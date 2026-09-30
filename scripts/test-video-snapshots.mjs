import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

const bundled = await build({ entryPoints: ["src/utils/videoSnapshots.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const recipe = { brightness: 0, contrast: 0, sharpness: 0, crop: null };
const clip = { id: "transient-id", identity: "fingerprint", path: "D:/original/camera.mov", name: "camera.mov", width: 3840, height: 2160, frameTimesMs: [0, 20, 40, 80, 100], suggestedStart: null, timeSource: "unknown", warnings: [] };
const source = { clip, shootingStart: "2026-12-31T23:59:59.980+11:00", timeConfirmed: true, position: 2 };
const selection = { id: "photo1", clipId: clip.id, index: 3, thumbnail: "data:image/jpeg;base64,PRIVATEPIXELS", personName: "Jane Smith", recipe, exported: null };
const session = () => api.createSnapshotSession([source], [selection]);

test("actual variable frame timestamps drive time navigation", () => {
  assert.equal(api.frameAtTime(clip.frameTimesMs, 79), 2);
  assert.equal(api.frameAtTime(clip.frameTimesMs, 80), 3);
  assert.equal(api.frameAtTime(clip.frameTimesMs, 999), 4);
  assert.equal(api.frameAtTime(clip.frameTimesMs, -10), 0);
  assert.equal(api.snapshotTime(3_661_020), "01:01:01.020");
});
test("shooting time requires a real calendar date and explicit zone", () => {
  for (const value of ["2026-09-30T12:00:00+10:00", "2024-02-29T00:00:00Z", "2026-09-30T12:00:00.123456789+10:00"]) assert.equal(api.validShootingStart(value), true);
  for (const value of ["2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-30T12:00:00", "2026-09-30T24:00:00Z", "2026-09-30T12:00:00+24:00", "not-a-date"]) assert.equal(api.validShootingStart(value), false, value);
  assert.equal(api.snapshotCapturedAt(source.shootingStart, 80), "2026-12-31T13:00:00.060Z");
});
test("Windows canonical paths deduplicate the same source", () => {
  assert.equal(api.snapshotPathKey("D:/original/Camera.mov"), api.snapshotPathKey("\\\\?\\D:\\original\\camera.mov"));
  assert.notEqual(api.snapshotPathKey("D:/original/Camera.mov"), api.snapshotPathKey("E:/original/Camera.mov"));
});
test("export receipts belong to their destination, not whichever folder is selected now", () => {
  const photo = { ...selection, exported: { path: "D:/Photos/2026/09/20/frame.jpg" }, exportedDestination: "D:/Photos" };
  for (const folder of ["D:/Photos", "d:/photos/", "\\\\?\\D:\\Photos\\"]) assert.equal(api.snapshotExportMatchesDestination(photo, folder), true);
  for (const folder of ["", "D:/Photos-other", "E:/Photos"]) assert.equal(api.snapshotExportMatchesDestination(photo, folder), false);
  assert.equal(api.snapshotExportMatchesDestination({ ...photo, exported: null }, "D:/Photos"), false);
  assert.equal(api.snapshotExportMatchesDestination({ ...photo, exportedDestination: undefined }, "D:/Photos"), false);
  const encoded = JSON.stringify(api.createSnapshotSession([source], [photo]));
  assert.equal(encoded.includes("exportedDestination"), false);
  assert.equal(encoded.includes("frame.jpg"), false);
});
test("session roundtrip retains choices but never media or native IDs", () => {
  const encoded = JSON.stringify(session());
  assert.equal(encoded.includes("PRIVATEPIXELS"), false);
  assert.equal(encoded.includes("transient-id"), false);
  assert.equal(encoded.includes("frameTimesMs"), false);
  assert.deepEqual(api.parseSnapshotSession(encoded), session());
  assert.equal(session().selections[0].index, 3);
});
test("untrusted sessions reject foreign versions, sources, counts and invalid times", () => {
  for (const mutate of [
    s => s.version = 2,
    s => s.kind = "different-project",
    s => s.sources[0].path = "https://example.com/private.mov",
    s => s.sources[0].path = "relative.mov",
    s => s.sources[0].shootingStart = "",
    s => s.sources.push(structuredClone(s.sources[0])),
    s => s.sources = Array.from({ length: 65 }, () => s.sources[0]),
    s => s.selections[0].identity = "wrong-source",
    s => s.selections[0].index = -1,
    s => s.selections[0].index = 1.5,
    s => s.selections.push(structuredClone(s.selections[0])),
    s => s.selections[0].personName = "bad\u0000name",
  ]) { const s = session(); mutate(s); assert.throws(() => api.parseSnapshotSession(JSON.stringify(s))); }
  assert.throws(() => api.parseSnapshotSession(" ".repeat(2 * 1024 * 1024 + 1)));
});
test("recipes reject unsafe numeric values and crops outside frame", () => {
  for (const patch of [{ brightness: NaN }, { brightness: .51 }, { contrast: 51 }, { sharpness: -1 }, { sharpness: Infinity }, { crop: { x: .8, y: 0, width: .4, height: 1 } }, { crop: { x: 0, y: 0, width: 0, height: 1 } }]) assert.throws(() => api.validateSnapshotRecipe({ ...recipe, ...patch }));
  assert.deepEqual(api.validateSnapshotRecipe({ ...recipe, crop: { x: .1, y: .1, width: .8, height: .8 } }).crop, { x: .1, y: .1, width: .8, height: .8 });
});
test("frame indexes reject malformed native responses", () => {
  for (const patch of [{ frameTimesMs: [] }, { frameTimesMs: [0, 50, 40] }, { frameTimesMs: [0, Infinity] }, { width: 0 }, { identity: "" }]) assert.throws(() => api.validateSnapshotClip({ ...clip, ...patch }));
  assert.equal(api.validateSnapshotClip(clip), clip);
});
test("adjacent-frame cache evicts least-recently-used data and respects reduced budget", () => {
  const cache = new api.SnapshotFrameCache(170);
  const frame = index => ({ index, atMs: index * 20, data: "abcdefghij" });
  cache.put("a", frame(1)); cache.put("a", frame(2)); cache.get("a", 1); cache.put("a", frame(3));
  assert.equal(cache.get("a", 2), undefined);
  assert.equal(cache.get("a", 1).index, 1);
  assert.equal(cache.get("b", 1), undefined);
  cache.setBudget(84); assert.equal(cache.get("a", 3), undefined);
  cache.clear(); assert.equal(cache.get("a", 1), undefined);
});
