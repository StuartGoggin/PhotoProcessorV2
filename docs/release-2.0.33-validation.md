# PhotoGoGo 2.0.33 Google Photos testing fixes

## Approved scope

The user approved implementing, testing, committing, merging, building and
delivering the fixes reported in
[the 26 October Slack feedback](https://goggoville.slack.com/archives/C0BDK1DDZTM/p1792953903059009).
The changes address missing Google jobs in the shared Jobs interface, lost error
details/inaccessible diagnostics, and complicated photo-version selection.

- Normal Jobs and the background panel include the existing Google upload jobs,
  with account-bound controls, Needs attention and History classification.
  Google store/account polling is independent of local import/process/Studio
  polling, and a Google failure does not hide the local jobs.
- One shared Google job card provides read-only **View diagnostics** and **Copy
  diagnostics**, including clipboard-denial feedback. Clearing finished local
  jobs does not delete Google receipts or recovery history.
- A bounded checkpoint history is stored inside the existing encrypted job.
  Exported reports omit filenames, paths, account details, private Google IDs,
  credentials, upload tokens/session URLs and raw response messages. Only
  canonical status names, numeric codes and allowlisted reasons are exposed.
- A failed media read-back is attributed to its photo and retains the registered
  media receipt. Resume verifies that ID instead of uploading/registering again.
  RPC quota errors receive the same minimum 30-second retry gate as HTTP 429.
- Two main selection choices replace four competing primary modes. Explicit
  Original/Enhanced/B&W choices are separate from uncropped/cropped/both framing;
  missing crops never silently fall back. Less-common strategies and rating
  filters are in Advanced. The review displays actual version counts.

No automatic OAuth installer configuration, cross-PC receipt synchronization,
dependency upgrade, subject-finishing integration or media-processing change is
part of this release. The Google integration remains a personal test preview.

## Reproduction and acceptance boundaries

Before the fix, the real native verification parser lost a supplied status 5
and emitted the screenshot's generic message. The focused test failed with
`Missing actionable status in: Google reported an error during media read-back`.
Browser regressions separately reproduced the missing normal-Jobs integration
and the four-primary/six-mixed-version control layout.

The supplied status 5 was a controlled fixture, **not a reconstruction of the
user's actual Google response**. The screenshot did not retain its status code;
the underlying live-account rejection is still unknown. This release exposes
safe diagnostics for a deliberate retry of the existing saved job, not a claim
that the remote rejection itself has been fixed.

Existing 2.0.32 jobs deserialize without a checkpoint history. Their already
discarded codes cannot be recovered; the report says so explicitly. No developer
test connects to the user's Google account, retries their uploads, installs on a
deployment PC, changes their media or interrupts renders. Live Google and real
ExifTool metadata/colour acceptance remain separate from mocked/synthetic tests.

## Validation and delivery record

Final versioned validation passed on 26 October 2026:

| Gate | Result |
| --- | --- |
| Native release-mode suite | 248 passed, 0 failed, 21 existing opt-in tests not run |
| Google Photos utilities | 4 passed |
| Lightbox utilities | 15 passed |
| Jobs classification and server-rendered UI checks | 15 passed |
| Google Photos browser checks | 11 groups passed, including desktop and 390px selection controls |
| New shared Google Jobs browser checks | 7 groups passed |
| Existing Jobs polling browser regressions | Passed, including failure retention, single-flight and RAM-wait behavior |
| Lightbox browser checks | 13 groups passed |
| Photo Process browser checks | 13 groups passed |
| TypeScript and production frontend build | Passed; packaging rebuilds the committed frontend |
| Independent cross-review | No remaining release blocker |

Native tests cover per-photo failed-read-back persistence, retry without another
upload/registration, legacy job loading, bounded history, status/HTTP redaction
and quota backoff. Review found and reproduced a further partial-registration
attribution defect: verifying a successful sibling could move the last log phase
before the pending registration error was returned. The engine now retains the
failed photo index and restores its registration context. A regression calls
the outer error handler and verifies it never blames the healthy sibling.

Browser reports and inspected screenshots are under
`test-output/google-photos-browser`, `test-output/google-photos-jobs-browser`,
`test-output/lightbox-browser` and `test-output/photo-process-browser`. Tests use
synthetic media, fake Google responses and mocked native IPC, not live uploads.
The native red/green checks include the actual parser and saved-job engine.

Commands include:

```powershell
pwsh -NoProfile -File scripts/test-photo-process.ps1
node scripts/test-google-photos.mjs
node scripts/test-lightbox.mjs
node scripts/test-jobs-ui.mjs
node scripts/test-google-photos-browser.mjs
node scripts/test-google-photos-jobs-browser.mjs
node scripts/test-jobs-polling-browser.mjs
node scripts/test-lightbox-browser.mjs
node scripts/test-photo-process-browser.mjs
npm.cmd run build
```

## Package verification

Built from source commit `105eaf31c90d778f7c5eb0366f94265096e46f31`, merged into
`master` by fast-forward. Build identifier:
`20261025T192916751Z-105eaf31+local`. Tauri's manifest line-ending rewrite caused
the `+local` marker; the normalized Cargo manifest was verified equal to the
committed blob `66b213da8065f945357302e8e38bdc5fd2a062fc`, with no content diff.
Later receipt commits change documentation only.

Both unsigned Windows x64 packages were extracted and inspected without
installation. Each verified 29 payloads: application, managed-media manifest
and 27 managed-media files. Only the unique three-byte Tauri bundle marker is
normalized when comparing application bytes; all other bytes must match.
MSI version is 2.0.33 and its upgrade identity matches 2.0.32:
`{9CBA7A69-EDA0-5480-A421-9DC9AD265A65}`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `PhotoGoGoV2_2.0.33_x64-setup.exe` | 24,981,126 | `87E0B2D7A0C6B3E07EC0E636DE25D3DFC981423BF90D03B85D7CBADA0C9FA2E0` |
| `PhotoGoGoV2_2.0.33_x64_en-US.msi` | 33,349,632 | `C109353D76ABE348CBFF20B94BDE9C28A3655F862CBE437D73C50D7109C367EC` |
| Standalone application | See receipt | `88E90A4C164AD4237D9C2B673CDAD83C62A72F2399B62C53F7D733D3C1919D05` |
| `PhotoGoGo-FFmpeg-rowtest1-source.tar.gz` | 49,570,807 | `27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8` |

Inspection receipt:
`test-output/release-2.0.33-inspection-20261025T193337305Z/report.json`.
The committed frontend was rebuilt successfully during packaging. Managed
FFmpeg and corresponding source are unchanged; no dependency upgrade is
included. Previous installers remain available for rollback.

```powershell
pwsh -NoProfile -File scripts/build-release.ps1 -SkipFaceBundle -SkipDependencyInstall -MediaSourceArchive test-output/media-delivery/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz
pwsh -NoProfile -File scripts/verify-photo-release.ps1 -Version 2.0.33 -PreviousVersion 2.0.32
```

## Safe testing and rollback

Let jobs finish, save and close PhotoGoGo normally before installing. Packages
are unsigned Windows x64 builds; use the setup EXE or MSI, not both. Preserve the
2.0.32 installer and backups of settings/projects. Keep the current Google
account/client and protected state on its original PC.

After upgrading, open **Jobs → Needs attention**, locate the existing Google
job and choose **View diagnostics**. If ready to retry, use **Retry safe remaining
work** on that same job. If verification still fails, copy the new diagnostics
and provide them in the existing Slack support thread. Do not start a fresh
publish plan simply to bypass verification or move the protected store to
another Windows installation.

See [the updated Google Photos guide](google-photos-transfer.md).
