// Development-only deterministic IPC adapter. No user RAW files or real decoder are used.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import RawDevelopment from "../src/components/RawDevelopment";
import { rawPreset } from "../src/utils/rawRecipe";
import "../src/styles.css";

const fixture = window as any;
fixture.__rawCalls = [];
fixture.__rawQueue = [];
fixture.__rawOverrides = {};
fixture.__rawLastApplied = { "D:\\Photos\\Portrait.CR3": { ...rawPreset("neutral"), exposure: 1.75 } };
fixture.__rawPreviewActive = 0;
fixture.__rawPreviewMax = 0;
fixture.__rawDeferred = [];
fixture.__rawRevoked = [];
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { fixture.__rawRevoked.push(url); revoke(url); };
function image(label: string, full: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = full ? 1200 : 400; canvas.height = full ? 1800 : 600;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#445c4f"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#e6bc63"; context.font = "18px sans-serif"; context.fillText(label, 20, 40);
  return canvas.toDataURL("image/jpeg", .85);
}
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  fixture.__rawCalls.push({ command, args: structuredClone(args) });
  if (command === "raw_development_candidates") {
    const paths = fixture.__rawEmpty ? [] : ["Rider.CR3", "Portrait.CR3", "Wide.CR3"].map((file) => `${args.request.scopeDir}\\${file}`);
    return { paths, total: paths.length, truncated: false, runtime: { available: !fixture.__rawUnavailable, version: "Fixture worker", message: fixture.__rawUnavailable ? "Fixture worker unavailable" : "Synthetic adapter; no image-quality claim" } };
  }
  if (command === "get_raw_recipe") return { recipe: fixture.__rawOverrides[args.path] || null, lastAppliedRecipe: fixture.__rawLastApplied[args.path] || null };
  if (command === "save_raw_recipe") {
    if (fixture.__rawSaveError) throw new Error(fixture.__rawSaveError);
    fixture.__rawOverrides[args.path] = structuredClone(args.recipe); return null;
  }
  if (command === "clear_raw_recipe") { delete fixture.__rawOverrides[args.path]; return null; }
  if (command === "start_raw_development_job") { fixture.__rawQueue.push(structuredClone(args.request)); return "raw-fixture-job"; }
  if (command === "raw_development_preview") {
    fixture.__rawPreviewActive++; fixture.__rawPreviewMax = Math.max(fixture.__rawPreviewMax, fixture.__rawPreviewActive);
    try {
      if (fixture.__rawHold) await new Promise<void>((resolve) => fixture.__rawDeferred.push(resolve));
      if (fixture.__rawPreviewError) throw new Error(fixture.__rawPreviewError);
      const histogram = { red: Array.from({ length: 256 }, (_, x) => x % 50), green: Array.from({ length: 256 }, (_, x) => x % 80), blue: Array.from({ length: 256 }, (_, x) => x % 100), shadowPercent: .2, highlightPercent: .7 };
      return { path: args.request.path, original: image("Camera preview", !!args.request.fullResolution), processed: image(`${args.request.path} exposure ${args.request.recipe.exposure}`, !!args.request.fullResolution), width: args.request.fullResolution ? 1200 : 400, height: args.request.fullResolution ? 1800 : 600, originalWidth: args.request.fullResolution ? 1200 : 400, originalHeight: args.request.fullResolution ? 1800 : 600, fullResolution: !!args.request.fullResolution, sourceLabel: "Camera preview", warning: `Fixture exposure ${args.request.recipe.exposure}`, elapsedMs: 130, histogram };
    } finally { fixture.__rawPreviewActive--; }
  }
  throw new Error(`Unexpected RAW fixture command: ${command}`);
} };
function Fixture() {
  const [scopeDir, setScope] = useState("D:\\Photos");
  fixture.__rawSetScope = setScope;
  return <div className="p-4 max-w-6xl mx-auto"><RawDevelopment stagingDir="D:\\Photos" scopeDir={scopeDir} scopeMode="folderRecursive" onOpenJobs={() => fixture.__rawOpenedJobs = true} /></div>;
}
const root = createRoot(document.getElementById("root")!);
fixture.__rawUnmount = () => root.unmount();
root.render(<React.StrictMode><Fixture /></React.StrictMode>);
