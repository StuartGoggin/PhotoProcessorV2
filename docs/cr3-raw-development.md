# Canon CR3 originals and RAW Development

Release: PhotoGoGo 2.0.42. Engine: the separately bundled, pinned RawTherapee 5.13 CLI. Canon software, an external editor and a separate RAW installation are not required.

## Workflow

1. Import original CR3 files into staging as usual. Photo Lightbox displays their embedded camera rendering for quick review. This image is a reference preview, not a developed RAW export.
2. Open **Photo Process → RAW Development**, expand the controls, choose the event folder and explicitly find its RAW originals. Choose all, non-trashed, a minimum rating, or selected originals. Scans return up to 1,000 picker entries and report a larger batch total; select a smaller event folder for individual overrides in a large shoot.
3. Start with **Natural**. **Neutral** removes the optional tone/detail treatment; **High ISO** is a conservative starting recipe, not a claim that every camera/ISO mode has been validated. Adjust white balance, exposure, highlight compression, shadows, black point, contrast, saturation, curve, edge sharpening and noise reduction.
4. **Generate preview** explicitly. Use the draft to compare treatment, then the full-resolution preview to inspect detail at 100%. The histogram and clipping indications describe the rendered display, not recoverable sensor data. Browser Save Image is disabled on preview comparisons to prevent accidental thumbnail exports.
5. Select colour development, independent B&W, or both. Choose high-quality full-resolution sRGB JPEG or 16-bit TIFF, then queue the core **Jobs** task. Pause takes effect between originals; Abort terminates an active decode. Final exports always decode the RAW, even when the Lightbox reference is a camera JPEG.
6. Refresh Photo Lightbox after the job. JPEG developments appear as versions of their RAW master. TIFF exports are beside the original and available to archive/export; this release's Lightbox comparison panels show JPEG versions.

The untouched `.cr3` stays in staging. Outputs have recipe-specific `_raw-developed-…` / `_raw-bw-…` names. Repeating an unchanged job reuses verified outputs. Changed settings create a new generation, preserving earlier files and their recorded lineage.

## Settings have three deliberate scopes

- **Job defaults** are saved on this machine and apply to the queued batch.
- A **saved per-photo override** lives in the event's `.photogogo-raw.json`. Enable use of photo overrides when queuing if those should supersede the batch defaults. Previewing or recalling a recipe does not save an override.
- **Recall last applied recipe** loads the last successfully applied treatment into a draft. Save it as an override to use it in later jobs. Discard leaves both the saved override and the batch defaults unchanged.

**Auto levels** calculates exposure, black point, contrast and highlight compression. Those four manual controls are disabled while it is on; their saved values return when it is switched off. It is not an additive automatic-plus-manual EV mode. Natural defaults to recorded exposure and as-shot white balance; an underexposed original may need exposure adjustment or explicit Auto levels.

RAW B&W runs independently from the source RAW through the engine's high-precision pipeline. It never reads the developed colour JPEG. Shared white balance/exposure/tone settings apply to both branches; B&W has its own curve/detail controls. Its controls use the RAW engine, so their numerical effect differs from the existing JPEG job's CLAHE processing.

## Review, selection and archive safety

RAW plus camera JPEG is paired only when camera model, serial and exact capture timestamp/subseconds identify one unambiguous pair in the same folder. Different filenames are allowed. Missing proof or ambiguous duplicates leave separate entries visible. A source selector makes the currently shown physical version explicit. Capture rating/trash is anchored to the RAW entry; Google Photos selection remains specific to the displayed physical version.

Generated JPEG ownership comes from the manifest, not a guessed filename suffix. Retired generations remain generated files and are not offered as fresh Originals. Existing JPEG Enhance/B&W jobs do not process RAW-owned outputs as new masters. A corrupt manifest or changed/ambiguous recorded output blocks processing/transfer rather than silently losing lineage.

The small `.photogogo-raw.json` remains with staging for revisiting recipes. Archive includes it only when library metadata backup is selected. A short-lived lock file coordinates concurrent operations; decoder scratch/settings/cache stay in an owned temporary workspace and are cleaned after use. Normal rating/trash tags and whole-event folder renames retain lineage. Reprocess/Collect Trash refuses individual moves that would strand saved RAW recipes or outputs; move the whole event folder instead.

