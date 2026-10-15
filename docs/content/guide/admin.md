---
title: Admin
---

# Admin

The Admin page (`/admin`, the gear icon in the top bar) manages the catalog, indexing and labels.

![The Admin page](/img/screenshots/admin-full.jpg)

## Status

The cards at the top show the number of photos, tagged and untagged photos (with the estimated time
to tag the untagged ones), liked photos, subjects in use and the database size. Below them are the
two models, EmbeddingGemma and the d1-3B tagger, with where each runs (device or remote endpoint),
the number of labels, the confidence threshold and whether the model is loaded. A model that isn't
configured is shown as unavailable, and the actions that need it are disabled. See
[Where the models run](../models.md).

## Catalog

- **Photo folder**: type another folder and press **Switch catalog** to index what is new in it.
  Nothing is deleted: every catalog keeps its own index, likes and tags. If you enter the current
  folder, the button reads **Rebuild catalog** and, after a confirmation that explains the purge,
  re-indexes it from scratch. See [Catalogs](../catalogs.md).
- **Refresh** indexes new JPEGs and then tags untagged photos; photos already indexed are skipped.
  Check **Prune missing** to also drop photos whose files are gone.
- **Retag all** re-runs d1 over every photo, for example after editing the labels. The confirmation
  shows the estimate (photos × 0.3 s). Current subjects stay visible until each photo is re-tagged,
  and tags you added by hand are kept.

![The Retag all confirmation](/img/screenshots/admin-retag.jpg)

## Progress

While a refresh runs, the panel under the buttons shows two steps, **1 Embed new photos** and **2 Tag
subjects**, each with its own bar, photos/s over a sliding window and time left. While embedding, the
tag step shows its estimated duration. The header shows the overall time left and the current file,
and a summary when the run finishes.

Only one run happens at a time: refresh, retag and "find in library" share it, and switching or
purging the catalog waits until it finishes.

## Your labels

The labels you created, with their photo counts and how many you tagged by hand. **Find in library**
shows the number of candidate photos and the estimate, asks for confirmation, then looks for the label
in the rest of the library, with live progress in the indexing panel. See
[Finding a new tag in other photos](tags.md#finding-a-new-tag-in-other-photos).

## Danger zone

**Purge everything** deletes the current catalog's index: database, thumbnails, likes and tags. You
must type `purge` to confirm. Other catalogs and your photos are never touched.

:::warning

There is no authentication. Anyone on your network who can reach the port can browse, like, refresh
and purge. Don't expose the port to the internet.

:::
