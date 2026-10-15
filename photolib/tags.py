"""Manual tags, tag suggestions and per-label propagation.

* **Vocabulary cache** (`get_vocab`): the `labels` table (builtin seed + user labels) with its EmbeddingGemma
  text vectors, process-wide, keyed by `meta.labels_version` so it reloads when a label is added/removed.
  The tag pass, suggestions and propagation all read it.
* **Suggestions** (`suggest`): while typing a tag, rank EXISTING labels: exact > prefix > text (substring or
  word match, plural-insensitive) > similar (cosine between the EG text vector of the typed text and the
  label vectors, above `config.SUGGEST_SIMILAR_FLOOR`). The point is to pick "pigeon" instead of creating "pigeons".
* **Manual tags** (`add_tag` / `remove_tag`): `subjects` rows with `source='user'`, score 1.0, ranked first,
  kept by re-tags.
* **Propagation** (`propagation_candidates` here, the d1 loop in indexer.py): for a label, the photos where
  it ranks in the EG top-20 over the current vocabulary (exactly the photos where a full re-tag would ask d1
  about it) and that don't have it yet; d1 answers that one question per photo, P >= 0.8 -> a 'd1' row.
"""

from __future__ import annotations

import re
import sqlite3
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from . import config, db, search, subjects
from .labels import LabelError, clean_question, normalize_label, try_normalize
from .remote import RemoteModelError

# How "the embedding model can't be used right now" shows up: not configured, the remote endpoint failing,
# or the local weights / the `local` extra missing. Suggestions degrade to text matches on these; anything
# else is a bug and propagates.
MODEL_ERRORS = (config.ModelUnavailable, RemoteModelError, OSError, ImportError)

# The "similar" suggestion settings live in config.py (SUGGEST_*); README "Manual tags, suggestions and
# propagation" explains how the cosine floor was calibrated.


# --------------------------------------------------------------------------- vocabulary cache


@dataclass
class Vocab:
    """The tag vocabulary of one DB at one `labels_version`, with its text vectors.

    Attributes:
        key: `(db file, labels_version)` this snapshot was loaded for.
        rows: Label rows in vocabulary order (see `db.label_rows`).
        labels: The label texts, in vocabulary order.
        index: Position of each label in `labels`.
        questions: Custom question per label, or None for the default template.
    """

    key: tuple[str, str | None]
    rows: list[dict]
    labels: list[str] = field(init=False)
    index: dict[str, int] = field(init=False)
    questions: dict[str, str | None] = field(init=False)
    _mat: np.ndarray | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        """Derives `labels`, `index` and `questions` from `rows`."""
        self.labels = [r["label"] for r in self.rows]
        self.index = {lb: i for i, lb in enumerate(self.labels)}
        self.questions = {r["label"]: r["question"] for r in self.rows}

    def matrix(self) -> np.ndarray:
        """Returns the (n_labels, 768) EG text vectors in vocabulary order.

        EmbeddingGemma is loaded on first use. The embedder also caches per label text, so a changed
        vocabulary only encodes the new labels.
        """
        if self._mat is None:
            self._mat = np.ascontiguousarray(subjects.label_matrix(self.labels), dtype=np.float32)
        return self._mat


_VOCAB: Vocab | None = None
_VOCAB_LOCK = threading.Lock()


def get_vocab(conn: sqlite3.Connection) -> Vocab:
    """Returns the process-wide vocabulary, reloading it when this DB's `labels_version` token changed."""
    global _VOCAB
    key = (search._db_key(conn), db.labels_version(conn))
    v = _VOCAB
    if v is not None and v.key == key:
        return v
    with _VOCAB_LOCK:
        v = _VOCAB
        if v is None or v.key != key:
            v = Vocab(key, db.label_rows(conn))
            _VOCAB = v
    return v


def invalidate_vocab() -> None:
    """Drops the process-wide vocabulary so the next request reloads it."""
    global _VOCAB
    with _VOCAB_LOCK:
        _VOCAB = None


# --------------------------------------------------------------------------- suggestions


