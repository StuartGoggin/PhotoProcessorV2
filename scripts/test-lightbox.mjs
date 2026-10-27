import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
const bundle = async path => {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
};
const { lightboxCatalogue, neighborPaths, photoFolder, lightboxAbsolute, photoForSource } = await bundle("src/utils/lightboxCatalogue.ts");
const { LightboxCache } = await bundle("src/utils/lightboxCache.ts");
const { FULL_CROP, fitCropRatio, dragCrop, validCrop, cropPixelSize } = await bundle("src/utils/lightboxCrop.ts");
const { normalizePhotoProcessRecipe } = await bundle("src/utils/photoProcessRecipe.ts");
const { normalizeRawRecipe, rawPreset } = await bundle("src/utils/rawRecipe.ts");
const file = (name, folder = "") => ({ name, path: folder ? `${folder}/${name}` : name, type: "file", size: 10 });
const payload = { data: Buffer.from("compressed image bytes").toString("base64"), mime: "image/jpeg", width: 640, height: 480 };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("one originals catalogue hides matched variants, keeps orphan/suffix originals, and supports root + nested navigation", () => {
  const nodes = [file("one.JPEG"), file("one_BW.JPG"), file("one_improved.jpg"), file("orphan_BW.jpg"), file("BW_training.jpg"), file("notes.txt"),
    { name: "day", path: "day", type: "dir", children: [file("two.png", "day"), file("two_improved.jpg", "day")] }];
  const result = lightboxCatalogue(nodes);
  assert.deepEqual(result.folders.get("").map(item => item.node.name), ["one.JPEG", "orphan_BW.jpg", "BW_training.jpg"]);
  assert.equal(result.photos.get("one.JPEG").bw.name, "one_BW.JPG");
  assert.equal(result.photos.get("day/two.png").improved.name, "two_improved.jpg");
  assert.equal(result.tree.at(-1).children.length, 1);
  assert.equal(photoFolder("day/two.png"), "day");
  assert.equal(lightboxAbsolute("D:\\stage\\", "day\\two.png"), "D:\\stage/day/two.png");
});

test("review tags before/after generated suffix associate; ambiguous fallback never guesses", () => {
  const result = lightboxCatalogue([file("one{Like oo}{trash}.jpg"), file("one_BW.jpg"), file("one_improved{Like o}.jpg"),
    file("two{Like o}.jpg"), file("two{Like oo}.jpg"), file("two_BW.jpg"), file("three{Out of Focus 15}.jpeg"), file("three_improved.jpg")]);
  assert.equal(result.photos.get("one{Like oo}{trash}.jpg").bw.name, "one_BW.jpg");
  assert.equal(result.photos.get("one{Like oo}{trash}.jpg").improved.name, "one_improved{Like o}.jpg");
  assert.equal(result.photos.has("two_BW.jpg"), true, "ambiguous variant remains visible instead of being assigned arbitrarily");
  assert.equal(result.photos.get("three{Out of Focus 15}.jpeg").improved.name, "three_improved.jpg");
});

test("read-ahead is folder-local, directional and bounded to two forward / one backward originals", () => {
  const result = lightboxCatalogue(Array.from({ length: 7 }, (_, i) => file(`${i}.jpg`)));
  assert.deepEqual(neighborPaths(result.folders.get(""), 3, 1), ["4.jpg", "2.jpg", "5.jpg"]);
  assert.deepEqual(neighborPaths(result.folders.get(""), 3, -1), ["2.jpg", "4.jpg", "1.jpg"]);
});

test("RAW + JPEG pairs associate processed versions with their JPEG original", () => {
  const result = lightboxCatalogue([file("shot.CR3"),file("shot.JPG"),file("shot_improved.jpg"),file("shot_BW.jpg")]);
  assert.equal(result.folders.get("").length,2);
  assert.equal(result.photos.get("shot.JPG").bw.name,"shot_BW.jpg");
  assert.equal(result.photos.get("shot.JPG").improved.name,"shot_improved.jpg");
  assert.equal(result.photos.get("shot.CR3").bw,undefined);
});

