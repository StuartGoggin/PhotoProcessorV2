# PhotoGoGo 2.0.55 combined release validation

Status: all four approved areas implemented; combined source validation and both installer inspections passed. Publication and delivery pending.

## Scope and evidence boundaries

- One release: Google authorization recovery, receipt-preserving cleanup of old job details, faster observable local photo inspection, and bounded SD-card import throughput improvements.
- Target report Slack1794779413.646469/fileF0CHGEX2CS3:392 pending photos,0bytes, repeated Check account HTTP400. The exact token rejection is unknown. Reconnection is an explicit target-user action; no live account/upload/reset was performed in development.
- Auth: bounded allowlisted OAuth codes, fixed recoveries, same account/client reconnect before credentials replacement, explicit job-level authorization block in diagnostics. Synthetic HTTP400 regression RED→GREEN.
- Cleanup: reviewed exact-ID/revision selection with no preselection, age/type/status filters and acknowledged remove/dismiss. Per-executor active/lifecycle/OS-writer checks. Receipt/album compaction is durable and read back before deletion. Unknown mutations/opaque evidence remain protected and can be dismissed where decodable/inactive. Removing details does not imply Google success. Portable import manifests, originals, processed outputs, projects and reusable renders remain.
- Cleanup includes abandoned Google plans older than24hours and previously cleared Studio records/logs. Account/media/privacy/album/fingerprint identities remain distinct. An unreadable sibling is retained without hiding healthy cleanup targets; global upload admission remains strict.
- Planning: scope scan, request-fenced stage/count/bytes, cancellation/persistence gate and request-local locked fingerprint reuse with fresh-read fallback beyond1,024handles. No unsafe persistent hash cache or weakened upload-time checks.
- Import: one source reader, two destination workers, bounded four-file/256MiB reservation before copying, oversize-alone path; source size bound carried into preparation and locked copy. Flush original writable handle in destination stage before independent MD5 and atomic no-overwrite publication. Backpressure/peak metrics logged.

## Historical implementation evidence (superseded by final validation below)

- New auth2tests green after reproduced generic400 lost-code failure; reconnect identity guard and global diagnostic-redaction tests added.
- Planning native7green before finalguardfallback test; final8case suite is in combined validation. Newbrowser4 and existingGooglebrowser15groups green. Synthetic3x1MiB originals:6,291,456→3,145,728 fingerprint bytes; local warm-cache121.880→101.825ms sample. Not target-PC throughput evidence.
- New cleanupbrowser7green; thrownapply consent-reset regression RED→GREEN. Status/action-reset changes included for finalrecheck.
- Native cleanup first10filteredchecks green; exact-album/fingerprint suppression regression reproduced RED and corrected; album-group mapping preserved too. Additional abandoned-plan, active/opaque archivedStudio, deletion-failure/readback and negative-evidence tests added.
- Import native59passed/1optionalignored before final combined run. Synthetic read-ahead RED proved third-file source stall under destination pause; new weighted pipeline and real source-size drift regression green. Standalone harness being updated only for the intentional3-payload compatibility seam (productionusesweighted4-filelimit).
- First combinedrun:442passed/1failed/30ignored; new global shape guard over-restricted an older multi-album fixture. Narrowed global check to receipt item identity/length while retaining stricter cleanup-shape checks. Nextcombinedrun446passed/0failed/30ignored, before last archive-history test/versionbump.
- Independent safety reviewer caught exact album identity and byte-reservation drift; both addressed with regressions. Windows guarded app-data cleanup and preserved writable flush handle reviewed. Final actual-diff/receipt check remains.

## Release requirements

Keep2.0.54 rollback installers. Preserve other worktrees and four unrelated cleanup artifacts. Validate all four changes together, update embedded/portable Help, sourcecommit after serialized compiledguide validation, then releasebuild and EXE/MSI extraction/hash/runtime/upgrade inspection. Publish source/tag and both Slack installers with read-back; GitHub smallguide/checksums and explicit Slack installer links. No installer will be installed here or on the renderPC.

## Final source validation

