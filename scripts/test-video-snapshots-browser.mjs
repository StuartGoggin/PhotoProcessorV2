import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/video-snapshots-browser";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1448", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, page;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch("http://127.0.0.1:1448/snapshots-preview.html")).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://127.0.0.1:1448/snapshots-preview.html");
  const capture = page.getByRole("button", { name: "＋ Select photo", exact: true });
  const position = page.getByLabel("Video frame position", { exact: true });
  const viewer = page.getByLabel("Frame viewer; scroll to move through frames", { exact: true });
  const waitCapture = () => capture.waitFor().then(() => page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "＋ Select photo" && !b.disabled)));
  await page.getByRole("button", { name: "＋ Add videos", exact: true }).click();
  await page.getByRole("button", { name: /02.*Second camera/ }).waitFor();
  await waitCapture(); checks.push("Multiple original clips index and become browsable");
  await viewer.focus(); await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector('[aria-label="Video frame position"]').value === "1");
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForFunction(() => document.querySelector('[aria-label="Video frame position"]').value === "11");
  await waitCapture(); await capture.click();
  await page.getByLabel("Selected photo person name").fill("Jane Smith");
  await page.keyboard.press("ArrowRight");
  assert.equal(await position.inputValue(), "11", "typing focus does not navigate video");
  checks.push("Exact and ten-frame keys work; fields retain keyboard control");
  await page.getByRole("button", { name: "Choose export folder", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Export this photo", exact: true }).isDisabled(), true);
  await page.getByLabel("I confirm this is the original shooting start", { exact: true }).check();
  await page.getByRole("button", { name: "Export this photo", exact: true }).click();
  await page.getByText("✓ Exported", { exact: true }).waitFor();
  const firstExport = await page.evaluate(() => window.__snapshotExports[0]);
  assert.equal(firstExport.index, 11); assert.equal(firstExport.clipId, "clip-a"); assert.equal(firstExport.personName, "Jane Smith");
  assert.equal(firstExport.shootingStart, "2026-09-20T14:35:10+10:00");
  checks.push("Export requires confirmed time and uses exact frame/source/name");
  await page.getByLabel("Brightness", { exact: true }).focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("button", { name: "Export this photo", exact: true }).isEnabled(), true, "changed recipe requires a fresh derivative");
  await page.getByLabel("Crop improved photo", { exact: true }).check();
  await page.getByRole("button", { name: "After", exact: true }).click();
  await page.getByText("ADJUSTED PREVIEW", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Before", exact: true }).click();
  await page.getByText("ORIGINAL FRAME", { exact: true }).waitFor();
  checks.push("Adjustments invalidate export status; before/after preview is explicit");

  await page.evaluate(() => { window.__deferFrames = true; });
  await position.focus(); await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector('[aria-label="Video frame position"]').value === "179");
  assert.equal(await capture.isDisabled(), true, "stale displayed frame cannot be selected as new target");
  await page.waitForFunction(() => window.__deferredFrames?.length > 0);
  await page.getByRole("button", { name: /02.*Second camera/ }).click();
  await page.evaluate(() => { window.__deferFrames = false; window.__deferredFrames.forEach(resolve => resolve()); window.__deferredFrames = []; });
  await waitCapture();
  await capture.click();
  await page.getByLabel("Selected photo person name").fill("Alex");
  checks.push("Late old-clip frames cannot enable a wrong-source capture");

  // A deliberately slower native seam must still produce changing images while
  // shuttling, rather than cancelling every extraction and freezing the viewer.
  await page.evaluate(() => { window.__frameDelay = 280; });
  const beforeShuttle = await viewer.locator("img").getAttribute("alt");
  await page.getByRole("button", { name: "Forward shuttle", exact: true }).click();
  await page.getByRole("button", { name: "Forward shuttle", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".snapshots-shuttle-badge")?.textContent.includes("2×"));
  await page.waitForFunction(previous => document.querySelector(".snapshots-viewer img")?.getAttribute("alt") !== previous && Number(document.querySelector('[aria-label="Video frame position"]').value) > 15, beforeShuttle);
  await viewer.focus(); await page.keyboard.press("k");
  const stoppedAt = Number(await position.inputValue());
  await delay(180); assert.equal(Number(await position.inputValue()), stoppedAt);
  await page.keyboard.press("j");
  await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Video frame position"]').value) < previous, stoppedAt);
  await page.keyboard.press("k");
  await page.evaluate(() => { window.__frameDelay = 25; });
  await page.getByText("ORIGINAL FRAME", { exact: true }).waitFor();
  const beforeWheel = Number(await position.inputValue());
  await viewer.hover(); await page.mouse.wheel(0, 100);
  await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Video frame position"]').value) > previous, beforeWheel);
  checks.push("Accelerated shuttle keeps images moving, reverses/stops precisely, and wheel scrubs");

  await page.getByRole("button", { name: /^Save session/ }).click();
  const saved = await page.evaluate(() => window.__savedSession);
  assert.equal(JSON.parse(saved).selections.length, 2); assert.equal(saved.includes("data:image"), false);
  await page.evaluate(() => { window.__openPaths = "D:/synthetic/session.snapshots.json"; });
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await page.getByRole("button", { name: /Photo 2, Second camera/ }).waitFor();
  checks.push("Session reload restores multi-clip selections without persisted image data");
  await page.getByRole("button", { name: /Photo 1, First camera/ }).click();
  await page.getByLabel("Selected photo person name").waitFor();
  for (const [width, height] of [[1440, 1000], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const clipped = await page.evaluate(() => {
      const selectors = [".snapshots-workspace", ".snapshots-main", ".snapshots-transport", ".snapshots-inspector", ".snapshots-header-actions", ".snapshots-tray-heading"];
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.scrollWidth > el.clientWidth + 1).map(() => selector));
    });
    assert.deepEqual(clipped, [], `no hidden clipping at ${width}`);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.snapshots-header button,.snapshots-transport button,.snapshots-adjustments input,.snapshots-export-actions button')].every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })), true, `all action controls reachable at ${width}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${output}/snapshots-${width}.png`, fullPage: true });
  }
  checks.push("Desktop, compact and narrow layouts have no horizontal overflow");
  const appPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  appPage.on("pageerror", e => errors.push(e.message));
  await appPage.goto("http://127.0.0.1:1448/studio-preview.html");
  const navigation = appPage.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: /Video snapshots/ }).click();
  await appPage.getByRole("heading", { name: /Video Snapshots/ }).waitFor();
  assert.equal(await appPage.locator("main").count(), 1, "one main landmark in application shell");
  await navigation.getByRole("button", { name: /Video Studio/ }).click();
  await appPage.getByRole("navigation", { name: "Video editing workflow" }).waitFor();
  assert.equal(await appPage.getByRole("heading", { name: /Video Snapshots/ }).isVisible(), false);
  await appPage.close();
  checks.push("Application navigation exposes snapshots and preserves the separate Studio workspace");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ complete: true, scope: "Synthetic browser fixture with mocked IPC; not native media performance", checks }, null, 2));
  console.log(`PASS Video snapshots browser: ${checks.length} checks`);
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  console.error(logs); throw error;
} finally { await browser?.close(); server.kill(); }
