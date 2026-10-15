"""Paths, constants and the tiny JSON config (`data/config.json`)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
# Project root when running from a source checkout (editable install, the normal `uv run` case).
_PROJECT_ROOT = PACKAGE_DIR.parent
_BASE = _PROJECT_ROOT if (_PROJECT_ROOT / "pyproject.toml").exists() else Path.cwd()

MODEL_NAME = "google/embeddinggemma-2"
EMBED_DIM = 768

# Indexing
JPEG_SUFFIXES = {".jpg", ".jpeg"}
EMBED_BATCH = 8
EMBED_MAX_SIDE = 1024  # images are downscaled to this long edge before going to the processor
THUMB_LONG_EDGE = 640
THUMB_QUALITY = 80
COLOR_SAMPLE_SIDE = 100
COLOR_K = 6

# Subject tagging: hybrid EG top-K candidates -> d1-3B yes/no (see subjects.py)
TAGGER_NAME = "LiquidAI/d1-3B"
TAGGER_SHORT = "d1-3B"  # stored in images.tagger
TAG_MAX_SIDE = 1600  # full resolution (capped): small distant birds need the tiled full-res view
TAG_CANDIDATES = 20  # EG top-K labels that d1 verifies
TAG_THRESHOLD = 0.8  # keep labels with d1 P(yes) >= this
TAG_SECONDS_ESTIMATE = 0.3  # per photo on the reference GPU (used for UI estimates only)
SUMMARY_SUBJECTS = 5  # ImageSummary.subjects = top-N by display_rank
TAG_LOAD_SECONDS_ESTIMATE = 8.0  # loading d1-3B from disk (used for UI estimates only)

# Tag suggestions (tags.py): EG text cosine floor for "similar" existing labels, calibrated on the builtin set
SUGGEST_SIMILAR_FLOOR = 0.82
SUGGEST_SIMILAR_MAX = 4
SUGGEST_QUERY_CHARS = 40
SUGGEST_MIN_CHARS = 3  # 1-2 typed characters carry no meaning for the embedder

_DB_FILES = ("photolib.db", "photolib.db-wal", "photolib.db-shm", "photolib.db-journal")


# Where each model runs: "local" (in this process), a URL (another machine), or None (not available).
# Set by `--embedding-model` / `--decision-model` on the command line, which store them in these env vars.
EMBEDDING_ENV = "PHOTOLIB_EMBEDDING_MODEL"
DECISION_ENV = "PHOTOLIB_DECISION_MODEL"


class ModelUnavailable(RuntimeError):
    """A feature needs a model this process can't use: started without it, or its weights are missing."""


def parse_model_setting(value: str | None) -> str | None:
    """Normalizes a `--embedding-model` / `--decision-model` value.

    Args:
        value: The raw flag or env var value.

    Returns:
        "local", an http(s) URL, or None when the value is empty.

    Raises:
        ValueError: If the value is neither "local" nor an http(s) URL.
    """
    v = (value or "").strip()
    if not v:
        return None
    if v.lower() == "local":
        return "local"
    if v.lower().startswith(("http://", "https://")):
        return v
    raise ValueError(f"expected 'local' or an http(s) URL, got {v!r}")


def embedding_model() -> str | None:
    """Returns where the embedding model runs ("local", a URL or None)."""
    return parse_model_setting(os.environ.get(EMBEDDING_ENV))


def decision_model() -> str | None:
    """Returns where the decision model runs ("local", a URL or None)."""
    return parse_model_setting(os.environ.get(DECISION_ENV))


def require_embedding() -> str:
    """Returns the embedding model setting.

    Raises:
        ModelUnavailable: If this process was started without an embedding model.
    """
    m = embedding_model()
    if m is None:
        raise ModelUnavailable("no embedding model (start with --embedding-model local or --embedding-model URL)")
    return m


def require_decision() -> str:
    """Returns the decision model setting.

    Raises:
        ModelUnavailable: If this process was started without a decision model.
    """
    m = decision_model()
    if m is None:
        raise ModelUnavailable("no decision model (start with --decision-model local or --decision-model URL)")
    return m


def data_dir() -> Path:
    """Returns the data dir (`PHOTOLIB_DATA_DIR`, default `./data`), resolved at call time.

    It is the base folder for everything photolib stores: `config.json` (which catalog is current) and
    one index folder per catalog under `catalogs/`.
    """
    env = os.environ.get("PHOTOLIB_DATA_DIR")
    return Path(env).expanduser().resolve() if env else (_BASE / "data").resolve()


