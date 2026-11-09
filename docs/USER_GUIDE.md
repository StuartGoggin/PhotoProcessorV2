# PhotoGoGo User Guide

Windows desktop edition • Version 2.0.53 • 9 November 2026

PhotoGoGo helps you copy camera media into a working library, organise events, review and develop photographs, assemble videos, extract still photographs from video, and transfer selected results to Google Photos or an archive.

This guide covers PhotoGoGo 2.0.53. It is organised around tasks rather than development history. The normal photo path uses camera JPEGs; RAW development is optional for individual photographs or a deliberate batch. The video paths are separate: Video Studio creates finished videos, while Video snapshots creates photographs from original video frames.

**Start with the quick workflows in chapter 1.** Use the later chapters for settings, detailed controls and recovery. Examples use imaginary event names and folders. Screen labels are written in bold. Generated previews help you make choices; the full export or render is the deliverable.

**Version boundary.** Subject-aware horse and rider finishing, background segmentation and the experimental GPU Tripod stabiliser are not released features. The Face Identify page is a separate, limited advanced workflow described in chapter 16. It is not required for Video snapshots.

## Contents

1. Start here
2. Setup and file safety
3. Import and name events
4. Browse the Video Timeline
5. Process JPEG photographs
6. Review and crop in Photo Lightbox
7. Develop optional RAW alternatives
8. Build a Video Studio project
9. Add titles chapters and scorecards
10. Finish video audio and export
11. Create photographs with Video snapshots
12. Publish to Google Photos
13. Copy and verify an archive
14. Manage jobs and find logs
15. Use the keyboard and AKP03E
16. Maintain the library and optional features
17. Solve common problems
18. Reference and further help

## 1 Start here

Open **Help & User Guide** from the app menu to read this guide without leaving your work. **Help for this page** starts at the relevant chapter. Search for an action, enlarge an illustration, or adjust the text size in the reading toolbar. **Return to your work** closes the guide; Escape also returns after any image or search has been dismissed. Jobs continue in the background. Snapshot shuttle navigation stops while you read. Existing Lightbox F1 help remains the separate keyboard/controller reference.

### The everyday photo workflow

1. In **Settings**, set your camera/card source, local staging folder and archive destination. Save the settings.
2. In **Import**, select the card or source folder and choose **Queue Import Job**. Wait for the verified import to finish in **Jobs**.
3. In **Name Events**, name the imported event before creating path-dependent video projects or upload plans.
4. In **Photo Process**, select that event and check the processing scope. Preview **JPG Enhancement** or **B&W Conversion**, adjust the controls, then queue the required jobs.
5. In **Photo Lightbox**, review originals and their comparisons. Rate, mark Trash, crop selected JPEGs and tick the exact versions you want to publish. Develop a RAW alternative only where it adds value.
6. In **Transfer → Transfer to Google Photos**, review a publish plan and publish it. A local selection checkbox does not upload anything by itself.
7. In **Transfer to Archive**, preview your archive rules, queue the reviewed transfer and verify the result. Keep a separate complete backup where your archive selection omits material.

For a JPEG-first event, you can complete the whole workflow without opening RAW Development. With a verified CR3/JPEG pair, the Camera JPEG remains the normal Lightbox view.

### The finished video workflow

1. Open **Video Studio**, choose **New**, then **Add clips** from staging.
2. Set project output, picture defaults, graphics and music.
3. Review the included clips, set their chapter names and approve their picture settings.
4. Render the clips that need preparation.
5. Configure the opening title and any per-clip scorecards.
6. In **Finish & export**, check the current included clip count and choose **Create updated final video — N clips**.
7. Check the finished video, then copy or save its YouTube description and chapters.

Keep the project snapshots and reusable rendered clips. They allow many finishing changes without repeating stabilisation.

### The video to photograph workflow

Open **Video snapshots**, create a session, add original videos and wait for indexing. Find a frame, choose **Select photo**, confirm the shooting start and UTC offset, choose the export folder, then export the full-resolution photograph. See chapter 11 for the controls and naming rules.

## 2 Setup and file safety

### Choose the three main locations

Open **Settings** and configure the following locations. The examples are illustrative; use folders that exist on your own PC and storage.

| Setting | Purpose | Example |
| --- | --- | --- |
| Source Root (SD Card) | Default source used by Import | F:\DCIM |
| Local Staging Directory | Working library for imported media, review and processing | E:\stage |
| Archive / NAS Directory | Destination for reviewed archive copies | Z:\PhotoArchive |
| ExifTool folder override (optional) | A custom metadata-tool folder if deliberately required | Leave empty normally |

Choose **Check metadata tool** to check the resolved metadata tool, then **Save Settings**. The released installer supplies the normal metadata and RAW tools; a manual ExifTool override is not normally needed.

On a new installation, verify the actual staging and output folders. A drive letter that exists on one machine may refer to different storage on another. Google sign-in and protected job history also belong to each installation; see chapter 12 before moving work between PCs.

### Understand what is stored

**Source media** is the camera/card material you import. **Staging** is the working library: originals, generated photographs, event descriptions and other saved review information can live together there. **Archive** is the destination for the selection you choose to retain.

Photo Process enhancement and B&W jobs create derived JPEGs. A crop creates a separate working version. RAW development creates separate outputs. Review rating and Trash actions can rename the review file with tags; marking Trash does not delete its image contents.

Some commands deliberately change existing files. **Focus Detection** can rename originals with focus flags. **Write Tags To JPG/MP4 Metadata** changes media bytes. **Reprocess Staging Tree** can correct names and timestamps. **Collect Trash** moves files. Treat those as maintenance actions, distinct from previews and ordinary viewing.

Keep the supported PhotoGoGo metadata when you want to revisit recipes, selections or event descriptions. Do not delete all JSON files from staging as if they were disposable cache files. Archive selection lets you choose whether to back up supported library metadata.

### Preview resolution and final resolution

Lightbox comparisons, Studio previews and Snapshot thumbnails serve different viewing purposes. A small preview is not a full-resolution export. Use the task’s **Queue Job**, final render or **Export full-resolution photo(s)** action to create the intended deliverable.

### Useful initial settings

Leave **Timeline Video Preview MP4** disabled if fast importing is your priority. You can enable it later for motion previews.

Under **Video Studio review frames**, choose automatic preparation for all project clips, selected clips only, or manual preparation. The initial choice is **All project clips when Studio is idle**, with **8** frames per clip; alternatives are 4 or 12. Save changes. These sparse frames help review, but do not approve clips or reveal every movement.

Start performance controls on their automatic settings. More simultaneous readers can slow one SD card, disk or Wi-Fi connection rather than improve it.

## 3 Import and name events

### Import a camera card or another source folder

