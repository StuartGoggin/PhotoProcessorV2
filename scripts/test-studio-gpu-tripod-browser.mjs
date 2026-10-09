import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const url = "http://127.0.0.1:1453/studio-preview.html";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1453", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server.stdout.on("data", data => { serverLog += data; });
server.stderr.on("data", data => { serverLog += data; });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Fixture starting. */ }
    await delay(250);
  }
  assert.ok(ready, serverLog);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__confirmCalls = [];
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "plugin:dialog|confirm") window.__confirmCalls.push(args);
      return original(command, args);
    };
  });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await page.locator("#studio-review").waitFor();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  const projectSettings = page.locator("#studio-project-settings");
  await projectSettings.getByRole("button", { name: "Filters", exact: true }).click();
  const method = page.getByRole("combobox", { name: "Stabiliser for this clip", exact: true });
  const preset = page.getByRole("combobox", { name: "Stabilisation preset", exact: true });
  const framing = page.locator("#studio-panel-picture").getByLabel("Framing", { exact: true });
  const rotation = page.getByRole("combobox", { name: "Prevent added rotation · this clip", exact: true });
  assert.equal(await method.inputValue(), "quality", "legacy fixture unchanged");
  await method.selectOption("fast");
  await preset.selectOption("custom");
  await framing.selectOption("maxFrame");
  const before = await saved();
  await method.selectOption("gpuTripod");
  let p = await saved();
  assert.equal(p.clips[0].stabilizationMethod, "gpuTripod");
  assert.equal(p.clips[0].stabilization, "balanced");
  assert.equal(p.clips[0].framing, "edgeSafe");
  assert.equal(p.clips[0].revision, before.clips[0].revision + 1);
  assert.equal(p.clips[0].rendered.path, before.clips[0].rendered.path);
  assert.deepEqual(p.clips.slice(1), before.clips.slice(1));
  assert.equal(await preset.locator("option[value=custom]").count(), 0);
  assert.equal(await framing.locator("option[value=maxFrame]").evaluate(option => option.disabled), true);
  assert.match(await framing.locator("option[value=edgeSafe]").textContent(), /4% per edge/);
  assert.equal(await rotation.isDisabled(), true);
  assert.equal(await rotation.inputValue(), "locked");
  await page.getByRole("button", { name: /Quick preview/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.preview === true);
  assert.equal((await page.evaluate(() => window.__lastStudioRequest)).project.clips[0].stabilizationMethod, "gpuTripod");
  await method.selectOption("quality");
  await rotation.selectOption("off");
  await framing.selectOption("maxFrame");
  const beforeDefaults = await saved();
  await projectSettings.getByRole("combobox", { name: "Stabiliser for new clips", exact: true }).selectOption("gpuTripod");
  assert.deepEqual((await saved()).clips, beforeDefaults.clips, "new default cannot migrate existing clips silently");
  await projectSettings.getByRole("combobox", { name: "New clip preset", exact: true }).selectOption("gentle");
  await page.evaluate(() => { window.__confirmResult = false; });
  await projectSettings.getByRole("button", { name: "Apply to selected clip", exact: true }).click();
  assert.match((await page.evaluate(() => window.__confirmCalls.at(-1))).message, /fixed 4% per-edge crop on 1 clip/);
  assert.deepEqual((await saved()).clips, beforeDefaults.clips, "declined migration preserves all pictures and settings");
  await page.evaluate(() => { window.__confirmResult = true; });
  await projectSettings.getByRole("button", { name: "Apply to selected clip", exact: true }).click();
  p = await saved();
  assert.equal(p.clips[0].stabilizationMethod, "gpuTripod");
  assert.equal(p.clips[0].stabilization, "gentle");
  assert.equal(p.clips[0].framing, "edgeSafe");
  assert.equal(p.clips[0].preventRotation, null);
  assert.deepEqual(p.clips.slice(1), beforeDefaults.clips.slice(1));
  await method.selectOption("quality");
  assert.equal(await rotation.isEnabled(), true);
  assert.equal(await rotation.inputValue(), "inherit");
  await mkdir("test-output/studio-gpu-tripod", { recursive: true });
  await method.selectOption("gpuTripod");
  await page.locator("#studio-panel-picture").screenshot({ path: "test-output/studio-gpu-tripod/clip-option.png" });
  await projectSettings.screenshot({ path: "test-output/studio-gpu-tripod/project-option.png" });
  await page.setViewportSize({ width: 1000, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS: opt-in GPU settings, custom/crop migration, fixed rotation, explicit project defaults, preview IPC and compact layout");
} finally {
  await browser?.close();
  server.kill();
}
