# 2.0.22 no-added-rotation test release

## Scope

Adds **Prevent added rotation** to Quality two-pass stabilisation: an Off-by-default
project setting and nullable per-clip On/Off/inherit override. Existing projects
and legacy cache identities remain unchanged until the effective option changes.
Fast mode and stabilisation Off ignore the stored option. The native transform
uses `maxangle=0`; pan/tilt smoothing, framing and encoder policy are unchanged.
There is no driver, dependency, media-backend or GPU-algorithm change.

Changed effective picture settings invalidate only the affected clips. Previous
output files remain intact; unchanged clips keep their verified caches and review
approval. Render/job metadata and native content signatures reject old-policy
output even when revision numbers match. Saved jobs remain immutable. Final-only
assembly fails rather than silently repeating stabilisation when a required
picture is stale. See [the user guide](studio-prevent-rotation.md).

## Release gates

- Locked frontend and native builds; all version declarations agree on 2.0.22.
- Frontend regression suites, native library tests, Studio and dedicated rotation
  browser flows. Browser tests use mocked IPC; native media checks are separate.
- Bounded native media checks: exact zero-roll/X-Y-reference pixel comparison with
  a negative control, plus real two-pass rendering, selective cache reuse, stale
  assembly refusal and preservation of previous output checksums.
- Managed media/source archive validation, then MSI extraction without installation:
  verify product/version/upgrade identity, executable/library payload, all 28
  backend files, extracted-media smoke tests and runtime closure.
- Verify the pushed GitHub branch and record installer SHA-256, payload inspection,
  test results and Slack delivery/read-back status in the local delivery receipt.

The synthetic pixel comparison demonstrates zero added rotation and preserved
translation. It does not reproduce the close-up horse footage or prove that its
visual wobble is resolved. Translation estimates can still follow a dominant
foreground subject. No throughput improvement is claimed.

## Delivery and user acceptance

Approved destination: **GoggoVille #swghermes**, conversation `C0BDK1DDZTM`.
Do not substitute the former Oracle DM. A Slack access failure must be reported
as a delivery blocker, not as a successful send. Exact evidence is retained under
`test-output/release-2.0.22/`.

Unsigned Windows x64 test installer; the optional offline face runtime is omitted.
Only the payload-inspected MSI is delivered; NSIS is built and hashed, not installed.
Installation, upgrade/downgrade and the actual horse footage remain user tests.
No render-PC installation, reboot, render interruption or settings changes are
performed by this release workflow.

Before installing: let current renders finish, save/back up the project, and close
PhotoGoGo normally. Retain the 2.0.21 installer and project backup. Keep outputs and
caches; allow room for a new export. For rollback, restore the pre-upgrade project
backup before opening an older version, which does not understand the new setting.

Test Quality + Gentle with prevention On against the problematic close approach
and a deliberate tracking pan. If the problem occurs later than the quick preview's
first 12 seconds, use an appropriate moment/replay preview or render the full clip.
Check rider/horse framing as well as rotation before exporting the whole project.

Corresponding FFmpeg source archive is unchanged, SHA-256:
`27F7CD21A21E661314D76FE4689F7E4D92B0C0E13BC101376E8443E10EEC8FD8`.
