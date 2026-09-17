import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { STUDIO_CLEARED, notifyStudioCleared } from "../utils/studioWorkflow";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import StudioJobDiagnostics from "./StudioJobDiagnostics";
export default function StudioJobs({
  compact = false,
  onOpen,
}: {
  compact?: boolean;
  onOpen?: () => void;
}) {
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [error, setError] = useState("");
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
          setError("");
        }
      } catch (e) {
        if (alive) setError(String(e));
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
    try {
      await invoke("studio_control_job", { id, action });
    } catch (e) {
      setError(String(e));
    }
  }
  async function retry(id: string) {
    try { await invoke("studio_retry_job", { id }); setError(""); }
    catch (e) { setError(String(e)); }
  }
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));
  if (compact)
    return active.length ? (
      <div className="px-4 py-2 bg-surface-800 border-t border-surface-600 text-sm text-cyan-200">
        <button onClick={onOpen}>
          Video Studio: {active.length} background job(s) · {active[0].phase} ·{" "}
          {Math.round(active[0].progress)}% — Open
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
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {!jobs.length && <p>No renders queued yet.</p>}
      {jobs.map((j) => (
        <div key={j.id} className="p-3 rounded bg-surface-800 space-y-2">
          <div className="flex justify-between">
            <strong>{j.name}</strong>
            <span>
              {j.status}
              {j.paused ? " · pause requested" : ""}
            </span>
          </div>
          <p className="text-sm">{j.phase}</p>
          <p className="text-xs text-gray-400">{j.kind} · {j.width}×{j.height} · {j.fps} fps · {j.bitrateMbps ?? "—"} Mbps · {j.artifacts?.length ?? 0} clips saved</p>
          <progress
            className="w-full"
            max="100"
            value={j.progress}
            aria-label={`${j.name} progress`}
          />
          <fieldset disabled={clearing} className="flex gap-2">
            {["interrupted", "failed", "cancelled"].includes(j.status) && <button className="btn-primary" onClick={() => void retry(j.id)}>Resume saved render</button>}
            {["running", "queued"].includes(j.status) && (
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
            <pre className="text-xs whitespace-pre-wrap">{j.logs.join("\n")}</pre>
          </details>
        </div>
      ))}
    </section>
  );
}
