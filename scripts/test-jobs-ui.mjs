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
const importStatusUrl = await compile("../src/components/ImportSchedulingStatus.tsx", { "../utils/importScheduling": importUrl });
const schedulerUrl = await compile("../src/components/StudioSchedulerStatus.tsx", { "../types/videoStudio": modelUrl });
const diagnosticsUrl = await compile("../src/components/StudioJobDiagnostics.tsx", { "../types/videoStudio": modelUrl, "./StudioSchedulerStatus": schedulerUrl });
const jobTileUrl = await compile("../src/components/JobTile.tsx", { "../utils": processUrl, "./ImportSchedulingStatus": importStatusUrl });
const jobConsoleUrl = await compile("../src/components/JobConsole.tsx", { "../utils": processUrl, "./ImportSchedulingStatus": importStatusUrl, "../utils/importScheduling": importUrl });
const studioTileUrl = await compile("../src/components/StudioJobTile.tsx", { "./StudioJobDiagnostics": diagnosticsUrl });
const panelUrl = await compile("../src/components/JobsPanel.tsx", {
  "../types/videoStudio": modelUrl, "../utils/jobsView": jobsUrl, "./JobTile": jobTileUrl,
  "./JobConsole": jobConsoleUrl, "./StudioJobTile": studioTileUrl, "./ImportSchedulingStatus": importStatusUrl,
});
const { isActiveJob, jobNeedsAttention, matchesJobsView, countJobs, readPanelSize } = await import(jobsUrl);
const { default: JobsPanel } = await import(panelUrl);
const { default: JobTile } = await import(jobTileUrl);
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
  assert.deepEqual(countJobs([importJob("running"), importJob("completed"), studioJob("interrupted"), studioJob("paused")]), { active: 2, attention: 1, history: 2 });
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
test("dock and tile provide keyboard accessible scrolling sizing and selection", () => {
  const markup = render(JobsPanel, { importJobs: [importJob("running")], processJobs: [] });
  assert.match(markup, /role="separator" tabindex="0"/);
  assert.match(markup, /aria-label="Resize jobs panel"/);
  assert.match(markup, /role="region" aria-label="Active jobs list"/);
  const tile = render(JobTile, { job: importJob("paused"), isSelected: true, onClick() {} });
  assert.match(tile, /role="button" tabindex="0" aria-pressed="true"/);
});
test("dock does not install a wheel hijack or duplicate Studio status bar", async () => {
  const panel = await readFile(new URL("../src/components/JobsPanel.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /addEventListener\(["']wheel|scrollLeft\s*\+=/);
  assert.doesNotMatch(app, /<StudioJobs\s+compact/);
});
