# Selective archive transfer

PhotoGoGo keeps the working library metadata in staging. **Transfer to Archive** copies the selection you review; it does not delete staged files or remove existing archive files.

1. Configure the staging and archive locations in Settings.
2. Choose all staging folders, or one event/folder including its subfolders.
3. Start with a preset, then choose an independent rule for Originals, B&W, Enhanced, Crops, Cropped B&W and Cropped enhanced: all, a minimum star rating, the local Google Photos checkbox, or none.
4. Leave **Exclude trashed photos and their versions** enabled unless you deliberately want them. This exclusion applies across photo rules. Videos have a separate inclusion switch.
5. Optionally retain source originals when selecting a generated version, camera/user companion sidecars, or supported PhotoGoGo library metadata. Caches, previews and temporary files remain excluded.
6. Select **Preview archive**. Review the counts and size by version, search the file decisions, and inspect the exclusion reasons. No files are copied during preview.
7. Select **Queue reviewed transfer**. It uses the existing transfer job in core Jobs, checksum records, duplicate handling and verification workflow. If the library changed, generate another preview; PhotoGoGo does not silently widen the reviewed selection.
8. Use **Queue Verify Job** to independently verify the latest archive transfer manifest.

“Marked for Google Photos” means the checkbox on that exact local Lightbox version. It does not require an upload, a Google sign-in, or cloud read-back. Rating rules follow the Lightbox catalogue, including the original's rating on generated versions.

Rules are remembered on the current machine. Folder scope and native preview tokens are not saved. Changing a rule, scope or location invalidates the preview. Changing rules affects future transfers only; it never cleans up previously archived files.

A selective archive is not a complete backup of staging. If you later delete staging, excluded originals and metadata will be unavailable. **Back up PhotoGoGo library metadata** is optional and defaults off; archive checksum/verification records remain available independently of that option.

Recognised library metadata includes Lightbox curation, event and staging tags, crop recipes, snapshot provenance and import manifests. It does not include caches, metadata backup images, temporary files, logs or account credentials. Camera/user XMP, AAE, JSON, DOP, PP3 and THM sidecars accompany selected media with a matching filename or stem; shared RAW/JPEG sidecars are retained when either matching original is selected. Unrecognised files and unresolved generated versions appear in the excluded preview for review.

Each transfer writes an archive-owned `archive-selection-*.json` receipt beside its checksum records in `_transfer_manifests`. The receipt records the reviewed rules and decisions; it is labelled `reviewed_selection`, not a claim that every selected file has already copied. The completed job and checksum manifest record the transfer outcome. Archive verification records are independent of the library-metadata option.

Archive jobs hash current source bytes before duplicate decisions; old staging checksum sidecars are not trusted for this decision. Each new destination copy is independently checksum-verified before it is published, and an existing file is never overwritten. A conflicting name receives a new name. Staging and archive must be separate folders, with neither containing the other. Unreadable scopes, unsafe links, oversized/deep scans and damaged selection metadata prevent a queueable complete preview.

Validation: `node scripts/test-archive-transfer-browser.mjs` exercises the real Transfer controls against a deterministic command adapter. Native planner tests separately validate filesystem classification, original/version matching and stale-plan safety. No live accounts or user photos are needed for the browser suite.

Run native regressions with `pwsh -NoProfile -File scripts/test-archive-transfer.ps1`; add `-AllNative` to run the full native suite. The runner disables debug symbols and bounds compilation to two workers to reduce temporary disk use. Reports and group logs are written under `test-output/archive-transfer-native`.
