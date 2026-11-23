import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessJob } from "../types";
import { processJobProgress } from "../utils/jobProgress";
import JobProgressCard from "./JobProgressCard";

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
  const upgraded = detail.mode === "upgrade";

  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await work(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <div className="space-y-3">
    <JobProgressCard display={processJobProgress(job)} />
    <div className="space-y-3">
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
        <p className="text-sm text-emerald-200">{upgraded ? "The existing archive was verified and upgraded in place." : verifying ? "The saved archive matches its checksum file." : "The card archive is verified. You can now reformat the card manually."}</p>
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
      {job.status === "completed" && detail.mode === "remove" && <p className="text-sm text-emerald-200">The old archive was removed after the replacement was verified.</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </div>
  </div>;
}
