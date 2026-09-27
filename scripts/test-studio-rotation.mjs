import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

const bundled = await build({ entryPoints: ["src/utils/studioWorkflow.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { normalizeProject, editProject, editClip, isClipReady, applyCompletedRenders, clipJob, sequenceRecipe, sequenceStatus, sequenceClipCount } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const clip = { id: "a", path: "D:/a.mp4", duration: 10, include: true, reviewed: true, revision: 0, chapter: "A", title: "", titleSeconds: 0,
  stabilization: "gentle", stabilizationMethod: "quality", customStabilization: { radius: 16, blockSize: 8, contrast: 125 }, framing: "edgeSafe", notes: "", replays: [] };
const rendered = { path: "D:/old.mp4", signature: "verified", renderedAt: "2026-09-01", revision: 0, width: 1920, height: 1080, fps: 50, bitrateMbps: 10 };
const project = normalizeProject({ version: 1, name: "Rotation", title: "", subtitle: "", titleSeconds: 0, width: 1920, height: 1080, fps: 50, bitrateMbps: 10, clips: [{ ...clip, rendered }], music: { enabled: false } });

test("legacy rotation defaults and saved overrides round trip without changing old renders", () => {
  assert.equal(project.defaultPreventRotation, false);
  assert.equal(project.clips[0].preventRotation, null);
  assert.equal(isClipReady(project.clips[0], project), true);
  for (const value of [true, false, null]) {
    const saved = normalizeProject(JSON.parse(JSON.stringify({ ...project, defaultPreventRotation: true, clips: [{ ...clip, preventRotation: value }] })));
    assert.equal(saved.defaultPreventRotation, true);
    assert.equal(saved.clips[0].preventRotation, value);
  }
});

test("project rotation edits invalidate only affected Quality clips, including excluded ones", () => {
  const p = { ...project, clips: [project.clips[0], { ...clip, id: "off", preventRotation: false }, { ...clip, id: "on", preventRotation: true },
    { ...clip, id: "fast", stabilizationMethod: "fast" }, { ...clip, id: "disabled", stabilization: "off" }, { ...clip, id: "excluded", include: false }] };
  const updated = editProject(p, { defaultPreventRotation: true });
  assert.deepEqual(updated.clips.map(c => c.revision), [1, 0, 0, 0, 0, 1]);
  assert.deepEqual(updated.clips.map(c => c.reviewed), [false, true, true, true, true, false]);
  assert.equal(updated.clips[0].rendered, rendered, "old render remains playable, not deleted");
  for (const i of [1, 2, 3, 4]) assert.equal(updated.clips[i], p.clips[i]);
  assert.equal(isClipReady(updated.clips[0], updated), false);
  assert.deepEqual(editProject(updated, { defaultPreventRotation: true }).clips, updated.clips);
});

test("clip overrides invalidate only an effective change, not equivalent inheritance or dormant settings", () => {
  const p = { ...project, defaultPreventRotation: true };
  assert.equal(editClip(clip, { preventRotation: true }, p).revision, 0);
  assert.equal(editClip({ ...clip, preventRotation: true }, { preventRotation: null }, p).revision, 0);
  assert.equal(editClip(clip, { preventRotation: false }, p).revision, 1);
  assert.equal(editClip({ ...clip, stabilizationMethod: "fast" }, { preventRotation: true }, p).revision, 0);
  assert.equal(editClip({ ...clip, stabilization: "off" }, { preventRotation: true }, p).revision, 0);
});

test("readiness and queued jobs reject a mismatching rotation policy even with an unchanged revision", () => {
  const p = { ...project, defaultPreventRotation: true };
  assert.equal(isClipReady(p.clips[0], p), false);
  assert.equal(isClipReady({ ...clip, rendered: { ...rendered, preventRotation: true } }, p), true);
  const job = { id: "old", kind: "clip", status: "queued", width: 1920, height: 1080, fps: 50, bitrateMbps: 10,
    targets: [{ clipId: "a", sourcePath: clip.path, revision: 0 }], artifacts: [{ clipId: "a", sourcePath: clip.path, rendered }] };
  assert.equal(clipJob(clip, p, [job]), undefined);
  assert.equal(clipJob(clip, project, [job]), job);
  assert.equal(applyCompletedRenders(p, [job]), p);
  const correct = { ...job, targets: [{ ...job.targets[0], preventRotation: true }] };
  assert.equal(clipJob(clip, p, [correct]), correct);
});

test("rotation recipes preserve legacy exports and track effective included policies", () => {
  const old = sequenceRecipe(project);
  assert.equal(old[0], 1);
  const p = { ...project, defaultPreventRotation: true };
  const next = sequenceRecipe(p);
  assert.equal(next[0], 4);
  assert.deepEqual(next.slice(1, 5), old.slice(1, 5));
  assert.deepEqual(next.slice(5), [null, null, [1, [["a", true]]]]);
  assert.equal(sequenceStatus({ sequence: old }, p), "outdated");
  assert.equal(sequenceStatus({ sequence: next }, p), "current");
  assert.equal(sequenceClipCount({ sequence: next }), 1);
  assert.deepEqual(sequenceRecipe({ ...p, clips: [{ ...clip, preventRotation: false }] }), old);
  assert.deepEqual(sequenceRecipe({ ...project, clips: [...project.clips, { ...clip, id: "excluded", include: false, preventRotation: true }] }), old);
});
