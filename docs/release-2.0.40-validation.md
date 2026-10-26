# PhotoGoGo 2.0.40 — Photo Lightbox keyboard and controller review

This release adds a shared Photo Lightbox command map, larger selection controls and a manual AJAZZ AKP03E setup pack. The existing Google Photos curation and core archive rules continue to own the same saved version selections.

## User workflow

- Open Photo Lightbox and select an original. The three comparison panels retain independent Google Photos checkboxes and favourites, with 24px checkboxes and at least 44px targets.
- Press F1 or ? (or Keys & controller) for full-screen, searchable keyboard, crop and AKP03E help. The cyan Active border shows the version targeted by A and G.
- Left/Right browse originals. 1/2/3 rate; Shift+1/2/3 save that rating then advance. X marks trash and advances without deleting a file. G explicitly selects the active version then advances; a failed save never advances.
- Q/W/E toggle exact Original/B&W/Enhanced selections; Shift+Q/W/E toggle their favourites. Cropped view uses the cropped versions. Missing versions are not substituted.
- Use [ and ] for active panel, +/− for zoom, Shift+arrows to pan, and 0 to fit/reset. C opens crop; V changes original/cropped view. The crop editor uses Ctrl+Enter to apply, normal focused-control activation, and arrow/Shift+arrow handle nudges.
- Save operations pin root/photo/version, serialize mouse and keyboard mutations, suppress held mutation keys and require actual image display readiness. Fast navigation ignores stale reads. Folder refresh follows a newer navigation instead of snapping back.

Controller setup: [Photo Lightbox guide](lightbox-controls.md) and public/controller/ajazz-akp03e/README.md. The release ZIP contains six SVG/PNG button icons and a machine-readable reference keymap generated from the app command registry. It is a manual setup reference, not a vendor-importable profile. No driver, firmware, SDK or new dependency is added.

## Safety corrections

Rating/trash rename now refuses to replace an existing target photo and validates the new basename. Both files remain intact on a collision. Favourite-only native updates preserve upload selection; selection-only updates preserve favourite. Existing saved curation files and credentials need no migration.

## Validation

- 314 native tests passed, zero failures; 23 pre-existing opt-in tests ignored. This includes five file-rename safety regressions and a partial-curation update regression, plus the existing archive and Google Photos tests.
- Shared command matching: 7 checks; catalogue/cache: 15 tests; Google Photos utility: 4 tests.
- Real React browser checks with synthetic IPC: 14 new control groups, 13 legacy Lightbox groups, 15 Google Photos groups and 10 archive groups. Tests cover delayed/failing saves, filename collision, held keys, rapid/stale frame reads, root changes, exact cropped/version targeting, typing/tree/modal scopes, crop controls, help focus and 720px layout.
- TypeScript and independent read-only safety review passed. Screenshots at 1360px and 720px were inspected.

Functional native source was tested before the release-only version bump. Native harness SHA-256: 4062CE35AA4FB9B4283360C2EEEEDC9ADC897F08BEF165556C8F654A1B0A2DB2. Evidence is in test-output/lightbox-controls-native, test-output/lightbox-controls-browser and the existing browser reports. The completed native test harness was retained before reclaiming only its generated debug build cache.

No user media, Google account, active render, installed controller configuration or firmware was changed. Physical AKP03E acceptance and deployment remain with Stuart.

## Deployment and rollback

Install either the EXE or MSI when PhotoGoGo has no active jobs. Test on a small event: select each version, try a favourite, rate/save/next, mark trash/save/next and reopen help. Configure AKP03E Hotkey actions using the guide, then check one button and all three dial directions/presses against the on-screen target. Avoid timed multi-action macros; the app owns save-and-next acknowledgement.

The 2.0.39 installers remain available for rollback. This release uses the existing metadata format and preserves prior selection flags. It does not rename or delete files merely by installing. Managed FFmpeg and metadata runtimes are unchanged. Installer, GitHub and Slack receipts follow packaging.
