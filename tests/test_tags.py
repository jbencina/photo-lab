"""Tests for label normalization, v2 -> v3 migration, suggestions, manual tags, retag preservation, propagation.

EmbeddingGemma and d1 are faked (conftest.FakeEmbedder / FakeTagger); the slow tests at the bottom use the
real models on the sample photos.
"""

import shutil
import sqlite3

import numpy as np
import pytest
from conftest import FakeTagger, mix, text_vec, wait_idle
from fastapi.testclient import TestClient
from PIL import Image

from photolib import config, db, indexer, labels, search, tags

# --------------------------------------------------------------------------- normalization


def test_normalize_label():
    n = labels.normalize_label
    assert n("  Wild   Turkey ") == "wild turkey"
    assert n("JELLYFISH") == "jellyfish"
    assert n("black\tand\nwhite") == "black and white"
    assert n("st. john's-wort") == "st. john's-wort"
    assert n("Éclair") == "éclair"
    assert n("x" * 40) == "x" * 40
    for bad in ("", "   ", "!!!", "-- ?", "x" * 41, "a/b", "tab\x00null", None):
        with pytest.raises(labels.LabelError):
            n(bad)
    assert labels.try_normalize("  Dog ") == "dog" and labels.try_normalize("...") is None
    assert labels.clean_question("  Is there   a whale? ") == "Is there a whale?"
    assert labels.clean_question("") is None and labels.clean_question(None) is None
    with pytest.raises(labels.LabelError):
        labels.clean_question("?" * 5)
    with pytest.raises(labels.LabelError):
        labels.clean_question("x" * 201)
    # every builtin label is already in normalized form
    assert all(n(lb) == lb for lb in labels.VOCABULARY)


# --------------------------------------------------------------------------- migration


V2_SCHEMA = """
CREATE TABLE images (
  rel_path TEXT PRIMARY KEY, file_name TEXT, file_size INTEGER, mtime REAL, sha1 TEXT,
  width INTEGER, height INTEGER, orientation INTEGER, make TEXT, model TEXT, lens TEXT, software TEXT,
  taken_at TEXT, iso INTEGER, f_number REAL, exposure_time REAL, exposure_str TEXT, focal_length REAL,
  exposure_bias REAL, flash INTEGER, white_balance INTEGER, exposure_program INTEGER, metering_mode INTEGER,
  gps_lat REAL, gps_lon REAL, exif_json TEXT, colors_json TEXT, liked INTEGER DEFAULT 0, liked_at TEXT,
  indexed_at TEXT, tagged_at TEXT, tagger TEXT
);
CREATE TABLE embeddings (rel_path TEXT PRIMARY KEY, vec BLOB NOT NULL);
CREATE TABLE subjects (rel_path TEXT, label TEXT, score REAL, source TEXT, eg_score REAL, display_rank INTEGER,
  PRIMARY KEY(rel_path, label));
CREATE INDEX subjects_label ON subjects(label);
CREATE VIRTUAL TABLE images_fts USING fts5(rel_path UNINDEXED, file_name, make, model, lens, software);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX images_taken_at ON images(taken_at);
CREATE INDEX images_liked ON images(liked);
CREATE INDEX images_tagged_at ON images(tagged_at);
"""


def _dump(c: sqlite3.Connection) -> dict:
    return {
        "images": c.execute("SELECT rel_path, file_name, liked, liked_at, tagged_at, tagger FROM images ORDER BY 1").fetchall(),
        "embeddings": c.execute("SELECT rel_path, vec FROM embeddings ORDER BY 1").fetchall(),
        "subjects": c.execute("SELECT rel_path, label, score, source, eg_score, display_rank FROM subjects ORDER BY 1, 2").fetchall(),
        "fts": c.execute("SELECT rel_path, file_name FROM images_fts ORDER BY 1").fetchall(),
        "vec_version": c.execute("SELECT value FROM meta WHERE key = 'vec_version'").fetchall(),
    }


