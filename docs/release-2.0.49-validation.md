# PhotoGoGo 2.0.49 — preview-first Photo Lightbox

## Approved scope

Stuart reported first-image waits sometimes exceeding a minute in folders with
over 700 photos. Approved scope: display the exact selected original before
folder inspection finishes, load comparison versions independently, bound and
cache background work, show inspection progress, retain exact-file/pending-save
protection, validate, merge/build and release to #swghermes. Two bounded helpers
covered native metadata performance and independent identity/cache safety.

Design: `docs/lightbox-first-preview-design.md`; implementation plan/ledger:
`docs/superpowers/plans/2026-11-08-lightbox-first-preview.md`.

## Reproduction and implementation

The production React page was exercised with 700 synthetic file entries and a
held folder-metadata response. Before correction, after 404 ms there were zero
image reads and zero visible images; an image could appear only after releasing
the held inspection. Separately, a held Enhanced read hid an already prepared
original because the hook published panels only after Promise.all. This is
dependency evidence, not measured render-PC latency.

The hook now starts exact physical-source reads immediately and publishes each
panel independently. Every completion checks mounting, root, selected path and
selection epoch. Preview readiness is separate from canonical action readiness;
mutations remain blocked until identity and the original read are resolved.
Source/crop switches also guard identity in the hook. Incomplete checks and RAW
lineage warnings remain read-only, with explicit progress/retry guidance.

Folder admission is shared across Lightbox mounts: one running inspection and
one latest queued inspection. Per-view keys and owner-scoped cleanup prevent a
reopened view from inheriting old work. Selected-photo inspections take priority
over folder expansion. Verified pairing retains a clicked Camera JPEG's pixels
and physical target while rotating the capture/action epoch. Cached bytes are
reused. Missing explicit Camera JPEGs show an error and require reselection;
there is no RAW-preview substitution. Unresolved selections revoke all old reads.

Native token reads retain the global singleflight lane, with at most two batches
overlapped inside that lane. Existing 128-file/64 KiB argument/4 MiB output limits,
size/time/path/duplicate/error checks, complete-candidate pairing and the 50,000
entry cache remain. Single-batch folders stay serial. No dependencies, staging
schema, original-file edits, implicit RAW development or export changes.

## Validation evidence

- Original ordering repro: `test-output/lightbox-first-image-latency-repro.log`.
- Native serial orchestration failed the overlap regression (peak 1, expected
  2); final focused suite passed six tests. The opt-in throughput probe passed
  separately through actual read_tokens and the bundled metadata runner.
- The scheduling fixture used 700 generated 32 × 24 JPEG payloads, half with CR3
  names; these are not real CR3 decode measurements. Serial batches took 9,525
  ms initially / 5,500 ms later; bounded-two runs took 3,802 / 3,140 ms. The final
  native path measured 2,610 ms with cold app cache (six tool calls), 46 ms warm
  (zero calls), all 700 tokens present and all fixture bytes unchanged.
- Nine new real-UI groups pass, covering held folder/Enhanced reads, 700-file
  preview, paused decisions, navigation, incomplete/corrupt metadata, retry,
  priority/coalescing, same-root remount, missing Camera JPEG and source changes.
  Recorded preview appeared at 298 ms in the final run while folder inspection
  remained held (795 ms with concurrent development checks). This is not a
  NAS/PC speed guarantee. Pending checkboxes say Capture checks pending rather
  than suggesting that saved selections are unavailable.
- The remount regression failed before owner scoping. Existing readiness tests
  caught early rating when B&W arrived before the original; original-read
  readiness is now retained. Independent source review also found/fixed queued
  selection priority, missing-JPEG fallback and unresolved-selection cleanup.
- Full serial native suite passed 386 tests, zero failed, 30 opt-in tests
  ignored, in 48.18 seconds. The explicit metadata probe is one of those opt-in
  tests and was run separately as described above.
- Existing Lightbox controls (21), general Lightbox/crop (13), RAW source (9),
  rename/error recovery (8), and selection/transfer barriers (11) browser groups
  passed. Controller panel (nine groups), 20 Lightbox units, 22 controller units,
  four persistence-queue checks and TypeScript passed. A final locked 2.0.49
  native run again passed 386 tests, zero failed, 30 opt-in ignored (46.17 s).
  Source/version checks and package/delivery receipts follow.

No physical-device speed, network-share speed or controller acceptance is
claimed from the fixtures. Prior released installers remain available for
rollback. No render-PC installation, process access or user-media changes occur.
