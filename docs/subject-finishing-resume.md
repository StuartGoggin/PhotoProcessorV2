# Paused subject-aware finishing — resume here

Checkpoint date: 25 October 2026. Branch: `SWG/subject-finishing`.
This is a source-preservation checkpoint, **not a release-qualified feature**.
The production baseline remains 2.0.29 at `2cd9b18`.

## What Stuart wanted

Optional post-stabilization sharpening and colour/light correction for the horse
and rider together, preserving the deliberately soft background from Canon R6 II
footage shot at 400 mm f/2.8. Selection must be correctable in preview and stable
over time. Subject-only colour/light is the default; whole-frame grading is a
separate explicit option. Fidelity, natural edges and watchable video take priority
over nominal 100% CPU/GPU utilization.

Existing stabilization methods/defaults and cached bases must remain available.
Keep finishing and stabilization identities separate. Reuse older Quality bases
with a warning about their already-baked whole-frame sharpening, and offer explicit
clean-base regeneration; never regenerate automatically or overwrite originals.
Finish the verified stabilized picture before titles, replays and scorecards.

## Where implementation stopped

The branch contains the experimental UI, correctable mask/preparation workflow,
native CPU/D3D11 picture kernels, runtime ownership/admission/cache safeguards,
tests, research, provenance and diagnostic handoff tooling. It is incomplete:
`src-tauri/src/commands/video_studio/subject_finishing.rs` still refuses enabled
production export with `Subject finishing is not export-ready`.

The old `fe7546c` parent checkpoint included an experimental GPU Tripod stabilizer.
That experiment was abandoned. Its removal is included in this source checkpoint;
the historical commit is not a feature to recover or merge by itself. Supported
stabilization remains the existing Fast and Quality paths.

## Evidence already obtained

- The original black-horse CPU/NVIDIA pair was independently checked: 100 UHD
  frames at 50 fps, exact frame timing and 95 copied AAC packets. NVIDIA reduced
  filter/transfer time about 25%, but decode/filter/software-encode time only 11.4%.
  One pair with cached masks/libx264 is not a general throughput claim.
- The diagnostic controller rejected an incidental empty NVIDIA directory. Its
  narrow repair admits only the exact ordinary empty driver-directory structure
  after verified NVIDIA report attribution; files, junctions and unknown entries
  still refuse. 21 native regressions and a report-only ZIP round-trip passed.
- The repaired portable kit completed four cases on the development PC's Intel
  GPU/CPU and passed relocated package execution/hash checks. Those are not RTX
  measurements, live mask inference or visual acceptance.
- Existing browser/native/synthetic/selected-frame evidence is documented in the
  qualification files below. Historical passes must be rerun as appropriate after
  further changes; they do not certify the entire paused feature.

Repaired kit delivered and read back in GoggoVille **#swghermes**:
[13 October kit and instructions](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1791877553235049?thread_ts=1791877466.154929&cid=C0BDK1DDZTM).
ZIP SHA-256: `e3b913056261e9705fb8309e98d5d4fdfa8e368e60a4f4dcd196d05ab18316ad`.
It is a diagnostic ZIP, not an installer. No newer render-PC result was retrieved
as part of this cleanup. Keep old/new runner reports distinct.

## Unresolved decisions and acceptance gates

1. Obtain the repaired kit's four-case render-PC `PhotoGoGo-Return-Reports.zip`.
2. Confirm correction semantics: preserve already-visited frames in the tracking
   direction versus allowing retroactive refinement. The observed whole-horse box
   plus point completed a short case but changed earlier frames; point-only failed.
   The prompt remedy counted as **one of two** bounded quality-repair attempts.
3. Resolve inference runtime distribution and licences. The bounded Intel OpenMP
   inspection-only acquisition was awaiting explicit approval; licence acquisition,
   installation and packaging are not authorized by this source checkpoint.
4. Validate actual NVIDIA inference, long-clip memory/throughput and representative
   close/wide continuous horse/rider footage: mane, reins, legs, edges, tracking,
   confidence transitions, bokeh, audio/timing and preview/export agreement.
5. Only after acceptance, rebase/integrate against current master, run full app and
   installer/runtime/media checks, then obtain/confirm the release go-ahead.

Preserve the original two-attempt stopping rule and report assumptions honestly.
Source checkpointing does not enable export, accept runtime terms, qualify quality,
authorize a driver change, or permit interruption of active renders.

## Start here when returning

1. Open the existing isolated worktree (or a new worktree from this branch), check
   `git status`, the current master and the latest checkpoint commit before editing.
2. Read [delivery plan](subject-finishing-delivery-plan.md),
   [integration checkpoint](subject-finishing-integration-qualification-2026-10-11.md),
   [controller repair](subject-picture-controller-repair-2026-10-13.md),
   [real correction evidence](subject-real-correction-qualification-2026-10-11.md),
   and [runtime provenance](subject-finishing-runtime-provenance-2026-10-10.md).
3. Inspect `src/components/studio/StudioSubject*`, `src/hooks/useStudioSubject*`,
   `src/utils/studioSubject*`, the native `video_studio/subject_finishing` modules,
   `src-tauri/scripts/subject_*`, and `src-tauri/native/subject_*`.
4. Re-establish the small regression loop with the existing finishing/preparation
   tests and TypeScript. Use the documented native/browser/media gates when their
   interfaces change. Tests requiring retained private media/runtime inputs are
   not portable green checks on a fresh clone.

## Local evidence and generated material

The worktree is intentionally retained. Ignored models, sealed runtimes, sample
media, masks, generated tools, installer caches and `test-output/` are not Git
source and have not been deleted or promoted into the repository. In particular,
the generated runner copies may differ from canonical source; do not substitute
them into a release without rebuilding, pinning and qualification.

Local worktree: `C:\Users\Stuart Goggin\.codex\worktrees\subject-finishing\PhotoGoGoV2`.
Pre-cleanup source backup/manifest:
`C:\creations\PhotoGoGoV2\test-output\subject-finishing-cleanup-20261025`.
The 197-file ZIP was entry-by-entry SHA-256 read-back verified and includes the
generated runner copies and the local branding SVG. Original diagnostic artifacts
remain in their existing local folders and the shared Slack thread.

For an unrelated new feature, start from current `master` in a separate branch;
there is no requirement to merge this paused implementation first.

## Checkpoint validation on 25 October

Fresh checks passed: seven finishing-recipe tests, seven preparation/workflow
tests, and TypeScript `--noEmit`. These are source-checkpoint checks, not a full
native/browser/media/installer qualification. The default sandbox denied esbuild
ancestor-directory reads; the same bounded checks passed in the repository
owner's context without changing dependencies or global trust settings.
