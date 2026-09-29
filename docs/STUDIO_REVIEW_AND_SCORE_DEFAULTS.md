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
2. Set the layout and all three default text lines: **Top line / heading**, **Main line / result**, and **Bottom line / subtitle**. Tables also have column headings and an initially blank row count.
3. Enable **Prepare scorecards from this project template**. It prepares independent cards for clips without an existing scorecard. Newly imported clips use the same starting defaults. **New cards start OFF, even when the default text is filled in.** Existing cards keep their on/off settings.
4. Open each clip's **Scorecard** tab and edit its individual text or table values. You can edit while the card is off. Select **Include scorecard** only for clips that should display a card.

After enabling a prepared card, it says **Needs results** until its result line (line/result layouts) or at least one table cell (table layout) has content. A nonblank project default in the result line counts as content, but never enables the card by itself. Common headings and subtitles alone do not activate it. Off or blank prepared cards do not add graphics, standalone-card duration or chapter offsets to the export. Clearing results hides them again. Existing legacy cards retain their previous behavior.

The project template is a set of **starting defaults**, not a live overwrite of every card. Later template edits affect future cards only until you deliberately apply an update. **Prepare missing cards** fills only clips without a card. Disabling the project template stops future seeding; it does not delete or disable existing cards.

### Review changes to existing scorecard text

1. Edit the project defaults, then select **Update clip scorecards from project defaults…**.
2. The review lists only differing lines, grouped by clip. Each item shows **Current clip text**, **Proposed project text**, and a warning if applying it would replace or clear existing text.
3. **Nothing is selected automatically.** Check each line you want to update. Leave an individual score, name or other custom line unchecked to keep it exactly as it is. Selecting an empty proposed value deliberately clears that line.
4. **Select blank items · all clips** selects only completely empty current lines and deselects replacements. It operates across every clip, including clips hidden by the review's search. Whitespace-only lines are treated as existing text and still need an individual choice. **Clear selection** unchecks everything.
5. Review the selected/replaced/cleared counts, then choose **Apply selected text changes**. Cancel or Escape discards the review choices without changing any clip cards. Project-default edits made before opening the review are retained.

Cards switched off and clips excluded from the final video are labelled in the review; updating their text does not enable or include them. Only the selected heading/result/subtitle fields change. Layout, table headings and cells, timing, clip names/titles, approval, revisions and cached picture renders are retained. If the underlying defaults or scorecards change during review, Apply is blocked; **Refresh review** rebuilds the list with nothing selected. Opening/resetting a project discards the old review.

Create a new final export to see changes to enabled cards. Earlier exported videos and saved snapshots are never rewritten by this action. Autosave keeps the working project; use **Save snapshot** for a durable project copy.

Compatibility: this build loads older projects with a blank default main line and preserves existing enabled cards. PhotoGoGo 2.0.23 does not understand the new project-template `result` field. Keep an original pre-upgrade project snapshot if you may need to return to 2.0.23; save edited work to a new snapshot.

Project graphics appearance is still shared. Scorecard timing follows the project when the clip is set to **Use project default**; per-card timing overrides remain available. Scorecards are composited after stabilisation during final assembly. Editing the template/results does not invalidate picture approval, picture revision or the stabilised render.

## Validation and delivery boundary

The implementation includes queue regressions, native cache/source/bounds tests, native saved-project/template validation, a synthetic frame-cache smoke, a real scorecard assembly/cache-reuse smoke, and browser checks covering settings, reopening, new clips, metadata/title separation and compact layouts.

Useful checks:

```powershell
node scripts/test-studio-review-frames.mjs
node scripts/test-studio-graphics.mjs
node scripts/test-studio-review-browser.mjs
node scripts/test-studio-scorecard-updates-browser.mjs
pwsh -NoProfile -File scripts/test-studio-review-frames.ps1
```

This change does not itself commit, package, publish or install a release.
