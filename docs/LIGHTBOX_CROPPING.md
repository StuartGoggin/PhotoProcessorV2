# Non-destructive cropping in Photo Lightbox

## Quick workflow

1. Select a JPEG original in **Photo Lightbox** and click **Crop** or press **C**.
2. Drag a corner or edge to crop; drag inside to move the selection. Choose Free, Original, 3:2, 4:3, Square or 16:9. Fixed ratios offer a portrait/landscape switch.
3. The pixel count shows the actual retained resolution, with no upscaling. A focused crop handle accepts arrow keys for one-pixel adjustments, or Shift+arrow for ten pixels. Reset full frame starts again from the untouched original.
4. Select the B&W and/or Enhanced crop versions to regenerate. Existing comparison versions determine the initial checkboxes; missing versions can be enabled explicitly. Expand **Current Photo Process settings** to inspect or adjust the recipe. These settings are shared with Photo Process, not reconstructed from historical JPEGs.
5. Click **Apply crop & regenerate** or press Enter. Escape/Cancel leaves files unchanged before saving. Controls are locked during the bounded save, so it cannot be submitted twice.
6. The Lightbox refreshes into **Cropped** view. Switch between **Original** and **Cropped** to inspect each version's B&W/Enhanced comparisons. There remains one navigation stop per original.

For `photo.jpg`, the working files are:

- `photo.jpg`: untouched original.
- `photo_BW.jpg` / `photo_improved.jpg`: existing original comparisons, unchanged by cropping.
- `photo_crop.jpg`: cropped JPEG, quality 95, at the retained pixel dimensions.
- `photo_crop_BW.jpg` / `photo_crop_improved.jpg`: independently processed from the actual cropped JPEG, not from each other.
- `photo_crop.photogogo-crop.json`: crop coordinates, settings and local content fingerprints for repeat editing and accidental-change detection. Keep this receipt alongside the crop when moving the family.

Recognised rating/trash/focus tags are excluded from the crop basename, so rating the original does not rename its crop family. Re-editing always uses the untouched original. Arbitrary external/event renames are not a crop-family migration workflow; orphan or ambiguous names are not guessed or silently discarded.

## Safety and limits

- Only the selected JPEG is cropped. This is not a folder-wide regeneration job. Subsequent ordinary B&W/Enhanced batch jobs can process both originals and crop working images; managed crops are excluded from focus-flag renaming so their identity remains stable.
- The crop preview is an upright display-sized image made from the same bytes used for its source fingerprint. Saving uses the full-resolution source, not that preview. Changes to the source while the editor is open require reloading/resetting the selection.
- Cropping does not replace the original or its existing comparisons. Existing crop files must be recognised by the receipt and match their recorded fingerprints before replacement. Foreign or externally edited files are refused, not silently overwritten. Fingerprints are local accidental-edit detection, not a signed/authenticated ownership record.
- All requested new files are prepared before publication. A journal and temporary generated backups support rollback/recovery of an interrupted crop save. Unexpected recovery files are retained with an actionable error, not deleted by guesswork. No original backup is necessary because the original is never replaced.
- When re-saving a crop, **unchecked previous crop comparison files are cleared** as part of that generated bundle. This prevents comparisons of an old crop appearing beside the new crop. The editor explains this before Apply. Original comparison files are unaffected.
- Let import and Photo Process jobs finish first. A crop operation does not stop existing work; new import/process requests are refused with a retry message until it finishes. Studio/render-PC settings are not changed.
- JPEG/JPG only, at most 64 MiB and 100 megapixels. Output must also fit the 64 MiB recovery limit. The minimum crop is 16 × 16 pixels. RAW/PNG cropping, perspective correction, straightening and upscaling are not included.
- EXIF display orientation is baked into upright pixels. The original retains all of its embedded metadata byte-for-byte; generated crop/processed JPEGs currently copy filesystem timestamps, not the entire original EXIF/ICC metadata set. Cropped JPEG encoding is not lossless. Keep the original for archival and colour-managed workflows.

## Validation boundary

Native checks use synthetic photographs and failure fixtures. Browser checks use the actual React pages with synthetic native-command responses. They verify interaction, dimensions, naming, state and safety behavior, not real-camera colour accuracy, measured throughput or installation on another PC.
