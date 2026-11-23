# PhotoGoGo 2.0.63 SD Card Archive maintenance

Source `e632e3114ed3db189b6fb12a2388966c8ffa632a`. SD Card Archive can upgrade a verified archive in place, restore recorded timestamps, and update Jobs history. A matching original card can supply missing directory timestamps. A fresh copy can be verified before the old archive is explicitly confirmed for removal. The repository needs space for both copies. Upgraded manifests are supported from 2.0.63.

## Validation

- The Windows native suite passed 505 tests with 33 opt-in cases skipped. The separate bundled ExifTool case passed.
- Fifteen SD Card Archive browser checks and seven offline Help checks passed. The production frontend built successfully.
- Synthetic Windows archives covered unchanged file identity during the upgrade, preservation of recorded times, interrupted upgrades and removals, rejection of an invalid replacement, and retention of unlisted files. Physical SD cards and network repositories were outside this test.

## Installer inspection

Both unsigned Windows x64 packages passed offline inspection, including 35 payload checks per package and MSI upgrade identity `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matching 2.0.62. Both packaged executables normalize to application SHA-256 `47ce0d05db3601c25b82dcacd2368967e0de555f513c9cebb1125bac1c33a150`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.63_x64_en-US.msi | 223,945,428 | `86d83a80776ad007c01b8486833d5549d35d9c4c413e68200a277fc863a8fdc5` |
| PhotoGoGoV2_2.0.63_x64-setup.exe | 132,436,491 | `df2c3cdb6ebec7e79ea04048bf8633f4dacc7077414643349924497fcc54f8ee` |
| PhotoGoGo_User_Guide_2.0.63.html | 1,330,302 | `11be36023172017cbde212e4a1dfa44e1c96998a1e4e2571ed7dbac994b2d50a` |
| SHA256SUMS-2.0.63.txt | 297 | `1d2f4c3fd565a8fecf77c558d32614991d9ba77380da2d79d1a8c8c4b2d95be1` |

Inspection receipt `test-output/release-2.0.63-inspection-20261123T101237746Z/report.json`. [Corresponding FFmpeg source](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz)

## Published release

The `v2.0.63` tag points to the built commit on GitHub `master`. GitHub reported the expected byte counts and SHA-256 digests for the guide and checksum list. [GitHub prerelease](https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.63)

Slack accepted 132,436,491 bytes with HTTP 200. The attachment was read back with file ID `F0CKPR4FBPH`. [PhotoGoGoV2_2.0.63_x64-setup.exe in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795429386676099)

Slack accepted 223,945,428 bytes with HTTP 200. The attachment was read back with file ID `F0CKZ04GF1R`. [PhotoGoGoV2_2.0.63_x64_en-US.msi in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795429486287359)

[Slack release thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795429374298449)