test("RAW comparisons require explicit unique ownership; retired, ambiguous and invalid claims fail safely", () => {
  const nodes = [file("capture.CR3"), { ...file("finished.jpg"), rawSource: "capture.CR3", rawKind: "developed" },
    { ...file("mono.jpg"), rawSource: "capture.CR3", rawKind: "bw" }, { ...file("old.jpg"), rawSource: "capture.CR3", rawKind: "retired" }, file("capture_BW.jpg"),
    { ...file("missing.jpg"), rawSource: "absent.CR3", rawKind: "developed" }];
  const result = lightboxCatalogue(nodes);
  assert.equal(result.photos.get("capture.CR3").improved.name, "finished.jpg");
  assert.equal(result.photos.get("capture.CR3").improvedLabel, "Developed RAW");
  assert.equal(result.photos.get("capture.CR3").bw.name, "mono.jpg");
  assert.equal(result.photos.has("old.jpg"), false);
  assert.equal(result.photos.has("capture_BW.jpg"), true, "RAW suffix guessing cannot hide a user file");
  assert.equal(result.photos.has("missing.jpg"), true, "an unresolvable ownership claim is visible");
  const duplicate = lightboxCatalogue([file("capture.CR3"), { ...file("first.jpg"), rawSource: "capture.CR3", rawKind: "developed" }, { ...file("second.jpg"), rawSource: "capture.CR3", rawKind: "developed" }]);
  assert.equal(duplicate.folders.get("").length, 3);
  assert.equal(duplicate.photos.get("capture.CR3").improved, undefined);
  const nested = lightboxCatalogue([file("capture.CR3"), { name: "day", path: "day", type: "dir", children: [{ ...file("other.jpg", "day"), rawSource: "capture.CR3", rawKind: "retired" }] }]);
  assert.equal(nested.photos.has("day/other.jpg"), true, "cross-folder ownership never hides a file");
});

test("native-identified RAW+JPEG captures group navigation while keeping source families and exact paths distinct", () => {
  const result = lightboxCatalogue([{ ...file("shot.CR3"), cameraJpeg: "shot.JPG" }, file("shot.JPG"), file("shot_BW.jpg"), file("shot_improved.jpg"),
    { ...file("developed.jpg"), rawSource: "shot.CR3", rawKind: "developed" }, { ...file("raw-mono.jpg"), rawSource: "shot.CR3", rawKind: "bw" }, file("shot_crop.jpg")]);
  assert.equal(result.folders.get("").length, 1);
  const capture = result.photos.get("shot.CR3");
  assert.equal(capture.original.path, "shot.CR3"); assert.equal(capture.improved.path, "developed.jpg"); assert.equal(capture.bw.path, "raw-mono.jpg");
  assert.equal(result.photos.has("shot.JPG"), false);
  const jpeg = photoForSource(capture, "cameraJpeg");
  assert.equal(jpeg.node.path, "shot.CR3", "the navigation identity remains the capture");
  assert.equal(jpeg.original.path, "shot.JPG", "curation targets the displayed exact original");
  assert.equal(jpeg.improved.path, "shot_improved.jpg"); assert.equal(jpeg.bw.path, "shot_BW.jpg"); assert.equal(jpeg.crop.original.path, "shot_crop.jpg");
  assert.equal(photoForSource(capture, "raw").original.path, "shot.CR3");
  const ambiguous = lightboxCatalogue([{ ...file("shot.CR3"), cameraJpeg: "shot.JPG" }, { ...file("other.DNG"), cameraJpeg: "shot.JPG" }, file("shot.JPG")]);
  assert.equal(ambiguous.folders.get("").length, 3);
  assert.equal(ambiguous.photos.get("shot.CR3").cameraJpeg, undefined);
});

test("metadata-proven differently named camera companions group; absent proof and competing claims stay separate", () => {
  const paired = lightboxCatalogue([{ ...file("sensor-number.CR3"), cameraJpeg: "renamed-camera.JPG" }, file("renamed-camera.JPG"), file("renamed-camera_BW.jpg")]);
  assert.equal(paired.folders.get("").length, 1);
  assert.equal(photoForSource(paired.photos.get("sensor-number.CR3"), "cameraJpeg").original.path, "renamed-camera.JPG");
  assert.equal(photoForSource(paired.photos.get("sensor-number.CR3"), "cameraJpeg").bw.path, "renamed-camera_BW.jpg");
  const unproven = lightboxCatalogue([file("same.CR3"), file("same.JPG"), file("different.CR3"), file("renamed.JPG")]);
  assert.equal(unproven.folders.get("").length, 4, "a matching basename never manufactures capture proof");
  const crossFolder = lightboxCatalogue([{ ...file("sensor.CR3"), cameraJpeg: "day/renamed.JPG" }, { type: "dir", name: "day", path: "day", children: [file("renamed.JPG", "day")] }]);
  assert.equal(crossFolder.photos.has("day/renamed.JPG"), true);
  assert.equal(crossFolder.photos.get("sensor.CR3").cameraJpeg, undefined);
});

test("regenerating a rated original prefers its exact current-stem comparison", () => {
  const result = lightboxCatalogue([file("one{Like o}.jpg"),file("one_BW.jpg"),file("one{Like o}_BW.jpg"),file("one_improved.jpg"),file("one{Like o}_improved.jpg")]);
  assert.equal(result.folders.get("").length,1);
  assert.equal(result.photos.get("one{Like o}.jpg").bw?.name,"one{Like o}_BW.jpg");
  assert.equal(result.photos.get("one{Like o}.jpg").improved?.name,"one{Like o}_improved.jpg");
});

