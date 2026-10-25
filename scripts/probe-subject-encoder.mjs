// Fixed qualification inputs. No pack edits, publication or production modes.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readEvidenceFile,writeEvidenceArtifact,evidenceDigest} from './subject-finishing/runtime/evidence-files.mjs';
const threads=Number(process.argv[2]||8);if(![4,8].includes(threads))throw new Error('Use the fixed 4- or 8-thread diagnostic');
const attention=process.argv[3]==='attention';
const tracking=attention||process.argv[3]==='tracking';if(process.argv[3]&&!tracking)throw new Error('Only the bounded tracking/attention diagnostic is available');
if(tracking&&threads!==8)throw new Error('Tracking probe fixes the unchanged eight-thread profile');
const root=resolve('.build-cache/subject-finishing-manual-cpu-v1');
const directory=resolve(`test-output/subject-${attention?'attention-probe':tracking?'tracking-probe':'encoder'}-${threads}-${Date.now()}`);await mkdir(directory);
const runtime=join(root,'runtime'),windows=process.env.SystemRoot;
if(!windows)throw new Error('Missing authoritative Windows root');
const args=['-I','-S','-B','-u',resolve('scripts/subject-finishing/probe-sam-encoder.py'),'--runtime-root',root,
 '--source',resolve('test-output/subject-footage-evaluation-1791597148390/black-horse/bounded-normalized-excerpt.mp4'),
 '--ffmpeg','C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe','--threads',String(threads),'--receipt',join(directory,'receipt.json')];
if(tracking)args.push('--tracking');
if(attention)args.push('--attention');
const pins=new Map();
if(attention)for(const name of ['scripts/probe-subject-encoder.mjs','scripts/subject-finishing/probe-sam-encoder.py',
 'scripts/subject-finishing/probe-sam-tracking.py','scripts/subject-finishing/probe-sam-attention.py',
 '.build-cache/subject-finishing-manual-cpu-v1/runtime-manifest.json'])pins.set(name,evidenceDigest(await readEvidenceFile(resolve(name))));
const child=spawn(join(runtime,'python.exe'),args,{windowsHide:true,cwd:runtime,stdio:['ignore','pipe','pipe'],env:{
 SystemRoot:windows,windir:windows,PATH:`${runtime};${join(runtime,'Lib/site-packages/torch/lib')};${windows}/System32`,
 NVTOOLSEXT_PATH:runtime,PYTHONUSERBASE:runtime,TEMP:directory,TMP:directory,
 HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',OMP_NUM_THREADS:String(threads),MKL_NUM_THREADS:String(threads)}});
let stdout='',stderr='',expired=false;const timer=setTimeout(()=>{expired=true;child.kill();},attention?240000:tracking?180000:120000);
child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>512*1024)child.kill();else process.stdout.write(bytes);});
child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>512*1024)child.kill();});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
await writeFile(join(directory,'stdout.txt'),stdout,{flag:'wx'});await writeFile(join(directory,'stderr.txt'),stderr,{flag:'wx'});
if(code!==0||expired)throw new Error(`Bounded encoder probe failed: code=${code}, deadline=${expired}; ${directory}; ${stderr.slice(-2000)}`);
if(attention){
 const receipt=JSON.parse(await readEvidenceFile(join(directory,'receipt.json')));
 if(!receipt.tracking?.cpuAttention||receipt.maskQualityAccepted!==false)throw new Error('Missing diagnostic-only attention receipt');
 for(const [name,digest] of pins)if(evidenceDigest(await readEvidenceFile(resolve(name)))!==digest)throw new Error('Attention diagnostic input changed');
 await writeEvidenceArtifact(directory,'provenance.json',Buffer.from(JSON.stringify({schema:1,diagnosticOnly:true,
  inputs:Object.fromEntries(pins),receiptSha256:evidenceDigest(await readEvidenceFile(join(directory,'receipt.json'))),qualityAccepted:false,exportQualified:false},null,2)));
}
console.log(JSON.stringify({directory,threads,diagnosticOnly:true}));
