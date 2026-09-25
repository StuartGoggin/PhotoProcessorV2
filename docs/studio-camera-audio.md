# Studio camera audio and compact editing

Implemented for the 2.0.18 test release. See `release-2.0.18-validation.md`
for packaging scope and acceptance boundaries; delivery is recorded separately.

## Listening workflow

Select a clip, open **Sound**, and start with **Light**. The project default is
**Off** for existing projects; clips use **Inherit** unless explicitly overridden.
Changing the default affects inherited clips, including clips added later.
Choose **Off** on an individual clip to keep its original camera sound.

Choose a windy section and generate an **up to 10-second** local preview. A/B
uses one player at the same listening position. It does not upload media, alter
source files, add music, or run video stabilisation. Preview the result before
using Moderate or Strong: wanted bass and high-frequency detail can soften too.
Clipped/distorted microphone recordings and broadband wind cannot be restored by
these filters. This is not speech isolation, a gate or AI noise removal.

| Preset | Two-pole high-pass | High shelf at 6 kHz |
| --- | --- | --- |
| Off | None | None |
| Light | 60 Hz | −2 dB |
| Moderate | 85 Hz | −4 dB |
| Strong | 110 Hz | −6 dB |

The existing original/music volume controls remain unchanged. Wind filtering is
on the camera branch **before** music mixing; background music never enters it.
Filters use FFmpeg's documented [highpass and treble filters](https://ffmpeg.org/ffmpeg-filters.html).

## Editing and export behaviour

- Audio-only edits preserve picture approval, picture revisions and verified
  stabilised clip caches. A complete export uses the new sound settings without
  stabilising those clips again.
- Existing clip-render files and picture previews intentionally retain original
  audio. Use Sound's A/B preview to hear cleanup, and the final export to hear the
  complete mix.
- An old final export becomes outdated if effective sound settings change.
  Resuming a queued/interrupted job still uses its immutable saved request.
- Replays inherit the parent clip's sound setting. Cleanup is applied after the
  existing replay speed/level treatment. Opening title cards are not filtered.
- Turning every included clip Off restores the legacy sequence recipe exactly.
  Active processing uses sequence recipe v2 with audio recipe v1. Future changes
  to filter coefficients must version the audio recipe rather than silently
  reinterpreting old exports.

## Implementation limits and safeguards

`video_studio/audio.rs` owns fixed preset validation, recipe identity, final
camera filtering and bounded WAV preview generation. No caller can supply an
FFmpeg filter string. Sources are validated MP4 files under the staging folder.
Preview accepts at most 20 seconds at the native interface (the UI requests 10),
one request at a time, one filter thread, bounded output and per-process timeouts.
Short/absent audio is padded to match the selected video interval.

Final processing uses measured video frame boundaries, not estimated clip
durations. 48 kHz audio is grouped into frame-sized blocks before preset switches.
Only audio is processed during final stream-copy assembly; an explicitly enabled
opening text overlay can still re-encode the first picture segment as before.
There are no full-video intermediates or uncompressed audio scratch files. A
generated filter script avoids Windows command-line limits for large sequences.
Timeline conditions are balanced expressions: the 500-clip alternating-preset
regression exposed FFmpeg's expression-depth limit for a flat sum of conditions.
The same terms succeed with logarithmic-depth grouping; no media or preset
changes are needed. See [FFmpeg's expression evaluator](https://www.ffmpeg.org/doxygen/8.1/eval_8c_source.html).
The existing render scheduler, cancellation, output verification and atomic
publish path remain in use. Delivery and verification receipts include audio
recipe identity. Setting Off is the reversible per-project/per-clip fallback.

## Verification

- `scripts/test-studio-audio.mjs`: migration, inheritance, explicit Off, invalid
  values, preserved picture readiness/review, v1/v2 export status and preview bounds.
- Native `studio_audio_*` tests: presets, recipe, bounded timeline and WAV header.
- Explicit ignored `studio_audio_media_smoke`: actual bundled FFmpeg frequency
  response, per-clip Off, silent input, unchanged video packets, frame count and
  duration, and identical music samples with camera volume zero.
- Explicit ignored `restart_assembly_smoke`: actual clip reuse across restart,
  audio-only assembly with replay, v2 receipt and music assembly.
- Browser and type checks cover the compact editor and audio interaction. Real
  windy event footage still needs a listening acceptance check; synthetic tests
  are not proof of subjective sound quality.

## Local validation checkpoint — 25 September 2026

- Release-mode native library: **111 passed**, 10 opt-in tests skipped by the
  ordinary suite. Audio media and recovery/assembly tests were then run explicitly
  in separate processes and passed, including the corrected 500-clip graph.
- Frontend regression suite: **63 passed**. TypeScript and the production Vite
  bundle build passed; no dependencies were added or updated.
- Real Edge browser tests passed for Studio layout/editing, A/B audio controls,
  job polling/recovery and the **31 → 51 clip** workflow. Browser IPC is mocked;
  real media operations are covered by the native tests above, not those mocks.
- At 1920×1080 the 24-clip fixture exposes **13 complete rows**. The layout also
  passes 360px–4K overflow checks and Comfortable touch controls retain 44px
  minimum height. Clip search/filtering, keyboard inspector tabs and explicit jobs
  panel preferences are covered. The collapsed dock retains errors and live RAM
  waits, without reviving completed/paused-job telemetry.
- Visual evidence: `test-output/studio-browser/studio-compact-1920x1080-24-clips.png`.
  Native logs: `test-output/ffmpeg-row-backport/studio-wind-final-native.log`,
  `studio-wind-scale-fixed.log`, and `studio-wind-final-recovery.log`.

These checks were completed before packaging. Nothing has been installed on the
render PC. Actual installation/upgrade and listening acceptance on representative
windy event audio remain user acceptance checks.
