# Lightbox cropping - unreleased validation checkpoint

Approved design: retain the untouched original; create a `_crop.jpg` working version and independently regenerate its optional `_crop_BW.jpg` / `_crop_improved.jpg` versions. Original navigation remains one stop per source with an Original/Cropped display switch.

## Verified locally

- Native library: **184 passed, 0 failed, 21 ignored** (205 total). Eleven crop-specific checks cover source preservation, source-based re-crop, all eight EXIF orientations, malformed/out-of-bounds rectangles, stale source, scope/type/name ambiguity, foreign/edited output protection, interrupted rollback, missing backup refusal, recipe parity, batch receipt update, tag renames, focus policy, exclusive lease and pre-transaction output size refusal.
- Lightbox focused checks: **14 passed**.
- Lightbox browser: **10 regression groups passed**, including actual pointer dragging, fixed portrait ratios and repeated orientation flips, keyboard isolation, busy Enter deduplication, current recipe capture, stale-source reload, same-snapshot pixels, StrictMode in-flight inspection coalescing, Original/Cropped switching and 390px layout.
- Existing Photo Process browser suite: **13 groups passed** in the final isolated run. One earlier concurrent-load run timed out on the enhancement-Off wait; this did not reproduce in the final isolated run or the UI helper's serial run. No application change was made to mask that timeout.
- TypeScript and production frontend build passed. The production build retains the current development version 2.0.30; it is not a newly released installer.
- An independent read-only reviewer checked native publication, recovery, paths, ownership, admission, frontend lifecycle and screenshots. No remaining blocking findings reported.

Repeat commands:

```powershell
pwsh -NoProfile -File scripts/test-photo-process.ps1
node scripts/test-lightbox.mjs
node scripts/test-lightbox-browser.mjs
node scripts/test-photo-process-browser.mjs
node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
```

Browser runners can reuse the existing offline runtime via `PHOTOGOGO_PLAYWRIGHT_PATH`; no dependency change is required. Tests use synthetic media and native adapters. They do not establish real-camera colour accuracy, measured speed or installer/upgrade behavior on another PC. No user media, render-PC settings or active renders were changed.

## Safety findings fixed during implementation

- A red-capable publication test reproduced a recovery branch inversion: successful writes disappeared. Corrected the branch, then verified successful publication and interrupted rollback separately.
- Crop inspection now returns preview pixels, oriented dimensions and source fingerprint from one byte snapshot; it never combines a fresh fingerprint with an old Lightbox cache entry.
- In-flight inspection coalescing avoids duplicate StrictMode requests competing for the native lease, without caching completed inspections.
- Encoded outputs are bounded before transaction creation. Backups are rechecked after moving and before committed cleanup; unrecognised recovery data is retained rather than deleted.
- Admission guards cover queued and legacy photo work/import entrypoints. Managed crop names are excluded from focus renaming, but remain eligible for B&W/Enhanced processing.

## Handoff

See [the cropping guide](LIGHTBOX_CROPPING.md) for the UX and limitations. Original metadata is retained byte-for-byte in the untouched original; newly encoded crop outputs currently carry filesystem times rather than the complete EXIF/ICC metadata set. Fingerprints are local accidental-edit detection, not authentication.

This checkpoint does **not** constitute a new Windows installer, merge/push, tag or Slack release. Package/version and publication work are a separate next step.