def test_migrate_v2_to_v3_in_place_keeps_data(data_dir, monkeypatch):
    p = config.db_path()
    p.parent.mkdir(parents=True)
    old = sqlite3.connect(p)
    old.executescript(V2_SCHEMA)
    vec = text_vec("a photo").tobytes()
    old.execute("INSERT INTO images(rel_path, file_name, liked, liked_at, tagged_at, tagger) VALUES ('a.jpg', 'a.jpg', 1, '2025-01-01', '2025-01-02', 'd1-3B')")
    old.execute("INSERT INTO images(rel_path, file_name) VALUES ('b.jpg', 'b.jpg')")
    old.execute("INSERT INTO embeddings VALUES ('a.jpg', ?)", (vec,))
    old.execute("INSERT INTO subjects VALUES ('a.jpg', 'dog', 0.97, 'd1', 0.71, 1)")
    old.execute("INSERT INTO subjects VALUES ('a.jpg', 'pet', 0.91, 'd1', 0.66, 2)")
    old.execute("INSERT INTO images_fts(rel_path, file_name) VALUES ('a.jpg', 'a.jpg')")
    old.execute("INSERT INTO meta VALUES ('vec_version', 'tok-1')")
    old.execute("PRAGMA user_version = 2")
    old.commit()
    before = _dump(old)
    old.close()

    db.check_schema()  # a v2 DB is usable (no "rebuild" error): it upgrades in place
    conn = db.connect()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 3 == db.SCHEMA_VERSION
    after = _dump(conn)
    assert [tuple(r) for r in after["images"]] == before["images"]
    assert [tuple(r) for r in after["embeddings"]] == before["embeddings"]
    assert [tuple(r) for r in after["subjects"]] == before["subjects"]
    assert [tuple(r) for r in after["fts"]] == before["fts"]
    assert [tuple(r) for r in after["vec_version"]] == [("tok-1",)]  # caches stay valid

    # the vocabulary was seeded from labels.py: all builtin, file order, questions/categories carried over
    rows = db.label_rows(conn)
    assert [r["label"] for r in rows] == labels.VOCABULARY
    assert {r["source"] for r in rows} == {"builtin"}
    by = {r["label"]: r for r in rows}
    assert "citrus" in by["orange"]["question"] and by["pigeon"]["question"] is None
    assert by["pigeon"]["category"] == "Birds" and by["pigeon"]["created_at"]
    v1 = db.labels_version(conn)
    assert v1
    conn.close()

    # reconnecting is a no-op (no re-seed, same token)
    conn = db.connect()
    assert db.labels_version(conn) == v1

    # user labels come after the builtins, ordered by created_at; a user-edited question survives a re-seed
    with conn:
        assert db.create_label(conn, "whale") is True
        assert db.create_label(conn, "whale") is False
        conn.execute("UPDATE labels SET created_at = '2030-01-01T00:00:00' WHERE label = 'whale'")
        db.create_label(conn, "anemone", "Is there a sea anemone in this photo?")
        conn.execute("UPDATE labels SET created_at = '2029-01-01T00:00:00' WHERE label = 'anemone'")
        conn.execute("UPDATE labels SET question = 'Is this a pigeon, really?' WHERE label = 'pigeon'")
    assert db.labels_version(conn) != v1
    assert [r["label"] for r in db.label_rows(conn)] == labels.VOCABULARY + ["anemone", "whale"]
    conn.close()

    # labels.py changes: a new builtin is inserted, a reworded question flows through unless edited in the DB,
    # an entry removed from the file stays in the table, and a user label is never taken over
    seed = [dict(e) for e in labels.LABELS if e["label"] != "dove"]
    for e in seed:
        if e["label"] == "pigeon":
            e["question"] = "Is there a rock pigeon in this photo?"
        if e["label"] == "crow":
            e["question"] = "Is there a crow or raven in this photo?"
    seed += [{"label": "osprey", "question": None}, {"label": "whale", "question": "Seed whale?"}]
    monkeypatch.setattr(labels, "LABELS", seed)
    monkeypatch.setattr(labels, "VOCABULARY", [e["label"] for e in seed])
    monkeypatch.setattr(labels, "CATEGORY_OF", {**labels.CATEGORY_OF, "osprey": "Birds", "whale": "Mammals"})
    monkeypatch.setattr(labels, "SEED_HASH", "changed")
    conn = db.connect()
    by = {r["label"]: r for r in db.label_rows(conn)}
    assert by["osprey"]["source"] == "builtin"
    assert by["crow"]["question"] == "Is there a crow or raven in this photo?"
    assert by["pigeon"]["question"] == "Is this a pigeon, really?"  # edited in the DB: kept
    assert "dove" in by  # never deleted
    assert by["whale"]["source"] == "user" and by["whale"]["question"] is None
    order = [r["label"] for r in db.label_rows(conn)]
    assert order[-2:] == ["anemone", "whale"] and order.index("dove") > order.index("osprey")  # retired builtin last
    assert len(_dump(conn)["subjects"]) == 2
    conn.close()


def test_fresh_db_has_labels_table(data_dir):
    conn = db.connect()
    assert conn.execute("SELECT COUNT(*) FROM labels WHERE source = 'builtin'").fetchone()[0] == len(labels.VOCABULARY)
    assert db.get_label(conn, "dog")["category"] == "Mammals" and db.get_label(conn, "nope") is None
    conn.close()


# --------------------------------------------------------------------------- helpers


def _add_image(conn, name: str, vec: np.ndarray, tagged: bool = True) -> None:
    db.insert_image(conn, {"rel_path": name, "file_name": name, "sha1": "ab" * 20, "colors_json": "[]", "liked": 0}, vec)
    if tagged:
        conn.execute("UPDATE images SET tagged_at = '2025-01-01T00:00:00', tagger = 'd1-3B' WHERE rel_path = ?", (name,))


def _subjects(conn, rp: str) -> list[tuple]:
    return [tuple(r) for r in conn.execute("SELECT label, source, display_rank FROM subjects WHERE rel_path = ? ORDER BY display_rank", (rp,))]


