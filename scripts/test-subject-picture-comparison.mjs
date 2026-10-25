// The no-development-tools workflow shares this public fixed-comparison seam.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {readPictureReport} from './subject-finishing/read-picture-report.mjs';
const binary=resolve(process.argv[2]??'test-output/subject-picture-handoff-v4/bin/PhotoGoGo-Cached-Picture-Test.exe');
const backend=process.argv[3]??'default-gpu';
const unavailable=process.argv[4]==='--expect-nvidia-unavailable';
assert.ok(!unavailable||backend==='nvidia');
const build=JSON.parse(await readFile(join(dirname(dirname(binary)),'build-receipt.json')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(await readFile(binary)),build.executable.sha256);
assert.equal(build.kind,'native-cached-picture-handoff-build');assert.equal(build.testFaultsEnabled,false);
const parent=await mkdtemp(resolve('test-output/subject-picture-comparison-')),folder=join(parent,'new session');
const child=spawn(binary,['--run-comparison',folder,'--confirm-idle','--gpu-backend',backend],
 {windowsHide:true,stdio:['ignore','pipe','pipe']});
let out='',err='',killed=false;const timer=setTimeout(()=>{killed=true;child.kill();},770000);
child.stdout.on('data',bytes=>{out+=bytes;assert.ok(Buffer.byteLength(out)<65536);});
child.stderr.on('data',bytes=>{err+=bytes;assert.ok(Buffer.byteLength(err)<65536);});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
assert.equal(killed,false);assert.equal(code,0,err);assert.equal(err,'');
const text=await readFile(join(folder,'comparison-report.json'));
const report=JSON.parse(text);
assert.equal(report.kind,'photogogo-cached-picture-comparison');assert.equal(report.schema,1);
assert.equal(report.runnerSha256,build.executable.sha256);assert.equal(report.status,unavailable?'partial':'complete');
assert.equal(report.cudaInferenceReady,false);assert.equal(report.subjectQualityAccepted,false);assert.equal(report.productionExportQualified,false);
assert.equal(report.observationsPerCase,1);assert.equal(report.cases.length,4);
const expected=[['black-horse','cpu'],['black-horse',backend],['white-horse',backend],['white-horse','cpu']];
for(let n=0;n<4;n++) {
 const item=report.cases[n];assert.equal(item.sample,expected[n][0]);assert.equal(item.backend,expected[n][1]);
 if(unavailable&&item.backend==='nvidia') {
  assert.equal(item.status,'failed');assert.match(item.code,/^[A-Z_]+$/);assert.equal(item.report,undefined);
  assert.ok(!(await readdir(join(folder,`case-${n+1}`))).some(name=>name.endsWith('.committed')));continue;
 }
 assert.equal(item.status,'passed');
 const source=join(folder,`case-${n+1}`),record=await readPictureReport(source,build,{requireOutput:true});
 assert.equal(item.reportSha256,sha(await readFile(join(source,'picture-report.json'))));
 assert.deepEqual(item.report,record);
}
const marker=`comparison-report.${sha(text)}.committed`;
const info=await lstat(join(folder,marker));assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(info.size,0);
assert.ok((await readdir(folder)).includes('PhotoGoGo-Return-Reports.zip'));
console.log(JSON.stringify({event:'passed',seam:'portable-four-fixed-case-comparison',folder,backend,productionExportQualified:false}));
