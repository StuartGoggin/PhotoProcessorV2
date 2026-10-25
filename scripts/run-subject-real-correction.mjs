// One fixed privately prepared mounted-horse case through the owned mask seam.
// No app admission, dependency acquisition, runtime replacement or export.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {readEvidenceFile,evidenceDigest,writeEvidenceArtifact,assertEvidenceAncestry} from './subject-finishing/runtime/evidence-files.mjs';

const requestedMode=process.argv[2],verifyOnly=requestedMode==='verify-baseline';
assert.ok(process.argv.length===3&&['baseline','horse-correction','verify-baseline'].includes(requestedMode),'Only fixed bounded modes are supported');
const mode=verifyOnly?'baseline':requestedMode;
const folder=resolve('test-output/subject-real-correction-ZBFTss');
const preparation=JSON.parse(await readEvidenceFile(join(folder,'preparation.json')));
assert.equal(preparation.output,folder);assert.equal(preparation.base.frames,26);assert.equal(preparation.base.fps,50);
assert.equal(preparation.privateCandidateSeal,'80c08e8911e9d948ca3b59a42ce38e171a87f825c8a5536f578ae0a37825622b');
assert.equal(preparation.appRuntimeAdmitted,false);assert.equal(preparation.exportQualified,false);
const python=join(preparation.runtimeRoot,'runtime/python.exe');
const owner=join(folder,'photogogo-subject-finishing.exe');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const probe=ff.replace('ffmpeg.exe','ffprobe.exe');
const oldManifest=join(preparation.runtimeRoot,'runtime-manifest.json');
const base=preparation.base.path,deadlineSeconds=480;
async function unchangedInputs(){
 await assertEvidenceAncestry(folder);await assertEvidenceAncestry(preparation.runtimeRoot);
 assert.equal(evidenceDigest(await readEvidenceFile(oldManifest)),preparation.oldSeal);
 assert.equal(evidenceDigest(await readEvidenceFile(base,16*1024**2)),preparation.base.sha256);
 assert.equal(evidenceDigest(await readEvidenceFile(owner)),'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d');
 assert.equal(evidenceDigest(await readEvidenceFile(ff,128*1024**2)),preparation.tools.ffmpeg);
 assert.equal(evidenceDigest(await readEvidenceFile(probe,128*1024**2)),preparation.tools.ffprobe);
 for(const entry of preparation.runner)assert.equal(evidenceDigest(await readEvidenceFile(join(folder,entry.path))),entry.sha256);
 const oldSeal=JSON.parse(await readEvidenceFile(oldManifest,8*1024**2));
 for(const entry of oldSeal.files.filter(file=>file.path.startsWith('runner/'))){
  assert.equal(evidenceDigest(await readEvidenceFile(resolve('src-tauri/tools/subject-finishing',entry.path))),entry.sha256);
 }
}
function verifyDependencyInventory(phase){
 const path=join(folder,mode+'-inventory-'+phase+'.json');
 const check=spawnSync(python,['-I','-S','-B',resolve('scripts/seal-subject-runtime.py'),'--root',preparation.runtimeRoot,
  '--runner',join(folder,'runner'),'--output',path],{windowsHide:true,timeout:120000,maxBuffer:1024**2});
 assert.equal(check.error,undefined);assert.equal(check.status,0,String(check.stderr??'').slice(-2000));
 const verified=JSON.parse(check.stdout.toString('utf8'));assert.equal(verified.sha256,preparation.privateCandidateSeal);
 assert.equal(verified.files,preparation.privateCandidateFiles);return verified;
}
await unchangedInputs();
if(!verifyOnly)verifyDependencyInventory('before');
else for(const phase of ['before','after']){
 const inventory=await readEvidenceFile(join(folder,mode+'-inventory-'+phase+'.json'),8*1024**2);
 assert.equal(evidenceDigest(inventory),preparation.privateCandidateSeal);
}
const anchors=[{frame:0,object:'horse',box:[.345,.22,.59,.92]},
 {frame:0,object:'rider',box:[.375,.10,.51,.71]}];
