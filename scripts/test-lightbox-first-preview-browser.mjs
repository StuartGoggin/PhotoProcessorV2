import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Production Review/hooks/cache with controlled local IPC, never user media.
const { chromium }=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:"playwright");
const output="test-output/lightbox-first-preview-browser",base="http://127.0.0.1:1493",root="D:\\Controller photos";
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1493","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let browser,serverLog="",check="starting";server.stdout.on("data",x=>serverLog+=x);server.stderr.on("data",x=>serverLog+=x);
const errors=[],report={complete:false,scope:"Actual Lightbox preview/action readiness with controlled 700-file and delayed native replies; timing is a development fixture measurement, not a render-PC/NAS guarantee.",checks:[],measurements:[]};
const tree=page=>page.getByRole("tree",{name:"Original photo folders"});
const upload=(page,label="Original")=>page.getByRole("checkbox",{name:`Upload ${label} to Google Photos`,exact:true});
async function fixture(options={}) {
  const page=await browser.newPage({viewport:{width:1360,height:950}});page.setDefaultTimeout(10000);page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(value=>Object.assign(window,value),options);await page.goto(base+"/lightbox-controls-preview.html",{waitUntil:"domcontentloaded"});
  await tree(page).waitFor();return page;
}
async function image(page,path,label,expectedRoot) {
  await page.waitForFunction(async({path,label,expectedRoot})=>{
    for(const node of document.querySelectorAll(".review-images img")) {
      if(label&&node.alt!==label)continue;if(!node.complete||!node.naturalWidth)continue;
      const bytes=new Uint8Array(await(await fetch(node.src)).arrayBuffer());let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);
      const payload=window.__controlsPayloads.get(btoa(binary));
      if(payload?.path===path&&(!expectedRoot||payload.root===expectedRoot))return true;
    }return false;
  },{path,label,expectedRoot},{timeout:3000});
}
async function hotkey(page,key){await page.locator('[aria-label="Photo Lightbox review"]').focus();await page.keyboard.press(key);}
async function settled(page,label="Original"){await page.waitForFunction(label=>{const input=document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`);return input&&!input.disabled;},label);}
async function mutationCounts(page){return page.evaluate(()=>[window.__controlsRenames.length,window.__controlsSelectionWrites.length,window.__controlsCropWrites.length]);}
async function group(name,test){if(process.env.FIRST_PREVIEW_CASE&&!name.includes(process.env.FIRST_PREVIEW_CASE))return;check=name;await test();report.checks.push(name);console.log("PASS "+name);}
try {
  let started=false;for(let i=0;i<100;i++){try{if((await fetch(base+"/lightbox-controls-preview.html")).ok){started=true;break;}}catch{}if(server.exitCode!==null)throw Error(serverLog);await delay(100);}assert.ok(started,serverLog);
  browser=await chromium.launch({channel:"msedge",headless:true});
  await group("JPEG-first paired captures retain explicit RAW selection across refresh",async()=>{
    const page=await fixture({__controlsRawFixture:true});
    await tree(page).getByText("01-horse.CR3",{exact:true}).click();
    assert.equal(await page.getByLabel("Original source",{exact:true}).inputValue(),"cameraJpeg","verified paired capture must default to its camera JPEG");
    await image(page,"01-horse.JPG","Camera JPEG");await image(page,"01-horse_improved.jpg","Enhanced");await settled(page,"Camera JPEG");
    assert.equal(await page.getByLabel("Original source",{exact:true}).inputValue(),"cameraJpeg");
    await hotkey(page,"q");await page.waitForFunction(()=>window.__controlsSelectionWrites.length===1);await settled(page,"Camera JPEG");
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"01-horse.JPG");
    await page.getByLabel("Original source",{exact:true}).selectOption("raw");
    await image(page,"01-horse.CR3","Original RAW");await settled(page,"Original RAW");
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();
    await image(page,"01-horse.CR3","Original RAW");await settled(page,"Original RAW");
    assert.equal(await page.getByLabel("Original source",{exact:true}).inputValue(),"raw");
    await page.getByLabel("Original source",{exact:true}).selectOption("cameraJpeg");await image(page,"01-horse.JPG","Camera JPEG");
    assert.deepEqual(await mutationCounts(page),[0,1,0]);await page.close();
  });
  await group("Failed comparisons have exact-version Retry and stale retries cannot repaint another photo",async()=>{
    const page=await fixture({__controlsFailImage:"01-horse_improved.jpg"});
    await tree(page).getByText("01-horse.jpg",{exact:true}).click();await image(page,"01-horse.jpg","Original");await settled(page);
    const panel=page.getByRole("group",{name:"Enhanced image panel",exact:true});
    await panel.getByText("Could not load Enhanced image.",{exact:true}).waitFor();
    assert.equal(await upload(page,"Enhanced").isDisabled(),true);
    await page.evaluate(()=>{window.__controlsFailImage=null;});
    await panel.getByRole("button",{name:"Retry Enhanced image",exact:true}).click();
    await image(page,"01-horse_improved.jpg","Enhanced");await settled(page,"Enhanced");
    await page.evaluate(()=>{window.__controlsFailImage="01-horse_improved.jpg";});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();
    await panel.getByText("Could not load Enhanced image.",{exact:true}).waitFor();
    await page.evaluate(()=>{window.__controlsFailImage=null;window.__controlsDeferImage="01-horse_improved.jpg";});
    await panel.getByRole("button",{name:"Retry Enhanced image",exact:true}).click();
    await page.waitForFunction(()=>typeof window.__controlsReleaseImage==="function");
    await tree(page).getByText("02-rider.jpg",{exact:true}).click();await image(page,"02-rider_improved.jpg","Enhanced");
    await page.evaluate(()=>{window.__controlsDeferImage=null;window.__controlsReleaseImage();});
    await image(page,"02-rider_improved.jpg","Enhanced");assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Browser decode failure disables its version and retries from fresh bytes",async()=>{
    const page=await fixture({__controlsMalformedImage:"01-horse_improved.jpg"});
    await tree(page).getByText("01-horse.jpg",{exact:true}).click();await image(page,"01-horse.jpg","Original");await settled(page);
    const panel=page.getByRole("group",{name:"Enhanced image panel",exact:true});
    await panel.getByText("Could not load Enhanced image.",{exact:true}).waitFor();
    assert.equal(await upload(page,"Enhanced").isDisabled(),true);
    await page.evaluate(()=>{window.__controlsMalformedImage=null;});
    await panel.getByRole("button",{name:"Retry Enhanced image",exact:true}).click();
    await image(page,"01-horse_improved.jpg","Enhanced");await settled(page,"Enhanced");
    assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Absent comparisons do not offer Retry or invent an image read",async()=>{
    const page=await fixture();
    await page.evaluate(()=>{const lib=window.__controlsLibraries.get("D:\\Controller photos");lib.tree.children=lib.tree.children.filter(n=>n.path!=="01-horse_improved.jpg");});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await tree(page).getByText("01-horse.jpg",{exact:true}).click();await image(page,"01-horse.jpg","Original");await settled(page);
    const panel=page.getByRole("group",{name:"Enhanced image panel",exact:true});await panel.getByText("No image",{exact:true}).waitFor();
    assert.equal(await panel.getByRole("button",{name:"Retry Enhanced image",exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_image"&&c.args.path.endsWith("01-horse_improved.jpg")).length),0);await page.close();
  });
  await group("Original Retry retains healthy comparisons and pauses decisions until the original settles",async()=>{
    const page=await fixture({__controlsFailImage:"01-horse.jpg"});await tree(page).getByText("01-horse.jpg",{exact:true}).click();
    await image(page,"01-horse_BW.jpg","B&W");await image(page,"01-horse_improved.jpg","Enhanced");
    const panel=page.getByRole("group",{name:"Original image panel",exact:true});await panel.getByText("Could not load Original image.",{exact:true}).waitFor();
    const bw=await page.getByRole("img",{name:"B&W",exact:true}).getAttribute("src");
    await page.evaluate(()=>{window.__controlsFailImage=null;window.__controlsDeferImage="01-horse.jpg";});
    await panel.getByRole("button",{name:"Retry Original image",exact:true}).click();await page.waitForFunction(()=>typeof window.__controlsReleaseImage==="function");
    assert.equal(await upload(page,"B&W").isDisabled(),true);assert.equal(await upload(page,"Enhanced").isDisabled(),true);
    assert.equal(await page.getByRole("img",{name:"B&W",exact:true}).getAttribute("src"),bw);
    await page.evaluate(()=>{window.__controlsDeferImage=null;window.__controlsReleaseImage();});await image(page,"01-horse.jpg","Original");await settled(page);
    assert.equal(await page.getByRole("img",{name:"B&W",exact:true}).getAttribute("src"),bw);assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Deferred comparison Retry cannot repaint a new RAW source or staging root",async()=>{
    for(const change of ["source","root"]) {
      const page=await fixture({__controlsRawFixture:change==="source",__controlsFailImage:"01-horse_improved.jpg"});
      await tree(page).getByText(change==="source"?"01-horse.CR3":"01-horse.jpg",{exact:true}).click();
      const panel=page.getByRole("group",{name:"Enhanced image panel",exact:true});await panel.getByText("Could not load Enhanced image.",{exact:true}).waitFor();
      await page.evaluate(()=>{window.__controlsFailImage=null;window.__controlsDeferImage="01-horse_improved.jpg";});
      await panel.getByRole("button",{name:"Retry Enhanced image",exact:true}).click();await page.waitForFunction(()=>typeof window.__controlsReleaseImage==="function");
      await page.evaluate(()=>{window.__oldRetryRelease=window.__controlsReleaseImage;window.__controlsDeferImage=null;});
      if(change==="source") {
        await page.getByLabel("Original source",{exact:true}).selectOption("raw");await image(page,"01-horse.CR3","Original RAW");await image(page,"01-owned-colour.jpg","Developed RAW");await settled(page,"Original RAW");
      } else {
        await page.evaluate(()=>window.__controlsSwitchRoot("D:\\Other photos"));await tree(page).getByText("01-horse.jpg",{exact:true}).click();await image(page,"01-horse_improved.jpg","Enhanced","D:\\Other photos");await settled(page);
      }
      await page.evaluate(()=>window.__oldRetryRelease());
      if(change==="source") {await image(page,"01-owned-colour.jpg","Developed RAW");assert.equal(await page.getByLabel("Original source",{exact:true}).inputValue(),"raw");}
      else {await image(page,"01-horse_improved.jpg","Enhanced","D:\\Other photos");await hotkey(page,"e");await page.waitForFunction(()=>window.__controlsSelectionWrites.length===1);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].root),"D:\\Other photos");}
      assert.equal(await page.getByRole("button",{name:"Retry Enhanced image",exact:true}).count(),0);await page.close();
    }
  });
  await group("700 files show the selected original while folder inspection is held; preview navigation works and all decisions stay paused",async()=>{
    const page=await fixture({__controlsLazyMetadata:true,__controlsDeferMetadata:true});await tree(page).getByText("Event",{exact:true}).waitFor();
    await page.evaluate(()=>{const folder=window.__controlsLibraries.get("D:\\Controller photos").tree.children.find(n=>n.path==="Event");folder.children=Array.from({length:350},(_,i)=>["CR3","JPG"].map(ext=>{const name=String(i+1).padStart(3,"0")+"."+ext;return{type:"file",name,path:"Event/"+name,size:32768,captureMetadataPending:true};})).flat();});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await tree(page).getByText("001.CR3",{exact:true}).waitFor();
    const start=performance.now();await tree(page).getByText("001.CR3",{exact:true}).click();await image(page,"Event/001.CR3");
    report.measurements.push({files:700,firstImageMs:Math.round(performance.now()-start),metadataStillHeld:await page.evaluate(()=>typeof window.__controlsReleaseMetadata==="function")});
    await page.getByTestId("lightbox-capture-checks").getByText(/700 files/).waitFor();assert.equal(await upload(page).isDisabled(),true);
    await page.getByTestId("lightbox-version-controls-original").getByText("Capture checks pending",{exact:true}).waitFor();
    for(const key of ["1","Delete","q","c","v"])await hotkey(page,key);assert.deepEqual(await mutationCounts(page),[0,0,0]);assert.equal(await page.getByRole("dialog",{name:"Crop photo"}).count(),0);
    await hotkey(page,"+");assert.ok(await page.getByRole("img",{name:"Original",exact:true}).getAttribute("style").then(x=>x.includes("scale(1.25)")));
    await hotkey(page,"ArrowRight");await image(page,"Event/001.JPG");
    assert.equal(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").length),1);
    assert.equal(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="google_photos_catalogue").length),0);
    await page.screenshot({path:output+"/700-preview-checking.png",fullPage:true});
    await page.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});await settled(page);assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Original and B&W paint before held Enhanced; its late completion cannot replace a newer photo",async()=>{
    const page=await fixture({__controlsDeferImage:"01-horse_improved.jpg"});await tree(page).getByText("01-horse.jpg",{exact:true}).click();
    await image(page,"01-horse.jpg","Original");await image(page,"01-horse_BW.jpg","B&W");await settled(page);
    await page.getByRole("group",{name:"Enhanced image panel",exact:true}).getByText("Loading image…",{exact:true}).waitFor();
    await upload(page).check();await page.waitForFunction(()=>window.__controlsSelectionWrites.length===1);await settled(page);
    await hotkey(page,"ArrowRight");await image(page,"02-rider.jpg","Original");await settled(page);
    await page.evaluate(()=>{window.__controlsDeferImage=null;window.__controlsReleaseImage();});await image(page,"02-rider_improved.jpg","Enhanced");
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"01-horse.jpg");await image(page,"02-rider.jpg","Original");await page.close();
  });
  await group("Folder work is one active and one latest queued; late pairing retains the clicked JPEG and current capture",async()=>{
    const page=await fixture({__controlsLazyMetadata:true,__controlsDeferMetadata:true});await tree(page).getByText("Event",{exact:true}).waitFor();
    await page.evaluate(()=>{const lib=window.__controlsLibraries.get("D:\\Controller photos");lib.tree.children.push({type:"dir",name:"Third",path:"Third",children:["01-horse.CR3","01-horse.JPG"].map(name=>({type:"file",name,path:"Third/"+name,size:32768,captureMetadataPending:true}))});});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await tree(page).getByText("Third",{exact:true}).waitFor();
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(0).click();await image(page,"Event/01-horse.JPG");
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(1).click();await image(page,"Elsewhere/01-horse.JPG");
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(2).click();await image(page,"Third/01-horse.JPG");
    assert.equal(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").length),1);
    await page.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});await image(page,"Third/01-horse.JPG","Camera JPEG");await settled(page,"Camera JPEG");
    const dirs=await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").map(c=>c.args.relativeDir));assert.deepEqual(dirs,["Event","Third"]);
    await hotkey(page,"q");await page.waitForFunction(()=>window.__controlsSelectionWrites.length===1);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"Third/01-horse.JPG");await page.close();
  });
  await group("Incomplete capture checks keep a usable preview and explicit retry; only verified pairing enables exact-JPEG writes",async()=>{
    const page=await fixture({__controlsLazyMetadata:true,__controlsMetadataIncomplete:true});await tree(page).getByText("01-horse.JPG",{exact:true}).nth(0).click();await image(page,"Event/01-horse.JPG");
    await page.getByRole("button",{name:"Retry capture checks",exact:true}).waitFor();assert.equal(await upload(page).isDisabled(),true);
    await hotkey(page,"q");assert.deepEqual(await mutationCounts(page),[0,0,0]);
    await page.evaluate(()=>{window.__controlsMetadataIncomplete=false;});await page.getByRole("button",{name:"Retry capture checks",exact:true}).click();
    await image(page,"Event/01-horse.JPG","Camera JPEG");await settled(page,"Camera JPEG");await hotkey(page,"q");await page.waitForFunction(()=>window.__controlsSelectionWrites.length===1);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"Event/01-horse.JPG");await page.close();
  });
  await group("Corrupt lineage remains display-only even when folder metadata is nominally complete",async()=>{
    const page=await fixture({__controlsRawFixture:true,__controlsRawWarning:"Synthetic corrupt lineage"});await tree(page).getByText("01-horse.CR3",{exact:true}).click();await image(page,"01-horse.JPG","Camera JPEG");
    await page.getByText(/RAW metadata needs attention: Synthetic corrupt lineage/).waitFor();assert.equal(await upload(page,"Camera JPEG").isDisabled(),true);
    for(const key of ["1","Delete","q","c"])await hotkey(page,key);assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Reopening the same staging root cannot reuse an old view's held inspection",async()=>{
    const page=await fixture({__controlsLazyMetadata:true,__controlsDeferMetadata:true});
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(0).click();await image(page,"Event/01-horse.JPG");
    await page.waitForFunction(()=>typeof window.__controlsReleaseMetadata==="function");
    await page.evaluate(()=>window.__controlsSwitchRoot("D:\\Controller photos"));
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(0).click();await image(page,"Event/01-horse.JPG");
    assert.equal(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").length),1);
    await page.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});
    await page.waitForFunction(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").length===2,null,{timeout:2000});
    await image(page,"Event/01-horse.JPG","Camera JPEG");await settled(page,"Camera JPEG");assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Expanding another folder cannot cancel the selected photo's queued inspection",async()=>{
    const page=await fixture({__controlsLazyMetadata:true,__controlsDeferMetadata:true});
    await page.evaluate(()=>{window.__controlsLibraries.get("D:\\Controller photos").tree.children.push({type:"dir",name:"Browse only",path:"Browse only",children:[{type:"file",name:"browse.CR3",path:"Browse only/browse.CR3",size:32,captureMetadataPending:true}]});});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await tree(page).getByText("Browse only",{exact:true}).waitFor();
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(0).click();await image(page,"Event/01-horse.JPG");
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(1).click();await image(page,"Elsewhere/01-horse.JPG");
    await tree(page).getByText("Browse only",{exact:true}).click();await tree(page).getByText("Browse only",{exact:true}).click();
    await page.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});await image(page,"Elsewhere/01-horse.JPG","Camera JPEG");await settled(page,"Camera JPEG");
    assert.deepEqual(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").map(c=>c.args.relativeDir)),["Event","Elsewhere"]);await page.close();
  });
  await group("A missing explicitly selected Camera JPEG never falls back to the RAW preview or changes its upload target",async()=>{
    const page=await fixture({__controlsRawFixture:true});await tree(page).getByText("01-horse.CR3",{exact:true}).click();await settled(page,"Camera JPEG");
    await page.getByRole("combobox",{name:"Original source",exact:true}).selectOption("cameraJpeg");await image(page,"01-horse.JPG","Camera JPEG");await settled(page,"Camera JPEG");
    await page.evaluate(()=>{const lib=window.__controlsLibraries.get("D:\\Controller photos");lib.tree.children=lib.tree.children.filter(n=>n.path!=="01-horse.JPG");});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await page.getByText(/The selected Camera JPEG is missing or unavailable/).waitFor();
    assert.equal(await page.locator(".review-images img").count(),0);await hotkey(page,"q");assert.deepEqual(await mutationCounts(page),[0,0,0]);
    await tree(page).getByText("01-horse.CR3",{exact:true}).click();await image(page,"01-horse.CR3");await page.close();
  });
  await group("Source changes fence each independently loading comparison",async()=>{
    const page=await fixture({__controlsRawFixture:true,__controlsDeferImage:"01-owned-bw.jpg"});await tree(page).getByText("01-horse.CR3",{exact:true}).click();await settled(page,"Camera JPEG");
    await page.getByRole("combobox",{name:"Original source",exact:true}).selectOption("raw");await image(page,"01-horse.CR3","Original RAW");await settled(page,"Original RAW");
    await page.getByRole("combobox",{name:"Original source",exact:true}).selectOption("cameraJpeg");await image(page,"01-horse.JPG","Camera JPEG");await image(page,"01-horse_BW.jpg","B&W");
    await page.evaluate(()=>{window.__controlsDeferImage=null;window.__controlsReleaseImage();});await image(page,"01-horse_BW.jpg","B&W");await settled(page,"Camera JPEG");assert.deepEqual(await mutationCounts(page),[0,0,0]);await page.close();
  });
  await group("Unrelated expansion cannot hide Retry after the selected inspection is incomplete",async()=>{
    const page=await fixture({__controlsLazyMetadata:true,__controlsDeferMetadata:true,__controlsMetadataIncomplete:true});
    await page.evaluate(()=>{window.__controlsLibraries.get("D:\\Controller photos").tree.children.push({type:"dir",name:"Browse only",path:"Browse only",children:[{type:"file",name:"browse.CR3",path:"Browse only/browse.CR3",size:32,captureMetadataPending:true}]});});
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await tree(page).getByText("Browse only",{exact:true}).waitFor();
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(0).click();await image(page,"Event/01-horse.JPG");
    await tree(page).getByText("01-horse.JPG",{exact:true}).nth(1).click();await image(page,"Elsewhere/01-horse.JPG");
    await tree(page).getByText("Browse only",{exact:true}).click();await tree(page).getByText("Browse only",{exact:true}).click();
    await page.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});
    await page.getByRole("button",{name:"Retry capture checks",exact:true}).waitFor({timeout:2000});
    assert.equal(await upload(page).isDisabled(),true);assert.deepEqual(await mutationCounts(page),[0,0,0]);
    await page.evaluate(()=>{window.__controlsMetadataIncomplete=false;});await page.getByRole("button",{name:"Retry capture checks",exact:true}).click();
    await image(page,"Elsewhere/01-horse.JPG","Camera JPEG");await settled(page,"Camera JPEG");
    assert.ok(await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").every(c=>c.args.relativeDir!=="Browse only")));await page.close();
  });
  assert.deepEqual(errors,[]);report.complete=true;
}catch(error){report.error=String(error.stack||error);report.failedCheck=check;process.exitCode=1;}
finally{await writeFile(output+"/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();server.kill();}
