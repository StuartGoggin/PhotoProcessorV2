# PhotoGoGo 2.0.29 - import transfer priority

## Change and safety boundaries

Timeline video motion previews are off by default for new and legacy settings. Enable them explicitly under Settings > Timeline Video Preview MP4. Existing preview files are retained, and original videos and full-resolution snapshot exports are unchanged. Import and cleanup no longer start optional preview generation; background preparation yields to queued, running or paused imports. Already-running encodes finish naturally.

Normal imports overlap the next source copy with independent verification/publication of the previous destination. There is still one reader per physical source card and at most two unpublished temporary files per card (up to eight across four admitted cards). This is a file-count bound, not a byte quota. Existing streaming MD5, independently verified destination MD5, duplicate handling, cancellation, source admission/session lifetime and no-overwrite publication remain intact. Reprocessing retains its existing scheduling policy.

The implementation commit is `0d3770009daa3d4109262a556fe49a1b1032b188`. Detailed source-level evidence and repeat commands are recorded in `qa/import-transfer-priority.md`.

## Validation

- Native library: 162 passed, 0 failed, 20 ignored. Ignored entries include opt-in media/GUI tests and subprocess-only probes; they are not included in the pass count.
- Focused native import suite: 43 passed, 0 failed, 1 child-only probe entry ignored.
- Standalone pipeline/safety suite: 26 passed, 0 failed, 2 child-only probe entries ignored; parent tests explicitly execute the bounded panic probes.
- Import UI/model: 10 passed. Browser regressions checked legacy default-off, disabled controls, import transfer priority, hover opt-out, saved opt-in/out and retained settings through real React controls with a synthetic native adapter.
- TypeScript and the production frontend build passed. Existing non-blocking Browserslist-age and bundle-size warnings remain.
- Bounded independent reviewers found no outstanding production or test-runner blocker.

The sequential implementation failed the overlap regression before the bounded pipeline passed it. A native integration test proves source-copy/destination-MD5 overlap with a handshake, and checks duplicate outcomes, source/destination checksums and cleanup. These synthetic tests do not claim a particular throughput improvement on the user's SD card or reader.

Installer extraction, upgrade identity, payload hashes, media/runtime verification, GitHub ref read-back and Slack delivery are separate release-stage checks recorded in the delivery receipt. They are not implied by the source-level tests above. The Windows test packages remain unsigned; the optional offline face runtime is omitted, consistently with the previous release.

## Acceptance and rollback

Let active work finish, save existing projects/sessions and close PhotoGoGo normally before installing. No installation, SD-card operation or render interruption is performed by this release workflow.

1. Open Settings and confirm timeline motion previews are off; verify existing originals and full-resolution snapshot exports are unchanged.
2. Import a representative unchanged card into a fresh empty NVMe staging folder. Check imported/skipped/error totals and independent verification, and compare elapsed wall time against 2.0.28 using the same files and a different fresh destination.
3. Enable motion previews deliberately and confirm timeline hover previews work when imports have finished. Disable them again if transfer-only operation is preferred.

Retain the 2.0.28 installer and pre-upgrade settings/projects for rollback. No original media or existing preview sidecars are deleted. Independent optional preview workers are not globally serialized, and disk/reader/CPU contention can still limit real throughput.
