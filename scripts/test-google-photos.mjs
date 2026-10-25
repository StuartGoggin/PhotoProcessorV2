import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/utils/googlePhotos.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { googlePhotoAssetForPath, googlePhotoCounts, googlePhotoSize, GOOGLE_PHOTO_VARIANTS } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
test("visible version lookup normalizes Windows slashes and case but never guesses ambiguous assets", () => {
  const assets = [{ id: "original", relativePath: "day/rider.jpg" }, { id: "crop", relativePath: "day/rider_crop.jpg" }, { id: "enhanced", relativePath: "day/rider_improved.jpg" }];
  assert.equal(googlePhotoAssetForPath(assets, "DAY\\RIDER.JPG")?.id, "original");
  assert.equal(googlePhotoAssetForPath(assets, "day/rider_crop.jpg")?.id, "crop");
  assert.equal(googlePhotoAssetForPath(assets, "day/rider_BW.jpg"), undefined);
  assert.equal(googlePhotoAssetForPath([...assets, { id: "ambiguous", relativePath: "DAY/RIDER.JPG" }], "day/rider.jpg"), undefined);
  assert.equal(googlePhotoAssetForPath(assets, undefined), undefined);
});
test("review counts distinguish ready, changed, already-uploaded and unavailable; unknown native status fails closed", () => {
  const counts = googlePhotoCounts(["ready", "changed", "already_uploaded", "blocked", "unsupported", "missing", "future_status"].map(status => ({ status })));
  assert.deepEqual(counts, { ready: 2, changed: 1, skipped: 1, blocked: 4 });
  assert.deepEqual(googlePhotoCounts([]), { ready: 0, changed: 0, skipped: 0, blocked: 0 });
});
test("six explicit original/crop version types use native wire names and labels", () => {
  assert.deepEqual(GOOGLE_PHOTO_VARIANTS.map(variant => variant.id), ["original", "bw", "enhanced", "crop", "crop_bw", "crop_enhanced"]);
  assert.equal(new Set(GOOGLE_PHOTO_VARIANTS.map(variant => variant.id)).size, 6);
});
test("payload summaries handle invalid values conservatively instead of displaying misleading storage counts", () => {
  assert.equal(googlePhotoSize(NaN), "—"); assert.equal(googlePhotoSize(Infinity), "—"); assert.equal(googlePhotoSize(-1), "—");
  assert.equal(googlePhotoSize(1024 ** 3), "1.00 GB"); assert.equal(googlePhotoSize(1024 ** 2), "1.0 MB"); assert.equal(googlePhotoSize(1024), "1 KB");
});
