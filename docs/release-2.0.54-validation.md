# PhotoGoGo 2.0.54 validation and delivery

Status: implementation and source validation complete; installer validation and delivery pending.

## Scope and evidence

- User reports a publish attempt on2.0.53 briefly appears then is absent from Jobs and History. Slack metadata at1794773866.614299 shows8 protected records, including2 created16November2026, each581414bytes. Their existence does not establish a Google upload outcome. The exact problematic target record is not yet identified.
- Reproduced a native/TypeScript contract defect: start returns JobSummary, while View job used the whole object as an ID. It now validates the exact native summary ID against the reviewed plan. Uncertain acknowledgements/errors retain an unconfirmed lookup reference and never trigger automatic republish.
- Reproduced read-only catalogue failure: one decoded legacy record with an unsupported identifier hides a newly saved valid job. Per-record scan findings now preserve independently readable current rows and return bounded sanitized warnings. Fully decoded, self-consistent legacy IDs remain non-runnable without blocking healthy jobs; the strict executor still reads their receipt evidence.
- Unreadable data, filename/plan-ID mismatch or a disappeared enumerated file blocks continuation/album actions while allowing stop and diagnostics. Same-root previously validated rows are retained only by their unavailable filename-derived IDs and marked stale. A successful fresh scan restores normal capabilities.
- Direct job lookup rejects filename/plan-ID mismatch. Protected root/reparse checks, strict executor ledger, archive validation, account/rate-limit binding and duplicate prevention remain unchanged.
- The existing Jobs page offers read-only lookup for a missing focused attempt and explicit destination links after a focused job leaves the current filter. No substitute process row or second tracker is created.
- The existing Clear finished path still rejects unsupported old identifiers; that separate nonblocking archive limitation is documented and not silently bypassed.

## Source checks

- Red native catalogue regression failed with Invalid Google Photos plan/job identifier; mixed good/legacy rows are now returned with warnings and unchanged old bytes.
- Red native direct-lookup regression exposed mismatched saved identities; the guard now rejects them.
- Full native library: 420 passed, 0 failed; 30 opt-in media/hardware checks ignored.
- Focused Google Photos native suite:104 passed,1 opt-in integration ignored. New cases cover unreadable receipts, strict ledger rejection, identity-keyed stale cache retention, repaired-state recovery and warning redaction.
- Recovery browser:10 passed; normal Google Photos browser:15 groups; shared core Jobs browser:11 groups. Synthetic IPC only; no Google account, live upload or user media was accessed.
- Shared Jobs UI: 17 passed; actual-App polling/recovery browser regression passed. Production TypeScript/Vite build, 4 Google unit groups and 7 offline-guide browser groups passed.
- One independent read-only reviewer found no blocking issue after checking receipt, ID, cache and retry behavior. The target record cause and real Google outcome remain for target-PC retest; no migration/reset was performed.

## Release constraints

Preserve2.0.53 rollback installers and unrelated worktrees/cleanup files. Use existing dependencies and pinned runtime/source bundles. Build and inspect EXE/MSI without installation; serialize packaging and compiled-guide validation. Deliver both to Personal/GoggoVille #swghermes with read-back and hashes. Both installers will be delivered to Slack. GitHub will publish the source tag, portable guide and checksums, with explicit Slack installer links and the unchanged matching FFmpeg source link; avoid slow redundant installer uploads.

Final checks, source commit, package hashes, inspection and delivery receipts will be appended after completion.
