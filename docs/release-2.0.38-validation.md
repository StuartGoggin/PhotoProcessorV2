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

Built source: 8b364eeb1545739e5df0a8435e5f884333f3add3.
Build ID: 20261026T061149624Z-8b364eeb+local, retained as emitted. Tracked tree
was clean before and after build; this does not rewrite the literal +local stamp.

Both unsigned Windows x64 installers built and passed extraction without
installation. Application bytes match the standalone executable apart from the
three-byte Tauri package marker; 2205 exact metadata files match and the relocated
runtime executes without PATH. The managed FFmpeg payloads and manifest match.
MSI UpgradeCode remains {9CBA7A69-EDA0-5480-A421-9DC9AD265A65}, unchanged from 2.0.37.
Inspection: test-output/release-2.0.38-inspection-20261026T061830678Z/report.json.
Standalone application SHA-256: 3A49A0D612D764AAA611A11A4B6BB5377965346FE01530DD379A53A442E34253.

- PhotoGoGoV2_2.0.38_x64_en-US.msi
  Bytes: 92050707
  SHA-256: 37C12443B9FB3B9C1B9CF163BA5CACD66A50A98DC183EB588FBE778A7952C75E

- PhotoGoGoV2_2.0.38_x64-setup.exe
  Bytes: 71159488
  SHA-256: 9B952FDDF067EA4843A053F62254F0FE961BBF534E61A0A8F1B5E415EA008FDA

Unchanged FFmpeg corresponding source: 49570807 bytes,
SHA-256 27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8.
[Existing source delivery](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792900657737419).
The managed runtimes retain their licence/source materials.

Published to GoggoVille #swghermes and read back:

- EXE: 26 October 2026, 17:26:47 AEDT, timestamp 1792996007.654089,
  file F0CC50UEXDF, HTTP 200 acknowledgement for exactly 71,159,488 bytes.
  [Release post](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792996007654089).
- MSI: 26 October 2026, 17:30:20 AEDT, timestamp 1792996220.722019,
  file F0CCXEUKF32, HTTP 200 acknowledgement for exactly 92,050,707 bytes.
  [MSI reply](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792996220722019).
- Both local artifacts were checked against exact size and SHA-256 immediately
  before sending. Full thread read-back confirmed both attachment IDs/names,
  metadata, instructions and checksum captions. This is not an independent
  download/hash comparison of Slack-hosted binary files.
- Two curl connection attempts sent zero bytes. Windows' system HTTP client
  delivered both files using normal TLS and the signed upload URLs. No duplicate
  release post or visible duplicate attachment was created.
- Installer receipt commit b882a7c6f210ffe7614019d148d47c6281095fac was
  atomically pushed to master and SWG/google-core-jobs and tagged v2.0.38.
  The built source is still 8b364ee; this delivery note changes documentation only.

Remaining deployment check: Stuart installs either installer and uses the
existing saved job. Retry under Needs attention, or Restore to History from
Archived followed by explicit Recheck. No live Google account upload, render-PC
installation, user-photo mutation or active-render interruption was performed
by this task.
