import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {mkdir,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:"playwright");
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1494","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let log="",browser;const pageErrors=[];server.stdout.on("data",d=>log+=d);server.stderr.on("data",d=>log+=d);
const report={complete:false,scope:"Actual JobCleanup component with synthetic native metadata; no files, jobs or Google accounts changed.",checks:[]};
const G="G".repeat(43),U="U".repeat(43),R="R".repeat(43);
const select=(p,title,id)=>p.getByRole("checkbox",{name:`Select ${title} ${id}`,exact:true});
const action=(p,id)=>p.getByRole("combobox",{name:`Cleanup action ${id}`,exact:true});
const confirm=p=>p.getByRole("checkbox",{name:"I understand removal cannot be undone",exact:true});
const apply=p=>p.getByRole("button",{name:/^(Clean selected jobs|Cleaning selected jobs…)$/});
async function fixture(options={}){const p=await browser.newPage({viewport:{width:1440,height:1100}});p.setDefaultTimeout(5000);p.on("pageerror",e=>pageErrors.push(e.message));await p.addInitScript(v=>Object.assign(window,v),options);await p.goto("http://127.0.0.1:1494/job-cleanup-preview.html",{waitUntil:"domcontentloaded",timeout:45000});await p.getByRole("button",{name:"Clean up jobs",exact:true}).waitFor();return p;}
async function open(p){await p.getByRole("button",{name:"Clean up jobs",exact:true}).click();await p.getByRole("heading",{name:"Clean up old jobs",exact:true}).waitFor();await select(p,"Old failed import","old-import").waitFor();}
async function check(name,run){await run();assert.deepEqual(pageErrors,[],"No browser errors during actual cleanup interactions");report.checks.push({name,passed:true});}
try{
 for(let n=0;n<80;n++){try{if((await fetch("http://127.0.0.1:1494/job-cleanup-preview.html")).ok)break;}catch{}await delay(200);}
 browser=await chromium.launch({channel:"msedge",headless:true});await mkdir("test-output/job-cleanup-browser",{recursive:true});
 await check("All ages are discoverable without preselection; age filters and protected actions stay explicit",async()=>{
  const p=await fixture();await open(p);assert.equal(await p.getByRole("combobox",{name:"Job age",exact:true}).inputValue(),"all");
  assert.equal(await select(p,"Recent photo process","recent-process").count(),1);
  assert.equal(await p.getByRole("checkbox").evaluateAll(nodes=>nodes.filter(n=>n.checked).length),0,"Nothing is selected by default");
  await p.getByRole("combobox",{name:"Job age",exact:true}).selectOption("30");
  assert.equal(await select(p,"Recent photo process","recent-process").count(),0);
  await p.getByRole("combobox",{name:"Job age",exact:true}).selectOption("all");
  assert.equal(await select(p,"Running Google upload",R).isDisabled(),true);
  assert.equal(await select(p,"Unresolved Google upload",U).isEnabled(),true);
  const removal=action(p,U).locator('option[value="remove"]');assert.ok((await removal.count())===0 || await removal.isDisabled(),"Uncertain receipts cannot be permanently removed");
  assert.equal(await apply(p).isDisabled(),true);await p.screenshot({path:"test-output/job-cleanup-browser/cleanup.png",fullPage:true});await p.close();
 });
 await check("Mixed deliberate remove/dismiss pins exact IDs and revisions and refreshes source jobs",async()=>{
  const p=await fixture();await open(p);await select(p,"Old verified Google upload",G).check();await action(p,G).selectOption("remove");await select(p,"Unresolved Google upload",U).check();await action(p,U).selectOption("dismiss");
  assert.equal(await apply(p).isDisabled(),true);await confirm(p).check();await apply(p).click();await p.getByText("Synthetic cleanup completed; photo files and compact receipts preserved.",{exact:true}).waitFor();
  const calls=await p.evaluate(()=>window.__cleanupCalls.filter(c=>c.command==="job_cleanup_apply"));assert.equal(calls.length,1);assert.equal(calls[0].args.acknowledged,true);
  assert.deepEqual(calls[0].args.choices.map(x=>({kind:x.kind,id:x.id,revision:x.revision,action:x.action})).sort((a,b)=>a.id.localeCompare(b.id)),[{kind:"google",id:G,revision:"google-verified-r1",action:"remove"},{kind:"google",id:U,revision:"google-unresolved-r1",action:"dismiss"}].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal(await p.evaluate(()=>window.__cleanupChanged),1);assert.equal(await confirm(p).isChecked(),false);await p.close();
 });
 await check("Take out the trash filter selects only removal-job details while retaining review and discard safeguards",async()=>{
  const p=await fixture();await open(p);await p.getByRole("combobox",{name:"Job type",exact:true}).selectOption("trash");
  assert.equal(await select(p,"Old trash removal","old-trash").count(),1);assert.equal(await select(p,"Old failed import","old-import").count(),0);
  await p.getByText("Review history, deletion receipts and discarded-import safeguards remain.",{exact:true}).waitFor();
  await select(p,"Old trash removal","old-trash").check();await confirm(p).check();await apply(p).click();await p.getByText("Synthetic cleanup completed; photo files and compact receipts preserved.",{exact:true}).waitFor();
  assert.deepEqual(await p.evaluate(()=>window.__cleanupCalls.find(call=>call.command==="job_cleanup_apply").args.choices),[{kind:"trash",id:"old-trash",revision:"trash-r1",action:"remove"}]);await p.close();
 });
 await check("Changing status/type filters clears hidden selections and resets old actions",async()=>{
  const p=await fixture();await open(p);await select(p,"Old verified Google upload",G).check();await action(p,G).selectOption("dismiss");
  await p.getByRole("combobox",{name:"Job status",exact:true}).selectOption("attention");
  assert.equal(await select(p,"Old verified Google upload",G).count(),0);assert.equal(await select(p,"Unresolved Google upload",U).isChecked(),false);
  await p.getByRole("combobox",{name:"Job status",exact:true}).selectOption("all");
  assert.equal(await action(p,G).inputValue(),"remove","Returning to a view must reset old cleanup actions and require a new review");
  await select(p,"Old verified Google upload",G).check();await p.getByRole("combobox",{name:"Job type",exact:true}).selectOption("import");
  assert.equal(await select(p,"Old verified Google upload",G).count(),0);await select(p,"Old failed import","old-import").check();await confirm(p).check();await apply(p).click();await p.getByText("Synthetic cleanup completed; photo files and compact receipts preserved.",{exact:true}).waitFor();
  const choices=await p.evaluate(()=>window.__cleanupCalls.find(c=>c.command==="job_cleanup_apply").args.choices);assert.deepEqual(choices.map(c=>c.id),["old-import"]);await p.close();
 });
 await check("Partial/stale cleanup is visible and never auto-retried",async()=>{
  const p=await fixture({__cleanupResult:{removed:0,dismissed:0,protected:1,failed:1,messages:["Synthetic stale revision: refresh and review before retry.","Synthetic locked record: existing data retained."]}});await open(p);await select(p,"Old failed import","old-import").check();await confirm(p).check();await apply(p).click();
  await p.getByText("Synthetic stale revision: refresh and review before retry.",{exact:true}).waitFor();await p.getByText("Synthetic locked record: existing data retained.",{exact:true}).waitFor();await delay(400);
  assert.equal(await p.evaluate(()=>window.__cleanupCalls.filter(c=>c.command==="job_cleanup_apply").length),1);assert.equal(await confirm(p).isChecked(),false);assert.equal(await apply(p).isDisabled(),true);await p.close();
 });
 await check("Rejected apply resets destructive consent before another attempt",async()=>{
  const p=await fixture({__cleanupApplyError:"Synthetic apply rejected: saved evidence changed."});await open(p);await select(p,"Old failed import","old-import").check();await confirm(p).check();await apply(p).click();
  await p.getByText(/Synthetic apply rejected: saved evidence changed/).waitFor();await delay(200);
  assert.equal(await confirm(p).isChecked(),false,"A rejected destructive action requires a deliberate new acknowledgement");assert.equal(await apply(p).isDisabled(),true);
  assert.equal(await p.evaluate(()=>window.__cleanupCalls.filter(c=>c.command==="job_cleanup_apply").length),1);await p.close();
 });
 await check("An in-flight apply disables duplicate submission and closing",async()=>{
  const p=await fixture({__cleanupHoldApply:true});await open(p);await select(p,"Old failed import","old-import").check();await confirm(p).check();await apply(p).click();await p.waitForFunction(()=>typeof window.__cleanupResolveApply==="function");
  assert.equal(await apply(p).isDisabled(),true);const close=p.getByRole("button",{name:/^(Close|Close cleanup)$/});assert.equal(await close.isDisabled(),true);
  await p.evaluate(()=>window.__cleanupResolveApply());await p.getByText("Synthetic cleanup completed; photo files and compact receipts preserved.",{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.__cleanupCalls.filter(c=>c.command==="job_cleanup_apply").length),1);await p.close();
 });
 await check("Preview failure and unmount do not apply stale work",async()=>{
  const p=await fixture({__cleanupPreviewError:"Synthetic preview unavailable; no details changed."});await p.getByRole("button",{name:"Clean up jobs",exact:true}).click();await p.getByText(/Synthetic preview unavailable; no details changed/).waitFor();assert.equal(await p.evaluate(()=>window.__cleanupCalls.filter(c=>c.command==="job_cleanup_apply").length),0);await p.close();
  const q=await fixture({__cleanupHoldPreview:true});await q.getByRole("button",{name:"Clean up jobs",exact:true}).click();await q.waitForFunction(()=>window.__cleanupPreviewResolvers.length===1);await q.evaluate(()=>window.__cleanupUnmount());await q.evaluate(()=>window.__cleanupPreviewResolvers[0]());await delay(150);assert.equal(await q.getByRole("heading",{name:"Clean up old jobs",exact:true}).count(),0);assert.deepEqual(await q.evaluate(()=>window.__cleanupErrors),[]);await q.close();
 });
 report.complete=true;report.passed=report.checks.length;console.log(JSON.stringify(report,null,2));
}catch(e){report.error=String(e);console.error(e);console.error(log.slice(-1200));process.exitCode=1;}finally{await mkdir("test-output/job-cleanup-browser",{recursive:true});await writeFile("test-output/job-cleanup-browser/report.json",JSON.stringify(report,null,2));await browser?.close();server.kill();}
