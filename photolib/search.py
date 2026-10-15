"""Query layer shared by the API: filters, listing, semantic / similar / color ranking, facets.

Vector search runs in numpy, not SQLite: a process-wide `VectorCache` holds every image's id, its 768-d
embedding (one float32 matrix) and its flattened palette (up to 6 x (L, a, b, share)). Each request reads
`meta.vec_version` (one tiny query) and reloads the cache when the token changed; the indexer bumps it on
every insert/delete, and a purged/rebuilt DB starts with a fresh token. A reload is ~100 ms for 25k photos.

Filtered semantic search is exact: SQL WHERE -> candidate rel_paths -> gather their rows -> one mat-vec ->
top-k (argpartition + sort) -> slice. No oversampling, no k cap. Similar-search and color search use the
same candidate path.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import numpy as np

from . import colors as colors_mod
from . import config, db

SUMMARY_COLUMNS = (
    "rel_path, file_name, sha1, width, height, taken_at, make, model, lens, iso, f_number, "
    "exposure_str, focal_length, liked, liked_at, colors_json, indexed_at"
)

SORTS = {
    "taken_at": "i.taken_at",
    "file_name": "i.file_name",
    "indexed_at": "i.indexed_at",
    "liked_at": "i.liked_at",
}


@dataclass
class Filters:
    """Filters shared by listing and every ranked search; unset fields don't filter.

    Attributes:
        liked: Only liked photos when True.
        subjects: Photos that have any of these labels.
        make: Exact camera make.
        model: Exact camera model.
        lens: Exact lens name.
        iso_min: Lowest ISO, inclusive.
        iso_max: Highest ISO, inclusive.
        f_min: Lowest f-number, inclusive.
        f_max: Highest f-number, inclusive.
        focal_min: Shortest focal length in mm, inclusive.
        focal_max: Longest focal length in mm, inclusive.
        date_from: Earliest `taken_at` (ISO date or datetime prefix), inclusive.
        date_to: Latest `taken_at` (ISO date or datetime prefix), inclusive.
        q_meta: Metadata search text (FTS5 prefix match on every word).
    """

    liked: bool | None = None
    subjects: list[str] = field(default_factory=list)
    make: str | None = None
    model: str | None = None
    lens: str | None = None
    iso_min: int | None = None
    iso_max: int | None = None
    f_min: float | None = None
    f_max: float | None = None
    focal_min: float | None = None
    focal_max: float | None = None
    date_from: str | None = None
    date_to: str | None = None
    q_meta: str | None = None

    def active(self) -> bool:
        """Returns True when at least one filter is set."""
        return any(
            v not in (None, "", [], False) for v in (
                self.liked, self.subjects, self.make, self.model, self.lens, self.iso_min, self.iso_max,
                self.f_min, self.f_max, self.focal_min, self.focal_max, self.date_from, self.date_to,
                self.q_meta,
            )
        )


_TOKEN_RE = re.compile(r"[^\w.\-]+", re.UNICODE)


def fts_query(q: str | None) -> str | None:
    """Turns user text into an FTS5 query where every word must match as a prefix.

    Args:
        q: The typed text, e.g. `IMG_12 canon`.

    Returns:
        The FTS5 query (`"IMG_12"* "canon"*`), or None when there is nothing to search for.
    """
    if not q:
        return None
    toks = [t for t in _TOKEN_RE.split(q) if t.strip(".-")]
    if not toks:
        return None
    return " ".join('"' + t.replace('"', "") + '"*' for t in toks)


def where_sql(f: Filters, alias: str = "i") -> tuple[str, list]:
    """Builds the SQL WHERE clause for a set of filters.

    Args:
        f: The filters.
        alias: The alias of the images table in the query.

    Returns:
        `("WHERE ...", args)`, or `("", [])` when no filter is active.
    """
    a = alias
    clauses: list[str] = []
    args: list = []
    if f.liked:
        clauses.append(f"{a}.liked = 1")
    subs = [s for s in f.subjects if s]
    if subs:
        clauses.append(
            f"{a}.rel_path IN (SELECT rel_path FROM subjects WHERE label IN ({','.join('?' * len(subs))}))"
        )
        args += subs
    for col, val in (("make", f.make), ("model", f.model), ("lens", f.lens)):
        if val:
            clauses.append(f"{a}.{col} = ?")
            args.append(val)
    for col, lo, hi in (
        ("iso", f.iso_min, f.iso_max),
        ("f_number", f.f_min, f.f_max),
        ("focal_length", f.focal_min, f.focal_max),
    ):
        if lo is not None:
            clauses.append(f"{a}.{col} >= ?")
            args.append(lo)
        if hi is not None:
            clauses.append(f"{a}.{col} <= ?")
            args.append(hi)
    if f.date_from:
        clauses.append(f"substr({a}.taken_at, 1, {len(f.date_from[:19])}) >= ?")
        args.append(f.date_from[:19])
    if f.date_to:
        clauses.append(f"substr({a}.taken_at, 1, {len(f.date_to[:19])}) <= ?")
        args.append(f.date_to[:19])
    fq = fts_query(f.q_meta)
    if fq:
        clauses.append(f"{a}.rel_path IN (SELECT rel_path FROM images_fts WHERE images_fts MATCH ?)")
        args.append(fq)
    return ("WHERE " + " AND ".join(clauses)) if clauses else "", args


# --------------------------------------------------------------------------- summaries


def encode_id(rel_path: str) -> str:
    """Returns a relative path percent-encoded for use as one URL path segment."""
    return quote(rel_path, safe="")


def _subjects_for(conn: sqlite3.Connection, rel_paths: list[str], top: int | None = None, full: bool = False) -> dict[str, list[dict]]:
    """Returns the subjects of each image ordered by display_rank.

    Args:
        conn: An open connection.
        rel_paths: The images.
        top: Keep only the first N per image (summaries).
        full: Add `eg_score` and `display_rank` to each subject (detail view).

    Returns:
        `{rel_path: [{label, score, source, ...}]}` with an entry for every requested image.
    """
    out: dict[str, list[dict]] = {rp: [] for rp in rel_paths}
    if not rel_paths:
        return out
    rank_filter = "WHERE rn <= ?" if top else ""
    args: list = [json.dumps(rel_paths)] + ([int(top)] if top else [])
    rows = conn.execute(
        "SELECT rel_path, label, score, source, eg_score, display_rank FROM ("
        "  SELECT rel_path, label, score, source, eg_score, display_rank,"
        "    ROW_NUMBER() OVER (PARTITION BY rel_path ORDER BY display_rank IS NULL, display_rank, score DESC, label) rn"
        "  FROM subjects WHERE rel_path IN (SELECT value FROM json_each(?))"
        f") {rank_filter} ORDER BY rel_path, rn",
        args,
    )
    for r in rows:
        d = {"label": r[1], "score": round(r[2], 4), "source": r[3] or "d1"}
        if full:
            d["eg_score"] = round(r[4], 4) if r[4] is not None else None
            d["display_rank"] = r[5]
        out[r[0]].append(d)
    return out


def row_to_summary(r: sqlite3.Row, subjects: list[dict], score: float | None = None) -> dict:
    """Builds the ImageSummary dict the API returns for one image row.

    Args:
        r: A row with at least `SUMMARY_COLUMNS`.
        subjects: The image's subjects, already ordered.
        score: The ranking score to include, for ranked searches.

    Returns:
        The summary, with cache-busted thumbnail and image URLs.
    """
    enc = encode_id(r["rel_path"])
    v = (r["sha1"] or "")[:12]
    cols = json.loads(r["colors_json"]) if r["colors_json"] else []
    d = {
        "id": r["rel_path"],
        "file_name": r["file_name"],
        "thumb_url": f"/api/thumb/{enc}?v={v}",
        "image_url": f"/api/image/{enc}?v={v}",
        "width": r["width"],
        "height": r["height"],
        "taken_at": r["taken_at"],
        "make": r["make"],
        "model": r["model"],
        "lens": r["lens"],
        "iso": r["iso"],
        "f_number": r["f_number"],
        "exposure_str": r["exposure_str"],
        "focal_length": r["focal_length"],
        "liked": bool(r["liked"]),
        "liked_at": r["liked_at"],
        "colors": [{"hex": c["hex"], "share": c["share"]} for c in cols],
        "subjects": subjects,
    }
    if score is not None:
        d["score"] = round(float(score), 4)
    return d


def summaries(conn: sqlite3.Connection, rel_paths: list[str], scores: dict[str, float] | None = None) -> list[dict]:
    """Returns ImageSummary dicts in the order of `rel_paths`.

    Args:
        conn: An open connection.
        rel_paths: The images; unknown ids are dropped.
        scores: Ranking score per image, added to the summaries when given.

    Returns:
        One summary per known image, each with its top subjects.
    """
    if not rel_paths:
        return []
    rows = conn.execute(
        f"SELECT {SUMMARY_COLUMNS} FROM images WHERE rel_path IN (SELECT value FROM json_each(?))",
        (json.dumps(rel_paths),),
    ).fetchall()
    by_id = {r["rel_path"]: r for r in rows}
    subs = _subjects_for(conn, list(by_id), top=config.SUMMARY_SUBJECTS)
    return [
        row_to_summary(by_id[rp], subs[rp], scores.get(rp) if scores else None) for rp in rel_paths if rp in by_id
    ]


# --------------------------------------------------------------------------- listing


def list_images(
    conn: sqlite3.Connection,
    f: Filters,
    sort: str = "taken_at",
    order: str = "desc",
    limit: int = 60,
    offset: int = 0,
    seed: int = 0,
) -> tuple[list[dict], int]:
    """Lists images that pass the filters, sorted and paged.

    Args:
        conn: An open connection.
        f: The filters.
        sort: A key of `SORTS`, or "random"; unknown values fall back to `taken_at`.
        order: "asc" or "desc". Images without a sort value always come last. Ignored for "random".
        limit: Page size.
        offset: Number of images to skip.
        seed: Picks the shuffle for "random": the same seed gives the same order, so pages don't overlap.

    Returns:
        `(summaries of the page, total number of matching images)`.
    """
    where, args = where_sql(f)
    if sort == "random":
        ids = [r[0] for r in conn.execute(f"SELECT i.rel_path FROM images i {where}", args)]
        ids.sort(key=lambda rp: hashlib.blake2b(f"{seed}:{rp}".encode("utf-8"), digest_size=8).digest())
        return summaries(conn, ids[int(offset) : int(offset) + int(limit)]), len(ids)
    col = SORTS.get(sort, SORTS["taken_at"])
    direction = "ASC" if order.lower() == "asc" else "DESC"
    total = conn.execute(f"SELECT COUNT(*) FROM images i {where}", args).fetchone()[0]
    ids = [
        r[0]
        for r in conn.execute(
            f"SELECT i.rel_path FROM images i {where} ORDER BY ({col} IS NULL), {col} {direction}, "
            f"i.rel_path {direction} LIMIT ? OFFSET ?",
            [*args, int(limit), int(offset)],
        )
    ]
    return summaries(conn, ids), total


# --------------------------------------------------------------------------- vector cache


@dataclass
class VectorCache:
    """Every image's embedding and palette in numpy, for one DB at one `vec_version`.

    Attributes:
        key: `(db file, vec_version)` this snapshot was loaded for.
        ids: Relative paths in row order.
        index: Row number of each relative path.
        mat: (N, 768) float32 embeddings, L2-normalised (zeros where an image has none).
        has_vec: (N,) bool, whether the image has an embedding.
        pal_lab: (N, K, 3) float64 palette colors in CIELAB.
        pal_share: (N, K) float64 palette shares, 0 for padding.
        has_pal: (N,) bool, whether the image has a palette.
    """

    key: tuple[str, str | None]
    ids: list[str]
    index: dict[str, int]
    mat: np.ndarray
    has_vec: np.ndarray
    pal_lab: np.ndarray
    pal_share: np.ndarray
    has_pal: np.ndarray

    def rows(self, ids) -> np.ndarray:
        """Returns the row numbers of the given relative paths, skipping unknown ones."""
        idx = self.index
        return np.fromiter((idx[i] for i in ids if i in idx), dtype=np.int64)


_CACHE: VectorCache | None = None
_CACHE_LOCK = threading.Lock()


def _db_key(conn: sqlite3.Connection) -> str:
    file = next(f for _, name, f in conn.execute("PRAGMA database_list") if name == "main")
    return str(Path(file).resolve()) if file else f"memory:{id(conn)}"


def load_cache(conn: sqlite3.Connection) -> VectorCache:
    """Reads every embedding and palette into numpy in one read transaction.

    Args:
        conn: An open connection.

    Returns:
        A fresh `VectorCache`.
    """
    k = config.COLOR_K
    own_txn = not conn.in_transaction  # one consistent snapshot of version + rows; never end a caller's transaction
    if own_txn:
        conn.execute("BEGIN")
    try:
        key = (_db_key(conn), db.vec_version(conn))
        rows = conn.execute(
            "SELECT i.rel_path, e.vec, i.colors_json FROM images i LEFT JOIN embeddings e ON e.rel_path = i.rel_path "
            "ORDER BY i.rel_path"
        ).fetchall()
    finally:
        if own_txn:
            conn.commit()
    n = len(rows)
    mat = np.zeros((n, config.EMBED_DIM), dtype=np.float32)
    has_vec = np.zeros(n, dtype=bool)
    pal_lab = np.zeros((n, k, 3), dtype=np.float64)
    pal_share = np.zeros((n, k), dtype=np.float64)
    ids: list[str] = []
    for i, (rp, blob, cj) in enumerate(rows):
        ids.append(rp)
        if blob is not None:
            v = db.blob_vec(blob)
            if v.shape[0] == config.EMBED_DIM:
                mat[i] = v
                has_vec[i] = True
        if cj:
            for j, c in enumerate(json.loads(cj)[:k]):
                pal_lab[i, j] = c["lab"]
                pal_share[i, j] = c["share"]
    has_pal = pal_share.sum(axis=1) > 0
    return VectorCache(key, ids, {rp: i for i, rp in enumerate(ids)}, mat, has_vec, pal_lab, pal_share, has_pal)


def get_cache(conn: sqlite3.Connection) -> VectorCache:
    """Returns the process-wide cache, reloading it when this DB's `vec_version` token changed."""
    global _CACHE
    key = (_db_key(conn), db.vec_version(conn))
    c = _CACHE
    if c is not None and c.key == key:
        return c
    with _CACHE_LOCK:
        c = _CACHE
        if c is None or c.key != key:
            c = load_cache(conn)
            _CACHE = c
    return c


