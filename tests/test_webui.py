"""When `serve` rebuilds the web UI: missing or stale build, missing or stale node_modules."""

import os

from photolib import webui


def _touch(path, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x")
    os.utime(path, (mtime, mtime))


def test_needs_build_when_dist_is_missing_or_older_than_a_source(tmp_path):
    _touch(tmp_path / "src" / "App.tsx", 100)
    assert webui.needs_build(tmp_path)

    _touch(tmp_path / "dist" / "index.html", 200)
    assert not webui.needs_build(tmp_path)

    _touch(tmp_path / "src" / "components" / "Grid.tsx", 300)
    assert webui.needs_build(tmp_path)


def test_needs_build_ignores_files_the_build_does_not_read(tmp_path):
    _touch(tmp_path / "dist" / "index.html", 200)
    _touch(tmp_path / "node_modules" / "x" / "index.js", 300)
    _touch(tmp_path / "scripts" / "shot.mjs", 300)
    assert not webui.needs_build(tmp_path)

    _touch(tmp_path / "tsconfig.app.json", 300)
    assert webui.needs_build(tmp_path)


def test_needs_install_when_node_modules_is_missing_or_older_than_the_lockfile(tmp_path):
    _touch(tmp_path / "package-lock.json", 100)
    assert webui.needs_install(tmp_path)

    _touch(tmp_path / "node_modules" / ".package-lock.json", 200)
    assert not webui.needs_install(tmp_path)

    _touch(tmp_path / "package-lock.json", 300)
    assert webui.needs_install(tmp_path)


def test_no_auto_build_for_a_build_from_elsewhere(monkeypatch, tmp_path):
    monkeypatch.setenv("PHOTOLIB_FRONTEND_DIST", str(tmp_path))
    assert webui.frontend_dir() is None


def test_serve_builds_a_stale_ui_and_still_starts_without_npm(monkeypatch, tmp_path):
    import uvicorn
    from typer.testing import CliRunner

    from photolib import cli

    monkeypatch.delenv("PHOTOLIB_EMBEDDING_MODEL")  # no models, so no torch needed
    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")
    monkeypatch.setenv("PHOTOLIB_FRONTEND_DIST", str(tmp_path / "dist"))
    monkeypatch.setattr(webui, "frontend_dir", lambda: tmp_path)
    monkeypatch.setattr(webui, "needs_build", lambda src: True)
    builds, runs = [], []

    def no_npm(src):
        builds.append(src)
        raise FileNotFoundError("npm not found")

    monkeypatch.setattr(webui, "build", no_npm)
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: runs.append(a))

    r = CliRunner().invoke(cli.app, ["serve", "--no-warmup"])
    assert r.exit_code == 0, r.output
    assert builds == [tmp_path] and len(runs) == 1
    assert "npm not found" in r.output and "Web UI not built" in r.output

    builds.clear()
    r = CliRunner().invoke(cli.app, ["serve", "--no-warmup", "--no-build-ui"])
    assert r.exit_code == 0, r.output
    assert builds == [] and len(runs) == 2
