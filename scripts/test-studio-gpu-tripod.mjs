import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

async function moduleAt(path) {
  const bundled = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
}
const { newProject, normalizeProject } = await moduleAt("src/types/videoStudio.ts");
const { GPU_TRIPOD_ENGINE, effectiveStabilizationEngine, effectivePreventRotation } = await moduleAt("src/utils/studioStabilization.ts");
const { editClip, editProject, isClipReady, applyCompletedRenders, clipJob, sequenceRecipe, sequenceStatus, sequenceClipCount } =
  await moduleAt("src/utils/studioWorkflow.ts");
const clip = { id: "a", path: "D:/synthetic/a.mp4", duration: 10, include: true, chapter: "A", title: "", titleSeconds: 0,
  stabilization: "balanced", stabilizationMethod: "quality", customStabilization: { radius: 16, blockSize: 8, contrast: 125 },
  framing: "edgeSafe", preventRotation: false, reviewed: true, revision: 0, notes: "", replays: [] };
const project = { ...newProject(), clips: [clip] };

test("the alternative remains opt-in and legacy saved projects keep Quality", () => {
  assert.equal(newProject().defaultStabilizationMethod, "fast");
  const legacy = normalizeProject({ ...project, defaultStabilizationMethod: undefined,
    clips: [{ ...clip, stabilizationMethod: undefined }] });
  assert.equal(legacy.defaultStabilizationMethod, "quality");
  assert.equal(legacy.clips[0].stabilizationMethod, "quality");
  const gpu = normalizeProject(JSON.parse(JSON.stringify({ ...project, defaultStabilizationMethod: "gpuTripod",
    clips: [{ ...clip, stabilizationMethod: "gpuTripod" }] })));
  assert.equal(gpu.defaultStabilizationMethod, "gpuTripod");
  assert.equal(gpu.clips[0].stabilizationMethod, "gpuTripod");
  assert.equal(gpu.clips[0].preventRotation, false, "dormant Quality preference survives round-trip");
});

test("enabled GPU Tripod is rotation locked regardless of Quality defaults and overrides", () => {
  for (const defaultPreventRotation of [true, false, undefined]) {
    for (const preventRotation of [true, false, null, undefined]) {
      const gpu = { ...clip, stabilizationMethod: "gpuTripod", preventRotation };
      assert.equal(effectivePreventRotation({ defaultPreventRotation }, gpu), true);
      assert.equal(effectiveStabilizationEngine(gpu), GPU_TRIPOD_ENGINE);
      assert.equal(effectivePreventRotation({ defaultPreventRotation }, { ...gpu, stabilization: "off" }), false);
      assert.equal(effectiveStabilizationEngine({ ...gpu, stabilization: "off" }), "");
    }
  }
  for (const stabilizationMethod of ["fast", "quality", undefined]) {
    assert.equal(effectiveStabilizationEngine({ ...clip, stabilizationMethod }), "");
  }
});

test("new defaults do not silently migrate existing clips or invalidate their pictures", () => {
  const next = editProject(project, { defaultStabilizationMethod: "gpuTripod" });
  assert.equal(next.clips[0], clip);
  const gpu = { ...clip, stabilizationMethod: "gpuTripod" };
  const changedDefault = editProject({ ...project, clips: [gpu] }, { defaultPreventRotation: true });
  assert.equal(changedDefault.clips[0], gpu, "Quality-only rotation preference does not stale GPU pictures");
});

test("selecting the new method invalidates picture approval but preserves old files", () => {
  const rendered = { path: "D:/synthetic/old.mp4", revision: 0, signature: "old" };
  const next = editClip({ ...clip, rendered }, { stabilizationMethod: "gpuTripod" }, project);
  assert.equal(next.revision, 1);
  assert.equal(next.reviewed, false);
  assert.equal(next.rendered, rendered);
  const dormantChange = editClip(next, { preventRotation: true }, project);
  assert.equal(dormantChange.revision, next.revision);
  assert.equal(dormantChange.preventRotation, true);
});

const output = { path: "D:/synthetic/render.mp4", width: project.width, height: project.height, fps: project.fps,
  bitrateMbps: project.bitrateMbps, duration: 10, revision: 0, signature: "verified", renderedAt: "2026-10-10T00:00:00Z",
  preventRotation: true };
const gpuClip = { ...clip, stabilizationMethod: "gpuTripod" };
const gpuProject = { ...project, clips: [gpuClip] };

test("GPU readiness requires the exact current engine even when legacy rotation already matches", () => {
  assert.equal(isClipReady({ ...gpuClip, rendered: { ...output, stabilizationEngine: GPU_TRIPOD_ENGINE } }, gpuProject), true);
  for (const stabilizationEngine of [undefined, "", "gpu-tripod-d3d11-v0", "gpu-tripod-d3d11-v2"]) {
    assert.equal(isClipReady({ ...gpuClip, rendered: { ...output, stabilizationEngine } }, gpuProject), false,
      `rotation-matching artifact with engine ${String(stabilizationEngine)} must not appear current`);
  }
});

