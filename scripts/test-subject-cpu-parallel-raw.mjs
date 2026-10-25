// Raw RGBA before encoding: test executable only, no app export or production CLI mode.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {assertEvidenceAncestry, readEvidenceFile, evidenceDigest, writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';
assert.ok(process.argv.length===3||process.argv.length===4,'Select one isolated test executable and optionally the failing media fixture directory');
const candidate=resolve(process.argv[2]),candidateRelative=relative(resolve('test-output'),candidate);
assert.ok(!isAbsolute(candidateRelative)&&!candidateRelative.startsWith('..'),'Test executable must remain in isolated test-output');
const retained=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const goldenHash=evidenceDigest(await readEvidenceFile(retained));
assert.equal(goldenHash,'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d');
const candidateHash=evidenceDigest(await readEvidenceFile(candidate));
await assertEvidenceAncestry(resolve('test-output'));
const folder=await mkdtemp(resolve('test-output/subject-cpu-parallel-raw-'));
console.log(JSON.stringify({event:'started',folder,productionExport:false}));
const width=224,height=126,frames=8,pixels=width*height;
const entries=[];
for(let frame=0;frame<frames;frame++) {
 const rgba=Buffer.alloc(pixels*4),mask=Buffer.alloc(pixels);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const i=y*width+x,level=70+((x+y+frame)%2)*30;
  rgba[i*4]=level+(frame*3+x)%20;rgba[i*4+1]=level+(frame+y)%17;rgba[i*4+2]=level;
  rgba[i*4+3]=(x===31&&y%7===0)?128:255;
  mask[i]=frame===0?0:[0,128,240,241,254,255][(x+3*y+frame)%6];
  if(frame>0&&x>=80&&x<width-12&&y>=12&&y<height-12)mask[i]=255;
 }
 entries.push(rgba,mask);
}
const input=Buffer.concat(entries);
await writeEvidenceArtifact(folder,'input.rgba-mask',input);
async function run(binary,args,name,runInput=input) {
 const child=spawn(binary,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const chunks=[];let bytes=0,err='',overflow=false,timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill();},10000);
 child.stdin.on('error',()=>{});child.stdin.end(runInput);
 child.stdout.on('data',data=>{bytes+=data.length;if(bytes>pixels*4*frames){overflow=true;child.kill();}else chunks.push(data);});
 child.stderr.on('data',data=>{if(Buffer.byteLength(err)+data.length>65536){overflow=true;child.kill();}else err+=data.toString('utf8');});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 const out=Buffer.concat(chunks);
 await writeEvidenceArtifact(folder,`${name}.rgba`,out);
 await writeEvidenceArtifact(folder,`${name}.stderr.txt`,Buffer.from(err));
 assert.equal(timedOut,false);assert.equal(overflow,false);assert.equal(code,0,`${name}: ${err}`);
 assert.equal(out.length,pixels*4*frames,'All exact raw frames must be present');return out;
}
const fixtures=[{name:'synthetic',input}];
if(process.argv[3]) {
 const mediaRoot=resolve(process.argv[3]),mediaRelative=relative(resolve('test-output'),mediaRoot);
 assert.ok(!isAbsolute(mediaRelative)&&!mediaRelative.startsWith('..'),'Media fixture must remain inside isolated test-output');
 const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
 assert.equal(evidenceDigest(await readEvidenceFile(ff,256*1024**2)),'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630');
 const source=join(mediaRoot,'source.mp4');
 const sourceHash=evidenceDigest(await readEvidenceFile(source));
 const cache=await readEvidenceFile(join(mediaRoot,'mask.pgmask'));
 assert.equal(cache.subarray(0,8).toString(),'PGMSK001');
 assert.equal(cache.readUInt32LE(8),width);assert.equal(cache.readUInt32LE(12),height);assert.equal(cache.readUInt32LE(16),frames);
 const decoded=await run(ff,['-v','error','-nostdin','-threads','4','-noautorotate','-i',source,'-map','0:v:0','-an',
  '-fps_mode','passthrough','-filter_threads','1','-vf',
  'scale=iw:ih:in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba',
  '-threads','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],'failing-media-decoded',Buffer.alloc(0));
 const mediaEntries=[];let offset=20;
 for(let frame=0;frame<frames;frame++) {
  const bytes=cache.readUInt32LE(offset);offset+=4;const end=offset+bytes,mask=Buffer.alloc(pixels);let filled=0;
  assert.ok(end<=cache.length&&bytes%5===0);
  while(offset<end){const count=cache.readUInt32LE(offset),alpha=cache[offset+4];offset+=5;
   assert.ok(count>0&&filled+count<=pixels);mask.fill(alpha,filled,filled+count);filled+=count;}
  assert.equal(filled,pixels);mediaEntries.push(decoded.subarray(frame*pixels*4,(frame+1)*pixels*4),mask);
 }
 assert.equal(offset,cache.length);assert.equal(evidenceDigest(await readEvidenceFile(source)),sourceHash);
 fixtures.push({name:'failing-media',input:Buffer.concat(mediaEntries),sourceHash,maskHash:evidenceDigest(cache)});
}
const results=[];
for(const fixture of fixtures)for(const global of [false,true]) {
 const name=`${fixture.name}-${global?'combined':'subject-only'}`;
 const gold=await run(retained,['--finish',String(width),String(height),'26','32',String(frames),'cpu',
  '.25','1.03','1.04','.02',global?'1':'0','.25','1','1','0'],`gold-${name}`,fixture.input);
 const neutral=await run(retained,['--finish',String(width),String(height),'0','32',String(frames),'cpu',
  '.25','1.03','1.04','.02',global?'1':'0','.25','1','1','0'],`grade-only-${name}`,fixture.input);
 assert.ok(!gold.equals(neutral),'Fixture must activate sharpening after non-neutral grading');
 for(const parallelism of [1,4,8]) {
  const actual=await run(candidate,['parallel-fixture',String(parallelism),global?'combined':'subject-only'],`parallel-${name}-${parallelism}`,fixture.input);
  assert.ok(actual.equals(gold),'Every pre-encode RGBA byte must match the retained serial worker');
  results.push({fixture:fixture.name,scope:global?'combined':'subject-only',parallelism,exactRawRgbaFrames:frames,rgbaSha256:evidenceDigest(actual)});
 }
}
assert.equal(evidenceDigest(await readEvidenceFile(retained)),goldenHash);
assert.equal(evidenceDigest(await readEvidenceFile(candidate)),candidateHash);
await writeEvidenceArtifact(folder,'receipt.json',Buffer.from(JSON.stringify({schema:1,goldenHash,candidateHash,
 fixtures:fixtures.map(({input:bytes,...fixture})=>({...fixture,inputHash:evidenceDigest(bytes)})),results,
 limits:'Test-only function seam, exact raw RGBA synthetic fixtures; not representative motion quality, GPU acceptance or app export.',
 subjectQualityAccepted:false,exportQualified:false},null,2)));
console.log(JSON.stringify({event:'passed',folder,goldenHash,candidateHash,results,subjectQualityAccepted:false,exportQualified:false}));
