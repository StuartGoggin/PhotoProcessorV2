# Name Events workflow

The page follows **Choose dates → Describe one event → Review and apply**. It replaces the separate composer/plan/library screens with a compact date list and one event editor.

## Everyday use

1. Open **Name Events**. Start with **Unnamed**, or switch to **All dates** to revise an existing event. Search and month filters reduce the list.
2. Check the dates for one event. Shift-click selects a visible range; **Select weekend** adds the adjacent Saturday or Sunday. Dates hidden by a filter remain selected, with an explicit notice.
3. Choose a suggested starting point or favourite, then enter the **Event group**, **Event type**, and optional **Venue**. Type new values freely. Suggestions follow the chosen group; Mounted Games Victoria includes Teams, Pairs, and Individuals.
4. Optionally include the month and year. These come from the selected dates, including cross-month/year events. For example: **Mounted Games Victoria - Teams - Ayr Hill - October 2026**.
5. Review the exact current and proposed folder names. Each existing event being replaced requires its own checkbox. **Apply** queues the existing naming job, with progress and pause/resume/stop controls on the page and in Jobs.

The folder remains in the established `YYYY/MM/DD - Event group - Event type - Venue` layout. The month/year suffix belongs to the event title and is not duplicated in that day-folder name. Photo filenames, image pixels, and original/derived image bytes are unchanged.

**Use a custom event name** preserves older wording without trying to infer fields from hyphens. Clicking a date name opens that date's saved description; checking its checkbox adds it to the current group. Adding a checkbox does not silently load or apply another event's description.

## Reuse and older data

- **Favourites & recent events** saves recurring descriptions and tags, never the selected dates. A favourite with the same name requires explicit replacement consent. Changing a favourite does not rename any existing folder.
- Recent descriptions are recorded after successful naming. Editing fields alone does not add a recent event.
- The unfinished editor draft, selected paths and active job identifier are saved locally per staging directory. A missing job after an app restart produces a notice and refresh; it never automatically resubmits a rename.
- **Previous names & archive lookup** retains access to the old naming library. Archive lookup reads the selected unnamed dates; choosing a result loads its wording as a custom description for review. Ambiguous same-day archive matches produce an error instead of guessing.
- The old naming catalogue is retained. New favourites and recent descriptions use `event-naming-library-v1.json` in the application configuration directory, so an older archive scan cannot overwrite them.

## Persistence and failure behaviour

Each named day folder has a small `.photogogo-event.json` sidecar containing schema version 1, the structured description, the selected dates and the composed title. Copying the complete folder with this sidecar preserves those fields. Folders without it remain usable as legacy custom names. Keep the sidecar when moving folders between machines. The existing archive transfer includes the event sidecar; internal naming locks and unfinished temporary files are excluded.

The native preview validates the staging root, real calendar dates, leaf names, target collisions and metadata size/version. Apply checks the reviewed folder name and metadata checksum again. Changed inputs require a fresh review. Linked/reparse paths and out-of-root sources are rejected.

Metadata is written through a unique temporary file and an atomic file replacement. If publishing the metadata fails after the directory move, the operation attempts to restore the original folder name. A rollback failure reports the actual remaining path. This is per-folder recovery, not an all-or-nothing transaction across several dates: completed changes are retained, and the job shows how many completed before a failure or stop. After a crash, refresh and review the remaining dates before retrying.

A staging-directory lease prevents simultaneous naming writers. Active import/processing/transfer jobs and Video Studio renders are checked before naming and between folder changes. The Google Photos writer lease also prevents an active upload from racing the rename. Finish other work first and do not start new jobs while naming; there is no general transaction coordinator across every application or external process.

Renaming changes paths. Saved Video Studio projects and snapshot sessions may need relinking; saved upload plans may need rebuilding. The review explicitly warns about this. The feature does not rewrite arbitrary saved projects or Google account data. A failure to update recent suggestions after successful renames is reported as a warning, not as a failed folder operation.

## Validation

All automated naming tests use synthetic folders or browser fixtures, not a real photo collection or Google account.

```powershell
node scripts/test-event-naming.mjs
node scripts/test-name-events-browser.mjs
pwsh -NoProfile -File scripts/test-event-naming.ps1
npm.cmd run build
```

The browser runner accepts `PHOTOGOGO_PLAYWRIGHT_PATH` for a bundled Playwright installation. The native runner accepts `-TargetDirectory` to reuse an existing Rust build cache; it disables installer resources for the test process only.

Coverage includes exact date/title composition, cross-month and year boundaries, legacy wording, original-byte preservation, folder/metadata read-back, overwrite consent, stale snapshots, no-op and metadata-only edits, collisions, traversal, invalid dates, linked folders, storage failure and rollback, favourites persistence, corrupt data, parallel naming writers, archive ambiguity, draft recovery, tags, single-flight Apply, completion, and compact layouts.

## Integration boundary

This feature changes the Name Events page and native naming commands, plus a narrow archive-transfer exclusion for internal naming work files. The only Google Photos change is a small lease adapter for folder naming; it does not alter upload selection, authentication, or failure diagnostics. Existing preview/processing/stabilisation engines are unchanged. Installer versioning and publication belong to the coordinated release after this feature is integrated.
