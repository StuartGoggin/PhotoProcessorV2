# Selective archive transfer

PhotoGoGo keeps the working library metadata in staging. **Transfer to Archive** copies the selection you review; it does not delete staged files or remove existing archive files.

1. Configure the staging and archive locations in Settings.
2. Choose all staging folders, or one event/folder including its subfolders.
3. Start with a preset, then choose an independent rule for Originals, B&W, Enhanced, Crops, Cropped B&W and Cropped enhanced: all, a minimum star rating, the local Google Photos checkbox, or none.
4. Leave **Exclude trashed photos and their versions** enabled unless you deliberately want them. This exclusion applies across photo rules. Videos have a separate inclusion switch.
5. Optionally retain source originals when selecting a generated version, camera/user companion sidecars, or supported PhotoGoGo library metadata. Caches, previews and temporary files remain excluded.
6. Select **Preview archive**. Review the counts and size by version, search the file decisions, and inspect the exclusion reasons. No files are copied during preview.
7. Select **Queue reviewed transfer**. It uses the existing transfer job in core Jobs, checksum records, duplicate handling and verification workflow. If the library changed, generate another preview; PhotoGoGo does not silently widen the reviewed selection.
8. Leave **Archive transfer concurrency** on **Auto** for adaptive operation, or select a fixed limit of 1, 2, 4 or 8 files. This choice does not change the reviewed selection.
9. Use **Queue Verify Job** with an explicit scope: **Latest recorded transfer** checks that run's confirmed destinations; **Whole archive** checks the archive's master MD5 index. Whole-archive verification can take substantially longer.

“Marked for Google Photos” means the checkbox on that exact local Lightbox version. It does not require an upload, a Google sign-in, or cloud read-back. Rating rules follow the Lightbox catalogue, including the original's rating on generated versions.

Rules are remembered on the current machine. Folder scope and native preview tokens are not saved. Changing a rule, scope or location invalidates the preview. Changing rules affects future transfers only; it never cleans up previously archived files.

A selective archive is not a complete backup of staging. If you later delete staging, excluded originals and metadata will be unavailable. **Back up PhotoGoGo library metadata** is optional and defaults off; archive checksum/verification records remain available independently of that option.

Recognised library metadata includes Lightbox curation, event and staging tags, crop recipes, snapshot provenance and import manifests. It does not include caches, metadata backup images, temporary files, logs or account credentials. Camera/user XMP, AAE, JSON, DOP, PP3 and THM sidecars accompany selected media with a matching filename or stem; shared RAW/JPEG sidecars are retained when either matching original is selected. Unrecognised files and unresolved generated versions appear in the excluded preview for review.

Each transfer writes an archive-owned `archive-selection-*.json` receipt beside its checksum records in `_transfer_manifests`. The receipt records the reviewed rules and decisions; it is labelled `reviewed_selection`, not a claim that every selected file has already copied. The completed job and checksum manifest record the transfer outcome. Archive verification records are independent of the library-metadata option.

Archive jobs hash current source bytes before duplicate decisions; old staging checksum sidecars are not trusted for this decision. Each new destination copy is independently checksum-verified before it is published, and an existing file is never overwritten. A conflicting name receives a new name. Staging and archive must be separate folders, with neither containing the other. Unreadable scopes, unsafe links, oversized/deep scans and damaged selection metadata prevent a queueable complete preview.

Validation: `node scripts/test-archive-transfer-browser.mjs` exercises the real Transfer controls against a deterministic command adapter. Native planner tests separately validate filesystem classification, original/version matching and stale-plan safety. No live accounts or user photos are needed for the browser suite.

Run native regressions with `pwsh -NoProfile -File scripts/test-archive-transfer.ps1`; add `-AllNative` to run the full native suite. The runner disables debug symbols and bounds compilation to two workers to reduce temporary disk use. Reports and group logs are written under `test-output/archive-transfer-native`.

## Adaptive copying and verification

Each file passes through fresh source hashing, duplicate checking, copying, independent destination verification and checksum recording. These stages overlap between files: the next file can start before the previous one finishes. A small bounded buffer is used per worker rather than loading entire photos or videos into memory. No additional reader is launched simply to measure the network.

Auto starts with two active files and explores limits from one to eight. It measures useful verified bytes, including freshly verified duplicates, rather than trusting the advertised connection speed. Sustained improvements can increase the limit; regressions, errors or an unhelpful probe can reduce it. Pauses, an empty work queue and the final few files are excluded from learning comparisons. Large files need actual completions before a throughput decision can be made. Already active files finish safely when the limit decreases.

This is a bounded heuristic, not a guarantee of full network utilisation or an optimal limit for every file mix. A short run may finish before Auto has enough evidence to change its limit. Local storage, antivirus, source hashing, destination rereads, remote storage and connection latency can each limit throughput. Fixed limits remain available for repeatable comparison. The interface reports active stages, **Copied** and **Verified** counts, and separate copied-payload and useful-verified rates in MiB/s. Duplicates increase Verified without increasing Copied.

Pause and cancellation are checked between data chunks, while waiting for duplicate coordination, and before publishing a verified file. An operating-system network read or write already in progress remains subject to the operating system's timeout. The transfer log records `ARCHIVE_TIMING` stage totals for diagnosis; stage totals add concurrent worker activity and are not a wall-clock breakdown.

## Archive checksum records and recovery

`master_hashes.md5` is the cumulative archive index. A transfer always hashes current source bytes and independently verifies destination bytes before recording success. A matching old index row alone never skips verification. Legacy archives containing only `checksums.md5` retain that validated coverage when the master is first created. Existing files are never overwritten.

Before publishing a verified destination, PhotoGoGo durably records a recovery intent in `_transfer_manifests/archive-recovery.jsonl`. Confirmed work updates the master using a flushed atomic replacement, then writes a per-run `transfer-*.md5` manifest and `latest-transfer.json` pointer before retiring the journal. If recording fails, the job reports the error and retains recovery evidence. The next transfer or verification checks uncertain final destinations against the saved size and checksum before recording them. It does not delete mismatched user files or claim they are verified. Confirmed files do not need another recovery reread during ordinary completion.

Latest recorded transfer uses that explicit pointer, including a partial or stopped run, and never guesses from lexicographic filenames. A new run's manifest contains only its own confirmed destinations, including duplicates at their actual existing paths. Recovery from a previous run updates the master independently. A run with zero confirmed files has an empty manifest. If the latest pointer is absent or damaged, choose Whole archive or resolve the reported record problem; the app will not silently substitute an older run.

One archive transfer or verification holds an exclusive archive lock at a time. Malformed complete index/journal records, unsafe paths and documents larger than 256 MiB fail closed. Missing, inaccessible or differently sized candidates conservatively retain their existing rows; Whole archive verification can report these discrepancies. Only an independently observed checksum mismatch removes the exact stale expected row, with an `ARCHIVE_INDEX_MISMATCH` warning, while preserving the existing file.

These records are archive-owned operational records and remain present regardless of the optional staging-library metadata selection. MD5 is used for accidental copy corruption and duplicate checking; it is not an authenticity signature. Flush and atomic replacement requests improve interruption recovery, but durability through a NAS or server power failure depends on that storage system honouring those requests. Keep an independent backup of irreplaceable originals.

Validation separates simulated connection curves, local synthetic filesystem work and real storage measurements. Development tests never use a user's NAS or media. Actual gigabit/Wi-Fi throughput should be assessed on the deployment machine from a representative selected transfer and its job log.