1. Insert the card and open **Import**.
2. Select a detected source. Use **Rescan** if a newly connected card is missing.
3. Alternatively choose **Browse...** in **Source override (optional; enables multiple sources)**. This changes the source for that import, without replacing the saved default.
4. Check the source and staging locations, then choose **Queue Import Job**.
5. Open **Jobs** and follow the import through copying and destination verification. Review its completion and any errors before disconnecting the source.

Normal importing copies media and checks the copied bytes. It does not remove the source media. Jobs on separate physical source devices can run together; jobs sharing one card or source device are scheduled conservatively. The pipeline overlaps copying and verification while retaining checksum checks.

Check camera clocks and the expected event dates before a large import. If media lands under an unexpected date, inspect the job log and the camera’s metadata rather than immediately running a broad rename.

### Import the same material again

A uniquely named day such as **E:\stage\2026\11\24 - AMGA Champs** is reused when the corresponding date is imported again. Identical content is skipped through the existing checksum checks. A conflicting filename with different contents receives a safe collision name rather than overwriting another photograph.

If both **24** and **24 - AMGA Champs** exist, or several named folders represent that day, the application reports the ambiguity. Resolve the folders deliberately before retrying. It does not silently merge old duplicate directories or guess which event you intended.

### Give an event a useful name

Use **Name Events → Choose dates → Describe one event → Review and apply**.

1. Select **Unnamed** or **All dates** and check the dates belonging to the event.
2. Enter **Event group**, **Event type** and an optional **Venue**. Use **Use a custom event name** for older free-form wording.
3. Inspect the proposed folder names. Replacing an existing description requires its own consent.
4. Apply the reviewed changes and follow the naming job.
5. Refresh the library after completion and check the actual folder names.

Favourites and recent events reuse descriptions, not a previously checked set of dates. Loading a favourite does not rename anything until you review and apply it.

### Name an event from a folder tree

In Photo Lightbox, Photo Process or Video Timeline, right-click the directory row, use **⋯**, or focus the row and press **Shift+F10**. Choose **Name event…**, **Edit event…** or **Name events within…**.

A day opens for that date. Root, year and month scopes let you deliberately choose recognised dates; they do not preselect an entire collection. Save or discard unsaved RAW edits and wait for pending selections and active jobs before naming.

Folder naming preserves photograph contents, but changes paths. Name events early where possible. Saved Studio projects, snapshot sessions and upload plans can need relinking or rebuilding after a folder move. Keep **.photogogo-event.json** with an event to retain its structured description.

## 4 Browse the Video Timeline

**Video Timeline** is the staging browser. It helps you find media by day and time, preview files, check a group and organise tags. It does not itself assemble the final Studio video.

Choose a day from the navigation list. Switch between **Timeline** and **List**, use **Search current day**, and select the media types you need. The sidecar visibility control can show companion files without making them additional photographs. The left and right panes are resizable.

In the file list or timeline, click to preview a file. **Ctrl+Click** toggles its check; **Shift+Click** checks a range. The **Details Pane** shows the selected media and event actions. **Open selected video** uses your system player.

### Tag and group files

1. Check the intended files.
2. Choose **Tag Selected**, or enter comma-separated tags under **Tag Checked Files**.
3. Optionally enable **Create group marker for this batch** and enter a group label.
4. Choose **Apply To Checked Files**.
5. Inspect the changed tags/groups in the browser.

Timeline sessions and sequence boundaries help divide a day into useful groups. Session context actions include selecting or tagging the session. Sequence context actions let you split before a file, merge with the previous sequence or clear the manual override. These organisation controls are separate from Studio’s clip inclusion and order.

### Write tags into media only when intended

Ordinary browser tags and an explicit metadata write are different operations. **Write Tags To JPG/MP4 Metadata** changes the selected media bytes and can invalidate earlier checksums.

For a deliberate write, first check **Backup originals before metadata write**, enable **Dry run only**, and review the proposed work using **Dry Run Metadata Write**. Keep **Verify metadata after write** enabled and consider **Generate MD5 report for modified files**. Remove dry-run mode only when you intend the real modification.

Renaming event folders can leave older saved Timeline tag/group references needing attention. Refresh and verify the checked paths before further changes.

## 5 Process JPEG photographs

Open **Photo Process** to create or regenerate photograph versions. The legacy photo tasks process JPEG/JPG originals. CR3 development uses the separate RAW Development section described in chapter 7.

**Check the scope first.** The initial scope is **Entire staging**. Selecting a folder in the tree is not sufficient if Entire staging remains selected. Choose **This folder only** or **Folder recursively** for an event-sized job.

### Preview and queue a job

1. Select the intended scope and task.
2. Open **Preview before queuing**.
3. Use the chosen sample, **Choose photo/video**, or **Another random photo/video**. Narrow the scope if the desired sample is outside the candidate list.
4. Adjust the controls. Use **Fit** for a draft and **100% - full-resolution check** for source-pixel inspection.
5. Check faces, edges, shadows and intentionally blurred backgrounds.
6. Choose **Queue Job** and follow the normal Jobs page.

The preview is one sample. **Queue Job processes every eligible original in the displayed scope**, not only the photograph you previewed. Previewing alone does not queue a batch.

### Choose the task

| Task | Result | Important distinction |
| --- | --- | --- |
| Focus Detection | Reports focus scores and can add an out-of-focus filename flag | Intentional bokeh can influence scores; a queued job can rename files |
| JPG Enhancement | Creates an _improved.jpg comparison | Contrast and sharpening are adjustable |
| B&W Conversion | Creates a _BW.jpg comparison | Reads the original independently of Enhanced |
| MP4 Stabilisation | Prepares stabilised MP4 outputs | Separate from the project-based Video Studio workflow |

Enhancement and B&W independently read the original; neither requires the other output. Display orientation is applied to the generated pixels, including portrait and mirrored EXIF orientations. Generated JPEGs use quality 95 and may be larger than earlier versions. Do not assume every original metadata or colour-profile field is retained.

### Adjust black and white photographs

Use **Local contrast**, **Sharpening** and **S-curve strength** gently, then inspect at 100%. A zero strength disables that adjustment. The advanced shadow depth, highlight lift and midpoint controls shape the tonal curve. There is no single correct recipe for every coat colour, face or lighting condition.

Repeated processing deliberately regenerates generated versions; original image contents remain intact. Existing sideways outputs are not corrected merely by installing an update: regenerate the intended versions.

### Removal and video previews

Removal tasks are maintenance operations. Their dry runs show affected paths and counts; the queued action performs the actual removal or tag change. A dry run is not a reservation, so inspect the real job’s outcome.

An MP4 task preview is a short, muted draft, up to five seconds at reduced resolution/frame rate. It is useful for checking the proposed motion correction, but does not establish full-clip quality. Active media jobs can prevent a new preview without stopping those jobs.

