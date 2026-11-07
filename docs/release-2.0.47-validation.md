# PhotoGoGo 2.0.47 — AKP03E transport and Lightbox controls

## Approved scope and evidence

Stuart reported that the controller did not start and supplied the screenshot in
[this Slack post](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794091650782079).
It shows **Reconnecting**, not the missing-model phase. The 2.0.46 source reaches
that phase only after opening a HID handle and failing a later I/O operation;
the old panel replaced the actual cause with a generic message. A narrow,
read-only PowerShell request for the existing controller log, matching USB IDs
(serial suffixes omitted) and controller process names was posted and read back
[in its thread](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794092069599039).
At implementation time that output had not arrived. The screenshot does not
prove which I/O operation failed or that the following transport defect caused
Stuart's particular failure.

Stuart explicitly approved the connection fix, saved control assignments, two
bounded helpers, validation/build and release to Personal/GoggoVille
**#swghermes**. Root owns native integration and release; one helper implements
frontend controls/tests, and the other performs read-only independent protocol,
input-safety and source-bundle review. No physical controller, vendor process or
user media is touched on this development machine.

## Corrected defects

The pinned Rust SDK discarded collection paths and opened the first matching
VID/PID/serial collection. Windows represents HID top-level collections
separately. The independent AKP03E transport explicitly uses **0300:3002, usage
page FFA0**, then opens its path. The replacement selects exactly one such
collection and refuses missing/ambiguous ones before takeover. It does not
guess another model or substitute a keyboard/mouse collection.
[AKP03E transport](https://github.com/tomekceszke/ajazz-akp03e/blob/main/src/ajazz_akp03e/_transport.py),
[constants](https://github.com/tomekceszke/ajazz-akp03e/blob/main/src/ajazz_akp03e/_constants.py),
[Microsoft HID collections](https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/top-level-collections).

The protocol's byte 10 distinguishes press/release, which the old application
path ignored. A held button released after acknowledgement could therefore
toggle Google selection/trash again. The new **AKP03E-only press reader** emits
no action on release but retains a consumed, nonempty report so draining does
not end prematurely. Twists keep their directions regardless of that marker.
Short/unknown reports fail without printing their contents. The upstream
readers and all other device models remain unchanged.
[AKP03E parser](https://github.com/tomekceszke/ajazz-akp03e/blob/main/src/ajazz_akp03e/_protocol.py).

Native errors now retain the operation and underlying cause in the panel/log,
including lazy initialisation/brightness, artwork/display, keep-alive and input
reads. Failure publication checks generation and updates state under one lock,
so an old failure cannot overwrite a new Retry/Release. Existing ownership,
client/session/revision, acknowledgement, timeout and narrow vendor-stop guards
are retained. Bounded descriptor logs omit serials and HID paths.

## Controls and persistence

The default Lightbox display-key layout is **Previous / Trash or Restore / Next**
above **Google Original / Google B&W / Google Enhanced**. Trash toggles without
advancing or physically deleting. Google buttons target the exact displayed
outputs, including active cropped variants, and do not upload. Unavailable
versions and current save/modal/source guards remain authoritative.

The panel provides separate allow-listed Turn/Press actions for each of three
physical dials. Identify pauses page commands, accepts a real dial turn rather
than a mirror click, and requires explicit Apply to assign browsing/fit to that
dial. Close, cancel, reconnect, context changes and timeout cancel identification.
Draft Cancel/save-failure and corrupt-file recovery preserve saved state until a
validated Apply succeeds. Mappings are stored atomically in the application's
`controller/bindings.json`, separate from automatic-mode/brightness preferences
and outside staging. Invalid saved mappings pause controls instead of silently
changing their meaning. Existing RAW/crop/video layouts remain available.

## Source and dependency closure

`ajazz-sdk` remains version **0.2.1**; its source origin becomes the directly
shipped `resources/controller-source/ajazz-sdk-photogogo` Cargo path. There are
**28 complete corresponding source files**. Only upstream `src/device.rs` and
`src/lib.rs` change, and only `PHOTOGOGO-CHANGES.md` is added. An independent
hash comparison against the pinned original archive confirms no removals or
other changes (`test-output/controller-source-diff.json`). Existing upstream
APIs/models, original archive checksums, authors and MPL-2.0 notices are kept.
No other dependency versions/lock edges change. FFmpeg, ExifTool and RAW engine
bundles remain unchanged.

The schema-2 source receipt records every compiled-source file's exact bytes
and hash. Build/package checks verify it without regenerating it; the explicit
maintainer update script requires subsequent review. `.gitattributes` preserves
the reviewed bytes on fresh Windows checkouts. Package inspection verifies the
full extracted tree, including hidden files, and its licence/source notices.

## Validation record

- The initial hidden-error regression failed with the generic reconnect
  message, then passed after retaining the actual operation/cause.
- The transport red run had **17 passed / three expected failures**: choosing
  the first keyboard collection, accepting a missing/ambiguous protocol
  collection, and executing four actions instead of two for two press/release
  cycles. The corrected focused run passed **21 tests**. It also covers all
  12 button/dial-press actions, six twist directions, consumed releases,
  short/unknown reports, nonzero press states, native persistence and old-error
  generation fencing.
- The first complete native run used parallel test execution and finished
  **375 passed / three failed / 29 ignored**. All three failures encountered
  the existing process-global RAW-publication guard in RAW/Google fixtures.
  The same harness, with the repository's prescribed `--test-threads=1`, passed
  **378 tests, zero failed, 29 opt-in tests ignored** in 47.31 seconds. No
  unrelated production/test semantics were changed to obtain that pass.
- The final formatted native source passed the complete serial suite again:
  **378 passed, zero failed, 29 ignored**, in 34.04 seconds.
- Final frontend validation passed **22 controller unit checks**, **eight panel
  browser groups** and **21 real Lightbox browser groups**, plus TypeScript and
  whitespace checks. The late settings-save/status-error race was reproduced
  first, then fixed by requiring a validated native session when re-enabling
  input (`test-output/controller-settings-status-race-red.log`). Current desktop,
  identification and 360-pixel screenshots were inspected. Tests use synthetic
  input/native replies and generated images, not physical USB hardware.
- Existing cross-page regressions passed on the final tree: RAW Development
  **13 groups**, Lightbox/cropping **13 groups**, and Video Snapshots **nine
  checks**. Their synthetic native interfaces do not establish device operation.
- Physical USB operation, actual image orientation and installed upgrade on
  Stuart's machine remain acceptance checks.

Evidence is under `test-output/akp03e-reconnect-*`, `akp03e-transport-*`,
`controller-unit/`, `controller-browser/` and `lightbox-controls-browser/`.
The first native build attempt had a Tauri command macro registration error;
it was corrected before the red test executed. A new cropped-checkbox browser
assertion used an incorrect accessible label and was corrected before rerunning.
These infrastructure/assertion errors are not represented as successful runs.

## Packaging and deployment boundary

Built-source, package and delivery receipts are added after validation.
Retained 2.0.45/2.0.46 installers support rollback; Release and close PhotoGoGo
before downgrading, then restart AJAZZ manually. The new bindings file is
separate and ignored by older versions. No staging/media schema changes or
automatic vendor restart are introduced. The actual remote connection cause
and recovery remain unverified until the returned log or physical retest.
