// Public report publication: existing data and redirected/nonexistent roots are refused.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, readdir, symlink, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {bindHandoffTest} from './subject-finishing/handoff-test-receipt.mjs';
const root=resolve('.'),binary=resolve(process.argv[2]??'test-output/subject-handoff-readiness-v7/bin/PhotoGoGo-Finishing-Test.exe');
const rel=relative(root,binary);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));
const verifyEvidence=await bindHandoffTest(binary);
const folder=await mkdtemp(join(root,'test-output','subject-handoff-paths-'));
async function refuses(output,expectedCode){
 const child=spawn(binary,['--preflight',output],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',overflow=false,timeout=false;
 const collect=(previous,data)=>{if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}return previous+data.toString('utf8');};
 child.stdout.on('data',data=>{stdout=collect(stdout,data);});
 child.stderr.on('data',data=>{stderr=collect(stderr,data);});
 const timer=setTimeout(()=>{timeout=true;child.kill();},35000);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 assert.equal(timeout,false);assert.equal(overflow,false);assert.equal(code,1);
 assert.equal(stdout,'');assert.equal(JSON.parse(stderr.trim()).code,expectedCode);
 assert.ok(!stderr.includes(output),'Failure codes must not expose private selected paths');
}
const existing=join(folder,'existing'),sentinel='preserve this caller-owned content';
await mkdir(existing);await writeFile(join(existing,'sentinel.txt'),sentinel,{flag:'wx'});
await refuses(existing,'REPORT_OUTPUT_ALREADY_EXISTS');
assert.deepEqual(await readdir(existing),['sentinel.txt']);
assert.equal(await readFile(join(existing,'sentinel.txt'),'utf8'),sentinel);
const destination=join(folder,'ordinary-destination'),redirect=join(folder,'redirect');
await mkdir(destination);await symlink(destination,redirect,'junction');
await refuses(join(redirect,'must-not-publish'),'REPORT_REDIRECTION_REFUSED');
assert.deepEqual(await readdir(destination),[]);
// This dev host has no Z: volume. A missing volume must fail the volume gate,
// rather than trying to interpret an arbitrary drive-letter path as local storage.
assert.equal(await stat('Z:\\').then(()=>true,()=>false),false,'Use this fixture only on a host without a Z: volume');
await refuses('Z:\\PhotoGoGo-must-not-publish','REPORT_VOLUME_NOT_LOCAL');
await verifyEvidence();
console.log(JSON.stringify({event:'passed',seam:'native-report-path-refusal',
 cases:['existing-data-preserved','junction-refused','missing-volume-refused'],productionExportQualified:false}));
