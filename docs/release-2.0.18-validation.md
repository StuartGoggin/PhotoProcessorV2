# 2.0.18 camera-audio and compact Studio test release

Scope: conservative camera wind-noise reduction and a denser Video Studio.
No dependency, driver, stabilisation algorithm, scheduler-budget or render-PC
configuration changes. The 2.0.17 appended-clip workflow is retained.

## Behaviour

- Project Off/Light/Moderate/Strong default and clip Inherit/explicit override.
  Existing projects default to Off. Camera filtering precedes music mixing;
  the music branch is not filtered. Fixed high-pass/high-shelf presets reduce
  bass rumble and hiss, but can soften wanted sound in those frequencies.
- A bounded local up-to-10-second A/B preview uses one player and retains the
  listening position. Raw camera audio is previewed; final assembly processes
  cached camera audio after existing replay treatments. They share coefficients
  but are not claimed to be sample-identical pipelines.
- Audio edits retain picture approval and verified stabilised clip caches.
  Create a NEW final video to apply them. Existing clip-render playback remains
  unchanged; old exports become outdated and saved jobs retain their requests.
- Compact three-column Studio, searchable/filterable sequence, keyboard-accessible
  inspector tabs, and Compact/Comfortable density. The collapsed jobs dock keeps
  errors and live RAM waits visible. Explicit user dock preferences are retained.

See `studio-camera-audio.md` for exact presets, bounds, recipe compatibility,
and implementation evidence. Large timelines use balanced filter expressions;
the 500-clip alternating-preset regression passes with the bundled FFmpeg.

## Validation gates

Pre-package implementation gates passed: 111 native library tests (10 opt-in
tests skipped in the general suite), 63 frontend checks, TypeScript, production
frontend bundle, and Studio/audio/jobs/appended-clips browser workflows.
The relevant audio-media and restart/assembly opt-in tests passed separately,
covering synthetic frequency response, silent input, per-clip Off, unchanged
video packet hashes/frame counts/duration, music isolation, replay/cache reuse
and sequence receipts. Browser IPC is mocked; native tests use real FFmpeg.

The 1920x1080 24-clip browser fixture exposes 13 complete rows; 360px-to-4K
overflow checks and 44px narrow/coarse-pointer controls pass. The 31-to-51
workflow retains old caches and leaves old requests unchanged.

The release must pass a fresh version-consistency/frontend check, locked build,
MSI identity and upgrade-code comparison, extracted application and media-payload
verification, and extracted-tool smoke checks before Slack delivery. Installer
hashes, build identity, remote Git commit and Slack read-back belong in the
delivery receipt, not assumed from build exit status.

## Packaging and acceptance

Uses the unchanged 2.0.16/2.0.17 managed FFmpeg/ffprobe bundle and corresponding
source archive SHA-256:
`27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8`.
The previous source attachment remains valid; no new media backend is claimed.
This is an unsigned Windows x64 test installer without the optional offline
face runtime. Optional LMMS soundtrack integration is not part of the test claim.

Let active renders finish and close PhotoGoGo normally before installation.
Keep the previous installer, outputs, caches and a backup of project.json.
Start with Light on a windy clip, compare the same section using A/B, check
natural event sounds, then export a new final and check its music and ending.
Set every included clip's effective preset Off for the immediate sound-processing
fallback; project Off alone does not override explicit per-clip strengths.
Do not clear picture caches. Preserve the project backup before any binary
downgrade: 2.0.17 does not understand the new audio fields or v2 recipes.
Installer downgrade/upgrade behaviour and full user-footage exports are not
established by extraction or synthetic-media tests.

Real-footage listening is still required: this is not a gate, speech isolator,
AI denoiser, or restoration of clipped/distorted recordings. This release does
not claim to fix the reported upward-pan rotational wobble.
