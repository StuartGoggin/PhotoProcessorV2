// Fixed retained-footage inspection through the public cached-picture seam.
// No inference, original-media writes, tracker promotion or export acceptance.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assertEvidenceAncestry,readEvidenceFile,evidenceDigest,writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const worker=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const root=resolve('test-output/subject-footage-evaluation-1791597148390');
const testOutput=resolve('test-output'),width=3840,height=2160,pixels=width*height,rgbaBytes=pixels*4;
const samples=[
 {name:'black-horse',frames:[32,33,34],grade:[.25,1.03,1.04,.02],
  crops:[{name:'mane-silhouette',x:1770,y:460},{name:'subject-interior',x:1640,y:1040}]},
 {name:'white-horse',frames:[68,69,70],grade:[-.20,1.02,.98,-.015],
  crops:[{name:'mane-silhouette',x:1920,y:420},{name:'subject-interior',x:1380,y:1000}]},
];
function run(binary,args,input,maximum=rgbaBytes+1024) {
 const result=spawnSync(binary,args,{input,windowsHide:true,timeout:30000,maxBuffer:maximum});
 assert.equal(result.error,undefined);assert.equal(result.status,0,String(result.stderr??'').slice(0,2000));
 return {data:result.stdout,stderr:String(result.stderr??'')};
}
function oneMask(data,selected) {
 assert.equal(data.subarray(0,8).toString('ascii'),'PGMSK001');
 assert.equal(data.readUInt32LE(8),1024);assert.equal(data.readUInt32LE(12),576);assert.equal(data.readUInt32LE(16),100);
 let cursor=20,chosen,payload;
 for(let frame=0;frame<100;frame++) {
  assert.ok(cursor+4<=data.length);const length=data.readUInt32LE(cursor);cursor+=4;
  assert.ok(length>0&&length%5===0&&cursor+length<=data.length);
  const alpha=frame===selected?Buffer.alloc(1024*576):null;let written=0;
  for(let offset=cursor;offset<cursor+length;offset+=5) {
   const count=data.readUInt32LE(offset);assert.ok(count>0&&written+count<=1024*576);
   if(alpha)alpha.fill(data[offset+4],written,written+count);written+=count;
  }
  assert.equal(written,1024*576);
  if(alpha){chosen=alpha;payload=data.subarray(cursor,cursor+length);}
  cursor+=length;
 }
 assert.equal(cursor,data.length);assert.ok(chosen);
 const single=Buffer.alloc(24+payload.length);data.copy(single,0,0,20);single.writeUInt32LE(1,16);
 single.writeUInt32LE(payload.length,20);payload.copy(single,24);
 const alpha=Buffer.alloc(pixels);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)alpha[y*width+x]=chosen[Math.floor(y*576/height)*1024+Math.floor(x*1024/width)];
 return {single,alpha};
}
function measure(source,graded,finished,alpha) {
 assert.equal(source.length,rgbaBytes);assert.equal(graded.length,rgbaBytes);assert.equal(finished.length,rgbaBytes);
 let background=0,detail=0,maximum=0,ineligible=0,gradedPixels=0,maximumGrade=0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const pixel=y*width+x,offset=pixel*4;
  assert.equal(graded[offset+3],source[offset+3]);assert.equal(finished[offset+3],source[offset+3]);
  let eligible=x>0&&y>0&&x+1<width&&y+1<height;
  if(eligible)for(let dy=-1;dy<=1&&eligible;dy++)for(let dx=-1;dx<=1;dx++)
   if(alpha[(y+dy)*width+x+dx]<=240){eligible=false;break;}
  if(!alpha[pixel])background++;
  const delta=finished[offset]-graded[offset];let changed=false,gradeChanged=false;
  for(let channel=0;channel<3;channel++) {
   const at=offset+channel,difference=finished[at]-graded[at];
   const gradeDifference=graded[at]-source[at];
   gradeChanged ||= gradeDifference!==0;
   maximumGrade=Math.max(maximumGrade,Math.abs(gradeDifference));
   assert.equal(difference,delta,'Detail must add the same bounded luma delta to all channels');
   maximum=Math.max(maximum,Math.abs(difference));assert.ok(Math.abs(difference)<=3);
   changed ||= difference!==0;
   if(!alpha[pixel]){assert.equal(graded[at],source[at],'Grade changed zero-alpha background');assert.equal(finished[at],source[at],'Detail changed zero-alpha background');}
   if(!eligible)assert.equal(finished[at],graded[at],'Detail crossed uncertain silhouette or picture edge');
  }
  detail+=Number(changed);ineligible+=Number(!eligible);gradedPixels+=Number(gradeChanged);
 }
 assert.ok(background>0&&background<pixels);
 assert.ok(gradedPixels>0,'Non-neutral subject grade must actually change selected picture pixels');
 return {zeroAlphaPixelsUnchanged:background,maskOrBorderExcludedPixelsUnchanged:ineligible,
  changedSubjectGradePixels:gradedPixels,maximumGradeChannelDelta:maximumGrade,
  changedDetailPixels:detail,maximumDetailChannelDelta:maximum};
}
await assertEvidenceAncestry(root);await assertEvidenceAncestry(testOutput);
assert.equal(evidenceDigest(await readEvidenceFile(worker)),'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d');
assert.equal(evidenceDigest(await readEvidenceFile(ff,128*1024**2)),'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630');
const adapter=JSON.parse(run(worker,['--probe'],undefined,1024**2).data.toString('utf8'));
assert.equal(adapter.available,true);assert.equal(adapter.vendorId,0x8086,'Intel inspection host only; no NVIDIA claim');
const evaluation=JSON.parse(await readEvidenceFile(join(root,'evaluation.json')));
const output=await mkdtemp(join(testOutput,'subject-edge-treatment-')),results=[];
for(const sample of samples) {
 const retained=evaluation.receipts.find(value=>value.name===sample.name);assert.ok(retained);
 const base=join(root,sample.name,'bounded-normalized-excerpt.mp4'),maskPath=join(root,sample.name,'masks.partial/masks.pgmask');
 const baseBytes=await readEvidenceFile(base,128*1024**2),maskBytes=await readEvidenceFile(maskPath,32*1024**2);
 assert.equal(createHash('md5').update(baseBytes).digest('hex'),retained.baseIdentity);
 assert.equal(evidenceDigest(maskBytes),retained.maskReceipt.mask.sha256);
 const cropSheets=sample.crops.map(crop=>({...crop,side:384,panelOrder:['base','subject-grade','subject-grade-plus-detail','expanded-alpha'],
  nativePixelScale:true,rows:sample.frames,pixels:Buffer.alloc(384*4*384*sample.frames.length*4)}));
 const observations=[];
 for(const [row,frame] of sample.frames.entries()) {
  const {single,alpha}=oneMask(maskBytes,frame),maskName=sample.name+'-'+frame+'.pgmask';
  await writeEvidenceArtifact(output,maskName,single);
  const filter='select=eq(n\\,'+frame+'),scale=iw:ih:in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba';
  const source=run(ff,['-v','error','-nostdin','-threads','2','-i',base,'-an','-vf',filter,'-filter_threads','1',
   '-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgba','pipe:1']).data;
  const pictures=[];
  for(const gain of [0,26]) {
   const produced=run(worker,['--finish-cached',String(width),String(height),String(gain),'32','1','gpu',
    ...sample.grade.map(String),'0','0','1','1','0',join(output,maskName)],source);
   const event=produced.stderr.trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(value=>value.event==='finished');
   assert.ok(event);assert.equal(event.backend,'d3d11');assert.equal(event.frames,1);
   pictures.push(produced.data);
  }
  const [graded,finished]=pictures,observation=measure(source,graded,finished,alpha);
  for(const crop of cropSheets) {
   assert.ok(crop.x>=0&&crop.y>=0&&crop.x+384<=width&&crop.y+384<=height);
   for(let panel=0;panel<3;panel++)for(let y=0;y<384;y++)
    [source,graded,finished][panel].copy(crop.pixels,((row*384+y)*1536+panel*384)*4,((crop.y+y)*width+crop.x)*4,((crop.y+y)*width+crop.x+384)*4);
   for(let y=0;y<384;y++)for(let x=0;x<384;x++) {
    const target=((row*384+y)*1536+3*384+x)*4,a=alpha[(crop.y+y)*width+crop.x+x];
    crop.pixels[target]=a;crop.pixels[target+1]=a;crop.pixels[target+2]=a;crop.pixels[target+3]=255;
   }
  }
  observations.push({frame,...observation});
  console.log(JSON.stringify({sample:sample.name,frame,...observation}));
 }
 const sheets=[];
 for(const {pixels:sheet,...metadata} of cropSheets) {
  const encoded=run(ff,['-v','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size','1536x'+384*sample.frames.length,
   '-i','pipe:0','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','pipe:1'],sheet,16*1024**2);
  const path=sample.name+'-'+metadata.name+'.png';const artifact=await writeEvidenceArtifact(output,path,encoded.data);
  sheets.push({...metadata,...artifact});
 }
 assert.equal(evidenceDigest(await readEvidenceFile(base,128*1024**2)),evidenceDigest(baseBytes));
 assert.equal(evidenceDigest(await readEvidenceFile(maskPath,32*1024**2)),evidenceDigest(maskBytes));
 results.push({sample:sample.name,grade:sample.grade,gain256:26,baseSha256:evidenceDigest(baseBytes),maskSha256:evidenceDigest(maskBytes),
  inputsUnchanged:true,observations,sheets});
}
await writeEvidenceArtifact(output,'receipt.json',Buffer.from(JSON.stringify({schema:1,adapter,results,
 inferenceExecuted:false,stabilizationExecuted:false,publicExportExecuted:false,continuousPlaybackReviewed:false,
 subjectQualityAccepted:false,exportQualified:false,
 limits:'Six selected pre-encode frames from cached v1 masks and normalized originals. Support invariants and still crops do not prove temporal or semantic quality, calibrated confidence, NVIDIA throughput, new v3 tracker behavior or release.'},null,2)));
const html='<!doctype html><meta charset="utf-8"><title>Subject edge-treatment inspection</title><style>body{margin:24px;background:#111a24;color:#e8edf3;font:15px Segoe UI}img{display:block;max-width:100%}p{max-width:1000px;line-height:1.5}</style><h1>Subject edge treatment</h1><p>Columns: base / subject grade / subject grade plus detail / expanded mask alpha. Rows are the exact frame numbers listed below. Each crop is native 384x384 pixels; a narrow viewport scales the sheet. This is selected pre-encode evidence, not continuous or whole-clip acceptance.</p>'+
 results.flatMap(item=>item.sheets.map(sheet=>'<h2>'+item.sample+' - '+sheet.name+'</h2><p>Frames '+sheet.rows.join(', ')+'; crop '+sheet.x+','+sheet.y+'</p><img src="'+sheet.path+'">')).join('');
await writeEvidenceArtifact(output,'review.html',Buffer.from(html));
console.log(JSON.stringify({output,frames:6,sheets:4,inferenceExecuted:false,subjectQualityAccepted:false}));
