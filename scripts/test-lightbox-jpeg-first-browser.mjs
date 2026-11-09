import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Real Review page with synthetic file/account IPC. Never opens user photos.
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : 'playwright');
const output = 'test-output/lightbox-jpeg-first-browser';
const base = 'http://127.0.0.1:1482';
const root = 'D:\\Controller photos';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1482', '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, activePage;
const results = [], errors = [];
server.stdout.on('data', value => logs += value);
server.stderr.on('data', value => logs += value);
const tree = page => page.getByRole('tree', { name: 'Original photo folders' });
const quick = (page, name) => page.getByRole('group', { name: 'Photo quick views' }).getByRole('button', { name, exact: true });
const frameName = index => `20261109_100000_frame-${String(index).padStart(4, '0')}.jpg`;

async function fixture(options = {}, documents = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ options, documents }) => {
    window.__browseTest = true;
    Object.assign(window, options);
    localStorage.setItem('photogogo.lightbox.browse.v1', JSON.stringify({ quick: 'all', trash: 'include', sort: 'name', direction: 'asc' }));
    localStorage.setItem('fixture.review.documents', JSON.stringify(documents));
  }, { options, documents });
  await page.goto(base + '/lightbox-controls-preview.html', { waitUntil: 'domcontentloaded' });
  await tree(page).waitFor();
  activePage = page;
  return page;
}

async function image(page, path, label, expectedRoot = root) {
  await page.waitForFunction(async ({ path, label, expectedRoot }) => {
    for (const img of document.querySelectorAll('.review-images img')) {
      if (label && img.alt !== label || !img.complete || !img.naturalWidth) continue;
      const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const payload = window.__controlsPayloads.get(btoa(binary));
      if (payload?.path === path && payload.root === expectedRoot) return true;
    }
    return false;
  }, { path, label, expectedRoot }, { timeout: 6000 });
}

