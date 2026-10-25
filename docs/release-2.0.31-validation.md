# PhotoGoGo 2.0.31 - non-destructive Lightbox cropping

## Release scope

Adds the approved cropping workflow from feature commit `3e6d4ae2a03c55210093c7a62b131d111f22a801`. Originals and their existing comparisons remain untouched. Crop saves create `_crop.jpg` and optionally `_crop_BW.jpg` / `_crop_improved.jpg`; repeat edits use the untouched source. The Lightbox has one original navigation stop with an Original/Cropped switch.

See [the cropping guide](LIGHTBOX_CROPPING.md) for corner/edge dragging, ratios, keyboard operation, regeneration choices and recovery behavior. Current Photo Process recipes are shared with the crop editor. Prior output settings are not guessed.

## Validation and evidence boundaries

Implementation validation passed **184 native tests (0 failed, 21 ignored)**, **14 Lightbox checks**, **10 Lightbox browser groups**, **13 existing Photo Process browser groups**, TypeScript and the production frontend build. The detailed [implementation checkpoint](lightbox-cropping-validation.md) records coverage and an earlier transient browser timeout that did not reproduce in isolated runs. The release gates rerun the applicable checks after versioning.

Tests use synthetic media; browser tests exercise actual React pages with native-command adapters. They do not establish real-camera colour accuracy, measured throughput or installation/upgrade behavior on another PC. Package inspection must independently verify the final MSI/EXE contents and upgrade identity before Slack publication. The separate release receipt records build/source commits, package hashes, verification results and Slack attachment read-back.

## Installation, limits and rollback

- Let active jobs finish, save projects/sessions and close PhotoGoGo normally before installing. This workflow does not install on the render PC, stop renders or change user media.
- Windows x64 packages are unsigned. Use either the setup EXE or MSI, not both. Keep the 2.0.30 installer for rollback; downgrading the app does not remove generated crop files.
- JPEG/JPG cropping only; no upscaling; quality 95. Original metadata remains intact in the untouched original. Newly encoded crop/processed files currently copy filesystem timestamps, **not the complete EXIF/ICC metadata set**. Cropping is not lossless JPEG editing.
- Re-saving clears unchecked previous crop comparison versions so old-crop pixels cannot masquerade as current results. Original comparison files remain unchanged. Foreign or externally edited crop files are refused, not silently overwritten.
- No dependency versions, media-runtime build or separately paused subject-finishing work are changed. The corresponding FFmpeg source archive remains the same byte-verified archive supplied with 2.0.30.

## Quick acceptance

1. Open a small JPEG folder in Photo Lightbox. Select an original and press C.
2. Drag a corner, try a portrait/landscape ratio, inspect the retained pixel count, and choose crop comparisons.
3. Apply; compare Original versus Cropped and check the expected sibling filenames.
4. Re-edit and reset the framing; verify the uncropped source is still available and unchanged.
5. Confirm Photo Process still previews and queues the displayed current recipe.
