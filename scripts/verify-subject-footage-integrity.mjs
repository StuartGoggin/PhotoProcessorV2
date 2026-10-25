// Independent media/pixel qualification. Integrity is NOT visual acceptance.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const folder=resolve(process.argv[2]||'test-output/subject-footage-evaluation-1791597148390');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe',probe=ff.replace('ffmpeg.exe','ffprobe.exe');
const worker=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
async function run(binary,args,input,limit=64*1024**2){
 const child=spawn(binary,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let bytes=0,out=[],err='';
 const timer=setTimeout(()=>child.kill(),30000);
 child.stdout.on('data',v=>{bytes+=v.length;if(bytes>limit)child.kill();else out.push(v);});
 child.stderr.on('data',v=>{err+=v;if(err.length>1024**2)child.kill();});child.stdin.on('error',()=>{});child.stdin.end(input);
 const code=await new Promise((done,reject)=>{child.on('error',reject);child.on('close',done);}).finally(()=>clearTimeout(timer));
 assert.equal(code,0,`${binary} failed: ${err}`);assert.ok(bytes<=limit,'Output exceeds bound');return {out:Buffer.concat(out),err};
}
const receipts=JSON.parse(await readFile(join(folder,'evaluation.json'),'utf8')).receipts,result=[];
for(const receipt of receipts){
 const directory=join(folder,receipt.name),base=join(directory,'bounded-normalized-excerpt.mp4'),finished=join(directory,'finished-excerpt.mp4');
 const profiles=[];
 for(const file of [base,finished]){
  const info=JSON.parse((await run(probe,['-v','error','-show_streams','-of','json',file],undefined,1024**2)).out);
  const v=info.streams.find(s=>s.codec_type==='video');
  for(const [key,value]of Object.entries({width:3840,height:2160,nb_frames:'100',r_frame_rate:'50/1',avg_frame_rate:'50/1',
   pix_fmt:'yuv420p',color_range:'tv',color_space:'bt709',color_transfer:'bt709',color_primaries:'bt709',field_order:'progressive'}))assert.equal(v[key],value,`${receipt.name} ${key}`);
  const packets=JSON.parse((await run(probe,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,duration_time','-of','json',file],undefined,1024**2)).out).packets;
  const stamps=packets.map(p=>Number(p.pts_time)).sort((a,b)=>a-b);assert.equal(stamps.length,100);
  stamps.forEach((stamp,i)=>assert.ok(Math.abs(stamp-i/50)<1e-6,`Wrong integer frame ${i}`));
  profiles.push(info.streams.map(s=>({type:s.codec_type,codec:s.codec_name,width:s.width,height:s.height,frames:s.nb_frames,sampleRate:s.sample_rate,channels:s.channels,start:s.start_time,duration:s.duration})));
 }
 // Bit-identical AAC packet payloads, timing and side data across finishing.
 const audio=[];
 for(const file of[base,finished])audio.push(JSON.parse((await run(probe,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256',
  '-show_entries','packet=pts_time,dts_time,duration_time,size,data_hash,side_data_list','-of','json',file],undefined,4*1024**2)).out).packets);
 assert.ok(audio[0].length>0);assert.deepEqual(audio[1],audio[0],'Finishing must preserve exact base audio packets/timing');
 const mask=await readFile(join(directory,'masks.partial/masks.pgmask'));assert.equal(mask.subarray(0,8).toString(),'PGMSK001');
 const mw=mask.readUInt32LE(8),mh=mask.readUInt32LE(12),count=mask.readUInt32LE(16);assert.equal(count,100);
 let at=20;const candidates=new Map();for(let frame=0;frame<count;frame++){
  const size=mask.readUInt32LE(at);at+=4;assert.ok(size>0&&size%5===0&&at+size<=mask.length);
  if([25,75].includes(frame)){const alpha=Buffer.alloc(mw*mh);let pixel=0;
   for(let pos=at;pos<at+size;pos+=5){const length=mask.readUInt32LE(pos);assert.ok(length>0&&pixel+length<=alpha.length);alpha.fill(mask[pos+4],pixel,pixel+length);pixel+=length;}
   assert.equal(pixel,alpha.length);candidates.set(frame,{alpha,payload:mask.subarray(at,at+size)});}
  at+=size;
 }assert.equal(at,mask.length);
 const pixels=[];
 for(const[frame,{alpha,payload}]of candidates){
  const single=Buffer.alloc(24+payload.length);mask.copy(single,0,0,20);single.writeUInt32LE(1,16);single.writeUInt32LE(payload.length,20);payload.copy(single,24);
  const maskPath=join(directory,`verification-mask-${frame}.pgmask`);await writeFile(maskPath,single,{flag:'wx'});
  const rgba=(await run(ff,['-v','error','-nostdin','-threads','2','-ss',String(frame/50),'-i',base,'-frames:v','1','-an','-vf','format=rgba','-filter_threads','1','-threads','1','-f','rawvideo','-pix_fmt','rgba','-'])).out;
  assert.equal(rgba.length,3840*2160*4);
  const args=backend=>['--finish-cached','3840','2160','26','32','1',backend,'0','1','1','0','0','0','1','1','0',maskPath];
  const cpu=await run(worker,args('cpu'),rgba),gpu=await run(worker,args('gpu'),rgba);assert.deepEqual(gpu.out,cpu.out,'Actual-footage CPU/GPU finishing parity');
  assert.equal(gpu.out.length,rgba.length);let background=0,subject=0,changed=0,maxDelta=0;
  for(let y=0;y<2160;y++)for(let x=0;x<3840;x++){
   const a=alpha[Math.floor(y*mh/2160)*mw+Math.floor(x*mw/3840)],p=(y*3840+x)*4;assert.equal(gpu.out[p+3],rgba[p+3]);
   if(a===0){background++;for(let c=0;c<3;c++)assert.equal(gpu.out[p+c],rgba[p+c],`Background filter spill at ${x},${y}`);}
   else{subject++;let different=false;for(let c=0;c<3;c++){const delta=Math.abs(gpu.out[p+c]-rgba[p+c]);maxDelta=Math.max(maxDelta,delta);different||=delta!==0;}changed+=Number(different);}
  }
  assert.ok(subject>0&&background>0&&changed>0,'Actual subject effect must execute, not no-op');
  // Full-resolution pixel inspection, not a downscaled video/thumbnail export.
  const dir=join(directory,'pixel-verification');await mkdir(dir,{recursive:true});
  for(const[name,data]of[['base',rgba],['filtered',gpu.out]]){
   await run(ff,['-v','error','-nostdin','-n','-f','rawvideo','-pixel_format','rgba','-video_size','3840x2160','-i','-','-frames:v','1','-threads','1',join(dir,`${name}-${frame}.png`)],data);
  }
  pixels.push({frame,backgroundPixelsExact:background,subjectPixels:subject,changedSubjectPixels:changed,maxSubjectChannelDelta:maxDelta,cpuGpuExact:true,
   note:'Pre-encode pixels. Final H.264 re-encoding may change background samples without applying a background filter.'});
 }
 result.push({sample:receipt.name,profiles,audioPacketsCopiedExactly:audio[0].length,pixels,integrityPassed:true,subjectQualityAccepted:false});
 console.log(`PASS: ${receipt.name}: 100 exact UHD/50fps SDR frames, ${audio[0].length} identical audio packets; actual full-resolution CPU/GPU parity and zero-alpha background pixels unchanged.`);
}
await writeFile(join(folder,'independent-integrity.json'),JSON.stringify({schema:1,result,subjectQualityAccepted:false},null,2),{flag:'wx'});
