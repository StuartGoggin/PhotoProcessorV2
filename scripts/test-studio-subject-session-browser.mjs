import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
// Real hook with deterministic native-interface replies, not a media acceptance.
const fixture=`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{useStudioSubjectPreparation}from'./src/hooks/useStudioSubjectPreparation';
import{newProject}from'./src/types/videoStudio';
window.__calls=[];window.__pending=[];window.__invoke=(name,args)=>{window.__calls.push({name,args});
 if(name==='studio_subject_forget')return Promise.resolve();
 return new Promise((resolve,reject)=>window.__pending.push({name,args,resolve,reject}));};
const c={id:'one',path:'D:/owned.mp4',duration:2,stabilization:'off',stabilizationMethod:'quality',framing:'edgeSafe'};
function Session({project,clip,epoch,jobs}){const s=useStudioSubjectPreparation(project,clip,epoch,true,jobs,async()=> 'D:/stage');
 window.__visible=s;return <section><button onClick={s.prepare}>Prepare</button><button onClick={s.release}>Release</button>
 <button onClick={()=>s.readFrame(9)}>Read nine</button><output id='state'>{JSON.stringify({id:s.id,base:s.base?.id,frame:s.response?.frame,error:s.error})}</output></section>;}
function App(){const[p,setP]=useState({...newProject(),outputDir:'D:/output',clips:[c]}),[clip,setClip]=useState(c),[epoch,setEpoch]=useState(0),[jobs,setJobs]=useState([]),[mounted,setMounted]=useState(true);
 window.__jobs=setJobs;return <main>{mounted&&<Session project={p} clip={clip} epoch={epoch} jobs={jobs}/>}
 <button onClick={()=>setClip({...clip,id:clip.id==='one'?'two':'one'})}>Switch clip</button>
 <button onClick={()=>setP({...p,finishing:{enabled:false,colour:{lightEv:.5}}})}>Change grade</button>
 <button aria-pressed={!!p.defaultPreventRotation} onClick={()=>setP({...p,defaultPreventRotation:!p.defaultPreventRotation})}>Toggle project rotation</button>
 <button onClick={()=>setClip({...clip,stabilization:'balanced',stabilizationMethod:'fast'})}>Use Fast</button>
 <button onClick={()=>setClip({...clip,stabilization:'balanced',stabilizationMethod:'quality'})}>Use Quality</button>
 <button onClick={()=>setP({...p,fps:25})}>Change format</button>
 <button onClick={()=>setEpoch(epoch+1)}>New project epoch</button>
 <button onClick={()=>setMounted(!mounted)}>Toggle mount</button></main>;}createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'subject-session-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',
 plugins:[{name:'native-fixture',setup(build){build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'native',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(name,args)=>window.__invoke(name,args);',loader:'js'}));}}],define:{'process.env.NODE_ENV':'"production"'}});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<!doctype html><div id="root"></div><script src="/app.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try {
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const wait=name=>page.waitForFunction(name=>window.__pending.some(p=>p.name===name),name);
 const finish=(name,value)=>page.evaluate(({name,value})=>{const i=window.__pending.findIndex(p=>p.name===name);window.__pending.splice(i,1)[0].resolve(value);},{name,value});
 const calls=name=>page.evaluate(name=>window.__calls.filter(p=>p.name===name),name);
 const prepare=async id=>{await page.getByRole('button',{name:'Prepare',exact:true}).click();await wait('studio_subject_prepare');await finish('studio_subject_prepare',id);};
 const complete=async id=>{await page.evaluate(id=>window.__jobs([{id,status:'completed'}]),id);await wait('studio_subject_prepared');};
 // Late enqueue response must be forgotten rather than shown on another clip.
 await page.getByRole('button',{name:'Prepare',exact:true}).click();await wait('studio_subject_prepare');await page.getByRole('button',{name:'Switch clip'}).click();await finish('studio_subject_prepare','late-one');
 await page.waitForFunction(()=>window.__calls.some(c=>c.name==='studio_subject_forget'&&c.args.preparationId==='late-one'));
 assert.equal(await page.evaluate(()=>window.__visible.id),undefined);
 // Release while metadata is pending cannot resurrect a previously ready ID.
 await prepare('two');await complete('two');await page.getByRole('button',{name:'Release',exact:true}).click();
 const base={version:1,id:'two',clipId:'two',identity:'a'.repeat(32),width:3840,height:2160,fps:50,frameCount:100,basePolicy:'reuse',reused:true,containsGlobalSharpening:false,warnings:[]};
 await prepare('three');await complete('three');
 await page.waitForFunction(()=>window.__pending.filter(p=>p.name==='studio_subject_prepared').length===2);
 assert.equal(await page.evaluate(()=>window.__pending.filter(p=>p.name==='studio_subject_prepared').length),2,'New metadata read must not be stalled by a forgotten old read');
 await finish('studio_subject_prepared',base);assert.equal(await page.evaluate(()=>window.__visible.base),undefined);
 // Prepare and display exact base, then preserve it across grade changes.
 await finish('studio_subject_prepared',{...base,id:'three'});await wait('studio_subject_frame');
 await finish('studio_subject_frame',{preparationId:'three',baseIdentity:base.identity,frame:0,dataUrl:'data:image/jpeg;base64,AA=='});
 await page.waitForFunction(()=>window.__visible.response?.frame===0);await page.getByRole('button',{name:'Change grade'}).click();assert.equal(await page.evaluate(()=>window.__visible.base.id),'three');
 // Dormant rotation changes must retain the prepared base; the native Off/Fast
 // motion policy ignores them. Effective Quality rotation changes must retire it.
 await page.getByRole('button',{name:'Toggle project rotation',exact:true}).click();
 await page.getByRole('button',{name:'Toggle project rotation',pressed:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__visible.base?.id),'three','Off stabilization must preserve the prepared base when project rotation changes');
 await page.getByRole('button',{name:'Use Fast',exact:true}).click();await prepare('fast-four');await complete('fast-four');
 await finish('studio_subject_prepared',{...base,id:'fast-four'});await wait('studio_subject_frame');
 await finish('studio_subject_frame',{preparationId:'fast-four',baseIdentity:base.identity,frame:0,dataUrl:'data:image/jpeg;base64,AA=='});
 await page.waitForFunction(()=>window.__visible.response?.frame===0);
 await page.getByRole('button',{name:'Toggle project rotation',exact:true}).click();
 await page.getByRole('button',{name:'Toggle project rotation',pressed:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.__visible.base?.id),'fast-four','Fast stabilization must preserve the prepared base when project rotation changes');
 await page.getByRole('button',{name:'Use Quality',exact:true}).click();await prepare('quality-five');await complete('quality-five');
 await finish('studio_subject_prepared',{...base,id:'quality-five'});await wait('studio_subject_frame');
 await finish('studio_subject_frame',{preparationId:'quality-five',baseIdentity:base.identity,frame:0,dataUrl:'data:image/jpeg;base64,AA=='});
 await page.waitForFunction(()=>window.__visible.response?.frame===0);
 await page.getByRole('button',{name:'Toggle project rotation',exact:true}).click();
 await page.getByRole('button',{name:'Toggle project rotation',pressed:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__visible.base),undefined,'Effective Quality rotation changes must invalidate the prepared base');
 assert.ok((await calls('studio_subject_forget')).some(p=>p.args.preparationId==='quality-five'));
 await prepare('quality-six');await complete('quality-six');await finish('studio_subject_prepared',{...base,id:'quality-six'});await wait('studio_subject_frame');
 await finish('studio_subject_frame',{preparationId:'quality-six',baseIdentity:base.identity,frame:0,dataUrl:'data:image/jpeg;base64,AA=='});
 await page.waitForFunction(()=>window.__visible.response?.frame===0);
 await page.getByRole('button',{name:'Read nine'}).click();await wait('studio_subject_frame');await page.getByRole('button',{name:'Change format'}).click();
 await finish('studio_subject_frame',{preparationId:'quality-six',baseIdentity:base.identity,frame:9,dataUrl:'data:image/jpeg;base64,AA=='});assert.equal(await page.evaluate(()=>window.__visible.response),undefined);
 assert.ok((await calls('studio_subject_forget')).some(p=>p.args.preparationId==='quality-six'));
 // Unmount before enqueue resolves must tombstone the late ID too.
 await page.getByRole('button',{name:'Prepare',exact:true}).click();await wait('studio_subject_prepare');await page.getByRole('button',{name:'Toggle mount'}).click();await finish('studio_subject_prepare','unmounted');
 await page.waitForFunction(()=>window.__calls.some(c=>c.name==='studio_subject_forget'&&c.args.preparationId==='unmounted'));
 assert.deepEqual(errors,[]);console.log('PASS: actual preparation hook drops/tombstones late clip, release, format and unmount replies; grade and dormant Off/Fast rotation edits preserve base, effective Quality rotation invalidates it. Deterministic native-interface fixture only.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
