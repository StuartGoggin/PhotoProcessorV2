// Uses the real native checked_case_report seam and verified return data only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, readdir, writeFile, rename, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const run=promisify(execFile);
const [binaryArg,sourceArg,payloadArg,outputArg]=process.argv.slice(2);
assert.ok(binaryArg&&sourceArg&&payloadArg&&outputArg,'Native harness, returned cases, retained payload and scratch parent required');
const binary=resolve(binaryArg),source=resolve(sourceArg),payload=resolve(payloadArg),parent=resolve(outputArg);
const buildBytes=await readFile(join(payload,'build-receipt.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(buildBytes),'eae125f478c69665fc14605ad8c3bcc793e3c2c368605f07fbbc27a59627b132');
const build=JSON.parse(buildBytes);
const scratch=await mkdtemp(join(parent,'case-inventory-'));
async function fixture(name,caseName) {
 const folder=join(scratch,name);await mkdir(folder);
 const reportBytes=await readFile(join(source,caseName,'picture-report.json'));
 const report=JSON.parse(reportBytes),marker=`picture-report.${sha(reportBytes)}.committed`;
 assert.ok((await readdir(join(source,caseName))).includes(marker));
 for(const file of ['picture-report.json',marker,report.outputFile])
  await copyFile(join(source,caseName,file),join(folder,file),constants.COPYFILE_EXCL);
 return {folder,report,marker};
}
let tests=0;
async function validate(name,item,expected,extra=[]) {
 let out='',err='',code=0;
 try { ({stdout:out,stderr:err}=await run(binary,[item.folder,payload,item.report.sample,item.report.backend,build.executable.sha256,...extra],
  {timeout:10000,maxBuffer:65536,windowsHide:true})); }
 catch(error) { out=error.stdout??'';err=error.stderr??'';code=error.code; }
 if(expected==='accept') {
  assert.equal(code,0,`${name}: ${err}`);assert.equal(err,'');
  assert.equal(JSON.parse(out).event,'checkedCaseAccepted');
 } else {
  assert.equal(code,1,`${name}: unexpectedly accepted`);
  assert.equal(JSON.parse(err).event,'checkedCaseRefused');
  if(expected!=='refuse')assert.equal(JSON.parse(err).code,expected);
 }
 tests++;
 console.log(JSON.stringify({test:name,expected,result:'passed'}));
}
let item=await fixture('plain-nvidia','case-2');await validate('plain NVIDIA case',item,'accept');
item=await fixture('empty-driver-root','case-2');await mkdir(join(item.folder,'NVIDIA Corporation'));
await validate('ordinary empty NVIDIA driver root',item,'accept');
item=await fixture('observed-driver-directories','case-2');
await mkdir(join(item.folder,'NVIDIA Corporation','umdlogs'),{recursive:true});
await validate('observed empty NVIDIA Corporation/umdlogs',item,'accept');
item=await fixture('cpu-driver-extra','case-1');await mkdir(join(item.folder,'NVIDIA Corporation','umdlogs'),{recursive:true});
await validate('CPU case cannot gain driver-directory exception',item,'REPORT_COMMIT_FAILED');
item=await fixture('unknown-directory','case-2');await mkdir(join(item.folder,'other'));
await validate('unknown directory',item,'REPORT_COMMIT_FAILED');
item=await fixture('driver-file','case-2');await writeFile(join(item.folder,'NVIDIA Corporation'),'x',{flag:'wx'});
await validate('driver name is a file',item,'refuse');
item=await fixture('unexpected-driver-child','case-2');await mkdir(join(item.folder,'NVIDIA Corporation','other'),{recursive:true});
await validate('unexpected driver child',item,'REPORT_COMMIT_FAILED');
item=await fixture('nonempty-driver-logs','case-2');await mkdir(join(item.folder,'NVIDIA Corporation','umdlogs'),{recursive:true});
await writeFile(join(item.folder,'NVIDIA Corporation','umdlogs','driver.log'),'x',{flag:'wx'});
await validate('nonempty driver-log directory',item,'REPORT_COMMIT_FAILED');
item=await fixture('extra-completion-marker','case-2');await writeFile(join(item.folder,`picture-report.${'0'.repeat(64)}.committed`),'',{flag:'wx'});
await validate('extra completion marker',item,'REPORT_COMMIT_FAILED');
item=await fixture('nonempty-completion-marker','case-2');await writeFile(join(item.folder,item.marker),'x');
await validate('nonempty completion marker',item,'refuse');
item=await fixture('changed-output','case-2');await writeFile(join(item.folder,item.report.outputFile),'changed output');
await validate('changed output bytes remain rejected',item,'REPORT_READBACK_FAILED');
item=await fixture('changed-report','case-2');
const altered=Buffer.from(JSON.stringify({...item.report,runnerSha256:'0'.repeat(64)})+'\n');
await writeFile(join(item.folder,'picture-report.json'),altered);
await rename(join(item.folder,item.marker),join(item.folder,`picture-report.${sha(altered)}.committed`));
await validate('self-consistent marker cannot replace runner identity',item,'REPORT_READBACK_FAILED');
item=await fixture('plain-cpu','case-1');await validate('unchanged CPU case',item,'accept');
item=await fixture('driver-child-file','case-2');await mkdir(join(item.folder,'NVIDIA Corporation'));
await writeFile(join(item.folder,'NVIDIA Corporation','umdlogs'),'x',{flag:'wx'});
await validate('umdlogs name is a file',item,'refuse');
item=await fixture('nested-log-directory','case-2');await mkdir(join(item.folder,'NVIDIA Corporation','umdlogs','nested'),{recursive:true});
await validate('nested driver-log directory',item,'REPORT_COMMIT_FAILED');
const junctionTarget=join(scratch,'junction-target');await mkdir(junctionTarget);
item=await fixture('driver-root-junction','case-2');await symlink(junctionTarget,join(item.folder,'NVIDIA Corporation'),'junction');
await validate('redirected NVIDIA driver root',item,'REDIRECTION_REFUSED');
item=await fixture('driver-child-junction','case-2');await mkdir(join(item.folder,'NVIDIA Corporation'));
await symlink(junctionTarget,join(item.folder,'NVIDIA Corporation','umdlogs'),'junction');
await validate('redirected umdlogs child',item,'REDIRECTION_REFUSED');
item=await fixture('driver-leases-and-late-entry','case-2');await mkdir(join(item.folder,'NVIDIA Corporation','umdlogs'),{recursive:true});
await validate('retained leases refuse replacement; final read-back refuses late child',item,'accept',['--lease-and-late-check']);
async function defaultGpu(name,vendor,driver) {
 const candidate=await fixture(name,'case-2');
 const next={...candidate.report,backend:'default-gpu',actualVendorId:vendor,outputFile:'black-horse-default-gpu.mp4'};
 const bytes=Buffer.from(JSON.stringify(next)+'\n');
 await rename(join(candidate.folder,candidate.report.outputFile),join(candidate.folder,next.outputFile));
 await writeFile(join(candidate.folder,'picture-report.json'),bytes);
 await rename(join(candidate.folder,candidate.marker),join(candidate.folder,`picture-report.${sha(bytes)}.committed`));
 if(driver)await mkdir(join(candidate.folder,'NVIDIA Corporation','umdlogs'),{recursive:true});
 return {...candidate,report:next};
}
item=await defaultGpu('default-nvidia-driver',0x10de,true);
await validate('default GPU exception requires verified NVIDIA vendor',item,'accept');
item=await defaultGpu('default-other-driver',0x1002,true);
await validate('non-NVIDIA default GPU gets no driver exception',item,'REPORT_COMMIT_FAILED');
item=await defaultGpu('default-other-plain',0x1002,false);
await validate('ordinary non-NVIDIA default GPU case',item,'accept');
console.log(JSON.stringify({event:'passed',seam:'real-native-case-report-with-incidental-empty-driver-directories',tests,scratch,rendering:false}));
