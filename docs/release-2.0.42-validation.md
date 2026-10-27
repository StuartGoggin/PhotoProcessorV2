# PhotoGoGo 2.0.42 — CR3 originals and standalone RAW development

Built application source: `bf7fdfff8582a037927ae04165d30554467a8f1f`. The implementation starts with `f59828e` and includes the subsequent fix retaining independent colour/B&W/JPEG/TIFF branches. Later commits record validation/delivery only.

## Result and workflow

CR3 originals can be reviewed through their camera previews and developed through the new Photo Process RAW Development card. Natural, Neutral and High ISO starting recipes expose white balance, manual/automatic levels, tone, detail and noise controls, separate saved photo overrides, recalled applied recipes and explicit preview actions. Colour and B&W export independently from RAW to full-resolution sRGB JPEG or true 16-bit TIFF through core Jobs.

Original bytes and earlier generations are retained. A folder-local versioned manifest owns derivatives and recipes; retired generations never become new Originals. Engine/profile/dependency identity and source/output checksums govern reuse. Individual maintenance moves that would strand lineage are blocked before a batch starts, with a final lease-protected check. Whole-event rename remains supported. Archive selection retains metadata only when library metadata backup is chosen.

Metadata-proven RAW/camera-JPEG pairs may have different imported filenames. One unambiguous camera model/serial/exact timestamp/subseconds match anchors capture ratings to RAW while keeping Google flags specific to each physical image. Preferred Colour chooses a supported camera JPEG over a RAW Original tie. Corrupt metadata, changed named output sizes, ambiguous identities and scope mismatches fail closed. A queued or active cancellation uses core Aborted semantics.

See [the user/developer guide](cr3-raw-development.md) for exact scopes, preset behavior, reproduction and limitations. Existing JPEG workflows remain independent; RAW-owned JPEG developments are not silently fed back into JPEG Enhance/B&W as masters.

## Validation evidence

- Final native suite: **333 passed**, zero failed, 26 opt-in tests skipped, including the new colour/B&W/JPEG/TIFF branch-isolation regression. Separate opt-in real-file acceptance exercised two supplied originals, TIFF/orientation/repeatability and library/reuse/cancellation. The library acceptance was repeated against the final native test harness after the branch fix. These are dedicated acceptance runs, not a claim that all 26 opt-in tests ran.
- Frontend: TypeScript and 20 catalogue/cache/recipe tests passed. RAW Development 12 browser groups, RAW Lightbox 5, existing Photo Process 13, existing Lightbox 13, Google Photos 15, archive 10, selection 11 and keyboard/controller 14 passed: **93 browser groups**. Browser fixtures test UI/IPC behavior; decoder quality is covered by separate real-file checks.
- Real originals: `20261024_111624.cr3` and `20261024_111630.cr3`. Natural, Neutral, B&W and +1 EV exported independently, with unchanged original hashes, capture date, orientation and RTv4_sRGB profile. Camera framing is 6000 × 4000; this engine exposes 6014 × 4016 usable pixels without resize. True 16-bit TIFF was verified as 16/16/16 bits. An isolated orientation-6 source copy produced 4016 × 6014, orientation 1.
- Same recipe produced the same output bytes across repeated executions. Library integration proved metadata pairing across different names, canonical rating propagation, independent selection flags and checksum reuse. An actually started decoder was aborted without publishing output: **811 ms** in the initial local check and **1,370 ms** in the final acceptance run while other work was active.
- Both samples' outer-corner sheets and subject-detail crops were inspected. No black sensor border was observed in these sheets; the conservative default retained smooth background bokeh. This is visual integration acceptance, not calibrated colour/DPP equivalence or a missed-focus restoration claim.
- A standalone relocated runtime decoded a real CR3 with PATH empty at 6014 × 4016, with expected ICC and unchanged source hash. This ran in roughly 7.3 seconds locally. Individual natural/neutral/B&W/EV checks varied around 6.5–17 seconds with other work active. These measurements are not deployment-machine throughput guarantees; peak working set was unavailable from that probe.
- Independent bounded source review found no remaining concrete release blocker after fixes to reuse source revalidation, metadata pairing, cancellation, native scopes, lineage maintenance, owned-output classification and runtime-manifest completeness.

Evidence files remain under ignored `test-output/raw-development/`: `native-tests-final-333.log`, `real-library-final.log`, `native-tests-acceptance.log`, `real-acceptance.log` (historical fixture failure retained), `real-library-retest.log` (corrected fixture passes), `second-sample-quality.log`, `quality/<sample>/report.json`, `quality/export-edges.json`, `library-cancel.json`, `standalone-runtime/raw-runtime-smoke.json` and browser reports. The first library fixture failed because it attempted to write an ExifTool alias that did not copy the camera serial; correcting the fixture to the actual SerialNumber tag made the intended proof pass. No production pairing relaxation was used to pass it.

## Runtime/source and quality boundaries

