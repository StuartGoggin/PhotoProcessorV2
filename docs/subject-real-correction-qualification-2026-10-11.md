# Private real correction checkpoint — 11 October 2026

The 26-frame baseline completes, but a point-only correction is rejected before
its chosen frame. A whole-horse box avoids that refusal without providing strong
treatment at the clicked leg. These private picture diagnostics are not an app
release, installer, NVIDIA benchmark or representative-quality acceptance.

## Exact private case

The fresh case is `test-output/subject-real-correction-ZBFTss`. Its 26 UHD frames
are source ordinals 30–55 of the retained 100-frame black-horse normalized
excerpt. Their original context is approximately 6.60–7.12 seconds. The mounted
horse and rider are centrally visible, with a moderately blurred stadium
background. This is not the hard frame-filling/occlusion case.

The new second-generation normalized original is picture-only: 3840 × 2160,
50 fps, limited-range SDR BT.709, progressive, yuv420p8. It is not a verified
stabilized base and does not exercise audio, timing preservation through the
complete export route, or preview/export agreement.

Base SHA-256: `691c0021da1f24ac6ff1d7b3bfbbbb527951e19efbeb4c13644663e1f22a01d1`.
Base MD5 used by the mask recipe: `5af92517a972a2aff299a6f856d1f30d`.

The six current application runner scripts were copied create-new beside a
private candidate manifest, not over the frozen runner. The candidate binds
16,536 archive-checked existing CPU runtime/vendor/model files and has SHA-256
`80c08e8911e9d948ca3b59a42ce38e171a87f825c8a5536f578ae0a37825622b`.
No dependencies were acquired or installed. The original runtime manifest
`3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78`
and its frozen application runner remain unchanged. The candidate is not
admitted by the app and does not establish redistribution permission.

## Completed baseline

`run-subject-real-correction.mjs baseline` ran through the native owned job
with a 480-second wall deadline, four-GiB memory limit and eight-thread CPU
bound. There were two finite windows, a seed at frame 12 and three held-out
seam frames. Native diagnostics report:

| Measurement | Observed result |
| --- | --- |
| Owned frames | 26, complete, with exact progress timestamps |
| Decode / inference | 1.428 / 179.045 seconds |
| Native seconds including load | 186.189 seconds |
| Peak working set | 1,434,931,200 bytes |
| Minimum held-out seam IoU | 0.9579633617510841 |
| Final alpha occupancy | 43,221–52,187 of 589,824 proxy pixels per frame |

This CPU slice is slow; it is not an acceptable real-time-throughput result or
an estimate of RTX performance. Seam IoU is an identity guard, not a subjective
quality/confidence score. Independent RLE readback covers all 26 final alpha
frames and finds nonempty treatment and excluded background. The union cache
does not prove separate horse/rider coverage or rider-output invariance.

Mask recipe identity:
`318683982929984425f958f3d40651082a6816ecd34598195b58452d7f2a2687`.
Mask-file SHA-256:
`63d16f8153ee1757a6b762130ff3d32788f4ebb0921584028370cb631a49b33f`.
Policy: `fixed-two-id-object-reacquisition-seam-v3`.

The live controller initially failed after native completion because an old
assertion indexed the shared reference as if it were the generation policy.
The exact obsolete assertion was reproduced against saved metadata. The
strengthened checker compares the independently literal complete canonical
recipe, its SHA-256 identity, selection/profile fields, exact progress and the
terminal manifest. `verify-baseline` recovered the receipt without repeating
inference. Its controller `wallSeconds` is deliberately null; the native time
above is retained, not replaced by an invented measurement. Recovery verifies
historical before/after full inventories plus current base/tool/runner hashes,
not a fresh full scan of every installed dependency.

## Still inspection and rejected correction

`inspect-subject-real-correction.mjs` produced the source-bound contact sheets
and metrics in `test-output/subject-real-mask-inspection-A7evcv`. The main agent
inspected both overview sheets (frames 0/3/5 and 11/12/13/25) and the native-pixel
shoulder crop (frames 2/3/4/5). The earlier cached-v1 shoulder hole is not present
in these inspected new-baseline frames; it must not be reported as reproduced
or as fixed by the new policy.

A visible narrow hind-leg shaft at frame 3, preview coordinate (354,440) in
960 × 540, has final alpha 14. That low opacity may reflect conservative inward
fringe suppression, rather than incorrect raw segmentation. A single literal
horse include point `(0.36875, 0.8148148148148148)` was tested through a fresh
saved-prompts/retrack job, with unchanged rider acquisition anchors.

The job was rejected by the existing abrupt-mask guard **at frame 2, before
the prompted frame 3**. Its only owned progress was frames 1 and 2. There is no
completed `manifest.json`, `masks.pgmask` or correction-result receipt. The
partial reference PNG and raw diagnostics remain inspectable. Both fresh
before/after candidate inventories match the candidate identity, and the
completed baseline remains byte-identical.

This is a captured refusal, not a successful correction, and not proof of a
software cause. Exact retained SAM source shows that all supplied anchors are
added before propagation and that conditioning may influence earlier frames.
The added point is consequently a fresh conditioning anchor, not an incremental
click refining stored baseline logits. A positive point alone can also be an
insufficient description of the whole horse. These are competing explanations
for the failure; neither has yet been isolated by a controlled repair.

Do not relax the identity/abrupt-change guard, fill mask holes globally, or
increase erosion tolerance merely to obtain a passing correction. The next
bounded diagnosis must distinguish whole-object prompt sufficiency from
correction scheduling/refinement and compare all owned frames, not just the
target point. No algorithm repair had been attempted at this initial capture.
The subsequent context attempt is counted below; the two-repair stop condition
remains in force.

