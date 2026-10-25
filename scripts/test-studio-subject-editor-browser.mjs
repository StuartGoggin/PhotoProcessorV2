import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated component contract fixture: this is not a native/media acceptance.
const entry=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{StudioSubjectSelectionEditor,StudioFinishingSettings}from'./src/components/studio/StudioSubjectFinishing';
import{effectiveFinishing}from'./src/utils/studioFinishing';
const base={version:1,id:'owned-preparation',clipId:'one',identity:'a'.repeat(32),width:3840,height:2160,fps:50,frameCount:100,basePolicy:'reuse',reused:true,containsGlobalSharpening:true,warnings:['Existing Quality base already contains whole-frame sharpening.']};
const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;const ctx=canvas.getContext('2d');ctx.fillStyle='#25384b';ctx.fillRect(0,0,960,540);ctx.fillStyle='#68784d';ctx.fillRect(0,340,960,200);ctx.fillStyle='#c3a482';ctx.fillRect(300,200,380,200);ctx.fillStyle='#bbc8dc';ctx.fillRect(450,110,100,160);const fixtureImage=canvas.toDataURL('image/png');
function App(){const[frame,setFrame]=useState(0),[stale,setStale]=useState(false),[settings,setSettings]=useState(()=>effectiveFinishing());
 window.__setFrame=setFrame;window.__setSettings=setSettings;
 const response={preparationId:stale?'older-preparation':base.id,baseIdentity:base.identity,frame,dataUrl:fixtureImage};
 return <main><StudioFinishingSettings value={settings} busy={false} available={true} onChange={v=>{setSettings(v);window.__settings=v;}} onConfirmClean={async()=>{window.__confirmations=(window.__confirmations||0)+1;if(window.__deferClean)return new Promise((resolve,reject)=>{window.__cleanResolve=resolve;window.__cleanReject=reject;});return window.__approveClean===true;}}/>
 <StudioSubjectSelectionEditor base={base} frame={frame} response={response} busy={false} onFrame={setFrame} onSelection={v=>window.__selection=v}/>
 <button onClick={()=>setStale(v=>!v)}>Toggle stale response</button></main>;}createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'subject-editor-fixture.tsx',loader:'tsx'},
  bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
const css=await readFile('src/styles/studio-editor.css','utf8');
const server=createServer((request,response)=> {
  response.setHeader('Content-Type',request.url==='/app.js'?'text/javascript':'text/html');
  response.end(request.url==='/app.js'?bundle.outputFiles[0].text:`<!doctype html><html><head><style>body{margin:0;background:#091321;color:#e7eef7;font-family:Segoe UI,sans-serif}main{max-width:1040px;margin:12px auto;padding:12px}button,input,select{font:inherit;color:inherit;background:#182538;border:1px solid #53657b;border-radius:4px;padding:6px}button:disabled{opacity:.45}${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1180,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const save=page.getByRole('button',{name:'Save horse & rider selection'});
  assert.equal(await save.isDisabled(),true);
  await page.getByRole('button',{name:'Add horse box'}).click();assert.equal(await save.isDisabled(),true);
  await page.getByRole('combobox',{name:'Subject',exact:true}).selectOption('rider');
  await page.getByRole('button',{name:'Add rider box'}).click();await save.click();
  let selection=await page.evaluate(()=>window.__selection);
  assert.equal(selection.referenceFrame,0);assert.deepEqual(selection.anchors.map(a=>a.object),['horse','rider']);
  await page.getByRole('spinbutton',{name:'Frame',exact:true}).fill('12');
  await page.getByRole('button',{name:'Add rider box'}).click();
  await page.getByRole('combobox',{name:'Tool'}).selectOption('exclude');
  const image=page.getByRole('img',{name:'Stabilized frame 12 with horse and rider prompts'});
  const bounds=await image.boundingBox();await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await save.click();
  selection=await page.evaluate(()=>window.__selection);
  assert.equal(selection.anchors[2].frame,12);assert.equal(selection.anchors[2].points[0].include,false);
  assert.ok(Math.abs(selection.anchors[2].points[0].x-.5)<.003);
  assert.ok(Math.abs(selection.anchors[2].points[0].y-.5)<.003);
  await page.getByRole('button',{name:'Clear rider prompt on this frame'}).click();await save.click();
  assert.equal((await page.evaluate(()=>window.__selection)).anchors.length,2);
  await page.getByRole('checkbox',{name:'Enable',exact:true}).check();
  const policy=page.getByRole('combobox',{name:'Stabilized base'});
  await policy.selectOption('clean');assert.equal(await policy.inputValue(),'reuse');
  await page.evaluate(()=>window.__approveClean=true);await policy.selectOption('clean');
  assert.equal(await policy.inputValue(),'clean');assert.equal(await page.evaluate(()=>window.__confirmations),2);
  await page.getByRole('button',{name:'Toggle stale response'}).click();
  await page.getByRole('spinbutton',{name:'Frame',exact:true}).fill('0');
  await page.getByRole('status').filter({hasText:'Reading the exact stabilized frame'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Add rider box'}).isDisabled(),true);
  await page.getByRole('button',{name:'Toggle stale response'}).click();
  await page.getByRole('combobox',{name:'Tool'}).selectOption('box');
  await page.getByRole('combobox',{name:'Subject',exact:true}).selectOption('horse');
  const drag=await page.getByRole('img',{name:'Stabilized frame 0 with horse and rider prompts'}).boundingBox();
  await page.mouse.move(drag.x+drag.width*.2,drag.y+drag.height*.2);await page.mouse.down();
  await page.evaluate(()=>window.__setFrame(9));await page.mouse.move(drag.x+drag.width*.6,drag.y+drag.height*.7);await page.mouse.up();await save.click();
  assert.equal((await page.evaluate(()=>window.__selection)).anchors.some(a=>a.frame===9),false,'Changing frame during a drag must cancel its prompt ownership');
  await mkdir('test-output/subject-editor',{recursive:true});
  await page.locator('.studio-subject-editor').screenshot({path:'test-output/subject-editor/editor.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: two-object reference, integer-frame corrections, exact overlay coordinates, removal, explicit clean confirmation, stale-image refusal and compact width; component fixture only.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
