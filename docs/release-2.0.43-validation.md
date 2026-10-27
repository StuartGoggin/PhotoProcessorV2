# PhotoGoGo 2.0.43 — responsive discovery and bright RAW Auto finish

Built application source: `c739018a8680fe89c4a1278276bc4d64c9332703`. Later commits record documentation, the bounded low-disk inspection helper and release/delivery receipts; the installed application is built from this source.

## Result

Photo Lightbox returns the folder tree before capture metadata probes. Selected/opened mixed RAW/JPEG folders are enriched on demand; curation reads the selected folder while retaining canonical library asset IDs. Metadata reads use bounded single-flight batches and revalidate file stats before caching. A displayed identity is invalidated/reconciled before late catalogue changes can enable keyboard actions. RAW Development lists candidates without hashing the runtime bundle, retaining complete verification before preview/export.

Auto finish adds an optional strength slider with an explicit Internet ready preset at 65. Automatic exposure establishes the baseline, then downstream Lab brightness/contrast, protected vibrance and bounded edge sharpening create progressively brighter looks. Off restores manual levels. Old recipes at absent/zero strength retain their serialization, cache identity and processing profile. The first positive step enables automatic exposure rather than blending its estimate. White balance, full export resolution and per-photo override scopes remain explicit. See [the guide](cr3-raw-development.md) and [measured acceptance](raw-auto-finish-validation.md).

## Validation

- **336 native tests passed**, zero failed; 28 opt-in tests omitted from the ordinary suite. The startup benchmark and two supplied-file Auto finish acceptance runs were executed separately.
- **97 browser groups passed** across ordinary/RAW Lightbox, exact selections, keyboard/controller controls, RAW Development, Photo Process, Google Photos and archive. Twenty catalogue/cache/recipe units, seven keymap checks, four persistence boundaries and TypeScript passed.
- Original eight-folder startup reproduction: 11,014 ms / eight metadata processes before first list. Final owned mixed fixture: 42 ms / zero probes; warm 36 ms. Selected-folder proof: 820 ms / one metadata process, reused on repetition. RAW discovery: 44 ms / zero runtime bytes hashed; warm 39 ms. These are local process-cold figures, not deployment-machine guarantees.
- Ten real RAW exports across two supplied R6 II originals and five look strengths passed 6014 × 4016 dimensions, output ICC/capture metadata and unchanged original hashes. Strength 65 lifted mean display luminance from 91.93→140.86 and 73.76→134.98; sampled all-channel near-white clipping was 0%. Overview and native-pixel detail inspection covered white cloth, subject texture and smooth bokeh. This does not establish calibrated colour accuracy, semantic masking, focus recovery or universal camera/lighting coverage.
- One approved read-only reviewer checked code and the low-disk verifier. Reported stale-selection/loading races were fixed; the final review found no residual blocker within that scope. Execution evidence is separate from source-review conclusions.

The optimized production build passed with the same four nonblocking native warnings and existing frontend size/Browserslist notices. No dependencies or runtime bundles changed. Production frontend version/source markers are 2.0.43 / c739018.

## Finished package inspection

Final successful report: `test-output/release-2.0.43-inspection-20261027T221240174Z/report.json`, `complete: true`. Earlier attempts ran out of extraction disk space before payload validation and cleaned their owned extraction directories; their failure logs remain local. No preservation or payload mismatch was waived.

`verify-photo-release.ps1 -CompactInspection` uses an explicitly extracted cabinet, the Windows CAB expander in bounded File-ID groups, reversible compression between groups and immutable hardlinks for the installed metadata layout. All application, media, runtime and decode checks remain. Member names are restricted to unique flat filenames; the final MSI's 2,681 member names passed a separate read-only uniqueness check after that guard was added. Compact mode is optional. Temporary inspection trees are removed; reports remain. The standard extraction path is retained.

Both unsigned Windows x64 packages were inspected without installation. Application hashes match the standalone executable after normalizing only the expected three-byte Tauri bundle marker. Each package passed all expected media payload hashes, exact 2,205-file ExifTool 13.59 and 440-resource RawTherapee 5.13 closures, source/licence evidence and relocated execution with PATH empty. Each extracted RAW runtime decoded the supplied CR3 with the strength-65 profile: MSI 8,734 ms, EXE 8,095 ms, both 6014 × 4016 with output ICC and unchanged source hash. These are isolated runtime smoke timings.

MSI ProductVersion is 2.0.43. UpgradeCode remains `{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}` from 2.0.42.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| PhotoGoGoV2_2.0.43_x64-setup.exe | 130,045,602 | C80CD0CF6A0A6A979BEE6195B640282816F7FA21788F825C08918C004AA491A3 |
| PhotoGoGoV2_2.0.43_x64_en-US.msi | 220,938,360 | DFCC4D6DE6A14079B3B51D623B12B4C12FBD2AD2B0E8A7160E1EF91E33C8D48B |
| photogogo-v2.exe | 30,000,128 | E27D44DD16DFB0AFF144A4290EB59769BD4F52805CE559F5A8D7EAD5DFD6F15B |

## Testing and rollback

Use a copied small event for the first test. Internet ready / strength 50–70 is a starting point for the supplied overcast samples. Inspect at 100% before a batch. Saved per-photo overrides take precedence while enabled; disable their use explicitly for uniform job defaults. Full-resolution sRGB JPEG remains the Google Photos sharing format.

2.0.42 installers and 2.0.40/41 remain locally available. 2.0.43 reads their existing recipes; 2.0.42 cannot read a newly saved nonzero Auto finish field. Preserve the pre-test event/metadata copy for rollback, and keep the new event/metadata intact. Never discard ownership metadata merely to force a downgrade.

Only old extracted installer payloads for the previously approved 2.0.21–2.0.39 range were removed; their reports were retained. Reversible build-cache compression preserved file hashes. No installation, Google-account upload, active-render interruption, driver change or user-photo write was performed by this task.

## Verified GitHub and Slack delivery

Receipt commit `976f3bc1e7a6b8ac39fbe653af1f4a8b316aa256` was atomically pushed to GitHub master and `SWG/lightbox-first-open`, with annotated tag `v2.0.43` pointing to that commit. Remote read-back confirmed both heads and the peeled tag. The installed application's built source remains c739018; this later delivery note changes documentation only. Other chats' local master and subject-finishing worktrees were not changed.

Published through the Personal connection to GoggoVille **#swghermes** (`C0BDK1DDZTM`):

- EXE parent: **28 October 2026, 09:19:53 AEDT**, timestamp `1793139593.946859`, file `F0CCP492C5Q`. HTTP 200 acknowledged exactly **130,045,602 bytes**. [Release post and EXE](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793139593946859).
- MSI reply: **09:24:07 AEDT**, timestamp `1793139847.622489`, file `F0CCH3JD1JP`. HTTP 200 acknowledged exactly **220,938,360 bytes**. [MSI alternative](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1793139847622489).

Local sizes and SHA-256 values were checked immediately before each upload. Full thread read-back confirmed the two file IDs/names, release captions, checksums, testing workflow, rollback and validation boundaries, with no remaining thread pages. This verifies transport acknowledgements and accessible Slack attachment metadata, not an independent download/hash of Slack-hosted bytes. No duplicate release post was created. Local delivery receipt: `test-output/release-2.0.43-delivery.json`.
