# PhotoGoGo 2.0.57 SD Card Archive

## Source and validation

The build source is `74f3688955193d65f6f85d63176875f77f022051`. This Windows x64 test release adds a separate whole-card archive workflow. Verified copies preserve the readable card tree, independent SHA-256 read-back, a portable checksum manifest, safe restart and retry, and offline verification. The job records publication separately from the private draft. The built-in guide explains setup, recovery and manual card reuse.

- Native library suite: **492 passed, 0 failed, 32 opt-in tests excluded**. The archive tests exercised card identity and inventory changes, interrupted copy, damaged checkpoints, a late destination collision, exact paths and data, and offline verification.
- Production frontend build, nine SD Card Archive browser checks, ten Import UI tests and the shared Jobs polling test passed. Archive browser checks used synthetic native responses. The corrected guide passed seven host checks and seven portable document checks.
- The optimized local fixture measured 66.42 MiB/s verified versus 68.04 MiB/s straight copy for two 64 MiB clips, and 8.11 versus 8.59 MiB/s for 256 mixed-size files. These use the same local test volume. Actual card-reader, network, unplug and out-of-space behavior remain to be exercised on target hardware.

The matching unchanged [FFmpeg source archive](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz) was checked against GitHub's digest and the local file. It is 49,570,807 bytes with SHA-256 `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8`.

## Verified packages

Build `20261122T202106114Z-74f36889+local` used the source above. Packaging was rebuilt from that unchanged commit using Tauri's project-local tool cache after its user-level cache could not be written. The final inspection verified the expected separate MSI and NSIS markers and 35 payloads in each package, including the bundled runtime and corresponding-source checks. MSI upgrade code `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matches 2.0.56. Both are unsigned x64 test installers and were inspected without installation.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
+| PhotoGoGoV2_2.0.57_x64_en-US.msi | 223,863,508 | `52844b8d9e80eadbea396867bf1b614a68362ffa3c12811b7493987792762308` |
| PhotoGoGoV2_2.0.57_x64-setup.exe | 132,428,618 | `5b24c9dacd30814f531f56f3a5a153680e8e7864ecd7f689e6dbf25f337a9a15` |
| PhotoGoGo_User_Guide_2.0.57.html | 1,327,032 | `6338d9852e994819a170ed018e9f808a9e78d5b6b8e620a7170046e6478e624b` |
| SHA256SUMS-2.0.57.txt | 407 | `35ad9fe67b67ac5607405469f45fda8f67591bdceffd77cfb63b094a420dfba9` |

Inspection receipt `test-output/release-2.0.57-inspection-20261122T203002532Z/report.json`. Standalone application SHA-256 `f8ecda10de8f5314585eff817a0d5ba3b01b65994273d45efc8bbc2e76e80ca2`.
