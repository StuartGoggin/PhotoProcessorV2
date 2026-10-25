import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../.build-cache/subject-finishing-evaluation-cpu/", import.meta.url));
const python = fileURLToPath(new URL("../.build-cache/subject-finishing-evaluation-cpu/runtime/python.exe", import.meta.url));
const worker = fileURLToPath(new URL("../src-tauri/scripts/subject_mask_worker.py", import.meta.url));
test("the pinned private Windows runtime loads both models and executes a finite corrected mask window", () => {
  const result = spawnSync(python, ["-I", "-B", worker, "--self-test", root], {
    timeout: 90_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr.toString()}`);
  const receipt = JSON.parse(result.stdout.toString().trim().split(/\r?\n/).at(-1));
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.evaluationOnly, true);
  assert.equal(receipt.modelHashesVerified, true);
  assert.equal(receipt.device, "cpu");
  assert.equal(receipt.frames, 2);
  assert.equal(receipt.finiteMasks, true);
  assert.equal(receipt.detectorExecuted, true);
  assert.ok(receipt.detectorTensorInventory > 0);
  assert.equal(receipt.detectorWeightsExact, true);
  assert.deepEqual(receipt.trackedObjects, ["horse", "rider"]);
  console.log(JSON.stringify(receipt));
});
test("manual inference refuses the old site-enabled evaluation startup even with -S", () => {
  const result=spawnSync(python,["-I","-S","-B",worker,"--manual-self-test",root],{timeout:10_000,maxBuffer:1024*1024});
  assert.notEqual(result.status,0);
  assert.match(result.stderr.toString(),/no-site|startup hooks/);
});
test("the independently provisioned 21-package offline runtime executes the two-object video contract", () => {
  const manualRoot=fileURLToPath(new URL("../.build-cache/subject-finishing-manual-cpu-v1/",import.meta.url));
  const manualPython=fileURLToPath(new URL("../.build-cache/subject-finishing-manual-cpu-v1/runtime/python.exe",import.meta.url));
  const result=spawnSync(manualPython,["-I","-S","-B",worker,"--manual-self-test",manualRoot],{timeout:90_000,maxBuffer:1024*1024});
  assert.equal(result.status,0,`${result.error??""}\n${result.stderr}`);
  const receipt=JSON.parse(result.stdout.toString().trim().split(/\r?\n/).at(-1));
  assert.equal(receipt.profile,"manual-video-cpu-v1");assert.equal(receipt.detectorExecuted,false);
  assert.equal(receipt.frames,2);assert.equal(receipt.subjectQualityAccepted,false);
  assert.equal(receipt.startupHooks,false);
  assert.deepEqual(receipt.excludedComponentsImported,[]);
  const inventory=spawnSync(manualPython,["-I","-S","-B","-c","import importlib.metadata as m,json; print(json.dumps(sorted(d.metadata['Name'].lower() for d in m.distributions())))"],{timeout:10_000});
  assert.equal(inventory.status,0,inventory.stderr.toString());const packages=JSON.parse(inventory.stdout);
  assert.equal(packages.length,21);for(const name of ["torchvision","transformers","huggingface-hub","tokenizers"])assert.equal(packages.includes(name),false);
  console.log(JSON.stringify({...receipt,installedPackages:packages.length}));
});
