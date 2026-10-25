// Qualification-only differential through the existing supervised --mask-job seam.
// No application export, production runtime or vendor-source changes.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {readEvidenceFile, writeEvidenceArtifact, evidenceDigest} from './subject-finishing/runtime/evidence-files.mjs';

const root=resolve('.build-cache/subject-finishing-manual-cpu-v1');
const python=join(root,'runtime/python.exe');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const owner=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const experiments=resolve('scripts/subject-finishing/experiments');
const directory=resolve(`test-output/subject-feature-cache-${Date.now()}`);
await mkdir(directory);
const pinNames=['scripts/test-subject-feature-cache.mjs',
 'scripts/subject-finishing/experiments/feature-cache-worker.py',
 'scripts/subject-finishing/experiments/feature-baseline-worker.py',
 'scripts/subject-finishing/experiments/feature-tail-failure-worker.py',
 'scripts/subject-finishing/experiments/feature-cache-experiment.py',
 'src-tauri/scripts/subject_mask_worker.py','src-tauri/scripts/subject_mask_job.py',
 'src-tauri/scripts/subject_masks_contract.py','src-tauri/scripts/subject_mask_cache.py',
 'src-tauri/scripts/subject_media_contract.py','src-tauri/scripts/subject_process.py',
 '.build-cache/subject-finishing-manual-cpu-v1/runtime-manifest.json',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/build_sam.py',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/sam2_video_predictor.py',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/modeling/sam2_base.py',
 'src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe'];
const pins={};
for(const name of pinNames) pins[name]=evidenceDigest(await readEvidenceFile(resolve(name)));
const tools={};
for(const path of [ff,ff.replace('ffmpeg.exe','ffprobe.exe')])tools[path]=evidenceDigest(await readEvidenceFile(path,32*1024**2));
// Each picture gets a different small background marker; local index is not identity.
const source=join(directory,'base.mp4');
const generate=spawnSync(ff,['-v','error','-nostdin','-n','-f','lavfi','-i',
 String.raw`color=c=0x707c80:size=160x96:rate=5,drawbox=x=48:y=24:w=72:h=58:color=0xb46040:t=fill,drawbox=x=68:y=8:w=24:h=24:color=0x4060b4:t=fill,geq=lum=if(lt(X\,8)*lt(Y\,8)\,32+N*12\,lum(X\,Y)):cb=cb(X\,Y):cr=cr(X\,Y)`,
 '-frames:v','9','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-color_range','tv',
 '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
 '-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709',source],{windowsHide:true,timeout:30000});
assert.equal(generate.status,0,generate.stderr?.toString());
const sourceBytes=await readFile(source);
const identity=createHash('md5').update(sourceBytes).digest('hex');
const sourceSha256=evidenceDigest(sourceBytes);
const request={version:1,sourcePath:source,baseChecksum:identity,width:160,height:96,fps:5,
 frameCount:9,windowFrames:4,overlapFrames:2,selection:{version:1,baseIdentity:identity,frameCount:9,referenceFrame:4,
 anchors:[{frame:4,object:'horse',box:[.3,.25,.75,.86]},{frame:4,object:'rider',box:[.425,.08,.575,.35]},
 {frame:3,object:'horse',box:[.3,.25,.75,.86]},{frame:5,object:'rider',box:[.425,.08,.575,.35]}]}};