# --------------------------------------------------------------------------- suggestions


def test_text_match_tiers():
    m = tags.text_match
    assert m("pigeon", "pigeon") == "exact"
    assert m("bird", "bird in flight") == "prefix"
    assert m("flight", "bird in flight") == "text"  # substring
    assert m("fl bird", "bird in flight") == "text"  # every query word starts a label word
    assert m("pigeons", "pigeon") == "text"  # plural folded
    assert m("big pigeons", "pigeon") == "text"  # label's words are among the query's words
    assert m("berry", "berries") == "text"
    assert m("dogwood", "dog") is None and m("cat", "dog") is None


def test_suggest_ranking_and_floor(data_dir, fake_embedder):
    conn = db.connect()
    with conn:
        _add_image(conn, "a.jpg", text_vec("img a"))
        _add_image(conn, "b.jpg", text_vec("img b"))
        for rp, lb in (("a.jpg", "bird"), ("b.jpg", "bird"), ("a.jpg", "flock of birds"), ("a.jpg", "ocean")):
            db.add_subject(conn, rp, lb, 0.95, "d1", 0.6)
    floor = config.SUGGEST_SIMILAR_FLOOR
    # "sea" is close to ocean (0.9) and coast (just above the floor); beach sits just below it

    def near(text: str, cos: float) -> np.ndarray:
        return mix({"sea": cos, f"{text}-rest": (1 - cos * cos) ** 0.5})

    fake_embedder.overrides |= {"ocean": near("ocean", 0.9), "coast": near("coast", floor + 0.03), "beach": near("beach", floor - 0.03)}
    sims = {lb: float(fake_embedder.overrides[lb] @ text_vec("sea")) for lb in ("ocean", "coast", "beach")}
    assert sims["ocean"] > sims["coast"] > floor > sims["beach"]

    r = tags.suggest(conn, "sea", "a.jpg")
    assert [(i["label"], i["match"]) for i in r["items"]] == [("ocean", "similar"), ("coast", "similar")]
    assert r["items"][0]["on_image"] is True and r["items"][1]["on_image"] is False
    assert r["items"][0]["similarity"] == pytest.approx(sims["ocean"], abs=1e-3) and r["items"][0]["count"] == 1
    assert r["exact_exists"] is False and r["normalized"] == "sea" and r["can_create"] is True

    # junk: nothing clears the floor, only "create" remains
    r = tags.suggest(conn, "asdfgh")
    assert r["items"] == [] and r["can_create"] is True and r["exact_exists"] is False

    # tiers: exact, then prefix, then text, then similar
    fake_embedder.overrides["bird"] = mix({"bird": 1.0, "sparrow": 3.0})  # sparrow becomes an embedding neighbour
    tags.invalidate_vocab()
    r = tags.suggest(conn, "  BIRD ", "b.jpg", limit=20)
    got = [(i["label"], i["match"]) for i in r["items"]]
    assert got[0] == ("bird", "exact") and got[1] == ("bird in flight", "prefix")
    assert set(got[2:4]) == {("flock of birds", "text"), ("hummingbird", "text")}
    assert got[4:] == [("sparrow", "similar")]
    assert r["exact_exists"] is True and r["can_create"] is False and r["normalized"] == "bird"
    assert r["items"][0]["on_image"] is True and r["items"][0]["count"] == 2 and r["items"][0]["source"] == "builtin"
    assert tags.suggest(conn, "bird", limit=2)["items"][1]["label"] == "bird in flight"  # limit keeps the best tiers

    # plural typed -> the singular label is offered as a text match (no duplicate "pigeons")
    r = tags.suggest(conn, "Pigeons")
    assert r["items"][0]["label"] == "pigeon" and r["items"][0]["match"] == "text" and r["can_create"] is True

    # 1-2 characters: text matches only, the embedder is not asked
    n = len(fake_embedder.queries)
    r = tags.suggest(conn, "bi")
    assert len(fake_embedder.queries) == n and r["items"][0]["label"] == "bird" and r["items"][0]["similarity"] is None
    # repeated queries hit the LRU
    tags.suggest(conn, "sea")
    assert len(fake_embedder.queries) == n

    # user labels are suggested like builtin ones
    with conn:
        db.create_label(conn, "jellyfish")
    r = tags.suggest(conn, "jelly")
    assert [(i["label"], i["match"], i["source"]) for i in r["items"]] == [("jellyfish", "prefix", "user")]

    # text that can't become a label: no "create", a reason, existing matches still offered
    r = tags.suggest(conn, "bird/")
    assert r["can_create"] is False and "/" in r["reason"] and r["items"][0]["label"] == "bird"
    r = tags.suggest(conn, "!!!")
    assert r["items"] == [] and r["can_create"] is False and r["reason"]

    # empty query + image: the photo's top EG labels it doesn't have yet
    with conn:
        _add_image(conn, "c.jpg", mix({"dog": 0.9, "pet": 0.6, "cat": 0.4, "zz": 0.3}))
        db.add_subject(conn, "c.jpg", "dog", 0.99, "d1", 0.7)
    r = tags.suggest(conn, "", "c.jpg", limit=2)
    assert [(i["label"], i["match"]) for i in r["items"]] == [("pet", "image"), ("cat", "image")]
    assert r["can_create"] is False and r["normalized"] == ""
    assert tags.suggest(conn, "")["items"] == []
    conn.close()


