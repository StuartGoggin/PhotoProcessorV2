import { useEffect, useRef, useState } from "react";
import { STUDIO_CLEARED } from "../utils/studioWorkflow";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob } from "../types";
import type { StudioJob } from "../types/videoStudio";

export interface JobsMonitorResult {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  studioJobs: StudioJob[];
  loading: boolean;
  error: string | null;
}

/**
 * Hook that monitors jobs in real-time (every 500ms by default).
 * Automatically fetches and updates job lists.
 */
export function useJobsMonitor(enabled = true, interval = 500): JobsMonitorResult {
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [processJobs, setProcessJobs] = useState<ProcessJob[]>([]);
  const [studioJobs, setStudioJobs] = useState<StudioJob[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    const clear = () => { generation.current++; setStudioJobs([]); };
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
    let pending = false;
    // Only the initial fetch needs a loading indicator. Background polling must
    // retain the last display (including errors) until a new snapshot arrives.
    setLoading(true);

    async function loadJobs() {
      if (pending) return;
      pending = true;
      const epoch = generation.current;
      try {
        const [importData, processData, studioData] = await Promise.all([
          invoke<ImportJob[]>("list_import_jobs"),
          invoke<ProcessJob[]>("list_process_jobs"),
          invoke<StudioJob[]>("studio_list_jobs"),
        ]);
        if (!alive) return;
        setImportJobs(importData);
        setProcessJobs(processData);
        if (epoch === generation.current) setStudioJobs(studioData);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    }
    void loadJobs();
    const timer = window.setInterval(() => {
      void loadJobs();
    }, interval);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled, interval]);

  return { importJobs, processJobs, studioJobs, loading, error };
}
