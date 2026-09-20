import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { STUDIO_CLEARED, notifyStudioCleared } from "../utils/studioWorkflow";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import { formatStudioMetric, isPendingStudioJob, liveStudioScheduler, sortStudioJobs } from "../types/videoStudio";
import StudioJobDiagnostics from "./StudioJobDiagnostics";
import StudioSchedulerStatus from "./StudioSchedulerStatus";

const percent = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
export default function StudioJobs({
  compact = false,
  onOpen,
}: {
  compact?: boolean;
  onOpen?: () => void;
}) {
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [error, setError] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const clear = () => { generation.current++; setJobs([]); };
    window.addEventListener(STUDIO_CLEARED, clear);
    return () => window.removeEventListener(STUDIO_CLEARED, clear);
  }, []);
  async function clearAll() {
    setClearing(true);
    setError("");
    try {
      if (!await confirm("Stop all active Studio jobs and clear queued, completed, failed and interrupted attempts? Clip render status will reset and the next render will start fresh. Source clips, project edits, music, exported videos and diagnostic files stay on disk.", { title: "Clear all Studio renders?", kind: "warning" })) return;
      const result = await invoke<{ cleared: number }>("studio_clear_jobs");
      notifyStudioCleared();
      setMessage(`Cleared ${result.cleared} Studio jobs. Ready to render from scratch.`);
    } catch (e) { setError(String(e)); }
    finally { setClearing(false); }
  }
  useEffect(() => {
    let alive = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const epoch = generation.current;
      try {
        const data = await invoke<StudioJob[]>("studio_list_jobs");
        if (alive && epoch === generation.current) {
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
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  async function control(id: string, action: string) {
    setPendingJob(id); setError("");
    try {
      await invoke("studio_control_job", { id, action });
    } catch (e) {
      setError(String(e));
    } finally { setPendingJob(null); }
  }
  async function retry(id: string) {
    try { await invoke("studio_retry_job", { id }); setError(""); }
    catch (e) { setError(String(e)); }
  }
  const orderedJobs = sortStudioJobs(jobs);
  const active = orderedJobs.filter(isPendingStudioJob);
  const scheduler = liveStudioScheduler(jobs);
  const maxQueuePosition = Math.max(0, ...jobs.map((j) => j.queuePosition ?? 0));
  if (compact)
    return active.length ? (
      <div className="px-4 py-2 bg-surface-800 border-t border-surface-600 text-sm text-cyan-200">
        <button onClick={onOpen}>
          Video Studio: {active.length} background job(s) · {active[0].phase} ·{" "}
          {Math.round(percent(active[0].progress))}% — Open
        </button>
      </div>
    ) : null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Render history & recovery</h2>
        <button className="btn-secondary" disabled={clearing} onClick={() => void clearAll()}>
          {clearing ? "Stopping jobs and clearing…" : "Clear all Studio renders"}
        </button>
      </div>
      {message && <p role="status" className="text-sm text-cyan-200">{message}</p>}
      <p className="text-sm text-gray-400">
        Work continues while you change pages. Pause takes effect between steps. After an interruption,
        resume the saved request to reuse verified clips and finish the video.
      </p>
      {(error || fetchError) && (
        <p role="alert" className="text-red-400">
          {error || fetchError}
        </p>
      )}
      <StudioSchedulerStatus jobs={jobs} />
      {!jobs.length && <p>No renders queued yet. Start with a clip preview to check your preset.</p>}
      {orderedJobs.map((j) => (
        <div key={j.id} className="p-3 rounded bg-surface-800 space-y-2">
          <div className="flex justify-between">
            <strong>{j.name}</strong>
            <span>
              {j.status}
              {j.paused ? " · pause requested" : ""}
            </span>
          </div>
          <p className="text-sm">{j.phase}</p>
          <p className="text-xs text-gray-400">{j.queuePosition ? `Queue #${j.queuePosition} · ` : ""}{j.encoder || "Encoder selected when started"}{j.status === "running" && scheduler ? " · capacity is managed by the shared scheduler above" : ` · configured limit: ${j.workerLimit || 0} parallel task(s) · ${j.threadsPerWorker || 0} CPU threads/task`} · {j.cacheHits || 0} cache hits</p>
          {j.hardwareNote && <p className="text-xs text-gray-400">{j.hardwareNote}</p>}
          {!!j.elapsedSeconds && <p className="text-xs text-gray-400">Elapsed {Math.round(j.elapsedSeconds)}s{j.status === "running" && j.etaSeconds != null && Number.isFinite(j.etaSeconds) ? ` · approximately ${Math.ceil(j.etaSeconds)}s remaining` : ""}</p>}
          {j.persistenceError && <p role="alert" className="text-amber-300">Recovery checkpoint: {j.persistenceError}</p>}
          {j.status === "running" && !!j.activeTasks?.length && <div className="space-y-2">{j.activeTasks.map((task) => <div key={task.key} className="text-xs">
            <p>{task.phase} · {Math.round(percent(task.progress))}% {task.fps != null && Number.isFinite(task.fps) ? `· ${task.fps.toFixed(1)} fps` : ""} {task.speed != null && Number.isFinite(task.speed) ? `· ${task.speed.toFixed(2)}×` : ""} {task.processId ? `· PID ${task.processId}` : ""} · {formatStudioMetric(task.threads, "threads")}</p>
            <progress className="w-full" max={100} value={percent(task.progress)} aria-label={`${task.phase} progress`} />
          </div>)}</div>}
          <p className="text-xs text-gray-400">{j.kind} · {j.width}×{j.height} · {j.fps} fps · {j.bitrateMbps ?? "—"} Mbps · {j.artifacts?.length ?? 0} clips saved</p>
          <progress
            className="w-full"
            max="100"
            value={percent(j.progress)}
            aria-label={`${j.name} progress`}
          />
          <fieldset disabled={clearing || pendingJob !== null} className="flex flex-wrap gap-2">
            {j.status === "queued" && <><button className="btn-secondary" disabled={j.queuePosition == null || j.queuePosition <= 1} onClick={() => void control(j.id, "up")}>Move earlier</button><button className="btn-secondary" disabled={j.queuePosition == null || j.queuePosition >= maxQueuePosition} onClick={() => void control(j.id, "down")}>Move later</button></>}
            {["interrupted", "failed", "cancelled"].includes(j.status) && j.kind !== "music" && <button className="btn-secondary" onClick={() => void control(j.id, "retryCpu")}>Retry with CPU</button>}
            {["interrupted", "failed", "cancelled"].includes(j.status) && <button className="btn-primary" onClick={() => void retry(j.id)}>Resume saved render</button>}
            {["running", "queued", "paused"].includes(j.status) && (
              <>
                <button
                  className="btn-secondary"
                  onClick={() => void control(j.id, j.paused ? "resume" : "pause")}
                >
                  {j.paused ? "Resume" : "Pause"}
                </button>
                <button className="btn-secondary" onClick={() => void control(j.id, "cancel")}>
                  Cancel
                </button>
              </>
            )}
            {j.output && (
              <>
                <button
                  className="btn-primary"
                  onClick={() =>
                    void invoke("open_in_default_app", { path: j.output }).catch((e) =>
                      setError(String(e))
                    )
                  }
                >
                  Play result
                </button>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    void invoke("reveal_in_explorer", { path: j.output }).catch((e) =>
                      setError(String(e))
                    )
                  }
                >
                  Show file
                </button>
              </>
            )}
          </fieldset>
          {j.output && <p className="text-xs break-all">{j.output}</p>}
          {j.error && <p className={j.status === "retried" ? "text-gray-400 text-sm break-all" : "text-red-400 text-sm break-all"}>{j.status === "retried" ? "Previous attempt error: " : ""}{j.error}</p>}
          <StudioJobDiagnostics job={j} />
          <details>
            <summary className="text-sm cursor-pointer">Processing log</summary>
            <pre className="text-xs whitespace-pre-wrap break-words max-h-72 overflow-auto">{j.logs.join("\n")}</pre>
          </details>
        </div>
      ))}
    </section>
  );
}
