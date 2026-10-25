import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { test } from "node:test";

assert.ok(process.argv.length===2||process.argv.length===3,'Select at most one isolated candidate worker');
const selectedCandidate=process.argv[2]!==undefined;
const worker = resolve(process.argv[2]??"src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe");
if(selectedCandidate) {
  const candidateRelative=relative(resolve('test-output'),worker);
  assert.ok(!isAbsolute(candidateRelative)&&!candidateRelative.startsWith('..'),'Candidate worker must remain inside isolated test-output');
}
const ff = process.env.PHOTOGOGO_FFMPEG ?? "C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe";
const probe = ff.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
const hash = (file) => createHash("md5").update(readFileSync(file)).digest("hex");
test("the supervised media path keeps exact frame/audio/profile identity and refuses a failed mask prefix", () => {
  const folder = mkdtempSync(resolve("test-output/subject-finishing-media-"));
  const source = join(folder, "original-馬.mp4"), masks = join(folder, "masks.pgmask");
  const generated = spawnSync(ff, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.4", "-c:v", "libx264", "-bf", "0", "-threads", "1",
    "-pix_fmt", "yuv420p", "-color_range", "tv", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", source], { timeout: 30_000 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const original = hash(source), header = Buffer.alloc(20);
  header.write("PGMSK001"); header.writeUInt32LE(320,8); header.writeUInt32LE(180,12); header.writeUInt32LE(10,16);
  const record = Buffer.alloc(9); record.writeUInt32LE(5); record.writeUInt32LE(320*180,4); record[8] = 255;
  const cache = Buffer.concat([header, ...Array(10).fill(record)]);
  writeFileSync(masks, cache);
  const output = join(folder, "finished-馬.mp4");
  const args = ["--render", ff, source, output, masks, "320", "180", "51", "32", "10", selectedCandidate?"cpu":"auto",
    "0", "1", "1", "0", "0", "0", "1", "1", "0", "25", selectedCandidate?"4":"2", "4", "libx264"];
  const heldWriter=openSync(source,'r+');
  try {
    const locked=spawnSync(worker,args,{timeout:30_000});
    assert.notEqual(locked.status,0,'Existing source writer must prevent immutable-base admission');
    assert.equal(existsSync(output),false);
  } finally {closeSync(heldWriter);}
  const rendered = spawnSync(worker, args, { timeout: 60_000, maxBuffer: 2*1024*1024 });
  assert.equal(rendered.status, 0, `${rendered.error ?? ""}\n${rendered.stderr}`);
  assert.match(rendered.stdout.toString(), /progress=end/);
  assert.match(rendered.stderr.toString(), /"event":"mediaFinished"/);
  const inspected = spawnSync(probe, ["-v", "error", "-show_streams", "-of", "json", output], { timeout: 30_000 });
  assert.equal(inspected.status, 0);
  const streams = JSON.parse(inspected.stdout).streams;
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.nb_frames, "10"); assert.equal(video.avg_frame_rate, "25/1");
  assert.equal(video.width, 320); assert.equal(video.height, 180);
  assert.equal(video.sample_aspect_ratio, '1:1');assert.equal(video.field_order,'progressive');
  for (const field of ["color_transfer", "color_primaries", "color_space"]) assert.equal(video[field], "bt709");
  assert.equal(video.color_range, "tv"); assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(audio.sample_rate, "48000"); assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) <= .025);
  const audioBytes = (file) => {
    const extracted = spawnSync(ff, ['-v','error','-nostdin','-i',file,'-map','0:a:0','-c:a','copy','-f','adts','pipe:1'], {timeout:30_000});
    assert.equal(extracted.status, 0, extracted.stderr.toString());
    return extracted.stdout;
  };
  assert.deepEqual(audioBytes(output), audioBytes(source), 'Finishing must retain compressed audio packets, not just duration');
  const preserved = hash(output);
  const overwrite = spawnSync(worker, args, { timeout: 30_000 });
  assert.notEqual(overwrite.status, 0); assert.equal(hash(output), preserved);
  const reshapedOutput = join(folder, 'must-not-reshape.mp4');
  const reshapedArgs = [...args]; reshapedArgs[3] = reshapedOutput; reshapedArgs[5] = '180'; reshapedArgs[6] = '320';
  const reshaped = spawnSync(worker, reshapedArgs, {timeout:30_000});
  assert.notEqual(reshaped.status, 0, 'Equal-pixel-count geometry mismatch must fail before picture processing');
  assert.equal(existsSync(reshapedOutput), false, 'Invalid base admission must not create an output');
  const prefixHeader = Buffer.from(header); prefixHeader.writeUInt32LE(9,16);
  writeFileSync(masks, Buffer.concat([prefixHeader, ...Array(9).fill(record)]));
  const prefixOutput = join(folder, 'must-not-truncate.mp4');
  const prefixArgs = [...args]; prefixArgs[3] = prefixOutput; prefixArgs[9] = '9';
  const prefix = spawnSync(worker, prefixArgs, {timeout:30_000});
  assert.notEqual(prefix.status, 0, 'A valid requested prefix is not complete-base proof');
  assert.equal(existsSync(prefixOutput), false);
  // Valid picture/mask prefix followed by invalid EOF may leave only an owned
  // partial file. It must not report completion or become a published artifact.
  writeFileSync(masks, Buffer.concat([cache, Buffer.from("unexpected")]));
  const failedOutput = join(folder, "must-remain-unverified.partial.mp4");
  const failedArgs = [...args]; failedArgs[3] = failedOutput;
  const failed = spawnSync(worker, failedArgs, { timeout: 60_000, maxBuffer: 2*1024*1024 });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout.toString(), /progress=end/);
  assert.doesNotMatch(failed.stderr.toString(), /"event":"mediaFinished"/);
  assert.equal(hash(source), original); assert.equal(hash(output), preserved);
  assert.ok(existsSync(output));
  console.log(`PASS: exact media/profile, UTF-8 paths, no overwrite and invalid-prefix failure; artifacts retained at ${folder}`);
});

