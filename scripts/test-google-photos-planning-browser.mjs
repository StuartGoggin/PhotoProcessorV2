import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const server = spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1493","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let browser,log="";server.stdout.on("data",d=>log+=d);server.stderr.on("data",d=>log+=d);
const report={complete:false,scope:"Actual Google Photos page with synthetic local IPC. No Google requests or media.",checks:[]};
async function fixture(){const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(4000);await page.addInitScript(()=>{window.__googlePlanDelay=true;});await page.goto("http://127.0.0.1:1493/google-photos-preview.html",{waitUntil:"domcontentloaded",timeout:45000});await page.getByRole("button",{name:"Review publish plan",exact:true}).waitFor();return page;}
async function check(name,run){await run();report.checks.push({name,passed:true});}
try{
 for(let n=0;n<60;n++){try{if((await fetch("http://127.0.0.1:1493/google-photos-preview.html")).ok)break;}catch{}await delay(200);}
 await mkdir("test-output/google-photos-planning-browser",{recursive:true});
 browser=await chromium.launch({channel:"msedge",headless:true});
 await check("Inspection has real stage/count progress and cancellation",async()=>{
  const p=await fixture();await p.getByRole("button",{name:"Review publish plan",exact:true}).click();
  await p.getByRole("region",{name:"Local photo inspection",exact:true}).waitFor();
  await p.getByText(/2 of 4 photos/).waitFor();
  assert.equal(await p.getByRole("button",{name:"Cancel inspection",exact:true}).isEnabled(),true);
  await p.screenshot({path:"test-output/google-photos-planning-browser/inspection.png",fullPage:true});
  await p.getByRole("button",{name:"Cancel inspection",exact:true}).click();
  await p.waitForFunction(()=>window.__googleCalls.some(c=>c.command==="google_photos_cancel_plan"));
  await p.evaluate(()=>window.__googleResolvePlan());
  await p.getByRole("button",{name:"Review publish plan",exact:true}).waitFor();
  assert.equal(await p.getByRole("heading",{name:"Review before publishing",exact:true}).count(),0,"Cancelled result must never be accepted");await p.close();
 });
 await check("Completed inspection accepts only its active request",async()=>{
  const p=await fixture();await p.getByRole("button",{name:"Review publish plan",exact:true}).click();await p.getByText(/2 of 4 photos/).waitFor();
  await p.evaluate(()=>window.__googleResolvePlan());await p.getByRole("heading",{name:"Review before publishing",exact:true}).waitFor();
  assert.equal(await p.getByRole("region",{name:"Local photo inspection",exact:true}).count(),0);
  const args=await p.evaluate(()=>window.__googleCalls.find(c=>c.command==="google_photos_plan").args);
  assert.equal(typeof args.inspectionId,"string");assert.ok(args.inspectionId.length>10);await p.close();
 });
 await check("Unmount cancels work and fences late results",async()=>{
  const p=await fixture();await p.getByRole("button",{name:"Review publish plan",exact:true}).click();await p.getByText(/2 of 4 photos/).waitFor();
  await p.evaluate(()=>window.__googleUnmount());await p.waitForFunction(()=>window.__googleCalls.some(c=>c.command==="google_photos_cancel_plan"));
  await p.evaluate(()=>window.__googleResolvePlan());await delay(150);assert.equal(await p.getByRole("heading",{name:"Review before publishing",exact:true}).count(),0);await p.close();
 });
 await check("Existing account can reconnect without forgetting saved setup",async()=>{
  const p=await fixture();await p.getByRole("button",{name:"Reconnect same account",exact:true}).click();
  const calls=await p.evaluate(()=>window.__googleCalls);assert.ok(calls.some(c=>c.command==="google_photos_connect"));assert.equal(calls.some(c=>c.command==="google_photos_disconnect"),false);await p.close();
 });
 report.complete=true;report.passed=report.checks.length;console.log(JSON.stringify(report,null,2));
}catch(error){report.error=String(error);console.error(error);process.exitCode=1;}finally{await mkdir("test-output/google-photos-planning-browser",{recursive:true});await writeFile("test-output/google-photos-planning-browser/report.json",JSON.stringify(report,null,2));await browser?.close();server.kill();}
