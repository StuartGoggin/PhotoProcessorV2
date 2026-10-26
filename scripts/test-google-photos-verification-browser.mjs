import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const output = "test-output/google-photos-verification-browser";
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1472", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browser, log = "";
server.stdout.on("data", data => { log += data; }); server.stderr.on("data", data => { log += data; });
const report = { complete: false, scope: "Shared production Google Photos card on real Jobs/Transfer pages with deterministic native IPC. Synthetic four-photo registration/verification pilot; no account, upload, reset or user-photo access.", checks: [] };
const calls = (page, command) => page.evaluate(command => (window.__jobsCalls ?? window.__googleCalls).filter(call => call.command === command), command);
const account = { id: "client-A:subject-A", email: "rider@example.test", displayName: "Synthetic rider" };
const pilot = { id: "verification-pilot", status: "needs_attention", accountId: account.id, accountEmail: account.email, createdAt: "2026-10-26T04:00:00Z", done: 4, total: 4, uploaded: 3, accepted: 4, awaitingVerification: 1, verificationNeedsAttention: 1, skipped: 0, failed: 1, bytesDone: 20000, totalBytes: 20000, currentFile: "", albums: [{ key: "pilot-event", title: "Synthetic pilot event", state: "ready", productUrl: "https://photos.google.com/lr/album/synthetic" }], errors: ["Photo 3 (Original): verification needs attention. Google per-item status INVALID_ARGUMENT (3); saved registration retained."] };
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) { if (server.exitCode !== null) throw new Error(log); try { if ((await fetch("http://127.0.0.1:1472/google-photos-jobs-preview.html")).ok) { ready = true; break; } } catch {} await delay(200); }
  assert.ok(ready, "Verification fixture started");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }); page.setDefaultTimeout(7000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ pilot, account }) => { window.__googleJobs = [pilot]; window.__googleStatus = { configured: true, connecting: false, account }; }, { pilot, account });
  await page.goto("http://127.0.0.1:1472/google-photos-jobs-preview.html", { waitUntil: "domcontentloaded" });
  const jobs = page.locator(".jobs-page"); const card = jobs.getByRole("article", { name: "Google Photos job verification-pilot", exact: true });
  await card.getByText("Accepted by Google: 4", { exact: true }).waitFor();
  await card.getByText("Verified: 3", { exact: true }).waitFor();
  await card.getByText("Verification needs attention: 1", { exact: true }).waitFor();
  await card.getByText("Retry this saved job", { exact: false }).waitFor();
  const warningProgress = await card.getByRole("progressbar", { name: "Processed photos verification-pilot", exact: true }).evaluate(node => {
    // WebKit's computed pseudo-element query can report the track instead of
    // the internal value. Check native appearance and the browser-parsed,
    // scoped fill declaration rather than inspecting source text.
    const rules = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } });
    const fill = rules.find(rule => rule.selectorText === ".gp-job progress.progress-amber::-webkit-progress-value");
    return { appearance: getComputedStyle(node).appearance, warningClass: node.classList.contains("progress-amber"), fillColour: fill?.style.backgroundColor };
  });
  assert.deepEqual(warningProgress, { appearance: "none", warningClass: true, fillColour: "rgb(245, 158, 11)" }, "Unverified/attention progress must use the actual application amber fill rule, not native green");
  report.warningProgress = warningProgress;
  assert.equal(await card.getByText("completed", { exact: true }).count(), 0, "A registered but unverified image must not make the job look completed");
  assert.equal(await card.getByRole("button", { name: /Reset|New upload|Mark.*verified/i }).count(), 0);
  assert.equal(await card.getByRole("button", { name: "Retry safe remaining work", exact: true }).isEnabled(), true);
  await page.screenshot({ path: `${output}/jobs-four-accepted-three-verified.png`, fullPage: true });
  report.checks.push("Normal Jobs distinguishes four accepted registration receipts from three verified photos and one verification warning, preserving same-job retry guidance");

  await card.getByRole("button", { name: "Retry safe remaining work", exact: true }).click();
  const retried = (await calls(page, "google_photos_control"));
  assert.equal(retried.length, 1); assert.deepEqual(retried[0].args, { jobId: "verification-pilot", action: "retry" });
  await jobs.getByRole("group", { name: "Filter jobs", exact: true }).getByRole("button", { name: "Active", exact: true }).click();
  await card.getByText("Verification is continuing in this saved job.", { exact: false }).waitFor();
  assert.equal((await calls(page, "google_photos_start")).length, 0); assert.equal((await calls(page, "google_photos_plan")).length, 0);
  report.checks.push("Retry uses the original saved job ID, retains accepted/verified distinctions during recovery, and never creates a new plan or upload job");

  await page.evaluate(() => { Object.assign(window.__googleJobs[0], { verificationNeedsAttention: 0, status: "running", errors: [], failed: 0, done: 3 }); });
  await jobs.getByRole("button", { name: "Refresh Google Photos jobs", exact: true }).click();
  await card.getByText("Awaiting verification: 1", { exact: true }).waitFor();
  assert.equal(await card.getByText("Verification needs attention: 1", { exact: true }).count(), 0);
  report.checks.push("A pending check without a saved error is Awaiting verification, not a failure or a verified photo");

  await page.evaluate(() => { Object.assign(window.__googleJobs[0], { status: "completed", awaitingVerification: 1 }); });
  await jobs.getByRole("button", { name: "Refresh Google Photos jobs", exact: true }).click();
  await jobs.getByRole("group", { name: "Filter jobs", exact: true }).getByRole("button", { name: "History", exact: true }).click();
  await card.getByText("needs attention", { exact: true }).waitFor();
  assert.equal(await card.getByText("completed", { exact: true }).count(), 0, "An inconsistent cached completed status cannot hide an outstanding accepted receipt");
  await page.evaluate(() => { Object.assign(window.__googleJobs[0], { uploaded: 4, awaitingVerification: 0, verificationNeedsAttention: 0, done: 4 }); });
  await jobs.getByRole("button", { name: "Refresh Google Photos jobs", exact: true }).click();
  await card.getByText("Verified: 4", { exact: true }).waitFor(); await card.getByText("completed", { exact: true }).waitFor();
  assert.equal(await card.getByRole("progressbar", { name: "Processed photos verification-pilot", exact: true }).evaluate(node => node.classList.contains("progress-emerald")), true, "Only completed verification uses the success progress tone");
  assert.equal(await card.getByText("Retry this saved job", { exact: false }).count(), 0);
  report.checks.push("Only complete read-back permits completed presentation; a stale completed status with unverified receipts stays visibly unresolved");

  const transfer = await browser.newPage({ viewport: { width: 1360, height: 1000 } }); transfer.setDefaultTimeout(7000);
  transfer.on("pageerror", error => errors.push(error.message));
  await transfer.addInitScript(({ pilot, account }) => { window.__googleJobs = [pilot]; window.__googleStatus = { configured: true, connecting: false, account }; }, { pilot, account });
  await transfer.goto("http://127.0.0.1:1472/google-photos-preview.html", { waitUntil: "domcontentloaded" });
  const transferCard = transfer.getByRole("article", { name: "Google Photos job verification-pilot", exact: true });
  await transferCard.getByText("Accepted by Google: 4", { exact: true }).waitFor(); await transferCard.getByText("Verified: 3", { exact: true }).waitFor();
  await transferCard.getByText("Verification needs attention: 1", { exact: true }).waitFor();
  await transferCard.getByText("Retry this saved job", { exact: false }).waitFor();
  await transfer.screenshot({ path: `${output}/transfer-four-accepted-three-verified.png`, fullPage: true });
  await transferCard.getByRole("button", { name: "Retry safe remaining work", exact: true }).click();
  assert.deepEqual((await calls(transfer, "google_photos_control"))[0].args, { jobId: "verification-pilot", action: "retry" });
  assert.equal((await calls(transfer, "google_photos_start")).length, 0);
  await transfer.evaluate(() => { window.__googleJobs[0].status = "paused"; });
  await transfer.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await transferCard.getByText("Resume this saved job", { exact: false }).waitFor();
  await transferCard.getByRole("button", { name: "Resume", exact: true }).click();
  assert.deepEqual((await calls(transfer, "google_photos_control")).map(call => call.args), [{ jobId: "verification-pilot", action: "retry" }, { jobId: "verification-pilot", action: "resume" }]);
  assert.equal((await calls(transfer, "google_photos_start")).length, 0);
  await transfer.close();
  report.checks.push("Transfer uses the same accepted/verified/warning labels, state-matched Resume/Retry guidance and same saved-job controls without starting a replacement upload");
  assert.deepEqual(errors, []);
  report.complete = true; console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); server.kill(); }
