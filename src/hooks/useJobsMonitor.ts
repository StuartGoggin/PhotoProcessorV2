import { useCallback, useEffect, useRef, useState } from "react";
import { STUDIO_CLEARED } from "../utils/studioWorkflow";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob, ProcessJobsSnapshot } from "../types";
import type { StudioJob } from "../types/videoStudio";
interface JobsSnapshot {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  studioJobs: StudioJob[];
  error: string | null;
}
export interface JobsMonitorResult extends JobsSnapshot {
  loading: boolean;
  refresh: () => Promise<void>;
  refreshArchives: () => Promise<void>;
  getSnapshot: () => JobsSnapshot;
}

/**
 * Hook that monitors jobs in real-time (every 500ms by default).
 * Automatically fetches and updates job lists.
 */
export function useJobsMonitor(enabled = true, interval = 500): JobsMonitorResult {
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [processJobs, setProcessJobs] = useState<ProcessJob[]>([]);
  const [studioJobs, setStudioJobs] = useState<StudioJob[]>([]);
  // Manual Refresh must consume the finished read, without depending on when
  // React commits the corresponding render (including while Tail is paused).
  const snapshotRef = useRef<JobsSnapshot>({ importJobs: [], processJobs: [], studioJobs: [], error: null });
  const getSnapshot = useCallback(() => snapshotRef.current, []);
  const generation = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const archiveRefreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshArchives = useCallback(() => archiveRefreshRef.current(), []);
  useEffect(() => {
    const clear = () => { generation.current++; snapshotRef.current = { ...snapshotRef.current, studioJobs: [] }; setStudioJobs([]); };
    window.addEventListener(STUDIO_CLEARED, clear);
    return () => window.removeEventListener(STUDIO_CLEARED, clear);
  }, []);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    let pending: Promise<void> | null = null;
    let archivePending: Promise<void> | null = null;
    let generalWarnings: string[] = [];
    let archiveWarnings: string[] = [];
    // Only the initial fetch needs a loading indicator. Background polling must
    // retain the last display (including errors) until a new snapshot arrives.
    setLoading(true);

    function publish(next: JobsSnapshot) {
      const warnings = [...generalWarnings, ...archiveWarnings];
      next.error = warnings.length ? warnings.join(" ") : null;
      snapshotRef.current = next;
      setError(next.error);
    }

    function updateProcessJobs(next: JobsSnapshot, jobs: ProcessJob[], archive: boolean) {
      const belongs = (job: ProcessJob) => (job.task === "sdCardArchive") === archive;
      next.processJobs = [...next.processJobs.filter(job => !belongs(job)), ...jobs.filter(belongs)]
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id.localeCompare(a.id));
      setProcessJobs(next.processJobs);
    }

    function loadArchiveJobs(): Promise<void> {
      if (archivePending) return archivePending;
      archivePending = invoke<ProcessJobsSnapshot>("process_jobs_snapshot", { jobGroup: "sdCardArchive" })
        .then(data => {
          if (!alive) return;
          const next = { ...snapshotRef.current };
          updateProcessJobs(next, data.jobs, true);
          archiveWarnings = data.warnings;
          publish(next);
        }).catch(reason => {
          if (!alive) return;
          archiveWarnings = [`SD Card Archive updates unavailable. ${String(reason)}`];
          publish({ ...snapshotRef.current });
        }).finally(() => { archivePending = null; });
      return archivePending;
    }

    function loadJobs(): Promise<void> {
      if (pending) return pending;
      pending = performLoad();
      return pending;
    }
    async function performLoad() {
      const epoch = generation.current;
      try {
        const [importData, processData, studioData] = await Promise.allSettled([
          invoke<ImportJob[]>("list_import_jobs"),
          invoke<ProcessJobsSnapshot>("process_jobs_snapshot", { jobGroup: "other" }),
          invoke<StudioJob[]>("studio_list_jobs"),
        ]);
        if (!alive) return;
        const warnings: string[] = [];
        const next = { ...snapshotRef.current };
        if (importData.status === "fulfilled") { next.importJobs = importData.value; setImportJobs(importData.value); }
        else warnings.push(`Import job updates unavailable. ${String(importData.reason)}`);
        if (processData.status === "fulfilled") { updateProcessJobs(next, processData.value.jobs, false); warnings.push(...processData.value.warnings); }
        else warnings.push(`Process job updates unavailable. ${String(processData.reason)}`);
        if (studioData.status === "fulfilled") { if (epoch === generation.current) { next.studioJobs = studioData.value; setStudioJobs(studioData.value); } }
        else warnings.push(`Studio job updates unavailable. ${String(studioData.reason)}`);
        generalWarnings = warnings;
        publish(next);
      } catch (e) {
        if (alive) { snapshotRef.current = { ...snapshotRef.current, error: String(e) }; setError(String(e)); }
      } finally {
        pending = null;
        if (alive) setLoading(false);
      }
    }
    async function refreshJobs() {
      // A slow import, Studio, or cloud job listing must not stall archive progress.
      await Promise.all([loadJobs(), loadArchiveJobs()]);
    }
    refreshRef.current = refreshJobs;
    archiveRefreshRef.current = loadArchiveJobs;
    void refreshJobs();
    const timer = window.setInterval(() => { void refreshJobs(); }, interval);

    return () => {
      alive = false;
      refreshRef.current = async () => {};
      archiveRefreshRef.current = async () => {};
      window.clearInterval(timer);
    };
  }, [enabled, interval]);

  return { importJobs, processJobs, studioJobs, loading, error, refresh, refreshArchives, getSnapshot };
}
