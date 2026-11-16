# PhotoGoGo 2.0.56 — fast capture culling and reviewed removal

Status: all source, optimized-throughput and compiled-Help checks passed. Installer validation and delivery are pending; no 2.0.56 installer has been published yet.

## Approved scope

- Immediate local Trash/Restore and next-original navigation through the current visible ordering, with bounded ordered background saves, explicit failure/retry state, close protection and no per-decision tree refresh.
- Portable full Trash/Restore audit history, Undo/Redo including the coupled Reviewed change, exact physical-file identities, replay revision fences and idempotent retry/restart recovery. A permanent-removal boundary cannot restore deleted bytes.
- Enhanced/B&W/RAW processing excludes rejected captures and their crop inputs. Job/preview preparation waits for review saves. JPEG-first review and exact-file Google selections remain distinct from canonical RAW identity.
- Explicit Take out the trash preview and durable executor projected into core Jobs. The approved capture includes Camera JPEG AND paired CR3, plus proven generated versions and exact sidecars. Frozen membership, before-discovery review revision, verified MD5/SHA256, Windows held-handle deletion, per-file durable intent/outcome, safe pause/cancel/retry and conservative original retention.
- Folder membership changes invalidate the frozen plan rather than authorize additional deletion. Shared application metadata, import/Google receipts, SD-card files and archive copies are retained; explicitly listed per-file sidecars can be removed. Old filename-only collection directs users to the reviewed workflow.
- Verified discard receipts skip identical content on a later ordinary import, with an explicit re-import override and visible count. Staged independent MD5 verification remains; SHA256 comparison reads the verified local copy, not another SD-card pass.
- Illustrated offline Help, controller bindings and one Windows x64 test release. No new dependencies.

## Evidence and boundaries

All development deletion cases use task-owned synthetic temporary folders. No personal photo, SD-card content, live Google account/upload, render PC or target installation was modified.

The independent reviewer checked ownership, exact-file identity, metadata CAS, reparse handling, interrupted persistence, partial retries, replay revision fences, discard-ledger validation, shared job cleanup and membership changes. Findings were corrected with regressions. The history cache compares the complete prior journal byte prefix before reusing incremental state; it never relies on timestamps alone. Complete corrupt records remain protected. Interrupted trailing bytes are preserved separately before recovery.

The journal retains confirmed history and blocks safely at its documented storage limit rather than silently dropping old decisions. Its warm cache is bounded to one journal/16 MiB; large histories remain on disk. Unrelated file changes can conservatively require a fresh removal preview. Arbitrary concurrent edits by external programs are outside application coordination; exact held-file identity and fingerprints remain enforced.

## Historical runs, not release acceptance

- Early focused native runs passed20, then30 cases. The first broader run was deliberately stopped during a slow725-decision development benchmark; a second timing run was likewise stopped while reducing repeated parsing/copying. Logs are retained; neither is reported as a passing full run.
- The subsequent full run completed480passed/3failed/30ignored. Two assertions counted the newly created coordination lock as a processing output; the RAW All fixture still expected inclusion of Trash. These were corrected against the approved behavior, preserving original-byte/no-output checks; final passing results follow.
- That pre-final development native timing was725decisions in567.158s (p50698.903ms/p951670.524ms). It is background-save timing from a debug build, not UI response or installed-release throughput. It exposed repeated folder metadata calls; final results must remain separate and must not be advertised as an achieved speed target.
- A shared Jobs polling run timed out at initial rendering under concurrent work; the fresh UI rerun passed unchanged assertions. Cause of the earlier timeout is unconfirmed.

## Final checks and delivery

