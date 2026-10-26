# PhotoGoGo 2.0.38 validation

Hardens Google Photos recovery and makes archived upload history reachable
through the existing core Jobs interface. No new job tracker, cloud permission,
dependency, image processing or local photo mutation is introduced.

## Recovery changes

- A first-read dimension rejection is upserted before its failed checkpoint,
  even when no prior ledger row exists. A serde-defaulted per-item rejection
  survives restart; the exact retained legacy mismatch message also migrates.
- Replaying a saved verified checkpoint cannot upgrade newer rejected evidence.
  Verified and both reused states check current rejection before shortcuts.
  Reused items without prepared dimensions require the original upload's review.
- Fresh validated success clears propagated rejection flags for that exact
  account/media object, promoting only its matching receipt to verified. Other
  original jobs' own unresolved contradictions remain conservative until those
  jobs pass their own fresh check.
- Plan and start reconcile durable negative job evidence with the ledger, so
  interrupted ledger writes cannot permit silent reuse. Drive persists this
  reconciliation once under the existing writer lease before source access or
  new cloud writes; it does not rescan saved history for every photograph.
- Already-overwritten legacy evidence cannot be reliably reconstructed. No
  Google-side cause or deployed-account result is inferred from synthetic tests.

## Workflow changes

- Completed Google uploads remain accessible in Jobs → Archived. They are
  excluded from ordinary Active, Needs attention and History counts. Restore
  changes only history visibility under the writer lease, without account
  connection, timestamp changes, receipt deletion or Google requests. Cloud
  controls stay hidden until restoration, then require deliberate continuation.
- Hidden records needing recovery still reappear normally. Native continuation
  enforces archive restoration for eligible completed records as well as the
  existing account/client, rate-limit and writer-admission guards.
- Counters distinguish selected photos, reused receipts, accepted in this job
  and read-back verified in this job. Inherited warnings point to the original
  upload in History/Archived rather than inventing verification dimensions.
- Attention text identifies the failed stage, including title/cover operations.
  Open album remains available during retry delays while same-account/current
  protected-store checks remain enforced. Stale snapshots disable album actions.
- Destination wording distinguishes new private albums from adding photos to
  saved event albums. Existing sharing still requires reviewed continuation.

## Validation

The two reported defects first failed at the real native engine seam with
synthetic media and an isolated protected store: first mismatch then restart/
code 3, and old verified checkpoint after a newer job rejection. Added checks
cover a missing ledger plus legacy rejection, both reused receipt states,
visibility-only restoration and two album receipts sharing a media ID.

Final full native suite: **288 passed, zero failed, 23 existing opt-in tests ignored**, including the extra multi-album regression. Receipt: test-output/google-recovery-hardening/native-final.log.

Core Jobs browser: eleven regression groups, including restore without account reconnection or implicit cloud work, inherited-warning guidance, and Open album during retry delay. Transfer: fifteen browser groups. Jobs UI/classification: seventeen tests. TypeScript and whitespace checks passed. Production build and installer inspection follow.
Both bounded read-only reviewers approved the final design/diff, subject to the
parent's final test execution. No live account operations or user media used.

## Release receipts

Pending final validation, packaging, Git and Slack read-back.
