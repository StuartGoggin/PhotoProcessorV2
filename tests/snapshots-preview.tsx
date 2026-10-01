// Development-only fixture: no real media, filesystem or production IPC.
import React from "react";
import { createRoot } from "react-dom/client";
import VideoSnapshots from "../src/pages/VideoSnapshots";
import "../src/styles.css";
// Production owns scrolling in App's main panel; give this isolated fixture a
// document scroll surface so full-page screenshots include the entire editor.
const fixtureStyle = document.createElement("style");
fixtureStyle.textContent = "html,body,#root{height:auto!important;min-height:100%;overflow:visible!important}";
document.head.appendChild(fixtureStyle);
const state = window as any;
state.__snapshotCalls = [];
state.__snapshotExports = [];
state.__exportFolder = "D:/synthetic/Photos";
state.__openPaths = ["D:/synthetic/First camera.mov", "D:/synthetic/Second camera.mp4"];
state.__snapshotIdentity = "unchanged";
const frameTime = (index: number) => index < 90 ? index * 20 : 1800 + (index - 90) * 40;
const frameImage = (index: number) => {
  const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 540;
  const ctx = canvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 540); sky.addColorStop(0, "#324d62"); sky.addColorStop(.6, "#b5c4b4"); sky.addColorStop(.61, "#607c56"); sky.addColorStop(1, "#253d30");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = "#ddc88d"; ctx.font = "bold 30px sans-serif"; ctx.fillText("Synthetic frame selection test", 42, 62);
  ctx.fillStyle = "#243026"; ctx.fillRect(0, 370, 960, 9); ctx.fillRect(0, 430, 960, 7);
  for (let i = 0; i < 8; i++) ctx.fillRect(i * 140 + 20, 320, 7, 180);
  ctx.fillStyle = "#dbe8eb"; ctx.font = "bold 90px sans-serif"; ctx.fillText(String(index + 1).padStart(3, "0"), 385, 280);
  ctx.font = "18px sans-serif"; ctx.fillText("Exact source frame · no user footage", 320, 315);
  return canvas.toDataURL("image/jpeg", .8);
};
state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
  state.__snapshotCalls.push({ command, args: structuredClone(args), at: performance.now() });
  if (command === "plugin:dialog|confirm") return state.__confirm !== false;
  if (command === "plugin:dialog|open") return args.options?.directory ? state.__exportFolder : state.__openPaths;
  if (command === "plugin:dialog|message") return null;
  if (command === "plugin:dialog|save") return "D:/synthetic/session.snapshots.json";
  if (command === "snapshot_open") {
    if (state.__openError) throw new Error(state.__openError);
    const id = String(args.path).includes("Second") ? "clip-b" : "clip-a";
    return { id, identity: state.__snapshotIdentity + args.path, path: args.path, name: args.path.split("/").pop(), width: 3840, height: 2160,
      frameTimesMs: Array.from({ length: state.__frameCount || 180 }, (_, i) => frameTime(i)),
      suggestedStart: "2026-09-20T14:35:10+10:00", timeSource: "Camera metadata (confirm time zone)", warnings: [] };
  }
  if (command === "snapshot_frames") {
    const response = { frames: Array.from({ length: Math.min(args.count, (state.__frameCount || 180) - args.start) }, (_, i) => {
      const index = args.start + i; return { index, atMs: frameTime(index), data: frameImage(index) };
    }) };
    if (state.__deferFrames) return new Promise(resolve => (state.__deferredFrames ||= []).push(() => resolve(response)));
    await new Promise(resolve => setTimeout(resolve, state.__frameDelay || 25)); return response;
  }
  if (command === "snapshot_photo_preview") {
    if (state.__deferAdjustment) await new Promise(resolve => { state.__releaseAdjustment = resolve; });
    return frameImage(args.index);
  }
  if (command === "snapshot_export") {
    state.__snapshotExports.push(structuredClone(args));
    if (state.__deferExport) await new Promise(resolve => { state.__releaseExport = resolve; });
    if (state.__exportError) throw new Error(state.__exportError);
    const stem = `${args.destination.replace(/[\\/]+$/, "")}/2026/09/20/20260920_143510_020_Jane`;
    return { path: `${stem}.jpg`, enhancedPath: args.recipe.brightness || args.recipe.contrast || args.recipe.sharpness || args.recipe.crop ? `${stem}_improved.jpg` : null, provenancePath: `${stem}.snapshot.json`, capturedAt: "2026-09-20T14:35:10.020+10:00", width: 3840, height: 2160 };
  }
  if (command === "reveal_in_explorer") { if (state.__revealError) throw new Error(state.__revealError); return null; }
  if (command === "snapshot_save_session") { state.__savedSession = args.json; return null; }
  if (command === "snapshot_load_session") return state.__savedSession;
  if (["snapshot_cancel", "snapshot_forget"].includes(command)) return null;
  throw new Error(`Unexpected fixture command: ${command}`);
} };
function Fixture() {
  const [active, setActive] = React.useState(true);
  state.__setSnapshotsActive = setActive;
  return <VideoSnapshots active={active} />;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
