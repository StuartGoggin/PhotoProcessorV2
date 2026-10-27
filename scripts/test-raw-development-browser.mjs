import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/raw-development-browser";
await mkdir(output, { recursive: true });
const url = process.env.RAW_DEVELOPMENT_TEST_URL || "http://127.0.0.1:1481/raw-development-preview.html";
const server = process.env.RAW_DEVELOPMENT_TEST_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1481", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", browser;
server?.stdout.on("data", (data) => { serverLog += data; }); server?.stderr.on("data", (data) => { serverLog += data; });
const report = { complete: false, scope: "Production RAW Development component with deterministic synthetic IPC. Tests controls, scope/recipe integrity, preview lifecycle and job submission; does not validate RAW decoding, image quality or throughput.", checks: [] };
const errors = [];
async function range(locator, value) { await locator.evaluate((node, amount) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, String(amount)); node.dispatchEvent(new Event("input", { bubbles: true })); }, value); }
async function ready(page) { await page.getByRole("button", { name: "Edit this photo's override", exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('button[aria-pressed="false"]:disabled') || [...document.querySelectorAll("button")].some((button) => button.textContent === "Edit this photo's override" && !button.disabled)); }
try {
  if (server) {
    let started = false;
    for (let attempt = 0; attempt < 80; attempt++) { if (server.exitCode !== null) throw new Error(`Fixture exited: ${serverLog}`); try { if ((await fetch(url)).ok) { started = true; break; } } catch { /* Starting. */ } await delay(250); }
    assert.ok(started, `Fixture did not start: ${serverLog}`);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1420, height: 1050 } });
  page.setDefaultTimeout(12000); page.on("pageerror", (error) => errors.push(error.message)); page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("button", { name: "Set up RAW Development", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__rawCalls.length), 0);
  await page.getByRole("button", { name: "Set up RAW Development", exact: true }).click(); await ready(page);
  assert.equal(await page.getByRole("combobox", { name: "RAW batch selection", exact: true }).inputValue(), "nonTrash");
  assert.equal(await page.getByRole("slider", { name: "RAW Detail sharpening", exact: true }).inputValue(), "20");
  assert.equal(await page.getByRole("checkbox", { name: "Auto levels", exact: true }).isChecked(), false);
  assert.equal(await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "raw_development_preview").length), 0);
  report.checks.push("Opening controls performs scoped candidate/recipe reads only; conservative Natural defaults and non-trash scope are explicit, with no automatic RAW decode");

  await range(page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }), .75);
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  await page.getByRole("img", { name: "RAW developed comparison", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "raw_development_preview").at(-1).args.request.recipe.exposure), .75);
  assert.equal(await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "raw_development_preview").at(-1).args.request.recipe.autoExposure), false);
  assert.equal(await page.evaluate(() => window.__rawQueue.length), 0);
  for (const label of ["RAW camera reference preview", "RAW developed comparison"]) {
    const allowed = await page.getByRole("img", { name: label, exact: true }).evaluate((image) => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    assert.equal(allowed, false, `${label} must not be saved as a finished export`);
  }
  const manualLevels = ["Exposure (EV)", "Black point", "Contrast", "Highlight recovery"];
  const savedLevels = await Promise.all(manualLevels.map((label) => page.getByRole("slider", { name: `RAW ${label}`, exact: true }).inputValue()));
  await page.getByRole("checkbox", { name: "Auto levels", exact: true }).check();
  assert.equal(await page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }).inputValue(), "0.75");
  for (const label of manualLevels) assert.equal(await page.getByRole("slider", { name: `RAW ${label}`, exact: true }).isDisabled(), true);
  for (const label of ["Shadow lift", "Saturation", "Gentle tonal S-curve"]) assert.equal(await page.getByRole("slider", { name: `RAW ${label}`, exact: true }).isDisabled(), false);
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  await page.getByRole("img", { name: "RAW developed comparison", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "raw_development_preview").at(-1).args.request.recipe.autoExposure), true);
  await page.getByRole("checkbox", { name: "Auto levels", exact: true }).uncheck();
  for (let index = 0; index < manualLevels.length; index++) {
    const input = page.getByRole("slider", { name: `RAW ${manualLevels[index]}`, exact: true });
    assert.equal(await input.isDisabled(), false); assert.equal(await input.inputValue(), savedLevels[index]);
  }
  report.checks.push("Auto levels is explicitly off by default and sends its native boolean; it disables exposure/black/contrast/highlight controls while preserving their manual values for switching off; comparison-image context menus cannot save previews as exports");
  const finish=page.getByRole("slider",{name:"RAW Auto finish strength",exact:true});
  assert.equal(await finish.inputValue(),"0");
  await range(finish,65);
  assert.equal(await page.getByRole("checkbox",{name:"Auto levels",exact:true}).isChecked(),true);
  for(const label of manualLevels)assert.equal(await page.getByRole("slider",{name:`RAW ${label}`,exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole("img",{name:"RAW developed comparison",exact:true}).count(),0,"Look changes revoke the prior preview");
  await page.getByRole("button",{name:"Generate RAW preview",exact:true}).click();
  await page.getByRole("img",{name:"RAW developed comparison",exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__rawCalls.filter(call=>call.command==="raw_development_preview").at(-1).args.request.recipe.finishingStrength),65);
  await range(finish,0);
  assert.equal(await page.getByRole("checkbox",{name:"Auto levels",exact:true}).isChecked(),false);
  assert.equal(await page.getByRole("slider",{name:"RAW Exposure (EV)",exact:true}).inputValue(),"0.75");
  await page.getByRole("button",{name:"Internet ready",exact:true}).click();
  assert.equal(await finish.inputValue(),"65");
  await page.getByRole("button",{name:"Natural",exact:true}).click();
  await range(page.getByRole("slider",{name:"RAW Exposure (EV)",exact:true}),.75);
  report.checks.push("Auto finish transmits its numeric strength, revokes stale previews, enables automatic levels, preserves manual values when Off, and Internet ready is an explicit preset rather than a saved-recipe migration");
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  await page.getByRole("img", { name: "RAW developed comparison", exact: true }).waitFor();
  await page.getByRole("img", { name: "Red, green and blue tonal distribution", exact: true }).waitFor();
  await page.getByRole("button", { name: "100% RAW detail check", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('img[alt="RAW developed comparison"]')?.naturalWidth === 1200);
  const sizes = await page.getByRole("img", { name: "RAW developed comparison", exact: true }).evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight, displayed: image.getBoundingClientRect().width }));
  assert.deepEqual(sizes, { width: 1200, height: 1800, displayed: 1200 });
  report.checks.push("Explicit preview carries the current recipe without queueing; the 100% check uses developed natural pixels with portrait geometry and separate camera-preview dimensions");

  await page.getByRole("button", { name: "Save job defaults on this computer", exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.rawDevelopment.defaults.v1")).exposure), .75);
  await page.getByRole("button", { name: "Queue RAW Development", exact: true }).click();
  await page.waitForFunction(() => window.__rawQueue.length === 1);
  let queued = await page.evaluate(() => window.__rawQueue[0]);
  assert.equal(queued.recipe.exposure, .75); assert.equal(queued.selection, "nonTrash"); assert.equal(queued.usePhotoOverrides, true); assert.equal(queued.path, undefined);
  assert.equal(queued.recipe.autoExposure, false);
  await page.getByRole("button", { name: "Open Jobs", exact: true }).click(); assert.equal(await page.evaluate(() => window.__rawOpenedJobs), true);
  report.checks.push("Job defaults persist locally; queue submits the full current scope and exact recipe through core Jobs, with saved overrides explicit and Open Jobs available");

  await page.getByRole("combobox", { name: "RAW batch selection", exact: true }).selectOption("selected"); await ready(page);
  await page.getByRole("checkbox", { name: "Include Rider.CR3 in RAW batch", exact: true }).check();
  await page.getByRole("combobox", { name: "RAW preview original", exact: true }).selectOption("D:\\Photos\\Portrait.CR3"); await ready(page);
  await page.getByRole("button", { name: "Queue RAW Development", exact: true }).click();
  await page.waitForFunction(() => window.__rawQueue.length === 2);
  queued = await page.evaluate(() => window.__rawQueue[1]);
  assert.deepEqual(queued.selectedPaths, ["D:\\Photos\\Rider.CR3"]); assert.equal(queued.selection, "selected");
  assert.equal(await page.getByRole("checkbox", { name: "Include Portrait.CR3 in RAW batch", exact: true }).isChecked(), false);
  report.checks.push("Only selected originals sends exact batch paths; inspecting a different photo does not select it or change Google Photos flags");

  await page.getByRole("button", { name: "Edit this photo's override", exact: true }).click();
  assert.equal(await page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }).inputValue(), "0.75", "Applied history must not silently replace job defaults");
  await range(page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }), 1.25);
  assert.equal(await page.getByRole("button", { name: "Queue RAW Development", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Save this photo's override", exact: true }).click();
  await page.waitForFunction(() => window.__rawOverrides["D:\\Photos\\Portrait.CR3"]?.exposure === 1.25);
  await page.getByRole("button", { name: "Queue RAW Development", exact: true }).click();
  await page.waitForFunction(() => window.__rawQueue.length === 3);
  assert.equal(await page.evaluate(() => window.__rawQueue[2].recipe.exposure), .75);
  await page.getByRole("button", { name: "Remove saved override", exact: true }).click();
  await page.waitForFunction(() => !window.__rawOverrides["D:\\Photos\\Portrait.CR3"]);
  assert.equal(await page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }).inputValue(), "0.75");
  const writesBeforeRecall = await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "save_raw_recipe").length);
  await page.getByRole("button", { name: "Recall last applied recipe", exact: true }).click();
  assert.equal(await page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }).inputValue(), "1.75");
  assert.equal(await page.evaluate(() => window.__rawOverrides["D:\\Photos\\Portrait.CR3"]), undefined);
  assert.equal(await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "save_raw_recipe").length), writesBeforeRecall);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.rawDevelopment.defaults.v1")).exposure), .75);
  assert.equal(await page.getByRole("button", { name: "Queue RAW Development", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Discard unsaved edits", exact: true }).click();
  assert.equal(await page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }).inputValue(), "0.75");
  report.checks.push("Per-photo saves and applied-history recall are deliberate: recall edits a draft only, preserves defaults/confirmed overrides, blocks unsaved queueing, and can be discarded without a native write");

  await page.getByRole("combobox", { name: "RAW white balance", exact: true }).selectOption("custom");
  await page.getByRole("spinbutton", { name: "RAW temperature", exact: true }).fill("4800");
  await page.getByRole("spinbutton", { name: "RAW tint", exact: true }).fill("1.12");
  await page.getByRole("combobox", { name: "RAW output format", exact: true }).selectOption("tiff16");
  await page.getByRole("checkbox", { name: "Independent B&W", exact: true }).check();
  await page.getByRole("checkbox", { name: "Keep GPS in output copies", exact: true }).uncheck();
  await page.getByText("Independent B&W adjustments", { exact: true }).click();
  await range(page.getByRole("slider", { name: "RAW B&W S-curve strength", exact: true }), .4);
  await page.getByRole("button", { name: "Save this photo's override", exact: true }).click();
  await page.waitForFunction(() => window.__rawOverrides["D:\\Photos\\Portrait.CR3"]?.output === "tiff16");
  const saved = await page.evaluate(() => window.__rawOverrides["D:\\Photos\\Portrait.CR3"]);
  assert.equal(saved.temperature, 4800); assert.equal(saved.tint, 1.12); assert.equal(saved.bw, true); assert.equal(saved.keepGps, false); assert.equal(saved.bwParams.curveStrength, .4);
  await page.getByText(/TIFF exports are written beside the original/).waitFor();
  await page.getByText(/RAW B&W local contrast maps 0–1 to RawTherapee Local Contrast Amount 0–0.15/).waitFor();
  report.checks.push("Custom WB, 16-bit output, exact colour/B&W branches, output-only GPS choice and all B&W settings survive the saved recipe contract");

  await page.getByRole("checkbox", { name: "Colour development", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Independent B&W", exact: true }).uncheck();
  assert.equal(await page.getByRole("button", { name: "Generate RAW preview", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save this photo's override", exact: true }).isDisabled(), true);
  await page.getByText("Choose at least one output.", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Colour development", exact: true }).check();
  await page.getByRole("checkbox", { name: "Independent B&W", exact: true }).check();
  await page.evaluate(() => { window.__rawSaveError = "Fixture metadata write failed"; });
  await range(page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }), 1.5);
  await page.getByRole("button", { name: "Save this photo's override", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture metadata write failed" }).waitFor();
  assert.equal(await page.evaluate(() => window.__rawOverrides["D:\\Photos\\Portrait.CR3"].exposure), .75);
  assert.equal(await page.getByRole("button", { name: "Queue RAW Development", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.__rawSaveError = null; });
  await page.getByRole("button", { name: "Save this photo's override", exact: true }).click();
  await page.waitForFunction(() => window.__rawOverrides["D:\\Photos\\Portrait.CR3"].exposure === 1.5);
  report.checks.push("An empty output selection cannot preview or save; failed metadata writes retain the confirmed recipe and keep unsaved edits blocked until a successful retry");

  await page.getByRole("combobox", { name: "RAW preview branch", exact: true }).selectOption("bw");
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  await page.getByText("B&W RAW-developed result · 400 × 600", { exact: true }).waitFor();
  let previewRequest = await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "raw_development_preview").at(-1).args.request);
  assert.equal(previewRequest.previewVariant, "bw"); assert.equal(previewRequest.recipe.colour, true); assert.equal(previewRequest.recipe.bw, true);
  await page.getByRole("checkbox", { name: "Colour development", exact: true }).uncheck();
  assert.equal(await page.getByRole("combobox", { name: "RAW preview branch", exact: true }).inputValue(), "bw");
  await page.getByRole("checkbox", { name: "Colour development", exact: true }).check();
  report.checks.push("Colour/B&W preview branch is an explicit independent request without changing export booleans; B&W-only recipes choose B&W automatically, and TIFF/RAW algorithm mappings are explained");

  await page.getByRole("checkbox", { name: "Use saved per-photo overrides where present", exact: true }).uncheck();
  await page.evaluate(() => { window.__rawHold = true; });
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  await page.waitForFunction(() => window.__rawDeferred.length === 1);
  assert.equal(await page.getByRole("button", { name: "Queue RAW Development", exact: true }).isDisabled(), true);
  await range(page.getByRole("slider", { name: "RAW Exposure (EV)", exact: true }), 2);
  assert.equal(await page.getByRole("button", { name: "Queue RAW Development", exact: true }).isDisabled(), true, "An invalidated but active preview still blocks the batch");
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__rawPreviewActive), 1);
  await page.evaluate(() => { window.__rawHold = false; window.__rawDeferred.splice(0).forEach((resolve) => resolve()); });
  await page.getByText("Fixture exposure 2", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__rawPreviewMax), 1);
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((button) => button.textContent === "Queue RAW Development")?.disabled);
  assert.ok(await page.evaluate(() => window.__rawRevoked.length > 0));
  report.checks.push("Editing invalidates stale image results; newer requests wait on one serial lane, obsolete responses never display, and object URLs are released");

  await page.evaluate(() => { window.__rawPreviewError = "Fixture decoder failure"; });
  await page.getByRole("button", { name: "Generate RAW preview", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture decoder failure" }).waitFor();
  assert.equal(await page.evaluate(() => window.__rawQueue.length), 3);
  await page.evaluate(() => { window.__rawPreviewError = null; window.__rawUnavailable = true; });
  await page.getByRole("button", { name: "Refresh RAW list", exact: true }).click(); await ready(page);
  assert.equal(await page.getByRole("button", { name: "Queue RAW Development", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Generate RAW preview", exact: true }).isDisabled(), true);
  report.checks.push("Decode errors are scoped to preview without queueing; unavailable worker disables final and preview actions with its runtime explanation");

  await page.evaluate(() => { window.__rawUnavailable = false; window.__rawSetScope("D:\\Photos\\Event"); });
  await page.waitForFunction(()=>document.querySelector('select[aria-label="RAW preview original"]')?.value === "D:\\Photos\\Event\\Rider.CR3");await ready(page);
  assert.equal(await page.getByRole("combobox", { name: "RAW preview original", exact: true }).inputValue(), "D:\\Photos\\Event\\Rider.CR3");
  assert.equal(await page.getByRole("checkbox", { name: "Include Rider.CR3 in RAW batch", exact: true }).isChecked(), false);
  await page.getByRole("combobox", { name: "RAW batch selection", exact: true }).selectOption("minRating"); await ready(page);
  await page.getByRole("combobox", { name: "Minimum RAW rating", exact: true }).selectOption("2"); await ready(page);
  await page.waitForFunction(() => window.__rawCalls.filter((call) => call.command === "raw_development_candidates").at(-1)?.args.request.minRating === 2);
  const rated = await page.evaluate(() => window.__rawCalls.filter((call) => call.command === "raw_development_candidates").at(-1).args.request);
  assert.equal(rated.selection, "minRating"); assert.equal(rated.scopeDir, "D:\\Photos\\Event");
  await page.getByRole("button",{name:"Internet ready",exact:true}).click();
  assert.equal(await finish.inputValue(),"65");
  await page.screenshot({path:`${output}/auto-finish.png`,fullPage:true});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: "html, body, #root { height: auto; overflow: visible; }" });
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(width.scroll <= width.viewport + 1, `Compact layout overflowed: ${JSON.stringify(width)}`);
  await page.screenshot({ path: `${output}/compact.png`, fullPage: true });
  report.checks.push("Changing scope replaces candidate/recipe identity and clears prior explicit selections; compact controls remain within a 390px viewport");
  assert.deepEqual(errors, []); report.complete = true;
} catch (error) { report.error = error.stack || String(error); throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); if (server) server.kill(); }
console.log(`RAW Development browser: ${report.checks.length} groups passed`);
