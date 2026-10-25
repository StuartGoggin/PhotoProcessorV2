import { useRef, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob } from "../types";
import type { StudioJob } from "../types/videoStudio";
import { liveStudioScheduler, sortStudioJobs } from "../types/videoStudio";
import { countJobs, isActiveJob, readPanelSize, type JobsView } from "../utils/jobsView";
import JobTile from "./JobTile";
import JobConsole from "./JobConsole";
import StudioJobTile from "./StudioJobTile";
import ImportSchedulingStatus from "./ImportSchedulingStatus";
import GooglePhotoJobCard from "./GooglePhotoJobCard";
import type { GooglePhotosJob, GooglePhotosStatus } from "../types/googlePhotos";

interface JobsPanelProps {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  studioJobs?: StudioJob[];
  googlePhotosJobs?: GooglePhotosJob[];
  googlePhotosAccount?: GooglePhotosStatus["account"];
  googlePhotosError?: string | null;
  refreshGooglePhotos?: () => Promise<void>;
  loading?: boolean;
  error?: string | null;
  onOpenJobs?: (view: JobsView) => void;
  preferCollapsed?: boolean;
}

export default function JobsPanel({ importJobs, processJobs, studioJobs = [], googlePhotosJobs = [], googlePhotosAccount = null, googlePhotosError, refreshGooglePhotos, loading = false, error, onOpenJobs, preferCollapsed = false }: JobsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const googleActionPending = useRef(false);
  const [googleActionError, setGoogleActionError] = useState("");
  async function googleRun(_name: string, action: () => Promise<unknown>) {
    if (googleActionPending.current) return;
    googleActionPending.current = true; setGoogleBusy(true); setGoogleActionError("");
    try { await action(); await refreshGooglePhotos?.(); }
    catch (error) { setGoogleActionError(String(error)); }
    finally { googleActionPending.current = false; setGoogleBusy(false); }
  }
  async function googleControl(job: GooglePhotosJob, action: "pause" | "resume" | "retry") {
    if (action !== "pause" && googlePhotosAccount?.id !== job.accountId) { setGoogleActionError("Reconnect the original Google account and OAuth client before continuing this job."); return; }
    await googleRun(`${action}-${job.id}`, () => invoke("google_photos_control", { jobId: job.id, action }));
  }
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
  const counts = countJobs([...importJobs, ...processJobs, ...studioJobs, ...googlePhotosJobs]);
  const activeGoogle = googlePhotosJobs.filter(isActiveJob);
  const expanded = counts.active > 0 && !collapsed;
  const isMemoryWait = (value: unknown): value is string => typeof value === "string" && /^Waiting for (?:available )?(?:RAM|memory)\b/i.test(value);
  const memoryWaiting = activeStudio.filter((job) => job.status === "running" && !job.paused && isMemoryWait(job.phase));
  const schedulerReason = liveStudioScheduler(activeStudio.filter((job) => !job.paused))?.reason;
  const memorySummary = memoryWaiting.length ? `${memoryWaiting.length} Studio job${memoryWaiting.length === 1 ? "" : "s"} waiting for RAM · ${memoryWaiting[0].phase}`
    : isMemoryWait(schedulerReason) ? `Shared render capacity · ${schedulerReason}` : "";
  const selectedJob = jobs.find(({ key }) => key === selectedJobKey)?.job;
  const selectedGoogle = activeGoogle.find(job => `google-${job.id}` === selectedJobKey);

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
      {(googlePhotosError || googleActionError) && <p role="alert" className="jobs-panel-warning">{googlePhotosError || googleActionError}</p>}
      {!expanded && memorySummary && <p role="status" aria-label="Memory wait" title={memorySummary} className="px-3 pb-2 text-xs text-amber-200 truncate">{memorySummary}</p>}
      {loading && counts.active === 0 && <p role="status" className="px-3 pb-2 text-xs text-gray-400">Checking jobs…</p>}
      <div id="active-jobs-content" hidden={!expanded} className="jobs-panel-content">
        <div className="jobs-panel-scroll" tabIndex={0} role="region" aria-label="Active jobs list">
          <ImportSchedulingStatus jobs={importJobs} compact />
          <div className="jobs-panel-grid">
            {activeStudio.map((job) => <StudioJobTile key={`studio-${job.id}`} job={job} />)}
            {activeGoogle.map(job => <button key={`google-${job.id}`} type="button" className="job-tile text-left rounded border border-sky-800 bg-sky-950/30 p-3" aria-label={`Select Google Photos job ${job.id}`} aria-pressed={selectedJobKey === `google-${job.id}`} onClick={() => setSelectedJobKey(selectedJobKey === `google-${job.id}` ? null : `google-${job.id}`)}><strong className="text-sm text-sky-200">Google Photos</strong><span className="block text-xs text-gray-300 truncate">{job.albums.map(album => album.title).join(" · ") || job.id}</span><span className="block text-xs text-gray-400">{job.status.replace(/_/g, " ")} · {job.done}/{job.total}</span><progress className="w-full" aria-label={`Google Photos progress ${job.id}`} value={job.done} max={Math.max(1, job.total)} /></button>)}
            {jobs.map(({ job, key }) => <JobTile key={key} job={job} isSelected={selectedJobKey === key} onClick={() => setSelectedJobKey(selectedJobKey === key ? null : key)} />)}
          </div>
        </div>
        {selectedJob && <div className="jobs-panel-console"><JobConsole job={selectedJob} onClose={() => setSelectedJobKey(null)} /></div>}
        {selectedGoogle && <div className="jobs-panel-console"><button className="jobs-header-button" onClick={() => setSelectedJobKey(null)}>Close Google Photos job</button><GooglePhotoJobCard job={selectedGoogle} account={googlePhotosAccount} busy={googleBusy} run={googleRun} control={googleControl} /></div>}
      </div>
    </section>
  );
}
