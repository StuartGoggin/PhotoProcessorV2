// Force the public render wall budget on the real CPU/FFmpeg pipeline.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,access} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
const root=resolve('.');
const binary=resolve(process.argv[2]??'test-output/subject-picture-handoff-v2/bin/PhotoGoGo-Cached-Picture-Test.exe');
assert.ok(process.argv.length<=3&&!isAbsolute(relative(root,binary))&&!relative(root,binary).startsWith('..'));
const receiptPath=join(dirname(dirname(binary)),'build-receipt.json');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const receiptSha=await hash(receiptPath),receipt=JSON.parse(await readFile(receiptPath));
assert.equal(receipt.kind,'native-cached-picture-handoff-build');assert.equal(receipt.testFaultsEnabled,false);
assert.equal(await hash(binary),receipt.executable.sha256);
for(const pin of receipt.sources)assert.equal(await hash(resolve(pin.path)),pin.sha256);
const folder=await mkdtemp(join(root,'test-output','subject-picture-timeout-')),output=join(folder,'new-output');
const child=spawn(binary,['--run-case',output,'--sample','black-horse','--backend','cpu','--confirm-idle','--render-deadline-seconds','1'],
 {windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='',wrapperKilled=false;
const timer=setTimeout(()=>{wrapperKilled=true;child.kill();},35000);
child.stdout.on('data',data=>{out+=data;assert.ok(Buffer.byteLength(out)<65536);});
child.stderr.on('data',data=>{err+=data;assert.ok(Buffer.byteLength(err)<65536);});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
assert.equal(wrapperKilled,false,'Native supervisor must stop its own complete tree');assert.equal(code,1);
assert.deepEqual(JSON.parse(err),{event:'cachedPictureFailed',code:'CHILD_TIMEOUT'});
const events=out.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const mediaStarted=events.find(event=>event.event==='ownedMediaStarted');assert.ok(mediaStarted);
assert.equal(mediaStarted.children.length,2);assert.ok(mediaStarted.children.every(pid=>Number.isSafeInteger(pid)&&pid>0));
assert.deepEqual(events.at(-1),{event:'ownedTestStopped',activeProcesses:0});
await assert.rejects(access(join(output,'picture-report.json')),{code:'ENOENT'});
assert.ok(!out.includes(folder)&&!err.includes(folder));
const remaining=spawnSync('powershell.exe',['-NoProfile','-Command',
 `$pictureRemaining = @(Get-Process -Id ${mediaStarted.children.join(',')} -ErrorAction SilentlyContinue); if ($pictureRemaining.Count) { exit 1 }`],
 {encoding:'utf8',windowsHide:true,timeout:10000});
assert.equal(remaining.status,0,'No decoder/encoder from this owned test may remain');
assert.equal(await hash(receiptPath),receiptSha);assert.equal(await hash(binary),receipt.executable.sha256);
for(const pin of receipt.sources)assert.equal(await hash(resolve(pin.path)),pin.sha256);
console.log(JSON.stringify({event:'passed',seam:'native-render-timeout-and-descendant-drain',folder,wrapperKilled:false,productionExportQualified:false}));
