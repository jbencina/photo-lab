"""Scans a catalog folder and indexes it in two resumable passes.

1. **Embed pass** (new files only): hash, EXIF, thumbnail, palette and the EmbeddingGemma vector, committed
   per batch of 8. `rel_path` (posix path relative to the catalog root) is the primary key; existing rows are
   never re-embedded. Files missing on disk are reported and only deleted with prune=True.
2. **Tag pass** (`images WHERE tagged_at IS NULL`, ordered by rel_path): hybrid EG top-20 -> d1-3B subjects
   (subjects.py), committed per image, so Ctrl-C / a crash simply resumes on the next run. d1 is unloaded when
   the pass ends so the server doesn't hold ~6 GB of VRAM idle.

`refresh()` runs both (`skip_tags=True` -> pass 1 only); `tag()` runs pass 2 only (`retag=True` first marks
every image untagged, e.g. after editing labels.py). One run at a time per process (`_RUN_LOCK`).

`propagate(labels)` is the per-label job: for each photo where one of `labels` is an EG top-20
candidate and not yet present (tags.propagation_candidates), d1 answers just those questions; P >= 0.8 adds
a 'd1' subject row. It never touches other labels' rows or `tagged_at`, commits per photo, and unloads d1.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
import traceback
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from PIL import Image, ImageOps

from . import colors, config, db, exif
from .remote import RemoteModelError


def thumb_name(rel_path: str) -> str:
    """Returns the thumbnail file name of an image: the SHA-1 of its relative path, `.webp`."""
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest() + ".webp"


def thumb_path(rel_path: str) -> Path:
    """Returns where an image's thumbnail lives inside the data dir."""
    return config.thumbs_dir() / thumb_name(rel_path)


# --------------------------------------------------------------------------- progress state


RATE_WINDOW_S = 30.0  # sliding window for img/s


@dataclass
class IndexProgress:
    """State of the current (or last) indexing run, as the API reports it.

    Attributes:
        running: Whether a run is active.
        mode: 'refresh', 'tag', 'retag' or 'propagate'.
        phase: 'scanning', 'embedding', 'tagging', 'propagating' or 'done' (None = never ran).
        done: Photos finished in the current phase.
        total: Photos in the current phase.
        current: The file (or step) being worked on.
        started_at: ISO timestamp of the start of the run.
        finished_at: ISO timestamp of the end of the run.
        error: Why the run stopped, when it failed or was interrupted.
        interrupted: Whether the run was stopped with Ctrl-C.
        added: Photos added by the embed pass.
        skipped: Files that were already indexed.
        failed: Files the embed pass could not read.
        missing: Indexed files that are no longer on disk.
        pruned: Rows deleted for missing files.
        failures: Up to 50 per-file error messages.
        embed_done: Photos the embed pass has processed.
        embed_total: Photos the embed pass has to process.
        embed_seconds: Wall time of the embed pass.
        skip_tags: Whether the tag pass is skipped in this run.
        tag_done: Photos the tag pass has processed.
        tag_total: Photos the tag pass has to process.
        tag_failed: Photos the tag (or propagate) pass could not process.
        tag_seconds: Wall time of the tag pass.
        tagged: Images with `tagged_at` set (live DB count).
        untagged: Images without `tagged_at` (live DB count).
        labels: The labels of a propagate job (its done/total count candidate photos).
        propagate_added: Photo/label pairs d1 confirmed.
        propagate_seconds: Wall time of the propagate job.
        rate: Photos per second over the last `RATE_WINDOW_S` seconds of the current phase.
        eta_seconds: Estimated time left in the current phase.
    """

    running: bool = False
    mode: str | None = None
    phase: str | None = None
    done: int = 0
    total: int = 0
    current: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    interrupted: bool = False
    # embed pass
    added: int = 0
    skipped: int = 0
    failed: int = 0
    missing: int = 0
    pruned: int = 0
    failures: list[str] = field(default_factory=list)
    embed_done: int = 0
    embed_total: int = 0
    embed_seconds: float | None = None
    # tag pass
    skip_tags: bool = False
    tag_done: int = 0
    tag_total: int = 0
    tag_failed: int = 0
    tag_seconds: float | None = None
    tagged: int = 0
    untagged: int = 0
    # propagate job
    labels: list[str] = field(default_factory=list)
    propagate_added: int = 0
    propagate_seconds: float | None = None
    # current phase speed
    rate: float | None = None
    eta_seconds: float | None = None