def invalidate_cache() -> None:
    """Drops the process-wide cache so the next request reloads it."""
    global _CACHE
    with _CACHE_LOCK:
        _CACHE = None


# --------------------------------------------------------------------------- ranking


def candidate_rows(conn: sqlite3.Connection, cache: VectorCache, f: Filters, exclude: str | None = None) -> np.ndarray:
    """Returns the cache rows that pass the filters.

    Args:
        conn: An open connection.
        cache: The cache whose rows are selected.
        f: The filters; all rows qualify when none is active.
        exclude: A relative path to leave out (the source photo of a similar-search).

    Returns:
        Sorted row indices into the cache.
    """
    if f.active():
        where, args = where_sql(f)
        idx = cache.rows(r[0] for r in conn.execute(f"SELECT i.rel_path FROM images i {where}", args))
        idx.sort()
    else:
        idx = np.arange(len(cache.ids), dtype=np.int64)
    if exclude is not None and exclude in cache.index:
        idx = idx[idx != cache.index[exclude]]
    return idx


def top_k(scores: np.ndarray, k: int) -> np.ndarray:
    """Returns the positions of the k best scores, best first (exact).

    Args:
        scores: One score per candidate; higher is better.
        k: How many positions to return (clamped to the number of scores).

    Returns:
        Positions into `scores`; ties are broken by position (= rel_path order).
    """
    n = scores.shape[0]
    k = max(0, min(int(k), n))
    if k == 0:
        return np.zeros(0, dtype=np.int64)
    if k < n:
        part = np.argpartition(-scores, k - 1)[:k]
        # argpartition may cut through a group of equal scores; pull in every position tied with the k-th
        kth = scores[part].min()
        part = np.flatnonzero(scores >= kth)
    else:
        part = np.arange(n)
    order = np.lexsort((part, -scores[part]))
    return part[order][:k]


