import shutil

import pytest
from fastapi.testclient import TestClient

from conftest import wait_idle

SAMPLES = ["5N7A1263.jpg", "5N7A1268.jpg", "5N7A1276.jpg"]  # dog, marigold, birds on a wire


@pytest.mark.slow
def test_api_smoke(sample_dir, data_dir, tmp_path):
    from photolib import config, indexer

    cat = tmp_path / "catalog" / "nested"
    cat.mkdir(parents=True)
    for i, name in enumerate(SAMPLES):
        dest = cat / (name if i else name.replace(".jpg", ".JPEG"))  # case-insensitive extension
        shutil.copyfile(sample_dir / name, dest)
    root = tmp_path / "catalog"
    config.save_config({"catalog_dir": str(root)})

    res = indexer.refresh(root, skip_tags=True)
    assert res["error"] is None and res["added"] == 3 and res["failed"] == 0
    assert res["phase"] == "done" and res["untagged"] == 3 and res["tag_total"] == 0
    res = indexer.refresh(root)  # nothing new to embed; the tag pass picks up the 3 untagged photos
    assert res["error"] is None and res["added"] == 0 and res["skipped"] == 3
    assert res["tag_done"] == 3 and res["tagged"] == 3 and res["untagged"] == 0 and res["tag_seconds"] > 0
    res = indexer.refresh(root)  # second run: nothing to do in either pass
    assert res["added"] == 0 and res["tag_done"] == 0 and res["untagged"] == 0
    from photolib.tagger import get_tagger

    assert not get_tagger().loaded  # d1 is unloaded after each tag pass

    from photolib.api import app

    c = TestClient(app)
    s = c.get("/api/status").json()
    assert s["image_count"] == 3 and s["model"]["dim"] == 768 and s["indexing"]["running"] is False
    assert s["tagged_count"] == 3 and s["untagged_count"] == 0
    assert s["tagger"]["name"] == "LiquidAI/d1-3B" and s["tagger"]["loaded"] is False and s["tagger"]["labels"] > 100

    r = c.get("/api/images", params={"limit": 2, "sort": "file_name", "order": "asc"}).json()
    assert r["total"] == 3 and len(r["items"]) == 2
    first = r["items"][0]
    assert first["id"].startswith("nested/") and first["thumb_url"].startswith("/api/thumb/nested%2F")
    assert first["make"] == "Canon" and first["colors"] and first["subjects"]

    q = c.get("/api/search/query", params={"q": "a dog", "limit": 3}).json()["items"]
    assert q[0]["id"] == "nested/5N7A1263.JPEG" and "score" in q[0]
    q = c.get("/api/search/query", params={"q": "birds sitting on a wire", "limit": 1}).json()["items"]
    assert q[0]["id"] == "nested/5N7A1276.jpg"
    q = c.get("/api/search/query", params={"q": "a dog", "subject": "flower"}).json()["items"]
    assert [i["id"] for i in q] == ["nested/5N7A1268.jpg"]

    sim = c.get(f"/api/search/similar/{first['id']}", params={"limit": 5}).json()["items"]
    assert len(sim) == 2 and first["id"] not in [i["id"] for i in sim]

    col = c.get("/api/search/color", params={"hex": "#ff8800"}).json()["items"]
    assert col[0]["id"] == "nested/5N7A1268.jpg"  # orange marigold
    assert c.get("/api/search/color", params={"hex": "nope"}).status_code == 400

    assert c.get("/api/subjects").json()["items"]
    fac = c.get("/api/facets").json()
    assert fac["makes"] == [{"value": "Canon", "count": 3}]

    d = c.get(f"/api/images/{first['id']}").json()
    assert d["exif"]["Make"] == "Canon" and d["file_size"] > 0 and len(d["sha1"]) == 40
    assert d["tagger"] == "d1-3B" and d["tagged_at"]

    # hybrid subjects: d1-confirmed, EG-ranked; summaries carry the top 5, detail all of them
    by_name = {i["file_name"]: i for i in c.get("/api/images", params={"limit": 10}).json()["items"]}
    dog = c.get("/api/images/nested/5N7A1263.JPEG").json()["subjects"]
    assert dog[0]["label"] == "dog" and dog[0]["source"] == "d1" and dog[0]["score"] >= 0.8
    assert [x["display_rank"] for x in dog] == list(range(1, len(dog) + 1))
    assert all("eg_score" in x for x in dog)
    marigold = [x["label"] for x in c.get("/api/images/nested/5N7A1268.jpg").json()["subjects"]]
    assert "marigold" in marigold and "orange" not in marigold
    birds = [x["label"] for x in c.get("/api/images/nested/5N7A1276.jpg").json()["subjects"]]
    assert "pigeon" in birds and "bird in flight" not in birds  # all perched in this frame
    for it in by_name.values():
        assert 1 <= len(it["subjects"]) <= 5 and set(it["subjects"][0]) == {"label", "score", "source"}
    labels_in_use = {x["label"] for x in c.get("/api/subjects").json()["items"]}
    assert not labels_in_use & {"ostrich", "peach", "macro", "wildlife"}

    t = c.get(first["thumb_url"])
    assert t.status_code == 200 and t.headers["content-type"] == "image/webp"
    o = c.get(first["image_url"])
    assert o.status_code == 200 and o.headers["content-type"] == "image/jpeg"
    assert c.get("/api/thumb/nope.jpg").status_code == 404
    assert c.get("/api/image/..%2F..%2Fetc%2Fpasswd").status_code == 404
    assert c.get("/api/nope").status_code == 404

    lk = c.post(f"/api/images/{first['id']}/like", json={"liked": True}).json()
    assert lk["liked"] is True and lk["liked_at"]
    liked = c.get("/api/images", params={"liked": 1}).json()
    assert liked["total"] == 1 and liked["items"][0]["liked"] is True
    assert c.post("/api/images/missing.jpg/like", json={"liked": True}).status_code == 404

    meta = c.get("/api/images", params={"q_meta": "5N7A126"}).json()
    assert meta["total"] == 2

    assert c.get("/api/admin/config").json()["catalog_dir"] == str(root)
    assert c.post("/api/admin/refresh", json={"prune": False, "skip_tags": True}).json()["ok"] is True
    wait_idle(c)

    # retag: confirm required; re-runs d1 over every photo in the background, then unloads it
    assert c.post("/api/admin/retag", json={}).status_code == 400
    r = c.post("/api/admin/retag", json={"confirm": True}).json()
    assert r["ok"] is True
    p = wait_idle(c)
    assert p["mode"] == "retag" and p["error"] is None and p["tag_done"] == 3 and p["phase"] == "done"
    s = c.get("/api/status").json()
    assert s["tagged_count"] == 3 and s["untagged_count"] == 0 and s["tagger"]["loaded"] is False
    assert c.get("/api/images/nested/5N7A1263.JPEG").json()["subjects"][0]["label"] == "dog"