## 6 Review and crop in Photo Lightbox

The folder tree and next/previous controls visit originals or verified captures. Matching generated versions appear in the comparison panels instead of becoming extra navigation stops. A suffix alone is not proof of ownership: ambiguous and orphan files are not silently hidden.

For a verified CR3/JPEG pair, the tree shows the **camera JPEG filename and size**, with a **RAW** badge. **Camera JPEG** is the normal view, with that JPEG’s B&W, Enhanced and crop versions. Choose **Camera RAW preview** deliberately to inspect the RAW reference and its own developed versions. The choice belongs to that photograph, not the whole event.

### Review an event

1. Select an original in the folder tree.
2. Wait for its image and any **Checking capture pairs** work to settle. Browsing and zoom remain available while identity checks finish.
3. Compare the available panels. Use **1**, **2** or **3** to rate; **Backspace** clears the review rating.
4. Use **Delete** to mark or restore Trash. A confirmed change can move the photo out of the filtered view; choose **Include Trash** to keep both states visible. **X** marks Trash and advances after saving.
5. Tick the exact versions you want for Google Photos. Checking a box saves a local decision; it starts no cloud work.
6. Wait for saving to finish before closing or preparing a transfer.

The cyan active border identifies the panel affected by active-panel commands. **Q / W / E** toggle Original / B&W / Enhanced selections; cropped view applies them to the cropped versions. **Shift+Q / W / E** toggle their local favourite flags. These favourites are filters within PhotoGoGo; they do not promise a favourite star inside Google Photos.

For verified pairs, ratings and Trash use the Camera JPEG review file in both views. If older RAW and JPEG review tags disagree, a notice explains the difference and both existing tags remain. A source-family switch never transfers crop geometry or changes upload selections.

In a folder containing camera JPEG originals, unpaired RAW files are hidden from normal browsing, including while capture checks run. **Show unpaired RAW files** reveals them; its count explains how many are hidden. RAW-only folders are always shown, even when they contain developed JPEG outputs. This is a view preference: no original is deleted, no files are paired by filename, and **Develop RAW alternative** stays available on each verified JPEG/RAW capture.

### Find your next photograph

The **Folder view** bar applies to the current folder. Choose **All**, **Needs review**, **Reviewed**, **Google-selected**, **Rated** or **Favourites**. Google-selected and Favourites match a capture when any of its verified Original, B&W, Enhanced or cropped versions has that saved flag. Generated versions remain in their comparison panels.

Use **Trash** independently: **Hide Trash** is the initial setting, **Include Trash** shows both states, and **Only Trash** helps inspect rejected photographs. The matching count compares visible photographs with all originals in this folder. Other folders stay available in the tree. **Reset view** returns to All, Hide Trash, capture time ascending, with unpaired RAW hidden in mixed folders. Your view preferences are remembered on this PC.

Sort by **Capture time**, **Filename**, **Rating** or **Original size**, then change the direction. Capture time uses the imported `YYYYMMDD_HHMMSS` filename, avoiding a slow metadata scan; unknown dates and sizes sort last. Filename and original-size sorting use the displayed camera JPEG for verified pairs. The tree, Previous/Next, Home/End and controller navigation use the same filtered order.

### Record a review decision

**Reviewed** records your progress. A successfully saved rating/tag, Trash or restore action, or Google selection/favourite change on any Original, B&W, Enhanced or cropped version automatically marks the capture Reviewed. Clearing a rating or unchecking a selection also counts as a deliberate review action. Press **M** or **Mark reviewed** to toggle the flag manually, including returning a capture to Needs review. Use **Shift+M** or **Reviewed & next** to save the decision and move to the next matching photograph. Browsing, zooming, choosing RAW/JPEG or opening an editor never marks a photograph as reviewed.

Older photographs with a positive rating, Trash tag or saved Google selection/favourite on a verified version are recognised as Reviewed. A notice says when this comes from existing decisions. A valid explicit Reviewed choice takes priority, including a manual Needs review choice. No metadata is rewritten in bulk; an unselected/unrated photograph alone cannot prove that you previously reviewed it. Decisions live beside their originals in `.photogogo-review.json`, so a normal event-folder rename carries them with the folder. The Archive option to include **PhotoGoGo library metadata** controls whether this record is backed up; it is excluded from a media-only archive.

A save must be acknowledged before the current photograph leaves a filtered view. A failed primary save does not mark Reviewed. If the decision saves but its Reviewed update fails, the decision stays saved and the photograph stays open: use **Retry Reviewed** to save only that flag as Reviewed, without repeating the photo action or advancing. **M** keeps its manual toggle meaning. A failed manual clear offers **Retry Needs review**, preserving that intended clear. While capture identity or folder information is uncertain, photographs remain visible with a notice; they are never silently labelled Reviewed. If an original was replaced or its identity is ambiguous, refresh and resolve the warning before recording a new decision. A newly verified RAW/JPEG pair retains a valid previous JPEG-only Reviewed decision when no canonical decision exists. Stale or ambiguous records remain uncertain. A matching filename alone never transfers a decision.

### Understand missing and delayed images

**No image** means that source family has no available comparison. An undeveloped RAW may legitimately have no RAW colour or B&W output even when JPEG comparisons exist.

**Could not load … image** means an existing image failed to read or display. Use that panel’s **Retry … image**. It rereads that exact version and leaves healthy panels visible. **Retry capture checks** handles incomplete folder identity checks. Metadata ownership warnings need repair; selecting another source does not override them.

Checkbox changes appear immediately, but are not safely finished until their save is acknowledged. A failure needs the scoped retry or **Reload selections**. Transfer previews refuse stale or unconfirmed decisions.

### Crop a JPEG without replacing the original

1. Select a JPEG source. In a verified RAW/JPEG pair, choose **Camera JPEG**.
2. Choose **Crop** or press **C**.
3. Drag corners or edges; drag inside to move the crop. Choose a free or fixed aspect ratio and inspect the retained pixel dimensions.
4. Select whether to regenerate cropped B&W and Enhanced versions.
5. Choose **Apply crop & regenerate**, or press **Ctrl+Enter**.
6. Compare the results using **Original / Cropped**, or **V**.

The crop becomes **_crop.jpg**. Optional comparisons become **_crop_BW.jpg** and **_crop_improved.jpg**. The original and its original comparison contents remain unchanged. Re-editing starts from the untouched original and cropping never upscales it.

Keep the crop receipt beside the crop, for example **photo_crop.photogogo-crop.json**. If you resave a crop while unchecking a previously generated crop comparison, that prior comparison is deliberately cleared to prevent a stale display. A RAW camera preview or PNG is not a crop source. Ordinary Enter activates its focused control; it is not the universal apply shortcut.

