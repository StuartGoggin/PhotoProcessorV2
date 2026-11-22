import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ProcessJobControls from "../components/ProcessJobControls";
import SdCardArchiveProgress, { archiveSize } from "../components/SdCardArchiveProgress";
import type { ProcessJob, Settings, SourceShortcut } from "../types";
import type { SdCardInspection } from "../types/sdCardArchive";

export default function SdCardArchive({ jobs, refresh, onOpenJob, onSettings }: {
  jobs: ProcessJob[];
  refresh: () => void | Promise<void>;
  onOpenJob: (id: string) => void;
  onSettings: () => void;
}) {
  const [repository, setRepository] = useState<string | null>(null);
  const [cards, setCards] = useState<SourceShortcut[]>([]);
  const [source, setSource] = useState("");
  const [inspection, setInspection] = useState<SdCardInspection | null>(null);
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newJob, setNewJob] = useState<ProcessJob | null>(null);
  const archiveJobs = jobs.filter(job => job.task === "sdCardArchive");
  const currentJob = newJob ? archiveJobs.find(job => job.id === newJob.id) ?? newJob : archiveJobs[0];
  const enoughSpace = inspection != null && inspection.availableBytes > inspection.totalBytes;

  useEffect(() => {
    let active = true;
    Promise.all([invoke<Settings>("load_settings"), invoke<SourceShortcut[]>("list_sd_cards")]).then(([settings, found]) => {
      if (active) { setRepository(settings.sd_card_repository ?? ""); setCards(found); }
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);

  function select(path: string) {
    setSource(path);
    setInspection(null);
    setDate("");
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
    <section className="rounded-xl border border-surface-600 bg-surface-800 p-4 space-y-3" aria-label="New card archive">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">SD Card Repository</h2>
          <p className="text-sm text-gray-400 break-all">{repository === null ? "Loading settings…" : repository || "Choose a repository to start archiving."}</p>
        </div>
        <button className="btn-secondary" disabled={!!busy} onClick={onSettings}>Repository settings</button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-gray-200 flex-1 min-w-48">Source card
          <select className="input-field block w-full" value={source} disabled={!!busy} onChange={event => select(event.target.value)}>
            <option value="">Select a mounted card</option>
            {cards.map(card => <option key={card.path} value={card.path}>{card.label}</option>)}
            {source && !cards.some(card => card.path === source) && <option value={source}>{source}</option>}
          </select>
        </label>
        <button className="btn-secondary" disabled={!!busy} onClick={() => void run("Refreshing cards…", async () => {
          setCards(await invoke<SourceShortcut[]>("list_sd_cards"));
          select("");
        })}>Refresh cards</button>
        <button className="btn-secondary" disabled={!!busy} onClick={() => void run("Selecting card…", async () => {
          const picked = await open({ directory: true, multiple: false });
          if (typeof picked === "string") select(picked);
        })}>Browse for card root</button>
        <button className="btn-primary" disabled={!repository || !source || !!busy} onClick={() => void run("Scanning card…", async () => {
          setInspection(null);
          setInspection(await invoke<SdCardInspection>("scan_sd_card_archive", { source }));
        })}>Inspect card</button>
      </div>
      {inspection && <div className="border-t border-surface-600 pt-3 space-y-3">
        <dl className="grid gap-3 grid-cols-2 lg:grid-cols-4 text-sm">
          <div><dt className="text-gray-400">Volume</dt><dd className="text-white">{inspection.label}</dd></div>
          <div><dt className="text-gray-400">Contents</dt><dd className="text-white">{inspection.files.toLocaleString()} files · {inspection.directories.toLocaleString()} folders</dd></div>
          <div><dt className="text-gray-400">Card data</dt><dd className="text-white">{archiveSize(inspection.totalBytes)}</dd></div>
          <div><dt className="text-gray-400">Repository free</dt><dd className={enoughSpace ? "text-white" : "text-amber-200"}>{archiveSize(inspection.availableBytes)}</dd></div>
        </dl>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-200">Override archive date<input className="input-field block" type="date" value={date} disabled={!!busy} onChange={event => setDate(event.target.value)} /></label>
          <button className="btn-primary" disabled={!!busy || !enoughSpace} onClick={() => void run("Starting archive…", async () => {
            const token = inspection.token;
            setInspection(null);
            follow(await invoke<ProcessJob>("start_sd_card_archive", { token, dateOverride: date || null }));
          })}>Start archive</button>
        </div>
        {inspection.proposedDate
          ? <p className="text-xs text-gray-400">Estimated date {inspection.proposedDate.date} from file modification time. PhotoGoGo checks embedded capture times on the copy before naming it.</p>
          : <p className="text-xs text-gray-400">PhotoGoGo will check the date on the copied files. You can enter it now if the card has no dated camera files.</p>}
        {!enoughSpace && <p role="alert" className="text-sm text-amber-200">The repository does not have enough free space for this card.</p>}
      </div>}
      {busy && <p role="status" className="text-sm text-sky-200">{busy}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
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