Google Photos still requires a validated full-resolution JPEG version; it does not upload a RAW or perform implicit RAW conversion. **Preferred colour** can choose the supported camera JPEG over its RAW companion, or a developed colour version when present. The upload plan remains reviewable before transfer.

## Quality and performance boundaries

This release uses one multithreaded CPU worker, capped at eight OpenMP threads, 4 GiB worker memory and five minutes per decode. It does not claim NVIDIA acceleration. The bundled engine/profile/dependency identity is included in render reuse keys. Missing or altered runtime resources fail with repair guidance.

Provided R6 Mark II samples are landscape, ISO 160–320, with ordinary single-image CR3 containers. Recorded camera JPEG framing is 6000 × 4000; the validated engine exposes a slightly larger usable 6014 × 4016 image. Outputs are not resized to force camera-JPEG dimensions. Exact dimensions or a small margin bounded by recorded sensor dimensions are required. Portrait rotation is covered by an isolated orientation-metadata fixture; actual high-ISO, C-RAW/crop-mode and portrait captures still need representative testing. RAW burst rolls are explicitly rejected; extract their individual originals first.

Natural/Neutral/B&W/exposure, deterministic recipe reuse, true 16-bit TIFF, metadata/orientation, unchanged originals, no-overwrite collisions, portable ownership and cancellation are checked separately. Visual inspection covers detail, smooth bokeh and outer-corner crops. This does not establish calibrated colour accuracy, DPP matching or universal camera-mode coverage.

RAW-specific crop/straighten/lens-profile editing and semantic horse/rider masking are not in this release. JPEG crop remains available for ordinary JPEG workflows. Edge-limited sharpening is intentionally conservative; it cannot restore missed focus or remove motion blur.

## Bundled runtime and reproduction

The engine's GPL licence, original and dependency notices, exact engine source archive and per-dependency source URLs are installed under `tools/rawtherapee/`. Source access and replacement rights are retained. This is dependency/source evidence, not a claim of independent legal certification.

Pinned inputs:

- Official `RawTherapee_5.13_win64_x86_64_release.exe`: SHA-256 `d27df7ebde717c5efa114338a4b1cf1c426a439e5a1a92e142e87868cbe45383`.
- Official `rawtherapee-5.13.tar.xz`: SHA-256 `23bdff4b1817e1274c11a94b11d21cac59e9c1b1d209795d3194710ee73e77bf`.
- Portable `jrathlev/InnoUnpacker-Windows-GUI` release `ui_2_2_13`, `innounp-2.zip`: SHA-256 `10fce27b6344b7674d5625cc34afca1c88c12183d957c6d93e401097fa2556cd`. Extract the official installer with `innounp.exe -x -d<owned-scratch-directory> <installer>`; do not execute/install it. Copy its `{app}` contents into `src-tauri/tools/rawtherapee/`.

`scripts/raw-runtime-dependencies.lock.json` maps all 81 runtime DLLs by SHA-256 to 62 exact official MSYS2 binary/source packages, including historical GCC 16.1.0 and winpthreads matches. `audit-raw-msys-packages.ps1` and `read-raw-msys-package.cjs` inspect package metadata without executing DLLs; `collect-raw-runtime-notices.ps1` retains licence texts, including source-only notices for split FFTW/libidn2 packages. The lock and original source references, rather than whatever is newest upstream, define this release.

After collecting notices, run `prepare-raw-bundle.ps1`, then `verify-raw-bundle.ps1 -ForRelease`. The preparation keeps CLI/camera/ICC/DCP resources and notices, removes GUI/browser data, and supplies owned neutral/global settings needed by the CLI. `build-release.ps1` fails if this verified bundle is absent. Release package inspection reconstructs installed resource paths from MSI tables, verifies each resource, and performs a real RAW decode from each extracted installer with PATH empty. Neither installer is installed during inspection.

Upstream reference: [RawTherapee 5.13](https://rawtherapee.com/downloads/5.13/). The exact packaged source archive is authoritative for this binary; some CLI flags in general online documentation differ from the shipped version.
