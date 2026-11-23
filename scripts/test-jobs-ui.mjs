import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Compile the production modules in memory using existing dependencies.
async function compile(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  compiled = compiled.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, "");
  for (const [name, url] of Object.entries({
    react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
    "@tauri-apps/api/core": import.meta.resolve("@tauri-apps/api/core"), ...imports,
  })) compiled = compiled.replaceAll(JSON.stringify(name), JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const jobsUrl = await compile("../src/utils/jobsView.ts");
const modelUrl = await compile("../src/types/videoStudio.ts");
const processUrl = await compile("../src/utils/processJobs.ts");
const importUrl = await compile("../src/utils/importScheduling.ts");
const progressUrl = await compile("../src/utils/jobProgress.ts", { "./importScheduling": importUrl, "./processJobs": processUrl });
const flowCardUrl = await compile("../src/components/JobProgressCard.tsx", { "../utils/jobProgress": progressUrl });
const importStatusUrl = await compile("../src/components/ImportSchedulingStatus.tsx", { "../utils/importScheduling": importUrl });
const schedulerUrl = await compile("../src/components/StudioSchedulerStatus.tsx", { "../types/videoStudio": modelUrl });
const diagnosticsUrl = await compile("../src/components/StudioJobDiagnostics.tsx", { "../types/videoStudio": modelUrl, "./StudioSchedulerStatus": schedulerUrl });
const jobTileUrl = await compile("../src/components/JobTile.tsx", { "../utils/jobProgress": progressUrl, "./JobProgressCard": flowCardUrl });
const studioTileUrl = await compile("../src/components/StudioJobTile.tsx", { "./StudioJobDiagnostics": diagnosticsUrl, "../utils/jobProgress": progressUrl, "./JobProgressCard": flowCardUrl });
const googleUtilsUrl = await compile("../src/utils/googlePhotos.ts");
const googleDetailsUrl = await compile("../src/components/GooglePhotoJobDetails.tsx", { "../utils/googlePhotos": googleUtilsUrl });
const processControlsUrl = await compile("../src/components/ProcessJobControls.tsx");
const jobConsoleUrl = await compile("../src/components/JobConsole.tsx", { "../utils": processUrl, "./ImportSchedulingStatus": importStatusUrl, "../utils/importScheduling": importUrl, "./GooglePhotoJobDetails": googleDetailsUrl, "./ProcessJobControls": processControlsUrl });
const panelUrl = await compile("../src/components/JobsPanel.tsx", {
  "../types/videoStudio": modelUrl, "../utils/jobsView": jobsUrl, "./JobTile": jobTileUrl,
  "./JobConsole": jobConsoleUrl, "./StudioJobTile": studioTileUrl, "./ImportSchedulingStatus": importStatusUrl,
});
const { isActiveJob, jobNeedsAttention, matchesJobsView, countJobs, readPanelSize } = await import(jobsUrl);
const { default: JobsPanel } = await import(panelUrl);
const { default: JobTile } = await import(jobTileUrl);
const { default: JobProgressCard } = await import(flowCardUrl);
const { importJobProgress, processJobProgress, studioJobProgress } = await import(progressUrl);
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const importJob = (status, id = status) => ({
  id, status, done: 1, total: 5, errors: [], logs: [], sourceDir: "E:\\DCIM", stagingDir: "C:\\Staging",
  startedAt: null, finishedAt: null, currentFile: `unique-${id}.jpg`, sourceFileTotal: 5, imported: 1,
  skipped: 0, ignoredFileTotal: 0, unsupportedFileTotal: 0,
});
const studioJob = (status) => ({
  id: status, status, name: `studio-${status}`, phase: "Awaiting work", kind: "clip", progress: 30,
  logs: [], activeTasks: [], artifacts: [], paused: status === "paused",
});

test("every process job type has a graphical source, destination and progress summary", () => {
  const tasks = [
    "focus", "remove_focus", "enhance", "remove_enhance", "bw", "remove_bw", "stabilize", "remove_stabilize",
    "scan_archive_naming", "apply_event_naming", "transfer", "verify_checksums", "scan_faces", "search_person_videos",
    "googlePhotos", "rawDevelop", "takeOutTrash", "sdCardArchive",
  ];
  const displays = tasks.map(task => processJobProgress({
    task, status: "running", done: 2, total: 5, processed: 2, resultCount: 1, currentFile: "sample.jpg",
  }));
  assert.equal(new Set(displays.map(display => display.title)).size, tasks.length);
  for (const display of displays) {
    assert.ok(display.source.label && display.target.label, display.title);
    const markup = render(JobProgressCard, { display });
    assert.match(markup, /class="job-flow"/, display.title);
    assert.match(markup, /sample\.jpg/, display.title);
  }
});

test("unreported totals stay indeterminate and waiting jobs stop animating", () => {
  const importing = { ...importJob("running"), phase: "scanning", total: 0, done: 0 };
  const scanning = render(JobProgressCard, { display: importJobProgress(importing) });
  assert.match(scanning, /<progress aria-label="Import progress"><\/progress>/);
  assert.doesNotMatch(scanning, /0%/);
  const waiting = render(JobProgressCard, { display: importJobProgress({ ...importing, phase: "waiting", waitReason: "Waiting for reader" }) });
  assert.match(waiting, /data-active="false"/);
  assert.match(waiting, /Waiting for reader/);
  assert.doesNotMatch(waiting, /<progress/);
});

test("archive and Google Photos show independent acceptance and verification evidence", () => {
  const job = { status: "running", done: 1, total: 3, processed: 1, resultCount: 0, currentFile: "" };
  const archive = render(JobProgressCard, { display: processJobProgress({ ...job, task: "sdCardArchive", sdCardArchive: {
    label: "Canon card", mode: "archive", phase: "Copying", copiedBytes: 900, verifiedBytes: 200,
    totalBytes: 1200, filesCopied: 2, filesVerified: 1, filesReused: 1, filesRepaired: 0,
  } }) });
  assert.match(archive, /aria-label="Card bytes read" max="1200" value="900"/);
  assert.match(archive, /aria-label="Verified bytes" max="1200" value="200"/);
  assert.match(archive, /<dt>Reused<\/dt><dd>1<\/dd>/);
  const photos = render(JobProgressCard, { display: processJobProgress({ ...job, task: "googlePhotos", googlePhotos: {
    albums: [], bytesDone: 900, totalBytes: 1200, accepted: 2, uploaded: 1, verificationNeedsAttention: 1, readbackUnavailable: 0,
  } }) });
  assert.match(photos, /<dt>Accepted<\/dt><dd>2<\/dd>/);
  assert.match(photos, /<dt>Verified<\/dt><dd>1<\/dd>/);
  assert.match(photos, /<dt>Needs attention<\/dt><dd>1<\/dd>/);
});

test("Studio shows observed render speed and hides live estimates while waiting", () => {
  const job = { ...studioJob("running"), phase: "Stabilising clip", encoder: "h264_nvenc", fps: 50, etaSeconds: 37,
    activeTasks: [{ key: "clip", phase: "Pass 2", progress: 30, fps: 12.4, speed: 0.25 }] };
  const running = render(JobProgressCard, { display: studioJobProgress(job) });
  assert.match(running, /h264_nvenc/);
  assert.match(running, /12\.4 fps/);
  assert.match(running, /37 s/);
  assert.doesNotMatch(running, /50 fps/);
  const waiting = render(JobProgressCard, { display: studioJobProgress({ ...job, phase: "Waiting for memory" }) });
  assert.match(waiting, /data-active="false"/);
  assert.doesNotMatch(waiting, /12\.4 fps|37 s/);
});

test("only running queued and paused jobs belong in Active", () => {
  for (const status of ["running", "queued", "paused"]) assert.equal(isActiveJob({ status }), true);
  for (const status of ["completed", "failed", "interrupted", "aborted", "cancelled", "retried", "unknown"])
    assert.equal(isActiveJob({ status }), false, status);
});
test("all terminal attempts stay in History without deleting data", () => {
  const jobs = ["running", "paused", "queued", "completed", "failed", "interrupted", "cancelled", "aborted", "retried", "future-status"].map((status) => ({ status }));
  const before = JSON.stringify(jobs);
  assert.equal(jobs.filter((job) => matchesJobsView(job, "history")).length, 7);
  assert.equal(JSON.stringify(jobs), before);
});
test("attention includes partial failures and lost checkpoints even during execution", () => {
  for (const job of [{ status: "failed" }, { status: "interrupted" }, { status: "completed", errors: ["One failed copy"] }, { status: "running", persistenceError: "Disk full" }, { status: "future-status" }])
    assert.equal(jobNeedsAttention(job), true);
  assert.equal(jobNeedsAttention({ status: "retried", error: "Previous attempt" }), false);
  assert.equal(matchesJobsView({ status: "running", errors: ["partial failure"] }, "active"), true);
});
test("mixed-family counts distinguish recoverable interruption from active", () => {
  assert.deepEqual(countJobs([importJob("running"), importJob("completed"), studioJob("interrupted"), studioJob("paused")]), { active: 2, attention: 1, history: 2, archived: 0 });
});

test("Google execution phases are active and failed or unverified attempts need attention", () => {
  for (const status of ["preparing", "uploading", "committing"]) {
    assert.equal(isActiveJob({ status }), true, status);
    assert.equal(jobNeedsAttention({ status }), false, status);
  }
  for (const status of ["needs_attention", "completed_with_errors", "waiting_for_account"]) assert.equal(jobNeedsAttention({ status }), true, status);
});

test("dock counts Google Photos as normal core process jobs without duplicate tracker tiles", () => {
  const google = (status, id) => ({ id, task: "googlePhotos", status, createdAt: "2026-10-26T00:00:00Z", done: 1, total: 3, processed: 1, resultCount: 0, currentFile: "Photo 1", errors: status === "needs_attention" ? ["Read-back unavailable"] : [], logs: [], googlePhotos: { albums: [{ key: "event", title: "Synthetic cloud event" }] } });
  const markup = render(JobsPanel, { importJobs: [importJob("running")], processJobs: [google("running", "cloud-active"), google("needs_attention", "cloud-failed")] });
  assert.match(markup, /2 active/); assert.match(markup, /Needs attention \(1\)/); assert.match(markup, /History \(1\)/);
  assert.match(markup, /Google Photos: running\. Show console/); assert.doesNotMatch(markup, /Select Google Photos job|Google Photos: needs_attention/);
});
test("preference reading is SSR safe and resilient to invalid or unavailable storage", () => {
  assert.equal(readPanelSize("jobsPanelHeight", 280, 180, 560), 280);
  globalThis.window = { localStorage: { getItem: () => "Infinity" } };
  assert.equal(readPanelSize("jobsPanelHeight", 280, 180, 560), 280);
  globalThis.window.localStorage.getItem = () => "9999";
  assert.equal(readPanelSize("jobsPanelHeight", 280, 180, 560), 560);
  globalThis.window.localStorage.getItem = () => { throw new Error("Storage denied"); };
  assert.equal(readPanelSize("jobsPanelHeight", 280, 180, 560), 280);
  delete globalThis.window;
});
test("dock renders active jobs only and exposes attention and history counts", () => {
  const markup = render(JobsPanel, { importJobs: [importJob("running"), importJob("completed")], processJobs: [], studioJobs: [studioJob("queued"), studioJob("interrupted"), studioJob("failed")] });
  assert.match(markup, /2 active/);
  assert.match(markup, /Needs attention \(2\)/);
  assert.match(markup, /History \(3\)/);
  assert.match(markup, /unique-running\.jpg/);
  assert.match(markup, /studio-queued/);
  assert.doesNotMatch(markup, /unique-completed\.jpg|studio-interrupted|studio-failed/);
});
test("empty dock collapses while retaining a route to recovery", () => {
  const markup = render(JobsPanel, { importJobs: [], processJobs: [], studioJobs: [studioJob("interrupted")] });
  assert.match(markup, /is-collapsed/);
  assert.match(markup, /No active jobs/);
  assert.match(markup, /Needs attention \(1\)/);
  assert.match(markup, /aria-expanded="false"/);
});
test("poll errors are visible even in an empty dock and diagnostic text is escaped", () => {
  const markup = render(JobsPanel, { importJobs: [], processJobs: [], error: "<device lost>" });
  assert.match(markup, /role="alert"/);
  assert.match(markup, /last known state/);
  assert.match(markup, /&lt;device lost&gt;/);
});

test("collapsed Studio dock keeps live RAM waits outside hidden job tiles", () => {
  const waiting = { ...studioJob("running"), phase: "Waiting for memory: 2231 MiB available <render>" };
  const markup = render(JobsPanel, { importJobs: [], processJobs: [], studioJobs: [waiting], preferCollapsed: true });
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-label="Memory wait"/);
  assert.match(markup, /1 Studio job waiting for RAM/);
  assert.match(markup, /2231 MiB available &lt;render&gt;/);
  assert.ok(markup.indexOf('aria-label="Memory wait"') < markup.indexOf('id="active-jobs-content"'), "warning remains outside collapsed content");
});

