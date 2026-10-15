---
title: Subject tagging
---

# Subject tagging

A photo's model tags come from a hybrid of the two models: EmbeddingGemma proposes candidates cheaply,
and d1-3B confirms them by looking at the photo. The rule was chosen by comparing approaches on the
sample photos, where it named the main subject on 31 of 31 photos with no false positives and accepted
0 of 36 decoy labels.

1. **EmbeddingGemma proposes.** Every label in the vocabulary is embedded once (`SearchQuery` prompt).
   For each photo, the cosine against all labels is a cheap matrix product over the stored embedding;
   the **top 20** become candidates.
2. **d1-3B confirms.** The photo is loaded at native resolution (EXIF-rotated, capped at 1600 px; d1
   bounds it to 1 MP and tiles it, which is what makes small, distant birds work) and d1 answers the 20
   yes/no questions ("Is there a pigeon in this photo?") in **one forward pass**. The questions don't
   compete with each other, and P(yes) is sharp: things that are present score about 0.98, absent ones
   about 0.02.
3. Every candidate with **P(yes) ≥ 0.8** is kept. They are ranked by EmbeddingGemma's cosine
   (`display_rank`), because d1's P saturates and can't say which subject is the main one. The grid
   uses the top 5 and the photo viewer shows all of them. If d1 rejects all 20, the EmbeddingGemma
   top 1 is stored with `source='eg'`, so every photo has a subject.

The tag pass runs after the embed pass, over `images WHERE tagged_at IS NULL` in file order, and
commits after every photo, so Ctrl-C, a crash or a reboot just resumes on the next `refresh` or
`tag`. d1 is loaded lazily when the pass starts and **unloaded when it ends**, so an idle server only
holds EmbeddingGemma on the GPU. Measured on an RTX 4080 16 GB: 2.2 GB idle with EmbeddingGemma
loaded, 8.7 GB at the peak of the tag pass, and back to 2.3 GB afterwards.

## The vocabulary

The vocabulary d1 is asked about is the `labels` table: the builtin entries from `photolib/labels.py`
**plus the labels you created in the UI**, so a refresh or a re-tag also checks new and existing photos
for your labels.

`photolib/labels.py` holds about 150 entries grouped by category (birds, mammals, flowers, landscape,
water, urban, people, vehicles, …). Each entry is `{"label": ..., "question": ...}`. `question` is
optional and defaults to `"Is there a {label} in this photo?"`; give a label its own question when the
plain form is ambiguous. The shipped overrides fix systematic errors found on the sample photos:

- "orange" asks about *the citrus fruit* (otherwise it scored 0.99 on orange marigolds);
- "food" asks about *food that is ready to eat* (it fired on a bee on flowers);
- "portrait" asks about *a person* (it fired on dog close-ups).

"macro", "wildlife" and "interior" were dropped as noise.

## Editing the labels

`photolib/labels.py` seeds the `labels` table. When it changes, the next connect inserts new entries
and updates reworded questions (unless a question was edited in the database). Entries you delete from
the file are **not** removed from the table; drop them with `uv run photolib labels --remove <label>`.

After editing, run `uv run photolib tag --retag` (or **Retag all** in Admin). Embeddings are not
recomputed. Retagging 25k photos takes about 2 hours.

## Known weak spots

The models only tag what is in the vocabulary (query search still finds everything), and
EmbeddingGemma must rank a label in its top 20 for d1 to be asked. d1 can be over-literal on debatable
labels ("mountain" on high hills, "pine tree" on other conifers). The rule was calibrated on 31 photos
of about 8 scenes, so expect the odd miss on kinds of photos the sample didn't have (people, night,
cities). Tags d1 is vague about find little or nothing: on the sample, "kelp" found 0 photos and
"seaweed" 19.
