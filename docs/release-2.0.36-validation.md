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
ignored. Final post-review results, build and publication receipts follow.

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

## Build and installer receipts

Application/source commit: 4e71d72aca405784aac0e92f0b956829da392a3b.
Displayed build ID: 20261026T021359608Z-4e71d72a+local. Keep this literal stamp
when checking an installed test. The working tree was clean before and after
packaging; the normalized Cargo.toml blob matches the recorded source commit
(2fff884d898c79c3b0c950125811c2a59cbfe63c). The conservative +local marker
emitted during Tauri's build is retained, not rewritten as a clean stamp.

Production TypeScript/Vite compilation and optimized native packaging passed.
Existing large-chunk and unused-code advisories remain non-failing. No new
dependencies, media runtime, metadata bundle or source companion was introduced.

Both packages passed non-installing extraction inspection: application bytes
match the standalone build, allowing only Tauri's documented three-byte bundle
marker; each metadata tree contains all 2,205 exact files and executes after
relocation with PATH empty; managed FFmpeg's 27 payload files and manifest match.
MSI version is 2.0.36, and upgrade identity remains
{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}, matching 2.0.35.

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.36_x64-setup.exe | 71,160,797 | 279F47638AF8FDCBE45EE76F59DB38405296331EC5330F46B6FE8C8B781D4A99 |
| PhotoGoGoV2_2.0.36_x64_en-US.msi | 92,030,227 | F1D9989DD20BAB7AFA21662EBB6C24B702E50B9C449FA752E743B52AB8C1FC35 |

Both are unsigned test installers. Standalone application SHA-256:
A712F3BFA70AD41427B524390670E008CE15DE78D1B117CDCED285F9769677BA.
Inspection receipt:
test-output/release-2.0.36-inspection-20261026T022233237Z/report.json.
Build log: test-output/google-core-jobs/release-build.log.

The unchanged FFmpeg source archive remains 49,570,807 bytes, SHA-256
27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8.
Its existing #swghermes companion is
https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792900657737419.
Pinned ExifTool/Perl sources, recipe and notices remain inside both installers.

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

## Publication and delivery read-back

GitHub main and SWG/google-core-jobs were atomically updated to
4f611eb7e8e4d684752a4107a4c7f47d7b2d828d. Annotated tag v2.0.36 has object
51b083e7b0a91559dbe5ae33aade2957ccc2d0db and peels to that installer-receipt
commit. The references were read back with git ls-remote. This final
documentation-only delivery commit follows the tag; application files remain
identical to source commit 4e71d72.

Both installers were uploaded through the Personal connection into GoggoVille
#swghermes (C0BDK1DDZTM). Exact local lengths/SHA-256 values were rechecked
immediately before each upload; each returned the full byte acknowledgement.

| Delivery | File ID | Message timestamp | Upload acknowledgement |
| --- | --- | --- | --- |
| EXE | F0CBZUUH8K0 | 1792981616.602289 | HTTP 200, OK - 71160797 |
| MSI | F0CBZV4DZL6 | 1792981771.231849 | HTTP 200, OK - 92030227 |

New top-level release post, 26 October 2026 13:26:56 AEDT:
https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792981616602289.
The MSI is the reply in that thread. After sharing both files, the complete
thread was read back. It contains the correct filenames/IDs, MIME types,
displayed sizes, both SHA-256 values, source-companion link, core Jobs workflow,
existing-job recovery steps and the separate unresolved Google verification
boundary. This confirms upload-byte acknowledgements and Slack attachment
metadata, not an independent remote download/hash comparison.

No deployment installation, live Google upload, credential reset, render
interruption or user-photo operation was performed here.