- Final native library: **484 passed, 0 failed, 31 ignored**, 133.29s; receipt `test-output/lightbox-trash-native-release-candidate.log`. The ignored set comprises30optional media/hardware cases and the explicitly invoked725-decision throughput case. Crop/preview/RAW regressions from the earlier run are corrected. This includes frozen-membership protection, shared-reader exclusion, corrupt semantic discard records, interrupted journals/intents, physical-file replacement, paired RAW eligibility and preserved review identity.
- Final725actual React/Vite UI decisions with synthetic JPEGs and mocked IPC: all saved in visible order, Review complete, no extra tree scans or browser errors. Visual p50 **67.6ms**, p95 **116.1ms**, p99 **135.6ms**, max **154.9ms**. Remaining next-image readiness p50 **54.1ms**, p95 **90.9ms**. **The under50ms target was not met.** This is a UI fixture, separate from native filesystem/installed-target throughput. Receipt `test-output/lightbox-fast-trash-browser/report-final-quiet-725.json` supersedes earlier lower timings.
- Production TypeScript/Vite build passed using the installed Node launcher (the roaming npm shim was stale). Only existing bundle-size/Browserslist advisories; no dependency or global installation changed. Photo Process13browser groups, shared Google/core Jobs11, Jobs UI17, import UI10, ordered review queue/transport and the helper's Lightbox/RAW/cleanup/browser checks passed. Final frozen-source functional rerun receipt follows.
- Help host7checks and portable guide7checks passed;535source fragments,18chapters/13figures. Embedded/portable HTML SHA256 `8ff255431b1f28da154f279d475c2e844c0956e70eb46477e811d1e340aaec68`.

Explicit optimized throughput, compiled Help parity, source commit, installer extraction/runtime/hash/upgrade validation and publication receipts will be appended here. Keep2.0.55 installers for rollback. All build-producing tests precede the final installer build; no installation is part of validation.

### Completed source gates

- Application implementation commit `ef153db7b9822f2600121a2b511986183b8a773a`. Subsequent pre-build checkpoint changes only validation/plan prose.
- Explicit optimized native725test passed1/1: **71.869s**, p50 **90.191ms**, p95 **152.215ms**, p99 **180.270ms**, max **220.246ms**. Receipt `test-output/lightbox-trash-native-throughput-release.log`. This is the real native review journal/filesystem over task-owned synthetic originals on the development PC. It is separate from mocked-IPC UI measurements and target-PC/media performance. Do not compare its elapsed time directly with the earlier debug-build baseline as an algorithm-only gain.
- Final frozen UI fast-Trash12/12 and Lightbox controls21/21 passed with zero browser errors, no edits; timing report SHA256 `63899054294b4a710ba0797f4b7d47c14b00742d39fafdd3c9adad41a900ca76` unchanged.
- Compiled release Help parity passed1/1 against the generated guide; receipt `test-output/release-2.0.56-compiled-help.log`.
- Standalone bounded import pipeline passed29/0failed; two child-probe functions are ignored in the outer listing and explicitly invoked by their normal parent tests. Receipt `test-output/release-2.0.56-import-pipeline.log`.
- Final independent review found no remaining code safety blocker. Evidence wording was corrected to distinguish mocked IPC, real native filesystem operations, shared application metadata and explicitly removable per-file sidecars.

## Verified packages

Built source: `75067cb2c4b2ad383963559ab8ad0a7d7ef0245f`; build ID `20261116T033453131Z-75067cb2+local`. The local suffix reflects the four preserved unrelated untracked cleanup files; tracked application source was clean. All build-producing tests preceded this final installer build, and no Cargo/build-producing check ran afterwards.

Both installers built successfully and passed non-installing extraction: `release-2.0.56-inspection-20261116T034549824Z/report.json`, complete=true. Both packages verified35payload hashes, ExifTool13.59 with2,205files/relocated runtime, RAW5.13 with440resources, controller pinned upstream archives/28modified sources/licences, and matching managed media/source. UpgradeCode `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` is unchanged from2.0.55. Application normalized SHA256 `863e85982f6437424971fbf43febf060e47fdfe3c0709a7676685fd59de8b53f`; only the expected3-byte Tauri bundle marker is normalized. These are unsigned test installers.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
+| PhotoGoGoV2_2.0.56_x64_en-US.msi | 223,638,228 | `709dd021a4b0f294981a7d6ce334a56dca24d41bb8a83af6171e62f291b71bc6` |
| PhotoGoGoV2_2.0.56_x64-setup.exe | 132,356,514 | `1b0b8befc08584674dedfced8c4de9aab5cc5d611a37731156e24d7373412d8a` |
| PhotoGoGo_User_Guide_2.0.56.html | 1,325,795 | `8ff255431b1f28da154f279d475c2e844c0956e70eb46477e811d1e340aaec68` |
| PhotoGoGo-FFmpeg-rowtest1-source.tar.gz | 49,570,807 | `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8` |

The matching unchanged FFmpeg source asset on GitHubv2.0.53 was reverified by server digest and size before linking it. Installer/source publication, Slack read-back and final checkout synchronization follow. Keep2.0.55 rollback installers.
