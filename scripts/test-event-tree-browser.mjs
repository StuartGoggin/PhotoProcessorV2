import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/tree-event-naming"; await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1485", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser;
server.stdout.on("data", value => log += value); server.stderr.on("data", value => log += value);
const url = "http://127.0.0.1:1485/name-events-preview.html", root = "D:\\Synthetic events", day = "2026/10/24";
const errors = [], report = { complete: false, scope: "Production tree, event editor and source pages with synthetic IPC only; no native media/file/account writes.", checks: [] };
const row = (page, path) => page.locator(`[data-event-folder=${JSON.stringify(path)}]`);
const dialog = page => page.getByRole("dialog", { name: "Event naming", exact: true });
async function boot(mode = "review", flags = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }); page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message)); page.on("dialog", d => void d.accept());
  await page.addInitScript(values => Object.assign(window, values), { __eventTreePage: mode, ...flags });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (mode === "timeline") await row(page, day).waitFor(); else await row(page, "2026").waitFor();
  return page;
}
async function photo(page, suffix, label = "Original") {
  await page.waitForFunction(async ({ suffix, label }) => {
    const img = [...document.querySelectorAll(".review-images img")].find(node => node.alt === label);
    if (!img?.complete || !img.naturalWidth) return false;
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    const key = btoa(String.fromCharCode(...bytes));
    return window.__eventImagePaths.get(key)?.replace(/\\/g, "/").endsWith(suffix);
  }, { suffix, label });
  await page.waitForFunction(label => !document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`)?.disabled, label);
}
async function open(page, path, label = "Name event…") {
  await row(page, path).click({ button: "right" });
  await page.getByRole("menu", { name: "Event actions" }).getByRole("menuitem", { name: label, exact: true }).click();
  await dialog(page).getByLabel("Event group", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.textContent.includes("Loading date folders…"));
}
async function review(page, count = 1) {
  await dialog(page).getByRole("button", { name: "MGV teams", exact: true }).click();
  await dialog(page).getByRole("button", { name: `Review ${count} change${count === 1 ? "" : "s"}`, exact: true }).click();
  await dialog(page).getByRole("region", { name: "Folder rename review", exact: true }).waitFor();
}
async function apply(page, count = 1) {
  await dialog(page).getByRole("button", { name: `Apply ${count} change${count === 1 ? "" : "s"}`, exact: true }).click();
  await page.waitForFunction(() => window.__eventRequests.length > 0);
  assert.equal(await dialog(page).getByRole("button", { name: "Close event editor", exact: true }).isDisabled(), true);
}
async function finish(page, status = "completed", count = 1) {
  await page.evaluate(({ status, count }) => window.__eventComplete(status, count), { status, count });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Close event editor"]')?.disabled);
}
async function close(page) { await dialog(page).getByRole("button", { name: "Close event editor", exact: true }).click(); await dialog(page).waitFor({ state: "detached" }); }

try {
  let started = false;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw Error(log); try { if ((await fetch(url)).ok) { started = true; break; } } catch {} await delay(150); }
  assert.ok(started, log); browser = await chromium.launch({ channel: "msedge", headless: true });

  const cancel = await boot();
  await row(cancel, day).click(); await cancel.getByText("horse.jpg", { exact: true }).click(); await photo(cancel, day + "/horse.jpg");
  const draft = JSON.stringify({ version: 1, selected: [root + "\\2026\\10\\25"], draft: { customName: "Unrelated standalone draft" } });
  await cancel.evaluate(draft => localStorage.setItem("photogogo.eventDraft.v1:d:\\synthetic events", draft), draft);
  const reads = await cancel.evaluate(() => window.__eventCalls.filter(c => c.command === "list_staging_tree").length);
  await open(cancel, day);
  await dialog(cancel).getByRole("button", { name: "Add or change dates", exact: true }).click();
  assert.equal(await dialog(cancel).getByRole("checkbox", { name: /^Select .*October 2026$/ }).evaluateAll(nodes => nodes.filter(n => n.checked).length), 1);
  assert.equal(await dialog(cancel).getByRole("checkbox", { name: "Select 24 October 2026", exact: true }).isChecked(), true);
  await dialog(cancel).getByRole("button", { name: "Close event editor" }).focus(); await cancel.keyboard.press("q");
  assert.equal(await cancel.evaluate(() => window.__eventSelectionWrites.length), 0);
  await cancel.keyboard.press("Escape"); await dialog(cancel).waitFor({ state: "detached" }); await photo(cancel, day + "/horse.jpg");
  assert.equal(await row(cancel, day).getAttribute("aria-expanded"), "true");
  assert.equal(await cancel.evaluate(() => window.__eventCalls.filter(c => c.command === "list_staging_tree").length), reads);
  assert.equal(await cancel.evaluate(() => localStorage.getItem("photogogo.eventDraft.v1:d:\\synthetic events")), draft);
  await row(cancel, day).focus(); await cancel.keyboard.press("Shift+F10"); await cancel.getByRole("menu", { name: "Event actions" }).waitFor(); await cancel.keyboard.press("Escape");
  assert.equal(await cancel.evaluate(() => window.__eventRequests.length), 0);
  report.checks.push("Right-click/keyboard actions preserve expansion, displayed photo and standalone draft; a clicked date opens alone; Escape cancels without naming, reloads or leaked Q actions");
  await cancel.close();

  const scopes = await boot();
  await open(scopes, "2026/10", "Name events within…");
  assert.equal(await dialog(scopes).getByRole("checkbox", { name: /^Select / }).evaluateAll(nodes => nodes.filter(n => n.checked).length), 0);
  assert.equal(await dialog(scopes).getByRole("checkbox", { name: "Select 1 November 2026", exact: true }).count(), 0);
  assert.equal(await dialog(scopes).getByRole("button", { name: "Review 0 changes", exact: true }).isDisabled(), true); await close(scopes);
  await open(scopes, "2026/10/04 - Monbulk Pony Club - Rally", "Edit event…");
  assert.equal(await dialog(scopes).getByLabel("Custom event name", { exact: true }).inputValue(), "Monbulk Pony Club - Rally");
  await dialog(scopes).getByLabel("Custom event name", { exact: true }).fill("Edited legacy event");
  await dialog(scopes).getByRole("button", { name: "Review 1 change", exact: true }).click();
  assert.equal(await dialog(scopes).getByRole("button", { name: "Apply 1 change", exact: true }).isDisabled(), true);
  await dialog(scopes).getByRole("checkbox", { name: "Replace existing event for 4 October 2026", exact: true }).check();
  assert.equal(await dialog(scopes).getByRole("button", { name: "Apply 1 change", exact: true }).isEnabled(), true); await close(scopes);
  await row(scopes, day).click(); await open(scopes, day + "/Extras", "Name containing event…");
  await dialog(scopes).getByRole("button", { name: "Add or change dates", exact: true }).click();
  assert.equal(await dialog(scopes).getByRole("checkbox", { name: "Select 24 October 2026", exact: true }).isChecked(), true); await close(scopes);
  report.checks.push("Month scopes start unselected and stay in period; legacy wording remains literal; existing descriptions require consent; nested folders resolve to their native event owner"); await scopes.close();

  const renamed = await boot(); await row(renamed, day).click(); await renamed.getByText("horse.jpg", { exact: true }).click(); await photo(renamed, day + "/horse.jpg");
  await open(renamed, day); await review(renamed); await apply(renamed);
  await renamed.evaluate(() => { window.__eventHoldTree = true; window.__eventComplete(); });
  await renamed.waitForFunction(() => window.__eventDeferred.some(d => d.kind === "Tree"));
  assert.equal(await dialog(renamed).getByRole("button", { name: "Close event editor" }).isDisabled(), true, "Terminal job remains locked until origin refresh");
  await renamed.evaluate(() => { window.__eventHoldTree = false; window.__eventRelease("Tree"); });
  await renamed.waitForFunction(() => !document.querySelector('button[aria-label="Close event editor"]')?.disabled);
  await renamed.screenshot({ path: `${output}/drawer-complete.png`, fullPage: true }); await close(renamed);
  const newDay = await renamed.evaluate(() => window.__eventDays.find(d => d.dateKey === "2026-10-24").relativePath);
  await photo(renamed, newDay + "/horse.jpg"); await row(renamed, newDay).waitFor();
  await renamed.locator('[aria-label="Photo Lightbox review"]').focus(); await renamed.keyboard.press("q");
  await renamed.waitForFunction(() => window.__eventSelectionWrites.length === 1);
  assert.equal(await renamed.evaluate(() => window.__eventSelectionWrites[0].relativePath), newDay + "/horse.jpg");
  report.checks.push("A completed rename stays locked through deferred source refresh, restores the same original beneath its confirmed new path, and subsequent Q targets that exact file"); await renamed.close();

  const process = await boot("process"); await process.getByText("This folder only", { exact: true }).click();
  await row(process, "2026/10").click(); await row(process, day).click();
  await process.getByRole("button", { name: "Set up RAW Development", exact: true }).click();
  await process.getByRole("button", { name: "Edit this photo's override", exact: true }).click();
  const exposure = process.getByRole("slider", { name: "RAW Exposure (EV)", exact: true });
  await exposure.evaluate(node => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, "1.25"); node.dispatchEvent(new Event("input", { bubbles: true })); });
  await open(process, day); await review(process);
  await dialog(process).getByRole("button", { name: "Apply 1 change", exact: true }).click();
  await dialog(process).getByRole("alert").filter({ hasText: "unsaved RAW photo override" }).waitFor();
  assert.equal(await process.evaluate(() => window.__eventRequests.length), 0); await close(process);
  assert.equal(await exposure.inputValue(), "1.25");
  await process.getByRole("button", { name: "Discard unsaved edits", exact: true }).click();
  await open(process, day); await review(process); await apply(process); await finish(process); await close(process);
  await process.getByRole("button", { name: "Queue Job", exact: true }).first().click();
  const queued = await process.evaluate(() => window.__eventCalls.filter(c => c.command === "start_process_job").at(-1).args);
  assert.equal(queued.scopeMode, "folderOnly"); assert.match(queued.scopeDir, /24 - Mounted Games Victoria/); assert.notEqual(queued.scopeDir, root);
  report.checks.push("Photo Process menu cancellation preserves an unsaved RAW override; Apply blocks its loss, then a deliberate rename retains folder-only processing scope instead of widening to staging"); await process.close();

  const timeline = await boot("timeline", { __eventMetadataOnly: true });
  await row(timeline, day).locator("button").first().click();
  await timeline.getByRole("button", { name: "All", exact: true }).click();
  await timeline.getByRole("button", { name: "Timeline", exact: true }).click();
  await timeline.getByRole("button", { name: "Preview horse.jpg", exact: true }).waitFor();
  await timeline.getByRole("button", { name: "Rename Day Folder", exact: true }).click();
  await dialog(timeline).getByLabel("Event group", { exact: true }).waitFor(); await review(timeline); await apply(timeline); await finish(timeline); await close(timeline);
  await timeline.getByRole("button", { name: "Preview horse.jpg", exact: true }).waitFor();
  assert.equal(await timeline.evaluate(() => window.__eventCalls.filter(c => c.command === "apply_event_naming").length), 0);
  report.checks.push("Timeline's existing rename action uses the shared reviewed job; metadata-only completion retains timeline media and never calls the old direct naming command"); await timeline.close();

  const stale = await boot("review", { __eventHoldDays: true }); await row(stale, day).click({ button: "right" });
  await stale.waitForFunction(() => window.__eventDeferred.some(d => d.kind === "Days"));
  await stale.evaluate(() => window.__eventSwitchRoot("E:\\New staging")); await row(stale, "2026").waitFor();
  await stale.evaluate(() => { window.__eventHoldDays = false; window.__eventRelease("Days"); }); await delay(50);
  assert.equal(await stale.getByRole("menu", { name: "Event actions" }).count(), 0); assert.equal(await dialog(stale).count(), 0);
  assert.equal(await stale.evaluate(() => window.__eventRequests.length), 0);
  report.checks.push("An old-root menu lookup cannot reopen or name anything in a newer staging root"); await stale.close();

  const crop = await boot("review", { __eventCrops: true }); await row(crop, day).click(); await crop.getByText("horse.jpg", { exact: true }).click(); await photo(crop, day + "/horse.jpg");
  await crop.getByRole("group", { name: "Photo version", exact: true }).getByRole("button", { name: "Cropped", exact: true }).click(); await photo(crop, day + "/horse_crop.jpg", "Cropped");
  await open(crop, day); await review(crop); await apply(crop); await finish(crop); await close(crop);
  const cropDay = await crop.evaluate(() => window.__eventDays.find(d => d.dateKey === "2026-10-24").relativePath);
  await photo(crop, cropDay + "/horse_crop.jpg", "Cropped");
  assert.equal(await crop.getByRole("group", { name: "Photo version" }).getByRole("button", { name: "Cropped", exact: true }).getAttribute("aria-pressed"), "true");
  report.checks.push("A verified folder move restores the displayed crop family and retains its original navigation owner"); await crop.close();

  const partial = await boot(); const secondDay = "2026/10/25";
  await row(partial, secondDay).click(); await partial.getByText("horse.jpg", { exact: true }).click(); await photo(partial, secondDay + "/horse.jpg");
  await open(partial, day); await dialog(partial).getByRole("button", { name: "Add or change dates", exact: true }).click();
  await dialog(partial).getByRole("checkbox", { name: "Select 25 October 2026", exact: true }).check();
  await review(partial, 2); await apply(partial, 2); await finish(partial, "failed", 1);
  await dialog(partial).getByText("Synthetic partial naming failure", { exact: true }).waitFor(); await close(partial);
  await photo(partial, secondDay + "/horse.jpg"); await row(partial, secondDay).waitFor();
  const completedDay = await partial.evaluate(() => window.__eventDays.find(d => d.dateKey === "2026-10-24").relativePath); assert.notEqual(completedDay, day); await row(partial, completedDay).waitFor();
  report.checks.push("A failed multi-date job refreshes completed moves while preserving the unmoved selected photo and its unchanged path"); await partial.close();

  const drain = await boot("review", { __eventHoldSelection: true }); await row(drain, day).click(); await drain.getByText("horse.jpg", { exact: true }).click(); await photo(drain, day + "/horse.jpg");
  await drain.locator('[aria-label="Photo Lightbox review"]').focus(); await drain.keyboard.press("q");
  await drain.waitForFunction(() => window.__eventDeferred.some(d => d.kind === "Selection"));
  await drain.evaluate(() => window.__eventSetPage("process")); await row(drain, "2026/10").click(); await row(drain, day).waitFor();
  await open(drain, day); await dialog(drain).getByRole("button", { name: "MGV teams", exact: true }).click();
  await dialog(drain).getByRole("button", { name: "Review 1 change", exact: true }).click();
  assert.equal(await drain.evaluate(() => window.__eventCalls.filter(c => c.command === "preview_event_naming").length), 0);
  assert.equal(await dialog(drain).getByRole("button", { name: "Close event editor" }).isDisabled(), true);
  await drain.evaluate(() => { window.__eventHoldSelection = false; window.__eventRelease("Selection"); });
  await dialog(drain).getByRole("region", { name: "Folder rename review" }).waitFor();
  assert.equal(await drain.evaluate(() => window.__eventRequests.length), 0); await close(drain);
  report.checks.push("A naming preview in another page waits for the shared pending Lightbox checkbox write before reviewing paths"); await drain.close();

  const late = await boot("process", { __eventHoldPreview: true }); await row(late, "2026/10").click(); await open(late, day);
  await dialog(late).getByRole("button", { name: "MGV teams", exact: true }).click(); await dialog(late).getByRole("button", { name: "Review 1 change", exact: true }).click();
  await late.waitForFunction(() => window.__eventDeferred.some(d => d.kind === "Preview"));
  await late.evaluate(() => window.__eventSwitchRoot("E:\\Replacement staging")); await row(late, "2026").waitFor();
  await late.evaluate(() => { window.__eventHoldPreview = false; window.__eventRelease("Preview"); }); await delay(70);
  assert.equal(await dialog(late).count(), 0); assert.equal(await late.evaluate(() => window.__eventRequests.length), 0);
  report.checks.push("A held old-root preview cannot revive its closed editor or submit a rename after switching staging directories"); await late.close();

  for (const foreign of [false, true]) {
    const recovery = await boot("review", foreign ? { __eventJobs: [{ id: "saved-job", task: "enhance", stagingDir: "E:\\Other root", status: "running", errors: [], total: 1, done: 0, processed: 0, resultCount: 0 }] } : {});
    await row(recovery, day).click(); await recovery.getByText("horse.jpg", { exact: true }).click(); await photo(recovery, day + "/horse.jpg");
    await recovery.evaluate(() => localStorage.setItem("photogogo.eventDrawer.v1:d:/synthetic events:2026/10/24", JSON.stringify({ version: 1, jobId: "saved-job", selected: ["E:\\Other root\\2026\\10\\24"], draft: { eventGroup: "Saved", eventType: "Teams", venue: "", customName: null }, changes: [{ from: "2026/10/24", to: "2026/10/WRONG" }] })));
    await open(recovery, day); await dialog(recovery).getByText(foreign ? /belongs to another task/ : /no longer available/).waitFor();
    await recovery.waitForFunction(() => !document.querySelector('button[aria-label="Close event editor"]')?.disabled); await close(recovery); await photo(recovery, day + "/horse.jpg");
    assert.equal(await recovery.evaluate(() => window.__eventRequests.length), 0); await recovery.close();
  }
  report.checks.push("Missing and foreign restored jobs only refresh the current view; saved path mappings are ignored and no rename is resubmitted");

  const missing = await boot("process"); await missing.getByText("This folder only", { exact: true }).click(); await row(missing, "2026/10").click(); await row(missing, day).click();
  await open(missing, day); await review(missing); await apply(missing);
  await missing.evaluate(() => { window.__eventOmitTreeDate = "2026-10-24"; window.__eventComplete(); });
  await missing.waitForFunction(() => !document.querySelector('button[aria-label="Close event editor"]')?.disabled); await close(missing);
  assert.equal(await missing.getByRole("button", { name: "Queue Job", exact: true }).first().isDisabled(), true);
  await missing.getByText(/selected scope no longer exists/).first().waitFor();
  report.checks.push("A missing post-rename processing scope disables queueing instead of silently widening to the staging root"); await missing.close();

  const compact = await boot(); await compact.setViewportSize({ width: 360, height: 780 });
  await row(compact, day).getByRole("button", { name: "Event actions for 24", exact: true }).click();
  await compact.getByRole("menuitem", { name: "Name event…", exact: true }).click(); await dialog(compact).getByLabel("Event group", { exact: true }).waitFor();
  const bounds = await dialog(compact).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 361);
  const modalControls = dialog(compact).locator('button,input,select,textarea,summary,[tabindex]').filter({ visible: true });
  const controls = await modalControls.elementHandles(); const enabled = [];
  for (const node of controls) if (await node.evaluate(n => !n.matches(':disabled,[tabindex="-1"]'))) enabled.push(node);
  await enabled.at(-1).focus(); await compact.keyboard.press("Tab"); assert.equal(await enabled[0].evaluate(n => n === document.activeElement), true);
  await compact.screenshot({ path: `${output}/drawer-compact.png`, fullPage: true }); await compact.keyboard.press("Escape"); await dialog(compact).waitFor({ state: "detached" });
  assert.equal(await row(compact, day).getByRole("button", { name: "Event actions for 24", exact: true }).evaluate(n => n === document.activeElement), true);
  report.checks.push("The visible actions button opens the drawer at 360 px; its bounds fit, Tab stays inside, and Escape restores the invoking control"); await compact.close();

  assert.deepEqual(errors, []); report.complete = true;
} catch (error) { report.error = error.stack || String(error); if (browser) for (const [i, page] of browser.contexts().flatMap(context => context.pages()).entries()) { await page.screenshot({ path: `${output}/failed-${i}.png`, fullPage: true }).catch(() => {}); await writeFile(`${output}/failed-${i}.txt`, await page.locator("body").innerText()); } throw error; }
finally { await writeFile(`${output}/browser-report.json`, JSON.stringify(report, null, 2)); await browser?.close(); server.kill(); }
console.log(`Event tree: ${report.checks.length} browser groups passed`);
