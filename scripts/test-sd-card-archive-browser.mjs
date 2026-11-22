import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const url = "http://127.0.0.1:1496/sd-card-archive-preview.html";
const output = "test-output/sd-card-archive-browser";
const source = "E:\\";
const repository = "D:\\SD archives";
const folder = repository + "\\2026-11-21_SD-C8A0-12345678-00";
const id = "sd_archive_" + "a".repeat(32);
const totalBytes = 64 * 1024 ** 3;
await mkdir(output, { recursive: true });

const server = spawn(process.execPath, [
  "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1496", "--strictPort",
], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browser, page, serverLog = "";
const pageErrors = [];
const report = {
  complete: false,
  scope: "Actual PhotoGoGo UI and shared Jobs with controlled synthetic IPC. No attached SD card, repository or native copy was used.",
  checks: [],
  pageErrors,
};
server.stdout.on("data", chunk => { serverLog += chunk; });
server.stderr.on("data", chunk => { serverLog += chunk; });

async function check(label, test) {
  await test();
  report.checks.push(label);
  console.log("PASS " + label);
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await delay(150);
  }
  assert.ok(ready, "SD Card Archive browser fixture started");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(url);

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const openArchive = () => nav.getByRole("button", { name: /SD Card Archive/ }).click();
  const canon = page.getByRole("radio", { name: /CANON \(E:\)/ });
  const progress = page.getByRole("region", { name: "SD Card Archive progress" });
  const card = page.getByRole("article", { name: "Process job " + id, exact: true });
  const filter = page.getByRole("group", { name: "Filter jobs" });
  const calls = command => page.evaluate(command => window.__sdArchiveFixture.calls.filter(call => call.command === command), command);

  await check("Card detection evidence, keyboard help and manual fallback are clear", async () => {
    await openArchive();
    await page.getByRole("heading", { name: "SD Card Archive", exact: true }).waitFor();
    assert.equal(await page.getByRole("main").count(), 1);
    await canon.waitFor();
    await page.getByText("SD card · Windows reports an SD bus", { exact: true }).waitFor();
    await page.getByText("USB storage · media type unconfirmed", { exact: true }).waitFor();
    await page.getByText("128 GiB", { exact: true }).waitFor();
    const help = page.getByRole("button", { name: "How cards are identified" });
    await help.hover();
    await page.getByRole("tooltip").filter({ hasText: "only its USB reader" }).waitFor();
    await help.focus();
    await canon.hover();
    await page.getByRole("tooltip").filter({ hasText: "only its USB reader" }).waitFor();
    const browse = page.getByRole("button", { name: "Browse for card root" });
    assert.equal(await browse.count(), 0);
    await page.getByText("Card not listed?", { exact: true }).click();
    await page.evaluate(() => { window.__sdArchiveFixture.pick = "G:\\DCIM"; });
    await browse.click();
    await page.getByRole("alert").filter({ hasText: "Choose the card's drive root" }).waitFor();
    await page.evaluate(() => { window.__sdArchiveFixture.pick = "g:\\"; });
    await browse.click();
    await page.getByText("Manually selected · media type unconfirmed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh cards" }).click();
    await canon.waitFor();
    await page.getByText("Card not listed?", { exact: true }).click();
  });

  await check("Inspect works without a repository and only archive start waits for the destination", async () => {
    await page.getByText("Choose a repository to start archiving.").waitFor();
    assert.ok(await page.getByRole("button", { name: "Inspect card" }).isDisabled());
    await canon.check();
    assert.ok(await page.getByRole("button", { name: "Inspect card" }).isEnabled(), "Selecting a card enables read-only inspection even before choosing a repository");
    await page.screenshot({ path: output + "/source-selection.png" });
    await page.getByRole("button", { name: "Inspect card" }).click();
    await page.getByText("246 files · 14 folders", { exact: true }).waitFor();
    await page.getByText("Choose an SD Card Repository before starting the archive.", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Start archive" }).isDisabled());
    assert.equal((await calls("start_sd_card_archive")).length, 0);
    await page.evaluate(repository => { window.__sdArchiveFixture.pick = repository; }, repository);
    await page.getByRole("button", { name: "Repository settings" }).click();
    const setting = page.getByLabel("SD Card Repository", { exact: true });
    await setting.waitFor();
    await setting.locator("xpath=../..").getByRole("button", { name: "Browse..." }).click();
    await page.waitForFunction(repository => document.getElementById("setting-sd_card_repository").value === repository, repository);
    await page.getByRole("button", { name: "Save Settings" }).click();
    await page.getByText("✓ Saved").waitFor();
    const [save] = await calls("save_settings");
    assert.equal(save.args.settings.sd_card_repository, repository);
    assert.equal(save.args.settings.archive_dir, "D:\\Media archive");
    await openArchive();
    await page.getByText(repository, { exact: true }).waitFor();
    await canon.waitFor();
    assert.ok(await page.getByRole("button", { name: "Inspect card" }).isDisabled(), "the source must be explicitly selected");
  });

  await check("Inspection shows source, counts and free space and cannot start when the destination is too small", async () => {
    await canon.check();
    await page.getByRole("button", { name: "Inspect card" }).click();
    await page.getByText("246 files · 14 folders", { exact: true }).waitFor();
    await page.getByText("42 GiB", { exact: true }).waitFor();
    await page.getByRole("alert").filter({ hasText: "does not have enough free space" }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Start archive" }).isDisabled());
    assert.equal((await calls("start_sd_card_archive")).length, 0);
  });

  await check("A fresh inspection passes the exact preview token and manual archive date to the shared job", async () => {
    await page.evaluate(() => { window.__sdArchiveFixture.availableBytes = 256 * 1024 ** 3; });
    await page.getByRole("button", { name: "Inspect card" }).click();
    await page.getByText("256 GiB", { exact: true }).waitFor();
    await page.getByText(/Estimated date 2026-11-22 from file modification time/).waitFor();
    await page.getByLabel("Override archive date").fill("2026-11-21");
    await page.getByRole("button", { name: "Start archive" }).click();
    await progress.getByRole("status").filter({ hasText: "Copying" }).waitFor();
    assert.deepEqual((await calls("start_sd_card_archive")).map(call => call.args), [
      { token: "synthetic-card-preview", dateOverride: "2026-11-21" },
    ]);
  });

  await check("The live graphic uses distinct byte meters and measured transfer rates without showing reuse controls", async () => {
    assert.equal(await progress.getByRole("progressbar", { name: "Copied bytes" }).getAttribute("value"), String(24 * 1024 ** 3));
    assert.equal(await progress.getByRole("progressbar", { name: "Verified bytes" }).getAttribute("value"), String(18 * 1024 ** 3));
    assert.equal(await progress.getByRole("progressbar", { name: "Copied bytes" }).getAttribute("max"), String(totalBytes));
    await progress.getByText("91.5 MiB/s", { exact: true }).waitFor();
    await progress.getByText("87.2 MiB/s", { exact: true }).waitFor();
    assert.equal(await progress.getAttribute("data-verified"), "false");
    const jobTile = page.getByRole("button", { name: "SD Card Archive: running. Show console", exact: true });
    await jobTile.getByText("CANON (E:)", { exact: true }).waitFor();
    assert.equal(await progress.getByRole("button", { name: "Open archive folder" }).count(), 0);
    assert.equal(await page.getByText(/reformat the card manually/).count(), 0);
    await page.screenshot({ path: output + "/copying.png" });
  });

  await check("View in Jobs opens the same archive job and shared controls pause, resume, abort and retry it", async () => {
    await page.getByRole("button", { name: "View in Jobs" }).click();
    await page.getByRole("heading", { name: "Background Jobs" }).waitFor();
    await card.getByRole("region", { name: "SD Card Archive progress" }).waitFor();
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await card.getByText("Paused at a safe checkpoint", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Resume", exact: true }).click();
    await card.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await card.getByRole("button", { name: "Abort", exact: true }).click();
    await filter.getByRole("button", { name: "Needs attention", exact: true }).click();
    await card.getByText("Cancelled. Draft retained", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await filter.getByRole("button", { name: "Active", exact: true }).click();
    await card.getByRole("button", { name: "Pause", exact: true }).waitFor();
    for (const command of ["pause_process_job", "resume_process_job", "abort_process_job", "retry_process_job"]) {
      assert.deepEqual((await calls(command)).map(call => call.args), [{ jobId: id }]);
    }
  });

  await check("A missing date remains in Needs attention until that same job receives a date and retries", async () => {
    await page.evaluate(() => {
      const job = window.__sdArchiveFixture.jobs[0];
      Object.assign(job, { status: "needs_attention", currentPhase: "Verification incomplete", canContinue: false,
        errors: ["No reliable capture date was found. Enter an archive date and resume."] });
      Object.assign(job.sdCardArchive, { phase: "Verification incomplete", needsDate: true });
    });
    await filter.getByRole("button", { name: "Needs attention", exact: true }).click();
    const retry = card.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    assert.ok(await retry.isDisabled());
    assert.equal(await card.getByRole("button", { name: "Verify archive again" }).count(), 0);
    await card.getByLabel("Archive date", { exact: true }).fill("2026-11-21");
    await card.getByRole("button", { name: "Save date and retry" }).click();
    await page.waitForFunction(() => window.__sdArchiveFixture.calls.filter(call => call.command === "retry_process_job").length === 2);
    assert.deepEqual((await calls("set_sd_card_archive_date")).map(call => call.args), [{ jobId: id, date: "2026-11-21" }]);
    assert.deepEqual((await calls("retry_process_job")).at(-1).args, { jobId: id });
  });

  await check("Only verified completion enables folder and manifest actions and states that the card can be reformatted", async () => {
    await openArchive();
    await page.evaluate(total => {
      const job = window.__sdArchiveFixture.jobs[0];
      job.currentPhase = "Verifying";
      Object.assign(job.sdCardArchive, { copiedBytes: total, filesCopied: 246, phase: "Verifying", etaSeconds: null });
    }, totalBytes);
    await progress.getByRole("status").filter({ hasText: "Verifying" }).waitFor();
    assert.equal(await progress.getByRole("progressbar", { name: "Copied bytes" }).getAttribute("value"), String(totalBytes));
    assert.equal(await progress.getByRole("button", { name: "Open archive folder" }).count(), 0);
    assert.equal(await page.getByText(/reformat the card manually/).count(), 0);
    await page.evaluate(id => window.__sdArchiveFixture.complete(id), id);
    await progress.getByText(/You can now reformat the card manually/).waitFor();
    assert.equal(await progress.getAttribute("data-verified"), "true");
    await progress.getByRole("button", { name: "Open archive folder" }).click();
    await progress.getByRole("button", { name: "View checksums" }).click();
    const opened = await calls("open_in_default_app");
    assert.deepEqual(opened.map(call => call.args.path), [folder, folder + "\\2026-11-21_SD-C8A0-12345678-00.checksums.json"]);
    await page.screenshot({ path: output + "/verified.png" });
  });

  await check("Reverify by saved job or selected folder works with the source card absent", async () => {
    await page.evaluate(folder => {
      window.__sdArchiveFixture.mounted = false;
      window.__sdArchiveFixture.pick = folder;
    }, folder);
    await page.getByRole("button", { name: "Refresh cards" }).click();
    await page.getByRole("option", { name: "CANON (E:)" }).waitFor({ state: "detached" });
    await progress.getByRole("button", { name: "Verify archive again" }).click();
    await progress.getByRole("status").filter({ hasText: "Verifying" }).waitFor();
    assert.equal(await progress.getByRole("progressbar", { name: "Copied bytes" }).count(), 0);
    assert.equal(await progress.getByRole("button", { name: "Open archive folder" }).count(), 0);
    await page.evaluate(() => {
      const state = window.__sdArchiveFixture;
      state.complete(state.jobs[0].id);
    });
    await progress.getByText("The saved archive matches its checksum file.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Verify an archive folder" }).click();
    await page.waitForFunction(() => window.__sdArchiveFixture.verificationCount === 2);
    await progress.getByRole("status").filter({ hasText: "Verifying" }).waitFor();
    assert.deepEqual((await calls("verify_sd_card_archive")).map(call => call.args), [{ archiveJobId: id }, { folder }]);
    await page.evaluate(() => {
      const state = window.__sdArchiveFixture;
      state.complete(state.jobs[0].id);
    });
    await progress.getByText("The saved archive matches its checksum file.", { exact: true }).waitFor();
    assert.equal(await page.getByText(/reformat the card manually/).count(), 0);
  });

  await check("Narrow view uses a single-column progress card and respects reduced-motion settings", async () => {
    await page.setViewportSize({ width: 410, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const job = window.__sdArchiveFixture.jobs[0];
      Object.assign(job, { status: "running", currentPhase: "Verifying", done: 126, resultCount: 126 });
      Object.assign(job.sdCardArchive, {
        phase: "Verifying", archiveFolder: null, verifiedBytes: 33 * 1024 ** 3, filesVerified: 126,
      });
    });
    await progress.getByRole("status").filter({ hasText: "Verifying" }).waitFor();
    const layout = await progress.evaluate(node => {
      const main = node.closest(".app-main");
      const pulse = node.querySelector(".sd-archive-stream span");
      return { width: node.clientWidth, scrollWidth: node.scrollWidth, mainWidth: main.clientWidth,
        columns: getComputedStyle(node).gridTemplateColumns, animationName: getComputedStyle(pulse).animationName };
    });
    assert.ok(layout.width <= layout.mainWidth && layout.scrollWidth <= layout.width + 1, "archive graphic must fit the viewport");
    assert.equal(layout.columns.split(" ").length, 1);
    assert.equal(layout.animationName, "none");
    await page.screenshot({ path: output + "/narrow.png" });
  });

  assert.deepEqual(pageErrors, []);
  report.complete = true;
  console.log("SD Card Archive: " + report.checks.length + " browser checks passed.");
} catch (error) {
  report.error = String(error);
  report.serverLog = serverLog.slice(-5000);
  if (page) await page.screenshot({ path: output + "/failure.png" }).catch(() => {});
  throw error;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser?.close();
  server.kill();
}
