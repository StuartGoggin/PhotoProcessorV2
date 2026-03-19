import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob } from "../types";
import { ProgressBar } from "../components";

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

type ProcessFilter = "all" | "active" | "issues" | "finished";

const PROCESS_FILTERS: Array<{ id: ProcessFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "issues", label: "Issues" },
  { id: "finished", label: "Finished" },
];

const PROCESS_TASK_LABELS: Record<ProcessJob["task"], string> = {
  focus: "Focus Detection",
  remove_focus: "Remove Focus Flags",
  enhance: "JPG Enhancement",
  remove_enhance: "Remove Enhancement Outputs",
  bw: "B&W Conversion",
  remove_bw: "Remove B&W Outputs",
  stabilize: "MP4 Stabilisation",
  remove_stabilize: "Remove Stabilised MP4s",
};

const PROCESS_SCOPE_LABELS: Record<ProcessJob["scopeMode"], string> = {
  entireStaging: "Entire staging",
  folderRecursive: "Folder recursively",
  folderOnly: "This folder only",
};

const STABILIZATION_MODE_LABELS: Record<NonNullable<ProcessJob["stabilizationMode"]>, string> = {
  maxFrame: "Max Frame",
  edgeSafe: "Edge-Safe",
  aggressiveCrop: "Aggressive Crop",
};

const STABILIZATION_STRENGTH_LABELS: Record<NonNullable<ProcessJob["stabilizationStrength"]>, string> = {
  gentle: "Gentle",
  balanced: "Balanced",
  strong: "Strong",
};

const PROCESS_STATUS_STYLES: Record<ProcessJob["status"], string> = {
  queued: "bg-blue-900/30 border-blue-700 text-blue-200",
  running: "bg-emerald-900/30 border-emerald-700 text-emerald-200",
  paused: "bg-amber-900/30 border-amber-700 text-amber-200",
  aborted: "bg-red-900/30 border-red-700 text-red-200",
  completed: "bg-surface-700 border-surface-500 text-gray-200",
  failed: "bg-red-900/50 border-red-600 text-red-200",
};

function matchesProcessFilter(job: ProcessJob, filter: ProcessFilter): boolean {
  switch (filter) {
    case "active":
      return job.status === "queued" || job.status === "running" || job.status === "paused";
    case "issues":
      return job.status === "failed" || job.status === "aborted";
    case "finished":
      return job.status === "completed" || job.status === "failed" || job.status === "aborted";
    case "all":
    default:
      return true;
  }
}

function toEpoch(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function summarizeLabels(values: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([label, count]) => ({ label, count }));
}

