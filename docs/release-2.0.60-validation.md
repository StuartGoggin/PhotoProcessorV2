# PhotoGoGo 2.0.60 resumable SD Card Archive

Source `d4ec29f28b03ce9c410a5c96f92393b03468e066`. The release restores interrupted SD Card Archive jobs using per-file SHA-256 checkpoints. It reuses matching files, recopies missing files, and preserves damaged draft bytes before a verified repair. A matching completed archive can be rechecked without another copy. The archive progress card refreshes independently in SD Card Archive and Jobs.

## Validation

- 499 native tests passed and 32 optional cases were skipped. Recovery cases included forced process exit, a torn checksum record, a missing file, repair of a damaged draft, changed bytes with unchanged timestamps, and a crash after archive publication.
- The frontend build, 13 SD Card Archive browser cases, shared Jobs polling and Google Photos core Jobs checks passed. Archive jobs stayed live during a stalled unrelated job list.
- Ten Import UI checks and seven checks each for embedded Help and the portable guide passed. Physical reader and repository throughput are for on-device testing.

## Installer inspection

Build `20261123T014647708Z-d4ec29f2+local` produced unsigned Windows x64 EXE and MSI installers. Both passed inspection without installation, including the correct package type, runtime and corresponding-source checks, and 35 payload checks each. MSI upgrade identity `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matches 2.0.59.

WiX could not write its cache on the initial bundle attempt. The signed-in build environment completed the MSI. Tauri's three-byte packaging marker was restored to its original value before the EXE was bundled again. Inspection confirmed that both packaged applications normalize to the same standalone application SHA-256 `a4c3665984a4f26ec3f931f302f36168dd102a2cd1b216f9d6fc49a0a4911481`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.60_x64-setup.exe | 132,402,556 | `1e3c0064cff1ebe602a4ad97f029661055f2764393e83e7121ea1abcfd96e10c` |
| PhotoGoGoV2_2.0.60_x64_en-US.msi | 223,900,372 | `477bb4d42f98245f8ae76b3103b69e0c09ec228f0542fdb92bfeb8ecd6feb5ec` |
| PhotoGoGo_User_Guide_2.0.60.html | 1,328,294 | `eb7153c1d0af15fc94a4c77d2919354c0bc24ca478d6c09467c1fd300992a508` |
| SHA256SUMS-2.0.60.txt | 300 | `f86f541d213b7b75c71fa0f4d592486f9b034e9f259fd72c8755c108af2e6c38` |

Inspection receipt `test-output/release-2.0.60-inspection-20261123T020356142Z/report.json`. See the unchanged [corresponding FFmpeg source](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz).

## Published release

The `v2.0.60` tag points to the exact built commit on GitHub `master`. GitHub reports the expected byte counts and SHA-256 digests for the guide and checksum list. [GitHub prerelease](https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.60)

The Windows x64 EXE returned HTTP 200 for the expected upload byte count and was read back with Slack file ID `F0CLWMG2U7J`. [EXE installer in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795400060826999)

The Windows x64 MSI returned HTTP 200 for the expected upload byte count and was read back with Slack file ID `F0CL477PMPB`. [MSI installer in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795400311823629)

[Slack release thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795400050372959)
