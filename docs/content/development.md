---
title: Development
---

# Development

Coding conventions are in `AGENTS.md` at the root of the repository.

```bash
uv run pytest -q                       # backend tests; the GPU ones (real d1 + API smoke) need PHOTOLIB_SAMPLE_DIR, see below
uv run pytest -q -m "not slow"         # fast tests only: no GPU, no models
uvx ruff check .                       # lint (Google-style docstrings, unused names)

cd frontend
npm run dev                            # Vite on :5173, proxies /api to :8000 (PHOTOLIB_API overrides)
npm run mock                           # tiny mock API on :8000 for UI work without the backend/GPU
npm run build                          # type-check + build to frontend/dist
```

The slow tests run the real models on a private set of sample photos that is not part of the
repository: point `PHOTOLIB_SAMPLE_DIR` at a folder of photos to run them; without it they are skipped.
The same goes for the file names in `frontend/scripts/e2e-tags.mjs`.

`PHOTOLIB_FRONTEND_DIST=<dir>` makes `serve` use a UI build from another folder
(`npm run build -- --outDir <dir> --emptyOutDir`), which lets you try a new build without replacing the
`frontend/dist` a running server is serving. The mock API (`npm run mock`) doesn't implement the tag
endpoints.

## Browser QA scripts

Playwright scripts live in `frontend/scripts`. They all expect a running server. Install Chromium once
with `npx playwright install chromium`.

```bash
BASE_URL=http://localhost:8000 npm run e2e        # functional checks against real data; prints top results per query
BASE_URL=http://localhost:8000 npm run e2e:smart  # search-box filter suggestions at 1440/820/390/360 px (read-only)
ADMIN_FLOW=1 CATALOG_DIR=/path/to/sample npm run e2e   # also Refresh + "Switch catalog" (rebuilds the index of CATALOG_DIR if it is the current catalog!)
BASE_URL=http://localhost:8000 npm run shots      # screenshots -> qa/screenshots/<phone|tablet|desktop>-<light|dark>-<page>.png
BASE_URL=http://localhost:8000 node scripts/shot-progress.mjs   # admin two-phase progress (synthetic 25k states; REAL=1 adds a live retag)
```

`scripts/e2e-tags.mjs` drives the manual-tag flow for real (suggestions, add / remove, create a new tag,
propagate it with d1, Admin → Find in library) on desktop and phone in light and dark, and saves
screenshots when `OUT` is set. It **writes** to the database (creates labels, tags photos) and its
photo ids are those of the sample catalog, so run it against a scratch data dir and a second server,
never your real library:

```bash
export PHOTOLIB_DATA_DIR=/tmp/photolib-scratch
uv run photolib catalog set /path/to/sample --embedding-model local --decision-model local
uv run photolib serve --port 8001 --embedding-model local --decision-model local &
cd frontend && BASE_URL=http://localhost:8001 OUT=/tmp/shots node scripts/e2e-tags.mjs
```

Viewports: phone is 390×844 (touch, 2×), tablet is 820×1180 (touch), desktop is 1440×900. On WSL
without root, Chromium may be missing `libnss3`/`libnspr4`. If so, run `apt-get download libnss3
libnspr4`, `dpkg -x` both into a directory, and run the scripts with
`LD_LIBRARY_PATH=<dir>/usr/lib/x86_64-linux-gnu`.

## This documentation site

The site is built with [Docusaurus](https://docusaurus.io/) and lives in `docs/`. The pages are
Markdown files in `docs/content/`, and the sidebar is defined in `docs/sidebars.ts`.

```bash
cd docs
npm install
npm start                              # dev server with live reload on :3000/photo-lab/
npm run build                          # static site in docs/build (fails on broken links)
```

The screenshots in `docs/static/img/screenshots/` come from `frontend/scripts/docs-shots.mjs`. Run
it against a server with a tagged catalog and both models configured, so that the Admin page shows
tagging as available. The script is read-only:

```bash
cd frontend
BASE_URL=http://localhost:8000 npm run docs:shots
```

The script replaces folder paths and model endpoints with placeholders, and removes serial numbers and
GPS from the EXIF, before the page renders them. The library shots use a fixed shuffle seed and the
viewer shows the oldest photo tagged "dog"; `PHOTO=<id>` picks another photo and `ONLY=name,...`
retakes only some shots.
