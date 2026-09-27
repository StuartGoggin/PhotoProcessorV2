# Prevent added rotation

Use this option for footage shot on a roll-locked tripod when Quality stabilisation
introduces unwanted rocking. It prevents the stabiliser from adding rotation;
it does not level an already tilted source or remove rotation recorded in-camera.
It retains the existing horizontal/vertical smoothing and framing settings. It
does not engage virtual-tripod mode or freeze deliberate pan/tilt motion.

## Where to configure it

1. Open **Video Studio → Project settings → Filters**.
2. Enable **Prevent added rotation · project default**.
3. Select a clip and open **Picture**. Use **Quality — two passes** and an enabled
   stabilisation preset. **Prevent added rotation · this clip** offers:
   - **Use project default**: follows subsequent project changes.
   - **On**: always prevent added rotation for this Quality clip.
   - **Off**: allow the existing rotation correction for this Quality clip.
4. Preview the affected section, approve the clip, then render/export again.

The project rotation default applies immediately to following Quality clips,
including existing/excluded clips. This differs from the existing stabiliser and
preset defaults, which apply only to new clips unless explicitly applied to
existing ones. Individual On/Off overrides are retained when the project default
changes. **Apply stabilisation defaults** resets targeted rotation overrides back
to inheritance, along with their other stabilisation choices and review approval.

Fast mode and stabilisation Off do not use the rotation control. The clip control
is disabled while either is selected, but its stored choice is retained for a
later switch back to Quality. New and older projects default to Off, preserving
existing behaviour until explicitly changed.

## What needs rendering again?

Only clips whose effective picture settings change need a new stabilised picture
from their originals. An old output with rocking already baked in cannot be
corrected by changing the scorecards or final assembly alone.

- Changed clips lose review approval and are marked for re-rendering.
- Unaffected clips retain their approval and verified cache entries.
- Choosing an explicit override equal to the inherited value does not invalidate
  an existing render.
- Old output files remain intact and playable. Saved/queued jobs retain their
  original settings; create a new request to use this change.
- Finishing-only export stops if the required picture is not available, rather
  than silently doing stabilisation work.

This is a constraint on the motion model, not subject/background recognition.
If a horse fills the frame and the background is blurred, translation estimates
can still follow the horse. Real-footage acceptance should therefore compare a
close approach and a deliberate tracking pan, not just a stationary shot.

## Implementation and validation

Quality's existing `vidstabtransform` receives `maxangle=0` when effective.
`relative=1`, preset smoothing, framing/zoom and the Fast filter remain unchanged.
The boolean is persisted as `defaultPreventRotation` at project level and nullable
`preventRotation` at clip level. Native clip/base content keys include a versioned
marker only when effective, preserving all legacy keys otherwise. Render/job
metadata records the effective policy; frontend readiness and native assembly
verification reject mismatching cached pictures. Export recipe v4 appends the
effective included-clip policies while retaining v1-v3 when no clip uses it.

Validation performed for this change:

- Frontend regressions cover migration, save round-trip, inheritance, explicit
  overrides, excluded clips, dormant settings, cache readiness and saved jobs.
- Native tests cover strict boolean deserialization, the exact filter change,
  legacy cache identity and the shared export recipe.
- A bounded bundled-FFmpeg test compares every decoded pixel across 25 frames at
  320×180. Known angle-only motion exactly matches a zero-angle reference when
  enabled; known X/Y-plus-angle motion exactly matches its X/Y-only reference.
  With the option disabled, the angle fixture changes the output (negative control).
- A second bounded native test renders a 0.8-second synthetic clip through the
  real Quality pipeline, then verifies changed-policy re-rendering, explicit-Off
  reuse, rejection of stale assembly, and preservation of earlier output checksums.
- The headless browser regression exercises controls, keyboard access, preview
  request data and compact layout. Screenshots are under
  `test-output/studio-rotation/`.

Re-run the focused frontend/browser tests with `npm run test:studio:rotation` and
`npm run test:studio:rotation:browser` (the latter needs Playwright and Edge, or
the existing `PHOTOGOGO_PLAYWRIGHT_PATH` runtime override). Standard native tests
run via `pwsh -NoProfile -File scripts/test-video-studio.ps1`.

The two media tests are ignored by default. From a Visual Studio-enabled shell,
set `PHOTOGOGO_FFMPEG` to the bundled `src-tauri/tools/ffmpeg/bin/ffmpeg.exe`, then
run each in a separate process using `cargo test --locked --release --lib
--manifest-path src-tauri/Cargo.toml <test-name> -- --ignored --nocapture
--test-threads=1`, with `no_added_rotation_pixels_smoke` and
`rotation_policy_render_cache_smoke`. Run media tests only when no user render is
active. Synthetic fixtures/results are retained in distinct temporary directories.

These checks prove the no-added-rotation control and cache behavior. They do not
establish the root cause or visual resolution of the reported horse-footage wobble.
