// Offline return-report contract; synthetic corruptions never admit export.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {readPictureReport} from './subject-finishing/read-picture-report.mjs';
const build=JSON.parse(await readFile(resolve(process.argv[2]??'test-output/subject-picture-handoff-v4/build-receipt.json')));
const original=resolve(process.argv[3]??'test-output/subject-picture-public-BpwrLu/private-user-and-media-path');
const originalText=await readFile(join(original,'picture-report.json'));
const report=JSON.parse(originalText);
const root=await mkdtemp(resolve('test-output/subject-picture-reader-'));
const markerFor=bytes=>`picture-report.${createHash('sha256').update(bytes).digest('hex')}.committed`;
async function fixture(name,text=originalText,marker=markerFor(text),markerBytes='') {
 const folder=join(root,name);await mkdir(folder);
 await writeFile(join(folder,'picture-report.json'),text);
 if(marker)await writeFile(join(folder,marker),markerBytes);
 return folder;
}
const valid=await fixture('valid');
assert.equal((await readPictureReport(valid,build)).sample,'black-horse');
await assert.rejects(readPictureReport(await fixture('missing-marker',originalText,''),build),/COMPLETION_MARKER/);
await assert.rejects(readPictureReport(await fixture('nonzero-marker',originalText,markerFor(originalText),'not empty'),build),/COMPLETION_MARKER/);
await assert.rejects(readPictureReport(await fixture('wrong-marker',originalText,`picture-report.${'0'.repeat(64)}.committed`),build),/COMPLETION_MARKER/);
const ambiguous=await fixture('ambiguous');
await writeFile(join(ambiguous,`picture-report.${'f'.repeat(64)}.committed`),'');
await assert.rejects(readPictureReport(ambiguous,build),/COMPLETION_MARKER/);
for(const [name,changed] of [
 ['runner-identity',{...report,runnerSha256:'0'.repeat(64)}],
 ['input-identity',{...report,baseSha256:'0'.repeat(64)}],
 ['unsafe-output-path',{...report,outputFile:'../private.mp4'}],
 ['quality-claim',{...report,subjectQualityAccepted:true}],
 ['cpu-labelled-nvidia',{...report,backend:'nvidia'}],
 ['missing-drain',{...report,ownedActiveProcesses:1}],
 ['missing-packet',{...report,audioPacketsCopiedExactly:94}],
 ['missing-frame',{...report,decodedVideoFrames:99}],
 ['invalid-timing',{...report,wallSeconds:Infinity}],
])await assert.rejects(readPictureReport(await fixture(name,JSON.stringify(changed)),build),/REPORT_CONTRACT/);
await assert.rejects(readPictureReport(valid,build,{requireOutput:true}),/OUTPUT_IDENTITY/);
await copyFile(join(original,report.outputFile),join(valid,report.outputFile));
assert.equal((await readPictureReport(valid,build,{requireOutput:true})).outputSha256,report.outputSha256);
const redirected=await fixture('redirected-marker',originalText,'');
const linkTarget=join(root,'ordinary-empty-marker');await writeFile(linkTarget,'');
await symlink(linkTarget,join(redirected,markerFor(originalText)),'file');
await assert.rejects(readPictureReport(redirected,build),/COMPLETION_MARKER/);
console.log(JSON.stringify({event:'passed',seam:'offline-picture-return-report-contract',root,checks:16,productionExportQualified:false}));
