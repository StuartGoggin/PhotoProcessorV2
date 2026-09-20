import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Use the existing compiler in memory so tests also run on Node versions without TS stripping.
const source = await readFile(new URL("../src/types/videoStudio.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 } });
const modelUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`;
const { newProject, normalizeProject, isPendingStudioJob, sortStudioJobs, liveStudioScheduler, formatStudioMetric } =
  await import(modelUrl);
const schedulerSource = await readFile(new URL("../src/components/StudioSchedulerStatus.tsx", import.meta.url), "utf8");
const schedulerCompiled = ts.transpileModule(schedulerSource, { compilerOptions: {
  module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
  .replace('"../types/videoStudio"', JSON.stringify(modelUrl))
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")));
const { default: StudioSchedulerStatus } = await import(`data:text/javascript;base64,${Buffer.from(schedulerCompiled).toString("base64")}`);

test("new projects use one-pass balanced stabilisation and automatic hardware", () => {
  const project = newProject();
  assert.equal(project.defaultStabilizationMethod, "fast");
  assert.equal(project.defaultStabilization, "balanced");
  assert.equal(project.performance, "max");
  assert.equal(project.encoderPreference, "auto");
  assert.equal(project.adaptiveScheduling, true);
  const second = newProject();
  project.defaultCustomStabilization.radius = 64;
  assert.equal(second.defaultCustomStabilization.radius, 16);
});

test("old saved projects keep two-pass settings and review approval", () => {
  const old = { version: 1, name: "Saved review", clips: [{ id: "old", stabilization: "strong", reviewed: true }] };
  const saved = JSON.stringify(old);
  const normalized = normalizeProject(old);
  assert.equal(normalized.defaultStabilizationMethod, "quality");
  assert.equal(normalized.defaultStabilization, "off");
  assert.equal(normalized.clips[0].stabilizationMethod, "quality");
  assert.equal(normalized.clips[0].stabilization, "strong");
  assert.equal(normalized.clips[0].reviewed, true);
  assert.equal(normalized.adaptiveScheduling, true);
  assert.equal(JSON.stringify(old), saved, "loading must not mutate the input snapshot");
});

test("explicit fixed scheduling is preserved without rewriting invalid saved choices", () => {
  const fixed = { ...newProject(), adaptiveScheduling: false };
  assert.equal(normalizeProject(fixed).adaptiveScheduling, false);
  assert.equal(normalizeProject({ ...fixed, adaptiveScheduling: "invalid" }).adaptiveScheduling, "invalid");
});

test("scheduler telemetry is shared and only read from running jobs", () => {
  const snapshot = { adaptive: true, targetWorkers: 4, activeWorkers: 3, reservedThreads: 10 };
  const older = { ...snapshot, targetWorkers: 2 };
  assert.equal(liveStudioScheduler([
    { status: "completed", scheduler: older },
    { status: "queued", scheduler: older },
    { status: "running", scheduler: snapshot },
  ]), snapshot);
  for (const status of ["completed", "failed", "cancelled", "paused", "queued", "interrupted"]) {
    assert.equal(liveStudioScheduler([{ status, scheduler: snapshot }]), null, `${status} telemetry is not live`);
  }
  assert.equal(liveStudioScheduler([{ status: "running" }]), null, "older backends have no telemetry");
});

test("malformed scheduler capacity is not presented as a valid snapshot", () => {
  const valid = { adaptive: false, targetWorkers: 3, activeWorkers: 0, reservedThreads: 0 };
  for (const scheduler of [null, "bad", [], {}, { ...valid, adaptive: "false" }, { ...valid, activeWorkers: -1 }, { ...valid, reservedThreads: NaN }, { ...valid, targetWorkers: 1.5 }]) {
    assert.equal(liveStudioScheduler([{ status: "running", scheduler }]), null);
  }
  assert.equal(liveStudioScheduler([{ status: "running", scheduler: valid }]), valid, "idle pool readings are valid");
});

test("unavailable telemetry is N/A, distinct from a measured zero", () => {
  for (const kind of ["percent", "memory", "fps", "threads"]) {
    for (const value of [undefined, null, NaN, Infinity, -1, "12", {}, []]) {
      assert.equal(formatStudioMetric(value, kind), "N/A");
    }
  }
  assert.equal(formatStudioMetric(0, "percent"), "0%");
  assert.equal(formatStudioMetric(83.6, "percent"), "84%");
  assert.equal(formatStudioMetric(101, "percent"), "N/A");
  assert.equal(formatStudioMetric(0, "fps"), "0.0 fps");
  assert.equal(formatStudioMetric(42.13, "fps"), "42.1 fps");
  assert.equal(formatStudioMetric(6 * 1024 ** 3, "memory"), "6.0 GiB");
  assert.equal(formatStudioMetric(4, "threads"), "4 CPU thread(s) allocated");
  assert.equal(formatStudioMetric(0, "threads"), "N/A");
  assert.equal(formatStudioMetric(2.5, "threads"), "N/A");
});

test("shared scheduler display hides final snapshots and makes unavailable monitoring explicit", () => {
  assert.equal(renderToStaticMarkup(createElement(StudioSchedulerStatus, { jobs: [{ status: "completed", scheduler: { adaptive: true } }] })), "");
  const unavailable = renderToStaticMarkup(createElement(StudioSchedulerStatus, { jobs: [{ status: "running", scheduler: null }] }));
  assert.match(unavailable, /Shared processing capacity/);
  assert.match(unavailable, /Live scheduler monitoring is unavailable/);
  assert.doesNotMatch(unavailable, /0%/);
});

test("shared scheduler display reports actual and target separately without claiming a queue ETA", () => {
  const scheduler = {
    adaptive: true, targetWorkers: 4, activeWorkers: 2, reservedThreads: 8,
    cpuPercent: 54, availableMemoryBytes: 6 * 1024 ** 3,
    gpuEncoderPercent: 0, gpuDecoderPercent: null, gpuComputePercent: NaN,
    gpuMemoryFreeBytes: null, throughputFps: 42.1, reason: "Waiting for <memory>",
  };
  const markup = renderToStaticMarkup(createElement(StudioSchedulerStatus, { jobs: [{ status: "running", scheduler }] }));
  assert.match(markup, /2 active task\(s\) · target 4 · 8 CPU thread\(s\) allocated/);
  assert.match(markup, /NVIDIA encoder<\/dt><dd>0%/);
  assert.match(markup, /NVIDIA decoder<\/dt><dd>N\/A/);
  assert.match(markup, /NVIDIA compute<\/dt><dd>N\/A/);
  assert.match(markup, /Aggregate active rendering<\/dt><dd>42\.1 fps/);
  assert.match(markup, /not a per-job allocation or queue ETA/);
  assert.match(markup, /Waiting for &lt;memory&gt;/, "diagnostic text must not become HTML");
  const invalidReason = renderToStaticMarkup(createElement(StudioSchedulerStatus, { jobs: [{ status: "running", scheduler: { ...scheduler, reason: {} } }] }));
  assert.match(invalidReason, /Waiting for a scheduler decision/);
});

test("saved custom values and explicit CPU selection survive normalization", () => {
  const current = { ...newProject(), encoderPreference: "cpu", defaultStabilization: "custom", defaultCustomStabilization: { radius: 64, blockSize: 16, contrast: 200 }, clips: [{ id: "fast", stabilization: "custom", stabilizationMethod: "fast", customStabilization: { radius: 32, blockSize: 12, contrast: 80 } }] };
  assert.deepEqual(normalizeProject(current), current);
  const invalid = { ...current, defaultStabilizationMethod: "unknown" };
  assert.equal(normalizeProject(invalid).defaultStabilizationMethod, "unknown", "invalid values must reach backend validation instead of being silently rewritten");
});

test("queue shows active work first and respects persisted queue order", () => {
  const rows = [
    { id: "6", status: "completed", queuePosition: null },
    { id: "5", status: "queued", queuePosition: 2 },
    { id: "4", status: "interrupted", recoverable: true, queuePosition: null },
    { id: "3", status: "queued", queuePosition: 1 },
    { id: "2", status: "running", queuePosition: null },
    { id: "1", status: "interrupted", recoverable: false, queuePosition: null },
  ];
  assert.deepEqual(sortStudioJobs(rows).map((row) => row.id), ["2", "3", "5", "4", "6", "1"]);
  assert.deepEqual(rows.filter(isPendingStudioJob).map((row) => row.id), ["5", "4", "3", "2"]);
  assert.equal(rows[0].id, "6", "sorting should not mutate the polling response");
});
