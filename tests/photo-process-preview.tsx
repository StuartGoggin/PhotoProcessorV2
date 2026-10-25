// Development-only fixture: deterministic synthetic images, never user media.
import React from "react";
import { createRoot } from "react-dom/client";
import PostProcess from "../src/pages/PostProcess";
import "../src/styles.css";

const fixture = window as any;
fixture.__previewCalls = [];
fixture.__candidateCalls = [];
fixture.__queuedJobs = [];
fixture.__previewActive = 0;
fixture.__maxPreviewActive = 0;
fixture.__previewDeferred = [];
fixture.__revokedPreviews = [];
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { fixture.__revokedPreviews.push(url); revoke(url); };
const photos = ["D:\\Photos\\Rider.jpg", "D:\\Photos\\Arena.jpg", "D:\\Photos\\Portrait.jpg"];
function image(label: string, full: boolean, processed = false) {
  const canvas = document.createElement("canvas");
  canvas.width = full ? 1800 : 600; canvas.height = full ? 2700 : 900;
  const context = canvas.getContext("2d")!;
  context.fillStyle = processed ? "#434343" : "#387e5f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f3ce76"; context.font = `${full ? 75 : 25}px sans-serif`;
  context.fillText(label, 20, 75);
  return canvas.toDataURL("image/jpeg", 0.8);
}
let videoData: Promise<string> | null = null;
function motion() {
  if (videoData) return videoData;
  videoData = new Promise<string>((resolve) => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
    };
    recorder.start(); let frame = 0;
    const paint = window.setInterval(() => {
      context.fillStyle = "#182938"; context.fillRect(0, 0, 320, 180);
      context.fillStyle = "#e6c66b"; context.fillRect(frame++ * 12, 50, 30, 50);
      if (frame === 8) { window.clearInterval(paint); recorder.stop(); }
    }, 80);
  });
  return videoData;
}
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  if (command === "load_settings") return { staging_dir: "D:\\Photos" };
  if (command === "list_staging_tree") return { name: "Photos", path: "", type: "dir", children: [
    { name: "Event", path: "Event", type: "dir", children: [] },
  ] };
  if (command === "process_preview_candidates") {
    fixture.__candidateCalls.push(structuredClone(args));
    const paths = fixture.__emptyScope ? [] : args.task === "stabilize" ? [`${args.scopeDir}\\Course.mp4`, `${args.scopeDir}\\Practice.mp4`] : photos.map((path) => `${args.scopeDir}\\${path.split("\\").pop()}`);
    return { paths, total: paths.length, truncated: false };
  }
  if (command === "start_process_job") { fixture.__queuedJobs.push(structuredClone(args)); return "photo-job-fixture"; }
  if (command === "process_preview") {
    const request = structuredClone(args.request);
    fixture.__previewCalls.push(request);
    fixture.__previewActive++;
    fixture.__maxPreviewActive = Math.max(fixture.__maxPreviewActive, fixture.__previewActive);
    try {
      if (fixture.__holdPreviews) await new Promise<void>((resolve) => fixture.__previewDeferred.push(resolve));
      if (fixture.__previewError) throw new Error(fixture.__previewError);
      const common = { path: request.path, warning: "", elapsedMs: 125, fullResolution: !!request.fullResolution, width: request.fullResolution ? 1800 : 600, height: request.fullResolution ? 2700 : 900 };
      if (request.task.startsWith("remove_")) return { ...common, kind: "cleanup", affected: ["D:\\Photos\\Rider_BW.jpg", "D:\\Photos\\Arena_BW.jpg"], total: 2 };
      if (request.task === "stabilize") return { ...common, kind: "video", original: await motion(), processed: await motion(), width: 320, height: 180, warning: "Synthetic short-motion fixture; full-clip context may differ." };
      const original = image(request.path, !!request.fullResolution);
      if (request.task === "focus") return { ...common, kind: "focus", original, focus: { max: 612, average: 118, percent: 82, flagged: false } };
      return { ...common, kind: "image", original, processed: image(`${request.task} ${JSON.stringify(request.bwParams || request.enhanceContrastLevel)}`, !!request.fullResolution, true) };
    } finally { fixture.__previewActive--; }
  }
  throw new Error(`Unexpected fixture command: ${command}`);
} };
const root = createRoot(document.getElementById("root")!);
fixture.__unmountPhotoProcess = () => root.unmount();
root.render(<React.StrictMode><PostProcess /></React.StrictMode>);
