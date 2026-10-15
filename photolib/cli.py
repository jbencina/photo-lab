"""`photolib` command line (Typer)."""

from __future__ import annotations

import os
import time
from pathlib import Path

import typer
from rich.console import Console
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeElapsedColumn
from rich.table import Table

from . import config

app = typer.Typer(
    help="photo-lib: local photo catalog with EmbeddingGemma 2 search and d1-3B subject tags.", no_args_is_help=True
)
catalog_app = typer.Typer(help="Show or switch the catalog folder.", no_args_is_help=True)
app.add_typer(catalog_app, name="catalog")
console = Console()

_MODEL_HELP = (
    "'local' runs it on this machine, a URL calls it on another machine, "
    "omitted means the features that need it are off."
)


def _embedding_option():
    return typer.Option(
        None, "--embedding-model", envvar=config.EMBEDDING_ENV, metavar="local|URL",
        help=f"Where EmbeddingGemma 2 runs: {_MODEL_HELP}",
    )


def _decision_option():
    return typer.Option(
        None, "--decision-model", envvar=config.DECISION_ENV, metavar="local|URL",
        help=f"Where d1-3B runs: {_MODEL_HELP}",
    )


def _use_models(embedding_model: str | None, decision_model: str | None) -> None:
    """Record where the models run for this process (and the uvicorn workers it starts)."""
    for flag, env, value in (
        ("--embedding-model", config.EMBEDDING_ENV, embedding_model),
        ("--decision-model", config.DECISION_ENV, decision_model),
    ):
        if value is None:
            continue
        try:
            setting = config.parse_model_setting(value)
        except ValueError as e:
            raise typer.BadParameter(str(e), param_hint=flag) from None
        if setting is None:
            os.environ.pop(env, None)
        else:
            os.environ[env] = setting
    if "local" in (config.embedding_model(), config.decision_model()):
        import importlib.util

        if importlib.util.find_spec("torch") is None:
            console.print(
                "[red]Running a model locally needs the `local` extra.[/] Install it with "
                "[bold]uv sync --extra local[/], or pass a URL instead of `local`."
            )
            raise typer.Exit(1)


@app.callback()
def _main(
    embedding_model: str | None = _embedding_option(),
    decision_model: str | None = _decision_option(),
    data_dir: Path | None = typer.Option(
        None, "--data-dir", envvar="PHOTOLIB_DATA_DIR", metavar="DIR",
        help="Where the index, thumbnails and config live (default ./data).",
    ),
    catalog_dir: Path | None = typer.Option(
        None, "--catalog-dir", envvar="PHOTOLIB_CATALOG_DIR", metavar="DIR",
        help="Photo folder to use instead of the one stored in the data dir (serving an index built elsewhere).",
    ),
):
    # Stored in the env vars `config` reads, so the uvicorn workers `serve` starts see them too.
    if data_dir is not None:
        os.environ["PHOTOLIB_DATA_DIR"] = str(data_dir.expanduser().resolve())
    if catalog_dir is not None:
        os.environ["PHOTOLIB_CATALOG_DIR"] = str(catalog_dir.expanduser().resolve())
    _use_models(embedding_model, decision_model)


def _need(embedding: bool = False, decision: bool = False) -> bool:
    """False (after printing why) when a command needs a model this run was started without."""
    ok = True
    if embedding and config.embedding_model() is None:
        console.print("[red]No embedding model.[/] Add [bold]--embedding-model local[/] (or a URL).")
        ok = False
    if decision and config.decision_model() is None:
        console.print("[red]No decision model.[/] Add [bold]--decision-model local[/] (or a URL).")
        ok = False
    return ok


