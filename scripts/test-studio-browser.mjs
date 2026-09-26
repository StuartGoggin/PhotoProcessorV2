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
  await page.evaluate(() => {
    window.__confirmCalls = [];
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "plugin:dialog|confirm") {
        window.__confirmCalls.push(args);
        if (window.__confirmDeferred) return new Promise((resolve) => { window.__resolveConfirm = resolve; });
      }
      return originalInvoke(command, args);
    };
  });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await page.getByRole("navigation", { name: "Video editing workflow" }).waitFor();
  const review = page.locator("#studio-review");
  const projectSettings = page.locator("#studio-project-settings");
  const projectSection = (name) => projectSettings.getByRole("button", { name, exact: true });
  const openMusicComposer = async () => {
    const summary = projectSettings.locator("summary").filter({ hasText: /^Compose a soundtrack \(advanced\)/ });
    if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
  };
  await projectSettings.waitFor();
  assert.equal(await projectSettings.getAttribute("aria-label"), "Project settings");
  const projectLayout = await projectSettings.evaluate((node) => {
    const workspace = document.querySelector(".studio-workspace");
    return { bottom: node.getBoundingClientRect().bottom, workspaceTop: workspace.getBoundingClientRect().top,
      precedesWorkspace: !!(node.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING),
      nestedInsideWorkspace: workspace.contains(node) };
  });
  assert.equal(projectLayout.precedesWorkspace, true, "project controls precede the editing workspace in keyboard order");
  assert.equal(projectLayout.nestedInsideWorkspace, false, "project controls are not a clip sidebar");
  assert.ok(projectLayout.bottom <= projectLayout.workspaceTop + 1, "project controls are physically above both sequence and review");
  for (const name of ["Project", "Filters", "Music", "Output"]) {
    const toggle = projectSection(name);
    await toggle.focus();
    const initialOpen = await toggle.getAttribute("aria-expanded");
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), initialOpen === "true" ? "false" : "true", "project disclosure is keyboard accessible");
    assert.equal(await projectSettings.locator("button[aria-expanded='true']").count(), 1, "only the selected project section is expanded");
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), initialOpen);
  }
  const panel = page.getByRole("region", { name: "Background jobs", exact: true });
  const active = panel.getByRole("region", { name: "Active jobs list", exact: true });
  assert.equal(await panel.getByRole("button", { name: /^.*Jobs .*active/ }).getAttribute("aria-expanded"), "false", "Studio defaults to a slim jobs frame");
  await page.screenshot({ path: `${output}/studio-compact-default.png` });
  const compactRowHeight = await page.locator(".studio-sequence-row").first().evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(compactRowHeight < 80, `compact clip row is dense, not a card (${compactRowHeight}px)`);
  await page.getByRole("combobox", { name: "Studio density", exact: true }).selectOption("comfortable");
  assert.equal(await page.evaluate(() => localStorage.getItem("photogogo.studio.density")), "comfortable");
  const comfortableHeight = await page.locator(".studio-sequence-row").first().evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(comfortableHeight > compactRowHeight, `Comfortable row ${comfortableHeight}px should exceed Compact ${compactRowHeight}px`);
  await page.getByRole("combobox", { name: "Studio density", exact: true }).selectOption("compact");
  await page.getByRole("searchbox", { name: "Search clips", exact: true }).fill("warm");
  assert.equal(await page.locator(".studio-sequence-row").count(), 1);
  await page.getByRole("searchbox", { name: "Search clips", exact: true }).fill("");
  await page.getByRole("combobox", { name: "Filter clips", exact: true }).selectOption("review");
  assert.equal(await page.locator(".studio-sequence-row").count(), 1);
  await page.getByRole("combobox", { name: "Filter clips", exact: true }).selectOption("render");
  assert.equal(await page.locator(".studio-sequence-row").count(), 2);
  await page.getByRole("combobox", { name: "Filter clips", exact: true }).selectOption("excluded");
  assert.equal(await page.locator(".studio-sequence-row").count(), 0);
  await page.getByRole("combobox", { name: "Filter clips", exact: true }).selectOption("all");
  await projectSection("Filters").click();
  await page.getByRole("tab", { name: "Sound", exact: true }).click();
  await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
  await page.screenshot({ path: `${output}/studio-project-filters-and-clip-sound.png` });
  await page.getByRole("tab", { name: "Picture", exact: true }).click();
  await projectSection("Music").click();
  await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
  await page.screenshot({ path: `${output}/studio-project-music.png` });
  await openMusicComposer();
  await projectSettings.getByLabel(/^Creative brief/).fill("Quiet accompaniment across the complete project");
  await projectSettings.getByLabel(/^OpenAI API key/).fill("fixture-session-only-not-a-real-key");
  await page.locator(".studio-clip-select").nth(1).click();
  assert.equal(await projectSettings.getByLabel(/^Creative brief/).inputValue(), "Quiet accompaniment across the complete project");
  assert.equal(await projectSettings.getByLabel(/^OpenAI API key/).inputValue(), "fixture-session-only-not-a-real-key", "selection does not remount project music state");
  await page.locator(".studio-clip-select").first().click();
  // A late queued-soundtrack acknowledgement/completion must not replace a file
  // explicitly selected by the user while the native request was in flight.
  const clipsBeforeMusic = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips);
  await page.evaluate(() => {
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__musicFixtureActive = true;
    window.__studioPollCount = 0;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "studio_list_jobs") window.__studioPollCount++;
      if (!window.__musicFixtureActive) return originalInvoke(command, args);
      if (command === "studio_ai_music_direction") return Promise.resolve({ title: "Fixture accompaniment", summary: "Local test direction", genre: "Ambient", mood: "Quiet", key: "C", mode: "major", bpm: 90, energy: 2, instruments: ["Soft synth"], chordProgression: ["C", "F"], arrangement: [{ name: "Opening", bars: 8, energy: 2 }] });
      if (command === "plugin:dialog|open") return Promise.resolve(args.options?.filters?.[0]?.name === "LMMS" ? "D:/fixture/lmms.exe" : "D:/fixture/manual-music.wav");
      if (command === "studio_start_music") {
        window.__pendingMusicRequest = args;
        return new Promise((resolve) => { window.__resolveMusic = resolve; });
      }
      return originalInvoke(command, args);
    };
  });
  await projectSettings.getByRole("button", { name: "Draft music direction from 3 clips", exact: true }).click();
  await projectSettings.getByRole("heading", { name: "Fixture accompaniment", exact: true }).waitFor();
  await projectSettings.getByRole("button", { name: "Choose LMMS", exact: true }).click();
  await projectSettings.getByRole("button", { name: "Generate soundtrack with LMMS", exact: true }).click();
  await page.waitForFunction(() => typeof window.__resolveMusic === "function");
  await projectSettings.getByRole("button", { name: "Use an existing music file", exact: true }).click();
  assert.equal(await projectSettings.getByLabel("Rendered music file", { exact: true }).inputValue(), "D:/fixture/manual-music.wav");
  await page.evaluate(() => window.__resolveMusic("old-music-fixture"));
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((button) => button.textContent === "Generate soundtrack with LMMS")?.disabled);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).music.requestId), "", "late acknowledgement does not claim the manually selected track");
  const musicPoll = await page.evaluate(() => {
    window.__studioJobs.push({ ...window.__studioJobs.find((job) => job.status === "completed"), id: "old-music-fixture", kind: "music", name: "Earlier soundtrack", status: "completed", output: "D:/fixture/obsolete-generated.wav", musicRequestId: window.__pendingMusicRequest.project.music.requestId });
    return window.__studioPollCount;
  });
  await page.waitForFunction((previous) => window.__studioPollCount > previous, musicPoll);
  assert.equal(await projectSettings.getByLabel("Rendered music file", { exact: true }).inputValue(), "D:/fixture/manual-music.wav", "late soundtrack completion cannot overwrite the newer choice");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips), clipsBeforeMusic, "project music changes preserve picture state");
  await page.evaluate(() => { window.__resolveMusic = null; });
  await projectSettings.getByRole("button", { name: "Generate soundtrack with LMMS", exact: true }).click();
  await page.waitForFunction(() => typeof window.__resolveMusic === "function");
  await projectSettings.getByRole("checkbox", { name: "Include background music in complete video", exact: true }).uncheck();
  await page.evaluate(() => window.__resolveMusic("disabled-music-fixture"));
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((button) => button.textContent === "Generate soundtrack with LMMS")?.disabled);
  const disabledMusicPoll = await page.evaluate(() => {
    window.__studioJobs.push({ ...window.__studioJobs.find((job) => job.status === "completed"), id: "disabled-music-fixture", kind: "music", name: "Disabled soundtrack", output: "D:/fixture/disabled-generated.wav", musicRequestId: window.__pendingMusicRequest.project.music.requestId });
    return window.__studioPollCount;
  });
  await page.waitForFunction((previous) => window.__studioPollCount > previous, disabledMusicPoll);
  const disabledMusic = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).music);
  assert.equal(disabledMusic.enabled, false, "late queued soundtrack cannot re-enable music after explicit Off");
  assert.equal(disabledMusic.requestId, "");
  assert.equal(disabledMusic.audioPath, "D:/fixture/manual-music.wav");
  await page.evaluate(() => { window.__musicFixtureActive = false; });
  await projectSettings.getByRole("button", { name: "Clear key", exact: true }).click();
  await projectSection("Music").click();
  await panel.getByRole("button", { name: /^.*Jobs .*active/ }).click();
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
  await page.getByRole("navigation", { name: "Video editing workflow" }).getByRole("link", { name: "Titles & graphics", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: /^Opening title style/ }).inputValue(), "card");
  await page.getByRole("combobox", { name: /^Opening title style/ }).selectOption("overlay");
  await page.getByRole("textbox", { name: "Opening title", exact: true }).fill("Training highlights");
  await review.getByRole("button", { name: "Move down", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips[1].id === "preview-0");
  let project = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  assert.equal(project.clips[1].revision, 0);
  assert.equal(project.clips[1].rendered.path, "D:/out/first.mp4");
  await review.getByRole("button", { name: "Move up", exact: true }).click();
  await page.getByRole("navigation", { name: "Video editing workflow" }).getByRole("link", { name: /^Review/ }).click();
  await review.getByRole("button", { name: /Render clip ·/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.renderKind === "clip");
  let request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.assembleOnly, false);
  assert.equal(request.project.width, 3840); assert.equal(request.project.fps, 50); assert.equal(request.project.bitrateMbps, 32);
  await page.getByRole("tab", { name: "Titles", exact: true }).click();
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
  await projectSection(/^Output\b/).click();
  await page.getByLabel("Resolution", { exact: true }).selectOption("1920");
  await page.getByLabel("Frame rate", { exact: true }).selectOption("30");
  await page.getByLabel("Video bitrate · Mbps").fill("18");
  await review.getByRole("button", { name: /Render clip ·/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.project.bitrateMbps === 18);
  request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.project.width, 1920); assert.equal(request.project.height, 1080); assert.equal(request.project.fps, 30);
  assert.equal(request.project.clips[0].revision, 1);
  await projectSection(/^Output\b/).click();
  await review.getByRole("button", { name: "Approve & next", exact: true }).click();
  await review.getByRole("heading", { name: "Final run", exact: true }).waitFor();
  await review.getByRole("button", { name: "Needs review: Final run", exact: true }).click();
  await page.locator("summary").filter({ hasText: /^Finish & export/ }).click();
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
    if (width === 390) {
      await page.getByRole("combobox", { name: "Studio density", exact: true }).selectOption("comfortable");
      assert.ok(await review.getByRole("button", { name: "Approve & next", exact: true }).evaluate((node) => node.getBoundingClientRect().height) >= 44, "Comfortable narrow-screen controls stay touch-sized");
      await page.getByRole("combobox", { name: "Studio density", exact: true }).selectOption("compact");
    }
  }
  // Expanded advanced sections must also fit a narrow desktop window.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator("main details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "expanded narrow editor fits");
  for (const name of ["Project", "Filters", "Music", "Output"]) {
    await projectSection(name).click();
    assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${name} project settings fit at 360px`);
    await projectSection(name).click();
  }
  await page.locator("main details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = false; }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByRole("button", { name: /History \(/ }).click();
  await page.getByRole("heading", { name: "Background Jobs", exact: true }).waitFor();
  await page.getByText("Finished export fixture", { exact: true }).waitFor();
  await page.getByText("Failed export fixture", { exact: true }).waitFor();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await details(/^Finish & export/).click();
  assert.match(await description.inputValue(), /^My edited description/, "navigation preserves the Studio draft");
  assert.equal(await panel.getByRole("button", { name: /^.*Jobs .*active/ }).getAttribute("aria-expanded"), "true", "returning to Studio preserves explicit jobs expansion");

  await page.getByRole("tab", { name: "Sound", exact: true }).click();
  await projectSection(/^Music\b/).click();
  await details(/^Studio jobs & recovery/).click();
  await openMusicComposer();
  await projectSettings.getByLabel(/^Creative brief/).waitFor();
  assert.equal(await review.getByLabel(/^Creative brief/).count(), 0, "music belongs to the project, never the selected clip");
  await projectSection(/^Music\b/).click();
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
  await projectSection(/^Filters\b/).click();
  await page.getByLabel("Encoder", { exact: true }).selectOption("cpu");
  const beforeDefaultChange = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips);
  await projectSettings.getByRole("combobox", { name: /^Stabiliser for new clips/ }).selectOption("quality");
  await projectSettings.getByRole("combobox", { name: /^New clip preset/ }).selectOption("gentle");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips), beforeDefaultChange, "stabilisation defaults do not silently modify existing clips");
  await page.getByRole("tab", { name: "Picture", exact: true }).click();
  await page.getByLabel("Stabiliser for this clip", { exact: true }).selectOption("fast");
  await page.getByLabel("Stabilisation preset", { exact: true }).selectOption("custom");
  await page.getByLabel("Block size (pixels)", { exact: true }).fill("16");
  await review.getByRole("button", { name: /^Needs review:/ }).click();
  await review.getByRole("button", { name: /Render clip ·/ }).click();
  await page.waitForFunction(() => window.__lastStudioRequest?.project.encoderPreference === "cpu");
  const customRequest = await page.evaluate(() => window.__lastStudioRequest);
  const customClip = customRequest.project.clips.find((clip) => clip.id === customRequest.clipId);
  assert.equal(customClip.stabilizationMethod, "fast"); assert.equal(customClip.customStabilization.blockSize, 16);
  const beforeApply = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  await page.evaluate(() => { window.__confirmResult = false; window.__confirmCalls = []; });
  await projectSettings.getByRole("button", { name: "Apply to selected clip", exact: true }).click();
  await page.waitForFunction(() => window.__confirmCalls.length === 1);
  assert.match((await page.evaluate(() => window.__confirmCalls.at(-1))).message, /1 selected clip.*resets review approval/i);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1"))), beforeApply, "cancelled stabilisation application leaves selected clip untouched");
  await page.evaluate(() => { window.__confirmResult = true; });
  await projectSettings.getByRole("button", { name: "Apply to selected clip", exact: true }).click();
  assert.equal(await review.getByRole("button", { name: /^Needs review:/ }).getAttribute("aria-pressed"), "false");
  const afterSelectedApply = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  assert.equal(afterSelectedApply.clips.find((clip) => clip.id === customRequest.clipId).stabilization, "gentle");
  await page.evaluate(() => { window.__confirmResult = false; window.__confirmCalls = []; });
  await projectSettings.getByRole("button", { name: "Apply to 3 included clip(s)", exact: true }).click();
  await page.waitForFunction(() => window.__confirmCalls.length === 1);
  assert.match((await page.evaluate(() => window.__confirmCalls.at(-1))).message, /3 included clip/i);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1"))), afterSelectedApply, "cancelled included-clips application keeps all edits");
  await page.evaluate(() => { window.__confirmResult = true; });
  await projectSettings.getByRole("button", { name: "Apply to 3 included clip(s)", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.every((clip) => !clip.reviewed && clip.stabilization === "gentle"));
  await page.evaluate(() => { window.__confirmDeferred = true; window.__resolveConfirm = null; });
  await projectSettings.getByRole("button", { name: "Apply to selected clip", exact: true }).click();
  await page.waitForFunction(() => typeof window.__resolveConfirm === "function");
  await page.evaluate(async () => {
    const { STUDIO_CLEARED } = await import("/src/utils/studioWorkflow.ts");
    window.dispatchEvent(new Event(STUDIO_CLEARED));
  });
  await page.getByText(/Studio renders cleared\. Clips will render from scratch/).waitFor();
  const afterClearDuringConfirm = await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  await page.evaluate(() => { window.__confirmDeferred = false; window.__resolveConfirm(true); });
  await page.getByRole("alert").filter({ hasText: /changed while confirming\. Nothing was applied/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1"))), afterClearDuringConfirm, "stale stabilisation confirmation cannot modify replacement project state");
  await page.evaluate(() => { window.__importJobs = []; });
  await panel.getByText("No active jobs", { exact: true }).waitFor();
  assert.equal(await active.isVisible(), false, "empty job frame collapses automatically");
  // Load a larger snapshot through the production project-opening flow, then count
  // complete, actually visible rows inside both the scroll frame and viewport.
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const toggle of await projectSettings.locator("button[aria-expanded='true']").all()) await toggle.click();
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1"));
    project.clips = Array.from({ length: 24 }, (_, index) => ({ ...project.clips[0], id: `dense-${index}`, chapter: `Camera segment ${String(index + 1).padStart(2, "0")}`, path: `D:/Videos/20260925_${String(index).padStart(6, "0")}.mp4` }));
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => command === "studio_load_project" ? project : command === "plugin:dialog|open" ? "D:/fixture/project.json" : invoke(command, args);
  });
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".studio-sequence-row").length === 24);
  await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
  const visibleRowCount = await page.locator(".studio-sequence-list").evaluate((list) => {
    const bounds = list.getBoundingClientRect(), main = document.querySelector("main").getBoundingClientRect();
    return [...list.querySelectorAll(".studio-sequence-row")].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.top >= Math.max(bounds.top, main.top) && box.bottom <= Math.min(bounds.bottom, main.bottom);
    }).length;
  });
  await page.screenshot({ path: `${output}/studio-compact-1920x1080-24-clips.png` });
  assert.ok(visibleRowCount >= 12, `1920×1080 Compact shows at least 12 complete rows, found ${visibleRowCount}`);
  assert.match(await page.locator(".studio-clip-select").first().getAttribute("title"), /20260925_000000.mp4/);
  console.log(`Compact1920: ${visibleRowCount} complete clip rows visible.`);
  // A project can be configured before any clips exist; there is no selection gate.
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")).clips.length === 0);
  await projectSection("Filters").click();
  assert.equal(await projectSettings.getByRole("combobox", { name: "Wind reduction default", exact: true }).isEnabled(), true);
  await projectSection("Project").click();
  assert.equal(await projectSettings.getByLabel("Project name", { exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole("region", { name: "Opening title", exact: true }).getByRole("textbox", { name: "Opening title", exact: true }).isEnabled(), true);
  await projectSection("Output").click();
  assert.equal(await projectSettings.getByLabel("Resolution", { exact: true }).isEnabled(), true);
  await projectSection("Music").click();
  assert.equal(await projectSettings.getByRole("button", { name: "Use an existing music file", exact: true }).isEnabled(), true);
  assert.equal(await review.getByRole("combobox", { name: "Selected clip wind reduction", exact: true }).count(), 0);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
  assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "empty project settings fit at 360px");
  for (const toggle of await projectSettings.getByRole("group", { name: "Project settings sections", exact: true }).getByRole("button").all()) {
    assert.ok(await toggle.evaluate((node) => node.getBoundingClientRect().height) >= 44, "narrow project disclosures are touch-sized");
  }
  await page.screenshot({ path: `${output}/studio-empty-project-360.png` });
  assert.deepEqual(failures, []);
  console.log("PASS: project-first controls, empty-project access, keyboard disclosures, approval/cache preservation, assembly dispatch, descriptions, active/history jobs, 360px–4K layouts and scheduling controls.");
} finally { await browser?.close(); server?.kill(); }