class ProgressState:
    """Thread-safe progress shared between the indexing thread and the API."""

    def __init__(self) -> None:
        """Creates an idle progress state."""
        self._lock = threading.Lock()
        self._p = IndexProgress()
        self._samples: deque[tuple[float, int]] = deque()

    def reset(self, **kw) -> None:
        """Replaces the state with a fresh `IndexProgress` built from the given fields."""
        with self._lock:
            self._p = IndexProgress(**kw)
            self._samples.clear()

    def update(self, **kw) -> None:
        """Sets the given `IndexProgress` fields."""
        with self._lock:
            for k, v in kw.items():
                setattr(self._p, k, v)

    def incr(self, name: str, n: int = 1) -> None:
        """Adds `n` to the counter `name`."""
        with self._lock:
            setattr(self._p, name, getattr(self._p, name) + n)

    def add_failure(self, msg: str, counter: str = "failed") -> None:
        """Counts one failed file and keeps its message (the first 50 are kept).

        Args:
            msg: What failed and why.
            counter: The counter to increase ("failed" or "tag_failed").
        """
        with self._lock:
            setattr(self._p, counter, getattr(self._p, counter) + 1)
            if len(self._p.failures) < 50:
                self._p.failures.append(msg)

    def start_phase(self, phase: str, total: int, **kw) -> None:
        """Switches to a new phase and resets its counters, rate and ETA.

        Args:
            phase: The new phase name.
            total: Photos the phase has to process.
            **kw: Other `IndexProgress` fields to set at the same time.
        """
        with self._lock:
            self._p.phase = phase
            self._p.done = 0
            self._p.total = total
            self._p.rate = None
            self._p.eta_seconds = None
            for k, v in kw.items():
                setattr(self._p, k, v)
            self._samples.clear()

    def mark_ready(self) -> None:
        """Starts the rate clock (call after models are loaded so load time doesn't skew img/s)."""
        with self._lock:
            self._samples.clear()
            self._samples.append((time.monotonic(), self._p.done))

    def advance(self, n: int = 1, **incr: int) -> None:
        """Records finished photos in the current phase, then refreshes rate and ETA.

        Args:
            n: Photos finished since the last call.
            **incr: Other counters to increase, by name.
        """
        now = time.monotonic()
        with self._lock:
            p = self._p
            p.done += n
            for k, v in incr.items():
                setattr(p, k, getattr(p, k) + v)
            s = self._samples
            if not s:
                s.append((now, p.done - n))
            s.append((now, p.done))
            while len(s) > 2 and now - s[1][0] > RATE_WINDOW_S:
                s.popleft()
            dt = s[-1][0] - s[0][0]
            if dt > 0:
                p.rate = round((s[-1][1] - s[0][1]) / dt, 3)
                p.eta_seconds = round(max(0, p.total - p.done) / p.rate, 1) if p.rate > 0 else None

    def snapshot(self) -> dict:
        """Returns a copy of the state as a plain dict (the API's progress object)."""
        with self._lock:
            d = asdict(self._p)
        return d


PROGRESS = ProgressState()
_RUN_LOCK = threading.Lock()


def is_running() -> bool:
    """Returns True while an indexing run is active in this process."""
    return _RUN_LOCK.locked()


# --------------------------------------------------------------------------- scanning


def scan(catalog: Path) -> list[str]:
    """Finds the JPEGs of a catalog folder.

    The search is recursive and matches `*.jpg` / `*.jpeg` case-insensitively; hidden files and
    directories are skipped.

    Args:
        catalog: The catalog root.

    Returns:
        Sorted posix paths relative to the root.
    """
    catalog = Path(catalog)
    out = []
    for root, dirs, files in os.walk(catalog):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.startswith("."):
                continue
            if os.path.splitext(f)[1].lower() in config.JPEG_SUFFIXES:
                out.append(Path(root, f).relative_to(catalog).as_posix())
    out.sort()
    return out


