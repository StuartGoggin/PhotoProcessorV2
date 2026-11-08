# Named-event re-import implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-import into existing named event days and skip verified identical contents.

**Architecture:** Resolve year/month/day using existing native date recognition
before creating/staging files. Retain source streaming, destination verification,
staging-wide content checking and no-overwrite publication.

**Tech Stack:** Rust, existing Tauri modules, synthetic filesystem tests.

**Spec:** `docs/superpowers/specs/2026-11-09-import-named-day-design.md`

## Global constraints

- No new dependencies, media changes, duplicate cleanup or release publication.
- Keep destinations inside canonical staging; reject redirected components.
- Preserve single source read, independent verification and no overwrite.
- Preserve event sidecars and curation files.

## Review focus

- Bare and named same-date folders: ambiguity without mutation.
- Renamed-day duplicate contents: skip with missing/stale sidecars.
- Same-size/name different bytes: retain both and reviewed state.
- RAW/JPEG pairs and concurrent jobs: consistent routing and safe publication.
- Reprocessing: preserve reviewed folder and filename where appropriate.

## Task 1: Destination resolution

- [x] Run existing native import baseline tests.
- [x] Add real-helper renamed-day regression and observe its failure.
- [x] Implement fallible destination selection in `src-tauri/src/commands/import.rs`, reusing native naming/path checks.
- [x] Report resolution errors through existing job errors before creating folders.
- [x] Test normal/missing dates, month/year separation, ambiguity, links and reprocessing.

## Task 2: Duplicate checks and publication

- [x] Test real staging hash/size checks for renamed folders, stale sidecars and changed bytes.
- [x] Test actual copy/MD5/verification/publication for RAW/JPEG and concurrent input.
- [x] Change duplicate logic only when a regression proves a defect (none reproduced; existing checks retained).
- [x] Run import, naming, RAW compatibility and standalone pipeline checks.
- [x] Resolve the approved read-only review and document final validation.

Execution: main agent on `SWG/import-named-day`, reusing the existing build cache.
One approved read-only reviewer checks safety. The approved conversation supplies
the design/execution authorization; no further approval for this scope is needed.