_QUERY_VECS: OrderedDict[str, np.ndarray] = OrderedDict()
_QUERY_VECS_MAX = 256
_QUERY_LOCK = threading.Lock()
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def query_vector(text: str) -> np.ndarray:
    """Returns the EG SearchQuery vector of typed text.

    A small LRU keeps recent vectors, because typing and backspacing repeat queries.
    """
    with _QUERY_LOCK:
        v = _QUERY_VECS.get(text)
        if v is not None:
            _QUERY_VECS.move_to_end(text)
            return v
    from .embedder import get_embedder

    v = get_embedder().encode_query(text)
    with _QUERY_LOCK:
        _QUERY_VECS[text] = v
        while len(_QUERY_VECS) > _QUERY_VECS_MAX:
            _QUERY_VECS.popitem(last=False)
    return v


def _stem(word: str) -> str:
    """Folds simple plurals so "pigeons" word-matches "pigeon" and "berry" matches "berries"."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith(("ches", "shes", "sses", "xes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _words(text: str) -> list[str]:
    return [_stem(w) for w in _WORD_RE.findall(text)]


def text_match(q: str, label: str) -> str | None:
    """Classifies how a normalized query matches one label.

    'text' = the query is a substring of the label, or every query word starts a label word ("fl bird" ->
    "bird in flight"), or every label word is one of the query's words ("big pigeons" -> "pigeon").
    Word comparisons fold simple plurals.

    Args:
        q: The normalized typed text.
        label: An existing label.

    Returns:
        'exact', 'prefix' or 'text', or None when the label doesn't match.
    """
    if label == q:
        return "exact"
    if label.startswith(q):
        return "prefix"
    if q in label:
        return "text"
    qw, lw = _words(q), _words(label)
    if not qw or not lw:
        return None
    if all(any(w.startswith(x) for w in lw) for x in qw):
        return "text"
    if all(w in qw for w in lw):
        return "text"
    return None


_TIER = {"exact": 0, "prefix": 1, "text": 2, "similar": 3}


def _on_image(conn: sqlite3.Connection, image: str | None) -> set[str]:
    if not image:
        return set()
    return {r[0] for r in conn.execute("SELECT label FROM subjects WHERE rel_path = ?", (image,))}


def suggest(conn: sqlite3.Connection, q: str | None, image: str | None = None, limit: int = 8) -> dict:
    """Suggests existing labels for typed text (see the module docstring for the ranking).

    Args:
        conn: An open connection.
        q: The typed text. When empty, the photo's top EG candidate labels that it doesn't have yet
            are offered instead.
        image: The photo being tagged, if any; its current labels are flagged `on_image`.
        limit: Maximum number of items.

    Returns:
        `{items: [{label, count, match, similarity, source, on_image}], exact_exists, normalized,
        can_create, reason}`. `match` is 'exact', 'prefix', 'text' or 'similar', or 'image' for the
        empty-query defaults. `reason` says why the text can't become a label, when it can't.
    """
    vocab = get_vocab(conn)
    limit = max(1, int(limit))
    raw = (q or "").strip()
    on_image = _on_image(conn, image)
    counts = db.label_counts(conn)
    source_of = {r["label"]: r["source"] for r in vocab.rows}

    def item(label: str, match: str, sim: float | None) -> dict:
        return {
            "label": label,
            "count": counts.get(label, (0, 0))[0],
            "match": match,
            "similarity": None if sim is None else round(float(sim), 4),
            "source": source_of[label],
            "on_image": label in on_image,
        }

    if not raw:
        items: list[dict] = []
        if image:
            vec = db.get_embedding(conn, image)
            if vec is not None and vocab.labels:
                try:
                    sims = vocab.matrix() @ np.asarray(vec, dtype=np.float32)
                except MODEL_ERRORS:  # no defaults rather than an error while typing
                    sims = None
                if sims is not None:
                    for j in np.argsort(-sims, kind="stable"):
                        if vocab.labels[j] not in on_image:
                            items.append(item(vocab.labels[j], "image", sims[j]))
                            if len(items) >= limit:
                                break
        return {"items": items, "exact_exists": False, "normalized": "", "can_create": False, "reason": None}

    reason = None
    try:
        nq = normalize_label(raw)
    except LabelError as e:
        reason = str(e)
        # still offer existing labels for text that can't become a label itself (too long, has a "/")
        nq = try_normalize(raw.replace("/", " ")[: config.SUGGEST_QUERY_CHARS]) or ""
        if not nq:
            return {"items": [], "exact_exists": False, "normalized": "", "can_create": False, "reason": reason}

    sims = None
    if len(nq) >= config.SUGGEST_MIN_CHARS and vocab.labels:
        try:
            sims = vocab.matrix() @ query_vector(nq)
        except MODEL_ERRORS:  # text matches still work
            sims = None

    found: list[tuple[tuple, dict]] = []
    matched: set[int] = set()
    for j, label in enumerate(vocab.labels):
        m = text_match(nq, label)
        if m is None:
            continue
        matched.add(j)
        sim = None if sims is None else float(sims[j])
        count = counts.get(label, (0, 0))[0]
        # within a tier: prefix by popularity then brevity; text by similarity when we have it
        within = (-count, len(label), j) if m != "text" else (-(sim if sim is not None else 0.0), -count, j)
        found.append(((_TIER[m], *within), item(label, m, sim)))
    if sims is not None:
        order = [j for j in np.argsort(-sims, kind="stable") if j not in matched and sims[j] >= config.SUGGEST_SIMILAR_FLOOR]
        for j in order[:config.SUGGEST_SIMILAR_MAX]:
            found.append(((_TIER["similar"], -float(sims[j]), j), item(vocab.labels[j], "similar", sims[j])))
    found.sort(key=lambda t: t[0])
    exact = nq in vocab.index
    return {
        "items": [it for _, it in found[:limit]],
        "exact_exists": exact,
        "normalized": nq,
        "can_create": reason is None and not exact,
        "reason": reason,
    }


# --------------------------------------------------------------------------- manual tags


class TagConflict(RuntimeError):
    """The request can't be applied to this row (e.g. removing a model tag)."""


