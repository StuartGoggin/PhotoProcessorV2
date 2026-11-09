# Lightbox filters, ordering and explicit review status

Approved in this chat on 9 November 2026, to join the illustrated Help centre in the 2.0.52 test build. The approval also extends the existing single read-only reviewer to selection/save safety.

## User experience

Compact quick views: All, Needs review, Selected for Google Photos, Rated and Favourites (also expose Reviewed as the complementary review view). Separate Trash choice: Hide / Include / Only. Order by capture time available in imported filenames, natural filename, JPEG-owner rating or original file size; ascending/descending. Unknown dates/sizes sort last, with deterministic neutral-name/path tie breaks. Show count, Reset and validated per-PC preferences. Scope is the containing folder and already-loaded tree; never scan/decode an entire library to apply a view.

Reviewed is a new explicit capture decision, independent of rating, favourites, Google selection and viewing choice. Browsing never marks Reviewed. Add Reviewed status and Reviewed & next, plus a deliberate return-to-Needs-review control. Existing photos have no reliable visit history: missing records start Needs review and the UI explains that older photos must be explicitly marked. No silent inference or legacy migration from ratings/Google flags.

## Persistence and rollback

Use separate per-folder `.photogogo-review.json`, schema1, revision, tag-neutral original filename (including extension) keys and native source stamps. Do not extend `.photogogo-curation.json`: its old readers deny unknown fields and rollback would lose selection access. Use the canonical RAW navigation node only for native-verified pairs; JPEG remains the rating/trash owner. Adding a RAW companion does not silently migrate an older standalone JPEG review marker. Cropped/developed views do not change capture Reviewed status.

Reuse the existing file metadata query in import::build_tree to expose an opaque stamp (size and decimal nanoseconds, never an unsafe JS integer). Do not add per-file stat calls or decode media for filtering. Ignore stale/ambiguous stamps as unknown, keep unknown items visible for Needs review, and show warnings separately from rawWarning. Reject unsupported/corrupt review metadata without overwriting it. Add the new JSON to archive library-metadata classification; its lock/temp files remain working files.

## Projection and saves

Retain the complete canonical catalogue for identity. Derive one filtered/sorted projection for visible tree, folder siblings, previous/next, Home/End and prefetch. Selection-dependent filters use confirmed Google state, not optimistic display intents. Unknown/pending Google facts must not hide every photo and prevent the first selection needed for loading them. Read containing-folder curation independently and keep work bounded.

Pin root, path, epoch and native stamp for Reviewed writes; validate exact acknowledgement. Reviewed & next captures its eligible next path before saving, reprojects confirmed state, then navigates exactly once. Failed writes keep the photograph and error visible. Hold current selection while relevant saves drain; changing filters/sort is disabled during pending decisions. Sorting keeps the current capture if still eligible. If a confirmed decision removes it, move once to an eligible neighbour; zero matches shows a useful empty state and Reset.

## Validation

Pure view tests cover combined filters, Trash, missing metadata, stable ordering, paired owners and generated-file exclusion. Native tests cover no-write reads, old/corrupt/unsupported/stale/ambiguous records, exact stamps, tag/event renames, path escapes/reparse points, unchanged media and concurrent atomic updates. Browser tests cover pending/failing saves, no double advance, controller/key navigation, reload persistence, saved-filter bootstrap, unknown metadata, empty/reset state, quick selection paint and 700+ files. Re-run affected existing Lightbox, curation, RAW pairing and archive classification regressions. Update the guide/keymap and capture fresh annotated controls. Build/inspect local test installers only; no publication or merge approval has been given.

## Approved amendment before publication

Stuart requested automatic Reviewed on 9 November 2026: successful rating/tag, Trash/restore and Google selection/favourite changes on any related version mark the canonical capture Reviewed. This supersedes the initial explicit-only wording above. Browsing, zoom, switching source/crop views and opening editors do not mark it. Existing historical flags are not migrated. M still clears the independent flag. A primary failure creates no review marker; a secondary Reviewed failure preserves the primary change, pins the photo, and offers Reviewed-only retry. A view-independent bounded writer reserves a follow-up before the primary operation, completes accepted work after unmount, and lets readers wait for both acknowledgements. Rapid checkboxes remain optimistic and ordered; navigation/filter reconciliation waits for the entire decision.