async function run(name,cancelAfterHit=false,tailFailure=false){
 console.log(JSON.stringify({event:'featureCacheExperimentPhase',name}));
 const destination=join(directory,`${name}.partial`),requestFile=join(directory,`${name}.json`);
 await writeFile(requestFile,JSON.stringify({...request,destinationPath:destination}),{flag:'wx'});
 const workerName=tailFailure?'feature-tail-failure-worker.py':name==='baseline'?'feature-baseline-worker.py':'feature-cache-worker.py';
 const child=spawn(owner,['--mask-job',python,join(experiments,workerName),
  requestFile,root,ff,'180','8'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',hit=null,pythonId=null,expired=false,cancelled=false;
 const timer=setTimeout(()=>{expired=true;child.kill();},185000);
 child.stderr.on('data',chunk=>{
  stderr+=chunk;
  for(const line of stderr.split(/\r?\n/).slice(0,-1)){
   let event;try{event=JSON.parse(line);}catch{continue;}
   if(event.event==='maskJobStarted')pythonId=event.child;
  }
  if(stderr.length>512*1024)child.kill();
 });
 child.stdout.on('data',chunk=>{
  stdout+=chunk;
  for(const line of stdout.split(/\r?\n/).slice(0,-1)){
   let event;try{event=JSON.parse(line);}catch{continue;}
   if(event.event==='featureCacheHit')hit=event;
  }
  if(cancelAfterHit&&hit&&!cancelled){cancelled=true;child.kill();}
  if(stdout.length>512*1024)child.kill();
 });
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 await writeEvidenceArtifact(directory,`${name}-stdout.txt`,Buffer.from(stdout));
 await writeEvidenceArtifact(directory,`${name}-stderr.txt`,Buffer.from(stderr));
 assert.equal(expired,false,`${name} reached its wrapper deadline`);
 if(tailFailure){
  assert.notEqual(code,0);assert.match(stdout,/"event": "featureCacheTailFailure"/);
  assert.doesNotMatch(stdout,/progress=end/);assert.doesNotMatch(stderr,/maskJobFinished/);
  for(const file of ['manifest.json','encoder-diagnostic.json','masks.pgmask'])await assert.rejects(access(join(destination,file)));
  return {failedAfterFinalFrame:true,publicationAccepted:false};
 }
 if(cancelAfterHit){
  assert.ok(cancelled&&hit&&pythonId>0,'Cancellation must occur after a real cache hit');
  assert.notEqual(code,0);assert.doesNotMatch(stdout,/progress=end/);assert.doesNotMatch(stderr,/maskJobFinished/);
  for(const file of ['manifest.json','encoder-diagnostic.json'])await assert.rejects(access(join(destination,file)));
  const absent=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
   `$remainingCacheChildren = @(Get-Process -Id ${pythonId} -ErrorAction SilentlyContinue); if ($remainingCacheChildren.Count) { exit 1 }`],
   {windowsHide:true,timeout:5000});
  assert.equal(absent.status,0,'Cancelled supervised Python remains alive');
  return {cancelledAfterHit:true,pythonId,hit,publicationAccepted:false,
   decoderLimit:'Each window decoder has already exited before its first encoder hit; prior owner fixture separately exercises a live decoder descendant.'};
 }
 assert.equal(code,0,`${name} failed: ${stderr.slice(-3000)}`);
 const manifest=JSON.parse(await readEvidenceFile(join(destination,'manifest.json')));
 const diagnostic=JSON.parse(await readEvidenceFile(join(destination,'encoder-diagnostic.json')));
 assert.equal(manifest.complete,true);assert.equal(manifest.frames,9);assert.equal(manifest.windows,4);
 assert.deepEqual(manifest.handoffSeedFrames,[6,2]);assert.equal(manifest.heldOutSeamFrames,2);
 assert.ok(manifest.minimumSeamIoU>=.6);assert.equal(manifest.subjectQualityAccepted,false);
 assert.ok(manifest.peakWorkingSetBytes>0&&manifest.peakWorkingSetBytes<=4*1024**3);
 assert.equal(diagnostic.qualityAccepted,false);assert.equal(diagnostic.exportQualified,false);
 assert.equal(diagnostic.windows.length,4);assert.equal(diagnostic.visits.length,14);
 assert.equal(diagnostic.inputIdentities.length,9);
 assert.equal(new Set(diagnostic.inputIdentities.map(item=>item.sha256)).size,9,'Fixture pictures are not all distinct');
 const artifacts={};
 for(const file of ['masks.pgmask','reference-mask.png','manifest.json','encoder-diagnostic.json'])
  artifacts[file]=evidenceDigest(await readEvidenceFile(join(destination,file)));
 return {manifest,diagnostic,artifacts};
}

const baseline=await run('baseline');
const candidate=await run('candidate');
const ignored=new Set(['peakWorkingSetBytes','decodeSeconds','inferenceSeconds','secondsIncludingLoad']);
const stable=manifest=>Object.fromEntries(Object.entries(manifest).filter(([key])=>!ignored.has(key)));
assert.deepEqual(stable(candidate.manifest),stable(baseline.manifest));
for(const file of ['masks.pgmask','reference-mask.png'])assert.equal(candidate.artifacts[file],baseline.artifacts[file],file);
assert.deepEqual(candidate.diagnostic.visits,baseline.diagnostic.visits,'Logits/new memory must match corresponding independent window visits');
assert.deepEqual(candidate.diagnostic.inputIdentities,baseline.diagnostic.inputIdentities);
assert.ok(candidate.diagnostic.cache.hits>0);assert.ok(candidate.diagnostic.cache.encoderCalls<baseline.diagnostic.cache.encoderCalls);
assert.deepEqual(candidate.diagnostic.cache.hitFrames,[{window:1,globalFrame:6},{window:1,globalFrame:7},
 {window:3,globalFrame:2},{window:3,globalFrame:1}],'Both directions must reuse their exact incoming overlap pictures');
assert.ok(candidate.diagnostic.cache.maximumEntries<=2);assert.ok(candidate.diagnostic.cache.maximumStorageBytes<=512*1024**2);
assert.equal(candidate.diagnostic.cache.integrityChecksPassed,true);
const cancellation=await run('cancel-after-hit',true);
const tailFailure=await run('tail-failure',false,true);
assert.equal(evidenceDigest(await readFile(source)),sourceSha256);
for(const name of pinNames)assert.equal(evidenceDigest(await readEvidenceFile(resolve(name))),pins[name],`Changed experiment input: ${name}`);
for(const [path,digest] of Object.entries(tools))assert.equal(evidenceDigest(await readEvidenceFile(path,32*1024**2)),digest,'Changed media tool');
const receipt={schema:1,diagnosticOnly:true,qualityAccepted:false,exportQualified:false,scope:'CPU-only distinct synthetic nine-frame midpoint reference and both-direction overlap correction',
 sourceSha256,pins,tools,baseline,candidate,cancellation,tailFailure,parity:{logitsAndNewMemory:true,masksAndReferenceBytes:true,
 canonicalRecipeAndIdentity:true,seamMetricsAndOwnership:true},
 limits:'One sequential instrumented pair, not a representative horse-quality, production throughput, NVIDIA, long-clip or release qualification.'};
await writeEvidenceArtifact(directory,'receipt.json',Buffer.from(JSON.stringify(receipt,null,2)));
console.log(JSON.stringify({directory,passed:true,encoderCalls:[baseline.diagnostic.cache.encoderCalls,candidate.diagnostic.cache.encoderCalls],
 hits:candidate.diagnostic.cache.hits,wallSeconds:[baseline.manifest.secondsIncludingLoad,candidate.manifest.secondsIncludingLoad],qualityAccepted:false,exportQualified:false}));