def catalog_key(catalog: str) -> str:
    """Returns the name of a catalog's index folder: the photo folder's name plus a hash of its full path.

    Args:
        catalog: The photo folder's absolute path, as stored in `config.json`.
    """
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(catalog).name).strip("-.") or "catalog"
    return f"{name}-{hashlib.sha1(catalog.encode('utf-8')).hexdigest()[:10]}"


def index_dir() -> Path:
    """Returns the current catalog's index folder (`<data dir>/catalogs/<key>`), which may not exist yet.

    The key comes from the photo folder stored in `config.json`, not from `PHOTOLIB_CATALOG_DIR`, so an
    index that was copied to another machine is still found there.
    """
    stored = load_config().get("catalog_dir")
    d = data_dir() / "catalogs" / (catalog_key(stored) if stored else "_none")
    legacy = data_dir() / "photolib.db"
    if stored and legacy.exists() and not (d / "photolib.db").exists():
        # A data dir from before per-catalog index folders: move its single index into place.
        d.mkdir(parents=True, exist_ok=True)
        for name in (*_DB_FILES, "thumbs"):
            if (data_dir() / name).exists():
                shutil.move(data_dir() / name, d / name)
    return d


def model_dir() -> Path:
    """Returns the EmbeddingGemma weights dir (`PHOTOLIB_MODEL_DIR`, default `models/embeddinggemma-2`)."""
    env = os.environ.get("PHOTOLIB_MODEL_DIR")
    return Path(env).expanduser().resolve() if env else (_BASE / "models" / "embeddinggemma-2").resolve()


def tagger_dir() -> Path:
    """Returns the d1-3B weights dir (`PHOTOLIB_TAGGER_DIR`, default `models/d1-3B`)."""
    env = os.environ.get("PHOTOLIB_TAGGER_DIR")
    return Path(env).expanduser().resolve() if env else (_BASE / "models" / "d1-3B").resolve()


def frontend_dist() -> Path:
    """Returns the built web UI dir (`PHOTOLIB_FRONTEND_DIST`, default `frontend/dist`).

    The override lets you test a build without replacing the one a running server is serving.
    """
    env = os.environ.get("PHOTOLIB_FRONTEND_DIST")
    return Path(env).expanduser().resolve() if env else _BASE / "frontend" / "dist"


def db_path() -> Path:
    """Returns the path of the current catalog's SQLite file."""
    return index_dir() / "photolib.db"


def thumbs_dir() -> Path:
    """Returns the current catalog's thumbnail dir."""
    return index_dir() / "thumbs"


def config_path() -> Path:
    """Returns the path of `config.json` inside the data dir."""
    return data_dir() / "config.json"


def load_config() -> dict:
    """Reads `config.json`.

    Returns:
        The stored config, or an empty dict when the file is missing or unreadable.
    """
    p = config_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(cfg: dict) -> None:
    """Writes `config.json` atomically (temp file, then rename), creating the data dir if needed.

    Args:
        cfg: The whole config to store.
    """
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(p)


def catalog_dir() -> Path | None:
    """Returns the catalog (photo) folder, or None when no catalog is set.

    `PHOTOLIB_CATALOG_DIR` overrides the folder stored in `config.json`, so a data dir that was indexed
    on one machine can be served from another where the photos live at a different path.
    """
    c = os.environ.get("PHOTOLIB_CATALOG_DIR") or load_config().get("catalog_dir")
    return Path(c) if c else None


def set_catalog(catalog: Path) -> None:
    """Makes a photo folder the current catalog. Its index (if it has one) is picked up as it is.

    Args:
        catalog: The photo folder; stored as an absolute path.
    """
    save_config({**load_config(), "catalog_dir": str(Path(catalog).expanduser().resolve())})


def purge_index() -> None:
    """Deletes the current catalog's index (db, thumbs). Other catalogs and the photos are not touched.

    Only known items are removed, so pointing PHOTOLIB_DATA_DIR at a shared folder can't wipe unrelated files.
    """
    d = index_dir()
    for name in _DB_FILES:
        (d / name).unlink(missing_ok=True)
    shutil.rmtree(d / "thumbs", ignore_errors=True)
    if d.is_dir() and not any(d.iterdir()):
        d.rmdir()


def purge_catalog() -> None:
    """Deletes the current catalog's index and forgets which catalog is current."""
    purge_index()
    config_path().unlink(missing_ok=True)
