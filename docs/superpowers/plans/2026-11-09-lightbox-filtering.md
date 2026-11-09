# Lightbox Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe folder-scoped filtering, sorting and explicit Reviewed status, then deliver with embedded illustrated Help in a validated 2.0.52 test installer.

**Architecture:** Independent backward-compatible review sidecar; existing tree stat yields opaque source stamp. Keep full catalogue identity and project one ordered view used by both tree and navigation. Separate confirmed filter membership from optimistic checkbox paint.

**Tech Stack:** Existing Rust/serde/fs2/sha2 and React/TypeScript; no new dependencies.

**Spec:** docs/superpowers/specs/2026-11-09-lightbox-filtering-design.md

## Global constraints

- No user-media changes during development/testing; isolated fixtures only.
- No new per-file metadata queries or RAW decodes for filtering.
- Do not extend strict legacy Google curation schema.
- No automatic Reviewed inference or marking on browse.
- No publication/merge without approval; other worktrees remain untouched.

## Review focus

- A filtered-out current photo must not skip the next matching item twice.
- Unresolved curation must not hide all candidates and block catalogue bootstrap.
- Pending/failed saves must not change filter membership prematurely.
- RAW/JPEG/crop identity and tag-neutral renames must preserve exact targets.
- Stale/corrupt review metadata must not disable unrelated rating/crop/upload decisions.

## Tasks

- [x] Native explicit review persistence + source stamp from existing build_tree stat; command registration and archive metadata classification; meaningful native tests first.
- [x] Pure view/projection and validated preferences; filter/sort/unknown/owner cases first.
- [x] Bounded review state hook and confirmed curation projection seam; conservative bootstrap and durable acknowledgement checks.
- [x] Integrate one ordered view into useReview tree/siblings/navigation/prefetch, with pinned pending selection and single advancement.
- [x] Add compact accessible controls, review actions/keymap and empty/count feedback; actual-page browser failure/paired/700-file regressions.
- [x] Update guide/captures, final independent safety review, run appropriate existing native/browser suites, build/inspect both 2.0.52 test installers.

## Current checkpoint

Both approved implementations are complete in the original checkout. Fresh validation: full native library suite 416 passed, 30 opt-in ignored, zero failed using serial test execution; Lightbox projection 21 assertions; new actual-page browse suite 11 groups; existing Lightbox 13 groups, controls 21 groups, selection persistence 11 groups; curation queue 4 boundary checks; controller 22 checks; event naming browser and Snapshot sessions (16 checks) passed. Help host 7 groups, actual-page preservation/capture 4 groups, document 7 groups with 503 source fragments, 18 chapters and 11 figures passed.

The reviewer found and rechecked fixes for draining Google writes after remount, ambiguous flag identities, cropped-family failure pinning and dangling review/lock links. No unresolved blocking review findings. The initial parallel native run collided with the existing global RAW publication guard; serial execution clears those four failures. A new link fixture initially reused its own normal lock; its corrected isolated fixtures now pass.

Windows test EXE/MSI packaging, release-mode compiled-guide parity and both installer inspections passed. See docs/release-2.0.52-validation.md for hashes and evidence limits. Source remains uncommitted on SWG/photo-review-upload-recovery; publication/merge is outside the current approval. The unused managed checkout remains unmodified; always pass C:/creations/PhotoGoGoV2 explicitly as workdir. Four unrelated cleanup files remain untouched.

## Approved publication amendment

Stuart approved commit/merge/push and publication to GitHub and Personal/GoggoVille #swghermes, then requested automatic Reviewed for successful photo review actions before release. This supersedes earlier local-test-only/explicit-only scope. The automatic writer is view independent, bounded and separately retryable; exact next and failed-capture pinning are tested. Final source commit and rebuilt installer/guide receipts will be recorded in docs/release-2.0.52-validation.md.
