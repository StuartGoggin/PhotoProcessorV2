# 2.0.19 project-settings Studio test release

Scope: separate project settings from the clip editor. No native pipeline,
project schema, dependency, driver, media backend or render-PC settings changes.
The 2.0.18 camera audio and 2.0.17 appended-clip workflow are retained.

## Behaviour

- Project, Filters, Music and Output are compact expandable groups above the
  sequence and clip editor. They are usable before any clips are added.
- Wind reduction has a live project default with per-clip inheritance or explicit
  overrides. Changing the default preserves overrides, including Off. New clips
  inherit. Reset-all asks before replacing overrides, including excluded clips.
- Music selection and mix are project-wide only. Optional composing tools are
  collapsed. Wind processing remains camera-only, before mixing background music.
- Stabilisation defaults are copied to new clips. Applying them to existing
  selected/included clips is explicit and confirmed; it resets picture approval
  and invalidates affected renders when the picture recipe changes.
- Audio-only edits preserve picture approval and verified video caches. A NEW
  final export applies the sound changes; existing exports and queued requests
  remain unchanged. Cached clip playback retains its original camera sound.
- Stale reset/apply confirmations are rejected after relevant state changes.
  Late soundtrack responses cannot replace a later manual selection or re-enable
  music after explicit Off. Queued soundtrack work itself is not cancelled.

## Validation and release gates

Pre-package checks passed: 65 frontend tests, TypeScript, production frontend
bundle and the main Studio, audio and appended-31-to-51 browser suites. Browser
tests mock native IPC boundaries, not the UI. Checks cover inheritance, explicit
Off, excluded clips, confirmation/cancellation, stale asynchronous responses,
picture/cache preservation, keyboard controls and empty-project settings.

The 1920x1080 fixture shows 12 complete clip rows. Overflow checks cover 360px
through 4K. Expanded Filters/clip Sound, project Music, desktop sequence and
empty narrow-screen layouts were visually inspected. See `studio-camera-audio.md`.

The release must pass fresh version-consistency/frontend checks, the locked
build, MSI identity and upgrade-code comparison against 2.0.18, extracted
application/media verification, extracted-tool smoke checks and runtime closure
before delivery. Hashes, build identity, Git remote verification and Slack
read-back are recorded separately in the local delivery receipt. NSIS may be
built and hashed, but only the extracted/verified MSI is shared.

Native/audio real-media tests from 2.0.18 are prior evidence, not claimed as fresh
tests for this UI-only revision. Actual installation/upgrade, real-footage
listening and a complete user-project export remain acceptance checks.

## Packaging and safe test workflow

The managed media bundle and corresponding source archive are unchanged:
SHA-256 `27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8`.
The prior Slack source attachment remains valid. This is an unsigned Windows
x64 test installer, without the optional offline face runtime. LMMS integration
is not part of the validation claim.

1. Let active renders finish, back up project.json and close PhotoGoGo normally.
   Keep the previous installer, outputs and caches. Install and confirm 2.0.19.
2. Check the top groups. Set project wind reduction to Light; verify inherited
   clips follow it and a clip explicitly Off stays Off. Use the local A/B preview
   to check natural event sounds before deciding on stronger processing.
3. Check project music and camera/music balance. Create an updated final video;
   confirm included count, final clip, chapters and sound. Matching picture
   renders should be reused. Allow space for a separate new final output.
4. Test reset-all only if you intend to remove every wind override. Cancel first
   to verify no change; acceptance intentionally includes excluded clips and Off.

Set every included clip's effective wind setting Off to disable cleanup;
project Off alone preserves explicit clip strengths. Keep the project backup
before any binary downgrade, and do not clear caches as a rollback step.
Downgrade behaviour is not established by package extraction. This release
does not claim to fix upward-pan rotational wobble or improve RTX throughput.