## 7 Develop optional RAW alternatives

Use a CR3 when the JPEG needs more exposure, white balance, highlight or noise adjustment. You do not need to develop every RAW to keep a JPEG-first review workflow.

### Develop one photograph from Lightbox

1. Select the CR3 original or its verified paired capture and choose **Develop RAW alternative**.
2. Start with **Natural**, **Neutral**, **High ISO** or **Internet ready**.
3. Adjust the photo draft, then choose **Generate RAW preview** or **100% RAW detail check**. The camera JPEG is available as the reference when present.
4. Choose **Queue this photo's RAW development**. It queues only that CR3 through core Jobs, using the settings currently shown. Saving an override is optional for this action.
5. Follow the job using **Open Jobs** or the common job dock.
6. After completion, return to Lightbox, select the photograph and choose **Refresh RAW results**.
7. Compare its source families. Use **Use this finish for this photo** to remember the JPEG/RAW viewing family if desired.

Opening the editor or browsing photographs does not automatically decode a new RAW finish. Creating or choosing a finish does not tick uploads, replace published photographs or move a JPEG crop to the RAW family.

A saved RAW finish requires an available validated JPEG alternative. Missing saved finishes produce a notice and a conservative fallback. The embedded camera image remains a reference, never a substitute for the full-resolution export.

### Choose the amount of automatic finishing

**Natural** starts with as-shot settings and Auto finish off. **Internet ready** starts at Auto finish 65. The scale runs from Off through balance/bright/web-pop treatments to Vivid.

Positive **Auto finish** enables an automatic exposure baseline, then adds the extra finish. It is not an opacity blend with the unprocessed image, and the first step from Off can visibly change exposure. Inspect bright areas, faces, dark coats, fine edges and bokeh at 100%. More vivid is a choice, not an assurance of a better photograph.

White balance, noise reduction and detail controls remain adjustable. Strong sharpening or noise reduction can harm natural detail. Save a recipe you like, but check it against representative lighting before applying it widely.

### Understand outputs and saved recipes

Colour and B&W develop independently from the CR3. The normal output is a full-resolution sRGB JPEG; B&W starts off unless selected. A 16-bit TIFF is available for further editing or archive, while Lightbox compares JPEG finishes. GPS is retained by default unless you change the relevant option.

The batch route is **Photo Process → RAW Development**. It distinguishes:
- Machine job defaults for future batches.
- A saved per-photo override kept with event metadata.
- **Recall last applied recipe**, which loads previous settings into the editable draft.

For a batch, inspect the scope, explicit selection and **Use saved per-photo overrides where present** before queuing. Preview settings and saved overrides do not become interchangeable automatically. Active preview, loading, saving and queue admission block a normal editor close; unsaved edits need a deliberate save or discard.

## 8 Build a Video Studio project

Video Studio creates a repeatable assembled video from clips in staging. It restores its local working project automatically. **Save snapshot** also creates a project file you can keep and reopen; it is not a copy of every source clip.

### Start and review a sequence

1. Choose **New**, then **Add clips**. The Studio picker accepts multiple MP4 clips from staging.
2. In the project controls, use **Project**, **Filters**, **Graphics**, **Music** and **Output** to establish the defaults.
3. Choose the output folder, resolution, frame rate and bitrate in **Output**.
4. Arrange the **Sequence** and tick the clips to include. Excluding a clip does not delete its source; filtering the visible list does not change inclusion.
5. Select a clip and review its picture, optional title, replay, scorecard and sound settings.
6. Approve the reviewed picture settings, or use **Approve & next**.
7. Prepare the clips using **Render clip** or **Render pending clips**.

The workspace sections **Sequence → Review → Titles & graphics → Finish & export** can be revisited. They are not locked wizard stages. **Density → Compact / Comfortable** changes the working layout.

Output choices include 4K UHD 3840 × 2160, Full HD 1920 × 1080 and HD 1280 × 720; frame rates are 25, 30, 50 or 60 fps. Bitrate is adjustable from 1 to 150 Mbps. A suggested bitrate after a resolution change is a starting point. New output formats need matching clip renders.

### Judge stabilisation on moving footage

Released methods are **Fast — one pass** and **Quality — two passes**. Presets include Off, Gentle for tracking pans, Balanced and Strong; Fast also permits custom settings. Framing options differ between methods.

Use the review frames for a quick check, then watch motion. Enter **Preview from (seconds)** and choose **Play 12-second preview**. The inline result appears when its job completes and does not autoplay. Reduced-resolution previews are for judging the treatment; they are not the final resolution. **Open preview externally** is available when the inline result is too large.

### Prevent introduced rotation on a roll locked tripod

For Quality stabilisation on a tripod that cannot roll, enable **Project settings → Filters → Prevent added rotation · project default**. A clip’s **Picture** tab can **Use project default**, switch On or switch Off.

This prevents added rotation; it does not level a tilted original, remove rotation already recorded in-camera, or distinguish subject motion from camera shake. It is inactive for Fast and Off. A change in effective picture settings requires a fresh preview, approval and render.

For ordinary picture defaults, applying changes to existing included or selected clips is explicit and confirmed. Do not assume every new project default silently rewrites reviewed clips. Rotation inheritance remains live, with explicit clip On/Off overrides retained.

### Add a replay and preserve the project

In a source preview, **Use current source time** marks replay start and end. Adjust speed and caption in **Replays**. Composite replay previews cannot supply a simple linear source-time marker.

Save a project snapshot at useful milestones. Retain the originals and rendered-clip folders so that the project can be reopened and verified later.

## 9 Add titles chapters and scorecards

### Name a clip without drawing text on the video

**Clip name / YouTube chapter** identifies the clip in the sequence and exported chapter summary. It does not put text on the picture.

For visible clip text, open **Clip title**, enable **Show title in video**, and enter the main title, optional heading/subtitle and duration. New clip titles start off. **Copy chapter name into title** copies once; it does not permanently link the two fields.

Chapter-name edits preserve picture readiness. Visible title or style edits can need a title-fragment refresh while retaining the verified stabilised base.

### Configure the opening title

Open **Titles & graphics** or its pinned **Opening title** entry. Enter the main title and any optional heading or subtitle/date. The heading is your text; the application does not force the words “Opening title” onto the finished video.

Choose **Separate title card**, **Overlay on first video**, or **None**, and a duration. A separate card adds time; an overlay does not. An enabled title needs its main text and a positive duration.

Use **Edit shared graphics defaults** for common appearance, including the supported font/style controls. Existing legacy appearance changes only when you opt into shared styling. Inspect a rendered preview before a long final assembly.

### Prepare scorecards from project defaults

