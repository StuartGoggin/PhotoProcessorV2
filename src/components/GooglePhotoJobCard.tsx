import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GooglePhotosExistingAlbum, GooglePhotosJob, GooglePhotosStatus } from "../types/googlePhotos";
import { googlePhotoSize } from "../utils/googlePhotos";
import "../pages/GooglePhotos.css";

const activeStates = new Set(["queued", "running", "uploading", "preparing", "committing"]);
export interface GooglePhotoJobCardProps {
  job: GooglePhotosJob;
  account: GooglePhotosStatus["account"];
  busy: boolean;
  run: (name: string, action: () => Promise<unknown>, success?: string) => Promise<void>;
  control: (job: GooglePhotosJob, action: "pause" | "resume" | "retry") => Promise<void>;
}

/** Shared transfer/Jobs recovery UI. Diagnostics are obtained from the native
 * sanitized-report seam, never by exposing protected store paths or tokens. */
export default function GooglePhotoJobCard({ job, account, busy, run, control }: GooglePhotoJobCardProps) {
  const [albums, setAlbums] = useState<GooglePhotosExistingAlbum[] | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState("");
  const active = activeStates.has(job.status);
  // Older summaries expose verified uploads only. Never infer registration
  // acceptance or successful read-back from byte offsets or processed totals.
  const verified = job.uploaded;
  const accepted = job.accepted ?? verified;
  const awaitingVerification = job.awaitingVerification ?? 0;
  const verificationNeedsAttention = job.verificationNeedsAttention ?? 0;
  const pendingVerification = Math.max(0, awaitingVerification - verificationNeedsAttention);
  const displayStatus = job.status === "completed" && awaitingVerification > 0 ? "needs_attention" : job.status;
  const sameAccount = !!account && !!job.accountId && account.id === job.accountId;
  const needsAttention = ["failed", "partial", "blocked", "needs_attention", "unknown", "completed_with_errors"].includes(displayStatus);
  async function recover(albumKey: string) {
    setChosen("");
    await run(`albums-${job.id}`, async () => {
      const existing = await invoke<GooglePhotosExistingAlbum[]>("google_photos_albums");
      setAlbums(existing); setRecovering(albumKey);
    });
  }
  async function showDiagnostics(copy: boolean) {
    if (diagnosticBusy) return;
    setDiagnosticBusy(true); setDiagnosticMessage(""); setDiagnostics(null);
    try {
      const report = await invoke<string>("google_photos_job_diagnostics", { jobId: job.id });
      setDiagnostics(report);
      if (copy) {
        try {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(report);
          setDiagnosticMessage("Diagnostics copied. Review the report before sharing it.");
        } catch { setDiagnosticMessage("Clipboard access was unavailable. The diagnostics are displayed below; select and copy the text manually."); }
      }
    } catch (error) { setDiagnosticMessage(`Diagnostics could not be loaded: ${String(error)}`); }
    finally { setDiagnosticBusy(false); }
  }
  return <article className="gp-job" aria-label={`Google Photos job ${job.id}`}>
    <div className="gp-row gp-between"><div><strong>{job.albums.map(album => album.title).join(" · ") || "Google Photos upload"}</strong><p className="gp-muted">{job.accountEmail} · {new Date(job.createdAt).toLocaleString()}</p><p className="gp-muted">Job ID: {job.id}</p></div><span className={`gp-pill ${displayStatus === "completed" ? "gp-pill-ready" : needsAttention ? "gp-pill-blocked" : ""}`}>{displayStatus.replace(/_/g, " ")}</span></div>
    <progress className={`progress-native ${awaitingVerification > 0 || needsAttention ? "progress-amber" : displayStatus === "completed" ? "progress-emerald" : "progress-blue"}`} aria-label={`Processed photos ${job.id}`} value={job.done} max={Math.max(1, job.total)} />
    <div className="gp-row gp-between"><div className="gp-pills" aria-label="Google Photos acceptance and verification"><span className="gp-pill">Accepted by Google: {accepted}</span><span className="gp-pill gp-pill-ready">Verified: {verified}</span>{pendingVerification > 0 && <span className="gp-pill">Awaiting verification: {pendingVerification}</span>}{verificationNeedsAttention > 0 && <span className="gp-pill gp-pill-blocked">Verification needs attention: {verificationNeedsAttention}</span>}</div><span className="gp-muted">Bytes transferred (not confirmed uploads): {googlePhotoSize(job.bytesDone)} / {googlePhotoSize(job.totalBytes)}</span></div>
    <p className="gp-muted mt-1">{job.skipped} skipped · {job.failed} failed or needing attention · {job.done}/{job.total} processed. Accepted means Google returned a registration receipt; Verified means PhotoGoGo completed its read-back checks.</p>
    {job.currentFile && <p className="gp-muted truncate mt-1" title={job.currentFile}>{job.currentFile}</p>}
    {!sameAccount && <p className="gp-note">Reconnect {job.accountEmail} to continue this job. It cannot upload into another account or OAuth client.</p>}
    {awaitingVerification > 0 && <p className="gp-note">{verificationNeedsAttention > 0 ? "Google accepted these photos, but some verification checks need attention." : "Google accepted these photos; read-back verification is still pending."} {active ? "Verification is continuing in this saved job." : `${["paused", "interrupted", "waiting_for_account"].includes(job.status) ? "Resume" : "Retry"} this saved job to recheck accepted photos. Registration receipts are retained; do not reset or create a new upload to resolve verification.`}</p>}
    {job.status === "completed_with_errors" && awaitingVerification === 0 && <p className="gp-note">Finished with excluded or failed versions. Verified photos are retained. Review the reported checks before retrying remaining work; nothing is silently converted or replaced.</p>}
    {job.errors.length > 0 && <details className="gp-details gp-job-errors" open={needsAttention}><summary>Job messages ({job.errors.length})</summary><ul>{job.errors.map((entry, index) => <li key={index}>{entry}</li>)}</ul></details>}
    <div className="gp-row gp-actions mt-3">
      {active && <button className="btn-secondary" disabled={busy} onClick={() => void control(job, "pause")}>Pause</button>}
      {["paused", "interrupted", "waiting_for_account"].includes(job.status) && <button className="btn-secondary" disabled={busy || !sameAccount} onClick={() => void control(job, "resume")}>Resume</button>}
      {["failed", "partial", "needs_attention", "blocked"].includes(displayStatus) && <button className="btn-secondary" disabled={busy || !sameAccount} onClick={() => void control(job, "retry")}>Retry safe remaining work</button>}
      {job.albums.filter(album => album.productUrl).map(album => <button className="btn-secondary" key={album.key} disabled={busy || !sameAccount} onClick={() => void run(`open-${job.id}`, () => invoke("google_photos_open_album", { jobId: job.id, albumKey: album.key }))}>Open {job.albums.length === 1 ? "album" : album.title} ↗</button>)}
      <button className="btn-secondary" disabled={diagnosticBusy} onClick={() => void showDiagnostics(false)}>{diagnosticBusy ? "Loading diagnostics…" : "View diagnostics"}</button>
      <button className="btn-secondary" disabled={diagnosticBusy} onClick={() => void showDiagnostics(true)}>Copy diagnostics</button>
    </div>
    {diagnosticMessage && <p role="status" className="gp-note">{diagnosticMessage}</p>}
    {diagnostics !== null && <div className="gp-field mt-3"><label htmlFor={`google-diagnostics-${job.id}`}>Sanitized job diagnostics</label><textarea id={`google-diagnostics-${job.id}`} aria-label={`Diagnostics for ${job.id}`} readOnly value={diagnostics} rows={9} className="w-full bg-surface-900 border border-surface-600 rounded p-2 text-xs font-mono" /><small>No protected store or raw log file is exposed. Review the report before sharing.</small><button className="btn-secondary" onClick={() => setDiagnostics(null)}>Hide diagnostics</button></div>}
    {job.albums.filter(album => album.state === "creation_outcome_unknown").map(album => <div className="gp-note" key={album.key}>
      <strong>Album creation needs reconciliation: {album.title}</strong>
      <p>Google’s response was lost, so this album may already exist. PhotoGoGo will not create a duplicate or guess from its name. Review your Google Photos account, then explicitly select the correct PhotoGoGo-created album.</p>
      <button className="btn-secondary mt-2" disabled={busy || !sameAccount} onClick={() => void recover(album.key)}>Choose existing app-created album</button>
      {recovering === album.key && albums && <div className="gp-field mt-3"><span>Verified app-created album</span><select aria-label={`Recover album ${album.key}`} value={chosen} onChange={event => setChosen(event.target.value)}><option value="">Select the exact album — no automatic match</option>{albums.map(existing => <option key={existing.id} value={existing.id}>{existing.title} · ID …{existing.id.slice(-12)}</option>)}</select><small>Associates this saved job only; no photos are uploaded by this action. Resume explicitly after verifying the association.</small><div className="gp-row gp-actions"><button className="btn-secondary" disabled={busy || !chosen || !sameAccount} onClick={() => void run(`reconcile-${job.id}`, async () => { await invoke("google_photos_reconcile", { jobId: job.id, albumKey: album.key, albumId: chosen }); setRecovering(null); }, "Album association saved. Review the job, then resume when ready.")}>Associate selected album</button><button className="btn-secondary" disabled={busy} onClick={() => setRecovering(null)}>Cancel</button></div></div>}
    </div>)}
  </article>;
}