## Point context comparison

The refusal message now names the object, direction and computed IoU. The
production change is diagnostic only: calculations, thresholds, ownership and
the v3 mask policy are unchanged. The public owned-job rider-refusal regression
failed before the message change, then passed; all 14 object-scoped correction
regressions subsequently passed. Current `subject_mask_job.py` SHA-256 is
`dab223fd124a00d0cab9f3101a22bd6111208a99b7d0affdd5959c57040fa67c`.
Changed runner bytes require a new private seal, not relabelling old receipts.

`diagnose-subject-correction-context.mjs` compares the exact 26-frame base,
frame-0 acquisition boxes, frame-3 include point, native owner and bounded
runtime. The only selection difference is a manually inspected frame-3
whole-horse box `[0.335,0.25,0.60,0.94]`, not the inherited frame-0 box.
Fresh before/after checks cover all 16,536 candidate inventory files. Both runs
bind current private candidate
`b826c4b2ff623195ec59bc3170f77f5539e05503b2564949c959590a458f71cf`
and preserve the source, retained baseline and frozen runtime.

| Observation | Point only | Box and point |
| --- | --- | --- |
| Native result | Horse refusal at frame 2, forward IoU 0.0094 | Completed 26 frames |
| Completed cache | None | 2,025,819 bytes, two windows |
| Native seconds including load | No completed measurement | 189.263 seconds |
| Decode and inference | No completed measurement | 1.445 and 182.000 seconds |
| Peak working set | No completed measurement | 1,414,365,184 bytes |
| Minimum held-out seam IoU | No completed measurement | 0.960421330578038 |
| Final alpha at frame-3 point | No result | 33, versus baseline 14 |

The point-only controller took 22.618 seconds; rejected-job wall time is not
completed inference throughput. Its result and absence of a completed cache
are retained in `test-output/subject-correction-context-point-only-G8yDNC`.
The successful comparison is in
`test-output/subject-correction-context-box-point-u5mgYS`.
Its mask identity is
`c367203c89df08ceb75a59ae7b9f1618c7fe7cdc95afb56d40391f933a594103`;
mask SHA-256 is
`f9584b585df3a26c82d20d6a41a37dc4f84ddabeb5f96e65d6a20283b6abe414`.
Both result checkers bind the literal canonical recipe and terminal completion
or refusal, not merely a cache filename.

The box comparison changes 5,013 alpha pixels in frame 1 and 5,264 in frame 2,
before its prompted frame 3; frame 0 is identical. Readback compares all 26
final-alpha union frames. It cannot establish separate horse/rider invariance;
unchanged rider prompts do not prove unchanged rider masks.

All three sheets in `test-output/subject-correction-context-inspection-QrhQkb`
were inspected by the main agent: source/baseline/box overviews at 0/2/3 and
4/12/25, plus native-pixel hind-leg crops at 2/3/4/5. No obvious gross silhouette
switch was identified in those selected stills. They do not establish continuous
quality. The frame-3 leg remains only lightly treated after inward fringe
suppression. Alpha 33 is below the detail filter's greater-than-240 neighbourhood
requirement; successful tracking is not an effective sharpening correction.

Spatial context avoids this particular eager-anchor refusal. It does not prove
scheduling is the sole cause or that point-only correction works. No guard,
erosion setting or confidence threshold was weakened. Conservatively count
the box-and-point prompt remedy as **one of the two bounded repair attempts**
for this captured case, although the production mask algorithm is unchanged.
Another failed remedy must trigger the agreed user decision, not reset the
counter.

## Correction behaviour decision

The pinned SAM public API supports refinement of an already-tracked frame:
pause after its initial yield, apply the click to the existing named object
and prior logits, validate the returned two-object result, explicitly commit
it with `propagate_in_video_preflight`, then resume the paused generator.
Resuming without preflight or restarting at the same frame with default
non-conditioning corrections is not equivalent. No private state mutation
is required.

This is proposed, not implemented. Its upside is predictable editing without
a future standalone point changing an already-visited prefix. Its downside
is loss of that anchor's ability to refine earlier visited frames. Stuart has
been asked to choose prefix preservation versus retroactive refinement before
production behaviour changes. In reverse traversal, preservation means
already-visited higher-numbered frames, not every numerically earlier frame.

If approved, give the experiment a new generation identity. Start with a public
owned-job RED-to-GREEN test driven by prompts the external predictor actually
receives: premature registration changes the prefix; correctly timed refinement
produces a literal distinct horse mask with stable rider regions. Then cover
multiple corrections, reverse traversal, seed-frame prompts, held-out overlap
and invalid returned frames/IDs/shapes/nonfinite logits. Retain exact ownership,
independent visible seams and empty-handoff refusal. The next real test must
compare the retained baseline prefix, separate object outputs and the clicked
leg neighbourhood after final alpha treatment.

## Release state

App runtime admission, continuous playback review, subject quality acceptance,
NVIDIA inference and public export qualification remain false. No source media,
existing stabilization cache, frozen runtime or portable picture kit was
replaced. No commit, merge, push, installer build or Slack publication occurred
at this checkpoint.

The retained 98,240,281-byte cached-picture test ZIP still hashes to
`01ad2942de919681f6987edc57d624cff40a98a1c50224b357c78b368cafa1ce`.
It is a portable picture test, not this tracking candidate or a production
installer. The fresh Slack workspace check returns NetSuite-GBU,
ProdDev-Fusion-Srv and Oracle One, not GoggoVille. The local Slack skill has
no configured authentication token either. Delivery to the authorized
`#swghermes` requires GoggoVille access to be restored; no substitute workspace
or old conversation was used.
