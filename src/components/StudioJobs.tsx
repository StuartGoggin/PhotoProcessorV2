import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
export default function StudioJobs({
  compact = false,
  onOpen,
}: {
  compact?: boolean;
  onOpen?: () => void;
}) {
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await invoke<StudioJob[]>("studio_list_jobs");
        if (alive) {
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
      <h2 className="text-lg font-semibold">Background renders and previews</h2>
      <p className="text-sm text-gray-400">
        You may change pages. Keep the app open. Pause takes effect between steps; Cancel interrupts
        FFmpeg.
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
          <progress
            className="w-full"
            max="100"
            value={j.progress}
            aria-label={`${j.name} progress`}
          />
          <div className="flex gap-2">
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
          </div>
          {j.output && <p className="text-xs break-all">{j.output}</p>}
          {j.error && <p className="text-red-400 text-sm break-all">{j.error}</p>}
          <details>
            <summary className="text-sm cursor-pointer">Processing log</summary>
            <pre className="text-xs whitespace-pre-wrap">{j.logs.join("\n")}</pre>
          </details>
        </div>
      ))}
    </section>
  );
}
