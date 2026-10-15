"""SQLite storage: metadata, embeddings (plain BLOB table), subjects, FTS5, and a tiny key/value `meta` table.

Schema versioning uses `PRAGMA user_version`:
  * 0 with no tables  -> a fresh file: create everything and stamp SCHEMA_VERSION.
  * 0/1 with tables   -> a pre-tagging DB (sqlite-vec `vec0` embeddings, no tagging columns). It can't be
                         migrated without sqlite-vec, so `connect()` raises `SchemaError` telling the user to
                         rebuild with `photolib catalog set <dir> --rebuild` (CLI and API surface the message).
  * 2 (tagging)       -> migrated IN PLACE to 3: the `labels` table is created and seeded from labels.py.
                         Nothing existing is rewritten (images, embeddings, subjects, likes all stay).
  * SCHEMA_VERSION    -> add any column a later revision introduced (`ALTER TABLE ... ADD COLUMN`) and
                         re-seed the builtin labels when labels.py changed.
  * > SCHEMA_VERSION  -> written by a newer photolib: refuse.

Vocabulary (v3): `labels(label, question, category, source 'builtin'|'user', created_at)`. labels.py is the
seed: its entries are upserted as builtin rows (insert missing, never delete, never overwrite a question that
was edited in the DB). The effective vocabulary = every row, builtin first in file order, then user labels
by created_at. `meta.labels_version` is bumped whenever the table changes (label-vector caches key on it).

Subjects: `source` is 'd1' (confirmed by the tagger), 'eg' (fallback) or 'user' (manual, score 1.0). Manual
rows rank ahead of model rows and survive a re-tag (`replace_subjects` only swaps the model rows).

Vectors live in `embeddings(rel_path, vec BLOB float32[768])`; search keeps them in an in-process numpy
matrix (search.py) invalidated by `meta.vec_version`, a random token bumped on every insert/delete.
A new DB file gets a fresh token, so a purge (= deleting the file) also invalidates every cache.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping

import numpy as np

from . import config
from . import labels as labels_mod

SCHEMA_VERSION = 3
MIN_MIGRATABLE_VERSION = 2  # v2 DBs upgrade in place; older ones need a rebuild

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
  rel_path TEXT PRIMARY KEY, file_name TEXT, file_size INTEGER, mtime REAL, sha1 TEXT,
  width INTEGER, height INTEGER, orientation INTEGER,
  make TEXT, model TEXT, lens TEXT, software TEXT,
  taken_at TEXT,
  iso INTEGER, f_number REAL, exposure_time REAL, exposure_str TEXT, focal_length REAL,
  exposure_bias REAL, flash INTEGER, white_balance INTEGER, exposure_program INTEGER, metering_mode INTEGER,
  gps_lat REAL, gps_lon REAL,
  exif_json TEXT,
  colors_json TEXT,
  liked INTEGER DEFAULT 0, liked_at TEXT,
  indexed_at TEXT,
  tagged_at TEXT,
  tagger TEXT
);
CREATE TABLE IF NOT EXISTS embeddings (rel_path TEXT PRIMARY KEY, vec BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS subjects (
  rel_path TEXT, label TEXT, score REAL,
  source TEXT, eg_score REAL, display_rank INTEGER,
  PRIMARY KEY(rel_path, label)
);
CREATE INDEX IF NOT EXISTS subjects_label ON subjects(label);
CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(rel_path UNINDEXED, file_name, make, model, lens, software);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS labels (
  label TEXT PRIMARY KEY, question TEXT, category TEXT,
  source TEXT NOT NULL,  -- 'builtin' | 'user'
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS images_taken_at ON images(taken_at);
CREATE INDEX IF NOT EXISTS images_liked ON images(liked);
CREATE INDEX IF NOT EXISTS images_tagged_at ON images(tagged_at);
"""

IMAGE_COLUMNS = [
    "rel_path", "file_name", "file_size", "mtime", "sha1", "width", "height", "orientation",
    "make", "model", "lens", "software", "taken_at", "iso", "f_number", "exposure_time", "exposure_str",
    "focal_length", "exposure_bias", "flash", "white_balance", "exposure_program", "metering_mode",
    "gps_lat", "gps_lon", "exif_json", "colors_json", "liked", "liked_at", "indexed_at", "tagged_at", "tagger",
]

