import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";

const worker = fileURLToPath(new URL("../src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe", import.meta.url));

test("compressed masks and inline masks produce the same picture, with malformed cache ownership rejected", () => {
  const width = 18, height = 12, source = fixture(width, height);
  const folder = mkdtempSync(resolve("test-output/subject-mask-stream-"));
  const path = join(folder, "mask.pgmask");
  const header = Buffer.alloc(20);
  header.write("PGMSK001"); header.writeUInt32LE(width, 8); header.writeUInt32LE(height, 12); header.writeUInt32LE(1, 16);
  const run = Buffer.alloc(9); run.writeUInt32LE(5); run.writeUInt32LE(width*height, 4); run[8] = 255;
  const good = Buffer.concat([header, run]);
  writeFileSync(path, good);
  const args = ["--finish-cached", String(width), String(height), "128", "32", "1", "cpu", "0", "1", "1", "0", "0", "0", "1", "1", "0", path];
  const cached = spawnSync(worker, args, { input: source, timeout: 30_000, maxBuffer: 1024*1024 });
  assert.equal(cached.status, 0, cached.stderr.toString());
  const inline = finish(width, height, source, Buffer.alloc(width*height, 255), "cpu", 128, [0,1,1,0]);
  assert.deepEqual(cached.stdout, inline.stdout);
  for (const data of [Buffer.concat([good, Buffer.from("extra")]), good.subarray(0, -1),
                      (() => { const copy = Buffer.from(good); copy.writeUInt32LE(width*height+1, 24); return copy; })()]) {
    writeFileSync(path, data);
    const bad = spawnSync(worker, args, { input: source, timeout: 30_000, maxBuffer: 1024*1024 });
    assert.notEqual(bad.status, 0);
    assert.doesNotMatch(bad.stderr.toString(), /"event":"finished"/);
  }
});
const run = (width, height, picture, mask, backend = "cpu", frames = 1, suffix = Buffer.alloc(0)) =>
  spawnSync(worker, ["--filter", String(width), String(height), "128", "32", String(frames), backend], {
    input: Buffer.concat([picture, mask, suffix]), timeout: 30_000, maxBuffer: 96 * 1024 * 1024,
  });
const colour = (width, height, picture, mask, backend, global = false) =>
  spawnSync(worker, ["--finish", String(width), String(height), "0", "32", "1", backend,
    "-0.5", "1.05", "0.98", "0.03", global ? "1" : "0", "0.25", "1", "1", "0"], {
    input: Buffer.concat([picture, mask]), timeout: 30_000, maxBuffer: 96 * 1024 * 1024,
  });
const finish = (width, height, picture, mask, backend, gain, subjectGrade, globalGrade = null) =>
  spawnSync(worker, ["--finish", String(width), String(height), String(gain), "32", "1", backend,
    ...subjectGrade.map(String), globalGrade ? "1" : "0", ...(globalGrade ?? [0, 1, 1, 0]).map(String)], {
    input: Buffer.concat([picture, mask]), timeout: 30_000, maxBuffer: 96 * 1024 * 1024,
  });

function fixture(width, height) {
  const picture = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const level = (x + y) % 2 ? 112 : 124;
    const index = (y * width + x) * 4;
    picture[index] = picture[index + 1] = picture[index + 2] = level;
    picture[index + 3] = 255;
  }
  const cy = Math.floor(height / 2), cx = Math.floor(width / 2);
  const centre = (cy * width + cx + ((cx + cy) % 2)) * 4;
  picture[centre] = picture[centre + 1] = picture[centre + 2] = 121;
  return picture;
}

test("the real stream preserves a zero mask and protects uncertain subject edges", () => {
  const width = 18, height = 12, source = fixture(width, height);
  const absent = run(width, height, source, Buffer.alloc(width * height));
  assert.equal(absent.status, 0, absent.stderr.toString());
  assert.deepEqual(absent.stdout, source);
  const mask = Buffer.alloc(width * height, 255);
  mask[6 * width + 3] = 0;
  mask[6 * width + 12] = 240;
  const detailed = run(width, height, source, mask);
  assert.equal(detailed.status, 0, detailed.stderr.toString());
  assert.notDeepEqual(detailed.stdout, source, "The enabled filter must make useful detail changes");
  const centre = (6 * width + 10) * 4;
  assert.deepEqual([...detailed.stdout.subarray(centre, centre + 4)], [122, 122, 122, 255]);
  for (let y = 5; y <= 7; ++y) for (const column of [3, 12]) for (let x = column - 1; x <= column + 1; ++x) {
    const index = (y * width + x) * 4;
    assert.deepEqual(detailed.stdout.subarray(index, index + 4), source.subarray(index, index + 4));
  }
});

