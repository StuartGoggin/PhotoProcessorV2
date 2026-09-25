import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

const bundled = await build({ entryPoints: ["src/utils/studioWorkflow.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const workflow = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const audioBundle = await build({ entryPoints: ["src/utils/studioAudio.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const audio = await import(`data:text/javascript;base64,${Buffer.from(audioBundle.outputFiles[0].text).toString("base64")}`);
const { normalizeProject, sequenceRecipe, sequenceStatus, sequenceClipCount, editClip, isClipReady } = workflow;
const { effectiveWindReduction, normalizeWindReduction, previewStartSeconds, resetWindReductionOverrides } = audio;
const clip = { id: "one", path: "D:/camera.mp4", duration: 30, include: true, reviewed: true, revision: 4,
  chapter: "Camera", title: "", titleSeconds: 0, stabilization: "off", framing: "edgeSafe", notes: "", replays: [],
  rendered: { path: "D:/render.mp4", signature: "verified", revision: 4, width: 1920, height: 1080, fps: 50, bitrateMbps: 10 } };
const original = normalizeProject({ version: 1, name: "Audio test", title: "", subtitle: "", titleSeconds: 0,
  openingTitleMode: "none", width: 1920, height: 1080, fps: 50, bitrateMbps: 10, clips: [clip] });

test("old projects and new missing clip overrides default to unchanged camera audio", () => {
  assert.equal(original.defaultWindReduction, "off");
  assert.equal(original.clips[0].windReduction, "inherit");
  assert.equal(effectiveWindReduction(original, original.clips[0]), "off");
  assert.equal(sequenceRecipe(original)[0], 1);
  assert.equal(sequenceRecipe(original).length, 5);
});
test("project default is inherited, while explicit off and clip strength win", () => {
  const p = { ...original, defaultWindReduction: "strong" };
  assert.equal(effectiveWindReduction(p, original.clips[0]), "strong");
  assert.equal(effectiveWindReduction(p, { ...clip, windReduction: "off" }), "off");
  assert.equal(effectiveWindReduction(p, { ...clip, windReduction: "light" }), "light");
  assert.equal(effectiveWindReduction(p, clip), "strong");
});
test("invalid values fail safe to off and are not silently normalised in saved data", () => {
  for (const bad of ["bad", "STRONG", null, 1, {}]) assert.equal(normalizeWindReduction(bad), "off");
  assert.equal(effectiveWindReduction({ defaultWindReduction: "bad" }, { windReduction: "inherit" }), "off");
  assert.equal(effectiveWindReduction({ defaultWindReduction: "strong" }, { windReduction: "bad" }), "off");
  assert.equal(normalizeProject({ ...original, defaultWindReduction: "bad" }).defaultWindReduction, "bad");
});
test("audio changes preserve picture review, revision and reusable video", () => {
  const edited = editClip(original.clips[0], { windReduction: "moderate" });
  assert.equal(edited.reviewed, true);
  assert.equal(edited.revision, 4);
  assert.equal(edited.rendered, original.clips[0].rendered);
  assert.equal(isClipReady(edited, original), true);
  assert.equal(isClipReady(edited, { ...original, defaultWindReduction: "strong" }), true);
});
test("effective audio extends the sequence only when needed and stales old exports", () => {
  const before = sequenceRecipe(original);
  const processed = { ...original, defaultWindReduction: "light" };
  const after = sequenceRecipe(processed);
  assert.deepEqual(after.slice(1, 5), before.slice(1));
  assert.deepEqual(after[5], [1, [["one", "light"]]]);
  assert.equal(after[0], 2);
  assert.equal(after.length, 6);
  assert.equal(sequenceStatus({ sequence: before }, processed), "outdated");
  assert.equal(sequenceStatus({ sequence: after }, processed), "current");
  assert.equal(sequenceStatus({ sequence: after }, original), "outdated");
  assert.equal(sequenceClipCount({ sequence: after }), 1);
  assert.equal(sequenceStatus({ sequence: [2, ...after.slice(1, 5)] }, processed), "unknown");
});
test("only effective included audio matters to final recipe", () => {
  const explicitOff = { ...original, defaultWindReduction: "strong", clips: [{ ...original.clips[0], windReduction: "off" }] };
  assert.deepEqual(sequenceRecipe(explicitOff), sequenceRecipe(original));
  const excluded = { ...original, clips: [...original.clips, { ...original.clips[0], id: "hidden", include: false, windReduction: "strong" }] };
  assert.deepEqual(sequenceRecipe(excluded), sequenceRecipe(original));
  const inherited = { ...original, defaultWindReduction: "light" };
  const explicit = { ...original, clips: [{ ...original.clips[0], windReduction: "light" }] };
  assert.deepEqual(sequenceRecipe(inherited), sequenceRecipe(explicit));
});
test("v2 records every included effective preset in clip order, including explicit off", () => {
  const p = { ...original, defaultWindReduction: "strong", clips: [
    { ...original.clips[0], windReduction: "off" },
    { ...original.clips[0], id: "two", windReduction: "inherit" },
  ] };
  const saved = sequenceRecipe(p);
  assert.deepEqual(saved[5], [1, [["one", "off"], ["two", "strong"]]]);
  assert.equal(sequenceClipCount({ sequence: saved }), 2);
  assert.equal(sequenceStatus({ sequence: saved }, { ...p, clips: [...p.clips].reverse() }), "outdated");
});
test("audio preview start is finite and bounded within the selected clip", () => {
  assert.equal(previewStartSeconds(4.5, 30), 4.5);
  assert.equal(previewStartSeconds(-5, 30), 0);
  assert.equal(previewStartSeconds(NaN, 30), 0);
  assert.equal(previewStartSeconds(99, 30), 29.9);
  assert.equal(previewStartSeconds(99, 0.05), 0);
  assert.equal(previewStartSeconds(5, 0), 0);
});

test("reset wind overrides includes excluded and explicit Off but preserves all other clip data", () => {
  const p = { ...original, defaultWindReduction: "moderate", music: { enabled: true, audioPath: "D:/music.wav" }, clips: [
    { ...original.clips[0], windReduction: "off" },
    { ...original.clips[0], id: "excluded", include: false, windReduction: "strong", notes: "Keep this" },
    { ...original.clips[0], id: "inherited", windReduction: "inherit" },
  ] };
  const snapshot = JSON.stringify(p), savedRequest = structuredClone(p), before = sequenceRecipe(p);
  const reset = resetWindReductionOverrides(p);
  assert.equal(JSON.stringify(p), snapshot, "do not mutate the original project or saved requests");
  assert.deepEqual(savedRequest, p);
  assert.equal(reset.music, p.music, "music is unaffected");
  assert.equal(reset.defaultWindReduction, "moderate");
  assert.equal(reset.clips[2], p.clips[2], "already inherited clip is unchanged");
  reset.clips.forEach((c, index) => {
    assert.equal(c.windReduction, "inherit");
    assert.equal(c.rendered, p.clips[index].rendered);
    assert.deepEqual({ ...c, windReduction: p.clips[index].windReduction }, p.clips[index]);
  });
  assert.equal(sequenceStatus({ sequence: before }, reset), "outdated");
});

test("reset only stales an export if included effective audio changes", () => {
  const p = { ...original, defaultWindReduction: "off", clips: [
    { ...original.clips[0], windReduction: "off" },
    { ...original.clips[0], id: "excluded", include: false, windReduction: "strong" },
  ] };
  assert.deepEqual(sequenceRecipe(resetWindReductionOverrides(p)), sequenceRecipe(p));
  assert.equal(resetWindReductionOverrides(original), original, "no overrides is a no-op");
  const empty = { ...original, clips: [] };
  assert.equal(resetWindReductionOverrides(empty), empty);
});
