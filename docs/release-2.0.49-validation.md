# PhotoGoGo 2.0.49 — preview-first Photo Lightbox

## Approved scope

**Superseded before Slack sharing by 2.0.50.** The source/tag/package receipt are
retained. A final failure-path regression found that expansion-only work could
overwrite the selected folder's progress and hide Retry after an incomplete
result. No 2.0.49 installer was finalized/shared to Slack. The 2.0.50 receipt
records the correction and final delivery.

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

## Built source

Application source is `603e2819165f8f1ae084005506ac707b4864aece`, based on
released `origin/master` at `da0ea7c5b772618f645ca6749485871749dcb84f`.
All application changes/tests/version/guide were committed before building.
The production frontend identifies
`2.0.49 / 20261108T060621075Z-603e2819+local`.
The literal `+local` records four unrelated untracked cleanup artifacts and
Vite's temporary configuration module; those files remain untouched/excluded.
Subsequent package/delivery documentation does not change the compiled source.

## Finished packages

The optimized native build completed in **6m 10s**, with five existing unused-code
warnings and the existing frontend Browserslist/chunk-size notices. Both EXE and
MSI were extracted without installing them. Inspection reports `complete: true`;
the application payload matches the built executable after normalizing only
Tauri's expected three-byte bundle marker. Pinned media/source payloads, all
2,205 ExifTool 13.59 files, all 440 RawTherapee 5.13 resources and all 28 modified
controller SDK source files/notices passed.

Both relocated packages decoded the supplied CR3 at **6014 × 4016**, RTv4_sRGB,
with PATH empty and the original hash unchanged. MSI ProductVersion is 2.0.49;
UpgradeCode remains `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` from 2.0.48.
These are unsigned test installers. Physical folder/storage performance remains
Stuart's retest; the fixture measurements do not establish that result.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.49_x64-setup.exe | 130,887,175 | FE7A10848B864D818C3BB7BC188AA47EC85AB99C7F3A3E3BBC89D7D4C537753D |
| PhotoGoGoV2_2.0.49_x64_en-US.msi | 222,163,668 | B7925FA20B4E52A3481B78C9F99FCDCF86F955F6BCF7340A43289D905266C820 |
| photogogo-v2.exe | 30,244,864 | 543F83B0E1BB246B01B499A04CBF46E5648C4E0E7B17858059489EF0A4D5E7F3 |
