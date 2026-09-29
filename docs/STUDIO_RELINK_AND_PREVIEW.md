# Relink media and review movement in Studio

## Open a project from another machine

1. Set **Settings → Local Staging Directory** to the folder that contains the original clips on this machine (for example `D:\stage`). Keep the day/year subfolders intact.
2. Open the saved Studio project, then choose **Relink media** in the Studio header.
3. Enter the **original staging folder** stored in that project (for example `E:\stage`). Leave it blank to check current source locations without remapping them.
4. Choose the **new output folder**. Rendered clips and music beneath the old output folder are mapped into this folder. Music stored elsewhere and the LMMS executable path are not rewritten.
5. Choose **Check media locations**. This is read-only: it checks source locations and, for existing renders, hashes the full source and output files and probes the video format. Large files can take several minutes.
6. Review the exact path changes and warnings. Missing included sources or enabled music block application; excluded missing clips are warnings.
7. Choose **Apply checked locations**, then **Save snapshot** to save a new project file. The working project is also autosaved locally. The original snapshot and all media files are untouched. **Undo relink** restores the previous working locations until further project edits make that unsafe.

A render is marked reusable only when the old source-and-settings identity can be reproduced and the relocated output's checksum and video format verify. Filename/size alone are not sufficient. Different timestamps, old cache generations, unavailable tools, corrupt output, or changed settings can make reuse unprovable. Those output files are retained for playback, not deleted or automatically rendered. Relocated sources without proven reuse must be reviewed again. A previously unapproved clip is never automatically approved.

Do not choose **Clear all Studio renders** as a relinking step: that deliberately resets render reuse. Relinking does not clear unrelated caches or alter the stabilisation method.

## Play a movement preview and mark a replay

1. Select a clip, enter **Preview from (seconds)**, then choose **Play 12-second preview**. Near the end of a clip the range is shortened automatically.
2. The generated 720p preview appears inside Studio when the queued job completes. It does not autoplay. Use its normal playback and seek controls.
3. Scrub to a replay start and choose **Use current source time**. Scrub forward, choose the same button again, and Studio adds the replay range. Edit its speed and caption in **Replays**.
4. Preview an individual replay using the existing replay preview control. Time marking is deliberately unavailable in that composite preview because its slowed section no longer maps linearly to source time.

Preview times include the selected source offset. Changing clips or picture settings hides stale previews; jobs already queued remain immutable and visible in Jobs. Previews use original sound without the project music. The existing short-window stabilisation behaviour is unchanged: full-clip results can differ at the preview edges. A movement preview is not a final title/scorecard/music acceptance check.

Repeated matching preview requests can reuse a completed, checksum-verified output. Source contents, settings, selected range, destination, and output validity are checked before reuse. No duplicate video is copied for a cache hit. Clearing Studio jobs removes that history-based reuse opportunity but does not delete exported videos.

Inline playback accepts only known completed preview jobs and is limited to **64 MiB**. A longer replay preview can exceed that limit; use **Open preview externally** or choose a shorter range. Preview video data is never put into the saved project or localStorage.

## Diagnostics and validation

Job logs now include full-source/candidate-output verification time and elapsed time for individual FFmpeg stages. Whole-file verification is retained; these timings support a future measured optimisation rather than weakening reuse checks or claiming a stabilisation speedup.

Developer checks:

```powershell
pwsh -NoProfile -File scripts/invoke-npm.ps1 run build
pwsh -NoProfile -File scripts/invoke-npm.ps1 run test:studio
pwsh -NoProfile -File scripts/test-studio-reliability.ps1
```

Browser checks (use installed Playwright, or set `PHOTOGOGO_PLAYWRIGHT_PATH` to an existing Playwright module):

```powershell
node scripts/test-studio-browser.mjs
node scripts/test-studio-inline-preview-browser.mjs
node scripts/test-studio-reliability-browser.mjs
```

The native reliability smoke creates only tiny synthetic media under `test-output`, moves only its own generated folders, verifies clip/assembly reuse, then checks preview cache hits and corruption rejection. It does not access the user's footage or run a substantial benchmark.
