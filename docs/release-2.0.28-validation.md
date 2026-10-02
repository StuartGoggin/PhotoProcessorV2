# PhotoGoGo 2.0.28 — Video Snapshots sessions

## Change and safety boundaries

Named sessions, a searchable recent-session library, Continue last, New, rename, duplicate, portable import/export and recoverable deletion. Autosave serializes updates with revision checks; normal close and session switching wait for a successful save. Source videos and exported photos are never deleted with a session. Missing or changed originals retain saved selections rather than silently discarding them during autosave.

Persistence is isolated in `video_snapshots/sessions.rs`: per-account application-data library, opaque IDs, exclusive lock, bounded validation, atomic replacement, read-back and last-good recovery. A recovered record is read-only until copied to a new session. No additional dependencies, encoder/stabilizer changes or user-media migration.

## Validation

- Native library: **157 passed, 0 failed, 20 intentionally ignored**. Eight new session-storage tests cover restart, stale writes, deletion/restore, failed publication, corruption/backup recovery, Unicode limits, revision exhaustion, and junction rejection. Source and portable-file sentinels remain unchanged.
- Snapshot helpers: **13 passed**. Session merge/writer helpers: **7 passed**.
- Session browser workflow: **16 grouped checks**, including save failure blocking New, recovered source choices, delayed source indexing, delayed saves/copy, cross-window rename conflicts, 200 preserved photo selections, 64 pending videos and native close-event JavaScript handling. Browser tests use a synthetic native adapter; they do not claim end-to-end OS-window or filesystem durability validation.
- Existing browser regressions: **9 viewer, 7 export, 9 read-ahead checks**. Responsive layouts checked at desktop, compact and narrow widths.
- Three additional real native media smoke tests passed: exact-frame output/timing, cancellation, and synthetic 3840×2160/50fps navigation with a full-resolution 3840×2160 JPEG export. Original media is preserved. These are not a responsiveness claim for the user's Canon footage.
- Production TypeScript/Vite build checked. Existing Browserslist age and bundle-size warnings are unrelated to this feature.

Reproducible commands are in `package.json` (`test:snapshots`, `test:snapshots:sessions`, and the four snapshot browser suites). Native tests use the existing locked Windows release toolchain. Local detailed evidence lives in `test-output/release-2.0.28` and the browser report folders. Installer extraction, hashes, packaged-media verification and Slack read-back are release-stage checks recorded separately in the delivery receipt, not implied by these source-level tests.

## Acceptance and rollback

Let renders finish, save/back up existing projects and portable sessions, then close PhotoGoGo normally before installing. Windows packages remain unsigned test installers. Installation/upgrade and real-camera acceptance are not automated here; the release process does not install on the render PC or interrupt work.

Create a session, select and adjust a frame, choose an export folder, then wait for **Saved automatically**. Start a New session and confirm it is empty. Open the first session and check choices and adjustments. Restart the app, Continue last, then delete and restore a test session. Export a full-resolution photo and reveal its actual output file.

Keep the previous 2.0.27 installer and pre-upgrade session copies for rollback. The new managed library is separate from original media and portable files. Older application versions do not have this library UI; export a session copy for portability, and retain the pre-upgrade copy rather than assuming every new draft field will be understood by an older version.
