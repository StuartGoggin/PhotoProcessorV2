// Actual redirected descendant: no write may escape the new candidate.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readdir,access,lstat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
const root=resolve('.'),folder=await mkdtemp(join(root,'test-output','subject-picture-staging-'));
const outside=join(folder,'outside');await mkdir(outside);const candidate=join(folder,'candidate');
const child=spawn('pwsh',['-NoProfile','-File','scripts/build-subject-picture-handoff.ps1',
 '-CandidateDirectory',relative(root,candidate),'-StagingOnly','-StagingJunctionFixture',outside],
 {windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='',killed=false;
const timer=setTimeout(()=>{killed=true;child.kill();},30000);
child.stdout.on('data',chunk=>{out+=chunk;assert.ok(Buffer.byteLength(out)<65536);});
child.stderr.on('data',chunk=>{err+=chunk;assert.ok(Buffer.byteLength(err)<65536);});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
assert.equal(killed,false);assert.equal(code,1);assert.match(err,/Ordinary staging\/input lease refused/);
assert.equal((await lstat(join(candidate,'media'))).isSymbolicLink(),true);
assert.deepEqual(await readdir(outside),[],'Redirected target must remain empty');
await assert.rejects(access(join(candidate,'build-receipt.json')),{code:'ENOENT'});
console.log(JSON.stringify({event:'passed',seam:'build-staging-junction-refusal',folder,externalFilesCreated:0,productionExportQualified:false}));
