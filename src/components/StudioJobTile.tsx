import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import { studioJobProgress } from "../utils/jobProgress";
import StudioJobDiagnostics from "./StudioJobDiagnostics";
import JobProgressCard from "./JobProgressCard";

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
    <article className="job-tile min-w-0 w-full space-y-2">
      <JobProgressCard display={studioJobProgress(job)} compact />
      <div className="flex flex-wrap gap-2">
        {["interrupted", "failed", "cancelled"].includes(job.status) && <button className="btn-secondary text-xs" onClick={() => void invoke("studio_retry_job", { id: job.id }).catch((e) => setError(String(e)))}>Resume saved render</button>}
        {active && <button className="btn-secondary text-xs" onClick={() => void control(job.paused ? "resume" : "pause")}>{job.paused ? "Resume" : "Pause"}</button>}
        {active && <button className="btn-secondary text-xs" onClick={() => void control("cancel")}>Cancel</button>}
        {job.output && <button className="btn-secondary text-xs" onClick={() => void invoke("open_in_default_app", { path: job.output }).catch((e) => setError(String(e)))}>Play</button>}
      </div>
      {(error || job.error) && <p className="text-xs text-red-300 line-clamp-2">{job.status === "retried" ? "Previous attempt: " : ""}{error || job.error}</p>}
      <StudioJobDiagnostics job={job} showScheduler />
    </article>
  );
}
