# PhotoGoGo 2.0.54 validation and delivery

Status: validated, merged/pushed and published. Both installer formats were delivered and read back in the requested Slack channel; target-PC acceptance remains pending.

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

## Final package evidence

Built application source: `46b0ceee8abe7936a9a4b026b74251f3d0630249`. Build ID: `20261115T205335240Z-46b0ceee+local`; the local marker reflects four preserved unrelated cleanup artifacts and a documentation clarification, not additional application changes. Production build and compiled custom-protocol embedded-guide parity passed. A final focused native run passed all 11 core-job cases after removing unrelated formatting churn.

Both EXE and MSI were built successfully and extracted without installation. Inspection report: `test-output/release-2.0.54-inspection-20261115T210157225Z/report.json`, complete=true. MSI product version is 2.0.54; UpgradeCode `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` is unchanged from 2.0.53. Both application payloads match normalized SHA-256 `d6c152c29979134ac3d0341ce69a9d56d63e11efea37c2ab3f2a83e5a0b9dfbe`; normalization covers only Tauri's expected three-byte bundle marker. Each package verified 35 payload hashes, ExifTool's 2,205 files and relocated runtime, RAW's 440 resources, controller sources/licences and media/source pairing. No new RAW decode benchmark or live Google test was run for this job-recovery change. These are unsigned test installers.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| PhotoGoGoV2_2.0.54_x64-setup.exe | 131,758,900 | `c3041be10c0f481c052436e752abbdf07cab54b1c12ae8183f62e79316fcafdc` |
| PhotoGoGoV2_2.0.54_x64_en-US.msi | 222,978,772 | `86469b210dc5fa737e5899f91e52831805d3985c8536a98f7d4d400c7e826cb9` |
| PhotoGoGo_User_Guide_2.0.54.html | 1,094,541 | `93ef8509369e2b2da71bc5b71f8edcf2f3c01523f97a23c912e56e98e918ad99` |
| PhotoGoGo-FFmpeg-rowtest1-source.tar.gz | 49,570,807 | `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8` |

`SHA256SUMS-2.0.54.txt` lists these hashes. Both installer formats will be shared in Slack; GitHub carries the source tag, portable guide and checksums with explicit installer links. The unchanged matching FFmpeg source archive was verified on the published 2.0.53 release by server digest and size. Source, receipts and all eight target records remain untouched by live Google operations. Remote and delivery receipts follow after read-back.

## Verified publication and delivery

Package receipt `0c15a439846ec90e4a227589d40c7206f7252f6d` was atomically pushed to GitHub master and SWG/google-upload-job-recovery; annotated tag v2.0.54 peels to that receipt. Both branches and the tag were read back. Application source remains `46b0ceee8abe7936a9a4b026b74251f3d0630249`. A later documentation-only delivery commit advances the branches without moving the tag.

Published GitHub test release: https://github.com/StuartGoggin/PhotoProcessorV2/releases/tag/v2.0.54 (release446366619), published2026-11-15T21:09:46Z; draft=false, prerelease=true. Its two assets, portable HTML guide and checksum list, have server SHA-256 digests and byte sizes matching local files. Both installer formats are explicitly linked to their Slack attachments rather than advertised as duplicate GitHub assets. The unchanged corresponding FFmpeg source archive remains linked from the verified2.0.53 asset.

Personal / GoggoVille #swghermes delivery:

- EXE release parent: https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794776877691729; fileF0CHRF6GDAP. HTTP200 acknowledged131758900bytes in134.6seconds.
- MSI alternative: https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794776946950309; fileF0CHVNYEGLW. HTTP200 acknowledged222978772bytes in202.5seconds.
- Published release/guide/source links and retest instructions: https://goggoville.slack.com/archives/C0BDK1DDZTM/p1794777010503909.
- Final thread read-back verified both file IDs, version, hashes, byte counts and published links.

Slack evidence is the sender's pre-transfer SHA-256, HTTP200 exact-byte acknowledgement and visible file/thread metadata; no independent Slack-hosted download/hash was performed. Signed upload addresses and credentials were not saved to files. Structured local receipt: `test-output/release-2.0.54-delivery.json`.

Target retest: after active jobs finish and the app is closed, install one format, open Jobs All/History and refresh. Inspect the existing attempt's details/diagnostics before considering another upload. If still missing, share the visible warning or reviewed report with sensitive paths/account details redacted. No protected-record deletion, migration, account reset or live upload occurred in development. The user target's exact failing record and actual Google outcome remain unconfirmed.
