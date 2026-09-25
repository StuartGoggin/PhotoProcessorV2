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
  const projectSettings = page.locator("#studio-project-settings");
  await projectSettings.getByRole("button", { name: "Filters", exact: true }).click();
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
    window.__confirmCalls = [];
    window.__audioDeferred = false;
    window.__pendingAudio = [];
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "plugin:dialog|confirm") {
        window.__confirmCalls.push(args);
        if (window.__confirmDeferred) return new Promise((resolve) => { window.__resolveConfirm = resolve; });
      }
      if (command === "plugin:dialog|open" && window.__addedPaths) return Promise.resolve(window.__addedPaths);
      if (command === "studio_inspect" && window.__addedPaths) return Promise.resolve(args.paths.map((path) => ({ path, duration: 25 })));
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
  assert.equal(await projectSettings.getByRole("combobox", { name: "Wind reduction default", exact: true }).count(), 1, "the default belongs only to the project");
  assert.equal(await page.locator("#studio-review").getByRole("combobox", { name: "Wind reduction default", exact: true }).count(), 0);
  assert.equal(await projectSettings.getByRole("combobox", { name: "Selected clip wind reduction", exact: true }).count(), 0);
  assert.equal(await defaults.inputValue(), "off");
  assert.equal(await override.inputValue(), "inherit");
  await defaults.selectOption("light");
  await override.selectOption("off");
  await page.getByText(/Override: Off/).waitFor();
  await override.selectOption("inherit");
  await page.getByText(/Using project: Light/).waitFor();
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

  // Explicit Off remains an override as project defaults change; excluded clips
  // still participate in an explicitly confirmed all-clips override reset.
  await page.locator(".studio-clip-select").first().click();
  await override.selectOption("off");
  await defaults.selectOption("strong");
  await page.getByText(/Override: Off/).waitFor();
  assert.equal((await savedProject()).clips[0].windReduction, "off");
  await page.locator(".studio-clip-select").nth(1).click();
  await page.getByText(/Using project: Strong/).waitFor();
  await override.selectOption("strong");
  await page.getByRole("checkbox", { name: "Include Technique practice.mp4", exact: true }).uncheck();
  await defaults.selectOption("light");
  await page.getByText(/Override: Strong/).waitFor();
  const beforeReset = await savedProject();
  const pictureState = (project) => project.clips.map(({ windReduction, ...picture }) => picture);
  const reset = projectSettings.getByRole("button", { name: "Reset all clips to project wind default", exact: true });
  await page.evaluate(() => { window.__confirmResult = false; });
  await reset.click();
  await page.waitForFunction(() => window.__confirmCalls.length >= 1);
  assert.deepEqual(await savedProject(), beforeReset, "cancel preserves overrides and all picture edits");
  const prompt = (await page.evaluate(() => window.__confirmCalls.at(-1))).message;
  assert.match(prompt, /\b2\b/, "confirmation states the number of overrides being removed");
  assert.match(prompt, /Off/, "confirmation makes clear that explicit Off is also reset");
  await page.evaluate(() => { window.__confirmResult = true; });
  await reset.click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.every((clip) => clip.windReduction === "inherit"));
  const afterReset = await savedProject();
  assert.deepEqual(pictureState(afterReset), pictureState(beforeReset), "reset keeps picture revisions, approvals, rendered caches, and excluded status");
  assert.equal(afterReset.defaultWindReduction, "light");
  await page.getByText(/Using project: Light/).waitFor();
  assert.equal(await reset.isDisabled(), true, "no-op bulk reset is unavailable after all clips inherit");

  await page.evaluate(() => { window.__addedPaths = ["D:/Videos/new-project-default.mp4"]; });
  await page.getByRole("button", { name: "Add clips", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.length === 4);
  const added = (await savedProject()).clips.at(-1);
  assert.equal(added.windReduction, "inherit", "new footage inherits the current project default, not a frozen copy");
  assert.equal(added.reviewed, false);
  await page.locator(".studio-clip-select").last().click();
  await page.getByText(/Using project: Light/).waitFor();
  await defaults.selectOption("moderate");
  await page.getByText(/Using project: Moderate/).waitFor();
  assert.deepEqual(pictureState(await savedProject()).slice(0, 3), pictureState(beforeReset), "adding clips and changing the default still preserve the older picture state");
  await override.selectOption("off");
  await page.evaluate(() => { window.__confirmDeferred = true; });
  await reset.click();
  await page.waitForFunction(() => typeof window.__resolveConfirm === "function");
  await page.evaluate(async () => {
    const { STUDIO_CLEARED } = await import("/src/utils/studioWorkflow.ts");
    window.dispatchEvent(new Event(STUDIO_CLEARED));
  });
  await page.getByText(/Studio renders cleared\. Clips will render from scratch/).waitFor();
  const replacementState = await savedProject();
  await page.evaluate(() => { window.__confirmDeferred = false; window.__resolveConfirm(true); });
  await page.getByRole("alert").filter({ hasText: /changed while confirming\. Nothing was reset/ }).waitFor();
  assert.deepEqual(await savedProject(), replacementState, "stale reset confirmation must not mutate the replacement project");
  assert.equal((await savedProject()).clips.at(-1).windReduction, "off");
  assert.deepEqual(failures, []);
  console.log("PASS: project/clip audio scopes, live inheritance and explicit Off, bulk reset cancellation/confirmation including excluded clips, preserved picture cache, new clip inheritance, A/B position and stale replies");
} finally {
  await browser?.close();
  server?.kill();
}
