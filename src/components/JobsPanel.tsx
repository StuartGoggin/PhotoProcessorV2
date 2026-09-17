import { useRef, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob } from "../types";
import type { StudioJob } from "../types/videoStudio";
import { isPendingStudioJob } from "../types/videoStudio";
import JobTile from "./JobTile";
import JobConsole from "./JobConsole";

type Job = (ImportJob & { jobType: "import" }) | (ProcessJob & { jobType: "process" });
type QueueItem =
  | { key: string; kind: "standard"; status: string; id: string; job: Job }
  | { key: string; kind: "studio"; status: string; id: string; job: StudioJob };

interface JobsPanelProps {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  studioJobs: StudioJob[];
  loading?: boolean;
}

function studioStatus(job: StudioJob): "queued" | "running" | "paused" | "interrupted" | "retried" | "aborted" | "completed" | "failed" {
  if (job.cancelled || job.status === "cancelled") return "aborted";
  if (job.status === "interrupted") return job.recoverable ? "interrupted" : "retried";
  if (job.paused || job.status === "paused") return "paused";
  if (job.status === "queued" || job.status === "running" || job.status === "completed" || job.status === "failed") {
    return job.status;
  }
  return "failed";
}

function StudioQueueTile({ job, isSelected, onClick }: { job: StudioJob; isSelected: boolean; onClick: () => void }) {
  const status = studioStatus(job);
  const statusColor = {
    queued: "text-blue-200", running: "text-emerald-200", paused: "text-amber-200", interrupted: "text-amber-200",
    aborted: "text-red-200", completed: "text-emerald-300", failed: "text-red-300", retried: "text-gray-300",
  }[status];
  return (
    <div onClick={onClick} className={`flex-shrink-0 w-72 rounded-lg border border-violet-700 bg-violet-950/30 cursor-pointer p-4 space-y-3 transition-all ${status === "running" ? "ring-2 ring-violet-500" : ""} ${isSelected ? "ring-2 ring-blue-500" : "hover:shadow-md"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="text-sm font-semibold text-white truncate">Video Studio render</div><div className="text-xs text-gray-400 truncate">{job.name}</div></div>
        <span className={`text-xs px-2 py-1 rounded-full capitalize font-medium ${statusColor}`}>{status === "completed" ? "Done" : status}</span>
      </div>
      <div className="text-xs text-violet-200 truncate">{job.phase || "Queued"}</div>
      <div className="space-y-1"><progress className="progress-native progress-emerald" max="100" value={Math.max(0, Math.min(100, job.progress))} aria-label={`${job.name} render progress`} /><div className="flex justify-between px-1 text-xs text-gray-400"><span>{Math.round(job.progress)}%</span><span>Video render</span></div></div>
      {job.error && <div className="text-xs text-red-300 truncate">⚠ {job.error}</div>}
      {job.output && <div className="text-xs text-emerald-300">Verified output ready</div>}
    </div>
  );
}

type StudioControl = "pause" | "resume" | "cancel" | "retry" | "retryCpu";

function StudioQueueConsole({ job, onClose, onControl }: { job: StudioJob; onClose: () => void; onControl: (id: string, action: StudioControl) => Promise<void> }) {
  const [controlError, setControlError] = useState("");
  const [pending, setPending] = useState(false);
  const active = isPendingStudioJob(job) && !job.cancelled;
  const resumable = job.paused || job.status === "paused" || job.status === "interrupted";
  async function control(action: StudioControl) {
    setControlError("");
    setPending(true);
    try { await onControl(job.id, action); }
    catch (e) { setControlError(String(e)); }
    finally { setPending(false); }
  }
  useEffect(() => { setControlError(""); }, [job.id]);
  return (
    <div className="h-full flex flex-col p-4 gap-3">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="font-semibold text-white">Video Studio render</h3><p className="text-xs text-gray-400 break-all">{job.name} · {job.phase || "Queued"}</p></div>
        <button className="btn-secondary px-3 py-1 text-xs" onClick={onClose}>Close</button>
      </div>
      <div className="flex flex-wrap gap-2">
        {active && <>
          {(job.status !== "interrupted" || job.recoverable) && <button className="btn-secondary" disabled={pending} onClick={() => void control(resumable ? "resume" : "pause")}>{resumable ? "Resume" : "Pause"}</button>}
          <button className="btn-danger" disabled={pending} onClick={() => void control("cancel")}>Cancel</button>
        </>}
        {job.recoverable && ["failed", "cancelled"].includes(job.status) && <>
          <button className="btn-secondary" disabled={pending} onClick={() => void control("retry")}>Retry</button>
          <button className="btn-secondary" disabled={pending} onClick={() => void control("retryCpu")}>Retry using CPU</button>
        </>}
        {job.output && <button className="btn-secondary" onClick={() => void invoke("reveal_in_explorer", { path: job.output }).catch((e) => setControlError(String(e)))}>Show file</button>}
      </div>
      {job.status === "interrupted" && job.recoverable && <p className="text-xs text-amber-200">Processing stopped when the app closed. Resume to reuse completed work.</p>}
      {controlError && <p role="alert" className="text-sm text-red-300 break-all">{controlError}</p>}
      {job.error && <p className="text-sm text-red-300 break-all">{job.error}</p>}
      <label className="text-xs text-gray-400">Render console</label>
      <pre className="flex-1 min-h-0 overflow-auto bg-surface-950 border border-surface-600 rounded-lg p-3 text-xs text-green-300 font-mono whitespace-pre-wrap">{job.logs.join("\n") || "Waiting for the render worker to write diagnostics…"}</pre>
    </div>
  );
}

export default function JobsPanel({ importJobs, processJobs, studioJobs, loading = false }: JobsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    const raw = window.localStorage.getItem("jobsPanelHeight");
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(parsed, 180), 560);
    }
    return 300;
  });
  const [isResizing, setIsResizing] = useState(false);

  // Handle mouse wheel for horizontal scrolling
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Only intercept if scrolling would happen horizontally
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        return; // Let native horizontal scroll happen
      }
      
      // Convert vertical scroll to horizontal
      if (container.scrollWidth > container.clientWidth) {
        e.preventDefault();
        container.scrollLeft += e.deltaY > 0 ? 50 : -50;
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("jobsPanelHeight", String(panelHeight));
    panelRef.current?.style.setProperty("--jobs-panel-height", `${panelHeight}px`);
  }, [panelHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const onMouseMove = (event: MouseEvent) => {
      const desired = window.innerHeight - event.clientY;
      const clamped = Math.min(Math.max(desired, 180), 560);
      setPanelHeight(clamped);
    };

    const onMouseUp = () => setIsResizing(false);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizing]);


  // Combine and sort jobs: active (running first, then queued) at left, completed at right
  const jobs: QueueItem[] = [
    ...processJobs.map((j) => ({ key: `process:${j.id}`, kind: "standard" as const, status: j.status, id: j.id, job: { ...j, jobType: "process" as const } })),
    ...importJobs.map((j) => ({ key: `import:${j.id}`, kind: "standard" as const, status: j.status, id: j.id, job: { ...j, jobType: "import" as const } })),
    ...studioJobs.map((j) => ({ key: `studio:${j.id}`, kind: "studio" as const, status: studioStatus(j), id: j.id, job: j })),
  ].sort((a, b) => {
    const aStatus = a.status;
    const bStatus = b.status;

    // Active jobs first (running > paused > queued > aborted)
    const statusOrder = { running: 0, paused: 1, interrupted: 1, queued: 2, aborted: 3, completed: 4, retried: 4, failed: 5 };
    const aOrder = (statusOrder[aStatus as keyof typeof statusOrder] ?? 99) as number;
    const bOrder = (statusOrder[bStatus as keyof typeof statusOrder] ?? 99) as number;

    if (aOrder !== bOrder) return aOrder - bOrder;

    // Within same status, newer first (by ID string comparison - higher alphanumeric = newer)
    return b.id.localeCompare(a.id);
  });

  const hasJobs = jobs.length > 0;
  const activeCount = jobs.filter((j) => ["running", "paused", "interrupted", "queued"].includes(j.status)).length;
  const selectedJob = selectedJobKey ? jobs.find((j) => j.key === selectedJobKey) ?? null : null;

  async function controlStudioJob(id: string, action: StudioControl) {
    await invoke("studio_control_job", { id, action });
  }

  return (
    <div ref={panelRef} className="jobs-panel-resizable border-t border-surface-700 bg-surface-900 flex flex-col">
      <div
        className="jobs-panel-resize-handle"
        onMouseDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
        title="Drag to resize jobs panel"
      >
        <div className="jobs-panel-resize-grip" />
      </div>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-surface-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white">
            Jobs {activeCount > 0 && <span className="text-emerald-400 ml-2">({activeCount} active)</span>}
          </h2>
          {loading && <div className="text-xs text-gray-500 animate-pulse">Syncing...</div>}
        </div>
        <div className="text-xs text-gray-400">
          Total: {jobs.length} {hasJobs && `• Scroll right to see ${jobs.filter((j) => j.status === "completed").length} completed`}
        </div>
      </div>

      {/* Main content area with scroll tiles and console */}
      <div className="flex-1 flex overflow-hidden">
        {/* Scroll container for tiles */}
        <div className={`flex-1 min-w-0 ${selectedJob ? "w-1/2" : "w-full"} transition-all duration-300 overflow-hidden`}>
          {hasJobs ? (
            <div
              ref={scrollRef}
              className="jobs-panel-scroll-strip w-full h-full overflow-x-scroll overflow-y-hidden scroll-smooth px-6 py-4 space-x-4 flex items-start"
            >
              {jobs.map((item) => item.kind === "studio" ? (
                <StudioQueueTile key={item.key} job={item.job} isSelected={selectedJobKey === item.key} onClick={() => setSelectedJobKey(item.key)} />
              ) : (
                <JobTile key={item.key} job={item.job} isSelected={selectedJobKey === item.key} onClick={() => setSelectedJobKey(item.key)} />
              ))}
              {/* Spacer on right for comfortable scrolling */}
              <div className="flex-shrink-0 w-4" />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full w-full">
              <p className="text-gray-400 text-sm">No jobs yet. Start processing to see them here.</p>
            </div>
          )}
        </div>

        {/* Console area */}
        {selectedJob && (
          <div className="w-1/2 border-l border-surface-700 transition-all duration-300 flex flex-col">
            {selectedJob.kind === "studio" ? (
              <StudioQueueConsole job={selectedJob.job} onClose={() => setSelectedJobKey(null)} onControl={controlStudioJob} />
            ) : (
              <JobConsole job={selectedJob.job} onClose={() => setSelectedJobKey(null)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
