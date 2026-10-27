import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/photo-process-browser";
await mkdir(output, { recursive: true });
const url = process.env.PHOTO_PROCESS_TEST_URL || "http://127.0.0.1:1462/photo-process-preview.html";
const server = process.env.PHOTO_PROCESS_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1462", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", (data) => { serverLog += data; });
server?.stderr.on("data", (data) => { serverLog += data; });
const report = { complete: false, scope: "Production Photo Process page; deterministic synthetic image/video native adapter. Validates interaction/IPC, not real photograph processing quality or throughput.", checks: [] };
const errors = [];
const card = (page, name) => page.getByRole("region", { name, exact: true });
async function range(locator, value) {
  await locator.evaluate((node, amount) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, String(amount));
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
async function complete(page, task, predicate) {
  await page.waitForFunction(({ task, predicate }) => {
    const calls = window.__previewCalls.filter((request) => request.task === task);
    return calls.length && window.__previewActive === 0 && (!predicate || Function("request", `return (${predicate});`)(calls.at(-1)));
  }, { task, predicate });
  await page.getByRole("status").waitFor({ state: "detached" });
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("heading", { name: "Photo Process", exact: true }).waitFor();
  const bw = card(page, "B&W Conversion");
  await bw.getByRole("button", { name: "Preview B&W Conversion", exact: true }).click();
  await complete(page, "bw");
  await bw.getByRole("img", { name: "Original photo preview", exact: true }).waitFor();
  await bw.getByRole("img", { name: "Result photo preview", exact: true }).waitFor();
  assert.equal(await bw.getByRole("img", { name: "Result photo preview", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), false, "Photo Process previews are not finished exports");
  assert.equal(await page.evaluate(() => window.__queuedJobs.length), 0);
  const first = await page.evaluate(() => window.__previewCalls.at(-1));
  assert.deepEqual(first.bwParams, { localContrast: 1, sharpness: 0.6, curveStrength: 0.25, shadowDepth: 0.12, highlightLift: 0.12, midpoint: 0.5 });
  assert.equal(first.fullResolution, false);
  assert.equal(first.scopeDir, "D:\\Photos");
  assert.equal(first.scopeMode, "entireStaging");
  report.checks.push("B&W preview starts from a scoped original, includes all six gentle defaults and does not queue or mutate files");

  await page.evaluate(() => { window.__holdPreviews = true; });
  await range(bw.getByRole("slider", { name: "S-curve strength", exact: true }), 0.3);
  await page.waitForFunction(() => window.__previewDeferred.length === 1);
  await range(bw.getByRole("slider", { name: "S-curve strength", exact: true }), 0.45);
  await range(bw.getByRole("slider", { name: "S-curve strength", exact: true }), 0.6);
  const countHeld = await page.evaluate(() => window.__previewCalls.length);
  await page.waitForFunction(() => !!document.querySelector('[role="status"]'));
  // Let the debounce mature while the earlier native call is deliberately held.
  await delay(500);
  assert.equal(await page.evaluate(() => window.__previewCalls.length), countHeld);
  await page.evaluate(() => { window.__holdPreviews = false; window.__previewDeferred.splice(0).forEach((resolve) => resolve()); });
  await complete(page, "bw", "request.bwParams.curveStrength === 0.6");
  const latest = await page.evaluate(() => window.__previewCalls.at(-1));
  assert.equal(latest.path, first.path, "Slider changes retain the same sample");
  assert.equal(await page.evaluate(() => window.__maxPreviewActive), 1);
  assert.equal(await page.evaluate(() => window.__previewCalls.filter((request) => request.bwParams?.curveStrength === 0.45).length), 0);
  report.checks.push("Slider work is debounced and serial: obsolete intermediate requests are skipped; the sample remains fixed and only latest results can display");

  await bw.getByRole("button", { name: "100% · full-resolution check", exact: true }).click();
  await complete(page, "bw", "request.fullResolution === true");
  const pixelSize = await bw.getByRole("img", { name: "Result photo preview", exact: true }).evaluate((node) => ({ naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight, displayedWidth: node.getBoundingClientRect().width }));
  assert.deepEqual(pixelSize, { naturalWidth: 1800, naturalHeight: 2700, displayedWidth: 1800 });
  await bw.getByRole("img", { name: "Original photo preview", exact: true }).evaluate((node) => {
    node.parentElement.scrollLeft = 120; node.parentElement.scrollTop = 160;
    node.parentElement.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="Result photo preview"]');
    return image?.parentElement.scrollLeft === 120 && image.parentElement.scrollTop === 160;
  });
  await range(bw.getByRole("slider", { name: "B&W sharpening", exact: true }), 0);
  await complete(page, "bw", "request.fullResolution === false && request.bwParams.sharpness === 0");
  assert.equal(await bw.getByRole("button", { name: "Fit", exact: true }).getAttribute("aria-pressed"), "true");
  report.checks.push("100% uses full-resolution natural pixel dimensions, including portrait geometry and synchronized scrolling; further adjustments return to bounded drafts");

  await bw.getByRole("button", { name: "Choose photo…", exact: true }).click();
  await bw.getByRole("listbox", { name: "Preview original", exact: true }).selectOption("D:\\Photos\\Portrait.jpg");
  await complete(page, "bw", "request.path.endsWith('Portrait.jpg')");
  await bw.getByRole("button", { name: "Another random photo", exact: true }).click();
  await complete(page, "bw", "!request.path.endsWith('Portrait.jpg')");
  const beforeQueue = await page.evaluate(() => window.__previewCalls.at(-1));
  await bw.getByRole("button", { name: "Queue Job", exact: true }).click();
  await page.waitForFunction(() => window.__queuedJobs.length === 1);
  const queued = await page.evaluate(() => window.__queuedJobs[0]);
  assert.deepEqual(queued.bwParams, beforeQueue.bwParams);
  assert.equal(queued.scopeDir, beforeQueue.scopeDir);
  assert.equal(queued.scopeMode, beforeQueue.scopeMode);
  assert.equal(queued.task, "bw");
  assert.equal(queued.path, undefined, "Queue applies to the scope, not just the sample");
  report.checks.push("Choose/random sample actions work; Queue Job sends the exact preview options and scope, without restricting the batch to the sample");

  const enhance = card(page, "JPG Enhancement");
  await enhance.getByRole("button", { name: "Preview JPG Enhancement", exact: true }).click();
  await complete(page, "enhance");
  await range(enhance.getByRole("slider", { name: "Enhancement contrast", exact: true }), 0);
  await range(enhance.getByRole("slider", { name: "Enhancement sharpening", exact: true }), 0);
  await complete(page, "enhance", "request.enhanceContrastLevel === 0 && request.enhanceSharpnessLevel === 0");
  await enhance.getByRole("button", { name: "Queue Job", exact: true }).click();
  await page.waitForFunction(() => window.__queuedJobs.length === 2);
  assert.equal(await page.evaluate(() => window.__queuedJobs[1].enhanceSharpnessLevel), 0);
  report.checks.push("Enhancement preview and queue share both adjustment values, including genuine Off settings");

  const focus = card(page, "Focus Detection");
  await focus.getByRole("button", { name: "Preview Focus Detection", exact: true }).click();
  await complete(page, "focus");
  await focus.getByText("Would not flag this original", { exact: true }).waitFor();
  await focus.getByText(/Maximum focus score: 612.0/).waitFor();
  assert.equal(await page.evaluate(() => window.__queuedJobs.length), 2);
  report.checks.push("Focus preview displays the analysis verdict and scores without queueing or renaming");

  for (const [name, task] of [["Focus Detection", "remove_focus"], ["JPG Enhancement", "remove_enhance"], ["B&W Conversion", "remove_bw"], ["MP4 Stabilisation", "remove_stabilize"]]) {
    const job = card(page, name);
    await job.getByRole("button", { name: "Preview cleanup files", exact: true }).click();
    await complete(page, task);
    await job.getByText("2 files would be affected by this cleanup job.", { exact: true }).waitFor();
    assert.equal(await job.getByRole("list", { name: "Cleanup affected files", exact: true }).getByRole("listitem").count(), 2);
  }
  assert.equal(await page.evaluate(() => window.__queuedJobs.length), 2);
  report.checks.push("All four cleanup previews list affected files and counts only; none invokes the mutating job command");

  const video = card(page, "MP4 Stabilisation");
  const priorVideoCalls = await page.evaluate(() => window.__previewCalls.filter((request) => request.task === "stabilize").length);
  await video.getByRole("button", { name: "Preview MP4 Stabilisation", exact: true }).click();
  await video.getByText("Course.mp4", { exact: true }).or(video.getByText("Practice.mp4", { exact: true })).waitFor();
  assert.equal(await page.evaluate(() => window.__previewCalls.filter((request) => request.task === "stabilize").length), priorVideoCalls);
  await video.getByRole("spinbutton", { name: "Video preview start seconds", exact: true }).fill("12");
  await video.getByRole("button", { name: "Generate 5-second preview", exact: true }).click();
  await complete(page, "stabilize", "request.startSeconds === 12");
  assert.equal(await video.locator("video").count(), 2);
  await video.getByRole("button", { name: "Max Frame", exact: false }).click();
  await video.locator("video").first().waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__previewCalls.filter((request) => request.task === "stabilize").length), priorVideoCalls + 1);
  report.checks.push("Video preview requires an explicit click, captures start time and shows motion comparison; changing options clears stale playback without starting another render");

  await page.getByRole("button", { name: "This folder only", exact: false }).click();
  await page.waitForFunction(() => window.__candidateCalls.at(-1)?.scopeMode === "folderOnly");
  await page.getByText("Event", { exact: true }).click();
  await page.waitForFunction(() => window.__candidateCalls.at(-1)?.scopeDir === "D:\\Photos\\Event");
  assert.equal(await page.evaluate(() => window.__candidateCalls.at(-1).scopeMode), "folderOnly");
  report.checks.push("Changing processing scope reloads samples from the exact selected folder/mode");

  await page.evaluate(() => { window.__holdPreviews = true; });
  await bw.getByRole("button", { name: "Preview B&W Conversion", exact: true }).click();
  await page.waitForFunction(() => window.__previewDeferred.length === 1);
  await page.getByRole("button", { name: "Use Full Staging", exact: true }).click();
  await page.waitForFunction(() => window.__candidateCalls.at(-1)?.scopeDir === "D:\\Photos");
  await delay(450);
  assert.equal(await page.evaluate(() => window.__previewActive), 1);
  await page.evaluate(() => { window.__holdPreviews = false; window.__previewDeferred.splice(0).forEach((resolve) => resolve()); });
  await complete(page, "bw", "request.scopeDir === 'D:\\\\Photos' && request.scopeMode === 'entireStaging'");
  assert.equal(await page.evaluate(() => window.__maxPreviewActive), 1);
  report.checks.push("A scope change during held native work discards the old comparison; the latest scoped original waits on the same serial preview lane");

  const queuedBeforeError = await page.evaluate(() => window.__queuedJobs.length);
  await page.evaluate(() => { window.__previewError = "Synthetic preview failure"; });
  await range(bw.getByRole("slider", { name: "B&W sharpening", exact: true }), 0.1);
  await bw.getByRole("alert").getByText("Preview unavailable: Error: Synthetic preview failure", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__queuedJobs.length), queuedBeforeError);
  await page.evaluate(() => { window.__previewError = null; });
  await bw.getByRole("button", { name: "Retry preview", exact: true }).click();
  await complete(page, "bw");
  assert.equal(await bw.getByRole("alert").count(), 0);
  report.checks.push("Preview failures are explicit, do not queue jobs, and can be retried without losing the sample or adjustment values");

  await page.evaluate(() => { window.__emptyScope = true; });
  await page.getByRole("button", { name: "Folder recursively", exact: false }).click();
  await bw.getByText("No eligible originals in this scope", { exact: true }).waitFor();
  assert.equal(await bw.getByRole("button", { name: "100% · full-resolution check", exact: true }).isDisabled(), true);
  report.checks.push("Empty scopes explain why there is no sample and disable full-resolution checks");

  await page.setViewportSize({ width: 360, height: 844 });
  await page.screenshot({ path: `${output}/compact.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Compact layout has no horizontal page overflow");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { window.__emptyScope = false; });
  await page.getByRole("button", { name: "Use Full Staging", exact: true }).click();
  await complete(page, "bw");
  await bw.getByRole("img", { name: "Result photo preview", exact: true }).waitFor();
  await bw.screenshot({ path: `${output}/bw-desktop.png` });
  await page.setViewportSize({ width: 360, height: 844 });
  await bw.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${output}/bw-compact-controls.png` });
  await bw.getByRole("region", { name: "bw preview", exact: true }).evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${output}/bw-compact-preview.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Image comparison also fits the compact viewport");
  const urlsBefore = await page.evaluate(() => window.__revokedPreviews.length);
  await page.evaluate(() => window.__unmountPhotoProcess());
  assert.ok(await page.evaluate(() => window.__revokedPreviews.length) > urlsBefore);
  assert.equal(await page.evaluate(() => window.__maxPreviewActive), 1);
  assert.deepEqual(errors, []);
  report.checks.push("Compact layout fits 360px; leaving releases image URLs; no concurrent native preview or browser runtime errors");
  report.complete = true;
  console.log(`Photo Process: ${report.checks.length} browser regression groups passed`);
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  server?.kill();
}
