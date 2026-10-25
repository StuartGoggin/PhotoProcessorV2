import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Reuse an existing browser runtime for offline QA; never install a dependency.
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/lightbox-browser";
await mkdir(output, { recursive: true });
const url = process.env.LIGHTBOX_TEST_URL || "http://127.0.0.1:1461/lightbox-preview.html";
const server = process.env.LIGHTBOX_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1461", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", (data) => { serverLog += data; });
server?.stderr.on("data", (data) => { serverLog += data; });
const report = { complete: false, scope: "Real Photo Lightbox controls with deterministic synthetic JPEG image IPC; RAW-named fixture verifies association only, not RAW decoding; not a camera-photo throughput benchmark", checks: [] };
const failures = [];

async function newFixture(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => failures.push(error.message));
  await page.addInitScript((initial) => Object.assign(window, initial), options);
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await page.locator(".review-file-tree").getByText("01-rider.jpg", { exact: true }).waitFor();
  return page;
}
const select = (page, name) => page.locator(".review-file-tree").getByText(name, { exact: true }).click();
const readCount = (page) => page.evaluate(() => window.__lightboxReads.length);
async function waitSettled(page) {
  let previous = -1;
  for (let attempt = 0; attempt < 35; attempt++) {
    const current = await readCount(page);
    if (current === previous && await page.evaluate(() => !window.__lightboxPending.length)) return current;
    previous = current;
    await delay(200);
  }
  throw new Error("Synthetic image reads did not settle");
}
async function displayed(page, label) {
  const image = page.getByRole("img", { name: label, exact: true });
  await image.waitFor();
  return image.evaluate(async (node) => {
    const response = await fetch(node.src);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return window.__lightboxPayloads.get(btoa(text));
  });
}
async function expectImage(page, label, basename, generation) {
  await page.waitForFunction(async ({ label, basename, generation }) => {
    const image = [...document.querySelectorAll(".review-images img")].find((node) => node.alt === label);
    if (!image) return false;
    try {
      const response = await fetch(image.src);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = ""; for (const byte of bytes) text += String.fromCharCode(byte);
      const payload = window.__lightboxPayloads.get(btoa(text));
      return payload?.path.endsWith(`\\${basename}`) && (generation === undefined || payload.generation === generation);
    } catch { return false; }
  }, { label, basename, generation });
}

