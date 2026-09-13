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
4. Choose per-clip Gentle/Balanced/Strong two-pass vid.stab stabilisation and framing.
   Stabilisation happens before titles and recaps. Edge-safe zoom is not a fixed
   crop cap; maximum-frame mode may show borders. Compare previews before approval.
   **Export this fragment only** creates a clean full-clip export without titles
   or recaps, using that clip's stabilisation settings.
5. Render a 720p clip or replay preview, review each included clip, then queue the
   final 720p, 1080p, or 4K video. Original audio is retained, and replay audio is
   slowed with pitch preservation. Silent sources receive a silent audio track.

Projects autosave locally; **Save snapshot** creates a portable JSON edit recipe
(source media paths remain absolute). Existing snapshots cannot be overwritten.
Every render creates a unique folder containing the video, project snapshot and
verification record. Originals and previous exports are never overwritten.
Disk-space and FAT32 size checks run before encoding; final frame counts and
duration are checked before publishing the output. Failed/cancelled runs remove
their temporary media but retain the project snapshot for diagnosis.

Background progress remains visible when changing pages. Pause takes effect at
the next processing boundary; cancel stops active FFmpeg. Keep the app open:
jobs are in-memory and do not resume after exit. Exports open in the system player.

Optional **AI review** sends only the displayed sampled frames to the OpenAI API
after explicit confirmation. Supply your own API key (kept in memory, not saved)
and an image-capable model; API usage may incur charges. AI suggestions never
automatically approve, exclude, or change footage. Sparse frames can miss brief
drops and cannot establish penalties: watch the original and verify every recap.
The entire editing/rendering workflow also works without AI or an API key.

Video Studio requires FFmpeg and ffprobe, with drawtext and vid.stab for titles
and stabilisation. Existing Post Process folder jobs retain their behaviour.

Tests: `cargo test --lib --manifest-path src-tauri/Cargo.toml video_studio::tests`.
To include the synthetic end-to-end render test, set `PHOTOGOGO_FFMPEG` to the
FFmpeg executable and append `-- --include-ignored --nocapture`. Set
`PHOTOGOGO_STUDIO_TEST_DIR` to the repo's ignored `test-output` folder to retain
synthetic results there for visual inspection; otherwise they use the system temp folder.

## Development

MP4 stabilization requires an FFmpeg build with the `vidstabdetect` and `vidstabtransform` filters. Running [run.ps1](run.ps1) now bootstraps a repo-local Windows GPL build into `tools/ffmpeg/bin/ffmpeg.exe` and exports `PHOTOGOGO_FFMPEG` automatically. If the detected build also exposes `h264_nvenc`, PhotoGoGo will use NVIDIA H.264 encoding for stabilized outputs.

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
npm run release

# Option B: place src-tauri/resources/face-scan-bundle.zip, then run
npm run release
```

## Code Quality

```bash
# Lint (requires: npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-react-hooks)
npx eslint src/

# Format
npx prettier --write src/

# Rust checks
cd src-tauri && cargo clippy
```
