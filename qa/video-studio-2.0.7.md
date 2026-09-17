# Video Studio 2.0.7 verification

Installer: `release/PhotoGoGoV2_2.0.7_x64_en-US.msi` (8,818,688 bytes).
SHA-256: `4380FC7674CA9328CA47BB11614DF8651FB419BB04E8DDCE95B6BC4F0F018F6C`.
Optimized native build and MSI packaging succeeded; the executable reports 2.0.7.
The release copy checksum matches the build artifact. Older installers were preserved.

## Delivered workflow

- One output profile controls individual clips and final video: resolution, FPS and target bitrate.
- Individual and batch clip preparation feed an automatic prepare/reuse/assemble operation.
- Clip rows expose saved format, outdated/missing outputs, active jobs and interrupted work.
- Studio jobs appear in the app Jobs panel and persist their request snapshots and completed clips.
- Restart recovery is explicit: Resume saved render rechecks assets and reruns unfinished steps.
- Optional AI direction uses sampled clip stills plus a creative brief. LMMS renders a local, editable three-track synth arrangement; existing music files remain supported.

## Checks performed

- TypeScript and production Vite build passed.
- Nine frontend workflow unit tests passed, including stale results after edits, missing outputs, interrupted status and legacy project migration.
- Nine native Studio unit tests passed.
- Headless Microsoft Edge checks passed at desktop and 900px width: individual dispatch, approval invalidation, resolution/FPS/bitrate propagation, final dispatch, music disclosure and no horizontal overflow. Desktop APIs were mocked for this UI test.
- Real FFmpeg recovery test passed: render a clip with title and replay, reload its checkpoint from disk after clearing in-memory state, reuse the identical output path, assemble at 720p/30fps, reject mismatched settings, and mix audio.
- Real LMMS 1.2.2 test passed: generated self-contained project rendered audible stereo 48 kHz WAV (mean -25.7 dB, peak -12.3 dB).
- Real FFmpeg stabilisation/title/replay/cache/preview smoke test passed on rerun. Its first run ended with an intermittent FFmpeg access-violation exit; the isolated stabilisation check and full rerun succeeded. This external-tool failure was not reproduced or claimed fixed. Failed requests can be retried without losing verified work.
- `git diff --check` passed.

## Boundaries

- No paid live OpenAI request was made. Consent, direction validation and frontend flow were checked; live model behaviour remains dependent on the supplied API credentials/model.
- Recovery was exercised by loading real disk checkpoints after discarding memory, not by forcibly terminating an installed app.
- The arranger uses tempo, key/chords and section energy; genre and instrument suggestions do not replace its fixed synthesizer palette. The saved LMMS project can be refined manually.
- Bitrate is an encoding target, not a guarantee of exact file bitrate. Previews are intentionally 720p/4 Mbps.
- Requires working FFmpeg/ffprobe; LMMS is separately installed for generated music. Installer does not bundle these tools.
- Jobs lost before this version cannot be reconstructed. New jobs are persisted. Source and cache/output files must remain available; only unfinished work is repeated.
- The installer is built, not silently installed over the user's current installation.
