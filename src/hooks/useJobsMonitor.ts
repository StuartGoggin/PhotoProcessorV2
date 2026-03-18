import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob } from "../types";

export interface JobsMonitorResult {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadJobs() {
    if (!enabled) return;
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

  useEffect(() => {
    // Load once on mount
    void loadJobs();

    // Set up polling
    const timer = window.setInterval(() => {
      void loadJobs();
    }, interval);

    return () => window.clearInterval(timer);
  }, [enabled, interval]);

  return { importJobs, processJobs, loading, error };
}
