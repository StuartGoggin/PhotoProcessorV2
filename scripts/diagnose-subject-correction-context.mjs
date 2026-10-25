// Exact retained-picture/public owned-job experiment. Only the frame-3 horse
// box varies. Does not install/admit a runtime or qualify correction/quality.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readEvidenceFile,evidenceDigest,assertEvidenceAncestry,storeEvidenceFile,writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

const mode=process.argv[2];assert.ok(process.argv.length===3&&['point-only','box-point'].includes(mode));
const retained=resolve('test-output/subject-real-correction-ZBFTss');
const preparation=JSON.parse(await readEvidenceFile(join(retained,'preparation.json')));
assert.equal(preparation.output,retained);assert.equal(preparation.appRuntimeAdmitted,false);
const runtime=preparation.runtimeRoot,python=join(runtime,'runtime/python.exe');
const base=join(retained,'bounded-picture-base.mp4');
const baseline=join(retained,'baseline.partial/masks.pgmask');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const oldManifest=join(runtime,'runtime-manifest.json'),deadlineSeconds=480;
const baseSha='691c0021da1f24ac6ff1d7b3bfbbbb527951e19efbeb4c13644663e1f22a01d1';
const baselineSha='63d16f8153ee1757a6b762130ff3d32788f4ebb0921584028370cb631a49b33f';
const ownerSource=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const ownerSha='db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d';
const scripts=['subject_mask_worker.py','subject_mask_job.py','subject_masks_contract.py','subject_mask_cache.py','subject_media_contract.py','subject_process.py'];
const testOutput=resolve('test-output');await assertEvidenceAncestry(testOutput);
assert.equal(evidenceDigest(await readEvidenceFile(oldManifest)),preparation.oldSeal);
assert.equal(evidenceDigest(await readEvidenceFile(base,16*1024**2)),baseSha);
assert.equal(evidenceDigest(await readEvidenceFile(baseline,32*1024**2)),baselineSha);
assert.equal(evidenceDigest(await readEvidenceFile(ownerSource)),ownerSha);
assert.equal(evidenceDigest(await readEvidenceFile(ff,128*1024**2)),preparation.tools.ffmpeg);
assert.equal(evidenceDigest(await readEvidenceFile(ff.replace('ffmpeg.exe','ffprobe.exe'),128*1024**2)),preparation.tools.ffprobe);
const output=await mkdtemp(join(testOutput,'subject-correction-context-'+mode+'-'));
const owner=join(output,'photogogo-subject-finishing.exe');await storeEvidenceFile(ownerSource,output,'photogogo-subject-finishing.exe');
const runner=[];for(const name of scripts)runner.push(await storeEvidenceFile(resolve('src-tauri/scripts',name),output,'runner/'+name));
assert.match((await readEvidenceFile(join(output,'runner/subject_mask_job.py'))).toString(),/IoU \{score:\.4f\}/);
function inventory(phase){
 const check=spawnSync(python,['-I','-S','-B',resolve('scripts/seal-subject-runtime.py'),'--root',runtime,'--runner',join(output,'runner'),
  '--output',join(output,'inventory-'+phase+'.json')],{windowsHide:true,timeout:120000,maxBuffer:1024**2});
 assert.equal(check.error,undefined);assert.equal(check.status,0,String(check.stderr??'').slice(-2000));
 const seal=JSON.parse(check.stdout.toString());assert.equal(seal.files,16536);assert.equal(seal.qualificationCandidate,true);return seal;
}
const before=inventory('before');
const point={x:.36875,y:.8148148148148148,include:true};
const correction={frame:3,object:'horse',points:[point]};
// Manually inspected frame-3 whole-horse extent, not an inherited frame-0 box.
if(mode==='box-point')correction.box=[.335,.25,.60,.94];
const selection={version:1,baseIdentity:'5af92517a972a2aff299a6f856d1f30d',frameCount:26,referenceFrame:0,
 anchors:[{frame:0,object:'horse',box:[.345,.22,.59,.92]},{frame:0,object:'rider',box:[.375,.10,.51,.71]},correction]};
const request={version:1,sourcePath:base,baseChecksum:selection.baseIdentity,width:3840,height:2160,fps:50,
 frameCount:26,windowFrames:16,overlapFrames:4,destinationPath:join(output,'masks.partial'),selection};
