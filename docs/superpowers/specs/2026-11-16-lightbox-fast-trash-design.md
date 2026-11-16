# Fast Lightbox culling, history and Take out the trash

Status: approved by Stuart on16November2026, including paired CR3 removal, two bounded helpers, validation and test release. Implemented; final validation and delivery evidence is maintained in ../../release-2.0.56-validation.md.

## Intent and agreed decisions

Stuart wants to review originals rapidly before Enhanced/B&W processing, reject unwanted captures without waiting for folder rescans, undo/redo mistakes through a retained history, and later permanently remove discarded files through the existing Jobs system.

Confirmed on 16 November 2026: trashing a capture includes its Camera JPEG and paired CR3, as well as its generated versions. A CR3 is an original, not a derivative. The deletion preview must call it out explicitly.

## Existing behavior verified in 2.0.55

- `src/hooks/useReview.ts` changes the JPEG review anchor's filename, waits for Reviewed persistence and refreshes the tree before advancing. A paired RAW keeps its separate physical identity.
- `src/utils/lightboxCommands.ts` already defines Delete for Trash toggle and X for Trash + next. Keyboard, mouse and controller share the command vocabulary.
- `src/utils/lightboxCache.ts` already provides bounded full-resolution read-ahead; reuse it and prioritize the next visible original.
- `src-tauri/src/commands/lightbox_review.rs` persists explicit Reviewed decisions separately from strict Google curation. Preserve that separation.
- `collect_jpgs` in `src-tauri/src/commands/process.rs`, used for Enhance/BW, does not explicitly exclude the Trash marker. Add and test the exclusion.
- The existing catalogue, RAW manifests and archive planner provide association rules and exact-file identity checks. Reuse these without weakening them for deletion.

## Approaches considered

1. Keep the existing synchronous rename/rescan and add an Undo button. Smallest change, but fails the requested responsiveness and complete decision history.
2. Recommended: immediate visual decisions backed by an ordered durable save/history service; a separate reviewed permanent-removal job. Preserves existing filename compatibility while removing full-tree refresh from each decision.
3. Move files into a quarantine folder or Windows Recycle Bin. Can retain file-recovery options, but uses storage until emptied and is inconsistent across storage types. Not the default for the requested permanent-removal job.

## 1. Review interaction

Trash means reject the capture, including both verified camera originals. Mouse, X/Delete and the AJAZZ Trash action use the same command and automatically advance to the next photo in the current visible ordering. In an explicit Trash-only view, the available action is Restore; restoring advances within that view. Avoid ambiguous toggle-plus-next behavior.

Update the visible catalogue locally and show the next prefetched original immediately. Do not wait for derivative loading, folder inspection or a whole-tree refresh. Maintain exact selection identity so rapid input cannot target a photo that has not yet become the displayed actionable capture. Ignore held-key repeats for Trash and bound pending writes rather than accepting unlimited actions.

Honor folder, sort and filter scope. Do not navigate to hidden RAW companions or generated variants. At the end, show Review complete rather than wrapping. Keep the next original prioritized in the existing bounded cache, with no full-resolution thumbnail substitution.

Show Saving N decisions / All changes saved and a persistent per-photo failure queue with Retry. Never present unsaved decisions as confirmed. A save failure must retain the rejected photo's identity and error even after the user has advanced; pause further mutations if ordering or identity is uncertain. Switching folders/settings or closing the app must account for pending writes.

## 2. Ordered persistence and history

Retain existing compatible filename tags for interoperability. Introduce an app-owned review action journal with recoverable intent/result records, exact capture identities and revisions, using the established metadata/locking conventions. Avoid a full folder scan, image hash or unbounded metadata rewrite on the keypress path.

Store confirmed history with the staging review metadata so it is available after restarting or revisiting the folder. Register it as application metadata for archive filtering. Paginate history and compact its storage without silently discarding confirmed user history. Bound the live save queue, not the total history to a single action.

For each Trash/Restore action store before/after Trash and Reviewed state, physical capture membership, identity evidence and save outcome. Marking Trash also marks Reviewed. Undo restores the prior values changed by that action, preserving unrelated ratings and Google selections. Do not pretend a partially completed rename/metadata save was atomic: recover or report it explicitly.

Undo/Redo buttons and Ctrl+Z, Ctrl+Y/Ctrl+Shift+Z operate outside text/edit controls only; controller bindings use direct app commands. Undo brings the affected original into view even if its restored status no longer matches the current filter, with a clear temporary explanation. Redo reapplies the action. A new decision after Undo clears that redo branch while retaining its audit entries.

History covers Trash/Restore and their coupled Reviewed change for this scope. It is structured for later review actions but does not silently expand into undoing other editing or transfer workflows. A changed/replaced source must block an unsafe replay. Pending Trash followed quickly by Undo must resolve in order to the correct final state.

Permanent deletion is an explicit history boundary for those files. Retain the history entry and deletion receipt, label the file Permanently removed, and disable impossible restore/redo actions. Other captures' history remains usable.

## 3. Processing eligibility

Enhanced and B&W skip trashed captures and their crop inputs by default, regardless of whether the paired RAW itself has a filename tag. RAW development follows the same capture decision. Show included/excluded counts before creating jobs.

