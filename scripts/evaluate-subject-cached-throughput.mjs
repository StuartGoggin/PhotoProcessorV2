// Fixed, cache-only media experiment. Never authorizes app export or changes input media.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp, stat} from 'node:fs/promises';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {assertEvidenceAncestry, readEvidenceFile, writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

const cpuCandidateMode=process.argv[2]==='--cpu-candidate';
assert.ok(process.argv.length===2||(cpuCandidateMode&&process.argv.length===5),
 'Only an explicitly hash-pinned isolated CPU candidate may be selected; source media and recipes are fixed');
const root=resolve('test-output/subject-footage-evaluation-1791597148390');
const outputRoot=resolve('test-output');
const worker=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const candidate=cpuCandidateMode?resolve(process.argv[3]):null;
if(candidate) {
 const candidateRelative=relative(outputRoot,candidate);
 assert.ok(!isAbsolute(candidateRelative)&&!candidateRelative.startsWith('..'),'Candidate must remain inside isolated test-output');
 assert.match(process.argv[4],/^[a-f0-9]{64}$/,'Candidate requires an explicit SHA256 pin');
}
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const probe=ff.replace('ffmpeg.exe','ffprobe.exe');
const pins={
 worker:'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d',
 ff:'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630',
 probe:'5dfbfa385580d884ba599a0356e36d80b14adc614fd95deee935bbf19b90bebc',
};
if(candidate)pins.candidate=process.argv[4];
const candidateBuildPath=candidate?join(dirname(dirname(candidate)),'build-receipt.json'):null;
const candidateBuild=candidate?JSON.parse(await readEvidenceFile(candidateBuildPath)):null;
if(candidateBuild) {
 assert.equal(candidateBuild.schema,1);assert.equal(candidateBuild.referenceOnly,false);
 assert.equal(candidateBuild.worker.path,'worker/photogogo-subject-finishing.exe');
 assert.equal(candidateBuild.worker.sha256,pins.candidate);
 assert.equal(candidateBuild.reference.path,'objects/subject-finishing-reference-tests.exe');
 assert.equal(await hash(join(dirname(candidateBuildPath),candidateBuild.reference.path)),candidateBuild.reference.sha256);
 pins.candidateBuild=await hash(candidateBuildPath);
 for(const entry of candidateBuild.sources) {
  assert.match(entry.path,/^src-tauri\/native\/subject_finishing\/[a-z_]+\.(h|cpp)$/);
  assert.equal(await hash(resolve(entry.path)),entry.sha256);
 }
}
const pinnedFiles={worker,ff,probe,...(candidate?{candidate,candidateBuild:candidateBuildPath}:{})};
const cases=[
 {name:'black-horse',grade:[0.25,1.03,1.04,0.02],order:cpuCandidateMode?['retained','candidate']:['cpu','gpu']},
 {name:'white-horse',grade:[-0.20,1.02,0.98,-0.015],order:cpuCandidateMode?['candidate','retained']:['gpu','cpu']},
];
async function hash(path,algorithm='sha256',maximum=256*1024**2) {
 await assertEvidenceAncestry(path);
 const info=await stat(path);assert.ok(info.isFile()&&info.size>0&&info.size<=maximum);
 const value=createHash(algorithm);let bytes=0;
 for await(const chunk of createReadStream(path)){bytes+=chunk.length;assert.ok(bytes<=maximum);value.update(chunk);}
 assert.equal(bytes,info.size);return value.digest('hex');
}
async function run(binary,args,phase,deadlineMs=30000) {
 const start=performance.now();let out='',err='',timedOut=false,overflow=false;
 const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>{timedOut=true;child.kill();},deadlineMs);
 const collect=(current,data)=>{
  if(Buffer.byteLength(current)+data.length>1024**2){overflow=true;child.kill();return current;}
  return current+data.toString('utf8');
 };
 child.stdout.on('data',data=>{out=collect(out,data);});
 child.stderr.on('data',data=>{err=collect(err,data);});
 const tick=setInterval(()=>console.log(JSON.stringify({event:'progress',phase,ownedPid:child.pid,
  seconds:Math.round((performance.now()-start)/100)/10,lastFrame:[...out.matchAll(/^frame=(\d+)\r?$/gm)].at(-1)?.[1]??null})),15000);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);})
  .finally(()=>{clearTimeout(timer);clearInterval(tick);});
 const wallSeconds=(performance.now()-start)/1000;
 await writeEvidenceArtifact(folder,`${phase}.stdout.txt`,Buffer.from(out));
 await writeEvidenceArtifact(folder,`${phase}.stderr.txt`,Buffer.from(err));
 assert.equal(timedOut,false,`${phase}: deadline; partial evidence retained`);
 assert.equal(overflow,false,`${phase}: bounded diagnostics exceeded`);
 assert.equal(code,0,`${phase}: ${err.slice(-2000)}`);
 return {out,err,wallSeconds};
}
async function inspect(path,phase) {
 const decoded=await run(probe,['-v','error','-count_frames','-show_streams','-of','json',path],`${phase}-profile`);
 assert.equal(decoded.err.trim(),'','Decoding the complete excerpt reported an error');
 const streams=JSON.parse(decoded.out).streams;
 assert.equal(streams.filter(s=>s.codec_type==='video').length,1);
 assert.equal(streams.filter(s=>s.codec_type==='audio').length,1);
 const v=streams.find(s=>s.codec_type==='video'),a=streams.find(s=>s.codec_type==='audio');
 for(const[key,value]of Object.entries({width:3840,height:2160,nb_frames:'100',nb_read_frames:'100',r_frame_rate:'50/1',avg_frame_rate:'50/1',
  pix_fmt:'yuv420p',color_range:'tv',color_space:'bt709',color_transfer:'bt709',color_primaries:'bt709',field_order:'progressive'}))
  assert.equal(v[key],value,`${phase}: ${key}`);
 assert.equal(a.codec_name,'aac');assert.equal(a.sample_rate,'48000');assert.equal(a.channels,2);
 const video=JSON.parse((await run(probe,['-v','error','-select_streams','v:0','-show_packets',
  '-show_entries','packet=pts_time,duration_time','-of','json',path],`${phase}-video-packets`)).out).packets;
 assert.equal(video.length,100);
 const ordered=video.map(p=>Number(p.pts_time)).sort((x,y)=>x-y);
 ordered.forEach((time,n)=>assert.ok(Math.abs(time-n/50)<1e-6,`${phase}: frame ${n}`));
 video.forEach(p=>assert.ok(Math.abs(Number(p.duration_time)-1/50)<1e-6,`${phase}: frame duration`));
 const audio=JSON.parse((await run(probe,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256',
  '-show_entries','packet=pts_time,dts_time,duration_time,size,data_hash,side_data_list','-of','json',path],`${phase}-audio-packets`)).out).packets;
 assert.ok(audio.length>0);
 return {audio,videoPackets:video.length,decodedVideoFrames:Number(v.nb_read_frames),
  videoDurationSeconds:Number(v.duration),audioDurationSeconds:Number(a.duration)};
}
await assertEvidenceAncestry(root);await assertEvidenceAncestry(outputRoot);
const evaluation=JSON.parse(await readEvidenceFile(join(root,'evaluation.json')));
assert.equal(evaluation.receipts.length,2);
for(const[key,path]of Object.entries(pinnedFiles))assert.equal(await hash(path),pins[key]);
const inputs=[];
for(const c of cases) {
 const recorded=evaluation.receipts.find(r=>r.name===c.name);assert.ok(recorded);
 const base=join(root,c.name,'bounded-normalized-excerpt.mp4'),mask=join(root,c.name,'masks.partial/masks.pgmask');
 const manifest=join(root,c.name,'masks.partial/manifest.json');
 const baseSha256=await hash(base),maskSha256=await hash(mask),manifestSha256=await hash(manifest);
 assert.equal(await hash(base,'md5'),recorded.baseIdentity);
 assert.equal(maskSha256,recorded.maskReceipt.mask.sha256);
 inputs.push({...c,base,mask,manifest,baseSha256,maskSha256,manifestSha256});
}
const folder=await mkdtemp(join(outputRoot,cpuCandidateMode?'subject-cpu-parallel-throughput-':'subject-cached-throughput-'));
const hardware=JSON.parse((await run(worker,['--probe'],'hardware-probe')).out);
assert.equal(hardware.available,true);assert.equal(hardware.backend,'d3d11');
const runs=[];
console.log(JSON.stringify({event:'started',folder,hardwareProbe:hardware,productionExport:false}));
for(const input of inputs) {
 const source=await inspect(input.base,`${input.name}-source`);
 for(const variant of input.order) {
  const backend=cpuCandidateMode?'cpu':variant;
  const selectedWorker=variant==='candidate'?candidate:worker;
  const phase=`${input.name}-${variant}`,output=join(folder,`${phase}.mp4`);
  console.log(JSON.stringify({event:'phase',phase}));
  const result=await run(selectedWorker,['--render',ff,input.base,output,input.mask,'3840','2160','26','32','100',backend,
   ...input.grade.map(String),'0','0','1','1','0','50','4','40','libx264'],phase,90000);
  assert.ok(!result.err.includes('cpuFallback'),'Explicit GPU may not masquerade as CPU');
  const events=result.err.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  const completed=events.filter(e=>e.event==='mediaFinished');assert.equal(completed.length,1);
  const done=completed[0];assert.equal(done.backend,backend==='gpu'?'d3d11':'cpu');assert.equal(done.frames,100);
  if(variant==='candidate')assert.equal(done.cpuPictureParallelism,4);
  assert.equal(done.engine,'subject-rgb709-q4-v2');assert.equal(done.profile,'limited-sdr709-yuv420p8');
  assert.equal(done.audio,'base-stream-copy');assert.ok(done.filterAndTransferMs>0&&done.decodeFilterEncodeSeconds>0);
  const frames=[...result.out.matchAll(/^frame=(\d+)\r?$/gm)].map(m=>Number(m[1]));
  assert.deepEqual(frames,Array.from({length:100},(_,n)=>n+1));
  assert.equal(result.out.trimEnd().split(/\r?\n/).at(-1),'progress=end');
  const media=await inspect(output,phase);assert.deepEqual(media.audio,source.audio,'Base AAC data/timing/side data changed');
  assert.equal(media.videoDurationSeconds,source.videoDurationSeconds);
  assert.equal(media.audioDurationSeconds,source.audioDurationSeconds);
  const bytes=(await stat(output)).size;assert.ok(bytes>0&&bytes<=64*1024**2);
  runs.push({sample:input.name,workerVariant:cpuCandidateMode?variant:'retained',requestedBackend:backend,grade:input.grade,sharpeningGain256:26,threads:4,encoder:'libx264',
   output,outputBytes:bytes,outputSha256:await hash(output),wallSeconds:result.wallSeconds,
   wholeCachedPipelineFramesPerSecond:100/result.wallSeconds,nativeCompletion:done,audioPacketsCopiedExactly:media.audio.length,
   videoPackets:media.videoPackets,decodedVideoFrames:media.decodedVideoFrames,videoDurationSeconds:media.videoDurationSeconds,
   pixelParityChecked:false,continuousPlaybackReviewed:false,subjectQualityAccepted:false,exportQualified:false});
  console.log(JSON.stringify({event:'completed',...runs.at(-1)}));
 }
}
for(const input of inputs) {
 assert.equal(await hash(input.base),input.baseSha256);assert.equal(await hash(input.mask),input.maskSha256);
 assert.equal(await hash(input.manifest),input.manifestSha256);
}
for(const[key,path]of Object.entries(pinnedFiles))assert.equal(await hash(path),pins[key]);
if(candidateBuild)for(const entry of candidateBuild.sources)assert.equal(await hash(resolve(entry.path)),entry.sha256);
const receipt={schema:1,experiment:cpuCandidateMode?'fixed-two-case-cached-media-cpu-parallel-v1':'fixed-two-case-cached-media-cpu-d3d-v1',hardwareProbe:hardware,pins,inputs,runs,
 limits:'Two-second normalized-original excerpts; no inference or stabilization. One sequential run per backend/worker per case with reversed order. Codec budget remains four for both CPU worker variants; candidate picture parallelism is four, not a combined pipeline thread cap. Not a statistically qualified speedup, RTX result, long-clip memory check, continuous visual review or public app export. Native timer excludes initial probe/GPU setup; external wall includes them. Filter timing includes transfers and overlaps decode/encode; do not subtract it to infer isolated stage costs. CPU/GPU engine utilization and peak memory not sampled.',
 productionExport:false,subjectQualityAccepted:false,exportQualified:false};
await writeEvidenceArtifact(folder,'receipt.json',Buffer.from(JSON.stringify(receipt,null,2)));
console.log(JSON.stringify({event:'finished',folder,subjectQualityAccepted:false,exportQualified:false}));
