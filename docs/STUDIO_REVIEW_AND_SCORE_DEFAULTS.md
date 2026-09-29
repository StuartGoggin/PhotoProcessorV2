# Review frames, chapter names and scorecard defaults

## Automatic review frames

In **Settings → Video Studio review frames**, choose:

- **All project clips when Studio is idle** (default): selected clip first, then the other clips.
- **Selected clip only**: prepare samples when you select a clip.
- **Manual only**: show available cached samples; use **Generate review frames** to prepare new ones.

Choose **4, 8 or 12 frames** per clip (default: 8), then **Save Settings**.

Preparation runs only while the Video Studio page is open. It uses one decoder at a time, pauses for queued/running/paused Studio jobs, and stops scheduling when you leave Studio. A frame already being decoded is bounded to 30 seconds and 1 MiB. Cached frames can still be viewed while jobs are active. Automatic thumbnails are local only: they do not approve clips, upload anything to AI, or change your source footage or renders.

Thumbnails use a disposable 128 MiB application cache, separate from source footage, project snapshots and stabilised video. Reopening reuses matching frames. Old disposable entries are evicted as needed. **Refresh review frames** forces a fresh set and retries a failure once Studio is idle. Review-frame source checks are lightweight; they are not the full-content verification used for rendered-video reuse. Refresh after replacing footage if anything looks stale.

Sparse frames cannot show every shake or event. Use movement preview or the original footage before approving a clip.

## Clip names are not on-screen titles

The **Clip name / YouTube chapter** field is always available above the selected clip's review controls. It controls the sequence-list label and exported YouTube chapter name. Changing it does not put text on the video or invalidate the picture render. Create an updated final export/description to deliver updated chapter labels; an earlier export remains its original snapshot.

For optional text on the footage, open **Clip title** and select **Show title in video**. Enter the title, optional heading/subtitle and duration. **Copy chapter name into title** is an explicit convenience, never automatic. Turning the checkbox off retains the text and hides it using the existing zero-duration setting. New clips start with titles off; existing configured visible titles remain enabled.

On-screen title edits can refresh the titled fragment. They preserve a matching verified stabilised base. This is separate from chapter-name-only changes, which leave picture approval and readiness unchanged.

## Prepare scorecards from a project template

1. Open **Project settings → Graphics → Default scorecard template**.
2. Set the layout, common heading/subtitle, table column headings and initially blank row count. Configure these **before** enabling the template.
3. Enable **Prepare scorecards from this project template**. It prepares independent cards for clips without an existing scorecard. Newly imported clips use the same starting defaults.
4. Open each clip's **Scorecard** tab and enter its actual result or table values. Turn **Include scorecard** off for clips that should not show a card.

Prepared cards say **Needs results** until their result line (line/result layouts) or at least one table cell (table layout) has content. Common headings and subtitles alone do not activate them. Blank prepared cards do not add graphics, standalone-card duration or chapter offsets to the export. Clearing results hides them again. Existing legacy cards retain their previous behavior.

The project template is a set of **starting defaults**, not a live overwrite of every card. Later template edits affect future cards only. **Apply to unconfigured clips** fills only clips without a card. Existing populated cards, customised cards, empty-but-configured cards and explicit Off choices are preserved. Disabling the project template stops future seeding; it does not delete or disable existing cards.

Project graphics appearance is still shared. Scorecard timing follows the project when the clip is set to **Use project default**; per-card timing overrides remain available. Scorecards are composited after stabilisation during final assembly. Editing the template/results does not invalidate picture approval, picture revision or the stabilised render.

## Validation and delivery boundary

The implementation includes queue regressions, native cache/source/bounds tests, native saved-project/template validation, a synthetic frame-cache smoke, a real scorecard assembly/cache-reuse smoke, and browser checks covering settings, reopening, new clips, metadata/title separation and compact layouts.

Useful checks:

```powershell
node scripts/test-studio-review-frames.mjs
node scripts/test-studio-graphics.mjs
node scripts/test-studio-review-browser.mjs
pwsh -NoProfile -File scripts/test-studio-review-frames.ps1
```

This change does not itself commit, package, publish or install a release.
