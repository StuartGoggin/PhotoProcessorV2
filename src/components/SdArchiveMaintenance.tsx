import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProcessJob } from "../types";
import type { ArchiveDate, SdCardInspection } from "../types/sdCardArchive";

interface UpgradeReview {
  token: string;
  targetName: string;
  date: ArchiveDate;
  fileTimes: number;
  fileCount: number;
  folderTimes: number;
  directoryCount: number;
  rootTime: boolean;
  serialKnown: boolean;
}

interface Props {
  jobs: ProcessJob[];
  repository: string | null;
  inspection: SdCardInspection | null;
  canRecreate: boolean;
  disabled: boolean;
  onRecreate: (folder: string) => Promise<ProcessJob>;
  onJob: (job: ProcessJob) => void;
}

const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

export default function SdArchiveMaintenance({ jobs, repository, inspection, canRecreate, disabled, onRecreate, onJob }: Props) {
  const [folder, setFolder] = useState("");
  const [review, setReview] = useState<UpgradeReview | null>(null);
  const [withCard, setWithCard] = useState(false);
  const [replacementId, setReplacementId] = useState("");
  const [chosenReplacement, setChosenReplacement] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const replacementJob = jobs.find(job => job.id === replacementId);
  const replacement = chosenReplacement || (replacementJob?.status === "completed" ? replacementJob.sdCardArchive?.archiveFolder ?? "" : "");
  const locked = disabled || !!busy;
  const oldName = folderName(folder);

  async function run(label: string, task: () => Promise<void>) {
    if (locked) return;
    setBusy(label);
    setError("");
    setStatus("");
    try { await task(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  return <details className="card space-y-4">
    <summary className="cursor-pointer text-base font-semibold text-white">Manage an existing archive</summary>
    <section aria-label="Existing archive maintenance" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-300 break-all">{folder || "Choose an archive folder inside your SD Card Repository."}</p>
        <button type="button" className="btn-secondary" disabled={locked} onClick={() => void run("Choosing archive…", async () => {
          const picked = await open({ directory: true, multiple: false, defaultPath: repository || undefined });
          if (typeof picked !== "string") return;
          setFolder(picked);
          setReview(null);
          setChosenReplacement("");
          setReplacementId("");
          setConfirmation("");
        })}>Choose existing archive</button>
      </div>
      {folder && <>
        <div className="border-t border-gray-700 pt-3 space-y-2">
          <h3 className="text-sm font-semibold text-white">Upgrade in place</h3>
          <p className="text-sm text-gray-400">Verify the saved files, restore recorded timestamps and review the new folder name.</p>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={withCard && !!inspection} disabled={locked || !inspection} onChange={event => {
              setWithCard(event.target.checked);
              setReview(null);
            }} />
            Use the inspected original card for missing folder timestamps
          </label>
          <button type="button" className="btn-secondary" disabled={locked} onClick={() => void run("Reviewing archive…", async () => {
            setReview(null);
            const result = await invoke<UpgradeReview>("review_sd_archive_upgrade", {
              folder,
              source: withCard ? inspection?.source ?? null : null,
            });
            setReview(result);
          })}>Review upgrade</button>
          {review && <div className="rounded border border-gray-700 p-3 space-y-2 text-sm">
            <dl className="grid gap-2 sm:grid-cols-2">
              <div><dt className="text-gray-400">Proposed folder name</dt><dd className="break-all">{review.targetName}</dd></div>
              <div><dt className="text-gray-400">Archive date</dt><dd>{review.date.date} · {review.date.basis}</dd></div>
              <div><dt className="text-gray-400">File timestamps</dt><dd>{review.fileTimes} of {review.fileCount} files</dd></div>
              <div><dt className="text-gray-400">Folder timestamps</dt><dd>{review.folderTimes} of {review.directoryCount} folders{review.rootTime && " and the archive root"}</dd></div>
            </dl>
            {!review.serialKnown && <p className="text-amber-200">PhotoGoGo needs the original card or its saved Jobs record to determine the full card ID. You can restore recorded timestamps under the current name.</p>}
            {(!review.rootTime || review.folderTimes < review.directoryCount) && <p className="text-amber-200">Some original folder times are unavailable. Inspect the original card to include them.</p>}
            <button type="button" className="btn-primary" disabled={locked} onClick={() => void run("Starting upgrade…", async () => {
              setReview(null);
              const job = await invoke<ProcessJob>("start_sd_archive_upgrade", { token: review.token });
              onJob(job);
              setStatus("Upgrade queued. Follow it in Jobs.");
              setFolder("");
            })}>Upgrade verified files</button>
          </div>}
        </div>
        <div className="border-t border-gray-700 pt-3 space-y-2">
          <h3 className="text-sm font-semibold text-white">Recreate from card</h3>
          <p className="text-sm text-gray-400">Inspect the original card above. PhotoGoGo makes a fresh archive and verifies it before you can remove the old copy. The repository needs space for both during the rebuild.</p>
          <button type="button" className="btn-secondary" disabled={locked || !canRecreate} onClick={() => void run("Starting fresh copy…", async () => {
            const job = await onRecreate(folder);
            setReplacementId(job.id);
            setChosenReplacement("");
            setConfirmation("");
            onJob(job);
            setStatus("Fresh copy queued. Follow it in Jobs.");
          })}>Recreate from inspected card</button>
          {replacementJob && replacementJob.status !== "completed" && <p className="text-sm text-sky-200">Follow the replacement in Jobs. Finish verifying it before removing the old archive.</p>}
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm text-gray-300">Remove old copy after recreation</summary>
            <p className="text-sm text-gray-400">Choose the verified replacement. Removal permanently deletes the selected old archive after PhotoGoGo rechecks the replacement.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary" disabled={locked} onClick={() => void run("Choosing replacement…", async () => {
                const picked = await open({ directory: true, multiple: false, defaultPath: repository || undefined });
                if (typeof picked === "string") {
                  setChosenReplacement(picked);
                  setConfirmation("");
                }
              })}>Choose verified replacement</button>
              {replacement && <p className="text-sm break-all">{replacement}</p>}
            </div>
            {replacement && <form className="space-y-2" onSubmit={event => {
              event.preventDefault();
              if (confirmation !== oldName || locked) return;
              void run("Queuing removal…", async () => {
                onJob(await invoke<ProcessJob>("remove_sd_archive_after_recreation", {
                  folder, replacement, confirmation,
                }));
                setStatus("Removal queued. Follow it in Jobs.");
                setFolder("");
                setConfirmation("");
              });
            }}>
              <label className="block text-sm">Type {oldName} to confirm removal
                <input className="input-field mt-1 block w-full max-w-lg" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={locked} autoComplete="off" />
              </label>
              <button type="submit" className="btn-danger" disabled={locked || confirmation !== oldName}>Permanently remove old archive</button>
            </form>}
          </details>
        </div>
      </>}
      {(busy || status) && <p role="status" className="text-sm text-sky-200">{busy || status}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </section>
  </details>;
}