1. Open **Project settings → Graphics → Default scorecard template**.
2. Enter **Top line / heading**, **Main line / result** and **Bottom line / subtitle**, and choose the layout.
3. Enable **Prepare scorecards from this project template** if wanted. New/missing clip cards receive independent starting text but start **off**.
4. In a clip’s **Scorecard** tab, enter its actual result or table data and enable **Include scorecard**.
5. Check timing and appearance. A prepared card needs result text or a nonblank table cell; common headings alone do not make it ready.

For later changes, **Prepare missing cards** fills missing cards. **Update clip scorecards from project defaults…** opens a review of Current and Proposed text. Nothing is selected automatically. Check each text item you intend to replace or clear, then use **Apply selected text changes**.

**Select blank items · all clips** includes genuinely blank items outside the current search results. Text updates do not enable cards, include excluded clips, or silently change layouts, table data, timing or render caches.

### Choose timing and inspect the actual card

Timing includes the end of the main clip, the end including replays, a separate card after replays, the start, or a custom main-clip position. **Use project default** inherits timing; an explicit override remains. Only standalone cards add time to the final video.

Tables support up to five columns and eight rows. Use **Rendered preview** for an actual compositor frame; the live sketch is illustrative. Read whether a preview uses stabilised footage, an original illustration or a standalone card.

### Export YouTube chapters

After exporting the video, use **YouTube description & chapters**. Select **Finished export**, edit the description, then **Copy description** or **Save alongside video**. The application does not upload to YouTube.

The chapter list uses measured timings for that finished export. Editing description text does not alter the video, its embedded graphics or its embedded chapter data. Check manual edits yourself.

YouTube’s published requirements include a 00:00 first timestamp, at least three ascending timestamps and chapters of at least ten seconds. See the official reference at the end of this guide.

## 10 Finish video audio and export

### Reduce wind on the camera sound

Set common wind defaults in **Filters**, then inherit or override them in each clip’s **Sound** tab. Begin with **Light** and listen to the short A/B preview.

Filtering reduces low rumble and hiss on the camera audio **before the music is mixed**. The added music is not wind-filtered. Strong treatment can also reduce desirable natural sound, and an already clipped recording cannot be repaired simply by filtering it.

### Recreate a video with new music

1. Reopen the saved Studio project and keep its verified rendered clips available.
2. In **Music**, use **Use an existing music file / Choose rendered audio**.
3. Set the supported music/original-audio levels and enable **Include in final render**.
4. Check that the chosen file is available. Music enabled without a file blocks assembly.
5. In **Finish & export**, check the current included clips and reusable render state.
6. Choose **Create updated final video — N clips**.

A new final file is created. The earlier video remains a useful comparison or rollback copy.

### Know which changes reuse stabilisation

| Change | Usual next action |
| --- | --- |
| Music levels or music file, wind treatment, scorecards or opening-title content | Create a new final assembly using matching verified picture renders |
| Chapter text or included clip order | Rebuild the final sequence/description as needed; preserve current picture renders |
| Visible clip title or graphics style | Refresh the needed title fragments; the verified stabilised base can be reused |
| Stabilisation, effective rotation, framing, replay/picture changes or output format | Prepare affected clips again before final assembly |
| Missing, changed or unverified source/cache | Resolve the mismatch; reuse is not accepted merely from a matching filename |

The finishing-only path checks sources and caches. It stops when that verification fails rather than silently deciding to stabilise again.

### Include clips added after an earlier render

If an old export contains 31 clips but the current project has 51, add and review the new clips, confirm the inclusion checkboxes and prepare their required renders. Then choose **Create updated final video** and inspect the shown N clips.

**Resume saved render** continues that job’s original saved sequence. It does not acquire clips added later. The finished-export selector indicates whether an earlier export matches the current edit.

### Move or relink a project

Choose **Relink media**, enter the old staging root and new output root, then **Check media locations**. Inspect the proposed paths and warnings, **Apply checked locations**, and **Save snapshot**.

Checks can hash large files and take minutes. A same-sized filename is not enough proof of reuse. Originals and previous snapshots are preserved. **Undo relink** is available until later edits make it unsafe. External music and LMMS paths are not automatically rewritten.

**Clear all Studio renders** deliberately stops/clears attempts and resets reuse. It is not the normal solution for a changed scorecard, new music or a path relink.

Optional advanced composition and AI review are separate from this everyday workflow. AI review explicitly confirms sending sampled stills and text to OpenAI, uses separately billed API access, and is not local-only. It does not require uploading the complete video/audio for the described review.

**Music → Compose a soundtrack** is an advanced alternative to choosing an existing file. It requires a separately installed LMMS executable, selected in the composition controls. AI direction uses its panel's API key field, consent to sampled stills, and review of the proposed direction. Using an existing music file requires neither LMMS nor AI.

## 11 Create photographs with Video snapshots

Video snapshots works from original video clips. It does not stabilise a Studio project or use automatic face matching. The selected frame is decoded again from the original for export; its browsing thumbnail is not the photograph.

### Start or restore a session

Choose **New session**, enter a name and choose **Create session**, then **Add videos**. You can add several original videos and more later. Wait for the timestamp index before exact-frame navigation.

Sessions autosave locally. **Sessions** opens the library; **Continue last session** restores the last work. Search/open a record, or use **More** for rename, duplicate or a portable copy. **Import saved session** imports a saved JSON copy.

A session holds media paths and choices, not the video files or preview cache. A portable session must travel with accessible originals. **Delete** moves the session record to **Recently deleted**; **Restore session** brings it back. It does not delete the source videos or exported photographs.

### Find and select a frame

1. Choose the source video and find the general position with the timeline.
2. Use the wheel to browse. Arrow keys move one exact frame; **Shift+Left/Right** moves ten.
3. **J / L** shuttle backward/forward; repeat for speed. **K / Space** stops. **Shift+wheel** steps one frame.
4. Hold the frame-step buttons to accelerate. Slow down for exact inspection because fast shuttling skips frames deliberately.
5. Wait for the requested frame to be displayed, then choose **Select photo**.

Read-ahead prioritises the current frame and nearby frames, starts around ten either side, expands toward a hundred and favours the movement direction. It is a bounded preview cache. Long-GOP video still requires decoding between keyframes; a fast NVMe drive alone does not guarantee instant scrolling.

Initial loading reads the source to verify identity and builds its frame-time index. Loaded Windows originals are held read-only against edits/deletion; remove a video from the session before renaming or changing it in another program.

### Export at maximum available resolution

1. Confirm **Video shooting start, with UTC offset** for each source.
2. Check **I confirm this is the original shooting start**. Camera metadata is only a suggested start; file-copy dates are not a substitute.
3. Optionally enter a manual **Person name** and adjust brightness, contrast and sharpness.
4. Enable **Crop improved photo** only if needed.
5. Choose **Choose export folder**, then **Export full-resolution photo(s)**.
6. Use **Show original in folder / Show improved photo in folder** to find the results.

