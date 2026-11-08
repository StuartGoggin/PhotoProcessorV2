# Lightbox First Preview Implementation Plan

> **For agentic workers:** Use inline execution with the two already approved bounded helpers. Steps track the approved preview-first change; do not request another approval for the same scope.

**Goal:** Display the exact selected photo before folder inspection or slower comparisons finish, without weakening saved decisions or capture identity.

**Architecture:** Separate display readiness from canonical action readiness in the existing hook. Fence each panel completion and reconcile verified metadata to the latest physical selection. Bound folder calls and retain the existing image cache.

**Tech Stack:** React/TypeScript, Tauri/Rust, existing Playwright fixtures and bundled metadata tool.

**Spec:** [Approved design](../../lightbox-first-preview-design.md)

## Global Constraints

- No new dependencies, implicit RAW development, original-file edits or staging schema changes.
- Preserve exact-version checks, incomplete-pair protection and pending/failed write receipts.
- One active folder inspection and at most one latest queued inspection; coalesce duplicates.
- Native concurrency only if bounded measurements demonstrate benefit.
- Root owns integration/release; helpers do not commit, publish or build installers.

## Review Focus

- A clicked JPEG folded into RAW must keep the same physical JPEG source.
- Every late panel/folder result must respect root, tree and selection epochs.
- Preview visibility must never enable writes before identity verification.
- Persistent inspection failure must not generate automatic retry loops.
- Comparison completion and folder reconciliation must not displace newer picks or dialogs.

### Task 1: Preview and independent panels

**Files:** `src/hooks/useReview.ts`, `src/pages/Review.tsx`, `src/components/ImagePanel.tsx`, `src/components/LightboxVersionControls.tsx`, `src/utils/lightboxFolderQueue.ts`, `scripts/test-lightbox-first-preview-browser.mjs`; reuse the existing controlled preview fixture.

**Interfaces:** Keep `getSnapshot`/`isContextCurrent`; expose separate display and action readiness plus per-panel loading and inspection status. Retain existing mutation-handler safety checks.

- [x] Reproduce both waits using the actual React fixture and 700 file entries; red evidence in `test-output/lightbox-first-image-latency/`.
- [x] Promote the repro to assertions for early exact-source display, zero provisional writes and independent version painting.
- [x] Implement source-pinned progressive display, safe navigation and canonical action gates.
- [x] Add bounded folder admission/coalescing, progress and explicit retry.
- [x] Run focused/browser/TypeScript checks and retain measured first-paint evidence.

### Task 2: Metadata performance

**Files:** `src-tauri/src/commands/raw_development/capture.rs` and focused native tests only as necessary.

**Interfaces:** `read_tokens` retains complete validated `HashMap<PathBuf, Option<String>>` semantics; pairing never uses a partial candidate snapshot.

- [x] Helper measures serial versus bounded-two batch processing with generated fixtures.
- [x] Implement only a proven small optimization; otherwise retain current native behavior and record the finding.
- [x] Test batch bounds, cache reuse, incomplete/duplicate/error rows and source changes.

### Task 3: Integration and release

**Files:** Existing Lightbox/RAW/curation/controller regression scripts, release version files, guide and `docs/release-2.0.49-validation.md` / `docs/release-2.0.50-validation.md`.

- [x] Independent reviewer checks identity/cache/error safety; repair actionable findings.
- [x] Run appropriate units, browser groups and serial native suite; compare first-preview dependency behavior.
- [x] Commit final source, build final 2.0.50 EXE/MSI and inspect both complete payloads/runtime/source closures.
- [x] Merge/push master and annotated release tag; post EXE + MSI to #swghermes and read both back.

## Execution ledger

- Baseline: `da0ea7c` (released 2.0.48); tracked application files clean, four unrelated cleanup artifacts left untouched.
- Ruling: use focused branch `SWG/lightbox-first-preview` in the current checkout to preserve the verified build/runtime cache; other active worktrees remain untouched. Helpers own disjoint files.
- Ruling: existing user approval covers implementation, two helpers, integration and publication; no additional plan/finishing approval is needed unless scope or risk materially changes.
- Task 1: complete — nine new browser groups, 21 controller/Lightbox groups, 13 general Lightbox groups, nine RAW-source groups, eight rename-recovery groups and 11 selection/barrier groups green. TypeScript, 20 Lightbox units, 22 controller units and four curation queue checks green.
- Task 2: complete — bounded-two metadata overlap passes six focused tests and an explicit real-tool probe; generated fixture cold 2,610 ms / warm 46 ms with unchanged bytes. Full serial native suite green (386 passed, 30 opt-in ignored).
- Review: same-root remount, foreground inspection priority, missing Camera JPEG fallback and unresolved-selection cleanup repaired. Original-read action readiness retained after legacy regression caught early rating. Independent final source review has no remaining material findings.
- Ruling: 2.0.49 tag/package checkpoint stays unchanged, but its uploads were never finalized/shared. A final failure-path test caught unrelated expansion overwriting selected-folder Retry status; the surgical phase-ownership fix and tenth regression pass. Deliver 2.0.50 instead of rewriting a published tag. Native implementation is unchanged.
- Task 3: complete — 2.0.50 built source `766bde5c`, package receipt/tag `072148ac`, both extracted packages/runtime/source closures and relocated RAW smoke verified. EXE parent `1794120372.112779` and MSI reply `1794120394.219089` read back with exact hashes/byte counts. Actual PC/storage speed is a user retest, not a claimed fixture result.
