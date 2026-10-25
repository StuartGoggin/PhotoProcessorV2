// Development evidence binding, not production/runtime admission.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, lstat} from 'node:fs/promises';
import {resolve, join, relative, isAbsolute, dirname} from 'node:path';
const expectedSources=['src-tauri/native/subject_handoff/main.cpp','src-tauri/native/subject_finishing/gpu.h',
 'src-tauri/native/subject_finishing/core.h','src-tauri/native/subject_finishing/shaders.h',
 'src-tauri/native/subject_finishing/process_owner.h','scripts/build-subject-handoff.ps1'];
async function digest(file){
 const info=await lstat(file);
 assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=8*1024*1024,'Evidence must be an ordinary bounded file');
 return createHash('sha256').update(await readFile(file)).digest('hex');
}
export async function bindHandoffTest(binary,{faults=false}={}){
 const root=resolve('.'),rel=relative(root,binary);
 assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'),'Test only a retained isolated-worktree candidate');
 const receiptPath=join(dirname(dirname(binary)),'build-receipt.json');
 const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
 assert.equal(receipt.schema,1);assert.equal(receipt.kind,'native-handoff-readiness-build');
 assert.equal(receipt.testFaultsEnabled,faults,'Never confuse a shippable candidate with an injected-failure fixture');
 assert.equal(receipt.mediaTestReady,false);assert.equal(receipt.subjectQualityAccepted,false);assert.equal(receipt.productionExportQualified,false);
 assert.equal(receipt.executable.path,'bin/PhotoGoGo-Finishing-Test.exe');
 assert.deepEqual(receipt.sources.map(entry=>entry.path).sort(),[...expectedSources].sort());
 const receiptHash=await digest(receiptPath);
 const check=async()=>{
  assert.equal(await digest(receiptPath),receiptHash,'Build receipt changed during validation');
  assert.equal(await digest(binary),receipt.executable.sha256,'Tested executable does not match its build receipt');
  for(const source of receipt.sources)assert.equal(await digest(join(root,source.path)),source.sha256,'Build receipt must bind the exact current source set');
 };
 await check();return check;
}
