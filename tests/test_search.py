"""numpy vector cache: exact filtered semantic / similar / color search vs brute force."""

import json

import numpy as np

from photolib import colors, db, search

N = 300


def _setup(rng):
    vecs = rng.normal(size=(N, 768)).astype(np.float32)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    palettes = []
    conn = db.connect()
    with conn:
        for i, v in enumerate(vecs):
            k = int(rng.integers(1, 7))
            rgb = rng.integers(0, 256, size=(k, 3))
            share = rng.dirichlet(np.ones(k))
            pal = [
                {"hex": colors.to_hex(c), "lab": [round(float(x), 2) for x in colors.rgb_to_lab(c)], "share": round(float(s), 4)}
                for c, s in zip(rgb, share)
            ]
            palettes.append(pal)
            db.insert_image(
                conn,
                {"rel_path": f"d{i % 3}/img_{i:04d}.jpg", "file_name": f"img_{i:04d}.jpg", "sha1": "ab" * 20,
                 "colors_json": json.dumps(pal), "liked": int(i % 5 == 0), "make": "Canon" if i % 2 else "Nikon",
                 "iso": 100 * (i % 16 + 1)},
                v,
            )
            label = "bird" if i % 3 == 0 else "flower"
            db.replace_subjects(conn, f"d{i % 3}/img_{i:04d}.jpg",
                                [{"label": label, "score": 0.9, "source": "d1", "eg_score": 0.7, "display_rank": 1}],
                                "d1-3B", "2025-01-01T00:00:00")
    ids = [f"d{i % 3}/img_{i:04d}.jpg" for i in range(N)]
    return conn, vecs, palettes, ids


def _brute(vecs, ids, q, keep, k, exclude=None):
    scored = [(ids[i], float(vecs[i] @ q)) for i in range(len(ids)) if keep(i) and ids[i] != exclude]
    scored.sort(key=lambda t: (-t[1], t[0]))
    return scored[:k]


def test_semantic_equals_brute_force_with_filters(data_dir):
    rng = np.random.default_rng(1)
    conn, vecs, _, ids = _setup(rng)
    q = rng.normal(size=768).astype(np.float32)
    q /= np.linalg.norm(q)

    cases = [
        (search.Filters(), lambda i: True),
        (search.Filters(make="Canon"), lambda i: i % 2 == 1),
        (search.Filters(liked=True), lambda i: i % 5 == 0),
        (search.Filters(subjects=["bird"]), lambda i: i % 3 == 0),
        (search.Filters(make="Canon", subjects=["bird"], iso_max=800), lambda i: i % 2 == 1 and i % 3 == 0 and 100 * (i % 16 + 1) <= 800),
        (search.Filters(make="Nobody"), lambda i: False),
    ]
    for f, keep in cases:
        expected = _brute(vecs, ids, q, keep, 1000)
        got = search.semantic(conn, q, f, limit=1000)
        assert [g["id"] for g in got] == [e[0] for e in expected], f
        assert np.allclose([g["score"] for g in got], [e[1] for e in expected], atol=1e-4)
        # paging is exact (no oversampling): offset windows tile the full ranking
        page = search.semantic(conn, q, f, limit=7, offset=5)
        assert [g["id"] for g in page] == [e[0] for e in expected[5:12]]

    # similar: excludes the source, ranks by its stored vector, filters apply
    src = ids[42]
    sim = search.semantic(conn, db.get_embedding(conn, src), search.Filters(make="Canon"), limit=20, exclude=src)
    exp = _brute(vecs, ids, vecs[42], lambda i: i % 2 == 1, 20, exclude=src)
    assert [s["id"] for s in sim] == [e[0] for e in exp] and src not in [s["id"] for s in sim]
    conn.close()


