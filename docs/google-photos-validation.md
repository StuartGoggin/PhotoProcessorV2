# Google Photos validation and pilot status

## Current delivery state

The personal-account Google Photos workflow is implemented on
`SWG/google-photos-transfer`, based on released `v2.0.31` / commit
`0a45afbfe92f2f4a031374d8dbf4fb4da20e248d`. The separate test-build version is
`2.0.32`. Do not treat it as an end-to-end validated Google Photos release before
the live-account and metadata pilot below. On 25 October 2026 the user authorized
committing, merging, pushing and Slack distribution of the completed work before
that pilot, as a clearly labelled personal test build. The final Git/build and
delivery receipts are recorded separately in `docs/release-2.0.32-validation.md`.
No real account, album or photograph has been uploaded by the development tests.

The paused subject-finishing worktree is unrelated and was not integrated.
Existing NAS archive transfer and checksum behavior remain separate.

## Implemented scope

- Native-backed per-version Lightbox selections and favourites, including crops.
- Transfer navigation, personal OAuth setup, browser sign-in and disconnect.
- Checked, preferred-colour, originals and explicit-version upload modes.
- Trash, star and favourite filters; per-job overrides preserve curation.
- Event/day grouping, editable album names, paged previews and cover selection.
- Full-resolution JPEG and unmodified PNG transfer without extra recompression.
- Metadata-only JPEG upload copies, GPS protection and compatible ICC handling.
- Frozen source/original fingerprints and metadata-aware account-specific reuse.
- Encrypted credentials, plans, jobs, resumable sessions and receipt ledger.
- Bounded background jobs, pause/restart/resume/retry and per-item read-back.
- Explicit reconciliation after uncertain album creation, never title guessing.
- Continued album title/cover updates without redundant photo uploads.

Google account identity includes both the OAuth client and verified subject.
Tokens and session URLs never cross the frontend interface. Cloud receipts use
DPAPI, not the portable local-curation sidecars.

## Validation completed on 25 October 2026

| Gate | Result |
| --- | --- |
| Native release-mode unit and contract suite | 242 passed, 0 failed, 21 existing opt-in tests not run |
| Google Photos frontend utilities | 4 passed |
| Lightbox frontend utilities | 15 passed |
| Google Photos browser regressions | 9 groups passed |
| Lightbox browser regressions | 13 groups passed |
| Photo Process browser regressions | 13 groups passed |
| TypeScript and production frontend build | Passed |
| Windows EXE and MSI test packages | Built and inspected without installing; version 2.0.32 and upgrade identity verified |
| Windows DPAPI round-trip and tamper tests | Passed |
| PKCE, fragmented callback and client/account isolation contracts | Passed |
| Full-resolution original byte identity and safe recovery adapter contracts | Passed |

Native tests use synthetic photographs and a fake Google adapter. Browser tests
use deterministic native-command fixtures. They are not a live Google protocol
test, a real-camera colour acceptance test or a throughput benchmark.

Commands:

```powershell
pwsh -NoProfile -File scripts/test-photo-process.ps1
node scripts/test-google-photos.mjs
node scripts/test-lightbox.mjs
node scripts/test-google-photos-browser.mjs
node scripts/test-lightbox-browser.mjs
node scripts/test-photo-process-browser.mjs
npm.cmd run build
```

Browser runners can use the configured `PHOTOGOGO_PLAYWRIGHT_PATH`; they launch
an isolated Edge session and do not use a personal Google browser profile.
Reports are under `test-output/google-photos-browser`,
`test-output/lightbox-browser` and `test-output/photo-process-browser`.

## Remaining gates

1. Finish the dedicated personal Google Cloud project setup. The user confirmed
   creation of **PhotoGoGo Personal** and that **Photos Library API is enabled**.
   Configure External/Testing consent and the personal test user, create one
   Desktop OAuth client, and download its JSON locally. Reuse the client across
   PCs, but keep sign-in and protected account state separate on each machine.
2. Package inspection is complete without installation. The 2.0.32 EXE/MSI have
   the expected upgrade identity, application bytes and 27 managed-media
   payloads. See the receipt below. They remain unsigned test packages, not a
   declaration of live Google compatibility.
3. Import the Desktop JSON through the app's local file picker, then sign in.
   No credentials belong in chat, source, reports or Slack.
4. Validate real ExifTool execution. This development environment did not have
   ExifTool on PATH. Its successful metadata/GPS/ICC branches are therefore not
   claimed executed merely because failure-path/byte-identity contracts pass.
   Include Unicode paths, portrait orientation, capture-time offset/subseconds,
   RGB colour and grayscale B&W. Non-sRGB originals without a compatible RGB
   ICC profile are blocked for generated colour copies rather than guessed.
5. Obtain explicit approval immediately before the live pilot. Use a small,
   non-sensitive selection containing original, Enhanced and B&W JPEGs. Inspect
   actual dimensions, dates, orientation, colour, GPS choice, album name/cover,
   interruption recovery, Continue behavior and unchanged local-source hashes.
6. The user authorized the personal 2.0.32 test distribution before these pilot
   checks. Keep the Google feature labelled preview and its setup requirements
   explicit. A production-ready claim or wider public launch requires the live
   acceptance and Google distribution/verification assessment; a build alone is
   not proof of Google-account operation.

The requested automatic installer configuration remains a follow-on: 2.0.32
requires local Desktop JSON import. No shared client exists yet. Do not embed
personal tokens or copy the DPAPI store. Saved jobs, upload receipts and Continue
album mappings are local, not automatically synchronized between PCs.

Use [the setup and recovery guide](google-photos-transfer.md) for the user-facing
workflow. An optional ephemeral guided checklist is
`test-output/google-photos-setup.sh`; it collects no credentials, writes no `.env`
and is intentionally excluded from source control.

## Earlier uncommitted test installer receipt

Build identifier: `20261025T061803765Z-0a45afbf+local`. Sources are the uncommitted
feature-branch changes at this checkpoint, not a published Git commit.

EXE: `src-tauri/target/release/bundle/nsis/PhotoGoGoV2_2.0.32_x64-setup.exe`

- Size: 24,990,816 bytes
- SHA-256: `78A0DBB6863B9A27585DFA15932EC743917D4E3D12C6FB12513598FB7D047E97`

MSI: `src-tauri/target/release/bundle/msi/PhotoGoGoV2_2.0.32_x64_en-US.msi`

- Size: 33,341,440 bytes
- SHA-256: `54D46B05C15D20A056AD34C17E50694DA7AD5EB6D39D9E2726F8682FB0DDE42B`

Inspection receipt:
`test-output/release-2.0.32-inspection-20261025T062158296Z/report.json`.
Each package verified 29 payloads: application, managed-media manifest and 27
media files. Only Tauri's documented three-byte bundle-type marker is normalised
when comparing packaged application bytes. Existing 2.0.31 installers remain.

## Recovery constraints

- Do not auto-retry an uncertain album creation or infer an album from a title.
- Do not erase the expected prepared-image hash when recovery cannot reproduce
  the original upload bytes; that pin must survive repeated retries.
- Do not replace old successful receipts with optimistic byte-upload success.
- Do not reuse receipts across accounts, OAuth clients, changed originals or
  metadata/privacy recipes.
- Do not silently reset an undecryptable store or introduce plaintext fallback.
- Continue preserves existing album sharing settings; newly added photographs
  may be visible to existing recipients. The app does not enable sharing.
- Keep originals untouched. Prepared copies belong only to the app-owned job
  workspace and are removed after successful registration/read-back.
