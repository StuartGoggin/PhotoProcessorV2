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

## Build and package receipts

Application/source commit: 189835998ecf90fee30489ba16060d59b5e68b47.
Remote main was rechecked at e179d98 before publication; it remains the parent
baseline. No application changes were made during packaging.

Displayed build ID: 20261026T002349711Z-18983599+local. Preserve that literal
stamp when comparing installed tests. The working tree was clean before and
after the build; the normalized Cargo.toml blob on disk matches the source
commit (0c806fdb1055c2eeed137e592354bbf051b48be8). The conservative +local
marker emitted during Tauri's build is not rewritten or claimed clean.

Both packages were extracted without installation and passed application-byte
comparison, allowing only Tauri's documented three-byte bundle marker. Each
contains the exact 2,205-file metadata closure, whose relocated runtime ran
with PATH empty, and the pinned managed FFmpeg payload. Both are unsigned test
installers. MSI version is 2.0.35 and upgrade identity remains
{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}, matching 2.0.34.

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.35_x64-setup.exe | 71,127,895 | 599EF65E9B4BAF64D88528AEAF43793D62513200EF1C9A8CF66B062981C13D54 |
| PhotoGoGoV2_2.0.35_x64_en-US.msi | 91,968,787 | 8D119CC3EDC4A3AE48BEE5837CBDC972AFA7E48EF83C96179813FC0A1CA379D6 |

Standalone application SHA-256:
DD5C781F9009EF5F7ADA4E4D7470C4F1F347D2040C0E59EB5849799E16D3700B.
Inspection receipt:
test-output/release-2.0.35-inspection-20261026T003126913Z/report.json.
Full build log: test-output/google-verification-recovery/release-build.log.

Bundled media and metadata resources/dependencies are unchanged from 2.0.34.
The FFmpeg corresponding-source archive remains 49,570,807 bytes, SHA-256
27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8.
Its existing #swghermes source-companion post was read back successfully:
https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792900657737419.
Complete pinned ExifTool/Perl sources and notices remain inside both installers.

## User acceptance

Install this update over 2.0.34 on the same Windows account/PC. Open the existing
saved Google Photos job and choose Retry safe remaining work. Do not create a
replacement upload, reset the account/client or clear the receipts. If Google
continues rejecting the Original, the correct outcome is four accepted, three
verified and one verification warning. If its saved-ID check succeeds, all four
can be verified and the job completes. Retain 2.0.34 for rollback.
