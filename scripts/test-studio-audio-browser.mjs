import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Reuse an installed runtime for offline QA; native audio processing has separate media tests.
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const url = process.env.STUDIO_AUDIO_TEST_URL || "http://127.0.0.1:1438/studio-preview.html";
const server = process.env.STUDIO_AUDIO_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1438", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", (data) => { serverLog += data; });
server?.stderr.on("data", (data) => { serverLog += data; });
try {
  if (server) {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Server is starting. */ }
      await delay(250);
    }
    assert.ok(ready, `Fixture server did not start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(url);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await page.getByRole("tab", { name: "Sound", exact: true }).click();
  await page.evaluate(() => {
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    const wav = (amplitude) => {
      const samples = 16000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
      const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
      text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, "data"); view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(amplitude * Math.sin(i * Math.PI / 20)), true);
      let encoded = "";
      for (let i = 0; i < bytes.length; i++) encoded += String.fromCharCode(bytes[i]);
      return btoa(encoded);
    };
    const original = wav(1000), processed = wav(400);
    window.__audioCalls = [];
    window.__audioDeferred = false;
    window.__pendingAudio = [];
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command !== "studio_audio_preview") return originalInvoke(command, args);
      window.__audioCalls.push(args);
      const result = { original, processed: args.preset === "off" ? original : processed, seconds: 1, preset: args.preset };
      return window.__audioDeferred ? new Promise((resolve, reject) => window.__pendingAudio.push({ resolve, reject, result })) : Promise.resolve(result);
    };
  });
  const defaults = page.getByRole("combobox", { name: "Wind reduction default", exact: true });
  const override = page.getByRole("combobox", { name: "Selected clip wind reduction", exact: true });
  const start = page.getByRole("spinbutton", { name: "Audio preview start · seconds", exact: true });
  const generate = page.getByRole("button", { name: "Preview up to 10 seconds", exact: true });
  const group = page.getByRole("group", { name: "Audio A/B comparison", exact: true });
  const savedProject = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  const initial = await savedProject();
  assert.equal(await defaults.inputValue(), "off");
  assert.equal(await override.inputValue(), "inherit");
  await defaults.selectOption("light");
  await override.selectOption("off");
  await page.getByText(/effective setting: Off — original camera audio/).waitFor();
  await override.selectOption("inherit");
  await page.getByText(/effective setting: Light/).waitFor();
  const changed = await savedProject();
  assert.equal(changed.defaultWindReduction, "light");
  assert.equal(changed.clips[0].reviewed, initial.clips[0].reviewed);
  assert.equal(changed.clips[0].revision, initial.clips[0].revision);
  assert.deepEqual(changed.clips[0].rendered, initial.clips[0].rendered, "audio choices preserve the picture cache");

  await generate.click();
  await group.waitFor();
  let call = await page.evaluate(() => window.__audioCalls.at(-1));
  assert.equal(call.seconds, 10); assert.equal(call.preset, "light"); assert.equal(call.path, initial.clips[0].path);
  assert.equal(await page.locator("audio").count(), 1, "A/B has one player, never overlapping audio");
  await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
  await page.locator("audio").evaluate((audio) => { audio.currentTime = 0.35; });
  await page.waitForFunction(() => Math.abs(document.querySelector("audio").currentTime - 0.35) < 0.02);
  const originalSrc = await page.locator("audio").getAttribute("src");
  await page.getByRole("button", { name: "B · Light wind reduction", exact: true }).click();
  await page.waitForFunction((previous) => {
    const audio = document.querySelector("audio");
    return audio?.readyState >= 1 && audio.src !== previous && Math.abs(audio.currentTime - 0.35) < 0.02;
  }, originalSrc);
  await page.getByRole("button", { name: "A · Original", exact: true }).click();
  await page.waitForFunction((previous) => {
    const audio = document.querySelector("audio");
    return audio?.readyState >= 1 && audio.src === previous && Math.abs(audio.currentTime - 0.35) < 0.02;
  }, originalSrc);

  async function beginPending() {
    await page.evaluate(() => { window.__audioDeferred = true; });
    await generate.click();
    await page.waitForFunction(() => window.__pendingAudio.length === 1);
    assert.equal(await page.getByRole("button", { name: "Preparing audio preview…", exact: true }).isDisabled(), true);
  }
  async function resolvePending() {
    await page.evaluate(() => { const pending = window.__pendingAudio.shift(); pending.resolve(pending.result); });
    await generate.waitFor();
    assert.equal(await group.count(), 0, "an obsolete response must not reappear");
    assert.equal(await page.getByRole("alert").count(), 0);
  }
  await beginPending();
  await defaults.selectOption("moderate");
  await resolvePending();
  await beginPending();
  await start.fill("2");
  await resolvePending();
  await beginPending();
  await page.locator(".studio-clip-select").nth(1).click();
  await resolvePending();
  assert.equal(await start.inputValue(), "0", "a new clip starts its preview at zero");

  await page.evaluate(() => { window.__audioDeferred = false; });
  await generate.click();
  await group.waitFor();
  call = await page.evaluate(() => window.__audioCalls.at(-1));
  assert.equal(call.preset, "moderate"); assert.equal(call.start, 0); assert.equal(call.path, initial.clips[1].path);
  await page.getByRole("tab", { name: "Picture", exact: true }).click();
  await page.getByRole("tab", { name: "Sound", exact: true }).click();
  assert.equal(await group.count(), 1, "opening another editing tab retains the valid audio comparison");
  assert.deepEqual(failures, []);
  console.log("PASS: audio defaults/override, preserved picture cache, single-player A/B position, stale preset/start/clip replies, and tab state");
} finally {
  await browser?.close();
  server?.kill();
}