The unenhanced JPEG is exported at the source frame’s available resolution, uncropped. Adjustments produce a separate **_improved.jpg**; the crop applies to that improved copy. A video frame cannot contain the sensor detail of a separate camera RAW photograph. JPEG export is not a lossless RAW master.

Files use year/month/day subfolders and names such as **20261124_143512_340_Jane_Smith.jpg**. The capture timestamp is the confirmed video start plus the actual source-frame position, including variable frame timing. Safe collision suffixes preserve existing files.

A **.snapshot.json** receipt records provenance and can contain the source path. An interrupted export may leave **.snapshot.partial.json**; the final receipt marks completion. Retry preserves existing outputs and can create a fresh name.

### Recover a session or explain disabled export

The disabled export control explains a missing selected frame, destination, confirmed shooting time, busy operation, or an already exported selection at that destination. Saving failures offer **Retry save / Save recovery copy** and block normal switching/closure. Reconnect the exact original and use **Retry video** for source errors.

Limits are 64 source videos and 200 selected photographs per session. Explicit HDR/PQ/HLG media is not silently turned into SDR; prepare an SDR copy first. Camera-log footage also needs appropriate colour treatment before judging exported colours.

## 12 Publish to Google Photos

Lightbox checkboxes and local favourites prepare a local selection. **Transfer → Transfer to Google Photos** reviews and sends a separate publish job. This is publishing to app-managed albums, not two-way synchronisation of your entire Google library.

### Connect a personal account

1. In Google Cloud, create or select a project and enable the **Photos Library API**.
2. Configure Google Auth Platform branding, audience and data access. For an External app in Testing, include your own account as a test user.
3. Create an OAuth client of type **Desktop app** and download its JSON configuration.
4. In PhotoGoGo, choose **Import OAuth setup** and select that file locally.
5. Choose **Connect Google Photos** and complete consent in your browser.
6. Check the connected account before preparing a publish plan.

The integration needs permissions to add photographs, read app-created content for verification, and edit app-created album details. It does not gain general read access to unrelated Google Photos content. Google’s Library API is focused on app-created content.

External Testing configurations using Photos permissions can have refresh tokens expire after seven days. Reconnect when needed. A cloud project with the API enabled does not, by itself, configure PhotoGoGo.

For several PCs, reuse the same Desktop client configuration, import it on each PC and sign in separately. Do not copy protected access/refresh-token stores between machines. Saved jobs, receipts and known event-album mappings remain local to that PC. The installer does not automatically configure Google credentials.

Keep the original OAuth client and Google account for existing jobs. Do not reset them merely to work around a verification failure. Never paste passwords, tokens or the JSON file’s contents into a support conversation.

### Review and publish the selection

1. Use **Choose folder** for the intended event, or deliberately choose **Entire staging**. Check the scope before selecting versions; the initial scope can include the whole staging library.
2. Start with **Use my Lightbox selections**. This uses the exact local selections, including any cropped versions already checked.
3. If deliberately overriding selections for one job, use **Choose versions for this upload**. In that mode, check **Photo framing** (Uncropped, Cropped only or Both) and the advanced colour/original, rating or favourite rules. The framing control is not shown in the ordinary checked-selection mode.
4. Choose **Create new private album(s)** or **Add new photos to saved event album(s)**. Continued albums retain their existing sharing settings.
5. Decide whether to enable **Remove GPS location from upload copies**. It is off by default; do not assume location is stripped.
6. Choose **Review publish plan**.
7. Inspect the account, album names/dates, exact versions, counts, duplicates and warnings. Confirm the explicit review checkbox.
8. Choose **Publish N photos**, then **View job** in the common Jobs page.

A one-job override does not rewrite Lightbox checkboxes. New albums begin private; sharing is a separate action in Google Photos. Publishing does not replace already uploaded image bytes or delete local photographs.

### Understand completion and recovery

Transferred bytes, accepted Google registration and read-back verification are different milestones. A visible photograph in an album is useful evidence, but does not automatically prove that every saved receipt was verified.

Use **Retry** or **Resume** on the existing job as offered. Accepted photos retain their receipts; healthy work can continue past an isolated photo read-back failure. Unresolved errors remain visible. An accepted upload with unavailable read-back may finish with verification warnings, while a genuine unresolved failure remains under **Needs attention**.

Use **View diagnostics / Copy diagnostics** for support. Send the app version, status and sanitised diagnostics. Do not repeatedly create replacement jobs to bypass a warning or reset the account/client without a specific recovery plan.

**Clear finished** archives local job visibility while retaining protected receipts and cloud photos. Restoring an archived record to History does not start another upload. A previous-upload label is history, not proof that today’s file bytes are unchanged.

## 13 Copy and verify an archive

Open **Transfer to Archive** to copy the reviewed selection into a NAS, external disk or other archive folder. It leaves staging in place and does not delete previously archived files.

### Choose the archive contents

The initial policy is all originals, Google-selected generated versions, videos included and Trash excluded. Camera/user companion sidecars are included; retaining source originals for selected derived versions and backing up PhotoGoGo library metadata are separate options initially off.

1. Check staging and archive locations.
2. Choose all staging folders or a particular event/folder with its subfolders.
3. Set an independent rule for Originals, B&W, Enhanced, Crops, Cropped B&W and Cropped enhanced: all, a minimum rating, the local Google Photos checkbox, or none.
4. Check **Exclude trashed photos and their versions**.
5. Enable source-original retention if selecting a generated version should also preserve its source.
6. Choose whether to include companion sidecars and **Back up PhotoGoGo library metadata**.
7. Choose **Preview archive** and inspect included/excluded counts, total size and reasons.
8. Choose **Queue reviewed transfer**. A changed selection or library requires a fresh preview.

“Marked for Google Photos” means the local checkbox on that exact version. It does not require Google sign-in, a successful upload or cloud verification.

If you want to revisit event descriptions, RAW recipes/ownership and saved selections from the archive, include supported library metadata. A media-only archive intentionally omits that state. Caches, preview files and temporary work are excluded from the normal archive choices.

### Let copying adapt to the connection

Start **Archive transfer concurrency** on **Auto**. It adapts useful verified throughput within bounded concurrency, rather than assuming every connection is gigabit. Fixed limits are available for troubleshooting or deliberate control.

The job can overlap copying with independent destination verification. A slow stage may be source reading, archive writing, verification rereads, Wi-Fi latency or the destination disk. More jobs cannot create bandwidth the storage path lacks. Assess a representative real transfer and its phase timings.

### Verify archived bytes and understand the records

Choose **Verify scope** first: **Latest recorded transfer** or **Whole archive — master MD5 index**. Then use **Queue Verify Job**. Whole-archive verification can take much longer.

