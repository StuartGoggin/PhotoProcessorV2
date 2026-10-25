// Unclassified native failures never become private-path diagnostic text.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {bindHandoffTest} from './subject-finishing/handoff-test-receipt.mjs';
const root=resolve('.'),binary=resolve(process.argv[2]??'test-output/subject-handoff-fault-v7/bin/PhotoGoGo-Finishing-Test.exe');
const rel=relative(root,binary);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));
const verifyEvidence=await bindHandoffTest(binary,{faults:true});
const folder=await mkdtemp(join(root,'test-output','subject-handoff-redaction-'));
const output=join(folder,'must-not-publish');
const child=spawn(binary,['--preflight',output],{windowsHide:true,
 env:{...process.env,PHOTOGOGO_TEST_UNKNOWN_FAILURE:'1'},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',overflow=false,timeout=false;
const collect=(previous,data)=>{if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}return previous+data.toString('utf8');};
child.stdout.on('data',data=>{stdout=collect(stdout,data);});
child.stderr.on('data',data=>{stderr=collect(stderr,data);});
const timer=setTimeout(()=>{timeout=true;child.kill();},5000);
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
assert.equal(timeout,false);assert.equal(overflow,false);assert.equal(code,1);
assert.equal(stdout,'');assert.equal(JSON.parse(stderr.trim()).code,'READINESS_FAILED');
assert.ok(!stderr.includes('private-user-and-media-path'));
assert.equal(await stat(output).then(()=>true,()=>false),false);
await verifyEvidence();
console.log(JSON.stringify({event:'passed',seam:'native-unclassified-failure-redaction',productionExportQualified:false}));
