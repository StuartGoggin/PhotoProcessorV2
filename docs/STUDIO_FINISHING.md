# Titles, chapters and scorecards

The Studio has two stages: reusable picture renders (including stabilisation and replays), then a final export that adds scorecards, the project opening title, camera-audio processing, music and publishing chapters.

## Change a score without stabilising again

1. Open your saved project with its existing rendered clips still available.
2. Select a clip and open **Scorecard**. Enable the card and enter its result or table.
3. In the project settings at the top, open **Graphics** to choose the shared font, palette, accent, position and default timing. A clip set to **Use project default** follows those timing changes; other clips keep their explicit override.
4. Use **Rendered preview** to inspect one frame drawn by the actual export compositor. It never starts stabilisation. The background label tells you whether it is verified stabilised footage, an original-footage illustration, or a standalone card. The live layout sketch is illustrative, not a rendered video frame.
5. Choose **Final Export**. When every included picture render is current, this is a verified finishing-only export. If a cached file or source fails verification, the job stops with an explanation instead of silently restabilising it. If there are genuinely pending picture edits, the normal complete-video workflow prepares those clips first.

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

**Segment / chapter name** is the publishing name. Edit it in the clip's Titles tab or in **Chapters & finishing**; both edit the same project field. Reorder the chapter list to reorder the included clips. Chapter edits and reordering reuse the pictures.

The **clip title** is separate text shown on the video. **Use chapter name as title** copies the current name into it; it is not a permanent link. Changing a visible clip title requires its title fragment to be refreshed. The unchanged stabilised base can be reused when its verified cache remains available.

Existing projects retain their legacy title appearance. To use the new shared typography, enable **Use shared style for opening and clip titles**. A theme change updates visible titles as well as scorecards, so titled clips may need a title-fragment refresh. Segoe UI, Georgia and Trebuchet MS use the corresponding installed Windows fonts; missing fonts cause an explicit error rather than a silent substitution.

Final export produces measured embedded video chapters and a YouTube description. Editing the publishing text of an already-finished export does not modify the project or inject graphics into that existing video. Edit the project and export again when you want different pictures, scorecards or chapter timing. YouTube's chapter requirements can still produce warnings for very short clips or result cards; the app does not pad your footage to conceal them.

## Card limits and preview

Use a lower-third line, a result card, or a table with up to five columns and eight rows. Table headings/cells allow 24 characters each. Longer entries wrap without dropping characters; dense tables scale to stay inside the safe area. Inspect the native preview at your intended output size, especially for dense tables or unusual characters. The installed font determines which glyphs are available.

The new export is saved in its own folder only after its frame count, format, audio and chapters pass validation. The saved request is immutable: editing the project while a job runs changes the next export, not the one already queued.
