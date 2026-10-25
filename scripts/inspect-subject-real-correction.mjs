// Fixed real-case mask inspection. Picture/mask evidence only, no inference,
// source edits, app admission, filter promotion or automated visual acceptance.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assertEvidenceAncestry,readEvidenceFile,evidenceDigest,writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

const folder=resolve('test-output/subject-real-correction-ZBFTss');
const result=JSON.parse(await readEvidenceFile(join(folder,'baseline-result.json')));
assert.equal(result.mode,'baseline');assert.equal(result.appRuntimeAdmitted,false);
assert.equal(result.manifest.frames,26);assert.equal(result.manifest.mask.width,1024);assert.equal(result.manifest.mask.height,576);
const base=result.request.sourcePath;
assert.equal(base,join(folder,'bounded-picture-base.mp4'));
assert.equal(evidenceDigest(await readEvidenceFile(base,16*1024**2)),'691c0021da1f24ac6ff1d7b3bfbbbb527951e19efbeb4c13644663e1f22a01d1');
const maskPath=join(folder,'baseline.partial/masks.pgmask'),data=await readEvidenceFile(maskPath,32*1024**2);
assert.equal(evidenceDigest(data),result.manifest.mask.sha256);assert.equal(data.length,result.manifest.mask.bytes);
assert.equal(data.subarray(0,8).toString('ascii'),'PGMSK001');
assert.equal(data.readUInt32LE(8),1024);assert.equal(data.readUInt32LE(12),576);assert.equal(data.readUInt32LE(16),26);
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
assert.equal(evidenceDigest(await readEvidenceFile(ff,128*1024**2)),'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630');
const selected=[0,2,3,4,5,11,12,13,25],masks=new Map(),metrics=[];
let cursor=20,previous=null;
for(let frame=0;frame<26;frame++){
 assert.ok(cursor+4<=data.length);const bytes=data.readUInt32LE(cursor);cursor+=4;
 assert.ok(bytes>0&&bytes%5===0&&cursor+bytes<=data.length);
 const alpha=Buffer.alloc(1024*576);let written=0;
 for(let offset=cursor;offset<cursor+bytes;offset+=5){
  const run=data.readUInt32LE(offset);assert.ok(run>0&&written+run<=alpha.length);
  alpha.fill(data[offset+4],written,written+run);written+=run;
 }
 assert.equal(written,alpha.length);cursor+=bytes;
 let nonzero=0,sum=0,change=0;
 for(let pixel=0;pixel<alpha.length;pixel++){
  nonzero+=Number(alpha[pixel]>0);sum+=alpha[pixel];
  if(previous)change+=Math.abs(alpha[pixel]-previous[pixel]);
 }
 metrics.push({frame,occupiedPixels:nonzero,meanAlpha:sum/alpha.length,
  meanAbsoluteAlphaChange:previous?change/alpha.length:null,
  inspectedShoulderPoint:{sourceX:1792,sourceY:1092,alpha:alpha[Math.floor(1092*576/2160)*1024+Math.floor(1792*1024/3840)]}});
 if(selected.includes(frame))masks.set(frame,alpha);previous=alpha;
}
assert.equal(cursor,data.length);
const testOutput=resolve('test-output');await assertEvidenceAncestry(testOutput);
const output=await mkdtemp(join(testOutput,'subject-real-mask-inspection-'));
function run(args,input,maximum=3840*2160*4+1024){
 const execution=spawnSync(ff,args,{input,windowsHide:true,timeout:30000,maxBuffer:maximum});
 assert.equal(execution.error,undefined);assert.equal(execution.status,0,String(execution.stderr??'').slice(-2000));
 return execution.stdout;
}
function expandAt(alpha,x,y){return alpha[Math.floor(y*576/2160)*1024+Math.floor(x*1024/3840)];}
function sourceFrame(frame,width,height){
 const filter='select=eq(n\\,'+frame+'),scale='+width+':'+height+':in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba';
 const source=run(['-v','error','-nostdin','-threads','2','-i',base,'-an','-vf',filter,'-filter_threads','1',
  '-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgba','pipe:1']);
 assert.equal(source.length,width*height*4);return source;
}
function overlay(source,alpha,width,height,xOffset=0,yOffset=0,native=false){
 const picture=Buffer.from(source);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const a=native?expandAt(alpha,x+xOffset,y+yOffset):alpha[Math.floor(y*576/height)*1024+Math.floor(x*1024/width)];
  const mix=a/255*.42,offset=(y*width+x)*4;
  for(let channel=0;channel<3;channel++)picture[offset+channel]=Math.round(source[offset+channel]*(1-mix)+[230,181,46][channel]*mix);
 }
 return picture;
}
function panel(sheet,picture,panel,row,panelWidth,panelHeight,columns){
 for(let y=0;y<panelHeight;y++)picture.copy(sheet,((row*panelHeight+y)*columns*panelWidth+panel*panelWidth)*4,
  y*panelWidth*4,(y+1)*panelWidth*4);
}
async function png(name,pixels,width,height,metadata){
 const encoded=run(['-v','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size',width+'x'+height,
  '-i','pipe:0','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','pipe:1'],pixels,16*1024**2);
 return {...metadata,...await writeEvidenceArtifact(output,name,encoded)};
}
const sheets=[];
for(const frames of [[0,3,5],[11,12,13,25]]){
 const width=768,height=432,sheet=Buffer.alloc(width*2*height*frames.length*4);
 for(const [row,frame] of frames.entries()){
  const source=sourceFrame(frame,width,height);panel(sheet,source,0,row,width,height,2);
  panel(sheet,overlay(source,masks.get(frame),width,height),1,row,width,height,2);
 }
 sheets.push(await png('overview-'+frames[0]+'.png',sheet,width*2,height*frames.length,
  {frames,columns:['exact-base-downsample','gold-mask-overlay'],nativePixelScale:false}));
}
const frames=[2,3,4,5],side=384,crop={x:1640,y:1040},sheet=Buffer.alloc(side*3*side*frames.length*4);
for(const [row,frame] of frames.entries()){
 const source=sourceFrame(frame,3840,2160),picture=Buffer.alloc(side*side*4),alpha=masks.get(frame),mask=Buffer.alloc(side*side*4);
 for(let y=0;y<side;y++)source.copy(picture,y*side*4,((crop.y+y)*3840+crop.x)*4,((crop.y+y)*3840+crop.x+side)*4);
 for(let y=0;y<side;y++)for(let x=0;x<side;x++){
  const a=expandAt(alpha,x+crop.x,y+crop.y),offset=(y*side+x)*4;
  mask[offset]=a;mask[offset+1]=a;mask[offset+2]=a;mask[offset+3]=255;
 }
 panel(sheet,picture,0,row,side,side,3);panel(sheet,overlay(picture,alpha,side,side,crop.x,crop.y,true),1,row,side,side,3);
 panel(sheet,mask,2,row,side,side,3);
}
sheets.push(await png('shoulder-native.png',sheet,side*3,side*frames.length,
 {frames,crop,columns:['exact-base-native','gold-mask-overlay','expanded-alpha'],nativePixelScale:true}));
assert.equal(evidenceDigest(await readEvidenceFile(base,16*1024**2)),'691c0021da1f24ac6ff1d7b3bfbbbb527951e19efbeb4c13644663e1f22a01d1');
assert.equal(evidenceDigest(await readEvidenceFile(maskPath,32*1024**2)),result.manifest.mask.sha256);
await writeEvidenceArtifact(output,'receipt.json',Buffer.from(JSON.stringify({schema:1,base,maskPath,maskIdentity:result.manifest.maskIdentity,
 maskSha256:result.manifest.mask.sha256,inputsUnchanged:true,metrics,sheets,inferenceExecuted:false,
 correctionExecuted:false,continuousPlaybackReviewed:false,appRuntimeAdmitted:false,subjectQualityAccepted:false,
 limits:'Selected stills and descriptive alpha changes of one 26-frame mounted-horse private v3 baseline; not correction effectiveness, calibrated confidence, continuous stability, finishing quality, NVIDIA, app or export acceptance.'},null,2)));
console.log(JSON.stringify({output,sheets:3,selectedFrames:selected,shoulderPoint:metrics.filter(row=>[2,3,4,5].includes(row.frame)),subjectQualityAccepted:false}));
