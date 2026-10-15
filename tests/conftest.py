import hashlib
import os
import time
from pathlib import Path

import numpy as np
import pytest

SAMPLE_ENV = "PHOTOLIB_SAMPLE_DIR"  # folder with the sample photos the slow (real-model) tests expect


@pytest.fixture
def sample_dir() -> Path:
    env = os.environ.get(SAMPLE_ENV)
    if not env or not Path(env).is_dir():
        pytest.skip(f"sample folder not available (set {SAMPLE_ENV})")
    return Path(env)


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    monkeypatch.setenv("PHOTOLIB_DATA_DIR", str(d))
    return d


def text_vec(text: str) -> np.ndarray:
    """Deterministic pseudo-random unit vector per text (different texts are ~orthogonal in 768-d)."""
    seed = int.from_bytes(hashlib.sha1(text.encode("utf-8")).digest()[:8], "little")
    v = np.random.default_rng(seed).normal(size=768).astype(np.float32)
    return v / np.linalg.norm(v)


def mix(parts: dict[str, float]) -> np.ndarray:
    """Unit vector that is a weighted sum of text vectors -> controllable cosines against those texts."""
    v = sum(w * text_vec(t) for t, w in parts.items())
    return (v / np.linalg.norm(v)).astype(np.float32)


class FakeEmbedder:
    """Stands in for EmbeddingGemma: labels and queries share `text_vec`; `overrides` pins specific texts."""

    loaded = True

    def __init__(self) -> None:
        self.overrides: dict[str, np.ndarray] = {}
        self.queries: list[str] = []

    def _vec(self, text: str) -> np.ndarray:
        return self.overrides.get(text, text_vec(text))

    def encode_labels(self, labels):
        return np.stack([self._vec(lb) for lb in labels])

    def encode_query(self, text):
        self.queries.append(text)
        return self._vec(text)

    def model(self):
        return self

    def info(self):
        return {"name": "fake", "device": "cpu", "dtype": "float32", "dim": 768, "loaded": True}


class FakeTagger:
    """Stands in for d1: P(yes) from a dict (or a callable(image_size, label)); records what it was asked."""

    loaded = False

    def __init__(self, probs=None, fail_after: int | None = None):
        self.probs = probs or {}
        self.calls: list[list[str]] = []
        self.questions: list[dict | None] = []
        self.fail_after = fail_after
        self.unloaded = 0

    def tag(self, image, labels, questions=None):
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise KeyboardInterrupt  # simulated Ctrl-C mid-pass
        self.calls.append(list(labels))
        self.questions.append(dict(questions) if questions is not None else None)
        if callable(self.probs):
            return {lb: float(self.probs(image, lb)) for lb in labels}
        return {lb: self.probs.get(lb, 0.01) for lb in labels}

    def model(self):
        return self

    def unload(self):
        self.unloaded += 1

    def info(self):
        return {"name": "fake-d1", "device": "cpu", "dtype": "float32", "loaded": False}


@pytest.fixture
def fake_embedder(monkeypatch) -> FakeEmbedder:
    """EmbeddingGemma replaced everywhere (label matrix, query vectors); vocabulary/query caches reset."""
    import photolib.embedder as emb
    from photolib import search, tags

    fake = FakeEmbedder()
    monkeypatch.setattr(emb, "get_embedder", lambda: fake)
    tags.invalidate_vocab()
    tags._QUERY_VECS.clear()
    search.invalidate_cache()
    yield fake
    tags.invalidate_vocab()
    tags._QUERY_VECS.clear()
    search.invalidate_cache()


@pytest.fixture
def install_tagger(monkeypatch):
    """`install_tagger(FakeTagger(...))` makes the indexer's tag / propagate passes use it."""

    def install(t):
        import photolib.tagger as tg

        monkeypatch.setattr(tg, "get_tagger", lambda: t)
        return t

    return install


@pytest.fixture(autouse=True)
def models_local(monkeypatch):
    """Tests run as if started with `--embedding-model local --decision-model local` unless they say otherwise."""
    monkeypatch.setenv("PHOTOLIB_EMBEDDING_MODEL", "local")
    monkeypatch.setenv("PHOTOLIB_DECISION_MODEL", "local")


def wait_idle(client, timeout: float = 180) -> dict:
    """Polls the API until the background indexing job has finished and returns its final progress."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        p = client.get("/api/admin/progress").json()
        if not p["running"]:
            return p
        time.sleep(0.05)
    raise AssertionError("background job did not finish")
