# PhotoGoGo 2.0.48 — readable AKP03E keys and Lightbox corrections

## Scope and implementation

Stuart reported that key images were rotated 90 degrees counter-clockwise
(written "count clockwise"), faint and difficult to see. He requested a 100%
default brightness and stronger artwork contrast. The interpretation and
clockwise correction were stated before implementation. This is a bounded
continuation of the approved controller test/release workflow. Stuart then added
the Trash/upload-selection error and disabled Crop in paired RAW Camera JPEG
view before publication. The two already approved bounded helpers resumed for
that diagnosis and safety review. No dependencies, native SDK patch, firmware or
vendor-profile change is introduced.

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
0.90 to 0.98 at the same bounded 60 × 60 size. Input transport, dial assignments
and takeover are unchanged.

## Added Lightbox fixes before publication

Trash/rating renames can publish a fresh tree revision before the replacement
selected photo is published. The folder-scoped curation hook could consequently
scan the retired filename and leave upload controls unavailable. Its refresh now
reconciles the current selected path when absent from the confirmed map, fences
stale reads, and recovers a late old-path read failure after navigation. Ordinary
same-folder browsing still reuses the map. Pending-write barriers and retained
failed-write receipts remain authoritative; recovery never silently clears them.
Trash remains a reversible filename tag, without deletion or automatic advance.
The existing X shortcut marks trash, saves and advances.

Crop eligibility now follows the explicitly displayed original source rather
than the RAW capture's navigation filename. Camera JPEG can open Crop and save
its own _crop/B&W/Enhanced family under the same capture. RAW preview cannot.
The existing native JPEG crop transaction, bounds, orientation, same-byte source
fingerprint and original-preservation checks are retained. No RAW decoding,
embedded-preview crop or implicit source substitution is added.

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

For the added crop case, the new browser regression first failed because Crop
was disabled for the explicitly selected full Camera JPEG. After correction,
all nine RAW Lightbox browser groups passed. The paired fixture uses a rated RAW
capture, a differently named full Camera JPEG and a separate developed RAW
output. It verifies RAW preview ineligibility, enabled controller Inspect/Crop,
exact JPEG inspect/apply paths and fingerprint, grouped crop comparisons after
refresh, and preserved RAW navigation/rating/development identity.

All 12 native crop tests passed, including a new synthetic RAW/JPEG-pair case
that checks retained source bytes, source-fingerprint rejection, full JPEG crop
dimensions and independent B&W/Enhanced generation from the cropped JPEG. The
complete serial native run then passed **382 tests, zero failed, 29 opt-in
tests ignored** in 88.15 seconds. Controller units again passed 22 checks and
the panel passed nine groups. Final browser runs passed the actual Lightbox
controls (21 groups), general Lightbox/crop (13 groups), and RAW source workflow
(nine groups); TypeScript and whitespace checks passed.

The native-rule curation fixture first reproduced the real retired-path error
after a successful Trash rename. Eight targeted real-UI groups now pass:
Trash and rating reconciliation, same-folder cache reuse, retained failed-write
receipts and exact retry, pending-save fences, read-failure recovery, held stale
completion, late A-to-B failure and bounded persistent same-photo failure. The
late-error test was corrected to use a single Reload read (a tree Refresh
already schedules another read); it failed before the dependency correction.
The retry-bound regression then failed at three automatic reads before the
same-path guard. Final independent source review found no remaining issue in
those changes. Existing selection/transfer barriers passed 11 browser groups
with zero browser errors; queue (four), command (seven) and Lightbox unit
(20) checks passed. Reports are retained locally; no Google API or user-media
operations occurred.

## Packaging boundary

The modified SDK source remains the same 28-file closure, with original pinned
archives and notices. The app's controller output, preferences, artwork,
Lightbox eligibility and curation read reconciliation change. Prior installers
remain available; Release and
close PhotoGoGo before rollback, and restart AJAZZ manually. No user-media or
staging schema changes occur. Built-source, package and delivery receipts follow
after validation.

## Intermediate build (superseded before publication)

Display-only checkpoint source: `80dbc408043e95c74df6269dd01ce21cb5d8b767`, based on
`origin/master` at `dc967642340a6c786bd6f97ada76bcb9d2079649`. All application
changes/tests/version were committed before building. Four unrelated cleanup
scripts/JSON summaries remain untracked, untouched and excluded from the release.
No tracked application source changed during packaging.

