import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
const bundle = async path => { const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" }); return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`); };
const { SnapshotSessionWriter } = await bundle("src/utils/snapshotSessionWriter.ts");
const { mergeSnapshotSession, parseSnapshotSession } = await bundle("src/utils/videoSnapshots.ts");
const entry = { id: "entry-1", revision: 1, name: "Test", json: "{}" };
const blank = { kind: "photogogo-video-snapshots", version: 1, sources: [], selections: [] };
const workspace = { personName: "Draft", destination: "D:/Photos", selectedSourcePath: "D:/missing.mov" };
const recipe = { brightness: 0, contrast: 0, sharpness: 0, crop: null };
test("unresolved photos and pending imports survive partial hydration without media payloads", () => {
  const base = { ...blank, sources: [{ path: "D:/missing.mov", identity: "original", shootingStart: "", timeConfirmed: false, position: 10 }], selections: [{ sourcePath: "D:/missing.mov", identity: "original", index: 10, personName: "Jane", recipe }] };
  const result = mergeSnapshotSession(base, [], [], ["D:/new.mov"], workspace);
  assert.deepEqual(result.sources, base.sources); assert.deepEqual(result.selections, base.selections);
  assert.deepEqual(result.pendingPaths, ["D:/new.mov"]); assert.deepEqual(result.workspace, workspace);
});
test("unconfirmed shooting-time drafts roundtrip, but confirmed invalid time fails", () => {
  const base = { ...blank, sources: [{ path: "D:/draft.mov", identity: "id", shootingStart: "2026-10-", timeConfirmed: false, position: 0 }] };
  assert.equal(parseSnapshotSession(JSON.stringify(base)).sources[0].shootingStart, "2026-10-");
  base.sources[0].timeConfirmed = true; assert.throws(() => parseSnapshotSession(JSON.stringify(base)));
});
test("workspace and pending source fields reject invalid paths, duplicate references and excessive photos", () => {
  assert.throws(() => parseSnapshotSession(JSON.stringify({ ...blank, workspace: { ...workspace, destination: "https://remote" } })));
  assert.throws(() => parseSnapshotSession(JSON.stringify({ ...blank, pendingPaths: ["D:/same.mov", "d:/same.mov"] })));
  assert.throws(() => parseSnapshotSession(JSON.stringify({ ...blank, pendingPaths: ["relative.mov"] })));
});
test("serial saves never acknowledge a newer edit using an older response", async () => {
  let text = "one", release, puts = [], statuses = [];
  const writer = new SnapshotSessionWriter(() => text, async (current, json) => { puts.push([current.revision, json]); if (puts.length === 1) await new Promise(resolve => release = resolve); return { ...current, revision: current.revision + 1, json }; }, state => statuses.push(state));
  writer.attach(entry); writer.mark(); const saving = writer.flush(); await delay(1);
  text = "two"; writer.mark(); assert.equal(writer.dirty, true); release(); await saving;
  assert.deepEqual(puts, [[1, "one"], [2, "two"]]); assert.equal(writer.current.revision, 3); assert.equal(writer.dirty, false); assert.equal(statuses.at(-1), "saved"); writer.dispose();
});
test("save failure remains dirty, blocks attach and only explicit retry clears failure", async () => {
  let failed = true, calls = 0, state;
  const writer = new SnapshotSessionWriter(() => "draft", async current => { calls++; if (failed) throw new Error("Disk full"); return { ...current, revision: 2 }; }, next => state = next, 5, 20);
  writer.attach(entry); writer.mark(); await assert.rejects(writer.flush(), /Disk full/); writer.mark(); await delay(35);
  assert.equal(calls, 1); assert.equal(writer.dirty, true); assert.equal(state, "failed"); assert.throws(() => writer.attach(null));
  failed = false; await writer.flush(); assert.equal(writer.dirty, false); assert.equal(state, "saved"); writer.dispose();
});
test("continuous position changes reach a bounded save deadline", async () => {
  let saves = 0;
  const writer = new SnapshotSessionWriter(() => "position", async current => { saves++; return { ...current, revision: current.revision + 1 }; }, () => {}, 40, 70);
  writer.attach(entry);
  const interval = setInterval(() => writer.mark(), 10); await delay(125); clearInterval(interval);
  assert.ok(saves >= 1, "continuous edits cannot starve autosave"); await writer.flush(); writer.dispose();
});
test("recovery copy settles an outstanding failed write before adopting saved state", async () => {
  let reject;
  const writer = new SnapshotSessionWriter(() => "draft", () => new Promise((_, fail) => reject = fail), () => {});
  writer.attach(entry); writer.mark(); const save = writer.flush().catch(() => undefined); const settled = writer.settle(); reject(new Error("Revision conflict")); await settled; await save;
  writer.adoptSavedCopy({ ...entry, id: "copy-2", revision: 1 }); assert.equal(writer.current.id, "copy-2"); assert.equal(writer.dirty, false); writer.dispose();
});
