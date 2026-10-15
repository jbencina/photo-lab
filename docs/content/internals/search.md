---
title: How search works
sidebar_label: Search
---

# How search works

## Embeddings

EmbeddingGemma 2 puts text and images in one shared 768-dimensional space. It is loaded through
sentence-transformers with the audio tower disabled (text and image only, about 440M parameters), in
bf16 on CUDA. Images are encoded with no prefix. Text queries use the model's `SearchQuery` prompt
(`task: search result | query: …`). Vectors are L2-normalized, and ranking uses cosine similarity.

## In-memory vector cache

Each server process keeps every embedding in one numpy float32 matrix (25k × 768 ≈ 77 MB) plus every
palette flattened into arrays. Each request reads `meta.vec_version` (one tiny query); when the token
has changed (photos added, pruned, catalog rebuilt) the cache reloads, which takes about 100 ms for 25k
photos.

## Query and similar search

Search is exact, with no oversampling and no cap on k. Filters run as SQL (the same WHERE clause as the
library) to get the candidate photos. Their rows are gathered from the matrix, scored with one
matrix-vector product, and the top `offset + limit` are picked. Find similar uses the stored vector and
excludes the source photo. Every search endpoint supports `limit`/`offset` paging.

## Color

When a photo is indexed, it is downscaled to 100 px and clustered with k-means (k = 6) in CIELAB. The
stored palette is a list of `{hex, lab, share}`. A color query scores every (filtered) photo, vectorized
over the cached palettes:

```
score = Σ shareᵢ · exp(−ΔE76(labᵢ, query) / 25)
```

Higher is better, so a photo dominated by a close color wins.

## Metadata

FTS5 over file name, make, model, lens and software, with prefix matching on every word.