def test_suggest_without_embedder_still_text_matches(data_dir, monkeypatch):
    import photolib.embedder as emb

    def boom():
        raise config.ModelUnavailable("no embedding model")

    monkeypatch.setattr(emb, "get_embedder", boom)
    tags.invalidate_vocab()
    tags._QUERY_VECS.clear()
    conn = db.connect()
    r = tags.suggest(conn, "pige")
    assert [i["label"] for i in r["items"]] == ["pigeon"] and r["items"][0]["similarity"] is None
    conn.close()
    tags.invalidate_vocab()


# --------------------------------------------------------------------------- manual tags


def test_manual_add_remove_and_ranks(data_dir, fake_embedder):
    conn = db.connect()
    with conn:
        _add_image(conn, "a.jpg", mix({"dog": 0.8, "pet": 0.5, "collar": 0.4}))
        db.replace_subjects(
            conn, "a.jpg",
            [{"label": "dog", "score": 0.99, "source": "d1", "eg_score": 0.7, "display_rank": 1},
             {"label": "pet", "score": 0.95, "source": "d1", "eg_score": 0.5, "display_rank": 2}],
            "d1-3B", "2025-01-01T00:00:00",
        )
    r = tags.add_tag(conn, "a.jpg", "  Mammal ")  # existing builtin label
    assert r["label"] == "mammal" and r["created"] is False and r["added"] is True
    assert _subjects(conn, "a.jpg") == [("mammal", "user", 1), ("dog", "d1", 2), ("pet", "d1", 3)]
    first = r["subjects"][0]
    assert first["label"] == "mammal" and first["source"] == "user" and first["score"] == 1.0 and first["display_rank"] == 1

    r = tags.add_tag(conn, "a.jpg", "Collar", "Is the animal wearing a collar?")  # brand new label
    assert r["created"] is True and r["added"] is True
    row = db.get_label(conn, "collar")
    assert row["source"] == "user" and row["question"] == "Is the animal wearing a collar?" and row["created_at"]
    assert _subjects(conn, "a.jpg") == [("mammal", "user", 1), ("collar", "user", 2), ("dog", "d1", 3), ("pet", "d1", 4)]
    eg = conn.execute("SELECT eg_score FROM subjects WHERE rel_path = 'a.jpg' AND label = 'collar'").fetchone()[0]
    assert eg == pytest.approx(float(text_vec("collar") @ mix({"dog": 0.8, "pet": 0.5, "collar": 0.4})), abs=1e-3)
    assert tags.get_vocab(conn).labels[-1] == "collar"  # the vocabulary cache picked the new label up

    # idempotent; a model tag is not converted
    again = tags.add_tag(conn, "a.jpg", "collar")
    assert again["created"] is False and again["added"] is False
    assert tags.add_tag(conn, "a.jpg", "dog")["added"] is False
    assert _subjects(conn, "a.jpg")[2] == ("dog", "d1", 3)

    with pytest.raises(labels.LabelError):
        tags.add_tag(conn, "a.jpg", "???")
    with pytest.raises(LookupError):
        tags.add_tag(conn, "missing.jpg", "dog")
    assert db.get_label(conn, "???") is None

    # remove: manual only; the label stays in the vocabulary
    with pytest.raises(tags.TagConflict):
        tags.remove_tag(conn, "a.jpg", "dog")
    with pytest.raises(LookupError):
        tags.remove_tag(conn, "a.jpg", "whale")
    r = tags.remove_tag(conn, "a.jpg", "Mammal")
    assert [s["label"] for s in r["subjects"]] == ["collar", "dog", "pet"]
    assert _subjects(conn, "a.jpg") == [("collar", "user", 1), ("dog", "d1", 2), ("pet", "d1", 3)]
    assert db.get_label(conn, "collar") and db.get_label(conn, "mammal")

    # summaries and filters see manual tags like any other subject
    items, total = search.list_images(conn, search.Filters(subjects=["collar"]))
    assert total == 1 and items[0]["subjects"][0] == {"label": "collar", "score": 1.0, "source": "user"}
    assert {"label": "collar", "count": 1, "category": None} in search.subject_counts(conn)
    lst = {r["label"]: r for r in tags.list_labels(conn)}
    assert lst["collar"]["count"] == 1 and lst["collar"]["manual_count"] == 1 and lst["collar"]["source"] == "user"
    assert lst["dog"]["count"] == 1 and lst["dog"]["manual_count"] == 0

    # deleting a label removes its rows and re-ranks
    with conn:
        assert db.delete_label(conn, "collar") == 1
    assert _subjects(conn, "a.jpg") == [("dog", "d1", 1), ("pet", "d1", 2)] and db.get_label(conn, "collar") is None
    assert "collar" not in tags.get_vocab(conn).labels
    conn.close()


