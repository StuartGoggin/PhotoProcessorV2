import { useCallback, useEffect, useRef, useState } from "react";
import { STUDIO_CLEARED } from "../utils/studioWorkflow";
import { invoke } from "@tauri-apps/api/core";
import type { ImportJob, ProcessJob } from "../types";
import type { StudioJob } from "../types/videoStudio";
import type { GooglePhotosJob, GooglePhotosStatus } from "../types/googlePhotos";

export interface GooglePhotoJobsMonitorResult {
  googlePhotosJobs: GooglePhotosJob[];
  googlePhotosAccount: GooglePhotosStatus["account"];
  googlePhotosError: string | null;
  refreshGooglePhotos: () => Promise<void>;
}

/** Native-only account/job summaries have an independent slow poll. A failed
 * protected-store read must not stall or erase local import/processing jobs. */
export function useGooglePhotoJobs(enabled = true, interval = 2500): GooglePhotoJobsMonitorResult {
  const [googlePhotosJobs, setJobs] = useState<GooglePhotosJob[]>([]);
  const [googlePhotosAccount, setAccount] = useState<GooglePhotosStatus["account"]>(null);
  const [googlePhotosError, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshGooglePhotos = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!enabled) { refreshRef.current = async () => {}; return; }
    let alive = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const [jobs, status] = await Promise.allSettled([
          invoke<GooglePhotosJob[]>("google_photos_list_jobs"),
          invoke<GooglePhotosStatus>("google_photos_status"),
        ]);
        if (!alive) return;
        const errors: string[] = [];
        if (jobs.status === "fulfilled" && Array.isArray(jobs.value)) setJobs(jobs.value);
        else errors.push(`Google Photos jobs unavailable; showing the last known state. ${jobs.status === "rejected" ? String(jobs.reason) : "Invalid job summary response."}`);
        if (status.status === "fulfilled" && status.value && typeof status.value === "object") setAccount(status.value.account ?? null);
        else { setAccount(null); errors.push(`Google Photos account status unavailable; reconnect-sensitive actions are disabled. ${status.status === "rejected" ? String(status.reason) : "Invalid account status response."}`); }
        setError(errors.length ? errors.join(" ") : null);
      } finally { pending = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => void refresh(), Math.max(2500, interval));
    return () => { alive = false; refreshRef.current = async () => {}; window.clearInterval(timer); };
  }, [enabled, interval]);
  return { googlePhotosJobs, googlePhotosAccount, googlePhotosError, refreshGooglePhotos };
}

export interface JobsMonitorResult extends GooglePhotoJobsMonitorResult {
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
export function useJobsMonitor(enabled = true, interval = 500, includeGooglePhotos = false): JobsMonitorResult {
  const googlePhotos = useGooglePhotoJobs(enabled && includeGooglePhotos, 2500);
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

  return { importJobs, processJobs, studioJobs, loading, error, ...googlePhotos };
}
