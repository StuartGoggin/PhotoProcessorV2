// Development-only browser fixture. Production starts at index.html.
import React from "react";
import { createRoot } from "react-dom/client";
import VideoStudio from "../src/pages/VideoStudio";
import { newProject } from "../src/types/videoStudio";
import "../src/styles.css";

const project = newProject();
project.name = "Afternoon training review";
project.outputDir = "D:\\Videos\\Training exports";
project.clips = ["Warm-up", "Technique practice", "Final run"].map((chapter, index) => ({
  id: `preview-${index}`, path: `D:\\Videos\\${chapter}.mp4`, chapter, duration: 25 + 10 * index,
  title: chapter, titleSeconds: 4, include: true, reviewed: index < 2,
  notes: "", replays: [], stabilization: "off", framing: "edgeSafe", revision: 0,
  rendered: index === 0 ? { path: "D:/out/first.mp4", width: 3840, height: 2160, fps: 50, bitrateMbps: 32, revision: 0, signature: "fixture", renderedAt: new Date().toISOString(), duration: 25 } : null,
}));
localStorage.setItem("photogogo.videoStudio.project.v1", JSON.stringify(project));
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  console.log("preview invoke", command, args);
  if (command === "load_settings") return { staging_dir: "D:/Videos" };
  if (command === "studio_start_render") {
    (window as any).__lastStudioRequest = args;
    return "preview-job";
  }
  if (command === "studio_clear_jobs") { (window as any).__studioCleared = true; return { cleared: 1 }; }
  if (command === "studio_list_jobs") return (window as any).__studioCleared ? [] : [{ id: "1789631314733811400-31304", name: "Diagnostic fixture", kind: "clip", status: "running", phase: "Render sample", progress: 40, logs: [], width: 3840, height: 2160, fps: 50, bitrateMbps: 32, createdAt: "2026-09-17T07:48:34Z", processId: 12345, processName: "ffmpeg.exe", heartbeatAt: "2026-09-17T07:48:34Z", progressAt: "2026-09-17T07:48:34Z", logPath: "D:/logs/job.log" }];
  if (command === "studio_read_job_log") return "Fixture detailed event log: PID 12345; command=ffmpeg; frame=500; speed=1.2x";
  if (command === "studio_missing_outputs") return [];
  if (command === "plugin:dialog|confirm") return (window as any).__confirmResult !== false;
  return null;
}};
createRoot(document.getElementById("root")!).render(<React.StrictMode><main className="h-full overflow-auto"><VideoStudio jobs={[]} onOpenJobs={() => {}} /></main></React.StrictMode>);
