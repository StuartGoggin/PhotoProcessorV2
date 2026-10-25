# Subject-aware finishing — paused checkpoint and restart note

Updated: **25 October 2026**. The main application's code remains at the released
**2.0.29 / `2cd9b18` baseline**. This handoff is documentation only; it does not
enable the experimental filters or qualify a new application release.

## Where the work is saved

- Source branch: **`SWG/subject-finishing`**, pushed to GitHub.
- Exact source checkpoint: **`7ffb75e71355d2e47f29e6889a02fefff163acb0`**.
- [Browse the checkpoint](https://github.com/StuartGoggin/PhotoProcessorV2/tree/7ffb75e71355d2e47f29e6889a02fefff163acb0).
- [Detailed implementation resume note](https://github.com/StuartGoggin/PhotoProcessorV2/blob/7ffb75e71355d2e47f29e6889a02fefff163acb0/docs/subject-finishing-resume.md).
- [Delivery plan and qualification history](https://github.com/StuartGoggin/PhotoProcessorV2/blob/7ffb75e71355d2e47f29e6889a02fefff163acb0/docs/subject-finishing-delivery-plan.md).
- Local retained worktree:
  `C:\Users\Stuart Goggin\.codex\worktrees\subject-finishing\PhotoGoGoV2`.

The source checkpoint includes the current implementation, tests, research,
diagnostic controller repair and removal of the abandoned GPU Tripod experiment.
Its parent `fe7546c` is historical experimental code: resume from the checkpoint,
not that parent. The unfinished branch is intentionally **not merged into master**.

## What we were trying to achieve

Give PhotoGoGo optional post-stabilization finishing that sharpens the horse and
rider and improves their colour/light while preserving the deliberately soft
background from Canon R6 II footage shot with a 400 mm f/2.8 lens.

The approved defaults are horse and rider together, correctable subject selection,
temporally stable masks, subject-only colour/light and separately enabled
whole-frame grading. Preserve natural edges, mane, reins, legs and bokeh. Quality
and complete-pipeline throughput matter more than maximizing processor occupancy.

Effects belong after the verified stabilized base and before titles, replays and
scorecards. Changing finishing settings must reuse stabilization where valid.
Old Quality renders can be reused with a warning about baked-in global sharpening;
clean-base regeneration is explicit and separately cache-identified, never automatic.

## What is implemented versus accepted

The branch preserves experimental editing/preview/preparation controls, native
CPU/D3D11 picture filtering, mask/runtime/cache/ownership safeguards and diagnostic
tooling. **Enabled production finishing export remains fail-closed.** There is no
qualified subject-finishing installer or production release.

The original black-horse CPU/NVIDIA pair passed independent geometry, frame timing
and audio packet checks. NVIDIA reduced picture-filter/transfer time about 25%,
but decode/filter/software-encode time only 11.4% in that single cached-mask pair.
This is not live-inference, NVENC, whole-clip quality or general speed evidence.

The 13 October controller repair fixes rejection of the exact empty incidental
NVIDIA directory structure while retaining hash, marker, adapter and path checks.
It passed 21 native regressions, a report-only ZIP round-trip, four cases on the
development PC's Intel GPU/CPU, and relocated package verification.

The repaired diagnostic kit and instructions were read-back delivered in
[GoggoVille #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1791877553235049?thread_ts=1791877466.154929&cid=C0BDK1DDZTM).
Its SHA-256 is `e3b913056261e9705fb8309e98d5d4fdfa8e368e60a4f4dcd196d05ab18316ad`.
It is **not an installer**. No newer Slack results were retrieved during this cleanup.

## What must happen before integration/release

1. Read the detailed checkpoint note and current branch status; compare against
   current master before making further edits or planning a merge.
2. Retrieve the repaired kit's four-case render-PC `PhotoGoGo-Return-Reports.zip`.
   Keep different runner builds' reports separate; Intel results are not RTX evidence.
3. Decide correction semantics: preserve already-visited frames in the tracking
   direction or permit retroactive refinement. The real correction case has used
   **one of two** bounded quality-repair attempts; preserve that count and stop rule.
4. Resolve inference runtime acquisition/distribution/licence approvals. Local
   availability and a source checkpoint do not grant installer redistribution rights.
5. Qualify continuous close/wide footage, subject edges/bokeh, confidence changes,
   NVIDIA inference, long-clip memory/throughput, timing/audio, cache reuse and
   preview/export agreement. Only then run the full integration/installer gates
   and confirm release authorization.

Fresh checkpoint checks on 25 October passed seven finishing tests, seven
preparation/workflow tests and TypeScript `--noEmit`. Historical native/browser/
media evidence remains documented in the source branch; it is not a fresh full
release qualification.

## Local material retained outside Git

The worktree's ignored models, sealed runtimes, original/sample media, masks,
generated worker copies, build caches and test evidence remain in place. They were
not deleted or committed as source. Some generated runner copies differ from
canonical source; rebuilding/pinning them is a future qualification step.

Pre-cleanup source backup and manifest:
`C:\creations\PhotoGoGoV2\test-output\subject-finishing-cleanup-20261025`.
The 197-file backup ZIP was entry-by-entry SHA-256 verified; archive SHA-256:
`7ffe9a8bc88d653f0b9a3169d3e52443cd36baa8c018e8f7937faf852a89a2a7`.

The unused local `assets/swg-clydesdale-watermark.svg` was preserved in that folder
and in the backup ZIP, rather than added as an approved product asset. No media,
installed application, driver or active render was changed by this cleanup.

## Starting an unrelated feature

Start from current **`master`** on a new `SWG/` branch or separate worktree. Do not
merge the paused source merely to make history look finished. The released
application is a valid independent baseline, and the checkpoint can be resumed later.