def _seed_catalog(tmp_path, vecs: dict[str, np.ndarray]):
    cat = tmp_path / "cat"
    cat.mkdir()
    config.save_config({"catalog_dir": str(cat)})  # first: the index folder depends on the catalog
    conn = db.connect()
    with conn:
        for i, (name, v) in enumerate(vecs.items()):
            Image.new("RGB", (32 + i, 24), (i * 20 % 255, 100, 50)).save(cat / name)  # width identifies the photo
            _add_image(conn, name, v, tagged=False)
    conn.close()
    return cat


def test_retag_preserves_manual_tags(data_dir, tmp_path, fake_embedder, install_tagger):
    _seed_catalog(tmp_path, {
        "p0.jpg": mix({"dog": 0.9, "pet": 0.7, "mammal": 0.5}),
        "p1.jpg": mix({"flower": 0.9, "plant": 0.6}),
        "p2.jpg": mix({"ocean": 0.9}),
    })
    # photos are 32/33/34 px wide (p0/p1/p2): the fake d1 answers per photo
    def d1(yes: dict[int, dict[str, float]]):
        return FakeTagger(lambda image, lb: yes.get(image.size[0], {}).get(lb, 0.01))

    install_tagger(d1({32: {"dog": 0.99, "pet": 0.9}, 33: {"flower": 0.97}}))
    res = indexer.tag()
    assert res["error"] is None and res["tag_done"] == 3
    conn = db.connect()
    assert _subjects(conn, "p0.jpg") == [("dog", "d1", 1), ("pet", "d1", 2)]
    assert _subjects(conn, "p2.jpg")[0][1] == "eg"  # d1 rejected everything -> EG fallback

    tags.add_tag(conn, "p0.jpg", "kelpie")  # new user label
    tags.add_tag(conn, "p0.jpg", "mammal")  # builtin label d1 does not confirm
    tags.add_tag(conn, "p1.jpg", "plant")  # builtin label d1 WILL confirm on the retag
    tags.add_tag(conn, "p2.jpg", "whale")
    assert _subjects(conn, "p0.jpg") == [("kelpie", "user", 1), ("mammal", "user", 2), ("dog", "d1", 3), ("pet", "d1", 4)]
    conn.close()

    t = install_tagger(d1({32: {"dog": 0.99, "pet": 0.2}, 33: {"plant": 0.93, "flower": 0.97}}))
    res = indexer.tag(retag=True)
    assert res["error"] is None and res["mode"] == "retag" and res["tag_done"] == 3 and res["untagged"] == 0
    # the retag asked about the user-created labels too (they are part of the vocabulary now)
    assert len(tags.get_vocab(db.connect()).labels) == len(labels.VOCABULARY) + 2
    conn = db.connect()
    assert _subjects(conn, "p0.jpg") == [("kelpie", "user", 1), ("mammal", "user", 2), ("dog", "d1", 3)]  # pet dropped
    assert _subjects(conn, "p1.jpg") == [("plant", "user", 1), ("flower", "d1", 2)]  # still manual, not duplicated
    assert _subjects(conn, "p2.jpg") == [("whale", "user", 1)]  # no EG fallback next to a manual tag
    assert conn.execute("SELECT score FROM subjects WHERE rel_path = 'p1.jpg' AND label = 'plant'").fetchone()[0] == 1.0
    assert db.tag_counts(conn) == (3, 0) and t.unloaded == 1
    conn.close()


# --------------------------------------------------------------------------- propagation


def _propagation_fixture(tmp_path):
    """8 tagged photos; 'jellyfish' (a user label) is an EG top-20 label for j0..j4 only."""
    vecs = {f"j{i}.jpg": mix({"jellyfish": 0.5 + 0.05 * i, "fish": 0.6, "water": 0.4}) for i in range(5)}
    vecs |= {f"x{i}.jpg": mix({"dog": 0.9, "pet": 0.5, f"noise{i}": 0.3}) for i in range(3)}
    cat = _seed_catalog(tmp_path, vecs)
    conn = db.connect()
    with conn:
        conn.execute("UPDATE images SET tagged_at = '2025-01-01T00:00:00', tagger = 'd1-3B'")
        for rp in vecs:
            db.add_subject(conn, rp, "fish" if rp.startswith("j") else "dog", 0.95, "d1", 0.9)
    return cat, conn


