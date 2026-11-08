# PhotoGoGo 2.0.51 validation and release

## Scope

JPEG-first Photo Lightbox with optional per-photo RAW alternatives. Existing camera-JPEG B&W/Enhanced images remain in their own family. The existing developer opens for one pinned CR3, previews explicitly, and submits its current draft through core Jobs. Per-photo viewing choices are portable, independently stamped metadata; they do not select upload files or refresh development lineage.

The verified camera JPEG preserves capture review decisions. Conflicting historical RAW/JPEG tags remain intact with a visible notice. Native transfer/archive decisions and RAW batch selection follow the same verified JPEG anchor, while existing Google asset and family IDs remain unchanged. Source-specific crops do not transfer between camera and developed families.

Includes preceding commits `ec6666a` (re-import into named event days) and `d2cc0b6` (JPEG-first comparison recovery, scoped Retry, isolated Google read-back failures). No account reset, live Google operation, user-photo modification, new dependency or target-PC installation was performed.

## Verification before packaging

- Full native suite: **407 passed, 30 opt-in tests ignored**, no failures. Log `test-output/raw-finish-final-native.log`.
- Five focused metadata/decision regressions cover independent admission stamps, unchanged recipes/output lineage, invalid/escaping requests, unavailable/changed/TIFF-only finishes, neutral rating renames, event-folder moves, ambiguous masters and authoritative JPEG review flags. All five passed again after the 2.0.51 version update.
- Nine production-component browser suites: **101 groups**, with synthetic native adapters. Reports: `lightbox-raw-workflow-browser`, `lightbox-first-preview-browser`, `lightbox-raw-browser`, `lightbox-controls-browser`, `lightbox-selection-browser`, `lightbox-rename-curation-browser`, `google-photos-core-jobs-browser`, `raw-photo-editor-browser`, `raw-development-browser` under `test-output`.
- Lightbox/cache/catalogue and Google UI unit checks: **24 passed**.
- Production frontend/type build passed; existing large-bundle advisory remains. No dependency update was made.
- Independent source safety review found and rechecked corrections for per-photo source bleed, busy/dirty close guards, stale modal roots, visible fallback notices, basename-only preference keys and recovery without a readable camera preview. No outstanding blocking source finding.
- Actual Review editor inspected at **1440 × 1000** and **860 × 1000**: no horizontal overflow, keyboard focus and Tab trapping verified, explicit queue isolated, no selection writes. Evidence `test-output/raw-editor-visual/report.json`.

Early validation distinguished test assumptions from application failures: an exact-path assertion needed canonical Windows path comparison; the core Google browser suite passed its complete isolated rerun after a timing-sensitive assertion failed under concurrent test load. Failed and successful logs are retained. Actual-sample RAW and completed package evidence are recorded below only after verification.

The current **2.0.51 native test binary** also passed `raw_real_file_library_and_cancel` with the supplied CR3 (82.48 seconds while other native tests were running). The test copies the sample into an owned workspace, proves pairing with a differently named JPEG, decodes and publishes a RAW finish, verifies repeat reuse, saves its viewing choice, confirms Camera JPEG ratings override old RAW Trash/rating tags for processing/transfer, and asserts unchanged Google asset/family IDs. Active decoder cancellation and the original source hash also pass. Evidence: `test-output/raw-finish-real-integration-current.log` and `test-output/raw-development/library-cancel.json`. The stale 2.0.50 executable was explicitly superseded by the newly compiled 2.0.51 executable; its old assertion failure is not reported as a current application failure.

The final Lightbox workflow rerun also dispatches **Open Jobs** with the exact returned job ID, without selection writes; evidence `test-output/raw-workflow-job-navigation.log`. Production App supplies the existing shared job-navigation callback.

## Target-PC acceptance

1. Confirm About shows 2.0.51. Open an already-reviewed JPEG/CR3 event; JPEG, B&W and Enhanced should appear as before. Check one existing rating/Trash decision.
2. Develop one CR3 alternative from Lightbox, inspect its preview, queue it and follow its core Job. Refresh finished outputs, compare both families, choose a finish for that photo and revisit it. Another photo stays JPEG-first until deliberately changed.
3. Verify exact-file Google selection/favourite flags are unchanged by the above. For an interrupted upload, retry the **existing job**: accepted photos retain their receipts, healthy work continues, unresolved read-back errors remain visible rather than being declared verified.
4. Re-import one already-imported card into its named event day: identical content should skip; conflicting day folders require resolution instead of creating another sibling or guessing. Existing duplicate directories are not automatically removed.

These controlled results do not establish live Google read-back resolution, subjective RAW appearance across every camera/scene, or performance on Stuart's storage. Originals and prior installer remain available for rollback.
