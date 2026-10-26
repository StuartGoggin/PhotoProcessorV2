# PhotoGoGo 2.0.35 validation

This release repairs the four-photo Google Photos pilot's verification flow.
All four registration receipts were saved; a singleton read-back rejection of
photo 3 stopped photo 4 being checked. The native regression reproduced that
failure before the fix (photo 4 remained registered rather than verified).
The original Google's INVALID_ARGUMENT cause is not established or bypassed.

## Change and recovery contract

- Typed read-back errors distinguish a singleton item status 3 from a failed
  request. A rejected item or dimension mismatch retains its receipt and error
  while healthy registered siblings are checked. Global HTTP, account, network
  and quota errors stop; rate-limit backoff is retained.
- Saved IDs across albums are verified before source access or new writes.
  Upload and registration paths explicitly exclude accepted receipts. Recovery
  can finish verification with the original photo folder offline.
- Unverified receipts produce needs_attention, never silent completion. Only
  verified items enter the account/hash/recipe/GPS-bound duplicate ledger.
- Jobs, Transfer and dock details separate accepted, verified, pending and
  verification-warning counts. Processed progress is not upload confirmation.
- Diagnostics retain one failed event per failed check and attribute aggregate
  attention to the job rather than the last healthy photo. Sensitive response
  contents and IDs remain excluded. Byte totals use actual prepared-copy sizes
  and exclude skipped/blocked items.
- Existing protected jobs, account/client bindings and media receipts are
  retained. No new OAuth scopes, manual verification override or dependencies.

## Validation evidence

The first exact four-photo regression failed in 0.50 seconds on the old flow.
After correction, 72 Google Photos native contracts passed, zero failed and one
existing opt-in metadata test was ignored. These include persistent rejections,
same-ID recovery with no new uploads/registration/album, offline source folder,
later-album receipt checks, cancellation, global failures/backoff, diagnostics
attribution, exact IDs, protected storage and account/client isolation.

Native evidence: test-output/google-verification-recovery/red.log and green.log.
Focused browser evidence: test-output/google-photos-verification-browser/report.json
and Jobs/Transfer screenshots. Five focused browser groups, seven existing Jobs
groups and sixteen existing Transfer groups passed. TypeScript validation passed.

The complete native suite passed: 270 passed, zero failed, 23 existing opt-in
tests ignored (test-output/google-verification-recovery/native-all.log).
The production TypeScript/Vite build passed. Existing large-chunk advisory
remains non-failing. The warning-progress bar was visually checked and its
computed amber fill asserted in the focused browser test.

The remaining full native/frontend, installer inspection, source commit and
publication receipts are recorded below after their gates finish. No live
Google requests, deployment installation or user-photo access are performed by
the local regression tests.

## User acceptance

Install this update over 2.0.34 on the same Windows account/PC. Open the existing
saved Google Photos job and choose Retry safe remaining work. Do not create a
replacement upload, reset the account/client or clear the receipts. If Google
continues rejecting the Original, the correct outcome is four accepted, three
verified and one verification warning. If its saved-ID check succeeds, all four
can be verified and the job completes. Retain 2.0.34 for rollback.
