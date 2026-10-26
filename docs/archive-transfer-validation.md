# Selective archive transfer validation

Validated 26 October 2026 against the working tree based on `e4ce213b0b552a5b8a7f390a8d2541e5d6fef3bd` (uncommitted archive changes). This is implementation validation, not an installer release or a live NAS transfer.

## Result

- Full native application test harness: **308 passed, 0 failed, 23 existing opt-in tests ignored** (331 total).
- Archive planner: **18 passed**, covering all version rules, source-original opt-in, inherited ratings, trash precedence, RAW/video controls, metadata/cache/sidecar classification, event scope, single-use and expired previews, changed media/curation, corrupt curation, operational-cache churn, stale legacy checksums, verified no-overwrite publication, cancellation, actual Windows junctions, path/depth refusal and selection receipts.
- Transfer regressions: **2 passed**, covering renamed conflicts participating in copying and refusal of invalid/escaped checksum entries.
- Browser regressions: **10 groups passed** against the real Transfer page with a deterministic native-command adapter. Covers independent rules, scopes/presets, native request shape, preview decisions/totals, search/filter/paging, invalidation, single-flight queuing, stale-preview rejection, safe preference persistence, empty/blocked plans and compact layout.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/vite/bin/vite.js build`: passed. Existing bundle-size and Browserslist-age notices remain.
- Independent read-only safety review: no outstanding confirmed P1/P2 findings in the final pass.

## Important implementation safeguards

Metadata stays in staging. Per-version selections use the exact local Lightbox Google Photos checkbox, without account access or upload-state dependence. Archive-only discovery shares the Lightbox catalogue semantics and additionally recognises common camera RAW formats. Generated-version ambiguity is excluded visibly; damaged curation and incomplete scans cannot produce a queueable complete preview.

A native preview token binds the roots, scope, rules and meaningful source/curation state; it expires, is consumed once, and is revalidated before queue admission and at worker start. Source fingerprints are also checked around source hashing and publication. Operational cache/log churn does not change the selection digest. Preview cache capacity is bounded by count and aggregate entry count.

The existing core transfer/verify jobs remain. Selected sources are freshly hashed rather than trusting legacy sidecars. An archive OS lease coordinates writers. Copies use the existing same-filesystem verified staging helper and never replace a destination created after planning. Renamed conflicts are copied. Archive paths, checksum paths and redirected ancestors are validated before reads/writes. The archive retains its own selection and checksum records; a reviewed-selection receipt does not claim successful copying.

## Evidence and reproduction

- `test-output/archive-transfer-native/report.json` and group logs record actual native outcomes.
- `test-output/archive-transfer-native/build.jsonl` records the successful full native harness compilation.
- Native harness SHA-256: `7D4B52207E5D0AE28221F8C57963470CAA5926F08ABBF2CAA700956C9D96EF71`.
- The verified harness is retained at `test-output/archive-transfer-native/native-tests.exe`; `retained-binary.json` records its copy/checksum receipt. The generated debug build cache was removed after validation to restore disk space.
- `test-output/archive-transfer-browser/report.json` records browser checks, with screenshots at 1360px and 720px alongside it. Screenshot counts and paths are synthetic fixture data.

Run `pwsh -NoProfile -File scripts/test-archive-transfer.ps1 -AllNative` to rebuild and validate. The runner disables debug symbols and uses two build workers. For the retained exact harness, use `-TestBinary test-output/archive-transfer-native/native-tests.exe -AllNative`; future source changes require a rebuild.

The first test links exhausted disk while producing debug symbols. A successful bounded rebuild disabled dependency/application debug symbols and linker PDB output. No dependency, driver, installed application, user media or Google account was changed. All native filesystem tests used generated temporary fixtures. No new installer was packaged or published in this change.

Subsequent approved packaging and delivery are recorded separately in [the 2.0.39 release receipt](release-2.0.39-validation.md).
