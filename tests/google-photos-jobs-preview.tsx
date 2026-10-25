// Real Jobs page and shared monitor; deterministic native IPC only. Synthetic
// accounts and jobs. No account sign-in, media access or network upload.
import React from "react";
import { createRoot } from "react-dom/client";
import Jobs from "../src/pages/Jobs";
import JobsPanel from "../src/components/JobsPanel";
import { useJobsMonitor } from "../src/hooks/useJobsMonitor";
import "../src/styles.css";
const fixture = window as any;
fixture.__jobsCalls = [];
fixture.__googleStatus ??= { configured: true, connecting: false, account: { id: "client-A:subject-A", email: "rider@example.test", displayName: "Synthetic rider" } };
fixture.__googleJobs ??= [{ id: "failed-upload-1", status: "needs_attention", accountId: "client-A:subject-A", accountEmail: "rider@example.test", createdAt: "2026-10-26T01:00:00Z", done: 1, total: 3, uploaded: 1, skipped: 0, failed: 1, bytesDone: 5000, totalBytes: 15000, currentFile: "synthetic-horse.jpg", albums: [{ key: "horse-event", title: "Synthetic horse event", state: "ready", productUrl: "https://photos.google.com/lr/album/synthetic" }], errors: ["Synthetic registration failed. Retry remaining work."] }];
fixture.__importJobs = [{ id: "local-import-1", status: "running", done: 1, total: 4, sourceDir: "E:\\Synthetic DCIM", stagingDir: "D:\\Synthetic staging", currentFile: "local-only.jpg", errors: [], logs: [], sourceFileTotal: 4, imported: 1, skipped: 0, ignoredFileTotal: 0, unsupportedFileTotal: 0, logFilePath: "synthetic.log", manifestFilePath: "synthetic-manifest.json" }];
fixture.__diagnostics = "PhotoGoGo Google Photos diagnostics\nJob: failed-upload-1\nState: needs_attention\nRegistration: saved success retained; one item needs retry.\nNo credentials, tokens, session URLs or private absolute paths are included.";
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { if (fixture.__clipboardDenied) throw new Error("Synthetic clipboard denied"); fixture.__copiedDiagnostics = text; } } });
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
  fixture.__jobsCalls.push({ command, args: structuredClone(args) });
  if (command === "list_import_jobs") return structuredClone(fixture.__importJobs);
  if (command === "list_process_jobs" || command === "studio_list_jobs") return [];
  if (command === "google_photos_status") { if (fixture.__googleStatusError) throw new Error("Synthetic Google account status unavailable"); return structuredClone(fixture.__googleStatus); }
  if (command === "google_photos_list_jobs") { if (fixture.__googleJobsError) throw new Error("Synthetic protected Google jobs unavailable"); return structuredClone(fixture.__googleJobs); }
  if (command === "google_photos_control") { if (fixture.__controlDelay) await new Promise<void>(resolve => { fixture.__resolveControl = resolve; }); fixture.__googleJobs.find((job: any) => job.id === args.jobId).status = args.action === "pause" ? "paused" : "running"; return true; }
  if (command === "google_photos_job_diagnostics") { if (fixture.__diagnosticsError) throw new Error("Synthetic diagnostics unavailable"); return fixture.__diagnostics; }
  if (command === "google_photos_open_album") return null;
  if (command === "google_photos_albums") return [{ id: "known-app-album", title: "Synthetic horse event", productUrl: "https://photos.google.com/lr/album/synthetic" }];
  if (command === "google_photos_reconcile") { fixture.__googleJobs[0].albums[0].state = "ready"; fixture.__googleJobs[0].status = "paused"; return true; }
  if (command === "clear_finished_import_jobs" || command === "clear_finished_process_jobs") return 0;
  throw new Error(`Unexpected Jobs fixture command: ${command}`);
} };
function Preview() {
  const monitor = useJobsMonitor(true, 400, fixture.__includeGoogle !== false);
  return <div style={{ height: "100%", overflow: "auto", padding: 12 }}>
    <JobsPanel {...monitor} />
    <Jobs initialView="attention" googlePhotos={{ jobs: monitor.googlePhotosJobs, account: monitor.googlePhotosAccount, error: monitor.googlePhotosError, refresh: monitor.refreshGooglePhotos }} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