REQUIRED_TABLES = {"images", "embeddings", "subjects", "images_fts", "meta", "labels"}

REBUILD_HINT = "run `photolib catalog set <dir> --rebuild` (or Admin -> Rebuild catalog) to rebuild the index"


class SchemaError(RuntimeError):
    """The DB file can't be used by this version of photolib (it needs a rebuild)."""


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")}


def migrate(conn: sqlite3.Connection, path: Path | str = "") -> None:
    """Creates, checks or upgrades the schema in place (see the module docstring).

    Args:
        conn: An open connection.
        path: The DB file, only used in error messages.

    Raises:
        SchemaError: If the file was written by a newer photolib or is too old to migrate.
    """
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    tables = _tables(conn)
    if version > SCHEMA_VERSION:
        raise SchemaError(
            f"{path or 'the database'} has schema version {version}, newer than this photolib understands "
            f"({SCHEMA_VERSION}); upgrade photolib or {REBUILD_HINT}."
        )
    if version < MIN_MIGRATABLE_VERSION and tables:
        raise SchemaError(
            f"The index at {path or 'the data dir'} was created by an older photo-lib (schema v{version}, "
            f"sqlite-vec embeddings, no d1 tagging); this version needs schema v{SCHEMA_VERSION}. "
            f"Your photos are fine: {REBUILD_HINT} (likes are not kept)."
        )
    if version == SCHEMA_VERSION and REQUIRED_TABLES <= tables:
        # The common case (every request): read-only checks, no write lock unless something is missing.
        if get_meta(conn, "vec_version") is not None and get_meta(conn, "labels_seed") == labels_mod.SEED_HASH:
            return
    with conn:
        conn.executescript(SCHEMA)
        if get_meta(conn, "vec_version") is None:
            bump_vec_version(conn)
        seed_labels(conn)  # v2 -> v3 lands here too: the table was just created, so every builtin is inserted
        if version != SCHEMA_VERSION:
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Opens the DB, creating the data dir and the schema if needed.

    Args:
        path: The DB file; defaults to `config.db_path()`.

    Returns:
        A connection in WAL mode with `sqlite3.Row` rows.

    Raises:
        SchemaError: If the file has a schema this version can't use.
    """
    path = Path(path) if path else config.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        migrate(conn, path)
    except BaseException:
        conn.close()
        raise
    return conn


def check_schema(path: Path | str | None = None) -> None:
    """Checks that an existing DB file can be used. Never creates a file.

    Args:
        path: The DB file; defaults to `config.db_path()`.

    Raises:
        SchemaError: If the file exists and has a schema this version can't use.
    """
    path = Path(path) if path else config.db_path()
    if not path.exists():
        return
    connect(path).close()


# --------------------------------------------------------------------------- vectors / meta


def vec_blob(v: np.ndarray) -> bytes:
    """Returns a vector as the float32 bytes stored in `embeddings.vec`."""
    return np.ascontiguousarray(v, dtype=np.float32).tobytes()


def blob_vec(b: bytes) -> np.ndarray:
    """Returns the float32 vector stored in an `embeddings.vec` blob (a read-only view)."""
    return np.frombuffer(b, dtype=np.float32)


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    """Returns the `meta` value for a key, or None when it is not set."""
    r = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return r[0] if r else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Inserts or replaces a `meta` value. Caller owns the transaction."""
    conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def bump_vec_version(conn: sqlite3.Connection) -> str:
    """Stores a new random `vec_version` token and returns it.

    Every process-wide vector cache reloads on its next request.
    """
    token = f"{time.time_ns():x}-{secrets.token_hex(4)}"
    set_meta(conn, "vec_version", token)
    return token


def vec_version(conn: sqlite3.Connection) -> str | None:
    """Returns the token that identifies the current set of embeddings."""
    return get_meta(conn, "vec_version")


def now_iso() -> str:
    """Returns the current local time as an ISO 8601 string with offset, to the second."""
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------- labels (the vocabulary)


def bump_labels_version(conn: sqlite3.Connection) -> str:
    """Stores a new random `labels_version` token and returns it (label-vector caches key on it)."""
    token = f"{time.time_ns():x}-{secrets.token_hex(4)}"
    set_meta(conn, "labels_version", token)
    return token