def test_api_old_db_returns_409(data_dir, tmp_path):
    """A pre-tagging DB gives a clear 409 'rebuild' error (no traceback), and Rebuild still works."""
    import sqlite3

    from photolib import config

    config.save_config({"catalog_dir": str(tmp_path)})
    p = config.db_path()
    p.parent.mkdir(parents=True)
    old = sqlite3.connect(p)
    old.executescript("CREATE TABLE images (rel_path TEXT PRIMARY KEY); CREATE TABLE subjects (rel_path TEXT, label TEXT, score REAL);")
    old.close()

    from photolib.api import app

    c = TestClient(app)
    for r in (c.get("/api/status"), c.get("/api/images"), c.post("/api/admin/refresh", json={}),
              c.post("/api/admin/retag", json={"confirm": True})):
        assert r.status_code == 409, r.text
        assert "photolib catalog set" in r.json()["detail"] and r.json()["code"] == "schema_rebuild_required"
    assert c.get("/api/admin/config").status_code == 200  # admin page can still offer "Rebuild catalog"


def test_catalog_dir_env_overrides_config(data_dir, tmp_path, monkeypatch):
    """A data dir indexed elsewhere is served with the photos at another path (`PHOTOLIB_CATALOG_DIR`)."""
    from photolib import config, db

    monkeypatch.delenv("PHOTOLIB_EMBEDDING_MODEL")  # a serving machine without local models
    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")
    here = tmp_path / "photos-here"
    here.mkdir()
    (here / "a.jpg").write_bytes(b"jpeg bytes")
    config.save_config({"catalog_dir": str(tmp_path / "path-on-the-indexing-machine")})
    conn = db.connect()
    conn.execute("INSERT INTO images(rel_path, file_name) VALUES ('a.jpg', 'a.jpg')")
    conn.commit()
    conn.close()

    from photolib.api import app

    c = TestClient(app)
    assert c.get("/api/image/a.jpg").status_code == 404  # the stored path doesn't exist on this machine
    monkeypatch.setenv("PHOTOLIB_CATALOG_DIR", str(here))
    assert config.catalog_dir() == here
    assert c.get("/api/status").json()["catalog_dir"] == str(here)
    assert c.get("/api/image/a.jpg").content == b"jpeg bytes"