def _require_image(conn: sqlite3.Connection, rel_path: str) -> None:
    if not conn.execute("SELECT 1 FROM images WHERE rel_path = ?", (rel_path,)).fetchone():
        raise LookupError("image not found")


def _eg_cosine(conn: sqlite3.Connection, rel_path: str, label: str) -> float | None:
    """Returns the EG cosine between the photo and the label text, or None when it can't be computed."""
    vec = db.get_embedding(conn, rel_path)
    if vec is None:
        return None
    vocab = get_vocab(conn)
    try:
        return round(float(vocab.matrix()[vocab.index[label]] @ np.asarray(vec, dtype=np.float32)), 4)
    except MODEL_ERRORS:
        return None


def image_subjects(conn: sqlite3.Connection, rel_path: str) -> list[dict]:
    """Returns all subjects of one image with source, EG score and rank, in display order."""
    return search._subjects_for(conn, [rel_path], full=True)[rel_path]


def add_tag(conn: sqlite3.Connection, rel_path: str, text: str, question: str | None = None) -> dict:
    """Manually tags one photo, creating the label (source 'user') when it is new.

    Args:
        conn: An open connection.
        rel_path: The photo.
        text: The tag as typed; it is normalized first.
        question: A custom yes/no question for a new label.

    Returns:
        `{label, created, added, subjects}`. `added` is False when the photo already had the label
        (a model tag is left as it is).

    Raises:
        LabelError: If the text can't be a label.
        LookupError: If the photo doesn't exist.
    """
    label = normalize_label(text)
    q = clean_question(question)
    _require_image(conn, rel_path)
    with conn:
        created = db.create_label(conn, label, q)
    added = False
    if db.subject_source(conn, rel_path, label) is None:
        eg = _eg_cosine(conn, rel_path, label)  # outside the write transaction: may load / run the embedder
        with conn:
            added = db.add_subject(conn, rel_path, label, 1.0, "user", eg)
    return {"label": label, "created": created, "added": added, "subjects": image_subjects(conn, rel_path)}


