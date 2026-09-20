# Device-aware imports 2.0.12 validation

Validated on the Windows build PC on 20 September 2026. This report records the
source validation; it is not a claim of render-PC acceptance. Commit, installer
checksums and delivery details are recorded separately in the local build receipt.

## Red/green admission check

The existing whole-job import gate was first placed behind the admission module
used by `run_import`, retaining one-job semantics. Running
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import.ps1`
failed `separate_card_starts_while_same_card_waits` with:

```text
card B must start while A1 runs and A2 waits
test result: FAILED. 0 passed; 1 failed
```

After source-aware admission, the same production module test passed. Additional
tests cover the four-source cap, overlapping disks/folders, unknown topology,
exclusive reprocessing, cancellation, paused waiters and permit release.

## Passing automated checks

- 39 native import tests passed, including Windows device discovery, staged-copy
  integrity, admission, session locking and cross-job protocol integration.
- Full native test executable: 85 passed, seven ignored by default. The isolated
  Studio clear/recovery test additionally passed. The child-only import OS-lock
  probe is invoked automatically by its parent integration test.
- Cross-job integration suite repeated ten times: all ten runs passed.
- Frontend/model/SSR: 10 import tests, 10 Studio scheduler tests and 12 Studio
  workflow tests passed.
- Tracked diff whitespace check passed.
- No diffs in the Studio scheduler, telemetry, hardware admission, video pipeline
  or Video Studio page implementation files.

## Independent review and resolutions

- Shared duplicate claims now contain verified destination paths only; stale,
  changed, removed and unreadable candidates cannot silently skip a source.
- Publication lock admission checks pause/abort without sleeping while holding
  the shared mutex. An aborted waiter cannot publish after it gets the lock.
- Paused queued requests withdraw their ticket and rejoin on resume, avoiding a
  same-device/exclusive head-of-line barrier. Admission handles the control race
  without entering a blocking pause helper while retaining a queue ticket.
- Filename reservations release on every exit via an owned guard.
- Throughput sampling spans file boundaries instead of missing short photos.
- Expensive existing-destination candidate scans happen outside the shared
  publication mutex; a selected duplicate is revalidated before skipping.
- Non-Windows conservative identity uses a volume/device-level identity rather
  than a per-file path. Unix-specific tests require a Unix test environment.

## Limits of this evidence

These tests exercise production scheduler/session/copy/naming interfaces; they
do not drive an entire import through a live Tauri UI. No real multi-SD-card or
RTX2060 performance measurement was made on this host. The five media tests that
need FFmpeg/LMMS were not run, nor was the Playwright browser suite (Playwright is
not installed here). Distinct physical disks may still share a USB bus.

Use [the acceptance procedure](../docs/device-aware-imports.md) with the same cards,
quality settings and separate fresh NVMe test destinations to measure wall-clock
improvement and verify unchanged video operation on the render PC. Installer
checksums and packaging results are recorded separately in the local build receipt.
