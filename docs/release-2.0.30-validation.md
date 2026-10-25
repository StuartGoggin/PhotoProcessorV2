# PhotoGoGo 2.0.30 - Photo Process previews and original-only Lightbox

## Changes

- Post Process becomes Photo Process; Review becomes Photo Lightbox. Internal route IDs remain unchanged.
- Originals-only tree/navigation; matched B&W/Enhanced panels; bounded read-ahead and stale-result protection.
- EXIF-normalised JPEG processing; independent B&W; adjustable local contrast, sharpening and smooth S-curve.
- Shared preview/batch recipe and quality-95 JPEG encoder; atomic generated-output publication.
- Scoped sample selection, debounced still previews, actual-pixel full-resolution checks, read-only focus previews, explicit short video samples and cleanup dry runs.

Usage, limits and regeneration guidance: [Photo Process and Lightbox](PHOTO_PROCESS_AND_LIGHTBOX.md).

## Validation

- Native library: **173 passed, 0 failed, 21 ignored**. The bounded synthetic video-preview smoke was then explicitly run and passed separately. Other opt-in media/GUI tests were not rerun as part of this release.
- Lightbox: **10 focused checks** and **7 browser groups** passed, including rating an original and regenerating comparison versions while older versions still exist.
- Photo Process: **13 browser groups** passed, including 360px layout, exact queue/preview recipe, deferred slider/scope changes, retry and actual 100% geometry/scrolling.
- Existing Studio browser regression passed at 360px-4K; **17 Studio model**, **13 snapshot** and **7 snapshot-session** checks passed.
- TypeScript passed. Native gates include all eight orientations with asymmetric pixel fixtures, generated orientation tags, B&W independence, Off identity, monotone S-curve extremes, actual saved-JPEG/preview byte parity, read-only cleanup/source checks, canonical scope validation and failed publication preserving old output.

Repeat commands:

```powershell
node scripts/test-lightbox.mjs
node scripts/test-lightbox-browser.mjs
node scripts/test-photo-process-browser.mjs
node scripts/test-studio-browser.mjs
node scripts/test-studio.mjs
node scripts/test-video-snapshots.mjs
node scripts/test-snapshot-sessions.mjs
pwsh -NoProfile -File scripts/test-photo-process.ps1 -VideoSmoke
```

Browser runners accept `PHOTOGOGO_PLAYWRIGHT_PATH` for an existing offline runtime. No dependency versions were added or changed. Browser fixtures exercise real React pages against synthetic native adapters, not the full Tauri runtime. Native tests use synthetic media, not the user's footage. They do not establish real-photo throughput or RAW decoding.

The release receipt separately records Git refs, package hashes, extracted payload/upgrade identity checks and Slack read-back. Source test passes alone do not prove packaging/publication.

## Acceptance and rollback

Let active work finish, save projects/sessions and close PhotoGoGo normally before installing. This workflow does not install on the render PC, stop renders or modify user media. Windows packages remain unsigned; optional face runtime dependencies are not newly installed/updated.

1. Check the navigation names and originals-only Lightbox on a small mixed folder.
2. Inspect a portrait original with B&W/Enhanced comparisons. Explicitly regenerate previously sideways versions, then refresh.
3. Tune B&W on one JPEG scope, inspect 100%, queue that recipe and compare the result. Enhanced must not be required.
4. Confirm Focus/cleanup previews do not change files. Queue cleanup only after reviewing targets.
5. Optionally preview a short stabilization sample while no import/render work is active.

Keep the 2.0.29 installer and settings/projects for rollback. Existing processed files remain unchanged until regeneration; an app rollback does not undo regeneration. Quality-95 files may be larger. This release does not add RAW decoding or the separately paused subject-finishing feature.