# --------------------------------------------------------------------------- per-file work


def _prepare(catalog: Path, rel_path: str) -> dict:
    """Reads one file: hash, EXIF, thumbnail, palette, and a PIL image for the embedder."""
    path = catalog / rel_path
    data = path.read_bytes()
    st = path.stat()
    sha1 = hashlib.sha1(data).hexdigest()

    with Image.open(io.BytesIO(data)) as im:
        meta = exif.extract(im)  # uses full-size dims, before draft()
        im.draft("RGB", (config.EMBED_MAX_SIDE, config.EMBED_MAX_SIDE))  # fast DCT downscale for big JPEGs
        oriented = ImageOps.exif_transpose(im).convert("RGB")

    work = oriented.copy()
    work.thumbnail((config.EMBED_MAX_SIDE, config.EMBED_MAX_SIDE), Image.Resampling.LANCZOS)

    thumb = work.copy()
    thumb.thumbnail((config.THUMB_LONG_EDGE, config.THUMB_LONG_EDGE), Image.Resampling.LANCZOS)
    tp = thumb_path(rel_path)
    tp.parent.mkdir(parents=True, exist_ok=True)
    tmp = tp.with_suffix(".tmp")
    thumb.save(tmp, "WEBP", quality=config.THUMB_QUALITY, method=4)
    tmp.replace(tp)

    palette = colors.palette(thumb)

    row = {
        "rel_path": rel_path,
        "file_name": Path(rel_path).name,
        "file_size": st.st_size,
        "mtime": st.st_mtime,
        "sha1": sha1,
        **meta,
        "colors_json": json.dumps(palette),
        "liked": 0,
        "liked_at": None,
    }
    return {"row": row, "image": work}


# --------------------------------------------------------------------------- passes


ProgressCb = Callable[[dict], None]


def _resolve_catalog(catalog: Path | str | None) -> Path:
    cat = Path(catalog) if catalog else config.catalog_dir()
    if not cat:
        raise RuntimeError("no catalog configured (run `photolib catalog set <dir>`)")
    cat = cat.expanduser().resolve()
    if not cat.is_dir():
        raise RuntimeError(f"catalog dir not found: {cat}")
    return cat


def _embed_pass(conn, catalog: Path, prune: bool, emit: Callable[[], None]) -> None:
    from .embedder import get_embedder

    PROGRESS.start_phase("scanning", 0, current="scanning")
    emit()
    found = scan(catalog)
    existing = db.existing_rel_paths(conn)
    new = [r for r in found if r not in existing]
    missing = sorted(existing - set(found))
    PROGRESS.update(skipped=len(found) - len(new), missing=len(missing), current=None)

    if prune and missing:
        with conn:
            for rp in missing:
                db.delete_image(conn, rp)
                thumb_path(rp).unlink(missing_ok=True)
        PROGRESS.update(pruned=len(missing))

    PROGRESS.start_phase("embedding", len(new), embed_total=len(new), embed_done=0)
    emit()
    if not new:
        PROGRESS.update(embed_seconds=0.0)
        return
    t0 = time.perf_counter()
    emb = get_embedder()
    PROGRESS.update(current="loading EmbeddingGemma")
    emit()
    emb.model()
    PROGRESS.mark_ready()
    bs = config.EMBED_BATCH
    batches = [new[i : i + bs] for i in range(0, len(new), bs)]
    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as pool:
        submit = lambda batch: [(rp, pool.submit(_prepare, catalog, rp)) for rp in batch]  # noqa: E731
        pending = submit(batches[0])
        for bi in range(len(batches)):
            futures = pending
            # decode/thumbnail the next batch on the CPU while this one runs on the GPU
            pending = submit(batches[bi + 1]) if bi + 1 < len(batches) else []
            PROGRESS.update(current=futures[0][0])
            emit()
            prepared = []
            for rp, fut in futures:
                try:
                    prepared.append(fut.result())
                except Exception as e:  # unreadable / corrupt file: skip, report
                    PROGRESS.add_failure(f"{rp}: {type(e).__name__}: {e}")
                    PROGRESS.advance(1, embed_done=1)
            if not prepared:
                emit()
                continue
            vecs = emb.encode_images([p["image"] for p in prepared])
            ts = db.now_iso()
            with conn:
                for p, v in zip(prepared, vecs):
                    p["row"]["indexed_at"] = ts
                    db.insert_image(conn, p["row"], v)
            PROGRESS.incr("untagged", len(prepared))
            PROGRESS.advance(len(prepared), added=len(prepared), embed_done=len(prepared))
            PROGRESS.update(current=prepared[-1]["row"]["rel_path"])
            emit()
    PROGRESS.update(embed_seconds=round(time.perf_counter() - t0, 2))