The archive maintains **master_hashes.md5**, per-run transfer manifests and an explicit latest-transfer pointer. Transfer success requires hashing current source bytes and independently checking the destination, not merely finding an old index row. Existing destination files are not overwritten.

Recovery records preserve uncertain work across an interruption. Resolve mismatches reported in Jobs; do not delete index or journal files simply to remove an error. The next transfer or verification can reconcile recorded uncertain destinations.

MD5 here checks accidental corruption and duplicates; it is not an authenticity signature. A selective archive is not necessarily a complete backup. Before deleting staging or formatting the only source card, establish which originals and metadata your verified backup actually contains.

## 14 Manage jobs and find logs

**Jobs** is the common work tracker for import, processing, RAW development, transfers and Google publication; Studio work is also visible through the Studio jobs/recovery controls and common dock.

| View | What to look for |
| --- | --- |
| Active | Queued, running and paused work |
| Needs attention | Failed, interrupted or unresolved attempts that need a recovery decision |
| History | Finished attempts, outcomes and logs |
| Archived | Hidden Google upload history with receipts retained |

Choose the controls offered for that job type: **Pause**, **Resume**, **Abort**, **Retry**, or the Studio saved-render recovery controls. They are not interchangeable. Read the current status before starting a second attempt.

Pausing retains the job; aborting stops that attempt. Neither means an archive copy or upload is verified. Finished and interrupted work can still have useful outputs or recovery records, so inspect the results rather than assuming “stopped” means nothing was written.

**Tail (auto-refresh)** updates the view. Turning Tail off freezes what you are looking at, not the underlying worker. **Refresh** requests a current view. In History, **Clear finished import / process history** changes history visibility; protected Google receipts remain. Archived Google upload records can be restored to History before an explicit recheck.

Use **Reveal Log**, **Reveal Manifest**, job diagnostics or the common console where available. The separate **Logs** page offers **Refresh**, **Tail (auto-refresh)** and **Clear Log**. Clearing the log removes useful evidence; copy the relevant failure details first.

For support, collect the app version, page/action, exact error, affected job status and a short redacted path example. Distinguish a missing output from a delayed preview, a failed save, a completed upload with a warning, and a genuinely failed job.

## 15 Use the keyboard and AKP03E

### Keyboard review

Open **Keyboard & Controller Help** using the toolbar, **F1** or **?**. It includes keyboard, controller and crop sections, and can be searched by action or key.

| Keys in the image review | Action |
| --- | --- |
| Left / Right; Home / End | Previous/next original; first/last in the folder |
| 1 / 2 / 3; Backspace | Set or clear the review rating |
| Shift+1 / Shift+2 / Shift+3 | Rate, save and advance |
| Delete; X | Toggle Trash (filter may move after saving); mark Trash, save and advance |
| M; Shift+M | Toggle Reviewed; mark Reviewed, save and next |
| Q / W / E | Toggle exact Original / B&W / Enhanced upload selection |
| Shift+Q / Shift+W / Shift+E | Toggle the corresponding local favourite |
| [ / ]; A; G | Change active panel; toggle its selection; select, save and advance |
| + / minus; 0 | Zoom in/out; fit and reset |
| Shift+arrows | Pan the active zoomed image |
| C; V; R | Crop; Original/Cropped switch; refresh |
| F1 / ? | Open help |

The folder tree has its own arrow-key navigation; Enter/Space opens the focused photo. Text inputs and open dialogs retain their normal keys. In the crop editor, **Ctrl+Enter** applies, **Escape** cancels/closes, arrows nudge a focused handle and Shift+arrows nudge faster.

### Use the AJAZZ AKP03E

Use the controller panel for PhotoGoGo’s managed connection, brightness, layouts and saved Lightbox dial assignments. A displayed layout preview alone does not prove a USB connection.

When automatic control is enabled, PhotoGoGo takes control of the supported device and stops the supported AJAZZ application as part of takeover. Release/close PhotoGoGo before returning to the vendor application; restart that application manually if needed.

The normal Lightbox layout provides Trash and three lower Google version-selection controls. Use **Lightbox dials** to assign the three dials’ turning and pressing actions. **Identify the large dial** lets you map the physical control deliberately, then apply the assignment.

Check **Connected** before reviewing. **Looking for AKP03E** means the expected device was not found; **Reconnecting** means an opened connection later failed. Capture the actual operation/error in the panel or controller log. Unsupported or ambiguous interfaces are not guessed. Saved custom brightness can differ from the current full-brightness default.

Try navigation, each lower selection key and Trash on a small test event before a long review. Confirm one press toggles once and each lower button affects the displayed version. The controller follows the active page and its modal/save safeguards; it is not a general keyboard-injection tool.

## 16 Maintain the library and optional features

### Use Cleanup deliberately

**Reprocess Staging Tree → Queue Reprocess Job** rechecks existing staged files, can correct names/timestamps and ensures MD5 sidecars. It is maintenance, not another routine card import. Saved RAW ownership can prevent an identity-changing reprocess; resolve the reported condition rather than deleting metadata to force it.

