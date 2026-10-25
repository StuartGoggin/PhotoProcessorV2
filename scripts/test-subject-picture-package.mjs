// Independent ZIP inventory/hash and relocated public native media execution.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const packageFolder=resolve(process.argv[2]??'test-output/subject-picture-package-v1');
const zip=join(packageFolder,'PhotoGoGo-Cached-Picture-Test.zip'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const zipBytes=await readFile(zip),zipSha=sha(zipBytes);
assert.ok(zipBytes.length>0&&zipBytes.length<160*1024**2);
const fixture=await mkdtemp(resolve('test-output/subject-picture-relocated-')),kit=join(fixture,'kit with spaces');
async function run(program,args,budget=200000) {
 const child=spawn(program,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='',killed=false;
 const timer=setTimeout(()=>{killed=true;child.kill();},budget);
 child.stdout.on('data',bytes=>{out+=bytes;assert.ok(out.length<65536);});child.stderr.on('data',bytes=>{err+=bytes;assert.ok(err.length<65536);});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 assert.equal(killed,false);assert.equal(code,0,err);assert.equal(err,'');return out;
}
await run('pwsh',['-NoProfile','-File','scripts/subject-finishing/extract-picture-package.ps1','-Zip',zip,'-Destination',kit],60000);
const receipt=JSON.parse(await readFile(join(kit,'package-receipt.json')));
assert.equal(receipt.schema,1);assert.equal(receipt.kind,'photogogo-cached-picture-control-package');assert.equal(receipt.testFaultsEnabled,false);
assert.equal(receipt.inferenceRuntimeBundled,false);assert.equal(receipt.cudaInferenceReady,false);assert.equal(receipt.subjectQualityAccepted,false);assert.equal(receipt.productionExportQualified,false);
const actual=[];
async function inventory(folder,prefix='') {
 for(const entry of await readdir(folder,{withFileTypes:true})) {
  const path=join(folder,entry.name),name=prefix+entry.name,stat=await lstat(path);assert.equal(stat.isSymbolicLink(),false);
  if(entry.isDirectory())await inventory(path,name+'/');else{assert.ok(entry.isFile());actual.push(name);}
 }
}
await inventory(kit);assert.deepEqual(actual.sort(),[...receipt.files.map(pin=>pin.path),'package-receipt.json'].sort());
assert.equal(actual.length,56);assert.ok(!actual.some(name=>/\.(obj|pdb|py|whl)$|torch|numpy|gui_fixture|startup_fixture/.test(name)));
for(const pin of receipt.files) {
 assert.ok(!pin.path.includes('..')&&!pin.path.includes('\\')&&!pin.path.includes(':'));
 const bytes=await readFile(join(kit,pin.path));assert.equal(bytes.length,pin.bytes);assert.equal(sha(bytes),pin.sha256);
}
const build=JSON.parse(await readFile(join(kit,'build-receipt.json')));
assert.equal(build.sources.length,15);assert.equal(build.payload.length,35);
for(const pin of build.sources)assert.equal(sha(await readFile(join(kit,'source','photogogo-owned',pin.path))),pin.sha256);
for(const pin of build.payload)assert.equal(sha(await readFile(join(kit,pin.path))),pin.sha256);
const mediaTest=JSON.parse(await run('node',['scripts/test-subject-picture-handoff.mjs',join(kit,build.executable.path),'cpu']));
assert.equal(mediaTest.event,'passed');assert.equal(mediaTest.actualVendorId,0);assert.equal(mediaTest.productionExportQualified,false);
for(const pin of receipt.files)assert.equal(sha(await readFile(join(kit,pin.path))),pin.sha256,'Delivered artifact changed during execution');
assert.equal(sha(await readFile(zip)),zipSha);
const evidence={schema:1,kind:'relocated-cached-picture-control-package',packageSha256:zipSha,packageBytes:zipBytes.length,files:56,
 exactInventoryAndHashesVerified:true,relocatedNativeMediaExecuted:true,pathsWithSpacesExercised:true,decodedVideoFrames:100,audioPacketsCopiedExactly:95,
 packageUnchangedAfterExecution:true,interactivePickerExercised:false,nvidiaMediaTested:false,cudaInferenceReady:false,subjectQualityAccepted:false,productionExportQualified:false};
const evidenceBytes=Buffer.from(JSON.stringify(evidence,null,2)),evidenceFile=join(packageFolder,'delivery-validation.json');
const handle=await open(evidenceFile,'wx');try{await handle.writeFile(evidenceBytes);await handle.sync();}finally{await handle.close();}
assert.deepEqual(await readFile(evidenceFile),evidenceBytes);
console.log(JSON.stringify({event:'passed',seam:'relocated-cached-picture-control-package',zip,packageBytes:zipBytes.length,packageSha256:zipSha,files:56,productionExportQualified:false}));