def test_propagation_candidates_rule(data_dir, tmp_path, fake_embedder):
    _, conn = _propagation_fixture(tmp_path)
    r = tags.add_tag(conn, "j0.jpg", "Jellyfish")
    assert r["created"] is True
    cands = tags.propagation_candidates(conn, ["jellyfish"])
    assert list(cands) == ["j1.jpg", "j2.jpg", "j3.jpg", "j4.jpg"]  # j0 already has it; x* never rank it top-20
    assert [c[0][0] for c in cands.values()] == ["jellyfish"] * 4
    assert cands["j4.jpg"][0][1] == pytest.approx(float(text_vec("jellyfish") @ search.get_cache(conn).mat[search.get_cache(conn).index["j4.jpg"]]), abs=1e-3)
    assert tags.propagation_preview(conn, ["jellyfish"]) == {"candidates": 4, "est_seconds": tags.estimate_seconds(4)}

    # same answer as the tag rule: a photo is a candidate iff the label is in subjects.candidates() for it
    from photolib import subjects

    vocab = tags.get_vocab(conn)
    cache = search.get_cache(conn)
    for lb in ("jellyfish", "dog", "water", "pet", "bird"):
        expect = sorted(
            rp for i, rp in enumerate(cache.ids)
            if lb in [c for c, _ in subjects.candidates(vocab.matrix() @ cache.mat[i], vocab.labels)]
            and db.subject_source(conn, rp, lb) is None
        )
        assert list(tags.propagation_candidates(conn, [lb])) == expect, lb

    # untagged photos are left to the normal tag pass; unknown labels give nothing
    with conn:
        conn.execute("UPDATE images SET tagged_at = NULL WHERE rel_path = 'j3.jpg'")
    assert list(tags.propagation_candidates(conn, ["jellyfish"])) == ["j1.jpg", "j2.jpg", "j4.jpg"]
    assert tags.propagation_candidates(conn, ["nope"]) == {}
    # several labels: one entry per photo with all its questions
    multi = tags.propagation_candidates(conn, ["jellyfish", "water"])
    assert [lb for lb, _ in multi["j1.jpg"]] == ["jellyfish", "water"]
    conn.close()


def test_propagate_job_with_mock_tagger(data_dir, tmp_path, fake_embedder, install_tagger):
    _, conn = _propagation_fixture(tmp_path)
    tags.add_tag(conn, "j0.jpg", "jellyfish", "Is there a jellyfish in this photo?")
    before = {rp: _subjects(conn, rp) for rp in ("j1.jpg", "j2.jpg", "x0.jpg")}
    tagged_at = conn.execute("SELECT rel_path, tagged_at FROM images ORDER BY 1").fetchall()
    conn.close()

    # photo j<i>.jpg is (32 + i) px wide (insertion order): d1 "sees" jellyfish in j1 (0.8, inclusive) and j3 only
    t = install_tagger(FakeTagger(lambda image, lb: {33: 0.8, 34: 0.79, 35: 0.97, 36: 0.1}.get(image.size[0], 0.0)))
    res = indexer.propagate(["jellyfish"])
    assert res["error"] is None and res["mode"] == "propagate" and res["phase"] == "done"
    assert res["total"] == 4 and res["done"] == 4 and res["propagate_added"] == 2 and res["labels"] == ["jellyfish"]
    assert t.calls == [["jellyfish"]] * 4  # ONE question per candidate photo, nothing else asked
    assert t.questions[0]["jellyfish"] == "Is there a jellyfish in this photo?"
    assert t.unloaded == 1

    conn = db.connect()
    rows = {r[0]: tuple(r)[1:] for r in conn.execute("SELECT rel_path, score, source, eg_score FROM subjects WHERE label = 'jellyfish'")}
    assert set(rows) == {"j0.jpg", "j1.jpg", "j3.jpg"}
    assert rows["j0.jpg"][:2] == (1.0, "user") and rows["j1.jpg"][:2] == (0.8, "d1") and rows["j3.jpg"][:2] == (0.97, "d1")
    assert rows["j3.jpg"][2] == pytest.approx(float(text_vec("jellyfish") @ mix({"jellyfish": 0.65, "fish": 0.6, "water": 0.4})), abs=1e-3)
    # appended in EG order after the existing model row; other photos / rows / tagged_at untouched
    assert _subjects(conn, "j1.jpg") == [("fish", "d1", 1), ("jellyfish", "d1", 2)]
    assert _subjects(conn, "j2.jpg") == before["j2.jpg"] and _subjects(conn, "x0.jpg") == before["x0.jpg"]
    assert conn.execute("SELECT rel_path, tagged_at FROM images ORDER BY 1").fetchall() == tagged_at
    conn.close()

    # running it again only re-asks the photos that still lack the label; nothing new -> d1 not even loaded
    t2 = install_tagger(FakeTagger({}))
    res = indexer.propagate(["jellyfish"])
    assert res["total"] == 2 and res["propagate_added"] == 0 and len(t2.calls) == 2
    conn = db.connect()
    with conn:
        for rp in ("j2.jpg", "j4.jpg"):
            db.add_subject(conn, rp, "jellyfish", 1.0, "user", None)
    conn.close()
    t3 = install_tagger(FakeTagger({}))
    res = indexer.propagate(["jellyfish"])
    assert res["total"] == 0 and res["error"] is None and t3.calls == [] and t3.unloaded == 0

    res = indexer.propagate(["not a label"])
    assert "unknown label" in res["error"]


