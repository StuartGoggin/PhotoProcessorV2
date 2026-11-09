# PhotoGoGo 2.0.53 validation and publication

Status: source and package validation passed; publication pending.

## Final scope

- JPEG-first Lightbox labels and sizes for verified camera pairs, with a RAW badge and per-photo development. Canonical RAW paths/stamps and exact JPEG upload/tag targets are preserved. Filename and size sorting follow the visible JPEG.
- Mixed camera-JPEG folders hide unpaired RAW rows by default, including during capture checks. A counted Show unpaired RAW files control reveals them. RAW-only folders remain accessible automatically, including when they contain owned developed JPEGs. No filename-only pairing, media changes or relaxed native checks.
- Positive historical ratings, Trash and saved Google selection/favourite flags count as Reviewed only when no explicit decision exists. Valid explicit canonical records win; an absent canonical record may use a valid record on its proven camera JPEG. Manual false wins; stale, invalid, unreadable and ambiguous records remain uncertain. Physical neutral-key counts include related versions. No bulk sidecar migration.
- Canonical evidence drives filters, badge and M independent of the displayed source. Failed secondary writes remain pinned. Retry Reviewed explicitly writes true, and Retry Needs review preserves a failed manual false, without replaying a primary action or advancing; M retains its manual toggle behavior.
- Updated illustrated offline and portable user guide. Existing processing and Google upload routines are unchanged.

## Verified checks

- Focused unit regression reproduced the original 888 All / 888 Needs review / 588 Google-selected counts before the fix; now 888 / 300 / 588. It also covers explicit false, stale and unreadable metadata, pre-pair JPEG choices, canonical identity, ambiguous flags, RAW-only/mixed visibility, visible sorting and failed-save pins.
- Native suite: 416 passed, 0 failed, 30 opt-in media/hardware cases ignored (446 total), serial runner. No user media, live Google upload, controller or render-PC changes.
- Actual-page browser suites passed: JPEG-first 10; RAW 9; per-photo RAW workflow 7; first preview 16; browse 11; automatic review 13; controls/controller 21; selection/transfer barriers 11; existing Lightbox 13. Automatic-review cases include positive retry, M clear after a redundant save failure, and a failed manual clear retrying false. Catalogue/cache 20, command map 7, review queue 7 and curation queue 4 groups also pass. Help host 7, actual-page/capture 5 and portable document 7 groups passed. Production TypeScript/Vite build passed; only existing Browserslist age and chunk-size advisories remain. Final package evidence follows below. The 700-file delayed-metadata fixture paints its selected JPEG in 292 ms while inspection remains held; this is a local synthetic regression measurement, not a target storage or NAS throughput claim.
- Illustrations were visually inspected and use synthetic demonstration artwork. No user photographs or account data are packaged in the guide.

## Rollback and target acceptance

Keep 2.0.52 installers available. This release recognises history at read time and does not rewrite metadata in bulk; existing explicit records retain their meaning. On the target folder, open Needs review after capture checks complete, compare All/Google-selected/Needs review counts, inspect one old selected JPEG, manually clear and restore Reviewed, and open RAW only for a chosen photograph. Hidden unpaired RAW rows and uncertain identities can affect counts and remain discoverable through their notices.

Package hashes, source commit, installer inspection, remote integration and verified #swghermes delivery will be appended after the build.

## Final package inspection

Built source: `fecc03a0ea518f4c28d1f5123519f318e5bf7c90`. Production UI markers confirm this source and the JPEG-first/retry controls. The +local build suffix reflects four preserved unrelated untracked cleanup files; no tracked source change is omitted.

The first full build compiled the application but WiX packaging failed with a generic tool-launch error and no successful installer. WiX itself was callable. After the independent compiled-guide check finished, one serialized `tauri bundle --bundles msi,nsis --verbose` retry succeeded without a source change. Initial and retry logs are retained in test-output/release-2.0.53-build.log and test-output/release-2.0.53-package-retry.log. The original failure's precise OS cause is unconfirmed.

The release/custom-protocol compiled-guide parity check passed. Public, production-dist and portable HTML are byte-identical: 18 chapters, 11 figures, 1,093,443 bytes, SHA-256 `d74f4767373c9975f4ad021416de034d25dfbdef99ee7103097f230a1f292e24`.

Inspection receipt: `test-output/release-2.0.53-inspection-20261109T111252686Z/report.json`, complete=true. Both packages were extracted without installation. ProductVersion is 2.0.53 and UpgradeCode `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` is unchanged from 2.0.52. Both application payloads match normalized SHA-256 `70a8c0735392fddd17c824a9e210b8a53b770136bc4f25827b72fbfa1463ac9d`; normalization covers only Tauri's expected three-byte installer marker. Each package verified 35 payload hashes, ExifTool's 2,205 files with relocated runtime check, RAW's 440 resources, media/source pairing and controller source/licence closure. No new RAW decode benchmark was run for this review/UI change. Packages are unsigned test builds.

| Download | Bytes | SHA-256 |
|---|---:|---|
| PhotoGoGoV2_2.0.53_x64-setup.exe | 131,759,725 | `2b4e33317359680e22030a3c7e87a90cc69b1257cfabb258c652f5156ae1986c` |
| PhotoGoGoV2_2.0.53_x64_en-US.msi | 222,978,772 | `5660762c4df640afe154ee7de2aad97f7cdf2231d2373b9d4b1376e6a639e973` |
| PhotoGoGo_User_Guide_2.0.53.html | 1,093,443 | `d74f4767373c9975f4ad021416de034d25dfbdef99ee7103097f230a1f292e24` |
| PhotoGoGo-FFmpeg-rowtest1-source.tar.gz | 49,570,807 | `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8` |

`SHA256SUMS-2.0.53.txt` lists the four download hashes. The annotated release tag will identify this package receipt; the built application source remains fecc03a. Verified remote and Slack delivery details follow after publication.
