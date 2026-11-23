import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessJob } from "../types";
import type { SdArchiveSource } from "../types/sdCardArchive";
import SdArchiveReuseReport, { ReuseSide, reuseProofMatched } from "./SdArchiveReuseReport";
import "./SdArchiveReuseModal.css";

const phases = [
  "Looking for matching archives",
  "Checking card and repository",
  "Verification proof",
];

export default function SdArchiveReuseModal({ card, repository, job, queueError, close, openJob, refresh }: {
  card: SdArchiveSource;
  repository: string;
  job?: ProcessJob;
  queueError: string;
  close: () => void;
  openJob: (id: string) => void;
  refresh: () => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [action, setAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [confirmedJob, setConfirmedJob] = useState("");
  const [handoffBlocked, setHandoffBlocked] = useState(false);
  const proof = job?.sdCardArchive?.reuseProof;
  const active = !queueError && (!job || ["queued", "running"].includes(job.status));
  const report = !!job && !active;
  const matched = reuseProofMatched(job);
  const phase = report || queueError ? 2 : proof?.stage === "compare" ? 1 : 0;
  const manual = matched && confirmedJob === job?.id;

  useEffect(() => {
    dialog.current?.showModal();
    heading.current?.focus();
  }, []);

  async function perform(label: string, work: () => Promise<void>) {
    if (action) return;
    setAction(label);
    setActionError("");
    try { await work(); } catch (reason) { setActionError(String(reason)); }
    finally { setAction(""); }
  }

  function phaseState(index: number) {
    if (index === phase) return active ? "active" : matched ? "done" : "blocked";
    if (index > phase) return "pending";
    if (index === 0) return proof?.candidates ? "done" : "blocked";
    return matched ? "done" : proof?.card ? "blocked" : "pending";
  }

  return <dialog className="sd-reuse-modal" ref={dialog} aria-labelledby={titleId} onClose={close}>
    <header className="sd-reuse-header">
      <div><h2 ref={heading} tabIndex={-1} id={titleId}>Prepare to format</h2><p>{card.label} · {card.path}</p></div>
      <button className="btn-secondary" onClick={() => dialog.current?.close()}>{active ? "Run in background" : "Close"}</button>
    </header>
    <ol className="sd-reuse-phases" aria-label="Reuse check progress">
      {phases.map((item, index) => <li key={item} data-state={phaseState(index)} aria-current={phase === index ? "step" : undefined}>
        <span className="sd-reuse-step" aria-hidden="true">{phaseState(index) === "done" ? "✓" : index + 1}</span>
        <span>{item}</span>
      </li>)}
    </ol>
    {queueError && <p className="sd-reuse-warning sd-reuse-message" role="alert">{queueError}</p>}
    {active && <div className="sd-reuse-body">
      {phase === 0 ? <div className="sd-reuse-lookup" role="status">
        <span className="sd-reuse-radar" aria-hidden="true" />
        <div><p>{job?.currentPhase === "Waiting for the card reader" ? "Waiting for the card reader" : "Looking for matching archives"}</p>
          <span>{proof?.archivesSearched ?? 0} archive records checked · {proof?.candidates ?? 0} with this card ID</span></div>
      </div> : <>
        <p className="sd-reuse-message" role="status">{job?.currentPhase}</p>
        <div className="sd-reuse-sides" data-live="true">
          <ReuseSide title="Source card" label={card.path} side={proof?.card} live />
          <ReuseSide title="Repository copy" label={proof?.archiveFolder ?? repository} side={proof?.archive} live />
        </div>
        {job?.currentFile && <p className="sd-reuse-current-file" title={job.currentFile}>{job.currentFile}</p>}
      </>}
    </div>}
    {report && job && <div className="sd-reuse-body"><SdArchiveReuseReport job={job} /></div>}
    {manual && <div className="sd-reuse-handoff" role="status">
      <h3>Manual formatting</h3>
      <p>In File Explorer, right-click <strong>{card.path}</strong>, choose Format, and confirm the card label is <strong>{card.label}</strong>. Formatting erases the selected drive. To format the card manually, enter <strong>GogginPhoto</strong> as the volume label.</p>
      <p>Run a fresh check if the card is removed or either copy changes.</p>
    </div>}
    {actionError && <p className="sd-reuse-warning sd-reuse-message" role="alert">{actionError}</p>}
    <footer className="sd-reuse-footer">
      {job && <button className="btn-secondary" onClick={() => { dialog.current?.close(); openJob(job.id); }}>View in Jobs</button>}
      {active && job && <button className="btn-secondary" disabled={!!action} onClick={() => void perform("Cancelling…", async () => {
        await invoke("abort_process_job", { jobId: job.id });
        await refresh();
      })}>{action || "Cancel check"}</button>}
      {matched && !manual && !handoffBlocked && job && <button className="btn-primary" disabled={!!action} onClick={() => void perform("Rechecking card…", async () => {
        try {
          await invoke("confirm_sd_card_reuse", { jobId: job.id });
        } catch (reason) {
          setHandoffBlocked(true);
          throw reason;
        }
        setConfirmedJob(job.id);
      })}>{action || "Confirm card for manual formatting"}</button>}
    </footer>
  </dialog>;
}
