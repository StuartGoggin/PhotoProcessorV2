# PhotoGoGo 2.0.41 — Responsive Lightbox selections

Google Photos checkboxes and favourites now display requested changes immediately while local saves run in order. They show Saving until the native write is acknowledged. Changing a checkbox does not contact Google Photos or upload media.

## Diagnosis and change

The old controlled checkbox waited for google_photos_set_selection to return a complete catalogue. Its native operation scanned the whole library before and after each write and enriched cloud history. The UI also blocked competing checkbox input for that entire operation. A generated delayed-save reproduction remained unchecked at 107ms and changed only after its save at 1,045ms.

The new google_photos_update_selection validates the supplied root, native asset ID and exact relative path against a shallow catalogue of only its containing folder, retaining the original canonical library root for identity. It preserves existing association/ambiguity rules, rejects traversal and linked paths, holds the folder lease through the bounded read/modify/atomic write, and returns a compact receipt. It does not rescan unrelated folders or read account/upload history. The legacy command remains compatible.

Confirmed flags and queued requested flags are separate. Native responses update the confirmed base; newer requested values remain overlaid. Keyboard and mouse toggles consult the latest requested value. Requests capture root, ID, path and explicit changed fields; receipts must match the exact identity and valid flag types. Independent checkbox/favourite failures retain their own recovery notices. A newer successful favourite cannot erase an earlier failed checkbox save.

The in-memory FIFO accepts at most 256 writes, continues accepted writes after leaving Lightbox and retains at most 64 failed-field notices. Initial/reopened catalogues wait for accepted writes. Reload selections reads confirmed disk state and deliberately clears notices, including when another scan supersedes its first attempt. This is UI persistence plumbing, not a second durable job tracker.

Browsing, rating, trash, crop and refresh wait for pending selections. Other checkbox/favourite and inspection controls remain responsive. Select and next still waits for its own native acknowledgement and pinned Review context. Google Photos and archive preview consumers share a settlement barrier and recheck their root/generation/request signature before native planning; unresolved selection failures block stale plans.

The new concurrency test exposed a pre-existing Windows lock retry mismatch. Retry now also recognises fs2::lock_contended_error(), as defined by the installed fs2 0.4.3 implementation, preserving the existing three-second deadline and atomic writer.

## Measurement and validation

Generated fixture: 803 images in the library, 3 in the selected folder, three repetitions per implementation. Median native scan/save time was 2,190.194ms for the legacy path versus 26.717ms for the targeted path (about 82 times faster on this fixture). This excludes IPC and protected history enrichment and is not a deployment-machine speed guarantee. Work remains proportional to the selected folder rather than constant time.

The React regression holds native writes pending and confirms the checkbox paints in two animation frames, remains enabled, reports Saving and does not invoke a full-catalogue IPC per click. Final measured paint time is recorded below from the browser report. Rapid same-frame keyboard and favourite-button toggles, independent versions, failed-field recovery, older acknowledgements, root changes, exact-ack Select and next, superseded Reload and transfer-preview barriers pass.

- 322 native tests passed; zero failures; 23 existing opt-in tests ignored. Eight new native tests cover root/nested/crop identity parity, partial flags, stale paths/IDs/traversal, duplicate tags, corrupt sidecar isolation, concurrent writers, Windows junction containment and bounded scope/timing.
- 11 new selection browser groups, 14 existing controls groups, 13 legacy Lightbox groups, 15 Google Photos groups and 10 archive groups passed (63 groups). New fixture reports no runtime exceptions.
- Four queue boundary checks, seven command checks, fifteen catalogue/cache tests and TypeScript passed. Independent read-only review findings were corrected and covered by targeted regressions.

Evidence: test-output/lightbox-selection-browser/report.json; test-output/lightbox-selection-native/report.json; test-output/lightbox-selection-native/checkbox-native-benchmark.log and existing browser reports. Functional native source was verified before the release-only version bump. Production build and installer receipts follow packaging.

## Deployment and rollback

Install either package only while no PhotoGoGo jobs are active. Test rapid Q/W/E checkbox toggles and Shift+Q/W/E favourites, check Saving transitions to Saved and reopen the folder to confirm persistence. Test G only advances after saving. Transfer previews should include the latest confirmed selections.

Keep PhotoGoGo open until Saving finishes. Accepted queue entries survive leaving Lightbox, but the in-memory queue cannot survive application/process shutdown. The UI and help explicitly say to wait before closing. Save failures restore confirmed state and remain visible; retry the affected field or deliberately Reload selections. A failed/unconfirmed acknowledgement is not represented as a completed save.

No dependency, metadata schema, credentials, upload-job architecture, controller hotkey or driver changes. Existing selections and the 2.0.40 controller map remain compatible. The 2.0.40 installers remain available for rollback. No user photos, live Google accounts or render-PC settings were changed in validation.
Final browser paint measurement: 40.4ms (two-animation-frame observation with native acknowledgement deliberately withheld).
Native harness SHA-256: 4CFC12B2502BCD1D8123F39CFE528F2361023F0191CBC2F8E3F5E65E19FA8B95.
