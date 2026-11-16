# PhotoGoGo 2.0.56 — fast capture culling and reviewed removal

Status: implementation/source validation passed; optimized throughput, compiled Help and installer validation are in progress. No 2.0.56 installer has been published yet.

## Approved scope

- Immediate local Trash/Restore and next-original navigation through the current visible ordering, with bounded ordered background saves, explicit failure/retry state, close protection and no per-decision tree refresh.
- Portable full Trash/Restore audit history, Undo/Redo including the coupled Reviewed change, exact physical-file identities, replay revision fences and idempotent retry/restart recovery. A permanent-removal boundary cannot restore deleted bytes.
- Enhanced/B&W/RAW processing excludes rejected captures and their crop inputs. Job/preview preparation waits for review saves. JPEG-first review and exact-file Google selections remain distinct from canonical RAW identity.
- Explicit Take out the trash preview and durable executor projected into core Jobs. The approved capture includes Camera JPEG AND paired CR3, plus proven generated versions and exact sidecars. Frozen membership, before-discovery review revision, verified MD5/SHA256, Windows held-handle deletion, per-file durable intent/outcome, safe pause/cancel/retry and conservative original retention.
- Folder membership changes invalidate the frozen plan rather than authorize additional deletion. Metadata, import/Google receipts, SD-card files and archive copies are retained. Old filename-only collection directs users to the reviewed workflow.
- Verified discard receipts skip identical content on a later ordinary import, with an explicit re-import override and visible count. Staged independent MD5 verification remains; SHA256 comparison reads the verified local copy, not another SD-card pass.
- Illustrated offline Help, controller bindings and one Windows x64 test release. No new dependencies.

## Evidence and boundaries

All development deletion cases use task-owned synthetic temporary folders. No personal photo, SD-card content, live Google account/upload, render PC or target installation was modified.

The independent reviewer checked ownership, exact-file identity, metadata CAS, reparse handling, interrupted persistence, partial retries, replay revision fences, discard-ledger validation, shared job cleanup and membership changes. Findings were corrected with regressions. The history cache compares the complete prior journal byte prefix before reusing incremental state; it never relies on timestamps alone. Complete corrupt records remain protected. Interrupted trailing bytes are preserved separately before recovery.

The journal retains confirmed history and blocks safely at its documented storage limit rather than silently dropping old decisions. Its warm cache is bounded to one journal/16 MiB; large histories remain on disk. Unrelated file changes can conservatively require a fresh removal preview. Arbitrary concurrent edits by external programs are outside application coordination; exact held-file identity and fingerprints remain enforced.

## Historical runs, not release acceptance

- Early focused native runs passed20, then30 cases. The first broader run was deliberately stopped during a slow725-decision development benchmark; a second timing run was likewise stopped while reducing repeated parsing/copying. Logs are retained; neither is reported as a passing full run.
- The subsequent full run completed480passed/3failed/30ignored. Two assertions counted the newly created coordination lock as a processing output; the RAW All fixture still expected inclusion of Trash. These are being reconciled against the approved behavior, preserving original-byte/no-output checks.
- That pre-final development native timing was725decisions in567.158s (p50698.903ms/p951670.524ms). It is background-save timing from a debug build, not UI response or installed-release throughput. It exposed repeated folder metadata calls; final results must remain separate and must not be advertised as an achieved speed target.
- A shared Jobs polling run timed out at initial rendering under concurrent work; the fresh UI rerun passed unchanged assertions. Cause of the earlier timeout is unconfirmed.

## Final checks and delivery

- Final native library: **484 passed, 0 failed, 31 ignored**, 133.29s; receipt `test-output/lightbox-trash-native-release-candidate.log`. The ignored set comprises30optional media/hardware cases and the explicitly invoked725-decision throughput case. Crop/preview/RAW regressions from the earlier run are corrected. This includes frozen-membership protection, shared-reader exclusion, corrupt semantic discard records, interrupted journals/intents, physical-file replacement, paired RAW eligibility and preserved review identity.
- Final725actual React/Vite decisions with synthetic JPEG/native IPC: all saved in visible order, Review complete, no extra tree scans or browser errors. Visual p50 **67.6ms**, p95 **116.1ms**, p99 **135.6ms**, max **154.9ms**. Remaining next-image readiness p50 **54.1ms**, p95 **90.9ms**. **The under50ms target was not met.** This is a UI fixture, separate from native filesystem/installed-target throughput. Receipt `test-output/lightbox-fast-trash-browser/report-final-quiet-725.json` supersedes earlier lower timings.
- Production TypeScript/Vite build passed using the installed Node launcher (the roaming npm shim was stale). Only existing bundle-size/Browserslist advisories; no dependency or global installation changed. Photo Process13browser groups, shared Google/core Jobs11, Jobs UI17, import UI10, ordered review queue/transport and the helper's Lightbox/RAW/cleanup/browser checks passed. Final frozen-source functional rerun receipt follows.
- Help host7checks and portable guide7checks passed;535source fragments,18chapters/13figures. Embedded/portable HTML SHA256 `8ff255431b1f28da154f279d475c2e844c0956e70eb46477e811d1e340aaec68`.

Explicit optimized throughput, compiled Help parity, source commit, installer extraction/runtime/hash/upgrade validation and publication receipts will be appended here. Keep2.0.55 installers for rollback. All build-producing tests precede the final installer build; no installation is part of validation.
