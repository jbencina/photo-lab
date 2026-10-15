---
title: Subjects and tags
---

# Subjects and tags

A **label** is an entry in the tag vocabulary: about 150 built in, plus the ones you create. A
**tag** is a label on a photo, either put there by the models during the tag pass or added by you.
The UI lists a photo's tags under **Subjects**.

## Subject chips

The photo viewer lists all of a photo's tags in EmbeddingGemma rank order (the grid only carries the
top 5). Hovering a chip shows d1's confidence, and clicking one filters the library by that subject.

- Model tags are plain chips. They have no ×, because a re-tag would bring them back.
- Tags you added yourself are teal chips with an × that removes them.
- A dashed chip with an amber **EG** badge is the fallback: d1 rejected every candidate, so
  EmbeddingGemma's best guess is shown. Every photo has at least one subject.

How the model tags are chosen is described in [Subject tagging](../internals/subject-tagging.md).

## Adding a tag

The **Add a tag** box is under the chips, in the desktop panel and in the phone info sheet.

![Suggestions for the empty tag box](/img/screenshots/lightbox-add-tag.jpg)

- Focusing the empty box lists likely labels for this photo that it doesn't have yet.
- Typing lists existing labels: text matches first, then labels with a similar meaning (violet
  **similar** badge), each with its photo count. This is there to stop near-duplicates: typing
  "pigeons" offers *pigeon*, and "puppy" offers *dog*.
- Labels already on the photo are grayed out.
- `Create "xyz"` is the last row. It only appears when no label is spelled exactly like that.
- The arrow keys move, Enter picks the highlighted row and Esc closes the list. On a phone, the box
  jumps to the top of the sheet so the rows stay above the keyboard.

Tags are normalized: trimmed, whitespace collapsed and lowercased, at most 40 characters, with at
least one letter or digit and no `/`. "  Wild   Turkey " is the existing *wild turkey*.

A tag you add survives re-tags: the tag pass only replaces the model's tags. Removing a tag from a
photo never deletes the label.

## Finding a new tag in other photos

After you create a tag, a prompt offers to look for it in your other photos, with the number of
candidate photos and a time estimate.

- **Run** starts the search in the background and shows a compact progress bar (photos/s, time left,
  found so far), then the result.
- **Not now** keeps the tag on this photo only. You can run the search later from
  [Admin](admin.md) under **Your labels** with **Find in library**.

The search asks d1 one yes/no question per candidate photo ("Is there a lamp in this photo?") and
adds the tag where it is at least 80% sure. Precision is high, and d1 errs on the side of saying no.
A tag d1 doesn't know well may find nothing (on the sample photos, "kelp" found 0 and "seaweed" found
19); in that case, try a more common word. Details and measurements are in
[Manual tags and propagation](../internals/manual-tags.md).
