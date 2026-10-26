# Google Photos transfer setup and use

PhotoGoGo publishes curated, full-resolution local photographs to Google Photos.
It does not synchronise your Google library, delete local photographs, replace
uploaded image bytes, or share albums publicly. This integration initially
targets a personal Google account on Windows.

## Curate in Photo Lightbox

Each Original, B&W and Enhanced panel has its own Google Photos checkbox and
favourite star. The Original/Cropped switch exposes independent selections for
the cropped versions. Checking a box only saves local curation; it never starts
an upload. Normal next/previous navigation still visits originals, not generated
versions.

Local selections live in `.photogogo-curation.json` beside their photographs.
The sidecar contains local version identities and flags, not Google credentials
or album information. It survives supported rating renames and regeneration of
a version. Ambiguous files are not silently assigned a shared selection.

The account-specific “uploaded previously” label is historical, not a claim that
current file bytes still match. The publish review checks fingerprints again.

## Configure your personal Google account

1. In Google Cloud, create or choose a project and enable the **Photos Library
   API**. Configure Google Auth Platform branding, audience and data access.
2. If the audience is External and the app is in Testing, add your own Google
   account as a test user. Testing refresh tokens with Photos permissions can
   expire after seven days, so reconnecting is normal.
3. Create an OAuth client of type **Desktop app**, then download its JSON file.
   Do not create a Web application client. Do not paste passwords or tokens into
   chat or source code.
4. Open **Transfer → Transfer to Google Photos → Import OAuth setup**, and choose
   that file. The app stores configuration in its protected native store.
5. Choose **Connect Google Photos** and complete consent in your normal browser.
   The sign-in response returns through a short-lived local loopback listener.

Permissions cover adding photographs, reading app-created content to verify it,
and editing app-created albums for titles and covers. Unrelated Google albums
are outside the integration. Desktop OAuth does not support incremental consent,
so the implemented features request their three Photos scopes together.

Personal-use apps can qualify for Google's verification exemption, with warning
screens. Wider distribution needs a separate consent, verification, privacy and
support assessment; personal setup is not a promise of public approval.

The same desktop client must remain configured for its saved jobs and album
history. Changing account email is not used as an identity shortcut: records are
bound to both the OAuth client and Google's stable account subject.

## Use on several Windows PCs

Create the Google Cloud project, enable the API and create the Desktop OAuth
client once for PhotoGoGo, not once per machine. Reuse that same Desktop client
configuration on your PCs. In **2.0.33**, each PC still needs **Import OAuth
setup**, followed by its own **Connect Google Photos** browser sign-in. The
installer does not yet contain a shared client configuration or configure it
automatically. API enablement alone is not enough to connect an account.

Do not copy access tokens, refresh tokens or the protected Google Photos store
between machines. The store is protected for its Windows user and machine;
each installation obtains its own authorization. A future installer can include
the application's shared Desktop OAuth configuration so that only sign-in is
required on each PC, without embedding anyone's account credentials. Creating
the client and configuring Google consent still happen once in Google Cloud.

Saved jobs, upload receipts and Continue album mappings are currently local to
each PC. Using the same Google account and client does not synchronize those
records. A second PC may therefore create a new event album instead of knowing
about one created on the first. Cross-PC history/album reconciliation needs a
separate explicit workflow; do not treat the current exporter as a two-way sync.

## Review and publish

Choose a folder inside the configured staging root, or use all staging, then
choose one of two main selection options:

- **Use my Lightbox selections:** only the exact versions checked in Lightbox.
- **Choose versions for this upload:** independent **Original**, **Enhanced** and
  **B&W** checkboxes. Choose **Uncropped versions**, **Cropped versions only** or
  **Both uncropped and cropped** in the separate framing control. Cropped-only
  does not silently substitute an uncropped photo when its crop is missing.

**Advanced selection options** contains the less-common strategies and rating
filters. **Best available colour** chooses one version per original, preferring
Crop Enhanced, Crop, Enhanced, then Original. **All originals** selects original
photos only. Minimum-star and favourite filters refine the chosen scope. These
options are collapsed initially so the normal selection remains compact.

Overrides affect this job only; they do not rewrite Lightbox selections. Trash
is excluded by default. The review shows counts for the actual returned versions,
including cropped versions, rather than promising that every source has every
requested output.

Album names use event-folder names and shooting dates where available. You can
override those labels, group by event/day, edit individual album titles and
choose a cover in the paged preview. Event-date labels do not invent or change
embedded capture times. **Continue PhotoGoGo event albums** uses saved, account-
specific album IDs rather than guessing by title. A changed file or changed
metadata/privacy recipe is added as a new Google media item, not an overwrite.

