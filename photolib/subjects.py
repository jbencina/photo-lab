"""Hybrid subject tagging: EmbeddingGemma proposes, d1-3B confirms.

Per image:
  1. EG cosine between the image embedding and every label vector (SearchQuery prompt) -> top 20.
  2. d1 answers "Is there a {label} in this photo?" (or the label's override) for those 20 in ONE forward pass
     over the full-resolution image.
  3. Keep every candidate with P(yes) >= 0.8. `score` = P(yes), `source` = 'd1'.
  4. `display_rank` = order by EG cosine among the kept labels (d1's P saturates at ~0.99 for everything
     present, so it can't rank salience; EG can). Summaries show the top 5 by display_rank.
  5. If d1 rejects all 20, keep EG's top-1 with `source='eg'` and `score` = its cosine, so every image has at
     least one subject.

The vocabulary is the DB's `labels` table (builtin seed from labels.py + user-created labels); see tags.py
for the cached label matrix, manual tags and per-label propagation.
"""

from __future__ import annotations

from typing import Mapping, Protocol, Sequence

import numpy as np
from PIL import Image

from . import config


class SupportsTag(Protocol):
    """Anything that can answer yes/no label questions about an image (`Tagger`, `RemoteTagger`)."""

    def tag(
        self, image: Image.Image, labels: Sequence[str], questions: Mapping[str, str | None] | None = None
    ) -> dict[str, float]:
        """Returns P(yes) per label for one image."""
        ...


def label_matrix(vocabulary: Sequence[str]) -> np.ndarray:
    """Embeds the vocabulary as text (cached per label by the embedder).

    Args:
        vocabulary: The labels, in order.

    Returns:
        An (n_labels, 768) matrix of EmbeddingGemma text vectors.
    """
    from .embedder import get_embedder

    return get_embedder().encode_labels(list(vocabulary))


def candidates(
    eg_scores: np.ndarray, vocabulary: Sequence[str], k: int = config.TAG_CANDIDATES
) -> list[tuple[str, float]]:
    """Picks the EmbeddingGemma top-k labels for one image.

    Args:
        eg_scores: Cosine of the image against every label, in vocabulary order.
        vocabulary: The labels `eg_scores` refers to.
        k: How many candidates to return (at least 1).

    Returns:
        `(label, cosine)` pairs, best first; ties keep vocabulary order.
    """
    row = np.asarray(eg_scores, dtype=np.float32)
    order = np.lexsort((np.arange(row.shape[0]), -row))[: max(1, k)]
    return [(vocabulary[j], float(row[j])) for j in order]


def select(
    cands: Sequence[tuple[str, float]], probs: dict[str, float], threshold: float = config.TAG_THRESHOLD
) -> list[dict]:
    """Applies the tag rule to the candidates and d1's answers.

    Args:
        cands: EmbeddingGemma candidates as `(label, cosine)`, best first.
        probs: d1's P(yes) per label.
        threshold: Minimum P(yes) to keep a label.

    Returns:
        Subject rows `{label, score, source, eg_score, display_rank}`: the confirmed labels with
        source "d1", or the single best candidate with source "eg" when none was confirmed.
    """
    kept = [(label, cos) for label, cos in cands if probs.get(label, 0.0) >= threshold]
    if kept:
        return [
            {"label": label, "score": round(float(probs[label]), 4), "source": "d1", "eg_score": round(cos, 4), "display_rank": i + 1}
            for i, (label, cos) in enumerate(kept)
        ]
    label, cos = cands[0]
    return [{"label": label, "score": round(cos, 4), "source": "eg", "eg_score": round(cos, 4), "display_rank": 1}]


def tag_image(
    image: Image.Image,
    img_vec: np.ndarray,
    labels_mat: np.ndarray,
    tagger: SupportsTag,
    vocabulary: Sequence[str],
    k: int = config.TAG_CANDIDATES,
    threshold: float = config.TAG_THRESHOLD,
    questions: Mapping[str, str | None] | None = None,
) -> list[dict]:
    """Runs the full hybrid rule for one image.

    EG cosine -> top-k -> d1 -> P >= threshold, EG-ranked, EG fallback. `vocabulary`, `labels_mat` and
    `questions` come from the DB vocabulary (`tags.get_vocab`).

    Args:
        image: The image as d1 should see it (see `tagger.load_for_tagging`).
        img_vec: The image's EmbeddingGemma vector.
        labels_mat: Text vectors of `vocabulary`, one row per label.
        tagger: The model that answers the yes/no questions.
        vocabulary: The labels, in the row order of `labels_mat`.
        k: How many EmbeddingGemma candidates d1 is asked about.
        threshold: Minimum P(yes) to keep a label.
        questions: `{label: question or None}`; None uses the tagger's defaults.

    Returns:
        The subject rows to store (see `select`).
    """
    eg = labels_mat @ np.asarray(img_vec, dtype=np.float32)
    cands = candidates(eg, vocabulary, k)
    asked = [label for label, _ in cands]
    probs = tagger.tag(image, asked, questions)
    return select(cands, probs, threshold)
