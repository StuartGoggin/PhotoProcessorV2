import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const url = "http://127.0.0.1:1441/studio-preview.html";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1441", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server.stdout.on("data", data => { serverLog += data; });
server.stderr.on("data", data => { serverLog += data; });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(250);
  }
  assert.ok(ready, serverLog);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  await page.locator("#studio-review").waitFor();
  const projectSettings = page.locator("#studio-project-settings");
  await projectSettings.getByRole("button", { name: "Filters", exact: true }).click();
  const projectToggle = page.getByRole("checkbox", { name: "Prevent added rotation · project default", exact: true });
  const clipOverride = page.getByRole("combobox", { name: "Prevent added rotation · this clip", exact: true });
  assert.equal(await projectToggle.isChecked(), false);
  assert.equal(await clipOverride.isDisabled(), true, "Off preset has no active roll correction");
  await page.getByRole("combobox", { name: "Stabilisation preset", exact: true }).selectOption("gentle");
  const before = await saved();
  assert.equal(await clipOverride.inputValue(), "inherit");
  // Keyboard-accessible project toggle invalidates the one affected clip only.
  await projectToggle.focus();
  await page.keyboard.press("Space");
  let p = await saved();
  assert.equal(p.defaultPreventRotation, true);
  assert.equal(p.clips[0].revision, before.clips[0].revision + 1);
  assert.equal(p.clips[0].reviewed, false);
  assert.equal(p.clips[0].rendered.path, before.clips[0].rendered.path);
  assert.deepEqual(p.clips.slice(1), before.clips.slice(1));
  await clipOverride.selectOption("on");
  assert.equal((await saved()).clips[0].revision, p.clips[0].revision, "equivalent override preserves revision");
  await projectToggle.uncheck();
  assert.equal((await saved()).clips[0].revision, p.clips[0].revision, "explicit On survives project Off");
  await clipOverride.selectOption("off");
  p = await saved();
  await projectToggle.check();
  assert.equal((await saved()).clips[0].revision, p.clips[0].revision, "explicit Off survives project On");
  await clipOverride.selectOption("inherit");
  assert.equal((await saved()).clips[0].revision, p.clips[0].revision + 1);
  // A real UI preview request must carry both levels of the policy to native code.
  await page.getByRole("button", { name: /Quick preview/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.preview === true);
  const request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.project.defaultPreventRotation, true);
  assert.equal(request.project.clips[0].preventRotation, null);
  // Selecting Fast must leave the choice stored but disable this Quality-only control.
  await page.getByRole("combobox", { name: "Stabiliser for this clip", exact: true }).selectOption("fast");
  assert.equal(await clipOverride.isDisabled(), true);
  await page.getByRole("combobox", { name: "Stabiliser for this clip", exact: true }).selectOption("quality");
  assert.equal(await clipOverride.isEnabled(), true);
  await mkdir("test-output/studio-rotation", { recursive: true });
  await page.locator("#studio-panel-picture").screenshot({ path: "test-output/studio-rotation/clip-control.png" });
  await projectSettings.screenshot({ path: "test-output/studio-rotation/project-control.png" });
  await page.setViewportSize({ width: 1000, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS: keyboard control, project/clip inheritance, explicit On/Off, targeted invalidation, preview IPC, dormant Fast choice and compact layout");
} finally {
  await browser?.close();
  server.kill();
}
