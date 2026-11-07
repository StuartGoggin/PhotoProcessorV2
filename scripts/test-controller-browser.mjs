import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");

const output = new URL("../test-output/controller-browser/", import.meta.url);
await fs.mkdir(output, { recursive: true });
await fs.writeFile(new URL("report.json", output), JSON.stringify({ complete: false, startedAt: new Date().toISOString() }, null, 2));
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5187", "--strictPort"], { cwd: process.cwd(), windowsHide: true, stdio: "pipe" });
let serverLog = ""; server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
const url = "http://127.0.0.1:5187/controller-preview.html";
let browser; const errors = [], checks = [];
const group = async (name, work) => { await work(); checks.push(name); console.log("PASS", name); };
async function page(width = 1360, initial = {}) {
  const result = await browser.newPage({ viewport: { width, height: 1000 } });
  result.on("pageerror", error => errors.push(error.message)); result.setDefaultTimeout(10000);
  await result.addInitScript(value=>Object.assign(window,value),initial);
  await result.goto(url); await result.getByRole("button", { name: "AKP03E controller", exact: true }).click();
  await result.getByRole("dialog", { name: "Your AKP03E controller" }).waitFor();
  await result.waitForFunction(() => window.__controllerState().status.phase === "connected" && window.__controllerState().bindingsReady && window.__controllerFrames.length > 0);
  return result;
}
try {
  for (let attempt = 0; ; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} if (attempt > 80) throw new Error("Controller fixture did not start: " + serverLog); await new Promise(resolve => setTimeout(resolve, 250)); }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  await group("Automatic controller mirror draws six exact 60px JPEGs and exposes all controls with live state", async () => {
    const p = await page();
    assert.equal(await p.locator('[aria-label="Six display buttons"] button').count(), 6);
    assert.equal(await p.locator('[aria-label="Three rotary controls"] button').count(), 9);
    assert.equal(await p.locator('[aria-label="Three side buttons"] button').count(), 3);
    assert.equal(await p.getByRole("button", { name: "Controller key 4: Crop photo" }).isDisabled(), true);
    const images = await p.evaluate(async () => Promise.all(window.__controllerFrames.at(-1).keys.map(key => new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, jpeg: key.imageData.startsWith("data:image/jpeg;base64,") }); image.src = key.imageData; }))));
    assert.ok(images.every(value => value.width === 60 && value.height === 60 && value.jpeg));
    await p.getByRole("button", { name: "Controller key 2: Google select" }).click();
    await p.waitForFunction(() => window.__controllerState().surface.keys[1].active);
    assert.equal(await p.getByRole("button", { name: "Controller key 2: Google select" }).getAttribute("aria-pressed"), "true");
    await p.screenshot({ path: new URL("controller-desktop.png", output).pathname.replace(/^\/([A-Za-z]:\/)/, "$1"), fullPage: true }); await p.close();
  });
  await group("Physical input rejects a stale photo revision and holds a pending save without executing rapid extra input", async () => {
    const p = await page(); const revision = await p.evaluate(() => window.__controllerState().surface.revision);
    await p.evaluate(() => window.__controllerInput({ index: 2 })); await p.getByTestId("fixture-photo").getByText(/Horse 2/).waitFor();
    await p.evaluate(revision => window.__controllerInput({ revision, index: 0 }), revision);
    await p.waitForFunction(() => window.__controllerAcks.at(-1)?.result === "ignored");
    assert.match(await p.getByTestId("fixture-photo").innerText(), /stars 0/);
    await p.evaluate(() => window.__controllerInput({ index: 4 }));
    await p.waitForFunction(() => window.__controllerState().actionBusy);
    await p.evaluate(() => window.__controllerInput({ index: 0 })); await p.waitForFunction(() => window.__controllerAcks.at(-1)?.result === "ignored");
    assert.equal(await p.getByRole("button", { name: "Controller key 1: Three stars" }).isDisabled(), true);
    await p.evaluate(() => window.__finishControllerSave()); await p.waitForFunction(() => !window.__controllerState().actionBusy);
    await p.getByLabel("Last controller input",{exact:true}).getByText("Last control: key 1",{exact:true}).waitFor();
    assert.match(await p.getByTestId("fixture-photo").innerText(), /stars 0/); await p.close();
  });
  await group("Controller dialog suspends underlying shortcuts but retains range and Enter-button defaults", async () => {
    const p = await page(); const close = p.getByRole("button", { name: "Close Esc", exact: true }); await close.focus();
    for (const key of ["Delete", "1", "ArrowLeft", "ArrowRight"]) await p.keyboard.press(key);
    assert.deepEqual(await p.evaluate(() => window.__underlyingKeys), []);
    const range = p.getByRole("slider", { name: "Controller display brightness" }); await range.focus(); await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => window.__controllerCalls.some(call => call.command === "configure" && call.brightness === 65));
    await close.focus(); await p.keyboard.press("Enter"); await p.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await p.getByRole("button", { name: "AKP03E controller", exact: true }).evaluate(element => document.activeElement === element), true);
    await p.close();
  });
  await group("Release is explicit, retains manual restart guidance, and automatic control can be resumed", async () => {
    const p = await page(); await p.getByRole("button", { name: "Release controller", exact: true }).click();
    await p.waitForFunction(() => !window.__controllerState().status.enabled);
    assert.equal(await p.getByRole("checkbox", { name: "Use automatically while PhotoGoGo is running" }).isChecked(), false);
    assert.equal(await p.getByRole("button", { name: "Controller key 1: Three stars" }).isDisabled(), true);
    await p.getByRole("button", { name: "Connect / retry", exact: true }).click();
    await p.waitForFunction(() => window.__controllerState().status.enabled); assert.equal(await p.getByRole("checkbox").isChecked(), true); await p.close();
  });
  await group("Dial drafts restore saved preferences, Cancel preserves them and failed Apply leaves the saved controls intact", async () => {
    const saved={version:1,dials:[{turn:"zoom",press:"next"},{turn:"off",press:"off"},{turn:"browse",press:"fit"}]};
    const p=await page(1360,{__controllerInitialBindings:saved});
    assert.equal(await p.getByLabel("Dial 1 turn action",{exact:true}).inputValue(),"zoom");
    await p.getByLabel("Dial 1 turn action",{exact:true}).selectOption("browse");
    await p.getByRole("button",{name:"Cancel changes",exact:true}).click();
    assert.equal(await p.getByLabel("Dial 1 turn action",{exact:true}).inputValue(),"zoom");
    assert.deepEqual(await p.evaluate(()=>window.__controllerCalls.filter(call=>call.command==="bindings")),[]);
    await p.getByLabel("Dial 1 press action",{exact:true}).selectOption("trash");
    await p.evaluate(()=>window.__controllerFailBindings=true);
    await p.getByRole("button",{name:"Apply dial controls",exact:true}).click();
    await p.getByRole("alert").filter({hasText:"previous saved controls remain unchanged"}).waitFor();
    assert.deepEqual(await p.evaluate(()=>window.__controllerState().lightboxBindings),saved);
    await p.evaluate(()=>window.__controllerFailBindings=false);
    await p.getByRole("button",{name:"Apply dial controls",exact:true}).click();
    await p.waitForFunction(()=>window.__controllerState().lightboxBindings.dials[0].press==="trash");
    assert.equal(await p.getByRole("button",{name:"Apply dial controls",exact:true}).isDisabled(),true);await p.close();
  });
  await group("Identify pauses every action, learns only a physical turn, and explicit Apply assigns the detected dial", async () => {
    const p=await page();await p.getByRole("button",{name:"Identify the large dial",exact:true}).click();
    await p.getByLabel("Identify physical dial",{exact:true}).waitFor();
    const revision=await p.evaluate(()=>window.__controllerState().surface.revision);
    for(const input of [{kind:"key",index:0},{kind:"key",index:1},{kind:"side",index:1},{kind:"dial",index:2,delta:0}]) {
      const before=await p.evaluate(()=>window.__controllerAcks.length);await p.evaluate(value=>window.__controllerInput(value),input);
      await p.waitForFunction(before=>window.__controllerAcks.length>before,before);
    }
    assert.equal(await p.evaluate(()=>window.__controllerState().identify.index),null);
    assert.equal(await p.getByRole("button",{name:"Dial 3 right",exact:true}).isDisabled(),true);
    assert.equal(await p.evaluate(()=>window.__controllerCalls.filter(call=>!["claim","configure","bindings"].includes(call.command)).length),0);
    await p.evaluate(()=>window.__controllerInput({kind:"dial",index:2,delta:-1}));
    await p.getByText(/Physical dial 3 detected/).waitFor();
    assert.equal(await p.evaluate(()=>window.__controllerCalls.filter(call=>call.command==="bindings").length),0);
    await p.screenshot({path:new URL("controller-identify.png",output).pathname.replace(/^\/([A-Za-z]:\/)/,"$1"),fullPage:true});
    await p.getByRole("button",{name:"Apply identified dial",exact:true}).click();
    await p.waitForFunction(()=>!window.__controllerState().identify.active&&window.__controllerState().lightboxBindings.dials[2].turn==="browse");
    await p.evaluate(revision=>window.__controllerInput({kind:"key",index:0,revision}),revision);
    await p.waitForFunction(()=>window.__controllerAcks.at(-1)?.result==="ignored");
    assert.match(await p.getByTestId("fixture-photo").innerText(),/Horse 1 · stars 0 · Not selected/);
    await p.getByRole("button",{name:"Identify the large dial",exact:true}).click();
    await p.getByRole("button",{name:"Cancel identification",exact:true}).click();
    assert.equal(await p.evaluate(()=>window.__controllerState().identify.active),false);await p.close();
  });
  await group("A pending preferences save keeps close and Identify locked until the atomic acknowledgement", async () => {
    const p=await page();await p.getByLabel("Dial 2 press action",{exact:true}).selectOption("next");
    await p.evaluate(()=>window.__controllerDeferBindings=true);await p.getByRole("button",{name:"Apply dial controls",exact:true}).click();
    await p.waitForFunction(()=>window.__controllerState().bindingsBusy);
    assert.equal(await p.getByRole("button",{name:"Close Esc",exact:true}).isDisabled(),true);
    assert.equal(await p.getByRole("button",{name:"Identify the large dial",exact:true}).isDisabled(),true);
    await p.keyboard.press("Escape");assert.equal(await p.getByRole("dialog").isVisible(),true);
    await p.evaluate(()=>window.__finishBindingsSave());await p.waitForFunction(()=>!window.__controllerState().bindingsBusy);
    assert.equal(await p.getByLabel("Dial 2 press action",{exact:true}).inputValue(),"next");await p.close();
  });
  await group("Narrow controller layout fits the viewport and keeps keyboard focus inside its dialog", async () => {
    const p = await page(360);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    for (let n = 0; n < 35; n++) { await p.keyboard.press("Tab"); assert.equal(await p.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true); }
    await p.screenshot({ path: new URL("controller-360.png", output).pathname.replace(/^\/([A-Za-z]:\/)/, "$1"), fullPage: true }); await p.close();
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(new URL("report.json", output), JSON.stringify({ complete: true, checks, scope: "Production controller panel/runtime/router with deterministic native adapter and synthetic review state. No physical controller, native vendor processes or user photos." }, null, 2));
  console.log(`PASS: ${checks.length} controller browser groups`);
} finally { await browser?.close(); server.kill(); await fs.writeFile(new URL("vite.log", output), serverLog); }
