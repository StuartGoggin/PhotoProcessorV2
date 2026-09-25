import { useRef, useEffect, useState } from "react";
import type { ImportJob, ProcessJob } from "../types";
import type { StudioJob } from "../types/videoStudio";
import { liveStudioScheduler, sortStudioJobs } from "../types/videoStudio";
import { countJobs, isActiveJob, readPanelSize, type JobsView } from "../utils/jobsView";
import JobTile from "./JobTile";
import JobConsole from "./JobConsole";
import StudioJobTile from "./StudioJobTile";
import ImportSchedulingStatus from "./ImportSchedulingStatus";

interface JobsPanelProps {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  studioJobs?: StudioJob[];
  loading?: boolean;
  error?: string | null;
  onOpenJobs?: (view: JobsView) => void;
  preferCollapsed?: boolean;
}

export default function JobsPanel({ importJobs, processJobs, studioJobs = [], loading = false, error, onOpenJobs, preferCollapsed = false }: JobsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(() => readPanelSize("jobsPanelHeight", 280, 180, 560));
  const [collapseChoice, setCollapseChoice] = useState<boolean | null>(() => {
    try { const saved = localStorage.getItem("jobsPanelCollapsed"); return saved === "true" ? true : saved === "false" ? false : null; } catch { return null; }
  });
  const collapsed = collapseChoice ?? preferCollapsed;
  function setCollapsed(value: boolean) {
    setCollapseChoice(value);
    try { localStorage.setItem("jobsPanelCollapsed", String(value)); } catch { /* Optional display preference. */ }
  }
  const [isResizing, setIsResizing] = useState(false);
  const jobs = [
    ...processJobs.map((job) => ({ job, key: `process-${job.id}` })),
    ...importJobs.map((job) => ({ job, key: `import-${job.id}` })),
  ].filter(({ job }) => isActiveJob(job)).sort((a, b) => {
    const priority = { running: 0, paused: 1, queued: 2 };
    return (priority[a.job.status as keyof typeof priority] ?? 9) - (priority[b.job.status as keyof typeof priority] ?? 9)
      || b.job.id.localeCompare(a.job.id);
  });
  const activeStudio = sortStudioJobs(studioJobs.filter(isActiveJob));
  const counts = countJobs([...importJobs, ...processJobs, ...studioJobs]);
  const expanded = counts.active > 0 && !collapsed;
  const isMemoryWait = (value: unknown): value is string => typeof value === "string" && /^Waiting for (?:available )?(?:RAM|memory)\b/i.test(value);
  const memoryWaiting = activeStudio.filter((job) => job.status === "running" && !job.paused && isMemoryWait(job.phase));
  const schedulerReason = liveStudioScheduler(activeStudio.filter((job) => !job.paused))?.reason;
  const memorySummary = memoryWaiting.length ? `${memoryWaiting.length} Studio job${memoryWaiting.length === 1 ? "" : "s"} waiting for RAM · ${memoryWaiting[0].phase}`
    : isMemoryWait(schedulerReason) ? `Shared render capacity · ${schedulerReason}` : "";
  const selectedJob = jobs.find(({ key }) => key === selectedJobKey)?.job;

  useEffect(() => {
    try { window.localStorage.setItem("jobsPanelHeight", String(panelHeight)); } catch { /* Optional preference. */ }
    panelRef.current?.style.setProperty("--jobs-panel-height", `${panelHeight}px`);
  }, [panelHeight]);
  useEffect(() => {
    if (!isResizing) return;
    const move = (event: PointerEvent) => setPanelHeight(Math.min(560, Math.max(180, window.innerHeight - event.clientY)));
    const stop = () => setIsResizing(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [isResizing]);

  return (
    <section ref={panelRef} aria-label="Background jobs" className={`jobs-panel border-t border-surface-600 bg-surface-900 ${expanded ? "jobs-panel-resizable" : "is-collapsed"}`}>
      {expanded && <div
        className="jobs-panel-resize-handle"
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setIsResizing(true); }}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          setPanelHeight((value) => event.key === "Home" ? 180 : event.key === "End" ? 560 : Math.min(560, Math.max(180, value + (event.key === "ArrowUp" ? 24 : -24))));
        }}
        role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="Resize jobs panel"
        aria-valuemin={180} aria-valuemax={560} aria-valuenow={panelHeight}
        title="Drag, or use arrow keys, to resize jobs panel"
      ><span className="jobs-panel-resize-grip" /></div>}
      <div className="jobs-panel-header">
        <button className="jobs-panel-toggle" onClick={() => setCollapsed(!collapsed)} disabled={!counts.active} aria-expanded={expanded} aria-controls="active-jobs-content">
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> Jobs <span className="text-emerald-300">{counts.active ? `${counts.active} active` : "No active jobs"}</span>
        </button>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {counts.attention > 0 && <button className="jobs-attention-button" onClick={() => onOpenJobs?.("attention")}>⚠ Needs attention ({counts.attention})</button>}
          <button className="jobs-header-button" onClick={() => onOpenJobs?.("history")}>History ({counts.history})</button>
          <button className="jobs-header-button" onClick={() => onOpenJobs?.("active")}>Manage jobs</button>
        </div>
      </div>
      {error && <p role="alert" className="jobs-panel-warning">Job updates unavailable; showing the last known state. {error}</p>}
      {!expanded && memorySummary && <p role="status" aria-label="Memory wait" title={memorySummary} className="px-3 pb-2 text-xs text-amber-200 truncate">{memorySummary}</p>}
      {loading && counts.active === 0 && <p role="status" className="px-3 pb-2 text-xs text-gray-400">Checking jobs…</p>}
      <div id="active-jobs-content" hidden={!expanded} className="jobs-panel-content">
        <div className="jobs-panel-scroll" tabIndex={0} role="region" aria-label="Active jobs list">
          <ImportSchedulingStatus jobs={importJobs} compact />
          <div className="jobs-panel-grid">
            {activeStudio.map((job) => <StudioJobTile key={`studio-${job.id}`} job={job} />)}
            {jobs.map(({ job, key }) => <JobTile key={key} job={job} isSelected={selectedJobKey === key} onClick={() => setSelectedJobKey(selectedJobKey === key ? null : key)} />)}
          </div>
        </div>
        {selectedJob && <div className="jobs-panel-console"><JobConsole job={selectedJob} onClose={() => setSelectedJobKey(null)} /></div>}
      </div>
    </section>
  );
}
