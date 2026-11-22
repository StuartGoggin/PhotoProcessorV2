# PhotoGoGo 2.0.59 multi-card archives and logging

Source `c74453f699fe3588c17ac6bc7b1a397f9f0e1c8e`. The SD Card Archive page can start another card while a job is running. Each active job has its own progress, controls and link to Jobs. PhotoGoGo can copy cards together when Windows identifies separate readers. Shared or uncertain readers retain the existing serialization safeguards.

Archive and **Verify archive again** now write job-ID-tagged entries to the standard Logs page and its `operations.log` file. The entries cover startup, phase changes, control requests, verification results and failures.

## Validation

- The native library suite passed 494 tests, with 32 opt-in cases excluded. It covered reader scheduling, archive safeguards and the new operation-log format.
- The production frontend build and 11 SD Card Archive browser checks passed. The two-card case used simulated responses and verified that both jobs stay visible, pausing one leaves the other running, and each job can be opened in Jobs.
- Ten Import UI checks and seven checks each for embedded Help and the portable guide passed. Physical reader behavior and throughput remain for target-machine testing.

## Installer evidence

Build `20261122T221538611Z-c74453f6+local` produced unsigned Windows x64 EXE and MSI test installers. Both were inspected without installation and passed bundle-type, runtime, corresponding-source and 35 payload checks each. The MSI upgrade identity `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matches 2.0.58, which remains available for rollback.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.59_x64_en-US.msi | 223,847,124 | `1cd68b1a491843d58d1a4ac897e7c49a9cb56a5a455a05f2ebadac5296b53f6a` |
| PhotoGoGoV2_2.0.59_x64-setup.exe | 132,389,527 | `0f4adbc56487ba887b40e40dd43e275e41c77158377448eee14a7885eaf4fd60` |
| PhotoGoGo_User_Guide_2.0.59.html | 1,327,748 | `b70b439199c765d236aa8265ad30867e59e10b6fc215f42cd14c62db282be7dd` |
| SHA256SUMS-2.0.59.txt | 407 | `62a493594cca95f74eb76fea70ca25c62154a96db5bf1a5684b02427861423bb` |

Inspection receipt `test-output/release-2.0.59-inspection-20261122T222547050Z/report.json`. Standalone application SHA-256 `bbc991b65dbf2c5e3310137177c1bc1a7ff54e48ad6b15ddc488e8b62dec82a4`. See the unchanged [corresponding FFmpeg source](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz).

## Published release

The [GitHub prerelease](https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.59) is live. Tag `v2.0.59` points to the exact built commit. The guide and checksum assets match their local byte counts and SHA-256 digests.

Both unsigned Windows installers returned HTTP 200 for the expected upload byte counts. The [#swghermes release thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795386742562989) shows both filenames and file IDs.

- [Windows x64 EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795386750536819), Slack file `F0CL565PGHJ`.
- [Windows x64 MSI](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795386833023789), Slack file `F0CLVRWABTJ`.