def _decode_ahead(catalog: Path, rel_paths: list[str]):
    """Yields `(rel_path, future image)`, decoding the next images on the CPU while d1 runs on the GPU."""
    from .tagger import load_for_tagging

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = deque((rp, pool.submit(load_for_tagging, catalog / rp)) for rp in rel_paths[:2])
        nxt = 2
        while futures:
            rp, fut = futures.popleft()
            if nxt < len(rel_paths):
                futures.append((rel_paths[nxt], pool.submit(load_for_tagging, catalog / rel_paths[nxt])))
                nxt += 1
            yield rp, fut


def _tag_pass(conn, catalog: Path, limit: int | None, emit: Callable[[], None]) -> None:
    from . import subjects, tags
    from .tagger import get_tagger

    todo = db.untagged_rel_paths(conn, limit)
    tagged, untagged = db.tag_counts(conn)
    PROGRESS.start_phase("tagging", len(todo), tag_total=len(todo), tag_done=0, tagged=tagged, untagged=untagged)
    emit()
    if not todo:
        PROGRESS.update(tag_seconds=0.0)
        return
    t0 = time.perf_counter()
    config.require_embedding()  # the label vectors come from the embedding model
    tagger = get_tagger()
    try:
        PROGRESS.update(current="loading EmbeddingGemma (label vectors)")
        emit()
        vocab = tags.get_vocab(conn)  # the DB vocabulary: builtin seed + user labels
        labels_mat = vocab.matrix()
        PROGRESS.update(current="loading d1-3B")
        emit()
        tagger.model()
        PROGRESS.mark_ready()
        for rp, fut in _decode_ahead(catalog, todo):
            PROGRESS.update(current=rp)
            try:
                image = fut.result()
                vec = db.get_embedding(conn, rp)
                if vec is None:
                    raise RuntimeError("no embedding stored")
                subs = subjects.tag_image(
                    image, vec, labels_mat, tagger, vocabulary=vocab.labels, questions=vocab.questions
                )
            except RemoteModelError:  # the endpoint is down or wrong: stop instead of failing every photo
                raise
            except Exception as e:  # unreadable file etc.: leave it untagged (retried next run), report
                PROGRESS.add_failure(f"{rp} (tagging): {type(e).__name__}: {e}", counter="tag_failed")
                PROGRESS.advance(1, tag_done=1)
                emit()
                continue
            with conn:  # one transaction per image -> interrupt-safe, resumable
                db.replace_subjects(conn, rp, subs, config.TAGGER_SHORT, db.now_iso())
            PROGRESS.advance(1, tag_done=1, tagged=1, untagged=-1)
            emit()
    finally:
        PROGRESS.update(tag_seconds=round(time.perf_counter() - t0, 2))
        tagger.unload()  # don't hold ~6 GB of VRAM between runs


