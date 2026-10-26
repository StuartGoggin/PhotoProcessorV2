import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the actual Review page with deterministic in-memory native replies.
// This never opens user media, touches native files or contacts Google Photos.
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/lightbox-controls-browser";
await mkdir(output, { recursive: true });
const url = process.env.LIGHTBOX_CONTROLS_TEST_URL || "http://127.0.0.1:1477/lightbox-controls-preview.html";
const server = process.env.LIGHTBOX_CONTROLS_TEST_URL ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1477", "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", data => { serverLog += data; });
server?.stderr.on("data", data => { serverLog += data; });
const pageErrors = [];
const report = { complete: false, scope: "Real React Lightbox keyboard, dialog, controller reference and save acknowledgement workflow with synthetic JPEG IPC. No physical AKP03E, native media or Google account operations.", checks: [] };
let check = "starting";
const rootPath = "D:\\Controller photos";
const checkbox = (page, label = "Original") => page.getByRole("checkbox", { name: `Upload ${label} to Google Photos`, exact: true });
const tree = page => page.getByRole("tree", { name: "Original photo folders" });
const original = page => page.getByRole("img", { name: "Original", exact: true });
async function count(page, key) { return page.evaluate(key => window[key].length, key); }
async function newFixture(options = {}, width = 1360) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(initial => Object.assign(window, initial), options);
  await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  await tree(page).getByText("01-horse.jpg", { exact: true }).waitFor();
  return page;
}
async function focusReview(page) { await page.locator('[aria-label="Photo Lightbox review"]').focus(); }
async function expectImage(page, label, suffix, expectedRoot = rootPath) {
  await page.waitForFunction(async ({ label, suffix, expectedRoot }) => {
    const node = [...document.querySelectorAll(".review-images img")].find(node => node.alt === label);
    if (!node || !node.complete || !node.naturalWidth) return false;
    try {
      const bytes = new Uint8Array(await (await fetch(node.src)).arrayBuffer());
      let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
      const payload = window.__controlsPayloads.get(btoa(binary));
      return payload?.root === expectedRoot && payload.path.endsWith(suffix);
    } catch { return false; }
  }, { label, suffix, expectedRoot });
}
async function ready(page, suffix = "01-horse.jpg", label = "Original", expectedRoot = rootPath) {
  await expectImage(page, label, suffix, expectedRoot);
  await page.waitForFunction(label => {
    const input = document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`);
    return input && !input.disabled;
  }, label);
}
async function select(page, name = "01-horse.jpg") {
  await tree(page).getByText(name, { exact: true }).click();
  await ready(page, name);
}
async function waitWrites(page, key, expected) {
  await page.waitForFunction(({ key, expected }) => window[key].length === expected, { key, expected });
}
async function flags(page, suffix, root = rootPath) {
  return page.evaluate(({ suffix, root }) => {
    const entries = [...window.__controlsLibraries.get(root).flags.entries()];
    return entries.find(([id]) => id.endsWith(suffix.toLowerCase()))?.[1] ?? { selected:false, favourite:false };
  }, { suffix, root });
}
async function expectChecked(page, label, value) {
  await page.waitForFunction(({ label, value }) => {
    const input = document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`);
    return input && !input.disabled && input.checked === value;
  }, { label, value });
}
async function group(name, test) {
  check = name; await test(); report.checks.push(name); console.log(`PASS ${name}`);
}

