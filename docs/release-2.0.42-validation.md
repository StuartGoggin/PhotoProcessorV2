# PhotoGoGo 2.0.42 — CR3 originals and standalone RAW development

Application source and installer inspection/delivery receipts are recorded below once complete. The implementation starts with `f59828e` and includes the subsequent fix retaining independent colour/B&W/JPEG/TIFF branches.

## Result and workflow

CR3 originals can be reviewed through their camera previews and developed through the new Photo Process RAW Development card. Natural, Neutral and High ISO starting recipes expose white balance, manual/automatic levels, tone, detail and noise controls, separate saved photo overrides, recalled applied recipes and explicit preview actions. Colour and B&W export independently from RAW to full-resolution sRGB JPEG or true 16-bit TIFF through core Jobs.

Original bytes and earlier generations are retained. A folder-local versioned manifest owns derivatives and recipes; retired generations never become new Originals. Engine/profile/dependency identity and source/output checksums govern reuse. Individual maintenance moves that would strand lineage are blocked before a batch starts, with a final lease-protected check. Whole-event rename remains supported. Archive selection retains metadata only when library metadata backup is chosen.

Metadata-proven RAW/camera-JPEG pairs may have different imported filenames. One unambiguous camera model/serial/exact timestamp/subseconds match anchors capture ratings to RAW while keeping Google flags specific to each physical image. Preferred Colour chooses a supported camera JPEG over a RAW Original tie. Corrupt metadata, changed named output sizes, ambiguous identities and scope mismatches fail closed. A queued or active cancellation uses core Aborted semantics.

See [the user/developer guide](cr3-raw-development.md) for exact scopes, preset behavior, reproduction and limitations. Existing JPEG workflows remain independent; RAW-owned JPEG developments are not silently fed back into JPEG Enhance/B&W as masters.

## Validation evidence

- Native suite initially passed 332 tests with zero failures and 26 opt-in tests skipped. The final branch-isolation regression and complete rerun are recorded with final results below. Separate opt-in real-file acceptance exercised two supplied originals, TIFF/orientation/repeatability and library/reuse/cancellation. These are four successful test invocations across three dedicated tests, not a claim that all 26 opt-in tests ran.
- Frontend: TypeScript and 20 catalogue/cache/recipe tests passed. RAW Development 12 browser groups, RAW Lightbox 5, existing Photo Process 13, existing Lightbox 13, Google Photos 15, archive 10, selection 11 and keyboard/controller 14 passed: **93 browser groups**. Browser fixtures test UI/IPC behavior; decoder quality is covered by separate real-file checks.
- Real originals: `20261024_111624.cr3` and `20261024_111630.cr3`. Natural, Neutral, B&W and +1 EV exported independently, with unchanged original hashes, capture date, orientation and RTv4_sRGB profile. Camera framing is 6000 × 4000; this engine exposes 6014 × 4016 usable pixels without resize. True 16-bit TIFF was verified as 16/16/16 bits. An isolated orientation-6 source copy produced 4016 × 6014, orientation 1.
- Same recipe produced the same output bytes across repeated executions. Library integration proved metadata pairing across different names, canonical rating propagation, independent selection flags and checksum reuse. An actually started decoder was aborted in **811 ms** in the local test, without publishing an output.
- Both samples' outer-corner sheets and subject-detail crops were inspected. No black sensor border was observed in these sheets; the conservative default retained smooth background bokeh. This is visual integration acceptance, not calibrated colour/DPP equivalence or a missed-focus restoration claim.
- A standalone relocated runtime decoded a real CR3 with PATH empty at 6014 × 4016, with expected ICC and unchanged source hash. This ran in roughly 7.3 seconds locally. Individual natural/neutral/B&W/EV checks varied around 6.5–17 seconds with other work active. These measurements are not deployment-machine throughput guarantees; peak working set was unavailable from that probe.
- Independent bounded source review found no remaining concrete release blocker after fixes to reuse source revalidation, metadata pairing, cancellation, native scopes, lineage maintenance, owned-output classification and runtime-manifest completeness.

Evidence files remain under ignored `test-output/raw-development/`: `native-tests-acceptance.log`, `real-acceptance.log` (historical fixture failure retained), `real-library-retest.log` (corrected fixture passes), `second-sample-quality.log`, `quality/<sample>/report.json`, `quality/export-edges.json`, `library-cancel.json`, `standalone-runtime/raw-runtime-smoke.json` and browser reports. The first library fixture failed because it attempted to write an ExifTool alias that did not copy the camera serial; correcting the fixture to the actual SerialNumber tag made the intended proof pass. No production pairing relaxation was used to pass it.

## Runtime/source and quality boundaries

RawTherapee 5.13 is a separate CPU/OpenMP process, capped to one worker/eight threads, 4 GiB and five minutes per decode. GUI browser resources are excluded; an owned neutral profile and explicit CR3-extension settings retain the CLI's required configuration. No external Canon editor/account, NVIDIA driver change or separately installed developer is required.

The 440-resource runtime closure contains all 81 SHA-matched DLLs, original engine/camera/ICC/DCP resources, 96 additional notice files, the exact 19,063,124-byte engine source archive and source locations for 62 exact MSYS2 dependency packages. Release verification rejects undeclared/missing/altered/linked resources. The engine source SHA-256 is `23BDFF4B1817E1274C11A94B11D21CAC59E9C1B1D209795D3194710EE73E77BF`. Source and notices are installed under `tools/rawtherapee/source` and adjacent licence folders. This records source/notices evidence; it is not an independent legal certification.

The ten supplied originals' metadata covers ISO 160–320 and landscape orientation, ordinary single-image containers. Real high-ISO, C-RAW/crop-mode and portrait captures remain additional validation inputs; the rotation fixture is explicitly not an actual portrait-capture certification. Burst rolls are rejected instead of silently treating one frame as the whole roll. RAW crop/straighten/lens-profile editing and semantic subject masking are not included. TIFF files are export/archive outputs; Lightbox comparison panels display JPEGs.

## Approved disk cleanup

Stuart explicitly approved removing only generated local installer copies 2.0.21–2.0.39. The bounded cleanup removed 38 files and reclaimed about 1,662 MiB. Their exact local paths, sizes and SHA-256 values were recorded in `test-output/raw-development/approved-installer-cleanup.json` before removal. Source, photos and 2.0.40/2.0.41 rollback installers were retained.

## Installer and delivery receipts

Pending final installer inspection and verified GitHub/Slack publication. No installation on Stuart's PCs or Google account uploads are performed by this task.
