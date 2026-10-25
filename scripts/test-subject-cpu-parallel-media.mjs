// Existing media-worker boundary: bounded CPU concurrency must preserve the serial pictures/audio.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, stat} from 'node:fs/promises';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {assertEvidenceAncestry, readEvidenceFile, evidenceDigest, writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';
const retained=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const candidate=resolve(process.argv[2]??retained);
const candidateRelative=relative(resolve('.'),candidate);
assert.ok(!isAbsolute(candidateRelative)&&!candidateRelative.startsWith('..'),'Candidate must remain in the isolated worktree');
assert.ok(process.argv.length<=3,'Only the candidate executable may be selected');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const probe=ff.replace('ffmpeg.exe','ffprobe.exe');
const width=224,height=126,frames=8,fps=50;
const before=evidenceDigest(await readEvidenceFile(retained));
assert.equal(before,'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d');
const candidateHash=evidenceDigest(await readEvidenceFile(candidate));
const buildRoot=dirname(dirname(candidate));
const buildReceiptBytes=await readEvidenceFile(join(buildRoot,'build-receipt.json'));
const buildReceipt=JSON.parse(buildReceiptBytes);
assert.equal(buildReceipt.schema,1);assert.equal(buildReceipt.referenceOnly,false);
assert.equal(buildReceipt.worker.path,'worker/photogogo-subject-finishing.exe');
assert.equal(buildReceipt.worker.sha256,candidateHash);
assert.equal(buildReceipt.reference.path,'objects/subject-finishing-reference-tests.exe');
const rawTests=join(buildRoot,buildReceipt.reference.path);
assert.equal(evidenceDigest(await readEvidenceFile(rawTests)),buildReceipt.reference.sha256);
assert.ok(buildReceipt.sources.some(entry=>entry.path==='src-tauri/native/subject_finishing/core.h'));
for(const entry of buildReceipt.sources) {
 assert.match(entry.path,/^src-tauri\/native\/subject_finishing\/[a-z_]+\.(h|cpp)$/);
 assert.equal(evidenceDigest(await readEvidenceFile(resolve(entry.path))),entry.sha256,'Candidate source identity changed');
}
await assertEvidenceAncestry(resolve('test-output'));
const folder=await mkdtemp(resolve('test-output/subject-cpu-parallel-media-'));
console.log(JSON.stringify({event:'started',folder,productionExport:false}));
async function run(binary,args,name) {
 const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let out='',err='',overflow=false,timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
 const collect=(previous,data)=>{
  if(Buffer.byteLength(previous)+data.length>1024**2){overflow=true;child.kill();return previous;}
  return previous+data.toString('utf8');
 };
 child.stdout.on('data',data=>{out=collect(out,data);});child.stderr.on('data',data=>{err=collect(err,data);});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 await writeEvidenceArtifact(folder,`${name}.stdout.txt`,Buffer.from(out));
 await writeEvidenceArtifact(folder,`${name}.stderr.txt`,Buffer.from(err));
 assert.equal(timedOut,false,`${name}: timeout`);assert.equal(overflow,false,`${name}: diagnostics bound`);
 assert.equal(code,0,`${name}: ${err}`);return {out,err};
}
const source=join(folder,'source.mp4'),mask=join(folder,'mask.pgmask');
await run(ff,['-v','error','-nostdin','-n','-f','lavfi','-i',`testsrc2=size=${width}x${height}:rate=${fps}`,
 '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-frames:v',String(frames),'-t',String(frames/fps),
 '-vf','format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
 '-c:v','libx264','-preset','veryfast','-threads','2','-bf','0','-pix_fmt','yuv420p','-color_range','tv',
 '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','aac','-ac','2','-ar','48000',
 '-video_track_timescale','90000',source],'source');
