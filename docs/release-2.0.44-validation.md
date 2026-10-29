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

Browser checks exercise production React components with deterministic native adapters; they do not establish a real collection's rename throughput or a successful upgrade on the render PC.

## Built source and finished packages

Built source: `d6df2f52f3c7b1e980f3dd934f40efc897bc849a`, from the clean `SWG/tree-event-naming` checkout based on `4423d652`. The optimized native build and production frontend passed. The four existing native warnings and frontend bundle-size/Browserslist notices remain; no new build errors occurred.

The installed frontend identifies `2.0.44 / 20261029T212040916Z-d6df2f52+local`. The `+local` suffix comes from Vite 5 creating `vite.config.ts.timestamp-*.mjs` before evaluating the configuration's untracked-file check, then removing it. The previous 2.0.43 build log has the same suffix. Source status was clean immediately before and after building; no app-source difference from d6df2f52 is being omitted. This receipt records the literal marker rather than claiming it lacks that suffix.

`test-output/release-2.0.44-inspection-20261029T213142966Z/report.json` reports `complete: true`. Both unsigned packages were extracted and inspected without installation using the existing compact verifier. Application hashes match the standalone executable after normalizing only the expected Tauri bundle marker. Media hashes, exact 2,205-file ExifTool 13.59 closure, 440-resource RawTherapee 5.13 closure and source/licence payloads all passed. No dependencies or pinned runtimes were updated.

Both relocated package runtimes decoded the supplied CR3 with the accepted Auto-finish-65 profile and PATH empty: 6014 × 4016, `RTv4_sRGB`, source hash unchanged. These smoke runs validate runtime packaging, not universal camera/lighting quality or render-PC throughput. Temporary extraction trees were removed; reports remain.

MSI ProductVersion is 2.0.44; UpgradeCode remains `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` from 2.0.43. No event-sidecar schema changes were introduced; 2.0.43 and earlier retained installers remain locally available. Use a copied small event for the initial naming test, especially if saved path-based projects or tags are involved.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.44_x64-setup.exe | 130,083,537 | 94435EA7B16BE84EC42C8011884DB137BA874B784610643A376725C311A270DD |
| PhotoGoGoV2_2.0.44_x64_en-US.msi | 220,946,552 | 9891154C29FE726C2FE5EEA83FBB5B29BD02C39DF7D46B19CC1D9B2CF18A0808 |
| photogogo-v2.exe | 30,018,560 | 6A448A031BAF69B5D31D8E5503FD41DCE311E379B7CC6361237152C6B9E7CB0E |

## Delivery

GitHub and Slack receipts will be appended after verified publication. Other chats' local master and subject-finishing worktrees remain unchanged.

Guide: [Name Events workflow](name-events-workflow.md).
