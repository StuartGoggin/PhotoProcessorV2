import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:"playwright");
const url="http://127.0.0.1:1504/lightbox-controls-preview.html",output="test-output/lightbox-trash-guide",figures="docs/user-guide/source";
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","1504","--strictPort"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
let logs="",browser;server.stdout.on("data",value=>logs+=value);server.stderr.on("data",value=>logs+=value);
const errors=[],report={complete:false,scope:"Actual React Lightbox history and removal confirmation with synthetic IPC and demo media. No native files, personal photos, jobs or Google accounts changed.",checks:[],screenshots:[]};
async function ready(page,name){await page.waitForFunction(name=>{const input=document.querySelector('input[aria-label="Upload Camera JPEG to Google Photos"]');return !!document.querySelector('[aria-label="Photo Lightbox review"] [title="'+name+'"]')&&input&&!input.disabled;},name);}
try{
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch(url)).ok)break;}catch{}await delay(100);}
  browser=await chromium.launch({channel:"msedge",headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:"reduce"});page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>window.__controlsRawWorkflow=true);await page.goto(url);
  await page.getByRole("tree").getByText("01-camera{Like oo}.JPG",{exact:true}).click();await ready(page,"01-camera{Like oo}.JPG");
  await page.locator('[aria-label="Photo Lightbox review"]').focus();await page.keyboard.press("x");await ready(page,"02-camera.JPG");await page.getByText("All changes saved",{exact:true}).waitFor();
  report.checks.push("Trash advances to next JPEG-first capture and reaches confirmed saved state");
  await page.getByRole("button",{name:"Undo",exact:true}).click();await ready(page,"01-camera{Like oo}.JPG");
  await page.getByRole("button",{name:"Redo",exact:true}).click();await ready(page,"01-camera{Like oo}{trash}.JPG");await page.getByText("All changes saved",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Review history",exact:true}).click();await page.getByRole("region",{name:"Trash and Restore history"}).getByText("01-camera{Like oo}.JPG",{exact:true}).waitFor();
  await page.getByText(/Showing the photo affected by Undo/).waitFor();
  const history=figures+"/lightbox-history-screen.png";await page.screenshot({path:history});report.screenshots.push(history);report.checks.push("Undo and Redo retain rating, reopen affected capture and expose the saved history");
  await page.evaluate(()=>window.__controlsTrashPreview={id:"guide-trash-preview",stagingDir:"D:\\Controller photos",relativeDir:"",recursive:false,canStart:true,captureCount:1,fileCount:4,totalBytes:131072,warnings:[],items:[
    {relativePath:"01-camera{Like oo}{trash}.JPG",capturePath:"01-raw.CR3",kind:"Camera JPEG original",bytes:32768,included:true,reason:"Verified member of this trashed capture"},
    {relativePath:"01-raw.CR3",capturePath:"01-raw.CR3",kind:"Camera RAW original",bytes:32768,included:true,reason:"Verified paired CR3 original"},
    {relativePath:"01-camera_improved.jpg",capturePath:"01-raw.CR3",kind:"Enhanced JPEG",bytes:32768,included:true,reason:"Proven generated member"},
    {relativePath:"01-finish.jpg",capturePath:"01-raw.CR3",kind:"Developed RAW JPEG",bytes:32768,included:true,reason:"Manifest-owned RAW development"},
  ]});
  await page.getByRole("button",{name:"Take out the trash",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Take out the trash",exact:true});await dialog.getByText("01-raw.CR3",{exact:true}).waitFor();
  assert.equal(await dialog.getByRole("checkbox",{name:"Include subfolders",exact:true}).isChecked(),false);
  assert.equal(await dialog.getByRole("checkbox",{name:/permanently remove/}).isChecked(),false);
  assert.equal(await dialog.getByRole("button",{name:"Permanently remove listed files",exact:true}).isDisabled(),true);
  const preview=figures+"/lightbox-trash-preview.png";await dialog.screenshot({path:preview});report.screenshots.push(preview);
  assert.equal(await page.evaluate(()=>window.__controlsTrashJobs?.length??0),0);
  report.checks.push("Exact four-file preview includes JPEG and CR3 originals plus proven derivatives; recursive scope and irreversible consent stay unchecked and no deletion job starts");
  assert.deepEqual(errors,[]);report.complete=true;
}catch(error){report.error=error.stack;report.failure=await browser?.contexts()[0]?.pages()[0]?.evaluate(()=>({text:document.body.innerText,writes:window.__controlsActionWrites}));await browser?.contexts()[0]?.pages()[0]?.screenshot({path:output+"/failure.png"});throw error;}
finally{await browser?.close();server.kill();await writeFile(output+"/report.json",JSON.stringify({...report,errors},null,2));}
console.log(JSON.stringify(report));
