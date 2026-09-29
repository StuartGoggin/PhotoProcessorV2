import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/studio-scorecard-updates";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1447", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, page;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch("http://127.0.0.1:1447/studio-preview.html")).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://127.0.0.1:1447/studio-preview.html");
  await page.evaluate(() => {
    window.__studioJobs = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "plugin:dialog|save" || command === "plugin:dialog|open") return Promise.resolve("D:/synthetic/project.json");
      if (command === "studio_save_project") { window.__scoreSnapshot = structuredClone(args.project); return Promise.resolve(null); }
      if (command === "studio_load_project") return Promise.resolve(structuredClone(window.__scoreSnapshot));
      return invoke(command, args);
    };
  });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Video Studio/ }).click();
  await page.getByLabel("Clip name / YouTube chapter", { exact: true }).waitFor();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("photogogo.videoStudio.project.v1")));
  const baseline = await saved();
  const graphics = page.getByRole("button", { name: "Graphics", exact: true });
  await graphics.click();
  await page.getByLabel("Default card heading", { exact: true }).fill("STATE CHAMPIONSHIPS");
  await page.getByLabel("Default card result", { exact: true }).fill("Results pending");
  await page.getByLabel("Default card subtitle", { exact: true }).fill("Open Division");
  await page.getByLabel("Use project scorecard template", { exact: true }).check();
  const seeded = await saved();
  for (let i = 0; i < 3; i++) {
    const card = seeded.clips[i].scorecard;
    assert.deepEqual([card.heading, card.result, card.subtitle, card.enabled], ["STATE CHAMPIONSHIPS", "Results pending", "Open Division", false]);
    assert.deepEqual({ ...seeded.clips[i], scorecard: undefined }, { ...baseline.clips[i], scorecard: undefined });
  }
  await graphics.click();
  await page.getByRole("tab", { name: "Scorecard", exact: true }).click();
  assert.equal(await page.getByLabel("Include scorecard", { exact: true }).isChecked(), false);
  await page.getByLabel("Scorecard result", { exact: true }).fill("72 points · 1st place");
  assert.equal((await saved()).clips[0].scorecard.enabled, false, "editing while off never enables a card");
  await page.getByLabel("Include scorecard", { exact: true }).check();
  await graphics.click();
  await page.getByLabel("Default card heading", { exact: true }).fill("FINAL CLASSIFICATION");
  await page.getByLabel("Default card result", { exact: true }).fill("Results confirmed");
  await page.getByLabel("Default card subtitle", { exact: true }).fill("");
  const before = await saved();
  assert.equal(before.clips[0].scorecard.result, "72 points · 1st place");
  assert.equal(before.clips[1].scorecard.heading, "STATE CHAMPIONSHIPS");
  const update = page.getByRole("button", { name: "Update clip scorecards from project defaults…", exact: true });
  const dialog = page.getByRole("dialog", { name: "Review scorecard text updates", exact: true });
  const select = (line, number, name) => dialog.getByRole("checkbox", { name: `Update ${line} for clip ${number}: ${name}`, exact: true });
  await update.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 9);
  assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "Apply 0 selected text changes", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
  await dialog.getByText("72 points · 1st place", { exact: true }).waitFor();
  assert.equal(await dialog.getByText("Will clear existing text if selected", { exact: true }).count(), 3);
  await select("Top line / heading", 1, "Warm-up").check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await saved(), before, "Cancel applies no text changes");
  await update.click();
  assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
  await select("Main line / result", 1, "Warm-up").check();
  await page.keyboard.press("Escape");
  assert.deepEqual(await saved(), before, "Escape applies no changes");
  await update.click();
  await select("Top line / heading", 1, "Warm-up").check();
  await select("Bottom line / subtitle", 1, "Warm-up").check();
  await select("Main line / result", 2, "Technique practice").check();
  await dialog.getByRole("searchbox", { name: "Find a clip in scorecard review", exact: true }).fill("Final run");
  await dialog.getByText("3 of 9 text changes selected", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 3);
  await dialog.getByText(/Counts include clips hidden by your search/).waitFor();
  await dialog.getByRole("searchbox").fill("");
  for (const [width, height] of [[1440, 1000], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `no review overflow at ${width}`);
    const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.equal(await dialog.getByRole("button", { name: "Apply 3 selected text changes", exact: true }).isVisible(), true);
    await dialog.screenshot({ path: `${output}/review-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole("button", { name: "Apply 3 selected text changes", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  let changed = await saved();
  assert.deepEqual(changed.clips[0].scorecard, { ...before.clips[0].scorecard, heading: "FINAL CLASSIFICATION", subtitle: "" });
  assert.deepEqual(changed.clips[1].scorecard, { ...before.clips[1].scorecard, result: "Results confirmed" });
  assert.deepEqual(changed.clips[2], before.clips[2]);
  changed.clips.forEach((c, i) => assert.deepEqual({ ...c, scorecard: undefined }, { ...before.clips[i], scorecard: undefined }));
  await update.click();
  assert.equal(await dialog.getByRole("checkbox").count(), 6, "accepted differences no longer offered");
  assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Blank-only convenience must deselect replacements, including when search hides the blank line.
  await page.getByLabel("Default card subtitle", { exact: true }).fill("Official results");
  const beforeBlank = await saved();
  await update.click();
  await select("Main line / result", 1, "Warm-up").check();
  await dialog.getByRole("searchbox").fill("Final run");
  await dialog.getByRole("button", { name: "Select blank items · all clips", exact: true }).click();
  await dialog.getByText("1 of 7 text changes selected", { exact: true }).waitFor();
  await dialog.getByRole("searchbox").fill("");
  assert.equal(await select("Main line / result", 1, "Warm-up").isChecked(), false);
  assert.equal(await select("Bottom line / subtitle", 1, "Warm-up").isChecked(), true);
  await dialog.getByRole("button", { name: "Clear selection", exact: true }).click();
  assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
  await dialog.getByRole("button", { name: "Select blank items · all clips", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply 1 selected text change", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  changed = await saved();
  assert.deepEqual(changed.clips[0].scorecard, { ...beforeBlank.clips[0].scorecard, subtitle: "Official results" });
  assert.deepEqual(changed.clips.slice(1), beforeBlank.clips.slice(1));
  // Actual save/open UI seams (synthetic IPC) exercise project normalization/remount.
  await page.getByRole("button", { name: "Save snapshot", exact: true }).click();
  await page.getByText("Project snapshot saved; earlier snapshots are preserved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#studio-project-toggle-graphics')?.getAttribute("aria-expanded") === "false");
  assert.deepEqual(await saved(), changed);
  await graphics.click();
  assert.equal(await page.getByLabel("Default card result", { exact: true }).inputValue(), "Results confirmed");
  await update.click();
  assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0, "reopen cannot retain approval choices");
  // Reset event changes project epoch and unmounts the old review without applying it.
  await page.evaluate(() => window.dispatchEvent(new Event("studio-renders-cleared")));
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual((await saved()).clips.map(c => c.scorecard), changed.clips.map(c => c.scorecard));
  assert.deepEqual(errors, []);
  console.log("PASS: three defaults; disabled seeding; editing while off; per-item overwrite/clear warnings; no preselection; cancel/Escape; focus containment; search counts; selective apply; cache retention; repeated review; save/open; epoch invalidation; 1440/1024/390px layouts");
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); server.kill(); }
