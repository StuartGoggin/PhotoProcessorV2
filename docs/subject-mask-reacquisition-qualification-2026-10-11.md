# Object identity reacquisition checkpoint - 11 October 2026

Status: a within-window admission defect is reproduced and fixed. This is a
source-development checkpoint, not semantic identity, confidence smoothing,
representative-footage acceptance, runtime promotion or release qualification.

## Finding and smallest change

The v2 adjacency guard compared two non-empty masks only. A rider could become
empty for one frame and then reappear without a rider reference, despite a
horse-only reference at that reappearance frame. The real owned mask-job seam
accepted that scripted case before the fix. Its request, source, completed v2
manifest and diagnostics remain in `test-output/subject-mask-correction-hYfgGP`.

The generator now rejects an uncorrected empty-to-non-empty transition for each
fixed object independently, before writing the current frame's alpha. A correction
must name that object at the exact global frame in the traversal direction.
The diagnostic identifies the object, frame and forward/reverse direction.

Non-empty-to-empty and repeated-empty observations remain allowed as zero
contribution. The shared initial reference remains the acquisition request.
Existing non-empty adjacency and held-out seam checks are unchanged, as are
sharpening, colour, mask geometry and stabilization. The guard also covers
non-owned lookahead predictions; uncertain reacquisition cannot become an
unverified seed for the next window.

## Version and reuse boundaries

All four active Python, TypeScript and Rust recipe references now use
`fixed-two-id-object-reacquisition-seam-v3`. V1 and v2 cache recipes cannot silently
qualify under the new identity. Existing selection/effect settings are retained,
disabled finishing remains a strict no-op, and stabilization identity is unchanged.
Old caches are not deleted, overwritten or relabelled.

The frozen runner still declares v1. Its runtime inventory SHA-256 was freshly
read back as `3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78`,
unchanged from the retained checkpoint. It will fail current v3 app admission
until a separately qualified runner is staged. This source fix does not claim
that fresh in-app tracking is ready.

## Executed tests-first validation

The previously accepted unreferenced rider case failed its new negative test,
then was rejected after the surgical guard. Literal Python and TypeScript v3
recipe tests were also observed failing against v2 before the four references
were updated.

Final commands and results:

- `node --test scripts/test-studio-finishing.mjs scripts/test-subject-mask-correction.mjs`:
  20 passed, comprising six saved-project/recipe regressions and 14 owned jobs.
- `runtime/python.exe -I -S -B scripts/test-subject-masks-contract.py`: 12 passed.
- `runtime/python.exe -I -S -B scripts/test-subject-mask-cache.py`: two passed.
  Both Python commands used the existing manual CPU evaluation runtime.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node scripts/test-studio-subject-tracking-browser.mjs`: passed the existing
  actual-hook prompt/base tombstone, metadata ownership, grade-only reuse and
  stale-frame regression. Its native responses remain synthetic.
- Tracked-file whitespace check passed; it does not constitute a syntax check
  of every untracked file. No Rust/native application build was executed.

The external scripted predictor ignores prompt effects deliberately. Actual
source/profile admission, bounded FFmpeg decode, temporal guards, mask/cache
writes and the native process owner execute through the approved `--mask-job`
interface. This fixture is not shipped, does not verify pretrained model
artifacts and is not a production runtime-admission route. Each job uses tiny
160x96 CFR synthetic media, one worker thread, a 30-second owned deadline,
a 35-second host timeout and 64-KiB diagnostic capture. Sources were hashed before
and after each job and remained unchanged. No original footage or pretrained
inference was used.

Final retained evidence beneath `test-output`:

| Case | Directory suffix | Completed manifest |
| --- | --- | --- |
| Existing adjacent rider disagreement | `subject-mask-correction-1kkZZx` | Absent |
| Existing held-out rider disagreement | `subject-mask-correction-6upQsg` | Absent |
| Horse-only reference cannot reacquire rider | `subject-mask-correction-6nr7u3` | Absent |
| Rider-only reference cannot reacquire horse | `subject-mask-correction-oMFUDj` | Absent |
| Reverse traversal requires reference at global frame 0 | `subject-mask-correction-uTy9Oa` | Absent |
| Non-owned lookahead cannot reacquire rider | `subject-mask-correction-TYv2pl` | Absent |
| Empty handoff remains refused | `subject-mask-correction-BhTDwQ` | Absent |
| Both-object deliberate adjacent correction | `subject-mask-correction-1fZ2O2` | V3, quality false |
| Stable uncorrected object | `subject-mask-correction-kiVKPj` | V3, quality false |
| Both-object reappearance correction | `subject-mask-correction-GhbxFN` | V3, quality false |
| Continued and repeated absence | `subject-mask-correction-OOlD7A` | V3, quality false |
| Reverse corrected reappearance | `subject-mask-correction-BcN1uA` | V3, quality false |
| Only rider corrected, horse stable | `subject-mask-correction-YSV8YS` | V3, quality false |
| Only horse corrected, rider stable | `subject-mask-correction-oNQs6d` | V3, quality false |

All refusal cases have no terminal success progress or completed manifest.
Accepted controls preserve exact frame ownership and `subjectQualityAccepted:false`.
The final evidence directories and generation policies were independently read back.
Read-only review found no material defect or recipe inconsistency. The reviewer
did not execute the tests or qualify real SAM identity/correction effectiveness.

## Source identities

| File | SHA-256 |
| --- | --- |
| Generator | `05b5afd4aa0e2eb84321da1a6d36a2d381500f428e41f1c3f12fc2757c12a203` |
| Python contract | `e943b552756790e88a54034bd2d4c43f5f86a5995fae7f441f8c6127ffe2b5a0` |
| TypeScript recipe | `b29fd6efc3063dbb43571fe87bc41b0d9aec5688a558af6815bd561fbb498793` |
| Rust finishing recipe | `18ed397b4317922bb5045d88f0a127505351c4081fc21414d34b7cbfe31dfb81` |
| Rust cache recipe | `98ac1973276b31b8a7b4f7eede125c5fa22f62a11657d003dd81bccc44497d98` |
| Owned-job test harness | `73d5681b52df78ab1ab836e43cd8d581d1105fc8cc46135207e04bdd840a7dcf` |
| Unshipped predictor fixture | `624b252a09c6778a6772436f97d9060ba2d0d21606441a2e51bd39b80d85a53b` |

## Still not achieved

Observed empty/non-empty masks are not calibrated confidence or verified semantic
absence. Tiny spurious non-empty masks and softer edge changes need other quality
evidence. Abrupt disappearance can still make subject treatment visibly change;
this admission guard is not temporal blending or a perceptual acceptance result.

An empty mask at a new window's start remains rejected before correction anchors
are applied. Long offscreen spans crossing such a boundary are not supported by
this narrow fix. Do not claim uninterrupted correctable offscreen tracking or
loosen the empty-seed/held-out evidence checks without a separately tested contract.

Real corrected-footage effectiveness, continuous non-neutral playback and bokeh,
close frame-fill/occlusion, stabilized-base quality, NVIDIA inference/whole-pipeline
throughput, distribution closure, runtime and installer qualification, integration
and verified Slack release remain open. The representative quality-repair count
is still zero; these guard defects are deterministic protocol repairs.

No main-checkout source writes, new dependencies, software installation, runtime
promotion, native app build, installer, commit, merge, push or Slack post occurred
in this slice. The previously delivered cached-picture ZIP remains unchanged:
`01ad2942de919681f6987edc57d624cff40a98a1c50224b357c78b368cafa1ce`.
The full delivery goal stays active with its original definition of done.
