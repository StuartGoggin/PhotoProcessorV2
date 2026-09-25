# 2.0.17 appended-clip workflow test release

Scope: make a new final export explicitly use the current project sequence,
distinguish it from a saved job or earlier export, and verify the prepared and
assembled sequence before publishing. No encoder, stabilisation, scheduler,
driver, dependency or render-PC configuration changes.

## Evidence and behaviour

The supplied project snapshot contained 31 included, approved clips, each with
a render record. Its calculated 36:34.48 timeline and all 31 chapter starts
matched the reported description. The additional 20 clips were absent from
that snapshot. This does not establish a file-size cutoff or encoder omission.

- Adding clips retains existing renders and explains that previous exports and
  queued/saved jobs are not automatically updated.
- The main action says `Create updated final video — N clips`, with included,
  approved, reusable and preparation counts and a new-output disk-space notice.
- An older active sequence does not block separately queuing the current edit;
  existing work is not cancelled. Resume continues the original saved request.
- Export selection shows count, date and current/outdated/unknown recipe status.
  A matching export is preferred even if an older request finishes later.
  Switching is explicit, and unsaved description drafts remain attached to
  their own export. Legacy records never fabricate a confirmed match.
- Native preparation verifies the ordered recipe. Assembly checks the actual
  ordered cached segment paths against that plan before opening-title overlay
  processing. `delivery.json` retains the recipe and planned/assembled receipt.
  Existing source/signature/checksum, measured-frame and atomic-publication
  validation is retained; recipe matching alone is not a source-byte check.

## Regression gates

- TypeScript checking, 52 frontend checks and 108 native checks passed on
  2.0.17. Nine native optional/integration cases were ignored in the general
  run; the three relevant isolated recovery/media cases below passed separately.
- Five new frontend sequence checks cover 31-to-51, same-count replacement and
  reordering, meaningful edits, legacy records and cache/progress exclusions.
- The headless browser regression adds 20 clips after an original 31, requires
  their review, submits all 51, preserves the original 31 cached paths, and
  leaves the old active request unchanged. It also verifies stale warnings,
  explicit latest-export selection, late completion of the older request, and
  preservation of an unsaved older description draft.
- Existing Studio browser and job-polling suites pass, including 360px-to-4K
  layout, approval, cache, description errors, active/history and RAM-wait flows.
- New native tests reject missing/reordered/replaced prepared clips and actual
  assembly inputs, including a 31-versus-51 mismatch and opening-card offset.
- Real-media restart/assembly, opening-overlay/reordering/delivery receipt and
  clear-job recovery are run separately because they own process-global state.

Reproduce the focused sequence checks:

```powershell
node --test scripts/test-studio-sequence.mjs
node scripts/diagnose-studio-appended-clips.mjs
pwsh -NoProfile -File scripts/test-video-studio.ps1
```

Browser tests can use `PHOTOGOGO_PLAYWRIGHT_PATH` for an existing Playwright
runtime. Test media is synthetic; no private footage is included in the repo.

## Packaging and acceptance boundaries

The release reuses the unchanged managed media bundle from 2.0.16 and its
corresponding source archive, SHA-256:
`27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8`.
See `release-2.0.16-validation.md` for that backend's original evidence.

After building, verify MSI identity/upgrade code, extracted payload hashes,
media manifest and extracted-tool smoke checks before Slack delivery. Final
installer hashes and Git commit are recorded in the delivery receipt/message.
The local source marker may include `+local` because unrelated user artwork is
untracked; that artwork is not staged or packaged by this change.

This remains an unsigned test installer without the optional offline face
runtime. Optional LMMS integration is not part of this release's test claim.
Actual Windows installation/upgrade and the user's full 51-clip export remain
render-PC acceptance tests. Let current work finish before installing; keep
the previous installer, outputs and caches. Do not clear caches to add clips.
This release does not claim to resolve the reported upward-pan rotation wobble.
