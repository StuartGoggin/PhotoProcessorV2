// Read back the exact box-plus-point diagnostic, not a quality acceptance route.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assertEvidenceAncestry,readEvidenceFile,evidenceDigest,writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

assert.equal(process.argv.length,3);
const folder=resolve(process.argv[2]),testOutput=resolve('test-output');
assert.equal(resolve(folder,'..'),testOutput);
assert.match(folder.split(/[\\/]/).at(-1),/^subject-correction-context-box-point-[A-Za-z0-9]+$/);
await assertEvidenceAncestry(folder);
const result=JSON.parse(await readEvidenceFile(join(folder,'result.json')));
assert.equal(result.mode,'box-point');assert.equal(result.output,folder);
assert.equal(result.completed,true);assert.equal(result.appRuntimeAdmitted,false);
assert.equal(result.subjectQualityAccepted,false);
const retained=resolve('test-output/subject-real-correction-ZBFTss');
const base=join(retained,'bounded-picture-base.mp4'),beforePath=join(retained,'baseline.partial/masks.pgmask');
const afterPath=join(folder,'masks.partial/masks.pgmask');
const baseSha='691c0021da1f24ac6ff1d7b3bfbbbb527951e19efbeb4c13644663e1f22a01d1';
const beforeSha='63d16f8153ee1757a6b762130ff3d32788f4ebb0921584028370cb631a49b33f';
assert.equal(evidenceDigest(await readEvidenceFile(base,16*1024**2)),baseSha);
const beforeBytes=await readEvidenceFile(beforePath,32*1024**2),afterBytes=await readEvidenceFile(afterPath,32*1024**2);
assert.equal(evidenceDigest(beforeBytes),beforeSha);assert.equal(evidenceDigest(afterBytes),result.manifest.mask.sha256);
function inflate(bytes){
 assert.equal(bytes.subarray(0,8).toString('ascii'),'PGMSK001');
 assert.equal(bytes.readUInt32LE(8),1024);assert.equal(bytes.readUInt32LE(12),576);assert.equal(bytes.readUInt32LE(16),26);
 let at=20;const frames=[];
 for(let frame=0;frame<26;frame++){
  assert.ok(at+4<=bytes.length);const length=bytes.readUInt32LE(at);at+=4;
  assert.ok(length>0&&length%5===0&&at+length<=bytes.length);const alpha=Buffer.alloc(1024*576);let written=0;
  for(let offset=at;offset<at+length;offset+=5){const count=bytes.readUInt32LE(offset);assert.ok(count>0&&written+count<=alpha.length);
   alpha.fill(bytes[offset+4],written,written+count);written+=count;}
  assert.equal(written,alpha.length);at+=length;frames.push(alpha);
 }
 assert.equal(at,bytes.length);return frames;
}
const original=inflate(beforeBytes),corrected=inflate(afterBytes);
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
assert.equal(evidenceDigest(await readEvidenceFile(ff,128*1024**2)),'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630');
const output=await mkdtemp(join(testOutput,'subject-correction-context-inspection-'));
function run(args,input,maximum=3840*2160*4+1024){
 const child=spawnSync(ff,args,{input,timeout:30000,windowsHide:true,maxBuffer:maximum});
 assert.equal(child.error,undefined);assert.equal(child.status,0,String(child.stderr??'').slice(-2000));return child.stdout;
}
function source(frame,width,height){
 const filter='select=eq(n\\,'+frame+'),scale='+width+':'+height+':in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba';
 const rgba=run(['-v','error','-nostdin','-threads','2','-i',base,'-an','-vf',filter,'-filter_threads','1',
  '-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgba','pipe:1']);
 assert.equal(rgba.length,width*height*4);return rgba;
}
const atSource=(alpha,x,y)=>alpha[Math.floor(y*576/2160)*1024+Math.floor(x*1024/3840)];
function overlay(picture,alpha,width,height,crop=null){
 const rgba=Buffer.from(picture);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const a=crop?atSource(alpha,x+crop.x,y+crop.y):alpha[Math.floor(y*576/height)*1024+Math.floor(x*1024/width)];
  const mix=a/255*.42,offset=(y*width+x)*4;
  for(let channel=0;channel<3;channel++)rgba[offset+channel]=Math.round(picture[offset+channel]*(1-mix)+[230,181,46][channel]*mix);
 }return rgba;
}
function panel(sheet,picture,column,row,width,height,columns){
 for(let y=0;y<height;y++)picture.copy(sheet,((row*height+y)*columns*width+column*width)*4,y*width*4,(y+1)*width*4);
}
async function png(name,pixels,width,height,metadata){
 const bytes=run(['-v','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size',width+'x'+height,
  '-i','pipe:0','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','pipe:1'],pixels,16*1024**2);
 return {...metadata,...await writeEvidenceArtifact(output,name,bytes)};
}
const sheets=[];
for(const frames of [[0,2,3],[4,12,25]]){
 const width=768,height=432,sheet=Buffer.alloc(width*3*height*frames.length*4);
 for(const [row,frame] of frames.entries()){
  const picture=source(frame,width,height);panel(sheet,picture,0,row,width,height,3);
  panel(sheet,overlay(picture,original[frame],width,height),1,row,width,height,3);
  panel(sheet,overlay(picture,corrected[frame],width,height),2,row,width,height,3);
 }
 sheets.push(await png('overview-'+frames[0]+'.png',sheet,width*3,height*frames.length,
  {frames,columns:['exact-base-downsample','baseline-gold-mask','box-plus-point-gold-mask'],nativePixelScale:false}));
}
const frames=[2,3,4,5],side=384,crop={x:1320,y:1600},sheet=Buffer.alloc(side*5*side*frames.length*4),roi=[];
for(const [row,frame] of frames.entries()){
 const picture=source(frame,3840,2160),cropped=Buffer.alloc(side*side*4),alphas=[Buffer.alloc(side*side*4),Buffer.alloc(side*side*4)];
 let changed=0,increased=0,decreased=0;
 for(let y=0;y<side;y++){
  picture.copy(cropped,y*side*4,((crop.y+y)*3840+crop.x)*4,((crop.y+y)*3840+crop.x+side)*4);
  for(let x=0;x<side;x++){
   const before=atSource(original[frame],x+crop.x,y+crop.y),after=atSource(corrected[frame],x+crop.x,y+crop.y),offset=(y*side+x)*4;
   changed+=Number(before!==after);increased+=Number(after>before);decreased+=Number(after<before);
   for(const [index,a] of [before,after].entries()){alphas[index].fill(a,offset,offset+3);alphas[index][offset+3]=255;}
  }
 }
 panel(sheet,cropped,0,row,side,side,5);panel(sheet,overlay(cropped,original[frame],side,side,crop),1,row,side,side,5);
 panel(sheet,overlay(cropped,corrected[frame],side,side,crop),2,row,side,side,5);
 panel(sheet,alphas[0],3,row,side,side,5);panel(sheet,alphas[1],4,row,side,side,5);
 roi.push({frame,changedSourcePixels:changed,increasedSourcePixels:increased,decreasedSourcePixels:decreased,
  literalPointAlphaBefore:atSource(original[frame],1416,1760),literalPointAlphaAfter:atSource(corrected[frame],1416,1760)});
}
sheets.push(await png('hind-leg-native.png',sheet,side*5,side*frames.length,
 {frames,crop,columns:['exact-base-native','baseline-gold-mask','box-plus-point-gold-mask','baseline-alpha','box-plus-point-alpha'],nativePixelScale:true}));
for(const [path,sha] of [[base,baseSha],[beforePath,beforeSha],[afterPath,result.manifest.mask.sha256]])
 assert.equal(evidenceDigest(await readEvidenceFile(path,32*1024**2)),sha);
await writeEvidenceArtifact(output,'receipt.json',Buffer.from(JSON.stringify({schema:1,case:folder,baseSha,beforeSha,
 afterSha:result.manifest.mask.sha256,inputsUnchanged:true,roi,sheets,all26AlphaComparisons:result.maskComparison,
 prefixFramesUnchanged:result.maskComparison.slice(0,3).every(row=>row.changedPixels===0),
 independentObjectCoverageVerified:false,continuousPlaybackReviewed:false,correctionEffectivenessAccepted:false,
 appRuntimeAdmitted:false,subjectQualityAccepted:false,exportQualified:false},null,2)));
console.log(JSON.stringify({output,roi,prefixComparison:result.maskComparison.slice(0,3),sheets,subjectQualityAccepted:false}));
