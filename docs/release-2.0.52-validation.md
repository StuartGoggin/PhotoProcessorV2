# PhotoGoGo 2.0.52 validation and publication

Status: release approved; final packages for the automatic-Reviewed amendment are being rebuilt. No 2.0.52 release has been published yet.

## Final scope

- Current-folder Lightbox quick views: All, Needs review, Reviewed, Google-selected, Rated and Favourites; independent Trash visibility; filename capture time, natural name, rating and original-size ordering. One projected order drives tree, keyboard/controller navigation and bounded read-ahead.
- Successful rating/tag, Trash/restore and exact-version Google selection/favourite decisions automatically mark the canonical capture Reviewed, including cropped versions and verified RAW/JPEG pairs. M still clears or sets the flag. Browsing, zoom, source/view changes and editor opening do not mark it. Historical ratings/selections are not migrated.
- A bounded view-independent writer reserves the secondary update before the primary operation. It validates immutable identities and receipts and completes accepted work after unmount. Primary failure creates no Reviewed write. Secondary failure preserves the primary change and keeps the photograph in tree, count and image until retry or deliberate filter change. Review-only retry never repeats Trash or a checkbox toggle.
- An illustrated offline Help centre, contextual links, search, text sizing, figure enlargement, printing and portable HTML. The reader preserves workspace state and blocks background input; accepted saves and Jobs can finish while it is open.
- Independent `.photogogo-review.json` metadata, atomic writes, source stamps, bounded parsing, portable event-folder renames and archive library-metadata classification. The strict legacy Google curation schema is unchanged.

## Verification

- Native library suite: 416 tests, 30 opt-in media/hardware tests ignored. Fresh pre-publication results are in `test-output/release-2.0.52-prepublish-native.log`; earlier successful run is `test-output/lightbox-review-native-all.log`. Runs are serial because existing RAW publication tests share process-wide state.
- Automatic-review browser suite: 11 cases covering passive actions, tag rename/idempotence, exact next, rapid flags, primary/secondary failures, Trash and cleared-rating failure pins, paired RAW, old-root unmount and cropped versions. Queue boundary suite: 6 groups; projection/status/preferences: 22 assertions including 760 synthetic originals.
- Existing browse browser suite: 11 groups; Lightbox: 13; controls: 21; selection workflow: 11; command map: 7; curation queue: 4; controller routing: 22. The measured 760-original sort/navigation fixture uses 14 preview reads; this proves bounded work rather than real target-disk throughput.
- Help host: 7 groups. Actual-page/capture suite: 5 groups including pending selection completion behind Help and Snapshot shuttle suspension. Document: 7 groups, 503 source fragments, 18 chapters, 11 self-contained illustrations, no external requests, desktop/mobile, no-script and print proof.
- Independent read-only review found no remaining material issue after rechecking deferred-write lifecycle, identity mapping, secondary failures and tree/count pinning. No helper changed files or used accounts/media.

## Package provenance

The initial explicit-only local test installers were superseded before publication at Stuart's request. Their inspection receipt `test-output/release-2.0.52-inspection-20261109T051857041Z/report.json` is retained as historical evidence; its artifact hashes do not identify the forthcoming automatic-review packages. Final source, package hashes, compiled-guide parity and inspection receipt are appended after the rebuild.

## Limits and target-PC acceptance

UI fixtures use synthetic media/native replies. No live Google upload, account reset, physical controller use, app installation or render-PC operation occurred. Native tests use owned temporary fixtures. The app was not launched against this PC's saved settings, which could resume Jobs or claim the controller. Browser DOM isolation and compiled-asset parity do not establish a live native WebView IPC security test.

Test a small event: mark a rating, Trash/restore and each version's selection/favourite; confirm Reviewed fills after saving. Try Needs review and Shift+rating once, then clear Reviewed with M and reopen the folder. Compare tree and controller order. Open Help during a pending decision, return and confirm state. Existing 2.0.51 installers remain available for rollback; older versions ignore the independent review record.

## Workspace

Source checkout: C:/creations/PhotoGoGoV2, branch SWG/photo-review-upload-recovery, initial base bed2a76b57fcb922c701efb48746e860acd31a72. Four unrelated cleanup files remain untouched and excluded from commits. Other pre-existing worktrees remain untouched. The chat's initially unused illustrated-user-guide worktree was not used to build this source.