test("GPU streaming reuses its buffers across active and bypass frames without stale pixels", () => {
  const width = 18, height = 12, source = fixture(width, height);
  const selected = Buffer.alloc(width * height, 255);
  const next = Buffer.alloc(source.length, 64);
  for (let i = 3; i < next.length; i += 4) next[i] = 255;
  const secondInput = Buffer.concat([next, Buffer.alloc(width * height)]);
  const cpu = run(width, height, source, selected, "cpu", 2, secondInput);
  const gpu = run(width, height, source, selected, "gpu", 2, secondInput);
  assert.equal(cpu.status, 0, cpu.stderr.toString());
  assert.equal(gpu.status, 0, gpu.stderr.toString());
  assert.equal(gpu.stdout.length, source.length * 2);
  assert.deepEqual(gpu.stdout, cpu.stdout);
  assert.deepEqual(gpu.stdout.subarray(source.length), next);
});

test("opaque coloured pixels retain channel differences and local luma/headroom bounds", () => {
  const width = 35, height = 27, source = Buffer.alloc(width * height * 4);
  let seed = 123;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
  for (let i = 0; i < source.length; i += 4) {
    source[i] = random(); source[i + 1] = random(); source[i + 2] = random(); source[i + 3] = 255;
  }
  const result = run(width, height, source, Buffer.alloc(width * height, 255), "gpu");
  assert.equal(result.status, 0, result.stderr.toString());
  const level = (buffer, i) => Math.floor((54 * buffer[i] + 183 * buffer[i + 1] + 19 * buffer[i + 2] + 128) / 256);
  for (let y = 1; y + 1 < height; ++y) for (let x = 1; x + 1 < width; ++x) {
    const index = (y * width + x) * 4, delta = result.stdout[index] - source[index];
    assert.ok(Math.abs(delta) <= 3);
    assert.equal(result.stdout[index + 1] - source[index + 1], delta);
    assert.equal(result.stdout[index + 2] - source[index + 2], delta);
    const nearby = [];
    for (let dy = -1; dy <= 1; ++dy) for (let dx = -1; dx <= 1; ++dx) {
      nearby.push(level(source, ((y + dy) * width + x + dx) * 4));
    }
    const finishedLevel = level(result.stdout, index);
    assert.ok(finishedLevel >= Math.min(...nearby) && finishedLevel <= Math.max(...nearby));
  }
});

test("subject colour affects only its mask and GPU colour matches the CPU within one code", () => {
  const width = 18, height = 12, source = fixture(width, height);
  const mask = Buffer.alloc(width * height, 255);
  mask.fill(0, 0, width * 4);
  const cpu = colour(width, height, source, mask, "cpu");
  const gpu = colour(width, height, source, mask, "gpu");
  assert.equal(cpu.status, 0, cpu.stderr.toString());
  assert.equal(gpu.status, 0, gpu.stderr.toString());
  assert.deepEqual(gpu.stdout.subarray(0, width * 4 * 4), source.subarray(0, width * 4 * 4));
  assert.ok(gpu.stdout[width * 4 * 4] < source[width * 4 * 4]);
  for (let i = 0; i < source.length; ++i) assert.ok(Math.abs(gpu.stdout[i] - cpu.stdout[i]) <= 1);
  const explicitGlobal = colour(width, height, source, Buffer.alloc(mask.length), "gpu", true);
  assert.equal(explicitGlobal.status, 0, explicitGlobal.stderr.toString());
  assert.notDeepEqual(explicitGlobal.stdout.subarray(0, width * 4), source.subarray(0, width * 4));
});

test("4K GPU streaming includes transfer and agrees exactly with the CPU reference", () => {
  const width = 3840, height = 2160, source = fixture(width, height);
  const mask = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; ++y) mask.fill(0, y * width, y * width + width / 4);
  const cpu = run(width, height, source, mask, "cpu");
  assert.equal(cpu.status, 0, cpu.stderr.toString());
  const hardware = run(width, height, source, mask, "gpu");
  assert.equal(hardware.status, 0, hardware.stderr.toString());
  assert.equal(hardware.stdout.length, source.length);
  assert.deepEqual(hardware.stdout, cpu.stdout);
  for (let y = 0; y < height; ++y) {
    assert.deepEqual(hardware.stdout.subarray(y * width * 4, (y * width + width / 4) * 4),
      source.subarray(y * width * 4, (y * width + width / 4) * 4));
  }
});

