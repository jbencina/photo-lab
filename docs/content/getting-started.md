---
title: Getting started
---

# Getting started

## Requirements

- Linux or WSL2 (developed on WSL2 Ubuntu).
- [uv](https://docs.astral.sh/uv/). It installs Python 3.12 and, with `--extra local`, PyTorch.
- Node.js 20+ and npm, to build the web UI.
- An NVIDIA GPU is strongly recommended. With CUDA, both models run in bfloat16. Without a GPU they
  run on the CPU in float32: search still works, but tagging a large library becomes impractical
  (d1-3B alone needs about 12.5 GB of RAM in fp32).
- About 9 GB of VRAM while tagging (EmbeddingGemma about 1.4 GB, d1-3B about 6.2 GB, plus CUDA
  contexts). d1-3B is unloaded after the tag pass, so search alone needs about 2 GB.
- About 8.5 GB of disk for the model weights (EmbeddingGemma about 2 GB, d1-3B 6.2 GB).

If the machine that holds the photos has no GPU, the models can run on another machine. See
[Where the models run](models.md).

## Install

```bash
# 1. model weights (once)
uvx hf download google/embeddinggemma-2 --local-dir models/embeddinggemma-2
uvx hf download LiquidAI/d1-3B --local-dir models/d1-3B      # subject tagger (LFM Open License, see below)

# 2. python env (the `local` extra is PyTorch + transformers, needed to run the models on this machine)
uv sync --extra local

# 3. web UI
cd frontend && npm install && npm run build && cd ..
```

## Index a folder and serve it

```bash
uv run photolib catalog set /path/to/photos --embedding-model local --decision-model local
uv run photolib serve --embedding-model local --decision-model local
```

`catalog set` indexes the folder in two passes: an embed pass (EXIF, thumbnail, palette, embedding)
and then a tag pass (subject tags). On a 31-photo folder it prints, for example:

```
Embedding    ━━━━━━━━━━━━━━━━━━━━━ 31/31 11.01 img/s 0:00:07
Tagging (d1) ━━━━━━━━━━━━━━━━━━━━━ 31/31 3.18 img/s  0:00:11
31 new / 0 skipped / 0 failed / 0 missing on disk
  embedding: 31 in 7.3s (4.27 img/s incl. model load, steady 11.01 img/s)
  tagging: 31 in 11.8s (2.64 img/s incl. model load, steady 3.18 img/s)
31 tagged / 0 untagged  (19.2s total)
```

Open [http://localhost:8000](http://localhost:8000). From now on,
`uv run photolib serve --embedding-model local --decision-model local` is the only command you need:
it serves both the API and the built UI (`frontend/dist`). If the UI hasn't been built, `serve`
prints a warning and the API still works under `/api`.

To browse from a phone or another computer, see [Phone and other devices](guide/phone.md).

## How long indexing takes

Measured on an RTX 4080 with copies of the 1600 px sample photos:

| Library | Embed pass (about 14.5 photos/s) | Tag pass (about 3.4 photos/s) |
|---|---|---|
| 1,000 photos | about 1 min | about 5 min |
| 25,000 photos | about 30 min | about 2 h |

Search works as soon as the embed pass has committed a batch. Tagging runs afterwards; you can skip
it (`refresh --skip-tags`) and run it later. Both passes are resumable: after Ctrl-C, a crash or a
reboot, the next `refresh` or `tag` continues where it stopped.

## Model license

d1-3B is released under the LFM Open License v1.0 (`models/d1-3B/LICENSE`), which is not an OSI
open-source license: commercial use is only licensed for entities under US$10M annual revenue;
personal and research use is unrestricted. photo-lib downloads the weights rather than shipping them;
don't redistribute them without the license.

Loading d1-3B needs `trust_remote_code=True`, which runs the model's own Python files from
`models/d1-3B`. They were reviewed when the tagger was chosen (no network or file access beyond
loading the tokenizer and processor from that folder). Re-check them if you re-download the model.