- Full native library on2.0.55: **449passed,0failed,30optional media/hardware tests ignored** (479total), serial runner. This includes the final unknown-album-state guard, eight planning cases, exact-membership/group/fingerprint retention, legacynegative/unreadablesibling isolation, delayed deletion failure with durable evidence, abandonedplan protection and archivedStudio/currentID/opaque/original-output safeguards. Receipt `test-output/release-2.0.55-native-all.log` supersedes earlier failing/debug runs.
- Auth refresh rejection was reproduced using a loopback synthetic token endpoint, then machine-code/hint redaction passed. Same-account reconnect rejects a different identity before credentials replacement. No live Google account/token/store/media was accessed.
- Actual-page/component browser suites: cleanup7, planning4, existingGoogle15, shared coreJobs11, recovery10; shared Jobs polling passed. Jobs UI17, import UI10 and Google unit4groups passed. Help host7 and portableguide7 passed. Production TypeScript/Vite build passed with only existing bundle-size/Browserslist advisories.
- Existing standalone import harness:29passed/0failed, two child probes ignored in its outerlisting but explicitly invoked by normalparentcases. Updated only its obsolete two-payload assertion to deterministicthree-payload compatibility-seam behavior; one source reader,24 ordered publications, exact synthetic checksums and noorphans remain checked. Production native uses realMD5; its weighted pipeline is capped atfour files/256MiB, oversizealone.
- Measured controlled import workload: one destination329.8067ms, two172.5426ms; recordedsourcebackpressure73ms, peakfour in-flight payloads. A RED metric regression first exposed omitted handoff waits; the corrected metric includes reservation and channel-send waits. This is a controlled latency fixture, not SD-card hardware throughput evidence.
- Planning repeated fingerprint bytes remain6,291,456→3,145,728 (50%reduction) for3x1MiB originals. Earlier121.880→101.825ms sample varied; latest174.353→174.195ms was effectively unchanged. Claim scoped scanning/read-byte reduction and observable/cancellable progress, not a guaranteed elapsed speedup on the target PC. No persistent hash cache was introduced.
- Cleanup and planning screenshots were visually inspected, including explicit protection/removal/dismissal, clearconsent and stage/progress/cancel. All fixtures are synthetic; no personal photos/account data are packaged.
- Independent reviewer found/corrected membership identity and reserved-size drift issues. New files formatted separately to avoid unrelated rustfmt churn. Remaining protected/uncertain records are shown honestly; cleanup does not claim to erase safety evidence.

The installer gate follows: complete all native and compiledGuide checks, sourcecommit, build bothformats, non-installing extraction/runtime/hash/upgrade inspection, then verified source/tag and Slackdelivery. Do not run Cargo tests between packaging and binary parity inspection. Target acceptance still requires Stuart to choose Reconnectsameaccount and retry the existing saved attempt; the exact originalHTTP400 reason remains unknown until the new safe code is available.

## Final packaging preparation

- Added a production weighted-pipeline regression with two real concurrent MD5 destination verifiers: eight synthetic duplicate inputs produce exactly two independently verified publications and six duplicate decisions, with one source reader and no private-copy orphans. Focused case passed; the final full native run passed449/0failed/30ignored in84.55seconds.
- Compiled release Help parity passed. Running that check after the first packaging pass rebuilt the local reference executable; the strict binary guard detected changed bytes and stopped before package publication. No installer was shared. All tests now precede the replacement production build; both packages must pass extraction against that final production reference before delivery.

## Final package evidence

Built application source: `7e54e42d` (full source identity recorded by Git); application implementation checkpoint `424b370f477833daf626b2bbf911f1c8118b727c`. Build ID: `20261115T230710724Z-7e54e42d+local`; local reflects four preserved unrelated untracked cleanup artifacts. No application code changed after the passing449-test native run. All build-producing tests ran before the final installer build.

Both installer formats built successfully. Non-installing inspection report `test-output/release-2.0.55-inspection-20261115T231402195Z/report.json` is complete=true. MSI version2.0.55, prior2.0.54 UpgradeCode `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` unchanged. Normalized application SHA-256 `3928d973ad0ba31147fafe7875ca5be4b734eec488ffd4551c885441550bb2cd`; normalization changes only the expected three-byte Tauri bundle marker. Each package verified35payload hashes, ExifTool2,205files and relocated runtime, RAW440resources, controller source/licence closure and managed media/source matching. No new RAW image-quality test or live Google operation was performed; installers are unsigned test builds.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| PhotoGoGoV2_2.0.55_x64-setup.exe | 131,843,891 | `1941c0c682e84f00047e68a51e8ef83f5a60bc3663f120a36db2ecfe03499078` |
| PhotoGoGoV2_2.0.55_x64_en-US.msi | 223,126,228 | `7261a60a718bfef3b96c3523b9633fde235db2d576c3449727cfe459e91ec6fc` |
| PhotoGoGo_User_Guide_2.0.55.html | 1,098,272 | `edc3fb998b15cd86186259addad4714fe25ed31e3ae48189238590c042bf8342` |
| PhotoGoGo-FFmpeg-rowtest1-source.tar.gz | 49,570,807 | `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8` |

The portable illustrated guide is18chapters/11figures; embedded and portable checks passed. The matching unchanged FFmpeg source asset on GitHubv2.0.53 was verified by server digest and size. `SHA256SUMS-2.0.55.txt` covers the four artifacts. Keep2.0.54 rollback installers. Published source/tag and Slack read-back receipts follow.