test("light trim preserves distinct highlights and opposite global/subject trims cancel", () => {
  const width = 256, height = 1, source = Buffer.alloc(width * 4), mask = Buffer.alloc(width, 255);
  for (let i = 0; i < width; ++i) {
    source.fill(i, i * 4, i * 4 + 3); source[i * 4 + 3] = 255;
  }
  for (const backend of ["cpu", "gpu"]) {
    const lifted = finish(width, height, source, mask, backend, 0, [0.5, 1, 1, 0]);
    assert.equal(lifted.status, 0, lifted.stderr.toString());
    for (const i of [215, 225, 235, 245]) assert.ok(lifted.stdout[i * 4] < lifted.stdout[(i + 10) * 4]);
    assert.equal(lifted.stdout[0], 0); assert.equal(lifted.stdout[255 * 4], 255);
    const cancelled = finish(width, height, source, mask, backend, 0, [-0.5, 1, 1, 0], [0.5, 1, 1, 0]);
    assert.equal(cancelled.status, 0, cancelled.stderr.toString());
    assert.deepEqual(cancelled.stdout, source);
  }
});

test("combined grading/sharpening handles coloured ramps, partial masks and nonopaque support", () => {
  const width = 73, height = 29, source = Buffer.alloc(width * height * 4), mask = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const i = (y * width + x) * 4;
    source[i] = (x * 13 + y * 29) % 256;
    source[i + 1] = (x * 7 + y * 11) % 256;
    source[i + 2] = (x * 19 + y * 3) % 256;
    source[i + 3] = 255;
    if (x < 8) mask[y * width + x] = 0;
    else if (x < 16) mask[y * width + x] = 128;
  }
  source[(13 * width + 40) * 4 + 3] = 128;
  const subjectGrade = [0.3, 1.12, 1.3, 0.1];
  const cpu = finish(width, height, source, mask, "cpu", 128, subjectGrade);
  const gpu = finish(width, height, source, mask, "gpu", 128, subjectGrade);
  assert.equal(cpu.status, 0, cpu.stderr.toString()); assert.equal(gpu.status, 0, gpu.stderr.toString());
  for (let i = 0; i < source.length; ++i) assert.ok(Math.abs(cpu.stdout[i] - gpu.stdout[i]) <= 2, `Combined CPU/GPU difference at ${i}`);
  for (let y = 0; y < height; ++y) assert.deepEqual(gpu.stdout.subarray(y * width * 4, (y * width + 8) * 4), source.subarray(y * width * 4, (y * width + 8) * 4));
  const transparent = (13 * width + 40) * 4;
  assert.deepEqual(gpu.stdout.subarray(transparent, transparent + 4), source.subarray(transparent, transparent + 4));
  const global = finish(width, height, source, mask, "gpu", 128, subjectGrade, [-0.2, 0.9, 0.95, -0.03]);
  const globalCpu = finish(width, height, source, mask, "cpu", 128, subjectGrade, [-0.2, 0.9, 0.95, -0.03]);
  assert.equal(global.status, 0, global.stderr.toString()); assert.equal(globalCpu.status, 0, globalCpu.stderr.toString());
  for (let i = 0; i < source.length; ++i) assert.ok(Math.abs(global.stdout[i] - globalCpu.stdout[i]) <= 2);
  assert.notDeepEqual(global.stdout.subarray(0, 32), source.subarray(0, 32));
});

test("trusted nonopaque sharpening stencils bypass on both CPU and GPU", () => {
  const width = 18, height = 12, source = fixture(width, height), mask = Buffer.alloc(width * height, 255);
  source[(6 * width + 10) * 4 + 3] = 128;
  for (const backend of ["cpu", "gpu"]) {
    const result = run(width, height, source, mask, backend);
    assert.equal(result.status, 0, result.stderr.toString());
    for (let y = 5; y <= 7; ++y) for (let x = 9; x <= 11; ++x) {
      const i = (y * width + x) * 4;
      assert.deepEqual(result.stdout.subarray(i, i + 4), source.subarray(i, i + 4));
    }
  }
});

test("partial, trailing, miscounted and malformed requests fail rather than report completion", () => {
  const width = 18, height = 12, source = fixture(width, height), mask = Buffer.alloc(width * height, 255);
  for (const result of [
    run(width, height, source, mask.subarray(1)),
    run(width, height, source, mask, "cpu", 1, Buffer.from([0])),
    run(width, height, source, mask, "cpu", 2),
    run(0, height, source, mask),
    run("18;bad", height, source, mask),
    run(width, height, source, mask, "unknown"),
  ]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /"event":"error"/);
    assert.doesNotMatch(result.stderr.toString(), /"event":"finished"/);
  }
});
