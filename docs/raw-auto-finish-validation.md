# RAW Auto finish and first-open validation

Date: 2026-10-28. Candidate release: 2.0.43. Scope: faster folder/RAW discovery and optional brighter RAW development, preserving source bytes, portable recipes, exact-version selection and existing branches. Installer/release receipts are recorded separately after packaging.

## Startup evidence

The unchanged ignored `startup_open_latency_budget` recreates eight event folders / sixteen files from one explicitly supplied CR3 and an owned camera-JPEG fixture. It does not scan the user's library or flush the OS cache. The old mixed-folder path launched eight metadata processes while constructing the first tree: 11,014 ms cold, 18 ms warm. A separate pre-fix run measured 4,833 ms / 32 ms. RAW-only folders took 16 ms, identifying capture probing rather than basic enumeration as the dominant regression. RAW candidate discovery separately hashed 201,455,815 bundled-runtime bytes before listing.

The final local run returned the first mixed tree in **42 ms**, warm 36 ms, with **zero metadata processes**. Selecting one folder took 820 ms / one metadata process; repeating that folder reused the successful token reads without another process. RAW discovery took 44 ms, warm 39 ms, hashing **zero runtime bytes** before the list. Both original sub-second first-list thresholds passed. A prior post-fix run measured 23/23 ms and 17/18 ms respectively. These are local process-cold timings, not deployment-PC or large-library guarantees.

Generic tree construction now reads filenames and ownership manifests. Capture proof is deferred to the selected/opened folder, runs off the UI thread, uses bounded single-flight metadata batches, and caches successful reads only after file stat revalidation. Runtime file presence is sufficient for discovery; complete runtime integrity verification remains before preview/export and in render-cache identities. Transfer retains its full-library scan; Lightbox curation uses only the selected containing folder while keeping the full canonical library root for asset IDs.

## RAW look evidence

The exact packaged RawTherapee 5.13 `procparams.cc` and `simpleprocess.cc` were reviewed. Auto levels recalculates exposure/brightness/contrast/black/highlight controls. The new look therefore applies its adjustable Lab brightness/contrast and colour vibrance downstream of automatic exposure, plus bounded edge sharpening. It does not interpolate the automatic exposure estimate or add clarity/dehaze. The first positive slider step can jump from recorded/manual exposure to the automatic baseline.

`raw_auto_finish_quality` performed five independent full RAW exports for each of two supplied R6 Mark II originals. Each export passed full-dimension, metadata/ICC and original-hash checks. Final outputs were 6014 × 4016. Display-luminance measurements use a rendered 512-pixel thumbnail; these are not sensor exposure/RAW clipping measurements.

| Source | Manual / Off | Legacy Auto levels | Strength 25 | Strength 65 | Strength 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20261024_111624 | 91.93 | 129.05 | 133.70 | 140.86 | 146.87 |
| 20261024_111630 | 73.76 | 122.46 | 127.39 | 134.98 | 141.39 |

All ten display histograms reported 0% pixels with all channels >=252. Visual inspection covered 1600-pixel overviews and native-pixel detail: brighter subject/midtones, white cloth texture and smooth background blur were retained on these overcast samples. Typical complete export-plus-validation was 8–12 seconds locally. This is not calibrated colour validation, a promise of focus recovery, a subject mask or universal photographic acceptance. Bright sun, actual high ISO, C-RAW/crop modes and actual portrait originals still require representative samples.

## Regression and review evidence

- Native suite: **336 passed, 0 failed, 28 opt-in tests ignored** in the ordinary suite. The startup benchmark and two real-file Auto finish runs were explicitly executed separately.
- Browser suites: **97 groups passed** across Lightbox 13, exact selection 11, controls 14, RAW Lightbox 8, RAW Development 13, Photo Process 13, Google Photos 15 and archive 10. Synthetic adapters use no Google account or user-media writes.
- Catalogue/cache/recipe units: 20 passed. Keymap checks: 7 passed. Curation persistence boundary checks: 4 passed. TypeScript passed.
- New delayed-response cases verify first-list independence, per-folder coalescing, exact clicked-JPEG ownership after deferred pairing, generic-refresh replacement during a newer JPEG pick, and successful retry of incomplete metadata. No action is permitted against an unreconciled displayed identity.
- Old recipes omit the new field at zero, retaining serialized cache identities and the original processing profile. Legacy Auto levels remains supported and labelled. Slider edits invalidate previews; manual values return when Off. Internet ready is an explicit preset and does not migrate saved overrides.
- One approved read-only reviewer checked root containment, capture uniqueness, single-flight admission, deferred runtime checks, recipe mapping, stale-read/display identity and scoped curation. Reported races were fixed; final source review found no residual blocker in that scope.

Evidence artifacts remain locally under `test-output/startup-performance/`, `test-output/auto-finish/` and the browser-suite report folders. These include private source metadata and are not uploaded wholesale.

## Reproduction

Use `cargo test --release --lib -j2 --no-default-features --config 'profile.release.package.photogogo-v2.opt-level=0' -- --test-threads=1` from `src-tauri`. The app-only optimization override reuses the release dependency cache; production packaging uses the normal optimized release profile.

For the opt-in startup benchmark set `PHOTOGOGO_STARTUP_RAW_SOURCE` to an explicitly supplied CR3 and filter `startup_open_latency_budget -- --ignored --nocapture --test-threads=1`. For visual acceptance set `PHOTOGOGO_RAW_TEST_SOURCE` and filter `raw_auto_finish_quality` with the same flags. Originals are read only; temporary development workspaces are owned and cleaned after use. Do not run these alongside an active user render on the render PC.

Installers are built with the existing release script and inspected without installing. 2.0.42 is retained for rollback. No dependency or runtime bundle was upgraded for this change.
