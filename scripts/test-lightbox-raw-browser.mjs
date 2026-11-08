import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/lightbox-raw-browser";
await mkdir(output, { recursive: true });
const url = process.env.LIGHTBOX_RAW_TEST_URL || "http://127.0.0.1:1482/lightbox-controls-preview.html";
const server = process.env.LIGHTBOX_RAW_TEST_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1482", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", (data) => { serverLog += data; }); server?.stderr.on("data", (data) => { serverLog += data; });
const errors = [];
const report = { complete: false, scope: "Production Photo Lightbox source selection and exact-version controls using synthetic RAW-named image payloads. No real RAW decoding, user photos or Google API access.", checks: [] };
const root = "D:\\Controller photos";
const tree = (page) => page.getByRole("tree", { name: "Original photo folders", exact: true });
async function pageWith(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000); page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((values) => Object.assign(window, { __controlsRawFixture: true, ...values }), options);
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await tree(page).getByText(options.__controlsLazyMetadata ? "Event" : options.__controlsPairedCrop ? "capture{Like oo}.CR3" : "01-horse.CR3", { exact: true }).waitFor();
  if(options.__controlsLazyMetadata)await tree(page).getByText("Elsewhere",{exact:true}).click();
  return page;
}
async function displayed(page, label, suffix) {
  await page.waitForFunction(async ({ label, suffix }) => {
    const node = [...document.querySelectorAll(".review-images img")].find((image) => image.alt === label);
    if (!node?.complete || !node.naturalWidth) return false;
    const data = new Uint8Array(await (await fetch(node.src)).arrayBuffer());
    let text = ""; for (const byte of data) text += String.fromCharCode(byte);
    return window.__controlsPayloads.get(btoa(text))?.path.endsWith(suffix);
  }, { label, suffix });
}
async function ready(page, label, suffix) {
  await displayed(page, label, suffix);
  await page.waitForFunction((label) => { const input = document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`); return input && !input.disabled; }, label);
}
async function hotkey(page, key) { await page.locator('[aria-label="Photo Lightbox review"]').focus(); await page.keyboard.press(key); }
async function saved(page, count) { await page.waitForFunction((count) => window.__controlsSelectionWrites.length === count, count); await page.waitForFunction(() => !document.body.textContent.includes("Saving selections…")); }
try {
  if (server) {
    let started = false;
    for (let attempt = 0; attempt < 80; attempt++) { if (server.exitCode !== null) throw new Error(`Fixture exited: ${serverLog}`); try { if ((await fetch(url)).ok) { started = true; break; } } catch { /* Starting. */ } await delay(250); }
    assert.ok(started, `Fixture failed to start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const pairedCrop = await pageWith({ __controlsPairedCrop:true, __controlsManagedController:true });
  await tree(pairedCrop).getByText("capture{Like oo}.CR3", {exact:true}).click();
  await pairedCrop.getByRole("combobox",{name:"Original source",exact:true}).selectOption("raw");
  await ready(pairedCrop,"Original RAW","capture{Like oo}.CR3");
  assert.equal(await pairedCrop.getByRole("button",{name:"Crop",exact:true}).isDisabled(),true);
  await hotkey(pairedCrop,"c");
  assert.equal(await pairedCrop.getByRole("dialog",{name:"Crop photo"}).count(),0,"RAW embedded preview cannot be cropped");
  await pairedCrop.getByRole("combobox",{name:"Original source",exact:true}).selectOption("cameraJpeg");
  await ready(pairedCrop,"Camera JPEG","camera-full.JPG");
  assert.equal(await pairedCrop.getByRole("button",{name:"Crop",exact:true}).isEnabled(),true,"Explicit full Camera JPEG must be editable despite RAW navigation identity");
  await pairedCrop.waitForFunction(()=>window.__controllerSurface?.keys[3]?.enabled);
  await pairedCrop.evaluate(()=>window.__controlsNativeInput({kind:"side",index:2}));
  await pairedCrop.waitForFunction(()=>window.__controllerSurface?.title==="Lightbox · inspect"&&window.__controllerSurface.keys.some(key=>key.label==="CROP"&&key.enabled));
  await pairedCrop.getByRole("button",{name:"Crop",exact:true}).click();
  const crop=pairedCrop.getByRole("dialog",{name:"Crop photo"});
  await crop.getByRole("img",{name:"Uncropped original for crop selection"}).waitFor();
  assert.equal(await pairedCrop.evaluate(()=>window.__controlsCalls.filter(call=>call.command==="lightbox_crop_info").at(-1).args.path),"camera-full.JPG");
  await crop.getByRole("button",{name:/Apply crop/}).click();
  await crop.waitFor({state:"detached"});
  await ready(pairedCrop,"Cropped","camera-full_crop.jpg");
  await displayed(pairedCrop,"B&W","camera-full_crop_BW.jpg");await displayed(pairedCrop,"Enhanced","camera-full_crop_improved.jpg");
  await pairedCrop.getByText("1 / 2",{exact:true}).waitFor();
  const pairedRequest=await pairedCrop.evaluate(()=>window.__controlsCropWrites[0]);
  assert.equal(pairedRequest.path,"camera-full.JPG");assert.equal(pairedRequest.sourceFingerprint,`${root}:camera-full.JPG`);
  assert.equal(pairedRequest.regenerateBw,true);assert.equal(pairedRequest.regenerateEnhanced,true);
  for(const hidden of ["camera-full.JPG","camera-full_crop.jpg","raw-developed.jpg"])assert.equal(await tree(pairedCrop).getByText(hidden,{exact:true}).count(),0);
  assert.equal(await tree(pairedCrop).getByText("capture{Like oo}.CR3",{exact:true}).count(),1);
  await pairedCrop.getByRole("combobox",{name:"Original source",exact:true}).selectOption("raw");
  await ready(pairedCrop,"Original RAW","capture{Like oo}.CR3");await displayed(pairedCrop,"Developed RAW","raw-developed.jpg");
  assert.equal(await pairedCrop.getByRole("button",{name:"Crop",exact:true}).isDisabled(),true);
  assert.equal(await pairedCrop.evaluate(()=>window.__controlsRenames.length),0);
  report.checks.push("Paired RAW capture crops only its explicitly selected full Camera JPEG; RAW preview stays ineligible, exact source fingerprint is retained, JPEG crop variants stay grouped, and RAW navigation/ratings/development are preserved");
  await pairedCrop.close();
  const page = await pageWith();
  for (const hidden of ["01-horse.JPG", "01-horse_BW.jpg", "01-horse_improved.jpg", "01-owned-colour.jpg", "01-owned-bw.jpg", "01-retired.jpg"]) assert.equal(await tree(page).getByText(hidden, { exact: true }).count(), 0);
  await tree(page).getByText("01-horse.CR3", { exact: true }).click();
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("raw");
  await ready(page, "Original RAW", "01-horse.CR3"); await displayed(page, "Developed RAW", "01-owned-colour.jpg"); await displayed(page, "B&W", "01-owned-bw.jpg");
  await page.getByText("1 / 2", { exact: true }).waitFor();
  await page.getByText(/Camera preview — not full RAW development.*900 × 600 displayed pixels.*Embedded camera image 6000 × 4000/).waitFor();
  assert.equal(await page.getByRole("img", { name: "Original RAW", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), false);
  assert.equal(await page.getByRole("img", { name: "Developed RAW", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), true);
  assert.equal(await page.getByRole("button", { name: "Crop", exact: true }).isDisabled(), true);
  report.checks.push("A native-identified RAW+JPEG pair is one navigation entry; explicitly owned outputs and retired generations stay out of the tree, with distinct display/embedded-camera dimensions and paired RAW crop disabled");

  await hotkey(page, "q"); await saved(page, 1);
  let write = await page.evaluate(() => window.__controlsSelectionWrites.at(-1));
  assert.equal(write.relativePath, "01-horse.CR3"); assert.equal(write.assetId, `${root}|01-horse.cr3`); assert.equal(write.selected, true);
  await hotkey(page, "Shift+q"); await saved(page, 2);
  write = await page.evaluate(() => window.__controlsSelectionWrites.at(-1)); assert.equal(write.relativePath, "01-horse.CR3"); assert.equal(write.favourite, true);
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg");
  await ready(page, "Camera JPEG", "01-horse.JPG"); await displayed(page, "Enhanced", "01-horse_improved.jpg"); await displayed(page, "B&W", "01-horse_BW.jpg");
  assert.equal(await page.getByRole("img", { name: "Camera JPEG", exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), true);
  assert.equal(await page.getByRole("checkbox", { name: "Upload Camera JPEG to Google Photos", exact: true }).isChecked(), false);
  await hotkey(page, "q"); await saved(page, 3);
  write = await page.evaluate(() => window.__controlsSelectionWrites.at(-1)); assert.equal(write.relativePath, "01-horse.JPG"); assert.equal(write.assetId, `${root}|01-horse.jpg`);
  await hotkey(page, "e"); await saved(page, 4);
  assert.equal(await page.evaluate(() => window.__controlsSelectionWrites.at(-1).relativePath), "01-horse_improved.jpg");
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("raw"); await ready(page, "Original RAW", "01-horse.CR3");
  assert.equal(await page.getByRole("checkbox", { name: "Upload Original RAW to Google Photos", exact: true }).isChecked(), true);
  await hotkey(page, "e"); await saved(page, 5);
  assert.equal(await page.evaluate(() => window.__controlsSelectionWrites.at(-1).relativePath), "01-owned-colour.jpg");
  report.checks.push("Q / Shift+Q target exact RAW or camera-JPEG originals independently; changing source switches its own comparison family, and E targets the shown JPEG enhancement or explicitly developed RAW file");

  const advancing = await pageWith();
  await tree(advancing).getByText("01-horse.CR3", { exact: true }).click(); await ready(advancing, "Camera JPEG", "01-horse.JPG");
  await advancing.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg"); await ready(advancing, "Camera JPEG", "01-horse.JPG");
  await hotkey(advancing, "g"); await ready(advancing, "Original", "02-rider.jpg");
  assert.equal(await advancing.evaluate(() => window.__controlsSelectionWrites.at(-1).relativePath), "01-horse.JPG");
  await advancing.getByText("2 / 2", { exact: true }).waitFor(); await advancing.close();
  report.checks.push("Controller Select and next (G) persists the displayed camera-JPEG source and advances through canonical original captures without visiting hidden derivatives");

  await page.evaluate(() => { window.__controlsDeferSelection = true; });
  await hotkey(page, "q"); await page.waitForFunction(() => typeof window.__controlsReleaseSelection === "function");
  assert.equal(await page.getByRole("combobox", { name: "Original source", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.__controlsDeferSelection = false; window.__controlsReleaseSelection(); }); await saved(page, 6);
  await page.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg"); await ready(page, "Camera JPEG", "01-horse.JPG");
  await hotkey(page, "1");
  await tree(page).getByText("01-horse.CR3", { exact: true }).waitFor(); await ready(page, "Camera JPEG", "01-horse{Like o}.JPG");
  assert.equal(await page.evaluate(() => window.__controlsRenames.at(-1).oldPath), `${root}/01-horse.JPG`);
  assert.equal(await tree(page).getByText("01-horse.JPG", { exact: true }).count(), 0);
  report.checks.push("Source changes wait for pending persistence; ratings preserve the verified Camera JPEG review anchor while RAW navigation and exact JPEG source remain grouped");

  const stale = await pageWith({ __controlsDeferImage: "01-horse.JPG" });
  await tree(stale).getByText("01-horse.CR3", { exact: true }).click();
  await stale.getByRole("combobox", { name: "Original source", exact: true }).selectOption("raw");
  await ready(stale, "Original RAW", "01-horse.CR3");
  await stale.getByRole("combobox", { name: "Original source", exact: true }).selectOption("cameraJpeg");
  await stale.waitForFunction(() => typeof window.__controlsReleaseImage === "function");
  await hotkey(stale, "q"); assert.equal(await stale.evaluate(() => window.__controlsSelectionWrites.length), 0);
  await hotkey(stale, "ArrowRight"); await ready(stale, "Original", "02-rider.jpg");
  await stale.evaluate(() => { window.__controlsDeferImage = null; window.__controlsReleaseImage(); });
  await displayed(stale, "Original", "02-rider.jpg");
  assert.equal(await stale.getByRole("combobox", { name: "Original source", exact: true }).count(), 0);
  await delay(100); await displayed(stale, "Original", "02-rider.jpg");
  report.checks.push("An incomplete source change cannot write a selection; navigating away invalidates its epoch and a late camera-JPEG read cannot replace the newer visible original");

  const lazy = await pageWith({__controlsLazyMetadata:true,__controlsDeferMetadata:true});
  assert.equal(await lazy.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder"||c.command==="google_photos_catalogue").length),0);
  await tree(lazy).getByText("Event",{exact:true}).click();
  await tree(lazy).getByText("Event",{exact:true}).click();
  await tree(lazy).getByText("01-horse.JPG",{exact:true}).click();
  await lazy.waitForFunction(()=>typeof window.__controlsReleaseMetadata==="function");
  await hotkey(lazy,"q");
  assert.equal(await lazy.evaluate(()=>window.__controlsSelectionWrites.length),0);
  assert.equal(await lazy.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").length),1);
  await lazy.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});
  await ready(lazy,"Camera JPEG","Event/01-horse.JPG");
  await hotkey(lazy,"q");await saved(lazy,1);
  assert.equal(await lazy.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"Event/01-horse.JPG");
  assert.ok(await lazy.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="google_photos_catalogue").every(c=>c.args.relativePath?.startsWith("Event/"))));
  assert.ok(await lazy.evaluate(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").every(c=>c.args.relativeDir==="Event")));
  report.checks.push("First list requires no capture metadata or Google catalogue scan; opening a folder coalesces metadata reads, scopes curation to that folder, and a JPEG clicked before pairing remains the exact selected physical upload");

  await lazy.evaluate(()=>{window.__controlsDeferTree=true;});
  await lazy.getByRole("button",{name:"Refresh photos",exact:true}).click();
  await lazy.waitForFunction(()=>typeof window.__controlsReleaseTree==="function");
  await tree(lazy).getByText("01-horse.CR3",{exact:true}).click();
  await ready(lazy,"Camera JPEG","Event/01-horse.JPG");
  await lazy.evaluate(()=>{window.__controlsDeferMetadata=true;window.__controlsDeferTree=false;window.__controlsReleaseTree();});
  await lazy.waitForFunction(()=>window.__controlsCalls.filter(c=>c.command==="read_lightbox_folder").length===2);
  await displayed(lazy,"Original","Event/01-horse.JPG");
  assert.equal(await lazy.getByRole("checkbox",{name:"Upload Original to Google Photos",exact:true}).isDisabled(),true);
  await hotkey(lazy,"q");assert.equal(await lazy.evaluate(()=>window.__controlsSelectionWrites.length),1);
  await lazy.evaluate(()=>{window.__controlsDeferMetadata=false;window.__controlsReleaseMetadata();});
  await ready(lazy,"Camera JPEG","Event/01-horse.JPG");await hotkey(lazy,"q");await saved(lazy,2);
  assert.equal(await lazy.evaluate(()=>window.__controlsSelectionWrites.at(-1).relativePath),"Event/01-horse.JPG");
  report.checks.push("A generic refresh overtaken by a newer camera-JPEG pick keeps its exact JPEG preview but pauses decisions during temporary catalogue replacement; shortcuts wait for verified identity");
  await lazy.close();

  const retry=await pageWith({__controlsLazyMetadata:true,__controlsMetadataIncomplete:true});
  await tree(retry).getByText("Event",{exact:true}).click();
  await tree(retry).getByText("Event",{exact:true}).click();
  await tree(retry).getByText("01-horse.JPG",{exact:true}).click();await displayed(retry,"Original","Event/01-horse.JPG");
  assert.equal(await retry.getByRole("checkbox",{name:"Upload Original to Google Photos",exact:true}).isDisabled(),true);
  await retry.evaluate(()=>{window.__controlsMetadataIncomplete=false;});
  await tree(retry).getByText("Event",{exact:true}).click();await tree(retry).getByText("Event",{exact:true}).click();
  await ready(retry,"Camera JPEG","Event/01-horse.JPG");await hotkey(retry,"q");await saved(retry,1);
  assert.equal(await retry.evaluate(()=>window.__controlsSelectionWrites[0].relativePath),"Event/01-horse.JPG");
  report.checks.push("Successful metadata retry reconciles a formerly standalone JPEG into its RAW capture while preserving the displayed JPEG and exact upload target");
  await retry.close();
  await page.screenshot({ path: `${output}/paired-source.png`, fullPage: true });
  await page.close(); await stale.close(); assert.deepEqual(errors, []); report.complete = true;
} catch (error) { report.error = error.stack || String(error); throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); server?.kill(); }
console.log(`RAW Lightbox: ${report.checks.length} browser groups passed`);
