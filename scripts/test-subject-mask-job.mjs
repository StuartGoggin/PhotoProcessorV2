import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(process.env.PHOTOGOGO_MASK_RUNTIME_ROOT ?? ".build-cache/subject-finishing-manual-cpu-v1");
const python = join(root, "runtime/python.exe");
const ff = process.env.PHOTOGOGO_FFMPEG ?? "C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe";
const worker = resolve("src-tauri/scripts/subject_mask_worker.py");
const owner = resolve("src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe");

test("a real later-reference two-object job owns opening/tail frames and publishes a bounded compressed mask receipt", () => {
  const folder = mkdtempSync(resolve("test-output/subject-mask-job-"));
  const source = join(folder, "base.mp4");
  const generate = spawnSync(ff, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
    "color=c=0x707c80:size=160x96:rate=5,drawbox=x=48:y=24:w=72:h=58:color=0xb46040:t=fill,drawbox=x=68:y=8:w=24:h=24:color=0x4060b4:t=fill",
    "-frames:v", "9", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-color_range", "tv",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", source], { timeout: 30_000 });
  assert.equal(generate.status, 0, generate.stderr?.toString());
  const identity = createHash("md5").update(readFileSync(source)).digest("hex");
  const destination = join(folder, "mask-cache.partial");
  const request = { version: 1, sourcePath: source, baseChecksum: identity,
    width: 160, height: 96, fps: 5, frameCount: 9, windowFrames: 4, overlapFrames: 2,
    destinationPath: destination, selection: { version: 1, baseIdentity: identity, frameCount: 9,
      anchors: [{ frame: 3, object: "horse", box: [.3, .25, .75, .86] },
                { frame: 3, object: "rider", box: [.425, .08, .575, .35] }] } };
  const requestFile = join(folder, "request.json");
  writeFileSync(requestFile, JSON.stringify(request));
  const result = spawnSync(owner, ["--mask-job",python,worker,requestFile,root,ff,"180"], {
    timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  const receipt = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.frames, 9);
  assert.equal(receipt.baseChecksum, identity);
  assert.equal(receipt.maskIdentity,createHash('sha256').update(receipt.canonicalRecipe).digest('hex'));
  assert.equal(JSON.parse(receipt.canonicalRecipe)[3],identity);
  assert.match(result.stderr.toString(),/"event":"maskJobFinished"/);
  assert.equal(receipt.windows, 3);
  assert.equal(receipt.maximumDecodedFrames, 4);
  assert.ok(receipt.peakWorkingSetBytes > 0 && receipt.peakWorkingSetBytes <= 4 * 1024 ** 3);
  assert.equal(receipt.mask.checksum, createHash("md5").update(readFileSync(join(destination, "masks.pgmask"))).digest("hex"));
  assert.ok(receipt.mask.bytes < 100_000);
  assert.equal(receipt.subjectQualityAccepted, false, "Synthetic tracking must not masquerade as horse acceptance");
  assert.equal(createHash("md5").update(readFileSync(source)).digest("hex"), identity);
  assert.ok(existsSync(join(destination, "reference-mask.png")));
  console.log(JSON.stringify(receipt));
});
