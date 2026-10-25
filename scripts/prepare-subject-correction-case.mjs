// Private, bounded retained-footage preparation. No dependency acquisition,
// runtime replacement, original writes, app admission or release promotion.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assertEvidenceAncestry,readEvidenceFile,evidenceDigest,writeEvidenceArtifact,storeEvidenceFile} from './subject-finishing/runtime/evidence-files.mjs';

const runtime=resolve('.build-cache/subject-finishing-manual-cpu-v1');
const oldManifest=join(runtime,'runtime-manifest.json');
const oldSeal='3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78';
const owner=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const probe=ff.replace('ffmpeg.exe','ffprobe.exe');
const retained=resolve('test-output/subject-footage-evaluation-1791597148390/black-horse/bounded-normalized-excerpt.mp4');
const scripts=['subject_mask_worker.py','subject_mask_job.py','subject_masks_contract.py','subject_mask_cache.py','subject_media_contract.py','subject_process.py'];
function run(binary,args,timeout=30000){
 const result=spawnSync(binary,args,{windowsHide:true,timeout,maxBuffer:16*1024**2});
 assert.equal(result.error,undefined);assert.equal(result.status,0,String(result.stderr??'').slice(-4000));
 return result.stdout;
}
await assertEvidenceAncestry(runtime);await assertEvidenceAncestry(resolve('test-output'));
assert.equal(evidenceDigest(await readEvidenceFile(oldManifest)),oldSeal);
const originalBase=await readEvidenceFile(retained,128*1024**2);
assert.equal(evidenceDigest(originalBase),'e252b692c87d81e56d6f8c1f38541ea3bb3bd184ac70cb501aba5ce364dca59a');
assert.equal(evidenceDigest(await readEvidenceFile(owner)),'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d');
assert.equal(evidenceDigest(await readEvidenceFile(ff,128*1024**2)),'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630');
const toolHashes={ffmpeg:evidenceDigest(await readEvidenceFile(ff,128*1024**2)),ffprobe:evidenceDigest(await readEvidenceFile(probe,128*1024**2))};
const output=await mkdtemp(join(resolve('test-output'),'subject-real-correction-'));
await storeEvidenceFile(owner,output,'photogogo-subject-finishing.exe');
const runner=[];
for(const name of scripts)runner.push(await storeEvidenceFile(resolve('src-tauri/scripts',name),output,'runner/'+name));
assert.match((await readEvidenceFile(join(output,'runner/subject_masks_contract.py'))).toString('utf8'),/fixed-two-id-object-reacquisition-seam-v3/);
const sealFile=join(output,'private-evaluation-runtime-manifest-v3.json');
const sealed=JSON.parse(run(join(runtime,'runtime/python.exe'),['-I','-S','-B',resolve('scripts/seal-subject-runtime.py'),'--root',runtime,'--runner',join(output,'runner'),'--output',sealFile],120000).toString('utf8'));
assert.equal(sealed.qualificationCandidate,true);
const sealBytes=await readEvidenceFile(sealFile,8*1024**2);assert.equal(evidenceDigest(sealBytes),sealed.sha256);
const seal=JSON.parse(sealBytes);assert.equal(seal.profile,'manual-video-cpu-v1');assert.equal(seal.qualificationCandidate,true);
for(const file of runner){const entry=seal.files.find(item=>item.path===file.path);assert.ok(entry);assert.equal(entry.sha256,file.sha256);assert.equal(entry.bytes,file.bytes);}
const base=join(output,'bounded-picture-base.mp4');
// Exact source ordinals 30..55; no seeking or uncertain keyframe copy.
run(ff,['-v','error','-nostdin','-n','-threads','2','-i',retained,'-map','0:v:0','-an','-vf',
 'select=between(n\\,30\\,55),setpts=N/(50*TB),format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
 '-filter_threads','1','-frames:v','26','-c:v','libx264','-preset','veryfast','-threads','4','-bf','0','-b:v','40M',
 '-pix_fmt','yuv420p','-color_range','tv','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
 '-map_metadata','-1','-write_tmcd','0','-video_track_timescale','90000',base],60000);
const streams=JSON.parse(run(probe,['-v','error','-show_streams','-of','json',base]).toString('utf8')).streams;
assert.equal(streams.length,1);const video=streams[0];
assert.equal(video.codec_type,'video');assert.equal(video.nb_frames,'26');assert.equal(video.width,3840);assert.equal(video.height,2160);
assert.equal(video.r_frame_rate,'50/1');assert.equal(video.avg_frame_rate,'50/1');assert.equal(video.sample_aspect_ratio,'1:1');
assert.equal(video.pix_fmt,'yuv420p');assert.equal(video.color_range,'tv');assert.equal(video.field_order,'progressive');
for(const name of ['color_primaries','color_transfer','color_space'])assert.equal(video[name],'bt709');
const baseBytes=await readEvidenceFile(base,16*1024**2),baseIdentity=createHash('md5').update(baseBytes).digest('hex');
for(const frame of [0,3,5]){
 const png=run(ff,['-v','error','-nostdin','-threads','2','-i',base,'-an','-vf','select=eq(n\\,'+frame+'),scale=960:540',
 '-filter_threads','1','-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1']);
 await writeEvidenceArtifact(output,'reference-'+frame+'.png',png);
}
assert.equal(evidenceDigest(await readEvidenceFile(retained,128*1024**2)),evidenceDigest(originalBase));
assert.equal(evidenceDigest(await readEvidenceFile(oldManifest)),oldSeal);
for(const item of runner)assert.equal(evidenceDigest(await readEvidenceFile(resolve('src-tauri/scripts',item.path.split('/').at(-1)))),item.sha256);
const receipt={schema:1,output,runtimeRoot:runtime,oldSeal,privateCandidateSeal:sealed.sha256,privateCandidateFiles:sealed.files,
 runner,tools:toolHashes,base:{path:base,sha256:evidenceDigest(baseBytes),baseIdentity,frames:26,width:3840,height:2160,fps:50},
 retainedBase:{path:retained,sha256:evidenceDigest(originalBase),sourceOrdinals:[30,55],unchanged:true},
 policy:'fixed-two-id-object-reacquisition-seam-v3',dependenciesReused:true,oldRuntimeManifestUnchanged:true,
 inferenceExecuted:false,appRuntimeAdmitted:false,continuousPlaybackReviewed:false,subjectQualityAccepted:false,exportQualified:false,
 limits:'Private separately identified v3 application runner over unchanged pinned CPU dependencies. Candidate manifest is not installed or admitted by the app. New 26-frame picture-only excerpt is a second-generation normalized original, not a stabilized base or audio/export qualification.'};
await writeEvidenceArtifact(output,'preparation.json',Buffer.from(JSON.stringify(receipt,null,2)));
console.log(JSON.stringify({output,baseIdentity,privateCandidateSeal:sealed.sha256,privateCandidateFiles:sealed.files,frames:26,inferenceExecuted:false,appRuntimeAdmitted:false}));
