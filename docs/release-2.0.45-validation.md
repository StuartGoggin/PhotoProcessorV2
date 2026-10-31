# PhotoGoGo 2.0.45 — adaptive archive transfer

## Change

Archive transfer now overlaps fresh source hashing, duplicate verification, copying, independent destination rereads and record updates per file. Auto starts with two files and probes a bounded one-to-eight limit using completed useful verified bytes; manual 1/2/4/8 limits remain available. This avoids whole-batch barriers without adding synthetic traffic to a live connection. Reviewed selections, exact version choices and no-overwrite publication remain in place.

The archive master MD5 index now uses flushed atomic replacement, a durable pre-publication recovery journal, confirmed per-run manifests and an explicit latest-transfer pointer. Legacy checksum-only archives retain their previous coverage. Uncertain publication acknowledgements are reconciled after workers join or on the next operation, rather than losing the pending records. Whole-archive and latest-recorded-transfer verification are explicit choices under the same exclusive archive lock.

The UI distinguishes copied payload from verified duplicates, reports active stages and preserves the reviewed selection when concurrency changes. Native logs expose stage timings, controller decisions, errors and independently detected index mismatches. Cancellation and pause checkpoints occur between data chunks; an already blocked operating-system network call must return or time out before that worker can stop.

## Validation checkpoint

- Full native suite: **357 passed, zero failed, 29 opt-in tests ignored**. This includes real synthetic filesystem tests for copy/dedup/verification, locks, safe naming, source preservation, cancellation, legacy migration, atomic index failure, damaged records, partial manifests and a published file whose acknowledgement is deliberately lost before recovery.
- After the final mismatch-warning addition, all **41 focused native archive tests passed** again, with the bounded measurement excluded from that ordinary run.
- Standalone scheduler/controller: **18 tests passed**. Simulated connection curves, pauses, changed conditions, probe invalidation, large-file completion windows, fixed-mode failure behaviour, bounded workers, stop handling and panic cleanup are covered. A deliberately restored old probe-reset implementation fails the regression before the corrected source passes.
- Archive browser suite: **14 checks passed**, including selection preservation, Auto/manual arguments, explicit verification scope, busy gating, copied-versus-verified counts, remembered safe preferences, stale preview protection and compact layouts. Production React components use a deterministic native adapter; this is not a live NAS test.
- Jobs polling regression and TypeScript passed. The two approved bounded helpers contributed test coverage and an independent integrity review; review findings were addressed before packaging. No dependency or pinned media/RAW/metadata runtime changes were needed.

Local evidence is under `test-output/archive-adaptive*` and `test-output/archive-transfer-browser/`. Generated logs, fixtures and test harnesses are not application source. Tests use generated local files; no user archive, Google account or source media was changed.

## Measurement and limits

The opt-in bounded filesystem measurement passed for all five modes, using six distinct 4 MiB generated files per mode, followed by whole-archive verification. It runs the production archive engine through the native test harness with application optimisation disabled and buffered local IO. The measured copy-plus-verification runs were: fixed 1, **1.554 s / 15.45 MiB/s**; fixed 2, **0.888 s / 27.04 MiB/s**; fixed 4, **0.502 s / 47.81 MiB/s**; fixed 8, **0.337 s / 71.26 MiB/s**; Auto, **0.684 s / 35.08 MiB/s**. These are sequential single samples, sensitive to caching and noise. Auto remained too short to learn beyond its starting limit; differing fixed-2/Auto samples do not establish an algorithmic speed difference. This is a correctness and bounded local timing check, not a NAS benchmark or a comparison with 2.0.44.

Auto is a bounded throughput heuristic. It cannot guarantee a saturated gigabit/Wi-Fi link or an optimal limit for every mixture of copied and duplicate files. Very short runs may end before a valid decision window; large files require actual completions. Missing or transiently inaccessible index candidates retain their rows conservatively, so Whole archive Verify may report ghost rows rather than silently pruning them. The app asks the OS for flushes and atomic replacement; a NAS must honour these for power-loss durability. See [Archive transfer guide](archive-transfer.md).

## Rollback and initial deployment test

Installers 2.0.43 and 2.0.44 remain locally available for rollback. With explicit approval, only the six generated EXE/MSI installers for 2.0.40–2.0.42 were removed to recover 678,294,566 bytes; sources, photos and validation reports were retained.

Start with a small representative reviewed selection on the deployment PC, leave Auto selected, then run Latest recorded transfer verification. Repeat the same selection to confirm verified duplicates without extra copies. Use Whole archive verification deliberately when checking the cumulative index. If a job fails or stops with recovery records pending, retain those records for the next operation. This release is packaged and inspected without installation on the render PC; actual network throughput and upgrade behaviour still require that deployment test.

