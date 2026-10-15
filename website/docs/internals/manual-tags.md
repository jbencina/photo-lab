---
title: Manual tags and propagation
---

# Manual tags and propagation

## Manual tags

A manual tag (one you added in the photo viewer) is a `subjects` row with `source='user'` and
score 1.0. It ranks ahead of the model's tags, shows up in the subject filter like any other tag, can
be removed with its ×, and **survives re-tags**: the tag pass only replaces the model's rows (and
drops a model row that duplicates a manual one). Removing a manual tag never deletes the label;
adding a tag the model already put on the photo changes nothing.

The text is normalized (trimmed, whitespace collapsed, lowercased; at most 40 characters; must contain a
letter or digit; no `/`), and uniqueness is on that form.

## Suggestions

Suggestions (`GET /api/labels/suggest`) exist to stop near-duplicates. For the typed text, existing
labels are ranked in tiers:

1. **exact**: the normalized text is a label (then there is no *Create* row);
2. **prefix**: the label starts with it (most-used first);
3. **text**: it is a substring of the label, or every typed word starts a word of the label
   (`fl bird` → *bird in flight*), or the label's words are all among the typed words. Simple plurals
   are folded, so `pigeons` → *pigeon* without the model;
4. **similar**: the EmbeddingGemma text vector of what you typed (same `SearchQuery` prompt as the
   labels, about 30 ms, LRU-cached) against the cached label vectors; up to 4 labels with cosine
   **≥ 0.82**, best first. Needs at least 3 typed characters.

An empty query with a photo returns that photo's best EmbeddingGemma labels that it doesn't have yet. If
the embedding model can't be used, text matches still work.

### Why 0.82

The threshold was calibrated on the 154 builtin labels with about 65 probe words. Label text vectors are
close to each other in this model, so junk still scores 0.70–0.79 against *something* (`asdfgh` → 0.74,
`tax return` → 0.69, `love` → 0.79, `computer` → 0.79), while real synonyms score 0.82 and up:

| Typed | Suggested |
|---|---|
| `pizza` | food 0.82 |
| `tabby` | cat 0.83 |
| `dusk` | sunset 0.84 |
| `sea` | ocean 0.90, coast 0.85, beach 0.83 |
| `puppy` | dog 0.89 |
| `kitten` | cat 0.88 |
| `plane` | aircraft 0.91 |

At 0.80, second-rate neighbors leak in (`puppy` → baby 0.80, `blue` → orange 0.81); at 0.82 every junk
probe returns nothing. The price is a few loose associations that fall just short (`wire` → power lines
0.79, `raptor` → hawk 0.80): for those you just get the *Create* row.

## Propagation

Propagation ("find in library" in the UI, `tag --labels` on the CLI) applies **one** label to the rest
of the library, consistently with what a full re-tag would do, but asking d1 a single question per
photo:

1. **Candidates** are the photos where the label ranks in the EmbeddingGemma **top 20 across the whole
   current vocabulary** (one matrix product over the cached image vectors × label vectors, about 50 ms),
   minus photos that already have the label and photos that aren't tagged yet (the normal tag pass will
   ask them about every label, yours included).
2. **d1** loads, answers that one yes/no question per candidate at full resolution, and
   **P(yes) ≥ 0.8** adds a `source='d1'` row (score = P, ranked among the photo's model tags by
   EmbeddingGemma cosine). It commits after every photo; other tags and `tagged_at` are never touched.
3. d1 is unloaded when the job ends. It shares the single indexing slot (HTTP 409 while a refresh or
   re-tag runs) and the same progress object (`mode: "propagate"`, `phase: "propagating"`).

It isn't resumable as a job, but interrupting it is safe, and running it again only asks the photos
that still lack the label. The estimate shown in the photo viewer prompt and the Admin dialog is 8 s
of model load plus 0.3 s per candidate photo. The default question is `Is there a {label} in this photo?`; the API accepts a custom
`question` when creating a label.

Every label you create is one more question competing for the 20 candidate slots per photo, so keep the
vocabulary tidy (`photolib labels --remove`). There is no UI to rename or delete a label or to edit its
question.

### Measurements

On the 266-photo sample catalog (RTX 4080; times include loading d1, 3–5 s with a warm disk cache, then
about 3.5 photos/s):

| New tag (on one photo) | Candidates | d1 confirmed | Time | Looking at the photos |
|---|---|---|---|---|
| `jellyfish` | 64 | 22 | 22 s | all 22 are jellyfish; 3 more jellyfish-like photos scored 0.59–0.78 and were left out |
| `whale` (CLI) | 153 (with `heron`) | 26 | 43 s | all 26 show a whale; some distant backs/blows were not confirmed |
| `seaweed` | 180 | 19 | 50 s | the kelp-tank photos |
| `lamp` | 8 | 6 | 5 s | exactly the other 6 photos of the lamp |
| `sea anemone` | 77 | 2 | 23 s | exactly the other 2 anemone photos |
| `red wattle` (only on the turkey photo) | 22 | 0 | 9 s | correct: nothing else has one |
| `kelp` | 185 | 0 | 51 s | **miss**: d1 answers 0.3–0.75 for "kelp" on the kelp photos (0.95+ for "seaweed") |

So precision is high and d1 errs on the side of saying no. A full `tag --retag` afterwards kept every
manual tag and re-found the propagated ones (jellyfish 23/23, seaweed 20/20, lamp 7/7; whale 25 of 26,
one photo sitting right at the 0.8 threshold).