def _human(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    f = n / 1024
    for unit in ("KB", "MB"):
        if f < 1024:
            return f"{f:.1f} {unit}"
        f /= 1024
    return f"{f:.1f} GB"


def _fmt_secs(sec: float | None) -> str:
    if sec is None:
        return ""
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h {m:02d}m" if h else (f"{m}m {s:02d}s" if m else f"{s}s")


def _schema_ok() -> bool:
    """Print a clear message (instead of a traceback) when the DB needs a rebuild."""
    from . import db

    try:
        db.check_schema()
    except db.SchemaError as e:
        console.print(f"[red]Index needs a rebuild:[/] {e}")
        return False
    return True


PHASE_LABELS = {"embedding": "Embedding", "tagging": "Tagging (d1)", "propagating": "Propagating (d1)"}


def _run_job(job, interrupted_hint: str) -> int:
    """Run an indexer job (refresh, tag or propagate) with per-phase progress bars and a throughput summary."""
    t0 = time.time()
    steady: dict[str, float] = {}  # last sliding-window rate seen per phase
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TextColumn("{task.fields[rate]}"),
        TextColumn("{task.fields[eta]}"),
        TimeElapsedColumn(),
        TextColumn("[dim]{task.fields[current]}"),
        console=console,
        transient=False,
    ) as prog:
        tasks: dict[str, int] = {}

        def cb(p: dict):
            if not p["running"]:  # finished / failed / interrupted: no ETA or current file any more
                for tid in tasks.values():
                    prog.update(tid, eta="", current="")
            phase = p.get("phase")
            if phase not in PHASE_LABELS or (p["total"] == 0 and phase not in tasks):
                return
            if phase not in tasks:
                for tid in tasks.values():  # previous phase finished: drop its ETA / current file
                    prog.update(tid, eta="", current="")
                tasks[phase] = prog.add_task(PHASE_LABELS[phase], total=p["total"], rate="", eta="", current="")
            if p.get("rate"):
                steady[phase] = p["rate"]
            prog.update(
                tasks[phase],
                total=p["total"],
                completed=p["done"],
                rate=f"{steady[phase]:.2f} img/s" if phase in steady else "",
                eta=f"ETA {_fmt_secs(p['eta_seconds'])}" if p.get("eta_seconds") is not None and p["running"] else "",
                current=(p["current"] or "") if p["running"] else "",
            )

        try:
            result = job(cb)
        except KeyboardInterrupt:
            prog.stop()
            console.print(f"[yellow]Interrupted.[/] Work committed so far is kept. {interrupted_hint}")
            return 130
    dt = time.time() - t0

    def phase_line(name: str, n: int, secs: float | None) -> str:
        if not n:
            return f"{name}: nothing to do"
        line = f"{name}: {n} in {secs or 0:.1f}s ({n / secs if secs else 0:.2f} img/s incl. model load"
        key = "embedding" if name.startswith("embed") else "tagging"
        return line + (f", steady {steady[key]:.2f} img/s)" if key in steady else ")")

    if result["mode"] == "propagate":
        n, secs = result["total"], result["propagate_seconds"]
        names = ", ".join(result["labels"])
        if not n:
            console.print(f"[green]No candidate photos[/] for {names} (nothing for d1 to check).")
        else:
            rate = f", steady {steady['propagating']:.2f} img/s" if "propagating" in steady else ""
            console.print(
                f"{names}: {n} candidate photo(s) checked in {secs or 0:.1f}s (incl. model load{rate}); "
                f"[green]{result['propagate_added']} tag(s) added[/]"
                + (f" / {result['tag_failed']} failed" if result["tag_failed"] else "")
                + f"  [dim]({dt:.1f}s total)[/]"
            )
        for f in result["failures"]:
            console.print(f"  [red]failed:[/] {f}")
        if result["error"]:
            console.print(f"[red]Error:[/] {result['error']}")
            return 1
        return 0
    if result["mode"] == "refresh":
        console.print(
            f"[green]{result['added']} new[/] / {result['skipped']} skipped / "
            f"{result['failed']} failed / {result['missing']} missing on disk"
            + (f" / {result['pruned']} pruned" if result["pruned"] else "")
        )
        console.print("  " + phase_line("embedding", result["embed_total"], result["embed_seconds"]))
    if result["mode"] != "refresh" or not result["skip_tags"]:
        console.print("  " + phase_line("tagging", result["tag_done"], result["tag_seconds"]))
    console.print(
        f"[green]{result['tagged']} tagged[/] / {result['untagged']} untagged"
        + (f" / {result['tag_failed']} failed to tag" if result["tag_failed"] else "")
        + f"  [dim]({dt:.1f}s total)[/]"
    )
    for f in result["failures"]:
        console.print(f"  [red]failed:[/] {f}")
    if result["missing"] and result["mode"] == "refresh" and not result["pruned"]:
        console.print("[yellow]Some indexed files are missing on disk; run with --prune to remove them.[/]")
    if result["mode"] == "refresh" and result["skip_tags"] and result["untagged"]:
        console.print("[dim]Tagging skipped; run `photolib tag` to add subjects.[/]")
    if result["error"]:
        console.print(f"[red]Error:[/] {result['error']}")
        return 1
    return 0


