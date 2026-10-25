// Public native command invoked via a file-level alias must not treat the alias as an immutable executable.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, symlink, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {bindHandoffTest} from './subject-finishing/handoff-test-receipt.mjs';
const root=resolve('.'),binary=resolve(process.argv[2]??'test-output/subject-handoff-readiness-v7/bin/PhotoGoGo-Finishing-Test.exe');
const verifyEvidence=await bindHandoffTest(binary);
const folder=await mkdtemp(join(root,'test-output','subject-handoff-executable-alias-'));
const alias=join(folder,'aliased-readiness.exe'),output=join(folder,'must-not-publish');
try {await symlink(binary,alias,'file');}catch(error){
 if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;
 await verifyEvidence();
 console.log(JSON.stringify({event:'skipped',seam:'native-executable-alias-refusal',reason:'host-does-not-permit-file-symlinks',productionExportQualified:false}));
 process.exit(0);
}
const child=spawn(alias,['--preflight',output],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',overflow=false,timeout=false;
const collect=(previous,data)=>{if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}return previous+data.toString('utf8');};
child.stdout.on('data',data=>{stdout=collect(stdout,data);});child.stderr.on('data',data=>{stderr=collect(stderr,data);});
const timer=setTimeout(()=>{timeout=true;child.kill();},5000);
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
assert.equal(timeout,false);assert.equal(overflow,false);assert.equal(code,1);
assert.equal(stdout,'');assert.equal(JSON.parse(stderr.trim()).code,'INSPECTOR_IDENTITY_UNAVAILABLE');
assert.equal(await stat(output).then(()=>true,()=>false),false);
await verifyEvidence();
console.log(JSON.stringify({event:'passed',seam:'native-executable-alias-refusal',productionExportQualified:false}));
