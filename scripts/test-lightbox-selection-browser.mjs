import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:"playwright");
const output="test-output/lightbox-selection-browser";await mkdir(output,{recursive:true});
const base="http://127.0.0.1:1478";
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1478","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let browser,serverLog="";server.stdout.on("data",x=>serverLog+=x);server.stderr.on("data",x=>serverLog+=x);
const errors=[];const report={complete:false,scope:"Actual React review and transfer pages with delayed/failing synthetic local IPC; no photos, Google account, network upload or installation",checks:[],firstPaintMs:[]};
async function fixture(name="lightbox-controls",options={}) {
  const page=await browser.newPage({viewport:{width:1360,height:950}});page.setDefaultTimeout(10000);page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(x=>Object.assign(window,x),options);await page.goto(`${base}/${name}-preview.html`,{waitUntil:"domcontentloaded"});return page;
}
const box=(p,label="Original")=>p.getByRole("checkbox",{name:`Upload ${label} to Google Photos`,exact:true});
async function review(page) {
  await page.getByRole("tree").getByText("01-horse.jpg",{exact:true}).click();await page.waitForFunction(()=>{const box=document.querySelector('input[aria-label="Upload Original to Google Photos"]');return box&&!box.disabled;});
}
const calls=(page,command,key="__controlsCalls")=>page.evaluate(({command,key})=>window[key].filter(c=>c.command===command).length,{command,key});
async function writes(page,n){await page.waitForFunction(n=>window.__controlsSelectionWrites.length===n,n);}
async function release(page){await page.evaluate(()=>window.__controlsReleaseSelection());}
async function saved(page){await page.waitForFunction(()=>![...document.querySelectorAll('input[aria-busy]')].some(x=>x.getAttribute("aria-busy")==="true"));}
async function group(label,run){await run();report.checks.push(label);console.log("PASS "+label);}
try {
  for(let n=0;n<100;n++){try{if((await fetch(base+"/lightbox-controls-preview.html")).ok)break;}catch{}await delay(100);}
  browser=await chromium.launch({channel:"msedge",headless:true});
  await group("Checkmarks paint before persistence; rapid same-frame toggles and independent versions retain newest intent",async()=>{
    const p=await fixture("lightbox-controls",{__controlsDeferSelection:true});await review(p);
    const scans=await calls(p,"google_photos_catalogue");
    const result=await p.evaluate(async()=>{
      const box=document.querySelector('input[aria-label="Upload Original to Google Photos"]');const start=performance.now();box.click();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return {checked:box.checked,disabled:box.disabled,busy:box.getAttribute("aria-busy"),elapsedMs:performance.now()-start};
    });
    report.firstPaintMs.push(result.elapsedMs);assert.equal(result.checked,true);assert.equal(result.disabled,false);assert.equal(result.busy,"true");
    await writes(p,1);
    await p.evaluate(()=>{for(const key of ["q","q","Q","w","e"])window.dispatchEvent(new KeyboardEvent("keydown",{key,code:`Key${key.toUpperCase()}`,shiftKey:key==="Q",bubbles:true}));const favourite=document.querySelector('button[aria-label="Favourite Original"]');favourite.click();favourite.click();});
    assert.equal(await box(p).isChecked(),true);assert.equal(await box(p,"B&W").isChecked(),true);assert.equal(await box(p,"Enhanced").isChecked(),true);
    assert.equal(await p.getByRole("button",{name:"Favourite Original",exact:true}).getAttribute("aria-pressed"),"true");
    assert.equal(await p.getByRole("button",{name:"Next original photo"}).isDisabled(),true);
    // First ACK is older than two new Original requests; it cannot repaint them.
    for(let n=1;n<=8;n++){await writes(p,n);await release(p);if(n<8)await writes(p,n+1);if(n===2)assert.equal(await box(p).isChecked(),true);}
    await saved(p);assert.equal(await calls(p,"google_photos_catalogue"),scans,"Each checkbox save must avoid full-catalogue IPC");
    const flags=await p.evaluate(()=>Object.fromEntries(window.__controlsLibraries.get("D:\\Controller photos").flags));
    assert.deepEqual(flags["D:\\Controller photos|01-horse.jpg"],{selected:true,favourite:true});
    assert.deepEqual(flags["D:\\Controller photos|01-horse_bw.jpg"],{selected:true,favourite:false});
    assert.deepEqual(flags["D:\\Controller photos|01-horse_improved.jpg"],{selected:true,favourite:false});
    await p.screenshot({path:`${output}/saved.png`});await p.close();
  });
  await group("A favourite ACK cannot erase a failed checkbox; a deliberate checkbox retry recovers it",async()=>{
    const p=await fixture("lightbox-controls",{__controlsDeferSelection:true,__controlsFailSelectionAt:[1]});await review(p);await p.keyboard.press("q");await writes(p,1);await p.keyboard.press("Shift+Q");
    await release(p);await writes(p,2);await release(p);await saved(p);
    assert.equal(await box(p).isChecked(),false);assert.equal(await p.getByRole("button",{name:"Favourite Original",exact:true}).getAttribute("aria-pressed"),"true");
    await p.getByText(/Selection save was not confirmed.*Google Photos checkbox/).first().waitFor();
    await p.keyboard.press("q");await writes(p,3);assert.equal(await box(p).isChecked(),true);await release(p);await saved(p);
    assert.equal(await p.getByText(/Selection save was not confirmed/).count(),0);await p.close();
  });
  await group("Select+next waits for its own durable ACK after earlier queued version changes",async()=>{
    const p=await fixture("lightbox-controls",{__controlsDeferSelection:true});await review(p);await p.keyboard.press("q");await writes(p,1);await p.keyboard.press("w");await p.keyboard.press("g");
    for(let n=1;n<=3;n++){await writes(p,n);assert.equal(await p.getByRole("img",{name:"Original",exact:true}).count(),1);await p.getByText("01-horse.jpg",{exact:true}).last().waitFor();await release(p);}
    await p.waitForFunction(()=>[...document.querySelectorAll(".review-images img")].some(x=>x.alt==="Original"&&x.complete)&&document.querySelector('[title="02-rider.jpg"]'));
    assert.equal(await p.evaluate(()=>window.__controlsSelectionWrites[2].selected),true);await p.close();
  });
  await group("Old-root completion never updates a new root; late failures remain visible when reopening their root",async()=>{
    const p=await fixture("lightbox-controls",{__controlsDeferSelection:true,__controlsFailSelectionAt:[1]});await review(p);await p.keyboard.press("q");await writes(p,1);
    await p.evaluate(()=>window.__controlsSwitchRoot("E:\\New shoot"));await p.getByRole("tree").getByText("01-horse.jpg",{exact:true}).click();await release(p);await saved(p);
    await p.waitForFunction(()=>!document.querySelector('input[aria-label="Upload Original to Google Photos"]').disabled);assert.equal(await box(p).isChecked(),false);assert.equal(await p.getByText(/Selection save was not confirmed/).count(),0);
    await p.evaluate(()=>window.__controlsSwitchRoot("D:\\Controller photos"));await review(p);await p.getByText(/Synthetic delayed selection failure/).first().waitFor();assert.equal(await box(p).isChecked(),false);await p.close();
  });
  await group("Reload retains its clear-error intent when an ordinary refresh supersedes a held scan",async()=>{
    const p=await fixture("lightbox-controls",{__controlsSelectionError:"Synthetic reload test failure"});await review(p);await p.keyboard.press("q");await p.getByText(/Synthetic reload test failure/).first().waitFor();
    await p.evaluate(()=>{window.__controlsSelectionError=undefined;window.__controlsDeferCatalogue=true;});
    const initial=await calls(p,"google_photos_catalogue");await p.getByRole("button",{name:"Reload selections",exact:true}).click();
    await p.waitForFunction(()=>typeof window.__controlsReleaseCatalogue==="function");await p.locator('[aria-label="Photo Lightbox review"]').focus();await p.keyboard.press("r");
    await delay(100);await p.evaluate(()=>window.__controlsReleaseCatalogue());
    await p.waitForFunction(n=>window.__controlsCalls.filter(c=>c.command==="google_photos_catalogue").length>=n,initial+2);
    await p.evaluate(()=>{window.__controlsDeferCatalogue=false;window.__controlsReleaseCatalogue();});
    await p.waitForFunction(()=>!document.querySelector('input[aria-label="Upload Original to Google Photos"]').disabled);
    assert.equal(await p.getByText(/Selection save was not confirmed/).count(),0);assert.equal(await box(p).isChecked(),false);await p.close();
  });
  for(const kind of ["google","archive"]){
    const name=kind==="google"?"google-photos":"archive-transfer";const key=kind==="google"?"__googleCalls":"__archiveCalls";
    const command=kind==="google"?"google_photos_plan":"preview_archive_transfer";const buttonName=kind==="google"?"Review publish plan":"Preview archive";
    async function pendingPage(extra={}){const p=await fixture(name,{__deferCuration:true,...extra});await p.getByRole("button",{name:buttonName,exact:true}).waitFor();await p.waitForFunction(name=>!([...document.querySelectorAll("button")].find(x=>x.textContent===name)?.disabled),buttonName);await p.evaluate(()=>window.__enqueueCuration());await p.waitForFunction(()=>typeof window.__releaseCuration==="function");return p;}
    await group(`${kind} preview waits for accepted local selections`,async()=>{const p=await pendingPage();await p.getByRole("button",{name:buttonName,exact:true}).click();await delay(100);assert.equal(await calls(p,command,key),0);await p.evaluate(()=>window.__releaseCuration());await p.waitForFunction(({key,command})=>window[key].some(c=>c.command===command),{key,command});assert.equal(await p.evaluate(()=>window.__curationSaved),true);await p.close();});
    await group(`${kind} preview surfaces a failed selection without planning stale flags`,async()=>{const p=await pendingPage({__curationError:"Synthetic planner-barrier save failure"});await p.getByRole("button",{name:buttonName,exact:true}).click();await p.evaluate(()=>window.__releaseCuration());await p.getByText(/Synthetic planner-barrier save failure/).first().waitFor();assert.equal(await calls(p,command,key),0);await p.close();});
    await group(`${kind} unmount while waiting never starts a stale planner`,async()=>{const p=await pendingPage();await p.getByRole("button",{name:buttonName,exact:true}).click();await p.evaluate(kind=>{window[kind==="google"?"__googleUnmount":"__archiveUnmount"]();window.__releaseCuration();},kind);await delay(150);assert.equal(await calls(p,command,key),0);await p.close();});
  }
  assert.deepEqual(errors,[]);report.complete=true;
} catch(error){report.failure=String(error);report.serverLog=serverLog.slice(-1000);throw error;}
finally {await writeFile(`${output}/report.json`,JSON.stringify({...report,browserErrors:errors},null,2));await browser?.close();server.kill();}