def _run_refresh(prune: bool, skip_tags: bool = False) -> int:
    from . import indexer

    cat = config.catalog_dir()
    if not cat:
        console.print("[red]No catalog configured.[/] Run [bold]photolib catalog set <dir>[/].")
        return 1
    if not _schema_ok():
        return 1
    console.print(f"Catalog: [bold]{cat}[/]")
    return _run_job(
        lambda cb: indexer.refresh(cat, prune=prune, skip_tags=skip_tags, progress_cb=cb),
        "Run `photolib refresh` (or `photolib tag`) again to resume.",
    )


@catalog_app.command("set")
def catalog_set(
    directory: Path = typer.Argument(..., help="Folder of JPEGs (searched recursively)."),
    rebuild: bool = typer.Option(False, "--rebuild", help="Delete this folder's index first and build it from scratch."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Don't ask for confirmation (with --rebuild)."),
    embedding_model: str | None = _embedding_option(),
    decision_model: str | None = _decision_option(),
):
    """Make a folder the current catalog and index what is new in it. Other catalogs keep their index."""
    _use_models(embedding_model, decision_model)
    if not _need(embedding=True):  # before anything changes: a catalog can't be indexed without it
        raise typer.Exit(1)
    directory = directory.expanduser().resolve()
    if not directory.is_dir():
        console.print(f"[red]Not a directory:[/] {directory}")
        raise typer.Exit(1)
    if rebuild and not yes:
        typer.confirm(f"This deletes the index, thumbnails, likes and tags of {directory}. Continue?", abort=True)
    config.set_catalog(directory)
    if rebuild:
        config.purge_index()
    console.print(f"Catalog set to [bold]{directory}[/] (index in {config.index_dir()})")
    raise typer.Exit(_run_refresh(prune=False))


@catalog_app.command("show")
def catalog_show():
    """Print catalog dir, counts and data dir."""
    from . import db, search

    cat = config.catalog_dir()
    console.print(f"Catalog dir : {cat or '[yellow](not set)[/]'}")
    console.print(f"Data dir    : {config.data_dir()}")
    if cat:
        console.print(f"Index dir   : {config.index_dir()}")
    if config.db_path().exists():
        if not _schema_ok():
            raise typer.Exit(1)
        conn = db.connect()
        try:
            s = search.stats(conn)
        finally:
            conn.close()
        console.print(f"Images      : {s['image_count']}  (liked {s['liked_count']}, subjects {s['subject_count']})")
        console.print(f"Tagged      : {s['tagged_count']}  (untagged {s['untagged_count']})")


@app.command()
def refresh(
    prune: bool = typer.Option(False, "--prune", help="Delete index rows whose files are gone."),
    skip_tags: bool = typer.Option(False, "--skip-tags", help="Only the embed pass; tag later with `photolib tag`."),
    embedding_model: str | None = _embedding_option(),
    decision_model: str | None = _decision_option(),
):
    """Index new JPEGs (embed pass), then tag untagged photos with d1-3B (tag pass). Both are resumable.

    Needs --embedding-model; without --decision-model only the embed pass runs.
    """
    _use_models(embedding_model, decision_model)
    if not _need(embedding=True):
        raise typer.Exit(1)
    if not skip_tags and config.decision_model() is None:
        console.print("[dim]No --decision-model: embedding only, photos stay untagged.[/]")
    raise typer.Exit(_run_refresh(prune, skip_tags))


@app.command()
def tag(
    retag: bool = typer.Option(False, "--retag", help="Re-tag every photo (use after editing photolib/labels.py)."),
    limit: int | None = typer.Option(None, "--limit", min=1, help="Tag at most N photos this run."),
    labels: str | None = typer.Option(
        None,
        "--labels",
        help='Propagate only these labels (comma-separated, e.g. "osprey,heron"): d1 checks the photos where '
        "each one is an EmbeddingGemma top-20 candidate and adds it where confirmed. Missing labels are created.",
    ),
    embedding_model: str | None = _embedding_option(),
    decision_model: str | None = _decision_option(),
):
    """Run only the tag pass: hybrid EmbeddingGemma top-20 -> d1-3B subjects for untagged photos.

    With --labels, run the per-label propagation instead (other tags and photos are left untouched).
    """
    from . import indexer

    _use_models(embedding_model, decision_model)
    if not _need(embedding=True, decision=True):
        raise typer.Exit(1)
    if not config.catalog_dir():
        console.print("[red]No catalog configured.[/] Run [bold]photolib catalog set <dir>[/].")
        raise typer.Exit(1)
    if not config.db_path().exists():
        console.print("[red]Nothing indexed yet.[/] Run [bold]photolib refresh[/] first.")
        raise typer.Exit(1)
    if not _schema_ok():
        raise typer.Exit(1)
    if labels is not None:
        if retag or limit is not None:
            console.print("[red]--labels can't be combined with --retag / --limit.[/]")
            raise typer.Exit(1)
        raise typer.Exit(_run_propagate(labels))
    hint = "Run `photolib tag` again to resume" + (" (no need for --retag)." if retag else ".")
    raise typer.Exit(_run_job(lambda cb: indexer.tag(retag=retag, limit=limit, progress_cb=cb), hint))


def _run_propagate(spec: str) -> int:
    from . import db, indexer
    from .labels import LabelError, normalize_label

    try:
        names = list(dict.fromkeys(normalize_label(part) for part in spec.split(",") if part.strip()))
    except LabelError as e:
        console.print(f"[red]Bad label:[/] {e}")
        return 1
    if not names:
        console.print("[red]--labels needs at least one label.[/]")
        return 1
    conn = db.connect()
    try:
        with conn:
            created = [lb for lb in names if db.create_label(conn, lb)]
    finally:
        conn.close()
    if created:
        console.print(f"Created label(s): [bold]{', '.join(created)}[/]")
    return _run_job(
        lambda cb: indexer.propagate(names, progress_cb=cb),
        "Tags confirmed so far are kept; run the same command again to check the remaining photos.",
    )


@app.command("labels")
def labels_cmd(
    user: bool = typer.Option(False, "--user", help="Only labels you created."),
    used: bool = typer.Option(False, "--used", help="Only labels that are on at least one photo."),
    remove: str | None = typer.Option(
        None, "--remove", help="Delete a label you created (or a builtin no longer in labels.py) and its tags."
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Don't ask for confirmation (with --remove)."),
):
    """List the tag vocabulary (builtin + your own labels) with photo counts and source."""
    from . import db, tags
    from .labels import VOCABULARY, try_normalize

    if not config.db_path().exists():
        console.print("[red]Nothing indexed yet.[/] Run [bold]photolib catalog set <dir>[/] first.")
        raise typer.Exit(1)
    if not _schema_ok():
        raise typer.Exit(1)
    conn = db.connect()
    try:
        if remove is not None:
            name = try_normalize(remove) or remove
            row = db.get_label(conn, name)
            if row is None:
                console.print(f"[red]No such label:[/] {name}")
                raise typer.Exit(1)
            if name in VOCABULARY:
                console.print(
                    f"[red]'{name}' is a builtin label.[/] Delete it from photolib/labels.py first "
                    "(the seed would re-create it)."
                )
                raise typer.Exit(1)
            n = db.label_counts(conn).get(name, (0, 0))[0]
            if not yes:
                typer.confirm(f"Delete label '{name}' and remove it from {n} photo(s)?", abort=True)
            with conn:
                db.delete_label(conn, name)
            console.print(f"Deleted label [bold]{name}[/] (removed from {n} photo(s)).")
            return
        rows = tags.list_labels(conn)
    finally:
        conn.close()
    shown = [r for r in rows if (not user or r["source"] == "user") and (not used or r["count"])]
    t = Table(box=None, header_style="bold")
    for col, justify in (("Label", "left"), ("Source", "left"), ("Category", "left"), ("Photos", "right"), ("Manual", "right"), ("Question", "left")):
        t.add_column(col, justify=justify, no_wrap=True, overflow="ellipsis")  # type: ignore[arg-type]
    for r in shown:
        t.add_row(
            r["label"],
            "[cyan]user[/]" if r["source"] == "user" else "builtin",
            r["category"] or "",
            str(r["count"]) if r["count"] else "[dim]0[/]",
            str(r["manual_count"]) if r["manual_count"] else "",
            f"[dim]{r['question']}[/]" if r["question"] else "",
        )
    console.print(t)
    n_user = sum(r["source"] == "user" for r in rows)
    console.print(f"[dim]{len(rows)} labels ({len(rows) - n_user} builtin, {n_user} user); {len(shown)} shown[/]")


@app.command()
def status(
    embedding_model: str | None = _embedding_option(),
    decision_model: str | None = _decision_option(),
):
    """Counts (incl. tagged/untagged), model + tagger info, db size."""
    from . import db, search

    _use_models(embedding_model, decision_model)
    from .labels import VOCABULARY

    n_labels, n_user = len(VOCABULARY), 0
    cat = config.catalog_dir()
    t = Table(show_header=False, box=None)
    t.add_row("Catalog dir", str(cat) if cat else "(not set)")
    t.add_row("Data dir", str(config.data_dir()))
    if config.db_path().exists():
        try:
            conn = db.connect()
        except db.SchemaError as e:
            t.add_row("DB", f"[red]needs a rebuild[/]: {e}")
        else:
            try:
                s = search.stats(conn)
                n_labels, n_user = db.vocabulary_size(conn)
            finally:
                conn.close()
            t.add_row("Images", str(s["image_count"]))
            t.add_row("Tagged", f"{s['tagged_count']}  (untagged {s['untagged_count']})")
            t.add_row("Liked", str(s["liked_count"]))
            t.add_row("Subjects in use", str(s["subject_count"]))
            t.add_row("DB size", _human(s["db_size_bytes"]))
    else:
        t.add_row("DB", "(not created)")
    def where(setting: str | None, local_dir: Path) -> str:
        if setting is None:
            return "[yellow]not available[/] (flag omitted)"
        return f"local ({local_dir})" if setting == "local" else f"remote ({setting})"

    emb, dec = config.embedding_model(), config.decision_model()
    t.add_row("Embedding model", f"{config.MODEL_NAME}: {where(emb, config.model_dir())}")
    t.add_row("Decision model", f"{config.TAGGER_NAME}: {where(dec, config.tagger_dir())}, {n_labels} labels"
              + (f" ({n_user} yours)" if n_user else "") + f", keep P >= {config.TAG_THRESHOLD}")
    if "local" in (emb, dec):
        import torch

        from .embedder import torch_device

        dev, dtype = torch_device()
        name = f"cuda: {torch.cuda.get_device_name(0)}" if dev == "cuda" else dev
        t.add_row("Local device", f"{name} ({str(dtype).removeprefix('torch.')})")
    t.add_row("Embedding dim", str(config.EMBED_DIM))
    console.print(t)


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", help="Bind address."),
    port: int = typer.Option(8000, help="Port."),
    reload: bool = typer.Option(False, "--reload", help="Auto-reload on code changes (dev)."),
    warmup: bool = typer.Option(True, "--warmup/--no-warmup", help="Load the model in the background at startup."),
    embedding_model: str | None = _embedding_option(),
    decision_model: str | None = _decision_option(),
):
    """Run the API + web UI. Without --embedding-model / --decision-model the UI hides what needs them."""
    import socket

    import uvicorn

    _use_models(embedding_model, decision_model)
    for name, setting in (("Embedding model", config.embedding_model()), ("Decision model", config.decision_model())):
        console.print(f"{name}: " + ("[yellow]not available[/]" if setting is None else f"[bold]{setting}[/]"))

    if not (config.frontend_dist() / "index.html").is_file():
        console.print(
            "[yellow]Web UI not built:[/] run [bold]cd frontend && npm install && npm run build[/] "
            "(the API still works under /api)."
        )
    lan = None
    try:  # best-effort LAN address (no packets are sent for a UDP connect)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            lan = s.getsockname()[0]
    except OSError:
        pass
    if host in ("0.0.0.0", "::"):
        console.print(f"photo-lib on [bold]http://localhost:{port}[/]" + (f"  ·  LAN: [bold]http://{lan}:{port}[/]" if lan else ""))
    if warmup:
        os.environ["PHOTOLIB_WARMUP"] = "1"
    uvicorn.run("photolib.api:app", host=host, port=port, reload=reload)


@app.command()
def purge(yes: bool = typer.Option(False, "--yes", "-y", help="Don't ask for confirmation.")):
    """Delete the current catalog's index (db, thumbs) and unset the catalog. Your photos are never touched."""
    cat = config.catalog_dir()
    if not cat:
        console.print("No catalog set, nothing to purge.")
        return
    if not yes:
        typer.confirm(f"Delete the index, thumbnails, likes and tags of {cat} ({config.index_dir()})?", abort=True)
    config.purge_catalog()
    console.print(f"Purged the index of {cat}")


if __name__ == "__main__":
    app()
