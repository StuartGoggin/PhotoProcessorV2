// Authorized original samples: read-only inspection and derived review stills.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const ff = "C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe";
const probe = ff.replace("ffmpeg.exe", "ffprobe.exe");
const samples = [
  { name: "black-horse", source: "C:/Users/Stuart Goggin/Downloads/20261004_140023.mp4", seconds: [6, 8] },
  { name: "white-horse", source: "C:/Users/Stuart Goggin/Downloads/20261004_131458.mp4", seconds: [2, 4] },
];
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const folder = resolve(`test-output/subject-original-inspection-${Date.now()}`);
await mkdir(folder);
const receipts = [];
for (const sample of samples) {
  const before = await digest(sample.source);
  const inspected = spawnSync(probe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", sample.source], { timeout: 30_000, maxBuffer: 2 * 1024 ** 2 });
  if (inspected.status !== 0) throw new Error(inspected.stderr.toString());
  const frames = [];
  for (const second of sample.seconds) {
    const path = join(folder, `${sample.name}-${second}s.png`);
    const result = spawnSync(ff, ["-v", "error", "-nostdin", "-n", "-threads", "2", "-ss", String(second), "-i", sample.source,
      "-frames:v", "1", "-an", "-vf", "scale=960:-2", "-filter_threads", "1", "-threads", "1", path], { timeout: 30_000, maxBuffer: 1024 ** 2 });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    frames.push({ second, path });
  }
  const after = await digest(sample.source);
  if (before !== after) throw new Error("Original sample changed during read-only inspection");
  receipts.push({ ...sample, sha256Before: before, sha256After: after, metadata: JSON.parse(inspected.stdout), frames, subjectQualityAccepted: false });
}
await writeFile(join(folder, "inspection.json"), JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), receipts }, null, 2));
console.log(JSON.stringify({ folder, frames: receipts.flatMap(value => value.frames), originalsUnchanged: true, qualityAcceptance: false }));
