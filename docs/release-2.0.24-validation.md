# PhotoGoGo 2.0.24 test release

## Scope

- Project scorecard defaults for all three lines: heading, main/result line and subtitle.
- New template-prepared clip cards start off. Existing cards retain their enabled state. Text can be prepared while a card is off.
- Explicit review before updating existing clip text: current/proposed values, replacement/clear warnings, one choice per differing line, nothing preselected, search and blank-only selection.
- Apply touches only selected text. Unselected lines, card on/off settings, table entries, layout, timing, picture approval, revisions and stabilised renders stay unchanged. Stale reviews fail closed; project reload/reset discards choices.

No stabilisation algorithm, media tool, dependency or cache-generation change. No render-PC changes or installation are part of this release procedure.

See [the updated workflow guide](STUDIO_REVIEW_AND_SCORE_DEFAULTS.md).

## Implementation validation

- Production TypeScript/Vite build passed.
- 48 targeted frontend checks passed: Studio, sequence, graphics and review-frame tests.
- Full ordinary native suite passed: 134 tests, zero failures, 17 opt-in tests skipped. Includes legacy/default-text saved-project compatibility and unchanged picture/sequence identities. The packaged-media smoke remains a separate release gate below.
- Three browser workflows passed: scorecard update review, existing review-frame/title/template controls, and graphics/title finishing controls.
- Update-review browser checks include per-item choices, replacement and clear warnings, no preselection, editing while off, Cancel/Escape, focus containment, filtered selection counts, blank-only selection, repeated review, saved-project reopening, project-epoch invalidation and 1440/1024/390px layouts.
- Independent read-only review found no remaining blocking issues.

## Release gates

Build from committed source with matching 2.0.24 versions using the locked existing build script and verified FFmpeg corresponding-source archive. Reuse the existing verified dependency tree; do not update dependencies. Omit the optional offline face runtime as in 2.0.23.

Rerun the ordinary native suite and relevant frontend/browser tests. Extract the MSI without installing it; verify product/version/upgrade identity, EXE/DLL equivalence and all managed media payload files. Check the extracted media runtime and bounded synthetic scorecard/cache-reuse smoke. Build and hash NSIS, but deliver the payload-inspected MSI.

Record actual commit, build ID, package hashes, validation results and Slack read-back under ignored `test-output/release-2.0.24/`. This document describes the release gates, not proof that subsequent packaging/publication has completed.

Preserve and exclude unrelated `assets/` and the pre-existing line-ending-only `scripts/test-video-studio.ps1` working-tree entry. The build ID can retain `+local` for those entries; the receipt identifies the committed application source.

## Distribution, rollback and acceptance

Unsigned Windows x64 test installer for GoggoVille **#swghermes** (`C0BDK1DDZTM`), accompanied by the unchanged FFmpeg corresponding-source archive. Do not use the old Oracle conversation or install on the render PC.

Let jobs finish, save and back up an original project snapshot, and close PhotoGoGo normally before upgrading. New builds read old projects and preserve enabled cards. **2.0.23 rejects the new project-template result field: retain an original pre-upgrade snapshot and the previous installer for rollback.** Save edited work as a new snapshot, not over the old backup.

Acceptance: configure all three default lines; confirm new cards remain off; customise a score; change project defaults and review exact proposed updates; select one heading and deliberately skip the score; apply and verify only that heading changed. Rebuild the final export using the matching stabilised clips. Installation/upgrade/rollback and real-footage acceptance remain user checks.
