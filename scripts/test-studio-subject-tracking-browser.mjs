import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
// Real tracking hook; bounded fake native replies, never footage acceptance.
const fixture=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{useStudioSubjectTracking}from'./src/hooks/useStudioSubjectTracking';
window.__calls=[];window.__pending=[];window.__invoke=(name,args)=>{window.__calls.push({name,args});if(name==='studio_subject_tracking_forget')return Promise.resolve();return new Promise((resolve,reject)=>window.__pending.push({name,args,resolve,reject}));};
const base={version:1,id:'base-one',clipId:'one',identity:'a'.repeat(32),width:3840,height:2160,fps:50,frameCount:100,basePolicy:'reuse',reused:true,containsGlobalSharpening:false,warnings:[]};
const initial={version:1,baseIdentity:base.identity,frameCount:100,referenceFrame:0,anchors:[{frame:0,object:'horse',box:[.2,.3,.8,.9]},{frame:0,object:'rider',box:[.4,.1,.6,.5]}]};window.__selection=initial;
function App(){const[s,setS]=useState(initial),[frame,setFrame]=useState(0),[jobs,setJobs]=useState([]),[b,setB]=useState(base),[grade,setGrade]=useState(0);const tracking=useStudioSubjectTracking(b,s,frame,jobs);
window.__visible=tracking;window.__jobs=setJobs;return <main><button onClick={tracking.start}>Track</button><button onClick={tracking.release}>Release</button>
<button onClick={()=>{const next={...s,anchors:[...s.anchors,{frame:5,object:'horse',box:[.3,.3,.9,.9]}]};setS(next);window.__selection=next;}}>Change prompts</button>
<button onClick={()=>setGrade(grade+1)}>Change grade</button><button onClick={()=>setFrame(9)}>Frame nine</button><button onClick={()=>setFrame(20)}>Frame twenty</button><button onClick={()=>setB({...b,id:'base-two'})}>Change base</button></main>;}createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'tracking-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',
plugins:[{name:'native-fixture',setup(build){build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'native',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(name,args)=>window.__invoke(name,args);',loader:'js'}));}}],define:{'process.env.NODE_ENV':'"production"'}});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<!doctype html><div id="root"></div><script src="/app.js"></script>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const wait=name=>page.waitForFunction(name=>window.__pending.some(p=>p.name===name),name);
 const finish=(name,value)=>page.evaluate(({name,value})=>{const i=window.__pending.findIndex(p=>p.name===name);window.__pending.splice(i,1)[0].resolve(value);},{name,value});
 const start=async id=>{await page.getByRole('button',{name:'Track',exact:true}).click();await wait('studio_subject_track');await finish('studio_subject_track',id);};
 const complete=async id=>{await page.evaluate(id=>window.__jobs([{id,status:'completed'}]),id);await wait('studio_subject_tracked');};
 const metadata=async id=>({version:1,id,preparationId:'base-one',baseIdentity:'a'.repeat(32),maskIdentity:'b'.repeat(64),maskSha256:'c'.repeat(64),frames:100,
 device:'cpu',secondsIncludingLoad:800,minimumSeamIoU:.9,selection:await page.evaluate(()=>window.__selection),reviewed:false,exportQualified:false});
 const mask=(id,frame,identity='b'.repeat(64))=>({trackingId:id,preparationId:'base-one',baseIdentity:'a'.repeat(32),maskIdentity:identity,frame,dataUrl:'data:image/png;base64,AA=='});
 // Late enqueue after prompt change is tombstoned, never adopted.
 await page.getByRole('button',{name:'Track',exact:true}).click();await wait('studio_subject_track');await page.getByRole('button',{name:'Change prompts'}).click();await finish('studio_subject_track','late');
 await page.waitForFunction(()=>window.__calls.some(c=>c.name==='studio_subject_tracking_forget'&&c.args.trackingId==='late'));assert.equal(await page.evaluate(()=>window.__visible.id),undefined);
 // Two overlapping metadata replies: release cannot stall or revive the old ID.
 await start('first');await complete('first');const old=await metadata('first');await page.getByRole('button',{name:'Release',exact:true}).click();await start('second');await complete('second');
 await page.waitForFunction(()=>window.__pending.filter(p=>p.name==='studio_subject_tracked').length===2);await finish('studio_subject_tracked',old);assert.equal(await page.evaluate(()=>window.__visible.metadata),undefined);
 await page.getByRole('button',{name:'Frame nine'}).click();await finish('studio_subject_tracked',await metadata('second'));await wait('studio_subject_mask_frame');
 assert.equal(await page.evaluate(()=>window.__pending.find(p=>p.name==='studio_subject_mask_frame').args.frame),9,'Late metadata must read the latest desired frame');
 await finish('studio_subject_mask_frame',mask('second',9));
 await page.waitForFunction(()=>window.__visible.mask?.frame===9);await page.getByRole('button',{name:'Change grade'}).click();assert.equal(await page.evaluate(()=>window.__visible.metadata.id),'second');
 // A read from an old base cannot show on the new one.
 await page.getByRole('button',{name:'Frame twenty'}).click();await wait('studio_subject_mask_frame');await page.getByRole('button',{name:'Change base'}).click();await finish('studio_subject_mask_frame',mask('second',20));
 assert.equal(await page.evaluate(()=>window.__visible.mask),undefined);await page.waitForFunction(()=>window.__calls.some(c=>c.name==='studio_subject_tracking_forget'&&c.args.trackingId==='second'));
 assert.deepEqual(errors,[]);console.log('PASS: actual tracking hook tombstones late prompt/base replies, owns overlapping metadata, preserves masks on grade changes and drops stale mask frames. Native-interface fixture only.');
}finally{await browser?.close();await new Promise(done=>server.close(done));}
