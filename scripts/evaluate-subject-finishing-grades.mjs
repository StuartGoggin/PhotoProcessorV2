// Bounded cached-footage picture checks. No inference, app export authority or release.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {assertEvidenceAncestry, readEvidenceFile, evidenceDigest, writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const worker=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const workerHash='db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d';
const retained=resolve('test-output/subject-footage-evaluation-1791597148390');
const testOutput=resolve('test-output');
const width=3840,height=2160,pixels=width*height,bytes=pixels*4;
const neutral=[0,1,1,0],global=[0.25,1,1,0];
const casesFor=subject=>[
 {name:'neutral',gain:0,subject:neutral,global:null,tolerance:0},
 {name:'subject-grade',gain:0,subject,global:null,tolerance:1},
 {name:'subject-grade-disabled-global',gain:0,subject,global:null,disabledGlobal:global,tolerance:1},
 {name:'global-only',gain:0,subject:neutral,global,tolerance:1},
 {name:'combined-grade',gain:0,subject,global,tolerance:1},
 {name:'subject-grade-detail',gain:26,subject,global:null,tolerance:2},
];
const samples=[
 {name:'black-horse',frame:25,subject:[0.25,1.03,1.04,0.02],crops:[{name:'rider-face',x:1640,y:160},{name:'mane-edge',x:1770,y:460},{name:'dark-fur',x:1640,y:1040}]},
 {name:'white-horse',frame:75,subject:[-0.20,1.02,0.98,-0.015],crops:[{name:'mane-edge',x:1920,y:420},{name:'muzzle-reins',x:2220,y:800},{name:'handler-face',x:2020,y:180}]},
];
async function run(binary,args,input,limit=bytes+1024,phase='picture') {
 const child=spawn(binary,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let size=0,stderr='',overflow=false,timedOut=false;const chunks=[],began=Date.now();
 const deadline=setTimeout(()=>{timedOut=true;child.kill();},30000);
 child.stdout.on('data',data=>{size+=data.length;if(size>limit){overflow=true;child.kill();}else chunks.push(data);});
 child.stderr.on('data',data=>{stderr+=data;if(stderr.length>1024**2){overflow=true;child.kill();}});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(deadline));
 assert.equal(code,0,`${phase}: ${stderr.slice(0,2000)}`);assert.equal(overflow,false);assert.equal(timedOut,false);
 return {data:Buffer.concat(chunks,size),stderr,wallSeconds:(Date.now()-began)/1000};
}
function oneMask(data,frame) {
 assert.equal(data.subarray(0,8).toString('ascii'),'PGMSK001');
 const mw=data.readUInt32LE(8),mh=data.readUInt32LE(12),count=data.readUInt32LE(16);
 assert.equal(mw,1024);assert.equal(mh,576);assert.equal(count,100);
 let cursor=20,selected;
 for(let n=0;n<count;n++) {
  assert.ok(cursor+4<=data.length);const length=data.readUInt32LE(cursor);cursor+=4;
  assert.ok(length>0&&length%5===0&&cursor+length<=data.length);
  let total=0;const alpha=n===frame?Buffer.alloc(mw*mh):null;
  for(let at=cursor;at<cursor+length;at+=5) {
   const run=data.readUInt32LE(at);assert.ok(run>0&&total+run<=mw*mh);
   if(alpha)alpha.fill(data[at+4],total,total+run);total+=run;
  }
  assert.equal(total,mw*mh);
  if(alpha)selected={alpha,payload:data.subarray(cursor,cursor+length)};
  cursor+=length;
 }
 assert.equal(cursor,data.length);assert.ok(selected);
 const single=Buffer.alloc(24+selected.payload.length);data.copy(single,0,0,20);single.writeUInt32LE(1,16);
 single.writeUInt32LE(selected.payload.length,20);selected.payload.copy(single,24);
 const alpha=Buffer.alloc(pixels);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)alpha[y*width+x]=selected.alpha[Math.floor(y*mh/height)*mw+Math.floor(x*mw/width)];
 return {single,alpha};
}
function inspect(source,cpu,gpu,alpha,recipe,globalCpu,globalGpu) {
 assert.equal(cpu.length,bytes);assert.equal(gpu.length,bytes);
 let maximum=0,background=0,changedSubject=0,newBlack=0,newWhite=0;
 for(let p=0;p<pixels;p++) {
  const at=p*4,a=alpha[p];let changed=false;
  assert.equal(cpu[at+3],source[at+3]);assert.equal(gpu[at+3],source[at+3]);
  if(!a)background++;
  for(let c=0;c<3;c++) {
   const i=at+c,difference=Math.abs(cpu[i]-gpu[i]);maximum=Math.max(maximum,difference);
   assert.ok(difference<=recipe.tolerance,`${recipe.name}: CPU/D3D difference ${difference} at byte ${i}`);
   if(recipe.name==='neutral')assert.equal(gpu[i],source[i]);
   if(!a) {
    if(!recipe.global){assert.equal(cpu[i],source[i]);assert.equal(gpu[i],source[i]);}
    else if(recipe.name==='combined-grade'){assert.equal(cpu[i],globalCpu[i]);assert.equal(gpu[i],globalGpu[i]);}
   } else {
    changed ||= gpu[i]!==source[i];
    newBlack+=Number(source[i]>0&&gpu[i]===0);newWhite+=Number(source[i]<255&&gpu[i]===255);
   }
  }
  changedSubject+=Number(changed);
 }
 assert.ok(background>0&&background<pixels);
 if(recipe.name!=='neutral')assert.ok(changedSubject>0,'Enabled test grade must not be a no-op');
 return {maximumCpuD3dChannelDifference:maximum,zeroAlphaPixels:background,changedSelectedPixels:changedSubject,
  newlyZeroSelectedChannels:newBlack,newly255SelectedChannels:newWhite,
  clippingNote:'Endpoint counts are descriptive, not proof of recovered highlights or perceptual quality.'};
}
async function png(directory,name,data,w=width,h=height) {
 const output=await run(ff,['-v','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size',`${w}x${h}`,
  '-i','pipe:0','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','pipe:1'],data,16*1024**2,'encode inspection PNG');
 return writeEvidenceArtifact(directory,name,output.data);
}
await assertEvidenceAncestry(testOutput);await assertEvidenceAncestry(retained);
assert.equal(evidenceDigest(await readEvidenceFile(worker,16*1024**2)),workerHash);
const evaluation=JSON.parse((await readEvidenceFile(join(retained,'evaluation.json'),1024**2)).toString('utf8'));
assert.deepEqual(evaluation.receipts.map(value=>value.name),samples.map(value=>value.name));
const adapter=JSON.parse((await run(worker,['--probe'],undefined,1024**2,'probe hardware')).data.toString('utf8'));
assert.equal(adapter.available,true);assert.equal(adapter.vendorId,0x8086,'This qualification slice is the Intel development host, not an NVIDIA measurement');
const output=await mkdtemp(join(testOutput,'subject-footage-grades-')),results=[];
for(const sample of samples) {
 const receipt=evaluation.receipts.find(value=>value.name===sample.name),input=join(retained,sample.name),destination=join(output,sample.name);
 await mkdir(destination);
 const base=join(input,'bounded-normalized-excerpt.mp4'),maskPath=join(input,'masks.partial/masks.pgmask');
 const baseData=await readEvidenceFile(base,128*1024**2),maskData=await readEvidenceFile(maskPath,32*1024**2);
 assert.equal(createHash('md5').update(baseData).digest('hex'),receipt.baseIdentity);
 assert.equal(evidenceDigest(maskData),receipt.maskReceipt.mask.sha256);
 const baseHash=evidenceDigest(baseData),maskHash=evidenceDigest(maskData),{single,alpha}=oneMask(maskData,sample.frame);
 await writeEvidenceArtifact(destination,'one-frame.pgmask',single);
 const conversion=`select=eq(n\\,${sample.frame}),scale=iw:ih:in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`;
 const source=(await run(ff,['-v','error','-nostdin','-threads','2','-i',base,'-an','-vf',conversion,
  '-filter_threads','1','-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],undefined,bytes+1024,'decode exact cached frame')).data;
 assert.equal(source.length,bytes);await png(destination,'base.png',source);
 const cases=casesFor(sample.subject),outputs=new Map(),checks=[];
 for(const recipe of cases) {
  const produced={};
  for(const backend of ['cpu','gpu']) {
   produced[backend]=await run(worker,['--finish-cached',String(width),String(height),String(recipe.gain),'32','1',backend,
    ...recipe.subject.map(String),recipe.global?'1':'0',...(recipe.global??recipe.disabledGlobal??neutral).map(String),join(destination,'one-frame.pgmask')],source,bytes+1024,`${sample.name}/${recipe.name}/${backend}`);
   const event=produced[backend].stderr.trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(value=>value.event==='finished');
   assert.ok(event);assert.equal(event.frames,1);assert.equal(event.backend,backend==='cpu'?'cpu':'d3d11');
  }
  const measured=inspect(source,produced.cpu.data,produced.gpu.data,alpha,recipe,outputs.get('global-only')?.cpu.data,outputs.get('global-only')?.gpu.data);
  if(recipe.disabledGlobal)for(const backend of ['cpu','gpu'])assert.deepEqual(produced[backend].data,outputs.get('subject-grade')[backend].data,'Disabled global grade must ignore saved non-neutral values');
  outputs.set(recipe.name,produced);
  if(recipe.name!=='neutral')await png(destination,`${recipe.name}.png`,produced.gpu.data);
  checks.push({recipe,...measured,cpuWallSeconds:produced.cpu.wallSeconds,d3dWallSeconds:produced.gpu.wallSeconds,
   timingNote:'Single cold-process frame diagnostics, not whole-pipeline throughput or isolated kernel benchmarks.'});
  console.log(JSON.stringify({sample:sample.name,frame:sample.frame,case:recipe.name,...measured}));
 }
 const grade=outputs.get('subject-grade').gpu.data,detail=outputs.get('subject-grade-detail').gpu.data;
 let maximumDetail=0,changedDetail=0;
 for(let i=0;i<bytes;i++) {const delta=Math.abs(grade[i]-detail[i]);maximumDetail=Math.max(maximumDetail,delta);changedDetail+=Number(delta!==0);assert.ok(delta<=3,'Detail must remain within three codes of its graded input');}
 assert.ok(changedDetail>0,'Detail interaction must execute, not no-op');
 const cropFiles=[];
 for(const crop of sample.crops) {
  const side=384,strip=Buffer.alloc(side*side*4*3),pictures=[source,grade,detail];
  assert.ok(crop.x>=0&&crop.y>=0&&crop.x+side<=width&&crop.y+side<=height);
  for(let panel=0;panel<3;panel++)for(let y=0;y<side;y++)pictures[panel].copy(strip,(y*side*3+panel*side)*4,((crop.y+y)*width+crop.x)*4,((crop.y+y)*width+crop.x+side)*4);
  const name=`crop-${crop.name}.png`;await png(destination,name,strip,side*3,side);cropFiles.push({...crop,path:name,panelOrder:['base','subject-grade','subject-grade-detail'],nativePixelScale:true});
 }
 assert.equal(evidenceDigest(await readEvidenceFile(base,128*1024**2)),baseHash);
 assert.equal(evidenceDigest(await readEvidenceFile(maskPath,32*1024**2)),maskHash);
 const html=`<!doctype html><meta charset="utf-8"><title>${sample.name} — grade checks</title><style>body{margin:24px;background:#111a24;color:#e8edf3;font:15px Segoe UI}img{max-width:100%;display:block}p{max-width:1000px;line-height:1.5}a{color:#e5bf73}</style><h1>${sample.name} · frame ${sample.frame}</h1><p>Cached normalized original, UHD pre-encode pixels. These are test stimuli, not a recommended look. The three panels below are Base / Subject grade / Subject grade plus 20% detail. Each source pixel maps to one output pixel in these 384×384 crops; a narrow viewport may scale the sheet. No inference or stabilization ran. No temporal, NVIDIA or release acceptance is implied.</p>${cropFiles.map(crop=>`<h2>${crop.name}</h2><img src="${crop.path}" alt="Base, subject grade and subject grade plus detail at matching crop coordinates">`).join('')}<h2>Full-resolution files</h2>${['base',...cases.filter(value=>value.name!=='neutral').map(value=>value.name)].map(name=>`<p><a href="${name}.png">${name}</a></p>`).join('')}`;
 await writeEvidenceArtifact(destination,'review.html',Buffer.from(html));
 results.push({sample:sample.name,frame:sample.frame,baseSha256:baseHash,maskSha256:maskHash,rgbaSha256:evidenceDigest(source),
  inputsUnchanged:true,checks,maximumDetailChannelDifferenceFromGrade:maximumDetail,changedDetailChannels:changedDetail,cropFiles});
}
assert.equal(evidenceDigest(await readEvidenceFile(worker,16*1024**2)),workerHash);
await writeEvidenceArtifact(output,'receipt.json',Buffer.from(JSON.stringify({schema:1,workerSha256:workerHash,adapter,results,
 inferenceExecuted:false,stabilizationExecuted:false,publicExportExecuted:false,subjectQualityAccepted:false,exportQualified:false,
 limits:'Two selected still frames, pre-encode SDR BT.709. No temporal/hard-close/long-clip/NVIDIA/installed-runtime or public export qualification.'},null,2)));
console.log(JSON.stringify({output,frames:results.length,inferenceExecuted:false,qualityAccepted:false}));
