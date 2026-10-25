// Public refusal tracer: omitted idle confirmation and existing-folder protection.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, mkdir, writeFile, access} from 'node:fs/promises';
import {resolve, join, dirname, relative, isAbsolute} from 'node:path';
const root=resolve('.');
const binary=resolve(process.argv[2]??'test-output/subject-picture-handoff-v2/bin/PhotoGoGo-Cached-Picture-Test.exe');
assert.ok(process.argv.length<=3&&!isAbsolute(relative(root,binary))&&!relative(root,binary).startsWith('..'));
const receiptPath=join(dirname(dirname(binary)),'build-receipt.json');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const receiptSha=await hash(receiptPath),receipt=JSON.parse(await readFile(receiptPath));
assert.equal(receipt.kind,'native-cached-picture-handoff-build');assert.equal(receipt.testFaultsEnabled,false);
assert.equal(await hash(binary),receipt.executable.sha256);
for(const pin of receipt.sources)assert.equal(await hash(resolve(pin.path)),pin.sha256);
const folder=await mkdtemp(join(root,'test-output','subject-picture-refusal-'));
async function run(args) {
 const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='',timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill();},35000);
 child.stdout.on('data',data=>{out+=data;assert.ok(Buffer.byteLength(out)<65536);});
 child.stderr.on('data',data=>{err+=data;assert.ok(Buffer.byteLength(err)<65536);});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 assert.equal(timedOut,false);assert.equal(code,1);assert.equal(out,'');
 assert.ok(!err.includes(folder)&&!err.includes(root));return JSON.parse(err);
}
const unopened=join(folder,'not-created');
assert.deepEqual(await run(['--run-case',unopened,'--sample','black-horse','--backend','cpu']),
 {event:'cachedPictureFailed',code:'CONFIRM_IDLE_AND_SELECT_FIXED_CASE'});
await assert.rejects(access(unopened),{code:'ENOENT'});
const existing=join(folder,'existing');await mkdir(existing);await writeFile(join(existing,'sentinel.txt'),'keep-existing-user-content');
assert.deepEqual(await run(['--run-case',existing,'--sample','black-horse','--backend','cpu','--confirm-idle']),
 {event:'cachedPictureFailed',code:'NEW_OUTPUT_FOLDER_REQUIRED'});
assert.deepEqual(await readdir(existing),['sentinel.txt']);assert.equal(await readFile(join(existing,'sentinel.txt'),'utf8'),'keep-existing-user-content');
assert.equal(await hash(receiptPath),receiptSha);assert.equal(await hash(binary),receipt.executable.sha256);
for(const pin of receipt.sources)assert.equal(await hash(resolve(pin.path)),pin.sha256);
console.log(JSON.stringify({event:'passed',seam:'native-fixed-case-refusal',folder,checks:2,productionExportQualified:false}));
