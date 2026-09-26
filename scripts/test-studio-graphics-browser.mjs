import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/studio-graphics";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1439", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browser, serverLog = "";
server.stdout.on("data", (data) => { serverLog += data; });
server.stderr.on("data", (data) => { serverLog += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch("http://127.0.0.1:1439/studio-preview.html")).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(250);
  }
  assert.ok(ready, `Fixture started: ${serverLog}`);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.setDefaultTimeout(10000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("http://127.0.0.1:1439/studio-preview.html");
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__graphicsCalls = [];
    window.__graphicsPending = [];
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command !== "studio_graphics_preview") return invoke(command, args);
      window.__graphicsCalls.push(args);
      const result = { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=", background: "Verified stabilised clip", atSeconds: 19 };
      if (window.__graphicsInvalid) return Promise.resolve({ ...result, dataUrl: "https://invalid.example/remote.png" });
      if (window.__graphicsDeferred) return new Promise((resolve) => window.__graphicsPending.push(() => resolve(result)));
      return Promise.resolve(result);
    };
  });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  const initial = await saved();
  await page.getByRole("tab", { name: "Scorecard", exact: true }).click();
  await page.getByRole("checkbox", { name: "Include scorecard", exact: true }).check();
  await page.getByRole("textbox", { name: "Scorecard result", exact: true }).fill("Navy 12 · White 8");
  const changed = (await saved()).clips[0];
  assert.equal(changed.scorecard.result, "Navy 12 · White 8");
  assert.equal(changed.reviewed, initial.clips[0].reviewed);
  assert.equal(changed.revision, initial.clips[0].revision);
  assert.deepEqual(changed.rendered, initial.clips[0].rendered);
  const score = page.locator("#studio-panel-scorecard");
  const settings = page.locator("#studio-project-settings");
  await settings.getByRole("button", { name: "Graphics", exact: true }).click();
  assert.equal(await settings.getByRole("checkbox", { name: "Use shared style for opening and clip titles", exact: true }).isChecked(), false, "legacy title rendering is opt-in");
  await settings.getByRole("combobox", { name: "Graphics font", exact: true }).selectOption("georgia");
  await settings.getByRole("combobox", { name: "Default scorecard timing", exact: true }).selectOption("separateCard");
  await settings.getByRole("spinbutton", { name: "Default scorecard seconds", exact: true }).fill("7");
  await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
  await page.screenshot({ path: `${output}/project-graphics-1360.png` });
  await settings.getByRole("button", { name: "Graphics", exact: true }).click();
  assert.equal(await score.getByRole("combobox", { name: "Scorecard timing", exact: true }).inputValue(), "inherit");
  await score.getByText(/Using project: Standalone card after replays · 7s/).waitFor();
  const chapters = page.getByRole("list", { name: "Ordered chapters", exact: true });
  await chapters.getByRole("listitem").nth(1).getByText("≈00:00:37", { exact: true }).waitFor();
  await chapters.getByRole("textbox", { name: "Chapter 1 name", exact: true }).fill("Opening match");
  await chapters.getByRole("button", { name: "Move chapter 1 down", exact: true }).click();
  assert.equal((await saved()).clips[1].chapter, "Opening match");
  assert.deepEqual((await saved()).clips[1].rendered, initial.clips[0].rendered, "chapter rename/reorder preserve cache");
  await chapters.getByRole("button", { name: "Move chapter 2 up", exact: true }).click();
  await score.getByRole("combobox", { name: "Scorecard timing", exact: true }).selectOption("custom");
  await score.getByRole("alert").filter({ hasText: /Scorecards are composited last/ }).waitFor();
  await score.getByRole("spinbutton", { name: "Scorecard start · seconds", exact: true }).fill("25");
  await score.getByRole("alert").filter({ hasText: "no visible time" }).waitFor();
  assert.equal(await score.getByRole("button", { name: "Rendered preview", exact: true }).isDisabled(), true);
  await score.getByRole("combobox", { name: "Scorecard timing", exact: true }).selectOption("clipEnd");
  await score.getByRole("spinbutton", { name: "Scorecard duration · seconds", exact: true }).fill("4");
  await chapters.getByRole("listitem").nth(1).getByText("≈00:00:30", { exact: true }).waitFor();
  await score.getByRole("combobox", { name: "Scorecard template", exact: true }).selectOption("table");
  await score.getByRole("spinbutton", { name: "Table columns", exact: true }).fill("6");
  await score.getByRole("spinbutton", { name: "Table rows", exact: true }).fill("9");
  assert.equal((await saved()).clips[0].scorecard.columns.length, 5);
  assert.equal((await saved()).clips[0].scorecard.rows.length, 8);
  assert.ok((await saved()).clips[0].scorecard.rows.every((row) => row.length === 5));
  await score.getByRole("spinbutton", { name: "Table columns", exact: true }).fill("3");
  await score.getByRole("spinbutton", { name: "Table rows", exact: true }).fill("2");
  await score.getByRole("textbox", { name: "Row 1, column 2", exact: true }).fill("Navy");
  await score.getByRole("textbox", { name: "Row 1, column 3", exact: true }).fill("12");
  await score.getByRole("textbox", { name: "Row 2, column 1", exact: true }).fill("2");
  await score.getByRole("textbox", { name: "Row 2, column 2", exact: true }).fill("White");
  await score.getByRole("textbox", { name: "Row 2, column 3", exact: true }).fill("8");
  assert.equal(await score.getByRole("textbox", { name: "Scorecard heading", exact: true }).getAttribute("maxlength"), "60");
  assert.equal(await score.getByRole("textbox", { name: "Scorecard result", exact: true }).getAttribute("maxlength"), "90");
  assert.equal(await score.getByRole("textbox", { name: "Scorecard subtitle", exact: true }).getAttribute("maxlength"), "120");
  assert.equal(await score.getByRole("textbox", { name: "Row 1, column 2", exact: true }).getAttribute("maxlength"), "24");
  assert.equal((await page.evaluate(() => window.__graphicsCalls)).length, 0, "editing never starts native work automatically");
  assert.equal(await page.evaluate(() => window.__lastStudioRequest ?? null), null, "finishing never starts a full video render implicitly");
  await score.getByRole("button", { name: "Rendered preview", exact: true }).click();
  await score.getByRole("img", { name: "Rendered scorecard preview", exact: true }).waitFor();
  await score.getByText("Verified stabilised clip · 19.00 seconds", { exact: true }).waitFor();
  const previewRequest = await page.evaluate(() => window.__graphicsCalls.at(-1));
  assert.equal(previewRequest.stagingDir, "D:/Videos");
  assert.equal(previewRequest.clipId, "preview-0"); assert.equal(previewRequest.target, "scorecard");
  await score.getByRole("textbox", { name: "Scorecard subtitle", exact: true }).fill("Final result · Afternoon match");
  assert.equal(await score.getByRole("img").count(), 0, "any edit clears the rendered frame immediately");
  await page.evaluate(() => { window.__graphicsDeferred = true; });
  await score.getByRole("button", { name: "Rendered preview", exact: true }).click();
  await page.waitForFunction(() => window.__graphicsPending.length === 1);
  await score.getByRole("textbox", { name: "Scorecard result", exact: true }).fill("MATCH RESULT");
  await page.evaluate(() => window.__graphicsPending.shift()());
  await score.getByRole("button", { name: "Rendered preview", exact: true }).waitFor();
  assert.equal(await score.getByRole("img").count(), 0, "late preview cannot restore an obsolete edit");
  await page.evaluate(() => { window.__graphicsDeferred = false; window.__graphicsInvalid = true; });
  await score.getByRole("button", { name: "Rendered preview", exact: true }).click();
  await score.getByRole("alert").filter({ hasText: "preview response was invalid" }).waitFor();
  assert.equal(await score.getByRole("img").count(), 0, "remote image URLs are rejected at the native preview seam");
  await page.evaluate(() => { window.__graphicsInvalid = false; });
  await score.getByRole("textbox", { name: "Scorecard heading", exact: true }).fill("AFTERNOON MATCH");
  for (const [width, height] of [[1360, 1000], [1920, 1080], [360, 800]]) {
    await page.setViewportSize({ width, height });
    await score.scrollIntoViewIfNeeded();
    assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `finishing controls fit at ${width}px`);
    await page.screenshot({ path: `${output}/scorecard-${width}.png` });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await score.screenshot({ path: `${output}/scorecard-detail.png` });
  await chapters.screenshot({ path: `${output}/chapters.png` });
  await page.getByRole("tab", { name: "Titles", exact: true }).click();
  await page.getByRole("button", { name: "Use chapter name as title", exact: true }).click();
  assert.equal((await saved()).clips[0].title, "Opening match");
  assert.equal((await saved()).clips[0].reviewed, false, "the existing picture-review rule still applies to a changed clip title");
  await page.getByRole("tab", { name: "Titles", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "Scorecard", exact: true }).getAttribute("aria-selected"), "true", "new scorecard tab participates in keyboard navigation");
  // Open an otherwise identical project with native-cache metadata at the IPC
  // seam: pending footage uses the normal path; all-ready footage must be strict.
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1"));
    project.clips = project.clips.map((clip) => ({ ...clip, reviewed: true, rendered: {
      path: `D:/out/verified-${clip.id}.mp4`, width: project.width, height: project.height,
      fps: project.fps, bitrateMbps: project.bitrateMbps, duration: clip.duration,
      revision: clip.revision ?? 0, signature: `fixture-${clip.id}`, renderedAt: "2026-09-26T00:00:00Z",
    } }));
    window.__graphicsReadyProject = structuredClone(project);
    project.clips.at(-1).rendered = null;
    window.__graphicsExportFixture = project;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "studio_load_project") return Promise.resolve(structuredClone(window.__graphicsExportFixture));
      if (command === "plugin:dialog|open" && args.options?.filters?.[0]?.name === "Studio project") return Promise.resolve("D:/fixture/graphics-export.json");
      return invoke(command, args);
    };
    window.__lastStudioRequest = null;
  });
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await page.locator("summary").filter({ hasText: /^Finish & export/ }).click();
  const exportButton = page.getByRole("button", { name: "Create updated final video — 3 clips", exact: true });
  await exportButton.click();
  await page.waitForFunction(() => window.__lastStudioRequest?.renderKind === "project");
  assert.equal(await page.evaluate(() => window.__lastStudioRequest.assembleOnly), false, "pending clips retain the complete render-and-assemble workflow");
  await page.evaluate(() => { window.__graphicsExportFixture = window.__graphicsReadyProject; window.__lastStudioRequest = null; });
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await exportButton.click();
  await page.waitForFunction(() => !!window.__lastStudioRequest);
  assert.equal(await page.evaluate(() => window.__lastStudioRequest.renderKind), "assembly", "strict finishing-only dispatch must satisfy native assembly admission");
  assert.equal(await page.evaluate(() => window.__lastStudioRequest.assembleOnly), true, "all-ready final export must require verified caches and never fall back to stabilisation");
  await page.getByText(/Finishing-only export queued/).waitFor();
  await page.evaluate(() => { window.__graphicsDeferred = true; });
  await score.getByRole("button", { name: "Rendered preview", exact: true }).click();
  await page.waitForFunction(() => window.__graphicsPending.length === 1);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.length === 0);
  await page.evaluate(() => window.__graphicsPending.shift()());
  assert.equal(await page.getByRole("img", { name: "Rendered scorecard preview", exact: true }).count(), 0, "preview from the old project cannot enter its replacement");
  assert.deepEqual(failures, []);
  console.log("PASS: scorecard/cache isolation, inherited/custom timing, estimated chapter offsets and source edits, bounded tables, explicit rendered previews, stale response guards, keyboard and 360/1360/1920 layouts.");
} finally { await browser?.close(); server.kill(); }