await writeEvidenceArtifact(output,'request.json',Buffer.from(JSON.stringify(request)));
await writeEvidenceArtifact(output,'input-binding.json',Buffer.from(JSON.stringify({schema:1,mode,baseSha,baselineSha,ownerSha,
 privateCandidateSeal:before.sha256,privateCandidateFiles:before.files,runner,tools:preparation.tools,
 policyUnchanged:'fixed-two-id-object-reacquisition-seam-v3',point,wholeHorseBox:correction.box??null,
 appRuntimeAdmitted:false,subjectQualityAccepted:false,exportQualified:false},null,2)));
let stdout='',stderr='',overflow=false,expired=false;
const began=performance.now();console.log(JSON.stringify({event:'contextStarted',mode,output,candidate:before.sha256,deadlineSeconds}));
const child=spawn(owner,['--mask-job',python,join(output,'runner/subject_mask_worker.py'),join(output,'request.json'),runtime,ff,
 String(deadlineSeconds),'8'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const timer=setTimeout(()=>{expired=true;child.kill();},(deadlineSeconds+5)*1000);
const progress=setInterval(()=>console.log(JSON.stringify({event:'contextProgress',mode,seconds:Math.round((performance.now()-began)/1000),
 ownedFrames:Number([...stdout.matchAll(/^frame=(\d+)\r?$/gm)].at(-1)?.[1]??0)})),30000);
child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>4*1024**2){overflow=true;child.kill();}});
child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>4*1024**2){overflow=true;child.kill();}});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>{clearTimeout(timer);clearInterval(progress);});
const wallSeconds=(performance.now()-began)/1000;
await writeEvidenceArtifact(output,'stdout.txt',Buffer.from(stdout));await writeEvidenceArtifact(output,'stderr.txt',Buffer.from(stderr));
assert.equal(expired,false);assert.equal(overflow,false);const after=inventory('after');assert.equal(after.sha256,before.sha256);
assert.equal(evidenceDigest(await readEvidenceFile(base,16*1024**2)),baseSha);
assert.equal(evidenceDigest(await readEvidenceFile(baseline,32*1024**2)),baselineSha);
assert.equal(evidenceDigest(await readEvidenceFile(oldManifest)),preparation.oldSeal);
for(const entry of runner)assert.equal(evidenceDigest(await readEvidenceFile(resolve('src-tauri/scripts',entry.path.split('/').at(-1)))),entry.sha256);
const frozen=JSON.parse(await readEvidenceFile(oldManifest,8*1024**2));
for(const file of frozen.files.filter(file=>file.path.startsWith('runner/')))
 assert.equal(evidenceDigest(await readEvidenceFile(resolve('src-tauri/tools/subject-finishing',file.path))),file.sha256);
const result={schema:1,mode,output,code,wallSeconds,completed:false,manifest:null,maskComparison:null,
 candidateSeal:before.sha256,inputsUnchanged:true,oldRuntimeUnchanged:true,appRuntimeAdmitted:false,
 continuousPlaybackReviewed:false,correctionEffectivenessAccepted:false,subjectQualityAccepted:false,exportQualified:false};
