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

Projects autosave locally; **Save snapshot** creates a portable JSON edit recipe
(source media paths remain absolute). Existing snapshots cannot be overwritten.
Every render creates a unique folder containing the video, project snapshot and
verification record. Originals and previous exports are never overwritten. Verified
fragments are retained under `.photogogo-video-studio-cache`, grouped by resolution
and frame rate; filenames include the source name, format, and settings signature.
Only matching source bytes, output format, stabilisation/framing, title, and replay
settings reuse a fragment, so title-only edits retain the expensive stabilised base.
Each cache MP4 also needs its matching verification record—partial or orphaned MP4s
are never reused. Disk-space and FAT32 size checks run before encoding; final frame
counts and duration are checked before publishing the output. Renders stay in a
`.partial` folder until their video and verification record are complete, then the
whole folder is renamed atomically. Failed/cancelled work is therefore never shown as
a completed render.

The production queue shows active clip tasks, selected encoder, CPU thread budget,
FPS/playback speed, approximate ETA, elapsed time, and cache reuse. Reorder waiting
jobs, pause/resume, cancel, retry, or retry using CPU. Pause finishes active FFmpeg
steps, then releases capacity at the next boundary; Cancel interrupts active FFmpeg.
Background progress remains visible when changing pages. Keep the app open to
continue processing. Recipes and job history are saved in the app configuration
folder (`video-studio-queue.json`, at most 100 retained recipes). After a restart,
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

Normal imports copy into a private `.photogogo-import` directory alongside the
destination date folder's media, flush the temporary file, and verify its size
and MD5 against the source before publishing its final filename. Publication
never replaces an existing destination. A failed copy removes its temporary file;
after a forced exit, the next attempt replaces its matching orphan `.partial` file.
Completed files are detected by their actual content, even without a checksum
sidecar. Existing sidecars are treated as hints and checked against the media bytes.

Import jobs are serialized in the application. A filesystem lock also prevents
two updated app instances from importing into the same staging root simultaneously;
the OS releases it when a process exits. Pause/Abort still takes effect between
files, including verification. Source and staging folders must not be nested.
Verification adds disk reads and can make imports slower on removable drives.

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
