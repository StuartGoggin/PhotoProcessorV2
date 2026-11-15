# Combined jobs, Google Photos and import release implementation plan

> **For agentic workers:** Execute the approved tasks with bounded helper ownership and a final independent safety review. Root integrates and releases once all four areas pass.

**Goal:** One validated release containing Google authorization recovery, old-job cleanup, faster observable upload planning, and improved SD-card read utilization.
**Architecture:** Retain the existing core Jobs and durable Google executor. Separate removable job details from protected receipt/uncertainty evidence; use crash-safe evidence-first cleanup. Improve bounded local pipelines with explicit progress and unchanged verification/admission rules.
**Tech stack:** Existing Rust/Tauri, React/TypeScript and Windows bundles; no new dependencies.
**Spec:** User approvals in this chat on 16 November 2026, including all four items in the SAME release. Source base b6db085; previous rollback 2.0.54. Slack error source: Slack C0BDK1DDZTM/1794779413.646469, file F0CHGEX2CS3:392 pending,0bytes, repeated Check account HTTP400. Actual token rejection reason remains unknown.

## Global constraints
- Preserve originals, selections, projects and reusable renders; no live Google uploads/account reset or render-PC installation.
- Preserve protected account/client binding and all accepted/uncertain upload evidence. Do not turn cleanup into success or allow implicit duplicate upload.
- Only explicitly selected inactive jobs may be removed; writer/admission controls must prevent worker races. Preview scope and consequences; report partial failures honestly.
- Keep source hashing, independent destination checksum, atomic no-overwrite publication, card identity and cancellation guarantees.
- Bound temporary files and bytes; do not promise 100% utilization when destination/hardware is limiting.
- One combined 2.0.55 test release, source merge/tag, non-installing EXE/MSI inspection and verified #swghermes delivery. Retain2.0.54 rollback. Preserve unrelated worktrees and four existing cleanup artifacts.

## Review focus
- Crash between receipt compaction and job deletion; replay must preserve negative/uncertain evidence and idempotency.
- Worker starts during cleanup preview; apply must revalidate leases/state and refuse active work.
- OAuth error body contains secrets/untrusted descriptions; only bounded allowlisted codes may enter diagnostics.
- Photo changes or scope switches mid-plan; no stale results or unsafe hash reuse.
- Slow/full destination, equal-size duplicates, pause/abort and >buffer-budget files; no unverified publication or unbounded disk growth.

## Tasks and validation
- [x] OAuth: RED classify synthetic invalid_grant/invalid_client/transient/malformed rejection and diagnostic redaction. Add bounded machine-code parsing, same-account/client reconnect recovery, explicit global-block message. Verify existing auth binding and resume semantics. Files oauth.rs, diagnostics.rs, job detail UI as needed. Primary docs: developers.google.com/identity/protocols/oauth2/native-app and /oauth2#expiration.
- [x] Cleanup: RED compact accepted/negative/uncertain receipts, remove selected inactive details, retain strict ledger behavior across restart/crash; reject running IDs and stale previews. Implement common cleanup preview/apply surface for import, process, studio and Google. Root owns cleanup module/core adapters/Jobs UI. Independent reviewer validates before release.
- [x] Planning helper: reproduce redundant reads; scope catalogue safely, coalesce per-inspection identity-checked source/metadata work, bounded concurrency, stage/count/byte progress + cancel with request fencing. Own plan/catalogue/metadata/planning + GooglePhotos page/types/tests; root integrates native command registration. Compare output/hash/read counts and cold/warm synthetic timings, maintain upload-time full checks.
- [x] Import: RED demonstrate source pause on destination flush/handoff; move destination flush into verification, add bounded look-ahead and measured worker tuning where useful, source-stage timing/idle reasons. Preserve one sequential card reader initially; do not add competing readers without evidence. Test real bytes plus deterministic slow verification, checksum failure, abort cleanup and duplicate races.
- [x] Integrate: full native serial suite, focused browser/unit regressions for all four changes, production build and guide parity; visually inspect changed UI. Two bounded repair attempts per failing safety/quality gate, then stop for decision if unresolvable.
- [ ] Release: update guide/version; source commit, serialized build/inspection, package receipt, fast-forward remote master/tag, both Slack installers read back, published guide/checksum links, final delivery commit and clean managed-checkout sync.

## Execution ledger
- Approved scope and helpers; no further approval needed for the listed implementation/release.
- Reuse writable root on isolated SWG/jobs-transfer-import-2.0.55 branch and its pinned caches because managed checkout is read-only and duplicating runtime resources wastes disk. Other worktrees are untouched.
- Planning performance helper implements only its listed ownership. Safety helper is read-only. Root owns auth/cleanup/import/integration/release and serializes native compilation.

- Ruling: irreversible cleanup is offered only when the target job's evidence can be safely compacted into the existing ledger/album records; unknown registration/album outcomes and unreadable records remain protected. Inactive uncertain jobs can be dismissed reversibly instead. This avoids introducing a second receipt/tombstone architecture and preserves recovery evidence.
- Ruling: import may reserve up to four in-flight files and256MiB per card across one reader/two destination workers. A larger single file runs alone. The reserved byte size is passed into preparation and checked before staging; size drift is rejected.
- Ruling: default cleanup shows all ages with no preselection; otherwise the reported21-day-old failed jobs were invisible under the initially proposed30-day filter. Age/type/status remain explicit filters, and changing them clears selection/actions/acknowledgement.

- Sourcegate: finalnative448/0/30ignored; UI/browser/guide/productionbuildpassed. Backpressure metric RED→GREEN; no liveGoogle operation. Benchmarkclaims restricted to controlled synthetic workloads/read-byte counts.
