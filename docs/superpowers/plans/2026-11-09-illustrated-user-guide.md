# Illustrated User Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved offline illustrated Help centre and a validated Windows test installer.

**Architecture:** Generate the portable and bundled HTML from docs/USER_GUIDE.md, locally owned SVG diagrams and demo screenshots. A focused UserGuide dialog overlays the mounted workspace; fixed frame-message contracts and a disabled controller surface isolate the reader from native operations.

**Tech Stack:** Existing React/TypeScript/Vite/Tauri; dependency-free Node documentation generator; existing Playwright browser harness.

**Spec:** docs/superpowers/specs/2026-11-09-illustrated-user-guide-design.md

## Global constraints

- No new dependencies, online documentation service, user-media access or cloud calls.
- Never grant same-origin or native privileges to the guide.
- Publication/merge is outside this approval.
- Existing F1/keymap help remains unchanged. Core Jobs continue.
- Use only generated/demo screenshot content; all graphics work offline.

## Review focus

- Held Snapshot shuttle must stop without losing cursor/session.
- Window-level keys and direct AJAZZ events must not mutate mounted editors.
- Opaque-frame messages require source validation and fixed allowlists.
- Modal focus must work across the frame boundary and restore safely.
- Installed assets must be embedded; development paths are insufficient.

### Task 1: Reader isolation and contextual integration

**Files:** src/components/UserGuide.tsx, src/components/userGuide.css, src/utils/userGuide.ts, src/App.tsx, tests/help-preview.tsx, scripts/test-user-guide-browser.mjs.

**Interfaces:** UserGuide({chapter,onClose}); guideChapterForPage(Page): string; fixed guide message constants. All are frontend-only.

- [x] Add browser assertions for contextual opening, mounted form/selection preservation, frame sandbox, keyboard/controller isolation, unknown frame messages, Escape/focus return and existing F1 help.
- [x] Observe missing integration failure, implement dialog and entry points, then pass focused checks.
- [x] Pass active=false to mounted Studio/Snapshots during help, retaining component instances; test active shuttle stops.

### Task 2: Illustrated reproducible documentation

**Files:** scripts/build-user-guide.mjs; docs/user-guide/source/*; docs/USER_GUIDE.md; public/help/user-guide.html; docs/user-guide/PhotoGoGo_User_Guide_2.0.52.html; package.json.

**Interfaces:** npm run guide:build emits identical embedded/portable self-contained HTML plus a small build manifest. Images embedded as data URLs; chapter IDs stable ch-01..ch-18.

- [x] Preserve all source paragraphs/tables and validate every internal link. Build diagram assets with text equivalents and capture real component screens using demo adapters.
- [x] Add reader styling, task cards, font size, search, image enlargement and frame-local Escape/Tab coordination. Match host contract from task 1.
- [x] Verify all 18 chapters, images, no external requests, desktop/mobile overflow, search and print; inspect screenshot and print proofs.

### Task 3: Review and installer validation

**Files:** versions in package/package-lock/Cargo/Cargo.lock/Tauri config; docs/release-2.0.52-validation.md; existing release scripts.

- [x] Run build/type checks, focused help browser checks, and affected existing Lightbox/Snapshot/controller regressions.
- [x] Obtain the approved reviewer's patch review, fix material issues and rerun relevant checks.
- [x] Build both Windows test installers with the pinned existing runtime bundles; inspect/extract without installing and confirm version, binary identity, graphics/guide content and resource closure.
- [x] Deliver local installer/manual links, evidence and remaining target-PC acceptance steps. Do not publish, push or merge without approval.

## Execution record

Ruling: the native managed checkout was created, but this session denied writes there and to branch metadata. The archive tool refused cleanup because it regards that new checkout as primary; it remains unmodified and is not used. Work continues in C:/creations/PhotoGoGoV2 on its existing task branch, with explicit paths; other worktrees and unrelated cleanup files remain untouched. Existing guide documentation changes belong to this chat and are retained.

Checkpoint: approved Lightbox filtering/explicit Reviewed status is included in the same 2.0.52 test build. Fresh Help reports pass 7 host groups, 4 actual-page/capture groups and 7 document groups (503 substantive fragments, 18 chapters, 11 embedded figures). The 29-page print proof was visually inspected. See release-2.0.52-validation.md for packaging results once complete. Browser DOM isolation and compiled asset parity are distinct from live native WebView privilege-boundary testing.

Final: both 2.0.52 installers built and inspected without installation; compiled-guide parity test passed. Local delivery links and acceptance steps are ready. No publication/merge/push.