test("legacy missing engine markers stay ready but a GPU artifact cannot masquerade as Quality", () => {
  const quality = { ...clip, preventRotation: true };
  const p = { ...project, clips: [quality] };
  assert.equal(isClipReady({ ...quality, rendered: output }, p), true);
  assert.equal(isClipReady({ ...quality, rendered: { ...output, stabilizationEngine: "" } }, p), true);
  assert.equal(isClipReady({ ...quality, rendered: { ...output, stabilizationEngine: GPU_TRIPOD_ENGINE } }, p), false);
});

test("GPU queued work must have a matching engine target, not merely matching revision and rotation", () => {
  const job = { id: "gpu-job", kind: "clip", status: "queued", width: project.width, height: project.height,
    fps: project.fps, bitrateMbps: project.bitrateMbps, targets: [{ clipId: clip.id, sourcePath: clip.path,
      revision: 0, preventRotation: true }] };
  assert.equal(clipJob(gpuClip, gpuProject, [job]), undefined);
  for (const stabilizationEngine of ["gpu-tripod-d3d11-v0", "gpu-tripod-d3d11-v2"]) {
    assert.equal(clipJob(gpuClip, gpuProject, [{ ...job, targets: [{ ...job.targets[0], stabilizationEngine }] }]), undefined);
  }
  const matching = { ...job, targets: [{ ...job.targets[0], stabilizationEngine: GPU_TRIPOD_ENGINE }] };
  assert.equal(clipJob(gpuClip, gpuProject, [matching]), matching);
  const quality = { ...clip, preventRotation: true };
  assert.equal(clipJob(quality, { ...project, clips: [quality] }, [job]), job);
  assert.equal(clipJob(quality, { ...project, clips: [quality] }, [matching]), undefined);
});

test("completed GPU outputs cannot be adopted from an old or missing engine", () => {
  const completed = { id: "gpu-finished", kind: "clip", status: "completed", artifacts: [{ clipId: clip.id,
    sourcePath: clip.path, rendered: output }] };
  assert.equal(applyCompletedRenders(gpuProject, [completed]), gpuProject);
  const matching = { ...completed, artifacts: [{ ...completed.artifacts[0], rendered: { ...output, stabilizationEngine: GPU_TRIPOD_ENGINE } }] };
  assert.equal(applyCompletedRenders(gpuProject, [matching]).clips[0].rendered.stabilizationEngine, GPU_TRIPOD_ENGINE);
});

test("GPU recipes append versioned included engine markers and preserve legacy recipes", () => {
  const original = sequenceRecipe(project);
  assert.equal(original[0], 1);
  assert.equal(original.length, 5);
  const audio = { ...project, defaultWindReduction: "light" };
  assert.equal(sequenceRecipe(audio)[0], 2);
  const graphics = { version: 1, theme: { font: "segoe", palette: "midnight", accent: "#D4AF37", position: "bottom", opacity: 0.8 },
    styledTitles: true, scorecardTiming: "clipEnd", scorecardSeconds: 6, scorecardStart: 0 };
  const styled = { ...project, graphics, clips: [{ ...clip, title: "Clip title", titleSeconds: 2 }] };
  assert.equal(sequenceRecipe(styled)[0], 3);
  const locked = { ...project, clips: [{ ...clip, preventRotation: true }] };
  const legacyRotation = sequenceRecipe(locked);
  assert.equal(legacyRotation[0], 4);
  assert.equal(legacyRotation.length, 8);
  for (const p of [project, audio, styled, locked]) {
    const untouched = sequenceRecipe({ ...p, defaultStabilizationMethod: "gpuTripod" });
    assert.deepEqual(untouched, sequenceRecipe(p), "changing only new-clip default must not change existing recipe");
  }
  const mixed = { ...gpuProject, clips: [gpuClip, { ...clip, id: "legacy", preventRotation: true },
    { ...gpuClip, id: "excluded", include: false }] };
  const next = sequenceRecipe(mixed);
  assert.equal(next[0], 5);
  assert.equal(next.length, 9);
  assert.deepEqual(next[8], [1, mixed.clips.filter(c => c.include).map(c => [c.id, effectiveStabilizationEngine(c)])]);
  assert.deepEqual(next[7], [1, [["a", true], ["legacy", true]]]);
  assert.equal(sequenceStatus({ sequence: next }, mixed), "current");
  assert.equal(sequenceClipCount({ sequence: next }), 2);
  const oldMarker = structuredClone(next);
  oldMarker[8][1][0][1] = "gpu-tripod-d3d11-v0";
  assert.equal(sequenceStatus({ sequence: oldMarker }, mixed), "outdated");
  assert.equal(sequenceStatus({ sequence: original }, gpuProject), "outdated");
});
