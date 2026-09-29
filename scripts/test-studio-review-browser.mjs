import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/studio-review";
await mkdir(output, { recursive: true });
execFileSync("src-tauri/tools/ffmpeg/bin/ffmpeg.exe", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180", "-frames:v", "1", "-threads", "1", `${output}/sample.jpg`], { windowsHide: true, timeout: 30000 });
const jpeg = (await readFile(`${output}/sample.jpg`)).toString("base64");
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1441", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, page;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch("http://127.0.0.1:1441/studio-preview.html")).ok) { ready = true; break; } } catch {} await delay(250); }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(jpeg => {
    window.__reviewFixture = true; window.__reviewSettings = { studio_review_frames_mode: "all", studio_review_frames_count: 4 };
    window.__reviewFrameData = jpeg;
  }, jpeg);
  await page.goto("http://127.0.0.1:1441/studio-preview.html");
  await page.evaluate(() => { window.__studioJobs = []; });
  assert.equal(await page.evaluate(() => (window.__reviewFrameCalls || []).length), 0, "hidden Studio never starts preparing frames");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const studio = () => nav.getByRole("button", { name: /Video Studio/ }).click();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  await studio(); await page.getByLabel("Clip name / YouTube chapter", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="review-frame-status"]')?.textContent.includes("3/3 clips prepared"));
  assert.equal(await page.locator(".studio-contact-sheet img").count(), 4);
  const baseline = await saved();
  assert.equal(await page.evaluate(() => window.__reviewFrameCalls.some(c => c.path.includes("Technique"))), true);
  await page.getByLabel("Clip name / YouTube chapter", { exact: true }).fill("Heat 1 — chapter only");
  const named = await saved();
  assert.equal(named.clips[0].title, baseline.clips[0].title);
  assert.equal(named.clips[0].revision, baseline.clips[0].revision);
  assert.equal(named.clips[0].reviewed, baseline.clips[0].reviewed);
  assert.deepEqual(named.clips[0].rendered, baseline.clips[0].rendered);
  await page.getByRole("tab", { name: "Clip title", exact: true }).click();
  assert.equal(await page.getByLabel("Show title in video", { exact: true }).isChecked(), true, "legacy visible titles remain enabled");
  await page.getByLabel("Show title in video", { exact: true }).uncheck();
  assert.equal((await saved()).clips[0].titleSeconds, 0);
  assert.equal((await saved()).clips[0].title, baseline.clips[0].title, "hiding retains title text");
  await page.getByLabel("Show title in video", { exact: true }).check();
  assert.equal((await saved()).clips[0].titleSeconds, 4);
  await page.locator(".studio-clip-select").nth(1).click();
  assert.equal(await page.getByLabel("Show title in video", { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel("On-screen clip title", { exact: true }).isDisabled(), true);
  await page.getByLabel("Clip name / YouTube chapter", { exact: true }).fill("Heat 2 — not a video title");
  assert.equal((await saved()).clips[1].title, "");
  await page.getByLabel("Show title in video", { exact: true }).check();
  assert.equal((await saved()).clips[1].title, "", "enabling does not copy chapter automatically");
  await page.getByLabel("On-screen clip title", { exact: true }).fill("Optional overlay");
  await page.getByLabel("Show title in video", { exact: true }).uncheck();

  // Configure before opt-in; seeding never touches the picture state.
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await page.getByLabel("Default card layout", { exact: true }).selectOption("table");
  await page.getByLabel("Default card heading", { exact: true }).fill("FINAL CLASSIFICATION");
  await page.getByLabel("Initially blank rows", { exact: true }).fill("2");
  await page.getByLabel("Default column 2", { exact: true }).fill("Rider");
  const beforeTemplate = await saved();
  await page.getByLabel("Use project scorecard template", { exact: true }).check();
  const seeded = await saved();
  assert.equal(seeded.clips.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(seeded.clips[i].scorecard.enabled, false, "project defaults never enable a clip card");
    assert.equal(seeded.clips[i].scorecard.heading, "FINAL CLASSIFICATION");
    assert.deepEqual(seeded.clips[i].scorecard.rows, [["", "", ""], ["", "", ""]]);
    assert.equal(seeded.clips[i].revision, beforeTemplate.clips[i].revision);
    assert.equal(seeded.clips[i].reviewed, beforeTemplate.clips[i].reviewed);
    assert.deepEqual(seeded.clips[i].rendered, beforeTemplate.clips[i].rendered);
  }
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await page.getByRole("tab", { name: "Scorecard", exact: true }).click();
  assert.equal(await page.getByLabel("Include scorecard", { exact: true }).isChecked(), false);
  await page.getByLabel("Include scorecard", { exact: true }).check();
  await page.locator("#studio-panel-scorecard").getByText("Needs results.", { exact: true }).waitFor();
  assert.equal(await page.locator("#studio-panel-scorecard").getByRole("button", { name: "Rendered preview", exact: true }).isDisabled(), true);
  await page.getByLabel("Row 1, column 2", { exact: true }).fill("Rider A");
  await page.getByLabel("Row 1, column 3", { exact: true }).fill("72");
  assert.equal(await page.locator("#studio-panel-scorecard").getByText("Needs results.", { exact: true }).count(), 0);
  await page.getByLabel("Include scorecard", { exact: true }).uncheck();
  const configured = await saved();
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await page.getByLabel("Default card heading", { exact: true }).fill("FUTURE CLIPS ONLY");
  await page.getByLabel("Use project scorecard template", { exact: true }).uncheck();
  await page.getByLabel("Use project scorecard template", { exact: true }).check();
  assert.deepEqual((await saved()).clips, configured.clips, "template changes preserve populated and disabled cards");
  // Import another clip via the user-facing picker/inspection seams.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "plugin:dialog|open") return Promise.resolve(["D:/Videos/New heat.mp4"]);
      if (command === "studio_inspect") return Promise.resolve([{ path: "D:/Videos/New heat.mp4", duration: 12 }]);
      return invoke(command, args);
    };
  });
  await page.getByRole("button", { name: /Add.*clips/i }).first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.length === 4);
  const added = (await saved()).clips[3];
  assert.equal(added.scorecard.heading, "FUTURE CLIPS ONLY"); assert.equal(added.title, ""); assert.equal(added.titleSeconds, 0);
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await page.locator("#studio-review").screenshot({ path: `${output}/clip-review.png` });
  const beforeReopen = await saved();
  await nav.getByRole("button", { name: /Settings/ }).click();
  await page.getByLabel("Prepare review frames", { exact: true }).selectOption("selected");
  await page.getByLabel("Frames per clip", { exact: true }).selectOption("8");
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await studio();
  await page.waitForFunction(() => document.querySelectorAll(".studio-contact-sheet img").length === 8);
  assert.deepEqual(await saved(), beforeReopen, "reopening retains project/template/results and never stores JPEGs in the project");
  await page.getByRole("tab", { name: "Clip title", exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator("#studio-panel-titles").screenshot({ path: `${output}/clip-title.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, "compact layout has no page overflow");
  assert.deepEqual(errors, []);
  console.log("PASS: automatic frames, settings, project reopening, chapter/title separation, template opt-in/preservation, new clip seeding, compact layout");
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); server.kill(); }
