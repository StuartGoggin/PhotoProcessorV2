import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STUDIO_CLEARED } from "../utils/studioWorkflow";
import type { ImportJob, ProcessJob, ProcessJobsSnapshot } from "../types";
import type { StudioJob } from "../types/videoStudio";

interface JobsSnapshot {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  studioJobs: StudioJob[];
  error: string | null;
}

export type JobsFeed = "imports" | "process" | "archives" | "studio";

export interface JobsMonitorResult extends JobsSnapshot {
  loading: boolean;
  refresh: () => Promise<void>;
  refreshArchives: () => Promise<void>;
  refreshFeed: (feed: JobsFeed) => Promise<void>;
  getSnapshot: () => JobsSnapshot;
}

const FEED_LABEL: Record<JobsFeed, string> = {
  imports: "Import job",
  process: "Process job",
  archives: "SD Card Archive",
  studio: "Studio job",
};
type Refreshers = Record<JobsFeed, () => Promise<void>>;

function mergeProcessJobs(previous: ProcessJob[], next: ProcessJob[], archives: boolean) {
  const isFeed = (job: ProcessJob) => (job.task === "sdCardArchive") === archives;
  return [...previous.filter(job => !isFeed(job)), ...next.filter(isFeed)].sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id.localeCompare(a.id),
  );
}

export function useJobsMonitor(enabled = true, interval = 500): JobsMonitorResult {
  const [snapshot, setSnapshot] = useState<JobsSnapshot>({ importJobs: [], processJobs: [], studioJobs: [], error: null });
  const [loading, setLoading] = useState(enabled);
  const current = useRef(snapshot);
  const feeds = useRef<Refreshers | null>(null);
  const studioGeneration = useRef(0);
  const getSnapshot = useCallback(() => current.current, []);
  const refreshFeed = useCallback(async (feed: JobsFeed) => { await feeds.current?.[feed](); }, []);
  const refreshArchives = useCallback(() => refreshFeed("archives"), [refreshFeed]);
  const refresh = useCallback(async () => {
    if (feeds.current) await Promise.all(Object.values(feeds.current).map(load => load()));
  }, []);

  const publish = useCallback((next: JobsSnapshot) => {
    current.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    const clear = () => {
      studioGeneration.current++;
      publish({ ...current.current, studioJobs: [] });
    };
    window.addEventListener(STUDIO_CLEARED, clear);
    return () => window.removeEventListener(STUDIO_CLEARED, clear);
  }, [publish]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let alive = true;
    setLoading(true);
    const pendingInitial = new Set<JobsFeed>(["imports", "process", "archives", "studio"]);
    const warnings = new Map<JobsFeed, string[]>();

    function update(change: Partial<JobsSnapshot> = {}) {
      const messages = Array.from(warnings.values()).flat();
      publish({ ...current.current, ...change, error: messages.length ? messages.join(" ") : null });
    }

    function singleFlight<T>(
      feed: JobsFeed,
      read: () => Promise<T>,
      apply: (data: T) => Partial<JobsSnapshot>,
      notices: (data: T) => string[] = () => [],
    ) {
      let pending: Promise<void> | null = null;
      return () => {
        if (pending) return pending;
        const generation = studioGeneration.current;
        const isCurrent = () => alive && (feed !== "studio" || generation === studioGeneration.current);
        pending = Promise.resolve().then(read).then(data => {
          if (!isCurrent()) return;
          const change = apply(data);
          warnings.set(feed, notices(data));
          update(change);
        }).catch(reason => {
          if (!isCurrent()) return;
          warnings.set(feed, [FEED_LABEL[feed] + " updates unavailable. " + String(reason)]);
          update();
        }).finally(() => {
          pending = null;
          if (alive && pendingInitial.delete(feed) && pendingInitial.size === 0) setLoading(false);
        });
        return pending;
      };
    }

    function processFeed(feed: "process" | "archives") {
      const archives = feed === "archives";
      return singleFlight(
        feed,
        () => invoke<ProcessJobsSnapshot>("process_jobs_snapshot", { jobGroup: archives ? "sdCardArchive" : "other" }),
        data => ({ processJobs: mergeProcessJobs(current.current.processJobs, data.jobs, archives) }),
        data => data.warnings,
      );
    }

    const activeFeeds: Refreshers = {
      imports: singleFlight("imports", () => invoke<ImportJob[]>("list_import_jobs"), importJobs => ({ importJobs })),
      process: processFeed("process"),
      archives: processFeed("archives"),
      studio: singleFlight("studio", () => invoke<StudioJob[]>("studio_list_jobs"), studioJobs => ({ studioJobs })),
    };
    feeds.current = activeFeeds;
    const poll = () => Object.values(activeFeeds).forEach(load => { void load(); });
    poll();
    const timer = window.setInterval(poll, interval);
    return () => {
      alive = false;
      feeds.current = null;
      window.clearInterval(timer);
    };
  }, [enabled, interval, publish]);

  return { ...snapshot, loading, refresh, refreshArchives, refreshFeed, getSnapshot };
}
