# Import transfer priority: local validation

Validated on 2026-10-04 against the working tree based on `18c01773634ed3156d56e8012d6fefb2029b5789` (application version remains 2.0.28).

## Approved changes

- Timeline video motion previews default off for new and legacy settings, with an explicit saved Settings toggle. Existing sidecars and original media are retained.
- Imports and cleanup do not launch optional preview workers. Native preview entry points enforce the saved opt-in, and optional background generation/prewarming yields to queued, running or paused imports.
- One sequential source reader per physical card overlaps the next source copy with independent destination verification/publication. The rendezvous handoff bounds unpublished staging to two files per card, up to eight across four admitted cards; it is not a byte quota.
- Existing streaming MD5, independent destination MD5, duplicate checks, cancellation, source admission/session lifetime and no-overwrite publication remain in place. Reprocessing retains its existing scheduling policy.

## Evidence

- Native library suite: **162 passed, 0 failed, 20 ignored**. Ignored entries include opt-in media/GUI smoke tests and a subprocess probe executed by its parent test; they are not counted as suite passes.
- Focused native import suite: **43 passed, 0 failed, 1 child-probe entry ignored**.
- Standalone pipeline/safety suite: **26 passed, 0 failed, 2 child-only probe entries ignored**. Parent tests explicitly execute and assert the panic probes with bounded deadlines.
- Import UI/model suite: **10 passed**.
- Browser regression: legacy default-off, disabled preview controls, no import-side preview work, hover opt-out, saved opt-in/out and retained settings all passed using mocked native calls. Settings screenshot visually inspected at `test-output/timeline-preview/settings-default-off.png`.
- TypeScript checking and production frontend build passed. Existing non-blocking Browserslist-age and bundle-size warnings remain.
- Independent bounded read-only safety review found no new production blocker.

The overlap regression first failed against a sequential implementation (`next copy did not overlap verification`), then passed against the bounded production pipeline. A native integration test uses streaming and independently verified destination MD5 with a handshake to prove real copy/verification overlap, duplicate skipping, intact source bytes and temporary cleanup.

The standalone runner's intermittent null exit-status false negative was fixed by owning the process from launch through completion, draining redirected output asynchronously and retaining the exact-process deadline. The final rerun returned exit 0 with all 26 tests passing. Generated receipts are under `test-output/import-pipeline/`.

## Limits and next acceptance

No physical SD card, reader or private media was used. These results prove bounded overlap and safeguards, not a particular MB/s or wall-time improvement. Destination contention, card/reader bandwidth and duplicate verification can still limit throughput. Already-running preview encodes finish naturally; independent enabled preview workers are not globally serialized.

Use the unchanged-media, fresh-staging-folder before/after procedure in `docs/device-aware-imports.md` for hardware acceptance. No installer was packaged, nothing was installed or published, and no commit/push was performed in this scope. Pre-existing unrelated changes in `scripts/test-video-studio.ps1` and `assets/` were left untouched.

## Repeat checks

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import.ps1 -Native
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-import-pipeline.ps1
node scripts/test-import-ui.mjs
node scripts/test-timeline-preview-browser.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

The browser check can use an already installed Playwright runtime via `PHOTOGOGO_PLAYWRIGHT_PATH`; no dependency installation was performed for this validation.
