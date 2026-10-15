# photo-lib

A single-user, local photo catalog you can browse from any device on your network. Point it at a
folder of JPEGs. It stores EXIF data, thumbnails, color palettes,
[EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) image embeddings and subject tags
from [LiquidAI d1-3B](https://huggingface.co/LiquidAI/d1-3B) in one SQLite file per photo folder, then serves a
responsive web UI with:

- **Query search**: describe what's in the photo ("bird in flight").
- **Metadata search**: filename, camera, lens, software.
- **Subject tags**: EmbeddingGemma proposes labels from a curated ~150-label vocabulary, d1-3B
  confirms them by looking at the full-resolution photo (pigeon, marigold, wild turkey, power lines…).
- **Your own tags**: type a tag on any photo. Existing tags are suggested as you type (by text and by
  meaning, so you pick "pigeon" instead of creating "pigeons"); a brand-new tag can be applied to the
  rest of the library in one click (EmbeddingGemma shortlists photos, d1 confirms each one).
- **Filters**: subjects, liked, camera, lens, ISO, aperture, focal length, date.
- **Search by color, find similar, double-tap to like.**

There are no accounts and nothing leaves the machine.

![The library: a grid of photos with the search bar on top and the dock of filters at the bottom](website/static/img/screenshots/library.jpg)

The full documentation, with screenshots, is a [Docusaurus](https://docusaurus.io/) site in `website/`:
run `cd website && npm install && npm start` to read it locally (see `website/docs/` for the pages).

## Requirements

- Linux or WSL2 (developed on WSL2 Ubuntu).
- [uv](https://docs.astral.sh/uv/). It installs Python 3.12 and, with `--extra local`, PyTorch for you.
- Node.js 20+ and npm, to build the web UI.
- An NVIDIA GPU is strongly recommended. With CUDA, both models run in bfloat16. Without it, they run
  on the CPU in float32: search still works, but tagging a large library becomes impractical (d1 alone
  needs ~12.5 GB of RAM in fp32). fp16 is never used.
- **VRAM: ~9 GB while tagging** (EmbeddingGemma ~1.4 GB + d1-3B ~6.2 GB + CUDA contexts; measured on an
  RTX 4080 16 GB: 2.2 GB idle with EmbeddingGemma loaded, 8.7 GB peak during the tag pass, back to
  2.3 GB afterwards because d1 is unloaded). Search alone needs ~2 GB.
- About 8.5 GB of disk for the model weights (EmbeddingGemma ~2 GB, d1-3B 6.2 GB).

## Setup

```bash
# 1. model weights (once)
uvx hf download google/embeddinggemma-2 --local-dir models/embeddinggemma-2
uvx hf download LiquidAI/d1-3B --local-dir models/d1-3B      # subject tagger (LFM Open License, see below)

# 2. python env (the `local` extra is PyTorch + transformers, needed to run the models on this machine)
uv sync --extra local

# 3. web UI
cd frontend && npm install && npm run build && cd ..

# 4. index a folder and serve
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local
uv run photolib serve --embedding-model local --decision-model local
```

Open <http://localhost:8000>. After the first build, `uv run photolib serve --embedding-model local --decision-model local`
is the only command you need: it serves both the API and the built UI (`frontend/dist`). If the UI hasn't been built,
`serve` prints a warning and the API still works under `/api`.

## Catalogs

A **catalog** is a folder of photos. It is the only path you give photo-lib:

```bash
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local
```

Everything photo-lib produces for that folder (the database with embeddings, tags and likes, and the
thumbnails) is its **index**. photo-lib decides where the index goes: each catalog gets its own
folder under the data dir, named after the photo folder plus a hash of its full path, for example
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
- **The base path is the data dir**, `./data` unless you pass `--data-dir` (or set `PHOTOLIB_DATA_DIR`).
  All catalogs live under it, so one flag moves everything to another disk.

```bash
uv run photolib catalog set /path/to/trip-2024 --embedding-model local --decision-model local   # indexes trip-2024
uv run photolib catalog set /path/to/family    --embedding-model local --decision-model local   # indexes family; trip-2024 is kept
uv run photolib catalog set /path/to/trip-2024 --embedding-model local --decision-model local   # back again, nothing to index
uv run photolib catalog show                   # current catalog, its counts and its index folder
uv run photolib catalog set /path/to/family --rebuild --embedding-model local --decision-model local   # wipe and re-index family only
```

The web UI does the same on the Admin page: *Switch catalog* for another folder, *Rebuild catalog*
when you enter the current one. There is no command that lists the catalogs you have indexed; look
in `data/catalogs/`. See [Data layout](#data-layout) for the files, and
[Index on one machine, serve from another](#index-on-one-machine-serve-from-another) for copying an
index to a second machine.

## CLI

All commands run as `uv run photolib <command>`.

### Where the models run

Two flags say where each model runs. They go on any command (or set the env vars once):

| Flag | Env var | Model |
|---|---|---|
| `--embedding-model` | `PHOTOLIB_EMBEDDING_MODEL` | EmbeddingGemma 2: indexing, semantic search, tag suggestions |
| `--decision-model` | `PHOTOLIB_DECISION_MODEL` | d1-3B: subject tags, "find in library" |

Each takes one of:

- `local`: load the model in this process (GPU if there is one). This is the original behaviour.
- a URL, e.g. `http://gpu-host.example:8080/v1/embeddings`: call the model on another machine. The URL is
  used as given and nothing is checked up front; a request is simply sent when the model is needed.
- omitted: that model is not available. The CLI refuses what needs it and the web UI disables it.

```bash
uv run photolib serve --embedding-model local --decision-model local      # everything on this machine
uv run photolib refresh --embedding-model http://gpu-host.example:8080/v1/embeddings --decision-model local
uv run photolib serve --embedding-model http://gpu-host.example:8080/v1/embeddings   # search, no tagging
uv run photolib serve                                                      # browse an existing index only
```

Two more flags say where things live. They go **before** the command (or set the env vars):

| Flag | Env var | Meaning |
|---|---|---|
| `--data-dir` | `PHOTOLIB_DATA_DIR` | Base folder for everything photo-lib stores (default `./data`). It holds one index folder per catalog, so you rarely need to change it. |
| `--catalog-dir` | `PHOTOLIB_CATALOG_DIR` | Photo folder to use instead of the one stored in the data dir; see [Index on one machine, serve from another](#index-on-one-machine-serve-from-another). |

```bash
uv run photolib --data-dir /path/to/data catalog set /path/to/photos --embedding-model local --decision-model local
uv run photolib --data-dir /path/to/data serve --embedding-model local --decision-model local
```

| Without | Still works | Off |
|---|---|---|
| embedding model | browsing, filters, metadata search, similar photos, colour search, likes, manual tags, text-match tag suggestions | semantic (Query) search, refresh / catalog switch, similar-meaning suggestions, all tagging |
| decision model | everything above plus semantic search and refresh (embed only, photos stay untagged) | tag pass, retag, "find in library" |

Remote request formats (the server only has to accept these):

- Embeddings: `POST {"model": "google/embeddinggemma-2", "input": ["text", {"image": "<base64 JPEG>"}], "prompt_name": "SearchQuery"}`
  answers `{"data": [{"index": 0, "embedding": [...768 floats]}]}`. `prompt_name` is sent for text only. Images are
  sent EXIF-oriented and capped at 1024 px, 8 per request.
- Decisions: `POST {"model": "LiquidAI/d1-3B", "images": ["<base64 JPEG>"], "questions": {"q000": {"type": "noul", "instructions": "Is there a dog in this photo?"}}}`
  answers `{"answers": {"q000": {"noul": 0.97}}}` (d1's `system_one` call as JSON). One request per photo.

An index can mix sources: vectors from a remote EmbeddingGemma 2 and a local one are interchangeable (measured
on 16 sample photos: text vectors identical, image vectors 0.994 mean cosine, same top-5 for 3 test queries). A run stops at the
first failed remote request instead of marking every photo failed; run it again to resume.

| Command | What it does |
|---|---|
| `catalog set <dir> [--rebuild [--yes]]` | Makes `<dir>` the current catalog and indexes what is new in it. Every catalog has its own index, so nothing is deleted and switching back to a folder you indexed before is instant. `--rebuild` deletes that folder's index first and builds it from scratch (asks y/N unless you pass `--yes`). |
| `catalog show` | Prints the catalog dir, image/liked/subject counts, the data dir and the catalog's index folder in it. |
| `refresh [--prune] [--skip-tags]` | Two resumable passes with per-phase progress bars (rate + ETA). **Embed pass**: indexes new `*.jpg`/`*.jpeg` files (recursive, case-insensitive, skips hidden dirs); files already indexed are skipped and never re-embedded. **Tag pass**: tags every photo that isn't tagged yet with d1-3B. Files that are missing on disk are reported; `--prune` deletes their rows. `--skip-tags` runs only the embed pass. Prints per-phase throughput at the end. |
| `tag [--retag] [--limit N]` | Runs only the tag pass over untagged photos. `--retag` first marks every photo untagged (use it after editing `photolib/labels.py`); `--limit N` stops after N photos. Ctrl-C is safe: rerun `photolib tag` to resume. |
| `tag --labels "osprey,heron"` | **Per-label propagation** instead of the full pass: for each listed label, d1 checks only the photos where the label is an EmbeddingGemma top-20 candidate and that don't have it yet, and adds it where P(yes) ≥ 0.8. Labels that don't exist are created as your own (`user`) labels. Other tags and `tagged_at` are untouched. Can't be combined with `--retag`/`--limit`. |
| `labels [--user] [--used] [--remove <label> [--yes]]` | Lists the tag vocabulary (builtin + your labels) with photo counts, how many were added by hand, source and custom question. `--remove` deletes one of your labels (or a builtin that is no longer in `labels.py`) together with its tags. |
| `status` | Shows counts (incl. tagged / untagged), DB size, model and tagger paths, label count, device and dtype. |
| `serve [--host 0.0.0.0] [--port 8000] [--reload] [--no-warmup]` | Runs the API and web UI. By default it loads the model in the background at startup, so the first query is fast. |
| `purge [--yes]` | Deletes the current catalog's index (database, thumbnails, likes, tags) and unsets the catalog. Other catalogs and your photos are never touched. |

Examples:

```bash
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local
uv run photolib refresh            # second run: "0 new / 31 skipped ... 31 tagged / 0 untagged"
uv run photolib refresh --prune    # also drop rows for deleted files
uv run photolib refresh --skip-tags  # embed only; search works right away, tag later
uv run photolib tag                # tag whatever is untagged (resumes an interrupted run)
uv run photolib tag --retag        # re-tag everything after editing photolib/labels.py (manual tags are kept)
uv run photolib tag --labels "whale,heron"   # look for just these labels in the photos that lack them
uv run photolib labels --user      # the labels you created, with counts
uv run photolib labels --remove "pigoen" --yes   # drop a label you created by mistake (and its tags)
uv run photolib status
uv run photolib serve --port 8080
uv run photolib purge --yes
```

`catalog set` on the 31-photo sample folder prints, for example:

```
Embedding    ━━━━━━━━━━━━━━━━━━━━━ 31/31 11.01 img/s 0:00:07
Tagging (d1) ━━━━━━━━━━━━━━━━━━━━━ 31/31 3.18 img/s  0:00:11
31 new / 0 skipped / 0 failed / 0 missing on disk
  embedding: 31 in 7.3s (4.27 img/s incl. model load, steady 11.01 img/s)
  tagging: 31 in 11.8s (2.64 img/s incl. model load, steady 3.18 img/s)
31 tagged / 0 untagged  (19.2s total)
```

## Web UI

- **Library**: a masonry grid in 2–6 columns depending on width, with small or large thumbnails. It
  opens in **random order**, reshuffled on every page load and kept while you scroll, filter or open
  photos. On desktop, hovering a photo shows the filename and its focal length, aperture, shutter
  speed and ISO. More photos load automatically as you scroll (60 at a time); a *Load more* button
  stays as the fallback and is the only trigger when the system asks for reduced motion.
- **Search modes**: use the dropdown in the search box.
  - *Query* (semantic): press Enter to search. Results are ranked by similarity, best match first.
    Hover a photo to see its score.
  - *Metadata*: searches live as you type, using FTS5 prefix matching on file name, make, model,
    lens and software. Every word must match, so `KI8A` or `RF200 canon` both work.
- **Filter suggestions**: while you type a word or two, the search box offers matching filters below
  it: subjects ("bird" → Bird, Bird in flight…), lens / light / depth presets ("tele", "low light",
  "bokeh"), dates ("2025", "june", "june 2025"), "liked", and camera or lens names ("rf200"). Click or
  tap one, or pick it with ↑↓ and Enter (or Tab), and the typed word turns into a filter chip; the rest
  of the text stays. Nothing is applied on its own: Enter without a highlighted suggestion searches
  the text as typed, and Esc hides the list. Suggestions need three letters, ignore words like "in" or
  "the", and once you are typing a sentence (two or more words before the current one) only exact
  matches of the non-subject filters show, so a description like "a dog sitting on the grass" is not
  interrupted.
- **Dock**: a floating bar at the bottom of the library, the same on phone and desktop:
  - *Shuffle* (tap again to reshuffle) and *By date* (tap again to flip newest/oldest first). Hidden
    for ranked results (query, color, similar).
  - *Liked*: liked photos only.
  - *Color*: preset swatches or a custom color (see Color search).
  - *Subjects*: every subject in use, grouped by category (the labels you created are under *Your
    tags*), with a find box (Enter picks the first match). Selecting several matches photos with any
    of them.
  - *More*: presets with photo counts for lens (wide, normal, tele, super-tele), light (ISO) and
    depth of field (aperture); a date histogram (years, then the months of a year; tap a month and
    then another for a range); camera and lens; the other sort orders (date added, file name, date
    liked); thumbnail size; and *Exact ranges* for typing ISO, aperture, focal length and dates.

  Filters also apply on top of query, color and similar results. Active filters appear as removable
  chips above the grid, and Color, Subjects and More show what is set on their buttons.
- **Color search**: pick a preset swatch or a custom color from the dock's Color button, or click a palette
  swatch in the lightbox.
- **Lightbox**: opens with a single tap or click. Navigation:
  - Desktop: arrow keys, `Esc` to close, `L` to like, `I` to toggle the info panel.
  - Mobile: swipe left/right to change photos, swipe down to close.

  The lightbox also has:
  - An EXIF summary (camera, lens, settings, date, dimensions, size).
  - The full EXIF table, with common codes decoded. For example, ExposureProgram 3 is shown as
    "Aperture priority".
  - The palette swatches.
  - Subject chips, all of the photo's tags in EmbeddingGemma rank order (the grid's data carries the
    top 5). Hovering a chip shows d1's confidence; clicking one filters the library by that subject.
    A dashed chip with an amber **EG** badge is the fallback: d1 rejected every candidate, so
    EmbeddingGemma's best guess is shown. Tags you added yourself are teal chips with an **×** that
    removes them (model tags have no ×: a re-tag would bring them back).
  - **Add a tag** (under the chips, in the desktop panel and the phone info sheet). Focusing the box
    lists likely labels for this photo; typing (debounced 150 ms) lists existing tags: text matches
    first, then tags with a similar meaning (violet *similar* badge), each with its photo count.
    Tags already on the photo are greyed out. `Create "xyz"` is the last row and only appears when
    no tag is spelled exactly like that. ↑/↓ move, Enter picks the highlighted row, Esc closes the
    list. On phones the box jumps to the top of the sheet so the 44 px rows stay above the keyboard.
  - After you **create a new tag**, a prompt offers to *look for it in your other photos* with the
    number of candidate photos and a time estimate. *Run* starts the search in the background and
    shows a compact progress bar (photos/s, time left, found so far), then the result; *Not now*
    keeps the tag on this photo only (you can run it later from Admin). See
    [Manual tags](#manual-tags-suggestions-and-propagation).
  - **Find similar**, plus a link to the original file.
- **Likes**: double-tap a photo (touch) or double-click it (desktop) to like or unlike it, with a
  heart burst. This works on the grid and in the lightbox. Likes persist in the database.
- **Admin** (`/admin`, gear icon):
  - Status cards (photos, tagged, untagged with the estimated time to tag them, liked, subjects in
    use, DB size) and two model cards: EmbeddingGemma and the d1-3B tagger (device, label count,
    threshold, loaded or not).
  - **Refresh**, with an optional *Prune missing* checkbox, and a two-step live progress view:
    *1 Embed new photos* then *2 Tag subjects*, each with its own bar, photos/s over a sliding
    window and time left; while embedding, the tag step shows its estimated duration. The header
    shows the overall time left and the current file, and a summary when the run finishes.
  - **Retag all**: re-runs d1 over every photo (after editing the labels). The confirm dialog shows
    the estimate (photos × 0.3 s); current subjects stay visible until each photo is re-tagged, and
    tags you added by hand are kept.
  - **Your labels**: the labels you created, with photo counts, and a **Find in library** button
    each. It shows the candidate count and estimate, asks for confirmation, then runs the same
    per-label search with live progress in the indexing panel.
  - **Switch catalog**: shows another photo folder and indexes what is new in it. Nothing is
    deleted; every catalog keeps its own index, likes and tags. If you enter the current folder, the
    button reads *Rebuild catalog* and, after a confirmation that explains the purge, re-indexes it
    from scratch.
  - **Purge everything**: deletes the current catalog's index; you must type `purge` to confirm.
- Light and dark themes follow the system setting. The toggle in the top bar remembers your choice.
  The search, filters and open photo are all kept in the URL, so you can share or bookmark a view,
  and Back closes the lightbox.

## Access from your phone or other devices

The server binds `0.0.0.0:8000`, and every UI and image URL is relative. On a normal Linux host, open
`http://<host-ip>:8000` from any device on the LAN. `serve` prints the address it detects.

**WSL2** uses NAT by default, so the IP that `serve` prints (for example `172.x.x.x`) is only
reachable from the Windows host. To reach the server from other devices, use either option:

- **Mirrored networking** (Windows 11 22H2+): add the following to `%UserProfile%\.wslconfig`, then
  run `wsl --shutdown`. WSL then shares the Windows IP. You may also need to allow port 8000 in the
  Windows firewall.
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
- **Port proxy**: in an elevated PowerShell, run:
  ```powershell
  netsh interface portproxy add v4tov4 listenport=8000 listenaddress=0.0.0.0 connectport=8000 connectaddress=<wsl-ip>
  New-NetFirewallRule -DisplayName "photo-lib 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
  ```
  The WSL IP changes on reboot, so you'll need to re-run this.

Then browse to `http://<windows-lan-ip>:8000`.

## Index on one machine, serve from another

The data dir is self-contained (plain SQLite plus thumbnails per catalog), so you can index on a machine with a
fast GPU and serve the catalog from a small one that has no GPU and no model weights:

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

`--catalog-dir` (or `PHOTOLIB_CATALOG_DIR`) says where the photos are on this machine. The current catalog
and its index are still found through the path stored in `config.json`, which is the path on the
machine that indexed. Without the photos on the serving machine everything still works from the
thumbnails except opening a photo at full size. The remote embedding model must be the same
EmbeddingGemma 2 the index was built with. Likes and manual tags made on the serving machine live in
its copy of the data dir, so copying the data dir again overwrites them.

## System overview

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/static/img/system-overview-dark.png">
  <img alt="photo-lib system overview: the photo folder feeds the indexing passes, which call EmbeddingGemma 2 and d1-3B and write the index; the server reads and writes the index, calls the models, and serves the web UI" src="website/static/img/system-overview-light.png">
</picture>

**Indexing** reads your photos and writes the index. The embed pass stores EXIF data, a thumbnail, a
color palette and an EmbeddingGemma 2 image embedding for each new JPEG. The tag pass then ranks the
labels against that stored embedding and asks d1-3B about the 20 best. The **server** reads and writes
the index, keeps every vector in memory for search, calls EmbeddingGemma for Query searches and d1-3B
for tagging jobs, and serves the web UI, thumbnails and originals. The photo folder is only ever read.

## Data layout

```
data/                         # --data-dir / PHOTOLIB_DATA_DIR overrides (default ./data)
  config.json                 # {"catalog_dir": "/path/to/photos"}: the current catalog
  catalogs/<name>-<hash>/     # one index folder per catalog: the photo folder's name + a hash of its full path
    photolib.db               # SQLite: images, EXIF, colors, likes, subjects, labels, embeddings (BLOB), FTS5, meta
    thumbs/<sha1>.webp        # 640px long edge, q=80, EXIF orientation applied; sha1 of the relative path
models/embeddinggemma-2       # PHOTOLIB_MODEL_DIR overrides
models/d1-3B                  # PHOTOLIB_TAGGER_DIR overrides
```

`catalog set /path/to/photos` works out the index folder from the photo folder's path and creates it
on first use (see [Catalogs](#catalogs)). A data dir from an older version (`photolib.db` and `thumbs/`
directly inside it) is moved into its catalog's folder the first time it is used.

Schema notes: `embeddings(rel_path, vec)` holds the 768 float32 values as a plain BLOB (sqlite-vec is
no longer used). `images.tagged_at` / `images.tagger` record the tag pass; `subjects` rows carry
`score` (d1 P(yes), the cosine for a fallback row, or 1.0 for a manual tag), `source` (`d1`, `eg` or
`user`), `eg_score` and `display_rank` (manual tags first, then model tags by EmbeddingGemma cosine).
`labels(label, question, category, source, created_at)` is the tag vocabulary: `builtin` rows are
seeded from `photolib/labels.py`, `user` rows are the labels you created. `meta.vec_version` is a
random token bumped on every insert/delete (see below) and `meta.labels_version` one that is bumped
whenever the vocabulary changes. The schema version lives in `PRAGMA user_version` (currently 3).

**Upgrading from schema v2** (an index built before manual tags) happens **in place** the first time
the new version opens the database: the `labels` table is created and seeded, the version is stamped
3, and nothing else is rewritten — photos, embeddings, subjects and likes stay as they are, no
re-index or re-tag is needed. Restart a running `photolib serve` after upgrading the code (an old
process would refuse the v3 file as "newer").

**Upgrading from an older index:** a database built before subject tagging (sqlite-vec embeddings,
schema v0) is not migrated. The CLI prints, and the API returns as HTTP 409 (shown in the UI with a
*Rebuild catalog* button), a message telling you to rebuild with `photolib catalog set <dir> --rebuild`. Your
photos are untouched; likes are not carried over.

The primary key is each file's path relative to the catalog root. Originals are served straight from
the catalog folder and never modified. `photolib purge` deletes the current catalog's index folder;
deleting `data/` removes every catalog's index.

## How search works

- **Embeddings**: EmbeddingGemma 2 puts text and images in one shared 768-dimensional space. It is
  loaded through sentence-transformers with the audio tower disabled (text and image only, about
  440M params), in bf16 on CUDA. Images are encoded with no prefix. Text queries use the model's
  `SearchQuery` prompt (`task: search result | query: …`). Vectors are L2-normalized, and ranking
  uses cosine similarity.
- **In-memory vector cache**: each server process keeps every embedding in one numpy float32 matrix
  (25k × 768 ≈ 77 MB) plus every palette flattened into arrays. Each request reads
  `meta.vec_version` (one tiny query); when the token changed (photos added, pruned, catalog rebuilt)
  the cache reloads, which takes ~100 ms for 25k photos.
- **Query and similar search**: exact, with no oversampling and no k cap. Filters run as SQL (the
  same WHERE clause as the library) to get the candidate photos, their rows are gathered from the
  matrix, scored with one matrix-vector product and the top `offset + limit` are picked. Find similar
  uses the stored vector and excludes the source photo. Every search endpoint supports
  `limit`/`offset` paging.
- **Color**: when a photo is indexed, it is downscaled to 100px and clustered with k-means (k=6) in
  CIELAB. The stored palette is a list of `{hex, lab, share}`. A color query scores every (filtered)
  photo, vectorized over the cached palettes: `Σ share_i · exp(−ΔE76(lab_i, query) / 25)`. Higher is
  better, so a photo dominated by a close color wins.
- **Metadata**: FTS5 over file name, make, model, lens and software, with prefix matching on every
  word.

## Subject tagging

Subjects come from a **hybrid** of the two models (chosen in a spike on the sample set, where it named
the main subject on 31/31 sample photos with no false positives and accepted 0 of 36 decoy labels):

1. **EmbeddingGemma proposes.** Every label in `photolib/labels.py` is embedded once (`SearchQuery`
   prompt). For each photo, the cosine against all labels is a free matrix product over the stored
   embedding; the **top 20** become candidates.
2. **d1-3B confirms.** The photo is loaded at native resolution (EXIF-rotated, capped at 1600 px; d1
   bounds it to 1 MP and tiles it, which is what makes small, distant birds work) and d1 answers the 20
   yes/no questions ("Is there a pigeon in this photo?") in **one forward pass**. Questions don't
   compete with each other, and P(yes) is sharp: present things score ~0.98, absent ones ~0.02.
3. Every candidate with **P(yes) ≥ 0.8** is kept. They're ranked by EmbeddingGemma's cosine
   (`display_rank`), because d1's P saturates and can't say which subject is the main one; grid data
   and chips use the top 5, the lightbox shows all. If d1 rejects all 20, the EmbeddingGemma top-1 is
   stored with `source='eg'` so every photo has a subject.

The tag pass runs after the embed pass, over `images WHERE tagged_at IS NULL` in file order, and
commits after every photo, so Ctrl-C, a crash or a reboot just resumes on the next `refresh` / `tag`.
d1 is loaded lazily when the pass starts and **unloaded when it ends**, so an idle server only holds
EmbeddingGemma (~2 GB) on the GPU.

The vocabulary d1 is asked about is the `labels` table: the builtin entries below **plus the labels
you created in the UI**, so a refresh or a re-tag also checks new and existing photos for your labels.

**Editing the labels.** `photolib/labels.py` is the seed of that table: when it changes, the next
connect inserts new entries and updates reworded questions (unless a question was edited in the
database); entries you delete from the file are *not* removed from the table — drop them with
`uv run photolib labels --remove <label>`. It holds ~150 entries grouped by category (birds, mammals,
flowers, landscape, water, urban, people, vehicles, …). Each entry is `{"label": ..., "question": ...}`;
`question` is optional and defaults to `"Is there a {label} in this photo?"`. Give a label its own
question when the plain form is ambiguous. The shipped overrides fix the spike's systematic errors:
"orange" asks about *the citrus fruit* (it scored 0.99 on orange marigolds otherwise), "food" asks
about *food that is ready to eat* (it fired on a bee on flowers), "portrait" asks about *a person*
(it fired on dog close-ups). "macro", "wildlife" and "interior" were dropped as noise. After editing,
run `uv run photolib tag --retag` (or *Retag all* in Admin). Embeddings are not recomputed.

## Manual tags, suggestions and propagation

**Manual tags.** In the lightbox, type a tag and pick a row. The text is normalized (trimmed,
whitespace collapsed, lowercased; at most 40 characters; must contain a letter or digit; no `/`), and
uniqueness is on that form, so "  Wild   Turkey " is the existing `wild turkey`. A manual tag is a
`subjects` row with `source='user'` and score 1.0. It ranks ahead of the model's tags, shows up in the
subject filter like any other tag, can be removed with its ×, and **survives re-tags**: the tag pass
only replaces the model's rows (and drops a model row that duplicates a manual one). Removing a manual
tag never deletes the label; adding a tag the model already put on the photo changes nothing.

**Suggestions** (`GET /api/labels/suggest`) exist to stop near-duplicates. For the typed text, existing
labels are ranked in tiers:

1. **exact** — the normalized text is a label (then there is no *Create* row);
2. **prefix** — the label starts with it (most-used first);
3. **text** — it is a substring of the label, or every typed word starts a word of the label
   (`fl bird` → *bird in flight*), or the label's words are all among the typed words; simple plurals
   are folded, so `pigeons` → *pigeon* without the model;
4. **similar** — the EmbeddingGemma text vector of what you typed (same `SearchQuery` prompt as the
   labels, ~30 ms, LRU-cached) against the cached label vectors; up to 4 labels with cosine
   **≥ 0.82**, best first. Needs at least 3 typed characters.

The 0.82 floor was calibrated on the 154 builtin labels with ~65 probe words. Label text vectors are
close to each other in this model, so junk still scores ~0.70–0.79 against *something*
(`asdfgh` → 0.74, `tax return` → 0.69, `love` → 0.79, `computer` → 0.79), while real synonyms score
0.82 and up (`pizza` → food 0.82, `tabby` → cat 0.83, `dusk` → sunset 0.84, `sea` → ocean 0.90 /
coast 0.85 / beach 0.83, `puppy` → dog 0.89, `kitten` → cat 0.88, `plane` → aircraft 0.91). At 0.80
second-rate neighbours leak in (`puppy` → baby 0.80, `blue` → orange 0.81); at 0.82 every junk probe
returns nothing. The price is a few loose associations that fall just short (`wire` → power lines
0.79, `raptor` → hawk 0.80): for those you just get the *Create* row. An empty query with a photo
returns that photo's best EmbeddingGemma labels that it doesn't have yet. If the embedding model
can't be loaded, text matches still work.

**Propagation** applies ONE label to the rest of the library, consistently with what a full re-tag
would do, but asking d1 a single question per photo:

1. **Candidates** = photos where the label ranks in the EmbeddingGemma **top 20 across the whole
   current vocabulary** (one matrix product over the cached image vectors × label vectors, ~50 ms),
   minus photos that already have the label and photos that aren't tagged yet (the normal tag pass
   will ask them about every label, yours included).
2. **d1** loads, answers that one yes/no question per candidate at full resolution, and
   **P(yes) ≥ 0.8** adds a `source='d1'` row (score = P, ranked among the photo's model tags by
   EmbeddingGemma cosine). One commit per photo; other tags and `tagged_at` are never touched.
3. d1 is unloaded when the job ends. It shares the single indexing slot (HTTP 409 while a refresh or
   re-tag runs) and the same progress object (`mode: "propagate"`, `phase: "propagating"`).

It isn't resumable as a job, but interrupting it is safe, and running it again only asks the photos
that still lack the label. The preview (`candidates`, `est_seconds` = 8 s model load + 0.3 s per
photo) is what the lightbox prompt and the Admin dialog show. The default question is
`Is there a {label} in this photo?`; the API accepts a custom `question` when creating a label.

Measured on the 266-photo sample catalog (RTX 4080; times include loading d1, ~3-5 s with a warm
disk cache, then ~3.5 photos/s):

| New tag (on one photo) | Candidates | d1 confirmed | Time | Looking at the photos |
|---|---|---|---|---|
| `jellyfish` | 64 | 22 | 22 s | all 22 are jellyfish; 3 more jellyfish-like photos scored 0.59–0.78 and were left out |
| `whale` (CLI) | 153 (with `heron`) | 26 | 43 s | all 26 show a whale; some distant backs/blows were not confirmed |
| `seaweed` | 180 | 19 | 50 s | the kelp-tank photos |
| `lamp` | 8 | 6 | 5 s | exactly the other 6 photos of the lamp |
| `sea anemone` | 77 | 2 | 23 s | exactly the other 2 anemone photos |
| `red wattle` (only on the turkey photo) | 22 | 0 | 9 s | correct: nothing else has one |
| `kelp` | 185 | 0 | 51 s | **miss**: d1 answers 0.3–0.75 for "kelp" on the kelp photos (0.95+ for "seaweed") |

So precision is high and d1 errs on the side of saying no; a tag d1 doesn't know well (kelp) finds
nothing, in which case try a more common word. A full `tag --retag` afterwards kept every manual tag
and re-found the propagated ones (jellyfish 23/23, seaweed 20/20, lamp 7/7; whale 25 of 26, one photo
sitting right at the 0.8 threshold).

**Time estimates** (RTX 4080, measured on copies of the 1600 px sample photos):

| Library | Embed pass (~14.5 photos/s) | Tag pass (~3.4 photos/s, ~0.29 s/photo) |
|---|---|---|
| 1,000 photos | ~1 min | ~5 min |
| 25,000 photos | **~30 min** | **~2 h** |

Search works as soon as the embed pass has committed a batch; tagging runs afterwards and can be
skipped (`--skip-tags`) and done later. Retagging 25k photos after a label edit is another ~2 h.

**Licence note.** d1-3B is released under the **LFM Open License v1.0** (`models/d1-3B/LICENSE`), not
an OSI open-source licence: commercial use is only licensed for entities under US$10M annual revenue;
personal and research use is unrestricted. photo-lib downloads the weights rather than shipping them;
don't redistribute them without the licence. Loading needs `trust_remote_code=True`, which runs the
model's own Python files from `models/d1-3B` (reviewed in the spike: no network or file access beyond
loading the tokenizer/processor from that folder). Re-check them if you re-download the model.

## API

JSON endpoints, all under `/api`:

- `status`
- `images` (list and metadata search, with filters, `sort` (`random`, `taken_at`, `file_name`, `indexed_at` or `liked_at`), `order`, `seed` (picks the shuffle for `sort=random`; keep it while paging), `limit` and `offset`)
- `images/{id}` (detail with full EXIF and all subjects with `source` / `eg_score` / `display_rank`)
- `images/{id}/like`
- `POST images/{id}/tags` (body `{label, question?}`: add a manual tag; creates the label when it is
  new → `{label, created, added, subjects}` plus `propagate: {candidates, est_seconds}` when created;
  422 for text that can't be a label)
- `DELETE images/{id}/tags/{label}` (remove a manual tag; 409 for a tag the model added, 404 if absent)
- `labels` (the whole vocabulary: `{label, question, category, source, created_at, count, manual_count}`)
- `labels/suggest?q=&image=&limit=8` → `{items: [{label, count, match, similarity, source, on_image}],
  exact_exists, normalized, can_create, reason}`; `match` is `exact`|`prefix`|`text`|`similar`, or
  `image` for the empty-query defaults
- `labels/{label}/propagate/preview` → `{candidates, est_seconds}`
- `POST labels/{label}/propagate` (body `{confirm: true}`) → `{ok, started, candidates, est_seconds}`;
  `started` is false when there are no candidates; 409 while another run is active
- `search/query`
- `search/similar/{id}`
- `search/color?hex=`
- `subjects` (`{label, count, category}`; `category` is null for labels you created)
- `facets` (makes, models, lenses with counts; ISO / aperture / focal / date ranges; `iso_values`, `f_values`, `focal_values` and `months` distributions for the presets and the date histogram)
- `thumb/{id}`
- `image/{id}`
- `admin/config` (returns `catalog_dir`, `data_dir` and `index_dir`, the current catalog's index folder)
- `admin/catalog` (body `{catalog_dir, confirm: true, rebuild}`; switches catalog and indexes what is new, `rebuild: true` deletes that catalog's index first)
- `admin/refresh` (body `{prune, skip_tags}`)
- `admin/retag` (body `{confirm: true}`; marks every photo untagged and starts the tag pass)
- `admin/progress`
- `admin/purge` (body `{confirm: true}`; deletes the current catalog's index and unsets the catalog)

`status` also returns `tagged_count`, `untagged_count` and `tagger: {name, device, dtype, loaded,
labels, user_labels, threshold, seconds_per_image}`. The progress object (`indexing` in `status`, and
`admin/progress`) carries `mode` (`refresh`|`tag`|`retag`|`propagate`), `phase`
(`scanning`|`embedding`|`tagging`|`propagating`|`done`), `done`/`total` for the current phase, `rate`
(photos/s over a 30 s window), `eta_seconds`, `embed_done`/`embed_total`, `tag_done`/`tag_total`, live
`tagged`/`untagged` counts and, for a propagate job, `labels`, `propagate_added` and
`propagate_seconds`. Image summaries carry `subjects: [{label, score, source}]` (top 5 by display
rank; `source` is `d1`, `eg` or `user`). A database that needs a rebuild answers every DB-backed endpoint with HTTP 409 and
`{"detail": "...", "code": "schema_rebuild_required"}`.

Thumbnail and image URLs carry `?v=<sha1>`, so they can be cached
as immutable.

## Development

```bash
uv run pytest -q                       # backend tests; the GPU ones (real d1 + API smoke) need PHOTOLIB_SAMPLE_DIR, see below
uv run pytest -q -m "not slow"         # fast tests only: schema/migration, numpy search vs brute force, colors,
                                       # labels, hybrid tag rule + resumable tag pass with a mocked d1,
                                       # label normalization, v2 -> v3 migration, suggestions, manual
                                       # tags, retag keeps manual tags, propagation (mocked EG + d1)

uvx ruff check .                       # docstring lint (Google style, see AGENTS.md)

cd frontend
npm run dev                            # Vite on :5173, proxies /api to :8000 (PHOTOLIB_API overrides)
npm run mock                           # tiny mock API on :8000 for UI work without the backend/GPU
npm run build                          # type-check + build to frontend/dist
```

The slow tests run the real models on a private set of sample photos that is not part of this
repository: point `PHOTOLIB_SAMPLE_DIR` at the folder to run them; without it they are skipped. The
same goes for the file names in `frontend/scripts/e2e-tags.mjs`.

Playwright QA scripts live in `frontend/scripts`. Both expect a running server. Install Chromium
once with `npx playwright install chromium`.

```bash
BASE_URL=http://localhost:8000 npm run e2e        # functional checks against real data; prints top results per query
BASE_URL=http://localhost:8000 npm run e2e:smart  # search-box filter suggestions at 1440/820/390/360 px (read-only)
ADMIN_FLOW=1 CATALOG_DIR=/path/to/sample npm run e2e   # also Refresh + "Switch catalog" (rebuilds the index of CATALOG_DIR if it is the current catalog!)
BASE_URL=http://localhost:8000 npm run shots      # screenshots -> qa/screenshots/<phone|tablet|desktop>-<light|dark>-<page>.png
BASE_URL=http://localhost:8000 node scripts/shot-progress.mjs   # admin two-phase progress (synthetic 25k states; REAL=1 adds a live retag)
BASE_URL=http://localhost:8000 npm run docs:shots # screenshots for the documentation site -> website/static/img/screenshots (read-only)
```

`scripts/e2e-tags.mjs` drives the manual-tag flow for real (suggestions, add / remove, create a new
tag, propagate it with d1, Admin → Find in library) on desktop + phone in light + dark, and saves
screenshots when `OUT` is set. It **writes** to the database (creates labels, tags photos) and its
photo ids are those of the sample catalog, so run it against a scratch data dir and a second server,
never your real library:

```bash
export PHOTOLIB_DATA_DIR=/tmp/photolib-scratch
uv run photolib catalog set /path/to/sample --embedding-model local --decision-model local
uv run photolib serve --port 8001 --embedding-model local --decision-model local &
cd frontend && BASE_URL=http://localhost:8001 OUT=/tmp/shots node scripts/e2e-tags.mjs
```

`PHOTOLIB_FRONTEND_DIST=<dir>` makes `serve` use a UI build from another folder
(`npm run build -- --outDir <dir> --emptyOutDir`), which lets you try a new build without replacing
the `frontend/dist` a running server is serving. The mock API (`npm run mock`) doesn't implement the
tag endpoints.

Viewports: phone is 390×844 (touch, 2×), tablet is 820×1180 (touch), desktop is 1440×900. On WSL
without root, Chromium may be missing `libnss3`/`libnspr4`. If so, run
`apt-get download libnss3 libnspr4`, `dpkg -x` both into a directory, and run the scripts with
`LD_LIBRARY_PATH=<dir>/usr/lib/x86_64-linux-gnu`.

## Known limitations

- **JPEG only.** HEIC, RAW, PNG and video are ignored.
- **Indexing only adds photos.** Files that changed in place aren't re-indexed; remove and re-add
  them, or rebuild. Renaming a file counts as a delete plus a new file, so its like is lost unless
  you keep the old name.
- **Vectors live in RAM per server process** (~77 MB for 25k photos, plus a reload of ~100 ms after
  each indexing change). Fine for a personal library; not meant for millions of photos.
- **No total count for ranked searches.** Query, color and similar results show "N photos · best
  match first" and keep loading as you scroll.
- **Subjects come from a vocabulary** (`photolib/labels.py` plus the labels you create). The model
  only tags what is in it (query search still finds everything), and EmbeddingGemma must rank a label
  in its top 20 for d1 to be asked — for propagation too, so a new tag is only looked for in photos
  EmbeddingGemma already finds plausible, and only added where d1 is at least 80% sure. Tags d1 is
  vague about find little or nothing (e.g. "kelp" → 0 on the sample, "seaweed" → 19). Every label
  you create is one more question competing for the 20 slots per photo, so keep the vocabulary tidy
  (`photolib labels --remove`). There is no UI to rename or delete a label or to edit its question. d1 can be over-literal on debatable labels (e.g. "mountain" on high hills, "pine tree"
  on other conifers); it was calibrated on 31 photos of ~8 scenes, so expect the odd miss on photo
  types the sample didn't have (people, night, cities).
- **Tagging is GPU-bound and slow-ish**: ~0.3 s per photo, ~2 h for 25k. The d1 fast path uses
  private PyTorch attention ops (bf16, Ampere or newer); a PyTorch upgrade could break it.
- **Time zones:** dates and date filters use the camera's local time as recorded in EXIF.
  Photos with no offset tag are compared as-is.
- **No authentication.** Anyone on your LAN who can reach the port can browse, like, refresh and
  purge. Don't expose the port to the internet.
- **One indexing run at a time** (refresh, tag, retag and per-label propagation share it). Switching
  or purging the catalog, or starting a retag or a propagation, while one runs returns HTTP 409. The
  lightbox only shows propagation progress while it stays open (the job itself continues; Admin
  shows it), and the grid's hover data for other photos refreshes on the next search or reload. A `photolib refresh`/`tag` in a terminal and a
  run started from the web UI don't know about each other; avoid running both at once.
