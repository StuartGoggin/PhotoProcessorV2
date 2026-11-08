# Named-day re-import validation — 9 November 2026

Branch: `SWG/import-named-day`, based on `3bea971` (PhotoGoGo 2.0.50 source).
Scope/design: `superpowers/specs/2026-11-09-import-named-day-design.md`.

## Result

Normal import now resolves a sole existing `YYYY/MM/DD - Event` directory
instead of constructing a bare day. It reports ambiguous dates before copying
and checks ordinary directory components before preparing the private work area.
In-place maintenance retains canonical filenames in named day folders.

The duplicate algorithm is unchanged. Tests of the actual staging MD5/size
indexes found existing identical contents across renamed folders, even without
sidecars, and rejected stale sidecar hashes after actual contents changed.
Same-size/same-name different contents retain the existing photo and publish
under a suffix. This is byte identity, including embedded metadata, not visual
similarity. No failure of identical-byte detection was reproduced in these
readable synthetic fixtures.

## Evidence

- Baseline native import suite: 42 passed, 1 subprocess probe ignored.
- Before implementation: renamed-day destination regression failed, choosing
  bare `24` instead of `24 - AMGA Champs`; both existing-content checks passed.
- Final complete native library suite: **399 passed, 0 failed, 30 ignored**.
  This includes 13 new named-day re-import tests and existing import, naming,
  RAW, archive, Google Photos, and Studio tests. Ignored tests require opt-in
  media/device environments or are invoked explicitly as subprocess probes.
- Standalone bounded import pipeline: **26 passed, 0 failed, 2 ignored**.
- Event naming rules: passed.
- Event context/path rules: **15 passed, 0 failed**.
- Independent user-approved read-only review: no material findings. The review
  checked the final resolver, containment, ambiguity policy, preservation of
  existing content checks and meaningful native test interfaces.
- `git diff --check`: passed. The new native test file was formatted separately;
  existing unrelated source was not reformatted.

Commands:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-event-naming.ps1 -Filter '' -TargetDirectory C:\creations\PhotoGoGoV2\src-tauri\target
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import-pipeline.ps1
node scripts/test-event-naming.mjs
node scripts/test-event-context.mjs
```

Full native output: `test-output/import-named-day-full-native.log`.
Failing regression: `test-output/import-named-day-red.log`.
Standalone pipeline output: `test-output/import-named-day-pipeline.log`.

## Coverage and limits

Fixtures exercise the real routing, staging indexes, MD5 checks, temporary-copy
verification, filename reservation and publication helpers. They cover RAW/JPEG
extensions, source/original/review-data preservation, restarts without content
claims, equal-size changed bytes, global duplicates, concurrent publication,
numeric-prefix lookalikes, missing dates, different months/years, both conflict
forms, and Windows junctions including one inserted after destination resolution.
They do not drive a Tauri window or read the user's SD card/photo collection.

Existing staging-index traversal/metadata errors can omit candidates; the
pre-existing scan-completeness policy is outside this focused routing correction.
The reviewer identified it as a separate investigation, not a newly reproduced
cause of this report. Do not infer a root cause for the user's already duplicated
photo bytes without comparing those files and their import logs.

Existing duplicate folders/media are untouched. Both bare and named day folders
for one date must be reconciled separately before retrying that date; the importer
does not automatically merge or delete them. No dependency or version change,
installer build, publication, account access or live media operation was performed.
