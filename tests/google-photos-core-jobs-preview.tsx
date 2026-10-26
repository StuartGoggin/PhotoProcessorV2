// One core ProcessJob, not a second Google job list. Real app job UI/hook,
// synthetic protected summary and deterministic core native-command adapter.
import React from "react";
import { createRoot } from "react-dom/client";
import Jobs from "../src/pages/Jobs";
import JobsPanel from "../src/components/JobsPanel";
import { useJobsMonitor } from "../src/hooks/useJobsMonitor";
import "../src/styles.css";
const fixture = window as any;
fixture.__coreCalls = [];
const id = "G".repeat(43);
fixture.__coreJob ??= { id, task: "googlePhotos", status: "needs_attention", stagingDir: "", scopeDir: "", scopeMode: "entireStaging", createdAt: "2026-10-26T04:00:00Z", startedAt: "2026-10-26T04:00:00Z", finishedAt: null, total: 4, done: 4, processed: 4, resultCount: 3, currentFile: "Photo 3 (Original)", errors: ["Photo 3 verification needs attention; saved registration retained."], logs: ["Registered receipts retained. Retry verifies remaining work."], statusLine: "4 accepted · 3 verified · 1 verification warning", pauseRequested: false, abortRequested: false, canContinue: true, controlBlockedReason: null, googlePhotos: { id, status: "needs_attention", accountId: "client:subject", accountEmail: "rider@example.test", createdAt: "2026-10-26T04:00:00Z", total: 4, done: 4, uploaded: 3, accepted: 4, awaitingVerification: 1, verificationNeedsAttention: 1, skipped: 0, failed: 1, bytesDone: 20000, totalBytes: 20000, currentFile: "Photo 3 (Original)", errors: ["Photo 3 verification needs attention; saved registration retained."], albums: [{ key: "event", title: "Synthetic event", state: "ready", productUrl: "https://photos.google.com/lr/album/synthetic" }] } };
fixture.__coreJobs ??= [fixture.__coreJob];
fixture.__coreWarnings ??= [];
fixture.__checkpointRetained = true;
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
  fixture.__coreCalls.push({ command, args: structuredClone(args) });
  if (command === "list_import_jobs" || command === "studio_list_jobs") return [];
  if (command === "process_jobs_snapshot") { fixture.__snapshotPending = (fixture.__snapshotPending || 0) + 1; fixture.__snapshotMaxPending = Math.max(fixture.__snapshotMaxPending || 0, fixture.__snapshotPending); try { if (fixture.__snapshotDelay) await new Promise(resolve => setTimeout(resolve, fixture.__snapshotDelay)); return { jobs: structuredClone(fixture.__coreJobs), warnings: [...fixture.__coreWarnings] }; } finally { fixture.__snapshotPending--; } }
  if (command === "list_process_jobs") return structuredClone(fixture.__coreJobs);
  if (["pause_process_job", "resume_process_job", "abort_process_job", "retry_process_job"].includes(command)) { const job = fixture.__coreJobs.find((job: any) => job.id === args.jobId); if (!job) throw new Error("Saved core job missing"); if ((command === "resume_process_job" || command === "retry_process_job") && job.canContinue !== true) throw new Error("Original account required"); if (fixture.__controlDelay) await new Promise<void>(resolve => { fixture.__resolveControl = resolve; }); job.status = command === "pause_process_job" ? "paused" : command === "abort_process_job" ? "aborted" : "running"; job.googlePhotos.status = job.status; return true; }
  if (command === "process_job_diagnostics") { if (fixture.__diagnosticError) throw new Error("Protected diagnostics unavailable"); return "Core process job diagnostics\n4 accepted; 3 verified; 1 verification warning.\nSaved receipts retained; no tokens, session URLs or private paths."; }
  if (command === "process_job_albums") return [{ id: "app-album", title: "Synthetic event", productUrl: "https://photos.google.com/lr/album/synthetic" }];
  if (command === "process_job_open_album") return true;
  if (command === "process_job_reconcile_album") { fixture.__coreJob.googlePhotos.albums[0].state = "ready"; fixture.__coreJob.status = "paused"; fixture.__coreJob.googlePhotos.status = "paused"; return true; }
  if (command === "restore_process_job_history") { fixture.__coreJob.googlePhotos.historyHidden = false; return true; }
  if (command === "clear_finished_import_jobs") return 0;
  if (command === "clear_finished_process_jobs") { let count=0; for (const job of fixture.__coreJobs) if (["completed", "completed_with_warnings"].includes(job.status) && !job.googlePhotos?.historyHidden) { job.googlePhotos.historyHidden=true; count++; } return count; }
  if (command.startsWith("google_photos_")) throw new Error(`Forbidden separate Google management command: ${command}`);
  throw new Error(`Unexpected core Jobs fixture command: ${command}`);
} };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { if (fixture.__clipboardDenied) throw new Error("Synthetic clipboard denied"); fixture.__copied = value; } } });
function Preview() { const monitor = useJobsMonitor(true, 500); return <div style={{ height: "100%", overflow: "auto", padding: 12 }}><JobsPanel {...monitor} /><Jobs initialView="attention" monitor={monitor} /></div>; }
createRoot(document.getElementById("root")!).render(<Preview />);