def _propagate_pass(conn, catalog: Path, labels: list[str], emit: Callable[[], None]) -> None:
    from . import tags
    from .tagger import get_tagger

    config.require_embedding()
    config.require_decision()
    PROGRESS.start_phase("propagating", 0, current="finding candidates (EmbeddingGemma)")
    emit()
    vocab = tags.get_vocab(conn)
    unknown = [lb for lb in labels if lb not in vocab.index]
    if unknown:
        raise RuntimeError(f"unknown label(s): {', '.join(unknown)}")
    todo = tags.propagation_candidates(conn, labels)
    order = list(todo)
    PROGRESS.start_phase("propagating", len(order))
    emit()
    if not order:
        PROGRESS.update(propagate_seconds=0.0)
        return
    t0 = time.perf_counter()
    tagger = get_tagger()
    try:
        PROGRESS.update(current="loading d1-3B")
        emit()
        tagger.model()
        PROGRESS.mark_ready()
        for rp, fut in _decode_ahead(catalog, order):
            PROGRESS.update(current=rp)
            try:
                image = fut.result()
                probs = tagger.tag(image, [lb for lb, _ in todo[rp]], vocab.questions)
            except RemoteModelError:
                raise
            except Exception as e:  # unreadable file etc.: skip this photo, report
                PROGRESS.add_failure(f"{rp} (propagating): {type(e).__name__}: {e}", counter="tag_failed")
                PROGRESS.advance(1)
                emit()
                continue
            added = 0
            with conn:  # one transaction per photo -> an interrupt leaves a consistent DB
                for label, cos in todo[rp]:
                    p = probs.get(label, 0.0)
                    if p >= config.TAG_THRESHOLD:
                        added += db.add_subject(conn, rp, label, round(float(p), 4), "d1", cos)
            PROGRESS.advance(1, propagate_added=added)
            emit()
    finally:
        PROGRESS.update(propagate_seconds=round(time.perf_counter() - t0, 2))
        tagger.unload()


def _run(mode: str, progress_cb: ProgressCb | None, body: Callable[[Callable[[], None]], None], **reset) -> dict:
    """Wraps a job: progress reset, error capture, final snapshot. Caller holds _RUN_LOCK."""
    PROGRESS.reset(running=True, mode=mode, phase="scanning", started_at=db.now_iso(), **reset)

    def emit():
        if progress_cb:
            progress_cb(PROGRESS.snapshot())

    ok = False
    try:
        body(emit)
        ok = True
    except KeyboardInterrupt:
        PROGRESS.update(interrupted=True, error="interrupted (progress so far is saved; run again to resume)")
        raise
    except Exception as e:
        PROGRESS.update(error=f"{type(e).__name__}: {e}")
        traceback.print_exc()
    finally:
        PROGRESS.update(running=False, current=None, finished_at=db.now_iso(), rate=None, eta_seconds=None,
                        **({"phase": "done"} if ok else {}))
        emit()
    return PROGRESS.snapshot()


def _with_conn(fn: Callable) -> Callable[[Callable[[], None]], None]:
    def body(emit):
        conn = db.connect()
        try:
            tagged, untagged = db.tag_counts(conn)
            PROGRESS.update(tagged=tagged, untagged=untagged)
            fn(conn, emit)
        finally:
            conn.close()

    return body


def _refresh_body(catalog, prune: bool, skip_tags: bool):
    def fn(conn, emit):
        cat = _resolve_catalog(catalog)
        _embed_pass(conn, cat, prune, emit)
        if not skip_tags:
            _tag_pass(conn, cat, None, emit)

    return _with_conn(fn)


def _tag_body(retag: bool, limit: int | None):
    def fn(conn, emit):
        cat = _resolve_catalog(None)
        config.require_embedding()  # before clear_tags: never wipe tags that can't be rebuilt
        config.require_decision()
        if retag:
            db.clear_tags(conn)
        _tag_pass(conn, cat, limit, emit)

    return _with_conn(fn)


def _propagate_body(labels: list[str]):
    def fn(conn, emit):
        cat = _resolve_catalog(None)
        _propagate_pass(conn, cat, labels, emit)

    return _with_conn(fn)


def _locked(run: Callable[[], dict]) -> dict:
    if not _RUN_LOCK.acquire(blocking=False):
        raise RuntimeError("indexing already running")
    try:
        return run()
    finally:
        _RUN_LOCK.release()


