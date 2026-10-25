# PhotoGoGo 2.0.32 personal test release

## Scope and acceptance

This release adds per-version Google Photos selection and favourites to Photo
Lightbox and the optional Transfer to Google Photos workflow. The current
Photo Process, non-destructive crops and NAS archive workflow remain available.
The separately paused subject-finishing worktree is not part of this release.

On 25 October 2026 the user authorized commit, merge, push and delivery to
GoggoVille **#swghermes**, before the live Google pilot. Google export is a
**personal test preview**, not an end-to-end accepted production integration.
No Google account has been connected and no real photographs have been uploaded
by development tests. Real ExifTool metadata execution and Google account
acceptance remain required as described in
[Google Photos validation](google-photos-validation.md).

## Setup on multiple PCs

The user has created **PhotoGoGo Personal** and confirmed Photos Library API is
enabled. One Desktop OAuth client can be reused on their PCs; creating it and
configuring consent remain outstanding. Version 2.0.32 still requires importing
that JSON locally and signing in on each PC. Automatic installer configuration
is a follow-on, not a feature of this package. Tokens and protected stores must
not be copied. Upload history, jobs and Continue mappings remain local to each
installation, so cross-PC duplicate prevention is not claimed.

## Validation

- Native release-mode suite: 242 passed, 0 failed, 21 existing opt-in tests not run.
- Google Photos utility checks: 4 passed; Lightbox utility checks: 15 passed.
- Browser regressions: 9 Google Photos, 13 Lightbox and 13 Photo Process groups.
- TypeScript and production frontend build passed.
- DPAPI, OAuth callback/PKCE, account/client isolation and recovery contracts use
  synthetic fixtures/fake Google responses, not a live Google session.

## Packaging and rollback

Built from feature commit `ce7411d97f975b4117f001c18c09f6f2bb966086`, integrated
into `master` by fast-forward, with the existing verified managed FFmpeg runtime
and matching source archive. Both installers were extracted and inspected
without installing. Each verified 29 payloads: the application, managed-media
manifest and 27 media files. MSI version is 2.0.32 and the upgrade identity still
matches 2.0.31: `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}`.

Build identifier: `20261025T064041238Z-ce7411d9+local`. Tauri rewrote the manifest
line endings before the frontend's Git check. The normalized `Cargo.toml` blob
was verified identical to the commit (`95184447f5a521b925c2e9e711e5e0544655c7c1`),
with no content diff. The actual build label is retained rather than rewritten.
Subsequent release-receipt edits affect documentation only.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `PhotoGoGoV2_2.0.32_x64-setup.exe` | 24,998,276 | `1C760A876681780A653920A61D318E696828F85AD3E5AE197980F12C13E16DC3` |
| `PhotoGoGoV2_2.0.32_x64_en-US.msi` | 33,341,440 | `9EDA8BB9BA6FBFAB8DE867BF92F3626060AD349C9DEDC42215E2786548A57E34` |
| Standalone application | See inspection receipt | `7051C095499D67996BACE107C28508FE69EB0EE7025F4FF4BA6228CB2CC5ED76` |
| `PhotoGoGo-FFmpeg-rowtest1-source.tar.gz` | 49,570,807 | `27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8` |

Inspection receipt:
`test-output/release-2.0.32-inspection-20261025T064422941Z/report.json`.
Only the unique three-byte Tauri bundle-type marker is normalized when comparing
packaged application bytes; every other byte must match. The managed media and
corresponding-source archive are unchanged. The original 2.0.31 installers remain.

Build and inspection commands:

```powershell
pwsh -NoProfile -File scripts/build-release.ps1 -SkipFaceBundle -SkipDependencyInstall -MediaSourceArchive test-output/media-delivery/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz
pwsh -NoProfile -File scripts/verify-photo-release.ps1 -Version 2.0.32 -PreviousVersion 2.0.31
```

The build reran TypeScript and the production frontend build successfully. The
4 Google Photos and 15 Lightbox utility checks were also rerun successfully;
the native and browser results above cover the same application source.

Before installing, let jobs finish, save and close PhotoGoGo normally. Use one
installer, not both. Packages are unsigned. Keep the 2.0.31 installer and backups
of settings/projects for rollback. Do not try to move the encrypted Google store
to another Windows installation. No deployment-PC installation, render
interruption, cloud upload or media modification is part of this release task.

For usage, see [Google Photos setup and recovery](google-photos-transfer.md).
