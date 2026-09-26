import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

async function moduleAt(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const graphics = await moduleAt("src/utils/studioGraphics.ts");
const workflow = await moduleAt("src/utils/studioWorkflow.ts");
const clip = { id: "one", path: "D:/one.mp4", duration: 20, include: true, reviewed: true, revision: 7,
  chapter: "Round one", title: "", titleSeconds: 4, stabilization: "off", stabilizationMethod: "quality",
  customStabilization: { radius: 16, blockSize: 8, contrast: 0.1 }, framing: "edgeSafe", notes: "", replays: [],
  rendered: { path: "D:/cached.mp4", signature: "verified", revision: 7, width: 1920, height: 1080, fps: 25, bitrateMbps: 10 } };
const project = workflow.normalizeProject({ version: 1, name: "Test", title: "", subtitle: "", titleSeconds: 0,
  openingTitleMode: "none", width: 1920, height: 1080, fps: 25, bitrateMbps: 10, clips: [clip] });

test("scorecard details and inherited project timing never invalidate stabilised pictures", () => {
  const card = { ...graphics.newScorecard(), result: "72 points · 1st place" };
  const edited = workflow.editClip(project.clips[0], { scorecard: card });
  assert.equal(edited.reviewed, true);
  assert.equal(edited.revision, 7);
  assert.equal(edited.rendered, clip.rendered);
  const styled = { ...project, graphics: graphics.graphicsDefaults(), clips: [edited] };
  assert.equal(workflow.isClipReady(edited, styled), true);
  assert.deepEqual(graphics.scoreWindow(styled, edited), { start: 14, end: 20, extraSeconds: 0 });
  assert.equal(graphics.graphicsRecipe(project), null);
});

test("changing a result marks a finished export outdated without changing picture readiness", () => {
  const p = { ...project, graphics: graphics.graphicsDefaults(), clips: [{ ...clip, scorecard: graphics.newScorecard() }] };
  const saved = workflow.sequenceRecipe(p);
  p.clips = [workflow.editClip(p.clips[0], { scorecard: { ...p.clips[0].scorecard, result: "73 points" } })];
  assert.equal(workflow.sequenceStatus({ sequence: saved }, p), "outdated");
  assert.equal(workflow.isClipReady(p.clips[0], p), true);
  assert.equal(workflow.sequenceClipCount({ sequence: saved }), 1);
});

test("standalone result shifts the next chapter but not the clip or its replays", () => {
  const p = { ...project, graphics: { ...graphics.graphicsDefaults(), scorecardTiming: "separateCard" },
    clips: [{ ...clip, scorecard: graphics.newScorecard(), replays: [{ enabled: true, start: 2, end: 4, speed: 0.5 }] }, { ...clip, id: "two" }] };
  const chapters = graphics.chapterPlan(p);
  assert.equal(chapters[0].cardStart, 24);
  assert.equal(chapters[0].cardEnd, 30);
  assert.equal(chapters[1].start, 30);
  assert.equal(chapters[1].end, 50);
});

test("individual clip jobs match their explicit target style without a project sequence", () => {
  const c = { ...clip, title: "Round one" };
  const original = { ...project, graphics: { ...graphics.graphicsDefaults(), styledTitles: true }, clips: [c] };
  const job = { kind: "clip", status: "running", progress: 30, width: 1920, height: 1080, fps: 25, bitrateMbps: 10,
    targets: [{ clipId: "one", sourcePath: c.path, revision: 7, titleStyleKey: graphics.titleStyleKey(original, c) }], sequence: null };
  assert.equal(workflow.clipJob(c, original, [job]), job);
  assert.equal(workflow.clipStatus(c, original, [job]), "Rendering · 30%");
  const changed = { ...original, graphics: { ...original.graphics, theme: { ...original.graphics.theme, font: "georgia" } } };
  assert.equal(workflow.clipJob(c, changed, [job]), undefined);
  assert.equal(workflow.clipStatus(c, changed, [job]), "Needs re-render");
  assert.equal(workflow.clipStatus(c, original, [{ ...job, status: "failed" }]), "Render failed · resume in Jobs");
  assert.equal(workflow.clipStatus(c, changed, [{ ...job, status: "failed" }]), "Needs re-render");
});

test("legacy project jobs retain their saved-sequence style fallback", () => {
  const c = { ...clip, title: "Round one" };
  const styled = { ...project, graphics: { ...graphics.graphicsDefaults(), styledTitles: true }, clips: [c] };
  const job = { kind: "project", status: "queued", width: 1920, height: 1080, fps: 25, bitrateMbps: 10,
    targets: [{ clipId: c.id, sourcePath: c.path, revision: 7 }], sequence: workflow.sequenceRecipe(styled) };
  assert.equal(workflow.clipJob(c, styled, [job]), job);
  const changed = { ...styled, graphics: { ...styled.graphics, theme: { ...styled.graphics.theme, font: "georgia" } } };
  assert.equal(workflow.clipJob(c, changed, [job]), undefined);
  const legacy = { ...styled, graphics: undefined };
  const oldClipJob = { ...job, kind: "clip", sequence: null };
  assert.equal(workflow.clipJob(c, legacy, [oldClipJob]), oldClipJob);
  assert.equal(workflow.clipJob(c, styled, [oldClipJob]), undefined);
});

test("explicit target identity including legacy empty style takes precedence over a saved recipe", () => {
  const c = { ...clip, title: "Round one" };
  const styled = { ...project, graphics: { ...graphics.graphicsDefaults(), styledTitles: true }, clips: [c] };
  const job = { kind: "project", status: "running", width: 1920, height: 1080, fps: 25, bitrateMbps: 10,
    targets: [{ clipId: "other", sourcePath: "D:/other.mp4", revision: 7, titleStyleKey: graphics.titleStyleKey(styled, c) },
      { clipId: c.id, sourcePath: c.path, revision: 7, titleStyleKey: "" }], sequence: workflow.sequenceRecipe(styled) };
  assert.equal(workflow.clipJob(c, styled, [job]), undefined);
  assert.equal(workflow.clipJob(c, { ...styled, graphics: undefined }, [job]), job);
});