export default function Jobs() {
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [processJobs, setProcessJobs] = useState<ProcessJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [processFilter, setProcessFilter] = useState<ProcessFilter>("active");
  const [expandedProcessLogs, setExpandedProcessLogs] = useState<Record<string, boolean>>({});

  async function loadJobs() {
    setLoading(true);
    setError(null);
    try {
      const [importData, processData] = await Promise.all([
        invoke<ImportJob[]>("list_import_jobs"),
        invoke<ProcessJob[]>("list_process_jobs"),
      ]);
      setImportJobs(importData);
      setProcessJobs(processData);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function clearFinished() {
    setError(null);
    try {
      await Promise.all([
        invoke<number>("clear_finished_import_jobs"),
        invoke<number>("clear_finished_process_jobs"),
      ]);
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

  async function pauseProcessJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("pause_process_job", { jobId });
      await loadJobs();
    } catch (e) {
      setError(String(e));
    }
  }

  async function resumeProcessJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("resume_process_job", { jobId });
      await loadJobs();
    } catch (e) {
      setError(String(e));
    }
  }

  async function abortProcessJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("abort_process_job", { jobId });
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

  const processCounts = useMemo(() => {
    const counts: Record<ProcessFilter, number> = {
      all: processJobs.length,
      active: 0,
      issues: 0,
      finished: 0,
    };

    for (const job of processJobs) {
      if (job.status === "queued" || job.status === "running" || job.status === "paused") {
        counts.active += 1;
      }
      if (job.status === "failed" || job.status === "aborted") {
        counts.issues += 1;
      }
      if (job.status === "completed" || job.status === "failed" || job.status === "aborted") {
        counts.finished += 1;
      }
    }

    return counts;
  }, [processJobs]);

  const filteredProcessJobs = useMemo(() => {
    return [...processJobs]
      .sort((a, b) => {
        const byCreated = toEpoch(b.createdAt) - toEpoch(a.createdAt);
        if (byCreated !== 0) return byCreated;
        return b.id.localeCompare(a.id);
      })
      .filter((job) => matchesProcessFilter(job, processFilter));
  }, [processFilter, processJobs]);

  const stabilizeOverview = useMemo(() => {
    const stabilizeJobs = processJobs.filter((job) => job.task === "stabilize");
    const activeCount = stabilizeJobs.filter((job) =>
      job.status === "queued" || job.status === "running" || job.status === "paused"
    ).length;

    const modes = summarizeLabels(
      stabilizeJobs.map((job) =>
        job.stabilizationMode ? STABILIZATION_MODE_LABELS[job.stabilizationMode] : "Unspecified"
      )
    );

    const strengths = summarizeLabels(
      stabilizeJobs.map((job) =>
        job.stabilizationStrength ? STABILIZATION_STRENGTH_LABELS[job.stabilizationStrength] : "Unspecified"
      )
    );

    const bitratePolicies = summarizeLabels(
      stabilizeJobs.map((job) =>
        typeof job.preserveSourceBitrate === "boolean"
          ? job.preserveSourceBitrate
            ? "Preserve source bitrate"
            : "Encoder quality mode"
          : "Unspecified"
      )
    );

    const threading = summarizeLabels(
      stabilizeJobs.map((job) =>
        typeof job.stabilizeMaxParallelJobsUsed === "number" ||
        typeof job.stabilizeFfmpegThreadsPerJobUsed === "number"
          ? `${job.stabilizeMaxParallelJobsUsed ?? "-"} parallel jobs • ${job.stabilizeFfmpegThreadsPerJobUsed ?? "-"} ffmpeg threads/job`
          : "Not yet applied"
      )
    );

    return {
      total: stabilizeJobs.length,
      active: activeCount,
      modes,
      strengths,
      bitratePolicies,
      threading,
    };
  }, [processJobs]);

  function toggleProcessLogs(jobId: string) {
    setExpandedProcessLogs((prev) => ({
      ...prev,
      [jobId]: !prev[jobId],
    }));
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Background Jobs</h2>
      <p className="text-gray-400 text-sm mb-4">
        Monitor queued/running import and post-process jobs while working on other tabs.
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

      {importJobs.length === 0 && processJobs.length === 0 ? (
        <div className="card text-sm text-gray-400">No jobs yet.</div>
      ) : (
        <div className="space-y-6">
          {importJobs.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Import Jobs</h3>
              {importJobs.map((job) => {
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
            </section>
          )}

          {processJobs.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-400">Post-Process Jobs</h3>
                  <p className="text-xs text-gray-500 mt-1">Newest first. Filter by status to focus on active or problem jobs.</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {PROCESS_FILTERS.map((filter) => (
                    <button
                      key={filter.id}
                      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${processFilter === filter.id ? "border-accent bg-accent/15 text-white" : "border-surface-600 bg-surface-800 text-gray-300 hover:bg-surface-700"}`}
                      onClick={() => setProcessFilter(filter.id)}
                    >
                      {filter.label} <span className="text-gray-400">({processCounts[filter.id]})</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="rounded-lg border border-surface-600 bg-surface-800 px-3 py-2">
                  <div className="text-xs text-gray-400">Total</div>
                  <div className="text-lg font-semibold text-white">{processCounts.all}</div>
                </div>
                <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/25 px-3 py-2">
                  <div className="text-xs text-emerald-300">Active</div>
                  <div className="text-lg font-semibold text-emerald-200">{processCounts.active}</div>
                </div>
                <div className="rounded-lg border border-red-800/70 bg-red-950/25 px-3 py-2">
                  <div className="text-xs text-red-300">Issues</div>
                  <div className="text-lg font-semibold text-red-200">{processCounts.issues}</div>
                </div>
                <div className="rounded-lg border border-surface-600 bg-surface-800 px-3 py-2">
                  <div className="text-xs text-gray-400">Finished</div>
                  <div className="text-lg font-semibold text-gray-200">{processCounts.finished}</div>
                </div>
              </div>

              {stabilizeOverview.total > 0 && (
                <div className="rounded-lg border border-cyan-900/70 bg-cyan-950/20 px-3 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-xs uppercase tracking-wide text-cyan-300">Stabilize Snapshot</div>
                    <div className="text-[11px] text-cyan-200/90">
                      {stabilizeOverview.active} active • {stabilizeOverview.total} total
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="rounded border border-cyan-900/70 bg-cyan-950/25 px-2 py-2">
                      <div className="text-cyan-200/90 mb-1">Mode</div>
                      <div className="flex flex-wrap gap-1">
                        {stabilizeOverview.modes.map((entry) => (
                          <span key={`mode-${entry.label}`} className="inline-flex items-center rounded border border-cyan-800 bg-cyan-900/30 px-2 py-0.5 text-[11px] text-cyan-100">
                            {entry.label} ({entry.count})
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="rounded border border-teal-900/70 bg-teal-950/25 px-2 py-2">
                      <div className="text-teal-200/90 mb-1">Strength</div>
                      <div className="flex flex-wrap gap-1">
                        {stabilizeOverview.strengths.map((entry) => (
                          <span key={`strength-${entry.label}`} className="inline-flex items-center rounded border border-teal-800 bg-teal-900/30 px-2 py-0.5 text-[11px] text-teal-100">
                            {entry.label} ({entry.count})
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="rounded border border-sky-900/70 bg-sky-950/25 px-2 py-2">
                      <div className="text-sky-200/90 mb-1">Bitrate Policy</div>
                      <div className="flex flex-wrap gap-1">
                        {stabilizeOverview.bitratePolicies.map((entry) => (
                          <span key={`bitrate-${entry.label}`} className="inline-flex items-center rounded border border-sky-800 bg-sky-900/30 px-2 py-0.5 text-[11px] text-sky-100">
                            {entry.label} ({entry.count})
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="rounded border border-indigo-900/70 bg-indigo-950/25 px-2 py-2">
                      <div className="text-indigo-200/90 mb-1">Threading In Use</div>
                      <div className="flex flex-wrap gap-1">
                        {stabilizeOverview.threading.map((entry) => (
                          <span key={`threading-${entry.label}`} className="inline-flex items-center rounded border border-indigo-800 bg-indigo-900/30 px-2 py-0.5 text-[11px] text-indigo-100">
                            {entry.label} ({entry.count})
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {filteredProcessJobs.length === 0 && (
                <div className="card text-sm text-gray-400">No post-process jobs match the selected filter.</div>
              )}

              {filteredProcessJobs.map((job) => {
                const progress = pct(job.done, job.total);
                const doneLabel = job.total > 0 ? `${job.done}/${job.total}` : `${job.done}`;
                const logsExpanded = Boolean(expandedProcessLogs[job.id]);
                const hasLogs = job.logs.length > 0;
                const stabilizationModeLabel =
                  job.task === "stabilize" && job.stabilizationMode
                    ? STABILIZATION_MODE_LABELS[job.stabilizationMode]
                    : null;
                const stabilizationStrengthLabel =
                  job.task === "stabilize" && job.stabilizationStrength
                    ? STABILIZATION_STRENGTH_LABELS[job.stabilizationStrength]
                    : null;
                const bitratePolicyLabel =
                  job.task === "stabilize" && typeof job.preserveSourceBitrate === "boolean"
                    ? job.preserveSourceBitrate
                      ? "Preserve source bitrate"
                      : "Encoder quality mode"
                    : null;
                const threadingLabel =
                  job.task === "stabilize" &&
                  (typeof job.stabilizeMaxParallelJobsUsed === "number" ||
                    typeof job.stabilizeFfmpegThreadsPerJobUsed === "number")
                    ? `${job.stabilizeMaxParallelJobsUsed ?? "-"} parallel jobs • ${job.stabilizeFfmpegThreadsPerJobUsed ?? "-"} ffmpeg threads/job`
                    : null;

                return (
                  <div key={job.id} className={`card space-y-3 ${job.status === "running" ? "ring-1 ring-emerald-700/40" : ""}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm text-gray-100 font-medium">{PROCESS_TASK_LABELS[job.task] ?? job.task}</div>
                        {(stabilizationModeLabel || stabilizationStrengthLabel || bitratePolicyLabel) && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {stabilizationModeLabel && (
                              <span className="inline-flex items-center rounded border border-cyan-700 bg-cyan-900/30 px-2 py-0.5 text-[10px] font-medium text-cyan-200">
                                {stabilizationModeLabel}
                              </span>
                            )}
                            {stabilizationStrengthLabel && (
                              <span className="inline-flex items-center rounded border border-teal-700 bg-teal-900/30 px-2 py-0.5 text-[10px] font-medium text-teal-200">
                                {stabilizationStrengthLabel}
                              </span>
                            )}
                            {bitratePolicyLabel && (
                              <span className="inline-flex items-center rounded border border-sky-700 bg-sky-900/30 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                                {bitratePolicyLabel}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="text-xs text-gray-500 mt-1 break-all">Job ID: {job.id}</div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <div className={`text-xs px-2 py-1 rounded-full border capitalize ${PROCESS_STATUS_STYLES[job.status]}`}>{job.status}</div>
                        {(job.status === "running" || job.status === "queued") && (
                          <button className="btn-secondary" onClick={() => pauseProcessJob(job.id)}>
                            Pause
                          </button>
                        )}
                        {job.status === "paused" && (
                          <button className="btn-secondary" onClick={() => resumeProcessJob(job.id)}>
                            Resume
                          </button>
                        )}
                        {(job.status === "running" || job.status === "paused" || job.status === "queued") && (
                          <button className="btn-danger" onClick={() => abortProcessJob(job.id)}>
                            Abort
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-gray-400">
                      <div>Staging: <span className="text-gray-200 break-all">{job.stagingDir}</span></div>
                      <div>Scope mode: <span className="text-gray-200">{PROCESS_SCOPE_LABELS[job.scopeMode] ?? job.scopeMode}</span></div>
                      <div>Progress: <span className="text-gray-200">{doneLabel} ({progress.toFixed(0)}%)</span></div>
                      <div>Processed: <span className="text-gray-200">{job.processed}</span></div>
                      <div>Out of focus flagged: <span className="text-gray-200">{job.outOfFocus}</span></div>
                      {bitratePolicyLabel && <div>Bitrate policy: <span className="text-gray-200">{bitratePolicyLabel}</span></div>}
                      {threadingLabel && (
                        <div className="md:col-span-2">Threading in use: <span className="text-gray-200">{threadingLabel}</span></div>
                      )}
                      <div className="md:col-span-2">Scope: <span className="text-gray-200 break-all">{job.scopeDir}</span></div>
                    </div>

                    <div>
                      <ProgressBar
                        total={job.total || 1}
                        done={Math.min(job.done, job.total || 1)}
                        label={job.currentFile || ""}
                        extra={`${doneLabel} • processed ${job.processed} • out_of_focus ${job.outOfFocus} • ${progress.toFixed(0)}%`}
                      />
                      {job.currentFile && (
                        <div className="mt-1 text-xs text-gray-500 truncate">Current: {job.currentFile}</div>
                      )}
                    </div>

                    {job.errors.length > 0 && (
                      <div className="text-xs text-red-300 bg-red-900/20 border border-red-700 rounded p-2 max-h-24 overflow-auto">
                        <div className="font-medium mb-1">Errors ({job.errors.length})</div>
                        {job.errors.map((line, idx) => (
                          <div key={idx}>{line}</div>
                        ))}
                      </div>
                    )}

                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor={`process-job-console-${job.id}`} className="text-xs text-gray-400">Job Console</label>
                        <button
                          className="btn-secondary px-3 py-1 text-xs"
                          onClick={() => toggleProcessLogs(job.id)}
                          disabled={!hasLogs}
                        >
                          {!hasLogs ? "No Logs Yet" : logsExpanded ? "Hide Logs" : `Show Logs (${job.logs.length})`}
                        </button>
                      </div>
                      {logsExpanded && (
                        <textarea
                          id={`process-job-console-${job.id}`}
                          readOnly
                          value={job.logs.join("\n")}
                          className="w-full h-32 resize-y overflow-auto bg-surface-900 border border-surface-600 rounded-lg p-2 text-xs text-green-300 font-mono"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
