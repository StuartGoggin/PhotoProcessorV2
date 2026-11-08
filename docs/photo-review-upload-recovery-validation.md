# JPEG-first review and Google recovery validation — 9 November 2026

Base: `ec6666a`, the separately committed named-day import fix. Branch:
`SWG/photo-review-upload-recovery`. Package version remains 2.0.50 until a release.

## Implemented scope

- Verified paired captures default to their Camera JPEG and its comparison family.
  A nullable default preference is separate from the effective displayed source;
  explicit RAW/JPEG choices survive refresh/navigation, and snapshots use the
  actual physical source. Pairing still requires native proof; filenames do not
  infer pairs. Capture decision anchors and existing upload selections are retained.
- Existing but unreadable/undecodable image versions have a per-panel error and
  exact-version Retry. Absent comparisons offer no Retry. Healthy panels remain
  visible; original retries pause decisions, and late retries cannot repaint a
  changed photo, source or root. Decode failures clear their version controls.
- Known item-scoped Google verification failures leave their receipt unresolved
  while healthy saved IDs, later batches and later albums continue. Request,
  authentication, quota, network and malformed-response failures still stop.
  Final status stays needs_attention for unresolved proof. Registered photos do
  not return to upload/registration; unresolved album cover intents stay pending.
- Redacted diagnostics expose safe prepared/saved-receipt dimensions and proof
  flags. They do not expose account/media IDs, secrets, paths or raw API messages.

## Evidence

- Before the fix, two ten-photo fixtures stopped at 8 instead of 10 uploads.
  Both fresh-batch and saved-receipt restart scenarios failed as expected.
- Before the fix, the paired-capture browser assertion showed `raw` instead of
  `cameraJpeg`; the failed-comparison fixture had no error/Retry UI.
- Final complete native suite: **402 passed, 0 failed, 30 ignored**.
  `test-output/photo-review-upload-final-native.log` records the final source,
  including the corrected evidence label. The earlier focused Google suite
  passed 99 tests with one ignored subprocess probe.
- Production frontend/type build passed (`npm.cmd run build`). Only the existing
  large-chunk advisory and npm update notice appeared; no dependency was changed.
- **70 browser groups passed**: 16 first-preview/default/retry/safety groups,
  9 RAW/source/crop groups, 21 review/controller groups, 11 selection/barrier
  groups, 8 rename/curation groups, and 5 Google verification/core-job groups.
- Lightbox catalogue/cache/RAW-recipe units: **20 passed**. Google UI helpers:
  **4 passed**. `git diff --check` passed.
- Approved independent read-only review found no blocking defects. Corrected
  its evidence-label finding and added its original-retry, source/root retry,
  absent-versus-failed and cross-album cover scenarios; all passed.

The native regressions cover complete later batches, later albums with a healthy
cover after another album's unresolved cover, saved IDs unchanged over repeated
retries/restarts, unresolved-versus-accepted warning outcomes, durable negative
evidence, fatal errors, pause/backoff and source-byte preservation. The UI fixtures
exercise actual production components/hooks through controlled local IPC.

## Evidence boundaries and next RAW proposal

The user's clarification explains the missing Enhanced view as selection of an
undeveloped CR3 family while the working versions belong to Camera JPEG. No local
photo deletion was established. The uploaded Google log proves a repeated Original
read-back failure, but does not establish Google's underlying reason or which
receipt proof is insufficient. No live Google operation was performed here.

The proposed larger workflow is one capture with JPEG-first review, an optional
RAW-available action only when a verified CR3 exists, explicit development through
the existing editor/core Jobs, and deliberate per-photo choice of a saved finish.
It should preserve JPEG review work and keep exact-file upload flags separate.
That integrated editor/finish preference and any capture-metadata migration remain
unapproved/unimplemented; this correction does not add them or auto-develop RAW.

No installer was packaged/published, no application was installed on the target
PC, no account was reset and no user media was changed. All tests use synthetic
local fixtures. Existing unrelated cleanup files remain outside this work.
