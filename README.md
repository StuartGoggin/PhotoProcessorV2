# PhotoGoGo V2

A desktop photo management workflow app built with [Tauri](https://tauri.app/) (Rust backend) and React + TypeScript frontend.

## Features

| Page | Description |
|------|-------------|
| **Import** | Copy photos from SD card to local staging, renamed by EXIF date |
| **Post Process** | Focus detection, CLAHE enhancement, B&W conversion, MP4 stabilization, plus task-specific cleanup jobs for generated results |
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
