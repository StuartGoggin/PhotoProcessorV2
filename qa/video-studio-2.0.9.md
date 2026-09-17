# Video Studio 2.0.9: job diagnostics

Installer: `release/PhotoGoGoV2_2.0.9_x64_en-US.msi` (8,871,936 bytes).
SHA-256: `D2972B86604742A476686788B06F655805C38BC324551EA3B236E1F39BB9B1E5`.
MSI ProductVersion verified as 2.0.9; release-copy checksum matches the packaged build. Not installed automatically.

## Findings

At diagnosis the app process was alive, but no FFmpeg/ffprobe process existed. The saved request still said `analyse shake`, and its motion-analysis file had been written. The 2.0.8 implementation did not persist live process identity or progress timestamps, so the exact wait could not be established from its records.

One possible hang was the unconditional join of stdout/stderr pipe-reader threads after process exit. Inherited handles can keep a pipe open after its encoder exits. The replacement uses regular on-disk process logs and direct child-status polling; it does not join pipe readers. This removes that waiting path without claiming it was conclusively the cause of the existing stalled process.

## Delivered diagnostics

- Separate persistent log folder per Studio attempt, including retries, under app data `studio-jobs/logs/<job-id>`.
- Timestamped queue/state/control events, application version, output profile, destination, exact encoder arguments and working directory.
- Encoder PID, start and exit events, exit status, elapsed time, five-second process checks and thirty-second progress summaries.
- Full FFmpeg/LMMS stdout and stderr retained independently of temporary render work directories.
- Verified clip paths, checksums, output format/duration, final output paths and detailed failures.
- Bounded in-memory event list and bounded log tails in the UI; full files remain accessible through Open log folder.
- Attempt timestamps, retry links, historical-error labels and overdue heartbeat/progress warnings.
- Unexpected render-worker panics are converted into failed jobs instead of leaving an indefinitely running request.

Logs are local and include media paths and encoder arguments, not AI API keys. Review paths before sharing logs publicly. Raw logs are retained, not automatically deleted.

Old attempts cannot gain missing diagnostics retrospectively. Resume saved render creates a new fully logged attempt. Close the old app and install the update to replace its running code; saved interrupted requests can then be resumed. Unfinished encoding/analysis may need to run again.

## Verification

- Twelve native unit tests passed, including bounded log-tail reads and non-zero process exit/stderr capture with PID clearing.
- Nine frontend workflow tests and the production frontend build passed.
- Browser checks passed for detailed-log expansion, returned log contents, overdue heartbeat warning and log-folder button, alongside the existing Studio workflow checks.
- Real-camera 4K/50 fps sample with balanced stabilisation, titles and assembly passed using the file-backed process runner. Its persistent log was inspected for actual command/PID/exit events.
- Restart/reuse/music-mix regression passed.
- LMMS generated audible 48 kHz stereo audio through the new runner.
- Standard stabilisation/replay/cache/silent-preview smoke test passed through the new runner.
- Whitespace check passed. No paid AI calls were made; the user's full-length clip was not rerendered.
