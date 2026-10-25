// Cache-only visual inspection of the two authorized, already-generated excerpts.
// No inference, original-media writes, app qualification or release permission.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {assertEvidenceAncestry, readEvidenceFile, evidenceDigest, writeEvidenceArtifact} from './subject-finishing/runtime/evidence-files.mjs';

const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const probe=ff.replace('ffmpeg.exe','ffprobe.exe');
const retained=resolve('test-output/subject-footage-evaluation-1791597148390');
const testOutput=resolve('test-output');
await assertEvidenceAncestry(testOutput);
await assertEvidenceAncestry(retained);
const evaluation=JSON.parse((await readEvidenceFile(join(retained,'evaluation.json'),1024**2)).toString('utf8'));
assert.equal(evaluation.receipts.length,2);
assert.deepEqual(evaluation.receipts.map(item=>item.name),['black-horse','white-horse']);
const output=await mkdtemp(join(testOutput,'subject-retained-sequence-review-'));
const results=[];
function run(binary,args,input) {
 const response=spawnSync(binary,args,{input,windowsHide:true,timeout:45000,maxBuffer:2*1024**2});
 assert.equal(response.status,0,`${binary} failed: ${String(response.stderr||'').slice(0,2000)} ${response.error?.message||''}`);
 return response.stdout;
}
for(const sample of evaluation.receipts) {
 const input=join(retained,sample.name),destination=join(output,sample.name);
 await mkdir(destination);
 const mask=await readEvidenceFile(join(input,'masks.partial/masks.pgmask'),32*1024**2);
 assert.equal(evidenceDigest(mask),sample.maskReceipt.mask.sha256);
 assert.equal(mask.subarray(0,8).toString('ascii'),'PGMSK001');
 const width=mask.readUInt32LE(8),height=mask.readUInt32LE(12),count=mask.readUInt32LE(16);
 assert.equal(width,1024);assert.equal(height,576);assert.equal(count,100);
 const base=join(input,'bounded-normalized-excerpt.mp4');
 const baseBytes=await readEvidenceFile(base,128*1024**2);
 assert.equal(createHash('md5').update(baseBytes).digest('hex'),sample.baseIdentity);
 const beforeBase=evidenceDigest(baseBytes),beforeMask=evidenceDigest(mask);
 const rgba=Buffer.alloc(512*288*4*100);let cursor=20;
 for(let frame=0;frame<count;frame++) {
  assert.ok(cursor+4<=mask.length);const length=mask.readUInt32LE(cursor);cursor+=4;
  assert.ok(length>0&&length%5===0&&cursor+length<=mask.length);
  const alpha=Buffer.alloc(width*height);let pixel=0;
  for(let at=cursor;at<cursor+length;at+=5) {
   const run=mask.readUInt32LE(at);assert.ok(run>0&&pixel+run<=alpha.length);
   alpha.fill(mask[at+4],pixel,pixel+run);pixel+=run;
  }
  assert.equal(pixel,alpha.length);cursor+=length;
  for(let y=0;y<288;y++)for(let x=0;x<512;x++) {
   const target=(frame*512*288+y*512+x)*4;
   rgba[target]=230;rgba[target+1]=181;rgba[target+2]=46;
   rgba[target+3]=Math.round(alpha[(y*2)*width+x*2]*0.38);
  }
 }
 assert.equal(cursor,mask.length);
 const overlay=join(destination,'mask-overlay-review.mp4');
 run(ff,['-v','error','-nostdin','-n','-threads','2','-i',base,'-f','rawvideo','-pixel_format','rgba',
  '-video_size','512x288','-framerate','50','-i','pipe:0','-filter_complex_threads','1',
  '-filter_complex','[0:v]scale=512:288:flags=bilinear,setsar=1[base];[base][1:v]overlay=shortest=1:format=auto,format=yuv420p[out]',
  '-map','[out]','-an','-frames:v','100','-r','50','-c:v','libx264','-threads','2','-preset','veryfast','-crf','18',
  '-color_range','tv','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709',overlay],rgba);
 const info=JSON.parse(run(probe,['-v','error','-show_streams','-of','json',overlay]).toString('utf8'));
 const video=info.streams.find(stream=>stream.codec_type==='video');
 assert.equal(video.width,512);assert.equal(video.height,288);assert.equal(video.nb_frames,'100');assert.equal(video.r_frame_rate,'50/1');
 const sheets=[];
 for(let first=0;first<100;first+=25) {
  const name=`frames-${first}-${first+24}.png`;
  run(ff,['-v','error','-nostdin','-n','-threads','2','-i',overlay,'-an','-vf',
   `select=between(n\\,${first}\\,${first+24}),tile=5x5`,'-frames:v','1','-threads','1',join(destination,name)]);
  sheets.push({path:name,first,last:first+24,rowMajorFrameOrder:true});
 }
 assert.equal(evidenceDigest(await readEvidenceFile(base,128*1024**2)),beforeBase);
 assert.equal(evidenceDigest(await readEvidenceFile(join(input,'masks.partial/masks.pgmask'),32*1024**2)),beforeMask);
 const title=sample.name==='white-horse'?'White horse with running handler':'Black horse with mounted rider';
 const sheetsHtml=sheets.map(sheet=>`<section><h2>Frames ${sheet.first}–${sheet.last}, row-major order</h2><div class="sheet"><img src="${sheet.path}" alt="Twenty-five sequential mask overlay frames"><div class="labels">${Array.from({length:25},(_,index)=>`<span>Frame ${sheet.first+index}</span>`).join('')}</div></div></section>`).join('');
 const html=`<!doctype html><meta charset="utf-8"><title>${title} — retained-mask inspection</title><style>body{max-width:1440px;margin:24px auto;background:#111a24;color:#e8edf3;font:15px Segoe UI;padding:0 18px}video{width:100%;max-width:1024px}h2{font-size:16px}.sheet{position:relative}.sheet img{display:block;width:100%}.labels{position:absolute;inset:0;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(5,1fr);pointer-events:none}.labels span{align-self:end;justify-self:start;padding:2px 6px;background:#111b;border-radius:3px;font-size:11px}p{line-height:1.5}a{color:#e5bf73}</style><h1>${title}</h1><p>Gold shows the cached affected region across all 100 frames (two seconds, 50 fps). This downscaled 512×288 view can reveal gross leakage/dropout and handoff discontinuities, but does not qualify fine edges, continuous playback, semantic identity, stabilization, NVIDIA performance or release. No inference was rerun.</p><video src="mask-overlay-review.mp4" controls loop preload="metadata"></video><p>Play at normal speed, then inspect the sequential sheets. Finishing and the UHD before/after files remain in the separate retained evaluation folder. This overlay is an inspection artifact, not an exported project or user photograph.</p>${sheetsHtml}`;
 await writeEvidenceArtifact(destination,'review.html',Buffer.from(html));
 results.push({name:sample.name,case:title,frames:100,fps:50,seconds:2,maskSha256:beforeMask,baseSha256:beforeBase,
  overlay:'mask-overlay-review.mp4',sheets,inputsUnchanged:true,inferenceExecuted:false,qualityAccepted:false});
}
await writeEvidenceArtifact(output,'review-index.json',Buffer.from(JSON.stringify({schema:1,results,
 description:'Cache-only inspection artifact. Generation is not proof that playback/all frames were reviewed.',
 continuousPlaybackReviewed:false,semanticQualityAccepted:false,exportQualified:false},null,2)));
console.log(JSON.stringify({output,clips:results.length,frames:200,inferenceExecuted:false,qualityAccepted:false}));
