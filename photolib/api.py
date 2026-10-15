"""FastAPI app: JSON API under /api + the built frontend (frontend/dist) with SPA fallback."""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Iterator

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from . import config, db, embedder, indexer, search, tagger, tags
from .labels import LabelError, try_normalize
from .remote import RemoteModelError

IMMUTABLE = "public, max-age=31536000, immutable"  # URLs carry ?v=<sha1> so content changes bust caches


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Starts the optional background warm-up of the local embedding model."""
    if os.environ.get("PHOTOLIB_WARMUP") == "1" and config.embedding_model() == "local":
        # Load the model in the background so the first query is fast; the server is usable immediately.
        threading.Thread(target=embedder.get_embedder().model, name="photolib-warmup", daemon=True).start()
    yield


app = FastAPI(title="photo-lib", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(db.SchemaError)
def schema_error(request: Request, exc: db.SchemaError):
    """Answers 409 for an old or foreign DB instead of a 500 traceback (Admin -> Rebuild fixes it)."""
    return JSONResponse({"detail": str(exc), "code": "schema_rebuild_required"}, status_code=409)


@app.exception_handler(config.ModelUnavailable)
def model_unavailable(request: Request, exc: config.ModelUnavailable):
    """Answers 503 when a feature needs a model this server was started without."""
    return JSONResponse({"detail": str(exc), "code": "model_unavailable"}, status_code=503)


@app.exception_handler(RemoteModelError)
def remote_model_error(request: Request, exc: RemoteModelError):
    """Answers 502 when a remote model endpoint failed."""
    return JSONResponse({"detail": str(exc), "code": "remote_model_error"}, status_code=502)


def get_conn() -> Iterator:
    """Yields a DB connection for one request and closes it afterwards."""
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def get_filters(
    liked: int | None = None,
    subject: list[str] = Query(default=[]),
    make: str | None = None,
    model: str | None = None,
    lens: str | None = None,
    iso_min: int | None = None,
    iso_max: int | None = None,
    f_min: float | None = None,
    f_max: float | None = None,
    focal_min: float | None = None,
    focal_max: float | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    q_meta: str | None = None,
) -> search.Filters:
    """Collects the query-string filters shared by /api/images and every /api/search/* endpoint."""
    return search.Filters(
        liked=bool(liked) if liked is not None else None,
        subjects=subject,
        make=make or None,
        model=model or None,
        lens=lens or None,
        iso_min=iso_min,
        iso_max=iso_max,
        f_min=f_min,
        f_max=f_max,
        focal_min=focal_min,
        focal_max=focal_max,
        date_from=date_from or None,
        date_to=date_to or None,
        q_meta=q_meta or None,
    )


def _not_found(what: str = "image") -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


# --------------------------------------------------------------------------- status / browse


@app.get("/api/status")
def status(conn=Depends(get_conn)):
    """Returns catalog, counts, model cards and indexing progress."""
    cat = config.catalog_dir()
    n_labels, n_user = db.vocabulary_size(conn)
    return {
        "catalog_dir": str(cat) if cat else None,
        **search.stats(conn),
        "model": embedder.embedder_info(),
        "tagger": {
            **tagger.tagger_info(),
            "labels": n_labels,
            "user_labels": n_user,
            "threshold": config.TAG_THRESHOLD,
            "seconds_per_image": config.TAG_SECONDS_ESTIMATE,
        },
        "indexing": indexer.PROGRESS.snapshot(),
    }


@app.get("/api/images")
def list_images(
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort: str = Query("taken_at", pattern="^(taken_at|file_name|indexed_at|liked_at|random)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    seed: int = Query(0, ge=0, description="Shuffle for sort=random; keep it the same while paging."),
    filters: search.Filters = Depends(get_filters),
    conn=Depends(get_conn),
):
    """Lists photos (with filters and metadata search), sorted and paged."""
    items, total = search.list_images(conn, filters, sort, order, limit, offset, seed)
    return {"items": items, "total": total}


@app.get("/api/images/{id:path}")
def image_detail(id: str, conn=Depends(get_conn)):
    """Returns one photo with full EXIF and all its subjects (404 if unknown)."""
    d = search.detail(conn, id)
    if d is None:
        raise _not_found()
    return d


class LikeBody(BaseModel):
    """Body of `POST /api/images/{id}/like`."""

    liked: bool


@app.post("/api/images/{id:path}/like")
def like(id: str, body: LikeBody, conn=Depends(get_conn)):
    """Likes or unlikes a photo (404 if unknown)."""
    r = search.set_like(conn, id, body.liked)
    if r is None:
        raise _not_found()
    return r


# --------------------------------------------------------------------------- manual tags / labels


class TagBody(BaseModel):
    """Body of `POST /api/images/{id}/tags`: the label and an optional custom question."""

    label: str
    question: str | None = None


class PropagateBody(BaseModel):
    """Body of `POST /api/labels/{label}/propagate`."""

    confirm: bool = False


def _known_label(conn, label: str) -> str:
    norm = try_normalize(label)
    if norm is None or db.get_label(conn, norm) is None:
        raise _not_found("label")
    return norm


@app.post("/api/images/{id:path}/tags")
def add_tag(id: str, body: TagBody, conn=Depends(get_conn)):
    """Manually tags a photo.

    A label that doesn't exist yet is created (source 'user'); the response then carries a propagation
    preview so the UI can offer to look for it in the other photos.
    """
    try:
        r = tags.add_tag(conn, id, body.label, body.question)
    except LabelError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except LookupError:
        raise _not_found()
    if r["created"] and config.embedding_model() and config.decision_model():
        try:
            r["propagate"] = tags.propagation_preview(conn, [r["label"]])
        except tags.MODEL_ERRORS:  # the tag is saved, there is just no preview
            r["propagate"] = None
    return r


@app.delete("/api/images/{id:path}/tags/{label}")
def remove_tag(id: str, label: str, conn=Depends(get_conn)):
    """Removes a MANUAL tag from a photo (409 for a tag the model added). The label itself stays."""
    try:
        return tags.remove_tag(conn, id, label)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except tags.TagConflict as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.get("/api/labels/suggest")
def labels_suggest(
    q: str = Query("", max_length=200),
    image: str | None = None,
    limit: int = Query(8, ge=1, le=50),
    conn=Depends(get_conn),
):
    """Suggests existing labels for typed text, or likely labels for a photo when `q` is empty."""
    return tags.suggest(conn, q, image or None, limit)


@app.get("/api/labels")
def labels_list(conn=Depends(get_conn)):
    """Returns the whole vocabulary with photo counts."""
    return {"items": tags.list_labels(conn)}


@app.get("/api/labels/{label}/propagate/preview")
def labels_propagate_preview(label: str, conn=Depends(get_conn)):
    """Returns how many photos a propagation would ask d1 about, and the time estimate."""
    config.require_embedding()
    return tags.propagation_preview(conn, [_known_label(conn, label)])


@app.post("/api/labels/{label}/propagate")
def labels_propagate(label: str, body: PropagateBody, conn=Depends(get_conn)):
    """Looks for one label in the rest of the library in the background (EG candidates -> d1 yes/no)."""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true (runs d1 over the candidate photos)")
    norm = _known_label(conn, label)
    config.require_embedding()
    config.require_decision()
    if not config.catalog_dir():
        raise HTTPException(status_code=400, detail="no catalog configured")
    if indexer.is_running():
        raise HTTPException(status_code=409, detail="indexing is running; try again when it finishes")
    preview = tags.propagation_preview(conn, [norm])
    if preview["candidates"] == 0:
        return {"ok": True, "started": False, **preview}  # nothing to ask d1: don't load 6 GB for it
    if not indexer.start_background_propagate([norm]):
        raise HTTPException(status_code=409, detail="indexing is running; try again when it finishes")
    return {"ok": True, "started": True, **preview}


# --------------------------------------------------------------------------- search


@app.get("/api/search/query")
def search_query(
    q: str = Query(..., min_length=1),
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    filters: search.Filters = Depends(get_filters),
    conn=Depends(get_conn),
):
    """Ranks photos by similarity to a text query (semantic search)."""
    config.require_embedding()
    if db.image_count(conn) == 0:
        return {"items": []}
    qvec = embedder.get_embedder().encode_query(q.strip())
    return {"items": search.semantic(conn, qvec, filters, limit, offset)}


@app.get("/api/search/similar/{id:path}")
def search_similar(
    id: str,
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    filters: search.Filters = Depends(get_filters),
    conn=Depends(get_conn),
):
    """Ranks photos by similarity to another photo, excluding that photo."""
    vec = db.get_embedding(conn, id)
    if vec is None:
        raise _not_found()
    return {"items": search.semantic(conn, vec, filters, limit, offset, exclude=id)}


@app.get("/api/search/color")
def search_color(
    hex: str = Query(..., min_length=3),
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    filters: search.Filters = Depends(get_filters),
    conn=Depends(get_conn),
):
    """Ranks photos by how much of a color they contain (400 for an invalid hex color)."""
    try:
        items = search.color_search(conn, hex, filters, limit, offset)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"items": items}


@app.get("/api/subjects")
def subjects(conn=Depends(get_conn)):
    """Returns every subject label in use with its photo count."""
    return {"items": search.subject_counts(conn)}


@app.get("/api/facets")
def facets(conn=Depends(get_conn)):
    """Returns the values and ranges the filter panel offers."""
    return search.facets(conn)


# --------------------------------------------------------------------------- files


@app.get("/api/thumb/{id:path}")
def thumb(id: str):
    """Serves a photo's WebP thumbnail."""
    p = indexer.thumb_path(id)
    if not p.is_file():
        raise _not_found("thumbnail")
    return FileResponse(p, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@app.get("/api/image/{id:path}")
def original(id: str, conn=Depends(get_conn)):
    """Serves an indexed photo's original file from the catalog folder."""
    cat = config.catalog_dir()
    if not cat or not conn.execute("SELECT 1 FROM images WHERE rel_path = ?", (id,)).fetchone():
        raise _not_found()
    root = cat.resolve()
    p = (root / id).resolve()
    if not p.is_relative_to(root) or not p.is_file():
        raise _not_found("original file")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": IMMUTABLE})


# --------------------------------------------------------------------------- admin


class CatalogBody(BaseModel):
    """Body of `POST /api/admin/catalog`."""

    catalog_dir: str
    rebuild: bool = False
    confirm: bool = False


class RefreshBody(BaseModel):
    """Body of `POST /api/admin/refresh`."""

    prune: bool = False
    skip_tags: bool = False


class RetagBody(BaseModel):
    """Body of `POST /api/admin/retag`."""

    confirm: bool = False


class PurgeBody(BaseModel):
    """Body of `POST /api/admin/purge`."""

    confirm: bool = False


@app.get("/api/admin/config")
def admin_config():
    """Returns the catalog dir, the data dir and the catalog's index dir inside it."""
    cat = config.catalog_dir()
    return {
        "catalog_dir": str(cat) if cat else None,
        "data_dir": str(config.data_dir()),
        "index_dir": str(config.index_dir()) if cat else None,
    }


def _forget_caches() -> None:
    search.invalidate_cache()
    tags.invalidate_vocab()
    indexer.PROGRESS.reset()


@app.post("/api/admin/catalog")
def admin_catalog(body: CatalogBody):
    """Switches to another catalog folder and indexes what is new in it, in the background.

    Every catalog keeps its own index, so switching deletes nothing and switching back is instant.
    With `rebuild` the target catalog's index is deleted first and built from scratch.
    """
    if not body.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true")
    config.require_embedding()  # before anything changes: a catalog can't be indexed without it
    target = Path(body.catalog_dir).expanduser()
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {body.catalog_dir}")
    if indexer.is_running():
        raise HTTPException(status_code=409, detail="indexing is running; try again when it finishes")
    config.set_catalog(target)
    if body.rebuild:
        config.purge_index()
    _forget_caches()
    indexer.start_background(prune=False)
    return {"ok": True}


@app.post("/api/admin/refresh")
def admin_refresh(body: RefreshBody | None = None):
    """Starts a background refresh (embed new photos, then tag) unless one is already running."""
    if not config.catalog_dir():
        raise HTTPException(status_code=400, detail="no catalog configured")
    if indexer.is_running():
        return {"ok": True, "already_running": True}
    db.check_schema()  # old DB -> 409 with the rebuild hint instead of a failing background run
    config.require_embedding()
    body = body or RefreshBody()
    started = indexer.start_background(prune=body.prune, skip_tags=body.skip_tags)
    return {"ok": True, "already_running": not started}


@app.post("/api/admin/retag")
def admin_retag(body: RetagBody):
    """Marks every photo untagged and re-runs the d1 tag pass in the background (after editing labels.py)."""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true (re-runs d1 over every photo)")
    if not config.catalog_dir():
        raise HTTPException(status_code=400, detail="no catalog configured")
    if indexer.is_running():
        raise HTTPException(status_code=409, detail="indexing is running; try again when it finishes")
    db.check_schema()
    config.require_embedding()
    config.require_decision()
    started = indexer.start_background_tag(retag=True)
    return {"ok": True, "already_running": not started}


@app.get("/api/admin/progress")
def admin_progress():
    """Returns the progress of the current (or last) indexing run."""
    return indexer.PROGRESS.snapshot()


@app.post("/api/admin/purge")
def admin_purge(body: PurgeBody):
    """Deletes the current catalog's index (database, thumbnails) and unsets the catalog. Photos are never touched."""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true")
    if indexer.is_running():
        raise HTTPException(status_code=409, detail="indexing is running; try again when it finishes")
    config.purge_catalog()
    _forget_caches()
    return {"ok": True}


# --------------------------------------------------------------------------- frontend (SPA)


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
def api_404(rest: str):
    """Answers 404 as JSON for unknown /api paths (instead of the SPA page)."""
    return JSONResponse({"detail": "not found"}, status_code=404)


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str, request: Request):
    """Serves the built web UI: a file from `frontend/dist`, else `index.html` (SPA fallback)."""
    dist = config.frontend_dist().resolve()
    index = dist / "index.html"
    if not index.is_file():
        return JSONResponse(
            {"detail": "frontend not built (run `npm run build` in frontend/)", "api": "/api/status"},
            status_code=404,
        )
    if full_path:
        f = (dist / full_path).resolve()
        if f.is_relative_to(dist) and f.is_file():
            cache = IMMUTABLE if full_path.startswith("assets/") else "no-cache"
            return FileResponse(f, headers={"Cache-Control": cache})
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