def refresh(
    catalog: Path | str | None = None,
    prune: bool = False,
    skip_tags: bool = False,
    progress_cb: ProgressCb | None = None,
) -> dict:
    """Runs the embed pass for new JPEGs, then the tag pass. Blocking.

    Errors inside the run are captured in the snapshot's `error` field. KeyboardInterrupt propagates;
    work committed so far is kept.

    Args:
        catalog: The folder to index; defaults to the configured catalog.
        prune: Delete the rows of files that are no longer on disk.
        skip_tags: Run the embed pass only. Implied when there is no decision model.
        progress_cb: Called with a progress snapshot after every step.

    Returns:
        The final progress snapshot.

    Raises:
        RuntimeError: If another run is already active in this process.
    """
    skip_tags = skip_tags or config.decision_model() is None  # no decision model: embed only, tag later
    return _locked(lambda: _run("refresh", progress_cb, _refresh_body(catalog, prune, skip_tags), skip_tags=skip_tags))


def tag(retag: bool = False, limit: int | None = None, progress_cb: ProgressCb | None = None) -> dict:
    """Runs the tag pass only, over images that aren't tagged yet. Blocking.

    Args:
        retag: First mark every image untagged, so all of them are tagged again.
        limit: Stop after this many images.
        progress_cb: Called with a progress snapshot after every step.

    Returns:
        The final progress snapshot.

    Raises:
        RuntimeError: If another run is already active in this process.
    """
    return _locked(lambda: _run("retag" if retag else "tag", progress_cb, _tag_body(retag, limit)))


def propagate(labels: list[str], progress_cb: ProgressCb | None = None) -> dict:
    """Looks for existing labels in the photos that don't have them yet. Blocking.

    Only photos where a label is an EmbeddingGemma candidate are put to d1 (see
    `tags.propagation_candidates`).

    Args:
        labels: Labels from the vocabulary; duplicates are dropped.
        progress_cb: Called with a progress snapshot after every step.

    Returns:
        The final progress snapshot.

    Raises:
        RuntimeError: If another run is already active in this process.
    """
    labels = list(dict.fromkeys(labels))
    return _locked(lambda: _run("propagate", progress_cb, _propagate_body(labels), labels=labels))


def _start(mode: str, body, **reset) -> bool:
    """Runs a job in a daemon thread. Returns False if one is already running."""
    if is_running():
        return False
    started = threading.Event()
    result = {"ok": True}

    def run():
        if not _RUN_LOCK.acquire(blocking=False):
            result["ok"] = False
            started.set()
            return
        # Mark as running before returning to the caller so an immediate progress poll never sees stale state.
        PROGRESS.reset(running=True, mode=mode, phase="scanning", started_at=db.now_iso(), **reset)
        started.set()
        try:
            _run(mode, None, body, **reset)
        finally:
            _RUN_LOCK.release()

    t = threading.Thread(target=run, name="photolib-indexer", daemon=True)
    t.start()
    started.wait(timeout=5)
    return result["ok"]


def start_background(prune: bool = False, skip_tags: bool = False) -> bool:
    """Starts a refresh of the configured catalog (embed + tag passes) in a background thread.

    Args:
        prune: Delete the rows of files that are no longer on disk.
        skip_tags: Run the embed pass only. Implied when there is no decision model.

    Returns:
        False if a run is already active, True when the job was started.
    """
    skip_tags = skip_tags or config.decision_model() is None
    return _start("refresh", _refresh_body(None, prune, skip_tags), skip_tags=skip_tags)


def start_background_tag(retag: bool = False) -> bool:
    """Starts the tag pass in a background thread.

    Args:
        retag: First mark every image untagged.

    Returns:
        False if a run is already active, True when the job was started.
    """
    return _start("retag" if retag else "tag", _tag_body(retag, None))


def start_background_propagate(labels: list[str]) -> bool:
    """Starts a per-label propagation in a background thread.

    It shares the run lock and `PROGRESS` with indexing.

    Args:
        labels: Labels from the vocabulary; duplicates are dropped.

    Returns:
        False if a run is already active, True when the job was started.
    """
    labels = list(dict.fromkeys(labels))
    return _start("propagate", _propagate_body(labels), labels=labels)
