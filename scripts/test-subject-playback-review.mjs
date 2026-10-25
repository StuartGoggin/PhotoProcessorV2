import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

// Approved seam: the human review controls and the retained resulting media.
// Browser playback is technical evidence only, never visual quality acceptance.
const root = path.resolve('test-output');
const comparison = 'subject-cached-throughput-3Fq7V9';
const originals = 'subject-footage-evaluation-1791597148390';
const pagePath = path.join(root, comparison, 'playback-review.html');
const receiptPath = path.join(root, comparison, 'receipt.json');
const receiptBefore = await readFile(receiptPath);
const fixtures = [
  [`/${originals}/black-horse/bounded-normalized-excerpt.mp4`, 'e252b692c87d81e56d6f8c1f38541ea3bb3bd184ac70cb501aba5ce364dca59a'],
  [`/${comparison}/black-horse-cpu.mp4`, 'b30482994c4cab70a6d41ece42cfa87b78c42acf21e857c69aaea3c6ba84f120'],
  [`/${originals}/white-horse/bounded-normalized-excerpt.mp4`, 'aa0bb9a813cc9eda18368005438986fcc907b23cdf8f738daae3f0b0397bfcc6'],
  [`/${comparison}/white-horse-cpu.mp4`, '6896a4e9332b888836978ea211ab68ca6764a389679fa77198301228508740d1'],
];
for (const [url, expected] of fixtures) {
  const bytes = await readFile(path.join(root, url.slice(1)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Retained media identity: ${url}`);
}
const html = await readFile(pagePath);
const media = new Map(fixtures.map(([url]) => [url, path.join(root, url.slice(1))]));
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1').pathname;
    if (url === `/${comparison}/playback-review.html`) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : html); return;
    }
    const file = media.get(url);
    if (!file) { res.writeHead(404).end(); return; }
    const { size } = await stat(file);
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : size - 1;
    if ((req.headers.range && !range) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/${comparison}/playback-review.html`);
  await page.getByRole('heading', { name: 'Subject finishing · motion review', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 4 && [...document.querySelectorAll('video')].every(video => video.readyState >= 1));
  const metadata = await page.locator('video').evaluateAll(videos => videos.map(video => ({
    width: video.videoWidth, height: video.videoHeight, duration: video.duration, rate: video.playbackRate,
  })));
  assert.deepEqual(metadata, Array.from({ length: 4 }, () => ({ width: 3840, height: 2160, duration: 2, rate: 1 })), 'Both real Before/After pairs load at their retained UHD dimensions and normal speed');
  const terminal = /^(Playback ended|Players diverged|Browser buffering|Browser stalled|Playback could not start)/;
  const outcomes = [];
  const start = async sample => {
    const section = page.locator(`[data-sample="${sample}"]`);
    await section.getByRole('button', { name: 'Play both · normal speed', exact: true }).click();
    await page.waitForFunction(sample => {
      const section = document.querySelector(`[data-sample="${sample}"]`);
      return [...section.querySelectorAll('video')].every(video => !video.paused && video.currentTime > 0.1 && video.playbackRate === 1) || /^(Players diverged|Browser buffering|Browser stalled|Playback could not start)/.test(section.querySelector('[role="status"]').textContent);
    }, sample, { timeout: 15000 });
    return !(terminal.test(await section.getByRole('status').textContent()));
  };
  for (const sample of ['black-horse', 'white-horse']) {
    const section = page.locator(`[data-sample="${sample}"]`);
    await start(sample);
    await section.getByRole('button', { name: 'Pause both', exact: true }).click();
    assert.equal(await section.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
    await section.getByRole('button', { name: 'Restart both', exact: true }).click();
    await page.waitForFunction(sample => [...document.querySelector(`[data-sample="${sample}"]`).querySelectorAll('video')].every(video => video.paused && video.currentTime === 0), sample);
    await section.getByRole('button', { name: 'Play both · normal speed', exact: true }).click();
    await page.waitForFunction(sample => /^(Playback ended|Players diverged|Browser buffering|Browser stalled|Playback could not start)/.test(document.querySelector(`[data-sample="${sample}"] [role="status"]`).textContent), sample, { timeout: 15000 });
    const status = await section.getByRole('status').textContent();
    const completed = status.startsWith('Playback ended');
    assert.equal(await section.locator('video').evaluateAll((videos, completed) => videos.every(video => completed ? video.ended : video.paused), completed), true, 'Host either reaches end or safely refuses the unsuitable pair');
    outcomes.push({ sample, outcome: completed ? 'completed' : 'protective-refusal', status });
  }
  // Public native seek creates an unsuitable comparison, which must stop with a
  // visible warning rather than silently allowing it to imply synchronized motion.
  const black = page.locator('[data-sample="black-horse"]');
  let nativeSeekRefusalObserved = false;
  let nativePauseRefusalObserved = false;
  if (await start('black-horse')) {
    await black.getByLabel('Black horse Before', { exact: true }).evaluate(video => { video.currentTime = 1.25; });
    await black.getByRole('status').filter({ hasText: 'Native seek changed — paired playback cancelled' }).waitFor({ timeout: 10000 });
    assert.equal(await black.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true, 'Independent native seek cancels paired observation');
    nativeSeekRefusalObserved = true;
  }
  await black.getByRole('button', { name: 'Restart both', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelector('[data-sample="black-horse"]').querySelectorAll('video')].every(video => video.paused && video.currentTime === 0));
  if (await start('black-horse')) {
    await black.getByLabel('Black horse Before', { exact: true }).evaluate(video => video.pause());
    await black.getByRole('status').filter({ hasText: 'Native controls changed — paired playback cancelled' }).waitFor({ timeout: 10000 });
    assert.equal(await black.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
    nativePauseRefusalObserved = true;
  }
  await black.getByRole('button', { name: 'Restart both', exact: true }).click();
  await black.getByRole('textbox', { name: 'Black horse review notes', exact: true }).fill('Human observation still pending.');
  await black.getByRole('button', { name: 'Restart both', exact: true }).click();
  assert.equal(await black.getByRole('textbox', { name: 'Black horse review notes', exact: true }).inputValue(), 'Human observation still pending.');
  assert.deepEqual(await readFile(receiptPath), receiptBefore, 'Technical playback must not alter the authoritative media/quality receipt');
  assert.deepEqual(errors, []);
  // Faults are injected only at the browser's public media API boundary. They
  // exercise request ownership, not codec throughput or a visual-quality pass.
  const fault = await browser.newPage();
  await fault.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await fault.goto(`http://127.0.0.1:${server.address().port}/${comparison}/playback-review.html`);
  await fault.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState === 4));
  const faultBlack = fault.locator('[data-sample="black-horse"]');
  await fault.evaluate(() => {
    const videos = [...document.querySelector('[data-sample="black-horse"]').querySelectorAll('video')];
    videos.forEach(video => Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 }));
    window.releaseBuffer = () => videos.forEach(video => { delete video.readyState; video.dispatchEvent(new Event('canplaythrough')); });
  });
  await faultBlack.getByRole('button', { name: 'Play both · normal speed', exact: true }).click();
  await faultBlack.getByRole('status').filter({ hasText: 'Buffering both' }).waitFor();
  await faultBlack.getByRole('button', { name: 'Pause both', exact: true }).click();
  assert.equal(await faultBlack.getByRole('button', { name: 'Play both · normal speed', exact: true }).isDisabled(), true, 'A cancelled start stays bounded until its outstanding browser wait settles');
  await fault.evaluate(() => window.releaseBuffer());
  await fault.waitForFunction(() => !document.querySelector('[data-sample="black-horse"] [data-action="play"]').disabled);
  assert.equal(await faultBlack.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
  assert.match(await faultBlack.getByRole('status').textContent(), /^Paused/, 'A late buffering reply must not start a cancelled pair');
  await fault.evaluate(() => {
    window.heldPlayReplies = [];
    for (const video of document.querySelector('[data-sample="black-horse"]').querySelectorAll('video')) {
      video.play = function () { return HTMLMediaElement.prototype.play.call(this).then(() => new Promise(resolve => window.heldPlayReplies.push(resolve))); };
    }
  });
  await faultBlack.getByRole('button', { name: 'Play both · normal speed', exact: true }).click();
  await fault.waitForFunction(() => window.heldPlayReplies.length === 2);
  await faultBlack.getByRole('button', { name: 'Pause both', exact: true }).click();
  assert.equal(await faultBlack.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
  await fault.evaluate(() => window.heldPlayReplies.splice(0).forEach(resolve => resolve()));
  await fault.waitForFunction(() => !document.querySelector('[data-sample="black-horse"] [data-action="play"]').disabled);
  assert.match(await faultBlack.getByRole('status').textContent(), /^Paused/, 'Late start acknowledgments must not revive a cancelled paired-run status');
  await faultBlack.getByRole('button', { name: 'Restart both', exact: true }).click();
  await faultBlack.getByRole('button', { name: 'Play both · normal speed', exact: true }).click();
  await fault.waitForFunction(() => window.heldPlayReplies.length === 2);
  await fault.locator('[data-sample="white-horse"]').getByRole('button', { name: 'Play both · normal speed', exact: true }).click();
  await fault.evaluate(() => window.heldPlayReplies.splice(0).forEach(resolve => resolve()));
  await fault.waitForFunction(() => !document.querySelector('[data-sample="black-horse"] [data-action="play"]').disabled);
  assert.equal(await faultBlack.locator('video').evaluateAll(videos => videos.every(video => video.paused)), true);
  assert.match(await faultBlack.getByRole('status').textContent(), /^Paused/, 'Selecting the other pair owns the observation; old start replies stay stale');
  await fault.close();
  const evidence = path.join(root, `subject-playback-controls-${Date.now()}`);
  await mkdir(evidence);
  await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 540, height: 900 });
  await page.screenshot({ path: path.join(evidence, 'compact.png'), fullPage: true });
  await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({
    schema: 1, pageSha256: createHash('sha256').update(html).digest('hex'),
    inputSha256: fixtures.map(([url, sha256]) => ({ url, sha256 })),
    realMediaLoaded: true, outcomes, bothNormalSpeedEndStatesObserved: outcomes.every(result => result.outcome === 'completed'),
    nativeSeekRefusalObserved, nativePauseRefusalObserved,
    browserBoundaryFaultFixtures: { cancelledBufferWait: true, cancelledPendingStart: true, oldPairAfterSelectionChange: true },
    notesPreservedOnRestart: true, mediaReceiptUnchanged: true,
    continuousVisualQualityReviewed: false, subjectQualityAccepted: false, exportQualified: false,
    scope: 'Existing two-second CPU outputs and browser control behavior only; no current-mask, stabilized-base, full-clip, RTX, installer or human visual acceptance.',
  }, null, 2));
  console.log(`PASS: exact UHD Before/After pairs, safe host-specific playback outcomes, reset/notes and unchanged acceptance receipt. Technical controls only. Evidence: ${evidence}`);
} catch (error) {
  if (page) console.error(JSON.stringify(await page.locator('[data-sample]').evaluateAll(sections => sections.map(section => ({
    sample: section.dataset.sample, status: section.querySelector('[role="status"]').textContent,
    videos: [...section.querySelectorAll('video')].map(video => ({ label: video.ariaLabel, time: video.currentTime, paused: video.paused, readyState: video.readyState, error: video.error?.message ?? null })),
  }))), null, 2));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