**Review publish plan** reads local photographs and prepares an immutable plan.
Review the account, counts, bytes, album names, cover and per-photo warnings.
Blocked, missing and unsupported versions are excluded explicitly. Only after
accepting the review does **Publish** create a durable background job.

## Image quality and location privacy

This implementation validates JPEG and unmodified PNG uploads. Other formats,
including RAW, are reported rather than silently converted. Google's accepted
format list is wider; that does not make every format validated by PhotoGoGo.
The file limit is 200 MB; local dimension validation is bounded at 100 megapixels.

Untouched originals are copied without recompression and checked against their
reviewed SHA-256. Generated JPEGs and GPS removal require **ExifTool**. From
2.0.34 the installer includes a complete pinned runtime built from source. Leave
Settings → ExifTool Folder Override empty for **Automatic (bundled ExifTool)**.
Use **Check metadata tool** to see its source and version before reviewing an
upload. An explicit override takes precedence; clear an invalid override to
return to the bundled copy. Existing PATH installations remain a fallback when
the managed copy is absent. The application performs no runtime downloads or
global PATH changes. Untouched original uploads without GPS removal do not
need ExifTool. Repair the installer if the automatic check fails.

Metadata preparation happens only in independent upload copies. It restores
capture date/time and available offset/subsecond fields from the original,
normalises generated-image orientation, removes obsolete previews, and retains
compatible colour metadata. An RGB ICC profile is never attached to generated
grayscale B&W output. Encoded JPEG picture data and dimensions must remain
unchanged after metadata edits. GPS removal is read back before upload. Missing
capture times are disclosed; folder dates and filesystem modification times are
not substituted. Google may otherwise assign an upload-time date.

Full-resolution uploads count against Google account storage. PhotoGoGo does not
claim to know available cloud storage or to perform cloud checksum verification.
Success requires a Google media ID and read-back of the resulting dimensions;
the controlled pilot must also inspect capture dates, orientation and colour.

## Pause, restart and recovery

Google Photos uploads use the core **Process Jobs** architecture, the normal
**Jobs** page, job tiles, console and background Jobs panel. The Transfer page
configures/reviews a publish plan, starts it, and provides **View job**; it has
no separate upload tracker or management poll. Existing saved jobs appear
automatically with their original IDs. Failures appear under **Needs attention**.

Standard Pause, Resume, Abort and Retry controls dispatch through the core job
interface. Google receipt counts, album recovery and sanitized diagnostics are
task-specific details inside that same job. **Clear finished** hides only fully
resolved completed Google entries from history; it never deletes the encrypted
checkpoint, successful receipts, duplicate ledger or album mapping. Pending,
failed, paused, stopped and uncertain uploads remain visible and recoverable.

Google upload checkpoints remain encrypted and authoritative. They are not
copied into the in-memory local-job store. The shared worker registry contains
only task identity and cooperative stop handles. A protected-store problem
leaves local Photo Process jobs usable, shows a warning, and disables continuation
from a stale upload view. Safe stop requests remain available for active work.

**View diagnostics** displays a local, sanitised report; **Copy diagnostics**
copies it for support. Neither action contacts Google or starts a retry. The
report contains photo checkpoints, processing stages, safe Google status/HTTP
codes and the latest 256 saved checkpoint events. It omits filenames, local
paths, account details, album/media identifiers, credentials, upload tokens,
session URLs and raw Google response messages. If clipboard access is denied,
the report remains selectable for manual copying.

Jobs created in 2.0.32 remain recoverable, but their discarded Google status
codes cannot be reconstructed. A deliberate retry of that same saved job can
record fresh diagnostic events. Keep the original account and OAuth client;
do not create another upload job just to get around a verification failure.

**Bytes transferred** and **confirmed uploads** are separate. A full byte meter
does not mean Google has registered and successfully read back the photograph.

Only one Google upload worker runs at a time, including across app processes.
Local archive transfer remains a separate module. Eight prepared photographs
per registration batch bound temporary disk use; individual byte transfers use
bounded chunks. The app does not load a whole event into memory.

Pause stops further network work at a safe checkpoint; an in-flight request may
finish first. After an app restart, resume is explicit. Resuming queries Google's
confirmed byte offset. A known expired byte session can restart using the exact
same prepared file without recreating its album. Retry retains successful media
receipts and verifies registered photos rather than adding them again.

Abort also stops at a safe checkpoint, retains upload receipts and prepared
bytes, and allows explicit Retry of that same job. Neither Pause nor Abort
deletes remote photos or albums. A stop request is not shown as a completed stop
until the executor has saved its checkpoint.

