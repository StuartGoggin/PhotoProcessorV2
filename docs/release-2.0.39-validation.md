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