After an interrupted transfer, let 2.0.45 reconcile its pending recovery journal before downgrading. Earlier versions do not understand that recovery journal or the explicit latest-transfer pointer.

## Built source and finished packages

Built source: `4951c3f788dee5723387259ce9b079cb387604de`, based on current `origin/master` at `ca05d95f440c2b360b19ee896f3786146033ad68`. The source checkout was clean immediately before building. No application source changed during packaging or inspection. An unrelated untracked `disk-scan-results.json` appeared at 03:03:31 UTC during packaging; it is untouched and excluded from all release commits.

The optimized native application and production frontend passed. Five native unused-code warnings remain: four pre-existing groups and one archive test-wrapper group. Existing frontend Browserslist and chunk-size notices remain. No dependency or pinned runtime versions changed.

The installed frontend identifies `2.0.45 / 20261031T025138198Z-4951c3f7+local`. The literal `+local` marker is retained in this receipt. Vite's temporary configuration module already caused the same marker in previous clean builds; the unrelated diagnostic file appeared later than this frontend timestamp. The application source is the committed source above.

`test-output/release-2.0.45-inspection-20261031T031229285Z/report.json` reports `complete: true`. Both unsigned packages were extracted and inspected without installation. All application bytes match the standalone executable after normalizing only Tauri's expected bundle marker. The managed FFmpeg payload/source closure, exact 2,205-file ExifTool 13.59 closure, 440-resource RawTherapee 5.13 closure and source/licence payloads passed. Both relocated packages decoded the supplied CR3 with the accepted Auto-finish-65 profile, PATH empty, at 6014 × 4016; the original hash remained unchanged. These are runtime packaging checks, not universal camera-quality or NAS-throughput evidence.

MSI ProductVersion is 2.0.45. UpgradeCode remains `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` from 2.0.44.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.45_x64-setup.exe | 130,047,754 | 462C9B4C8BA85726E3F58DEC194A30572B594A1B818BBA42020CFC7B25BD3606 |
| PhotoGoGoV2_2.0.45_x64_en-US.msi | 220,979,320 | E451508514858D867DE428419F7DDB50E34155C9C23F3C0F2A7E38964AB36D7E |
| photogogo-v2.exe | 29,970,944 | 76FEB236642C48CCAF1A55F5768128F1DC6020DE2EC6FB5E9E976DF3562A4B16 |

The first inspection passed MSI validation but exhausted disk during NSIS extraction. It was not recorded as a passing full inspection. The successful retry used a process-scoped compressed temporary directory, with no installer changes or system-setting changes. Four test executable/symbol files produced by this task were retired after recording their hashes, and five build-cache files received reversible LZX compression with identical before/after hashes. Sources, test reports, photos and retained rollback installers were preserved. Both runs' owned extraction trees and the retry temporary directory were removed; evidence reports remain. Application source was not rebuilt or changed between attempts.

## Delivery

Receipt commit `8ebc237a273b58e97b0034d5f86a914a72e9b629` was atomically published to GitHub `master` and `SWG/adaptive-archive`, with annotated tag `v2.0.45` pointing to the receipt. Remote read-back verified both heads and the peeled tag. The installed application remains built from `4951c3f7`. This subsequent delivery-note commit changes documentation only. The other local master and subject-finishing worktrees remain at their original commits.

Published through Personal to GoggoVille **#swghermes** (`C0BDK1DDZTM`) on **31 October 2026**:

- EXE parent: **14:22:37 AEDT**, timestamp `1793416957.613269`, file `F0CDK65BCBD`. HTTP 200 acknowledged exactly **130,047,754 bytes**, in 101.0 seconds. [Release post and EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793416957613269).
- MSI reply: **14:26:52 AEDT**, timestamp `1793417212.620689`, file `F0CDL4Q37JR`. HTTP 200 acknowledged exactly **220,979,320 bytes**, in 150.3 seconds. [MSI alternative](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793417212620689).

Installer sizes and SHA-256 values were checked immediately before each upload. Complete thread read-back verified both file identities/names, captions, hashes, test instructions and rollback guidance, with no remaining thread pages. Local receipt: `test-output/release-2.0.45-delivery.json`. These checks establish local hashes, exact HTTP byte acknowledgements and accessible Slack metadata; they do not claim an independent download/hash of Slack-hosted bytes.

The first EXE request failed during local request construction, before sending bytes: unlike the earlier release, the current Windows user PAC resolved the file host directly and returned no proxy URI. A bounded read-only check confirmed HTTP 200 by the direct route; both uploads then succeeded using that current route. No system settings changed, no duplicate upload slot or release post was created, and no signed upload URLs or credentials are saved in the repository.
