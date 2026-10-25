import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const load=async path=>{const r=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);};
const preparation=await load('src/utils/studioSubjectPreparation.ts');
const {newProject}=await load('src/types/videoStudio.ts');
const clip=()=>({id:'one',path:'D:/owned/source.mp4',duration:10,include:true,chapter:'One',title:'',titleSeconds:0,
  stabilization:'balanced',stabilizationMethod:'quality',customStabilization:{radius:16,blockSize:8,contrast:125},
  framing:'edgeSafe',reviewed:true,notes:'',replays:[],revision:0});
test('letterboxed subject selection maps only actual picture pixels to normalized base coordinates',()=>{
  const rect={left:10,top:20,width:800,height:800};
  assert.equal(preparation.subjectDisplayPoint(410,30,rect,3840,2160),null);
  assert.deepEqual(preparation.subjectDisplayPoint(410,420,rect,3840,2160),{x:.5,y:.5});
  assert.deepEqual(preparation.subjectDisplayPoint(10,195,rect,3840,2160),{x:0,y:0});
  assert.deepEqual(preparation.subjectDisplayPoint(810,645,rect,3840,2160),{x:1,y:1});
  assert.equal(preparation.subjectDisplayPoint(0,420,rect,3840,2160),null);
  assert.equal(preparation.subjectDisplayPoint(NaN,420,rect,3840,2160),null);
  assert.equal(preparation.subjectDisplayPoint(410,420,{...rect,width:0},3840,2160),null);
});
test('grade/title/replay/prompt edits keep base preparation identity; motion/policy/format edits do not',()=>{
  const c=clip(),p={...newProject(),finishing:{enabled:true,basePolicy:'reuse'},clips:[c]};
  const key=preparation.subjectBaseRecipe(p,c);
  assert.equal(preparation.subjectBaseRecipe({...p,finishing:{...p.finishing,colour:{lightEv:.5}}},c),key);
  assert.equal(preparation.subjectBaseRecipe(p,{...c,title:'New',revision:1,replays:[{start:1,end:2}],finishingSelection:{}}),key);
  for(const changed of [{...p,fps:25},{...p,width:1920},{...p,encoderPreference:'cpu'},
    {...p,finishing:{...p.finishing,basePolicy:'clean'}}])assert.notEqual(preparation.subjectBaseRecipe(changed,c),key);
  assert.notEqual(preparation.subjectBaseRecipe(p,{...c,stabilization:'strong'}),key);
  assert.notEqual(preparation.subjectBaseRecipe(p,{...c,path:'D:/other.mp4'}),key);
  assert.notEqual(preparation.subjectBaseRecipe(p,{...c,duration:11}),key);
});
test('frame responses must match exact preparation and requested integer frame, not merely clip ID',()=>{
  const base={version:1,id:'native-one',identity:'a'.repeat(32),frameCount:100,width:3840,height:2160,fps:50};
  const response={preparationId:base.id,baseIdentity:base.identity,frame:12,dataUrl:'data:image/jpeg;base64,AA=='};
  assert.equal(preparation.subjectFrameMatches(base,12,response),true);
  for(const changed of [{...response,preparationId:'older'},{...response,frame:11},
    {...response,baseIdentity:'b'.repeat(32)},{...response,dataUrl:'https://remote/image.jpg'}]) {
    assert.equal(preparation.subjectFrameMatches(base,12,changed),false);
  }
  for(const frame of [-1,100,1.2,NaN])assert.equal(preparation.subjectFrameMatches(base,frame,response),false);
});

const reply=(base,frame)=>({preparationId:base.id,baseIdentity:base.identity,frame,dataUrl:'data:image/jpeg;base64,AA=='});
const ownedBase=()=>({version:1,id:'native-one',clipId:'one',identity:'a'.repeat(32),frameCount:100,width:3840,height:2160,fps:50,basePolicy:'reuse',warnings:[]});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('native base DTO bounds are checked before the selection editor is mounted',()=>{
  const base=ownedBase();assert.equal(preparation.subjectBaseMatches(base,'one'),true);
  for(const changed of [{...base,identity:'x'}, {...base,fps:29.97},{...base,frameCount:1_800_001},{...base,warnings:[{}]}])
    assert.equal(preparation.subjectBaseMatches(changed,'one'),false);
  assert.equal(preparation.subjectBaseMatches(base,'other'),false);
});
test('scrub burst has one live read and only the latest pending frame; old pixels are blanked',async()=>{
  const base=ownedBase(),calls=[],states=[];const pending=[];
  const reader=new preparation.SubjectFrameReader(base,frame=>{calls.push(frame);const p=deferred();pending.push(p);return p.promise;},state=>states.push(state));
  reader.request(1);for(let i=2;i<100;i++)reader.request(i);
  assert.deepEqual(calls,[1]);assert.equal(states.at(-1).response,undefined);
  pending[0].resolve(reply(base,1));await tick();assert.deepEqual(calls,[1,99]);
  assert.equal(states.some(state=>state.response?.frame===1),false);
  pending[1].resolve(reply(base,99));await tick();assert.equal(states.at(-1).response.frame,99);reader.stop();
});
test('reader cleanup suppresses late reads and invalid bounds never launch native work',async()=>{
  const base=ownedBase(),pending=deferred(),states=[];let calls=0;
  const reader=new preparation.SubjectFrameReader(base,()=>{calls++;return pending.promise;},state=>states.push(state));
  for(const frame of [-1,100,.5,NaN])assert.throws(()=>reader.request(frame));assert.equal(calls,0);
  reader.request(1);const count=states.length;reader.stop();pending.resolve(reply(base,1));await tick();
  reader.request(2);assert.equal(calls,1);assert.equal(states.length,count);
});
test('a busy decoder gets one bounded retry, not endless queue growth',async()=>{
  const base=ownedBase(),states=[];let calls=0;
  const reader=new preparation.SubjectFrameReader(base,async()=>{calls++;throw new Error('Subject frame reader is busy');},state=>states.push(state));
  reader.request(0);await new Promise(resolve=>setTimeout(resolve,450));assert.equal(calls,2);
  assert.equal(states.at(-1).reading,false);assert.match(states.at(-1).error,/busy/);reader.stop();
});