test("untagged RAW cannot preempt a uniquely rated JPEG's untagged processed versions", () => {
  const result = lightboxCatalogue([file("shot.CR3"), file("shot{Like oo}.JPG"), file("shot_BW.jpg"), file("shot_improved.jpg")]);
  assert.equal(result.folders.get("").length, 2);
  assert.equal(result.photos.get("shot{Like oo}.JPG").bw.name, "shot_BW.jpg");
  assert.equal(result.photos.get("shot{Like oo}.JPG").improved.name, "shot_improved.jpg");
  assert.equal(result.photos.get("shot.CR3").bw, undefined);
  assert.equal(result.photos.get("shot.CR3").improved, undefined);
  const ambiguous = lightboxCatalogue([file("shot.CR3"), file("shot{Like o}.JPG"), file("shot{Like oo}.JPG"), file("shot_BW.jpg")]);
  assert.equal(ambiguous.photos.has("shot_BW.jpg"), true);
  assert.equal(ambiguous.photos.get("shot.CR3").bw, undefined);
});

test("crop versions attach to one original with their own independent comparisons, including rating changes", () => {
  const result = lightboxCatalogue([file("shot{Like o}.JPEG"), file("shot_BW.jpg"), file("shot_improved.jpg"), file("shot_crop.jpg"), file("shot_crop_BW.jpg"), file("shot_crop_improved.jpg"), file("shot_crop.photogogo-crop.json")]);
  assert.equal(result.folders.get("").length, 1);
  const original = result.photos.get("shot{Like o}.JPEG");
  assert.equal(original.bw.name, "shot_BW.jpg");
  assert.equal(original.crop.original.name, "shot_crop.jpg");
  assert.equal(original.crop.bw.name, "shot_crop_BW.jpg");
  assert.equal(original.crop.improved.name, "shot_crop_improved.jpg");
});

test("orphan, ambiguous, cross-folder and crop-chain filenames are never hidden by guessed ownership", () => {
  const result = lightboxCatalogue([file("one.jpg"), file("one.jpeg"), file("one_crop.jpg"), file("orphan_crop.jpg"), file("shot.jpg"), file("shot_crop.jpg"), file("shot_crop_crop.jpg"), { name: "day", path: "day", type: "dir", children: [file("one_crop.jpg", "day")] }]);
  assert.equal(result.photos.has("one_crop.jpg"), true);
  assert.equal(result.photos.has("orphan_crop.jpg"), true);
  assert.equal(result.photos.has("shot_crop_crop.jpg"), true);
  assert.equal(result.photos.has("day/one_crop.jpg"), true);
  assert.equal(result.photos.get("shot.jpg").crop.original.name, "shot_crop.jpg");
});

test("all crop handles stay in bounds and fixed ratios use upright source-pixel aspect", () => {
  const ratio = fitCropRatio(FULL_CROP, 16 / 9, 4000, 6000);
  assert.ok(Math.abs(ratio.width * 4000 / (ratio.height * 6000) - 16 / 9) < 1e-10);
  for (const handle of ["move", "nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    for (const locked of [null, 3 / 2, 2 / 3, 1]) {
      const start = fitCropRatio({ x: .1, y: .1, width: .8, height: .8 }, locked, 640, 480);
      for (const dx of [-100, -.2, 0, .2, 100]) for (const dy of [-100, -.2, 0, .2, 100]) {
        const crop = dragCrop(start, handle, dx, dy, locked, 640, 480);
        assert.ok(validCrop(crop), `${handle}: ${JSON.stringify(crop)}`);
        if (locked) assert.ok(Math.abs(crop.width * 640 / (crop.height * 480) - locked) < 1e-8);
      }
    }
  }
  assert.deepEqual(dragCrop(FULL_CROP, "nw", NaN, 0, null, 640, 480), FULL_CROP);
  assert.deepEqual(cropPixelSize({ x: .123, y: .234, width: .567, height: .456 }, 640, 480), { width: 364, height: 220 });
});

test("persisted processing recipes reject malformed values and clamp supported bounds", () => {
  const recipe = normalizePhotoProcessRecipe({ bwParams: { localContrast: NaN, sharpness: 30, midpoint: -1 }, enhanceContrastLevel: 99, enhanceSharpnessLevel: "oops" });
  assert.equal(recipe.bwParams.localContrast, 1);
  assert.equal(recipe.bwParams.sharpness, 1);
  assert.equal(recipe.bwParams.midpoint, .25);
  assert.equal(recipe.enhanceContrastLevel, 2);
  assert.equal(recipe.enhanceSharpnessLevel, .5);
});

