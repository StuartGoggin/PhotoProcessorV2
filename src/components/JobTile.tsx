import type { ImportJob, ProcessJob } from "../types";
import { importJobProgress, processJobProgress } from "../utils/jobProgress";
import JobProgressCard from "./JobProgressCard";

interface JobTileProps {
  job: ImportJob | ProcessJob;
  isSelected?: boolean;
  onClick?: () => void;
}

export default function JobTile({ job, isSelected = false, onClick }: JobTileProps) {
  const imported = "task" in job ? null : job;
  const display = "task" in job ? processJobProgress(job) : importJobProgress(job);
  const discarded = imported?.discardedSkipped ?? 0;
  const errors = job.errors.length;
  const consoleButton = onClick && <button type="button" className="btn-secondary job-flow-console"
    aria-label={display.title + ": " + job.status + ". " + (isSelected ? "Hide" : "Show") + " console"}
    aria-pressed={isSelected} onClick={event => { event.stopPropagation(); onClick(); }}>{isSelected ? "Hide console" : "Console"}</button>;
  return <article className={"job-tile min-w-0 space-y-1" + (onClick ? " cursor-pointer" : "") + (isSelected ? " ring-2 ring-sky-500 rounded-lg" : "")} onClick={onClick}>
    <JobProgressCard display={display} compact actions={consoleButton} />
    {(discarded > 0 || errors > 0) && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs">
      {discarded > 0 && <span className="text-amber-200" title="Already included in the skipped total">Previously discarded: {discarded.toLocaleString()}</span>}
      {errors > 0 && <span className="text-red-300">{errors} {errors === 1 ? "error" : "errors"}</span>}
    </div>}
  </article>;
}
