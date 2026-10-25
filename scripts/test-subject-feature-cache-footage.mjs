// Read-only retained-input, CPU-only moving-footage differential. No renormalization,
// app export, runtime edits or NVIDIA/whole-clip quality qualification.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {assertEvidenceAncestry, readEvidenceFile, writeEvidenceArtifact, evidenceDigest} from './subject-finishing/runtime/evidence-files.mjs';

const preflight=process.argv[2]==='--preflight';
assert.ok(process.argv.length===2||preflight&&process.argv.length===3,'Only fixed retained inputs or --preflight are supported');
const retained=resolve('test-output/subject-footage-evaluation-1791597148390');
const runtime=resolve('.build-cache/subject-finishing-manual-cpu-v1');
const python=join(runtime,'runtime/python.exe');
const owner=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const experiment=resolve('scripts/subject-finishing/experiments');
const directory=resolve(`test-output/subject-feature-cache-footage-${Date.now()}`);
const deadlineSeconds=1200;
const inputs=[
 'scripts/test-subject-feature-cache-footage.mjs',
 'scripts/subject-finishing/experiments/feature-cache-experiment.py',
 'scripts/subject-finishing/experiments/feature-baseline-worker.py',
 'scripts/subject-finishing/experiments/feature-cache-worker.py',
 'src-tauri/scripts/subject_mask_job.py','src-tauri/scripts/subject_mask_worker.py',
 'src-tauri/scripts/subject_masks_contract.py','src-tauri/scripts/subject_mask_cache.py',
 'src-tauri/scripts/subject_process.py','src-tauri/scripts/subject_media_contract.py',
 'src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe',
 '.build-cache/subject-finishing-manual-cpu-v1/runtime-manifest.json',
 '.build-cache/subject-finishing-manual-cpu-v1/models/sam2.1_hiera_tiny.pt',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/build_sam.py',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/sam2_video_predictor.py',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/modeling/sam2_base.py',
 '.build-cache/subject-finishing-manual-cpu-v1/vendor/sam2/configs/sam2.1/sam2.1_hiera_t.yaml',
 ff,ff.replace('ffmpeg.exe','ffprobe.exe')];

async function hash(path,algorithm='sha256'){
 await assertEvidenceAncestry(path);
 const stat=await lstat(path);assert.ok(stat.isFile()&&stat.size<512*1024**2,'Input must be a bounded regular file');
 const digest=createHash(algorithm);let bytes=0;
 for await(const chunk of createReadStream(path)){bytes+=chunk.length;assert.ok(bytes<=stat.size,'Input grew during hashing');digest.update(chunk);}
 assert.equal(bytes,stat.size,'Input length changed');return digest.digest('hex');
}

const pins={};for(const name of inputs)pins[name]=await hash(resolve(name));
const previous=JSON.parse(await readEvidenceFile(join(retained,'evaluation.json')));
assert.equal(previous.subjectQualityAccepted,false);
const samples=[];
for(const name of ['black-horse','white-horse']){
 const folder=join(retained,name),source=join(folder,'bounded-normalized-excerpt.mp4');
 const savedPath=join(folder,'request.json'),request=JSON.parse(await readEvidenceFile(savedPath));
 const oldManifestPath=join(folder,'masks.partial/manifest.json');
 const oldManifest=JSON.parse(await readEvidenceFile(oldManifestPath));
 const oldMaskPath=join(folder,'masks.partial/masks.pgmask'),oldReference=join(folder,'masks.partial/reference-mask.png');
 assert.equal(resolve(request.sourcePath),source);assert.equal(request.width,3840);assert.equal(request.height,2160);
 assert.equal(request.fps,50);assert.equal(request.frameCount,100);assert.equal(request.windowFrames,16);assert.equal(request.overlapFrames,4);
 assert.equal(request.selection.referenceFrame,0);assert.equal(oldManifest.subjectQualityAccepted,false);
 assert.equal(request.baseChecksum,await hash(source,'md5'));assert.equal(request.baseChecksum,oldManifest.baseChecksum);
 const original=previous.receipts.find(item=>item.name===name);
 assert.ok(original,'Missing retained original binding');
 assert.equal(await hash(original.original),original.originalSha256Before,'Authorized original no longer matches retained evaluation');
 const retainedPins={};
 for(const path of [source,savedPath,oldManifestPath,oldMaskPath,oldReference,original.original])retainedPins[path]=await hash(path);
 assert.equal(retainedPins[oldMaskPath],oldManifest.mask.sha256);
 samples.push({name,request,oldManifest,retainedPins,oldMaskPath,oldReference,
  subjectScope:name==='black-horse'?'horse and mounted rider':'horse and running handler (not a mounted-rider sample)'});
}
if(preflight){console.log(JSON.stringify({preflightPassed:true,profiles:samples.map(({name,request,subjectScope})=>({name,frames:request.frameCount,window:16,overlap:4,subjectScope})),
 sourceReused:true,payloadsChanged:false,perJobDeadlineSeconds:deadlineSeconds,qualityAccepted:false,exportQualified:false}));process.exit(0);}

