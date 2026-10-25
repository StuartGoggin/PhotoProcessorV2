// Offline diagnostic reader only. No returned report can admit app export.
import {open,lstat,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const check=(condition,code)=>{if(!condition)throw new Error(code);};
async function ordinaryAncestors(folder) {
 for(let part=folder;;part=dirname(part)) {
  const stat=await lstat(part);
  check(stat.isDirectory()&&!stat.isSymbolicLink(),'REPORT_CONTRACT');
  if(dirname(part)===part)break;
 }
}
async function ordinaryBytes(path,limit,code) {
 let handle;
 try {
  const named=await lstat(path);check(named.isFile()&&!named.isSymbolicLink()&&named.size<=limit,code);
  handle=await open(path,'r');const before=await handle.stat();
  check(before.isFile()&&before.size===named.size&&before.ino===named.ino&&before.dev===named.dev,code);
  const bytes=Buffer.alloc(before.size);let used=0;
  while(used<bytes.length) {
   const result=await handle.read(bytes,used,bytes.length-used,used);
   check(result.bytesRead>0,code);used+=result.bytesRead;
  }
  const after=await handle.stat();const again=await lstat(path);
  check(after.size===before.size&&after.mtimeMs===before.mtimeMs&&again.ino===before.ino&&!again.isSymbolicLink(),code);
  return bytes;
 }catch{throw new Error(code);}finally{await handle?.close();}
}
export async function readPictureReport(folder,build,{requireOutput=false}={}) {
 folder=resolve(folder);await ordinaryAncestors(folder);
 const bytes=await ordinaryBytes(join(folder,'picture-report.json'),65536,'REPORT_CONTRACT');
 const marker=`picture-report.${sha(bytes)}.committed`;
 const markers=(await readdir(folder)).filter(name=>name.startsWith('picture-report.')&&name.endsWith('.committed'));
 check(markers.length===1&&markers[0]===marker,'COMPLETION_MARKER');
 check((await ordinaryBytes(join(folder,marker),0,'COMPLETION_MARKER')).length===0,'COMPLETION_MARKER');
 let report;try{report=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('REPORT_CONTRACT');}
 check(report&&report.schema===1&&report.kind==='photogogo-cached-picture-benchmark'&&
  report.buildProfile==='cached-picture-fixed35-sdr709-rgbq4-v1'&&
  report.completionProtocol==='zero-byte-report-sha256-marker-v1'&&
  build?.kind==='native-cached-picture-handoff-build'&&build.testFaultsEnabled===false&&
  hex(report.runnerSha256)&&report.runnerSha256===build.executable?.sha256,'REPORT_CONTRACT');
 check(['black-horse','white-horse'].includes(report.sample)&&['cpu','nvidia','default-gpu'].includes(report.backend),'REPORT_CONTRACT');
 for(const [field,file] of [['baseSha256','base.mp4'],['maskSha256','masks.pgmask'],['maskManifestSha256','manifest.json']])
  check(hex(report[field])&&report[field]===build.payload?.find(pin=>pin.path===`samples/${report.sample}/${file}`)?.sha256,'REPORT_CONTRACT');
 check(report.mediaManifestSha256===build.payload?.find(pin=>pin.path==='media/build-manifest.json')?.sha256,'REPORT_CONTRACT');
 check(report.outputFile===`${report.sample}-${report.backend}.mp4`&&hex(report.outputSha256)&&
  Number.isSafeInteger(report.outputBytes)&&report.outputBytes>0&&report.outputBytes<=64*1024**2,'REPORT_CONTRACT');
 check(report.decodedVideoFrames===100&&report.videoPackets===100&&report.audioPacketsCopiedExactly===95&&
  report.ownedActiveProcesses===0&&report.ownedPeakScope==='render-job-committed-bytes'&&
  Number.isSafeInteger(report.ownedPeakBytes)&&report.ownedPeakBytes>0&&report.ownedPeakBytes<=4*1024**3,'REPORT_CONTRACT');
 check(Number.isSafeInteger(report.actualVendorId)&&report.actualVendorId>=0&&report.actualVendorId<=65535&&
  Number.isSafeInteger(report.actualDeviceId)&&report.actualDeviceId>=0&&report.actualDeviceId<=65535&&
  report.cpuPictureParallelism===(report.backend==='cpu'?4:0)&&
  (report.backend!=='cpu'||(report.actualVendorId===0&&report.actualDeviceId===0))&&
  (report.backend==='cpu'||report.actualVendorId>0)&&
  (report.backend!=='nvidia'||report.actualVendorId===0x10de),'REPORT_CONTRACT');
 for(const [field,cap] of [['filterAndTransferMs',180000],['decodeFilterEncodeSeconds',90],['renderWallSeconds',95],['wallSeconds',180]])
  check(Number.isFinite(report[field])&&report[field]>0&&report[field]<=cap,'REPORT_CONTRACT');
 check(report.encoder==='libx264'&&report.profile==='limited-sdr709-yuv420p8','REPORT_CONTRACT');
 for(const field of ['cudaInferenceReady','inferenceRuntimeBundled','pixelParityChecked','continuousPlaybackReviewed','subjectQualityAccepted','productionExportQualified'])
  check(report[field]===false,'REPORT_CONTRACT');
 check(report.hostChanges&&Object.keys(report.hostChanges).length===3&&
  ['dependenciesInstalled','driverChanged','executionPolicyChanged'].every(key=>report.hostChanges[key]===false),'REPORT_CONTRACT');
 if(requireOutput) {
  const output=await ordinaryBytes(join(folder,report.outputFile),64*1024**2,'OUTPUT_IDENTITY');
  check(output.length===report.outputBytes&&sha(output)===report.outputSha256,'OUTPUT_IDENTITY');
 }
 return Object.freeze(report);
}
