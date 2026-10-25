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

Rebuild from the committed source with the existing verified managed FFmpeg
runtime and matching source archive. Inspect EXE/MSI payloads without installing,
and confirm the MSI upgrade identity still matches 2.0.31. Record the final
build identifier, hashes, Git references and Slack delivery receipt below only
after those operations succeed.

Before installing, let jobs finish, save and close PhotoGoGo normally. Use one
installer, not both. Packages are unsigned. Keep the 2.0.31 installer and backups
of settings/projects for rollback. Do not try to move the encrypted Google store
to another Windows installation. No deployment-PC installation, render
interruption, cloud upload or media modification is part of this release task.

For usage, see [Google Photos setup and recovery](google-photos-transfer.md).