await assertEvidenceAncestry(resolve('test-output'));await mkdir(directory);
await writeEvidenceArtifact(directory,'preflight.json',Buffer.from(JSON.stringify({schema:1,diagnosticOnly:true,pins,
 samples:samples.map(({name,subjectScope,retainedPins})=>({name,subjectScope,retainedPins})),deadlineSeconds,qualityAccepted:false,exportQualified:false},null,2)));

async function run(sample,mode){
 const folder=join(directory,sample.name);const destination=join(folder,`${mode}.partial`);
 const requestFile=join(folder,`${mode}.json`);
 await writeEvidenceArtifact(directory,`${sample.name}/${mode}.json`,Buffer.from(JSON.stringify({...sample.request,destinationPath:destination})));
 console.log(JSON.stringify({event:'movingFeatureCachePhase',sample:sample.name,mode,startedAt:new Date().toISOString(),deadlineSeconds}));
 const began=performance.now();
 const child=spawn(owner,['--mask-job',python,join(experiment,mode==='baseline'?'feature-baseline-worker.py':'feature-cache-worker.py'),
  requestFile,runtime,ff,String(deadlineSeconds),'8'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',expired=false,overflow=false;
 const timer=setTimeout(()=>{expired=true;child.kill();},deadlineSeconds*1000+5000);
 const progress=setInterval(()=>{
  const frames=[...stdout.matchAll(/^frame=(\d+)\r?$/gm)];
  console.log(JSON.stringify({event:'movingFeatureCacheProgress',sample:sample.name,mode,
   seconds:Math.round((performance.now()-began)/1000),ownedFrames:Number(frames.at(-1)?.[1]??0)}));
 },30000);
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>4*1024**2){overflow=true;child.kill();}});
 child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>4*1024**2){overflow=true;child.kill();}});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>{clearTimeout(timer);clearInterval(progress);});
 const wallSeconds=(performance.now()-began)/1000;
 await writeEvidenceArtifact(directory,`${sample.name}/${mode}-stdout.txt`,Buffer.from(stdout));
 await writeEvidenceArtifact(directory,`${sample.name}/${mode}-stderr.txt`,Buffer.from(stderr));
 assert.equal(expired,false);assert.equal(overflow,false);assert.equal(code,0,`${sample.name}/${mode}: ${stderr.slice(-3000)}`);
 assert.match(stderr,/"event":"maskJobFinished"/);assert.match(stdout,/progress=end/);
 const manifest=JSON.parse(await readEvidenceFile(join(destination,'manifest.json')));
 const diagnostic=JSON.parse(await readEvidenceFile(join(destination,'encoder-diagnostic.json')));
 assert.equal(manifest.complete,true);assert.equal(manifest.frames,100);assert.equal(manifest.windows,8);
 assert.equal(manifest.maximumDecodedFrames,16);assert.equal(manifest.heldOutSeamFrames,21);
 assert.deepEqual(manifest.handoffSeedFrames,[12,24,36,48,60,72,84]);
 assert.equal(manifest.subjectQualityAccepted,false);assert.equal(diagnostic.qualityAccepted,false);assert.equal(diagnostic.exportQualified,false);
 assert.equal(manifest.device,'cpu');assert.equal(diagnostic.cache.integrityChecksPassed,true);
 assert.ok(manifest.peakWorkingSetBytes>0&&manifest.peakWorkingSetBytes<=4*1024**3);
 assert.equal(diagnostic.entryLimit,4);assert.equal(diagnostic.windows.length,8);assert.equal(diagnostic.visits.length,128);
 assert.deepEqual(diagnostic.inputIdentities.map(item=>item.globalFrame),Array.from({length:100},(_,index)=>index),
  'All global pictures must be bound; genuinely duplicate picture bytes remain legal');
 const artifacts={};for(const file of ['masks.pgmask','reference-mask.png','manifest.json','encoder-diagnostic.json'])artifacts[file]=await hash(join(destination,file));
 assert.equal(artifacts['masks.pgmask'],manifest.mask.sha256);
 console.log(JSON.stringify({event:'movingFeatureCacheJobFinished',sample:sample.name,mode,wallSeconds,
  encoderCalls:diagnostic.cache.encoderCalls,hits:diagnostic.cache.hits,peakBytes:manifest.peakWorkingSetBytes}));
 return {manifest,diagnostic,artifacts,wallSeconds};
}

