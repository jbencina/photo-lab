"""Subject vocabulary for the hybrid tagger (EmbeddingGemma proposes, d1-3B confirms).

Each entry is `{"label": ..., "question": ...}`. `question` is optional: when it is None, d1 is asked
`DEFAULT_QUESTION.format(label=label)` ("Is there a {label} in this photo?", which scored precision 1.00 /
recall 0.97 at P >= 0.8 on the sample photos). Give a label its own question when the plain form is
ambiguous or ungrammatical enough to mislead the model (e.g. "orange" the colour vs the fruit).

How it is used (see `subjects.py`): every label text is embedded once with EmbeddingGemma (SearchQuery
prompt); per photo the 20 labels with the highest cosine become yes/no questions for d1 in one forward
pass, and every label with P(yes) >= 0.8 is stored.

This file is the SEED of the vocabulary, not the vocabulary itself: on connect, db.py upserts
these entries into the `labels` table as `source='builtin'` rows, and everything (tag pass, suggestions,
propagation) reads the table, which also holds the labels you create in the UI (`source='user'`).

Editing this file: add or reword entries, keep labels unique and short (they are the chip text), then
re-tag the library with `uv run photolib tag --retag` (or Admin -> "Retag all"). Embeddings are not
recomputed; only the d1 pass re-runs (about 0.3 s per photo on an RTX 4080). A reworded question replaces
the stored one unless it was edited in the DB. Entries deleted here are NOT deleted from the table (the
seed only inserts): drop them with `uv run photolib labels --remove <label>`.

Labels that proved noisy were dropped or reworded:
  * dropped "macro" (d1 reads it as "close-up": fired on 12/31 telephoto shots), "wildlife" (fires on
    every animal, adds nothing) and "interior" (0.5-0.56 on outdoor flower close-ups);
  * dropped near-duplicates that only doubled chips ("turkey" vs "wild turkey", "dog portrait",
    "telephone pole" vs "utility pole", "cityscape", "raven" vs "crow");
  * "orange" asks about the citrus fruit (0.99 -> 0.13 on orange marigolds), "food" asks about food that
    is ready to eat (0.87 -> 0.10 on a bee on flowers), "portrait" asks about a person (it fired 0.95 on
    dog close-ups).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Iterable, Mapping, TypedDict

DEFAULT_QUESTION = "Is there a {label} in this photo?"


class LabelEntry(TypedDict):
    """One seed entry: the label text and an optional custom question for d1."""

    label: str
    question: str | None


def L(label: str, question: str | None = None) -> LabelEntry:
    """Builds a seed entry (short name keeps the `CATEGORIES` table readable)."""
    return {"label": label, "question": question}


CATEGORIES: dict[str, list[LabelEntry]] = {
    "Birds": [
        L("bird"),
        L("bird in flight"),
        L("flock of birds"),
        L("pigeon"),
        L("dove"),
        L("crow"),
        L("sparrow"),
        L("starling"),
        L("hawk"),
        L("eagle"),
        L("owl"),
        L("duck"),
        L("goose"),
        L("gull"),
        L("heron"),
        L("egret"),
        L("hummingbird"),
        L("wild turkey"),
        L("chicken"),
    ],
    "Mammals": [
        L("mammal"),
        L("dog"),
        L("cat"),
        L("pet"),
        L("horse"),
        L("deer"),
        L("squirrel"),
        L("rabbit"),
        L("fox"),
        L("cow"),
        L("sheep"),
    ],
    "Reptiles, amphibians & fish": [
        L("reptile"),
        L("lizard"),
        L("snake"),
        L("turtle"),
        L("frog"),
        L("fish"),
    ],
    "Insects & spiders": [
        L("insect"),
        L("butterfly"),
        L("moth"),
        L("bee"),
        L("honey bee"),
        L("bumblebee"),
        L("wasp"),
        L("dragonfly"),
        L("ladybug"),
        L("spider"),
    ],
    "Flowers": [
        L("flower"),
        L("wildflowers"),
        L("white flowers"),
        L("marigold"),
        L("rose"),
        L("sunflower"),
        L("daisy"),
        L("tulip"),
        L("lily"),
        L("orchid"),
        L("poppy"),
        L("lavender"),
        L("umbellifer"),
        L("cherry blossom"),
    ],
    "Plants & trees": [
        L("plant"),
        L("leaves"),
        L("tree"),
        L("forest"),
        L("palm tree"),
        L("pine tree"),
        L("eucalyptus"),
        L("cactus"),
        L("mushroom"),
        L("grass"),
        L("garden"),
        L("autumn foliage", "Does this photo show autumn foliage (red, orange or yellow fall leaves)?"),
    ],
    "Fruit & food": [
        L("fruit"),
        L("fruit tree"),
        L("plum"),
        L("peach"),
        L("apple"),
        L("orange", "Is there an orange (the citrus fruit) in this photo?"),
        L("lemon"),
        L("grapes"),
        L("berries"),
        L("vegetables"),
        L("food", "Does this photo show food that is ready to eat (a meal, dish, snack or harvested produce)?"),
    ],
    "Landscape": [
        L("landscape"),
        L("mountain"),
        L("hills"),
        L("desert"),
        L("canyon"),
        L("cliff"),
        L("rocks"),
        L("field"),
        L("farm"),
        L("rural"),
        L("island"),
    ],
    "Water": [
        L("water"),
        L("ocean"),
        L("waves"),
        L("beach"),
        L("coast"),
        L("lake"),
        L("river"),
        L("waterfall"),
        L("harbor"),
        L("marina"),
        L("reflection"),
    ],
    "Sky, weather & light": [
        L("sky"),
        L("clouds"),
        L("sunset"),
        L("sunrise"),
        L("night", "Was this photo taken at night?"),
        L("stars"),
        L("moon"),
        L("fog"),
        L("rainbow"),
        L("snow"),
        L("silhouette"),
    ],
    "Urban & architecture": [
        L("city"),
        L("skyline"),
        L("street"),
        L("urban"),
        L("architecture"),
        L("building"),
        L("house"),
        L("barn"),
        L("church"),
        L("bridge"),
        L("lighthouse"),
        L("road"),
        L("park"),
        L("power lines"),
        L("utility pole"),
        L("sculpture"),
        L("street art", "Is there street art or graffiti in this photo?"),
    ],
    "People & events": [
        L("portrait", "Is this a portrait of a person?"),
        L("people", "Are there people in this photo?"),
        L("child"),
        L("baby"),
        L("crowd", "Is there a crowd of people in this photo?"),
        L("wedding"),
        L("concert"),
        L("sports", "Does this photo show people playing a sport?"),
        L("fireworks"),
    ],
    "Vehicles": [
        L("vehicle"),
        L("car"),
        L("truck"),
        L("motorcycle"),
        L("bicycle"),
        L("train"),
        L("aircraft"),
        L("boat"),
        L("sailboat"),
        L("motorboat"),
        L("ship"),
    ],
    "Style": [
        L("black and white", "Is this a black-and-white photo?"),
    ],
}

LABELS: list[LabelEntry] = [entry for group in CATEGORIES.values() for entry in group]
VOCABULARY: list[str] = [entry["label"] for entry in LABELS]
CATEGORY_OF: dict[str, str] = {entry["label"]: cat for cat, group in CATEGORIES.items() for entry in group}
_QUESTION_OF: dict[str, str | None] = {entry["label"]: entry["question"] for entry in LABELS}


# Fingerprint of the seed: db.migrate() re-runs the upsert only when this changes (cheap check per connect).
SEED_HASH: str = hashlib.sha1(
    json.dumps([[e["label"], e["question"], CATEGORY_OF[e["label"]]] for e in LABELS]).encode("utf-8")
).hexdigest()[:16]


def question_for(label: str, overrides: Mapping[str, str | None] | None = None) -> str:
    """Returns the d1 yes/no question for one label.

    Args:
        label: The label.
        overrides: `{label: question or None}` from the DB; replaces the seed questions when given.

    Returns:
        The label's own question, or `DEFAULT_QUESTION` filled in when it has none.
    """
    q = overrides.get(label) if overrides is not None else _QUESTION_OF.get(label)
    return q if q else DEFAULT_QUESTION.format(label=label)


def questions_for(labels: Iterable[str], overrides: Mapping[str, str | None] | None = None) -> dict[str, str]:
    """Returns `{label: question}` in the given order (see `question_for`)."""
    return {label: question_for(label, overrides) for label in labels}


# --------------------------------------------------------------------------- user-typed labels

MAX_LABEL_LEN = 40
MAX_QUESTION_LEN = 200
_WS_RE = re.compile(r"\s+")


class LabelError(ValueError):
    """A typed label (or question) that can't be stored; the message is shown to the user."""


