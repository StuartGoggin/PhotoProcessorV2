# JPEG-first Lightbox and historical review recognition

Approved scope: deliver 2.0.53, validate identity and transition safety, commit/integrate and publish installers to #swghermes. Two bounded helpers cover browser transitions and independent identity safety.

## Design and risk decisions

- Keep canonical physical RAW identities for verified pairs. Present the camera JPEG filename/size in the tree; show RAW availability and keep per-photo RAW development. No filename-only pairing or changes to native capture verification.
- Hide unpaired RAW rows in mixed camera-JPEG folders by default, including while native checks run. Offer an explicit counted Show unpaired RAW files control. RAW-only folders remain visible automatically. Derived JPEG outputs do not define a mixed folder. Failed-save targets remain pinned.
- Recognise positive historical ratings, Trash and Google selection/favourite flags at read time. Valid explicit canonical Reviewed records take precedence; an absent canonical record may use a valid proven camera-JPEG record. Explicit false wins; stale, invalid, unreadable or ambiguous data remains unknown. No bulk metadata migration.
- Evaluate evidence on the full canonical capture, independent of the displayed finish. Count physical keys once per loaded folder, deduplicating exact paths, so ambiguous child selection flags cannot establish Reviewed.
- Sort by the displayed JPEG name/size while preserving physical paths as deterministic tie-breakers. All media, Google selections and processing ownership remain unchanged.

## Execution and acceptance

1. Lock down the observed 888/888/588 failure, explicit-false precedence, stale data and pairing projection in focused regressions before implementation.
2. Implement the presentation seam, canonical review evidence, RAW disclosure and compact explanatory UI.
3. Exercise the real Review page with delayed metadata, RAW-only/mixed folders, source switching, exact save targets and root transitions. Re-run affected Lightbox and guide regressions; no live Google uploads or user-media mutations.
4. Update the illustrated guide and release version; run production build, native suite and compiled asset parity. Have the independent reviewer inspect the final diff.
5. Commit source, build both installers, extract/inspect them without installation, verify hashes, integrate master/feature/tag, publish GitHub assets and a new verified Slack release post with installer links.

Rollback: preserve the 2.0.52 installers. The read-time compatibility behavior writes nothing until a user decision; existing explicit records and selections remain valid in 2.0.52. Stop for an unresolved identity/overwrite defect or failed validation, repair narrowly, and do not publish failing artifacts.
