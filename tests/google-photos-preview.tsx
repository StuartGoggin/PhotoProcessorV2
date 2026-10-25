// Deterministic local IPC fixture. No Google accounts, network uploads or user
// media are accessed by these browser checks.
import React from "react";
import { createRoot } from "react-dom/client";
import GooglePhotos from "../src/pages/GooglePhotos";
import SettingsPage from "../src/pages/Settings";
import "../src/styles.css";
const fixture = window as any;
fixture.__googleCalls = [];
fixture.__googleStatus ??= { configured: true, connecting: false, account: { id: "personal-client:subject-1", email: "rider@example.test", displayName: "Synthetic Rider" }, clientIdHint: "…synthetic.apps.googleusercontent.com" };
fixture.__googleJobs ??= [];
fixture.__metadataSavedSettings = [];
fixture.__googleThumbnailActive = 0;
fixture.__googleThumbnailMax = 0;
fixture.__googleRevokedUrls = [];
const nativeRevoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { fixture.__googleRevokedUrls.push(url); nativeRevoke(url); };
const data = () => {
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#214e41"; ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = "#efd68e"; ctx.font = "18px sans-serif"; ctx.fillText("Synthetic horse & rider", 20, 90);
  return canvas.toDataURL("image/jpeg", .8).split(",")[1];
};
const items = [
  { id: "first-original", relativePath: "2026/10/24/Horse event/rider.jpg", variant: "original", bytes: 18123456, status: "ready", warnings: [] },
  { id: "first-enhanced", relativePath: "2026/10/24/Horse event/rider_improved.jpg", variant: "enhanced", bytes: 19123456, status: "changed", warnings: ["New pixels will upload as a new Google photo, not replace the prior photo."] },
  { id: "first-bw", relativePath: "2026/10/24/Horse event/rider_BW.jpg", variant: "bw", bytes: 12123456, status: "already_uploaded", warnings: [] },
  { id: "next-crop", relativePath: "2026/10/25/Arena/fence_crop.jpg", variant: "crop", bytes: 14123456, status: "ready", warnings: [] },
  { id: "next-raw", relativePath: "2026/10/25/Arena/fence.CR3", variant: "original", bytes: 28123456, status: "unsupported", warnings: ["This RAW type is not in the validated upload format contract."] },
];
fixture.__TAURI_INTERNALS__ = {
  convertFileSrc: () => "",
  invoke: async (command: string, args: any = {}) => {
    fixture.__googleCalls.push({ command, args: structuredClone(args) });
    if (command === "load_settings") return { staging_dir: "D:\\Synthetic photos", source_root: "", archive_dir: "", exiftool_dir: fixture.__metadataSavedOverride ?? "" };
    if (command === "save_settings") { fixture.__metadataSavedSettings.push(args.settings); return null; }
    if (command === "metadata_tool_status") {
      if (fixture.__metadataHold) await new Promise<void>(resolve => { fixture.__metadataResolve = resolve; });
      if (fixture.__metadataError) throw new Error(fixture.__metadataError);
      return fixture.__metadataResult ?? (args.directory ? { ready: true, source: "override", version: "13.50", path: `${args.directory}\\exiftool.exe`, message: "The selected ExifTool folder override is ready." }
        : { ready: true, source: "bundled", version: "13.50", path: "C:\\PhotoGoGo\\resources\\metadata\\exiftool.exe", message: "Bundled ExifTool is ready." });
    }
    if (command === "google_photos_status") { if (fixture.__googleStatusError) throw new Error("Synthetic unavailable status"); return structuredClone(fixture.__googleStatus); }
    if (command === "google_photos_list_jobs") return structuredClone(fixture.__googleJobs);
    if (command === "plugin:dialog|open") return fixture.__googleDialogPath ?? "D:\\private-config\\desktop-client.json";
    if (command === "google_photos_configure") { fixture.__googleStatus.configured = true; return null; }
    if (command === "google_photos_connect") { fixture.__googleStatus.account = { id: "personal-client:subject-1", email: "rider@example.test", displayName: "Synthetic Rider" }; return null; }
    if (command === "google_photos_disconnect") { fixture.__googleStatus.account = null; return null; }
    if (command === "google_photos_plan") {
      if (fixture.__googlePlanError) throw new Error(fixture.__googlePlanError);
      if (fixture.__googlePlanDelay) await new Promise<void>(resolve => { fixture.__googleResolvePlan = resolve; });
      const sourceItems = fixture.__googlePlanItems ?? items;
      const planItems = fixture.__googleAlreadyUploadedOnly ? sourceItems.map((item: any) => ({ ...item, status: item.status === "unsupported" ? "unsupported" : "already_uploaded" })) : sourceItems;
      const albums = [
        { key: "horse-24", title: "Horse event — 24 October 2026", date: "2026-10-24", albumId: args.request.albumMode === "continue" ? "saved-horse-album" : null, itemIds: planItems.filter((item: any) => item.relativePath.includes("/24/")).map((item: any) => item.id), coverItemId: null },
        { key: "arena-25", title: "Arena — 25 October 2026", date: "2026-10-25", albumId: args.request.albumMode === "continue" ? "saved-app-album" : null, itemIds: planItems.filter((item: any) => item.relativePath.includes("/25/")).map((item: any) => item.id), coverItemId: null },
      ].filter(album => album.itemIds.length > 0);
      return { id: `plan-${fixture.__googleCalls.filter((call: any) => call.command === command).length}`, accountId: fixture.__googleStatus.account.id, accountEmail: fixture.__googleStatus.account.email, root: args.request.root, items: planItems, albums, warnings: ["Synthetic metadata check: confirm capture dates before publishing."], totalBytes: 51370368 };
    }
    if (command === "google_photos_thumbnail") {
      fixture.__googleThumbnailActive++;
      fixture.__googleThumbnailMax = Math.max(fixture.__googleThumbnailMax, fixture.__googleThumbnailActive);
      await new Promise(resolve => setTimeout(resolve, 30));
      fixture.__googleThumbnailActive--;
      return data();
    }
    if (command === "google_photos_start") {
      if (fixture.__googleStartDelay) await new Promise<void>(resolve => { fixture.__googleResolveStart = resolve; });
      if (fixture.__googleStartError) throw new Error(fixture.__googleStartError);
      fixture.__googleJobs.push({ id: "saved-job-1", status: "running", accountId: fixture.__googleStatus.account.id, accountEmail: fixture.__googleStatus.account.email, createdAt: "2026-10-25T07:00:00Z", total: 4, done: 1, uploaded: 1, skipped: 1, failed: 0, bytesDone: 18123456, totalBytes: 51370368, currentFile: "rider_improved.jpg", albums: args.albums.map((album: any) => ({ key: album.key, title: album.title, productUrl: "https://photos.google.com/lr/album/synthetic", state: "created" })), errors: [] });
      return "saved-job-1";
    }
    if (command === "google_photos_control") {
      const job = fixture.__googleJobs.find((job: any) => job.id === args.jobId);
      job.status = args.action === "pause" ? "paused" : "running";
      return true;
    }
    if (command === "google_photos_open_album") return null;
    if (command === "google_photos_job_diagnostics") return `Synthetic Google Photos job ${args.jobId}\nConfirmed uploads: 1\nNo credentials, protected paths or raw logs are included.`;
    if (command === "google_photos_albums") return [{ id: "verified-app-album-1234", title: "Horse event — 24 October 2026", productUrl: "https://photos.google.com/lr/album/synthetic" }];
    if (command === "google_photos_reconcile") { const job = fixture.__googleJobs.find((job: any) => job.id === args.jobId); job.albums.find((album: any) => album.key === args.albumKey).state = "created"; job.status = "paused"; return true; }
    throw new Error(`Unexpected Google Photos fixture command: ${command}`);
  },
};
document.getElementById("root")!.style.height = "100%";
document.getElementById("root")!.style.overflow = "auto";
const root = createRoot(document.getElementById("root")!);
fixture.__googleUnmount = () => root.unmount();
root.render(<React.StrictMode>{new URLSearchParams(location.search).get("page") === "settings" ? <SettingsPage /> : <GooglePhotos />}</React.StrictMode>);
