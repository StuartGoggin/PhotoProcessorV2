// Bounded actual-footage evaluation; these excerpts are NOT public full bases.
// Keep failed samples and their evidence. No automatic quality approval.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const ff = "C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe";
const owner = resolve("src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe");
const runtime = resolve(".build-cache/subject-finishing-manual-cpu-v1");
const folder = resolve(`test-output/subject-footage-evaluation-${Date.now()}`);
await mkdir(folder);
async function hash(path, algorithm = "sha256") {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function run(binary, args, phase, timeout, prefix) {
  console.log(JSON.stringify({ event: "phase", phase, startedAt: new Date().toISOString() }));
  const began = Date.now();
  const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", killed = false;
  const timer = setTimeout(() => { killed = true; child.kill(); }, timeout);
  child.stdout.on("data", value => { stdout += value; if (stdout.length > 4 * 1024 ** 2) child.kill(); });
  child.stderr.on("data", value => { stderr += value; if (stderr.length > 4 * 1024 ** 2) child.kill(); });
  const heartbeat = setInterval(() => {
    const frames = [...stdout.matchAll(/^frame=(\d+)$/gm)];
    console.log(JSON.stringify({ event: "progress", phase, seconds: (Date.now() - began) / 1000, ownedFrames: frames.at(-1)?.[1] ?? null }));
  }, 30_000);
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); }).finally(() => { clearTimeout(timer); clearInterval(heartbeat); });
  await writeFile(`${prefix}.stdout.txt`, stdout);
  await writeFile(`${prefix}.stderr.txt`, stderr);
  if (code !== 0 || killed) throw new Error(`${phase} failed (${code}; deadline=${killed}); retained evidence ${prefix}`);
  return { seconds: (Date.now() - began) / 1000, stdout, stderr };
}
const samples = [
  { name: "black-horse", original: "C:/Users/Stuart Goggin/Downloads/20261004_140023.mp4", offset: 6,
    horse: [.325, .32, .55, .87], rider: [.375, .08, .50, .67] },
  { name: "white-horse", original: "C:/Users/Stuart Goggin/Downloads/20261004_131458.mp4", offset: 2,
    horse: [0, .20, .49, .94], rider: [.405, .09, .59, .88] },
];
const receipts = [];
for (const sample of samples) {
  const directory = join(folder, sample.name); await mkdir(directory);
  const before = await hash(sample.original);
  const base = join(directory, "bounded-normalized-excerpt.mp4");
  const normalization = await run(ff, ["-v", "error", "-nostdin", "-n", "-threads", "2", "-ss", String(sample.offset), "-i", sample.original,
    "-map", "0:v:0", "-map", "0:a:0", "-t", "2", "-frames:v", "100", "-vf",
    "scale=3840:2160:out_range=tv,format=yuv420p,setsar=1,fps=50,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-filter_threads", "1", "-c:v", "libx264", "-preset", "veryfast", "-threads", "4", "-bf", "0", "-b:v", "40M",
    "-pix_fmt", "yuv420p", "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-video_track_timescale", "90000", base], "Normalize bounded excerpt", 90_000, join(directory, "normalization"));
  const identity = await hash(base, "md5");
  const destination = join(directory, "masks.partial");
  const selection = { version: 1, baseIdentity: identity, frameCount: 100, referenceFrame: 0,
    anchors: [{ frame: 0, object: "horse", box: sample.horse }, { frame: 0, object: "rider", box: sample.rider }] };
  const request = { version: 1, sourcePath: base, baseChecksum: identity, width: 3840, height: 2160, fps: 50, frameCount: 100,
    windowFrames: 16, overlapFrames: 4, destinationPath: destination, selection };
  const requestFile = join(directory, "request.json"); await writeFile(requestFile, JSON.stringify(request));
  const masks = await run(owner, ["--mask-job", join(runtime, "runtime/python.exe"), resolve("src-tauri/tools/subject-finishing/runner/subject_mask_worker.py"),
    requestFile, runtime, ff, "900", "8"], "Track actual horse and rider (CPU qualification candidate)", 905_000, join(directory, "tracking"));
  const maskReceipt = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  const output = join(directory, "finished-excerpt.mp4");
  const filtering = await run(owner, ["--render", ff, base, output, join(destination, "masks.pgmask"), "3840", "2160", "26", "32", "100", "auto",
    "0", "1", "1", "0", "0", "0", "1", "1", "0", "50", "4", "40", "libx264"], "Finish bounded excerpt", 90_000, join(directory, "finishing"));
  for (const frame of [0, 25, 50, 75, 99]) {
    for (const [name, path] of [["base", base], ["finished", output]]) {
      await run(ff, ["-v", "error", "-nostdin", "-n", "-threads", "2", "-ss", String(frame / 50), "-i", path, "-frames:v", "1", "-an",
        "-vf", "scale=960:-2", "-filter_threads", "1", "-threads", "1", join(directory, `${name}-${frame}.png`)], `Read ${name} frame ${frame}`, 30_000, join(directory, `${name}-${frame}`));
    }
  }
  const after = await hash(sample.original);
  if (before !== after || await hash(base, "md5") !== identity) throw new Error("Original or normalized base changed during finishing");
  receipts.push({ ...sample, originalSha256Before: before, originalSha256After: after, baseIdentity: identity, normalizationSeconds: normalization.seconds,
    maskSeconds: masks.seconds, filteringSeconds: filtering.seconds, maskReceipt, selection, output, subjectQualityAccepted: false,
    limits: "Two-second excerpt; CPU segmentation and Intel Arc filter development host, not full-clip/NVIDIA throughput or continuous playback acceptance." });
  await writeFile(join(folder, "evaluation.json"), JSON.stringify({ schema: 1, receipts, subjectQualityAccepted: false }, null, 2));
}
console.log(JSON.stringify({ event: "finished", folder, subjectQualityAccepted: false }));
