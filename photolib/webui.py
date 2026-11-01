"""Builds the web UI (`frontend/`) with npm when its build is missing or older than its sources."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from . import config

# What `npm run build` reads; anything else in frontend/ (dist, node_modules, mock, scripts) doesn't
# change the build.
_SOURCES = ("src", "public", "index.html", "package.json", "package-lock.json", "vite.config.ts")


def frontend_dir() -> Path | None:
    """Returns the web UI's source folder, or None when `serve` shouldn't build it.

    That's the case when `PHOTOLIB_FRONTEND_DIST` points at a build made elsewhere, or when there is no
    source checkout next to the default build folder.
    """
    if os.environ.get("PHOTOLIB_FRONTEND_DIST"):
        return None
    src = config.frontend_dist().parent
    return src if (src / "package.json").is_file() else None


def _newest_mtime(paths: list[Path]) -> float:
    """Returns the newest modification time among the given files and the files below the given dirs."""
    newest = 0.0
    for p in paths:
        if p.is_dir():
            for f in p.rglob("*"):
                if f.is_file():
                    newest = max(newest, f.stat().st_mtime)
        elif p.is_file():
            newest = max(newest, p.stat().st_mtime)
    return newest


def needs_build(src: Path) -> bool:
    """Returns True when `<src>/dist` is missing or older than a source file (see `_SOURCES`).

    Args:
        src: The web UI's source folder.
    """
    index = src / "dist" / "index.html"
    if not index.is_file():
        return True
    sources = [src / name for name in _SOURCES] + sorted(src.glob("tsconfig*.json"))
    return _newest_mtime(sources) > index.stat().st_mtime


def needs_install(src: Path) -> bool:
    """Returns True when `node_modules` is missing or older than `package-lock.json`.

    npm writes `node_modules/.package-lock.json` on every install, so its time is the last install.

    Args:
        src: The web UI's source folder.
    """
    installed = src / "node_modules" / ".package-lock.json"
    lock = src / "package-lock.json"
    if not installed.is_file():
        return True
    return lock.is_file() and lock.stat().st_mtime > installed.stat().st_mtime


def build(src: Path) -> None:
    """Installs the npm dependencies if needed (`npm ci`), then runs `npm run build`.

    npm's output goes straight to the terminal.

    Args:
        src: The web UI's source folder.

    Raises:
        FileNotFoundError: If npm is not installed.
        subprocess.CalledProcessError: If `npm ci` or the build fails.
    """
    npm = shutil.which("npm")
    if npm is None:
        raise FileNotFoundError("npm not found")
    if needs_install(src):
        subprocess.run([npm, "ci"], cwd=src, check=True)
    subprocess.run([npm, "run", "build"], cwd=src, check=True)
