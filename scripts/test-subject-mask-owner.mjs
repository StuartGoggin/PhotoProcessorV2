import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const worker = resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const python = 'C:/Users/Stuart Goggin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const script = resolve('scripts/subject-finishing/test-mask-job-owner.py');
const ff = process.env.PHOTOGOGO_FFMPEG ?? 'C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
function args(seconds) {
  const root = mkdtempSync(resolve('test-output/subject-mask-owner-'));
  const request = join(root, 'request.json'); writeFileSync(request, '{}');
  return ['--mask-job', python, script, request, root, ff, String(seconds)];
}
function absent(ids) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$remainingMaskOwners = @(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue); if ($remainingMaskOwners.Count) { exit 1 }`],
    { windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, 'Mask cancellation or deadline left an owned descendant running');
}
test('mask-job deadline kills the Python process and its FFmpeg descendant', () => {
  const result = spawnSync(worker, args(1), { timeout: 8000, windowsHide: true,
    env:{...process.env,PHOTOGOGO_OWNER_SECRET:'must-not-be-inherited',CUDA_PATH:'untrusted-synthetic-path'} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /Mask job exceeded its bounded deadline/);
  const receipt = JSON.parse(result.stdout.toString().trim());
  assert.equal(receipt.event, 'ownerFixture'); absent([receipt.child]);
  assert.equal(receipt.controlledEnvironment,true);
});
test('cancelling a mask owner kills Python and its already-started decoder', async () => {
  const child = spawn(worker, args(60), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env:{...process.env,PHOTOGOGO_OWNER_SECRET:'must-not-be-inherited',CUDA_PATH:'untrusted-synthetic-path'} });
  let output = '', errors = '', descendant = null, pythonId = null;
  const timer = setTimeout(() => child.kill(), 8000);
  child.stderr.on('data', chunk => {
    errors += chunk;
    for (const line of errors.split(/\r?\n/).slice(0, -1)) {
      const receipt = JSON.parse(line);
      if (receipt.event === 'maskJobStarted') pythonId = receipt.child;
    }
  });
  child.stdout.on('data', chunk => {
    output += chunk;
    const line = output.split(/\r?\n/).slice(0, -1)[0];
    if (line) { descendant = JSON.parse(line).child; child.kill(); }
  });
  try { await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); }); }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  assert.ok(descendant > 0 && pythonId > 0, errors);
  absent([descendant, pythonId]); assert.doesNotMatch(errors, /maskJobFinished/);
});
