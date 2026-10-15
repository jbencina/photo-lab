---
title: Data layout
---

# Data layout

```
data/                         # --data-dir / PHOTOLIB_DATA_DIR overrides (default ./data)
  config.json                 # {"catalog_dir": "/path/to/photos"}: the current catalog
  catalogs/<name>-<hash>/     # one index folder per catalog: the photo folder's name + a hash of its full path
    photolib.db               # SQLite: images, EXIF, colors, likes, subjects, labels, embeddings (BLOB), FTS5, meta
    thumbs/<sha1>.webp        # 640px long edge, q=80, EXIF orientation applied; sha1 of the relative path
models/embeddinggemma-2       # PHOTOLIB_MODEL_DIR overrides
models/d1-3B                  # PHOTOLIB_TAGGER_DIR overrides
```

`catalog set /path/to/photos` works out the index folder from the photo folder's path and creates it on
first use (see [Catalogs](../catalogs.md)). A data dir from an older version (`photolib.db` and
`thumbs/` directly inside it) is moved into its catalog's folder the first time it is used.

The primary key is each file's path relative to the catalog root. Originals are served straight from the
catalog folder and never modified. `photolib purge` deletes the current catalog's index folder; deleting
`data/` removes every catalog's index.

## Schema

- `embeddings(rel_path, vec)` holds the 768 float32 values as a plain BLOB.
- `images.tagged_at` and `images.tagger` record the tag pass.
- `subjects` rows carry `score` (d1 P(yes), the cosine for a fallback row, or 1.0 for a manual tag),
  `source` (`d1`, `eg` or `user`), `eg_score` and `display_rank` (manual tags first, then model tags by
  EmbeddingGemma cosine).
- `labels(label, question, category, source, created_at)` is the tag vocabulary: `builtin` rows are
  seeded from `photolib/labels.py`, `user` rows are the labels you created.
- `meta.vec_version` is a random token bumped on every insert or delete (it tells the server to reload
  its [vector cache](search.md#in-memory-vector-cache)), and `meta.labels_version` one that is bumped
  whenever the vocabulary changes.

The schema version lives in `PRAGMA user_version` (currently 3).

## Upgrading

**From schema v2** (an index built before manual tags), the upgrade happens **in place** the first time
the new version opens the database: the `labels` table is created and seeded, the version is stamped 3,
and nothing else is rewritten. Photos, embeddings, subjects and likes stay as they are; no re-index or
re-tag is needed. Restart a running `photolib serve` after upgrading the code (an old process would
refuse the v3 file as "newer").

**From an older index**, a database built before subject tagging (schema v0) is not migrated. The CLI
prints, and the API returns as HTTP 409 (shown in the UI with a **Rebuild catalog** button), a message
telling you to rebuild with `photolib catalog set <dir> --rebuild`. Your photos are untouched; likes are
not carried over.
