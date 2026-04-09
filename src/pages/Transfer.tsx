import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessJob } from "../types";
import { useJobsMonitor, useSettings } from "../hooks";
import { ProgressBar } from "../components";
import { getProcessAttemptLabel, getProcessResultLabel } from "../utils";

const PHASE_LABELS: Record<string, string> = {
  transfer_copy: "Copying files to archive",
  transfer_md5: "Generating transfer checksum manifest",
  verify_checksums: "Verifying latest transfer manifest",
};

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

function getJobPhaseLabel(job: ProcessJob | null): string {
  if (!job) {
    return "Waiting for job.";
  }

  const lastLog = job.logs[job.logs.length - 1]?.toLowerCase() ?? "";
  if (job.task === "transfer") {
    if (lastLog.includes("checksum generation phase") || lastLog.includes("transfer manifest") || lastLog.includes("master manifest")) {
      return PHASE_LABELS.transfer_md5;
    }
    return PHASE_LABELS.transfer_copy;
  }

  if (job.task === "verify_checksums") {
    return PHASE_LABELS.verify_checksums;
  }

  return job.task;
}

export default function Transfer() {
  const { settings } = useSettings();
  const { processJobs } = useJobsMonitor(true, 1000);
  const [queueingTransfer, setQueueingTransfer] = useState(false);
  const [queueingVerify, setQueueingVerify] = useState(false);
  const [queuedTransferJobId, setQueuedTransferJobId] = useState<string | null>(null);
  const [queuedVerifyJobId, setQueuedVerifyJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transferJobs = useMemo(
    () => processJobs.filter((job) => job.task === "transfer").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [processJobs],
  );
  const verifyJobs = useMemo(
    () => processJobs.filter((job) => job.task === "verify_checksums").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [processJobs],
  );
  const latestTransferJob = transferJobs[0] ?? null;
  const latestVerifyJob = verifyJobs[0] ?? null;
  const activeTransferJob = queuedTransferJobId ? processJobs.find((job) => job.id === queuedTransferJobId) ?? null : latestTransferJob;
  const activeVerifyJob = queuedVerifyJobId ? processJobs.find((job) => job.id === queuedVerifyJobId) ?? null : latestVerifyJob;

  useEffect(() => {
    if (!queuedTransferJobId) {
      return;
    }

    const job = processJobs.find((item) => item.id === queuedTransferJobId);
    if (!job) {
      return;
    }

    if (job.status === "completed") {
      setQueuedTransferJobId(null);
      setMessage(`Transfer completed. Copied ${job.processed} files and checksummed ${job.resultCount}.`);
    } else if (job.status === "failed") {
      setQueuedTransferJobId(null);
      setError(job.errors[job.errors.length - 1] ?? "Transfer failed. Check Jobs for details.");
    } else if (job.status === "aborted") {
      setQueuedTransferJobId(null);
      setError("Transfer was aborted.");
    }
  }, [processJobs, queuedTransferJobId]);

  useEffect(() => {
    if (!queuedVerifyJobId) {
      return;
    }

    const job = processJobs.find((item) => item.id === queuedVerifyJobId);
    if (!job) {
      return;
    }

    if (job.status === "completed") {
      setQueuedVerifyJobId(null);
      setMessage(`Checksum verification completed. Verified ${job.resultCount} files.`);
    } else if (job.status === "failed") {
      setQueuedVerifyJobId(null);
      setError(job.errors[job.errors.length - 1] ?? "Checksum verification failed. Check Jobs for details.");
    } else if (job.status === "aborted") {
      setQueuedVerifyJobId(null);
      setError("Checksum verification was aborted.");
    }
  }, [processJobs, queuedVerifyJobId]);

  async function startTransfer() {
    if (!settings?.staging_dir || !settings?.archive_dir) {
      setError("Staging and Archive directories must be configured in Settings.");
      return;
    }

    setQueueingTransfer(true);
    setError(null);
    setMessage(null);

    try {
      const jobId = await invoke<string>("start_transfer", {
        stagingDir: settings.staging_dir,
        archiveDir: settings.archive_dir,
      });
      setQueuedTransferJobId(jobId);
      setMessage(`Queued transfer job ${jobId}. Progress will appear here and in Jobs.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingTransfer(false);
    }
  }

  async function verifyChecksums() {
    if (!settings?.archive_dir) {
      setError("Archive directory not configured.");
      return;
    }

    setQueueingVerify(true);
    setError(null);
    setMessage(null);

    try {
      const jobId = await invoke<string>("verify_checksums", {
        archiveDir: settings.archive_dir,
      });
      setQueuedVerifyJobId(jobId);
      setMessage(`Queued checksum verification job ${jobId}. Progress will appear here and in Jobs.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingVerify(false);
    }
  }

  async function pauseJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("pause_process_job", { jobId });
    } catch (e) {
      setError(String(e));
    }
  }

  async function resumeJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("resume_process_job", { jobId });
    } catch (e) {
      setError(String(e));
    }
  }

  async function abortJob(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("abort_process_job", { jobId });
    } catch (e) {
      setError(String(e));
    }
  }

  async function revealPath(path: string) {
    setError(null);
    try {
      await invoke("reveal_in_explorer", { path });
    } catch (e) {
      setError(String(e));
    }
  }

  function renderJobCard(job: ProcessJob | null, emptyLabel: string) {
    if (!job) {
      return (
        <div className="card text-sm text-gray-400">
          {emptyLabel}
        </div>
      );
    }

    const progress = pct(job.done, job.total);
    const isActive = job.status === "queued" || job.status === "running" || job.status === "paused";
  const conflictReportPath = job.task === "transfer" ? job.conflictReportPath : undefined;

    return (
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-white">{job.task === "transfer" ? "Transfer to Archive" : "Verify Checksums"}</h3>
            <p className="text-xs text-gray-500 mt-1 break-all">
              {job.archiveDir ?? job.scopeDir}
            </p>
          </div>
          <span className="rounded-full border border-surface-600 bg-surface-800 px-2 py-1 text-xs capitalize text-gray-200">
            {job.status}
          </span>
        </div>

        <ProgressBar
          total={Math.max(job.total, 1)}
          done={job.done}
          label={job.currentFile || "Waiting"}
          extra={
            job.speedMbps && job.speedMbps > 0
              ? `${progress.toFixed(0)}% • ${job.done}/${job.total} • ${job.speedMbps.toFixed(1)} MB/s`
              : `${progress.toFixed(0)}% • ${job.done}/${job.total}`
          }
        />

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded bg-surface-900 px-3 py-2">
            <div className="text-gray-500">{getProcessAttemptLabel(job.task)}</div>
            <div className="text-lg font-semibold text-white">{job.processed}</div>
          </div>
          <div className="rounded bg-surface-900 px-3 py-2">
            <div className="text-gray-500">{getProcessResultLabel(job.task)}</div>
            <div className="text-lg font-semibold text-cyan-300">{job.resultCount}</div>
          </div>
        </div>

        {job.logs.length > 0 && (
          <div className="rounded border border-surface-600 bg-gray-950 px-3 py-2 text-xs text-green-300 font-mono max-h-40 overflow-auto whitespace-pre-wrap">
            {job.logs.slice(-10).join("\n")}
          </div>
        )}

        {job.errors.length > 0 && (
          <div className="rounded border border-red-700 bg-red-950/30 px-3 py-2 text-xs text-red-200 space-y-1 max-h-32 overflow-auto">
            {job.errors.map((entry, index) => (
              <div key={`${job.id}-error-${index}`}>{entry}</div>
            ))}
          </div>
        )}

        {conflictReportPath && (
          <div className="rounded border border-amber-700/60 bg-amber-950/20 px-3 py-3 text-xs text-amber-100 space-y-2">
            <div className="font-semibold text-amber-200">Duplicate collision report</div>
            <div className="break-all font-mono text-[11px] text-amber-100/90">{conflictReportPath}</div>
            <button className="btn-secondary" onClick={() => revealPath(conflictReportPath)}>
              Reveal Conflict Report
            </button>
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => pauseJob(job.id)} disabled={!isActive || job.status === "paused"}>
            Pause
          </button>
          <button className="btn-secondary" onClick={() => resumeJob(job.id)} disabled={job.status !== "paused"}>
            Resume
          </button>
          <button className="btn-danger" onClick={() => abortJob(job.id)} disabled={!isActive}>
            Abort
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-white mb-2">Transfer to Archive</h2>
        <p className="text-gray-400 text-sm">
          Queue a transfer job to copy the staging directory to the NAS archive, write a checksum manifest for that transfer, and append new file hashes to the master server checksums file without rewriting its existing contents. Verification runs as a separate job against the latest transfer manifest, with fallback to the legacy root checksums file.
        </p>
      </div>

      {settings && (
        <div className="card space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-gray-400">Staging:</span>
            <span className="text-gray-200 truncate max-w-xl text-right">
              {settings.staging_dir || <span className="text-red-400">Not set</span>}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-400">Archive:</span>
            <span className="text-gray-200 truncate max-w-xl text-right">
              {settings.archive_dir || <span className="text-red-400">Not set</span>}
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {message && (
        <div className="bg-emerald-900/30 border border-emerald-700 rounded-lg px-4 py-3 text-emerald-200 text-sm">
          {message}
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        <button className="btn-primary" onClick={startTransfer} disabled={queueingTransfer || queueingVerify}>
          {queueingTransfer ? "Queueing Transfer..." : "Queue Transfer Job"}
        </button>
        <button className="btn-secondary" onClick={verifyChecksums} disabled={queueingTransfer || queueingVerify}>
          {queueingVerify ? "Queueing Verify..." : "Queue Verify Job"}
        </button>
      </div>

      <div className="space-y-6">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm uppercase tracking-wide text-gray-400">Latest Transfer Job</h3>
            <p className="text-xs text-gray-500 mt-1">{getJobPhaseLabel(activeTransferJob)}</p>
          </div>
          {renderJobCard(activeTransferJob, "No transfer job queued yet.")}
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm uppercase tracking-wide text-gray-400">Latest Verification Job</h3>
            <p className="text-xs text-gray-500 mt-1">Verify the latest transfer manifest as a separate process job.</p>
          </div>
          {renderJobCard(activeVerifyJob, "No checksum verification job queued yet.")}
        </section>

      </div>
    </div>
  );
}
