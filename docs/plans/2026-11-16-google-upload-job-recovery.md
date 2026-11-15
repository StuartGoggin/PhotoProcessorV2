# Google Photos saved-job visibility and recovery

Approved: focused repair, one read-only receipt/retry reviewer, validation, commit/build and replacement test installer to #swghermes. Work uses a new branch in the existing writable checkout, reusing its pinned native/runtime caches; the externally managed chat checkout is outside the writable roots. Preserve unrelated worktrees and the four existing cleanup artifacts.

## Evidence and limits

- User runs 2.0.53; a confirmed publish appears briefly and is absent from both Active and History.
- Slack1794773866.614299 reports8 protected upload records, including2 written16November2026 at07:02:05 and07:04:46, each581414bytes. The files exist; their status and Google outcome are not yet known.
- A real-page synthetic command test is RED: native google_photos_start returns a JobSummary, but GooglePhotos.tsx treats it as string, passing an object to Jobs focus. No Google calls or user media were used.
- Snapshot enumeration currently aborts the whole cloud list if any record fails parsing, ID validation or filename/ID consistency. A legacy unsupported identifier can pass the executor ledger read yet fail this stricter read-only projection. This is a candidate explanation, not a confirmed target-record diagnosis.

## Intended repair

1. Consume and validate the actual native summary ID; persist/reuse only that accepted ID for View job. Reject malformed acknowledgements without silently creating a second upload.
2. Make read-only job enumeration report per-record issues and retain independently readable, valid jobs. Preserve all encrypted records and legacy receipt/ledger data. Keep global-store failures visible and preserve known safe cached rows where identity is known.
3. Show actionable missing-job/recovery diagnostics through the existing core Jobs architecture. Do not add another tracker. Preserve strict account, ID, ledger and upload admission checks; no deletion, reset, guessed success or implicit reupload.
4. Correct fixtures to match the native return shape; regress confirmed publish → focused job, failures/history, malformed acknowledgements, mixed legacy/new records and stale snapshots. The independent reviewer checks receipt isolation and safe retries.

## Validation and release

- Run focused red/green browser and native regressions; existing Google/core Jobs and relevant Lightbox boundaries; TypeScript/production build and offline Help checks.
- Review final diff, commit source, build both installer formats with existing pinned runtimes, inspect/extract and compare hashes without installing. Serialize packaging and compiled-asset validation after the earlier WiX overlap failure.
- Deliver validated EXE/MSI to #swghermes with verified read-back and source/tag receipts. Both installers go to Slack; GitHub carries the source tag, guide/checksums and explicit links to Slack installers and the unchanged matching FFmpeg source.
- No live Google sign-in/upload, account reset, user-photo mutation, render-PC installation or controller access. Keep2.0.53 rollback installers. Stop for a decision on an unresolved identity/receipt issue, unsuitable dependency or behavior-changing integration conflict; no dependency changes are planned.
