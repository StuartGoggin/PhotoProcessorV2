import { useRef, useEffect, useState } from "react";
import type { ImportJob, ProcessJob } from "../types";
import JobTile from "./JobTile";
import JobConsole from "./JobConsole";

type Job = (ImportJob & { jobType: "import" }) | (ProcessJob & { jobType: "process" });

interface JobsPanelProps {
  importJobs: ImportJob[];
  processJobs: ProcessJob[];
  loading?: boolean;
}

export default function JobsPanel({ importJobs, processJobs, loading = false }: JobsPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

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


  // Combine and sort jobs: active (running first, then queued) at left, completed at right
  const jobs: Job[] = [
    ...processJobs.map((j) => ({ ...j, jobType: "process" as const })),
    ...importJobs.map((j) => ({ ...j, jobType: "import" as const })),
  ].sort((a, b) => {
    const aStatus = a.status;
    const bStatus = b.status;

    // Active jobs first (running > paused > queued > aborted)
    const statusOrder = { running: 0, paused: 1, queued: 2, aborted: 3, completed: 4, failed: 5 };
    const aOrder = (statusOrder[aStatus as keyof typeof statusOrder] ?? 99) as number;
    const bOrder = (statusOrder[bStatus as keyof typeof statusOrder] ?? 99) as number;

    if (aOrder !== bOrder) return aOrder - bOrder;

    // Within same status, newer first (by ID string comparison - higher alphanumeric = newer)
    return b.id.localeCompare(a.id);
  });

  const hasJobs = jobs.length > 0;
  const activeCount = jobs.filter((j) => ["running", "paused", "queued"].includes(j.status)).length;
  const selectedJob = selectedJobId
    ? jobs.find((j) => j.id === selectedJobId)?.jobType === "import"
      ? importJobs.find((j) => j.id === selectedJobId)
      : processJobs.find((j) => j.id === selectedJobId)
    : null;

  return (
    <div className="jobs-panel-resizable border-t border-surface-700 bg-surface-900 flex flex-col">
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
              className="jobs-panel-scroll-strip w-full h-full overflow-x-auto overflow-y-hidden scroll-smooth px-6 py-4 space-x-4 flex items-start"
            >
              {jobs.map((job) => (
                <JobTile
                  key={`${job.jobType}-${job.id}`}
                  job={job as any}
                  isSelected={selectedJobId === job.id}
                  onClick={() => setSelectedJobId(job.id)}
                />
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
            <JobConsole job={selectedJob} onClose={() => setSelectedJobId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}
