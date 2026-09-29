import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";
const bundle = await build({ entryPoints: ["src/utils/studioReviewFrames.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { ReviewFrameQueue, reviewOptions } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const clips = ["a", "b", "c"].map(id => ({ id, path: `${id}.mp4`, duration: 8 }));
const reply = request => ({ at: request.index * 2 + 1, data: request.path, sourceKey: request.path, cached: true, deferred: false });
function queue(mode = "all", read = async r => reply(r)) {
  let latest, calls = [];
  const q = new ReviewFrameQueue(clips, mode, 4, async r => { calls.push(r); return read(r); }, value => { latest = value; });
  return { q, calls, get latest() { return latest; } };
}
test("defaults and malformed persisted settings stay bounded", () => {
  assert.deepEqual(reviewOptions({}), { mode: "all", count: 8 });
  assert.deepEqual(reviewOptions({ studio_review_frames_mode: "unexpected", studio_review_frames_count: 999 }), { mode: "all", count: 8 });
});
test("selected clip first, then all other clips; only selected images in memory", async () => {
  const state = queue(); state.q.select("b");
  for (let i = 0; i < 15; i++) await state.q.step(false);
  assert.deepEqual(state.calls.map(c => c.path), [...Array(4).fill("b.mp4"), ...Array(4).fill("a.mp4"), ...Array(4).fill("c.mp4")]);
  assert.equal(state.latest.prepared, 3); assert.equal(state.latest.frames.length, 4);
  assert.ok(state.latest.frames.every(f => f.data === "b.mp4"));
  state.q.select("a"); await state.q.step(false);
  assert.deepEqual(state.latest.frames.map(f => f.data), ["a.mp4"]);
});
test("selected-only never processes another clip", async () => {
  const state = queue("selected"); state.q.select("a");
  for (let i = 0; i < 12; i++) await state.q.step(false);
  assert.equal(state.calls.length, 4);
});
test("manual reads cache only until requested; render blocks force refresh without memory growth", async () => {
  const state = queue("manual", async r => r.cacheOnly ? { ...reply(r), data: null } : reply(r)); state.q.select("a");
  for (let i = 0; i < 4; i++) await state.q.step(false);
  assert.ok(state.calls.every(c => c.cacheOnly)); assert.equal(state.latest.frames.length, 0);
  state.q.select("a", true);
  for (let i = 0; i < 100; i++) await state.q.step(true);
  assert.equal(state.calls.length, 4); assert.equal(state.latest.frames.length, 0);
  await state.q.step(false); assert.equal(state.calls.at(-1).refresh, true); assert.equal(state.latest.frames.length, 1);
});
test("rendering permits cached selected frames but no repeated miss IO or background work", async () => {
  const state = queue("all", async r => ({ ...reply(r), data: r.index ? null : "cached" })); state.q.select("a");
  for (let i = 0; i < 100; i++) await state.q.step(true);
  assert.equal(state.calls.length, 2); assert.ok(state.calls.every(c => c.cacheOnly)); assert.equal(state.latest.frames.length, 1);
});
test("selection and project changes discard stale IPC; only one call is in flight", async () => {
  let finish; const state = queue("all", r => new Promise(resolve => { finish = () => resolve(reply(r)); }));
  state.q.select("a"); const pending = state.q.step(false); await state.q.step(false);
  assert.equal(state.calls.length, 1); state.q.select("b"); finish(); await pending;
  assert.equal(state.latest.frames.length, 0);
  const last = state.q.step(false); state.q.stop(); finish(); await last; assert.equal(state.latest.frames.length, 0);
});
test("background failure preserves selected frames; refresh retries failed clips", async () => {
  let counter = 0;
  const state = queue("all", async r => ({ ...reply(r), sourceKey: r.path === "b.mp4" ? String(counter++) : r.path })); state.q.select("a");
  for (let i = 0; i < 6; i++) await state.q.step(false);
  assert.equal(state.latest.failed, 1); assert.equal(state.latest.frames.length, 4);
  state.q.select("b", true); assert.equal(state.latest.failed, 0); await state.q.step(false);
  assert.equal(state.latest.frames.length, 1); assert.equal(state.calls.at(-1).refresh, true);
});
test("reopening queue retrieves frames without serializing image data into project", async () => {
  const before = JSON.stringify(clips); const one = queue(); one.q.select("a"); await one.q.step(false); one.q.stop();
  const reopened = queue(); reopened.q.select("a"); await reopened.q.step(false);
  assert.equal(reopened.latest.frames.length, 1); assert.equal(reopened.calls[0].refresh, false);
  assert.equal(JSON.stringify(clips), before);
});
