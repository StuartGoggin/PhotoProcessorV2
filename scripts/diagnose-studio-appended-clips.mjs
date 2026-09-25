// Regression: real Studio UI with synthetic IPC; native assembly is tested separately.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const before = Number(process.env.STUDIO_INITIAL_CLIPS || 31);
const added = Number(process.env.STUDIO_ADDED_CLIPS || 20);
assert.ok([before, added].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 51));
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const url = "http://127.0.0.1:1437/studio-preview.html";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1437", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser;
server.stdout.on("data", (data) => { log += data; });
server.stderr.on("data", (data) => { log += data; });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(200);
  }
  assert.ok(ready, log);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });
  page.setDefaultTimeout(10000);
  await page.addInitScript(({ before }) => {
    const setItem = Storage.prototype.setItem;
    let seeded = false;
    Storage.prototype.setItem = function (key, value) {
      if (key === "photogogo.videoStudio.project.v1" && !seeded) {
        seeded = true;
        const p = JSON.parse(value), template = p.clips[0];
        p.clips = Array.from({ length: before }, (_, index) => ({ ...template,
          id: `original-${index}`, path: `D:/Videos/original-${index}.mp4`, chapter: `Original ${index + 1}`,
          rendered: { ...template.rendered, path: `D:/out/original-${index}.mp4` } }));
        value = JSON.stringify(p);
      }
      return setItem.call(this, key, value);
    };
  }, { before });
  await page.goto(url);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await page.locator("summary").filter({ hasText: /^Finish & export/ }).click();
  await page.getByRole("button", { name: `Create updated final video — ${before} clips`, exact: true }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.renderKind === "project");
  assert.equal((await page.evaluate(() => window.__lastStudioRequest)).project.clips.length, before);
  await page.evaluate(async ({ before, added }) => {
    const { sequenceRecipe } = await import("/src/utils/studioWorkflow.ts");
    window.__sequenceRecipe = sequenceRecipe;
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__firstAssembly = structuredClone(window.__lastStudioRequest);
    const description = (count) => ({ text: `Export of ${count} clips`, path: `D:/out/${count}/youtube-description.txt`,
      chapters: Array.from({ length: count }, (_, index) => ({ startSeconds: index * 25, title: `Clip ${index + 1}` })), warnings: [] });
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "plugin:dialog|open") return Array.from({ length: added }, (_, index) => `D:/Videos/added-${index}.mp4`);
      if (command === "studio_inspect") return args.paths.map((path) => ({ path, duration: 25 }));
      if (command === "studio_read_export_description") return description(args.jobId === "new-full-export" ? before + added : before);
      return originalInvoke(command, args);
    };
    window.__studioJobs = [{ id: "old-partial-export", name: "Original export", kind: "project", status: "completed", logs: [], progress: 100, activeTasks: [],
      output: "D:/out/original/project.mp4", finishedAt: "2026-09-24T00:00:00Z", sequence: sequenceRecipe(window.__firstAssembly.project), targets: window.__firstAssembly.project.clips.map((c) => ({ clipId: c.id, sourcePath: c.path, revision: c.revision })) }];
  }, { before, added });
  const exportPicker = page.getByRole("combobox", { name: "Finished export", exact: true });
  await exportPicker.locator('option[value="old-partial-export"]').waitFor({ state: "attached" });
  await exportPicker.selectOption("old-partial-export");
  await page.waitForFunction((n) => document.querySelector("#studio-description")?.value === `Export of ${n} clips`, before);
  await page.getByRole("button", { name: "Add clips", exact: true }).click();
  await page.waitForFunction((n) => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.length === n, before + added);
  await page.getByText(`${added} new clip(s) added.`, { exact: false }).waitFor();
  await page.getByRole("status", { name: "Export sequence status" }).filter({ hasText: `differs from your current ${before + added}-clip sequence` }).waitFor();
  assert.equal(await page.getByRole("button", { name: `Create updated final video — ${before + added} clips`, exact: true }).isDisabled(), true, "new clips require review");
  for (let index = 0; index < added; index++) {
    await page.getByRole("button", { name: `Needs review: added-${index}.mp4`, exact: true }).first().click();
  }
  await page.evaluate(() => { window.__studioJobs = [...window.__studioJobs, { ...window.__studioJobs[0], id: "older-active", status: "running", output: null }]; });
  await page.getByText(`A saved ${before}-clip render is still active`, { exact: false }).waitFor();
  await page.getByRole("button", { name: `Create updated final video — ${before + added} clips`, exact: true }).click();
  await page.waitForFunction((n) => window.__lastStudioRequest?.project.clips.length === n, before + added);
  const request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.project.clips.filter((c) => c.include).length, before + added);
  assert.ok(request.project.clips.slice(0, before).every((c, index) => c.rendered?.path === `D:/out/original-${index}.mp4`), "Existing rendered clips remain reusable");
  assert.equal((await page.evaluate(() => window.__firstAssembly)).project.clips.length, before, "Saved earlier request is unchanged");
  assert.equal(await page.evaluate(() => window.__studioJobs.find((j) => j.id === "older-active").status), "running", "old job was not cancelled");
  console.log(`PASS: add ${added} after ${before}, fresh assembly submits ${before + added}, preserves ${before} cached clips; old request stays ${before}.`);
  await page.locator("#studio-description").fill("My unsaved description for the earlier export");
  await page.evaluate(() => { window.__studioJobs = [...window.__studioJobs, { ...window.__studioJobs[0], id: "new-full-export", name: "New full export",
    sequence: window.__sequenceRecipe(window.__lastStudioRequest.project),
    targets: window.__lastStudioRequest.project.clips.map((c) => ({ clipId: c.id, sourcePath: c.path, revision: c.revision })),
    output: "D:/out/new/project.mp4", finishedAt: "2026-09-25T00:00:00Z" }]; });
  await exportPicker.locator('option[value="new-full-export"]').waitFor({ state: "attached" });
  assert.equal(await exportPicker.inputValue(), "old-partial-export");
  assert.equal(await page.locator("#studio-description").inputValue(), "My unsaved description for the earlier export");
  await page.getByRole("button", { name: "Open latest export", exact: true }).click();
  await page.waitForFunction((n) => document.querySelector("#studio-description")?.value === `Export of ${n} clips`, before + added);
  await page.getByRole("status", { name: "Export sequence status" }).filter({ hasText: "Matches the current edit recipe" }).waitFor();
  await page.evaluate(() => { window.__studioJobs = [...window.__studioJobs, { ...window.__studioJobs[0], id: "late-old-export", finishedAt: "2026-09-26T00:00:00Z" }]; });
  await exportPicker.locator('option[value="late-old-export"]').waitFor({ state: "attached" });
  assert.equal(await page.getByRole("button", { name: "Open latest export", exact: true }).count(), 0, "late completion of the older sequence must not replace the current-match shortcut");
  await exportPicker.selectOption("old-partial-export");
  assert.equal(await page.locator("#studio-description").inputValue(), "My unsaved description for the earlier export");
  await page.getByRole("button", { name: "Open latest export", exact: true }).click();
  assert.equal(await exportPicker.inputValue(), "new-full-export", "latest action still chooses current51 after old31 finishes last");
  console.log(`PASS: stale export warning, explicit latest action shows ${before + added} clips, unsaved older draft preserved.`);
  assert.deepEqual(pageErrors, []);
} finally {
  await browser?.close();
  server.kill();
}