def labels_version(conn: sqlite3.Connection) -> str | None:
    """Returns the token that identifies the current vocabulary."""
    return get_meta(conn, "labels_version")


def seed_labels(conn: sqlite3.Connection) -> None:
    """Upserts labels.py into `labels` as builtin rows. Caller owns the transaction.

    Insert missing; never delete; a builtin row's question follows labels.py only while it still equals the
    question the previous seed wrote (i.e. nobody edited it in the DB). A user label that later shows up in
    labels.py is left alone.
    """
    prev: dict = json.loads(get_meta(conn, "labels_seed_questions") or "{}")
    existing = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT label, question, source FROM labels")}
    ts = now_iso()
    for e in labels_mod.LABELS:
        label, question, category = e["label"], e["question"], labels_mod.CATEGORY_OF[e["label"]]
        if label not in existing:
            conn.execute(
                "INSERT INTO labels(label, question, category, source, created_at) VALUES (?, ?, ?, 'builtin', ?)",
                (label, question, category, ts),
            )
            continue
        old_q, source = existing[label]
        if source != "builtin":
            continue
        if label in prev and old_q == prev[label] and old_q != question:
            conn.execute("UPDATE labels SET question = ?, category = ? WHERE label = ?", (question, category, label))
        else:
            conn.execute("UPDATE labels SET category = ? WHERE label = ?", (category, label))
    set_meta(conn, "labels_seed_questions", json.dumps({e["label"]: e["question"] for e in labels_mod.LABELS}))
    set_meta(conn, "labels_seed", labels_mod.SEED_HASH)
    bump_labels_version(conn)


def label_rows(conn: sqlite3.Connection) -> list[dict]:
    """Returns the effective vocabulary in order.

    Builtin rows come first in labels.py order (retired ones after), then user labels by `created_at`.

    Returns:
        A list of `{label, question, category, source, created_at}` dicts.
    """
    file_order = {lb: i for i, lb in enumerate(labels_mod.VOCABULARY)}
    rows = [
        {"label": r[0], "question": r[1], "category": r[2], "source": r[3], "created_at": r[4]}
        for r in conn.execute("SELECT label, question, category, source, created_at FROM labels")
    ]
    rows.sort(
        key=lambda r: (
            0 if r["source"] == "builtin" else 1,
            file_order.get(r["label"], len(file_order)) if r["source"] == "builtin" else 0,
            (r["created_at"] or "") if r["source"] != "builtin" else "",
            r["label"],
        )
    )
    return rows


def get_label(conn: sqlite3.Connection, label: str) -> dict | None:
    """Returns one vocabulary row as a dict (see `label_rows`), or None when the label doesn't exist."""
    r = conn.execute(
        "SELECT label, question, category, source, created_at FROM labels WHERE label = ?", (label,)
    ).fetchone()
    return {"label": r[0], "question": r[1], "category": r[2], "source": r[3], "created_at": r[4]} if r else None


def vocabulary_size(conn: sqlite3.Connection) -> tuple[int, int]:
    """Returns `(all labels, labels you created)` in the vocabulary."""
    return conn.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE source = 'user') FROM labels").fetchone()


def create_label(conn: sqlite3.Connection, label: str, question: str | None = None) -> bool:
    """Inserts a user label if it is new. Caller owns the transaction.

    Args:
        conn: An open connection.
        label: The label, already normalized.
        question: A custom yes/no question; None uses the default template.

    Returns:
        True when a row was created, False when the label already existed.
    """
    cur = conn.execute(
        "INSERT OR IGNORE INTO labels(label, question, category, source, created_at) VALUES (?, ?, NULL, 'user', ?)",
        (label, question, now_iso()),
    )
    if cur.rowcount:
        bump_labels_version(conn)
    return bool(cur.rowcount)


def delete_label(conn: sqlite3.Connection, label: str) -> int:
    """Drops a label from the vocabulary together with its subject rows.

    Returns:
        The number of subject rows removed.
    """
    touched = [r[0] for r in conn.execute("SELECT rel_path FROM subjects WHERE label = ?", (label,))]
    conn.execute("DELETE FROM subjects WHERE label = ?", (label,))
    conn.execute("DELETE FROM labels WHERE label = ?", (label,))
    for rp in touched:
        rerank_subjects(conn, rp)
    bump_labels_version(conn)
    return len(touched)


