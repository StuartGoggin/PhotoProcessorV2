import type { StudioJob } from "../types/videoStudio";
import { formatStudioMetric, liveStudioScheduler } from "../types/videoStudio";

export default function StudioSchedulerStatus({ jobs }: { jobs: StudioJob[] }) {
  if (!jobs.some((job) => job.status === "running")) return null;
  const scheduler = liveStudioScheduler(jobs);
  return (
    <section className="rounded border border-surface-600 bg-surface-900 p-3 space-y-2 text-xs" aria-label="Shared processing capacity">
      <h3 className="text-sm font-semibold">Shared processing capacity</h3>
      {scheduler ? <>
        <p>{scheduler.adaptive ? "Adaptive scheduling" : "Fixed scheduling"} · {scheduler.activeWorkers} active task(s) · target {scheduler.targetWorkers} · {scheduler.reservedThreads} CPU thread(s) allocated</p>
        <dl className="flex flex-wrap gap-x-5 gap-y-2">
          {[
            ["CPU", formatStudioMetric(scheduler.cpuPercent, "percent")],
            ["Available RAM", formatStudioMetric(scheduler.availableMemoryBytes, "memory")],
            ["NVIDIA encoder", formatStudioMetric(scheduler.gpuEncoderPercent, "percent")],
            ["NVIDIA decoder", formatStudioMetric(scheduler.gpuDecoderPercent, "percent")],
            ["NVIDIA compute", formatStudioMetric(scheduler.gpuComputePercent, "percent")],
            ["Free GPU memory", formatStudioMetric(scheduler.gpuMemoryFreeBytes, "memory")],
            ["Aggregate active rendering", formatStudioMetric(scheduler.throughputFps, "fps")],
          ].map(([label, value]) => <div key={label}><dt className="text-gray-400">{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <p className="text-cyan-200 break-words">{typeof scheduler.reason === "string" && scheduler.reason ? scheduler.reason : "Waiting for a scheduler decision."}</p>
        <p className="text-gray-400">Shared across active Video Studio work, not a per-job allocation or queue ETA. N/A means that measurement is unavailable. Different processing phases use different hardware.</p>
      </> : <p className="text-gray-400">Live scheduler monitoring is unavailable. Check each job’s processing log for its configured limits and hardware fallback.</p>}
    </section>
  );
}
