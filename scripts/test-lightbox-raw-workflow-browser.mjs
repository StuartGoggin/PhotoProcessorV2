import assert from "node:assert/strict";
import { mkdir,writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:"playwright");
const out="test-output/lightbox-raw-workflow-browser",base="http://127.0.0.1:1498",root="D:\\Controller photos";
await mkdir(out,{recursive:true});
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1498","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let logs="",browser;server.stdout.on("data",x=>logs+=x);server.stderr.on("data",x=>logs+=x);
const report={complete:false,checks:[]},errors=[];
const tree=p=>p.getByRole("tree",{name:"Original photo folders"});
async function ready(p,label="Camera JPEG"){await p.getByRole("checkbox",{name:`Upload ${label} to Google Photos`,exact:true}).waitFor();await p.waitForFunction(label=>!document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`)?.disabled,label);}
async function fixture(){const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on("pageerror",e=>errors.push(e.message));await p.addInitScript(()=>window.__controlsRawWorkflow=true);await p.goto(base+"/lightbox-controls-preview.html");await tree(p).waitFor();return p;}
async function pick(p,name){await tree(p).getByText(name,{exact:true}).click();await ready(p,name==="03-jpeg.jpg"?"Original":"Camera JPEG");}
async function key(p,k){await p.locator('[aria-label="Photo Lightbox review"]').focus();await p.keyboard.press(k);}
async function group(name,fn){await fn();report.checks.push(name);console.log("PASS "+name);}
try{
  for(let i=0;i<100;i++){try{if((await fetch(base+"/lightbox-controls-preview.html")).ok)break;}catch{}if(server.exitCode!==null)throw Error(logs);await delay(100);}
  browser=await chromium.launch({channel:"msedge",headless:true});
  await group("RAW inspection stays per photo; saved choice survives remount without changing upload flags",async()=>{
    const p=await fixture();await pick(p,"01-raw.CR3");assert.equal(await p.getByLabel("Original source",{exact:true}).inputValue(),"cameraJpeg");
    await p.getByLabel("Original source",{exact:true}).selectOption("raw");await ready(p,"Original RAW");
    await pick(p,"02-raw.CR3");assert.equal(await p.getByLabel("Original source",{exact:true}).inputValue(),"cameraJpeg");
    await tree(p).getByText("01-raw.CR3",{exact:true}).click();await ready(p,"Original RAW");await p.getByRole("button",{name:"Use this finish for this photo",exact:true}).click();
    await p.getByText("Viewing choice saved for this photo. Upload selections are unchanged.",{exact:true}).waitFor();
    await p.evaluate(()=>window.__controlsSwitchRoot("E:\\another"));await tree(p).waitFor();await p.evaluate(root=>window.__controlsSwitchRoot(root),root);await tree(p).waitFor();
    await tree(p).getByText("01-raw.CR3",{exact:true}).click();await ready(p,"Original RAW");assert.equal(await p.getByLabel("Original source",{exact:true}).inputValue(),"raw");
    assert.equal(await p.evaluate(()=>window.__controlsSelectionWrites.length),0);assert.equal(await p.evaluate(()=>window.__controlsRawJobs?.length??0),0);
    await key(p,"g");await ready(p);assert.equal(await p.getByLabel("Original source",{exact:true}).inputValue(),"cameraJpeg","save-and-next must not carry A's RAW choice to B");
    await p.close();
  });
  await group("Paired rating and trash decisions preserve the JPEG anchor in both views",async()=>{
    const p=await fixture();await pick(p,"01-raw.CR3");await p.getByText("The RAW and Camera JPEG have different review tags.",{exact:false}).waitFor();
    await key(p,"1");await p.waitForFunction(()=>window.__controlsRenames.length===1);assert.match(await p.evaluate(()=>window.__controlsRenames[0].oldPath),/01-camera\{Like oo\}\.JPG$/);
    await ready(p);await p.getByLabel("Original source",{exact:true}).selectOption("raw");await ready(p,"Original RAW");
    const command=await p.evaluate(()=>window.__controlsCommandReference.find(x=>x.id==="trash")?.keys[0]);assert.ok(command);await key(p,command);
    await p.waitForFunction(()=>window.__controlsRenames.length===2);assert.match(await p.evaluate(()=>window.__controlsRenames[1].oldPath),/01-camera/);assert.match(await p.evaluate(()=>window.__controlsRenames[1].newName),/\{trash\}/i);
    await p.close();
  });
  await group("Lightbox opens exact one-photo editor; queue and close preserve review and upload state",async()=>{
    const p=await fixture();await pick(p,"02-raw.CR3");await p.getByRole("button",{name:"Develop RAW alternative",exact:true}).click();
    const dialog=p.getByRole("dialog",{name:"Develop RAW alternative",exact:true});await dialog.waitFor();assert.equal(await dialog.getByRole("combobox",{name:"RAW original",exact:true}).count(),0);
    assert.equal(await p.evaluate(()=>window.__controlsCalls.filter(x=>x.command==="raw_development_preview").length),0);
    await dialog.getByRole("button",{name:"Queue this photo's RAW development",exact:true}).click();await dialog.getByRole("button",{name:"Refresh finished outputs",exact:true}).waitFor();
    const req=await p.evaluate(()=>window.__controlsRawJobs[0]);assert.equal(req.selection,"selected");assert.equal(req.scopeMode,"folderOnly");assert.equal(req.selectedPaths.length,1);assert.match(req.selectedPaths[0],/02-raw\.CR3$/);assert.equal(req.usePhotoOverrides,false);
    await dialog.getByRole("button",{name:"Open Jobs",exact:true}).click();await ready(p);assert.equal(await p.evaluate(()=>window.__controlsViewedJob),"raw-photo-job");assert.equal(await p.evaluate(()=>window.__controlsSelectionWrites.length),0);
    await p.close();
  });
  await group("Changing staging while editor is open closes it and restores review commands",async()=>{const p=await fixture();await pick(p,"01-raw.CR3");await p.getByRole("button",{name:"Develop RAW alternative",exact:true}).click();await p.getByRole("dialog",{name:"Develop RAW alternative",exact:true}).waitFor();await p.evaluate(()=>window.__controlsSwitchRoot("E:\\other"));await pick(p,"03-jpeg.jpg");assert.equal(await p.getByRole("dialog",{name:"Develop RAW alternative",exact:true}).count(),0);await key(p,"1");await p.waitForFunction(()=>window.__controlsRenames.length===1);await p.close();});
  await group("Missing saved RAW finish falls back with a visible notice",async()=>{const p=await fixture();await p.evaluate(root=>{const lib=window.__controlsLibraries.get(root);const raw=lib.tree.children.find(n=>n.path==="02-raw.CR3");raw.lightboxSource="raw";lib.tree.children=lib.tree.children.filter(n=>n.path!=="02-finish.jpg");},root);await p.getByRole("button",{name:"Refresh photos",exact:true}).click();await pick(p,"02-raw.CR3");await p.getByText("This photo's saved RAW finish is unavailable.",{exact:false}).waitFor();assert.equal(await p.getByLabel("Original source",{exact:true}).inputValue(),"cameraJpeg");await p.close();});
  await group("Unreadable camera preview still permits explicit RAW recovery",async()=>{const p=await fixture();await p.evaluate(root=>{const lib=window.__controlsLibraries.get(root);lib.tree.children=lib.tree.children.filter(n=>!["02-camera.JPG","02-finish.jpg"].includes(n.path));delete lib.tree.children.find(n=>n.path==="02-raw.CR3").cameraJpeg;window.__controlsFailImage="02-raw.CR3";},root);await p.getByRole("button",{name:"Refresh photos",exact:true}).click();await tree(p).getByText("02-raw.CR3",{exact:true}).click();const open=p.getByRole("button",{name:"Develop RAW alternative",exact:true});await open.click();await p.getByRole("dialog",{name:"Develop RAW alternative",exact:true}).waitFor();await p.close();});
  await group("JPEG-only photo has no RAW actions",async()=>{const p=await fixture();await pick(p,"03-jpeg.jpg");assert.equal(await p.getByRole("button",{name:"Develop RAW alternative",exact:true}).count(),0);await p.close();});
  assert.deepEqual(errors,[]);report.complete=true;
}catch(error){report.error=error.stack||String(error);throw error;}
finally{await writeFile(out+"/report.json",JSON.stringify(report,null,2));await browser?.close();server.kill();}
