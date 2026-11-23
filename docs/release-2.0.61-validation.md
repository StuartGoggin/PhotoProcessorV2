# PhotoGoGo 2.0.61 graphical Jobs progress

Source `225ef48a3f6810e17526caa86964d68b281b4ce6`. The bottom Jobs pane shows compact live progress cards for each job type. Manage jobs opens the full cards with details, controls, and logs. The SD Card Archive setup page shows status and a shortcut to Jobs. Job lists refresh independently.

## Validation

- The production frontend build passed. Twenty-one Jobs browser checks covered all 18 process types and the existing controls.
- Thirteen SD Card Archive browser checks passed, including progress during a stalled unrelated job feed. Seven portable guide checks passed.

## Installer inspection

Build `20261123T025748788Z-225ef48a+local` produced unsigned Windows x64 EXE and MSI installers. Both passed offline inspection, including 35 payload checks per package and bundled runtime, license, and corresponding-source checks. Both packaged executables normalize to the standalone application SHA-256 `259201b5fc24b28c14a96f9174be526bc4cf126cb7f091866c20bf0f705c8e6f`. MSI upgrade identity `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` matches 2.0.60. Installation and physical hardware testing remain for the target PC.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.61_x64-setup.exe | 132,388,463 | `a678d839b2a821ced3c2544a4efddff2f6aec5f38b832994872f6deff08f0127` |
| PhotoGoGoV2_2.0.61_x64_en-US.msi | 223,900,372 | `112c0ab45d3e53c2bbebb481aec0fafa68aa48c9d0e6aeb0752e1f62e0b4df61` |
| PhotoGoGo_User_Guide_2.0.61.html | 1,328,407 | `310105176ecef5293c13084732c99964e2aac7150f0132bf752a4de27c8a6aaa` |
| SHA256SUMS-2.0.61.txt | 300 | `1e82c126bab29d0accde96361e2600377b043da98e4fb23f8910e0a09cd527aa` |

Inspection receipt `test-output/release-2.0.61-inspection-20261123T030949565Z/report.json`. [Corresponding FFmpeg source](https://github.com/StuartGoggin/PhotoProcessorV2/releases/download/v2.0.53/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz)

## Published release

The `v2.0.61` tag points to the built commit on GitHub `master`. The GitHub prerelease reports the expected byte counts and SHA-256 digests for the guide and checksum list. [GitHub prerelease](https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.61)

Slack accepted 132,388,463 bytes with HTTP 200. The attachment was read back with file ID `F0CL4FGUQSD`. [PhotoGoGoV2_2.0.61_x64-setup.exe in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795403931997159)

Slack accepted 223,900,372 bytes with HTTP 200. The attachment was read back with file ID `F0CL4FHAJ81`. [PhotoGoGoV2_2.0.61_x64_en-US.msi in #swghermes](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795403958331059)

[Slack release thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1795403845850479)
