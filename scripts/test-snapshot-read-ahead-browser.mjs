import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");

const output = "test-output/snapshot-read-ahead";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1453", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
const report = { complete: false, scope: "Real viewer controls; deterministic synthetic native IPC delay, not camera-footage performance", checks: [] };
try {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch("http://127.0.0.1:1453/snapshots-preview.html")).ok) break; } catch {}
    await delay(200);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => { window.__frameCount = 601; window.__frameDelay = 120; });
  await page.goto("http://127.0.0.1:1453/snapshots-preview.html");
  await page.getByRole("button", { name: "＋ New session", exact: true }).click();
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.getByRole("button", { name: "＋ Add videos", exact: true }).click();
  const position = page.getByLabel("Video frame position", { exact: true });
  const viewer = page.getByLabel("Frame viewer; scroll to move through frames", { exact: true });
  const waitExact = () => page.waitForFunction(() => {
    const index = Number(document.querySelector('[aria-label="Video frame position"]').value);
    return document.querySelector('.snapshots-viewer img')?.alt.startsWith(`Original video frame ${index + 1} at `);
  });
  await waitExact();
  const box = await position.boundingBox();
  await position.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await waitExact();
  const centre = Number(await position.inputValue());
  assert.ok(centre > 200 && centre < 400);
  await delay(4000); // Fixed warm-up budget; identical before/after comparison.
  const warmed = await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "snapshot_frames").map(c => c.args));
  await viewer.focus();
  const started = performance.now();
  await page.keyboard.press("Shift+ArrowRight");
  await waitExact();
  report.tenFrameStepMs = Math.round(performance.now() - started);
  report.centre = centre;
  report.requestedFrames = [...new Set(warmed.flatMap(r => Array.from({ length: r.count }, (_, i) => r.start + i)))].sort((a, b) => a - b);
  console.log(`Paused-viewer coverage: ${report.requestedFrames.length} frames; ten-frame step: ${report.tenFrameStepMs} ms`);
  for (let index = centre - 10; index <= centre + 10; index++) {
    assert.ok(report.requestedFrames.includes(index), `Idle viewer should prepare frame ${index} within ±10 before a step`);
  }
  report.checks.push("Paused viewer prepares both neighbouring ten-frame windows");
  assert.ok(warmed.every(r => r.count <= 12), "Preparation remains split into bounded requests");
  const first = warmed.find(r => r.start >= centre - 100);
  assert.deepEqual({ start: first.start, count: first.count }, { start: centre, count: 1 }, "Exact requested frame precedes background preparation");
  report.checks.push("Target is requested alone first; preparation batches never exceed twelve");
  const waitWindow = () => page.waitForFunction(() => document.querySelector('[aria-label="Read-ahead status"]')?.textContent.includes("100 before · 100 after"));
  await waitWindow();
  const callCount = () => page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "snapshot_frames").length);
  const settled = await callCount(); await delay(500); assert.equal(await callCount(), settled);
  report.checks.push("Idle cache expands to ±100 and then stops requesting frames");
  await viewer.focus();
  const reversedAt = performance.now();
  await page.keyboard.press("Shift+ArrowLeft"); await waitExact();
  report.reverseTenFrameStepMs = Math.round(performance.now() - reversedAt);
  report.checks.push("Reversing within the prepared window displays the exact cached frame");

  // A new clip has no warm window. Hold its first background batch, then jump.
  await page.evaluate(() => { window.__snapshotCalls = []; });
  await page.getByRole("button", { name: /02.*Second camera/ }).click(); await waitExact();
  await page.evaluate(() => { window.__deferFrames = true; });
  await page.waitForFunction(() => window.__deferredFrames?.length > 0);
  const deferred = await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "snapshot_frames").at(-1).args.requestId);
  await position.focus(); await page.keyboard.press("End");
  await page.waitForFunction(id => window.__snapshotCalls.some(c => c.command === "snapshot_cancel" && c.args.requestId === id), deferred);
  await page.evaluate(() => { window.__deferFrames = false; window.__deferredFrames.splice(0).forEach(resolve => resolve()); });
  await waitExact(); assert.equal(Number(await position.inputValue()), 600);
  assert.equal(await page.getByRole("alert").count(), 0);
  report.checks.push("An uncached jump cancels/drains read-ahead and ignores its late response");

  // Selecting a photo starts the independent full-resolution adjustment lane.
  await page.evaluate(() => { window.__deferFrames = true; window.__deferAdjustment = true; window.__snapshotCalls = []; });
  await page.waitForFunction(() => window.__deferredFrames?.length > 0);
  await page.getByRole("button", { name: "＋ Select photo", exact: true }).click();
  await page.waitForFunction(() => window.__releaseAdjustment && window.__snapshotCalls.some(c => c.command === "snapshot_cancel"));
  const adjustmentCalls = await callCount(); await delay(400); assert.equal(await callCount(), adjustmentCalls);
  await page.evaluate(() => {
    window.__deferFrames = false; window.__deferredFrames.splice(0).forEach(resolve => resolve());
    window.__deferAdjustment = false; window.__releaseAdjustment();
  });
  await page.getByText("ADJUSTED PREVIEW", { exact: true }).waitFor();
  report.checks.push("Adjustment previews preempt and pause speculative decoding");
  await page.getByRole("button", { name: "Choose export folder", exact: true }).click();
  await page.getByLabel("I confirm this is the original shooting start", { exact: true }).check();
  await page.evaluate(() => { window.__deferExport = true; window.__deferFrames = true; window.__snapshotCalls = []; });
  await page.waitForFunction(() => window.__deferredFrames?.length > 0);
  await page.getByRole("button", { name: "Export full-resolution photo", exact: true }).first().click();
  await page.waitForFunction(() => window.__releaseExport && window.__snapshotCalls.some(c => c.command === "snapshot_cancel"));
  const exportCalls = await callCount(); await delay(400); assert.equal(await callCount(), exportCalls);
  const exported = await page.evaluate(() => window.__snapshotExports.at(-1));
  assert.equal(exported.index, 600); assert.equal(exported.clipId, "clip-b");
  assert.equal(Object.values(exported).some(v => typeof v === "string" && v.startsWith("data:image/")), false);
  await page.evaluate(() => {
    window.__deferFrames = false; window.__deferredFrames.splice(0).forEach(resolve => resolve());
    window.__deferExport = false; window.__releaseExport();
  });
  await page.getByText("✓ Exported", { exact: true }).waitFor();
  report.checks.push("Export preempts read-ahead and receives original clip/frame, never preview pixels");

  await page.evaluate(() => { window.__deferFrames = true; });
  await page.waitForFunction(() => window.__deferredFrames?.length > 0);
  const leaving = await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "snapshot_frames").at(-1).args.requestId);
  await page.evaluate(() => window.__setSnapshotsActive(false));
  await page.waitForFunction(id => window.__snapshotCalls.some(c => c.command === "snapshot_cancel" && c.args.requestId === id), leaving);
  const inactiveCalls = await callCount(); await delay(400); assert.equal(await callCount(), inactiveCalls);
  await page.evaluate(() => { window.__deferFrames = false; window.__deferredFrames.splice(0).forEach(resolve => resolve()); window.__setSnapshotsActive(true); });
  await waitExact();
  report.checks.push("Leaving the viewer cancels preparation and late replies cannot revive it");
  await page.getByRole("button", { name: /01.*First camera/ }).click(); await waitExact(); await waitWindow();
  await page.getByLabel("Preview cache budget", { exact: true }).selectOption("16");
  await delay(1500);
  const reduced = await callCount(); await delay(600); assert.equal(await callCount(), reduced);
  report.checks.push("Reducing the preview cache settles without repeated requests");
  await page.screenshot({ path: `${output}/viewer.png`, fullPage: true });
  report.complete = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(`${output}/${process.env.SNAPSHOT_BASELINE ? "baseline" : "report"}.json`, JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  server.kill();
}
