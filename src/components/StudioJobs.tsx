import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import { formatStudioMetric, isPendingStudioJob, liveStudioScheduler, sortStudioJobs } from "../types/videoStudio";
import StudioSchedulerStatus from "./StudioSchedulerStatus";

const percent = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const duration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  if (total >= 3600) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  return total >= 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total}s`;
};

export default function StudioJobs({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void }) {
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [fetchError, setFetchError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await invoke<StudioJob[]>("studio_list_jobs");
        if (alive) {
          setJobs(data);
          setFetchError("");
        }
      } catch (e) {
        if (alive) setFetchError(String(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  async function control(id: string, action: string) {
    setPendingJob(id);
    setActionError("");
    try {
      await invoke("studio_control_job", { id, action });
      setJobs(await invoke<StudioJob[]>("studio_list_jobs"));
    } catch (e) {
      setActionError(String(e));
    } finally {
      setPendingJob(null);
    }
  }
  const orderedJobs = sortStudioJobs(jobs);
  const active = orderedJobs.filter(isPendingStudioJob);
  const scheduler = liveStudioScheduler(jobs);
  const maxQueuePosition = Math.max(0, ...jobs.map((j) => j.queuePosition ?? 0));
  const error = actionError || fetchError;
  if (compact) {
    const first = active.find((j) => j.status === "running") || active[0];
    return first ? (
      <div className="px-4 py-2 bg-surface-800 border-t border-surface-600 text-sm text-cyan-200">
        <button onClick={onOpen}>
          Video Studio: {active.length} job(s) · {first.status === "interrupted" ? "Interrupted — resume when ready" : first.phase} · {Math.round(percent(first.progress))}% — Open queue
        </button>
      </div>
    ) : null;
  }
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Production queue</h2>
      <p className="text-sm text-gray-400">
        You may change pages while rendering. Pause finishes active steps before releasing capacity; Cancel interrupts FFmpeg.
        After an app restart, resume interrupted jobs to reuse completed work. Keep the app open for processing to continue.
      </p>
      {error && <p role="alert" className="text-red-400 break-words">{error}</p>}
      <StudioSchedulerStatus jobs={jobs} />
      {!jobs.length && <p className="text-gray-400">No renders queued yet. Start with a clip preview to check your preset.</p>}
      {orderedJobs.map((j) => {
        const paused = j.status === "paused" || j.paused;
        const resumable = j.status === "paused" || (j.status === "interrupted" && j.recoverable);
        const controllable = isPendingStudioJob(j);
        const retryable = j.recoverable && ["failed", "cancelled", "interrupted"].includes(j.status);
        const pending = pendingJob !== null;
        return (
          <div key={j.id} className="p-4 rounded bg-surface-800 space-y-3">
            <div className="flex flex-wrap justify-between gap-2">
              <strong className="break-words">{j.name}</strong>
              <span className={j.status === "interrupted" || paused ? "text-amber-200" : "text-cyan-200"}>
                {j.queuePosition != null ? `#${j.queuePosition} in queue · ` : ""}{j.status === "interrupted" && !j.recoverable ? "retried" : j.status}
                {j.paused && j.status === "running" ? " · pausing after active steps" : ""}
              </span>
            </div>
            <p className="text-sm">{j.phase}</p>
            <progress className="w-full" max="100" value={percent(j.progress)} aria-label={`${j.name} progress`} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-300">
              <span>{Math.round(percent(j.progress))}%</span>
              <span>Elapsed {duration(j.elapsedSeconds ?? 0)}</span>
              {j.status === "running" && <span>{j.etaSeconds != null && Number.isFinite(j.etaSeconds) ? `About ${duration(j.etaSeconds)} remaining` : "Estimating remaining time…"}</span>}
              <span>{j.cacheHits ?? 0} cached fragment(s) reused</span>
            </div>
            {(j.encoder || j.workerLimit > 0) && (
              <div className="rounded bg-surface-900 p-2 text-xs space-y-1">
                <p>{j.encoder || "Detecting encoder"}{j.status === "running" && scheduler
                  ? " · capacity is managed by the shared scheduler above"
                  : j.workerLimit > 0 ? ` · configured limit: ${j.workerLimit} parallel task(s) · ${j.threadsPerWorker} CPU threads/task` : ""}</p>
                {j.hardwareNote && <p className="text-gray-400">{j.hardwareNote}</p>}
              </div>
            )}
            {j.status === "running" && !!j.activeTasks?.length && (
              <ul className="space-y-2 text-xs" aria-label={`${j.name} active work`}>
                {j.activeTasks.map((task) => (
                  <li key={task.key} className="rounded border border-surface-600 p-2">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="break-words">{task.phase}</span>
                      <span>{Math.round(percent(task.progress))}%{task.fps != null && Number.isFinite(task.fps) ? ` · ${task.fps.toFixed(1)} fps` : ""}{task.speed != null && Number.isFinite(task.speed) ? ` · ${task.speed.toFixed(2)}× playback` : ""} · {formatStudioMetric(task.threads, "threads")}</span>
                    </div>
                    <progress className="w-full" max="100" value={percent(task.progress)} aria-label={`${task.phase} progress`} />
                  </li>
                ))}
              </ul>
            )}
            {j.status === "interrupted" && j.recoverable && <p className="text-sm text-amber-200">Processing stopped when the app closed. Resume when ready; completed cached fragments will be reused.</p>}
            {j.persistenceError && <p role="alert" className="text-sm text-amber-200 break-all">Queue recovery could not be saved: {j.persistenceError}. Keep the app open and save a project snapshot.</p>}
            <div className="flex flex-wrap gap-2">
              {["running", "queued"].includes(j.status) && <button className="btn-secondary" disabled={pending} onClick={() => void control(j.id, paused ? "resume" : "pause")}>{paused ? "Resume" : "Pause"}</button>}
              {resumable && <button className="btn-primary" disabled={pending} onClick={() => void control(j.id, "resume")}>Resume</button>}
              {controllable && <button className="btn-secondary" disabled={pending} onClick={() => void control(j.id, "cancel")}>Cancel</button>}
              {j.status === "queued" && <>
                <button className="btn-secondary" disabled={pending || j.queuePosition == null || j.queuePosition <= 1} onClick={() => void control(j.id, "up")}>Move earlier</button>
                <button className="btn-secondary" disabled={pending || j.queuePosition == null || j.queuePosition >= maxQueuePosition} onClick={() => void control(j.id, "down")}>Move later</button>
              </>}
              {retryable && <>
                {j.status !== "interrupted" && <button className="btn-primary" disabled={pending} onClick={() => void control(j.id, "retry")}>Retry</button>}
                <button className="btn-secondary" disabled={pending} onClick={() => void control(j.id, "retryCpu")}>Retry using CPU</button>
              </>}
              {j.output && <>
                <button className="btn-primary" onClick={() => void invoke("open_in_default_app", { path: j.output }).catch((e) => setActionError(String(e)))}>Play result</button>
                <button className="btn-secondary" onClick={() => void invoke("reveal_in_explorer", { path: j.output }).catch((e) => setActionError(String(e)))}>Show file</button>
              </>}
              {pendingJob === j.id && <span role="status" className="text-xs text-gray-400 self-center">Updating queue…</span>}
            </div>
            {j.output && <p className="text-xs break-all">{j.output}</p>}
            {j.error && <p className="text-red-400 text-sm break-all">{j.error}</p>}
            <details>
              <summary className="text-sm cursor-pointer">Processing log</summary>
              <pre className="text-xs whitespace-pre-wrap break-words max-h-72 overflow-auto">{j.logs.join("\n")}</pre>
            </details>
          </div>
        );
      })}
    </section>
  );
}