// This literal include point was chosen from reference-3.png after inspecting
// the completed baseline: the visible hind-leg shaft at preview (354,440) has
// final alpha 14. It may remain excluded by inward fringe protection; this
// experiment must not assert improved coverage merely because a prompt changed.
if(mode==='horse-correction'){
 const baseline=JSON.parse(await readEvidenceFile(join(folder,'baseline-result.json')));
 assert.equal(baseline.manifest.maskIdentity,'318683982929984425f958f3d40651082a6816ecd34598195b58452d7f2a2687');
 assert.equal(baseline.manifest.mask.sha256,'63d16f8153ee1757a6b762130ff3d32788f4ebb0921584028370cb631a49b33f');
 assert.equal(baseline.subjectQualityAccepted,false);
 anchors.push({frame:3,object:'horse',points:[{x:.36875,y:.8148148148148148,include:true}]});
}
const selection={version:1,baseIdentity:preparation.base.baseIdentity,frameCount:26,referenceFrame:0,anchors};
const request={version:1,sourcePath:base,baseChecksum:preparation.base.baseIdentity,width:3840,height:2160,fps:50,
 frameCount:26,windowFrames:16,overlapFrames:4,destinationPath:join(folder,mode+'.partial'),selection};
const requestName=mode+'-request.json';
let stdout='',stderr='',wallSeconds=null;
if(verifyOnly){
 assert.deepEqual(JSON.parse(await readEvidenceFile(join(folder,requestName))),request);
 stdout=(await readEvidenceFile(join(folder,mode+'-stdout.txt'))).toString('utf8');
 stderr=(await readEvidenceFile(join(folder,mode+'-stderr.txt'))).toString('utf8');
}else{
await writeEvidenceArtifact(folder,requestName,Buffer.from(JSON.stringify(request)));
const began=performance.now();
console.log(JSON.stringify({event:'realCorrectionPhase',mode,frames:26,deadlineSeconds,startedAt:new Date().toISOString(),appRuntimeAdmitted:false}));
const child=spawn(owner,['--mask-job',python,join(folder,'runner/subject_mask_worker.py'),join(folder,requestName),
 preparation.runtimeRoot,ff,String(deadlineSeconds),'8'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let expired=false,overflow=false;
const timer=setTimeout(()=>{expired=true;child.kill();},deadlineSeconds*1000+5000);
const progress=setInterval(()=>{
 const frames=[...stdout.matchAll(/^frame=(\d+)\r?$/gm)];
 console.log(JSON.stringify({event:'realCorrectionProgress',mode,seconds:Math.round((performance.now()-began)/1000),ownedFrames:Number(frames.at(-1)?.[1]??0)}));
},30000);
child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>4*1024**2){overflow=true;child.kill();}});
child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>4*1024**2){overflow=true;child.kill();}});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>{clearTimeout(timer);clearInterval(progress);});
await writeEvidenceArtifact(folder,mode+'-stdout.txt',Buffer.from(stdout));
await writeEvidenceArtifact(folder,mode+'-stderr.txt',Buffer.from(stderr));
await unchangedInputs();verifyDependencyInventory('after');
assert.equal(expired,false);assert.equal(overflow,false);assert.equal(code,0,stderr.slice(-3000));
wallSeconds=(performance.now()-began)/1000;
}
assert.match(stdout,/progress=end/);assert.match(stderr,/"event":"maskJobFinished"/);
const manifest=JSON.parse(await readEvidenceFile(join(request.destinationPath,'manifest.json')));
assert.equal(manifest.complete,true);assert.equal(manifest.frames,26);assert.equal(manifest.windows,2);
assert.deepEqual(manifest.handoffSeedFrames,[12]);assert.equal(manifest.maximumDecodedFrames,16);
assert.equal(manifest.heldOutSeamFrames,3);assert.equal(manifest.subjectQualityAccepted,false);
assert.equal(manifest.device,'cpu');assert.ok(manifest.peakWorkingSetBytes>0&&manifest.peakWorkingSetBytes<=4*1024**3);
// Literal case contract, independent of the runner that emitted the receipt.
// A single policy-index check missed both the old index error and other recipe
// drift. Preserve the original terminal artifacts and revalidate their binding.
const engine='sam2.1-tiny-two-object-window-v1';
const generation=[1,'proxy-max1024-jpeg-q2-v1','fp32-cpu-offload-v1',16,4,
 'fixed-two-id-object-reacquisition-seam-v3',.6,.25,'inward-erode5-blur1-nearest-v1'];
