import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/video-snapshots-export-browser";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1449", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, page;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch("http://127.0.0.1:1449/snapshots-preview.html")).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://127.0.0.1:1449/snapshots-preview.html");
  await page.getByRole("button", { name: "＋ Add videos", exact: true }).click();
  const capture = page.getByRole("button", { name: "＋ Select photo", exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "＋ Select photo" && !b.disabled));
  await capture.click();
  await page.waitForFunction(() => document.querySelector(".snapshots-photo-thumb img")?.naturalWidth > 0);
  for (const selector of [".snapshots-viewer img", ".snapshots-photo-thumb img"]) {
    const prevented = await page.locator(selector).evaluate(el => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    assert.equal(prevented, true, `${selector}: browser Save image as must not silently save a preview`);
  }
  const help = await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "plugin:dialog|message"));
  assert.equal(help.length, 2); assert.ok(help.every(c => JSON.stringify(c.args).includes("full-resolution")));
  assert.equal(await page.evaluate(() => window.__snapshotExports.length), 0, "right-click does not write a file without an export action");
  checks.push("Viewer and tray block thumbnail Save image as and explain full-resolution export without writing");
  const single = page.getByRole("button", { name: "Export full-resolution photo", exact: true });
  const batch = page.getByRole("button", { name: "Export 1 full-resolution photo", exact: true });
  assert.equal(await single.isDisabled(), true);
  assert.match(await page.locator("#snapshot-photo-export-reason").innerText(), /Choose an export folder/);
  await page.getByRole("button", { name: "Choose export folder", exact: true }).click();
  assert.equal(await single.isDisabled(), true); assert.equal(await batch.isDisabled(), true);
  assert.match(await page.locator("#snapshot-photo-export-reason").innerText(), /Confirm.*shooting start/);
  await page.getByLabel("I confirm this is the original shooting start", { exact: true }).check();
  assert.equal(await single.isEnabled(), true); assert.equal(await batch.isEnabled(), true);
  await single.click(); await page.getByText("✓ Exported", { exact: true }).waitFor();
  const exportedPath = "D:/synthetic/Photos/2026/09/20/20260920_143510_020_Jane.jpg";
  await page.getByText(exportedPath, { exact: true }).waitFor();
  await page.getByText("Full-resolution original · 3840 × 2160", { exact: true }).waitFor();
  const first = await page.evaluate(() => window.__snapshotExports[0]);
  assert.equal(first.index, 0); assert.equal(first.clipId, "clip-a");
  assert.equal(JSON.stringify(first).includes("data:image"), false, "export gets source identity/index, never display pixels");
  assert.match(await page.locator("#snapshot-batch-export-reason").innerText(), /already exported/);
  checks.push("Export gates explain folder/time; exact source index goes to native export; saved dimensions and dated path are visible");
  await page.getByRole("button", { name: "Show original in folder", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "reveal_in_explorer").at(-1).args.path), exportedPath);
  await page.evaluate(() => { window.__revealError = "Path does not exist: moved-photo.jpg"; });
  await page.getByRole("button", { name: "Show original in folder", exact: true }).click();
  await page.locator(".snapshots-export-location-error").getByText(/Path does not exist/).waitFor();
  checks.push("Show in folder uses the returned file path and surfaces a missing-file error locally");
  await page.evaluate(() => { window.__exportFolder = "D:/synthetic/A different destination with a long folder name"; window.__revealError = ""; });
  await page.getByRole("button", { name: "Folder: Photos", exact: true }).click();
  assert.equal(await single.isEnabled(), true); assert.equal(await batch.isEnabled(), true);
  await page.getByText("Previously exported", { exact: true }).waitFor();
  assert.equal(await page.getByText(exportedPath, { exact: true }).isVisible(), true, "changing folder preserves the previous receipt/location");
  await page.getByRole("button", { name: "Show original in folder", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "reveal_in_explorer").at(-1).args.path), exportedPath);
  await page.evaluate(() => { window.__exportFolder = "D:/synthetic/Photos"; });
  await page.getByRole("button", { name: /^Folder:/ }).click();
  assert.equal(await single.isDisabled(), true, "returning to the original destination restores its current receipt");
  await page.evaluate(() => { window.__exportFolder = "D:/synthetic/A different destination with a long folder name"; window.__revealError = "Path does not exist: old-location.jpg"; });
  await page.getByRole("button", { name: /^Folder:/ }).click();
  await page.getByRole("button", { name: "Show original in folder", exact: true }).click();
  await page.locator(".snapshots-export-location-error").getByText(/old-location/).waitFor();
  await batch.click(); await page.getByText("✓ Exported", { exact: true }).waitFor();
  assert.equal(await page.locator(".snapshots-export-location-error").count(), 0, "a successful replacement export must not retain the previous file's missing-location error");
  await page.evaluate(() => { window.__revealError = ""; });
  assert.equal(await page.evaluate(() => window.__snapshotExports.at(-1).destination), "D:/synthetic/A different destination with a long folder name");
  checks.push("New destination allows export while retaining previous location until replacement receipt arrives");
  await page.evaluate(() => { window.__exportFolder = "D:\\synthetic\\A DIFFERENT DESTINATION WITH A LONG FOLDER NAME\\"; });
  await page.getByRole("button", { name: /^Folder:/ }).click();
  assert.equal(await single.isDisabled(), true, "same Windows folder with alternate case/slashes is not a new export destination");
  checks.push("Equivalent Windows folder spellings do not create duplicate export work");
  await page.getByLabel("Brightness", { exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await page.evaluate(() => { window.__exportError = "Destination is read-only"; });
  await single.click(); await page.getByText("Destination is read-only", { exact: true }).waitFor();
  assert.equal(await single.isEnabled(), true, "failed export stays retryable");
  assert.equal(await page.getByText("✓ Exported", { exact: true }).count(), 0);
  await page.evaluate(() => { window.__exportError = ""; });
  await single.click(); await page.getByText("✓ Exported", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show improved photo in folder", exact: true }).click();
  assert.ok(await page.evaluate(() => window.__snapshotCalls.filter(c => c.command === "reveal_in_explorer").at(-1).args.path.endsWith("_improved.jpg")));
  checks.push("Failures remain visible/retryable; enhanced copies have a distinct location action");
  for (const [width, height] of [[1440, 1000], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.deepEqual(await page.evaluate(() => [".snapshots-workspace", ".snapshots-export-success", ".snapshots-export-actions", ".snapshots-tray-heading"].flatMap(s => [...document.querySelectorAll(s)].filter(el => el.scrollWidth > el.clientWidth + 1).map(() => s))), [], `export controls/paths wrap at ${width}`);
    await page.screenshot({ path: `${output}/export-${width}.png`, fullPage: true });
  }
  checks.push("Full saved paths and export actions fit desktop, compact and narrow layouts");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ complete: true, scope: "Real React controls with mocked native IPC. Physical full-resolution output is validated separately in native media tests.", checks }, null, 2));
  console.log(`PASS snapshots export browser: ${checks.length} checks`);
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  console.error(logs); throw error;
} finally { await browser?.close(); server.kill(); }
