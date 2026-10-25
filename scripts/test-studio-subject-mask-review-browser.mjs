import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
// Actual selection editor/review controls with bounded native-interface replies.
// Synthetic image fixtures are not footage or semantic-quality acceptance.
const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{StudioSubjectSelectionEditor}from'./src/components/studio/StudioSubjectFinishing';
window.__calls=[];window.__pending=[];window.__invoke=(name,args)=>{window.__calls.push({name,args});return new Promise((resolve,reject)=>window.__pending.push({name,args,resolve,reject}));};
const base={version:1,id:'base-one',clipId:'one',identity:'a'.repeat(32),width:320,height:180,fps:25,frameCount:100,basePolicy:'reuse',reused:true,containsGlobalSharpening:false,warnings:[]};
const selection={version:1,baseIdentity:base.identity,frameCount:100,referenceFrame:0,anchors:[{frame:0,object:'horse',box:[.2,.3,.8,.9]},{frame:0,object:'rider',box:[.4,.1,.6,.5]}]};
const initial={version:1,id:'track-one',preparationId:base.id,baseIdentity:base.identity,maskIdentity:'b'.repeat(64),maskSha256:'c'.repeat(64),frames:100,device:'cpu',secondsIncludingLoad:800,minimumSeamIoU:.9,selection,review:null,reviewed:false,exportQualified:false};
const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;canvas.getContext('2d').fillRect(0,0,320,180);const picture=canvas.toDataURL('image/png'),invalid='data:image/png;base64,AA==';
function App(){const[frame,setFrame]=useState(9),[tracking,setTracking]=useState(initial),[s,setS]=useState(selection),[active,setActive]=useState(true),[grade,setGrade]=useState(0),[broken,setBroken]=useState(false),[baseReady,setBaseReady]=useState(false),[maskReady,setMaskReady]=useState(false);
window.__tracking=tracking;window.__setTracking=setTracking;window.__setFrame=setFrame;
window.__loadBase=()=>setBaseReady(true);window.__loadMask=()=>setMaskReady(true);window.__saved=s;
const response={preparationId:base.id,baseIdentity:base.identity,frame,dataUrl:baseReady?picture:invalid};
const mask={trackingId:tracking?.id,preparationId:base.id,baseIdentity:base.identity,maskIdentity:tracking?.maskIdentity,frame,dataUrl:maskReady&&!broken?picture:invalid};
return <main><StudioSubjectSelectionEditor key={JSON.stringify(s)} base={base} frame={frame} response={response} selection={s} mask={mask} tracking={tracking} active={active} busy={false} onFrame={setFrame} onSelection={setS}/>
<button onClick={()=>setGrade(grade+1)}>Change grade</button><button onClick={()=>setActive(v=>!v)}>Toggle active</button><button onClick={()=>setBroken(v=>!v)}>Toggle broken mask</button><button onClick={()=>setTracking(undefined)}>Release tracking</button><output>{grade}</output></main>;}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'subject-review-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',
 plugins:[{name:'native-fixture',setup(build){build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'native',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(name,args)=>window.__invoke(name,args);',loader:'js'}));}}],define:{'process.env.NODE_ENV':'"production"'}});
const css=await readFile('src/styles/studio-editor.css','utf8');
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:`<!doctype html><style>body{margin:0;background:#091321;color:#e7eef7;font-family:Segoe UI,sans-serif}main{max-width:880px;margin:12px auto;padding:12px}button,input,select{font:inherit;color:inherit;background:#182538;border:1px solid #53657b;border-radius:4px;padding:6px}button:disabled{opacity:.45}${css}</style><div id="root"></div><script src="/app.js"></script>`);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;
try {
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1000,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(30000);
 await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
 const approve=page.getByRole('button',{name:'Acknowledge this mask frame',exact:true}),flag=page.getByRole('button',{name:'Flag this mask frame',exact:true});
 await approve.waitFor({timeout:3000});assert.equal(await approve.isDisabled(),true,'A frame is not visible until both actual images load');
 await page.waitForFunction(()=>document.querySelectorAll('svg image').length===2);
 await page.evaluate(()=>window.__loadBase());assert.equal(await approve.isDisabled(),true,'Loading only the base cannot acknowledge the overlay');
 await page.evaluate(()=>window.__loadMask());await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Acknowledge this mask frame').disabled);
 const wait=()=>page.waitForFunction(()=>window.__pending.length===1);
 const reply=async(decision='approve',patch={})=>{const args=await page.evaluate(()=>window.__pending[0].args);const t=await page.evaluate(()=>window.__tracking);
  const receipt={schema:1,sequence:1,previousIdentity:null,receiptIdentity:'d'.repeat(64),assertionKind:'user-asserted',timestamp:'2026-10-10T00:00:00Z',decision,coverage:'sampledFrames',frames:args.request.frames,
    binding:{baseChecksum:baseIdentity,baseSha256:'e'.repeat(64),width:320,height:180,fps:25,frames:100,maskIdentity:t?.maskIdentity||'b'.repeat(64),maskSha256:'c'.repeat(64),canonicalRecipeSha256:'b'.repeat(64),generationProfile:[1,'fixture'],runtimeProfile:'fixture',runtimeSeal:'f'.repeat(64)}};
  await page.evaluate(value=>{window.__lastReply=value;window.__pending.shift().resolve(value);},{trackingId:args.trackingId,preparationId:'base-one',baseIdentity,maskIdentity:'b'.repeat(64),maskSha256:'c'.repeat(64),review:receipt,reviewed:false,exportQualified:false,subjectQualityAccepted:false,...patch});};
 const readBack=async()=>{await page.waitForFunction(()=>window.__pending.some(p=>p.name==='studio_subject_tracked'));await page.evaluate(()=>{
   const next=window.__pending.shift(),value=window.__lastReply;next.resolve({...window.__tracking,review:value.review});});};
 const baseIdentity='a'.repeat(32);
 // Navigation alone never records an assertion. Grade changes retain scope.
 assert.equal(await page.evaluate(()=>window.__calls.length),0);await approve.click();await wait();
 assert.deepEqual(await page.evaluate(()=>window.__pending[0].args.request),{decision:'approve',coverage:'sampledFrames',frames:[9]});await reply();
 await page.getByRole('status').filter({hasText:'User acknowledged frame 9'}).waitFor();await page.getByRole('button',{name:'Change grade'}).click();
 assert.equal(await page.getByRole('status').filter({hasText:'User acknowledged frame 9'}).count(),1);
 await page.getByRole('checkbox',{name:'Show tracked mask'}).uncheck();assert.equal(await approve.isDisabled(),true);assert.equal(await flag.isDisabled(),true);
 await page.getByRole('checkbox',{name:'Show tracked mask'}).check();
 // Unsafe direction: late rejection after an existing acknowledgment.
 await flag.click();await wait();await page.getByRole('spinbutton',{name:'Frame',exact:true}).fill('20');await page.getByRole('spinbutton',{name:'Frame',exact:true}).fill('9');
 assert.equal(await page.getByRole('status').filter({hasText:'User acknowledged frame 9'}).count(),0,'Mutation must invalidate superseded acknowledgment immediately');
 await reply('reject');await readBack();await page.getByRole('status').filter({hasText:'User flagged frame 9'}).waitFor();
 // A pending exact-frame response must not bless a newly selected frame.
 await approve.click();await wait();await page.getByRole('spinbutton',{name:'Frame',exact:true}).fill('20');await reply();await readBack();
 await page.getByRole('status').filter({hasText:'No verified decision loaded for frame 20'}).waitFor();
 await page.getByRole('button',{name:'Toggle active'}).click();assert.equal(await approve.isDisabled(),true);await page.getByRole('button',{name:'Toggle active'}).click();
 await page.getByRole('button',{name:'Toggle broken mask'}).click();await page.getByRole('status').filter({hasText:'Load the exact frame and visible mask'}).waitFor();assert.equal(await approve.isDisabled(),true);
 await page.getByRole('button',{name:'Toggle broken mask'}).click();
 await approve.click();await wait();await reply('approve',{exportQualified:true});await page.getByRole('alert').filter({hasText:'did not match'}).waitFor();
 await mkdir('test-output/subject-mask-review',{recursive:true});await page.locator('.studio-subject-review').screenshot({path:'test-output/subject-mask-review/desktop.png'});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.locator('.studio-subject-review').screenshot({path:'test-output/subject-mask-review/compact.png'});
 // Replacing the artifact during durable-readback drain cannot resurrect it,
 // including the error path. These are real component ownership transitions.
 for(const outcome of ['resolve','reject']) {
  await flag.click();await wait();const target=await page.getByRole('spinbutton',{name:'Frame',exact:true}).inputValue();
  await page.getByRole('spinbutton',{name:'Frame',exact:true}).fill(target==='20'?'9':'20');await reply('reject');
  try{await page.waitForFunction(()=>window.__pending.some(p=>p.name==='studio_subject_tracked'));}
  catch(error){throw new Error(`Read-back ${outcome} did not start: ${JSON.stringify(await page.evaluate(()=>({calls:window.__calls.slice(-4),pending:window.__pending.map(p=>p.name),review:document.querySelector('.studio-subject-review')?.textContent})))}`,{cause:error});}
  const old=await page.evaluate(()=>({...window.__tracking,review:window.__lastReply.review}));
  await page.evaluate(id=>window.__setTracking({...window.__tracking,id,review:null}),`replacement-${outcome}`);
  await page.evaluate(({outcome,old})=>{const request=window.__pending.shift();if(outcome==='resolve')request.resolve(old);else request.reject(new Error('stale readback failure'));},{outcome,old});
  await page.waitForFunction(()=>document.querySelector('.studio-subject-review'));
  assert.equal(await page.getByRole('status').filter({hasText:/User (acknowledged|flagged) frame/}).count(),0);
  assert.equal(await page.getByRole('alert').filter({hasText:'stale readback failure'}).count(),0);
 }
 // Unsaved edits hide the mask and revoke the actual review seam.
 await page.getByRole('button',{name:'Add horse box'}).click();assert.equal(await approve.isDisabled(),true);assert.equal(await page.locator('svg image').count(),1);
 await page.getByRole('button',{name:'Save horse & rider selection'}).click();
 assert.equal(await approve.isDisabled(),true,'New saved prompts must not adopt the old tracked mask');
 await page.evaluate(()=>window.__setTracking({...window.__tracking,id:'track-two',selection:window.__saved,review:null}));
 await approve.click();await wait();await page.getByRole('button',{name:'Release tracking',exact:true}).click();await reply();assert.equal(await page.getByRole('button',{name:'Acknowledge this mask frame'}).count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: actual editor exact-frame review is explicit, loaded/visible/saved/active only; preserves grade scope, records rejection and refuses stale/qualified replies. Native-interface fixture only.');
} finally {await browser?.close();await new Promise(done=>server.close(done));}
