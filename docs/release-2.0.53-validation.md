# PhotoGoGo 2.0.53 validation and publication

Status: source validation passed; installers and publication not yet complete.

## Final scope

- JPEG-first Lightbox labels and sizes for verified camera pairs, with a RAW badge and per-photo development. Canonical RAW paths/stamps and exact JPEG upload/tag targets are preserved. Filename and size sorting follow the visible JPEG.
- Mixed camera-JPEG folders hide unpaired RAW rows by default, including during capture checks. A counted Show unpaired RAW files control reveals them. RAW-only folders remain accessible automatically, including when they contain owned developed JPEGs. No filename-only pairing, media changes or relaxed native checks.
- Positive historical ratings, Trash and saved Google selection/favourite flags count as Reviewed only when no explicit decision exists. Valid explicit canonical records win; an absent canonical record may use a valid record on its proven camera JPEG. Manual false wins; stale, invalid, unreadable and ambiguous records remain uncertain. Physical neutral-key counts include related versions. No bulk sidecar migration.
- Canonical evidence drives filters, badge and M independent of the displayed source. Failed secondary writes remain pinned. Retry Reviewed explicitly writes true, and Retry Needs review preserves a failed manual false, without replaying a primary action or advancing; M retains its manual toggle behavior.
- Updated illustrated offline and portable user guide. Existing processing and Google upload routines are unchanged.

## Verified checks

- Focused unit regression reproduced the original 888 All / 888 Needs review / 588 Google-selected counts before the fix; now 888 / 300 / 588. It also covers explicit false, stale and unreadable metadata, pre-pair JPEG choices, canonical identity, ambiguous flags, RAW-only/mixed visibility, visible sorting and failed-save pins.
- Native suite: 416 passed, 0 failed, 30 opt-in media/hardware cases ignored (446 total), serial runner. No user media, live Google upload, controller or render-PC changes.
- Actual-page browser suites passed: JPEG-first 10; RAW 9; per-photo RAW workflow 7; first preview 16; browse 11; automatic review 13; controls/controller 21; selection/transfer barriers 11; existing Lightbox 13. Automatic-review cases include positive retry, M clear after a redundant save failure, and a failed manual clear retrying false. Catalogue/cache 20, command map 7, review queue 7 and curation queue 4 groups also pass. Help host 7, actual-page/capture 5 and portable document 7 groups passed. Production TypeScript/Vite build passed; only existing Browserslist age and chunk-size advisories remain. Final package evidence follows below. The 700-file delayed-metadata fixture paints its selected JPEG in 292 ms while inspection remains held; this is a local synthetic regression measurement, not a target storage or NAS throughput claim.
- Illustrations were visually inspected and use synthetic demonstration artwork. No user photographs or account data are packaged in the guide.

## Rollback and target acceptance

Keep 2.0.52 installers available. This release recognises history at read time and does not rewrite metadata in bulk; existing explicit records retain their meaning. On the target folder, open Needs review after capture checks complete, compare All/Google-selected/Needs review counts, inspect one old selected JPEG, manually clear and restore Reviewed, and open RAW only for a chosen photograph. Hidden unpaired RAW rows and uncertain identities can affect counts and remain discoverable through their notices.

Package hashes, source commit, installer inspection, remote integration and verified #swghermes delivery will be appended after the build.
