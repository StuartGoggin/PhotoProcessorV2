import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
// Real component/controller, deferred native-interface fixture. Not image-quality acceptance.
const fixture=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import StudioSubjectPreview from'./src/components/studio/StudioSubjectPreview';import{effectiveFinishing}from'./src/utils/studioFinishing';
window.__calls=[];window.__pending=[];window.__invoke=(name,args)=>{window.__calls.push({name,args});return new Promise((resolve,reject)=>window.__pending.push({name,args,resolve,reject}));};
const base={version:1,id:'base-one',clipId:'one',identity:'a'.repeat(32),width:3840,height:2160,fps:50,frameCount:100,basePolicy:'reuse',reused:true,containsGlobalSharpening:false,warnings:[]};
const track={version:1,id:'track-one',preparationId:base.id,baseIdentity:base.identity,maskIdentity:'b'.repeat(64),maskSha256:'c'.repeat(64),frames:100,device:'cpu',secondsIncludingLoad:800,minimumSeamIoU:.9,selection:{},reviewed:false,exportQualified:false};
function App(){const[frame,setFrame]=useState(0),[settings,setSettings]=useState(effectiveFinishing({enabled:true})),[t,setTrack]=useState(track),[show,setShow]=useState(true);
return <main><button onClick={()=>setFrame(9)}>Frame nine</button><button onClick={()=>setFrame(0)}>Frame zero</button><button onClick={()=>setSettings({...settings,colour:{...settings.colour,lightEv:.3}})}>Change grade</button>
<button onClick={()=>setTrack({...t,id:'track-two',maskIdentity:'d'.repeat(64)})}>Change masks</button><button onClick={()=>setTrack({...t,id:'track-three'})}>Release tracking</button><button onClick={()=>setShow(false)}>Unmount</button>
{show&&<StudioSubjectPreview base={base} tracking={t} frame={frame} settings={settings} busy={false} active={true}/>}</main>;}createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'preview-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',
plugins:[{name:'native-fixture',setup(build){build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'native',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(name,args)=>window.__invoke(name,args);',loader:'js'}));}}],define:{'process.env.NODE_ENV':'"production"'}});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<!doctype html><div id="root"></div><script src="/app.js"></script>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;
try {
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const wait=name=>page.waitForFunction(name=>window.__pending.some(p=>p.name===name),name);
 const finish=(name,value)=>page.evaluate(({name,value})=>{const i=window.__pending.findIndex(p=>p.name===name);window.__pending.splice(i,1)[0].resolve(value);},{name,value});
 const reject=(name,message)=>page.evaluate(({name,message})=>{const i=window.__pending.findIndex(p=>p.name===name);window.__pending.splice(i,1)[0].reject(message);},{name,message});
 const update=()=>page.getByRole('button',{name:'Update full-resolution comparison',exact:true}).click();
 const begin=async()=>{await update();const pendingCancel=await page.evaluate(()=>window.__pending.some(p=>p.name==='studio_subject_finish_cancel'));
   if(pendingCancel){assert.equal(await page.evaluate(()=>window.__pending.filter(p=>p.name==='studio_subject_finish_epoch').length),0,'Replacement ticket must wait for prior same-tracking cancellation acknowledgment');
     while(await page.evaluate(()=>window.__pending.some(p=>p.name==='studio_subject_finish_cancel')))await finish('studio_subject_finish_cancel',undefined);}
   await wait('studio_subject_finish_epoch');await finish('studio_subject_finish_epoch',4);await wait('studio_subject_finish_frame');};
 const response=async extra=>{const args=await page.evaluate(()=>window.__pending.find(p=>p.name==='studio_subject_finish_frame').args);return {trackingId:args.trackingId,preparationId:'base-one',baseIdentity:'a'.repeat(32),maskIdentity:args.trackingId==='track-one'?'b'.repeat(64):'d'.repeat(64),
 frame:args.frameIndex,width:3840,height:2160,settings:args.settings,settingsIdentity:'e'.repeat(64),beforeDataUrl:'data:image/png;base64,AA==',dataUrl:'data:image/png;base64,AQ==',engine:'subject-rgb709-q4-v2',exportQualified:false,note:'Interface fixture only',...extra};};
 // A ticket reply after a frame change must never submit a native picture job.
 await update();await wait('studio_subject_finish_epoch');await page.getByRole('button',{name:'Frame nine'}).click();await finish('studio_subject_finish_epoch',0);
 await page.waitForFunction(()=>window.__calls.some(c=>c.name==='studio_subject_finish_cancel'));assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.name==='studio_subject_finish_frame').length),0);
 // Changing scope while a replacement waits for cancellation acknowledgment
 // must not let that old replacement acquire a ticket when the barrier opens.
 const waitingEpochs=await page.evaluate(()=>window.__calls.filter(c=>c.name==='studio_subject_finish_epoch').length);
 await update();await page.getByRole('button',{name:'Frame zero',exact:true}).click();await finish('studio_subject_finish_cancel',undefined);
 await page.getByRole('button',{name:'Update full-resolution comparison',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.name==='studio_subject_finish_epoch').length),waitingEpochs);
 // The immutable recipe and native generation belong to this one request.
 await begin();assert.equal(await page.evaluate(()=>window.__pending.find(p=>p.name==='studio_subject_finish_frame').args.previewEpoch),4);
 const old=await response();await page.getByRole('button',{name:'Change grade'}).click();await finish('studio_subject_finish_frame',old);assert.equal(await page.getByRole('img').count(),0);
 // Cancellation keeps its in-flight bound until drain, then enables a retry.
 await begin();const cancelled=await response();await page.getByRole('button',{name:'Cancel frame preview'}).click();await finish('studio_subject_finish_frame',cancelled);
 await page.getByRole('button',{name:'Update full-resolution comparison',exact:true}).waitFor();assert.equal(await page.getByRole('img').count(),0);
 await begin();await finish('studio_subject_finish_frame',await response());await page.getByRole('img',{name:/after subject finishing/}).waitFor();
 await page.getByRole('button',{name:'Before',exact:true}).click();await page.getByRole('img',{name:/before finishing/}).waitFor();
 await page.getByRole('checkbox',{name:'Inspect at 100% pixels'}).check();assert.equal(await page.locator('.actual-pixels').count(),1);
 // A new mask clears the picture without discarding a base; wrong recipe is rejected.
 await page.getByRole('button',{name:'Change masks'}).click();assert.equal(await page.getByRole('img').count(),0);await begin();
 const wrong=await response({settings:old.settings});await finish('studio_subject_finish_frame',wrong);await page.getByRole('alert').filter({hasText:'did not match'}).waitFor();
 // An unacknowledged cancel must fail closed for this tracking, not merely hide
 // the old image. Releasing it for a new tracking identity allows a safe retry.
 await begin();const failedCancelReply=await response();await page.getByRole('button',{name:'Cancel frame preview'}).click();
 await reject('studio_subject_finish_cancel','Native cancellation unavailable');await finish('studio_subject_finish_frame',failedCancelReply);
 const epochsBefore=await page.evaluate(()=>window.__calls.filter(c=>c.name==='studio_subject_finish_epoch').length);
 for(let retry=0;retry<2;retry++) {await update();await page.getByRole('alert').filter({hasText:'Cannot confirm preview cancellation'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.name==='studio_subject_finish_epoch').length),epochsBefore,'Failed cancellation must not admit another request for the same tracking');}
 assert.equal(await page.getByRole('img').count(),0);
 await page.getByRole('button',{name:'Release tracking',exact:true}).click();await begin();await finish('studio_subject_finish_frame',await response());
 await page.getByRole('img',{name:/before finishing/}).waitFor();await page.getByRole('button',{name:'After',exact:true}).click();await page.getByRole('img',{name:/after subject finishing/}).waitFor();
 await begin();await page.getByRole('button',{name:'Unmount'}).click();await finish('studio_subject_finish_frame',await response());assert.equal(await page.getByRole('img').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: real finishing comparison/controller uses immutable full-frame recipes and generation tickets, drops stale replies, drains cancellation, validates masks/settings, and switches before/after and 100% inspection. Interface fixture only.');
}finally{await browser?.close();await new Promise(done=>server.close(done));}