def semantic(
    conn: sqlite3.Connection,
    qvec: np.ndarray,
    f: Filters,
    limit: int = 60,
    offset: int = 0,
    exclude: str | None = None,
) -> list[dict]:
    """Ranks images by exact cosine similarity to a query vector.

    Args:
        conn: An open connection.
        qvec: The L2-normalised query vector (a text query or another image's embedding).
        f: The filters applied before ranking.
        limit: Page size.
        offset: Number of results to skip.
        exclude: A relative path to leave out (the source photo of a similar-search).

    Returns:
        Summaries with a `score`, best match first.
    """
    if limit <= 0:
        return []
    cache = get_cache(conn)
    idx = candidate_rows(conn, cache, f, exclude)
    idx = idx[cache.has_vec[idx]]
    if idx.size == 0:
        return []
    q = np.asarray(qvec, dtype=np.float32)
    scores = cache.mat[idx] @ q
    best = top_k(scores, offset + limit)[offset:]
    hits = [(cache.ids[idx[j]], float(scores[j])) for j in best]
    return summaries(conn, [h[0] for h in hits], dict(hits))


def color_scores(pal_lab: np.ndarray, pal_share: np.ndarray, q_lab) -> np.ndarray:
    """Scores many palettes against one color (vectorised `colors.color_score`).

    Args:
        pal_lab: (N, K, 3) palette colors in CIELAB.
        pal_share: (N, K) palette shares, 0 for padding.
        q_lab: The query color in CIELAB.

    Returns:
        (N,) scores: sum_i share_i * exp(-dE76(lab_i, q) / 25) per row.
    """
    q = np.asarray(q_lab, dtype=np.float64)
    de = np.linalg.norm(pal_lab - q, axis=-1)
    return (pal_share * np.exp(-de / colors_mod.DELTA_E_SCALE)).sum(axis=-1)


