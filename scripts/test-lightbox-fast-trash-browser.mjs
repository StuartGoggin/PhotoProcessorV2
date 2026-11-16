import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {pathToFileURL} from "node:url";
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:"playwright");
const url="http://127.0.0.1:1487/lightbox-controls-preview.html",output="test-output/lightbox-fast-trash-browser";
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1487","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let log="",browser;server.stdout.on("data",v=>log+=v);server.stderr.on("data",v=>log+=v);
const skipBenchmark=process.env.PHOTOGOGO_FAST_TRASH_SKIP_BENCHMARK==="1";
const report={complete:false,checks:[],measurements:{},benchmarkSkipped:skipBenchmark,scope:"Synthetic IPC; actual React Lightbox. No user photos, native deletion or Google account."};
const errors=[];
async function fixture(options={}){const page=await browser.newPage({viewport:{width:1360,height:980}});page.on("pageerror",e=>errors.push(e.message));await page.addInitScript(v=>Object.assign(window,v),options);await page.goto(url);const first=options.__controlsLargeCount?"20261109_100000_frame-0000.jpg":options.__controlsRawWorkflow?"01-camera{Like oo}.JPG":"01-horse.jpg";await page.getByRole("tree").getByText(first,{exact:true}).click();await ready(page,first);return page;}
async function ready(page,name){await page.waitForFunction(name=>{const label=/camera/i.test(name)?"Camera JPEG":"Original",img=document.querySelector('.review-images img[alt="'+label+'"]'),input=document.querySelector('input[aria-label="Upload '+label+' to Google Photos"]');return document.querySelector('[title="'+name+'"]')&&img?.complete&&img.naturalWidth>0&&input&&!input.disabled;},name);await page.locator('[aria-label="Photo Lightbox review"]').focus();}
async function release(page){await page.evaluate(()=>{window.__controlsHoldActions=false;window.__controlsDeferredActions.shift()?.();});}
async function group(name,body){if((skipBenchmark&&name.startsWith("725 "))||(process.env.PHOTOGOGO_FAST_TRASH_CASE&&!name.includes(process.env.PHOTOGOGO_FAST_TRASH_CASE)))return;await body();report.checks.push(name);console.log("PASS "+name);}
try{
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(url)).ok)break;}catch{}await delay(100);}
  browser=await chromium.launch({channel:"msedge",headless:true});
  await group("Trash advances before persistence without a folder scan; pending Undo resolves in order",async()=>{
    const page=await fixture({__controlsHoldActions:true,__controlsDeferRename:true});
    const scans=await page.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="list_staging_tree").length);
    await page.keyboard.press("x");
    await page.getByTitle("02-rider.jpg",{exact:true}).waitFor({timeout:1500});
    await page.getByText(/Saving 1 decision/).waitFor();
    await page.keyboard.press("Control+z");await release(page);
    await ready(page,"01-horse.jpg");await page.getByText("All changes saved",{exact:true}).waitFor();
    const state=await page.evaluate(()=>({writes:window.__controlsActionWrites,scans:window.__controlsCalls.filter(c=>c.command==="list_staging_tree").length,renames:window.__controlsRenames.length}));
    assert.equal(state.scans,scans);assert.equal(state.renames,0);assert.equal(state.writes[1].direction,"undo");
    await page.keyboard.press("Control+y");await ready(page,"01-horse{trash}.jpg");
    await page.getByRole("button",{name:"Review history",exact:true}).click();await page.getByRole("region",{name:"Trash and Restore history"}).waitFor();
    await page.screenshot({path:`${output}/history.png`,fullPage:true});await page.close();
  });
  await group("A failed photo remains identified after advance and Retry unblocks its saved decision",async()=>{
    const page=await fixture({__controlsFailActions:true});await page.keyboard.press("Delete");await ready(page,"02-rider.jpg");
    await page.getByRole("region",{name:"Unsaved photo decisions"}).getByText(/01-horse/).waitFor();
    assert.equal(await page.getByRole("button",{name:"Discard rejected action and queued unsaved actions",exact:true}).count(),0,"Unknown save outcomes must remain retry-only");
    await page.evaluate(()=>window.__controlsFailActions=false);await page.getByRole("button",{name:"Retry decision",exact:true}).click();
    await page.getByText("All changes saved",{exact:true}).waitFor();await page.keyboard.press("Control+z");await ready(page,"01-horse.jpg");await page.close();
  });
  await group("Failed decision Retry after remount reconciles the new view and persistent Undo history",async()=>{
    const page=await fixture({__controlsFailActions:true});await page.keyboard.press("x");await ready(page,"02-rider.jpg");await page.getByRole("region",{name:"Unsaved photo decisions"}).waitFor();
    await page.evaluate(()=>window.__controlsRemount());await page.getByRole("tree").getByText("02-rider.jpg",{exact:true}).click();await ready(page,"02-rider.jpg");
    await page.evaluate(()=>window.__controlsFailActions=false);await page.getByRole("button",{name:"Retry decision",exact:true}).click();await page.getByText("All changes saved",{exact:true}).waitFor();
    await page.getByRole("tree").getByText("01-horse{trash}.jpg",{exact:true}).waitFor({timeout:2500});
    await page.waitForFunction(()=>!document.querySelector('[aria-label="Folder review information"]'),undefined,{timeout:2500});
    await page.keyboard.press("Control+z");await ready(page,"01-horse.jpg");await page.close();
  });
  await group("A deliberately discarded admission rejection cancels dependent Undo without changing earlier saved history",async()=>{
    const page=await fixture();await page.keyboard.press("x");await ready(page,"02-rider.jpg");await page.getByText("All changes saved",{exact:true}).waitFor();
    await page.evaluate(()=>{window.__controlsRejectActions=true;window.__controlsHoldActions=true;});await page.keyboard.press("x");await ready(page,"03-wide.jpg");await page.keyboard.press("Control+z");await release(page);
    const discard=page.getByRole("button",{name:"Discard rejected action and queued unsaved actions",exact:true});await discard.waitFor({timeout:2500});
    page.once("dialog",dialog=>dialog.dismiss());await discard.click();assert.equal(await discard.count(),1);
    let confirmedCount=false;page.once("dialog",async dialog=>{confirmedCount=/2 unsaved actions/.test(dialog.message());await dialog.accept();});await discard.click();assert.equal(confirmedCount,true);
    await page.getByRole("region",{name:"Discarded unsaved decisions"}).getByText(/Synthetic changed source/).waitFor();await page.getByText("All changes saved",{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__controlsActionWrites.filter(request=>request.direction).length),0,"Discard must not replay Undo against the older confirmed Trash");
    await page.evaluate(()=>window.__controlsRejectActions=false);await page.locator('[aria-label="Photo Lightbox review"]').focus();await page.keyboard.press("Control+z");await ready(page,"01-horse.jpg");await page.close();
  });
  await group("Queued Undo rejects another window's intervening action instead of undoing that capture",async()=>{
    const page=await fixture({__controlsHoldActions:true,__controlsExternalActionAfterSave:true});await page.keyboard.press("x");await ready(page,"02-rider.jpg");await page.keyboard.press("Control+z");await release(page);
    await page.getByRole("region",{name:"Unsaved photo decisions"}).getByText(/history changed in another window/).waitFor();
    const result=await page.evaluate(()=>({request:window.__controlsActionWrites[1],files:window.__controlsLibraries.get("D:\\Controller photos").tree.children.map(node=>node.name)}));
    assert.equal(result.request.expectedRevision,1);assert.ok(result.files.includes("01-horse{trash}.jpg"));assert.ok(result.files.includes("03-wide{trash}.jpg"),"External C remains trashed; stale queued Undo cannot target C");await page.close();
  });
  await group("Take out the trash lists JPEG and CR3 originals and protects ambiguity before explicit confirmation",async()=>{
    const page=await fixture();await page.getByRole("button",{name:"Take out the trash",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"Take out the trash"});await dialog.waitFor();
    await dialog.getByText("01-raw.CR3",{exact:true}).waitFor();await dialog.getByText("Several possible owners",{exact:true}).waitFor();
    assert.equal(await dialog.getByRole("checkbox",{name:/permanently remove/}).isChecked(),false);
    const remove=dialog.getByRole("button",{name:"Permanently remove listed files",exact:true});assert.equal(await remove.isDisabled(),true);
    await dialog.getByRole("checkbox",{name:/permanently remove/}).check();await remove.click();
    await page.waitForFunction(()=>window.__controlsViewedJob==="trash-job-fixture");
    assert.deepEqual(await page.evaluate(()=>window.__controlsTrashJobs),[{previewId:"trash-preview",acknowledged:true}]);await page.close();
  });
  await group("Filtered final capture completes without wrapping; Undo explains a temporary photo outside filters",async()=>{
    const page=await fixture();await page.getByLabel("Trash visibility").selectOption("hide");await page.locator('[aria-label="Photo Lightbox review"]').focus();
    for(const name of ["02-rider.jpg","03-wide.jpg"]){await page.keyboard.press("x");await ready(page,name);}
    await page.keyboard.press("x");await page.getByText(/Review complete ·/).waitFor();
    await page.getByText("All changes saved",{exact:true}).waitFor();await page.keyboard.press("Control+z");await ready(page,"03-wide.jpg");
    await page.getByText(/Showing the photo affected by Undo/).waitFor();
    await page.keyboard.press("Control+y");await ready(page,"03-wide{trash}.jpg");
    await page.evaluate(()=>window.__controlsRemount());await page.getByRole("button",{name:"Review history",exact:true}).click();
    await page.getByRole("region",{name:"Trash and Restore history"}).getByText("03-wide.jpg",{exact:true}).waitFor();await page.close();
  });
  await group("Paired capture Trash uses canonical RAW identity and keeps exact Google flags and rating",async()=>{
    const page=await fixture({__controlsRawWorkflow:true,__controlsInitialFlags:{"01-camera{Like oo}.JPG":{selected:true,favourite:true}}});
    await page.keyboard.press("Delete");await page.getByText("All changes saved",{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__controlsActionWrites[0].relativePath),"01-raw.CR3");
    await page.keyboard.press("Control+z");await ready(page,"01-camera{Like oo}.JPG");
    assert.equal(await page.getByRole("checkbox",{name:"Upload Camera JPEG to Google Photos",exact:true}).isChecked(),true);
    assert.equal(await page.getByRole("button",{name:/2 stars/}).getAttribute("aria-pressed"),"true");
    await page.getByRole("button",{name:"Redo",exact:true}).click();
    await ready(page,"01-camera{Like oo}{trash}.JPG");
    assert.equal(await page.getByRole("checkbox",{name:"Upload Camera JPEG to Google Photos",exact:true}).isChecked(),true,"Paired Redo resolves the renamed physical JPEG without losing its exact-file flags");
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.length),0);await page.close();
  });
  await group("Held replay survives folder navigation while stale history cannot replace the confirmed cursor",async()=>{
    const page=await fixture({__controlsHoldHistory:true});await page.keyboard.press("Delete");await ready(page,"02-rider.jpg");
    await page.getByText("All changes saved",{exact:true}).waitFor();await page.evaluate(()=>window.__controlsHoldActions=true);await page.keyboard.press("Control+z");
    await page.waitForFunction(()=>window.__controlsDeferredActions.length===1);
    await page.getByRole("tree").getByText("04-finish.jpg",{exact:true}).click();
    await page.evaluate(()=>{window.__controlsHoldHistory=false;window.__controlsDeferredHistories.splice(0).forEach(release=>release());});
    await release(page);await ready(page,"01-horse.jpg");
    await page.getByRole("button",{name:"Redo",exact:true}).waitFor();assert.equal(await page.getByRole("button",{name:"Redo",exact:true}).isEnabled(),true);
    await page.keyboard.press("Control+y");await ready(page,"01-horse{trash}.jpg");await page.close();
  });
  await group("Pending replay cannot overwrite a replacement staging root",async()=>{
    const page=await fixture();await page.keyboard.press("Delete");await ready(page,"02-rider.jpg");await page.getByText("All changes saved",{exact:true}).waitFor();
    await page.evaluate(()=>window.__controlsHoldActions=true);await page.keyboard.press("Control+z");await page.waitForFunction(()=>window.__controlsDeferredActions.length===1);
    await page.evaluate(()=>window.__controlsSwitchRoot("E:\\Replacement library"));await release(page);
    await page.getByRole("tree").getByText("02-rider.jpg",{exact:true}).click();await ready(page,"02-rider.jpg");
    assert.equal(await page.getByText(/Showing the photo affected by Undo/).count(),0);
    assert.equal(await page.getByTitle("01-horse.jpg",{exact:true}).count(),0);await page.close();
  });
  await group("Controller Undo remains available at Review complete without an active photo",async()=>{
    const page=await fixture({__controlsManagedController:true});
    await page.getByRole("tree").getByText("04-finish.jpg",{exact:true}).click();await ready(page,"04-finish.jpg");
    await page.keyboard.press("Delete");await page.getByText(/Review complete ·/).waitFor();await page.getByText("All changes saved",{exact:true}).waitFor();
    await page.waitForFunction(()=>window.__controlsControllerSnapshot()?.surface?.sideButtons?.[2]?.enabled,undefined,{timeout:2000});
    await page.evaluate(()=>window.__controlsNativeInput({kind:"side",index:2}));
    await page.waitForFunction(()=>window.__controllerSurface?.keys[3]?.label==="UNDO"&&window.__controllerSurface.keys[3].enabled);
    await page.evaluate(()=>window.__controlsNativeInput({index:3}));await ready(page,"04-finish.jpg");await page.close();
  });
  await group("Next original prefetch and Trash navigation do not wait for a deferred derivative",async()=>{
    const page=await fixture({__controlsDeferImage:"_BW"});
    await page.waitForFunction(()=>window.__controlsCalls.some(call=>call.command==="read_lightbox_image"&&call.args.path.endsWith("02-rider.jpg")),undefined,{timeout:2000});
    await page.keyboard.press("x");await ready(page,"02-rider.jpg");
    assert.equal(await page.evaluate(()=>window.__controlsActionWrites.length),1);await page.close();
  });
  await group("725 synthetic originals cull in visible order with bounded state and no per-decision scan",async()=>{
    const page=await fixture({__controlsLargeCount:725});page.setDefaultTimeout(120000);await page.exposeFunction("__fastTrashProgress",count=>console.log(`MEASURE ${count} / 725 decisions`));
    const result=await page.evaluate(async()=>{
      const samples=[],decodes=[],startScans=window.__controlsCalls.filter(c=>c.command==="list_staging_tree").length;
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
      const region=document.querySelector('[aria-label="Photo Lightbox review"]');
      const name=()=>[...region.querySelectorAll('span[title]')].find(node=>/frame-\d{4}/.test(node.title))?.title??"";
      const actionable=()=>[...region.querySelectorAll("button")].find(node=>node.textContent.includes("Trash & next"))?.disabled===false;
      for(let i=0;i<725;i++){
        const until=performance.now()+10000;while(!actionable()){if(performance.now()>until)throw Error("Photo did not become actionable at "+i);await frame();}
        const previous=name(),start=performance.now();window.dispatchEvent(new KeyboardEvent("keydown",{key:"x",code:"KeyX",bubbles:true}));
        while(name()===previous&&!region.textContent.includes("Review complete ·")){if(performance.now()>until)throw Error("Trash did not advance at "+i);await frame();}
        samples.push(performance.now()-start);
        const decoded=performance.now();while(i<724&&!actionable()){if(performance.now()>until)throw Error("Next image decode timed out at "+i);await frame();}decodes.push(performance.now()-decoded);
        if((i+1)%100===0)await window.__fastTrashProgress(i+1);
      }
      while(!region.textContent.includes("All changes saved"))await frame();
      const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
      return {count:window.__controlsActionWrites.length,additionalScans:window.__controlsCalls.filter(c=>c.command==="list_staging_tree").length-startScans,visual:{p50:percentile(samples,.5),p95:percentile(samples,.95),p99:percentile(samples,.99),max:Math.max(...samples)},nextDecode:{p50:percentile(decodes,.5),p95:percentile(decodes,.95)},reviewComplete:region.textContent.includes("Review complete ·")};
    });
    assert.equal(result.count,725);assert.equal(result.additionalScans,0);assert.equal(result.reviewComplete,true);report.measurements=result;
    console.log("MEASURE "+JSON.stringify(result));await page.close();
  });
  assert.deepEqual(errors,[]);report.complete=true;
}catch(error){report.error=error.stack;const pages=browser?.contexts().flatMap(context=>context.pages())??[];report.failurePages=await Promise.all(pages.map(async(page,index)=>{await page.screenshot({path:`${output}/failure-${index}.png`,fullPage:true});return await page.evaluate(()=>({text:document.body.innerText,writes:window.__controlsActionWrites,history:window.__controlsCalls.filter(c=>c.command.includes("review_history"))}));}));throw error;
}finally{if(browser)await browser.close();server.kill();const suffix=process.env.PHOTOGOGO_FAST_TRASH_CASE?"-"+process.env.PHOTOGOGO_FAST_TRASH_CASE.toLowerCase().replace(/[^a-z0-9]+/g,"-"):skipBenchmark?"-functional":"";await writeFile(`${output}/report${suffix}.json`,JSON.stringify({...report,errors},null,2));}
