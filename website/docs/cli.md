---
title: CLI reference
sidebar_label: CLI
---

# CLI reference

All commands run as `uv run photolib <command>`. `--help` on any command prints its options.

## Global options

These go before the command, or you set the environment variables.

- `--data-dir` (`PHOTOLIB_DATA_DIR`): the base folder for everything photo-lib stores (default
  `./data`). It holds one index folder per catalog, so you rarely need to change it.
- `--catalog-dir` (`PHOTOLIB_CATALOG_DIR`): the photo folder to use instead of the one stored in the
  data dir. See [Index on one machine, serve from another](catalogs.md#index-on-one-machine-serve-from-another).

```bash
uv run photolib --data-dir /path/to/data catalog set /path/to/photos --embedding-model local --decision-model local
uv run photolib --data-dir /path/to/data serve --embedding-model local --decision-model local
```

`--embedding-model` and `--decision-model` go on the commands that need a model. See
[Where the models run](models.md). They are left out of the examples below.

## Commands

### `catalog set <dir> [--rebuild] [--yes]`

Makes `<dir>` the current catalog and indexes what is new in it. Every catalog has its own index, so
nothing is deleted, and switching back to a folder you indexed before is instant.

`--rebuild` deletes that folder's index first and builds it from scratch. It asks for confirmation
unless you pass `--yes`.

```bash
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local
```

### `catalog show`

Prints the catalog dir, the image, liked and subject counts, the data dir and the catalog's index
folder in it.

```bash
uv run photolib catalog show
```

### `refresh [--prune] [--skip-tags]`

Runs two resumable passes with per-phase progress bars (rate and ETA):

- The **embed pass** indexes new `*.jpg` and `*.jpeg` files (recursive, case-insensitive, hidden
  folders skipped). Files already indexed are skipped and never re-embedded.
- The **tag pass** tags every photo that isn't tagged yet with d1-3B.

Files that are missing on disk are reported; `--prune` deletes their rows. `--skip-tags` runs only
the embed pass. Per-phase throughput is printed at the end.

```bash
# second run: "0 new / 31 skipped ... 31 tagged / 0 untagged"
uv run photolib refresh

# also drop rows for deleted files
uv run photolib refresh --prune

# embed only; search works right away, tag later
uv run photolib refresh --skip-tags
```

A `refresh` or `tag` in a terminal and a run started from the web UI don't know about each other;
avoid running both at once.

### `tag [--retag] [--limit N]`

Runs only the tag pass, over untagged photos. `--retag` first marks every photo untagged (use it after
editing `photolib/labels.py`); `--limit N` stops after N photos. Ctrl-C is safe: run `photolib tag`
again to resume.

```bash
# tag whatever is untagged (resumes an interrupted run)
uv run photolib tag

# re-tag everything after editing photolib/labels.py (manual tags are kept)
uv run photolib tag --retag
```

### `tag --labels "osprey,heron"`

Per-label propagation instead of the full pass. For each listed label, d1 checks only the photos
where the label is an EmbeddingGemma top-20 candidate and that don't have it yet, and adds it where
P(yes) ≥ 0.8. Labels that don't exist are created as your own (`user`) labels. Other tags and
`tagged_at` are untouched. Can't be combined with `--retag` or `--limit`.

```bash
# look for just these labels in the photos that lack them
uv run photolib tag --labels "whale,heron"
```

### `labels [--user] [--used] [--remove <label>] [--yes]`

Lists the tag vocabulary (built-in plus your labels) with photo counts, how many were added by hand,
source and custom question. `--user` shows only the labels you created and `--used` only the labels
on at least one photo. `--remove` deletes one of your labels (or a built-in one that is no longer in
`labels.py`) together with its tags.

```bash
# the labels you created, with counts
uv run photolib labels --user

# drop a label you created by mistake (and its tags)
uv run photolib labels --remove "pigoen" --yes
```

### `status`

Shows the counts (including tagged and untagged), the database size, the model and tagger paths, the
label count, device and dtype.

```bash
uv run photolib status
```

### `serve [--host 0.0.0.0] [--port 8000] [--reload] [--no-warmup]`

Runs the API and the web UI. By default it loads the embedding model in the background at startup,
so the first query is fast; `--no-warmup` skips that.

```bash
uv run photolib serve --port 8080
```

### `purge [--yes]`

Deletes the current catalog's index (database, thumbnails, likes, tags) and unsets the catalog. Other
catalogs and your photos are never touched.

```bash
uv run photolib purge --yes
```
