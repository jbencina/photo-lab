"""Hybrid tag rule (EG top-20 -> d1 P >= 0.8 -> EG-ranked, EG fallback) and the resumable tag pass, with d1 mocked."""

import numpy as np
import pytest
from PIL import Image

from conftest import FakeTagger
from photolib import config, db, indexer, labels, subjects

VOCAB = [f"label{i:02d}" for i in range(40)]


def _eg_row(order: list[int]) -> np.ndarray:
    """Cosines that rank VOCAB in the given index order (first = best)."""
    row = np.zeros(len(VOCAB), dtype=np.float32)
    for rank, j in enumerate(order):
        row[j] = 0.8 - rank * 0.005
    return row


def test_candidates_top20():
    row = _eg_row(list(range(39, -1, -1)))
    c = subjects.candidates(row, VOCAB, k=20)
    assert [lb for lb, _ in c] == [VOCAB[j] for j in range(39, 19, -1)]
    assert c[0][1] == pytest.approx(0.8)


def test_rule_keeps_p_ge_threshold_ranked_by_eg():
    row = _eg_row(list(range(40)))  # label00 best
    t = FakeTagger({"label05": 0.99, "label01": 0.80, "label02": 0.79, "label30": 0.99, "label19": 0.95})
    labels_mat = np.eye(40, dtype=np.float32)
    out = subjects.tag_image(Image.new("RGB", (8, 8)), row, labels_mat, t, vocabulary=VOCAB)
    assert t.calls == [VOCAB[:20]]  # exactly EG's top 20, best first; label30 never asked
    assert [s["label"] for s in out] == ["label01", "label05", "label19"]  # 0.8 inclusive, 0.79 out, by EG cosine
    assert [s["display_rank"] for s in out] == [1, 2, 3]
    assert all(s["source"] == "d1" for s in out)
    assert out[0]["score"] == 0.8 and out[0]["eg_score"] == pytest.approx(0.795)


def test_rule_falls_back_to_eg_top1():
    row = _eg_row([7] + [j for j in range(40) if j != 7])
    out = subjects.tag_image(Image.new("RGB", (8, 8)), row, np.eye(40, dtype=np.float32), FakeTagger({}), vocabulary=VOCAB)
    assert out == [{"label": "label07", "score": 0.8, "source": "eg", "eg_score": 0.8, "display_rank": 1}]


def _seed_catalog(tmp_path, n=6):
    cat = tmp_path / "cat"
    cat.mkdir()
    config.save_config({"catalog_dir": str(cat)})  # first: the index folder depends on the catalog
    conn = db.connect()
    rng = np.random.default_rng(0)
    with conn:
        for i in range(n):
            name = f"p{i}.jpg"
            Image.new("RGB", (32, 24), (i * 30, 100, 50)).save(cat / name)
            v = rng.normal(size=768).astype(np.float32)
            db.insert_image(conn, {"rel_path": name, "file_name": name, "sha1": "ab" * 20, "colors_json": "[]", "liked": 0},
                            v / np.linalg.norm(v))
    conn.close()
    return cat


@pytest.fixture
def fake_models(fake_embedder, install_tagger):
    """Fake EmbeddingGemma label vectors (for the DB vocabulary) and a mock d1 for the indexer's tag pass."""
    return install_tagger


def test_tag_pass_resumes_after_interrupt_without_duplicates(data_dir, tmp_path, fake_models):
    _seed_catalog(tmp_path, n=6)
    probs = {lb: 0.95 for lb in labels.VOCABULARY[::2]}  # the pass uses the DB vocabulary (seeded from labels.py)

    t1 = FakeTagger(probs, fail_after=2)
    fake_models(t1)
    with pytest.raises(KeyboardInterrupt):
        indexer.tag()
    assert t1.unloaded == 1  # unloaded even when interrupted
    snap = indexer.PROGRESS.snapshot()
    assert snap["interrupted"] and not snap["running"] and snap["tag_done"] == 2
    conn = db.connect()
    assert db.tag_counts(conn) == (2, 4)
    assert db.untagged_rel_paths(conn) == ["p2.jpg", "p3.jpg", "p4.jpg", "p5.jpg"]  # rel_path order -> resumable
    conn.close()

    t2 = FakeTagger(probs)
    fake_models(t2)
    res = indexer.tag()
    assert res["error"] is None and res["phase"] == "done" and res["tag_done"] == 4
    assert len(t2.calls) == 4  # only the untagged ones
    assert all(len(c) == config.TAG_CANDIDATES and set(c) <= set(labels.VOCABULARY) for c in t2.calls)
    assert t2.questions[0] is not None and "citrus" in (t2.questions[0].get("orange") or "")  # DB questions reach d1
    assert res["tagged"] == 6 and res["untagged"] == 0 and t2.unloaded == 1

    conn = db.connect()
    assert db.tag_counts(conn) == (6, 0)
    dup = conn.execute("SELECT COUNT(*) FROM (SELECT rel_path, label FROM subjects GROUP BY rel_path, label HAVING COUNT(*) > 1)").fetchone()[0]
    assert dup == 0
    per_img = conn.execute("SELECT rel_path, COUNT(*), MIN(display_rank), MAX(display_rank) FROM subjects GROUP BY rel_path").fetchall()
    assert len(per_img) == 6 and all(r[2] == 1 and r[3] == r[1] for r in per_img)
    assert {r[0] for r in conn.execute("SELECT DISTINCT tagger FROM images")} == {config.TAGGER_SHORT}
    conn.close()

    # retag: everything again, replacing (not adding) rows; --limit caps the run
    t3 = FakeTagger({labels.VOCABULARY[0]: 0.99})
    fake_models(t3)
    res = indexer.tag(retag=True, limit=3)
    assert res["mode"] == "retag" and res["tag_done"] == 3 and res["untagged"] == 3
    res = indexer.tag()
    assert res["tag_done"] == 3 and res["untagged"] == 0
    conn = db.connect()
    rows = conn.execute("SELECT COUNT(*) FROM subjects").fetchone()[0]
    assert rows == 6  # one subject per image now ('bird' or the EG fallback)
    conn.close()


def test_progress_rate_and_eta():
    p = indexer.ProgressState()
    p.reset(running=True)
    p.start_phase("tagging", 10)
    p.mark_ready()
    import time

    time.sleep(0.05)
    p.advance(1)
    time.sleep(0.05)
    p.advance(1)
    s = p.snapshot()
    assert s["phase"] == "tagging" and s["done"] == 2 and s["rate"] > 0
    assert s["eta_seconds"] == pytest.approx(8 / s["rate"], rel=0.05)