def test_each_catalog_keeps_its_own_index(data_dir, tmp_path, fake_embedder, monkeypatch):
    """Switching catalogs deletes nothing; `rebuild` only clears the catalog it is asked for."""
    import numpy as np
    from PIL import Image

    from photolib import config

    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")  # embed pass only
    fake_embedder.encode_images = lambda images: np.stack([fake_embedder.encode_query("x") for _ in images])
    a, b = tmp_path / "a" / "photos", tmp_path / "b" / "photos"  # same folder name, different paths
    for d, n in ((a, 2), (b, 3)):
        d.mkdir(parents=True)
        for i in range(n):
            Image.new("RGB", (32, 24), (i * 40, 100, 50)).save(d / f"p{i}.jpg")

    from photolib.api import app

    c = TestClient(app)

    def switch(d, **kw):
        assert c.post("/api/admin/catalog", json={"catalog_dir": str(d), "confirm": True, **kw}).status_code == 200
        wait_idle(c)
        return c.get("/api/status").json()

    assert switch(a)["image_count"] == 2
    index_a = config.index_dir()
    assert index_a.parent == data_dir / "catalogs" and index_a.name.startswith("photos-")
    assert c.post("/api/images/p0.jpg/like", json={"liked": True}).status_code == 200

    assert switch(b)["image_count"] == 3
    assert config.index_dir() != index_a and (index_a / "photolib.db").exists()
    assert c.get("/api/status").json()["liked_count"] == 0

    s = switch(a)  # back: nothing re-indexed, the like is still there
    assert s["image_count"] == 2 and s["liked_count"] == 1 and c.get("/api/admin/progress").json()["added"] == 0

    s = switch(a, rebuild=True)
    assert s["image_count"] == 2 and s["liked_count"] == 0
    assert switch(b)["image_count"] == 3  # untouched by the rebuild of a

    assert c.post("/api/admin/purge", json={"confirm": True}).status_code == 200
    assert config.catalog_dir() is None and not (data_dir / "catalogs" / config.catalog_key(str(b))).exists()
    assert (index_a / "photolib.db").exists()


def test_flat_data_dir_is_moved_into_its_catalog_folder(data_dir, tmp_path):
    """A data dir from before per-catalog folders (db + thumbs at the top) keeps working."""
    import sqlite3

    from photolib import config

    config.save_config({"catalog_dir": str(tmp_path / "photos")})
    sqlite3.connect(data_dir / "photolib.db").close()
    (data_dir / "thumbs").mkdir()
    (data_dir / "thumbs" / "t.webp").write_bytes(b"x")

    d = config.index_dir()
    assert (d / "photolib.db").exists() and (d / "thumbs" / "t.webp").exists()
    assert not (data_dir / "photolib.db").exists() and not (data_dir / "thumbs").exists()


def test_random_sort_is_stable_per_seed(data_dir, tmp_path):
    import numpy as np

    from photolib import config, db

    config.save_config({"catalog_dir": str(tmp_path)})
    conn = db.connect()
    with conn:
        for i in range(30):
            v = np.zeros(768, dtype=np.float32)
            v[i] = 1
            db.insert_image(conn, {"rel_path": f"p{i:02}.jpg", "file_name": f"p{i:02}.jpg", "sha1": "ab" * 20,
                                   "colors_json": "[]", "liked": 0}, v)
    conn.close()

    from photolib.api import app

    c = TestClient(app)

    def ids(seed, offset=0, limit=30):
        r = c.get("/api/images", params={"sort": "random", "seed": seed, "limit": limit, "offset": offset}).json()
        assert r["total"] == 30
        return [it["id"] for it in r["items"]]

    a = ids(1)
    assert sorted(a) == [f"p{i:02}.jpg" for i in range(30)] and a != sorted(a)
    assert ids(1, 0, 10) + ids(1, 10, 10) + ids(1, 20, 10) == a  # pages don't overlap or skip
    assert ids(2) != a


def test_facets_distributions_and_subject_categories(data_dir, tmp_path):
    import numpy as np

    from photolib import config, db, search

    config.save_config({"catalog_dir": str(tmp_path)})
    conn = db.connect()
    with conn:
        for i, (iso, f, focal, taken) in enumerate([(100, 8.0, 400.0, "2025-06-01T10:00:00"),
                                                    (100, 5.6, 200.0, "2025-06-20T10:00:00"),
                                                    (3200, 8.0, None, "2025-08-02T10:00:00")]):
            db.insert_image(conn, {"rel_path": f"p{i}.jpg", "file_name": f"p{i}.jpg", "sha1": "ab" * 20, "colors_json": "[]",
                                   "liked": 0, "iso": iso, "f_number": f, "focal_length": focal, "taken_at": taken},
                            np.ones(768, dtype=np.float32) / np.sqrt(768))
        db.add_subject(conn, "p0.jpg", "bird", 0.9, "d1", 0.5)
    fac = search.facets(conn)
    assert fac["iso_values"] == [{"value": 100, "count": 2}, {"value": 3200, "count": 1}]
    assert fac["focal_values"] == [{"value": 200.0, "count": 1}, {"value": 400.0, "count": 1}]
    assert fac["months"] == [{"value": "2025-06", "count": 2}, {"value": "2025-08", "count": 1}]
    assert search.subject_counts(conn) == [{"label": "bird", "count": 1, "category": "Birds"}]
    conn.close()
