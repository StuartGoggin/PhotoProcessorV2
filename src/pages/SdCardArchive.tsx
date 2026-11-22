import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ProcessJobControls from "../components/ProcessJobControls";
import SdCardArchiveProgress, { archiveSize } from "../components/SdCardArchiveProgress";
import type { ProcessJob, Settings } from "../types";
import type { SdArchiveSource, SdCardInspection } from "../types/sdCardArchive";
import "./SdCardArchive.css";

const sourceEvidence: Record<SdArchiveSource["kind"], string> = {
  sd: "SD card · Windows reports an SD bus",
  usb: "USB storage · media type unconfirmed",
  mmc: "MMC media · reported by Windows",
  removable: "Removable drive · media type unconfirmed",
};

function HelpTip({ label, children }: { label: string; children: string }) {
  const id = useId();
  return <span className="sd-archive-help">
    <button type="button" aria-label={label} aria-describedby={id}>?</button>
    <span id={id} role="tooltip">{children}</span>
  </span>;
}

function ArchiveCardIcon() {
  return <span className="sd-picker-card-icon" aria-hidden="true"><i /><i /><i /></span>;
}

export default function SdCardArchive({ jobs, refresh, onOpenJob, onSettings }: {
  jobs: ProcessJob[];
  refresh: () => void | Promise<void>;
  onOpenJob: (id: string) => void;
  onSettings: () => void;
}) {
  const [repository, setRepository] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState("");
  const [cards, setCards] = useState<SdArchiveSource[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [source, setSource] = useState("");
  const [inspection, setInspection] = useState<SdCardInspection | null>(null);
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newJob, setNewJob] = useState<ProcessJob | null>(null);
  const archiveJobs = jobs.filter(job => job.task === "sdCardArchive");
  const currentJob = newJob ? archiveJobs.find(job => job.id === newJob.id) ?? newJob : archiveJobs[0];
  const enoughSpace = inspection?.availableBytes != null && inspection.availableBytes > inspection.totalBytes;
  const manualSource = source && !cards.some(card => card.path === source);

  useEffect(() => {
    let active = true;
    invoke<Settings>("load_settings").then(settings => {
      if (active) setRepository(settings.sd_card_repository ?? "");
    }).catch(reason => { if (active) setRepositoryError(String(reason)); });
    invoke<SdArchiveSource[]>("list_sd_archive_sources").then(found => {
      if (active) setCards(found);
    }).catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoadingCards(false); });
    return () => { active = false; };
  }, []);

  function select(path: string) {
    setSource(path);
    setInspection(null);
    setDate("");
    setError("");
  }

  async function run(label: string, work: () => Promise<void>) {
    if (busy) return;
    setError("");
    setBusy(label);
    try { await work(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  function follow(job: ProcessJob) {
    setNewJob(job);
    void refresh();
  }

  return <div className="max-w-5xl mx-auto space-y-5">
    <header>
      <h1 className="text-2xl font-bold text-white">SD Card Archive</h1>
      <p className="mt-1 text-sm text-gray-400">Preserve the entire card and verify every file before reusing it.</p>
    </header>
    <section className="sd-picker" aria-label="New card archive">
      <div className="sd-picker-grid">
        <div className="sd-picker-source">
          <div className="sd-picker-heading">
            <div className="sd-picker-title">
              <h2>Source card</h2>
              <HelpTip label="How cards are identified">Windows may identify an SD card directly or report only its USB reader. Check the drive letter and label before selecting.</HelpTip>
            </div>
            <button className="btn-secondary sd-picker-compact" disabled={!!busy || loadingCards} title="Look for media inserted since this page opened" onClick={() => void run("Refreshing cards…", async () => {
              select("");
              setCards(await invoke<SdArchiveSource[]>("list_sd_archive_sources"));
            })}>Refresh cards</button>
          </div>
          <fieldset className="sd-picker-options" disabled={!!busy}>
            <legend className="sr-only">Source card</legend>
            {loadingCards && <p role="status" className="sd-picker-empty">Detecting mounted cards…</p>}
            {!loadingCards && !cards.length && <p className="sd-picker-empty">No mounted card found. Insert your card and refresh.</p>}
            {cards.map(card => <label key={card.path} className="sd-picker-option" data-selected={card.path === source}>
              <input type="radio" name="sd-archive-source" value={card.path} checked={card.path === source} onChange={() => select(card.path)} />
              <ArchiveCardIcon />
              <span className="sd-picker-option-copy">
                <strong>{card.label}</strong>
                <span className={card.kind === "sd" ? "sd-picker-confirmed" : undefined}>{sourceEvidence[card.kind]}</span>
              </span>
              {card.capacityBytes != null && <span className="sd-picker-capacity">{archiveSize(card.capacityBytes)}</span>}
            </label>)}
            {manualSource && <div className="sd-picker-option" data-selected="true">
              <ArchiveCardIcon />
              <span className="sd-picker-option-copy"><strong>{source}</strong><span>Manually selected · media type unconfirmed</span></span>
            </div>}
          </fieldset>
          <details className="sd-picker-fallback">
            <summary>Card not listed?</summary>
            <p>Some readers appear as fixed drives. If you can see the card in File Explorer, select its drive root, such as E:\, to inspect it.</p>
            <button className="btn-secondary sd-picker-compact" disabled={!!busy} title="Use only if your card is missing from the detected list" onClick={() => void run("Selecting card…", async () => {
              const picked = await open({ directory: true, multiple: false });
              if (typeof picked !== "string") return;
              if (!/^[A-Za-z]:[\\/]$/.test(picked)) throw new Error("Choose the card's drive root, such as E:\\, instead of a folder on the card.");
              select(`${picked[0].toUpperCase()}:\\`);
            })}>Browse for card root</button>
          </details>
        </div>
        <div className="sd-picker-destination">
          <div className="sd-picker-title">
            <h2>SD Card Repository</h2>
            <HelpTip label="What the repository is for">This folder holds the finished archives. Pick a folder on a different volume from the card. You can inspect the card before choosing it.</HelpTip>
          </div>
          <div className="sd-picker-repository" aria-hidden="true"><i /><i /><i /></div>
          <p className="sd-picker-repository-path">{repositoryError ? "Repository settings unavailable" : repository === null ? "Loading settings…" : repository || "Choose a repository to start archiving."}</p>
          {repositoryError && <p role="alert" className="text-xs text-amber-200">{repositoryError}</p>}
          <button className="btn-secondary sd-picker-compact" disabled={!!busy} title="Choose where PhotoGoGo saves completed card archives" onClick={onSettings}>Repository settings</button>
        </div>
      </div>
      <div className="sd-picker-action">
        <p>{source ? "Inspection reads the card’s contents and checks available space when a repository is set." : "Select a mounted card to inspect its files."}</p>
        <div className="sd-picker-title">
          <HelpTip label="What happens when I inspect a card">PhotoGoGo counts the files, checks their total size and estimates the archive date. Inspection is read-only.</HelpTip>
          <button className="btn-primary" disabled={!source || !!busy} onClick={() => void run("Scanning card…", async () => {
            setInspection(null);
            setInspection(await invoke<SdCardInspection>("scan_sd_card_archive", { source }));
          })}>Inspect card</button>
        </div>
      </div>
      {inspection && <div className="sd-picker-inspection space-y-3">
        <dl className="grid gap-3 grid-cols-2 lg:grid-cols-4 text-sm">
          <div><dt className="text-gray-400">Volume</dt><dd className="text-white">{inspection.label}</dd></div>
          <div><dt className="text-gray-400">Contents</dt><dd className="text-white">{inspection.files.toLocaleString()} files · {inspection.directories.toLocaleString()} folders</dd></div>
          <div><dt className="text-gray-400">Card data</dt><dd className="text-white">{archiveSize(inspection.totalBytes)}</dd></div>
          <div><dt className="text-gray-400">Repository free</dt><dd className={enoughSpace ? "text-white" : "text-amber-200"}>{inspection.availableBytes == null ? "Unavailable" : archiveSize(inspection.availableBytes)}</dd></div>
        </dl>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-200">Override archive date<input className="input-field block" type="date" value={date} disabled={!!busy} onChange={event => setDate(event.target.value)} /></label>
          <button className="btn-primary" disabled={!!busy || !enoughSpace || !inspection.token} onClick={() => void run("Starting archive…", async () => {
            const token = inspection.token;
            if (!token) return;
            setInspection(null);
            follow(await invoke<ProcessJob>("start_sd_card_archive", { token, dateOverride: date || null }));
          })}>Start archive</button>
        </div>
        {inspection.proposedDate
          ? <p className="text-xs text-gray-400">Estimated date {inspection.proposedDate.date} from file modification time. PhotoGoGo checks embedded capture times on the copy before naming it.</p>
          : <p className="text-xs text-gray-400">PhotoGoGo will check the date on the copied files. You can enter it now if the card has no dated camera files.</p>}
        {inspection.repositoryIssue
          ? <p role="status" className="text-sm text-amber-200">{inspection.repositoryIssue}</p>
          : !enoughSpace && <p role="alert" className="text-sm text-amber-200">The repository does not have enough free space for this card.</p>}
      </div>}
      {busy && <p role="status" className="sd-picker-feedback text-sky-200">{busy}</p>}
      {error && <p role="alert" className="sd-picker-feedback text-red-300">{error}</p>}
    </section>
    {currentJob && <div className="space-y-3">
      <SdCardArchiveProgress key={currentJob.id} job={currentJob} onChanged={refresh} onVerification={follow} />
      {currentJob.errors.length > 0 && <p role="alert" className="text-sm text-red-300">{currentJob.errors.join(" · ")}</p>}
      <div className="flex flex-wrap items-start gap-2">
        <ProcessJobControls job={currentJob} onChanged={async () => { await refresh(); }} />
        <button className="btn-secondary" onClick={() => onOpenJob(currentJob.id)}>View in Jobs</button>
      </div>
    </div>}
    <section className="flex flex-wrap items-center justify-between gap-2 py-2" aria-label="Verify an existing archive">
      <p className="text-sm text-gray-400">Check an existing archive from its saved checksum file, even without the card.</p>
      <button className="btn-secondary" disabled={!!busy} onClick={() => void run("Opening archive…", async () => {
        const folder = await open({ directory: true, multiple: false });
        if (typeof folder !== "string") return;
        follow(await invoke<ProcessJob>("verify_sd_card_archive", { folder }));
      })}>Verify an archive folder</button>
    </section>
  </div>;
}
