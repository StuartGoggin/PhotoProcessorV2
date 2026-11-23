# PhotoGoGo 2.0.62 SD Card Archive

Source `a5f6199546c0e009c01e9c0593a73a99cfdeb2e3`. New archives use the card's Windows volume serial followed by the earliest photo date. Archived files, directories and the card root retain their creation and modification timestamps. Last-access timestamps are preserved where supported. Existing archives verify under their original names.

## Validation

- The production frontend built successfully. Thirteen SD Card Archive browser checks and seven offline guide checks passed.
- The native suite passed 501 tests with 33 opt-in cases skipped. An additional opt-in test passed against bundled ExifTool and checked earliest capture date selection from embedded photo metadata.
- Windows fixtures verified creation and modification times for files, directories, empty directories and the archived root. They detected a timestamp-only change, verified a legacy archive and recovered after an interrupted copy. Physical SD cards and network repositories were outside this test.

## Installer inspection

Both unsigned Windows x64 packages passed non-installing inspection, including the 35 payload checks, runtime and corresponding-source checks, and MSI upgrade identity `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matching 2.0.61. The packaged application normalizes to SHA-256 `53f8674b523507be8bc7193e9cae1084ff1ff402593c1779621b01a08c0647ac`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.62_x64-setup.exe | 132,515,232 | `c23bac0cce6d123badb42c4de5b11bae11790cc81bb8b2e04fd105065ed80bac` |
| PhotoGoGoV2_2.0.62_x64_en-US.msi | 223,945,428 | `3fe812f1ea694088fe034641ba5216a53858a42a3921be4151295d2d5f45cc0a` |
| PhotoGoGo_User_Guide_2.0.62.html | 1,329,014 | `0e3baca3165f0b295a5fef06f16ae5b38bb41b7a53503080363c177e0e46729e` |
| SHA256SUMS-2.0.62.txt | 297 | `eaa1700d0595942a87f4f5c3b48d8a076912af98126a60acf041e2ea0418348e` |

Inspection receipt `test-output/release-2.0.62-inspection-20261123T091400880Z/report.json`. [Corresponding FFmpeg source](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz)

## Published release

The `v2.0.62` tag points to the exact built commit on GitHub `master`. GitHub returned the expected byte counts and SHA-256 digests for the offline guide and checksum list. [GitHub prerelease](https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.62)

Slack accepted 132,515,232 bytes with HTTP 200. The attachment was read back with file ID `F0CL6JPDF17`. [PhotoGoGoV2_2.0.62_x64-setup.exe in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795425785598599)

Slack accepted 223,945,428 bytes with HTTP 200. The attachment was read back with file ID `F0CL6JQ2EJD`. [PhotoGoGoV2_2.0.62_x64_en-US.msi in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795425878131469)

[Slack release thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795425773900359)
