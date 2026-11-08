# Per-photo RAW alternative implementation plan

> For agentic workers: execute the approved design in bounded tasks; preserve the existing RAW engine and core Jobs.

**Goal:** Keep camera JPEG review intact while offering explicit, full-resolution RAW development and a saved viewing choice for each verified capture.

**Architecture:** Retain conservative native capture pairing and source-specific output lineage. Embed the existing RAW editor for exactly one CR3. Store an optional viewing preference in existing portable RAW metadata, with its own source admission stamp; it does not select upload files or change a recipe. The verified camera JPEG remains the review-decision anchor for a pair, regardless of displayed finish; RAW-only captures retain their RAW anchor.

**Boundaries:** No implicit development, basename pairing, original replacement, automatic upload selection, crop transfer, new dependencies or live Google operations. Conflicting old JPEG/RAW review tags remain intact and visible; no mass migration. Native transfer/archive policy and RAW batch filters use the same verified JPEG review anchor; existing selection modes remain. New choices must survive rating tags and event-folder moves and be rejected when source identity becomes stale.

- [x] Add failing native preference identity/lineage tests and production-component browser tests for per-photo choices, JPEG decisions, exact editor target and upload isolation.
- [x] Add bounded preference persistence and conservative tree annotation using existing metadata and locks; protect preference-only records from identity-breaking moves.
- [x] Replace global viewing preference with per-photo choices; preserve exact file targets and JPEG review decisions.
- [x] Embed existing RAW editor, scoped to one CR3, with dirty/busy close barriers, explicit queueing and a refresh-results action.
- [ ] Run focused and full native/frontend regressions, independent safety review and actual RAW/package smoke checks.
- [ ] Commit, merge with current upstream, build the next unused version, inspect both installers, push/tag and deliver to Personal #swghermes with read-back receipts.

**Validation:** Unchanged source hashes; exact one-photo job selection; no decode on browsing; independent colour/B&W pipeline retained; pending selection writes fenced; missing/changed lineage fails conservatively; saved choices do not alter Google flags; source-specific crops remain isolated. Existing import and per-item upload recovery fixes are included in this release.

**Release boundary:** Local controlled tests establish software behavior. Large-folder timing and live Google account recovery still require Stuart's target-PC retest. Preserve the prior installer for rollback.