def test_cache_invalidates_on_insert_and_delete(data_dir):
    rng = np.random.default_rng(2)
    conn, vecs, _, ids = _setup(rng)
    c1 = search.get_cache(conn)
    assert c1 is search.get_cache(conn)  # same token -> no reload
    assert len(c1.ids) == N and c1.mat.shape == (N, 768)

    new = rng.normal(size=768).astype(np.float32)
    new /= np.linalg.norm(new)
    with conn:
        db.insert_image(conn, {"rel_path": "zz_new.jpg", "file_name": "zz_new.jpg", "sha1": "cd" * 20,
                               "colors_json": "[]", "liked": 0}, new)
    hit = search.semantic(conn, new, search.Filters(), limit=1)
    assert hit[0]["id"] == "zz_new.jpg" and abs(hit[0]["score"] - 1) < 1e-4
    c2 = search.get_cache(conn)
    assert c2 is not c1 and len(c2.ids) == N + 1

    # a second connection (another request) sees the same token -> shares the cache
    other = db.connect()
    assert search.get_cache(other) is c2
    other.close()

    with conn:
        db.delete_image(conn, "zz_new.jpg")
    assert search.semantic(conn, new, search.Filters(), limit=1)[0]["id"] != "zz_new.jpg"
    conn.close()


def test_color_vectorised_equals_scalar(data_dir):
    rng = np.random.default_rng(3)
    conn, _, palettes, ids = _setup(rng)
    cache = search.get_cache(conn)
    for hex_ in ("#ff8800", "#2050ff", "#000000", "#ffffff", "#3a5f2e"):
        q = colors.hex_to_lab(hex_)
        vec = search.color_scores(cache.pal_lab, cache.pal_share, q)
        order = [cache.index[i] for i in ids]
        scalar = np.array([colors.color_score(p, q) for p in palettes])
        assert np.allclose(vec[order], scalar, atol=1e-9), hex_

        got = search.color_search(conn, hex_, search.Filters(subjects=["flower"]), limit=25)
        exp = sorted(((ids[i], scalar[i]) for i in range(N) if i % 3 != 0), key=lambda t: (-t[1], t[0]))[:25]
        assert [g["id"] for g in got] == [e[0] for e in exp]
        assert np.allclose([g["score"] for g in got], [e[1] for e in exp], atol=1e-4)
    conn.close()


def test_top_k_exact_with_ties():
    s = np.array([0.5, 0.9, 0.9, 0.1, 0.9, 0.7], dtype=np.float32)
    assert search.top_k(s, 2).tolist() == [1, 2]
    assert search.top_k(s, 4).tolist() == [1, 2, 4, 5]
    assert search.top_k(s, 99).tolist() == [1, 2, 4, 5, 0, 3]
    assert search.top_k(s, 0).tolist() == []


def test_summary_subjects_top5_by_display_rank_and_detail_all(data_dir):
    conn = db.connect()
    v = np.ones(768, dtype=np.float32) / np.sqrt(768)
    with conn:
        db.insert_image(conn, {"rel_path": "a.jpg", "file_name": "a.jpg", "sha1": "ab" * 20, "colors_json": "[]", "liked": 0}, v)
        subs = [{"label": f"l{r}", "score": 0.99 - r / 100, "source": "d1", "eg_score": 0.8 - r / 100, "display_rank": r}
                for r in (3, 1, 7, 2, 5, 4, 6)]
        db.replace_subjects(conn, "a.jpg", subs, "d1-3B", "2025-01-01T00:00:00")
    s = search.summaries(conn, ["a.jpg"])[0]
    assert [x["label"] for x in s["subjects"]] == ["l1", "l2", "l3", "l4", "l5"]
    assert set(s["subjects"][0]) == {"label", "score", "source"}
    d = search.detail(conn, "a.jpg")
    assert [x["label"] for x in d["subjects"]] == [f"l{r}" for r in range(1, 8)]
    assert d["subjects"][0]["eg_score"] == 0.79 and d["subjects"][0]["display_rank"] == 1 and d["tagger"] == "d1-3B"
    conn.close()
