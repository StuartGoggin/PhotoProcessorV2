import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");

const output = "test-output/timeline-preview";
await mkdir(output, { recursive: true });
const url = "http://127.0.0.1:1447/studio-preview.html";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1447", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
server.stdout.on("data", data => logs += data);
server.stderr.on("data", data => logs += data);
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__previewCalls = [];
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      window.__previewCalls.push({ command, args });
      if (command === "start_import_job") return Promise.resolve("test-only-import");
      if (command === "list_event_day_directories") return Promise.resolve([{ path: "D:/Videos/2026/10/04", relativePath: "2026/10/04", name: "04", year: 2026, month: 10, day: 4, dateKey: "2026-10-04", hasCustomName: false }]);
      if (command === "load_event_naming_catalog") return Promise.resolve({ eventTypes: [], peopleTags: [], groupTags: [], generalTags: [] });
      if (command === "load_staging_tags") return Promise.resolve({ version: 1, entries: [], groups: [] });
      if (command === "list_staging_tree") return Promise.resolve({ path: "D:/Videos", name: "Videos", children: [] });
      if (command === "load_staging_timeline") return Promise.resolve([{ relativePath: "2026/10/04/sample.mp4", name: "sample.mp4", kind: "video", size: 1000, timestampMs: Date.UTC(2026, 9, 4, 12), endTimestampMs: Date.UTC(2026, 9, 4, 12, 0, 5), durationMs: 5000, timestampSource: "ffprobe" }]);
      if (command === "read_video_thumbnail_base64") return Promise.resolve("");
      if (command === "read_video_hover_preview_base64") return Promise.resolve("AAAA");
      if (command.startsWith("prewarm_") || command === "start_preview_monitor_worker") return Promise.resolve(0);
      return original(command, args);
    };
  });
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const settings = () => nav.getByRole("button", { name: /Settings/ }).click();
  const reset = () => page.evaluate(() => { window.__previewCalls = []; });
  const calls = () => page.evaluate(() => window.__previewCalls);
  const motionCommands = new Set(["read_video_hover_preview_base64", "prewarm_video_hover_frames", "start_preview_monitor_worker", "start_import_prewarm_worker"]);
  await settings();
  const toggle = page.getByLabel("Enable timeline video motion previews", { exact: false });
  assert.equal(await toggle.isChecked(), false, "legacy settings without the flag remain off");
  assert.equal(await page.getByLabel("Preview Width", { exact: true }).isDisabled(), true);
  await reset();
  await nav.getByRole("button", { name: /Import/, exact: true }).click();
  await page.getByRole("button", { name: "Queue Import Job", exact: true }).click();
  await page.getByText(/Queued background job: test-only-import/).waitFor();
  assert.equal((await calls()).filter(call => motionCommands.has(call.command)).length, 0, "import never starts motion work");
  await reset();
  await nav.getByRole("button", { name: /Video Timeline/ }).click();
  await page.locator(".staging-timeline-card").first().waitFor();
  await page.locator(".staging-timeline-card").first().hover();
  assert.equal((await calls()).filter(call => motionCommands.has(call.command)).length, 0, "disabled timeline never creates motion previews, including hover");

  await settings();
  await toggle.check();
  assert.equal(await page.getByLabel("Preview Width", { exact: true }).isDisabled(), false);
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByText("✓ Saved", { exact: true }).waitFor();
  await reset();
  await nav.getByRole("button", { name: /Video Timeline/ }).click();
  await page.locator(".staging-timeline-card").first().waitFor();
  await page.locator(".staging-timeline-card").first().hover();
  await page.waitForFunction(() => window.__previewCalls.some(call => call.command === "read_video_hover_preview_base64"));
  assert.ok((await calls()).some(call => call.command === "start_preview_monitor_worker"), "explicit opt-in starts timeline preview preparation");

  await reset();
  await nav.getByRole("button", { name: /Import/, exact: true }).click();
  await page.getByRole("button", { name: "Queue Import Job", exact: true }).click();
  await page.getByText(/Queued background job: test-only-import/).waitFor();
  assert.equal((await calls()).filter(call => motionCommands.has(call.command)).length, 0, "enabled previews still never start from import");
  await settings();
  await toggle.uncheck();
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByText("✓ Saved", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Timeline Video Preview MP4", exact: true }).locator("..").locator("..").screenshot({ path: `${output}/settings-default-off.png` });
  await reset();
  await nav.getByRole("button", { name: /Video Timeline/ }).click();
  await page.locator(".staging-timeline-card").first().waitFor();
  await page.locator(".staging-timeline-card").first().hover();
  assert.equal((await calls()).filter(call => motionCommands.has(call.command)).length, 0, "saved opt-out applies on reopening");
  assert.deepEqual(errors, []);
  console.log("PASS: legacy default-off, disabled dimensions, import transfer priority, hover opt-out, persisted opt-in/out, retained settings");
} finally {
  await browser?.close();
  server.kill();
}
