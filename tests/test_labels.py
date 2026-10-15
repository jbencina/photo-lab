import re

from photolib import labels


def test_vocabulary_sanity():
    v = labels.VOCABULARY
    assert len(v) == len(set(v)), "labels must be unique"
    assert 120 <= len(v) <= 160, len(v)
    for lb in v:
        assert lb == lb.strip() and lb == lb.lower() and 1 <= len(lb) <= 32, lb
    # every entry belongs to exactly one category, in file order
    assert [e["label"] for group in labels.CATEGORIES.values() for e in group] == v
    assert all(labels.CATEGORY_OF[lb] for lb in v)
    # dropped as noisy in the d1 spike
    for noisy in ("macro", "wildlife", "interior"):
        assert noisy not in v
    # core labels the sample set relies on
    for core in ("bird", "pigeon", "dog", "marigold", "wild turkey", "flower", "power lines", "harbor", "boat"):
        assert core in v


def test_questions_format():
    assert labels.DEFAULT_QUESTION.format(label="pigeon") == "Is there a pigeon in this photo?"
    qs = labels.questions_for(labels.VOCABULARY)
    assert list(qs) == labels.VOCABULARY
    for lb, q in qs.items():
        assert q.endswith("?") and "{" not in q and "}" not in q, (lb, q)
        assert len(q) < 160
    assert qs["pigeon"] == "Is there a pigeon in this photo?"
    assert "citrus" in qs["orange"]
    assert "ready to eat" in qs["food"]
    assert "person" in qs["portrait"]
    # overrides are real overrides (not equal to the default)
    for e in labels.LABELS:
        if e["question"] is not None:
            assert e["question"] != labels.DEFAULT_QUESTION.format(label=e["label"])
            assert re.match(r"^[A-Z]", e["question"])
