import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessJob } from "../types";
import "./SdCardArchiveProgress.css";

export function archiveSize(bytes: number) {
  const magnitude = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  const value = bytes / 1024 ** magnitude;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: magnitude ? 1 : 0 })} ${["B", "KiB", "MiB", "GiB"][magnitude]}`;
}

export default function SdCardArchiveProgress({ job, onChanged, onVerification }: {
  job: ProcessJob;
  onChanged: () => void | Promise<void>;
  onVerification?: (job: ProcessJob) => void;
}) {
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const detail = job.sdCardArchive;
  if (!detail) return null;
  const completed = job.status === "completed" && !!detail.archiveFolder;
  const verifying = detail.mode === "verify";
  const phase = job.currentPhase || detail.phase;
  const active = job.status === "running" && ["Copying", "Verifying"].includes(phase);
  const max = Math.max(detail.totalBytes, 1);
  const value = (bytes: number) => Math.min(max, completed && !detail.totalBytes ? 1 : bytes);
  const rate = (number?: number | null) => number == null ? "—" : `${number.toFixed(1)} MiB/s`;

  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await work(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="sd-archive-progress" data-verified={completed} aria-label="SD Card Archive progress">
    <div className="sd-archive-graphic" data-active={active} aria-hidden="true">
      <div className="sd-archive-device"><div className="sd-archive-card"><i /><i /><i /><i /><i /><b>SD</b></div><span>{verifying ? "Saved archive" : "SD card"}</span></div>
      <div className="sd-archive-stream"><span /><span /><span /><span /><span /></div>
      <div className="sd-archive-device"><div className="sd-archive-repository"><i /><i /><i /></div><span>{completed ? "Verified" : "Repository"}</span></div>
    </div>
    <div className="sd-archive-metrics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-white">{detail.label}</h3>
        <span className={completed ? "text-emerald-300 font-semibold" : "text-sky-200"} role="status">{phase}</span>
      </div>
      {!verifying && <label className="sd-archive-meter">Copied <span>{archiveSize(detail.copiedBytes)} / {archiveSize(detail.totalBytes)} · {detail.filesCopied.toLocaleString()} files</span>
        <progress aria-label="Copied bytes" max={max} value={value(detail.copiedBytes)} /></label>}
      <label className="sd-archive-meter">Verified <span>{archiveSize(detail.verifiedBytes)} / {archiveSize(detail.totalBytes)} · {detail.filesVerified.toLocaleString()} files</span>
        <progress aria-label="Verified bytes" max={max} value={value(detail.verifiedBytes)} /></label>
      {!verifying && <dl className="sd-archive-rates">
        <div><dt>Card read</dt><dd>{rate(detail.sourceMbps)}</dd></div><div><dt>Sustained</dt><dd>{rate(detail.sustainedMbps)}</dd></div>
        {detail.etaSeconds != null && detail.etaSeconds > 1 && <div><dt>Copy remaining</dt><dd>{Math.ceil(detail.etaSeconds)} s</dd></div>}
      </dl>}
      {detail.bottleneck && <p className="text-xs text-sky-200">{detail.bottleneck}</p>}
      {detail.date && <p className="text-xs text-gray-400" title={detail.date.file ?? undefined}>{detail.date.date} · {detail.date.basis}{detail.date.file ? ` · ${detail.date.file}` : ""}</p>}
      {detail.timestampWarnings > 0 && <p className="text-xs text-amber-200">The repository could not preserve {detail.timestampWarnings} timestamps.</p>}
      {detail.needsDate && <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault();
        if (date) void action(async () => {
          await invoke("set_sd_card_archive_date", { jobId: job.id, date });
          await invoke("retry_process_job", { jobId: job.id });
          await onChanged();
        });
      }}>
        <label className="text-sm">Archive date<input required type="date" value={date} onChange={event => setDate(event.target.value)} className="input-field block" /></label>
        <button className="btn-secondary" disabled={busy || !date}>Save date and retry</button>
      </form>}
      {completed && <div className="space-y-2">
        <p className="text-sm text-emerald-200">{verifying ? "The saved archive matches its checksum file." : "The card archive is verified. You can now reformat the card manually."}</p>
        <p className="text-xs text-gray-400 break-all">{detail.archiveFolder}</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={busy} onClick={() => void action(() => invoke("open_in_default_app", { path: detail.archiveFolder }))}>Open archive folder</button>
          <button className="btn-secondary" disabled={busy || !detail.checksumFile} onClick={() => void action(() => invoke("open_in_default_app", { path: detail.checksumFile }))}>View checksums</button>
          <button className="btn-secondary" disabled={busy} onClick={() => void action(async () => {
            const verification = await invoke<ProcessJob>("verify_sd_card_archive", { archiveJobId: job.id });
            onVerification?.(verification);
            await onChanged();
          })}>Verify archive again</button>
        </div>
      </div>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </div>
  </section>;
}
