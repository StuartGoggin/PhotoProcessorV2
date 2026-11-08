# PhotoGoGo 2.0.50 — final preview-first Lightbox delivery

## Scope and held checkpoint

This completes the approved large-folder loading work documented in
`docs/lightbox-first-preview-design.md` and `docs/release-2.0.49-validation.md`.
The 2.0.49 source/tag/package receipt was retained after a final targeted check
found a recovery-UI edge case. Its installer bytes were uploaded privately but
never finalized/shared in Slack; they are not the delivery artifacts.

With inspection O running, selecting a photo in A queues A at foreground
priority. Expanding B correctly discards B's queued work, but previously still
overwrote the visible inspection phase with B. If A completed incompletely,
the preview stayed usable and writes stayed blocked, but Retry was hidden.

The real-UI regression failed on 2.0.49 waiting for Retry. The correction only
lets foreground/current-selected-folder work update that visible checking phase;
promoting an existing queued selection also restores its progress context.
Threading, identity gates, cache limits, writes and all original files remain
unchanged. Version 2.0.50 avoids moving the published v2.0.49 tag.

## Validation

Red evidence: `test-output/lightbox-inspection-progress-red.log`.
Final tests, built-source, package and verified delivery receipts follow.

The full ten-case preview browser suite passes, including the new failure-path
case, original/crop/source identity, delayed comparisons, metadata failure and
retry, bounded priority, same-root remount and missing Camera JPEG handling.
The 700-file preview measured **301 ms while metadata remained held**. This is
a controlled dependency measurement, not a render-PC/network speed guarantee.
TypeScript passes; no native implementation changed after the 386 passing
native tests and explicit real-tool throughput probe recorded with 2.0.49.
Final targeted legacy browser checks passed: 21 Lightbox/controller controls,
nine RAW-source groups and 11 saved-selection/transfer-barrier groups. The
independent reviewer confirmed the final five-line correction and its regression
with no findings. No other implementation changes are included in this cut.

## Built source

Final application source: `766bde5ca4bd7cdc733197cd35ab67f43f228ab9`, including
the original preview-first implementation `603e2819` and the final progress-state
correction. The production frontend identifies
`2.0.50 / 20261108T062854364Z-766bde5c+local`.
All application changes/tests/version/guide were committed before building.
Four unrelated untracked cleanup scripts/JSON summaries remain untouched and
excluded. The `+local` suffix retains that boundary and the temporary Vite
configuration module; later package/delivery notes do not alter the built source.

## Finished packages

The final optimized build completed in **5m 10s**, with five existing unused-code
warnings and the existing frontend Browserslist/chunk-size notices. Inspection
reports `complete: true` after extracting both installers without installation.
The application payloads match the built binary after normalizing only Tauri's
expected three-byte bundle marker. All pinned media/source payloads, 2,205
ExifTool 13.59 files, 440 RawTherapee 5.13 resources and all 28 modified controller
SDK source files/notices passed.

Both relocated packages decoded the supplied CR3 at **6014 × 4016**, RTv4_sRGB,
with PATH empty and the original hash unchanged. MSI ProductVersion is 2.0.50;
UpgradeCode remains `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` from the last
delivered 2.0.48. These are unsigned test installers. Prior 2.0.48 packages
remain available for rollback; actual large-folder/drive performance is a retest.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.50_x64-setup.exe | 130,876,509 | 73FD455F960F5A98BD78B57147B0AD468C1BD6448C465C94B2F4517C4CB90B3D |
| PhotoGoGoV2_2.0.50_x64_en-US.msi | 222,184,148 | 16A643D2773018595E675E36C93D0F0A2C7367E199C8861D48DBF7B7806B55B7 |
| photogogo-v2.exe | 30,244,864 | 198440585EDD78A4100473DA96C9CE8D6D45E6642DF32BFC0B19F58653FC876C |

## Publication and verified delivery

Inspection receipt:
`test-output/release-2.0.50-inspection-20261108T063902935Z/report.json`.
Package receipt commit `072148ac3739fbbfc29070d80967b8d4df08b85d` was atomically
published to GitHub `master` and `SWG/lightbox-first-preview`, with annotated
tag `v2.0.50` pointing to it. Remote read-back verified both heads and the peeled
tag. Compiled application source remains `766bde5c`; later receipt documentation
does not alter it. Other worktrees and unrelated cleanup artifacts are untouched.

Delivered through Personal to GoggoVille **#swghermes**, **8 November 2026**:

- EXE parent `1794120372.112779`, file `F0CFQB8DV6H`; HTTP 200 acknowledged
  exactly **130,876,509 bytes**, in **147.1 seconds**, using the direct route.
  [Release post and EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794120372112779).
- MSI reply `1794120394.219089`, file `F0CFQB8MB8D`; HTTP 200 acknowledged
  exactly **222,184,148 bytes**, in **218.2 seconds**, using the direct route.
  [MSI alternative](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794120394219089).

Local bytes/SHA-256 were rechecked immediately before upload. Complete thread
read-back verified both IDs, filenames, hashes, byte counts, source identity,
preview/checking instructions and physical retest boundary, with no pages left.
Local receipt: `test-output/release-2.0.50-delivery.json`. No signed upload URLs
or credentials are retained. This establishes exact upload acknowledgements and
accessible Slack metadata, not an independent download/hash of Slack-hosted bytes.

The 2.0.49 pending uploads `F0CGPV5E9S4` and `F0CFE724SPR` were acknowledged
but never finalized/shared. They are superseded by the two 2.0.50 artifacts above;
the older tag was not moved. Development fixture timing does not establish
Stuart's actual 700+ folder/storage performance. The release post asks for time
to first image separately from time to Ready to review during the PC retest.
