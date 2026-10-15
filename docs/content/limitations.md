---
title: Known limitations
---

# Known limitations

- **JPEG only.** HEIC, RAW, PNG and video are ignored.
- **Indexing only adds photos.** Files that changed in place aren't re-indexed; remove and re-add
  them, or rebuild. Renaming a file counts as a delete plus a new file, so its like is lost unless you
  keep the old name.
- **Vectors live in RAM, per server process**: about 77 MB for 25k photos, plus a reload of about
  100 ms after each indexing change. Fine for a personal library; not meant for millions of photos.
- **No total count for ranked searches.** Query, color and similar results show "N photos · best
  match first" and keep loading as you scroll.
- **Subjects come from a vocabulary** (`photolib/labels.py` plus the labels you create). The models
  only tag what is in it, although query search still finds everything, and EmbeddingGemma must rank
  a label in its top 20 for d1 to be asked. The same holds for "find in library": a new tag is only
  looked for in photos EmbeddingGemma finds plausible, and only added where d1 is at least 80% sure.
  See [Known weak spots](internals/subject-tagging.md#known-weak-spots).
- **No UI to manage labels.** You can't rename or delete a label or edit its question from the web
  UI; use `photolib labels --remove`.
- **Tagging is GPU-bound and slow**: about 0.3 s per photo, about 2 h for 25k. The d1 fast path uses
  private PyTorch attention ops (bf16, Ampere or newer); a PyTorch upgrade could break it.
- **Time zones.** Dates and date filters use the camera's local time as recorded in EXIF. Photos with
  no offset tag are compared as-is.
- **No authentication.** Anyone on your LAN who can reach the port can browse, like, refresh and
  purge. Don't expose the port to the internet.
- **One indexing run at a time.** Refresh, tag, retag and "find in library" share it. Switching or
  purging the catalog, or starting a retag or a "find in library", while one runs returns HTTP 409.
  The photo viewer only shows "find in library" progress while it stays open (the job itself
  continues, and Admin shows it), and the grid's hover data for other photos refreshes on the next
  search or reload. A `photolib refresh` or `tag` in a terminal and a run started from the web UI
  don't know about each other; avoid running both at once.
