# User guide maintenance

Content: `docs/USER_GUIDE.md`. The 18 stable chapter IDs are shared by the app's contextual help and standalone guide. Update this source when a workflow changes.

Run `npm run guide:build` to regenerate the two byte-identical self-contained HTML editions and `public/help/manifest.json`. The normal app build also runs this step. Node built-ins only; no new runtime dependency. The portable filename follows the package version. Vite copies `public/help` into the production frontend, which Tauri embeds.

## Illustrations

`source/figures.json` specifies chapter, caption, alternative text and asset filename. SVG diagrams and demo artwork are original editable artwork. `scripts/create-guide-illustrations.mjs` regenerates the six workflow diagrams. PNG dimensions are read from their headers at build time. All figures are embedded as data URLs; no internet or workstation paths are required.

Screenshots show real application components with isolated synthetic native adapters. They contain no private media, filesystem access or Google accounts. The illustrative horse/rider artwork replaces only the fixture's displayed demo media during capture; it does not claim a calibrated photo-processing result. Numbered callouts are temporary capture overlays. Test-only Help buttons and controller overlays are hidden before capture.

To recreate with the existing Playwright development dependency:

```
node scripts/test-user-guide-browser.mjs --capture
node scripts/test-user-guide-pages.mjs --capture
npm run guide:build
node scripts/test-user-guide-document.mjs
```

The tests also accept `PHOTOGOGO_PLAYWRIGHT_PATH` for a bundled Playwright module. Browser fixture entry files are not production build entry points. Guide HTML must not receive `allow-same-origin` or native privileges. Keep frame messages source-checked and schema-limited. External references open only from the fixed host allowlist.