if(code===0){
 const manifest=JSON.parse(await readEvidenceFile(join(request.destinationPath,'manifest.json')));
 const generation=[1,'proxy-max1024-jpeg-q2-v1','fp32-cpu-offload-v1',16,4,'fixed-two-id-object-reacquisition-seam-v3',.6,.25,'inward-erode5-blur1-nearest-v1'];
 const recipe=[1,'sam2.1-tiny-two-object-window-v1','7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69',
  selection.baseIdentity,26,3840,2160,generation,0,selection.anchors.map(a=>[a.frame,a.object,a.box??null,(a.points??[]).map(p=>[p.x,p.y,p.include])])];
 assert.equal(manifest.canonicalRecipe,JSON.stringify(recipe));assert.equal(manifest.maskIdentity,evidenceDigest(Buffer.from(manifest.canonicalRecipe)));
 assert.deepEqual(manifest.selection,selection);assert.deepEqual(manifest.generationProfile,generation);
 assert.equal(manifest.complete,true);assert.equal(manifest.frames,26);assert.equal(manifest.width,3840);assert.equal(manifest.height,2160);
 assert.equal(manifest.fps,50);assert.equal(manifest.profile,'limited-sdr709-yuv420p8');assert.equal(manifest.device,'cpu');
 assert.equal(manifest.windows,2);assert.deepEqual(manifest.handoffSeedFrames,[12]);assert.equal(manifest.heldOutSeamFrames,3);
 assert.ok(manifest.peakWorkingSetBytes>0&&manifest.peakWorkingSetBytes<=4*1024**3);assert.equal(manifest.subjectQualityAccepted,false);
 assert.deepEqual([...stdout.matchAll(/^frame=(\d+)\r?$/gm)].map(m=>Number(m[1])),Array.from({length:26},(_,i)=>i+1));
 assert.deepEqual([...stdout.matchAll(/^out_time_us=(\d+)\r?$/gm)].map(m=>Number(m[1])),Array.from({length:26},(_,i)=>(i+1)*20000));
 assert.equal([...stdout.matchAll(/^progress=end\r?$/gm)].length,1);assert.match(stderr,/"event":"maskJobFinished"/);
 assert.deepEqual(stdout.trim().split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)),[manifest]);
 const mask=await readEvidenceFile(join(request.destinationPath,'masks.pgmask'),32*1024**2);
 assert.equal(evidenceDigest(mask),manifest.mask.sha256);assert.equal(mask.length,manifest.mask.bytes);
 function inflate(bytes){
  assert.equal(bytes.subarray(0,8).toString('ascii'),'PGMSK001');assert.equal(bytes.readUInt32LE(8),1024);
  assert.equal(bytes.readUInt32LE(12),576);assert.equal(bytes.readUInt32LE(16),26);let at=20;const frames=[];
  for(let frame=0;frame<26;frame++){
   assert.ok(at+4<=bytes.length);const length=bytes.readUInt32LE(at);at+=4;assert.ok(length>0&&length%5===0&&at+length<=bytes.length);
   let written=0;const alpha=Buffer.alloc(1024*576);
   for(let offset=at;offset<at+length;offset+=5){const count=bytes.readUInt32LE(offset);assert.ok(count>0&&written+count<=alpha.length);
    alpha.fill(bytes[offset+4],written,written+count);written+=count;}
   assert.equal(written,alpha.length);at+=length;frames.push(alpha);
  }
  assert.equal(at,bytes.length);return frames;
 }
 const actual=inflate(mask),original=inflate(await readEvidenceFile(baseline,32*1024**2)),comparisons=[];
 const pointPixel=Math.floor(point.y*576)*1024+Math.floor(point.x*1024);assert.equal(original[3][pointPixel],14);
 for(let frame=0;frame<26;frame++){
  let changed=0,increased=0,decreased=0,occupied=0,sum=0;
  for(let pixel=0;pixel<1024*576;pixel++){
   changed+=Number(actual[frame][pixel]!==original[frame][pixel]);increased+=Number(actual[frame][pixel]>original[frame][pixel]);
   decreased+=Number(actual[frame][pixel]<original[frame][pixel]);occupied+=Number(actual[frame][pixel]>0);sum+=actual[frame][pixel];
  }
  assert.ok(occupied>0&&occupied<1024*576);comparisons.push({frame,changedPixels:changed,increasedAlphaPixels:increased,decreasedAlphaPixels:decreased,
   occupiedPixels:occupied,meanAlpha:sum/(1024*576),fixedPointAlphaBefore:original[frame][pointPixel],fixedPointAlphaAfter:actual[frame][pointPixel]});
 }
 result.completed=true;result.manifest=manifest;result.maskComparison=comparisons;
}else{
 assert.equal(code,1,'Only the expected diagnostic refusal is an interpretable negative result');
 assert.doesNotMatch(stdout,/progress=end/);
 for(const file of ['manifest.json','masks.pgmask'])await assert.rejects(lstat(join(request.destinationPath,file)),{code:'ENOENT'});
 result.refusal=stderr.match(/Abrupt subject-mask change at frame \d+ \((?:horse|rider), (?:forward|reverse), IoU [\d.]+\)/)?.[0]??null;
 assert.ok(result.refusal,'An unexpected error is not the captured quality refusal');
}
await writeEvidenceArtifact(output,'result.json',Buffer.from(JSON.stringify(result,null,2)));
console.log(JSON.stringify({event:'contextFinished',mode,output,completed:result.completed,refusal:result.refusal??null,
 secondsIncludingLoad:result.manifest?.secondsIncludingLoad??null,pointFrameComparison:result.maskComparison?.[3]??null,subjectQualityAccepted:false}));