def test_propagate_interrupt_leaves_consistent_db(data_dir, tmp_path, fake_embedder, install_tagger):
    _, conn = _propagation_fixture(tmp_path)
    tags.add_tag(conn, "j0.jpg", "jellyfish")
    conn.close()
    t = install_tagger(FakeTagger({"jellyfish": 0.95}, fail_after=2))
    with pytest.raises(KeyboardInterrupt):
        indexer.propagate(["jellyfish"])
    snap = indexer.PROGRESS.snapshot()
    assert snap["interrupted"] and not snap["running"] and snap["propagate_added"] == 2 and t.unloaded == 1
    conn = db.connect()
    assert conn.execute("SELECT COUNT(*) FROM subjects WHERE label = 'jellyfish'").fetchone()[0] == 3
    ranks = conn.execute("SELECT rel_path, COUNT(*), MIN(display_rank), MAX(display_rank) FROM subjects GROUP BY 1").fetchall()
    assert all(r[2] == 1 and r[3] == r[1] for r in ranks)  # contiguous ranks everywhere
    conn.close()
    install_tagger(FakeTagger({"jellyfish": 0.95}))
    res = indexer.propagate(["jellyfish"])  # rerun finishes the rest
    assert res["total"] == 2 and res["propagate_added"] == 2


# --------------------------------------------------------------------------- API


def test_tag_api(data_dir, tmp_path, fake_embedder, install_tagger):
    _, conn = _propagation_fixture(tmp_path)
    conn.close()
    import photolib.api as api_mod

    install_tagger(FakeTagger())
    c = TestClient(api_mod.app)

    s = c.get("/api/labels/suggest", params={"q": "Fish", "image": "j0.jpg"}).json()
    assert s["items"][0] == {"label": "fish", "count": 5, "match": "exact", "similarity": pytest.approx(1.0, abs=1e-3), "source": "builtin", "on_image": True}
    assert s["exact_exists"] is True and s["normalized"] == "fish"

    # existing label: no propagation preview
    r = c.post("/api/images/j0.jpg/tags", json={"label": "Water"})
    assert r.status_code == 200 and r.json()["created"] is False and "propagate" not in r.json()
    assert r.json()["subjects"][0]["label"] == "water" and r.json()["subjects"][0]["source"] == "user"

    # new label: created + preview
    r = c.post("/api/images/j0.jpg/tags", json={"label": " JellyFish "}).json()
    assert r["label"] == "jellyfish" and r["created"] is True
    assert r["propagate"] == {"candidates": 4, "est_seconds": tags.estimate_seconds(4)}
    assert [x["label"] for x in r["subjects"]][:2] == ["water", "jellyfish"]
    assert c.get("/api/images/j0.jpg").json()["subjects"][1]["source"] == "user"
    st = c.get("/api/status").json()["tagger"]
    assert st["labels"] == len(labels.VOCABULARY) + 1 and st["user_labels"] == 1

    assert c.post("/api/images/j0.jpg/tags", json={"label": "!!"}).status_code == 422
    assert c.post("/api/images/j0.jpg/tags", json={"label": "a/b"}).status_code == 422
    assert c.post("/api/images/nope.jpg/tags", json={"label": "dog"}).status_code == 404

    # delete: manual only
    assert c.delete("/api/images/j0.jpg/tags/fish").status_code == 409
    assert c.delete("/api/images/j0.jpg/tags/whale").status_code == 404
    assert c.delete("/api/images/nope.jpg/tags/water").status_code == 404
    r = c.delete("/api/images/j0.jpg/tags/water")
    assert r.status_code == 200 and [x["label"] for x in r.json()["subjects"]] == ["jellyfish", "fish"]

    allv = c.get("/api/labels").json()["items"]
    assert len(allv) == len(labels.VOCABULARY) + 1 and allv[-1]["label"] == "jellyfish" and allv[-1]["source"] == "user"
    assert allv[-1]["count"] == 1 and allv[-1]["manual_count"] == 1
    assert {"label": "jellyfish", "count": 1, "category": None} in c.get("/api/subjects").json()["items"]  # filter chips include it

    assert c.get("/api/labels/jellyfish/propagate/preview").json()["candidates"] == 4
    assert c.get("/api/labels/nope/propagate/preview").status_code == 404
    assert c.post("/api/labels/jellyfish/propagate", json={}).status_code == 400
    assert c.post("/api/labels/nope/propagate", json={"confirm": True}).status_code == 404

    # 409 while another run holds the lock
    assert indexer._RUN_LOCK.acquire(blocking=False)
    try:
        assert c.post("/api/labels/jellyfish/propagate", json={"confirm": True}).status_code == 409
    finally:
        indexer._RUN_LOCK.release()

    install_tagger(FakeTagger({"jellyfish": 0.9}))
    r = c.post("/api/labels/jellyfish/propagate", json={"confirm": True}).json()
    assert r == {"ok": True, "started": True, "candidates": 4, "est_seconds": tags.estimate_seconds(4)}
    p = wait_idle(c)
    assert p["mode"] == "propagate" and p["phase"] == "done" and p["error"] is None
    assert p["total"] == 4 and p["propagate_added"] == 4 and p["labels"] == ["jellyfish"]
    assert c.get("/api/images", params={"subject": "jellyfish"}).json()["total"] == 5
    # nothing left: the job is not even started
    r = c.post("/api/labels/jellyfish/propagate", json={"confirm": True}).json()
    assert r["started"] is False and r["candidates"] == 0


