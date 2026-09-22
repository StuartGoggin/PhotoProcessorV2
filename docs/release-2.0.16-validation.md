# 2.0.16 row-parallel stabilisation test release

Scope: package the narrow old-vid.stab backport, keep the explicit external
FFmpeg override, and prefer the installer-owned matching FFmpeg/ffprobe pair.
No quality reduction, chunked clips, changed scheduler budgets, relaxed memory
reserve, graphics-driver changes, or remote deployment.

## Backend evidence (22 September 2026)

The candidate is `n8.1.1-PhotoGoGo-rowtest1`:

- FFmpeg SHA-256: `898C1EA98F42755B57F1EF845AB50FC7CB1840FC6C1D64F2F0D150727FBC5630`
- ffprobe SHA-256: `5DFBFA385580D884BA599A0356E36D80B14ADC614FD95DEEE935BBF19B90BEBC`
- Source archive: `PhotoGoGo-FFmpeg-rowtest1-source.tar.gz`, 49,570,807 bytes.
- Source archive SHA-256: `27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8`
- Source archive listing verified: 20,038 files; critical modified source,
  patch, build script and recipe extracted and hash-compared to build inputs.

Full production Quality filter chain, same synthetic 50-frame 4K50 input,
existing motion data, two runs per thread count:

| OpenMP workers | Mean seconds | Relative speed | Peak working set |
| --- | ---: | ---: | ---: |
| 1 | 16.351 | 1.00x | 323.8 MiB |
| 6 | 7.570 | 2.16x | 324.0 MiB |
| 12 | 7.304 | 2.24x | 324.1 MiB |

All **300 frame comparisons across six runs of the same 50 frames** match the
installed Gyan 8.1.1 reference pixels and timestamps exactly. Relative speeds
above compare this candidate with itself at one worker, not an RTX render.
The test substitutes checksums for encoding and does not rerun motion detection.
Raw evidence is in `test-output/low-disk-ffmpeg-20260922T021527464Z/report.json`;
the installer contains its path-sanitized copy with identical hashes/results.

Other backend gates passed: retained-input ownership red/green regression,
192 one-versus-many-worker frame pairs, 24 additional format/interpolation
pairs, bounded binary-header regression, captioned H.264/AAC video, ffprobe,
JPEG thumbnail pipe, software AV1, capability coverage, and recursive x64
runtime import/hash checks. Microsoft release DLLs are bundled app-locally.

## Application and package gates

- 104 native tests passed; nine optional/integration cases ignored in that run.
- 47 frontend checks and both headless browser suites passed.
- GUI-parent regression passed: thumbnail, metadata, preview and error-capture
  helpers produced no child console, while the positive control was visible.
- Five separately executed real-media scenarios passed with this backend:
  clear-job recovery, restart assembly, full-range colour, rendering/cache,
  and opening-title/overlay delivery.
- Optional `lmms_audio_smoke` failed its prerequisite check because LMMS is not
  installed at the configured/default path. It did not reach media processing.
  No dependency was installed or the test weakened to hide that limitation.
- Manifest regression: valid bundle plus eight invalid/tampered cases, including
  mismatched runtime evidence, all behaved as expected. The runtime evidence
  regression was first reproduced failing before the verifier was corrected.
- Release entry point uses PowerShell 7; the release preflight fails closed
  unless pair, DLL, media/Quality evidence, licenses and source archive match.

The installer is unsigned and continues to omit the optional offline face
runtime. Its final SHA-256, extracted-payload validation and Git commit are
recorded in the delivery receipt/Slack message after the package is built.
Actual installer upgrade behaviour and fresh-clip RTX 2060 throughput remain
render-PC acceptance items. Keep previous outputs and the previous installer;
do not interrupt active work to install or benchmark this build.
