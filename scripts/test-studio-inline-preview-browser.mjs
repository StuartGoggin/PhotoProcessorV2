import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-output/studio-inline-preview/", import.meta.url);
await mkdir(output, { recursive: true });
const sample = fileURLToPath(new URL("sample.mp4", output));
// Tiny bounded synthetic media: no source footage, project, or render process.
execFileSync(fileURLToPath(new URL("../src-tauri/tools/ffmpeg/bin/ffmpeg.exe", import.meta.url)),
  ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=10:d=2",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", sample],
  { cwd: root, windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
const dataUrl = `data:video/mp4;base64,${(await readFile(sample)).toString("base64")}`;
const url = process.env.STUDIO_INLINE_TEST_URL || "http://127.0.0.1:1433/studio-inline-preview.html";
const server = process.env.STUDIO_INLINE_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1433", "--strictPort"],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
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
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const failures = [];
  page.on("pageerror", (failure) => failures.push(failure.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript((url) => { window.__previewDataUrl = url; }, dataUrl);
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  const panel = page.getByRole("region", { name: "Video preview", exact: true });
  await panel.waitFor();
  const setPreview = async (id, status = "completed", extra = {}, linear = true) => {
    await page.evaluate(({ id, status, extra, linear }) => {
      const job = { id, kind: "preview", status, phase: "Stabilising preview", progress: 25, output: status === "completed" ? `D:/preview/${id}.mp4` : null,
        error: null, logs: [], cacheHits: 0, ...extra };
      window.__setPreview({ jobId: id, jobs: [job], sourceStart: 10 }, linear);
    }, { id, status, extra, linear });
    await page.waitForFunction((id) => document.querySelector(".studio-video-preview")?.dataset.previewJobId === id, id);
  };
  const readCount = () => page.evaluate(() => window.__previewCalls.filter((call) => call.command === "studio_read_preview").length);
  const waitPlayable = () => page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && video.readyState >= 1 && Number.isFinite(video.duration);
  });

  assert.match(await panel.innerText(), /Generate a quick preview/);
  assert.equal(await readCount(), 0);
  await setPreview("queued", "queued");
  await panel.getByText(/Preview queued/).waitFor();
  assert.equal(await readCount(), 0, "queued jobs are never opened/read");
  await setPreview("queued", "running");
  await panel.getByText(/Stabilising preview · 25%/).waitFor();
  assert.equal(await readCount(), 0, "running output is never read");
  await setPreview("queued", "paused");
  await panel.getByText(/Preview paused or interrupted/).waitFor();
  await setPreview("queued", "failed", { error: "Synthetic render failure" });
  await panel.getByText(/Synthetic render failure/).waitFor();
  await setPreview("queued", "cancelled");
  await panel.getByText(/Preview cancelled/).waitFor();

  await setPreview("ready", "completed", { cacheHits: 1 });
  await waitPlayable();
  await panel.getByText("Cached preview ready", { exact: true }).waitFor();
  assert.equal(await page.locator("video").evaluate((video) => video.paused), true, "playback never starts itself");
  assert.equal(await page.locator("video").getAttribute("autoplay"), null);
  await page.locator("video").evaluate(async (video) => { video.muted = true; await video.play(); });
  await page.waitForFunction(() => document.querySelector("video").currentTime > 0.15);
  assert.ok(await page.locator("video").evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames > 0), "the synthetic MP4 decodes and plays");
  await page.locator("video").evaluate((video) => video.pause());
  await page.locator("video").evaluate((video) => { video.currentTime = 0.6; });
  await page.waitForFunction(() => Math.abs(document.querySelector("video").currentTime - 0.6) < 0.05);
  await panel.getByRole("button", { name: "Use current source time", exact: true }).click();
  assert.ok(Math.abs((await page.evaluate(() => window.__selectedPreviewTimes[0])) - 10.6) < 0.05, "selection includes the original-clip offset");
  const beforePoll = await readCount();
  await setPreview("ready", "completed", { cacheHits: 1 });
  await delay(200);
  assert.equal(await readCount(), beforePoll, "job polling does not reread the video");
  await panel.getByRole("button", { name: "Open preview externally", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__previewCalls.find((call) => call.command === "open_in_default_app").args.path), "D:/preview/ready.mp4");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => localStorage.getItem(key)?.includes("data:video"))), false, "media stays out of localStorage");

  await setPreview("replay", "completed", {}, false);
  await waitPlayable();
  assert.equal(await panel.getByRole("button", { name: "Use current source time" }).count(), 0, "composited replay playback cannot select source time");
  const beforeUnknown = await readCount();
  await setPreview("not-preview", "completed", { kind: "project" });
  await panel.getByText(/This job is not a preview/).waitFor();
  assert.equal(await readCount(), beforeUnknown, "project exports are never loaded as inline previews");
  assert.equal(await panel.getByRole("button", { name: "Open preview externally" }).count(), 0);
  assert.equal(await page.locator("video").count(), 0);

  await page.evaluate(() => { window.__previewReadMode = "error"; });
  await setPreview("large");
  await panel.getByRole("alert").filter({ hasText: /64 MiB/ }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Open preview externally" }).isEnabled(), true);
  await page.evaluate(() => { window.__previewReadMode = "normal"; });
  await panel.getByRole("button", { name: "Retry preview playback", exact: true }).click();
  await waitPlayable();
  await page.locator("video").dispatchEvent("error");
  await panel.getByRole("alert").filter({ hasText: /cannot be played in the app/ }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Use current source time" }).isDisabled(), true, "failed playback cannot select a misleading source time");
  await panel.getByRole("button", { name: "Retry preview playback", exact: true }).click();
  await waitPlayable();
  await panel.getByRole("button", { name: "Use current source time" }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Use current source time").disabled);

  await page.evaluate(() => { window.__previewReadMode = "invalid"; });
  await setPreview("invalid");
  await panel.getByRole("alert").filter({ hasText: /not a supported MP4/ }).waitFor();
  assert.equal(await page.locator("video").count(), 0, "unexpected remote URLs are rejected");

  // A late read of an older selection must never reappear after a newer one.
  await page.evaluate(() => { window.__previewReadMode = "deferred"; });
  await setPreview("old");
  await page.waitForFunction(() => window.__pendingPreviewReads.some((read) => read.jobId === "old"));
  await page.evaluate(() => { window.__previewReadMode = "normal"; });
  await setPreview("new");
  await waitPlayable();
  await page.evaluate(() => { window.__pendingPreviewReads.filter((read) => read.jobId === "old").forEach((read) => read.reject(new Error("Stale read must be ignored"))); });
  await delay(100);
  assert.equal(await panel.getByRole("alert").count(), 0);
  assert.equal(await page.locator("video").count(), 1);
  await page.evaluate(() => { window.__setPreview({ jobId: null, jobs: [], sourceStart: 0, resetKey: "edited recipe" }); });
  await panel.getByText(/Generate a quick preview/).waitFor();
  assert.equal(await page.locator("video").count(), 0, "editing/reset drops the old preview immediately");

  await page.evaluate(() => { window.__previewReadMode = "deferred"; });
  await setPreview("unmount");
  await page.waitForFunction(() => window.__pendingPreviewReads.some((read) => read.jobId === "unmount"));
  await page.evaluate(() => { window.__showPreview(false); });
  await panel.waitFor({ state: "detached" });
  await page.evaluate(() => { window.__pendingPreviewReads.filter((read) => read.jobId === "unmount").forEach((read) => read.resolve(window.__previewDataUrl)); });
  await page.evaluate(() => { window.__previewReadMode = "normal"; window.__showPreview(true); });
  await waitPlayable();
  await page.setViewportSize({ width: 360, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "preview controls remain inside a narrow viewport");
  await page.screenshot({ path: fileURLToPath(new URL("compact.png", output)) });
  assert.deepEqual(failures, []);
  console.log("PASS inline preview: real MP4 playback, no autoplay, original-time selection, cache status, polling stability, non-linear replay guard, job type checks, oversized/invalid response and playback-error fallback, stale/unmounted response guards, no media persistence, compact layout");
} finally {
  await browser?.close();
  server?.kill();
}
