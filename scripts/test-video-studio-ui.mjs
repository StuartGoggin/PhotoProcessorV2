import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Use the existing compiler in memory so tests also run on Node versions without TS stripping.
const source = await readFile(new URL("../src/types/videoStudio.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 } });
const { newProject, normalizeProject, isPendingStudioJob, sortStudioJobs } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);

test("new projects use one-pass balanced stabilisation and automatic hardware", () => {
  const project = newProject();
  assert.equal(project.defaultStabilizationMethod, "fast");
  assert.equal(project.defaultStabilization, "balanced");
  assert.equal(project.performance, "max");
  assert.equal(project.encoderPreference, "auto");
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
  assert.equal(JSON.stringify(old), saved, "loading must not mutate the input snapshot");
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
