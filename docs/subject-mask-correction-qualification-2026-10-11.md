# Object-scoped subject correction checkpoint - 11 October 2026

Status: a narrow development safety defect is reproduced and fixed. This is not
representative-footage quality acceptance, runtime promotion or a release.

This historical v2 source snapshot is superseded by the later
[v3 identity-reacquisition checkpoint](subject-mask-reacquisition-qualification-2026-10-11.md).
The hashes below identify the v2 checkpoint, not the current v3 source files.

## Finding and surgical change

Any anchor previously marked its entire frame as corrected. A horse-only prompt
therefore waived both the horse and rider's adjacent-frame and held-out overlap
checks. Both bad-rider cases were accepted by the real mask-generation workflow
before the corresponding change; they are retained in
`test-output/subject-mask-correction-HMPUCf` (adjacency) and
`test-output/subject-mask-correction-IbUv79` (overlap).

`subject_mask_job.generate` now maps corrections to their named fixed object ID.
Each object receives an exemption only for its own prompt at that global frame.
No thresholds, mask geometry, filter strength, stabilization or image kernel
were changed. The overlap seed still cannot count as independent seam evidence,
and both objects still require visible held-out evidence at a handoff.

The generation policy is now `fixed-two-id-object-corrections-seam-v2`, consistently
referenced by Python, TypeScript and both Rust recipe locations. Old policy
results cannot acquire the new identity. Existing selections/effect settings are
preserved; disabled finishing remains a no-op, and stabilization identity is not
changed. Old caches and all failure evidence remain on disk, not deleted or
rewritten.

## Executed validation

The unshipped scripted predictor is an external model adapter behind the existing
native `--mask-job` request/result interface. Real source admission, FFmpeg window
decode, temporal checks, mask/cache writes and owned process launch run unchanged.
The predictor ignores prompt effects deliberately, so these checks establish
guard behaviour, not actual SAM correction effectiveness or horse suitability.

- Adjacent rider jump: observed acceptance before the adjacency fix; now rejected
  at frame 2 with no completed manifest or terminal success progress.
- Independent rider overlap disagreement: observed acceptance after the adjacency
  fix but before the overlap fix; now rejected at frame 4 with no completed
  manifest. Scripted IoU is 26/54, below seam 0.6 but above adjacency 0.25, so this
  is a separate check rather than another adjacency failure.
- Deliberate both-object correction and stable uncorrected rider controls still
  complete with four exact frames and `subjectQualityAccepted:false`.
- Python recipe/selection/window suite: 12 passed. TypeScript saved-project/
  finishing recipe suite: 6 passed. Native-owned scripted job cases: 4 passed.
- Existing mask-cache contract: 2 passed. TypeScript no-emit compilation passed.
  Existing real tracking-hook browser regression passed prompt/base tombstoning,
  overlapping metadata ownership, grade-only mask preservation and stale-frame
  rejection; native replies in that browser test remain synthetic.

Retained final cases:

| Case | Evidence directory | Completed manifest |
| --- | --- | --- |
| Rejected adjacency | `subject-mask-correction-KrnwZf` | Absent |
| Rejected overlap | `subject-mask-correction-f3GmnI` | Absent |
| Deliberate both-object correction | `subject-mask-correction-vh7QUs` | Present, quality false |
| Stable uncorrected object | `subject-mask-correction-YeNB2E` | Present, quality false |

All directories above are beneath the isolated worktree's `test-output`. Each
retains its exact request, synthetic source and stdout/stderr. The source fixture
hash was verified unchanged after each job. No original footage was processed or
modified, and no pretrained inference was performed for these cases.

Independent read-only review found no material defect in the fix or four recipe
references. It explicitly limited executed coverage to forward/reference-zero
horse-only failures and the stated controls; rider-only, reverse/later-reference
and successful both-object overlap cases are not newly claimed as exercised.

## Current source identity

| File | SHA-256 |
| --- | --- |
| `src-tauri/scripts/subject_mask_job.py` | `86305e62459366e5443a30e4fd4a38d66db9dd7213601acc4d99c893022ce13c` |
| `src-tauri/scripts/subject_masks_contract.py` | `eed2fe269075d6deb1df87c5937dbd2dca3cd7d95a65405e7a379178bdab35e4` |
| `src/utils/studioFinishing.ts` | `517a7ca7cf3c8695c3e51d0190be5a5b3e6c33919c9a9f6dcc5e47ac9cb17717` |
| `src-tauri/src/commands/video_studio/subject_finishing.rs` | `b1bb97fc499482dca0fecfa71aece1a2558963964a374079e468252b01b51bd8` |
| `src-tauri/src/commands/video_studio/subject_finishing/cache.rs` | `3ab82c7950dd765bc1f0db4544a08a2956d98a6b825722f5b5cfe6d0cf093a7b` |
| `scripts/test-subject-mask-correction.mjs` | `37c599383b8b3debef635414e0879239f811d1bc6e4e713024303d0b79ed0ec2` |
| `scripts/subject-finishing/mask-correction-fixture.py` | `2df86aed842ace2a44faa7250703b926b3f66ab3d0f3d7392fb4a305e2816a49` |

## Boundaries and remaining work

The sealed evaluation runner copies are deliberately unchanged and still use
policy v1. They will fail current v2 app admission until a separately qualified
runner build is staged; this source correction does not silently promote that
runtime or claim fresh app tracking is currently ready. No Rust/native app build,
installer, commit, merge, push or Slack publication occurred in this slice.
Enabled public export remains fail-closed.

The delivered cached-picture test ZIP remains byte-identical: SHA-256
`01ad2942de919681f6987edc57d624cff40a98a1c50224b357c78b368cafa1ce`.
Its prepared initial-box masks do not exercise correction behaviour, and its
NVIDIA/image-quality/export caveats remain unchanged.

Continuous non-neutral before/after motion review, difficult close frame-fill,
actual corrected-footage effectiveness, dropout/occlusion handling and calibrated
uncertainty remain open quality gates. Feathered alpha is not model confidence.
These deterministic guard repairs are not failed representative-quality repair
attempts; the finishing quality-repair count remains zero. The full delivery goal
remains active without a reduced definition of done.
