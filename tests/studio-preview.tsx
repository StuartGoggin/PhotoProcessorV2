// Development-only browser fixture. Production starts at index.html.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { newProject } from "../src/types/videoStudio";
import "../src/styles.css";

const project = newProject();
project.name = "Afternoon training review";
project.outputDir = "D:\\Videos\\Training exports";
project.clips = ["Warm-up", "Technique practice", "Final run"].map((chapter, index) => ({
  id: `preview-${index}`, path: `D:\\Videos\\${chapter}.mp4`, chapter, duration: 25 + 10 * index,
  title: chapter, titleSeconds: 4, include: true, reviewed: index < 2,
  notes: "", replays: [], stabilization: "off", stabilizationMethod: "quality", customStabilization: { radius: 16, blockSize: 8, contrast: 125 }, framing: "edgeSafe", revision: 0,
  rendered: index === 0 ? { path: "D:/out/first.mp4", width: 3840, height: 2160, fps: 50, bitrateMbps: 32, revision: 0, signature: "fixture", renderedAt: new Date().toISOString(), duration: 25 } : null,
}));
localStorage.setItem("photogogo.videoStudio.project.v1", JSON.stringify(project));
const fixture = window as any;
const baseStudioJob = { kind: "clip", phase: "Render sample", progress: 40, logs: [], width: 3840, height: 2160, fps: 50, bitrateMbps: 32, createdAt: "2026-09-17T07:48:34Z", processId: 12345, processName: "ffmpeg.exe", heartbeatAt: "2026-09-17T07:48:34Z", progressAt: "2026-09-17T07:48:34Z", logPath: "D:/logs/job.log" };
fixture.__studioJobs = [
  { ...baseStudioJob, id: "diagnostic-fixture", name: "Diagnostic fixture", status: "running" },
  ...Array.from({ length: 5 }, (_, index) => ({ ...baseStudioJob, id: `queued-${index}`, name: `Queued render ${index + 1}`, status: "queued", queuePosition: index + 1 })),
  { ...baseStudioJob, id: "paused-fixture", name: "Paused fixture", status: "paused", paused: true },
  { ...baseStudioJob, id: "failed-fixture", name: "Failed export fixture", status: "failed", error: "Fixture error", recoverable: true },
  { ...baseStudioJob, id: "finished-fixture", name: "Finished export fixture", kind: "project", status: "completed", progress: 100, output: "D:/out/finished/project.mp4", finishedAt: "2026-09-17T07:55:00Z" },
];
const baseImportJob = { sourceDir: "E:/DCIM", stagingDir: "D:/Videos", logFilePath: "D:/logs/import.log", manifestFilePath: "D:/logs/manifest.json", reprocessExisting: false, createdAt: "2026-09-17T07:48:34Z", startedAt: null, finishedAt: null, sourceFileTotal: 20, ignoredFileTotal: 0, ignoredLegacyMd5SidecarTotal: 0, unsupportedFileTotal: 0, total: 20, done: 4, skipped: 0, speedMbps: 17, currentFile: "photo.jpg", imported: 4, md5SidecarHits: 0, md5Computed: 4, errors: [], logs: [], pauseRequested: false, abortRequested: false };
fixture.__importJobs = [
  { ...baseImportJob, id: "active-import-fixture", status: "running" },
  { ...baseImportJob, id: "completed-import-fixture", status: "completed", sourceDir: "F:/Completed-card" },
];
fixture.__descriptionText = "Afternoon training review\n\n00:00 Warm-up\n00:25 Technique practice\n01:00 Final run\n";
fixture.__TAURI_INTERNALS__ = { convertFileSrc: () => "", invoke: async (command: string, args: any) => {
  console.log("preview invoke", command, args);
  if (command === "load_settings") return { source_root: "E:/DCIM", staging_dir: "D:/Videos", archive_dir: "D:/Archive", exiftool_dir: "", stabilize_max_parallel_jobs: 3, stabilize_ffmpeg_threads_per_job: 4, face_scan_parallel_jobs: 1, face_scan_min_shard_mb: 10, face_scan_target_shard_mb: 100, timeline_preview_width: 420, timeline_preview_height: 240, timeline_preview_fps: 8 };
  if (command === "list_sd_cards" || command === "list_process_jobs") return [];
  if (command === "list_import_jobs") return fixture.__importJobs;
  if (command === "studio_start_render") {
    (window as any).__lastStudioRequest = args;
    return "preview-job";
  }
  if (command === "studio_clear_jobs") { (window as any).__studioCleared = true; return { cleared: 1 }; }
  if (command === "studio_list_jobs") return fixture.__studioCleared ? [] : fixture.__studioJobs;
  if (command === "studio_read_export_description") {
    if (fixture.__descriptionReadError) throw new Error("Fixture description read failure");
    return { text: fixture.__descriptionText, path: "D:/out/finished/youtube-description.txt", chapters: [{ startSeconds: 0, title: "Warm-up" }, { startSeconds: 25, title: "Technique practice" }, { startSeconds: 60, title: "Final run" }], warnings: [] };
  }
  if (command === "studio_save_export_description") {
    if (fixture.__descriptionSaveError) throw new Error("Fixture description save failure");
    fixture.__descriptionText = args.text;
    fixture.__savedDescription = args;
    return "D:/out/finished/youtube-description.txt";
  }
  if (command === "studio_read_job_log") return "Fixture detailed event log: PID 12345; command=ffmpeg; frame=500; speed=1.2x";
  if (command === "studio_missing_outputs") return [];
  if (command === "plugin:dialog|confirm") return (window as any).__confirmResult !== false;
  return null;
}};
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
