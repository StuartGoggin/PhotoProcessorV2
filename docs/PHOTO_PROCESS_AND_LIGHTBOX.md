# Photo Process and Photo Lightbox

## Browse and compare originals

Photo Lightbox lists originals rather than making B&W/Enhanced versions separate navigation stops. The Original, B&W and Enhanced panels show the associated versions. The tree, arrow buttons, keyboard arrows and photo counter share one folder-local originals list, including staging-root photos.

Generated `_BW.jpg` and `_improved.jpg` versions are matched case-insensitively in their original's folder, including recognised rating/trash/focus tags and `.jpeg` originals. RAW+JPEG pairs associate processed versions with the JPEG. Orphan suffix-named images remain visible; ambiguous source associations are not guessed. Hiding versions deletes nothing. RAW decoding is not added.

Read-ahead prepares up to two originals in the browsing direction and one behind, followed by their available versions. It uses at most two native reads, one speculative read at a time, a 64 MiB compressed cache and up to 128 MiB of explicitly warmed speculative decoded pixels. Active panels, transient buffers and browser-managed memory are additional; this is not a whole-app RAM cap. Refresh, rating/trash renames and leaving the page invalidate/dispose the cache. Refresh after regenerating versions elsewhere.

Reads refuse files over 64 MiB or 100 megapixels. Full-resolution files are not replaced by thumbnails. Synthetic cache checks do not establish a numerical speedup on camera photos.

## Tune before queuing

For selected-photo composition, Photo Lightbox also offers [non-destructive cropping](LIGHTBOX_CROPPING.md): the original stays untouched, `_crop.jpg` becomes a separate working version, and optional `_crop_BW.jpg` / `_crop_improved.jpg` comparisons are generated from that crop. One Original/Cropped switch keeps navigation original-only.

1. Choose entire staging, a selected folder recursively, or that folder only.
2. Open **Preview before queuing** on a task. A sample original is selected from the first 1000 eligible files in that scope. Use **Choose photo/video** or **Another random photo/video**; narrow the scope to find other files.
3. Adjust controls. The sample remains selected. Still previews debounce and serialize work; obsolete results are discarded.
4. Use **Fit** for a draft or **100% - full-resolution check** for actual source pixels with synchronized comparison scrolling. Reduced-image drafts can differ in local contrast/sharpening. Full-resolution checks share the batch recipe and quality-95 JPEG encoder.
5. **Queue Job** applies those settings to all eligible originals in the displayed scope, not only the sample. A preview never queues a job.

Preview failures are visible and retryable without changing originals. Photo processing accepts JPEG/JPG originals; PNG/RAW processing is not introduced.

## Orientation and independent versions

All eight EXIF orientations, including mirrored orientations, are applied to decoded pixels before Focus/Enhanced/B&W processing. Generated JPEGs contain upright pixels without a conflicting rotation tag. A portrait stays portrait; 90-degree rotation swaps width/height without resizing. Filesystem timestamps are copied as before; this does not promise preservation of every EXIF/colour-profile field.

Enhanced and B&W independently read the original. B&W never requires an Enhanced output. Existing sideways versions need deliberate regeneration; upgrading does not change existing photos automatically.

Generated JPEGs now use quality 95 rather than the previous default 75 and may be larger. A complete JPEG is written/synced to an owned temporary file before replacing a generated version. Failed writes/publication retain the previous output. Enhancement/B&W do not change originals; an actual queued Focus job deliberately renames flagged originals.

## B&W adjustments

- **Local contrast:** blend CLAHE from Off to full strength.
- **Sharpening:** Off to strong; Off really disables sharpening.
- **S-curve strength:** gentle tonal separation; zero disables it.
- Advanced **shadow depth**, **highlight lift** and **midpoint:** shape a smooth monotone curve with fixed black/white endpoints.
- Reset restores the starting recipe; no single preset is ideal for every photograph.

Enhancement's contrast/sharpening controls also control their actual effects, including Off. No fixed sharpening pass remains hidden. Queued jobs capture/log recipes. Full-resolution photo work is bounded to two photo workers per job, not globally across separately queued jobs.

## Other previews

**Focus Detection:** source-resolution scores and the flagging verdict, without renaming. Scores are review aids, not a definitive judgement about intentionally blurred backgrounds.

**MP4 Stabilisation:** explicitly generate up to five seconds from a chosen position, muted and at most 720p/30fps. The same filter settings run in isolated temporary storage with timeouts/cleanup. Motion context, resolution, bitrate and encoder can differ from the final full clip. Active import/processing/Studio jobs prevent a new video preview; nothing is stopped. Separate Studio stabilization methods are unchanged.

**Cleanup:** a read-only snapshot of the actual affected paths/counts. Removal occurs only when deliberately queued; Remove Focus Flags retains collision checks. Lists cap at 2000 paths with full totals. A dry run is not a reservation: the queued job checks the filesystem again.
