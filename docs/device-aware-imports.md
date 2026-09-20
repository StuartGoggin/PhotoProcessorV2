# Device-aware photo imports

## Scheduling

Normal imports use one sequential copy/checksum worker per physical source device,
with at most four source jobs admitted. Different source devices may import into
the same NVMe staging folder concurrently. A waiting second job on card A does not
block a ready job on card B. This is an import-only scheduler: Video Studio and
post-processing CPU/GPU worker/thread policies are unchanged.

Windows source paths are resolved to their mounted volume and physical disk
extents, not grouped by directory name or drive letter. Partitions and aliases on
the same disk share a lane. Unknown topology uses conservative serial admission.
Distinct disks are not proof of independent USB-controller bandwidth.

Mounted-media identity is captured before a queued job is accepted, checked again
at admission, and checked on each actual source file before and after copying.
Missing/replaced cards fail safely and must be reselected. Identity is ordinary
volume GUID/serial information, not a cryptographic fingerprint of a card.

Paused queued jobs withdraw their admission ticket. Pausing an already admitted
job retains its source lane and open-file ownership; it does not start another
read against that card. Abort is checked between copy chunks and while waiting
for publication. Reprocess-existing jobs remain globally exclusive with imports.

## Copy and publication safety

Each normal source file is streamed once into a uniquely owned temporary file on
the destination using a 1 MiB buffer. MD5 is computed from those same bytes. Small
EXIF/metadata reads may additionally be needed; there is no separate full-file
source checksum pass. The destination temporary file is flushed and independently
checksummed before final publication. Windows denies source writes during copying
and destination writes while a verified temporary file awaits publication.

Jobs targeting the same canonical staging root share a session that owns the
existing exclusive `.photogogo-import.lock` OS lock. Other app instances using
that root must wait. Within the session, source reads are independent and naming,
content claims and final publication are coordinated. Nested staging scopes in
the same app cannot run concurrently. Do not use different overlapping staging
roots in separate app instances; use one canonical staging root for the cohort.

Only completed, verified destination files enter the shared content registry.
Duplicate candidates are checked against their actual bytes. The expensive scan
of pre-existing same-size candidates runs outside the shared publication mutex;
the chosen candidate is checked again before a duplicate is skipped. Large
equal-sized collections can still spend time verifying existing NVMe files.

Publication never overwrites an existing destination. Cancellation/failure removes
only that stream's unpublished temporary file and leaves source media untouched.
On first use of each destination parent in a new exclusively owned session,
precisely named abandoned `stream-<pid>-<timestamp>-<counter>.partial` files may be
removed. Active streams are not swept; legacy partials and user files are retained.

Concurrent copies of already archived files do temporary NVMe writes before
duplicate detection; this trades fast destination I/O for avoiding another slow
card read. Up to four files may be staged at once, so staging needs free space for
those files. Full/failed destinations fail the copy without publishing it.

## UI

The queue, job tiles and console show source identity, waiting reason and phase
(copying plus checksumming, verifying destination, or publishing). Source-read
throughput is distinct from effective completed-file throughput. Combined source
throughput only includes running copy phases with known physical identities; it
does not sum stale, paused, verification or unknown-device measurements.

## Validation commands

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import.ps1 -Case import_safety
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import.ps1 -Case import_devices
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import.ps1 -Native
node scripts/test-import-ui.mjs
node scripts/test-video-studio-ui.mjs
node scripts/test-studio.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-video-studio.ps1
```

The concurrent integration tests use the actual admission, staging-session,
streaming-copy, destination-verification and filename-reservation interfaces.
They are not physical SD-reader benchmarks or full Tauri UI-driven imports.

## Render-PC acceptance

1. Keep the source cards unchanged. Select a fresh, empty test staging folder on
   the NVMe; do not delete or overwrite an existing archive for a benchmark.
2. With the earlier installer, record elapsed wall time and imported/error counts
   for the chosen cards/files. Record source-read speeds separately if available.
3. Close the app after work finishes, install this version, then use another fresh
   staging folder and exactly the same cards/files. Queue card A, another folder
   from A, and card B. A and B should run together; the additional A job must wait.
4. If only two cards fit at once, wait for a card's import to complete before
   removing it. Insert and explicitly queue the next card. Never reuse a queued
   request for replacement media.
5. Compare total wall time, checksums, imported/skipped/error counts and current
   source-read rates. Do not infer performance from aggregate CPU/GPU usage.
6. Run a representative Video Studio job with unchanged settings and confirm its
   scheduling/encoding still behaves correctly. Concurrent imports can still
   compete for physical disk/CPU bandwidth; their admission does not use or alter
   the video scheduler's worker/thread reservations.

No real multi-card throughput improvement is claimed until this comparison is
performed on the user's reader, cards and destination drive.