# --------------------------------------------------------------------------- real models (slow)

JELLY = ["5N7A1464.jpg", "5N7A1468.jpg", "5N7A1476.jpg"]
OTHERS = ["5N7A1263.jpg", "5N7A1268.jpg", "5N7A1286.jpg", "5N7A1396.jpg"]  # dog, marigold, pigeons, trout


@pytest.mark.slow
def test_real_manual_tag_propagation_and_retag(sample_dir, data_dir, tmp_path):
    """Create "jellyfish" (not a builtin label) on one photo, propagate with real EG + d1, then retag."""
    from photolib import search as search_mod
    from photolib.api import app
    from photolib.tagger import get_tagger

    assert "jellyfish" not in labels.VOCABULARY and "snowman" not in labels.VOCABULARY
    tags.invalidate_vocab()
    search_mod.invalidate_cache()
    cat = tmp_path / "catalog"
    cat.mkdir()
    for name in JELLY + OTHERS:
        shutil.copyfile(sample_dir / name, cat / name)
    config.save_config({"catalog_dir": str(cat)})
    res = indexer.refresh(cat)
    assert res["error"] is None and res["tagged"] == 7

    c = TestClient(app)
    s = c.get("/api/labels/suggest", params={"q": "pigeons", "image": JELLY[0]}).json()
    assert s["items"][0]["label"] == "pigeon" and s["exact_exists"] is False
    assert c.get("/api/labels/suggest", params={"q": "sea"}).json()["items"][0] == {
        "label": "ocean", "count": s_count(c, "ocean"), "match": "similar",
        "similarity": pytest.approx(0.9, abs=0.05), "source": "builtin", "on_image": False,
    }
    assert c.get("/api/labels/suggest", params={"q": "puppy"}).json()["items"][0]["label"] == "dog"
    assert c.get("/api/labels/suggest", params={"q": "asdfgh"}).json()["items"] == []

    r = c.post(f"/api/images/{JELLY[0]}/tags", json={"label": "Jellyfish"}).json()
    assert r["created"] is True and r["subjects"][0]["label"] == "jellyfish" and r["subjects"][0]["source"] == "user"
    assert 2 <= r["propagate"]["candidates"] <= 6  # the other jellyfish photos (+ maybe the trout); never the tagged one

    assert c.post("/api/labels/jellyfish/propagate", json={"confirm": True}).json()["started"] is True
    p = wait_idle(c)
    assert p["error"] is None and p["mode"] == "propagate" and p["propagate_added"] == 2
    assert not get_tagger().loaded  # d1 unloaded when the job ends
    have = {i["id"] for i in c.get("/api/images", params={"subject": "jellyfish"}).json()["items"]}
    assert have == set(JELLY)
    d = {x["label"]: x for x in c.get(f"/api/images/{JELLY[1]}").json()["subjects"]}
    assert d["jellyfish"]["source"] == "d1" and d["jellyfish"]["score"] >= 0.8

    # a tag nothing else shows: propagation adds nothing
    r = c.post(f"/api/images/{OTHERS[0]}/tags", json={"label": "snowman"}).json()
    assert r["created"] is True
    out = c.post("/api/labels/snowman/propagate", json={"confirm": True}).json()
    if out["started"]:
        p = wait_idle(c)
        assert p["error"] is None and p["propagate_added"] == 0
    assert c.get("/api/images", params={"subject": "snowman"}).json()["total"] == 1

    # a full retag keeps both manual tags and re-finds jellyfish on the other photos (it is in the vocabulary now)
    assert c.post("/api/admin/retag", json={"confirm": True}).json()["ok"] is True
    p = wait_idle(c)
    assert p["error"] is None and p["tag_done"] == 7
    subs = {x["label"]: x["source"] for x in c.get(f"/api/images/{JELLY[0]}").json()["subjects"]}
    assert subs["jellyfish"] == "user"
    assert c.get(f"/api/images/{OTHERS[0]}").json()["subjects"][0] == {
        "label": "snowman", "score": 1.0, "source": "user", "eg_score": pytest.approx(0.5, abs=0.5), "display_rank": 1,
    }
    have = {i["id"] for i in c.get("/api/images", params={"subject": "jellyfish"}).json()["items"]}
    assert have == set(JELLY)
    assert not get_tagger().loaded


def s_count(c, label: str) -> int:
    return next((i["count"] for i in c.get("/api/subjects").json()["items"] if i["label"] == label), 0)
