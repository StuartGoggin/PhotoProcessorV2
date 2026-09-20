import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const bundled = await build({ entryPoints: ["src/utils/studioWorkflow.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { resetProjectRenders, applyCompletedRenders, approveAndNext, moveClip, editClip, isClipReady, normalizeProject, clipJob, clipStatus } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const clip = { id: "clip-1", path: "D:/clips/a.mp4", duration: 10, include: true, reviewed: true, revision: 0, title: "Original title", titleSeconds: 2, stabilization: "off", framing: "edgeSafe", notes: "", chapter: "First clip", replays: [] };
const project = normalizeProject({ version: 1, name: "Test", title: "", titleSeconds: 0, clips: [clip], width: 1920, height: 1080, fps: 50 });
const rendered = { path: "D:/out/clip.mp4", width: 1920, height: 1080, fps: 50, bitrateMbps: 10, revision: 0, signature: "verified-signature", renderedAt: "2026-09-17T01:00:00Z", duration: 10 };
const job = { id: "1", status: "completed", artifacts: [{ clipId: clip.id, sourcePath: clip.path, rendered }] };
test("clear preserves edits and media but rejects stale completed jobs", () => {
  const old = { ...applyCompletedRenders(project, [job]), music: { ...project.music, requestId: "old", audioPath: "keep.wav" } };
  const cleared = resetProjectRenders(old);
  assert.equal(cleared.clips[0].rendered, null);
  assert.equal(cleared.clips[0].reviewed, true);
  assert.equal(cleared.clips[0].path, clip.path);
  assert.equal(cleared.music.audioPath, "keep.wav");
  assert.equal(cleared.music.requestId, "");
  assert.equal(applyCompletedRenders(cleared, [job]), cleared);
});

test("clip render matches resolution, frame rate and bitrate", () => {
  assert.equal(isClipReady({ ...clip, rendered }, project), true);
  for (const change of [{ width: 3840, height: 2160 }, { fps: 30 }, { bitrateMbps: 20 }]) {
    assert.equal(isClipReady({ ...clip, rendered }, { ...project, ...change }), false);
  }
});
test("new stabilization controls invalidate existing clip renders", () => {
  for (const change of [{ stabilizationMethod: "fast" }, { customStabilization: { radius: 32, blockSize: 8, contrast: 125 } }]) {
    const edited = editClip({ ...clip, rendered }, change);
    assert.equal(edited.revision, 1);
    assert.equal(edited.reviewed, false);
    assert.equal(isClipReady(edited, project), false);
  }
});
test("a completed old job cannot restore ready status after an edit", () => {
  const first = applyCompletedRenders(project, [job]);
  const edited = { ...first, clips: [editClip(first.clips[0], { title: "New title" })] };
  const polled = applyCompletedRenders(edited, [job]);
  assert.equal(polled.clips[0].revision, 1);
  assert.equal(isClipReady(polled.clips[0], polled), false);
  assert.equal(polled.clips[0].rendered.path, rendered.path, "old output remains playable");
});
test("missing output cannot be marked ready again by polling its old job", () => {
  const missing = { ...project, clips: [{ ...clip, rendered: { ...rendered, available: false } }] };
  assert.equal(isClipReady(missing.clips[0], missing), false);
  assert.equal(applyCompletedRenders(missing, [job]), missing);
});
test("edits while rendering reject the finished snapshot", () => {
  const edited = { ...project, clips: [editClip(clip, { stabilization: "strong" })] };
  assert.equal(applyCompletedRenders(edited, [job]), edited);
});
test("notes, inclusion and sequence labels do not invalidate video", () => {
  const edited = editClip({ ...clip, rendered }, { notes: "check", include: false, chapter: "Renamed" });
  assert.equal(edited.revision, 0); assert.equal(edited.reviewed, true);
  assert.equal(isClipReady(edited, project), true);
});
test("recovered completed artifacts restore a matching project", () => {
  const recovered = applyCompletedRenders(project, [{ ...job, status: "interrupted" }]);
  assert.equal(isClipReady(recovered.clips[0], recovered), true);
  assert.equal(applyCompletedRenders(recovered, [job]), recovered);
});
test("queued jobs target only the matching edit and format", () => {
  const queued = { ...job, kind: "clip", status: "queued", width: 1920, height: 1080, fps: 50, bitrateMbps: 10, targets: [{ clipId: clip.id, sourcePath: clip.path, revision: 0 }] };
  assert.equal(clipJob(clip, project, [queued]), queued);
  assert.equal(clipJob(editClip(clip, { title: "change" }), project, [queued]), undefined);
});
test("clip status distinguishes missing files and interrupted requests", () => {
  const interrupted = { ...job, kind: "project", status: "interrupted", width: 1920, height: 1080, fps: 50, bitrateMbps: 10, targets: [{ clipId: clip.id, sourcePath: clip.path, revision: 0 }] };
  assert.equal(clipStatus(clip, project, [interrupted]), "Interrupted · resume in Jobs");
  assert.equal(clipStatus({ ...clip, rendered }, project, [interrupted]), "Ready to assemble");
  assert.equal(clipStatus({ ...clip, rendered: { ...rendered, available: false } }, project, []), "Output missing · re-render needed");
});
test("legacy project defaults preserve existing clips and audio", () => {
  const migrated = normalizeProject({ ...project, bitrateMbps: undefined, music: { enabled: true, audioPath: "D:/music.wav" }, clips: [{ ...clip, revision: undefined }] });
  assert.equal(migrated.bitrateMbps, 10);
  assert.equal(migrated.clips[0].revision, 0);
  assert.equal(migrated.music.audioPath, "D:/music.wav");
  assert.equal(migrated.music.requestId, "");
});

test("adaptive scheduling survives recovery normalization without invalidating rendered clips", () => {
  assert.equal(project.adaptiveScheduling, true, "legacy projects enable adaptive scheduling");
  const fixed = normalizeProject({ ...project, adaptiveScheduling: false, clips: [{ ...clip, rendered }] });
  assert.equal(fixed.adaptiveScheduling, false, "an explicit off choice is preserved");
  assert.equal(resetProjectRenders(fixed).adaptiveScheduling, false);
  assert.equal(applyCompletedRenders(fixed, [job]).adaptiveScheduling, false);
  assert.equal(isClipReady(fixed.clips[0], { ...fixed, adaptiveScheduling: true }), true, "scheduling does not change output quality or cache identity");
  assert.equal(fixed.music.audioPath, project.music.audioPath);
});

test("legacy opening titles preserve separate cards and explicit modes survive normalization", () => {
  assert.equal(normalizeProject({ ...project, openingTitleMode: undefined }).openingTitleMode, "card");
  for (const mode of ["card", "overlay", "none"]) assert.equal(normalizeProject({ ...project, openingTitleMode: mode }).openingTitleMode, mode);
  assert.equal(normalizeProject({ ...project, openingTitleMode: "invalid" }).openingTitleMode, "invalid", "invalid saved values remain visible to backend validation");
});

test("approve and next skips excluded/approved clips and wraps to earlier pending clips", () => {
  const clips = [
    { ...clip, id: "earlier", reviewed: false }, { ...clip, id: "current", reviewed: false, rendered },
    { ...clip, id: "excluded", reviewed: false, include: false }, { ...clip, id: "approved", reviewed: true },
    { ...clip, id: "later", reviewed: false },
  ];
  const result = approveAndNext({ ...project, clips }, "current");
  assert.equal(result.project.clips[1].reviewed, true);
  assert.equal(result.project.clips[1].revision, clips[1].revision);
  assert.equal(result.project.clips[1].rendered, rendered);
  assert.equal(result.nextClipId, "later");
  const wrapped = approveAndNext(result.project, "later");
  assert.equal(wrapped.nextClipId, "earlier");
  assert.equal(approveAndNext(wrapped.project, "earlier").nextClipId, null);
  assert.equal(approveAndNext(result.project, "excluded").project, result.project);
});

test("reordering and opening title edits preserve clip approval and reusable renders", () => {
  const original = { ...project, clips: [{ ...clip, rendered }, { ...clip, id: "second", rendered }] };
  const reordered = moveClip(original, clip.id, 1);
  assert.equal(reordered.clips[1], original.clips[0]);
  assert.equal(moveClip(original, clip.id, -1), original);
  assert.equal(moveClip(original, "missing", 1), original);
  for (const mode of ["card", "overlay", "none"]) {
    const updated = { ...reordered, openingTitleMode: mode, title: "New opening", titleSeconds: 6, subtitle: "New date" };
    assert.equal(updated.clips[1].reviewed, true);
    assert.equal(isClipReady(updated.clips[1], updated), true);
    assert.equal(applyCompletedRenders(updated, [job]), updated);
  }
});

test("title overlay and none add no time while legacy cards retain their duration", async () => {
  const types = await build({ entryPoints: ["src/types/videoStudio.ts"], bundle: true, write: false, format: "esm", platform: "node" });
  const { projectDuration } = await import(`data:text/javascript;base64,${Buffer.from(types.outputFiles[0].text).toString("base64")}`);
  for (const mode of ["card", undefined, "overlay", "none"]) {
    const duration = projectDuration({ ...project, title: "Opening", titleSeconds: 5, openingTitleMode: mode });
    assert.equal(duration, mode === "card" || mode === undefined ? 15 : 10);
  }
});

test("approval controls expose text, icon and pressed state rather than colour alone", async () => {
  const view = await build({ entryPoints: ["src/components/StudioApprovalButton.tsx"], bundle: true, write: false, format: "esm", platform: "node" });
  const { default: ApprovalButton } = await import(`data:text/javascript;base64,${Buffer.from(view.outputFiles[0].text).toString("base64")}`);
  for (const approved of [false, true]) {
    const html = renderToStaticMarkup(createElement(ApprovalButton, { approved, name: "Jump <one>", onChange() {} }));
    assert.match(html, new RegExp(`aria-pressed="${approved}"`));
    assert.match(html, new RegExp(approved ? "is-approved" : "needs-review"));
    assert.match(html, new RegExp(approved ? "Approved" : "Needs review"));
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /Jump &lt;one&gt;/, "untrusted segment labels are escaped");
    assert.doesNotMatch(html, /type="checkbox"/);
  }
});
