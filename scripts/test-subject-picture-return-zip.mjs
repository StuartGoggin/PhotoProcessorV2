import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {readPictureReport} from './subject-finishing/read-picture-report.mjs';
const folder=resolve(process.argv[2]);const build=JSON.parse(await readFile(resolve(process.argv[3])));
const original=await readFile(join(folder,'comparison-report.json')),report=JSON.parse(original);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const zip=await readFile(join(folder,'PhotoGoGo-Return-Reports.zip'));
assert.ok(zip.length>0&&zip.length<=65536);
const commit=await lstat(join(folder,`PhotoGoGo-Return-Reports.${sha(zip)}.committed`));
assert.ok(commit.isFile()&&!commit.isSymbolicLink());assert.equal(commit.size,0);
const fixture=await mkdtemp(resolve('test-output/subject-picture-return-')),destination=join(fixture,'small returned reports');
const child=spawn('pwsh',['-NoProfile','-File','scripts/subject-finishing/extract-picture-return.ps1','-Zip',join(folder,'PhotoGoGo-Return-Reports.zip'),'-Destination',destination],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let err='';child.stderr.on('data',bytes=>{err+=bytes;assert.ok(err.length<65536);});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});assert.equal(code,0,err);
assert.deepEqual(await readFile(join(destination,'comparison-report.json')),original);
const returnedCommit=await lstat(join(destination,`comparison-report.${sha(original)}.committed`));
assert.ok(returnedCommit.isFile()&&!returnedCommit.isSymbolicLink());assert.equal(returnedCommit.size,0);
for(let n=0;n<report.cases.length;n++)if(report.cases[n].status==='passed') {
 const record=await readPictureReport(join(destination,`case-${n+1}`),build);
 assert.deepEqual(record,report.cases[n].report);
 assert.equal(sha(await readFile(join(destination,`case-${n+1}`,'picture-report.json'))),report.cases[n].reportSha256);
}
console.log(JSON.stringify({event:'passed',seam:'small-report-only-zip-roundtrip',fixture,zipBytes:zip.length,status:report.status,productionExportQualified:false}));
