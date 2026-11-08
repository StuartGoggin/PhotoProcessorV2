# PhotoGoGo 2.0.50 — final preview-first Lightbox delivery

## Scope and held checkpoint

This completes the approved large-folder loading work documented in
`docs/lightbox-first-preview-design.md` and `docs/release-2.0.49-validation.md`.
The 2.0.49 source/tag/package receipt was retained after a final targeted check
found a recovery-UI edge case. Its installer bytes were uploaded privately but
never finalized/shared in Slack; they are not the delivery artifacts.

With inspection O running, selecting a photo in A queues A at foreground
priority. Expanding B correctly discards B's queued work, but previously still
overwrote the visible inspection phase with B. If A completed incompletely,
the preview stayed usable and writes stayed blocked, but Retry was hidden.

The real-UI regression failed on 2.0.49 waiting for Retry. The correction only
lets foreground/current-selected-folder work update that visible checking phase;
promoting an existing queued selection also restores its progress context.
Threading, identity gates, cache limits, writes and all original files remain
unchanged. Version 2.0.50 avoids moving the published v2.0.49 tag.

## Validation

Red evidence: `test-output/lightbox-inspection-progress-red.log`.
Final tests, built-source, package and verified delivery receipts follow.

The full ten-case preview browser suite passes, including the new failure-path
case, original/crop/source identity, delayed comparisons, metadata failure and
retry, bounded priority, same-root remount and missing Camera JPEG handling.
The 700-file preview measured **301 ms while metadata remained held**. This is
a controlled dependency measurement, not a render-PC/network speed guarantee.
TypeScript passes; no native implementation changed after the 386 passing
native tests and explicit real-tool throughput probe recorded with 2.0.49.
Final targeted legacy browser checks passed: 21 Lightbox/controller controls,
nine RAW-source groups and 11 saved-selection/transfer-barrier groups. The
independent reviewer confirmed the final five-line correction and its regression
with no findings. No other implementation changes are included in this cut.