test("collapsed RAM summary never revives terminal or paused telemetry", () => {
  const scheduler = { adaptive: true, targetWorkers: 2, activeWorkers: 0, reservedThreads: 0, reason: "Waiting for memory: 2231 MiB available" };
  for (const status of ["completed", "failed", "interrupted", "paused", "queued"]) {
    const markup = render(JobsPanel, { importJobs: [], processJobs: [], studioJobs: [{ ...studioJob(status), phase: "Waiting for RAM", scheduler }], preferCollapsed: true });
    assert.doesNotMatch(markup, /aria-label="Memory wait"/, status);
  }
  const markup = render(JobsPanel, { importJobs: [], processJobs: [], studioJobs: [{ ...studioJob("running"), scheduler }], preferCollapsed: true });
  assert.match(markup, /Shared render capacity/);
  assert.match(markup, /aria-label="Memory wait"/);
});

test("explicit jobs display choice wins over the Studio slim default", () => {
  globalThis.localStorage = { getItem: () => "false" };
  try {
    const markup = render(JobsPanel, { importJobs: [importJob("running")], processJobs: [], preferCollapsed: true });
    assert.match(markup, /aria-expanded="true"/);
  } finally { delete globalThis.localStorage; }
});
test("dock and tile provide keyboard accessible scrolling sizing and selection", () => {
  const markup = render(JobsPanel, { importJobs: [importJob("running")], processJobs: [] });
  assert.match(markup, /role="separator" tabindex="0"/);
  assert.match(markup, /aria-label="Resize jobs panel"/);
  assert.match(markup, /role="region" aria-label="Active jobs list"/);
  const tile = render(JobTile, { job: importJob("paused"), isSelected: true, onClick() {} });
  assert.match(tile, /<button[^>]+aria-pressed="true"/);
});
test("dock does not install a wheel hijack or duplicate Studio status bar", async () => {
  const panel = await readFile(new URL("../src/components/JobsPanel.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /addEventListener\(["']wheel|scrollLeft\s*\+=/);
  assert.doesNotMatch(app, /<StudioJobs\s+compact/);
});

test("completed warning jobs stay in History without concealing genuine errors", () => {
  const job = { status: "completed_with_warnings", errors: [] };
  assert.equal(isActiveJob(job), false);
  assert.equal(jobNeedsAttention(job), false);
  assert.equal(matchesJobsView(job, "history"), true);
  assert.equal(jobNeedsAttention({ ...job, errors: ["Actual upload failure"] }), true);
  assert.equal(jobNeedsAttention({ ...job, persistenceError: "Protected store unavailable" }), true);
});

test("archived uploads are recoverable without ordinary history or attention counts", () => { const job={status:"completed_with_warnings",googlePhotos:{historyHidden:true}}; assert.equal(matchesJobsView(job,"history"),false);assert.equal(matchesJobsView(job,"archived"),true);assert.equal(jobNeedsAttention(job),false);assert.deepEqual(countJobs([job]),{active:0,attention:0,history:0,archived:1}); });
