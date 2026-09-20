import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Existing TypeScript compiler + React SSR; no browser or dependency install required.
async function compile(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  for (const [name, url] of Object.entries(imports)) compiled = compiled.replaceAll(JSON.stringify(name), JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const modelUrl = await compile("../src/utils/importScheduling.ts");
const { formatImportRate, formatImportBytes, importPhaseLabel, importWaitReason, isReadingImportSource, summarizeImportReads } = await import(modelUrl);
const componentUrl = await compile("../src/components/ImportSchedulingStatus.tsx", {
  "../utils/importScheduling": modelUrl,
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
});
const { default: ImportSchedulingStatus, ImportJobSchedulingStatus } = await import(componentUrl);
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const readingJob = (changes = {}) => ({
  id: "one", sourceDir: "E:\\DCIM", status: "running", phase: "copying", sourceDevice: "SD card E:",
  sourceDeviceKey: "disk:2", sourceIdentityKnown: true, sourceReadMbps: 17, activeSources: 2, maxSources: 4,
  ...changes,
});

test("old saved jobs without scheduling fields remain readable without fabricated live metrics", () => {
  const old = { id: "old", sourceDir: "E:\\DCIM", status: "running" };
  assert.equal(importPhaseLabel(old), "Importing");
  assert.equal(isReadingImportSource(old), false);
  assert.equal(summarizeImportReads([old]).combinedMbps, null);
  assert.match(render(ImportJobSchedulingStatus, { job: old }), /Source identity unavailable/);
  const markup = render(ImportSchedulingStatus, { jobs: [old] });
  assert.match(markup, /N\/A/);
  assert.match(markup, /Partial reading/);
  assert.doesNotMatch(markup, /0\.0 MB\/s/);
});

test("rates and byte counters distinguish unavailable, measured zero and finite values", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, "12", {}, []]) {
    assert.equal(formatImportRate(value), "N/A");
    assert.equal(formatImportBytes(value), "N/A");
  }
  assert.equal(formatImportRate(0), "0.0 MB/s");
  assert.equal(formatImportRate(17.24), "17.2 MB/s");
  assert.equal(formatImportBytes(0), "0.0 MiB");
  assert.equal(formatImportBytes(1024 ** 2 * 17), "17.0 MiB");
  assert.equal(formatImportBytes(1024 ** 3), "1.00 GiB");
});

test("waiting reasons are visible and diagnostic text never becomes HTML", () => {
  const job = readingJob({ status: "queued", phase: "waiting", waitReason: "Waiting for <SD card>", sourceDevice: "Card <E>" });
  const markup = render(ImportJobSchedulingStatus, { job, compact: true });
  assert.match(markup, /Waiting for &lt;SD card&gt;/);
  assert.match(markup, /Card &lt;E&gt;/);
  assert.doesNotMatch(markup, /17\.0 MB\/s/);
  assert.equal(summarizeImportReads([job]).waitingJobs, 1);
  assert.equal(importWaitReason({ ...job, waitReason: {} }), null);
});

test("source copying and destination verification are explicitly distinct", () => {
  const copy = render(ImportJobSchedulingStatus, { job: readingJob({ bytesRead: 1024 ** 2 * 10, bytesCopied: 1024 ** 2 * 10 }) });
  assert.match(copy, /Copying \+ checksumming source · 17\.0 MB\/s source read/);
  assert.match(copy, /Copied to staging: 10\.0 MiB/);
  const verify = readingJob({ phase: "verifying", sourceReadMbps: 999 });
  const markup = render(ImportJobSchedulingStatus, { job: verify });
  assert.match(markup, /Verifying destination copy/);
  assert.match(markup, /Reading the destination, not rereading the SD card/);
  assert.doesNotMatch(markup, /999/);
  assert.equal(summarizeImportReads([verify]).combinedMbps, 0);
});

test("terminal and paused jobs cannot resurrect saved copying speeds or waiting reasons", () => {
  for (const status of ["completed", "failed", "aborted", "paused"]) {
    const job = readingJob({ status, waitReason: "Old waiting reason" });
    assert.equal(isReadingImportSource(job), false);
    assert.doesNotMatch(render(ImportJobSchedulingStatus, { job }), /17\.0 MB\/s/);
    assert.equal(summarizeImportReads([job]).combinedMbps, 0);
    if (status !== "paused") {
      assert.equal(importWaitReason(job), null);
      assert.equal(render(ImportSchedulingStatus, { jobs: [job] }), "");
    }
  }
});

