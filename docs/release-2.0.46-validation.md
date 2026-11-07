# PhotoGoGo 2.0.46 — automatic AKP03E controller

## Approved behaviour

Full app-managed AKP03E integration replaces the need to configure vendor scenes/hotkeys. The user explicitly authorised stopping the AJAZZ controller application at takeover and will restart it manually. Two bounded helpers were approved for frontend implementation and independent protocol/process/input review. No goal automation was created.

The exact detected model and an exclusive PhotoGoGo lease precede takeover. Only a held, verified `Stream Dock AJAZZ.exe` process in this Windows session can be terminated; no wildcard or tree kill is used. Release, disabled automation, stale generations and shutdown fence a takeover. AJAZZ reappearance blocks forwarding and releases the USB session rather than repeatedly killing the app.

The native worker owns all HID reads/writes, uses raw AKP03E press packets, finite read timeouts and bounded JPEGs, and repaints only changed faces. Active client/session/display revisions, one pending action, post-ACK input draining and layout expiry prevent delayed presses from acting on a different photo. Preferences and diagnostics live outside staging. There is no TCP bridge, global keyboard injection, firmware write, boot-logo replacement or automatic AJAZZ restart.

The frontend supplies live six-key artwork, dials/side buttons, automatic-mode and brightness controls, a mirror, and current task layouts for Home, Lightbox Review/Versions/Inspect, RAW Development, cropping and Snapshots. Existing save, source-identity, exact-version and modal guards remain in the command paths. The old manual hotkey pack is explicitly optional legacy material.

## Validation checkpoint

- Full native suite passed **368 tests, zero failed**, with 29 opt-in tests ignored in the ordinary run. Eleven new controller tests exercise raw repeated presses, safe process-name filtering, actual native admission/ack/client/timeout helpers, decoded-artwork limits and the exclusive lease. The final focused rerun passed all eleven after the last takeover/reappearance checks. Preference publication/corruption checks remain in the full suite.
- Frontend controller runtime/router/artwork: **13 checks passed**, including client claim before publication, old-owner/reload/session fences, status/configuration races, stale layouts, bounded acceleration and acknowledgement/error behaviour.
- Controller panel browser: **five groups passed**, with six actual 60 × 60 JPEG frames, all control types, keyboard/range defaults, release/retry and desktop/360-pixel focus/layout checks.
- Actual Lightbox/controller browser: **18 groups passed** (14 retained plus four managed-controller groups), covering deferred rating save-before-next, exact Versions selection, one deferred crop Apply and mirror keyboard/focus safety.
- Existing regressions passed: RAW Development **13 groups**, Lightbox/crop **13 groups**, Video Snapshots **nine checks**. TypeScript passed. Browser tests use production React components with deterministic IPC; they do not establish physical USB operation.
- Independent review verified the exact cached SDK source, including its raw press semantics and display transforms, held-handle process checks, cancellation fences, device ownership, changed-face display updates, source licences and shared helper tests. Source review is separate from executed tests.

The first browser launches could not import a locally installed Playwright; the available bundled runtime was selected without adding a test dependency. A controller-mirror fixture trigger initially sat outside its scroll area because test-only Tailwind classes were not generated; explicit fixture positioning fixed it and the complete suite was rerun. Those infrastructure failures are retained in logs and are not represented as passing runs.

Evidence lives under `test-output/controller-unit/`, `controller-browser/`, `lightbox-controls-browser/` and `test-output/akp03e-*.log`. No user media, Google account, physical controller or live vendor process was modified in development. Read-only device inventory found no matching controller on the development PC.

## Source and packaging

Application version is 2.0.46. New locked packages are `ajazz-sdk 0.2.1` and `hidapi 2.6.7`; the direct Base64 dependency already existed transitively. Other dependencies were not updated. The exact unmodified source archives and original notices are included in `resources/controller-source`; the build and installer inspectors validate their pinned registry checksums. Existing FFmpeg, ExifTool and RAW engine bundles are unchanged.

Built-source and package/delivery receipts are added after validation completes. Physical acceptance remains pending: six-key image position/orientation, every repeated press, three side buttons and all encoder turns/presses, live state, reconnect/Release and manual vendor restart. The pinned SDK's orientation differs from an independent implementation, so no physical orientation claim is made. See [the controller guide](akp03e-controller.md).

Unrelated cleanup scripts and JSON summaries present before this feature are left untouched. The other worktrees, including subject finishing, are outside this feature's scope.
