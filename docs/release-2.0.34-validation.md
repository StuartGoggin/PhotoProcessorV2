# PhotoGoGo 2.0.34 release validation

Version 2.0.34 bundles the metadata tool needed to restore dates/colour metadata
and optionally remove GPS from generated photo upload copies. Settings retains
an explicit folder override and adds an unsaved-path health check. Google Photos
shows readiness early. This release also includes current main's completed
Name Events workflow. No live Google upload was performed during validation.

## Source and integration

Metadata implementation: 8d5c191. Current main through 6327e33 (Name Events) was
integrated without conflicts in 7f7b8fd. Application/build source commit:
ef445fdb98fef2c00830ba9d3551d9f6ec158173.
Follow-up cd24515 preserves exact pinned resource bytes across Git checkouts;
it changes Git attributes and lock-file line endings, not application code or
the reviewed on-disk runtime bytes. The final tag includes that follow-up.

Displayed build ID: 20261025T212558704Z-ef445fdb+local. Retain this literal ID
when comparing installed tests. The normalized Cargo.toml blob matches the
recorded application source (99f73d750dfc078f4806ff5342ecc497980cd6f1); no
application-source differences exist between ef445fdb and cd24515. The +local
marker is not replaced with a claim that the build stamp was clean.

## Checks completed

- Combined native regressions: 262 passed, zero failed, 23 opt-in ignored.
- Both real source-built metadata tests passed after integration: capture
  dates/offset/subseconds, portrait orientation/dimensions, RGB versus grayscale
  ICC handling, GPS retain/remove, JPEG coding-byte identity, unchanged upload
  sources, Unicode tag read/write, unchanged pixels and file-mtime retention.
- Runtime acceptance moved the complete bundle to a path with spaces, accents
  and CJK characters, removed PATH dependencies, supplied hostile Perl variables
  and user config, and rejected missing/tampered files.
- Google Photos browser: 16 groups. Google Jobs browser: seven groups.
- Integrated Name Events rule and real-page browser checks passed; TypeScript
  and the Vite production build passed. Existing bundle-size and native unused
  code advisories remain non-failing.
- Independent static/source review verified all locked files, upstream ExifTool
  sources, all 52 x64 native files, both Microsoft signatures and notices, and
  complete source/build provenance. See exiftool-runtime-review.md.

Application runtime receipt:
test-output/exiftool-runtime-20261025T212330177Z/report.json.
Perl build receipt:
test-output/metadata-perl-build/runtime-build-receipt.json.
Installer inspection receipt:
test-output/release-2.0.34-inspection-20261025T213238593Z/report.json.

## Installer receipts

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.34_x64-setup.exe | 71,115,157 | C33E4787828D7756A6E6063ECEA9D4641A442167602BB1E6D23339E2E9AF2717 |
| PhotoGoGoV2_2.0.34_x64_en-US.msi | 91,964,691 | 5A1265070E415353F2A478CF7C24B39AA6962AAA82829B4B070AE1068757E8E2 |

Both test installers are unsigned. The standalone application SHA-256 is
71C72E41218DFCA43F0B306DC43EA8D202427497AF4E1443DED0FC1CF1F2353E.
The inspector allows only Tauri's documented three-byte MSI/NSIS bundle marker
change; every other application byte matches. MSI product version is 2.0.34;
upgrade code remains {9CBA7A69-EDA0-5480-A421-9DC9AD265A65}, matching 2.0.33.
Neither package was installed to perform inspection.

Each extracted installer contains the exact 2,205-file metadata payload. MSI
File/Component/Directory tables reconstruct the installed paths from cabinet
IDs; this avoids accepting hashes in the wrong folder. Both relocated extracted
runtimes execute with PATH empty. Managed FFmpeg's 27 payload files and manifest
also match the existing validated bundle. Its unchanged corresponding-source
archive is 49,570,807 bytes, SHA-256
27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8.

The metadata manifest SHA-256 is
A4E4A62DC6CB671A8E5E24CAF62893820278E1E1CD02D746C43C720101356F75.
It matches the file packaged in both installers. The installer includes complete
pinned Perl/ExifTool source archives, the build recipe and required notices.
Old vendor/GCC/GMP resources are excluded. Existing 2.0.33 installers are kept
for rollback. No render, app settings, OAuth identity or photo collection was
changed on a deployment PC.

## User acceptance and remaining account error

Install either package, leave Settings → ExifTool folder override empty for
Automatic (bundled ExifTool), and select Check metadata tool. Expect ready and
ExifTool 13.59. Rebuild the upload review so previously blocked B&W choices are
assessed with the available tool. Keep the same intended Google account and
preserve durable jobs/receipts instead of using a fresh job to bypass recovery.

The latest Slack diagnostics also show a Check account failure with zero bytes
sent and no retained API code. Source inspection places that stage at saved
account/token checks before local-source preflight. Its exact in-app error was
requested separately; this installer does not establish that the account issue
or remote Google read-back has been resolved. A user-run personal pilot remains
necessary. Do not reset the account/client, request credentials, or claim upload
success from transferred bytes alone.

## Publication

GitHub and Slack delivery receipts will be added after their live read-back.
The destination is GoggoVille #swghermes, metadata-error thread 1792958256.790289.