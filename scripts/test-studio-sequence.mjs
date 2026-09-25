import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

const bundled = await build({ entryPoints: ["src/utils/studioWorkflow.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const workflow = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const { normalizeProject, sequenceRecipe, sequenceStatus, sequenceClipCount } = workflow;
const clip = { id: "a", path: "D:/a.mp4", duration: 10, include: true, reviewed: true, revision: 0, chapter: "A", title: "", titleSeconds: 0, stabilization: "off", stabilizationMethod: "quality", customStabilization: { radius: 16, blockSize: 8, contrast: 125 }, framing: "edgeSafe", notes: "", replays: [] };
const project = normalizeProject({ version: 1, name: "Sequence", title: "Opening", subtitle: "Sub", titleSeconds: 5, openingTitleMode: "overlay", outputDir: "D:/out", width: 1920, height: 1080, fps: 50, bitrateMbps: 10, clips: [clip], music: { enabled: false } });
const target = (c) => ({ clipId: c.id, sourcePath: c.path, revision: c.revision });
const jobFor = (p) => ({ kind: "project", sequence: sequenceRecipe(p), targets: p.clips.filter(c => c.include).map(target) });

test("31 to 51 marks old export outdated and retains original snapshot", () => {
  const original = { ...project, clips: Array.from({ length: 31 }, (_, i) => ({ ...clip, id: `${i}`, path: `D:/${i}.mp4` })) };
  const saved = jobFor(original);
  const updated = { ...original, clips: [...original.clips, ...Array.from({ length: 20 }, (_, i) => ({ ...clip, id: `new-${i}` }))] };
  assert.equal(sequenceStatus(saved, original), "current");
  assert.equal(sequenceStatus(saved, updated), "outdated");
  assert.equal(sequenceClipCount(saved), 31);
  assert.equal(sequenceStatus(jobFor(updated), updated), "current");
});
test("equal counts cannot hide reordered, replaced, excluded or edited clips", () => {
  const p = { ...project, clips: [clip, { ...clip, id: "b", path: "D:/b.mp4" }] };
  const saved = jobFor(p);
  for (const clips of [[...p.clips].reverse(), [clip, { ...p.clips[1], id: "c" }], [clip, { ...p.clips[1], include: false }], [clip, { ...p.clips[1], chapter: "Renamed" }], [clip, { ...p.clips[1], replays: [{ id: "r", enabled: true, start: 1, end: 3, speed: 0.5, caption: "Replay" }] }]]) {
    assert.equal(sequenceStatus(saved, { ...p, clips }), "outdated");
  }
  for (const patch of [{ title: "Changed" }, { fps: 30 }, { bitrateMbps: 20 }, { music: { ...p.music, enabled: true, audioPath: "D:/music.wav" } }]) {
    assert.equal(sequenceStatus(saved, { ...p, ...patch }), "outdated");
  }
});
test("render progress, notes, review, destination and scheduling do not stale an export", () => {
  const saved = jobFor(project);
  const updated = { ...project, outputDir: "E:/out", performance: "balanced", adaptiveScheduling: false,
    clips: [{ ...clip, reviewed: false, notes: "Reviewed again", rendered: { path: "D:/cache.mp4", renderedAt: "now" } }] };
  assert.equal(sequenceStatus(saved, updated), "current");
});
test("legacy or unsupported recipes never claim a match", () => {
  assert.equal(sequenceStatus({ targets: [target(clip)] }, project), "unknown");
  assert.equal(sequenceStatus({ sequence: [999], targets: [target(clip)] }, project), "unknown");
  assert.equal(sequenceStatus({ targets: [target({ ...clip, id: "other" })] }, project), "outdated");
  assert.equal(sequenceClipCount({}), null);
});
test("recipe contract is a versioned ordered value compatible with native JSON", () => {
  assert.deepEqual(sequenceRecipe(project), [1, ["Sequence", "Opening", "Sub", 5, "overlay"], [1920, 1080, 50, 10], null,
    [["a", "D:/a.mp4", 0, 10, "A", "", 0, "off", "quality", [16, 8, 125], "edgeSafe", []]]]);
});