def label_counts(conn: sqlite3.Connection) -> dict[str, tuple[int, int]]:
    """Returns `{label: (photos with it, of which manual)}` for every label in use."""
    return {
        r[0]: (int(r[1]), int(r[2]))
        for r in conn.execute("SELECT label, COUNT(*), COALESCE(SUM(source = 'user'), 0) FROM subjects GROUP BY label")
    }


# --------------------------------------------------------------------------- images


def existing_rel_paths(conn: sqlite3.Connection) -> set[str]:
    """Returns the relative path of every indexed image."""
    return {r[0] for r in conn.execute("SELECT rel_path FROM images")}


def insert_image(conn: sqlite3.Connection, row: dict, embedding: np.ndarray) -> None:
    """Inserts one image with its embedding and FTS row. Caller owns the transaction.

    Subjects are not written here: the tag pass adds them.

    Args:
        conn: An open connection.
        row: Column values keyed by name; columns not in `IMAGE_COLUMNS` are ignored.
        embedding: The image's 768-d vector.
    """
    cols = [c for c in IMAGE_COLUMNS if c in row]
    conn.execute(
        f"INSERT INTO images ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
        [row[c] for c in cols],
    )
    conn.execute("INSERT INTO embeddings(rel_path, vec) VALUES (?, ?)", (row["rel_path"], vec_blob(embedding)))
    conn.execute(
        "INSERT INTO images_fts(rel_path, file_name, make, model, lens, software) VALUES (?, ?, ?, ?, ?, ?)",
        [row.get(c) for c in ("rel_path", "file_name", "make", "model", "lens", "software")],
    )
    bump_vec_version(conn)


def delete_image(conn: sqlite3.Connection, rel_path: str) -> None:
    """Deletes an image's row, embedding, subjects and FTS row. Caller owns the transaction."""
    conn.execute("DELETE FROM images WHERE rel_path = ?", (rel_path,))
    conn.execute("DELETE FROM embeddings WHERE rel_path = ?", (rel_path,))
    conn.execute("DELETE FROM subjects WHERE rel_path = ?", (rel_path,))
    conn.execute("DELETE FROM images_fts WHERE rel_path = ?", (rel_path,))
    bump_vec_version(conn)


def get_embedding(conn: sqlite3.Connection, rel_path: str) -> np.ndarray | None:
    """Returns an image's stored vector, or None when it has none."""
    r = conn.execute("SELECT vec FROM embeddings WHERE rel_path = ?", (rel_path,)).fetchone()
    return blob_vec(r[0]) if r else None


# --------------------------------------------------------------------------- subjects / tagging


def replace_subjects(
    conn: sqlite3.Connection, rel_path: str, subjects: Iterable[Mapping], tagger: str, tagged_at: str
) -> None:
    """Swaps an image's MODEL subjects for a new set and marks it tagged.

    Caller owns the (per-image) transaction. Manual rows (`source='user'`) are preserved: a model row
    for a label the user already added is dropped, the 'eg' fallback row is dropped when the image has
    manual tags (it only exists so no image is subject-less), and ranks are rebuilt with the manual rows
    first.

    Args:
        conn: An open connection.
        rel_path: The image.
        subjects: Rows of `{label, score, source ('d1'|'eg'), eg_score, display_rank}`.
        tagger: Short name of the model that produced them (stored in `images.tagger`).
        tagged_at: ISO timestamp to store in `images.tagged_at`.
    """
    manual = {r[0] for r in conn.execute("SELECT label FROM subjects WHERE rel_path = ? AND source = 'user'", (rel_path,))}
    conn.execute("DELETE FROM subjects WHERE rel_path = ? AND COALESCE(source, '') != 'user'", (rel_path,))
    conn.executemany(
        "INSERT INTO subjects(rel_path, label, score, source, eg_score, display_rank) VALUES (?, ?, ?, ?, ?, ?)",
        [
            (rel_path, s["label"], float(s["score"]), s["source"], float(s["eg_score"]), int(s["display_rank"]))
            for s in subjects
            if s["label"] not in manual and not (manual and s["source"] == "eg")
        ],
    )
    if manual:
        rerank_subjects(conn, rel_path)
    conn.execute("UPDATE images SET tagged_at = ?, tagger = ? WHERE rel_path = ?", (tagged_at, tagger, rel_path))