try {
  if (server) {
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw Error(`Fixture server exited: ${serverLog}`);
      try { if ((await fetch(url)).ok) { started = true; break; } } catch { /* server starting */ }
      await delay(200);
    }
    assert.ok(started, `Fixture server did not start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });

  await group("24px checkboxes and 44px label, favourite and rating targets; exact-version flags merge independently", async () => {
    const page = await newFixture(); await select(page);
    const dimensions = await checkbox(page).evaluate(input => ({ checkbox:input.getBoundingClientRect().toJSON(), label:input.closest("label").getBoundingClientRect().toJSON() }));
    assert.ok(dimensions.checkbox.width >= 24 && dimensions.checkbox.height >= 24);
    assert.ok(dimensions.label.height >= 44);
    const favourite = await page.getByRole("button", { name:"Favourite Original", exact:true }).boundingBox();
    const rating = await page.getByRole("button", { name:"2 stars", exact:true }).boundingBox();
    assert.ok(favourite.width >= 44 && favourite.height >= 44); assert.ok(rating.width >= 44 && rating.height >= 44);
    await page.keyboard.press("q"); await expectChecked(page,"Original",true);
    await page.keyboard.press("Shift+Q");
    await page.waitForFunction(() => document.querySelector('button[aria-label="Favourite Original"]')?.getAttribute("aria-pressed") === "true");
    assert.deepEqual(await flags(page,"01-horse.jpg"),{selected:true,favourite:true});
    await page.keyboard.press("w"); await expectChecked(page,"B&W",true);
    await page.keyboard.press("e"); await expectChecked(page,"Enhanced",true);
    assert.deepEqual(await flags(page,"01-horse_bw.jpg"),{selected:true,favourite:false});
    assert.deepEqual(await flags(page,"01-horse_improved.jpg"),{selected:true,favourite:false});
    const writes=await count(page,"__controlsSelectionWrites");
    await checkbox(page).focus(); await page.keyboard.press("Space"); await expectChecked(page,"Original",false);
    assert.equal(await count(page,"__controlsSelectionWrites"),writes+1,"Space uses the native checkbox exactly once");
    await page.screenshot({ path:`${output}/lightbox-1360.png`,fullPage:true });
    await page.close();
  });

  await group("Held toggles run once; repeated navigation may continue; same rating is an idempotent keyboard command", async () => {
    const page=await newFixture(); await select(page);
    await page.keyboard.down("q"); await expectChecked(page,"Original",true);
    await page.keyboard.down("q"); await page.keyboard.up("q"); await delay(80);
    assert.equal(await count(page,"__controlsSelectionWrites"),1);
    await page.keyboard.press("2"); await ready(page,"01-horse{Like oo}.jpg");
    const renames=await count(page,"__controlsRenames"); await page.keyboard.press("2"); await delay(80);
    assert.equal(await count(page,"__controlsRenames"),renames,"Setting the same rating does not clear it");
    await page.keyboard.press("Backspace"); await ready(page); assert.equal(await count(page,"__controlsRenames"),renames+1);
    await page.keyboard.down("ArrowRight"); await ready(page,"02-rider.jpg");
    await page.keyboard.down("ArrowRight"); await page.keyboard.up("ArrowRight"); await ready(page,"03-wide.jpg");
    await page.close();
  });

  await group("Shift+number saves before advancing and blocks competing decisions while native rename is pending", async () => {
    const page=await newFixture(); await select(page); await page.evaluate(()=>window.__controlsDeferRename=true);
    await page.keyboard.press("Shift+1"); await waitWrites(page,"__controlsRenames",1);
    await expectImage(page,"Original","01-horse.jpg");
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("q"); await page.keyboard.press("x");
    assert.equal(await count(page,"__controlsRenames"),1); assert.equal(await count(page,"__controlsSelectionWrites"),0);
    await page.evaluate(()=>{window.__controlsDeferRename=false;window.__controlsReleaseRename();});
    await ready(page,"02-rider.jpg");
    const saved=await page.evaluate(()=>window.__controlsRenames[0]); assert.equal(saved.newName,"01-horse{Like o}.jpg");
    await page.close();
  });

  await group("Rename failure and a real destination collision keep the current photo and preserve both fixture files", async () => {
    const page=await newFixture({__controlsRenameError:"Synthetic rename failure"}); await select(page);
    await page.keyboard.press("Shift+3"); await page.getByText(/Could not save this photo decision:.*Synthetic rename failure/).waitFor();
    await ready(page); assert.equal(await count(page,"__controlsRenames"),1); await page.close();
    const collision=await newFixture({__controlsCollision:true}); await select(collision);
    await collision.keyboard.press("Shift+1"); await collision.getByText(/Destination already exists; source and destination preserved/).waitFor();
    await expectImage(collision,"Original","01-horse.jpg");
    const names=await collision.evaluate(()=>window.__controlsLibraries.get("D:\\Controller photos").tree.children.map(node=>node.name));
    assert.ok(names.includes("01-horse.jpg")&&names.includes("01-horse{Like o}.jpg")); await collision.close();
  });

  await group("Select+next waits for acknowledged selection; a rejected selection never advances", async () => {
    const page=await newFixture(); await select(page); await page.evaluate(()=>window.__controlsDeferSelection=true);
    await page.keyboard.press("g"); await waitWrites(page,"__controlsSelectionWrites",1); await expectImage(page,"Original","01-horse.jpg");
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("g"); assert.equal(await count(page,"__controlsSelectionWrites"),1);
    await page.evaluate(()=>{window.__controlsDeferSelection=false;window.__controlsReleaseSelection();}); await ready(page,"02-rider.jpg");
    assert.deepEqual(await flags(page,"01-horse.jpg"),{selected:true,favourite:false}); await page.close();
    const fail=await newFixture({__controlsSelectionError:"Synthetic selection failure"}); await select(fail);
    await fail.keyboard.press("g"); await fail.getByText(/Synthetic selection failure/).first().waitFor(); await expectImage(fail,"Original","01-horse.jpg");
    assert.equal(await count(fail,"__controlsSelectionWrites"),1); await fail.close();
  });

  await group("Data shortcuts wait for actual display readiness and rapid navigation targets the latest selected photo", async () => {
    const page=await newFixture({__controlsDeferImage:"01-horse.jpg"});
    await tree(page).getByText("01-horse.jpg",{exact:true}).click(); await focusReview(page);
    await page.keyboard.press("1"); await page.keyboard.press("q");
    assert.equal(await count(page,"__controlsRenames"),0); assert.equal(await count(page,"__controlsSelectionWrites"),0);
    await page.waitForFunction(()=>typeof window.__controlsReleaseImage==="function");
    await page.evaluate(()=>{window.__controlsDeferImage=null;window.__controlsReleaseImage();}); await ready(page);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
    await ready(page,"02-rider.jpg"); await page.keyboard.press("q"); await expectChecked(page,"Original",true);
    assert.deepEqual(await flags(page,"02-rider.jpg"),{selected:true,favourite:false});
    assert.deepEqual(await flags(page,"03-wide.jpg"),{selected:false,favourite:false}); await page.close();
  });

  await group("Missing versions are never substituted; active-panel cycling skips unavailable panels", async () => {
    const page=await newFixture(); await select(page,"03-wide.jpg");
    const before=await count(page,"__controlsSelectionWrites"); await page.keyboard.press("w");
    await page.getByText("That version is unavailable for this photo.",{exact:true}).waitFor();
    assert.equal(await count(page,"__controlsSelectionWrites"),before); assert.equal(await checkbox(page,"B&W").count(),0);
    await page.keyboard.press("]");
    assert.equal(await page.getByRole("group",{name:"Original image panel",exact:true}).getAttribute("data-active"),"true");
    await page.keyboard.press("a"); await expectChecked(page,"Original",true); await page.close();
  });

  await group("Original/cropped view targets independent exact-version selections; panel focus and fit reset work", async () => {
    const page=await newFixture(); await select(page); await page.keyboard.press("v"); await ready(page,"01-horse_crop.jpg","Cropped");
    await page.keyboard.press("q"); await expectChecked(page,"Cropped",true);
    await page.keyboard.press("w"); await expectChecked(page,"Cropped B&W",true);
    assert.deepEqual(await flags(page,"01-horse.jpg"),{selected:false,favourite:false});
    assert.deepEqual(await flags(page,"01-horse_crop.jpg"),{selected:true,favourite:false});
    await page.keyboard.press("]");
    assert.equal(await page.getByRole("group",{name:"Enhanced image panel",exact:true}).getAttribute("data-active"),"true");
    await page.keyboard.press("[");
    assert.equal(await page.getByRole("group",{name:"B&W image panel",exact:true}).getAttribute("data-active"),"true");
    await page.keyboard.press("+"); await page.keyboard.press("Shift+ArrowRight");
    const before=await page.getByRole("img",{name:"B&W",exact:true}).getAttribute("style"); assert.match(before,/38\.4px/);
    const other=await page.getByRole("img",{name:"Cropped",exact:true}).getAttribute("style"); assert.match(other,/translate\(0px, 0px\)/);
    await page.keyboard.press("0");
    const reset=await page.getByRole("img",{name:"B&W",exact:true}).getAttribute("style"); assert.match(reset,/scale\(1\) translate\(0px, 0px\)/);
    await page.keyboard.press("v"); await ready(page); await expectChecked(page,"Original",false); await page.close();
  });

  await group("Typing and native menu controls keep their keys; tree arrows move focus without selecting", async () => {
    const page=await newFixture(); await select(page);
    await page.evaluate(()=>{const input=document.createElement("input");input.id="typing-test";input.setAttribute("aria-label","Typing test");document.querySelector('[aria-label="Photo Lightbox review"]').append(input);});
    const input=page.getByRole("textbox",{name:"Typing test"}); await input.fill("draft");
    for(const key of ["q","1","Delete","Backspace","ArrowRight","Home","End"])await input.press(key);
    await page.evaluate(()=>{for(const [tag,id]of [["textarea","textarea-test"],["div","editable-test"],["select","select-test"]]){const node=document.createElement(tag);node.id=id;if(tag==="div")node.contentEditable="true";if(tag==="select")node.innerHTML='<option>Original</option><option>B&W</option>';document.querySelector('[aria-label="Photo Lightbox review"]').append(node);}});
    for(const id of ["textarea-test","editable-test","select-test"]){await page.locator(`#${id}`).focus();for(const key of ["q","1","Delete","ArrowRight"])await page.keyboard.press(key);}
    assert.equal(await count(page,"__controlsRenames"),0);assert.equal(await count(page,"__controlsSelectionWrites"),0);await expectImage(page,"Original","01-horse.jpg");
    const horse=tree(page).getByRole("treeitem").filter({has:page.getByText("01-horse.jpg",{exact:true})});
    await horse.focus(); await page.keyboard.press("ArrowDown");
    await expectImage(page,"Original","01-horse.jpg"); assert.match(await page.evaluate(()=>document.activeElement.textContent),/02-rider.jpg/);
    await page.keyboard.press("Enter"); await ready(page,"02-rider.jpg");
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute("aria-label")),"Photo Lightbox review");
    await tree(page).getByRole("treeitem").filter({has:page.getByText("Event",{exact:true})}).focus(); await page.keyboard.press("ArrowLeft");
    assert.equal(await tree(page).getByText("04-finish.jpg",{exact:true}).count(),0);
    await page.keyboard.press("ArrowRight"); assert.equal(await tree(page).getByText("04-finish.jpg",{exact:true}).count(),1);
    await page.close();
  });

  await group("Help is registry-driven, traps focus, suspends review keys and restores focus; controller pack matches bindings", async () => {
    const page=await newFixture(); await select(page); await page.getByRole("button",{name:"Keyboard and controller help"}).focus(); await page.keyboard.press("F1");
    const help=page.getByRole("dialog",{name:"Keyboard & Controller Help"}); await help.waitFor();
    await page.keyboard.press("1");await page.keyboard.press("q");await page.keyboard.press("Delete");
    assert.equal(await count(page,"__controlsRenames"),0);assert.equal(await count(page,"__controlsSelectionWrites"),0);
    await help.getByRole("searchbox",{name:"Find a command or shortcut"}).fill("save and next");
    await help.getByText("Set one star, save and next",{exact:true}).waitFor();
    await help.getByRole("button",{name:"Close help"}).focus(); await page.keyboard.press("Shift+Tab");
    assert.ok(await help.evaluate(node=>node.contains(document.activeElement)),"Tab remains in help");
    await help.getByRole("button",{name:"AJAZZ AKP03E",exact:true}).click(); assert.equal(await help.locator('img[src^="/controller/ajazz-akp03e/"]').count(),6);
    const reference=await (await fetch(new URL("/controller/ajazz-akp03e/reference-keymap.json",url))).json();
    const commands=await page.evaluate(()=>window.__controlsCommandReference);assert.deepEqual(reference.commands,commands);assert.equal(reference.vendorImportProfile,false);
    for(const button of reference.buttons){const response=await fetch(new URL(`/controller/ajazz-akp03e/${button.icon}`,url));assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>1000);}
    await page.screenshot({path:`${output}/controller-help-1360.png`,fullPage:true});
    await page.keyboard.press("Escape"); await help.waitFor({state:"detached"});
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute("aria-label")),"Keyboard and controller help");await page.close();
  });

  await group("Crop owns its keyboard scope; normal Enter cannot apply; source-pixel nudges and deliberate Ctrl+Enter apply once", async () => {
    const page=await newFixture();await select(page);await page.keyboard.press("c");
    const crop=page.getByRole("dialog",{name:"Crop photo"});await crop.getByRole("img",{name:"Uncropped original for crop selection"}).waitFor();
    await crop.getByRole("button",{name:/Apply crop & regenerate/}).waitFor();
    await page.keyboard.press("1");await page.keyboard.press("Delete");await page.keyboard.press("Enter");
    assert.equal(await count(page,"__controlsRenames"),0);assert.equal(await count(page,"__controlsCropWrites"),0);
    const bw=crop.getByRole("checkbox",{name:/B&W crop version/});assert.equal(await bw.isChecked(),true);
    await page.keyboard.press("q");assert.equal(await bw.isChecked(),false);
    await bw.focus();await page.keyboard.press("Enter");assert.equal(await count(page,"__controlsCropWrites"),0);
    await page.keyboard.press("Space");assert.equal(await bw.isChecked(),true);
    const handle=crop.getByRole("button",{name:"Crop top-left corner",exact:true});await handle.focus();
    await page.keyboard.press("ArrowRight");await page.keyboard.press("Shift+ArrowDown");
    const dimensions=await crop.getByTestId("crop-output-dimensions").textContent();assert.match(dimensions,/899 × 590/);
    await crop.focus();await page.keyboard.press("r");assert.match(await crop.getByTestId("crop-output-dimensions").textContent(),/900 × 600/);
    await page.keyboard.press("F1");assert.equal(await page.getByTestId("lightbox-help").count(),0);assert.equal(await crop.locator("details").last().getAttribute("open"),"");
    await page.evaluate(()=>window.__controlsDeferCrop=true);await page.keyboard.press("Control+Enter");await waitWrites(page,"__controlsCropWrites",1);
    await page.keyboard.press("Control+Enter");await page.keyboard.press("Escape");assert.equal(await crop.count(),1);assert.equal(await count(page,"__controlsCropWrites"),1);
    await page.evaluate(()=>{window.__controlsDeferCrop=false;window.__controlsReleaseCrop();});await crop.waitFor({state:"detached"});
    const request=await page.evaluate(()=>window.__controlsCropWrites[0]);assert.equal(request.regenerateBw,true);assert.equal(request.regenerateEnhanced,true);assert.deepEqual(request.crop,{x:0,y:0,width:1,height:1});
    await page.close();
  });

  await group("Old-root pending saves cannot select, advance or flag a newly opened staging root", async () => {
    const page=await newFixture();await select(page);await page.evaluate(()=>window.__controlsDeferSelection=true);await page.keyboard.press("g");await waitWrites(page,"__controlsSelectionWrites",1);
    await page.evaluate(()=>window.__controlsSwitchRoot("E:\\Another shoot"));await tree(page).getByText("01-horse.jpg",{exact:true}).waitFor();
    await tree(page).getByText("01-horse.jpg",{exact:true}).click();await expectImage(page,"Original","01-horse.jpg","E:\\Another shoot");
    await page.evaluate(()=>{window.__controlsDeferSelection=false;window.__controlsReleaseSelection();});await delay(120);
    await expectImage(page,"Original","01-horse.jpg","E:\\Another shoot");assert.deepEqual(await flags(page,"01-horse.jpg","E:\\Another shoot"),{selected:false,favourite:false});
    assert.deepEqual(await flags(page,"01-horse.jpg"),{selected:true,favourite:false});await page.close();
    const rename=await newFixture();await select(rename);await rename.evaluate(()=>window.__controlsDeferRename=true);await rename.keyboard.press("Shift+2");await waitWrites(rename,"__controlsRenames",1);
    await rename.evaluate(()=>window.__controlsSwitchRoot("E:\\Another shoot"));await tree(rename).getByText("01-horse.jpg",{exact:true}).waitFor();
    await tree(rename).getByText("01-horse.jpg",{exact:true}).click();await ready(rename,"01-horse.jpg","Original","E:\\Another shoot");
    await rename.evaluate(()=>{window.__controlsDeferRename=false;window.__controlsReleaseRename();});await delay(120);
    await expectImage(rename,"Original","01-horse.jpg","E:\\Another shoot");
    const names=await rename.evaluate(()=>Object.fromEntries([...window.__controlsLibraries.entries()].map(([root,lib])=>[root,lib.tree.children.map(node=>node.name)])));
    assert.ok(names[rootPath].includes("01-horse{Like oo}.jpg"));assert.ok(names["E:\\Another shoot"].includes("01-horse.jpg"));await rename.close();
  });

  await group("A pending refresh retains the newest navigation; folder edges and trash+next stay within the selected folder", async () => {
    const page=await newFixture();await select(page);await page.evaluate(()=>window.__controlsDeferTree=true);await page.keyboard.press("r");
    await page.waitForFunction(()=>typeof window.__controlsReleaseTree==="function");await page.keyboard.press("ArrowRight");await ready(page,"02-rider.jpg");
    await page.evaluate(()=>{window.__controlsDeferTree=false;window.__controlsReleaseTree();});await ready(page,"02-rider.jpg");
    await page.keyboard.press("End");await ready(page,"03-wide.jpg");await page.keyboard.press("Home");await ready(page);
    await page.keyboard.press("x");await ready(page,"02-rider.jpg");
    const calls=await page.evaluate(()=>window.__controlsRenames);assert.equal(calls.at(-1).newName,"01-horse{trash}.jpg");
    await tree(page).getByText("04-finish.jpg",{exact:true}).click();await ready(page,"04-finish.jpg");
    await page.keyboard.press("x");await ready(page,"04-finish{trash}.jpg");
    assert.equal(await page.getByRole("button",{name:"Next original photo",exact:true}).isDisabled(),true);await page.close();
  });

  await group("720px review and help remain usable with bounded horizontal layout and large controls", async () => {
    const page=await newFixture({},720);await select(page);
    const overflow=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));
    await page.screenshot({path:`${output}/lightbox-720.png`,fullPage:true});
    await checkbox(page,"Enhanced").scrollIntoViewIfNeeded();await checkbox(page,"Enhanced").check();await expectChecked(page,"Enhanced",true);
    assert.deepEqual(await flags(page,"01-horse_improved.jpg"),{selected:true,favourite:false});
    await page.screenshot({path:`${output}/lightbox-720-lower-panels.png`,fullPage:true});await page.keyboard.press("?");
    const help=page.getByTestId("lightbox-help");await help.waitFor();await help.getByRole("button",{name:"AJAZZ AKP03E",exact:true}).click();
    await page.screenshot({path:`${output}/controller-help-720.png`,fullPage:true});
    assert.ok(await help.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await page.keyboard.press("Escape");await page.close();
  });

  assert.deepEqual(pageErrors,[],"No browser runtime exceptions");
  report.complete=true;report.browserErrors=pageErrors;
} catch(error) {
  report.failedCheck=check;report.error=String(error.stack??error);report.browserErrors=pageErrors;
  if(browser)for(const [index,page]of browser.contexts().flatMap(context=>context.pages()).entries())await page.screenshot({path:`${output}/failure-${index}.png`,fullPage:true}).catch(()=>{});
  console.error(report.error);process.exitCode=1;
} finally {
  await writeFile(`${output}/report.json`,JSON.stringify(report,null,2)+"\n");await browser?.close();server?.kill();
}