def color_search(conn: sqlite3.Connection, hex_str: str, f: Filters, limit: int = 60, offset: int = 0) -> list[dict]:
    """Ranks images by how well their stored palette matches a color (exhaustive).

    Args:
        conn: An open connection.
        hex_str: The query color as `#rgb` or `#rrggbb`.
        f: The filters applied before ranking.
        limit: Page size.
        offset: Number of results to skip.

    Returns:
        Summaries with a `score`, best match first.

    Raises:
        ValueError: If `hex_str` is not a hex color.
    """
    q = colors_mod.hex_to_lab(hex_str)
    cache = get_cache(conn)
    idx = candidate_rows(conn, cache, f)
    idx = idx[cache.has_pal[idx]]
    if idx.size == 0 or limit <= 0:
        return []
    scores = color_scores(cache.pal_lab[idx], cache.pal_share[idx], q)
    best = top_k(scores, offset + limit)[offset:]
    hits = [(cache.ids[idx[j]], float(scores[j])) for j in best]
    return summaries(conn, [h[0] for h in hits], dict(hits))


# --------------------------------------------------------------------------- detail / facets


def detail(conn: sqlite3.Connection, rel_path: str) -> dict | None:
    """Returns one image's summary plus full EXIF, palette, all subjects and file facts, or None."""
    r = conn.execute("SELECT * FROM images WHERE rel_path = ?", (rel_path,)).fetchone()
    if not r:
        return None
    d = row_to_summary(r, _subjects_for(conn, [rel_path], full=True)[rel_path])
    d["colors"] = json.loads(r["colors_json"]) if r["colors_json"] else []
    d["exif"] = json.loads(r["exif_json"]) if r["exif_json"] else {}
    for k in (
        "file_size", "sha1", "indexed_at", "tagged_at", "tagger", "mtime", "orientation", "software", "exposure_time", "exposure_bias",
        "flash", "white_balance", "exposure_program", "metering_mode", "gps_lat", "gps_lon",
    ):
        d[k] = r[k]
    return d


