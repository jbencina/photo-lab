import sqlite3

import numpy as np
import pytest

from photolib import config, db, search


def _row(rp, **kw):
    r = {"rel_path": rp, "file_name": rp.split("/")[-1], "sha1": "ab" * 20, "colors_json": "[]", "liked": 0}
    r.update(kw)
    return r


def _unit(n, seed=0):
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, 768)).astype(np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def test_fresh_db_schema_and_version(data_dir):
    conn = db.connect()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    assert {"images", "embeddings", "subjects", "images_fts", "meta"} <= tables
    assert {"tagged_at", "tagger"} <= {r[1] for r in conn.execute("PRAGMA table_info(images)")}
    assert {"source", "eg_score", "display_rank"} <= {r[1] for r in conn.execute("PRAGMA table_info(subjects)")}
    v1 = db.vec_version(conn)
    assert v1
    conn.close()
    conn = db.connect()  # reopening keeps the token (no spurious cache reloads)
    assert db.vec_version(conn) == v1
    conn.close()


def test_old_db_raises_clear_rebuild_error(data_dir):
    """A pre-tagging DB (user_version 0, no tagging columns, vec0 embeddings) must not crash connect()."""
    p = config.db_path()
    p.parent.mkdir(parents=True)
    old = sqlite3.connect(p)
    old.executescript(
        """
        CREATE TABLE images (rel_path TEXT PRIMARY KEY, file_name TEXT, colors_json TEXT, liked INTEGER DEFAULT 0);
        CREATE TABLE subjects (rel_path TEXT, label TEXT, score REAL, PRIMARY KEY(rel_path, label));
        CREATE TABLE image_vec_rowids (rowid INTEGER PRIMARY KEY, id TEXT);  -- stand-in for the vec0 shadow tables
        INSERT INTO images VALUES ('a.jpg', 'a.jpg', '[]', 1);
        """
    )
    old.commit()
    old.close()
    with pytest.raises(db.SchemaError) as ei:
        db.connect()
    msg = str(ei.value)
    assert "photolib catalog set" in msg and "older photo-lib" in msg
    with pytest.raises(db.SchemaError):
        db.check_schema()
    # the old file is left untouched
    c = sqlite3.connect(p)
    assert c.execute("PRAGMA user_version").fetchone()[0] == 0
    assert "tagged_at" not in {r[1] for r in c.execute("PRAGMA table_info(images)")}
    c.close()


def test_newer_db_is_refused(data_dir):
    p = config.db_path()
    p.parent.mkdir(parents=True)
    c = sqlite3.connect(p)
    c.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION + 1}")
    c.execute("CREATE TABLE images (rel_path TEXT PRIMARY KEY)")
    c.commit()
    c.close()
    with pytest.raises(db.SchemaError, match="newer"):
        db.connect()


def test_insert_delete_embeddings_and_vec_version(data_dir):
    conn = db.connect()
    vecs = _unit(50)
    v0 = db.vec_version(conn)
    with conn:
        for i, v in enumerate(vecs):
            db.insert_image(
                conn,
                _row(f"sub/img_{i:03d}.jpg", make="Canon" if i % 2 else "Nikon", iso=100 * (i + 1),
                     taken_at=f"2025-06-{(i % 28) + 1:02d}T10:00:00"),
                v,
            )
    v1 = db.vec_version(conn)
    assert v1 != v0
    assert db.image_count(conn) == 50 and len(db.existing_rel_paths(conn)) == 50
    assert np.allclose(db.get_embedding(conn, "sub/img_007.jpg"), vecs[7])
    assert db.tag_counts(conn) == (0, 50)
    assert db.untagged_rel_paths(conn, limit=2) == ["sub/img_000.jpg", "sub/img_001.jpg"]

    # subjects + tagging state
    with conn:
        db.replace_subjects(
            conn, "sub/img_003.jpg",
            [{"label": "bird", "score": 0.97, "source": "d1", "eg_score": 0.71, "display_rank": 1}],
            "d1-3B", "2025-01-01T00:00:00",
        )
    with conn:  # replacing again must not duplicate rows
        db.replace_subjects(
            conn, "sub/img_003.jpg",
            [{"label": "bird", "score": 0.98, "source": "d1", "eg_score": 0.71, "display_rank": 1},
             {"label": "sky", "score": 0.99, "source": "d1", "eg_score": 0.66, "display_rank": 2}],
            "d1-3B", "2025-01-02T00:00:00",
        )
    assert conn.execute("SELECT COUNT(*) FROM subjects WHERE rel_path = 'sub/img_003.jpg'").fetchone()[0] == 2
    assert db.tag_counts(conn) == (1, 49)
    assert db.clear_tags(conn) == 1 and db.tag_counts(conn) == (0, 50)
    assert conn.execute("SELECT COUNT(*) FROM subjects").fetchone()[0] == 2  # kept until re-tagged

    # FTS + shared filters
    items, total = search.list_images(conn, search.Filters(q_meta="img_01"), limit=100)
    assert total == 10
    items, total = search.list_images(conn, search.Filters(date_from="2025-06-01", date_to="2025-06-02"), limit=100)
    assert total == 4

    # delete cleans every table and bumps the version
    with conn:
        db.delete_image(conn, "sub/img_003.jpg")
    assert db.vec_version(conn) != v1
    assert db.get_embedding(conn, "sub/img_003.jpg") is None
    assert conn.execute("SELECT COUNT(*) FROM subjects").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM images_fts WHERE rel_path = 'sub/img_003.jpg'").fetchone()[0] == 0
    conn.close()
