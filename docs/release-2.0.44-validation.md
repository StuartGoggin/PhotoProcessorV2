# PhotoGoGo 2.0.44 — directory event actions

## Change

Photo Lightbox, Photo Process and Video Timeline / Staging Explorer open a shared Name Events side panel from directory actions: right-click, the visible ⋯ button, or Shift+F10. Native-recognised days load only that date and its structured or legacy description; nested folders resolve to their owning event. Period actions start with no dates checked. The existing reviewed core job retains collision, overwrite-consent, root/date, stale-review and writer safeguards.

Opening/cancelling preserves source-page state. Pending Lightbox selections drain before preview/apply. An unsaved per-photo RAW override or active RAW action prevents Apply. Originating views refresh before the editor unlocks; path restoration uses fresh native evidence, including completed moves from a partial failure. Missing Photo Process scopes block queueing rather than widen it. Restored missing/foreign jobs cannot infer path moves or automatically resubmit work.

The review explicitly warns that saved Studio projects, snapshots, upload plans and Timeline tags/groups can retain old paths. This increment does not migrate those stores. No user media has been renamed during development; tests use synthetic folders/IPC, except the read-only supplied-file installer decode smoke.

## Validation checkpoint

- 336 native tests passed; zero failed, with 28 opt-in tests ignored in the ordinary suite. Native source and media runtimes are unchanged in this increment.
- 13 new directory-action browser groups passed: right-click/keyboard/cancel preservation, period/nested/legacy scope, overwrite consent, deferred refresh and exact-photo restoration, unsaved RAW protection, metadata-only Timeline completion, stale menu/preview rejection, crop restoration, partial failure, pending curation saves, missing/foreign recovery, unresolved processing scope and 360-pixel keyboard focus. Desktop and narrow screenshots were inspected. The focus test caught hidden disclosure controls in the Tab boundary; visibility filtering was corrected and the complete suite passed again.
- 97 existing browser groups/checks passed across Lightbox (13), exact selections (11), controls (14), RAW Lightbox (8), Photo Process (13), RAW Development (13), Google Photos (15) and Archive (10). The existing standalone Name Events and Timeline preview workflows also passed.
- Fifteen new path/context unit cases, twenty catalogue/cache/recipe tests, seven keymap checks, four curation-persistence boundary checks, naming composition checks and TypeScript passed.
- Two approved bounded helpers reviewed the shared editor, lifecycle, recovery, selection safety and overwrite/cache boundaries. Identified stale-source, metadata-only Timeline, RAW-draft and focus issues were addressed. Their source reviews are separate from executed tests.

Local evidence: `test-output/tree-event-naming/` contains the native log, browser report/screenshots and core/Lightbox/editor/transfer regression logs. These generated files are not release source.

Package build, inspection, source identity and delivery receipts will be recorded below after completion. Browser checks exercise production React components with deterministic native adapters; they do not establish a real collection's rename throughput or a successful upgrade on the render PC.

Guide: [Name Events workflow](name-events-workflow.md).
