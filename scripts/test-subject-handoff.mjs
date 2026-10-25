// Approved public handoff seam: a native user-run executable and its returned report.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, stat} from 'node:fs/promises';
import {resolve, join, relative, isAbsolute} from 'node:path';
import {bindHandoffTest} from './subject-finishing/handoff-test-receipt.mjs';

const root=resolve('.');
const binary=resolve(process.argv[2]??'test-output/subject-handoff-readiness-v7/bin/PhotoGoGo-Finishing-Test.exe');
const rel=relative(root,binary);
assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'),'Only an isolated-worktree test executable is admitted');
assert.ok(process.argv.length<=3,'Select only the built native executable');
const verifyEvidence=await bindHandoffTest(binary);
const folder=await mkdtemp(join(root,'test-output','subject-handoff-test-'));
const privateMarker='private-user-and-media-path';
const reportDirectory=join(folder,privateMarker);
const child=spawn(binary,['--preflight',reportDirectory],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',overflow=false,timedOut=false;
const collect=(previous,data)=>{
 if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}
 return previous+data.toString('utf8');
};
child.stdout.on('data',chunk=>{stdout=collect(stdout,chunk);});
child.stderr.on('data',chunk=>{stderr=collect(stderr,chunk);});
const timer=setTimeout(()=>{timedOut=true;child.kill();},35000);
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);})
 .finally(()=>clearTimeout(timer));
assert.equal(code,0,stderr);assert.equal(timedOut,false);assert.equal(overflow,false);
assert.equal(stderr,'');
const reportBytes=await readFile(join(reportDirectory,'readiness-report.json'));
assert.ok(reportBytes.length<=65536);
const report=JSON.parse(reportBytes);
assert.equal(report.schema,1);
assert.equal(report.kind,'photogogo-subject-finishing-readiness');
assert.equal(report.mode,'preflight-only');
assert.equal(report.productionExportQualified,false);
assert.equal(report.subjectQualityAccepted,false);
assert.equal(report.cudaInferenceReady,false);
assert.equal(report.mediaTestReady,false);
assert.equal(report.inferenceRuntimeBundled,false);
assert.equal(report.mediaFramesProcessed,0);
assert.deepEqual(report.hostChanges,{dependenciesInstalled:false,driverChanged:false,executionPolicyChanged:false});
assert.ok(Number.isSafeInteger(report.host.logicalProcessors)&&report.host.logicalProcessors>0);
assert.ok(Number.isSafeInteger(report.host.availablePhysicalBytes)&&report.host.availablePhysicalBytes>0);
assert.ok(Array.isArray(report.host.adapters)&&report.host.adapters.length<=16);
assert.equal(report.nvidiaAdapterPresent,report.host.adapters.some(adapter=>adapter.vendorId===4318&&!adapter.software));
assert.equal(typeof report.d3d11ShaderReady,'boolean');
for(const adapter of report.host.adapters){
 assert.equal(typeof adapter.description,'string');
 assert.ok(adapter.description.length<=128);
 assert.ok(Number.isSafeInteger(adapter.vendorId)&&adapter.vendorId>=0&&adapter.vendorId<=65535);
 assert.ok(Number.isSafeInteger(adapter.dedicatedBytes)&&adapter.dedicatedBytes>=0);
 assert.equal(typeof adapter.software,'boolean');
}
assert.deepEqual(await readdir(reportDirectory),['readiness-report.json']);
assert.ok((await stat(join(reportDirectory,'readiness-report.json'))).isFile());
for(const value of [reportBytes.toString('utf8'),stdout,stderr]){
 assert.ok(!value.includes(privateMarker),'Shared diagnostics must not contain the private selected output path');
 assert.ok(!value.includes(root),'Shared diagnostics must not contain checkout/user paths');
}
await verifyEvidence();
console.log(JSON.stringify({event:'passed',seam:'native-user-run-readiness',folder,
 mediaTestReady:false,productionExportQualified:false}));
