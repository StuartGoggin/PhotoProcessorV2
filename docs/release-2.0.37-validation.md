# PhotoGoGo 2.0.37 validation

Google Photos no longer leaves an accepted upload permanently failed solely
because the additional per-item read-back returns INVALID_ARGUMENT. A successful
saved registration with full-resolution dimensions matching the prepared image
can finish as Completed with verification warnings. Accepted and read-back
verified remain different evidence, counts and durable receipt states.

## Cause and boundaries

The observed 2.0.36 log shows two reused photos, two successful registrations,
a repeated singleton read-back rejection for the Original, and a healthy B&W
read-back. Stuart confirmed the Originals had previously been uploaded and
shared in another album. Google documents duplicate-byte ID reuse and app-created
read restrictions. That combination is a strong explanation, not a confirmed
Google-side reason for the generic code 3 response.

The app defect was making additional read-back mandatory for job completion,
even when registration had succeeded. The deterministic ten-photo regression
first failed with the saved-receipt aggregate error, before later batches ran.
It now passes with ten accepted, nine read-back verified, one warning and no
repeat byte transfer or registration. Synthetic service contracts reproduce
the application recovery policy; they do not prove Google's remote cause.

## Safety and recovery

- Only a singleton API per-item code 3 uses the unavailable classification.
  HTTP 400, auth, quota, transport, malformed responses and dimension errors
  keep requiring attention. Read-back dimension mismatches are a separate type.
- Warning completion requires a saved media ID, prepared fingerprint and
  matching registration dimensions, including the portrait EXIF swap. Missing
  or incorrect registration dimensions do not qualify.
- Later batches continue. Each deliberately requested recheck reads the saved
  IDs once; it never sends accepted bytes or registers the photo again. An
  actual authentication/dimension error on recheck returns to Needs attention.
  Contradictory dimension evidence also prevents future-plan receipt reuse until
  a successful read-back resolves it; a later code 3 cannot erase that evidence.
- Existing 2.0.36 registered jobs recover via one normal Retry, including with
  the original drive offline. No store reset, OAuth change or new album needed.
- Encrypted ledger evidence distinguishes accepted-only from read-back verified.
  Future plans reuse unchanged photos only with existing account, album, source
  and original hashes, metadata recipe and GPS-policy matching. Reuse keeps the
  verification warning; successful later read-back upgrades the evidence.
- The normal core ProcessJob interface adds a completed-with-warnings result.
  It appears in History, not as a perpetual attention failure. Optional Recheck
  verification uses the standard retry command. Clear finished archives only
  eligible history visibility and preserves receipts and ledger.
- Bounded diagnostics use warning events and retain only safe numeric codes;
  no credentials, raw Google responses, filenames, media IDs or paths are added.
  No dependency, account permission or photo-encoding change is introduced.
- Rollback: the prior 2.0.36 installer remains available. Its stricter read-back
  handling may show Needs attention again; do not reset saved checkpoints.

## Validation

- Red-capable command: run-native.ps1 -Filter
  accepted_receipt_readback_rejection_completes_with_warning_and_survives_restart.
  Observed failure before fix: one registered photo still needed verification.
- Full release-profile native suite: 283 passed, zero failed, 23 existing opt-in
  tests ignored. Receipt: test-output/google-acceptance-recovery/native.log.
- Core Jobs browser: ten groups through real React components and controlled
  native IPC. Covers warning history, optional same-ID recheck, counts, archive,
  account/persistence guards, ordinary controls and no separate tracker/poller.
- Transfer browser: fifteen groups. Jobs SSR/classification: sixteen tests.
  Google Photos utility tests: four. Steady Jobs polling regression passed.
- TypeScript and whitespace checks passed. Production build and extracted
  installer validation receipts will be appended after packaging.
- No live Google account upload, deployed-app installation or user-photo access
  was performed here. Final remote behaviour needs Stuart's saved-job retry.

## Release receipts

Source commit: b711da050a92881324ea1176207a9e808c2f6d5f.
Build ID: 20261026T034108382Z-b711da05+local, retained exactly as emitted.
The tracked tree was clean before and after the build; the literal +local marker
is not rewritten or represented as a clean build stamp.

Both Windows x64 test installers built successfully. Extraction without
installation passed: application matches apart from Tauri's three-byte package
marker; all 2205 metadata payload files match and the relocated private runtime
executes without PATH; 27 managed FFmpeg files plus manifest match; MSI upgrade
identity is unchanged from 2.0.36. Installers are unsigned.

Inspection report: test-output/release-2.0.37-inspection-20261026T034806313Z/report.json.
MSI UpgradeCode: {9CBA7A69-EDA0-5480-A421-9DC9AD265A65}.
Standalone application SHA-256: A747A886D1792C38489D2890EBA0ED0252A8F64E637C969B70DE701168B8DC6C.

- PhotoGoGoV2_2.0.37_x64_en-US.msi
  Bytes: 92095763
  SHA-256: 934BE10D30C413DAF06428B665C9EF9FE0DF296023640BD8DF86FBB53DEC15C6

- PhotoGoGoV2_2.0.37_x64-setup.exe
  Bytes: 71218127
  SHA-256: A2B2BFF7BBC43AF5350B5B3432E1652A0444ED701D969DA2ABF9EBE63FBE5F4C

Corresponding FFmpeg source: 49570807 bytes,
SHA-256 27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8.
The exact unchanged source companion is available in the existing
[Slack source post](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792900657737419).
Source/runtime licensing files are retained in the managed packages.

Slack delivery receipts will be appended after publication and read-back.