def remove_tag(conn: sqlite3.Connection, rel_path: str, text: str) -> dict:
    """Removes a MANUAL tag from one photo (the label itself stays in the vocabulary).

    Args:
        conn: An open connection.
        rel_path: The photo.
        text: The tag; it is normalized first.

    Returns:
        `{label, subjects}` with the photo's remaining subjects.

    Raises:
        LookupError: If the photo doesn't exist or doesn't have the tag.
        TagConflict: If the tag was added by the model.
    """
    label = try_normalize(text) or text
    _require_image(conn, rel_path)
    with conn:
        source = db.subject_source(conn, rel_path, label)
        if source is None:
            raise LookupError("this photo doesn't have that tag")
        if source != "user":
            raise TagConflict(
                f"'{label}' was added by the tagger, not by hand; only manual tags can be removed "
                "(a re-tag would add it back)"
            )
        db.remove_subject(conn, rel_path, label)
    return {"label": label, "subjects": image_subjects(conn, rel_path)}


def list_labels(conn: sqlite3.Connection) -> list[dict]:
    """Returns every label in vocabulary order with its `count` and `manual_count`."""
    counts = db.label_counts(conn)
    return [
        {**r, "count": counts.get(r["label"], (0, 0))[0], "manual_count": counts.get(r["label"], (0, 0))[1]}
        for r in db.label_rows(conn)
    ]


# --------------------------------------------------------------------------- propagation


_CHUNK = 4096


def propagation_candidates(
    conn: sqlite3.Connection, labels: Sequence[str], k: int = config.TAG_CANDIDATES
) -> dict[str, list[tuple[str, float]]]:
    """Finds the d1 questions a propagation of `labels` has to ask.

    A photo is a candidate for a label when the label ranks in its EG top-`k` across the CURRENT full
    vocabulary (same ordering as `subjects.candidates`: cosine desc, ties by vocabulary order), i.e. exactly
    when a full re-tag would put that question to d1. Skipped: photos that already have the label (any
    source), photos without an embedding, and untagged photos (the normal tag pass asks about every label,
    new ones included, when it reaches them).

    Args:
        conn: An open connection.
        labels: Labels to look for; ones that aren't in the vocabulary are ignored.
        k: How many EG candidates per photo the tag rule uses.

    Returns:
        `{rel_path: [(label, eg_cosine), ...]}`, sorted by rel_path.
    """
    vocab = get_vocab(conn)
    cols = [vocab.index[lb] for lb in labels if lb in vocab.index]
    if not cols:
        return {}
    cache = search.get_cache(conn)
    if not cache.ids:
        return {}
    lmat = vocab.matrix()
    eligible = cache.has_vec.copy()
    idx = cache.index
    for (rp,) in conn.execute("SELECT rel_path FROM images WHERE tagged_at IS NULL"):
        if rp in idx:
            eligible[idx[rp]] = False
    out: dict[str, list[tuple[str, float]]] = {}
    hits: dict[int, np.ndarray] = {j: np.zeros(len(cache.ids), dtype=bool) for j in cols}
    scores: dict[int, np.ndarray] = {j: np.zeros(len(cache.ids), dtype=np.float32) for j in cols}
    for start in range(0, len(cache.ids), _CHUNK):
        s = cache.mat[start : start + _CHUNK] @ lmat.T  # (chunk, n_labels)
        for j in cols:
            col = s[:, j : j + 1]
            rank = (s > col).sum(axis=1) + (s[:, :j] == col).sum(axis=1)
            hits[j][start : start + s.shape[0]] = rank < k
            scores[j][start : start + s.shape[0]] = s[:, j]
    for j in cols:
        label = vocab.labels[j]
        mask = hits[j] & eligible
        for (rp,) in conn.execute("SELECT rel_path FROM subjects WHERE label = ?", (label,)):
            if rp in idx:
                mask[idx[rp]] = False
        for i in np.flatnonzero(mask):
            out.setdefault(cache.ids[i], []).append((label, round(float(scores[j][i]), 4)))
    return dict(sorted(out.items()))


def estimate_seconds(n_images: int) -> float:
    """Returns the rough wall time of a d1 run over `n_images` photos (model load + per photo)."""
    if n_images <= 0:
        return 0.0
    return round(config.TAG_LOAD_SECONDS_ESTIMATE + n_images * config.TAG_SECONDS_ESTIMATE, 1)


def propagation_preview(conn: sqlite3.Connection, labels: Sequence[str]) -> dict:
    """Returns `{candidates, est_seconds}` for propagating `labels`."""
    n = len(propagation_candidates(conn, labels))
    return {"candidates": n, "est_seconds": estimate_seconds(n)}
