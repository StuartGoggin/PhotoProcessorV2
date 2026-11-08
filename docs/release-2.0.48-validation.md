# PhotoGoGo 2.0.48 — readable, upright AKP03E keys

## Scope and implementation

Stuart reported that key images were rotated 90 degrees counter-clockwise
(written "count clockwise"), faint and difficult to see. He requested a 100%
default brightness and stronger artwork contrast. The interpretation and
clockwise correction were stated before implementation. This is a bounded
continuation of the approved controller test/release workflow; no new helper
workflow, dependencies, native SDK patch, firmware or vendor-profile change is
introduced.

The SDK still specifies zero rotation for AKP03E key images. PhotoGoGo now
rotates only the device-output image **90 degrees clockwise** before the
existing encoder/write path. Frontend JPEG/SVG previews stay upright; key
positions and photo/video pixels are untouched. Cached source images are not
mutated or progressively re-rotated.

Native and initial UI brightness default to **100%**. A missing brightness-profile
marker plus the previous 70% default upgrades to 100% in memory. Different
saved values are preserved; new explicit choices carry the profile marker,
including an intentional 70%, so they are not remigrated. Reading preferences
does not rewrite them, change the released/enabled flag or touch staging.
The existing atomic save path records the marker on a deliberate settings save.

Both artwork renderers use black backgrounds, bright white idle icons/labels,
heavier 2.6-unit glyph strokes, bold text, stronger borders and vivid state
accents. Disabled states remain identifiable. Frontend JPEG quality rises from
0.90 to 0.98 at the same bounded 60 × 60 size. There is no change to input
handling, Google selection, trash/navigation, dial assignments or takeover.

## Validation

Before the correction, the native controller run passed 21 existing checks and
failed the three new regressions: encoded clockwise quadrant placement, fresh
full-brightness preferences, and migration of the old 70% default. The browser
pixel regression failed against the old JPEG with **zero bright white icon
pixels** and a background maximum-channel mean of **41.95 / 255**.

After correction, all **24 focused native tests passed**. The orientation test
uses hand-derived asymmetric quadrant positions through the actual AKP03E JPEG
encoder, allowing normal JPEG error; the original upright input stays intact.
Preference tests cover released state, no read-time writes, another custom
brightness and an explicitly retained 70%. All **nine panel browser groups**
passed, including real JPEG/SVG pixel checks and existing focus, save, identify,
release and narrow-screen cases. The finished artwork was visually inspected.
The complete serial native suite passed **381 tests, zero failed**, with 29
opt-in tests ignored, in 39.78 seconds. Controller runtime/router units passed
**22 checks**, the actual Lightbox suite passed **21 browser groups**, and
TypeScript/whitespace checks passed. Package receipts follow below.

Evidence: `test-output/akp03e-display-red-*`, `akp03e-display-green-*`,
`controller-browser/`, `controller-unit/` and `lightbox-controls-browser/`.
Physical image orientation and perceived readability remain a retest on Stuart's
unit; development has no attached AKP03E. The new user feedback establishes that
images reached the physical keys, not that every control or state was accepted.

## Packaging boundary

The modified SDK source remains the same 28-file closure, with original pinned
archives and notices. Only the app's controller-output boundary, preferences,
artwork and their checks change. Prior installers remain available; Release and
close PhotoGoGo before rollback, and restart AJAZZ manually. No user-media or
staging schema changes occur. Built-source, package and delivery receipts follow
after validation.