test("aggregate adds independent physical sources once, not folder names or duplicate rows", () => {
  const jobs = [
    readingJob(),
    readingJob({ id: "two", sourceDir: "E:\\OTHER", sourceDevice: "Another folder on E:", sourceReadMbps: 16 }),
    readingJob({ id: "three", sourceDeviceKey: "disk:3", sourceDevice: "SD card E:" }),
    readingJob({ id: "four", status: "queued", sourceReadMbps: 50 }),
    readingJob({ id: "old", status: "completed", sourceDeviceKey: "disk:4", sourceReadMbps: 500 }),
  ];
  const summary = summarizeImportReads(jobs);
  assert.equal(summary.knownSources, 2);
  assert.equal(summary.combinedMbps, 34);
  assert.equal(summary.waitingJobs, 1);
  const markup = render(ImportSchedulingStatus, { jobs });
  assert.match(markup, /34\.0 MB\/s combined source read/);
  assert.match(markup, /2\/4 source slot\(s\) occupied/);
  assert.match(markup, /Devices may still share a USB bus/);
});

test("unknown identities remain visible individually but cannot inflate aggregate throughput", () => {
  const unknown = readingJob({ sourceIdentityKnown: false, sourceDeviceKey: undefined, sourceReadMbps: 23 });
  assert.match(render(ImportJobSchedulingStatus, { job: unknown }), /23\.0 MB\/s source read/);
  assert.match(render(ImportJobSchedulingStatus, { job: unknown }), /physical identity unavailable/);
  const summary = summarizeImportReads([readingJob(), unknown, { ...unknown, id: "another" }]);
  assert.equal(summary.combinedMbps, 17);
  assert.equal(summary.unidentifiedReads, true);
  assert.match(render(ImportSchedulingStatus, { jobs: [readingJob(), unknown] }), /Partial reading/);
  assert.match(render(ImportSchedulingStatus, { jobs: [unknown] }), /N\/A known measured sources/);
  assert.equal(summarizeImportReads([readingJob({ sourceDeviceKey: "" })]).unidentifiedReads, true);
});

test("missing or non-finite source rates do not silently become zero readings", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, "12"]) {
    const summary = summarizeImportReads([readingJob({ sourceReadMbps: value })]);
    assert.equal(summary.combinedMbps, null);
    assert.equal(summary.incomplete, true);
  }
  assert.equal(summarizeImportReads([readingJob({ sourceReadMbps: 0 })]).combinedMbps, 0);
  const overflow = summarizeImportReads([readingJob({ sourceReadMbps: 1e308 }), readingJob({ sourceDeviceKey: "disk:3", sourceReadMbps: 1e308 })]);
  assert.equal(overflow.combinedMbps, null);
  assert.equal(overflow.incomplete, true);
});

test("malformed capacities and phase values are handled defensively", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 1.5, "2"]) {
    const summary = summarizeImportReads([readingJob({ activeSources: value, maxSources: value })]);
    assert.equal(summary.activeSources, null);
    assert.equal(summary.maxSources, null);
  }
  assert.equal(summarizeImportReads([readingJob({ activeSources: 5, maxSources: 4 })]).activeSources, null);
  for (const phase of [undefined, {}, "unknown", "__proto__", "constructor"]) {
    assert.equal(importPhaseLabel(readingJob({ phase })), "Importing");
    assert.doesNotThrow(() => render(ImportJobSchedulingStatus, { job: readingJob({ phase }) }));
  }
});

test("only the copying phase contributes source throughput, even if other phases retain a rate", () => {
  for (const phase of ["scanning", "waiting", "verifying", "publishing", "recovering", "hashing"]) {
    const job = readingJob({ phase, sourceReadMbps: 100 });
    assert.equal(isReadingImportSource(job), false);
    assert.equal(summarizeImportReads([job]).combinedMbps, 0);
  }
});