**Collect Trash** is a real move. It takes individually named **{trash}** files into staging’s **Trash/** folder, with collision-safe names. It is not a capture-family collector: moving a tagged JPEG can separate it from its RAW pair or leave derived versions elsewhere.

For an ordinary reviewed RAW/JPEG/crop library, leave Trash marks and use the transfer/archive exclusion rules unless you have deliberately checked the maintenance consequences. Do not assume a marked capture means all associated files will move together.

### Optional Face Identify

The separate **Face Identify** menu opens **Face Recognition**. It scans videos in staging, or archive if staging is unset. It is not the manual Video snapshots workflow and is not required for still-frame selection.

This advanced page needs its own environment. The current setup supports Python 3.8–3.11 and can download packages/model data. It creates a per-user managed environment outside staging, normally under **%APPDATA%\PhotoGoGoV2\face_scan_env**. Its **.faces_db.json** database is saved at the staging/archive root used by this page; a selected subfolder limits the videos scanned, not that database location. The database can contain face embeddings and source paths. Review that before sharing the folder.

The current visible workflow has limitations: labels are generated person IDs, and the page does not provide a complete populated match-results browser after person search. Use Jobs/logs for the queued work and counts. Do not make this page a prerequisite for the reliable photo/import/Studio/Snapshots workflows.

### Optional AI review and experimental finishing

Studio AI review is an explicit cloud action requiring the panel's API key, consent and separate billing. Ordinary local importing, JPEG/RAW processing and manual Snapshot selection do not need that review.

Subject-aware sharpening/segmentation and the GPU Tripod experiment are outside the released 2.0.51 workflow. A saved development checkpoint or research note is not a menu feature to enable.

## 17 Solve common problems

### Lightbox opens slowly or comparisons are missing

Check the current source family first. Camera JPEG comparisons do not appear as RAW-developed outputs. Select Camera JPEG for existing JPEG work. **No image** is different from a failed existing image, which offers Retry.

In a large folder, wait for capture checks while browsing/zooming remains available. Use **Retry capture checks** for an incomplete scan. Refresh after generating comparisons elsewhere. For a persistent problem, record time to first image separately from time to “Ready to review”, and whether storage is local, USB or network.

### Crop or Google checkboxes are disabled

Wait for the original and identity checks, and finish pending saves. Crop requires a supported JPEG source; a paired Camera JPEG is valid, a RAW preview is not. A missing or failed comparison cannot be selected as if it existed. Resolve the visible save or metadata warning before preparing a transfer.

### RAW looks dark or the preview differs from the saved finish

Try the **Internet ready** starting preset and inspect Auto finish around 65, then adjust to taste. Check highlights and natural detail at 100%. A camera JPEG, an embedded preview and a newly developed RAW can have different tone/colour treatments.

Confirm which source family is displayed and refresh the finished results. A draft preview is not an already published full-resolution output. Keep the original JPEG as a comparison.

### Snapshot export is disabled or a saved image is tiny

Select a photo into the tray, choose a destination, confirm the source shooting start/offset and wait for session saving/export work to finish. An already exported selection may not need another export to that same destination.

Use **Export full-resolution photo(s)**, not a browser save of the browsing preview. Check the destination’s year/month/day subfolders, and use **Show original in folder**. A crop reduces retained pixels on the improved copy; the unenhanced export remains the full frame.

### A video export is missing clips added later

Check the inclusion boxes and the current N clips. Prepare the added clips and choose **Create updated final video**. **Resume saved render** intentionally uses the saved job’s earlier clip list. It is not evidence of a file-size limit.

### A scorecard or music change appears to require stabilisation again

Keep the saved project and verified clip-render folders. Check whether only finishing settings changed, or whether a picture/output setting also changed. Use the updated final assembly when the picture caches remain valid.

If media moved, use **Relink media** and inspect the verification result. Do not clear all renders merely to update a score, opening title or music file.

### Google Photos contains pictures but the job shows an error

Read accepted and verified counts separately. Use the existing job’s **Retry / Resume / Recheck verification** control as offered. A single photo can have a read-back issue while other work proceeds. An unavailable read-back is not automatically a missing cloud photo, and a visible album is not proof that all receipts verified.

Keep the same client/account and obtain **Copy diagnostics**. Reconnecting may resolve an expired testing token; account reset or a replacement job can lose useful continuity.

### A re-import creates or reports another day folder

With a unique named day, current importing reuses it. Check for both a bare numeric folder and a named folder, or several names for the same date. Resolve the ambiguity deliberately. The importer does not remove earlier duplicates automatically.

### Archive copy is slower than expected

Use Auto, check phase timings and inspect the destination connection. Verification intentionally reads data again. A high disk peak does not prove that video decoding, source reads, destination writes or Wi-Fi are equally fast. Avoid changing several concurrency controls at once while assessing one representative run.

### A project or session cannot find media on another PC

Confirm the actual drive, path and file contents. Studio offers **Relink media**; Snapshots preserves source choices and offers **Retry video** after the exact original is reconnected. Portable project/session files do not contain the media itself. Google setup and job history also do not automatically follow the media folder.

## 18 Reference and further help

### File and metadata reference

| Item | Purpose | Retention choice |
| --- | --- | --- |
| Original JPEG or CR3 | Camera photograph / RAW master | Keep according to your original/backup policy |
| _improved.jpg and _BW.jpg | JPEG task outputs | Choose independently for review, publication and archive |
| _crop.jpg and crop comparisons | Non-destructive crop family | Keep its crop receipt if you want to revisit it |
| RAW-developed / RAW B&W outputs | Separate recipe-based generations | Preserve RAW ownership metadata alongside desired versions |
| .photogogo-event.json | Structured event description | Include library metadata for portable descriptions |
| .photogogo-curation.json | Local exact-version selections/favourites | Not an OAuth credential store |
| .photogogo-raw.json | RAW recipes, ownership and viewing choices | Keep with the event for later RAW work |
| photo_crop.photogogo-crop.json | Example crop receipt filename | Keep with the associated crop family |
| .snapshot.json | Exported frame provenance/settings | Can contain the original video path |
| Studio project / Snapshot session | Saved work referencing media | Keep source media accessible as well |
| master_hashes.md5 and transfer records | Archive checksums and recovery | Archive-owned operational records, not disposable staging cache |

### A final check before sharing or archiving

Confirm the intended versions, output dimensions and destination. Decide whether location metadata should be removed from upload copies. Keep the project/session and supported library metadata needed for your future work. Review provenance files before sharing paths outside your own library.

A selection, approval, preview, queued job and verified result are different states. Check the last one that matters for your task before deleting a source or declaring delivery finished.

### Version and evidence

The media workflows in this guide were checked against released PhotoGoGo 2.0.51, application source **8ffa47b**, with package record **6bcf6ee** and release delivery recorded on 9 November 2026. The embedded illustrated Help centre is added in 2.0.53; its validation is recorded separately in the 2.0.53 validation note. This guide describes application behavior; it does not substitute for testing your own media, account permissions, hardware or storage. The paired-camera, controller and optional-environment conditions described above still apply. Screenshots use demo settings and illustrative media, with no private photographs or accounts.

Application reference notes are in the repository’s docs folder: **lightbox-controls.md**, **cr3-raw-development.md**, **PHOTO_PROCESS_AND_LIGHTBOX.md**, **LIGHTBOX_CROPPING.md**, **device-aware-imports.md**, **name-events-workflow.md**, **STUDIO_FINISHING.md**, **studio-camera-audio.md**, **studio-prevent-rotation.md**, **STUDIO_RELINK_AND_PREVIEW.md**, **STUDIO_REVIEW_AND_SCORE_DEFAULTS.md**, **VIDEO_SNAPSHOT_SESSIONS.md**, **google-photos-transfer.md**, **archive-transfer.md**, and **akp03e-controller.md**. Historical release/checkpoint notes can describe older behavior; use this guide’s version boundary and the current screen labels.

Official external requirements checked for this guide:
- [Google Photos Library API getting started](https://developers.google.com/photos/library/guides/get-started-library)
- [Configure a Google Photos application](https://developers.google.com/photos/overview/configure-your-app)
- [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2/#expiration)
- [YouTube video chapter requirements](https://support.google.com/youtube/answer/9884579?hl=en)

For support, provide the version, job/page, exact action and sanitised diagnostics. Keep passwords, tokens, private media and broad environment dumps out of the report.

