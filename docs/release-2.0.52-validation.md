# PhotoGoGo 2.0.52 validation and publication

Status: published and delivered. Final automatic-Reviewed packages, GitHub downloads and Slack thread were verified.

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

## Final automatic-Reviewed packages

Built source commit: `675aaad4005e0be7f797a54dcbddb9436844d4e0`. Both Windows x64 installers completed successfully. The release-mode compiled-assets test passed against the new guide and manifest without launching the application. Frontend/type build and fresh native suite passed (416 passed, 30 opt-in ignored, zero failed). All source inputs are committed; four unrelated untracked cleanup artifacts cause the existing build-label logic to append `+local`, and are excluded from the release source.

Inspection: `test-output/release-2.0.52-inspection-20261109T093143206Z/report.json`. Both extracted packages match normalized application SHA-256 `6AACA059A6CF4138157BB5980B9E1F83EE0FFE7F70FC835883935DB207B96AC1` (only Tauri's three expected bundle-marker bytes are normalized). ProductVersion is 2.0.52; UpgradeCode `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` is unchanged from 2.0.51. Each package verified 35 payload hashes, ExifTool's 2,205 files with relocated runtime check, RAW's 440 resources, media pair/source and controller source/licence closure. Packages remain unsigned. No new RAW/image-quality benchmark was run for these review/UI changes.

| Download | Bytes | SHA-256 |
|---|---:|---|
| PhotoGoGoV2_2.0.52_x64-setup.exe | 131,750,645 | `8767b36b38c1f38a6f328a08dbc2fec612f5a77d3fa5b273def768e2a2b395b2` |
| PhotoGoGoV2_2.0.52_x64_en-US.msi | 222,986,964 | `69fd76547f11029663e1ca91c347ef78ace70721a1da65afac1b423cbbb0bd81` |
| PhotoGoGo_User_Guide_2.0.52.html | 1,087,888 | `4f5e833dd7cf53de0476c61542eeb91718a280cc6c258a7a9b9d2685dca35faa` |
| PhotoGoGo-FFmpeg-rowtest1-source.tar.gz | 49,570,807 | `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8` |

The portable, public and production-dist HTML are byte-identical: 18 chapters, 11 figures, 1,087,888 bytes. `SHA256SUMS-2.0.52.txt` lists the hashes for release downloads. Source and both installer variants will be published under tag v2.0.52; the post-publication receipt on master records remote and Slack read-back.

## Verified publication and delivery

Package receipt 11edc8329ba968ea434865ddb842b5755a6d954c was atomically pushed to GitHub master and SWG/photo-review-upload-recovery; annotated tag v2.0.52 peels to that receipt. Built source remains 675aaad4005e0be7f797a54dcbddb9436844d4e0. Both branch heads and tag were read back.

GitHub test release: https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.52 (release 438945091). Published 2026-11-09T09:45:59Z; draft=false and prerelease=true. All five assets are uploaded, with GitHub server SHA-256 digests and byte sizes matching the local installers, guide, corresponding source archive and checksum list.

Personal / GoggoVille #swghermes:

- Release parent and EXE: https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794217444323699; file F0CFVR8PTK5. HTTP200 acknowledged 131750645 bytes in 154.6 seconds.
- MSI thread reply: https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794217500046139; file F0CG5PFMXV2. HTTP200 acknowledged 222986964 bytes in 254.4 seconds.
- Thread read-back verified both file IDs, version, hashes and the published GitHub/guide links.

GitHub server digests match local hashes. Slack proves the actual sender byte hashes, HTTP200 exact byte acknowledgements and visible file/thread metadata; no independent Slack-hosted download/hash was performed. No signed upload addresses or credentials are retained. Local structured receipt: test-output/release-2.0.52-delivery.json.
