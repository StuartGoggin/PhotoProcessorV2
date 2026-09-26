# Titles, chapters and scorecards

The Studio has two stages: reusable picture renders (including stabilisation and replays), then a final export that adds scorecards, the project opening title, camera-audio processing, music and publishing chapters.

## Configure the opening title

The editing workflow is **Sequence → Review → Titles & graphics → Finish & export**. These are shortcuts, not locked steps: visit or revisit any of them whenever you need.

1. Choose **Titles & graphics** in the workflow bar, or the pinned **Opening title** entry above the source clips. Both take you to the same editor and keep your selected clip.
2. Enter the main opening title and, optionally, a **Heading** above it and subtitle/event date below it. The heading is your text (for example, an event name), never a hardcoded “Opening title” label. Leave it blank to hide that line. Choose **Separate title card**, **Overlay on first video**, or **None**, and set its duration. The main title is required to show any of these lines.
3. Check the summary: a card adds time before the sequence; an overlay adds no time and is shortened to fit the first included clip. Reordering changes which clip receives the overlay. None or zero seconds hides it without deleting your text.
4. Use **Rendered preview** for an actual compositor frame. Editing controls updates only the illustrative layout sketch until you request a rendered frame.
5. Choose **Edit shared graphics defaults** for the project-wide font, palette and panel styling. The **Preview opening title in Titles & graphics** button returns to the editor. The defaults stay at project level; title content stays in the dedicated step.
6. In **Chapters & finishing** underneath, edit chapter names or use a row's **Titles** / **Scorecard** button to open that clip's existing editor. Then use **Finish & export → Create updated final video**.

The opening entry is not a source clip: it has no picture approval or stabilisation, is not filtered or reordered with footage, and does not change the clip count. Opening text, placement and duration changes preserve prepared clips. Shared style changes can also affect visible clip titles, which may need a title-fragment refresh. Existing saved projects use the same title fields; no migration or cache clearing is needed.

## Change a score without stabilising again

1. Open your saved project with its existing rendered clips still available.
2. Select a clip and open **Scorecard**. Enable the card and enter its result or table.
3. In the project settings at the top, open **Graphics** to choose the shared font, palette, accent, position and default timing. A clip set to **Use project default** follows those timing changes; other clips keep their explicit override.
4. Use **Rendered preview** to inspect one frame drawn by the actual export compositor. It never starts stabilisation. The background label tells you whether it is verified stabilised footage, an original-footage illustration, or a standalone card. The live layout sketch is illustrative, not a rendered video frame.
5. Choose **Finish & export → Create updated final video**. When every included picture render is current, this is a verified finishing-only export. If a cached file or source fails verification, the job stops with an explanation instead of silently restabilising it. If there are genuinely pending picture edits, the normal complete-video workflow prepares those clips first.

A scorecard change preserves picture approval, picture revision and the reusable rendered file. It marks earlier exports as outdated; it does not overwrite them. Overlays require an encoding pass for the affected clip's pixels, so an export is not instantaneous, but the stabilisation pass is not repeated. Keep the rendered clips and their output folders if you want to reuse them.

## Timing choices

| Choice | Placement | Adds time? |
| --- | --- | --- |
| End of main clip | Last configured seconds of the main footage, before replays | No |
| End of clip + replays | Last configured seconds of the whole clip/replay segment | No |
| Standalone card after replays | A separate result card before the next clip | Yes |
| Start of clip | First configured seconds of the main footage | No |
| Custom time in main clip | Starts at the configured offset within the main footage | No |

An overlay is shortened to fit the available footage. A custom start must be inside the clip. Export uses measured frame boundaries; editor times are estimates. A standalone card has silent camera audio while enabled project music continues. Its duration is included in the project total and subsequent chapter times.

Scorecards are composited last. The editor warns when they overlap a clip title or project opening overlay. Choose later timing or a standalone card to keep both readable; the app does not silently alter your timing.

## Chapters and titles

**Segment / chapter name** is the publishing name. Edit it in the clip's Titles tab or in **Titles & graphics → Chapters & finishing**; both edit the same project field. Reorder the chapter list to reorder the included clips. Chapter edits and reordering reuse the pictures.

The **clip title** is separate text shown on the video. **Use chapter name as title** copies the current name into it; it is not a permanent link. Changing a visible clip title requires its title fragment to be refreshed. The unchanged stabilised base can be reused when its verified cache remains available.

Each clip's **Titles** editor also has an optional **Heading** above the main title and **Subtitle** below it. A blank heading is hidden, not replaced with “Clip title”. Headings allow 60 characters; clip subtitles allow 110. A main title and positive duration are required. Preview and export use the same saved text. Opening-heading edits preserve all prepared clips; clip-heading/subtitle edits follow the normal clip review and title-fragment refresh workflow, reusing the unchanged stabilised base when available.

Saved projects from before 2.0.21 default to blank optional lines and keep their existing cache identities. Use **Save project as** to keep a new snapshot; retain the earlier snapshot if you plan to return to an older installer, which does not understand the new heading/subtitle fields.

Existing projects retain their legacy title appearance. To use the new shared typography, enable **Use shared style for opening and clip titles**. A theme change updates visible titles as well as scorecards, so titled clips may need a title-fragment refresh. Segoe UI, Georgia and Trebuchet MS use the corresponding installed Windows fonts; missing fonts cause an explicit error rather than a silent substitution.

Final export produces measured embedded video chapters and a YouTube description. Editing the publishing text of an already-finished export does not modify the project or inject graphics into that existing video. Edit the project and export again when you want different pictures, scorecards or chapter timing. YouTube's chapter requirements can still produce warnings for very short clips or result cards; the app does not pad your footage to conceal them.

## Card limits and preview

Use a lower-third line, a result card, or a table with up to five columns and eight rows. Table headings/cells allow 24 characters each. Longer entries wrap without dropping characters; dense tables scale to stay inside the safe area. Inspect the native preview at your intended output size, especially for dense tables or unusual characters. The installed font determines which glyphs are available.

The new export is saved in its own folder only after its frame count, format, audio and chapters pass validation. The saved request is immutable: editing the project while a job runs changes the next export, not the one already queued.
