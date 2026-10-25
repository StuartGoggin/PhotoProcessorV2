# ExifTool bundling checkpoint

PhotoGoGo 2.0.34 fixes the missing metadata-tool dependency reported in
GoggoVille #swghermes. Implementation and application runtime acceptance have
passed. Installer build, extracted-package verification and delivery receipts
are recorded separately in the release validation note once completed.

## Accepted implementation

An empty ExifTool override selects the installed private runtime before an
existing PATH tool. Explicit overrides take precedence and fail visibly when
invalid. PATH lookup excludes relative/empty entries and Windows' implicit
current-directory search. Settings checks the current unsaved override;
Google Photos checks the saved configuration early without blocking untouched
original uploads that need no metadata edits.

The installer owns stock Perl 5.44.0 built with MSVC x64 and pure ExifTool 13.59
source. Complete pinned sources, the build recipe, licences and compiler/CRT
provenance are included. No old Strawberry/GCC/GMP binaries ship. The loader
uses a fixed private working directory and restricts module lookup to local
lib before loading the unchanged ExifTool script. It disables user ExifTool
config, inherited Perl startup/module overrides and unsupported locale input.

The adapter streams UTF-8 arguments, rejects line breaks/nulls, drains bounded
stdout concurrently, and supervises the process with a 20-second deadline and
Windows job. Originals remain unchanged during upload-copy preparation.
Existing metadata-tag commands share this adapter. They preserve file mtime
through Rust's native wide-path file API, avoiding an optional Perl time module.
Restoration errors identify the partial outcome instead of claiming no write.

## Validation

- Native regressions after integrating current main's Name Events changes:
  262 passed, zero failed, 23 opt-in tests ignored.
- Both separately run real-runtime tests passed on the final source-built
  candidate. The upload-copy test covers Enhanced/B&W, GPS retain/remove,
  portrait dimensions/orientation, capture date/offset/subseconds, compatible
  RGB ICC retention, grayscale ICC exclusion, unchanged JPEG coding bytes and
  unchanged source hashes. The tag test verifies Unicode text, unchanged image
  pixels and historical modification-time preservation.
- Final full acceptance receipt:
  test-output/exiftool-runtime-20261025T212330177Z/report.json.
- Acceptance relocated the runtime into a path with spaces, accents and CJK
  characters, removed PATH dependencies, and supplied hostile Perl environment
  variables and user config. Missing/tampered payload files were rejected.
- Google Photos browser regressions: 16 groups passed. Google Jobs browser
  regressions: seven groups passed. TypeScript/frontend production build passed.
  Integrated Name Events naming-rule and browser checks also passed.
- Independent review checked all 2,204 lock entries, all 246 ExifTool libraries
  and upstream script against source, complete source archives/recipe/notices,
  and all 52 native binaries against the accepted Perl build.
- Final release metadata gate: 2,205 exact files verified and version probe
  passed. Redistribution gate is cleared for this exact source-built payload.

The first complete application acceptance found a filesystem-mtime failure;
the native timestamp repair passed the second attempt. There were no further
runtime repair attempts. Version probes and static review are separate from
these application tests.

No live Google account, album or upload was accessed. Live Google acceptance
remains a separate personal pilot after installation. Existing OAuth state,
protected recovery receipts and upload-quality/privacy checks remain intact.

## Source provenance and build

Perl 5.44.0 source SHA-256:
3b855066b92491cb40e86affb1ca57d1a388aa43e51b91c7806a32c2f65f96c3.
ExifTool 13.59 source archive SHA-256:
87d3317882fdae9cb4dcfe57a96a378d0132ffc02c731315bf128b19ddcf7aac;
tag commit 2200871d9cef988051d2a99d67df3bda6cbb30a8.
See the runtime review and scripts/exiftool-bundle.lock.json for primary sources.

Private interpreter build receipt:
test-output/metadata-perl-build/runtime-build-receipt.json.
Accepted normalized stage:
test-output/metadata-perl-build/stages/runtime-20261026T080608525.
Both app-local Microsoft release CRT DLLs match installed redistributables and
have valid Microsoft signatures. Their original licence is included.

The former vendor bundle and exploratory source downloads are retained only
under ignored test-output. They are excluded from the installer and Git.
The prior released 2.0.33 installers and paused finishing worktree are retained.

## Resume commands

```powershell
pwsh -NoProfile -File scripts/build-metadata-perl.ps1
pwsh -NoProfile -File scripts/test-photo-process.ps1
pwsh -NoProfile -File scripts/test-exiftool-runtime.ps1
node scripts/test-google-photos-browser.mjs
node scripts/test-google-photos-jobs-browser.mjs
npm.cmd run build
```

The browser runners require the configured Playwright runtime. Use
prepare-exiftool-bundle.ps1 with the accepted runtime, both pinned source
archives and matching Perl receipt to assemble a fresh absent managed directory.
Preserve an existing directory before replacement. A new lock requires explicit
-WriteLock and fresh source/runtime review; release requires the cleared gate.
Use build-release.ps1 with the existing verified managed-media source archive,
then verify-photo-release.ps1 -Version 2.0.34 -PreviousVersion 2.0.33.
Deliver only verified installers to the metadata-error thread 1792958256.790289
in GoggoVille #swghermes, and read back all messages and attachments.