async function count(page, shown, total) {
  const expected = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} originals`;
  try { await page.waitForFunction(expected => document.querySelector('[aria-label="Matching photo count"]')?.textContent === expected, expected, { timeout: 4500 }); }
  catch { assert.equal(await page.getByLabel('Matching photo count').textContent(), expected); }
}

async function settled(page, label = 'Original') {
  await page.waitForFunction(label => {
    const input = document.querySelector(`input[aria-label="Upload ${label} to Google Photos"]`);
    return input && !input.disabled;
  }, label);
}

async function openFolder(page, name) {
  const folders = tree(page).locator('[data-event-folder]');
  for (const folder of await folders.all()) {
    if (await folder.getAttribute('data-event-folder') !== name && await folder.getAttribute('aria-expanded') === 'true') await folder.click();
  }
  const target = tree(page).locator('[data-event-folder]').filter({ has: page.getByText(name, { exact: true }) });
  if (await target.getAttribute('aria-expanded') !== 'true') await target.click();
}

async function group(name, test) {
  if (process.env.JPEG_FIRST_CASE && !name.includes(process.env.JPEG_FIRST_CASE)) return;
  const start = performance.now();
  try {
    await test(); results.push({ name, passed: true, durationMs: Math.round(performance.now() - start) });
    console.log('PASS ' + name);
  } catch (error) {
    const number = results.length + 1;
    await activePage?.screenshot({ path: `${output}/failure-${number}.png` }).catch(() => {});
    results.push({ name, passed: false, error: error.stack, durationMs: Math.round(performance.now() - start) });
    console.error('FAIL ' + name + ': ' + error.message);
  } finally { await activePage?.close().catch(() => {}); activePage = undefined; }
}

function reviewDocument(entries) { return { schemaVersion: 1, revision: 1, entries }; }
function rootDocument(entries, folder = '', sourceRoot = root) { return { [JSON.stringify([sourceRoot, folder])]: reviewDocument(entries) }; }

try {
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try { if ((await fetch(base + '/lightbox-controls-preview.html')).ok) { started = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(started, logs);
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  await group('Historical 888 originals / 588 confirmed selections leave 300 needing review without migration writes', async () => {
    const flags = Object.fromEntries(Array.from({ length: 588 }, (_, index) => [frameName(index), { selected: true, favourite: false }]));
    const page = await fixture({ __controlsLargeCount: 888, __controlsInitialFlags: flags });
    await image(page, frameName(0), 'Original'); await settled(page);
    await count(page, 888, 888);
    await quick(page, 'Google-selected').click(); await count(page, 588, 888);
    await quick(page, 'Needs review').click(); await count(page, 300, 888);
    await image(page, frameName(588), 'Original');
    await page.screenshot({ path: output + '/legacy-needs-review.png' });
    assert.equal(await page.evaluate(() => window.__controlsReviewWrites.length), 0, 'opening historical review must not rewrite metadata');
    await quick(page, 'Reviewed').click(); await count(page, 588, 888);
  });

  await group('Exact B&W/Enhanced historical selections mark their original reviewed without adding derived navigation rows', async () => {
    const page = await fixture({ __controlsInitialFlags: { '01-horse_BW.jpg': { selected: true, favourite: false }, '02-rider_improved.jpg': { selected: false, favourite: true } } });
    await image(page, '01-horse.jpg', 'Original'); await settled(page);
    await image(page, '01-horse_BW.jpg', 'B&W'); await image(page, '01-horse_improved.jpg', 'Enhanced');
    await quick(page, 'Needs review').click(); await count(page, 1, 3); await image(page, '03-wide.jpg', 'Original');
    assert.equal(await tree(page).getByText('01-horse_BW.jpg', { exact: true }).count(), 0);
    assert.equal(await tree(page).getByText('02-rider_improved.jpg', { exact: true }).count(), 0);
    await quick(page, 'Reviewed').click(); await count(page, 2, 3);
  });

  await group('Explicit current Reviewed false overrides historical positive while stale explicit records stay uncertain', async () => {
    const names = Array.from({ length: 3 }, (_, index) => frameName(index));
    const flags = Object.fromEntries(names.map(name => [name, { selected: true, favourite: false }]));
    const docs = rootDocument({
      [names[0]]: { reviewed: false, sourceStamp: '1:1' },
      [names[1]]: { reviewed: true, sourceStamp: 'old-source' },
      [names[2]]: { reviewed: true, sourceStamp: '3:1' },
    });
    const page = await fixture({ __controlsLargeCount: 3, __controlsInitialFlags: flags }, docs);
    await image(page, names[0], 'Original'); await settled(page);
    await quick(page, 'Needs review').click(); await count(page, 2, 3);
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1);
    await tree(page).getByText(names[1], { exact: true }).click(); await image(page, names[1], 'Original');
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1, 'stale true must not be trusted through a historical positive flag');
    assert.equal(await page.evaluate(() => window.__controlsReviewWrites.length), 0);
  });

  await group('Corrupt review history cannot be bypassed by historical positive flags', async () => {
    const page = await fixture({ __controlsBadReview: true, __controlsLargeCount: 1, __controlsInitialFlags: { [frameName(0)]: { selected: true, favourite: true } } });
    await image(page, frameName(0), 'Original');
    await page.getByLabel('Folder review information').waitFor();
    await quick(page, 'Needs review').click(); await count(page, 1, 1);
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__controlsReviewWrites.length), 0);
  });

  await group('Verified capture uses JPEG tree label and comparisons while Reviewed keeps canonical RAW identity', async () => {
    const page = await fixture({ __controlsRawFixture: true, __controlsFileSizes: { '01-horse.CR3': 90000000, '01-horse.JPG': 5000000 } });
    await image(page, '01-horse.JPG', 'Camera JPEG'); await settled(page, 'Camera JPEG');
    await image(page, '01-horse_BW.jpg', 'B&W'); await image(page, '01-horse_improved.jpg', 'Enhanced');
    assert.equal(await tree(page).getByText('01-horse.JPG', { exact: true }).count(), 1, 'verified capture must be labelled with its default Camera JPEG');
    assert.equal(await tree(page).getByText('01-horse.CR3', { exact: true }).count(), 0, 'verified Camera JPEG is one navigation row, not a separate RAW row');
    assert.match(await tree(page).getByRole('treeitem').filter({ has: page.getByText('01-horse.JPG', { exact: true }) }).textContent(), /4\.8MB/, 'visible row size must describe the displayed JPEG, not its canonical RAW');
    await count(page, 2, 2);
    await page.screenshot({ path: output + '/jpeg-first-paired.png' });
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await page.waitForFunction(() => window.__controlsReviewWrites.length === 1);
    assert.deepEqual(await page.evaluate(() => ({ path: window.__controlsReviewWrites[0].relativePath, stamp: window.__controlsReviewWrites[0].sourceStamp })), { path: '01-horse.CR3', stamp: '90000000:1' });
    await page.getByLabel('Upload Camera JPEG to Google Photos', { exact: true }).check();
    await page.waitForFunction(() => window.__controlsSelectionWrites.length === 1);
    assert.equal(await page.evaluate(() => window.__controlsSelectionWrites[0].relativePath), '01-horse.JPG');
  });

  await group('Explicit current canonical RAW Reviewed false overrides a paired JPEG historical selection', async () => {
    const docs = rootDocument({ '01-horse.cr3': { reviewed: false, sourceStamp: '32768:1' } });
    const page = await fixture({ __controlsRawFixture: true, __controlsInitialFlags: { '01-horse.JPG': { selected: true, favourite: true } } }, docs);
    await image(page, '01-horse.JPG', 'Camera JPEG'); await settled(page, 'Camera JPEG');
    await quick(page, 'Needs review').click(); await count(page, 2, 2);
    await image(page, '01-horse.JPG', 'Camera JPEG');
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.__controlsReviewWrites.length), 0);
  });

  await group('Per-photo RAW alternative remains opt-in and does not change JPEG upload choices', async () => {
    const page = await fixture({ __controlsRawFixture: true });
    await image(page, '01-horse.JPG', 'Camera JPEG'); await settled(page, 'Camera JPEG');
    await page.getByLabel('Original source', { exact: true }).selectOption('raw');
    await image(page, '01-horse.CR3', 'Original RAW'); await settled(page, 'Original RAW');
    await page.getByRole('button', { name: 'Develop RAW alternative', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Develop RAW alternative', exact: true });
    await dialog.waitFor(); await dialog.getByText('01-horse.CR3', { exact: false }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__controlsSelectionWrites.length), 0);
    assert.equal(await page.evaluate(() => (window.__controlsRawJobs || []).length), 0, 'opening RAW editor must not queue development');
  });

  await group('Pending pair inspection shows JPEG once, then keeps RAW-only and unmatched photos accessible', async () => {
    const page = await fixture({ __controlsJpegFirstPairs: true, __controlsDeferMetadata: true });
    await openFolder(page, 'Event');
    await tree(page).getByText('01-horse.JPG', { exact: true }).click();
    await image(page, 'Event/01-horse.JPG');
    assert.equal(await tree(page).getByText('01-horse.JPG', { exact: true }).count(), 1);
    assert.equal(await tree(page).getByText('01-horse.CR3', { exact: true }).count(), 0, 'pending same-stem RAW must not flash as a duplicate review row');
    assert.equal(await tree(page).getByText('03-raw-only.CR3', { exact: true }).count(), 0, 'mixed-folder RAW alternatives are opt-in');
    assert.equal(await tree(page).getByText('04-unmatched.CR3', { exact: true }).count(), 0);
    await page.evaluate(() => { window.__controlsDeferMetadata = false; window.__controlsReleaseMetadata(); });
    await settled(page, 'Camera JPEG'); await count(page, 3, 5);
    await image(page, 'Event/01-horse.JPG', 'Camera JPEG');
    assert.equal(await tree(page).getByText('01-horse.JPG', { exact: true }).count(), 1);
    assert.equal(await tree(page).getByText('01-horse.CR3', { exact: true }).count(), 0);
    await page.getByRole('checkbox', { name: /^Show unpaired RAW files/ }).check(); await count(page, 5, 5);
    await tree(page).getByText('03-raw-only.CR3', { exact: true }).click(); await image(page, 'Event/03-raw-only.CR3', 'Original RAW');
    assert.equal(await page.getByRole('button', { name: 'Develop RAW alternative', exact: true }).isEnabled(), true);
    await tree(page).getByText('04-unmatched.CR3', { exact: true }).click(); await image(page, 'Event/04-unmatched.CR3', 'Original RAW');
    await tree(page).getByText('04-different.JPG', { exact: true }).click(); await image(page, 'Event/04-different.JPG', 'Original');
    await page.getByRole('checkbox', { name: /^Show unpaired RAW files/ }).uncheck();
    await openFolder(page, 'RawOnly');
    await tree(page).getByText('only.CR3', { exact: true }).click(); await image(page, 'RawOnly/only.CR3', 'Original RAW'); await count(page, 1, 1);
  });

  await group('Identical names in other roots and folders cannot inherit a review decision or image identity', async () => {
    const page = await fixture({}, rootDocument({ '01-horse.jpg': { reviewed: true, sourceStamp: '32768:1' } }));
    await image(page, '01-horse.jpg', 'Original'); await settled(page);
    await quick(page, 'Needs review').click(); await count(page, 2, 3);
    await page.evaluate(root => {
      const lib = window.__controlsLibraries.get(root);
      window.__controlsLibraries.set('E:\\Other photos', { tree: structuredClone(lib.tree), flags: new Map() });
      window.__controlsSwitchRoot('E:\\Other photos');
    }, root);
    await image(page, '01-horse.jpg', 'Original', 'E:\\Other photos'); await count(page, 3, 3);
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1);
    await openFolder(page, 'Event'); await tree(page).getByText('04-finish.jpg', { exact: true }).click();
    await image(page, 'Event/04-finish.jpg', 'Original', 'E:\\Other photos'); await count(page, 1, 1);
    assert.equal(await page.evaluate(() => window.__controlsReviewWrites.length), 0);
  });

  await group('Identical paired capture names in sibling folders cannot share historical flags or explicit review state', async () => {
    const docs = rootDocument({ '01-horse.cr3': { reviewed: true, sourceStamp: '32768:1' } }, 'Event');
    const page = await fixture({ __controlsJpegFirstPairs: true, __controlsInitialFlags: { 'Event/01-horse.JPG': { selected: true, favourite: true } } }, docs);
    await openFolder(page, 'Event'); await tree(page).getByText('01-horse.JPG', { exact: true }).click();
    await image(page, 'Event/01-horse.JPG', 'Camera JPEG'); await settled(page, 'Camera JPEG');
    assert.equal(await page.getByLabel('Upload Camera JPEG to Google Photos', { exact: true }).isChecked(), true);
    await quick(page, 'Needs review').click(); await count(page, 2, 5);
    await openFolder(page, 'Elsewhere'); await tree(page).getByText('01-horse.JPG', { exact: true }).click();
    await image(page, 'Elsewhere/01-horse.JPG', 'Camera JPEG'); await settled(page, 'Camera JPEG'); await count(page, 3, 5);
    assert.equal(await page.getByLabel('Upload Camera JPEG to Google Photos', { exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.__controlsReviewWrites.length), 0);
  });
} catch (error) {
  results.push({ name: 'Test harness startup', passed: false, error: error.stack });
} finally {
  await browser?.close(); server.kill();
  const report = { complete: true, scope: 'Actual Photo Lightbox page, synthetic IPC only; no user media, native controller or Google account access.', passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, checks: results, errors, serverLog: logs };
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors }));
  if (report.failed || errors.length) process.exitCode = 1;
}