def normalize_label(text: str | None) -> str:
    """Returns the canonical form of a typed label: trimmed, whitespace collapsed, lowercased.

    Uniqueness is on this form ("  Wild   Turkey " == "wild turkey").

    Args:
        text: The label as typed.

    Returns:
        The normalized label.

    Raises:
        LabelError: If the text is empty, only punctuation, longer than `MAX_LABEL_LEN`, or contains
            control characters or "/" (labels are URL path segments in the API).
    """
    s = _WS_RE.sub(" ", (text or "")).strip().lower()
    if not s:
        raise LabelError("a tag can't be empty")
    if not any(ch.isalnum() for ch in s):
        raise LabelError("a tag needs at least one letter or digit")
    if len(s) > MAX_LABEL_LEN:
        raise LabelError(f"a tag can be at most {MAX_LABEL_LEN} characters")
    if "/" in s or any(not ch.isprintable() for ch in s):
        raise LabelError("a tag can't contain '/' or control characters")
    return s


def try_normalize(text: str | None) -> str | None:
    """Returns the normalized label, or None when the text can't be a label."""
    try:
        return normalize_label(text)
    except LabelError:
        return None


def clean_question(text: str | None) -> str | None:
    """Validates the optional custom d1 question of a new label.

    Args:
        text: The question as typed.

    Returns:
        The question with whitespace collapsed, or None (use the default template) when it is blank.

    Raises:
        LabelError: If the question is longer than `MAX_QUESTION_LEN` or has no letters or digits.
    """
    q = _WS_RE.sub(" ", (text or "")).strip()
    if not q:
        return None
    if len(q) > MAX_QUESTION_LEN:
        raise LabelError(f"a question can be at most {MAX_QUESTION_LEN} characters")
    if not any(ch.isalnum() for ch in q):
        raise LabelError("a question needs some text")
    return q
