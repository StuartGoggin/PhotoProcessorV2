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