def set_like(conn: sqlite3.Connection, rel_path: str, liked: bool) -> dict | None:
    """Likes or unlikes an image.

    Returns:
        `{liked, liked_at}`, or None when the image doesn't exist.
    """
    ts = db.now_iso() if liked else None
    with conn:
        cur = conn.execute("UPDATE images SET liked = ?, liked_at = ? WHERE rel_path = ?", (int(liked), ts, rel_path))
    if cur.rowcount == 0:
        return None
    return {"liked": liked, "liked_at": ts}


def subject_counts(conn: sqlite3.Connection) -> list[dict]:
    """Returns `{label, count, category}` for every label in use, most common first.

    `category` is the builtin label's group from `labels.py` (e.g. "Birds"), or None for labels you created.
    """
    return [
        {"label": r[0], "count": r[1], "category": r[2]}
        for r in conn.execute(
            "SELECT s.label, COUNT(*) c, l.category FROM subjects s LEFT JOIN labels l ON l.label = s.label "
            "GROUP BY s.label ORDER BY c DESC, s.label"
        )
    ]


def facets(conn: sqlite3.Connection) -> dict:
    """Returns the filter options: makes, models and lenses with counts, value ranges and distributions."""

    def counts(col: str) -> list[dict]:
        return [
            {"value": r[0], "count": r[1]}
            for r in conn.execute(
                f"SELECT {col}, COUNT(*) c FROM images WHERE {col} IS NOT NULL AND {col} != '' "
                f"GROUP BY {col} ORDER BY c DESC, {col}"
            )
        ]

    def rng(col: str) -> dict:
        r = conn.execute(f"SELECT MIN({col}), MAX({col}) FROM images").fetchone()
        return {"min": r[0], "max": r[1]}

    def values(expr: str) -> list[dict]:
        return [
            {"value": r[0], "count": r[1]}
            for r in conn.execute(f"SELECT {expr} v, COUNT(*) FROM images WHERE v IS NOT NULL GROUP BY v ORDER BY v")
        ]

    return {
        "makes": counts("make"),
        "models": counts("model"),
        "lenses": counts("lens"),
        "iso": rng("iso"),
        "f_number": rng("f_number"),
        "focal_length": rng("focal_length"),
        "dates": rng("taken_at"),
        # Distributions behind the presets (photo counts per ISO / aperture / focal length) and the date histogram.
        "iso_values": values("iso"),
        "f_values": values("f_number"),
        "focal_values": values("focal_length"),
        "months": values("substr(taken_at, 1, 7)"),
    }


def stats(conn: sqlite3.Connection) -> dict:
    """Returns the library counts (images, tagged, untagged, liked, subjects) and the DB size."""
    tagged, untagged = db.tag_counts(conn)
    return {
        "image_count": db.image_count(conn),
        "tagged_count": tagged,
        "untagged_count": untagged,
        "liked_count": conn.execute("SELECT COUNT(*) FROM images WHERE liked = 1").fetchone()[0],
        "subject_count": conn.execute("SELECT COUNT(DISTINCT label) FROM subjects").fetchone()[0],
        "db_size_bytes": db.db_size_bytes(),
    }