RawTherapee 5.13 is a separate CPU/OpenMP process, capped to one worker/eight threads, 4 GiB and five minutes per decode. GUI browser resources are excluded; an owned neutral profile and explicit CR3-extension settings retain the CLI's required configuration. No external Canon editor/account, NVIDIA driver change or separately installed developer is required.

The 440-resource runtime closure contains all 81 SHA-matched DLLs, original engine/camera/ICC/DCP resources, 96 additional notice files, the exact 19,063,124-byte engine source archive and source locations for 62 exact MSYS2 dependency packages. Release verification rejects undeclared/missing/altered/linked resources. The engine source SHA-256 is `23BDFF4B1817E1274C11A94B11D21CAC59E9C1B1D209795D3194710EE73E77BF`. Source and notices are installed under `tools/rawtherapee/source` and adjacent licence folders. This records source/notices evidence; it is not an independent legal certification.

The ten supplied originals' metadata covers ISO 160–320 and landscape orientation, ordinary single-image containers. Real high-ISO, C-RAW/crop-mode and portrait captures remain additional validation inputs; the rotation fixture is explicitly not an actual portrait-capture certification. Burst rolls are rejected instead of silently treating one frame as the whole roll. RAW crop/straighten/lens-profile editing and semantic subject masking are not included. TIFF files are export/archive outputs; Lightbox comparison panels display JPEGs.

## Approved disk cleanup

Stuart explicitly approved removing only generated local installer copies 2.0.21–2.0.39. The bounded cleanup removed 38 files and reclaimed about 1,662 MiB. Their exact local paths, sizes and SHA-256 values were recorded in `test-output/raw-development/approved-installer-cleanup.json` before removal. Source, photos and 2.0.40/2.0.41 rollback installers were retained.

## Installer and delivery receipts

The optimized TypeScript/Vite/Rust production build passed. Four nonblocking native warnings remain: three existing unused items and one cfg-dependent unused-mut warning in the runtime resolver; existing frontend bundle-size/Browserslist-age notices remain. No unrelated dependency updates were made.

Final installer inspection: `test-output/release-2.0.42-inspection-20261027T035330244Z/report.json`, complete. The earlier 033905Z preflight report belongs to an unshared candidate and is not the release receipt.

- EXE: `PhotoGoGoV2_2.0.42_x64-setup.exe`, **130,055,537 bytes**; SHA-256 `44F653A19AED87DBC0FA6A2A878625936A3764BA98F70B0284744F70495389D8`.
- MSI: `PhotoGoGoV2_2.0.42_x64_en-US.msi`, **220,921,976 bytes**; SHA-256 `FDBCDB1DFC9FEF334017374A46C1F00EB1D2AA855FE86CEDDF6EA6DA39F6FB3E`.
- Standalone application: 29,902,848 bytes; SHA-256 `2D73F14441F9F74FA1773E04F7D176105901A50D445BC00416E1EC41D46036F7`.

Both unsigned Windows x64 installers were extracted without installation. Application payloads match the standalone binary after normalizing only the expected three-byte Tauri bundle marker. Both exact 2,205-file metadata-tool and 440-resource RAW closures verified and executed after relocation with PATH empty. Each extracted RAW runtime decoded a real CR3 at 6014 × 4016 with RTv4_sRGB and unchanged source hash. Media/source manifests verified; MSI UpgradeCode `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` is unchanged from 2.0.41. The production frontend contains version 2.0.42 and source marker bf7fdfff.

## Verified GitHub and Slack delivery

Installer-receipt commit `d1d8c38eaf8ddcaab2d2abb260d1e5a765d3fbb9` was atomically pushed to GitHub master and `SWG/cr3-raw-development` with annotated tag `v2.0.42`. Remote read-back confirmed both heads and the peeled tag at that commit. Built application source remains `bf7fdfff8582a037927ae04165d30554467a8f1f`; subsequent changes record receipts only. Other chats' local master and subject-finishing worktrees were left untouched.

Published through the verified Personal connection to GoggoVille **#swghermes** (`C0BDK1DDZTM`):

- EXE parent: 27 October 2026, **15:01:28 AEDT**, timestamp `1793073688.473119`, file `F0CBY3V2K7H`. HTTP 200 acknowledged exactly **130,055,537 bytes**. [Release post and EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793073688473119).
- MSI reply: **15:03:58 AEDT**, timestamp `1793073838.878389`, file `F0CCFC5J78R`. HTTP 200 acknowledged exactly **220,921,976 bytes**. [MSI alternative](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793073838878389).

Local sizes and SHA-256 values were rechecked immediately before each upload. Full thread read-back confirmed both file IDs/names, captions, checksums, testing guide and validation boundaries, with no remaining pagination. This verifies upload acknowledgements and Slack attachment metadata; no independent download/hash comparison of Slack-hosted bytes is claimed. A sandboxed request could not access the Windows network client certificate; the approved upload succeeded using the normal Windows transport outside that sandbox. No duplicate release post was created.

Install either unsigned x64 package when PhotoGoGo is idle; 2.0.41 is retained for rollback. No installation on Stuart's PCs, Google account uploads, active-render interruptions, driver changes or source-photo writes were performed by this task.
