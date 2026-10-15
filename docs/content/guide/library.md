---
title: Library and search
---

# Library and search

## Browsing

The library is a masonry grid of 2 to 6 columns, depending on the width of the window, with small or
large thumbnails. It opens in random order, reshuffled on every page load and kept while you scroll,
filter or open photos. On desktop, hovering a photo shows its file name, focal length, aperture,
shutter speed and ISO.

More photos load as you scroll, 60 at a time. A **Load more** button stays as the fallback, and it is
the only trigger when the system asks for reduced motion.

![The library](/img/screenshots/library.jpg)

The search, the filters and the open photo are all kept in the URL, so you can bookmark or share a
view, and Back closes the photo viewer. Light and dark themes follow the system setting; the moon
button in the top bar switches them and remembers your choice.

![The library in the dark theme](/img/screenshots/library-dark.jpg)

## Search modes

The search box has two modes; pick one in the dropdown at its right.

- **Query** (semantic): describe the photo and press Enter. Results are ranked by similarity, best
  match first, and hovering a photo shows its score. Ranked results have no total count: the header
  reads "120+ photos · best match first", and more load as you scroll.
- **Metadata**: searches as you type, with prefix matching on file name, make, model, lens and
  software. Every word must match, so `KI8A` and `RF200 canon` both work.

![Query results for "bird in flight", with the score shown on hover](/img/screenshots/query.jpg)

## Filter suggestions

While you type a word or two, the search box offers matching filters below it:

- subjects ("bird" offers Bird, Bird in flight, …);
- lens, light and depth-of-field presets ("tele", "low light", "bokeh");
- dates ("2025", "june", "june 2025");
- "liked";
- camera and lens names ("rf200").

![Suggestions for "bir"](/img/screenshots/search-suggestions.jpg)

Click or tap a suggestion, or pick it with the arrow keys and Enter (or Tab), and the typed word turns
into a filter chip; the rest of the text stays. Nothing is applied on its own: Enter without a
highlighted suggestion searches the text as typed, and Esc hides the list.

Suggestions need three letters and ignore words like "in" or "the". Once you are typing a sentence
(two or more words before the current one), only exact matches of the non-subject filters show, so a
description like "a dog sitting on the grass" is not interrupted.

## Color search

Pick a preset swatch or a custom color from the dock's **Color** button, or click a palette swatch in
the photo viewer. Photos dominated by a color close to the one you picked come first.

![Photos ranked by how much orange they contain](/img/screenshots/color.jpg)

## Find similar

**Find similar** in the photo viewer lists the photos whose embedding is closest to that photo's,
best match first. The photo you started from is shown in the header.

![Photos similar to a dog portrait](/img/screenshots/similar.jpg)

Filters apply on top of query, color and similar results. See [Filters and the dock](filters.md).
