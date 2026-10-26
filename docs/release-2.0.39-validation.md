# PhotoGoGo 2.0.39 selective archive release

This release keeps PhotoGoGo library metadata in staging and adds reviewed archive selection through the existing Transfer and core Jobs workflow.

## Behaviour

- Independent All / Minimum rating / Marked for Google Photos / None rules for Originals, B&W, Enhanced, Crops, Cropped B&W and Cropped enhanced.
- Default: all non-trash originals and generated versions checked locally for Google Photos. An upload or connected Google account is not required.
- Separate video, source-original, companion-sidecar and library-metadata controls. PhotoGoGo caches, preview proxies, logs, backup images and temporary work remain excluded.
- All-staging or event/folder scope; preview totals, selected bytes, per-file reasons, search, include/exclude filtering and pagination. Changed rules or meaningful library changes require a new native preview.
- Single-use native preview admissions, strict root/path/link/depth checks, bounded preview memory and native source revalidation. Existing archive files are retained when rules change.
- Current source bytes are hashed before deduplication. Verified same-filesystem temporary copies publish without replacing existing files; renamed conflicts now participate in copying. An archive lease coordinates writers.
- The archive keeps its own selection receipt and checksum records. A selection receipt records reviewed intent, not completed copying. Core Jobs continues to own transfer and separate verification jobs.

## Validation

The implementation passed 308 native tests (including 20 archive checks), zero failures, with 23 existing opt-in tests ignored. Ten archive browser regression groups, TypeScript, production frontend build and independent read-only safety review passed. These checks use generated local fixtures and deterministic browser command adapters, not user media, a live NAS transfer or Google account operations.

Detailed implementation evidence: [archive-transfer-validation.md](archive-transfer-validation.md).
User workflow: [archive-transfer.md](archive-transfer.md).

The release changes the application version to 2.0.39; dependencies and managed FFmpeg/metadata runtime payloads are unchanged. Source, installer inspection and delivery receipts are added after packaging.

## Rollback

The previous 2.0.38 EXE and MSI remain available. No staging metadata migration or credential reset is required by this feature. Return to 2.0.38 if deployment testing finds an issue; its older archive command does not provide these selection controls. Existing archived files are not deleted or reconciled by the new selection rules.

## Deployment check

Install either Windows x64 package, then open Transfer → Transfer to Archive. Preview a small event with a rated/unrated original, a trash-marked original and one Google-selected B&W. Confirm the included/excluded reasons before queueing. Check the core transfer job and run Queue Verify Job. Staging should retain its metadata. The archive should contain the selected media and its own `_transfer_manifests` records, with library metadata absent unless explicitly enabled.

## Installer receipts

Built source: 3d616ff2c662b2c17df8fae99842cb981fb4eec0.
Build ID: 20261026T085302443Z-3d616ff2+local, retained exactly as emitted. Both normal and release-user Git views were clean during the build; the literal +local stamp is not rewritten.
Inspection: test-output/release-2.0.39-inspection-20261026T090116626Z/report.json.
Standalone application SHA-256: 95FBDBF07BCEF544BAD4161CBF29F744D59F63D52E2A866C04F6E54E79AB1646.

- EXE: PhotoGoGoV2_2.0.39_x64-setup.exe; 71,238,203 bytes.
  SHA-256: B8AD1F9E8A5C187B95F05D77B4153453C9C91E7755B493BF28928EF2706A10AC.
- MSI: PhotoGoGoV2_2.0.39_x64_en-US.msi; 92,128,531 bytes.
  SHA-256: 54FD16E2A004F002B6DBA53DBCC60E15D9FB6A36E1192327A194BC7B82AF1879.

Both unsigned Windows x64 packages passed extraction without installation. Application bytes match the standalone executable apart from the expected three-byte Tauri bundle marker. All 2,205 metadata runtime files and the managed FFmpeg payload/manifest match; the relocated metadata runtime executes without PATH.
MSI UpgradeCode: {9CBA7A69-EDA0-5480-A421-9DC9AD265A65}, unchanged from 2.0.38.

Unchanged FFmpeg corresponding source: 49,570,807 bytes; SHA-256 27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8.
[Existing source delivery](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792900657737419). Managed runtime licence/source materials remain included.

The fresh 2.0.39 archive browser regression run passed all ten groups after the version bump. Functional native code is unchanged from the implementation validated by the 308-test suite. No installation, live NAS copy, Google account upload or user-photo mutation was performed by this release task.

## Verified GitHub and Slack delivery

The installer-receipt commit c34d330df59747c048c5d80f5d6bd58c90468f0e was atomically pushed to GitHub master and SWG/selective-archive, with annotated tag v2.0.39. Remote read-back confirmed both branch heads and the peeled tag at that commit. The built source remains 3d616ff2c662b2c17df8fae99842cb981fb4eec0; subsequent commits record delivery evidence only. Another chat's older local master checkout was left untouched.

Published to GoggoVille #swghermes (C0BDK1DDZTM) using the Personal connection:

- EXE: 26 October 2026, 20:06:14 AEDT; timestamp 1793005574.718539; file F0CC42M06CA. Windows HTTP upload acknowledged HTTP 200 and exactly 71,238,203 bytes.
  [Release post and EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793005574718539).
- MSI reply: 26 October 2026, 20:08:56 AEDT; timestamp 1793005736.922239; file F0CBYTA3QVB. Windows HTTP upload acknowledged HTTP 200 and exactly 92,128,531 bytes.
  [MSI alternative](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793005736922239).

Exact local size and SHA-256 were checked immediately before each upload. Complete thread read-back confirmed both file IDs/names, captions, checksums and testing instructions, with no pagination remaining. This is receipt/attachment metadata verification, not an independent download/hash comparison of Slack-hosted bytes. No duplicate release post or file was created.

Deployment testing remains with Stuart: install either package when the app has no active jobs, preview a small event and run transfer plus verification. No user-PC installation, active-job interruption or live NAS archive transfer was performed by this task.
