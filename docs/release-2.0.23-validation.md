# PhotoGoGo 2.0.23 test release

## Scope

- Automatic local review frames, configurable as all clips, selected clip or manual; 4/8/12 frames, a bounded disposable cache, one decoder at a time and no scheduling during Studio jobs or outside Studio.
- Project scorecard starting templates, independently editable per clip. Blank prepared cards require results before appearing in the final video. Existing cards and explicit Off choices are preserved.
- Separate clip name / YouTube chapter metadata from the optional Clip title tab. New clips have on-screen titles off; existing enabled titles are preserved. Chapter-name-only edits do not invalidate picture renders.
- Include the previously validated media relinking, inline movement preview and targeted diagnostics work in this checkout.

No change to the stabilisation algorithm or its cache generation. Scorecards remain a post-stabilisation assembly operation. No user media, drivers or render-PC settings are changed by this release process.

See [review frames and scorecard guide](STUDIO_REVIEW_AND_SCORE_DEFAULTS.md) and [relink and preview guide](STUDIO_RELINK_AND_PREVIEW.md).

## Completed implementation validation

- Production TypeScript/Vite build passed.
- 89 ordinary Studio native tests passed (15 opt-in tests ignored by that run).
- Synthetic review-frame extraction/reopen/cache/pause/refresh smoke passed.
- Real synthetic scorecard assembly, frame/audio/chapter and cache-reuse smoke passed.
- 56 targeted frontend tests passed across Studio, audio, sequence, rotation, graphics and review-frame suites.
- Five browser workflows passed: Studio, graphics, inline preview, reliability and review-frame/title/template editing. These cover compact layouts, reopen behavior and preservation of picture approval for chapter-only edits.
- Independent read-only safety review found no remaining blocking findings.

## Release gates and receipt

Build from the committed release source using the existing locked release script and the checksum-verified corresponding FFmpeg source archive. Reuse the existing verified dependency tree; do not update dependencies. Omit the optional offline face runtime, as in 2.0.22.

Before publication, extract the MSI without installing it; verify product/version/upgrade identity, executable/library identity, every managed media payload file, media smoke and runtime closure. Build and hash NSIS but deliver the payload-inspected MSI. Record final commit, build identity, checksums, validation results and Slack read-back in the ignored `test-output/release-2.0.23/` receipt. This document is not itself evidence that the subsequent build or publication succeeded.

Preserve and exclude the unrelated `assets/` directory and the pre-existing line-ending-only `scripts/test-video-studio.ps1` working-tree entry. The build identity may retain `+local` because these entries remain; the release receipt identifies the exact committed application source.

## Distribution and acceptance

Unsigned Windows x64 test installer for GoggoVille **#swghermes** (`C0BDK1DDZTM`), accompanied by the unchanged corresponding-source archive. Do not publish to the old Oracle conversation. Do not install or run the installer on the render PC.

Before trying the upgrade, let active jobs finish, save a project snapshot and retain a backup plus the previous installer. Close PhotoGoGo normally. If rolling back, reopen the pre-upgrade snapshot: older versions do not understand the new settings. Installation/upgrade/rollback and real-footage acceptance remain user checks; local synthetic/browser validation does not establish GPU execution, throughput improvements or final stabilization quality.

Suggested acceptance: reopen a copied project, check cached review frames, rename a YouTube chapter without showing text, explicitly enable a clip title, seed and fill a scorecard, and regenerate the final video while confirming matching stabilized clips are reused.