// Zero / uncertain / trusted masks on every row, including all worker boundaries.
const alpha=Buffer.alloc(width*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++)alpha[y*width+x]=[0,128,240,241,255][(x+3*y)%5];
// Give a trusted interior patch a real sharpening stencil, not only bypass pixels.
for(let y=12;y<height-12;y++)for(let x=80;x<width-12;x++)alpha[y*width+x]=255;
function packedMask(values) {
 const entries=[];
 for(let i=0;i<values.length;){let end=i+1;while(end<values.length&&values[end]===values[i])end++;
  const entry=Buffer.alloc(5);entry.writeUInt32LE(end-i);entry[4]=values[i];entries.push(entry);i=end;}
 const payload=Buffer.concat(entries),length=Buffer.alloc(4);length.writeUInt32LE(payload.length);
 return Buffer.concat([length,payload]);
}
const header=Buffer.alloc(20);header.write('PGMSK001');
header.writeUInt32LE(width,8);header.writeUInt32LE(height,12);header.writeUInt32LE(frames,16);
const masks=Array.from({length:frames},(_,frame)=>{
 const values=Buffer.from(alpha);
 if(frame===0)values.fill(0);
 else for(let y=12;y<height-12;y++)for(let x=80;x<width-12;x++)if((x+frame)%19===0)values[y*width+x]=128;
 return packedMask(values);
});
await writeEvidenceArtifact(folder,'mask.pgmask',Buffer.concat([header,...masks]));
const sourceHash=evidenceDigest(await readEvidenceFile(source)),maskHash=evidenceDigest(await readEvidenceFile(mask));
async function inspect(path,name) {
 const decoded=await run(probe,['-v','error','-count_frames','-show_streams','-of','json',path],`${name}-profile`);
 assert.equal(decoded.err.trim(),'');const streams=JSON.parse(decoded.out).streams;
 assert.equal(streams.filter(s=>s.codec_type==='video').length,1);assert.equal(streams.filter(s=>s.codec_type==='audio').length,1);
 const v=streams.find(s=>s.codec_type==='video');
 for(const[key,value]of Object.entries({width,height,nb_read_frames:String(frames),r_frame_rate:'50/1',avg_frame_rate:'50/1',
  pix_fmt:'yuv420p',color_range:'tv',color_space:'bt709',color_transfer:'bt709',color_primaries:'bt709',field_order:'progressive'}))
  assert.equal(v[key],value,`${name}: ${key}`);
 const packets=JSON.parse((await run(probe,['-v','error','-select_streams','v:0','-show_packets',
  '-show_entries','packet=pts_time,dts_time,duration_time','-of','json',path],`${name}-video`)).out).packets;
 assert.equal(packets.length,frames);packets.forEach((p,i)=>{
  assert.ok(Math.abs(Number(p.pts_time)-i/fps)<1e-6);assert.ok(Math.abs(Number(p.duration_time)-1/fps)<1e-6);
 });
 const audio=JSON.parse((await run(probe,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256',
  '-show_entries','packet=pts_time,dts_time,duration_time,size,data_hash,side_data_list','-of','json',path],`${name}-audio`)).out).packets;
 assert.ok(audio.length>0);
 const digest=await run(ff,['-v','error','-nostdin','-threads','1','-i',path,'-map','0:v:0','-an','-threads','1',
  '-f','framemd5','-'],`${name}-decoded-frame-hashes`);
 assert.equal(digest.err.trim(),'');const hashes=digest.out.split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
 assert.equal(hashes.length,frames);return {audio,packets,hashes};
}
const original=await inspect(source,'source'),results=[];
// The compressed multithreaded VBV stream is not an exact-pixel oracle. Bind
// pre-encode parity to this very fixture and the candidate's test executable.
const raw=await run(process.execPath,['scripts/test-subject-cpu-parallel-raw.mjs',rawTests,folder],'raw-parity');
const rawPassed=raw.out.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).find(e=>e.event==='passed');
assert.ok(rawPassed&&rawPassed.results.length===12,'Both scopes, both raw fixtures and all three picture budgets must pass');
assert.equal(rawPassed.candidateHash,buildReceipt.reference.sha256);
assert.equal(rawPassed.goldenHash,before);
for(const threads of [1,4,64]) {
 const gold=join(folder,`serial-${threads}.mp4`),parallel=join(folder,`candidate-${threads}.mp4`);
 const args=output=>['--render',ff,source,output,mask,String(width),String(height),'26','32',String(frames),'cpu',
  '0.25','1.03','1.04','0.02','0','0','1','1','0',String(fps),String(threads),'4','libx264'];
 await run(retained,args(gold),`serial-${threads}`);
 const execution=await run(candidate,args(parallel),`candidate-${threads}`);
 const finish=execution.err.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(e=>e.event==='mediaFinished');
 assert.equal(finish.length,1);assert.equal(finish[0].backend,'cpu');assert.equal(finish[0].frames,frames);
 assert.equal(finish[0].cpuPictureParallelism,Math.min(threads,8,height),'CPU completion must expose its bounded picture budget');
 const [expected,actual]=[await inspect(gold,`serial-${threads}`),await inspect(parallel,`candidate-${threads}`)];
 const repeated=join(folder,`serial-repeat-${threads}.mp4`);
 await run(retained,args(repeated),`serial-repeat-${threads}`);
 const repeat=await inspect(repeated,`serial-repeat-${threads}`);
 await writeEvidenceArtifact(folder,`encoder-repeat-${threads}.json`,Buffer.from(JSON.stringify({threads,
  serialRepeatExact:repeat.hashes.every((hash,i)=>hash===expected.hashes[i]),
  candidateDecodedExact:actual.hashes.every((hash,i)=>hash===expected.hashes[i])},null,2)));
 if(threads===1) {
  assert.deepEqual(repeat.hashes,expected.hashes,'One-thread retained encoding must be deterministic in this fixture');
  assert.deepEqual(actual.hashes,expected.hashes,'Every one-thread decoded frame must equal the retained output');
 }
 assert.deepEqual(actual.packets,expected.packets);assert.deepEqual(actual.audio,original.audio);
 assert.deepEqual(expected.audio,original.audio);
 assert.ok((await stat(parallel)).size<16*1024**2);
 results.push({threads,cpuPictureParallelism:finish[0].cpuPictureParallelism,decodedFrameCount:frames,
  decodedPicturesExact:actual.hashes.every((hash,i)=>hash===expected.hashes[i]),
  serialEncoderRepeatExact:repeat.hashes.every((hash,i)=>hash===expected.hashes[i]),audioPacketsExact:actual.audio.length});
}
assert.equal(evidenceDigest(await readEvidenceFile(source)),sourceHash);assert.equal(evidenceDigest(await readEvidenceFile(mask)),maskHash);
assert.equal(evidenceDigest(await readEvidenceFile(retained)),before);assert.equal(evidenceDigest(await readEvidenceFile(candidate)),candidateHash);
assert.equal(evidenceDigest(await readEvidenceFile(join(buildRoot,'build-receipt.json'))),evidenceDigest(buildReceiptBytes));
await writeEvidenceArtifact(folder,'receipt.json',Buffer.from(JSON.stringify({schema:1,retainedHash:before,candidateHash,
 buildReceiptHash:evidenceDigest(buildReceiptBytes),rawTestHash:rawPassed.candidateHash,sourceHash,maskHash,rawParityFolder:rawPassed.folder,results,
 limits:'Synthetic eight-frame media integrity with separate exact pre-encode RGBA checks. Compressed-picture equality required only for one-thread encoding; multithreaded VBV equality is recorded, not presumed. Not representative visual quality, measured speed, GPU or app export acceptance.',
 subjectQualityAccepted:false,exportQualified:false},null,2)));
console.log(JSON.stringify({event:'passed',folder,results,subjectQualityAccepted:false,exportQualified:false}));
