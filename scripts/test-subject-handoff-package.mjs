// Public package seam: build a control ZIP, relocate it, then run its native report interface.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, lstat, open} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('.');
async function run(binary,args,timeoutMs=35000){
 const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',overflow=false,timeout=false;
 const collect=(previous,data)=>{if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}return previous+data.toString('utf8');};
 child.stdout.on('data',data=>{stdout=collect(stdout,data);});child.stderr.on('data',data=>{stderr=collect(stderr,data);});
 const timer=setTimeout(()=>{timeout=true;child.kill();},timeoutMs);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 assert.equal(timeout,false);assert.equal(overflow,false);assert.equal(code,0,stderr);return {stdout,stderr};
}
const candidate=process.argv[2]??'test-output/subject-handoff-readiness-v7';
const fault=process.argv[3]??'test-output/subject-handoff-fault-v7';
const output=process.argv[4]??'test-output/subject-handoff-readiness-package-v2';
await run('pwsh.exe',['-NoProfile','-File',join(root,'scripts','package-subject-handoff-readiness.ps1'),
 '-CandidateDirectory',candidate,'-FaultCandidateDirectory',fault,'-OutputDirectory',output],60000);
const zip=join(resolve(output),'PhotoGoGo-Readiness-Test.zip');
const zipBytes=await readFile(zip),zipHash=createHash('sha256').update(zipBytes).digest('hex');
const fixture=await mkdtemp(join(root,'test-output','subject-handoff-relocated-'));
const unpacked=join(fixture,'package with spaces');
await run('pwsh.exe',['-NoProfile','-File',join(root,'scripts','subject-finishing','extract-readiness-fixture.ps1'),
 '-Zip',zip,'-Destination',unpacked]);
const receipt=JSON.parse(await readFile(join(unpacked,'package-receipt.json'),'utf8'));
assert.equal(receipt.schema,1);assert.equal(receipt.kind,'photogogo-readiness-control-package');
assert.equal(receipt.testFaultsEnabled,false);assert.equal(receipt.mediaTestReady,false);assert.equal(receipt.productionExportQualified,false);
const actual=[];
async function inventory(dir,prefix=''){
 for(const item of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,item.name),rel=prefix+item.name,info=await lstat(path);assert.equal(info.isSymbolicLink(),false);
  if(item.isDirectory())await inventory(path,rel+'/');else{assert.ok(item.isFile());actual.push(rel);}
 }
}
await inventory(unpacked);
assert.deepEqual(actual.sort(),[...receipt.files.map(entry=>entry.path),'package-receipt.json'].sort());
for(const file of receipt.files){
 assert.match(file.path,/^(bin|evidence|source)\/|^README\.txt$/);
 assert.ok(!file.path.includes('..')&&!file.path.includes('\\')&&!file.path.includes(':'));
 const bytes=await readFile(join(unpacked,file.path));assert.equal(bytes.length,file.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
}
const report=join(fixture,'new report with spaces');
const runResult=await run(join(unpacked,'bin','PhotoGoGo-Finishing-Test.exe'),['--preflight',report]);
assert.equal(runResult.stderr,'');assert.equal(JSON.parse(runResult.stdout.trim()).event,'readinessReportSaved');
const readiness=JSON.parse(await readFile(join(report,'readiness-report.json'),'utf8'));
assert.equal(readiness.mode,'preflight-only');assert.equal(readiness.mediaFramesProcessed,0);assert.equal(readiness.cudaInferenceReady,false);
assert.equal(readiness.productionExportQualified,false);
for(const file of receipt.files)assert.equal(createHash('sha256').update(await readFile(join(unpacked,file.path))).digest('hex'),file.sha256,
 'A delivered artifact changed during the relocated run');
assert.equal(createHash('sha256').update(await readFile(zip)).digest('hex'),zipHash,'Transport ZIP changed during relocation');
const qualification={schema:1,kind:'relocated-native-readiness-package',packageBytes:zipBytes.length,packageSha256:zipHash,
 files:receipt.files.length+1,inventoryAndHashesVerified:true,nativeCliExecutedAfterRelocation:true,pathsWithSpacesExercised:true,
 reportReturned:true,packageUnchangedAfterExecution:true,interactivePickerExercised:false,
 cudaInferenceTested:false,mediaTestReady:false,subjectQualityAccepted:false,productionExportQualified:false};
const qualificationBytes=Buffer.from(JSON.stringify(qualification,null,2));
const qualificationPath=join(resolve(output),'delivery-validation.json');
const qualificationFile=await open(qualificationPath,'wx');
try{await qualificationFile.writeFile(qualificationBytes);await qualificationFile.sync();}finally{await qualificationFile.close();}
assert.deepEqual(await readFile(qualificationPath),qualificationBytes);
console.log(JSON.stringify({event:'passed',seam:'relocated-native-readiness-package',zip,packageBytes:zipBytes.length,
 packageSha256:zipHash,files:receipt.files.length+1,productionExportQualified:false}));
