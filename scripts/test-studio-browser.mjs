import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// CI uses the locked dependency. Select an existing runtime for offline QA.
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/studio-browser";
await mkdir(output, { recursive: true });
const url = process.env.STUDIO_TEST_URL || "http://127.0.0.1:1431/studio-preview.html";
const server = process.env.STUDIO_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1431", "--strictPort"],
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
  await page.getByRole("navigation", { name: "Video editing workflow" }).waitFor();
  const review = page.locator("#studio-review");
  const panel = page.getByRole("region", { name: "Background jobs", exact: true });
  const active = panel.getByRole("region", { name: "Active jobs list", exact: true });
  await active.getByText("Diagnostic fixture", { exact: true }).waitFor();
  assert.equal(await active.getByText("Finished export fixture", { exact: true }).count(), 0);
  assert.equal(await active.getByText("Failed export fixture", { exact: true }).count(), 0);
  assert.equal(await active.getByText("F:/Completed-card", { exact: false }).count(), 0);
  assert.equal(await active.evaluate((node) => node.scrollHeight > node.clientHeight), true, "active jobs scroll internally");
  await panel.getByRole("separator", { name: "Resize jobs panel" }).focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await panel.getByRole("separator").getAttribute("aria-valuenow"), "304");

  // Opening titles and order are final-assembly edits, not clip invalidations.
  const details = (name) => page.locator("summary").filter({ hasText: name });
  await details(/^Project details & opening title/).click();
  assert.equal(await page.getByRole("combobox", { name: /^Opening title style/ }).inputValue(), "card");
  await page.getByRole("combobox", { name: /^Opening title style/ }).selectOption("overlay");
  await page.getByLabel("Opening title", { exact: true }).fill("Training highlights");
  await review.getByRole("button", { name: "Move down", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips[1].id === "preview-0");
  let project = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  assert.equal(project.clips[1].revision, 0);
  assert.equal(project.clips[1].rendered.path, "D:/out/first.mp4");
  await review.getByRole("button", { name: "Move up", exact: true }).click();
  await details(/^Project details & opening title/).click();
  await review.getByRole("button", { name: /Render clip ·/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.renderKind === "clip");
  let request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.assembleOnly, false);
  assert.equal(request.project.width, 3840); assert.equal(request.project.fps, 50); assert.equal(request.project.bitrateMbps, 32);
  await page.getByLabel("Clip title (blank = hidden)").fill("Edited warm-up");
  assert.equal(await review.getByRole("button", { name: /Render clip ·/ }).isDisabled(), true);
  await review.getByText("Previous render · outdated", { exact: false }).waitFor();
  const needsReview = review.getByRole("button", { name: "Needs review: Warm-up", exact: true });
  assert.equal(await needsReview.getAttribute("aria-pressed"), "false");
  assert.ok((await needsReview.getAttribute("class")).includes("needs-review"));
  await needsReview.click();
  const approved = review.getByRole("button", { name: "Approved: Warm-up", exact: true });
  assert.equal(await approved.getAttribute("aria-pressed"), "true");
  assert.ok((await approved.getAttribute("class")).includes("is-approved"));
  await details(/^Output settings/).click();
  await page.getByLabel("Resolution", { exact: true }).selectOption("1920");
  await page.getByLabel("Frame rate", { exact: true }).selectOption("30");
  await page.getByLabel("Video bitrate · Mbps").fill("18");
  await review.getByRole("button", { name: /Render clip ·/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.project.bitrateMbps === 18);
  request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.project.width, 1920); assert.equal(request.project.height, 1080); assert.equal(request.project.fps, 30);
  assert.equal(request.project.clips[0].revision, 1);
  await details(/^Output settings/).click();
  await review.getByRole("button", { name: "Approve & next", exact: true }).click();
  await review.getByRole("heading", { name: "Final run", exact: true }).waitFor();
  await review.getByRole("button", { name: "Needs review: Final run", exact: true }).click();
  await page.getByRole("button", { name: "Create updated final video — 3 clips", exact: true }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.renderKind === "project");
  assert.equal((await page.evaluate(() => window.__lastStudioRequest)).project.openingTitleMode, "overlay");

  // Job polling must not overwrite a draft for a selected finished export.
  const description = page.locator("#studio-description");
  await description.waitFor();
  assert.match(await description.inputValue(), /00:25 Technique practice/);
  await description.fill("My edited description\n\n00:00 Warm-up\n00:25 Technique practice\n01:00 Final run");
  await page.waitForTimeout(1200); // Cross one actual job-poll refresh.
  assert.match(await description.inputValue(), /^My edited description/);
  await page.evaluate(() => { window.__descriptionSaveError = true; });
  await page.getByRole("button", { name: "Save alongside video", exact: true }).click();
  await page.getByText(/Description was not saved:/).waitFor();
  assert.match(await description.inputValue(), /^My edited description/);
  await page.evaluate(() => { window.__descriptionSaveError = false; });
  await page.getByRole("button", { name: "Save alongside video", exact: true }).click();
  await page.getByText("Description saved alongside the selected video.", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__savedDescription)).jobId, "finished-fixture");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copiedDescription = text; } } }));
  await page.getByRole("button", { name: "Copy description", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copiedDescription), await description.inputValue());
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Fixture clipboard unavailable"); } } }));
  await page.getByRole("button", { name: "Copy description", exact: true }).click();
  await page.getByText(/Could not copy the description/).waitFor();

  // Measure the whole app shell, not an isolated editor component.
  for (const [width, height] of [[1440, 1000], [3840, 2160], [768, 1024], [390, 844], [360, 640], [640, 360]]) {
    await page.setViewportSize({ width, height });
    await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
    await page.screenshot({ path: `${output}/studio-${width}x${height}.png` });
    const layout = await page.evaluate(() => {
      const main = document.querySelector("main"), panel = document.querySelector(".jobs-panel");
      return { document: document.documentElement.scrollWidth, mainWidth: main.clientWidth, mainScroll: main.scrollWidth,
        mainHeight: main.clientHeight, panelHeight: panel.getBoundingClientRect().height };
    });
    assert.ok(layout.document <= width, `document overflow at ${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.mainScroll <= layout.mainWidth + 1, `main overflow at ${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.mainHeight >= height * 0.3, `editor must remain usable at ${width}x${height}`);
    if (width === 3840) assert.ok(await page.locator(".studio-workspace").evaluate((node) => node.clientWidth) > 2500, "Studio uses a 4K workspace");
  }
  // Expanded advanced sections must also fit a narrow desktop window.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator("main details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "expanded narrow editor fits");
  await page.locator("main details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = false; }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByRole("button", { name: /History \(/ }).click();
  await page.getByRole("heading", { name: "Background Jobs", exact: true }).waitFor();
  await page.getByText("Finished export fixture", { exact: true }).waitFor();
  await page.getByText("Failed export fixture", { exact: true }).waitFor();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  assert.match(await description.inputValue(), /^My edited description/, "navigation preserves the Studio draft");

  await details(/Optional background music/).click();
  await page.getByText("Creative brief", { exact: false }).waitFor();
  await details(/Optional background music/).click();
  await page.evaluate(() => { window.__confirmResult = false; });
  await page.getByRole("button", { name: "Clear all Studio renders", exact: true }).click();
  assert.equal(await page.evaluate(() => !!window.__studioCleared), false);
  await page.evaluate(() => { window.__confirmResult = true; });
  await page.getByRole("button", { name: "Clear all Studio renders", exact: true }).click();
  await page.getByText("Cleared 1 Studio jobs. Ready to render from scratch.").waitFor();
  await page.waitForFunction(() => !document.querySelector("#studio-description")?.closest("section")?.querySelector("button.btn-primary:not(:disabled)"));
  assert.match(await description.inputValue(), /^My edited description/, "clearing history retains a copyable draft");
  assert.equal(await page.getByRole("button", { name: "Save alongside video", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Copy description", exact: true }).isEnabled(), true);
  project = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  assert.ok(project.clips.every((clip) => !clip.rendered)); assert.equal(project.clips.length, 3);
  await details(/^Stabilisation defaults & performance/).click();
  await page.getByLabel("Encoder", { exact: true }).selectOption("cpu");
  await page.getByLabel("Stabiliser for this clip", { exact: true }).selectOption("fast");
  await page.getByLabel("Stabilisation preset", { exact: true }).selectOption("custom");
  await page.getByLabel("Block size (pixels)", { exact: true }).fill("16");
  await review.getByRole("button", { name: /^Needs review:/ }).click();
  await review.getByRole("button", { name: /Render clip ·/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.project.encoderPreference === "cpu");
  const customRequest = await page.evaluate(() => window.__lastStudioRequest);
  const customClip = customRequest.project.clips.find((clip) => clip.id === customRequest.clipId);
  assert.equal(customClip.stabilizationMethod, "fast"); assert.equal(customClip.customStabilization.blockSize, 16);
  await page.getByRole("button", { name: "Apply to selected clip", exact: true }).click();
  assert.equal(await review.getByRole("button", { name: /^Needs review:/ }).getAttribute("aria-pressed"), "false");
  await page.evaluate(() => { window.__importJobs = []; });
  await panel.getByText("No active jobs", { exact: true }).waitFor();
  assert.equal(await active.isVisible(), false, "empty job frame collapses automatically");
  assert.deepEqual(failures, []);
  console.log("PASS: approval flow, cache preservation, assembly dispatch, description editing/errors, active/history jobs, 360px–4K layouts and scheduling controls.");
} finally { await browser?.close(); server?.kill(); }
