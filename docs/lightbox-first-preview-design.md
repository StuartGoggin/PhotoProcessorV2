# Preview-first Lightbox loading

Approved 8 November 2026: show the selected original before folder inspection
finishes, load comparison versions independently, bound/cache background work,
show inspection progress, preserve exact-file and pending-save protection, then
validate, merge, build and release to #swghermes. Two bounded helpers are approved:
native metadata performance and independent identity/cache safety review.

The reproduced problem is ordering: with 700 synthetic files, no image read
starts until a held folder-metadata call completes. A separately held Enhanced
read also hides an already prepared original because all panels share one wait.
These are deterministic dependency tests, not measurements of Stuart's PC.

## Resulting behavior

Selecting a file starts its exact physical image immediately. RAW reference
previews remain labelled and cannot be saved as RAW developments. Each available
Original/B&W/Enhanced panel paints when ready; pending panels say Loading image.
Read-only browsing, fit and zoom do not depend on folder-wide capture inspection.

While capture metadata is unverified, a visible status explains that preview is
available but editing/selection decisions are paused. Rating, Trash, Crop,
source/version switches and Google selection/favourite writes remain gated.
Complete verified metadata replaces provisional navigation, retaining a clicked
camera JPEG as the displayed source when folded into its RAW owner. It revokes
the old action epoch without needlessly rereading cached identical image bytes.
Incomplete/failed checks retain the preview and offer explicit retry.

Folder inspection admits one active call and at most one latest queued call;
duplicates coalesce. Old root/tree/selection results cannot replace current
display or grant permission to act. Comparison completions have the same fences.
Existing bounded full-resolution image cache and save settlement rules remain.

Native metadata optimization is conditional on a measured benefit. It must retain
all-candidate completeness, unique pairing, missing-tag/read-failure distinction,
path admission, per-batch limits and source size/time checks. No new dependencies,
implicit RAW development, media changes or staging metadata schema changes.

## Acceptance

With folder inspection and Enhanced completion withheld, the original displays
and browsing works; writes remain absent until canonical verification. Exercise
700+ entries, rapid cross-folder/root/source/crop changes, late completions,
incomplete metadata, retry, stale controller revisions and pending/failed saves.
Keep existing Lightbox/RAW/selection/controller tests green; inspect both finished
installers and read back the Slack delivery. Physical-PC speed remains a retest.