try {
  if (server) {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Starting. */ }
      await delay(250);
    }
    assert.ok(ready, `Fixture server did not start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await newFixture();
  const tree = page.locator(".review-file-tree");
  for (const hidden of ["01-rider_improved.jpg", "01-rider_BW.jpg", "02-arena_improved.jpg", "02-arena_BW.jpg", "03-wide_improved.jpg", "03-wide_BW{trash}.jpg", "10-close_improved.jpg", "10-close_BW.jpg", "notes.txt", "camera.mp4"]) {
    assert.equal(await tree.getByText(hidden, { exact: true }).count(), 0, `${hidden} is not another original in the tree`);
  }
  for (const visible of ["01-rider.jpg", "02-arena.CR3", "03-wide{Like oo}.PNG", "04-genuine_BW.jpg", "05-course_improved.jpg", "Session", "10-close.jpeg", "11-pan.jpg"]) {
    assert.equal(await tree.getByText(visible, { exact: true }).count(), 1, `${visible} remains browseable`);
  }
  report.checks.push("Only originals and photo folders appear; orphan suffix-name originals are preserved");

  const coldStarted = performance.now();
  await select(page, "01-rider.jpg");
  await expectImage(page, "Original", "01-rider.jpg");
  report.syntheticColdDisplayMs = Math.round(performance.now() - coldStarted);
  await expectImage(page, "B&W", "01-rider_BW.jpg");
  await expectImage(page, "Enhanced", "01-rider_improved.jpg");
  await page.getByText("1 / 5", { exact: true }).waitFor();
  const originalUpload = page.getByRole("checkbox", { name: "Upload Original to Google Photos", exact: true });
  await originalUpload.check();
  await page.waitForFunction(() => window.__lightboxSelectionWrites.length === 1);
  await originalUpload.waitFor();
  assert.equal(await originalUpload.isChecked(), true, "Native acknowledgement persists this exact original selection");
  assert.equal(await page.getByRole("checkbox", { name: "Upload B&W to Google Photos", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "Upload Enhanced to Google Photos", exact: true }).isChecked(), false);
  await page.getByRole("button", { name: "Favourite Original", exact: true }).click();
  await page.waitForFunction(() => window.__lightboxSelectionWrites.length === 2);
  assert.equal(await page.getByRole("button", { name: "Favourite Original", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => window.__lightboxSelectionWrites.some(write => write.command?.includes("start"))), false, "Checking and favouriting never uploads");
  report.checks.push("Each comparison version has independent native-backed upload/favourite curation; checking is not publication");
  assert.equal(await page.getByRole("button", { name: "Previous original photo", exact: true }).isDisabled(), true);
  await page.waitForFunction(() => window.__lightboxReads.some((entry) => entry.path.endsWith("\\02-arena.CR3")));
  const warmed = await waitSettled(page);
  const curationReadsBeforeNavigation = await page.evaluate(() => window.__lightboxCatalogueReads);
  const prepared = await page.evaluate(() => window.__lightboxReads.map((entry) => entry.path));
  assert.ok(prepared.some((path) => path.endsWith("\\02-arena_improved.jpg")), "Upcoming comparison version is prepared too");
  const warmStarted = performance.now();
  await page.getByRole("button", { name: "Next original photo", exact: true }).click();
  await expectImage(page, "Original", "02-arena.CR3");
  report.syntheticCachedForwardDisplayMs = Math.round(performance.now() - warmStarted);
  await expectImage(page, "Enhanced", "02-arena_improved.jpg");
  await page.getByText("2 / 5", { exact: true }).waitFor();
  await page.keyboard.press("ArrowLeft");
  await expectImage(page, "Original", "01-rider.jpg");
  const firstOriginalReads = await page.evaluate(() => window.__lightboxReads.filter((entry) => entry.path.endsWith("\\01-rider.jpg")).length);
  const secondOriginalReads = await page.evaluate(() => window.__lightboxReads.filter((entry) => entry.path.endsWith("\\02-arena.CR3")).length);
  assert.equal(firstOriginalReads, 1, "Back navigation reuses selected-photo cache");
  assert.equal(secondOriginalReads, 1, "Forward navigation consumes prefetched photo without repeat native read");
  assert.equal(await page.evaluate(() => window.__lightboxCatalogueReads), curationReadsBeforeNavigation, "Ordinary next/back navigation does not rescan the whole staging tree for upload curation");
  report.warmReadCount = warmed;
  report.checks.push("Root arrows/counter skip derivatives; read-ahead prepares comparison images and cached forward/back navigation avoids duplicate IPC");

  await select(page, "03-wide{Like oo}.PNG");
  await expectImage(page, "Original", "03-wide{Like oo}.PNG");
  await expectImage(page, "B&W", "03-wide_BW{trash}.jpg");
  await expectImage(page, "Enhanced", "03-wide_improved.jpg");
  await page.getByText("3 / 5", { exact: true }).waitFor();
  await select(page, "10-close.jpeg");
  await expectImage(page, "Enhanced", "10-close_improved.jpg");
  await page.getByText("1 / 2", { exact: true }).waitFor();
  await page.keyboard.press("ArrowRight");
  await expectImage(page, "Original", "11-pan.jpg");
  await page.getByText("2 / 2", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Next original photo", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("img", { name: "B&W", exact: true }).count(), 0, "Missing derivative does not show the previous photo's B&W image");
  report.checks.push("RAW/PNG/JPEG sources resolve .jpg comparisons and review tags; nested navigation stays within its original-only folder and absent variants clear");

  await select(page, "01-rider.jpg");
  await expectImage(page, "Original", "01-rider.jpg");
  const beforeRefresh = await page.evaluate(() => window.__lightboxReads.filter((entry) => entry.path.endsWith("\\01-rider.jpg")).length);
  await page.evaluate(() => { window.__lightboxGeneration++; });
  await page.getByRole("button", { name: "Refresh photos", exact: true }).click();
  await expectImage(page, "Original", "01-rider.jpg", 1);
  assert.ok(await page.evaluate(() => window.__lightboxReads.filter((entry) => entry.path.endsWith("\\01-rider.jpg")).length) > beforeRefresh);
  await page.keyboard.press("1");
  await tree.getByText("01-rider{Like o}.jpg", { exact: true }).waitFor();
  await expectImage(page, "Original", "01-rider{Like o}.jpg", 1);
  await expectImage(page, "Enhanced", "01-rider_improved.jpg", 1);
  assert.equal(await tree.getByText("01-rider_improved.jpg", { exact: true }).count(), 0, "Rating only original does not reveal unchanged generated sibling");
  await page.keyboard.press("ArrowRight");
  await expectImage(page, "Original", "02-arena.CR3");
  await page.keyboard.press("ArrowLeft");
  await expectImage(page, "Original", "01-rider{Like o}.jpg");
  assert.equal(await page.evaluate(() => window.__lightboxRenames.length), 1);
  assert.ok(await page.evaluate(() => window.__lightboxRevokedUrls.length) > 0, "Invalidated image Blob URLs are released");
  report.checks.push("Refresh rereads changed pixels; rating rename refreshes selected path/navigation, preserves comparison association and releases cached URLs");
  await page.screenshot({ path: `${output}/lightbox.png`, fullPage: true });

  const stale = await newFixture({ __lightboxHold: ["01-rider_BW.jpg"] });
  await select(stale, "01-rider.jpg");
  await stale.waitForFunction(() => window.__lightboxPending.some((entry) => entry.path.endsWith("\\01-rider_BW.jpg")));
  await select(stale, "05-course_improved.jpg");
  await expectImage(stale, "Original", "05-course_improved.jpg");
  await stale.evaluate(() => { window.__lightboxHold = []; window.__lightboxReleaseAll(); });
  await waitSettled(stale);
  assert.ok((await displayed(stale, "Original")).path.endsWith("\\05-course_improved.jpg"), "Late previous selection cannot overwrite new image");
  await stale.getByText("5 / 5", { exact: true }).waitFor();
  report.checks.push("Late old comparison read cannot overwrite a different requested original");

  const priority = await newFixture({ __lightboxHold: ["02-arena.CR3"], __lightboxDelay: 30 });
  await select(priority, "01-rider.jpg");
  await expectImage(priority, "Original", "01-rider.jpg");
  await priority.waitForFunction(() => window.__lightboxPending.some((entry) => entry.path.endsWith("\\02-arena.CR3")));
  await select(priority, "05-course_improved.jpg");
  await expectImage(priority, "Original", "05-course_improved.jpg");
  assert.ok(await priority.evaluate(() => window.__lightboxPending.length) > 0, "Foreground selection completes while a speculative native read is still held");
  await priority.evaluate(() => { window.__lightboxHold = []; window.__lightboxReleaseAll(); });
  await waitSettled(priority);
  report.checks.push("An uncached user selection is not queued behind a slow speculative neighbor");

  const leaving = await newFixture({ __lightboxDeferRename: true });
  await select(leaving, "01-rider.jpg");
  await expectImage(leaving, "Original", "01-rider.jpg");
  await waitSettled(leaving);
  await leaving.keyboard.press("1");
  await leaving.waitForFunction(() => !!window.__lightboxResolveRename);
  const beforeLeaving = await leaving.evaluate(() => ({ trees: window.__lightboxTreeReads, images: window.__lightboxReads.length, revoked: window.__lightboxRevokedUrls.length }));
  await leaving.evaluate(() => { window.__lightboxUnmount(); window.__lightboxResolveRename(); });
  await delay(350); // Drain the resolved native promise; there should be no new work to await.
  const afterLeaving = await leaving.evaluate(() => ({ trees: window.__lightboxTreeReads, images: window.__lightboxReads.length, revoked: window.__lightboxRevokedUrls.length }));
  assert.equal(afterLeaving.trees, beforeLeaving.trees, "Completing a rename after leaving the page must not refresh the tree");
  assert.equal(afterLeaving.images, beforeLeaving.images, "Completing a rename after leaving must not restart image reads");
  assert.ok(afterLeaving.revoked > beforeLeaving.revoked, "Leaving releases image Blob URLs even while a rename is pending");
  report.checks.push("Leaving during a delayed rating rename releases cached URLs and its eventual completion cannot restart tree or image reads");

  const cropPage = await newFixture({ __lightboxDeferCropInfo: true });
  await select(cropPage, "01-rider.jpg");
  await expectImage(cropPage, "Original", "01-rider.jpg");
  await cropPage.evaluate(() => localStorage.setItem("photogogo.photoProcess.recipe.v1", JSON.stringify({ bwParams: { localContrast: .2, sharpness: .3, curveStrength: .4, shadowDepth: .1, highlightLift: .08, midpoint: .55 }, enhanceContrastLevel: 1.4, enhanceSharpnessLevel: .75 })));
  await cropPage.keyboard.press("c");
  const cropDialog = cropPage.getByRole("dialog", { name: "Crop photo", exact: true });
  await cropPage.waitForFunction(() => !!window.__lightboxResolveCropInfo);
  assert.equal(await cropPage.evaluate(() => window.__lightboxCropInfoReads), 1, "StrictMode mount replay coalesces the bounded native inspection instead of competing for its exclusive lease");
  await cropPage.evaluate(() => { window.__lightboxDeferCropInfo = false; window.__lightboxResolveCropInfo(); });
  await cropDialog.getByRole("img", { name: "Uncropped original for crop selection" }).waitFor();
  await cropPage.keyboard.press("1"); await cropPage.keyboard.press("Delete"); await cropPage.keyboard.press("ArrowRight");
  assert.equal(await cropPage.evaluate(() => window.__lightboxRenames.length), 0, "Crop mode blocks rating/trash/navigation shortcuts");
  assert.equal(await cropPage.locator(".review-file-tree").getByText("01-rider.jpg", { exact: true }).count(), 1);
  const corner = await cropDialog.getByRole("button", { name: "Crop top-left corner", exact: true }).boundingBox();
  const sourceBox = await cropDialog.getByRole("img", { name: "Uncropped original for crop selection" }).boundingBox();
  await cropPage.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await cropPage.mouse.down(); await cropPage.mouse.move(corner.x + corner.width / 2 + sourceBox.width * .15, corner.y + corner.height / 2 + sourceBox.height * .1, { steps: 8 }); await cropPage.mouse.up();
  const dragged = await cropDialog.getByTestId("crop-selection").evaluate(node => ({ x: parseFloat(node.style.left) / 100, y: parseFloat(node.style.top) / 100 }));
  assert.ok(Math.abs(dragged.x - .15) < .015 && Math.abs(dragged.y - .1) < .015, "Pointer crop coordinates are relative to displayed upright source, not viewport");
  await cropDialog.getByRole("combobox", { name: "Crop aspect ratio" }).selectOption("16:9");
  const landscapeWidth = await cropDialog.getByTestId("crop-selection").evaluate(node => node.style.width);
  await cropDialog.getByRole("button", { name: "Switch to portrait" }).click();
  await cropDialog.getByRole("button", { name: "Switch to landscape" }).click();
  assert.equal(await cropDialog.getByTestId("crop-selection").evaluate(node => node.style.width), landscapeWidth, "Flipping ratio orientation does not repeatedly shrink the framed region");
  await cropDialog.getByRole("button", { name: "Switch to portrait" }).click();
  await cropPage.screenshot({ path: `${output}/crop-desktop.png`, fullPage: true });
  await cropPage.evaluate(() => { window.__lightboxDeferCrop = true; });
  await cropDialog.getByRole("button", { name: "Apply crop & regenerate", exact: true }).click();
  await cropPage.waitForFunction(() => !!window.__lightboxResolveCrop);
  assert.equal(await cropDialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true, "An atomic crop publication cannot be closed or submitted twice");
  await cropPage.keyboard.press("Enter"); await cropPage.keyboard.press("Enter");
  assert.equal(await cropPage.evaluate(() => window.__lightboxCropRequests.length), 1, "Repeated Enter while busy cannot submit duplicate writes");
  const cropRequest = await cropPage.evaluate(() => window.__lightboxCropRequests[0]);
  assert.equal(cropRequest.path, "01-rider.jpg");
  assert.equal(cropRequest.sourceFingerprint, "synthetic-original-v1");
  assert.ok(Math.abs(cropRequest.crop.width * 640 / (cropRequest.crop.height * 480) - 9 / 16) < .00001);
  assert.equal(cropRequest.regenerateBw, true); assert.equal(cropRequest.regenerateEnhanced, true);
  assert.equal(cropRequest.bwParams.localContrast, .2); assert.equal(cropRequest.enhanceContrastLevel, 1.4);
  await cropPage.evaluate(() => window.__lightboxResolveCrop());
  await expectImage(cropPage, "Cropped", "01-rider_crop.jpg", 1);
  await expectImage(cropPage, "B&W", "01-rider_crop_BW.jpg", 1);
  await expectImage(cropPage, "Enhanced", "01-rider_crop_improved.jpg", 1);
  await cropPage.getByRole("checkbox", { name: "Upload Cropped to Google Photos", exact: true }).check();
  await cropPage.getByRole("checkbox", { name: "Upload Cropped Enhanced to Google Photos", exact: true }).check();
  assert.equal(await cropPage.locator(".review-file-tree").getByText("01-rider_crop.jpg", { exact: true }).count(), 0);
  await cropPage.getByRole("group", { name: "Photo version" }).getByRole("button", { name: "Original", exact: true }).click();
  await expectImage(cropPage, "Original", "01-rider.jpg", 1);
  await expectImage(cropPage, "B&W", "01-rider_BW.jpg", 1);
  assert.equal(await cropPage.getByRole("checkbox", { name: "Upload Original to Google Photos", exact: true }).isChecked(), false, "Crop and untouched original upload flags are independent");
  assert.equal(await cropPage.getByRole("checkbox", { name: "Upload Enhanced to Google Photos", exact: true }).isChecked(), false);
  await cropPage.getByRole("button", { name: "Crop", exact: true }).click();
  await cropPage.getByTestId("crop-selection").waitFor();
  const restored = await cropPage.getByTestId("crop-selection").evaluate(node => parseFloat(node.style.width) / 100);
  assert.ok(Math.abs(restored - cropRequest.crop.width) < .00001, "Re-edit restores normalized recipe on original, never a crop-of-a-crop");
  await cropPage.keyboard.press("Escape");
  await cropPage.getByRole("dialog").waitFor({ state: "detached" });
  report.checks.push("Crop editor supports corner drag, fixed portrait ratio, modal shortcut isolation, selected-photo current recipes, atomic busy controls and one-entry Original/Cropped comparisons");

  const cropFailure = await newFixture({ __lightboxCropError: "The existing _crop file is not owned by PhotoGoGo. Original and existing files were not changed." });
  await select(cropFailure, "01-rider.jpg"); await expectImage(cropFailure, "Original", "01-rider.jpg");
  await cropFailure.getByRole("button", { name: "Crop", exact: true }).click();
  await cropFailure.getByRole("button", { name: "Apply crop & regenerate", exact: true }).click();
  await cropFailure.getByRole("alert").filter({ hasText: "not owned" }).waitFor();
  assert.equal(await cropFailure.getByRole("dialog").count(), 1, "Ownership collision remains an actionable error, not a success");
  assert.equal(await cropFailure.locator(".review-file-tree").getByText("01-rider_crop.jpg", { exact: true }).count(), 0);
  await cropFailure.evaluate(() => { window.__lightboxCropError = null; window.__lightboxCropFingerprint = "synthetic-original-v2"; window.__lightboxGeneration++; });
  await cropFailure.getByRole("button", { name: "Apply crop & regenerate", exact: true }).click();
  await cropFailure.getByRole("alert").filter({ hasText: "original has changed" }).waitFor();
  await cropFailure.getByRole("button", { name: "Reload original and reset selection" }).click();
  await cropFailure.waitForFunction(() => !document.querySelector('[role="alert"]') && !!document.querySelector('[alt="Uncropped original for crop selection"]'));
  assert.equal((await displayed(cropFailure, "Uncropped original for crop selection")).generation, 1, "Reload crop preview uses the same new native snapshot as its fingerprint, never cached original pixels");
  await cropFailure.getByRole("button", { name: "Apply crop & regenerate", exact: true }).click();
  await expectImage(cropFailure, "Cropped", "01-rider_crop.jpg", 2);
  assert.equal(await cropFailure.evaluate(() => window.__lightboxCropRequests.at(-1).sourceFingerprint), "synthetic-original-v2");
  report.checks.push("Unowned output collisions stay visible; stale original fingerprint rejects apply and explicit reload resets selection with a fresh source");

  const cropCompact = await newFixture();
  await cropCompact.setViewportSize({ width: 390, height: 844 });
  await select(cropCompact, "01-rider.jpg"); await expectImage(cropCompact, "Original", "01-rider.jpg");
  await cropCompact.getByRole("button", { name: "Crop", exact: true }).click();
  await cropCompact.getByRole("img", { name: "Uncropped original for crop selection" }).waitFor();
  await cropCompact.screenshot({ path: `${output}/crop-compact.png`, fullPage: true });
  const geometry = await cropCompact.getByRole("dialog").evaluate(node => ({ width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth, height: node.getBoundingClientRect().height }));
  assert.ok(geometry.width <= 390 && geometry.scrollWidth <= 390 && geometry.height <= 844, "Crop editor fits compact viewport without horizontal overflow");
  const cropSelectionBox = await cropCompact.getByTestId("crop-selection").boundingBox();
  assert.ok(cropSelectionBox.height > 100 && cropSelectionBox.width > 100, "Compact editor retains useful image working area");
  await cropCompact.keyboard.press("Escape");
  await select(cropCompact, "02-arena.CR3"); await expectImage(cropCompact, "Original", "02-arena.CR3");
  assert.equal(await cropCompact.getByRole("button", { name: "Crop", exact: true }).isDisabled(), true, "Unsupported RAW cannot enter JPEG crop pipeline");
  report.checks.push("Compact crop controls fit 390px viewport with useful image area; RAW crop is clearly disabled");

  const selectionFailure = await newFixture({ __lightboxSelectionWriteError: "Synthetic protected curation write failure" });
  await select(selectionFailure, "01-rider.jpg"); await expectImage(selectionFailure, "Original", "01-rider.jpg");
  await selectionFailure.getByRole("checkbox", { name: "Upload Original to Google Photos", exact: true }).click();
  await selectionFailure.getByRole("status").filter({ hasText: "Selection was not saved" }).waitFor();
  assert.equal(await selectionFailure.getByRole("checkbox", { name: "Upload Original to Google Photos", exact: true }).isChecked(), false, "Failed curation cannot look successfully saved");
  await expectImage(selectionFailure, "Original", "01-rider.jpg");
  report.checks.push("Selection persistence failure remains visible without breaking image review or falsely checking a version");
  await selectionFailure.close();
  const taggedPair = await newFixture({ __lightboxTaggedPairFixture: true });
  await select(taggedPair, "paired{Like oo}.jpg");
  await expectImage(taggedPair, "Original", "paired{Like oo}.jpg");
  await expectImage(taggedPair, "B&W", "paired_BW.jpg");
  await expectImage(taggedPair, "Enhanced", "paired_improved.jpg");
  await taggedPair.getByRole("checkbox", { name: "Upload Enhanced to Google Photos", exact: true }).check();
  assert.equal((await taggedPair.evaluate(() => window.__lightboxSelectionWrites.at(-1))).assetId, "paired_improved.jpg");
  await select(taggedPair, "paired.CR3"); await expectImage(taggedPair, "Original", "paired.CR3");
  assert.equal(await taggedPair.getByRole("img", { name: "B&W", exact: true }).count(), 0);
  assert.equal(await taggedPair.getByRole("img", { name: "Enhanced", exact: true }).count(), 0);
  report.checks.push("Untagged RAW never steals the rated JPEG's processed panels or upload flags; ambiguous variants remain visible");
  await taggedPair.close();

  await page.close(); await stale.close(); await priority.close(); await leaving.close(); await cropPage.close(); await cropFailure.close(); await cropCompact.close();
  assert.deepEqual(failures, [], "No browser runtime errors");
  report.complete = true;
  console.log(`Photo Lightbox: ${report.checks.length} browser regression groups passed`);
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  server?.kill();
}
