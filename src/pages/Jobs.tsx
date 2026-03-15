import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob } from "../types";
import { ProgressBar } from "../components";

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

export default function Jobs() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(true);
  const [loading, setLoading] = useState(false);

  async function loadJobs() {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<ImportJob[]>("list_import_jobs");
      setJobs(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function clearFinished() {
    setError(null);
    try {
      await invoke<number>("clear_finished_import_jobs");
      await loadJobs();
    } catch (e) {
      setError(String(e));
    }
  }

  async function pauseJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("pause_import_job", { jobId });
      await loadJobs();
    } catch (e) {
      setError(String(e));
    }
  }

  async function resumeJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("resume_import_job", { jobId });
      await loadJobs();
    } catch (e) {
      setError(String(e));
    }
  }

  async function abortJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("abort_import_job", { jobId });
      await loadJobs();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    loadJobs();
  }, []);

  useEffect(() => {
    if (!tail) return;
    const timer = window.setInterval(() => {
      void loadJobs();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [tail]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Background Jobs</h2>
      <p className="text-gray-400 text-sm mb-4">
        Monitor queued/running imports while working on other tabs.
      </p>

      <div className="card mb-4 flex items-center gap-2 flex-wrap">
        <button className="btn-secondary" onClick={loadJobs} disabled={loading}>
          Refresh
        </button>
        <button className="btn-secondary" onClick={clearFinished} disabled={loading}>
          Clear Finished
        </button>
        <label className="flex items-center gap-2 text-sm text-gray-300 ml-2">
          <input type="checkbox" className="h-4 w-4" checked={tail} onChange={(e) => setTail(e.target.checked)} />
          Tail (auto-refresh)
        </label>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="card text-sm text-gray-400">No jobs yet.</div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const progress = pct(job.done, job.total);
            const doneLabel = job.total > 0 ? `${job.done}/${job.total}` : `${job.done}`;

            return (
              <div key={job.id} className="card space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm text-gray-200 font-medium">{job.id}</div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs px-2 py-1 rounded bg-surface-700 text-gray-200">{job.status}</div>
                    {(job.status === "running" || job.status === "queued") && (
                      <button className="btn-secondary" onClick={() => pauseJob(job.id)}>
                        Pause
                      </button>
                    )}
                    {job.status === "paused" && (
                      <button className="btn-secondary" onClick={() => resumeJob(job.id)}>
                        Resume
                      </button>
                    )}
                    {(job.status === "running" || job.status === "paused" || job.status === "queued") && (
                      <button className="btn-danger" onClick={() => abortJob(job.id)}>
                        Abort
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-gray-400">
                  <div>Source: <span className="text-gray-200 break-all">{job.sourceDir}</span></div>
                  <div>Staging: <span className="text-gray-200 break-all">{job.stagingDir}</span></div>
                  <div>Mode: <span className="text-gray-200">{job.reprocessExisting ? "reprocess" : "import"}</span></div>
                  <div>Speed: <span className="text-gray-200">{job.speedMbps.toFixed(1)} MB/s</span></div>
                  <div>MD5 Sidecar: <span className="text-gray-200">{job.md5SidecarHits}</span></div>
                  <div>MD5 Computed: <span className="text-gray-200">{job.md5Computed}</span></div>
                </div>

                <div>
                  <ProgressBar
                    total={job.total || 1}
                    done={Math.min(job.done, job.total || 1)}
                    label={job.currentFile || ""}
                    extra={`${doneLabel} • skipped ${job.skipped} • imported ${job.imported} • ${progress.toFixed(0)}%`}
                  />
                  {job.currentFile && (
                    <div className="mt-1 text-xs text-gray-500 truncate">Current: {job.currentFile}</div>
                  )}
                </div>

                {job.errors.length > 0 && (
                  <div className="text-xs text-red-300 bg-red-900/20 border border-red-700 rounded p-2 max-h-24 overflow-auto">
                    {job.errors.map((line, idx) => (
                      <div key={idx}>{line}</div>
                    ))}
                  </div>
                )}

                <div className="space-y-1">
                  <label htmlFor={`job-console-${job.id}`} className="text-xs text-gray-400">Job Console</label>
                  <textarea
                    id={`job-console-${job.id}`}
                    readOnly
                    value={job.logs.join("\n")}
                    className="w-full h-32 resize-y overflow-auto bg-surface-900 border border-surface-600 rounded-lg p-2 text-xs text-green-300 font-mono"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
