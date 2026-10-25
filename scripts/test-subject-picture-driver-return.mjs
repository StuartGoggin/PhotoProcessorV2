// No rendering: the real case checker and native report ZIP, then safe extraction.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readPictureReport } from './subject-finishing/read-picture-report.mjs';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const [binaryArg,sourceArg,payloadArg]=process.argv.slice(2);
assert.ok(binaryArg&&sourceArg&&payloadArg);
const binary=resolve(binaryArg),source=resolve(sourceArg),payload=resolve(payloadArg);
const buildBytes=await readFile(join(payload,'build-receipt.json'));
assert.equal(sha(buildBytes),'eae125f478c69665fc14605ad8c3bcc793e3c2c368605f07fbbc27a59627b132');
const build=JSON.parse(buildBytes),bytes=await readFile(join(source,'case-2','picture-report.json'));
const report=JSON.parse(bytes),marker=`picture-report.${sha(bytes)}.committed`;
const fixture=await mkdtemp(resolve('test-output/subject-picture-driver-return-')),folder=join(fixture,'case-2');
await mkdir(folder);
for(const file of ['picture-report.json',marker,report.outputFile])
 await copyFile(join(source,'case-2',file),join(folder,file),constants.COPYFILE_EXCL);
await mkdir(join(folder,'NVIDIA Corporation','umdlogs'),{recursive:true});
const zip=join(fixture,'reports.zip');
const accepted=await run(binary,[folder,payload,report.sample,report.backend,build.executable.sha256,'--report-only-zip',zip],
 {timeout:10000,maxBuffer:65536,windowsHide:true});
assert.equal(accepted.stderr,'');assert.equal(JSON.parse(accepted.stdout).event,'checkedCaseAccepted');
const zipBytes=await readFile(zip);assert.ok(zipBytes.length>0&&zipBytes.length<=65536);
const zipMarker=await lstat(join(fixture,`reports.${sha(zipBytes)}.committed`));assert.ok(zipMarker.isFile());assert.equal(zipMarker.size,0);
const destination=join(fixture,'returned reports');
await run('pwsh',['-NoProfile','-File','scripts/subject-finishing/extract-picture-return.ps1','-Zip',zip,'-Destination',destination],
 {timeout:30000,maxBuffer:65536,windowsHide:true});
assert.deepEqual(await readdir(destination),['case-2']);
const returnedFiles=(await readdir(join(destination,'case-2'))).sort();
assert.deepEqual(returnedFiles,['picture-report.json',marker].sort());
assert.deepEqual(await readFile(join(destination,'case-2','picture-report.json')),bytes);
assert.deepEqual(await readPictureReport(join(destination,'case-2'),build),report);
// The report legitimately names its video; only ZIP entries, not JSON text,
// must exclude media. Exact extracted inventory already proves that boundary.
assert.ok(returnedFiles.every(name=>!name.endsWith('.mp4')&&!name.endsWith('.log')));
assert.ok(!zipBytes.includes(Buffer.from('NVIDIA Corporation'))&&!zipBytes.includes(Buffer.from('umdlogs')));
console.log(JSON.stringify({event:'passed',seam:'verified-incidental-driver-case-native-report-zip-roundtrip',fixture,zipBytes:zipBytes.length,
 onlyReportsAndMarkers:true,rendering:false,productionExportQualified:false}));
