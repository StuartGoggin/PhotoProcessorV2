# PhotoGoGo V2

A desktop photo management workflow app built with [Tauri](https://tauri.app/) (Rust backend) and React + TypeScript frontend.

## Features

| Page | Description |
|------|-------------|
| **Import** | Copy photos from SD card to local staging, renamed by EXIF date |
| **Post Process** | Focus detection, CLAHE enhancement, B&W conversion, MP4 stabilization, plus task-specific cleanup jobs for generated results |
| **Video Studio** | Reviewed full-clip assemblies, editable titles, slow-motion recaps, per-clip stabilization and background rendering |
| **Review** | Browse staging folder, rate (stars) and mark photos for deletion |
| **Tidy Up** | Move `{trash}`-marked files to a `Trash/` subdirectory |
| **Transfer** | Copy staging to archive (NAS), generate + verify MD5 checksums |
| **Settings** | Configure source, staging, and archive directory paths |

## Windows background previews

Version 2.0.13 fixes flashing console windows during import/staging preview
generation. Background FFmpeg thumbnails, FFprobe metadata and hover previews
run without console windows; captured errors and process exit status are retained.
Import/device concurrency and Video Studio scheduling are unchanged. Deliberately
opened VLC/Explorer windows are unaffected.

Regression: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-background-processes.ps1`.
This Windows desktop test uses a GUI-subsystem parent and synthetic console
helpers, not real media. It intentionally opens **one control console** to prove
the detector works; the background helpers must create none. A hidden-console
test parent can mask the original bug. Visual Studio C++ Build Tools is required.

## Tech Stack

- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **Backend:** Rust via Tauri 2
- **Image processing:** Rayon (parallel), EXIF parsing, MD5 checksums

## Project Structure

```
src/
  types/          API types (Rust-mirrored) + UI types
  utils/          Pure utility functions (fileNaming, etc.)
  hooks/          Custom React hooks (useSettings, useProgressListener, useReview)
  components/     Shared UI components (FileTree, ImagePanel, ProgressBar, StarRating)
  pages/          Page-level components (thin — logic lives in hooks)

src-tauri/src/
  utils.rs        Shared Rust utilities (MD5, base64, unique_dest, num_cpus)
  commands/
    settings.rs   load/save settings
    import.rs     SD card import with EXIF renaming
    process.rs    Focus detection, enhancement, B&W, MP4 stabilization
    transfer.rs   Archive copy + MD5 verify
    tidy.rs       Trash collection
    files.rs      File rename + image read (Review page)
```

## Video Studio

Video Studio is a separate page for repeatable training-video projects:

1. Add MP4 clips from the configured staging folder, reorder them, and exclude
   unrelated footage. Included source clips are retained in full in final renders.
2. Play originals and generate review frames to check team consistency. Record
   notes and add editable recap ranges, captions, and 25%, 50%, or normal speed.
3. Edit the opening title, subtitle/event date, clip titles, durations and chapters.
4. Choose per-clip Gentle/Balanced/Strong two-pass vid.stab stabilisation and framing.
   Stabilisation happens before titles and recaps. Edge-safe zoom is not a fixed
   crop cap; maximum-frame mode may show borders. Compare previews before approval.
     **Render clip** creates a standalone clip with its titles, stabilisation and
     recaps, using the project's output resolution, frame rate and bitrate.
4. Choose project defaults or per-clip Gentle/Balanced/Strong/Custom stabilisation.
   New projects use **Fast preset (one pass)** with Balanced strength: no separate
   camera-shake analysis pass. The deshake filter still estimates motion while
   processing each frame; a fixed preset cannot remove that necessary work.
   Fast framing uses mirrored edges plus an optional fixed 4% or 10% dimension crop.
   Mirroring/cropping can be visible on large movements. **Quality (two pass)**
   retains vid.stab for difficult footage; old projects keep their existing method.
   In Quality mode, edge-safe zoom is not a fixed crop cap and maximum-frame mode
   may show borders. Compare a preview before approving clips. Changing defaults
   and applying them to clips resets their review approval.
   **Export this fragment only** creates a clean full-clip export without titles
   or recaps, using that clip's stabilisation settings.
5. Render a 720p clip or replay preview, review each included clip, then queue the
   final 720p, 1080p, or 4K video. Original audio is retained, and replay audio is
   slowed with pitch preservation. Silent sources receive a silent audio track.
6. Optionally create background music: approve sparse still-frame analysis of the
     included clips and an optional creative brief, refine the musical direction,
     then choose **Generate soundtrack with LMMS**. A local synthesizer arranger
     converts tempo, chords and energy into a self-contained editable LMMS project
     and renders WAV audio in the job queue. Audio is attached automatically.
     The current arranger uses a fixed synth palette; genre/instrument suggestions
     are guidance for further editing in LMMS, not arbitrary audio-model generation.
     You can alternatively select an existing audio file and adjust music/original
     sound levels. AI analysis requires explicit upload consent and separately
     billed OpenAI API access; the key remains session-only.

Choose the output profile at the top: 720p, 1080p or 4K; 25, 30, 50 or 60 fps;
and a target video bitrate of 1–150 Mbps (actual bitrate varies with content).
Quick previews intentionally use 720p/4 Mbps. Clip rows show ready, queued or
outdated status and the last rendered format. Editing video settings invalidates
approval/readiness; notes, ordering and inclusion do not invalidate rendered media.
**Render pending clips** queues reviewed missing clips. **Render & assemble complete
video** prepares missing clips, reuses verified completed clips and stream-copies
the video into the final assembly, optionally mixing music. Reordering or changing
music does not require re-encoding unchanged clips.

Projects autosave locally; **Save snapshot** creates a portable JSON edit recipe
(source media paths remain absolute). Existing snapshots cannot be overwritten.
Every render creates a unique folder containing the video, project snapshot and
verification record. Originals and previous exports are never overwritten. Verified
fragments are retained under `.photogogo-video-studio-cache`, grouped by resolution
and frame rate/bitrate; filenames include the source name, format, and settings signature.
Only matching source bytes, output format, stabilisation/framing, title, and replay
settings reuse a fragment, so title-only edits retain the expensive stabilised base.
Each cache MP4 also needs its matching verification record—partial or orphaned MP4s
are never reused. Disk-space and FAT32 size checks run before encoding; final frame
counts and duration are checked before publishing the output. Renders stay in a
`.partial` folder until their video and verification record are complete, then the
whole folder is renamed atomically. Failed/cancelled work is therefore never shown as
a completed render.

Background progress remains visible when changing pages. Pause takes effect at
the next processing boundary; cancel stops active FFmpeg/LMMS. Jobs are saved under
the app-data `studio-jobs` directory before execution and after completed steps.
After closing/restarting, unfinished jobs appear as **interrupted**. Choose
**Resume saved render** in Studio or the app Jobs queue. This restores the original
request, checks source/output hashes and format, reuses verified clips/fragments,
and reruns unfinished work. It does not resume a partially encoded frame stream.
Keep source files and output/cache folders available; missing or changed assets
are rebuilt. Each retry creates a new output folder. Exports open in the system player.
The production queue shows active clip tasks, selected encoder, CPU thread budget,
FPS/playback speed, approximate ETA, elapsed time, and cache reuse. Reorder waiting
jobs, pause/resume, cancel, retry, or retry using CPU. Pause finishes active FFmpeg
steps, then releases capacity at the next boundary; Cancel interrupts active FFmpeg.
Background progress remains visible when changing pages. Keep the app open to
continue processing. Recipes and job history are saved in app-data `studio-jobs`.
The previous `video-studio-queue.json` format is migrated once and archived, without
discarding older saved requests. After a restart,
unfinished work is marked **Interrupted** and waits for explicit Resume; verified
fragments are reused. A queue lock prevents two app instances owning that queue.
On Windows, long-running video workers belong to a kill-on-close Job Object, so
closing/crashing the app also stops its FFmpeg children instead of orphaning them.
Recovery-file errors are shown, and damaged files are preserved for investigation.
Exports open in the system player.

**Maximum throughput** uses the available logical CPU budget and up to four FFmpeg
processes, shared with Post Process stabilization. **Balanced** leaves some CPU
headroom and uses fewer workers. Up to two projects dispatch work; CPU, estimated
RAM, source/output resolution and output-drive reservations bound concurrency.
CPU-heavy filters may not scale to every core, and I/O/verification can be the
bottleneck: 100% utilization at every instant is not a useful completion guarantee.

**Automatic hardware** tries NVIDIA NVENC, then Intel Quick Sync, then CPU encoding.
Selection requires a real bounded encode probe, not just an encoder name in FFmpeg.
Probe results are cached briefly. Stabilization/title filters remain on CPU;
GPU encoding is not a fully GPU-resident pipeline. A driver failure during a render
is visible in the log; **Retry using CPU** provides an explicit recovery path.
CPU encoding can also be selected before queuing a project and may be faster for
short, filter-heavy clips. Encoder choice is included in fragment cache signatures.

Optional **AI review** sends only the displayed sampled frames to the OpenAI API
after explicit confirmation. Supply your own API key (kept in memory, not saved)
and an image-capable model; API usage may incur charges. AI suggestions never
automatically approve, exclude, or change footage. Sparse frames can miss brief
drops and cannot establish penalties: watch the original and verify every recap.
The entire editing/rendering workflow also works without AI or an API key.

Optional **background music** sends sparse representative stills—not source video
or sound—to the OpenAI API after explicit confirmation. The API key is session-only.
LMMS renders the generated editable synthesizer score locally. MIDI export is also
available for manual instrument selection/editing. The selected WAV, MP3, FLAC, OGG, M4A, or AAC is never
modified; the final render loops and fades it to the edit duration while retaining
the chosen original-clip audio level.

Video Studio requires FFmpeg and ffprobe, with drawtext and vid.stab for titles
and stabilisation. Existing Post Process folder jobs retain their behaviour.
Soundtrack generation requires a local [LMMS](https://lmms.io/) installation.

Tests: `npm run test:studio` and `cargo test --lib --manifest-path src-tauri/Cargo.toml video_studio`.
For browser checks, run Vite on port 1431, then `npm run test:studio:browser`
(uses installed Microsoft Edge and a mocked desktop API; screenshots go to `qa`).
Ignored native tests `restart_assembly_smoke`, `lmms_audio_smoke` and `render_smoke`
exercise real media. Run separately with `--ignored --nocapture --test-threads=1`.
For native media tests, set `PHOTOGOGO_FFMPEG` to the FFmpeg executable.
Run all Studio tests with `-- --include-ignored --nocapture --test-threads=1`.
Set `PHOTOGOGO_LMMS` if LMMS is not installed at `C:/Program Files/LMMS/lmms.exe`. Set
Video Studio requires FFmpeg and ffprobe, with drawtext for titles, deshake for
Fast mode, and vid.stab for Quality mode. Post Process retains its two-pass method
but shares the bounded CPU/RAM resource pool.

Windows tests: `./scripts/test-video-studio.ps1` reuses the release build cache and
loads the MSVC environment. UI model tests: `node scripts/test-video-studio-ui.mjs`.
To include synthetic parallel/cache/quality/audio and cancellation render tests,
set `PHOTOGOGO_FFMPEG` to the FFmpeg executable and add `-Smoke`. Set
`PHOTOGOGO_STUDIO_TEST_DIR` to the repo's ignored `test-output` folder to retain
synthetic results there for visual inspection; otherwise they use the system temp folder.

`scripts/benchmark-video-studio.ps1` provides repeatable synthetic jitter and pan
comparisons, with frame/audio/source-hash checks and contact sheets. On the local
Intel Ultra 7 / Intel Arc test machine, two 8-second 720p clips took 10.12/10.45 s
using the former two-pass CPU path, 6.64/5.62 s with Fast CPU (1.52–1.86x faster),
and 7.98/7.13 s with Fast Quick Sync. These isolated two-thread results are not a
parallel-queue benchmark or a promise of equivalent stabilization quality on
real footage. NVIDIA could not be validated locally because this machine has no
NVIDIA device. Preview representative camera footage before choosing a preset.

## Restart-safe imports

Normal imports copy into a uniquely owned file in a private `.photogogo-import`
directory alongside the destination date folder's media. The checksum is computed
during that single full source read; the temporary destination is flushed and its
size/MD5 independently verified before final publication. Publication never
replaces an existing destination. A failed copy removes only its own temporary
file; a newly locked session cleans precisely identified abandoned stream partials.
Completed files are detected by their actual content, even without a checksum
sidecar. Existing sidecars are treated as hints and checked against the media bytes.

Independent source devices can import concurrently (maximum four), with one
sequential reader per device. Same-device jobs wait without blocking other cards;
unknown device topology falls back to serial imports. Source media is revalidated
at admission and per file. Reprocessing existing files remains exclusive. Shared
staging sessions retain the filesystem lock against other app instances using the
same staging root, while coordinating duplicates and final filenames internally.
Pause/Abort is checked during streaming and while waiting to publish; destination
verification finishes before the next control checkpoint. Source and staging
folders must not be nested. Video encoding/thread allocation is unchanged.

The queue shows source/device identity, waiting reasons, copy/verification phases,
per-source read rates and combined known-source throughput. See
[device-aware imports](docs/device-aware-imports.md) for safety details, limitations,
tests and the real-card benchmark procedure.

Old incomplete files created by earlier app versions are **not** automatically
deleted or overwritten; those need separate inspection. Do not run an older app
instance against the same staging folder, since it does not honour this lock.
The `.photogogo-import.lock` file is internal metadata and should be left in place.

Fast isolated copy/restart tests (no full Tauri build required):
`rustc --edition 2021 --test tests/import_safety.rs -o test-output/import-safety-tests.exe`,
then run `test-output/import-safety-tests.exe`. Create `test-output` first if absent.

## Development

Post Process MP4 stabilization and Studio Quality mode require `vidstabdetect` and
`vidstabtransform`; Studio Fast mode requires `deshake`. Running [run.ps1](run.ps1)
bootstraps a repo-local Windows GPL build into `tools/ffmpeg/bin/ffmpeg.exe` and
exports `PHOTOGOGO_FFMPEG`. Hardware encoders must pass an actual runtime probe.

Face recognition can be packaged without requiring end users to install Python. The production build can pull a prebuilt face bundle (Python runtime + wheelhouse) from a local zip path or URL.

```bash
# Install dependencies
npm install

# Run in dev mode (hot reload)
npm run tauri dev

# Build for production
npm run tauri build

# Build release with bundled face runtime (no manual Python install for end users)
# Option A: set once in your shell/session
$env:PHOTOGOGO_FACE_BUNDLE_SOURCE = "https://your-host/face-scan-bundle-win64.zip"
.\scripts\build-release.ps1

# Option B: place src-tauri/resources/face-scan-bundle.zip, then run
.\scripts\build-release.ps1

# Build a basic installer without the optional offline face-recognition bundle
.\scripts\build-release.ps1 -SkipFaceBundle
```

The release script performs a locked `npm ci` and passes `--locked` to Cargo, requires a working Rust MSVC
toolchain, and invokes npm through Node's local CLI rather than a potentially
misconfigured global npm wrapper. It writes Windows installer artifacts under
`src-tauri/target/release/bundle/`.

### Windows release prerequisites

- Node.js with npm (an LTS release is recommended).
- Rust's `stable-x86_64-pc-windows-msvc` toolchain and the Microsoft C++ Build Tools.
- Outbound HTTPS access to `registry.npmjs.org`, `static.rust-lang.org`, and the Rust crate registry.
- A face-scan bundle only when offline face recognition must be included. Use
  `-SkipFaceBundle` to create an installer without that optional feature.

The first successful release downloads the locked Node/Rust dependencies, so it
can take several minutes. Later releases reuse their local caches. The script
stops before compiling if Node dependencies or an active Rust compiler are not
available, instead of leaving a partial installer behind.

## Code Quality

```bash
# Lint (requires: npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-react-hooks)
npx eslint src/

# Format
npx prettier --write src/

# Rust checks
cd src-tauri && cargo clippy
```