A lost **album creation** response is different: Google provides no documented
idempotency key for that operation. The job stops with an uncertain outcome.
Use **Choose existing app-created album**, inspect the exact account and album,
associate it explicitly, then resume. PhotoGoGo never guesses from a title or
blindly creates another album. If no album exists, leave the uncertain job
stopped and review the account/error before creating a separate plan.

Continuing an album retains its existing Google Photos sharing settings. Check
the album before adding photographs: people with whom it is already shared may
see new additions. PhotoGoGo itself never enables sharing.

Rate-limit errors require at least 30 seconds before manual retry. Authorization
errors require reconnecting the original account. A wrong account or changed
source is a stop, not a reason to substitute different media.

Temporary image copies are removed after successful registration and read-back.
Unresolved jobs retain their prepared bytes for safe recovery. Those copies
are local photo data, not cloud downloads; include them in your PC's normal
privacy/storage policy.

## Upload acceptance and verification

Job details show **Accepted by Google** when a media registration receipt
has been saved, and **Verified** only after PhotoGoGo successfully reads that
same media ID back and checks its reported dimensions. These are different
checkpoints. Transferred bytes and the processed-photo bar do not prove that
every photo has passed verification.

If Google rejects an individual read-back result with `INVALID_ARGUMENT`,
PhotoGoGo continues checking other registered photos. A dimension mismatch
also remains a per-photo warning. Account, HTTP, network and quota failures
stop further requests; rate-limit recovery keeps its waiting period.

Use **Retry safe remaining work** or **Resume** on the existing saved job.
Registered photos are checked by their saved IDs before any new uploads or
album changes. They are never uploaded or registered again to bypass a failed
verification check. This read-back can work with the original photo folder
offline. Unverified receipts stay in **Needs attention**, with their own
diagnostics; PhotoGoGo does not silently mark them verified. No manual override
or additional Google permissions are introduced.

After installing the current build, retry the existing four-photo pilot in
**Jobs → Needs attention**. If Google still
rejects the Original, expect **4 accepted, 3 verified, 1 verification needs
attention**, while the fourth photo is now checked. If that Original's
read-back succeeds, the job can finish with all four verified. The precise
Google-side cause of its earlier rejection remains unconfirmed.

## Disconnect and stored data

**Disconnect** can forget this installation's credentials only, or also revoke
Google access. Revocation may invalidate the Cloud project's tokens on other
installations too. Neither option deletes Google albums or local photographs.
Paused jobs remain account-bound.

Credentials, Google-derived album/media information, resumable sessions, jobs
and receipts are encrypted at rest with Windows current-user DPAPI. They are
not portable to another Windows account or PC, and there is no plaintext
fallback. A corrupt or undecryptable store is reported rather than silently
reset. Browser storage contains no Google tokens or upload-session URLs.

Protected records are under the application's configuration directory in
`google-photos-v1/protected`. Local curation sidecars are separate. Disconnect
forgets credentials, not historical jobs/receipts; retain those for recovery and
duplicate avoidance. A future local-data reset must be an explicit reviewed
operation, never an automatic repair. To delete uploaded content, use Google
Photos directly; this app does not perform remote deletion.

## Validation and pilot gate

Offline native contracts cover full-resolution byte identity, partial results,
pause/resume, persisted intent, uncertain album creation, read-back, account/client
isolation, encrypted storage, PKCE, callback validation and malicious endpoints.
Browser regressions use mocked native commands, not real Google accounts.

Before calling the integration end-to-end validated, explicitly approve a small
live pilot: one untouched portrait JPEG, one Enhanced JPEG and one grayscale B&W
JPEG, preferably with known capture dates and a GPS-tagged source. Check the
private album, exact versions, displayed dimensions, dates, orientation, colour,
cover, interruption recovery and Continue behavior. Confirm originals' SHA-256
remain unchanged. Do not include sensitive photographs in that pilot.

## Primary references

- [Google Photos authorization](https://developers.google.com/photos/overview/authorization)
- [App-created content changes](https://developers.google.com/photos/support/updates)
- [Upload and per-item results](https://developers.google.com/photos/library/guides/upload-media)
- [Media read-back and per-item statuses](https://developers.google.com/photos/library/reference/rest/v1/mediaItems/batchGet)
- [Google API error codes](https://google.aip.dev/193)
- [Resumable upload protocol](https://developers.google.com/photos/library/guides/resumable-uploads)
- [Album management](https://developers.google.com/photos/library/guides/manage-albums)
- [Photos API policy](https://developers.google.com/photos/support/api-policy)
- [Desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Personal-use verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en)
- [Refresh-token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)
- [Windows DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
