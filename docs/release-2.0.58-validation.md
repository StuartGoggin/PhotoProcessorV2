# PhotoGoGo 2.0.58 SD Card Archive setup

Source `017c7e14a1379276ca993e1a1f9c44d6458e5f19`, build `20261122T210655752Z-017c7e14+local`. The update allows read-only card inspection before choosing a repository. Archive start still checks the saved destination, card identity and available space. The new card tiles show Windows-reported SD evidence, available capacity and unconfirmed media when Windows exposes only a generic reader. The manual drive-root picker remains available under **Card not listed?**. The redesigned source and repository panels have hover and keyboard help.

## Validation

- The native library suite passed 493 tests, with 32 opt-in cases excluded. It covers conservative Windows device classification and the existing archive safeguards.
- Ten SD Card Archive browser checks passed. These include simulated SD and USB-only readers, the previously disabled inspection, manual drive-root selection, capacity, keyboard help and the start guard. Ten standalone Import UI tests and seven checks each for embedded Help and the portable guide passed.
- The production frontend build passed. Both Windows installers were inspected without installation. Each verified 35 payloads, bundle-type markers and the bundled runtime and source closure. MSI upgrade identity `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matches 2.0.57.
- Testing used development fixtures. The reader and card on the target machine remain to be checked. Keep 2.0.57 for rollback.

## Release files

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.58_x64_en-US.msi | 223,888,084 | `56b50bf94082e774a50902e8d99a3c7aec8b38b3445ad907cd558aae73cf3fe9` |
| PhotoGoGoV2_2.0.58_x64-setup.exe | 132,565,601 | `e84bd9af3b61eefea4710cd3528053c0b0896801e671654c5cc11b1e6ad45457` |
| PhotoGoGo_User_Guide_2.0.58.html | 1,327,270 | `960a7fe1a115eff0ea91393b5e0c774b54c56b1bf8a0bc8cc6da5ebcd0e24464` |
| SHA256SUMS-2.0.58.txt | 407 | `f8631f493e6a4cafbf6c976961939a1ebdf9fccff993aa4db7ee0c90a809da68` |

Both installers are unsigned Windows x64 test packages. Inspection receipt `test-output/release-2.0.58-inspection-20261122T211650175Z/report.json`. Standalone application SHA-256 `1c6b13620ade1fbc1a80ea85925afcfe8ff2e01b10ffef7d4448643659671ea2`. The bundle uses the unchanged [corresponding FFmpeg source](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz).

## Published release

The [GitHub prerelease](https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.58) is live. Tag `v2.0.58` points to the exact source used to build both installers. The guide and checksum file matched their local sizes and SHA-256 digests in GitHub's read-back.

Both installer uploads returned HTTP 200 with the expected byte counts. The [#swghermes thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795382686715789) shows both filenames and file IDs. This records local hashes, server transfer acknowledgements and visible attachments.

- [Windows x64 EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795382692073619), Slack file `F0CL4V7ALQL`.
- [Windows x64 MSI](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795382726262419), Slack file `F0CLVKHTZR6`.