const comparisons=[];
for(const sample of samples){
 const baseline=await run(sample,'baseline');
 // Preserve a terminal result even if a later candidate or sample fails.
 await writeEvidenceArtifact(directory,`${sample.name}/baseline-evidence.json`,Buffer.from(JSON.stringify(baseline,null,2)));
 const candidate=await run(sample,'candidate');
 await writeEvidenceArtifact(directory,`${sample.name}/candidate-evidence.json`,Buffer.from(JSON.stringify(candidate,null,2)));
 const ignored=new Set(['peakWorkingSetBytes','decodeSeconds','inferenceSeconds','secondsIncludingLoad']);
 const stable=manifest=>Object.fromEntries(Object.entries(manifest).filter(([key])=>!ignored.has(key)));
 assert.deepEqual(stable(candidate.manifest),stable(baseline.manifest),'Moving-footage manifest/ownership/seams differ');
 assert.deepEqual(stable(baseline.manifest),stable(sample.oldManifest),'Fresh unmodified generator differs from retained public result');
 assert.deepEqual(candidate.diagnostic.visits,baseline.diagnostic.visits,'Corresponding moving-footage logits/stored compact output differ');
 assert.deepEqual(candidate.diagnostic.inputIdentities,baseline.diagnostic.inputIdentities);
 assert.deepEqual(candidate.diagnostic.windows,baseline.diagnostic.windows);
 assert.equal(candidate.artifacts['masks.pgmask'],baseline.artifacts['masks.pgmask']);
 assert.equal(candidate.artifacts['masks.pgmask'],sample.retainedPins[sample.oldMaskPath]);
 assert.equal(candidate.artifacts['reference-mask.png'],baseline.artifacts['reference-mask.png']);
 assert.equal(candidate.artifacts['reference-mask.png'],sample.retainedPins[sample.oldReference]);
 assert.equal(baseline.diagnostic.cache.encoderCalls,128);assert.equal(candidate.diagnostic.cache.encoderCalls,100);
 const expectedHits=[];for(const [window,start] of [[1,12],[2,24],[3,36],[4,48],[5,60],[6,72],[7,84]])
  for(let frame=start;frame<start+4;frame++)expectedHits.push({window,globalFrame:frame});
 assert.deepEqual(candidate.diagnostic.cache.hitFrames,expectedHits);assert.equal(candidate.diagnostic.cache.hits,28);
 assert.equal(candidate.diagnostic.cache.maximumEntries,4);assert.equal(candidate.diagnostic.cache.maximumStorageBytes,400*1024**2);
 assert.equal(candidate.diagnostic.cache.evictions,24,'Consumed incoming features must be replaced without growing retention');
 assert.ok(candidate.diagnostic.cache.maximumStorageBytes<=candidate.diagnostic.persistentByteLimit);
 assert.ok(candidate.diagnostic.admissionEstimateIncludingCacheBytes<=4*1024**3);
 for(const [path,digest] of Object.entries(sample.retainedPins))assert.equal(await hash(path),digest,'Retained media/request/mask changed');
 const comparison={name:sample.name,subjectScope:sample.subjectScope,baseline,candidate,
  retainedPins:sample.retainedPins,parity:{correspondingLogitsAndStoredCompactOutput:true,maskAndReferenceBytes:true,
   retainedUnmodifiedMask:true,canonicalRecipeIdentitySeamsAndOwnership:true},
  limits:'Fixed two-second normalized original, not a stabilized Quality base or continuous close-up/bokeh acceptance. Origin-zero reference; reverse/corrections covered separately by synthetic differential.'};
 comparisons.push(comparison);
 await writeEvidenceArtifact(directory,`${sample.name}/comparison.json`,Buffer.from(JSON.stringify(comparison,null,2)));
 console.log(JSON.stringify({event:'movingFeatureCacheComparisonPassed',sample:sample.name,qualityAccepted:false,exportQualified:false}));
}
for(const name of inputs)assert.equal(await hash(resolve(name)),pins[name],`Changed harness/model/tool input: ${name}`);
const receipt={schema:1,diagnosticOnly:true,pins,comparisons,qualityAccepted:false,exportQualified:false,
 limits:'One instrumented sequential baseline/candidate pair per retained moving-footage sample. No statistical speed, full-clip quality, NVIDIA, installer or app-export approval.'};
await writeEvidenceArtifact(directory,'receipt.json',Buffer.from(JSON.stringify(receipt,null,2)));
console.log(JSON.stringify({event:'movingFeatureCacheFinished',directory,passed:true,qualityAccepted:false,exportQualified:false}));