test("RAW recipes preserve manual exposure by default and opt in to automatic levels explicitly", () => {
  for (const preset of ["natural", "neutral", "highIso"]) assert.equal(rawPreset(preset).autoExposure, false);
  assert.equal(normalizeRawRecipe({ exposure: .5 }).autoExposure, false, "older recipes safely default off");
  assert.equal(normalizeRawRecipe({ autoExposure: "true" }).autoExposure, false, "invalid booleans do not opt in");
  const automatic = normalizeRawRecipe({ autoExposure: true, exposure: -.25 });
  assert.equal(automatic.autoExposure, true); assert.equal(automatic.exposure, -.25);
});

test("foreground reads coalesce; cached full-resolution data avoids repeated read", async () => {
  let reads = 0;
  const cache = new LightboxCache(async () => { reads++; return payload; });
  cache.select(["one"]);
  const [first, second] = await Promise.all([cache.get("one"), cache.get("one")]);
  assert.equal(first, second); assert.match(first, /^blob:/); assert.equal(reads, 1);
  assert.equal(await cache.get("one"), first); assert.equal(reads, 1);
  cache.clear(); assert.equal(cache.stats().bytes, 0);
});

test("camera-preview display and embedded-image dimensions survive cache hits without replacing RAW file identity", async () => {
  const cache = new LightboxCache(async () => ({ ...payload, source: "cameraPreview", sourceWidth: 6000, sourceHeight: 4000 }));
  cache.select(["capture.CR3"]); await cache.get("capture.CR3");
  assert.deepEqual(cache.info("capture.CR3"), { width: 640, height: 480, source: "cameraPreview", sourceWidth: 6000, sourceHeight: 4000 });
  cache.clear(); assert.equal(cache.info("capture.CR3"), null);
});

test("refresh generation discards late reads and safely rereads identical paths", async () => {
  const pending = [];
  const cache = new LightboxCache(() => new Promise(resolve => pending.push(resolve)));
  cache.select(["one"]); const stale = cache.get("one"); cache.clear();
  cache.select(["one"]); const fresh = cache.get("one");
  pending[1](payload); const url = await fresh;
  pending[0](payload); assert.equal(await stale, null); await tick();
  assert.equal(await cache.get("one"), url); assert.equal(cache.stats().entries, 1); cache.clear();
});

test("one speculative read yields a slot to foreground; queued abandoned foreground cannot block a new selection", async () => {
  const calls = [], pending = new Map();
  const cache = new LightboxCache(path => { calls.push(path); return new Promise(resolve => pending.set(path, resolve)); });
  cache.select(["a", "b", "c"]); const old = [cache.get("a"), cache.get("b"), cache.get("c")];
  cache.select(["z"]); const current = cache.get("z");
  assert.equal(await old[2], null); pending.get("a")(payload); await tick();
  assert.deepEqual(calls, ["a", "b", "z"]); pending.get("z")(payload); await current;
  pending.get("b")(payload); await Promise.all(old); await tick();
  cache.prefetch(["next", "next2"]); assert.equal(cache.stats().running, 1);
  cache.select(["jump"]); const jump = cache.get("jump");
  assert.equal(calls.at(-1), "jump"); assert.equal(calls.includes("next2"), false);
  pending.get("jump")(payload); await jump; pending.get("next")(payload); await tick(); cache.clear();
});

test("compressed cache remains within budget, except active panels which are evicted after selection changes", async () => {
  const cache = new LightboxCache(async () => payload, 30);
  cache.select(["one"]); await cache.get("one");
  cache.prefetch(["two", "three", "four"]); for (let i = 0; i < 8; i++) await tick();
  assert.ok(cache.stats().bytes <= 30); assert.ok(cache.stats().entries <= 1);
  cache.clear();
  const oversized = new LightboxCache(async () => payload, 1);
  oversized.select(["one"]); assert.ok(await oversized.get("one"));
  oversized.select([]); assert.equal(oversized.stats().entries, 0); oversized.clear();
});

test("decoded read-ahead counts RGBA dimensions and releases warm image references on eviction", async () => {
  const saved = globalThis.Image;
  globalThis.Image = class { src = ""; decode() { return Promise.resolve(); } };
  try {
    const cost = payload.width * payload.height * 4;
    const cache = new LightboxCache(async () => payload, 1000, cost);
    cache.prefetch(["one", "two", "three"]); for (let i = 0; i < 8; i++) await tick();
    assert.equal(cache.stats().decodedBytes, cost, "only one speculative decoded image fits");
    cache.clear(); assert.equal(cache.stats().decodedBytes, 0);
  } finally { globalThis.Image = saved; }
});