That intermediate frontend identifies `2.0.48 / 20261108T024815254Z-80dbc408+local`.
The literal `+local` is retained because of those unrelated untracked files and
Vite's temporary configuration module. This is the committed application source
above, not a wholly clean-checkout claim. It was held and never published after
Stuart added the two Lightbox bugs. The combined final build and receipts follow.

## Combined built source

The final combined application is built from
`2ddd0c82386139d17a1484da8b89ad43d78c867d`, including the display correction
commit `80dbc408043e95c74df6269dd01ce21cb5d8b767` and both Lightbox fixes.
The production frontend identifies
`2.0.48 / 20261108T031540275Z-2ddd0c82+local`.
All application changes, checks, version and guide updates were committed before
this build. The four unrelated untracked cleanup scripts/JSON summaries remain
excluded and untouched. Subsequent package/delivery documentation does not alter
the compiled application source. The `+local` suffix accurately records those
untracked files and the Vite temporary configuration module.

## Finished combined packages

The final optimized native build completed in **4m 25s**, with five existing
native unused-code warnings and the existing frontend Browserslist/chunk-size
notices. Both installer formats completed successfully.

`test-output/release-2.0.48-inspection-20261108T032430586Z/report.json` reports
`complete: true`. Both packages were extracted without installation. Their app
payloads match the built executable after normalizing only Tauri's expected
three-byte bundle marker. All pinned media/source payloads, the 2,205-file
ExifTool 13.59 closure, 440-resource RawTherapee 5.13 closure and all 28 modified
controller SDK source files/notices passed inspection. Both relocated packages
ran the supplied CR3 conversion with the accepted Auto-finish-65 profile and
PATH empty; the source hashes stayed unchanged. This validates packaging and
runtime relocation, not physical controller acceptance.

MSI ProductVersion is 2.0.48. UpgradeCode remains
`{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` from 2.0.47. These are unsigned test
installers; prior released packages remain available for rollback.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.48_x64-setup.exe | 130,881,999 | 6A2352E640B814CBCAAA394D543D0C78DA5831E70D0257B576A404462C4D78E4 |
| PhotoGoGoV2_2.0.48_x64_en-US.msi | 222,163,668 | 83A07E9AC5AF50619DF32249CDF312EDB174D7C18255DC95074A735B4830DD10 |
| photogogo-v2.exe | 30,182,912 | 5B72F50CB09D04E1BB39A7A55D7B05AF5EAA6541059BDD021C572C3AAA0BB3F2 |

## Publication and verified delivery

Package receipt commit `9de8c9330556ccc76a5c71d5d80a9272c0d66d13` was
atomically published to GitHub `master` and `SWG/akp03e-display`, with annotated
tag `v2.0.48` pointing to it. Remote read-back verified both heads and the peeled
tag. The compiled application remains source `2ddd0c82`; later delivery
documentation does not alter it. Other local worktrees remain untouched.

Published through Personal to GoggoVille **#swghermes** on **8 November 2026**:

- EXE parent `1794108700.761529`, file `F0CFT5E70JJ`. HTTP 200 acknowledged
  exactly **130,881,999 bytes**, in **191.6 seconds**, using the direct route.
  [Release post and EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794108700761529).
- MSI reply `1794108724.659829`, file `F0CFPR725EH`. HTTP 200 acknowledged
  exactly **222,163,668 bytes**, in **224.5 seconds**, using the direct route.
  [MSI alternative](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794108724659829).

Local bytes and SHA-256 were rechecked immediately before upload. Complete
thread read-back verified both file IDs, filenames, hashes, byte counts,
combined fixes, paired Camera JPEG instructions, Trash/X distinction, manual
AJAZZ restart and physical retest boundary. No thread pages remain. A literal
case-sensitive instruction check initially rejected "Both originals" against
"both originals"; case-insensitive read-back then passed without resending or
duplicating either upload. Local receipt is
`test-output/release-2.0.48-delivery.json`; no signed upload URLs or credentials
are stored in that receipt or this note. These checks establish local hashes,
exact upload acknowledgements and accessible Slack metadata, without claiming
an independent download/hash of the Slack-hosted files.

The physical unit still requires orientation, readability and control retests.
Trash remains a reversible tag that keeps the photo visible; X saves the tag
and advances. Camera JPEG crops retain both originals. No render-PC installation,
controller/vendor process access or user-media changes were performed here.
