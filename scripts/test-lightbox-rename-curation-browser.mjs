import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Production Review/useReview/useGooglePhotoCuration. Only local native IO is
// synthetic; targeted catalogue reads enforce the production existing-path rule.
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/lightbox-rename-curation-browser";
await mkdir(output, { recursive: true });
const base = "http://127.0.0.1:1491";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1491", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser, page;
server.stdout.on("data", data => serverLog += data); server.stderr.on("data", data => serverLog += data);
const report = { complete: false, checks: [], traces: [], scope: "Actual Lightbox rename and targeted-catalogue boundary with synthetic local photos. No user media, native changes or upload operations." };
async function fixture(options={}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript(value=>Object.assign(window,value),options);
  await page.addInitScript(() => {
    window.__renameCatalogueTrace = [];
    let native;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, get: () => native, set: value => {
      native = value;
      const invoke = value.invoke;
      value.invoke = async (command, args) => {
        if (command === "google_photos_catalogue" && args.relativePath) {
          const flatten = node => node.type === "file" ? [node] : (node.children || []).flatMap(flatten);
          const paths = flatten(window.__controlsLibraries.get(args.root).tree).map(node => node.path);
          const exists = paths.includes(args.relativePath);
          window.__renameCatalogueTrace.push({ path: args.relativePath, exists });
          if (!exists) throw Error("The photo is no longer present; refresh the Lightbox.");
        }
        const result=await invoke(command, args);
        if(command==="google_photos_catalogue"&&args.relativePath&&window.__renameFailHeldCatalogue){window.__renameFailHeldCatalogue=false;window.__renameInjectedErrors=(window.__renameInjectedErrors||0)+1;throw Error("Synthetic retired read failure");}
        return result;
      };
    } });
  });
  await page.goto(base + "/lightbox-controls-preview.html");
  await page.getByRole("tree").getByText("01-horse.jpg", { exact: true }).click();
  return page;
}
const checkbox=page=>page.getByRole("checkbox", { name: "Upload Original to Google Photos", exact: true });
async function ready(page) {
  await page.waitForFunction(()=>{const input=document.querySelector('input[aria-label="Upload Original to Google Photos"]');return input&&!input.disabled&&input.getAttribute("aria-busy")!=="true";});
}
async function trace(page) {return page.evaluate(()=>({catalogue:window.__renameCatalogueTrace,calls:window.__controlsCalls.filter(call=>["rename_file","google_photos_catalogue"].includes(call.command)),text:document.body.innerText}));}
async function group(name,run) {if(process.env.PHOTOGOGO_RENAME_CASE&&!name.includes(process.env.PHOTOGOGO_RENAME_CASE))return;await run();report.checks.push(name);report.traces.push({name,...await trace(page)});console.log("PASS "+name);await page.close();page=null;}
try {
  for (let n = 0; ; n++) { try { if ((await fetch(base + "/lightbox-controls-preview.html")).ok) break; } catch {} if (n > 100) throw Error("Fixture unavailable: " + serverLog); await delay(100); }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  await group("Trash rename refreshes selections for the confirmed new path without an unavailable warning",async()=>{
  page=await fixture();await ready(page);await page.getByRole("button", { name: "🗑 Trash", exact: true }).click();
  await page.getByRole("button", { name: "✗ Trashed", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="Upload Original to Google Photos"]');
    return input && !input.disabled && !document.body.textContent.includes("Upload selections unavailable");
  });
  assert.equal(await checkbox(page).isChecked(), false);
  await checkbox(page).check();
  await page.waitForFunction(() => window.__controlsSelectionWrites.length === 1 && !document.querySelector('input[aria-label="Upload Original to Google Photos"]').getAttribute("aria-busy")?.includes("true"));
  assert.equal(await page.evaluate(() => window.__controlsSelectionWrites[0].relativePath), "01-horse{trash}.jpg");
  assert.equal(await page.getByText(/Upload selections unavailable/).count(),0);
  });
  await group("Rating renames also reconcile the new path and ordinary navigation reuses the same-folder catalogue",async()=>{
    page=await fixture();await ready(page);await page.locator('[aria-label="Photo Lightbox review"]').focus();await page.keyboard.press("2");
    await page.getByRole("tree").getByText("01-horse{Like oo}.jpg",{exact:true}).waitFor();await ready(page);
    await checkbox(page).check();await ready(page);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"01-horse{Like oo}.jpg");
    const scans=await page.evaluate(()=>window.__controlsCalls.filter(call=>call.command==="google_photos_catalogue").length);
    await page.getByRole("button",{name:"Next original photo",exact:true}).click();await page.locator('[title="02-rider.jpg"]').last().waitFor();await ready(page);
    await page.getByRole("button",{name:"Previous original photo",exact:true}).click();await page.locator('[title="01-horse{Like oo}.jpg"]').last().waitFor();await ready(page);
    assert.equal(await page.evaluate(()=>window.__controlsCalls.filter(call=>call.command==="google_photos_catalogue").length),scans);
    assert.equal(await checkbox(page).isChecked(),true);
  });
  await group("A real failed checkbox remains visible after a rename until its own exact-version retry succeeds",async()=>{
    page=await fixture({__controlsSelectionError:"Synthetic unsaved checkbox"});await ready(page);await checkbox(page).click();
    await page.getByText(/Selection save was not confirmed.*Synthetic unsaved checkbox/).first().waitFor();await ready(page);
    await page.getByRole("button",{name:"🗑 Trash",exact:true}).click();await page.getByRole("button",{name:"✗ Trashed",exact:true}).waitFor();await ready(page);
    assert.equal(await checkbox(page).isChecked(),false);assert.ok(await page.getByText(/Selection save was not confirmed.*Synthetic unsaved checkbox/).count()>0);
    await page.evaluate(()=>window.__controlsSelectionError=undefined);await checkbox(page).check();await ready(page);
    assert.equal(await page.getByText(/Selection save was not confirmed/).count(),0);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.length),2);
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[1].relativePath),"01-horse{trash}.jpg");
  });
  await group("Trash cannot race a pending checkbox save and each confirmed intent is persisted once",async()=>{
    page=await fixture({__controlsDeferSelection:true});await ready(page);await checkbox(page).check();await page.waitForFunction(()=>window.__controlsSelectionWrites.length===1);
    assert.equal(await page.getByRole("button",{name:"🗑 Trash",exact:true}).isDisabled(),true);
    await page.locator('[aria-label="Photo Lightbox review"]').focus();await page.keyboard.press("Delete");assert.equal(await page.evaluate(()=>window.__controlsRenames.length),0);
    await page.evaluate(()=>{window.__controlsDeferSelection=false;window.__controlsReleaseSelection();});await ready(page);
    await page.getByRole("button",{name:"🗑 Trash",exact:true}).click();await page.getByRole("button",{name:"✗ Trashed",exact:true}).waitFor();await ready(page);
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.length),1);assert.equal(await page.evaluate(()=>window.__controlsRenames.length),1);assert.equal(await checkbox(page).isChecked(),true);
  });
  await group("A genuine catalogue read failure recovers on the confirmed renamed photo without clearing failed writes",async()=>{
    page=await fixture({__controlsCatalogueError:"Synthetic catalogue unavailable"});await page.getByText(/Upload selections unavailable/).first().waitFor();
    await page.evaluate(()=>window.__controlsCatalogueError=undefined);await page.getByRole("button",{name:"🗑 Trash",exact:true}).click();await page.getByRole("button",{name:"✗ Trashed",exact:true}).waitFor();await ready(page);
    assert.equal(await page.getByText(/Upload selections unavailable/).count(),0);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.length),0);
  });
  await group("A held pre-rename catalogue cannot replace the new photo's selections after it finishes",async()=>{
    page=await fixture();await ready(page);await page.evaluate(()=>window.__controlsDeferCatalogue=true);
    await page.getByRole("button",{name:"Refresh photos",exact:true}).click();await page.waitForFunction(()=>typeof window.__controlsReleaseCatalogue==="function");
    await page.getByRole("button",{name:"🗑 Trash",exact:true}).click();await page.getByRole("button",{name:"✗ Trashed",exact:true}).waitFor();
    await page.evaluate(()=>{window.__controlsDeferCatalogue=false;window.__controlsReleaseCatalogue();});await ready(page);
    assert.equal(await page.getByText(/Upload selections unavailable/).count(),0);await checkbox(page).check();await ready(page);
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.length),1);assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"01-horse{trash}.jpg");
  });
  await group("A late failed read for A is replaced by the current cached B selection without stale warnings",async()=>{
    page=await fixture({__controlsSelectionError:"Synthetic retained checkbox"});await ready(page);await checkbox(page).click();await page.getByText(/Selection save was not confirmed.*Synthetic retained checkbox/).first().waitFor();await ready(page);
    await page.evaluate(()=>{window.__controlsSelectionError=undefined;window.__controlsDeferCatalogue=true;window.__renameFailHeldCatalogue=true;});
    await page.getByRole("button",{name:"Reload selections",exact:true}).click();await page.waitForFunction(()=>typeof window.__controlsReleaseCatalogue==="function");
    await page.getByRole("button",{name:"Next original photo",exact:true}).click();await page.locator('[title="02-rider.jpg"]').last().waitFor();
    await page.evaluate(()=>{window.__controlsDeferCatalogue=false;window.__controlsReleaseCatalogue();});
    await page.waitForFunction(()=>window.__renameInjectedErrors===1&&window.__controlsCalls.some(call=>call.command==="google_photos_catalogue"&&call.args.relativePath==="02-rider.jpg"));await ready(page);
    assert.equal(await page.getByText(/Upload selections unavailable/).count(),0);await checkbox(page).check();await ready(page);
    assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.at(-1).relativePath),"02-rider.jpg");assert.equal(await page.evaluate(()=>window.__controlsSelectionWrites.length),2);
  });
  await group("A persistent same-photo catalogue failure stays visible without an automatic retry loop",async()=>{
    page=await fixture({__controlsCatalogueError:"Persistent catalogue failure"});await page.getByText(/Upload selections unavailable.*Persistent catalogue failure/).first().waitFor();
    await page.evaluate(()=>new Promise(resolve=>{let frames=0;function next(){if(++frames===5)resolve();else requestAnimationFrame(next);}requestAnimationFrame(next);}));
    const scans=await page.evaluate(()=>window.__controlsCalls.filter(call=>call.command==="google_photos_catalogue").length);assert.ok(scans<=2,`Persistent read failure unexpectedly retried ${scans} times`);
    assert.equal(await checkbox(page).isDisabled(),true);assert.ok(await page.getByText(/Upload selections unavailable/).count()>0);
  });
  report.complete = true;
} catch (error) {
  report.error = String(error.stack || error); process.exitCode = 1;
  await page?.screenshot({ path: output + "/failure.png", fullPage: true }).catch(() => {});
} finally {
  if (page) report.trace = await trace(page).catch(() => null);
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({complete:report.complete,checks:report.checks,error:report.error}, null, 2)); await browser?.close(); server.kill();
}
