import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessJob } from "../types";

/** Every process task crosses the same native control interface. Google account
 * binding is a native capability, not a separate frontend account poll. */
export default function ProcessJobControls({ job, onChanged }: { job: ProcessJob; onChanged?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mayContinue = job.task !== "googlePhotos" || (job.canContinue === true && !job.persistenceError);
  async function run(command: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await invoke(command, { jobId: job.id }); await onChanged?.(); }
    catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div>
    <div className="flex flex-wrap items-center gap-2">
      {["running", "queued"].includes(job.status) && <button className="btn-secondary" disabled={busy} onClick={() => void run("pause_process_job")}>Pause</button>}
      {job.status === "paused" && <button className="btn-secondary" disabled={busy || !mayContinue} onClick={() => void run("resume_process_job")}>Resume</button>}
      {job.task === "googlePhotos" && ["needs_attention", "failed", "aborted"].includes(job.status) && <button className="btn-secondary" disabled={busy || !mayContinue} onClick={() => void run("retry_process_job")}>Retry</button>}
      {job.task === "googlePhotos" && job.status === "completed_with_warnings" && (job.googlePhotos?.accepted ?? 0) > (job.googlePhotos?.uploaded ?? 0) && <button className="btn-secondary" disabled={busy || !mayContinue} onClick={() => void run("retry_process_job")}>Recheck verification</button>}
      {["running", "queued", "paused"].includes(job.status) && <button className="btn-danger" disabled={busy} onClick={() => void run("abort_process_job")}>Abort</button>}
    </div>
    {!mayContinue && <p className="text-xs text-amber-200 mt-2">{job.controlBlockedReason || "Reconnect the original Google account and OAuth client to continue this saved job."}</p>}
    {error && <p role="alert" className="text-xs text-red-300 mt-2">{error}</p>}
  </div>;
}
