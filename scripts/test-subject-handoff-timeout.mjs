// Public launcher deadline, using a separately built, unshippable hardware-fault fixture.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {bindHandoffTest} from './subject-finishing/handoff-test-receipt.mjs';
const root=resolve('.'),binary=resolve(process.argv[2]??'test-output/subject-handoff-fault-v7/bin/PhotoGoGo-Finishing-Test.exe');
const rel=relative(root,binary);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));
const verifyEvidence=await bindHandoffTest(binary,{faults:true});
const folder=await mkdtemp(join(root,'test-output','subject-handoff-timeout-'));
const output=join(folder,'must-not-publish');
const started=performance.now();
const child=spawn(binary,['--preflight',output,'--deadline-seconds','2'],{windowsHide:true,
 env:{...process.env,PHOTOGOGO_TEST_READINESS_STALL:'1'},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',overflow=false;
const collect=(previous,data)=>{if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}return previous+data.toString('utf8');};
child.stdout.on('data',data=>{stdout=collect(stdout,data);});
child.stderr.on('data',data=>{stderr=collect(stderr,data);});
let wrapperTimeout=false;
const timer=setTimeout(()=>{wrapperTimeout=true;child.kill();},8000);
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
assert.equal(wrapperTimeout,false,'The native launcher must enforce the deadline, not this test wrapper');
assert.equal(overflow,false);
assert.equal(code,1);
assert.equal(JSON.parse(stderr.trim()).code,'HARDWARE_INSPECTION_TIMEOUT');
assert.equal(stdout,'');
const elapsed=performance.now()-started;
assert.ok(elapsed>=1900&&elapsed<8000,'Deadline must be reached, then the owned inspector must drain');
assert.equal(await stat(output).then(()=>true,()=>false),false,'No readiness completion may be published after timeout');
await verifyEvidence();
console.log(JSON.stringify({event:'passed',seam:'native-hardware-inspection-deadline',elapsedMilliseconds:elapsed,
 productionExportQualified:false}));
