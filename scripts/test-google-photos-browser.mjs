import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/google-photos-browser";
await mkdir(output, { recursive: true });
const url = process.env.GOOGLE_PHOTOS_TEST_URL || "http://127.0.0.1:1465/google-photos-preview.html";
const server = process.env.GOOGLE_PHOTOS_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1465", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser;
server?.stdout.on("data", data => { log += data; }); server?.stderr.on("data", data => { log += data; });
const report = { complete: false, scope: "Real Google Photos controls with deterministic mocked native IPC. No real Google sign-in, albums, media, network upload or user files.", checks: [] };
const errors = [];
async function fixture(options = {}, viewport = { width: 1440, height: 1050 }) {
  const page = await browser.newPage({ viewport }); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(initial => Object.assign(window, initial), options);
  await page.goto(options.__metadataSettingsPage ? `${url}?page=settings` : url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("heading", { name: options.__metadataSettingsPage ? "Settings" : "Transfer to Google Photos", exact: true }).waitFor();
  return page;
}
const calls = (page, command) => page.evaluate(command => window.__googleCalls.filter(call => call.command === command), command);
const preview = async page => { await page.getByRole("button", { name: "Review publish plan", exact: true }).click(); await page.getByRole("heading", { name: "Review before publishing", exact: true }).waitFor(); };
const consent = page => page.getByRole("checkbox", { name: /I reviewed this account/ });
const croppedOnlyFixture = { __googlePlanItems: [
  { id: "cropped-enhanced", relativePath: "2026/10/24/Horse event/rider_crop_improved.jpg", variant: "crop_enhanced", bytes: 19123456, status: "ready", warnings: [] },
  { id: "cropped-bw", relativePath: "2026/10/24/Horse event/rider_crop_BW.jpg", variant: "crop_bw", bytes: 12123456, status: "ready", warnings: [] },
] };
async function simplifiedSelection(page) {
  await page.getByText("rider@example.test", { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Minimum Lightbox stars", exact: true }).isVisible(), false,
    "Less-common rating filters stay under collapsed Advanced rather than competing with primary upload choices");
  await page.getByText("Advanced photo selection", { exact: true }).click();
  const primaryLightbox = page.getByRole("radio", { name: /Use my Lightbox selections/ });
  await primaryLightbox.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  assert.equal(await primaryLightbox.isChecked(), true, "Keyboard arrows stay within the two primary choices even while Advanced is open");
  await page.getByText("Advanced photo selection", { exact: true }).click();
  await page.getByRole("radio", { name: /Choose versions for this upload/ }).check();
  assert.equal(await page.getByRole("group", { name: "Photo version types", exact: true }).getByRole("checkbox").count(), 3,
    "Upload versions are Original, Enhanced and B&W; cropping is a separate choice, not three extra version types");
  assert.equal(await page.getByRole("checkbox", { name: "Original", exact: true }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: "Enhanced", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "B&W", exact: true }).isChecked(), false);
  await page.getByRole("checkbox", { name: "Original", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Enhanced", exact: true }).check();
  await page.getByRole("checkbox", { name: "B&W", exact: true }).check();
  await page.getByRole("combobox", { name: "Photo framing", exact: true }).selectOption("cropped");
  await page.getByText("Missing crops are skipped; uncropped files are never substituted.", { exact: false }).waitFor();
  await page.getByRole("region", { name: "Choose photos and publishing rules", exact: true }).screenshot({ path: `${output}/upload-version-choices-${await page.evaluate(() => innerWidth)}px.png` });
  await preview(page);
  const planned = (await calls(page, "google_photos_plan")).at(-1).args.request;
  assert.equal(planned.mode, "variants");
  assert.deepEqual(planned.variants, ["crop_enhanced", "crop_bw"], "Only the explicitly requested processing/framing combination reaches native planning");
  assert.equal((await calls(page, "google_photos_set_selection")).length, 0, "One-upload choices never rewrite Lightbox checks");
  assert.equal((await calls(page, "google_photos_start")).length, 0, "Selection review is not publication");
  assert.equal(await page.getByRole("group", { name: "Exact photo versions in this plan", exact: true }).count(), 1,
    "The review exposes counts for the exact native-returned photo versions, so crop selection cannot hide behind a total");
  const breakdown = page.getByRole("group", { name: "Exact photo versions in this plan", exact: true });
  await breakdown.getByText("Crop enhanced: 1", { exact: true }).waitFor();
  await breakdown.getByText("Crop B&W: 1", { exact: true }).waitFor();
  assert.equal(await breakdown.getByText("Original", { exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "Photo framing", exact: true }).selectOption("uncropped");
  assert.equal(await page.getByRole("heading", { name: "Review before publishing", exact: true }).count(), 0, "Framing change invalidates the old saved plan");
  await preview(page);
  assert.deepEqual((await calls(page, "google_photos_plan")).at(-1).args.request.variants, ["enhanced", "bw"]);
  await page.getByRole("combobox", { name: "Photo framing", exact: true }).selectOption("both");
  await preview(page);
  assert.deepEqual((await calls(page, "google_photos_plan")).at(-1).args.request.variants, ["enhanced", "crop_enhanced", "bw", "crop_bw"]);
  await page.getByRole("checkbox", { name: "Enhanced", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "B&W", exact: true }).uncheck();
  assert.equal(await page.getByRole("button", { name: "Review publish plan", exact: true }).isDisabled(), true, "No selected processing version cannot fall back to another image");
  await page.getByRole("radio", { name: /Use my Lightbox selections/ }).check();
  assert.equal(await page.getByRole("button", { name: "Review publish plan", exact: true }).isEnabled(), true, "Lightbox selection is independent of empty one-upload override choices");
  await preview(page);
  assert.equal((await calls(page, "google_photos_plan")).at(-1).args.request.mode, "checked");
  assert.equal((await calls(page, "google_photos_set_selection")).length, 0);
  assert.equal((await calls(page, "google_photos_start")).length, 0);
  report.checks.push("Three clear processing-version choices and separate cropped-only framing map exactly to native variants without fallback or curation writes");
}
async function metadataReadiness() {
  const settingsPage = await fixture({ __metadataSettingsPage: true });
  assert.equal(await settingsPage.getByText("Automatic (bundled ExifTool)", { exact: true }).count(), 1,
    "An empty metadata override is clearly automatic, not a request to manually install or find ExifTool");
  await settingsPage.getByRole("button", { name: "Check metadata tool", exact: true }).click();
  await settingsPage.getByText("Metadata tool ready", { exact: true }).waitFor();
  assert.equal((await calls(settingsPage, "metadata_tool_status")).at(-1).args.directory, "", "Settings checks the current empty textbox explicitly, not an unrelated saved override");
  assert.equal(await settingsPage.getByText("Version 13.50", { exact: true }).count(), 1);
  const override = settingsPage.getByRole("textbox", { name: "ExifTool folder override (optional)", exact: true });
  await override.fill("D:\\Unsaved metadata tools");
  assert.equal(await settingsPage.getByText("Metadata tool ready", { exact: true }).count(), 0, "Changing the folder invalidates a previous ready result");
  await settingsPage.getByRole("button", { name: "Check metadata tool", exact: true }).click();
  await settingsPage.getByText("Metadata tool ready", { exact: true }).waitFor();
  assert.equal((await calls(settingsPage, "metadata_tool_status")).at(-1).args.directory, "D:\\Unsaved metadata tools");
  assert.equal(await settingsPage.getByText("Folder override", { exact: true }).count(), 1);
  assert.equal(await settingsPage.evaluate(() => window.__metadataSavedSettings.length), 0, "Checking a tool never saves settings");
  report.checks.push("Settings distinguishes bundled automatic resolution from an optional override and checks unsaved text without saving settings");
  const google = await fixture();
  assert.equal(await google.getByRole("group", { name: "Metadata tool readiness", exact: true }).count(), 1,
    "Google Photos shows metadata readiness before the user has to discover a per-photo preflight failure");
  await google.getByText("Metadata tool ready", { exact: true }).waitFor();
  const savedCheck = (await calls(google, "metadata_tool_status"))[0];
  assert.equal(Object.hasOwn(savedCheck.args, "directory"), false, "Google Photos checks saved configuration instead of overriding it with an empty folder");
  assert.equal(await google.getByRole("group", { name: "Metadata tool readiness", exact: true }).locator(".gp-note").count(), 0, "A working bundled tool is not presented as a missing-tool warning");
  report.checks.push("Google Photos checks the saved native resolver early and presents a working bundled tool as ready, not a warning");

  await settingsPage.evaluate(() => { window.__metadataResult = { ready: false, source: "unavailable", message: "The configured override is unavailable. Clear the override to use the bundled tool, then check again." }; });
  await override.fill("D:\\Missing metadata tools");
  await settingsPage.getByRole("button", { name: "Check metadata tool", exact: true }).click();
  await settingsPage.getByText("Metadata tool unavailable", { exact: true }).waitFor();
  await settingsPage.getByText("The configured override is unavailable.", { exact: false }).waitFor();
  assert.equal(await settingsPage.getByRole("button", { name: /install|download/i }).count(), 0, "Readiness does not introduce software installation or downloading");
  await settingsPage.evaluate(() => { window.__metadataResult = null; window.__metadataHold = true; });
  await override.fill("D:\\First unsaved folder");
  await settingsPage.getByRole("button", { name: "Check metadata tool", exact: true }).click();
  await settingsPage.waitForFunction(() => !!window.__metadataResolve);
  await override.fill("D:\\Second unsaved folder");
  await settingsPage.evaluate(() => { window.__metadataHold = false; window.__metadataResolve(); });
  await settingsPage.getByText("Folder changed. Check the metadata tool again", { exact: false }).waitFor();
  assert.equal(await settingsPage.getByText("Metadata tool ready", { exact: true }).count(), 0, "A late result cannot claim a newly entered override is ready");
  await override.fill("");
  await settingsPage.getByRole("button", { name: "Check metadata tool", exact: true }).click();
  await settingsPage.getByText("Metadata tool ready", { exact: true }).waitFor();
  assert.equal((await calls(settingsPage, "metadata_tool_status")).at(-1).args.directory, "");
  assert.equal(await settingsPage.evaluate(() => window.__metadataSavedSettings.length), 0);
  await settingsPage.getByRole("textbox", { name: "ExifTool folder override (optional)", exact: true }).scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: `${output}/metadata-settings.png`, fullPage: true });
  report.checks.push("Missing/stale override results are actionable; late checks cannot mark edited paths ready, and clearing the textbox restores automatic resolution without saving");

  const unavailable = await fixture({ __metadataSavedOverride: "D:\\Unavailable saved override", __metadataResult: { ready: false, source: "unavailable", message: "Saved metadata override was not found. Check the optional override in Settings." }, __googlePlanItems: [
    { id: "untouched-original", relativePath: "2026/10/24/Horse event/rider.jpg", variant: "original", bytes: 18123456, status: "ready", warnings: [] },
  ] });
  await unavailable.getByText("Metadata tool unavailable", { exact: true }).waitFor();
  await unavailable.getByText("Untouched originals without GPS removal can still be reviewed", { exact: false }).waitFor();
  await unavailable.getByRole("radio", { name: /Choose versions for this upload/ }).check();
  assert.equal(await unavailable.getByRole("button", { name: "Review publish plan", exact: true }).isEnabled(), true, "Unavailable metadata tool cannot globally block untouched original-only review");
  await preview(unavailable);
  const originalRequest = (await calls(unavailable, "google_photos_plan")).at(-1).args.request;
  assert.deepEqual(originalRequest.variants, ["original"]); assert.equal(originalRequest.stripGps, false);
  await consent(unavailable).check();
  assert.equal(await unavailable.getByRole("button", { name: "Publish 1 photo", exact: true }).isEnabled(), true, "Native-ready original stays publishable; the advisory readiness banner adds no new client-side blocker");
  assert.equal((await calls(unavailable, "google_photos_start")).length, 0);
  assert.equal(await unavailable.evaluate(() => window.__metadataSavedSettings.length), 0);
  await unavailable.getByRole("group", { name: "Metadata tool readiness", exact: true }).screenshot({ path: `${output}/metadata-google-unavailable.png` });
  report.checks.push("Early missing-tool advice preserves native per-file gates and does not block an untouched original-only job or silently change saved settings");
  await unavailable.evaluate(() => { window.__metadataResult = { ready: true, source: "path", version: "13.42", message: "ExifTool from system PATH is ready." }; });
  await unavailable.getByRole("button", { name: "Recheck metadata tool", exact: true }).click();
  await unavailable.getByText("Metadata tool ready", { exact: true }).waitFor();
  await unavailable.getByText("System PATH", { exact: false }).first().waitFor();
  assert.equal(Object.hasOwn((await calls(unavailable, "metadata_tool_status")).at(-1).args, "directory"), false);
  assert.equal(await unavailable.getByRole("group", { name: "Metadata tool readiness", exact: true }).getAttribute("class").then(value => value.includes("gp-metadata-unavailable")), false);
  report.checks.push("Manual recheck reflects a recovered PATH tool/version without changing the saved override or creating an upload");
}

try {
  if (server) {
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (server.exitCode !== null) throw new Error(`Fixture server exited: ${log}`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Starting. */ }
      await delay(250);
    }
    assert.ok(ready, `Fixture did not start: ${log}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  if (process.env.GOOGLE_PHOTOS_TEST_FOCUS === "metadata") {
    await metadataReadiness();
  } else if (process.env.GOOGLE_PHOTOS_TEST_FOCUS === "selection") {
    await simplifiedSelection(await fixture(croppedOnlyFixture));
  } else {
  const page = await fixture();
  await page.getByText("rider@example.test", { exact: true }).waitFor();
  assert.equal(await page.getByRole("radiogroup", { name: "Photo selection mode", exact: true }).getByRole("radio").count(), 2,
    "Primary selection offers only Lightbox selections or explicit upload versions; advanced modes are separate");
  assert.equal(await page.getByRole("radio", { name: /Use my Lightbox selections/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: "Exclude photos marked as trash", exact: true }).isChecked(), true);
  assert.equal((await calls(page, "google_photos_start")).length, 0);
  await preview(page);
  const request = (await calls(page, "google_photos_plan"))[0].args.request;
  assert.equal(request.root, "D:\\Synthetic photos"); assert.equal(request.mode, "checked");
  assert.equal(request.excludeTrash, true); assert.equal(request.stripGps, false); assert.equal(request.groupByEventDay, true);
  const publish = page.getByRole("button", { name: "Publish 3 photos", exact: true });
  assert.equal(await publish.isDisabled(), true, "Explicit review consent gates publication");
  assert.equal(await page.getByLabel("Album name horse-24", { exact: true }).inputValue(), "Horse event — 24 October 2026");
  assert.equal(await page.getByLabel("Album name arena-25", { exact: true }).inputValue(), "Arena — 25 October 2026");
  await page.getByRole("img", { name: "Preview 2026/10/24/Horse event/rider.jpg", exact: true }).waitFor();
  assert.ok(await page.evaluate(() => window.__googleThumbnailMax <= 2), "All album filmstrips share the bounded two-read budget");
  const thumb = (await calls(page, "google_photos_thumbnail"))[0].args;
  assert.deepEqual(Object.keys(thumb).sort(), ["itemId", "planId"], "Preview requests use frozen plan identity, never arbitrary paths or upload payloads");
  await consent(page).check(); assert.equal(await publish.isEnabled(), true);
  await page.getByLabel("Album name horse-24", { exact: true }).fill("Horse event — curated selection");
  assert.equal(await consent(page).isChecked(), false, "Album edits invalidate prior acceptance");
  await page.getByRole("combobox", { name: "Album cover horse-24", exact: true }).selectOption("first-enhanced");
  assert.equal(await page.getByText("★ Album cover", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Preview photos in Arena — 25 October 2026", exact: true }).click();
  await page.getByRole("button", { name: "Use 2026/10/25/Arena/fence.CR3 as album cover", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Use 2026/10/25/Arena/fence.CR3 as album cover", exact: true }).isDisabled(), true);
  await page.screenshot({ path: `${output}/desktop-plan.png`, fullPage: true });
  report.checks.push("Checked/trash-safe defaults, event/day albums, independent ready/changed/skipped/blocked counts, bounded plan-identity previews, cover choice and explicit acceptance gate");

  await page.evaluate(() => { window.__googleStartDelay = true; });
  await consent(page).check(); await publish.click();
  await page.waitForFunction(() => !!window.__googleResolveStart);
  assert.equal(await page.getByRole("button", { name: "Saving upload job…", exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Album name horse-24", { exact: true }).isDisabled(), true);
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  assert.equal((await calls(page, "google_photos_start")).length, 1, "Busy keyboard input cannot duplicate publication");
  const start = (await calls(page, "google_photos_start"))[0].args;
  assert.equal(start.planId, "plan-1"); assert.equal(start.acknowledgeWarnings, true);
  assert.equal(start.albums[0].title, "Horse event — curated selection"); assert.equal(start.albums[0].coverItemId, "first-enhanced");
  assert.equal("items" in start, false, "Start submits immutable plan identity and allowed album edits only");
  await page.evaluate(() => window.__googleResolveStart());
  await page.getByText("Upload job saved.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open Horse event — curated selection ↗", exact: true }).click();
  assert.equal((await calls(page, "google_photos_open_album"))[0].args.albumKey, "horse-24");
  assert.deepEqual((await calls(page, "google_photos_control")).map(call => call.args.action), ["pause", "resume"]);
  await page.waitForFunction(() => window.__googleRevokedUrls.length > 0);
  report.checks.push("Frozen-plan publication is single-flight, album edits locked while saving; native-backed jobs pause/resume, open album and discard preview object URLs");

  await page.getByRole("radio", { name: /Choose versions for this upload/ }).check();
  await page.getByRole("checkbox", { name: "Enhanced", exact: true }).check();
  await page.getByRole("combobox", { name: "Photo framing", exact: true }).selectOption("both");
  await page.getByText("Advanced photo selection", { exact: true }).click();
  await page.getByRole("combobox", { name: "Minimum Lightbox stars", exact: true }).selectOption("2");
  await page.getByRole("checkbox", { name: "Only Google Photos favourites from Lightbox", exact: true }).check();
  await page.getByRole("checkbox", { name: "Remove GPS location from upload copies", exact: true }).check();
  await page.getByRole("combobox", { name: "Album destination", exact: true }).selectOption("continue");
  await preview(page);
  const override = (await calls(page, "google_photos_plan")).at(-1).args.request;
  assert.deepEqual(override.variants, ["original", "crop", "enhanced", "crop_enhanced"]); assert.equal(override.mode, "variants");
  assert.equal(override.minStars, 2); assert.equal(override.favouritesOnly, true); assert.equal(override.stripGps, true); assert.equal(override.albumMode, "continue");
  assert.equal((await calls(page, "google_photos_set_selection")).length, 0, "Transfer override never rewrites Lightbox flags");
  await page.getByRole("radio", { name: /Best available colour/ }).check();
  assert.equal(await page.getByRole("heading", { name: "Review before publishing", exact: true }).count(), 0, "Changed selection rules invalidate saved review");
  await preview(page); assert.equal((await calls(page, "google_photos_plan")).at(-1).args.request.mode, "preferred_colour");
  await page.getByRole("radio", { name: /All originals/ }).check(); await preview(page);
  assert.equal((await calls(page, "google_photos_plan")).at(-1).args.request.mode, "originals");
  report.checks.push("All four selection modes and per-job variants, ratings, favourites, GPS/privacy and continue-album options cross native seam without mutating Lightbox curation");

  await consent(page).check();
  await page.evaluate(() => { window.__googleStatus.account = { id: "same-email-other-client:subject-1", email: "rider@example.test", displayName: "Same email, different OAuth app" }; });
  await page.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "connected account has changed" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Publish 3 photos", exact: true }).isDisabled(), true, "Opaque account ID protects same-email different-app plans");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByText("Google may invalidate this project’s tokens", { exact: false }).waitFor();
  await page.getByRole("checkbox", { name: "Also revoke Google access for this OAuth project", exact: true }).uncheck();
  await page.getByRole("button", { name: "Confirm disconnect", exact: true }).click();
  await page.getByText("Not connected", { exact: true }).waitFor();
  assert.equal((await calls(page, "google_photos_disconnect"))[0].args.revoke, false);
  assert.equal(await page.getByRole("button", { name: "Review publish plan", exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).length), 0, "Account/session data are not written into browser storage");
  report.checks.push("Account identity changes invalidate publication; revoke-project vs forget-local distinction is explicit, disconnect gates plans and no account/session data enter localStorage");

  const compact = await fixture({}, { width: 390, height: 844 }); await preview(compact);
  await compact.getByRole("heading", { name: "Review before publishing", exact: true }).scrollIntoViewIfNeeded();
  await compact.screenshot({ path: `${output}/compact-plan.png`, fullPage: true });
  const bounds = await compact.locator(".google-photos").evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, viewport: innerWidth }));
  assert.ok(bounds.width <= bounds.viewport && bounds.scroll <= bounds.viewport, "Compact publish review has no horizontal overflow");
  report.checks.push("390px compact account, filters, album names, filmstrip and confirmation controls remain usable without horizontal overflow");
  const compactChoices = await fixture(croppedOnlyFixture, { width: 390, height: 844 });
  await simplifiedSelection(compactChoices);
  const choiceBounds = await compactChoices.getByRole("region", { name: "Choose photos and publishing rules", exact: true }).evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, viewport: innerWidth }));
  assert.ok(choiceBounds.width <= choiceBounds.viewport && choiceBounds.scroll <= choiceBounds.viewport, "Explicit version and framing choices fit the compact viewport");

  const signedOut = await fixture({ __googleStatus: { configured: false, connecting: false, account: null } });
  await signedOut.getByText("Not connected", { exact: true }).waitFor();
  assert.equal(await signedOut.getByRole("button", { name: "Connect Google Photos", exact: true }).isDisabled(), true);
  await signedOut.getByRole("button", { name: "Import OAuth setup", exact: true }).click();
  await signedOut.getByRole("button", { name: "Connect Google Photos", exact: true }).click();
  await signedOut.getByText("rider@example.test", { exact: true }).waitFor();
  assert.equal((await calls(signedOut, "google_photos_configure"))[0].args.configPath, "D:\\private-config\\desktop-client.json");
  assert.deepEqual((await calls(signedOut, "google_photos_connect"))[0].args, {}, "Browser OAuth starts natively without credentials in IPC");
  report.checks.push("Disconnected first-use setup imports a local desktop-client file and starts native browser OAuth; missing setup disables connection");

  const unknown = await fixture({ __googleJobs: [{ id: "interrupted-job", accountId: "personal-client:subject-1", accountEmail: "rider@example.test", createdAt: "2026-10-25T07:00:00Z", status: "needs_attention", done: 0, total: 1, uploaded: 0, skipped: 0, failed: 0, bytesDone: 0, totalBytes: 1234, currentFile: "", errors: ["Previous album-create result is unknown"], albums: [{ key: "recover-key", title: "Horse event — 24 October 2026", state: "creation_outcome_unknown" }] }] });
  await unknown.getByRole("button", { name: "Choose existing app-created album", exact: true }).click();
  const recovery = unknown.getByRole("combobox", { name: "Recover album recover-key", exact: true });
  assert.equal(await recovery.inputValue(), "", "Album recovery never guesses from matching title");
  assert.equal(await unknown.getByRole("button", { name: "Associate selected album", exact: true }).isDisabled(), true);
  await recovery.selectOption("verified-app-album-1234");
  await unknown.getByRole("button", { name: "Associate selected album", exact: true }).click();
  assert.deepEqual((await calls(unknown, "google_photos_reconcile"))[0].args, { jobId: "interrupted-job", albumKey: "recover-key", albumId: "verified-app-album-1234" });
  await unknown.getByRole("button", { name: "Resume", exact: true }).waitFor();
  assert.equal((await calls(unknown, "google_photos_start")).length, 0); assert.equal((await calls(unknown, "google_photos_control")).length, 0, "Reconcile does not automatically upload/resume");
  report.checks.push("Lost album-create response has an explicit app-created-album chooser with no title match, no auto-resume and no upload mutation");

  const coverOnly = await fixture({ __googleAlreadyUploadedOnly: true });
  await coverOnly.getByRole("combobox", { name: "Album destination", exact: true }).selectOption("continue");
  await preview(coverOnly);
  const updateDetails = coverOnly.getByRole("button", { name: "Update album details", exact: true });
  await consent(coverOnly).check();
  assert.equal(await updateDetails.isDisabled(), true, "A zero-upload no-op cannot create a needless job");
  await coverOnly.getByRole("combobox", { name: "Album cover horse-24", exact: true }).selectOption("first-original");
  await consent(coverOnly).check();
  assert.equal(await updateDetails.isEnabled(), true, "Existing app-created album cover can change without reuploading identical photos");
  await updateDetails.click();
  assert.equal((await calls(coverOnly, "google_photos_start"))[0].args.albums[0].coverItemId, "first-original");
  report.checks.push("Existing app-created album cover/title edits can run without redundant byte uploads; zero-upload no-ops remain disabled");

  const failed = await fixture({ __googlePlanError: "Synthetic metadata preflight failed; local photos unchanged" });
  await failed.getByRole("button", { name: "Review publish plan", exact: true }).click();
  await failed.getByRole("alert").filter({ hasText: "metadata preflight failed" }).waitFor();
  assert.equal((await calls(failed, "google_photos_start")).length, 0);
  report.checks.push("Preflight failure remains actionable and cannot create albums or start an upload");
  await simplifiedSelection(await fixture(croppedOnlyFixture));
  await metadataReadiness();
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
  report.complete = true; console.log(`Google Photos: ${report.checks.length} browser regression groups passed`);
} catch (error) { report.error = String(error); throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); server?.kill(); }
