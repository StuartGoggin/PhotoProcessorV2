import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-output/studio-reliability/", import.meta.url);
await mkdir(output, { recursive: true });
const sample = fileURLToPath(new URL("sample.mp4", output));
execFileSync(fileURLToPath(new URL("../src-tauri/tools/ffmpeg/bin/ffmpeg.exe", import.meta.url)),
  ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=10:d=2",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", sample],
  { cwd: root, windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
const dataUrl = `data:video/mp4;base64,${(await readFile(sample)).toString("base64")}`;
const url = process.env.STUDIO_RELIABILITY_TEST_URL || "http://127.0.0.1:1434/studio-preview.html";
const server = process.env.STUDIO_RELIABILITY_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1434", "--strictPort"],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser, page;
server?.stdout.on("data", (chunk) => { serverLog += chunk; });
server?.stderr.on("data", (chunk) => { serverLog += chunk; });
try {
  if (server) {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* starting */ }
      await delay(250);
    }
    assert.ok(ready, `Fixture server did not start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(10000);
  const failures = [];
  page.on("pageerror", (failure) => failures.push(failure.message));
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await page.getByRole("navigation", { name: "Video editing workflow" }).waitFor();
  await page.locator(".studio-clip-select").first().waitFor();
  await page.evaluate((dataUrl) => {
    window.__studioPreviewDataUrl = dataUrl;
    window.__reliabilityCalls = [];
    window.__previewQueueCounter = 0;
    window.__fixtureSavedFiles = {};
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      window.__reliabilityCalls.push({ command, args });
      if (command === "studio_start_render" && args.preview) {
        window.__lastStudioRequest = args;
        if (window.__previewQueueDeferred) return new Promise((resolve) => { window.__resolvePreviewQueue = resolve; });
        const id = `reliability-preview-${++window.__previewQueueCounter}`;
        window.__studioJobs.push({ id, name: "Synthetic movement preview", kind: "preview", status: "queued", phase: "Queued", progress: 0,
          output: null, error: null, logs: [], cacheHits: 0, targets: [], activeTasks: [], queuePosition: 1 });
        window.__lastPreviewId = id;
        return id;
      }
      if (command === "plugin:dialog|confirm" && window.__relinkConfirmDeferred) {
        return new Promise((resolve) => { window.__resolveRelinkConfirm = resolve; });
      }
      if (command === "studio_save_project") {
        window.__fixtureSavedFiles[args.path] = JSON.stringify(args.project);
        return null;
      }
      return originalInvoke(command, args);
    };
  }, dataUrl);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  const original = await saved();
  await page.evaluate((project) => { window.__fixtureSavedFiles["E:/original-project.json"] = JSON.stringify(project); }, original);
  await page.getByRole("button", { name: "Relink media", exact: true }).click();
  const relink = page.locator("details.studio-relink");
  await relink.waitFor();
  const check = relink.getByRole("button", { name: "Check media locations", exact: true });
  const apply = relink.getByRole("button", { name: "Apply checked locations", exact: true });
  const undo = relink.getByRole("button", { name: "Undo relink", exact: true });
  const originalStaging = relink.getByLabel("Original staging folder", { exact: true });
  const outputFolder = relink.getByLabel("Relink output folder", { exact: true });
  await originalStaging.fill("E:\\stage");
  await outputFolder.fill("H:\\new-output");
  const makePlan = (project, errors = []) => {
    const candidate = structuredClone(project);
    candidate.outputDir = "H:\\new-output";
    candidate.clips[0].path = "D:\\Videos\\relinked\\Warm-up.mp4";
    candidate.clips[0].rendered = { ...candidate.clips[0].rendered, path: "H:\\new-output\\verified\\first.mp4", signature: "verified-relocated-recipe" };
    return { project: candidate, changes: [
      { label: "Output folder", from: project.outputDir, to: candidate.outputDir },
      { label: "Warm-up original", from: project.clips[0].path, to: candidate.clips[0].path },
      { label: "Warm-up rendered video", from: project.clips[0].rendered.path, to: candidate.clips[0].rendered.path },
    ], errors, warnings: ["Technique practice render was not verified; original footage is retained."], verifiedRenders: 1, elapsedSeconds: 1.25 };
  };
  const configurePlan = (plan) => page.evaluate((plan) => { window.__relinkPlan = plan; }, plan);
  await configurePlan(makePlan(original, ["Missing source: D:\\Videos\\missing.mp4"]));
  await check.click();
  await apply.waitFor();
  assert.equal(await apply.isDisabled(), true, "missing media disables Apply");
  assert.match(await relink.innerText(), /Missing source: D:\\Videos\\missing.mp4/);
  assert.deepEqual(await saved(), original, "checking with errors cannot mutate the working project");
  await relink.locator("summary").filter({ hasText: "Review exact path changes" }).click();
  for (const change of makePlan(original).changes) {
    assert.ok((await relink.innerText()).includes(change.from), "exact original path is visible");
    assert.ok((await relink.innerText()).includes(change.to), "exact replacement path is visible");
  }
  await relink.locator("summary").filter({ hasText: "warnings / renders not verified" }).click();
  assert.match(await relink.innerText(), /original footage is retained/);
  await configurePlan(makePlan(original));
  await check.click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Apply checked locations").disabled);
  await page.evaluate(() => { window.__confirmResult = false; });
  await apply.click();
  assert.deepEqual(await saved(), original, "cancelled confirmation leaves every project field intact");
  assert.equal(await undo.count(), 0);
  await page.evaluate(() => { window.__confirmResult = true; });
  await apply.click();
  await undo.waitFor();
  assert.deepEqual(await saved(), makePlan(original).project, "apply changes only to the exact checked candidate");
  const confirmation = await page.evaluate(() => window.__reliabilityCalls.filter((call) => call.command === "plugin:dialog|confirm").at(-1));
  assert.match(confirmation.args.message, /3 path changes/);
  assert.match(confirmation.args.message, /No media will be moved/);
  await undo.click();
  await relink.getByRole("status").filter({ hasText: "Previous project locations restored" }).waitFor();
  assert.deepEqual(await saved(), original, "undo restores the entire prior working project");
  assert.equal(await page.evaluate(() => window.__fixtureSavedFiles["E:/original-project.json"]), JSON.stringify(original), "original snapshot is byte-for-byte unchanged in the filesystem adapter");
  assert.equal(await page.evaluate(() => window.__reliabilityCalls.filter((call) => call.command === "studio_save_project").length), 0, "check/apply/undo never invoke saved-project writes");

  // Input changes make an already checked plan stale.
  await configurePlan(makePlan(original));
  await check.click();
  await apply.waitFor();
  await originalStaging.fill("E:\\different-stage");
  assert.equal(await apply.isDisabled(), true);
  await relink.getByRole("alert").filter({ hasText: "Project or folder choices changed" }).waitFor();
  await originalStaging.fill("E:\\stage");

  // The rest of Studio stays editable during a native check. A late result must
  // report stale state, not replace work made while hashes were being verified.
  await page.evaluate(() => { window.__relinkDeferred = true; });
  await check.click();
  await page.waitForFunction(() => !!window.__resolveRelink);
  await page.locator("#studio-project-settings").getByRole("button", { name: "Project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("New edit while relink checks");
  await page.evaluate((plan) => { window.__resolveRelink(plan); window.__relinkDeferred = false; }, makePlan(original));
  await apply.waitFor();
  assert.equal(await apply.isDisabled(), true, "a deferred check cannot apply over new edits");
  assert.equal((await saved()).name, "New edit while relink checks");
  assert.equal((await saved()).outputDir, original.outputDir);
  // Also recheck at confirmation completion, when the project has changed after
  // an otherwise valid plan was presented.
  const changed = await saved();
  await configurePlan(makePlan(changed));
  await check.click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Apply checked locations").disabled);
  await page.evaluate(() => { window.__relinkConfirmDeferred = true; });
  await apply.click();
  await page.waitForFunction(() => !!window.__resolveRelinkConfirm);
  await page.getByLabel("Project name", { exact: true }).fill("New edit during confirmation");
  await page.evaluate(() => { window.__resolveRelinkConfirm(true); window.__relinkConfirmDeferred = false; });
  await relink.getByRole("alert").filter({ hasText: "Project changed while checking" }).waitFor();
  assert.equal((await saved()).name, "New edit during confirmation");
  assert.equal((await saved()).outputDir, original.outputDir);
  await page.getByLabel("Project name", { exact: true }).fill(original.name);
  const beforeFolderRace = await saved();
  await configurePlan(makePlan(beforeFolderRace));
  await check.click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Apply checked locations").disabled);
  await page.evaluate(() => { delete window.__resolveRelinkConfirm; window.__relinkConfirmDeferred = true; });
  await apply.click();
  await page.waitForFunction(() => !!window.__resolveRelinkConfirm);
  await outputFolder.fill("H:\\different-output-during-confirmation");
  await page.evaluate(() => { window.__resolveRelinkConfirm(true); window.__relinkConfirmDeferred = false; });
  await relink.getByRole("alert").filter({ hasText: "Folder choices changed. Check media locations again before applying." }).waitFor();
  assert.deepEqual(await saved(), beforeFolderRace, "changing folder choices during confirmation rejects the old plan without any working-project mutation");
  await outputFolder.fill("H:\\new-output");
  await page.locator("#studio-project-settings").getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("button", { name: "Relink media", exact: true }).click();

  // Preview enqueue, completed-job polling, source offset and replay marking
  // use real VideoStudio controls and the isolated read-only MP4 adapter.
  const preview = page.getByRole("region", { name: "Video preview", exact: true });
  const start = page.getByRole("spinbutton", { name: "Preview start seconds", exact: true });
  const playPreview = page.getByRole("button", { name: "Play 12-second preview", exact: true });
  const timeButton = preview.getByRole("button", { name: "Use current source time", exact: true });
  const completePreview = async (jobId) => {
    assert.ok(jobId, "only a captured queued preview can be completed");
    await page.waitForFunction((id) => document.querySelector(".studio-video-preview")?.dataset.previewJobId === id
      && window.__studioJobs.some((job) => job.id === id && job.status === "queued"), jobId);
    await page.evaluate((id) => {
      window.__studioJobs = window.__studioJobs.map((job) => job.id !== id ? job : {
        ...job, status: "completed", progress: 100, output: `D:/preview/${job.id}.mp4`, cacheHits: 1,
      });
    }, jobId);
    await page.waitForFunction((id) => {
      const panel = document.querySelector(".studio-video-preview"), video = panel?.querySelector("video");
      return panel?.dataset.previewJobId === id && window.__studioPreviewReads?.some((read) => read.jobId === id)
        && video && video.readyState >= 1 && Number.isFinite(video.duration);
    }, jobId);
  };
  await start.fill("5.5");
  await playPreview.click();
  await preview.getByText(/Preview queued/).waitFor();
  let request = await page.evaluate(() => window.__lastStudioRequest);
  assert.equal(request.previewStart, 5.5);
  assert.equal(request.previewLength, 12);
  assert.equal(request.project.clips.length, 1);
  assert.equal(request.project.clips[0].id, original.clips[0].id);
  assert.equal(request.project.music.enabled, false);
  assert.equal(await preview.getAttribute("data-preview-job-id"), await page.evaluate(() => window.__lastPreviewId), "returned queue ID owns the player session");
  await completePreview(await preview.getAttribute("data-preview-job-id"));
  await preview.getByText("Cached preview ready", { exact: true }).waitFor();
  await preview.locator("video").evaluate((video) => { video.currentTime = 0.4; });
  await timeButton.click();
  await page.getByText("Replay start: 5.90s", { exact: false }).waitFor();
  await preview.locator("video").evaluate((video) => { video.currentTime = 1.2; });
  await timeButton.click();
  await page.getByRole("tab", { name: "Replays", exact: true }).waitFor();
  let project = await saved();
  assert.ok(Math.abs(project.clips[0].replays[0].start - 5.9) < 0.03);
  assert.ok(Math.abs(project.clips[0].replays[0].end - 6.7) < 0.03);
  assert.equal(await preview.locator("video").count(), 0, "adding a replay invalidates the former recipe preview");
  await page.getByRole("button", { name: "Preview this moment (up to 60s source)", exact: true }).click();
  await preview.getByText(/Preview queued/).waitFor();
  await completePreview(await preview.getAttribute("data-preview-job-id"));
  request = await page.evaluate(() => window.__lastStudioRequest);
  assert.ok(Math.abs(request.previewStart - 5.9) < 0.03);
  assert.equal(request.project.clips[0].replays[0].start, 0);
  assert.equal(await timeButton.count(), 0, "replay-composite previews never expose linear source-time marking");
  await page.locator(".studio-clip-select").nth(1).click();
  await page.locator(".studio-review-heading").getByRole("heading", { name: "Technique practice", exact: true }).waitFor();
  await preview.getByText(/Generate a quick preview/).waitFor();
  assert.equal(await preview.locator("video").count(), 0, "switching clips hides the old preview immediately");
  assert.equal(await start.inputValue(), "0", "new clip preview offset starts at zero");

  // A queued reply that arrives after switching clips cannot reattach the old
  // preview, even if its completed job appears in the next poll.
  await page.evaluate(() => { window.__previewQueueDeferred = true; });
  await playPreview.click();
  await page.waitForFunction(() => !!window.__resolvePreviewQueue);
  await page.locator(".studio-clip-select").nth(2).click();
  await page.evaluate(() => {
    window.__studioJobs.push({ id: "late-preview", name: "Late preview", kind: "preview", status: "completed", phase: "Completed", progress: 100,
      output: "D:/preview/late.mp4", error: null, logs: [], cacheHits: 0, targets: [], activeTasks: [], queuePosition: null });
    window.__resolvePreviewQueue("late-preview"); window.__previewQueueDeferred = false;
  });
  await playPreview.waitFor({ state: "visible" });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Play 12-second preview").disabled);
  await delay(1300);
  assert.equal(await preview.locator("video").count(), 0);
  assert.equal(await preview.getAttribute("data-preview-job-id"), null);
  assert.equal(await page.evaluate(() => (window.__studioPreviewReads || []).some((read) => read.jobId === "late-preview")), false, "obsolete queue acknowledgement never triggers a media read");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => localStorage.getItem(key)?.includes("data:video"))), false);
  assert.equal(await page.evaluate(() => window.__fixtureSavedFiles["E:/original-project.json"]), JSON.stringify(original));

  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator("main").evaluate((node) => node.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "full Studio has no horizontal overflow at laptop width");
  await page.screenshot({ path: fileURLToPath(new URL("studio-laptop.png", output)) });
  await page.setViewportSize({ width: 640, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "full Studio has no horizontal overflow at compact width");
  assert.equal(await page.locator(".studio-editor").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "Studio itself does not hide horizontal overflow inside the app shell");
  await page.screenshot({ path: fileURLToPath(new URL("studio-compact.png", output)) });
  await page.getByRole("button", { name: "Relink media", exact: true }).click();
  await relink.waitFor();
  await relink.getByLabel("Original staging folder", { exact: true }).fill("E:\\stage");
  await relink.getByLabel("Relink output folder", { exact: true }).fill("H:\\new-output");
  await configurePlan(makePlan(await saved()));
  await relink.getByRole("button", { name: "Check media locations", exact: true }).click();
  await relink.getByRole("button", { name: "Apply checked locations", exact: true }).waitFor();
  await relink.locator("summary").filter({ hasText: "Review exact path changes" }).click();
  assert.equal(await relink.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "expanded relink inputs and exact path review fit the compact panel");
  await relink.screenshot({ path: fileURLToPath(new URL("relink-compact.png", output)) });
  assert.deepEqual(failures, []);
  console.log("PASS Studio reliability integration: exact relink review, errors/cancel/undo, saved-file preservation, stale check and project/folder confirmation guards, preview queue identity/offset, source marks, nonlinear replay guard, clip-switch and delayed enqueue invalidation, compact full-page layout");
} catch (failure) {
  if (page) {
    console.error("Studio reliability failure state:", JSON.stringify(await page.evaluate(() => {
      const panel = document.querySelector(".studio-video-preview");
      const video = panel?.querySelector("video");
      return {
        preview: { jobId: panel?.getAttribute("data-preview-job-id"), text: panel?.textContent,
          video: video ? { readyState: video.readyState, networkState: video.networkState, duration: video.duration,
            paused: video.paused, error: video.error?.message, sourceLength: video.getAttribute("src")?.length } : null },
        selectedClip: document.querySelector(".studio-review-heading")?.textContent,
        previewStart: document.querySelector('[aria-label="Preview start seconds"]')?.value,
        jobs: window.__studioJobs?.map((job) => ({ id: job.id, status: job.status, kind: job.kind, output: job.output })),
        reads: window.__studioPreviewReads,
        lastQueueId: window.__lastPreviewId,
        request: window.__lastStudioRequest,
        calls: window.__reliabilityCalls?.slice(-24).map((call) => ({ command: call.command, jobId: call.args?.jobId })),
      };
    }).catch((error) => ({ captureError: String(error) })), null, 2));
    await page.screenshot({ path: fileURLToPath(new URL("failure.png", output)) }).catch(() => {});
  }
  throw failure;
} finally {
  await browser?.close();
  server?.kill();
}