Preparing processing/deletion plans waits for pending review writes to settle. Existing/frozen jobs revalidate source identity and Trash eligibility when starting each capture; a concurrent Trash decision cannot cause a deleted file to be processed or a new derivative to appear behind the removal job. Reuse per-capture access coordination, with precise protected/skipped outcomes instead of stopping unrelated jobs.

## 4. Take out the trash

Expose an action from Lightbox, backed by the existing core Jobs architecture. Default scope is the selected folder; including subfolders is explicit. Preview an exact file list, capture counts, confirmed file bytes, and protected/ambiguous cases before confirmation.

For each marked capture include:

- Camera JPEG and verified paired CR3; RAW-only originals are supported too.
- Associated B&W, Enhanced, crops, crop variants, and manifest-owned RAW developments/versions.
- Precisely owned per-file checksum/recipe sidecars where appropriate.

Do not use broad prefix deletion or guess between several possible source/derivative owners. Ambiguous matches remain protected and visible. Never delete outside the selected staging scope, follow links/reparse points into another tree, remove whole directories recursively, or remove shared folder metadata just because one capture is trashed.

The confirmation explicitly states that JPEG + CR3 originals and listed generated versions will be permanently removed and that decision Undo cannot recover deleted bytes. No automatic deletion during review and no scheduled emptying.

At execution, revalidate the preview revision, Trash decision, exact identities and active-use protections. If a capture was restored, modified, replaced or is being used by another job, protect it with a reason. Revalidate remaining members after restart; stale plans cannot authorize new files. Freeze the ownership list rather than discovering extra candidates during removal.

Use a resumable per-file journal. Remove verified derivatives first and source originals last. File-family deletion is not one filesystem transaction: record partial success honestly, retain surviving originals and report failures/locks. Cancel at safe boundaries. Progress/history show removed, already absent, protected and failed files separately; count confirmed removed file bytes without promising exact physical free-space changes.

Retain Google duplicate-prevention and uncertain-outcome receipts. Pending transfers must be protected or visibly invalidated through existing source-validation rules, never reported as successful. This job removes local staging files; Google Photos albums, SD-card files and archive copies are outside its scope.

## 5. Deliberate discard and re-import

Retain a compact deletion receipt with verified import-compatible content fingerprints so the next SD-card import can recognize intentionally discarded captures. Reuse trusted prior checksums where valid; otherwise compute during the removal job, not on the Lightbox keypress path. Same-name/different-content files must remain distinct.

Approved default: previously discarded identical captures are skipped with an explicit count and a deliberate re-import override. Restoring a not-yet-deleted capture invalidates its frozen removal approval. Do not remove import verification or treat filename/timestamp alone as proof.

## Scope and delivery constraints

- Extend the existing React/Rust/Tauri application and core Jobs architecture. Prefer existing dependencies.
- Preserve JPEG-first browsing, optional RAW development, exact-file Google selections and existing naming behavior.
- Implement on a separate SWG feature branch with other worktrees and unrelated files preserved.
- Development and deletion tests use synthetic fixtures only; no user photos, Google accounts, live transfers or target-PC installation.
- Approved helpers: one bounded UI/history implementer and one independent native identity/deletion/concurrency reviewer. Root owns integration and native removal/processing/import rules.
- Approved completion: validate, commit/merge, build and inspect both installer formats, update Help and deliver one test release to Personal #swghermes with read-back and rollback retained.

## Acceptance checks

1. Rapid reject/undo/redo over 700+ synthetic originals; visual update does not await native persistence or full-tree scans. Measure response distributions separately from next-image decode; target under 50 ms for cached visual state on the development fixture, report actual measurements rather than promise target hardware timing.
2. Visible-order navigation covers filters, sorts, final image, RAW pairs, RAW-only folders, crop views, delayed pairing and unavailable derivatives.
3. Save failure, rapid Undo before save completion, restart during each journal stage, folder/settings changes and source replacement preserve intent and exact identity.
4. Existing ratings, explicit Reviewed overrides and Google selections survive Trash/Undo/Restore unchanged except the coupled Reviewed transition.
5. Trash excludes whole captures from Enhanced/B&W/RAW processing; pending decisions settle before planning; concurrent processing/removal cannot create stale outputs or delete active sources.
6. Removal includes JPEG + paired CR3 and all proven derivatives, handles different review-tag names, and protects same-stem unrelated/ambiguous files, links, changed files and active work.
7. Cancellation, locked-file and disk-full failures, partial removal, restart/resume and duplicate attempts produce truthful durable outcomes. No folder-wide destructive fallback.
8. History after deletion clearly prevents impossible recovery while preserving unaffected undo/redo entries. Re-import tests distinguish discarded identical content from new content and exercise the explicit override.
9. Run appropriate native and browser regressions, visual checks, Help checks and installer extraction/runtime/hash/upgrade checks before a release claim. No build-producing tests after final packaging before parity inspection.

## Blue-team verdict

Proceed with the two-stage design. The gain is a fast cull-before-process workflow with recoverable review decisions and explicit disk reclamation. The main risks are optimistic-save ordering, permanent-deletion boundaries and JPEG/RAW/derivative identity. Keep the deletion surface narrow, preserve an inspectable journal and refuse ambiguous ownership. Recycle Bin/quarantine remains an alternative if recoverable byte-level deletion becomes a requirement.
