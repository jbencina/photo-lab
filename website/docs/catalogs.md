---
title: Catalogs
---

# Catalogs

A **catalog** is a folder of photos. It is the only path you give photo-lib:

```bash
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local
```

Everything photo-lib produces for that folder (the database with embeddings, tags and likes, and the
thumbnails) is its **index**. photo-lib decides where the index goes: each catalog gets its own folder
under the data dir, named after the photo folder plus a hash of its full path, for example
`data/catalogs/photos-3f9a1c0b7e/`. Nothing is ever written to the photo folder itself.

- **One catalog is current at a time.** `catalog set <dir>` makes `<dir>` current and indexes the
  photos in it that are new. `refresh`, `tag`, `serve` and the web UI all work on the current catalog.
- **Switching deletes nothing.** The catalog you switch away from keeps its index, likes and tags.
  Switching back to it is instant: only photos added since are indexed.
- **Two folders never share an index**, even when they have the same name, because the full path is
  part of the index folder's name. The other side of that: if you move or rename a photo folder,
  photo-lib sees a new catalog and indexes it again.
- **Starting over is explicit.** `catalog set <dir> --rebuild` deletes that catalog's index and builds
  it from scratch. `purge` deletes the current catalog's index and leaves no catalog set. Neither
  touches other catalogs or your photos.
- **The base path is the data dir**: `./data` unless you pass `--data-dir` (or set
  `PHOTOLIB_DATA_DIR`). All catalogs live under it, so one flag moves everything to another disk.

```bash
uv run photolib catalog set /path/to/trip-2024 --embedding-model local --decision-model local   # indexes trip-2024
uv run photolib catalog set /path/to/family    --embedding-model local --decision-model local   # indexes family; trip-2024 is kept
uv run photolib catalog set /path/to/trip-2024 --embedding-model local --decision-model local   # back again, nothing to index
uv run photolib catalog show                   # current catalog, its counts and its index folder
uv run photolib catalog set /path/to/family --rebuild --embedding-model local --decision-model local   # wipe and re-index family only
```

The web UI does the same on the [Admin](guide/admin.md) page: **Switch catalog** for another folder,
**Rebuild catalog** when you enter the current one. There is no command that lists the catalogs you
have indexed; look in `data/catalogs/`.

## What gets indexed

Indexing finds `*.jpg` and `*.jpeg` files, recursively and case-insensitively, and skips hidden
folders. It only adds photos: files that changed in place aren't re-indexed (remove and re-add them, or
rebuild). Renaming a file counts as a delete plus a new file, so its like is lost unless you keep the
old name. HEIC, RAW, PNG and video are ignored.

Photos whose files are gone are reported by `refresh`; `refresh --prune` (or **Prune missing** in
Admin) deletes their rows.

## Index on one machine, serve from another

The data dir is self-contained (plain SQLite plus thumbnails per catalog), so you can index on a machine
with a fast GPU and serve the catalog from a small one that has no GPU and no model weights:

```bash
# 1. on the fast machine: index and tag as usual
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local

# 2. copy the data dir and the photos to the serving machine (no photolib command running meanwhile)
rsync -a data/ server.example:/srv/photolib/data/
rsync -a /path/to/photos/ server.example:/srv/photolib/photos/

# 3. on the serving machine: install without the `local` extra (no PyTorch), point at both folders
#    and send search queries to a remote embedding model
uv sync
uv run photolib --data-dir /srv/photolib/data --catalog-dir /srv/photolib/photos \
  serve --embedding-model http://gpu-host.example:8080/v1/embeddings
```

`--catalog-dir` (or `PHOTOLIB_CATALOG_DIR`) says where the photos are on this machine. The current
catalog and its index are still found through the path stored in `config.json`, which is the path on
the machine that indexed.

- Without the photos on the serving machine, everything still works from the thumbnails except opening
  a photo at full size.
- The remote embedding model must be the same EmbeddingGemma 2 the index was built with.
- Likes and manual tags made on the serving machine live in its copy of the data dir, so copying the
  data dir again overwrites them.

The layout of the data dir is described in [Data layout](internals/data-layout.md).