def rerank_subjects(conn: sqlite3.Connection, rel_path: str) -> None:
    """Rewrites an image's `display_rank` values as 1..n.

    Manual rows come first (oldest first), then model rows by EG cosine (the tag rule's order; ties keep
    their previous rank).
    """
    rows = conn.execute(
        "SELECT label FROM subjects WHERE rel_path = ? ORDER BY (COALESCE(source, '') != 'user'), "
        "CASE WHEN source = 'user' THEN rowid END, eg_score IS NULL, eg_score DESC, "
        "display_rank IS NULL, display_rank, label",
        (rel_path,),
    ).fetchall()
    conn.executemany(
        "UPDATE subjects SET display_rank = ? WHERE rel_path = ? AND label = ?",
        [(i + 1, rel_path, r[0]) for i, r in enumerate(rows)],
    )


def subject_source(conn: sqlite3.Connection, rel_path: str, label: str) -> str | None:
    """Returns who put a label on an image ('user', 'd1' or 'eg'), or None when it isn't there."""
    r = conn.execute("SELECT COALESCE(source, 'd1') FROM subjects WHERE rel_path = ? AND label = ?", (rel_path, label)).fetchone()
    return r[0] if r else None


def add_subject(
    conn: sqlite3.Connection, rel_path: str, label: str, score: float, source: str, eg_score: float | None
) -> bool:
    """Adds ONE subject row to an image without touching its other rows.

    Caller owns the transaction.

    Args:
        conn: An open connection.
        rel_path: The image.
        label: The label to add.
        score: 1.0 for a manual tag, P(yes) for a propagated one.
        source: 'user' for a manual tag, 'd1' for a propagated one.
        eg_score: EmbeddingGemma cosine of the label against the image, if known.

    Returns:
        False when the image already has the label, True when the row was added.
    """
    cur = conn.execute(
        "INSERT OR IGNORE INTO subjects(rel_path, label, score, source, eg_score, display_rank) VALUES (?, ?, ?, ?, ?, NULL)",
        (rel_path, label, float(score), source, None if eg_score is None else float(eg_score)),
    )
    if not cur.rowcount:
        return False
    rerank_subjects(conn, rel_path)
    return True


def remove_subject(conn: sqlite3.Connection, rel_path: str, label: str) -> None:
    """Removes one label from an image and re-ranks the rest. Caller owns the transaction."""
    conn.execute("DELETE FROM subjects WHERE rel_path = ? AND label = ?", (rel_path, label))
    rerank_subjects(conn, rel_path)


def untagged_rel_paths(conn: sqlite3.Connection, limit: int | None = None) -> list[str]:
    """Returns the images the tag pass still has to do, in path order (at most `limit` when given)."""
    sql = "SELECT rel_path FROM images WHERE tagged_at IS NULL ORDER BY rel_path"
    args: list = []
    if limit is not None:
        sql += " LIMIT ?"
        args.append(int(limit))
    return [r[0] for r in conn.execute(sql, args)]


def clear_tags(conn: sqlite3.Connection) -> int:
    """Marks every image untagged; subjects stay visible until each image is re-tagged.

    Returns:
        The number of images that were marked.
    """
    with conn:
        return conn.execute("UPDATE images SET tagged_at = NULL WHERE tagged_at IS NOT NULL").rowcount


def tag_counts(conn: sqlite3.Connection) -> tuple[int, int]:
    """Returns `(tagged, untagged)` image counts."""
    r = conn.execute(
        "SELECT COALESCE(SUM(tagged_at IS NOT NULL), 0), COALESCE(SUM(tagged_at IS NULL), 0) FROM images"
    ).fetchone()
    return int(r[0]), int(r[1])


def image_count(conn: sqlite3.Connection) -> int:
    """Returns the number of indexed images."""
    return conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]


def db_size_bytes() -> int:
    """Returns the size on disk of the DB file plus its WAL."""
    p = config.db_path()
    total = 0
    for suffix in ("", "-wal"):
        f = Path(str(p) + suffix)
        if f.exists():
            total += f.stat().st_size
    return total
