// Public launcher refuses a report ancestor that another process can mutate.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {bindHandoffTest} from './subject-finishing/handoff-test-receipt.mjs';
const root=resolve('.'),binary=resolve(process.argv[2]??'test-output/subject-handoff-readiness-v7/bin/PhotoGoGo-Finishing-Test.exe');
const rel=relative(root,binary);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));
const verifyEvidence=await bindHandoffTest(binary);
const folder=await mkdtemp(join(root,'test-output','subject-handoff-write-lease-'));
const output=join(folder,'must-not-publish');
const writer=spawn('pwsh.exe',['-NoProfile','-File',join(root,'scripts','subject-finishing','hold-handoff-directory-writer.ps1'),'-Directory',folder],
 {windowsHide:true,stdio:['pipe','pipe','pipe']});
let writerText='',writerError='';
writer.stdout.on('data',data=>{writerText+=data;if(writerText.length>1024)writer.kill();});
writer.stderr.on('data',data=>{writerError+=data;if(writerError.length>1024)writer.kill();});
let writerClosed=false;
const writerFinished=new Promise((done,reject)=>{writer.once('error',reject);writer.once('close',code=>{writerClosed=true;done(code);});});
// Install rejection handling while waiting for readiness; unexpected exit is a test failure.
writerFinished.catch(()=>{});
const fixtureTimer=setTimeout(()=>writer.kill(),15000);
try {
 const started=performance.now();
 while(!writerText.includes('directoryWriterReady')){
  assert.equal(writerClosed,false,writerError);
  assert.ok(performance.now()-started<10000,'The OS fixture must become ready within ten seconds');
  await new Promise(done=>setTimeout(done,20));
 }
 const child=spawn(binary,['--preflight',output],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',overflow=false,wrapperTimeout=false;
 const collect=(previous,data)=>{if(Buffer.byteLength(previous)+data.length>65536){overflow=true;child.kill();return previous;}return previous+data.toString('utf8');};
 child.stdout.on('data',data=>{stdout=collect(stdout,data);});
 child.stderr.on('data',data=>{stderr=collect(stderr,data);});
 const timer=setTimeout(()=>{wrapperTimeout=true;child.kill();},5000);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 assert.equal(wrapperTimeout,false,'Unsafe ancestry must be rejected before hardware inspection');
 assert.equal(overflow,false);assert.equal(code,1,'A mutable report ancestor must not be admitted');
 assert.equal(JSON.parse(stderr.trim()).code,'REPORT_PARENT_UNAVAILABLE');
 assert.equal(stdout,'');
 assert.equal(await stat(output).then(()=>true,()=>false),false,'Rejection must not create or publish report data');
 await verifyEvidence();
 console.log(JSON.stringify({event:'passed',seam:'native-report-ancestor-write-lease',productionExportQualified:false}));
} finally {
 writer.stdin.end('\n');
 const writerCode=await writerFinished.finally(()=>clearTimeout(fixtureTimer));
 assert.equal(writerCode,0,'The owned OS fixture must exit after releasing its handle');
}
