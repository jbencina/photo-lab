---
title: API reference
sidebar_label: API
---

# API reference

The web UI is a client of a JSON API under `/api`. The server also serves interactive OpenAPI docs at
`/docs`.

## Library

- `GET /api/status`: counts, database size, the models and the indexing progress (see
  [Status and progress](#status-and-progress)).
- `GET /api/images`: list and metadata search, with filters, `sort` (`random`, `taken_at`,
  `file_name`, `indexed_at` or `liked_at`), `order`, `seed` (picks the shuffle for `sort=random`;
  keep it while paging), `limit` and `offset`.
- `GET /api/images/{id}`: detail with the full EXIF and all subjects, each with `source`, `eg_score`
  and `display_rank`.
- `POST /api/images/{id}/like`: body `{liked}`; likes or unlikes a photo.
- `GET /api/subjects`: `{label, count, category}` per subject in use; `category` is null for labels
  you created.
- `GET /api/facets`: makes, models and lenses with counts; ISO, aperture, focal length and date
  ranges; `iso_values`, `f_values`, `focal_values` and `months` distributions for the presets and the
  date histogram.
- `GET /api/thumb/{id}`: the thumbnail.
- `GET /api/image/{id}`: the original file.

Thumbnail and image URLs carry `?v=<sha1>`, so they can be cached as immutable.

## Search

- `GET /api/search/query?q=`: semantic search.
- `GET /api/search/similar/{id}`: photos similar to a photo.
- `GET /api/search/color?hex=`: photos ranked by a color.

All search endpoints take the same filters as `images` and support `limit` and `offset` paging.

## Tags and labels

- `POST /api/images/{id}/tags`: body `{label, question?}`; adds a manual tag and creates the label
  when it is new. Returns `{label, created, added, subjects}`, plus
  `propagate: {candidates, est_seconds}` when the label was created. 422 for text that can't be a
  label.
- `DELETE /api/images/{id}/tags/{label}`: removes a manual tag. 409 for a tag the model added, 404 if
  absent.
- `GET /api/labels`: the whole vocabulary,
  `{label, question, category, source, created_at, count, manual_count}` per label.
- `GET /api/labels/suggest?q=&image=&limit=8`: returns
  `{items: [{label, count, match, similarity, source, on_image}], exact_exists, normalized, can_create, reason}`.
  `match` is `exact`, `prefix`, `text` or `similar`, or `image` for the empty-query defaults.
- `GET /api/labels/{label}/propagate/preview`: returns `{candidates, est_seconds}`.
- `POST /api/labels/{label}/propagate`: body `{confirm: true}`; returns
  `{ok, started, candidates, est_seconds}`. `started` is false when there are no candidates; 409
  while another run is active.

## Admin

- `GET /api/admin/config`: `catalog_dir`, `data_dir` and `index_dir` (the current catalog's index
  folder).
- `POST /api/admin/catalog`: body `{catalog_dir, confirm: true, rebuild}`; switches catalog and
  indexes what is new. `rebuild: true` deletes that catalog's index first.
- `POST /api/admin/refresh`: body `{prune, skip_tags}`.
- `POST /api/admin/retag`: body `{confirm: true}`; marks every photo untagged and starts the tag pass.
- `GET /api/admin/progress`: the progress object.
- `POST /api/admin/purge`: body `{confirm: true}`; deletes the current catalog's index and unsets the
  catalog.

## Status and progress

`status` also returns `tagged_count`, `untagged_count` and
`tagger: {name, device, dtype, loaded, labels, user_labels, threshold, seconds_per_image}`.

The progress object (`indexing` in `status`, and `admin/progress`) carries:

- `mode`: `refresh`, `tag`, `retag` or `propagate`;
- `phase`: `scanning`, `embedding`, `tagging`, `propagating` or `done`;
- `done` and `total` for the current phase, `rate` (photos/s over a 30 s window) and `eta_seconds`;
- `embed_done`, `embed_total`, `tag_done`, `tag_total`, and live `tagged` and `untagged` counts;
- for a propagate job, `labels`, `propagate_added` and `propagate_seconds`.

Image summaries carry `subjects: [{label, score, source}]` (the top 5 by display rank; `source` is
`d1`, `eg` or `user`).

## Errors

- A database that needs a rebuild answers every database-backed endpoint with HTTP 409 and
  `{"detail": "...", "code": "schema_rebuild_required"}`.
- Starting a run while another one is active answers 409.
- An action that needs a model that isn't available answers 503 with `"code": "model_unavailable"`.
- An action whose remote model endpoint failed answers 502 with `"code": "remote_model_error"`.
