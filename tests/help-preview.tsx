// Real app, synthetic native adapter. No user files, devices or Google accounts.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { defaultLightboxBindings } from "../src/controller/lightboxBindings";
import "../src/styles.css";
const test = window as any;
test.__helpCalls = [];
test.__helpAcks = [];
const callbacks = new Map<number, (value: unknown) => void>();
const listeners = new Map<number, {event: string; callback: number}>();
let sequence = 0, client = "";
const status = () => ({enabled: true, phase: "connected", message: "Demo controller", session: "demo-session", client, vendorStopped: false, brightness: 100});
test.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: (_: string, id: number) => listeners.delete(id)};
test.__helpInput = (kind = "key", index = 0, delta = 1, revision = test.__helpSurface?.revision) => {
  const payload = {session: "demo-session", revision, id: String(++sequence), kind, index, delta};
  for (const entry of listeners.values()) if (entry.event === "controller-input") callbacks.get(entry.callback)?.({event: entry.event, id: entry.callback, payload});
};
test.__TAURI_INTERNALS__ = {
  metadata: {currentWindow: {label: "main"}, currentWebview: {label: "main"}},
  transformCallback: (callback: (value: unknown) => void) => {callbacks.set(++sequence, callback); return sequence;},
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any = {}) => {
    test.__helpCalls.push({command, args});
    if (command === "load_settings") return {source_root: "E:/Camera", staging_dir: "D:/PhotoGoGo Demo", archive_dir: "Z:/Photo archive", exiftool_dir: "", stabilize_max_parallel_jobs: 2, stabilize_ffmpeg_threads_per_job: 4, face_scan_parallel_jobs: 1, face_scan_min_shard_mb: 200, face_scan_target_shard_mb: 400, timeline_preview_enabled: false, timeline_preview_width: 640, timeline_preview_height: 360, timeline_preview_fps: 10};
    if (["list_sd_cards", "list_import_jobs", "studio_list_jobs"].includes(command)) return [];
    if (command === "process_jobs_snapshot") return {jobs: [], warnings: []};
    if (command === "snapshot_sessions_list") return {sessions: [], warnings: []};
    if (command === "plugin:event|listen") {listeners.set(args.handler, {event: args.event, callback: args.handler}); return args.handler;}
    if (command === "plugin:event|unlisten") return null;
    if (command === "controller_claim_client") {client = args.client; return status();}
    if (command === "controller_status") return status();
    if (command === "controller_surface") {test.__helpSurface = args.surface; return null;}
    if (command === "controller_ack") {test.__helpAcks.push(args); return null;}
    if (command === "controller_lightbox_bindings") return defaultLightboxBindings();
    if (command === "plugin:shell|open") {test.__helpOpenedUrl = args.path; return null;}
    if (command === "save_settings") {test.__helpSavedSettings = args.settings; return null;}
    throw new Error("Unexpected help fixture command: " + command);
  }
};
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
