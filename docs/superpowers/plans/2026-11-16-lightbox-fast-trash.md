# Fast capture Trash implementation plan

> **For agentic workers:** Root executes native tasks inline; the approved UI helper owns frontend changes and the approved read-only reviewer checks spec and deletion safety. Preserve ownership and serialize native builds.

**Goal:** Fast whole-capture culling with persistent Undo/Redo, processing exclusions and a reviewed, durable removal job, released together.
**Architecture:** An append-only portable review journal hides save/replay recovery behind three commands. A removal executor owns durable per-file state and projects into existing core Jobs; exact guarded deletion and verified discard receipts stay native. Existing filename tags, catalogue pairing, RAW lineage and independent import verification remain.
**Tech Stack:** Existing Rust/Tauri, React/TypeScript, fs2, md5, sha2 and Windows file APIs. No new dependencies planned.
**Spec:** ../specs/2026-11-16-lightbox-fast-trash-design.md

## Global constraints
- User confirmed JPEG AND paired CR3 plus proven derivatives are removed by the explicit job; Trash marking itself remains reversible.
- No personal media/account/live upload/target install; all deletion fixtures are task-owned synthetic temp directories.
- Preserve exact-file Google flags, receipts, JPEG-first review, originals outside confirmed plans, other worktrees and four unrelated cleanup artifacts.
- Existing writable build checkout/new SWG/lightbox-capture-trash branch is used because this chat's managed checkout is read-only and the pinned cache avoids duplicate resource/build storage. Managed checkout remains the clean released snapshot until final delivery.
- Native compilation/packaging is serialized. Native tests and compiled Help check must precede final installer build and parity inspection.

## Review focus
- Pending Trash then immediate Undo; save failure/restart and external source replacement.
- Conflicting JPEG/RAW pairing, tagged-name aliases, multiple derivatives, retired RAW outputs and reparse paths.
- Durable intent before deletion; persistence failure/locked derivative/cancellation/partial family removal.
- Another import/process/RAW/upload reader starts between preview and apply.
- Same-name/different-content reimport and retained Google safety receipts.

## Tasks
- [x] 1. Native review journal. Add lightbox_trash/{mod,model,history,safety,tests}. Commands apply_lightbox_review_action, read_lightbox_review_history, replay_lightbox_review_action with agreed TS receipt (including exact Reviewed override). RED idempotent Trash/Undo/Redo, history restart, write-order recovery, changed-file refusal and unrelated flags. GREEN append-only intent/result journal, locked saves and precise replay. Commit task once focused native tests pass.
- [x] 2. Frontend fast decisions. Helper writes bounded queue and delayed-IPC behavior tests first. Locally patch current catalogue, advance visible order and use cached next original without tree refresh; persistent History/Undo/Redo UI and controller/help bindings. RED then GREEN rapid input/late reply/failure/retry/filter/end/remount cases; measure 700+ cached fixture independently from image decode. Root reviews actual patch and integrates native registration.
- [x] 3. Safe removal inventory/executor. Add lightbox_trash/{plan,worker}. RED exact JPEG+CR3/derivative membership, ambiguous/stale/active protection, changed derivative retains originals, per-file persistence failure/cancel/restart. GREEN frozen source SHA/MD5 and Windows handle-based unlink, per-file intent/outcome, discard receipts and per-capture partial reporting. Project executor into ProcessJob with stop/resume/retry/diagnostics and existing cleanup handling. Helper supplies Lightbox preview/confirm UI.
- [x] 4. Eligibility/import. Add shared capture access/Trash eligibility seam to Enhance/BW/RAW and destination import publication. RED discarded-capture processing and same-content reimport suppression; GREEN stage-scoped verified-MD5 discard receipts with explicit re-import override, no source-verification weakening. Show included/excluded processing counts.
- [x] 5. Integrate/review. Native library suite, targeted Google/import/RAW/Lightbox/Jobs regressions and actual-browser visual checks; independent actual-diff safety review and bounded fixes. Update Help/design/validation receipt; preserve target acceptance limits.
- [ ] 6. Release. Bump next unused version, source checkpoints, compiled Help parity then final EXE/MSI build and non-installing source/runtime/hash/upgrade inspection. Fast-forward master+feature/tag, deliver both Slack installers/read-back, publish guide/checksum/source links, commit delivery receipt and clean managed-checkout sync. Keep2.0.55 rollback.

## Interfaces agreed with UI helper
- apply_lightbox_review_action {request:{stagingDir,relativePath,expectedSourceStamp,actionId,trashed}} -> {actionId,revision,relativePath,renamed:[{oldPath,newPath}],trashed,reviewed,sourceStamp,entry,review:{root,relativePath,key,sourceStamp,reviewed,revision,explicit}}.
- read_lightbox_review_history {stagingDir,relativeDir,offset,limit} -> {revision,entries,canUndo,canRedo,total,nextOffset,warnings}.
- replay_lightbox_review_action {request:{stagingDir,direction,actionId,expectedRevision?}} -> same receipt. Client actionId makes retry idempotent; native retains precise prior Reviewed override.
- Entry {id,capturePath,label,beforeTrashed,afterTrashed,beforeReviewed,afterReviewed,outcome:saved|permanently_removed|blocked,canUndo,canRedo,createdAt}.
- preview_lightbox_trash {stagingDir,relativeDir,recursive} -> {id,stagingDir,relativeDir,recursive,canStart,items:[{relativePath,capturePath,kind,bytes,included,reason}],captureCount,fileCount,totalBytes,warnings}.
- start_lightbox_trash_job {previewId,acknowledged:true} -> ProcessJob. Core Jobs owns presentation; executor journal owns durable state.

## Progress ledger
- Baseline source668cfc34, released2.0.55. Last full native suite449passed/0failed/30optional ignored; only subsequent commits changed release docs. UI helper owns its listed frontend files, reviewer is read-only; root native.
- Initial review found generic process history is memory-only, normal browse catalogue omits retired/ambiguous versions, RAW All includes Trash, and stale sidecars cannot authorize discard. Use durable executor projection and exact verified ownership.
- Native journal first green:8history cases passed, exact inventory and guarded Windows unlink subsequently passed; durable executor RED reproduced. Additional identity-bound history, derivative-only Trash, crop ownership and metadata CAS regressions are being integrated.
- Windows blocked a large shell source-writing batch before execution. Worker remained the421-byte test stub; no partial executor edits or media operations occurred. Security protection is unchanged. Use the purpose-built source patch interface for normal reviewed edits; never encode/replay the blocked shell batch or disable protection.

- Final source checkpoint: implementation ef153db7; native484/0fail/31ignored, explicit optimized725 native case passed, finalUI725 preserved (p5067.6ms/p95116.1ms; target under50not met), frozen functional12 and controls21 passed. Compiled release Help1 and standalone import29 passed before installer packaging. Final validation record is docs/release-2.0.56-validation.md. Step6 remains pending until verified publication.
