// Polling regression: actual App and hooks, controlled desktop IPC latency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : 'playwright');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1432', '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, serverLog = '';
server.stdout.on('data', data => { serverLog += data; });
server.stderr.on('data', data => { serverLog += data; });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch('http://127.0.0.1:1432/studio-preview.html')).ok) { ready = true; break; } } catch {}
    await delay(200);
  }
  assert.ok(ready, 'Fixture server started');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('http://127.0.0.1:1432/studio-preview.html');
  await page.getByRole('region', { name: 'Active jobs list', exact: true }).waitFor();
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__flickerOriginalJobs = { studio: window.__studioJobs, imports: window.__importJobs };
    window.__flickerDelay = 150;
    window.__flickerPending = {};
    window.__flickerMaxPending = {};
    window.__flickerCalls = {};
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (['list_import_jobs', 'list_process_jobs', 'studio_list_jobs'].includes(command)) {
        window.__flickerCalls[command] = (window.__flickerCalls[command] || 0) + 1;
        window.__flickerPending[command] = (window.__flickerPending[command] || 0) + 1;
        window.__flickerMaxPending[command] = Math.max(window.__flickerMaxPending[command] || 0, window.__flickerPending[command]);
        try {
          const snapshot = structuredClone(await invoke(command, args));
          await new Promise(resolve => setTimeout(resolve, window.__flickerDelay));
          if (window.__flickerFail) throw new Error('Controlled fixture polling failure');
          return snapshot;
        } finally { window.__flickerPending[command]--; }
      }
      return invoke(command, args);
    };
  });
  const results = [];
  for (const mode of ['active', 'active-error', 'empty', 'error']) {
    await page.evaluate(mode => {
      window.__studioJobs = mode.startsWith('active') ? window.__flickerOriginalJobs.studio : [];
      window.__importJobs = mode.startsWith('active') ? window.__flickerOriginalJobs.imports : [];
      window.__flickerFail = mode.endsWith('error');
    }, mode);
    await delay(900);
    const measurement = await page.evaluate(async () => {
      const panel = document.querySelector('.jobs-panel');
      const main = document.querySelector('main');
      const originalTiles = [...panel.querySelectorAll('.job-tile')];
      const heights = new Set(), mainHeights = new Set(), checking = new Set(), errors = new Set();
      let removedTiles = 0, frames = 0;
      const started = performance.now();
      await new Promise(resolve => {
        function sample() {
          frames++;
          heights.add(panel.getBoundingClientRect().height);
          mainHeights.add(main.getBoundingClientRect().height);
          checking.add(panel.textContent.includes('Checking jobs'));
          errors.add(!!panel.querySelector('[role="alert"]'));
          removedTiles = Math.max(removedTiles, originalTiles.filter(tile => !tile.isConnected).length);
          if (performance.now() - started < 2200) requestAnimationFrame(sample); else resolve();
        }
        requestAnimationFrame(sample);
      });
      return { frames, tileCount: originalTiles.length, panelHeights: [...heights], mainHeights: [...mainHeights], checkingVisible: [...checking], errorVisible: [...errors], removedTiles };
    });
    results.push({ mode, ...measurement });
  }
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(result => result.panelHeights.length === 1 && result.mainHeights.length === 1), 'unchanged job snapshots must not resize the frame or page during polling');
  assert.ok(results.every(result => result.removedTiles === 0), 'polling must preserve existing job tiles');
  assert.deepEqual(results.find(result => result.mode === 'error').errorVisible, [true], 'poll errors must remain visible until a successful refresh');
  assert.equal(results.find(result => result.mode === 'active-error').tileCount, results.find(result => result.mode === 'active').tileCount, 'failed polls must retain the last good job list');
  assert.ok(results.find(result => result.mode === 'active').tileCount > 0, 'active scenario must exercise real tiles');
  await page.evaluate(() => { window.__flickerFail = false; });
  await page.waitForFunction(() => !document.querySelector('.jobs-panel [role="alert"]'));

  // A response slower than the 500 ms poll interval must not spawn more polls.
  await page.evaluate(() => { window.__flickerDelay = 800; window.__flickerMaxPending = {}; window.__flickerCalls = {}; });
  await delay(2400);
  const slow = await page.evaluate(() => ({ max: window.__flickerMaxPending, calls: window.__flickerCalls }));
  assert.equal(slow.max.list_import_jobs, 1, 'slow responses must not overlap monitor polls');
  assert.ok(slow.calls.list_import_jobs >= 2, 'polling must continue after slow responses');
  await page.evaluate(() => { window.__flickerDelay = 150; });
  await delay(900);

  const waitMessage = 'Waiting for memory: 2231 MiB available; approximately 1018 MiB for this worker + 2026 MiB Windows headroom required. Resumes automatically.';
  await page.evaluate(message => {
    const job = structuredClone(window.__flickerOriginalJobs.studio.find(job => job.status === 'running'));
    job.phase = message; job.activeTasks = []; job.processId = null; job.etaSeconds = null;
    window.__studioJobs = [job];
  }, waitMessage);
  const waitingTile = page.locator('.jobs-panel .job-tile');
  await waitingTile.getByText(waitMessage, { exact: true }).waitFor();
  assert.equal(await waitingTile.getByRole('button', { name: 'Pause', exact: true }).isEnabled(), true);
  assert.equal(await waitingTile.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
  assert.equal(await waitingTile.getByRole('button', { name: 'Resume saved render', exact: true }).count(), 0, 'a RAM wait must not appear as a failed attempt');
  await page.evaluate(() => { window.__studioJobs[0].phase = 'Render resumed after memory recovery'; });
  await waitingTile.getByText('Render resumed after memory recovery', { exact: true }).waitFor();
  await page.evaluate(() => { window.__studioJobs = []; });
  await page.locator('.jobs-panel').getByText('No active jobs', { exact: true }).waitFor();

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Jobs/ }).click();
  await page.getByText('No import or post-process jobs yet.', { exact: true }).waitFor();
  const jobsPage = await page.evaluate(async () => {
    const container = document.querySelector('.jobs-page');
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh');
    const disabled = new Set(), checking = new Set();
    const started = performance.now();
    await new Promise(resolve => {
      function sample() {
        disabled.add(refresh.disabled);
        checking.add(container.textContent.includes('Checking import and post-process jobs'));
        if (performance.now() - started < 2200) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    return { disabled: [...disabled], checking: [...checking] };
  });
  console.log('Jobs page:', jobsPage);
  assert.deepEqual(jobsPage.disabled, [false], 'background polls must not flash the Refresh button');
  assert.deepEqual(jobsPage.checking, [false], 'background polls must not replace the empty-state message');
  await page.getByLabel('Tail (auto-refresh)').uncheck();
  const refresh = page.locator('.jobs-page').getByRole('button', { name: 'Refresh', exact: true });
  await refresh.click();
  assert.equal(await refresh.isDisabled(), true, 'manual Refresh must still give loading feedback');
  await page.waitForFunction(() => ![...document.querySelectorAll('.jobs-page button')].find(button => button.textContent.trim() === 'Refresh').disabled);
  assert.deepEqual(failures, [], 'no browser runtime errors');
  console.log('PASS: steady polling, RAM-wait controls and recovery, persistent errors and manual refresh.');
} finally { await browser?.close(); server.kill(); }
