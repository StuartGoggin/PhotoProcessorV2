import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import { formatStudioMetric } from "../types/videoStudio";
import StudioSchedulerStatus from "./StudioSchedulerStatus";

function date(value?: string) { return value ? new Date(value).toLocaleString() : "Not recorded"; }
export default function StudioJobDiagnostics({ job, showScheduler = false }: { job: StudioJob; showScheduler?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!expanded) return;
    let alive = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const text = await invoke<string>("studio_read_job_log", { id: job.id }); if (alive) { setLog(text); setError(""); } }
      catch (e) { if (alive) setError(String(e)); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [expanded, job.id]);
  const stale = job.status === "running" && !!job.processId && (!job.heartbeatAt || now - Date.parse(job.heartbeatAt) > 15000);
  const quiet = job.status === "running" && !!job.processId && !!job.progressAt && now - Date.parse(job.progressAt) > 120000;
  const legacyTime = /^\d{19}-\d+$/.test(job.id) ? new Date(Number(job.id.split("-")[0]) / 1_000_000).toISOString() : "";
  return <div className="space-y-2 text-xs">
    <p className="text-gray-400 break-all">Attempt {job.id} · {date(job.createdAt || legacyTime)}</p>
    {job.retryOf && <p className="text-cyan-200 break-all">Retry of {job.retryOf}</p>}
    {job.retriedAs && <p className="text-cyan-200 break-all">Superseded by attempt {job.retriedAs}</p>}
    {job.status === "running" && <p className={stale || quiet ? "text-amber-200" : "text-gray-300"}>
      {job.processId ? `${job.processName || "Encoder"} · PID ${job.processId} · checked ${date(job.heartbeatAt)}` : job.logPath ? "No encoder process currently tracked — preparing or verifying media" : "Legacy job: no live process diagnostics available"}
      {stale && " · Status check overdue; running state is unconfirmed."}
      {quiet && " · No recent encoder progress; inspect the detailed log."}
    </p>}
    {showScheduler && job.status === "running" && <details className="max-h-56 overflow-y-auto">
      <summary className="cursor-pointer text-cyan-200">Shared processing capacity & active task threads</summary>
      <div className="mt-2 space-y-2">
        <StudioSchedulerStatus jobs={[job]} />
        {!!job.activeTasks?.length && <ul className="space-y-1" aria-label={`${job.name} active task threads`}>
          {job.activeTasks.map((task) => <li key={task.key} className="break-words">{task.phase} · {formatStudioMetric(task.threads, "threads")}{task.processId ? ` · PID ${task.processId}` : ""}</li>)}
        </ul>}
      </div>
    </details>}
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-cyan-200">Detailed job log</summary>
      <div className="mt-2 space-y-2">
        <p>Started: {date(job.startedAt)} · Finished: {date(job.finishedAt)}</p>
        <p>Last encoder progress: {date(job.progressAt)}</p>
        {job.logPath && <button className="btn-secondary text-xs" onClick={() => void invoke("reveal_in_explorer", { path: job.logPath }).catch(e => setError(String(e)))}>Open log folder</button>}
        <p className="text-gray-400">Updates every 3 seconds. Shows the event log and tails of recent process logs; full files remain in the log folder. Logs contain local file paths.</p>
        {error && <p role="alert" className="text-red-300">{error}</p>}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-surface-900 rounded p-2">{log || "Loading log…"}</pre>
      </div>
    </details>
  </div>;
}