test('cancelling after a valid prefix terminates both owned FFmpeg children without publishing completion', async () => {
  const folder=mkdtempSync(resolve('test-output/subject-finishing-cancel-'));
  const source=join(folder,'source.mp4'),masks=join(folder,'masks.pgmask'),output=join(folder,'owned-unverified.partial.mp4');
  const created=spawnSync(ff,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate=25',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','40','-c:v','libx264','-preset','ultrafast',
    '-bf','0','-threads','2','-pix_fmt','yuv420p','-color_range','tv',
    '-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709','-c:a','aac','-ac','2',source],{timeout:30_000});
  assert.equal(created.status,0,created.stderr.toString());const before=hash(source);
  const header=Buffer.alloc(20);header.write('PGMSK001');header.writeUInt32LE(640,8);header.writeUInt32LE(360,12);header.writeUInt32LE(1000,16);
  const record=Buffer.alloc(9);record.writeUInt32LE(5);record.writeUInt32LE(640*360,4);record[8]=255;
  writeFileSync(masks,Buffer.concat([header,...Array(1000).fill(record)]));
  const child=spawn(worker,['--render',ff,source,output,masks,'640','360','51','32','1000','cpu',
    '0','1','1','0','0','0','1','1','0','25',selectedCandidate?'4':'2','4','libx264'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',pids=null,killed=false;const started=Date.now();
  const timer=setTimeout(()=>child.kill(),8000);
  const maybeKill=()=> {
    const receipt=stderr.split(/\r?\n/).slice(0,-1).find(line=>line.includes('"event":"pipelineStarted"'));
    if(receipt)pids=JSON.parse(receipt).children;
    if(pids&&/frame=\d+\r?\n/.test(stdout)&&!killed) {killed=true;child.kill();}
  };
  child.stdout.on('data',chunk=>{stdout+=chunk;maybeKill();});
  child.stderr.on('data',chunk=>{stderr+=chunk;maybeKill();});
  try {await new Promise((res,rej)=>{child.once('close',res);child.once('error',rej);});}
  finally {clearTimeout(timer);if(child.exitCode===null)child.kill();}
  assert.equal(killed,true,`Worker never exposed a valid owned prefix: ${stderr}\n${stdout}`);
  assert.equal(pids.length,2);assert.ok(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  assert.ok(Date.now()-started<8000);
  assert.doesNotMatch(stdout,/progress=end/);assert.doesNotMatch(stderr,/"event":"mediaFinished"/);
  const checked=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `$subjectRemaining = @(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue); if ($subjectRemaining.Count) { exit 1 }`],
    {windowsHide:true,timeout:5000});
  assert.equal(checked.status,0,'Cancelled finishing left a decoder or encoder process alive');
  assert.equal(hash(source),before);
  console.log(`PASS: killed worker and both FFmpeg owners after first prefix; retained unverified staging at ${folder}`);
});
