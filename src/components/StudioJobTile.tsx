import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import StudioJobDiagnostics from "./StudioJobDiagnostics";

const statusStyle: Record<string, string> = {
  queued: "text-blue-300",
  running: "text-emerald-300",
  completed: "text-gray-200",
  failed: "text-red-300",
  cancelled: "text-amber-300",
  interrupted: "text-amber-300",
};

export default function StudioJobTile({ job }: { job: StudioJob }) {
  const [error, setError] = useState("");
  const active = ["queued", "running", "paused"].includes(job.status);
  async function control(action: "pause" | "resume" | "cancel") {
    try {
      await invoke("studio_control_job", { id: job.id, action });
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <article className="w-72 flex-shrink-0 rounded border border-cyan-800 bg-surface-800 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-cyan-300">Video Studio {job.kind || "render"}</p>
          <h3 className="font-medium text-sm text-white truncate" title={job.name}>{job.name}</h3>
        </div>
        <span className={`text-xs ${statusStyle[job.status] || "text-gray-300"}`}>{job.status}</span>
      </div>
      <p className="text-xs text-gray-400 truncate" title={job.phase}>{job.phase}</p>
      <progress className="w-full" max="100" value={job.progress} aria-label={`${job.name} progress`} />
      <div className="flex flex-wrap gap-2">
        {["interrupted", "failed", "cancelled"].includes(job.status) && <button className="btn-secondary text-xs" onClick={() => void invoke("studio_retry_job", { id: job.id }).catch((e) => setError(String(e)))}>Resume saved render</button>}
        {active && <button className="btn-secondary text-xs" onClick={() => void control(job.paused ? "resume" : "pause")}>{job.paused ? "Resume" : "Pause"}</button>}
        {active && <button className="btn-secondary text-xs" onClick={() => void control("cancel")}>Cancel</button>}
        {job.output && <button className="btn-secondary text-xs" onClick={() => void invoke("open_in_default_app", { path: job.output }).catch((e) => setError(String(e)))}>Play</button>}
      </div>
      {(error || job.error) && <p className="text-xs text-red-300 line-clamp-2">{job.status === "retried" ? "Previous attempt: " : ""}{error || job.error}</p>}
      <StudioJobDiagnostics job={job} />
    </article>
  );
}
