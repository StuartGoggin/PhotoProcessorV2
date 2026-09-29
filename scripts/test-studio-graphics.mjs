import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

async function moduleAt(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const graphics = await moduleAt("src/utils/studioGraphics.ts");
const workflow = await moduleAt("src/utils/studioWorkflow.ts");
const studioTypes = await moduleAt("src/types/videoStudio.ts");
const clip = { id: "one", path: "D:/one.mp4", duration: 20, include: true, reviewed: true, revision: 7,
  chapter: "Round one", title: "", titleSeconds: 4, stabilization: "off", stabilizationMethod: "quality",
  customStabilization: { radius: 16, blockSize: 8, contrast: 0.1 }, framing: "edgeSafe", notes: "", replays: [],
  rendered: { path: "D:/cached.mp4", signature: "verified", revision: 7, width: 1920, height: 1080, fps: 25, bitrateMbps: 10 } };
const project = workflow.normalizeProject({ version: 1, name: "Test", title: "", subtitle: "", titleSeconds: 0,
  openingTitleMode: "none", width: 1920, height: 1080, fps: 25, bitrateMbps: 10, clips: [clip] });

test("project scorecard starting defaults seed only unconfigured clips with independent blank results", () => {
  const template = { ...graphics.scorecardTemplateDefaults(), enabled: true, template: "table", heading: "FINAL",
    columns: ["Place", "Rider", "Points"], blankRows: 2 };
  const disabled = { ...clip, id: "off", scorecard: { ...graphics.newScorecard(), enabled: false } };
  const populated = { ...clip, id: "ready", scorecard: { ...graphics.newScorecard(), result: "72 points" } };
  const source = { ...project, graphics: { ...graphics.graphicsDefaults(), scorecardTemplate: template },
    clips: [clip, { ...clip, id: "two" }, disabled, populated] };
  const seeded = graphics.applyScorecardTemplate(source);
  assert.equal(source.clips[0].scorecard, undefined, "never mutate caller project");
  assert.equal(seeded.clips[2], disabled, "explicitly disabled is configured, not missing");
  assert.equal(seeded.clips[3], populated, "results never overwritten");
  assert.equal(seeded.clips[0].scorecard.requiresResults, true);
  assert.deepEqual(seeded.clips[0].scorecard.rows, [["", "", ""], ["", "", ""]]);
  assert.equal(seeded.clips[0].scorecard.result, "");
  assert.equal(seeded.clips[0].reviewed, true);
  assert.equal(seeded.clips[0].revision, 7);
  assert.equal(seeded.clips[0].rendered, clip.rendered);
  assert.equal(workflow.isClipReady(seeded.clips[0], seeded), true);
  seeded.clips[0].scorecard.rows[0][0] = "1";
  seeded.clips[0].scorecard.columns[0] = "Rank";
  assert.deepEqual(seeded.clips[1].scorecard.rows, [["", "", ""], ["", "", ""]]);
  assert.deepEqual(seeded.clips[1].scorecard.columns, ["Place", "Rider", "Points"]);
  assert.deepEqual(template.columns, ["Place", "Rider", "Points"]);
  assert.equal(graphics.seedScorecardDefaults(project, clip), clip, "missing template is opt-out");
  assert.equal(graphics.seedScorecardDefaults({ ...source, graphics: { ...source.graphics, scorecardTemplate: { ...template, enabled: false } } }, clip), clip);
});

test("editing project template affects future defaults only and survives saved-project reload", () => {
  const source = { ...project, graphics: { ...graphics.graphicsDefaults(), scorecardTemplate: { ...graphics.scorecardTemplateDefaults(), enabled: true } } };
  const seeded = graphics.applyScorecardTemplate(source);
  const first = seeded.clips[0];
  const updated = workflow.editProject(seeded, { graphics: { ...seeded.graphics, scorecardTemplate: { ...seeded.graphics.scorecardTemplate, heading: "NEXT ROUND", template: "table", blankRows: 3 } } });
  assert.equal(updated.clips[0], first);
  assert.equal(graphics.applyScorecardTemplate(updated).clips[0], first, "apply is idempotent for every configured card");
  const next = graphics.seedScorecardDefaults(updated, { ...clip, id: "new" });
  assert.equal(next.scorecard.heading, "NEXT ROUND");
  assert.equal(next.scorecard.rows.length, 3);
  const loaded = workflow.normalizeProject(JSON.parse(JSON.stringify({ ...updated, clips: [...updated.clips, next] })));
  assert.deepEqual(loaded.graphics.scorecardTemplate, updated.graphics.scorecardTemplate);
  assert.equal(loaded.clips[0].scorecard.requiresResults, true);
  assert.equal(loaded.clips[0].scorecard.heading, "RESULT");
  assert.equal(loaded.clips[1].scorecard.heading, "NEXT ROUND");
});

test("blank prepared cards cannot change export recipe, chapters or duration; real results activate them", () => {
  const baseline = { ...project, clips: [clip, { ...clip, id: "two" }] };
  const source = { ...baseline, graphics: { ...graphics.graphicsDefaults(), scorecardTiming: "separateCard",
    scorecardTemplate: { ...graphics.scorecardTemplateDefaults(), enabled: true } } };
  const seeded = graphics.applyScorecardTemplate(source);
  assert.deepEqual(workflow.sequenceRecipe(seeded), workflow.sequenceRecipe(baseline));
  assert.equal(graphics.graphicsRecipe(seeded), null);
  assert.equal(studioTypes.projectDuration(seeded), 40);
  assert.deepEqual(graphics.chapterPlan(seeded), graphics.chapterPlan(baseline));
  assert.equal(graphics.chapterPlan(seeded)[0].cardStart, null);
  const completed = { ...seeded, clips: [workflow.editClip(seeded.clips[0], { scorecard: { ...seeded.clips[0].scorecard, result: "72 points" } }), seeded.clips[1]] };
  assert.equal(studioTypes.projectDuration(completed), 46);
  assert.equal(graphics.chapterPlan(completed)[1].start, 26);
  assert.equal(workflow.sequenceStatus({ sequence: workflow.sequenceRecipe(seeded) }, completed), "outdated");
  assert.equal(workflow.isClipReady(completed.clips[0], completed), true);
  const cleared = { ...completed, clips: [{ ...completed.clips[0], scorecard: { ...completed.clips[0].scorecard, result: "  " } }, completed.clips[1]] };
  assert.deepEqual(workflow.sequenceRecipe(cleared), workflow.sequenceRecipe(baseline), "clearing results returns to omitted state");
  const legacy = { ...source, clips: [{ ...clip, scorecard: graphics.newScorecard() }] };
  assert.notEqual(graphics.graphicsRecipe(legacy), null, "legacy heading-only cards stay visible");
});

test("prepared table requires an actual cell, not a common heading or result subtitle", () => {
  const source = { ...project, graphics: { ...graphics.graphicsDefaults(), scorecardTemplate: { ...graphics.scorecardTemplateDefaults(), enabled: true, template: "table" } } };
  const prepared = graphics.seedScorecardDefaults(source, clip).scorecard;
  assert.equal(studioTypes.scorecardReady({ ...prepared, result: "Event", heading: "Placings", subtitle: "Results" }), false);
  assert.equal(studioTypes.scorecardReady({ ...prepared, rows: [[" ", "", ""]] }), false);
  assert.equal(studioTypes.scorecardReady({ ...prepared, rows: [["", "Rider", ""]] }), true);
  assert.equal(studioTypes.scorecardReady({ ...prepared, enabled: false, rows: [["1", "Rider", "72"]] }), false);
});

test("optional title lines preserve legacy identity when blank and stale only the affected picture", () => {
  const p = { ...project, title: "Opening", titleSeconds: 5, openingTitleMode: "card", clips: [{ ...clip, title: "Round one" }] };
  const previous = workflow.sequenceRecipe(p);
  const blank = { ...p, titleHeading: "", clips: [{ ...p.clips[0], titleHeading: "", titleSubtitle: "" }] };
  assert.deepEqual(workflow.sequenceRecipe(blank), previous);
  assert.equal(workflow.isClipReady(blank.clips[0], blank), true);
  const openingEdit = { ...p, titleHeading: "Championship" };
  assert.equal(workflow.sequenceStatus({ sequence: previous }, openingEdit), "outdated");
  assert.equal(workflow.isClipReady(openingEdit.clips[0], openingEdit), true);
  const hidden = { ...p, title: "   ", titleHeading: "Invisible event", clips: [{ ...p.clips[0], title: "   ", titleHeading: "Invisible round", titleSubtitle: "Invisible subtitle" }] };
  assert.equal(graphics.graphicsRecipe(hidden), null, "optional lines never make a whitespace-only main title visible");
  assert.equal(graphics.titleStyleKey(hidden, hidden.clips[0]), "");
  assert.equal(graphics.chapterPlan(hidden)[0].start, 0, "hidden opening adds no chapter time");
  for (const field of ["titleHeading", "titleSubtitle"]) {
    const changed = workflow.editClip(p.clips[0], { [field]: "Final round" });
    assert.equal(changed.reviewed, false);
    assert.equal(changed.revision, 8);
    assert.equal(changed.rendered, clip.rendered, "keep previous artifact available, never delete it");
    assert.equal(workflow.isClipReady(changed, p), false);
    const externalEdit = { ...p, clips: [{ ...p.clips[0], [field]: "Final round" }] };
    assert.equal(workflow.isClipReady(externalEdit.clips[0], externalEdit), false, "saved-file edits cannot bypass content identity");
    assert.equal(workflow.sequenceStatus({ sequence: previous }, externalEdit), "outdated");
    assert.equal(workflow.sequenceStatus({ sequence: workflow.sequenceRecipe(externalEdit) }, externalEdit), "current");
  }
});

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
