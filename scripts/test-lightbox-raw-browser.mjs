import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/lightbox-raw-browser";
await mkdir(output, { recursive: true });
const url = process.env.LIGHTBOX_RAW_TEST_URL || "http://127.0.0.1:1482/lightbox-controls-preview.html";
const server = process.env.LIGHTBOX_RAW_TEST_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1482", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", (data) => { serverLog += data; }); server?.stderr.on("data", (data) => { serverLog += data; });
const errors = [];
const report = { complete: false, scope: "Production Photo Lightbox source selection and exact-version controls using synthetic RAW-named image payloads. No real RAW decoding, user photos or Google API access.", checks: [] };
const root = "D:\\Controller photos";
const tree = (page) => page.getByRole("tree", { name: "Original photo folders", exact: true });
async function pageWith(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000); page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((values) => Object.assign(window, { __controlsRawFixture: true, ...values }), options);
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await tree(page).getByText("01-horse.CR3", { exact: true }).waitFor();
  return page;
}
async function displayed(page, label, suffix) {
  await page.waitForFunction(async ({ label, suffix }) => {
    const node = [...document.querySelectorAll(".review-images img")].find((image) => image.alt === label);
    if (!node?.complete || !node.naturalWidth) return false;
    const data = new Uint8Array(await (await fetch(node.src)).arrayBuffer());
    let text = ""; for (const byte of data) text += String.fromCharCode(byte);
    return window.__controlsPayloads.get(btoa(text))?.path.endsWith(suffix);
  }, { label, suffix });
}
async function ready(page, label, suffix) {
  await displayed(page, label, suffix);
  await page.waitForFunction((label) => { const input = document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`); return input && !input.disabled; }, label);
}
async function hotkey(page, key) { await page.locator('[aria-label="Photo Lightbox review"]').focus(); await page.keyboard.press(key); }
async function saved(page, count) { await page.waitForFunction((count) => window.__controlsSelectionWrites.length === count, count); await page.waitForFunction(() => !document.body.textContent.includes("Saving selections…")); }
try {
  if (server) {
    let started = false;
    for (let attempt = 0; attempt < 80; attempt++) { if (server.exitCode !== null) throw new Error(`Fixture exited: ${serverLog}`); try { if ((await fetch(url)).ok) { started = true; break; } } catch { /* Starting. */ } await delay(250); }
    assert.ok(started, `Fixture failed to start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await pageWith({ __controlsRawWarning: "Synthetic damaged recipe metadata" });
  for (const hidden of ["01-horse.JPG", "01-horse_BW.jpg", "01-horse_improved.jpg", "01-owned-colour.jpg", "01-owned-bw.jpg", "01-retired.jpg"]) assert.equal(await tree(page).getByText(hidden, { exact: true }).count(), 0);
  await tree(page).getByText("01-horse.CR3", { exact: true }).click();
  await ready(page, "Original RAW", "01-horse.CR3"); await displayed(page, "Developed RAW", "01-owned-colour.jpg"); await displayed(page, "B&W", "01-owned-bw.jpg");
  await page.getByText("1 / 2", { exact: true }).waitFor();
  await page.getByText(/Camera preview — not full RAW development.*900 × 600 displayed pixels.*Embedded camera image 6000 × 4000/).waitFor();
  await page.getByText(/RAW metadata needs attention: Synthetic damaged recipe metadata/).waitFor();
  assert.equal(await page.getByRole("img", { name: "Original RAW", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), false);
  assert.equal(await page.getByRole("img", { name: "Developed RAW", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), true);
  assert.equal(await page.getByRole("button", { name: "Crop", exact: true }).isDisabled(), true);
  report.checks.push("A native-identified RAW+JPEG pair is one navigation entry; explicitly owned outputs and retired generations stay out of the tree, with distinct display/embedded-camera dimensions and paired RAW crop disabled");

  await hotkey(page, "q"); await saved(page, 1);
  let write = await page.evaluate(() => window.__controlsSelectionWrites.at(-1));
  assert.equal(write.relativePath, "01-horse.CR3"); assert.equal(write.assetId, `${root}|01-horse.cr3`); assert.equal(write.selected, true);
  await hotkey(page, "Shift+q"); await saved(page, 2);
  write = await page.evaluate(() => window.__controlsSelectionWrites.at(-1)); assert.equal(write.relativePath, "01-horse.CR3"); assert.equal(write.favourite, true);
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg");
  await ready(page, "Camera JPEG", "01-horse.JPG"); await displayed(page, "Enhanced", "01-horse_improved.jpg"); await displayed(page, "B&W", "01-horse_BW.jpg");
  assert.equal(await page.getByRole("img", { name: "Camera JPEG", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), true);
  assert.equal(await page.getByRole("checkbox", { name: "Upload Camera JPEG to Google Photos", exact: true }).isChecked(), false);
  await hotkey(page, "q"); await saved(page, 3);
  write = await page.evaluate(() => window.__controlsSelectionWrites.at(-1)); assert.equal(write.relativePath, "01-horse.JPG"); assert.equal(write.assetId, `${root}|01-horse.jpg`);
  await hotkey(page, "e"); await saved(page, 4);
  assert.equal(await page.evaluate(() => window.__controlsSelectionWrites.at(-1).relativePath), "01-horse_improved.jpg");
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("raw"); await ready(page, "Original RAW", "01-horse.CR3");
  assert.equal(await page.getByRole("checkbox", { name: "Upload Original RAW to Google Photos", exact: true }).isChecked(), true);
  await hotkey(page, "e"); await saved(page, 5);
  assert.equal(await page.evaluate(() => window.__controlsSelectionWrites.at(-1).relativePath), "01-owned-colour.jpg");
  report.checks.push("Q / Shift+Q target exact RAW or camera-JPEG originals independently; changing source switches its own comparison family, and E targets the shown JPEG enhancement or explicitly developed RAW file");

  const advancing = await pageWith();
  await tree(advancing).getByText("01-horse.CR3", { exact: true }).click(); await ready(advancing, "Original RAW", "01-horse.CR3");
  await advancing.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg"); await ready(advancing, "Camera JPEG", "01-horse.JPG");
  await hotkey(advancing, "g"); await ready(advancing, "Original", "02-rider.jpg");
  assert.equal(await advancing.evaluate(() => window.__controlsSelectionWrites.at(-1).relativePath), "01-horse.JPG");
  await advancing.getByText("2 / 2", { exact: true }).waitFor(); await advancing.close();
  report.checks.push("Controller Select and next (G) persists the displayed camera-JPEG source and advances through canonical original captures without visiting hidden derivatives");

  await page.evaluate(() => { window.__controlsDeferSelection = true; });
  await hotkey(page, "q"); await page.waitForFunction(() => typeof window.__controlsReleaseSelection === "function");
  assert.equal(await page.getByRole("combobox", { name: "Original source", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.__controlsDeferSelection = false; window.__controlsReleaseSelection(); }); await saved(page, 6);
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg"); await ready(page, "Camera JPEG", "01-horse.JPG");
  await hotkey(page, "1");
  await tree(page).getByText("01-horse{Like o}.CR3", { exact: true }).waitFor(); await ready(page, "Camera JPEG", "01-horse.JPG");
  assert.equal(await page.evaluate(() => window.__controlsRenames.at(-1).oldPath), `${root}/01-horse.CR3`);
  assert.equal(await tree(page).getByText("01-horse.JPG", { exact: true }).count(), 0);
  report.checks.push("Source changes wait for pending persistence; rating still names the clearly identified RAW original, and refreshed ownership keeps the capture grouped while the displayed JPEG source remains pinned");

  const stale = await pageWith({ __controlsDeferImage: "01-horse.JPG" });
  await tree(stale).getByText("01-horse.CR3", { exact: true }).click(); await ready(stale, "Original RAW", "01-horse.CR3");
  await stale.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg");
  await stale.waitForFunction(() => typeof window.__controlsReleaseImage === "function");
  await hotkey(stale, "q"); assert.equal(await stale.evaluate(() => window.__controlsSelectionWrites.length), 0);
  await hotkey(stale, "ArrowRight"); await ready(stale, "Original", "02-rider.jpg");
  await stale.evaluate(() => { window.__controlsDeferImage = null; window.__controlsReleaseImage(); });
  await displayed(stale, "Original", "02-rider.jpg");
  assert.equal(await stale.getByRole("combobox", { name: "Original source", exact: true }).count(), 0);
  await delay(100); await displayed(stale, "Original", "02-rider.jpg");
  report.checks.push("An incomplete source change cannot write a selection; navigating away invalidates its epoch and a late camera-JPEG read cannot replace the newer visible original");
  await page.screenshot({ path: `${output}/paired-source.png`, fullPage: true });
  await page.close(); await stale.close(); assert.deepEqual(errors, []); report.complete = true;
} catch (error) { report.error = error.stack || String(error); throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); server?.kill(); }
console.log(`RAW Lightbox: ${report.checks.length} browser groups passed`);
