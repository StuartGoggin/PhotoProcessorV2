# 2.0.20 Studio finishing test release

## Scope and cache boundary

Adds clip-anchored scorecards, editable clip/chapter names and ordering, shared
project graphics settings, opt-in styled titles and native one-frame previews.
No dependency, media backend, driver or stabilisation algorithm changes.

Scorecards are composited only during final assembly, after verified reusable
picture renders. Score details/timing do not change picture revision, approval
or clip cache identity. All-ready exports explicitly use the native
`assembly`/`assembleOnly=true` mode: missing or changed caches stop the request
before fallback rendering. Pending picture edits use normal preparation.

Simple line, result and table layouts share installed Windows fonts, palettes,
accent, opacity and position. Timing can be inherited or overridden per clip.
Standalone cards add exact frame-based duration, silent camera audio and an
optional continuing project music track. Final chapters/audio intervals follow
the measured output, including replays and cards. Earlier exports stay intact.

Old projects preserve their title appearance. Styled clip titles conditionally
extend title-fragment identity; the unchanged stabilised base can be reused.
Active jobs carry the target title-style identity, including individual clip
jobs without an export sequence. Project score settings never silently alter
clip picture approval. See [the user guide](STUDIO_FINISHING.md).

## Validation evidence

Fresh pre-package checks: 71 frontend tests, TypeScript/production frontend
build and 114 native tests passed (12 opt-in media tests excluded from the normal
suite). Studio, graphics, audio, appended-31-to-51 and jobs browser workflows
were exercised. Browser IPC is mocked; native acceptance is separate. The jobs
browser initially timed out loading the fixture during parallel compilation;
an isolated rerun passed without code or timeout changes.

The bounded real-media acceptance gate covers native previews in all three
fonts, dense five-column/eight-row tables, sub-frame-length titles, literal text
and invalid-style rejection. Export checks cover card boundary pixels, replays,
165-frame/5-chapter delivery, changed score pixels with unchanged cached clip
paths/checksums, missing-cache refusal, silent standalone camera audio, music
continuity, legacy/styled opening titles and camera-only audio filtering.
Named logs and receipts live under `test-output/ffmpeg-row-backport/release20-*`.

Independent review caught and prompted regression tests for the native/UI
assembly-mode pair, individual clip-job style identity and short-title preview
time. Native visual inspection also caught a subpixel divider interpreted as a
full-frame drawbox; rectangle dimensions now have a one-pixel minimum and a
bottom-safe-area pixel assertion. Maximum-width table cells wrap and dense
panels scale inside the safe area. UI screenshots cover 360px, 1360px and 1920px;
the main 1920px fixture retains 12 complete clip rows.

The locked installer build, MSI product/version/upgrade identity, application
payload comparison, all 28 bundled backend files, extracted-tool media smoke
checks and runtime closure must pass before publication. Exact hashes, build
identity, remote-ref verification and Slack attachment/message read-back are
recorded in the local release delivery receipt. NSIS is built/hashed, but only
the extracted and inspected MSI is shared.

## Acceptance and rollback boundaries

Unsigned Windows x64 test installer; optional offline face runtime omitted.
LMMS integration, installation/upgrade/downgrade and the complete real-footage
user project remain user acceptance tests. No render-PC installation, render
interruption or settings changes are performed. This does not claim to fix the
upward-pan rotational wobble or improve RTX throughput.

Preview uses the actual graphics compositor. Cached score backgrounds require
source/signature/checksum verification; fallback source previews are explicitly
labelled illustrations, not stabilised output. Clip-title previews use source
footage to avoid duplicating an already-baked title. The 30-second timeout covers
the rendering subprocess, not preceding probes/checksums of large files.
Available glyphs depend on installed fonts; dense tables need visual acceptance
at the intended delivery size. Overlapping opening/clip titles and scorecards
produce a warning rather than silently changing timing.

Let renders finish, back up the project, close the app normally, then install.
Keep the prior installer, project backup, outputs and caches. Disabling cards
and exporting again removes them from the new output; never clear caches as a
rollback step. Restore the pre-upgrade project backup before testing an older
binary because older versions cannot preserve new graphics fields.

The media backend/source archive is unchanged. Corresponding-source SHA-256:
`27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8`.