const expectedRecipe=[1,engine,'7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69',
 preparation.base.baseIdentity,26,3840,2160,generation,0,
 anchors.map(anchor=>[anchor.frame,anchor.object,anchor.box??null,
  (anchor.points??[]).map(point=>[point.x,point.y,point.include])])];
assert.equal(manifest.canonicalRecipe,JSON.stringify(expectedRecipe));
assert.equal(evidenceDigest(Buffer.from(manifest.canonicalRecipe)),manifest.maskIdentity);
assert.deepEqual(manifest.generationProfile,generation);assert.equal(manifest.engine,engine);
assert.equal(manifest.width,3840);assert.equal(manifest.height,2160);assert.equal(manifest.fps,50);
assert.equal(manifest.profile,'limited-sdr709-yuv420p8');
assert.deepEqual(manifest.selection,selection);assert.equal(manifest.baseChecksum,preparation.base.baseIdentity);
assert.deepEqual([...stdout.matchAll(/^frame=(\d+)\r?$/gm)].map(match=>Number(match[1])),
 Array.from({length:26},(_,index)=>index+1));
assert.deepEqual([...stdout.matchAll(/^out_time_us=(\d+)\r?$/gm)].map(match=>Number(match[1])),
 Array.from({length:26},(_,index)=>(index+1)*20000));
assert.equal([...stdout.matchAll(/^progress=end\r?$/gm)].length,1);
const terminalManifest=stdout.trim().split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
assert.deepEqual(terminalManifest,[manifest]);
assert.equal(manifest.mask.width,1024);assert.equal(manifest.mask.height,576);assert.equal(manifest.mask.frames,26);
assert.equal(manifest.mask.format,'PGMSK001');
const mask=await readEvidenceFile(join(request.destinationPath,'masks.pgmask'),32*1024**2);
assert.equal(evidenceDigest(mask),manifest.mask.sha256);assert.equal(mask.length,manifest.mask.bytes);
assert.equal(mask.subarray(0,8).toString('ascii'),'PGMSK001');
assert.equal(mask.readUInt32LE(8),1024);assert.equal(mask.readUInt32LE(12),576);assert.equal(mask.readUInt32LE(16),26);
let offset=20;const finalAlpha=[];
for(let frame=0;frame<26;frame++){
 assert.ok(offset+4<=mask.length);const length=mask.readUInt32LE(offset);offset+=4;
 assert.ok(length>0&&length%5===0&&offset+length<=mask.length);
 let written=0,occupied=0,sum=0;
 for(let runAt=offset;runAt<offset+length;runAt+=5){
  const count=mask.readUInt32LE(runAt),alpha=mask[runAt+4];assert.ok(count>0&&written+count<=1024*576);
  written+=count;occupied+=alpha>0?count:0;sum+=count*alpha;
 }
 assert.equal(written,1024*576);assert.ok(occupied>0&&occupied<1024*576&&sum>0);
 finalAlpha.push({frame,occupiedPixels:occupied,meanAlpha:sum/(1024*576)});offset+=length;
}
assert.equal(offset,mask.length);
const result={schema:1,mode,request,manifest,wallSeconds,validationRecoveredWithoutInference:verifyOnly,
 finalAlpha,nonemptyFinalTreatmentVerified:true,separateObjectCoverageVerified:false,
 dependencyInventoryScope:verifyOnly?'Historical before/after inventories; current source, runner and tool checks':'Fresh before/after full candidate inventories',
 sourceUnchanged:true,oldRuntimeUnchanged:true,privateRunnerVerified:true,dependenciesReused:true,
 appRuntimeAdmitted:false,continuousPlaybackReviewed:false,subjectQualityAccepted:false,exportQualified:false,
 limits:'One privately source-bound 26-frame picture-only CPU job. No application UI/runtime admission, audio, NVIDIA, temporal attractiveness or release acceptance.'};
await writeEvidenceArtifact(folder,mode+'-result.json',Buffer.from(JSON.stringify(result,null,2)));
console.log(JSON.stringify({event:'realCorrectionFinished',mode,frames:manifest.frames,wallSeconds:result.wallSeconds,
 minimumSeamIoU:manifest.minimumSeamIoU,peakWorkingSetBytes:manifest.peakWorkingSetBytes,appRuntimeAdmitted:false,subjectQualityAccepted:false}));
