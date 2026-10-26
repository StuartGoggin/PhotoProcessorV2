# PhotoGoGo 2.0.36 validation

Google Photos now uses the core Photo Process job interface rather than a
separate tracker. Transfer owns account setup, photo/album review and submission;
its View job link opens the standard Jobs entry. Existing saved uploads retain
the same IDs. The private encrypted Google Job remains authoritative for
checkpoints and receipts; no second mutable progress record is introduced.

## Architecture and safety

- Core process snapshot, normal job tiles/console, common filters/history,
  standard controls and the shared native worker registry include Google tasks.
  Photo Process, event naming and local transfer use the same worker admission
  registry. Google still holds its OS writer lease over the complete executor.
- The old Google polling hook, standalone job card/dashboard and separate
  management fixture are removed. Legacy native listing is a compatibility
  adapter to the common snapshot, not a second tracker.
- Native continuation rechecks the original account/client, rate-limit delay
  and writer admission. UI capability hints cannot authorize cloud work.
- Pause and Abort cooperate with safe upload checkpoints. Abort retains all
  receipts and allows explicit same-job Retry. Queued/running orphans recover
  to paused only when no other process holds writer admission.
- Clear finished archives visibility only for fully resolved completed uploads.
  Pending, failed, paused, aborted and uncertain records stay visible. No
  checkpoint, media receipt, deduplication ledger or album mapping is deleted.
- The core snapshot caches read-only Google projections for 2.5 seconds. A
  protected-store failure retains the last known upload view, warns explicitly
  and disables continuation while local jobs remain usable. Generic logs use
  the existing bounded, redacted diagnostics, never raw saved Job serialization.
- Mixed local/RFC3339 timestamps sort by their actual instant. Worker cleanup
  is ownership-aware; failed thread spawn reacquires the OS writer lease before
  any orphan-state repair, avoiding overwriting another process's resumed job.
- The earlier four-photo verification correction remains: per-item rejection
  does not stop healthy sibling verification, and saved media never reuploads.

## Validation record

The new real-page browser regression first failed against the separate tracker.
Controlled native-command fixtures exercise the actual monitor, Jobs page,
standard tile/console and controls. Native tests use synthetic photographs,
a temporary sealed store and a deterministic Google service adapter. They make
no live Google upload or account changes.

The first complete native run passed 278 tests with 23 existing opt-in cases
ignored. Final post-review native and browser results, source commit, installer
inspection and verified publication receipts follow after their gates finish.

Final native validation: **279 passed, zero failed, 23 existing opt-in tests
ignored**, including ownership-aware worker cleanup and queued/running recovery.
Receipt: test-output/google-core-jobs/native-release-validation.log.

Browser/interface checks passed:

- Core Jobs: nine groups using actual React interfaces and controlled native IPC.
  One entry/poll path, standard controls, accepted/verified counts, same saved ID,
  abort/retry, capability guards, explicit album reconciliation, safe history,
  protected-store failure isolation, clipboard fallback and pending verification.
- Transfer: fifteen groups. Jobs SSR/behaviour: fifteen tests.
- Existing steady Jobs polling and NameEvents browser regressions passed.
- Final TypeScript check and diff whitespace check passed. The production build
  is repeated as the installer's normal before-build gate.
- The tighter Tail-off/manual Refresh regression also passed before adjustment;
  a synchronous snapshot getter removes React render-order assumptions. This
  is a contract hardening, not a claim of a reproduced additional bug.
- Independent native recovery/privacy and final concurrency review: GO.

Core evidence and visually inspected screenshot:
test-output/google-photos-core-jobs-browser/report.json and
test-output/google-photos-core-jobs-browser/core-needs-attention.png.
The canonical core browser runner replaces the obsolete standalone-tracker
fixture. Legacy Jobs/verification runner names delegate to that same suite;
their repeated execution is not counted as additional unique coverage.

## Acceptance on the test PC

Install over 2.0.35 on the same Windows account. Open Jobs; older saved Google
uploads should already appear under Process Jobs, once each. Use the ordinary
Pause/Resume/Abort/Retry controls and View diagnostics inside that job. Transfer
no longer contains a second upload-job dashboard. Its View job opens the same
core entry after publishing a reviewed plan.

Retry the existing four-photo job. If Google still rejects the Original's saved
ID, expect four accepted, three verified and one verification warning. The
Google-side INVALID_ARGUMENT cause is still unconfirmed; this architecture
change does not bypass verification or claim the live pilot is fully resolved.
Keep 2.0.35 installers for rollback. No installation on deployment PCs or edits
to user media are performed by this release validation.
