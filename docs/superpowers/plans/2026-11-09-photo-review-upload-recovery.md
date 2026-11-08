# Photo review and upload recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task.

**Goal:** Complete safe upload work despite isolated verification failures, and restore JPEG-first review with truthful failed-image recovery.

**Architecture:** Retain the existing receipt state machine and exact physical
Lightbox identity. Isolate item errors inside verification, aggregate at job
completion, guard cover writes, and make display preference distinct from its
effective source. Reuse the bounded image cache for exact-node Retry.

**Tech Stack:** Existing Rust/Tauri, React/TypeScript, native fixtures, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-photo-review-upload-recovery-design.md`

## Constraints and review focus

- No new dependencies, live uploads, media changes, publication or import regression.
- No registered item returns to upload; unresolved proof stays needs_attention.
- Fatal/request failures stop; unresolved album covers remain pending.
- Explicit source choice, verified pair proof and pending-save barriers survive.
- Retry targets exact source/epoch, preserves healthy panels and handles decode failures.

## Task 1: Engine recovery

- [x] Add failing multi-photo/multi-batch and restart/cover tests.
- [x] Run and observe failure before product changes.
- [x] Isolate unavailable/rejected per-item failures, retaining request fail-stop.
- [x] Aggregate unresolved proof at completion and guard cover writes.
- [x] Add bounded diagnostic proof fields and privacy checks.

## Task 2: JPEG-first Lightbox and panel recovery

- [x] Add failing paired-default and failed-read/decode browser tests.
- [x] Separate preferred/default source from effective displayed physical source.
- [x] Add per-panel error and exact-node Retry with stale-response fencing.
- [x] Run native, Lightbox/source/curation/controller browser and type checks.
- [x] Resolve the approved independent review; record validation and RAW proposal boundary.

Main agent implements both tasks; one approved read-only reviewer checks their
receipt/image identity boundaries. Existing approved scope supplies execution
authority. The optional larger RAW workflow remains unimplemented.
