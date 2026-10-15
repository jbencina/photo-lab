---
title: Where the models run
---

# Where the models run

photo-lib uses two models, and two flags say where each one runs. The flags go on any command, or you
set the environment variables once.

- `--embedding-model` (`PHOTOLIB_EMBEDDING_MODEL`): EmbeddingGemma 2, used for indexing, semantic
  search and tag suggestions.
- `--decision-model` (`PHOTOLIB_DECISION_MODEL`): d1-3B, used for subject tags and "find in library".

Each takes one of:

- `local`: load the model in this process, on the GPU if there is one. Needs `uv sync --extra local`
  and the weights in `models/`.
- A URL, for example `http://gpu-host.example:8080/v1/embeddings`: call the model on another machine.
  The URL is used as given and nothing is checked up front; a request is sent when the model is
  needed.
- Omitted: that model is not available. The CLI refuses what needs it, and the web UI disables it.

```bash
uv run photolib serve --embedding-model local --decision-model local      # everything on this machine
uv run photolib refresh --embedding-model http://gpu-host.example:8080/v1/embeddings --decision-model local
uv run photolib serve --embedding-model http://gpu-host.example:8080/v1/embeddings   # search, no tagging
uv run photolib serve                                                      # browse an existing index only
```

## What works without a model

Without the embedding model, you can still browse, filter, search metadata, find similar photos,
search by color, like photos, add tags by hand and get text-match tag suggestions. Semantic (Query)
search, refresh and catalog switching, similar-meaning tag suggestions and all tagging are off.

Without the decision model, everything above works, and so do semantic search and refresh (the embed
pass only; photos stay untagged). The tag pass, Retag all and "find in library" are off.

## Remote request formats

A remote model server only has to accept these requests.

**Embeddings**

```json
POST {"model": "google/embeddinggemma-2", "input": ["text", {"image": "<base64 JPEG>"}], "prompt_name": "SearchQuery"}
→    {"data": [{"index": 0, "embedding": [...768 floats]}]}
```

`prompt_name` is sent for text only. Images are sent EXIF-oriented and capped at 1024 px, 8 per
request.

**Decisions**

```json
POST {"model": "LiquidAI/d1-3B", "images": ["<base64 JPEG>"], "questions": {"q000": {"type": "noul", "instructions": "Is there a dog in this photo?"}}}
→    {"answers": {"q000": {"noul": 0.97}}}
```

This is d1's `system_one` call as JSON. One request is sent per photo.

## Mixing local and remote

An index can mix sources: vectors from a remote EmbeddingGemma 2 and a local one are interchangeable
(on 16 sample photos, text vectors were identical, image vectors had a mean cosine of 0.994, and
3 test queries returned the same top 5).

A run stops at the first failed remote request instead of marking every photo failed; run it again to
resume.

For a serving machine with no GPU at all, see
[Index on one machine, serve from another](catalogs.md#index-on-one-machine-serve-from-another).
