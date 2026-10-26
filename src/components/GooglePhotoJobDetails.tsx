import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessJob } from "../types";
import type { GooglePhotosExistingAlbum } from "../types/googlePhotos";
import { googlePhotoSize } from "../utils/googlePhotos";
import "../pages/GooglePhotos.css";

/** Receipt-specific read-only information inside the normal process console.
 * This module has no tracker, worker, polling, job status or job controls. */
export default function GooglePhotoJobDetails({ job, onChanged }: { job: ProcessJob; onChanged?: () => Promise<void> }) {
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [albums, setAlbums] = useState<GooglePhotosExistingAlbum[] | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setDiagnostics(null); setMessage(""); setAlbums(null); setRecovering(null); setChosen(""); return () => { generation.current++; }; }, [job.id]);
  const details = job.googlePhotos;
  if (!details) return <p className="text-xs text-amber-200">Protected Google Photos receipt details are unavailable. Refresh Jobs; no new upload is needed.</p>;
  const awaiting = details.awaitingVerification ?? 0;
  const warnings = details.verificationNeedsAttention ?? 0;
  const mayContinue = job.canContinue === true && !job.persistenceError;
  async function action(run: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage("");
    try { await run(); }
    catch (reason) { setMessage(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function diagnostic(copy: boolean) {
    const epoch = generation.current; setDiagnostics(null);
    await action(async () => {
      const text = await invoke<string>("process_job_diagnostics", { jobId: job.id });
      if (generation.current !== epoch) return;
      setDiagnostics(text);
      if (copy) {
        try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(text); setMessage("Diagnostics copied. Review before sharing."); }
        catch { setMessage("Clipboard access was unavailable. Select and copy the diagnostics below manually."); }
      }
    });
  }
  return <section className="space-y-3" aria-label="Google Photos receipt details">
    <p className="text-xs text-gray-400">Destination account: {details.accountEmail}</p>
    <div className="gp-pills" aria-label="Google Photos acceptance and verification"><span className="gp-pill">Accepted by Google: {details.accepted ?? details.uploaded}</span><span className="gp-pill gp-pill-ready">Verified: {details.uploaded}</span>{awaiting > warnings && <span className="gp-pill">Awaiting verification: {awaiting - warnings}</span>}{warnings > 0 && <span className="gp-pill gp-pill-blocked">Verification needs attention: {warnings}</span>}</div>
    <p className="text-xs text-gray-400">Bytes transferred (not confirmed uploads): {googlePhotoSize(details.bytesDone)} / {googlePhotoSize(details.totalBytes)}. Accepted means a registration receipt; Verified means completed read-back checks.</p>
    {awaiting > 0 && <p className="gp-note">Google accepted these photos; some verification remains outstanding. {job.status === "running" || job.status === "queued" ? "Verification is continuing in this saved job." : `${job.status === "paused" ? "Resume" : "Retry"} this saved job to recheck accepted photos. Receipts are retained; do not reset or create a new upload to resolve verification.`}</p>}
    {job.status === "aborted" && <p className="gp-note">Network work is stopped. Saved registration receipts and resumable checkpoints remain available; Retry continues this same saved job.</p>}
    <div className="gp-row gp-actions">
      {details.albums.filter(album => album.productUrl).map(album => <button className="btn-secondary" key={album.key} disabled={busy || !mayContinue} onClick={() => void action(async () => { await invoke("process_job_open_album", { jobId: job.id, albumKey: album.key }); })}>Open {details.albums.length === 1 ? "album" : album.title} ↗</button>)}
      <button className="btn-secondary" disabled={busy} onClick={() => void diagnostic(false)}>View diagnostics</button><button className="btn-secondary" disabled={busy} onClick={() => void diagnostic(true)}>Copy diagnostics</button>
    </div>
    {message && <p role="status" className="gp-note">{message}</p>}
    {diagnostics !== null && <div className="gp-field"><label htmlFor={`process-google-diagnostics-${job.id}`}>Sanitized process-job diagnostics</label><textarea id={`process-google-diagnostics-${job.id}`} aria-label={`Diagnostics for ${job.id}`} readOnly value={diagnostics} rows={8} className="w-full bg-surface-900 border border-surface-600 rounded p-2 text-xs font-mono" /><small>No raw protected store or credential file is exposed.</small></div>}
    {details.albums.filter(album => album.state === "creation_outcome_unknown").map(album => <div className="gp-note" key={album.key}><strong>Album creation needs reconciliation: {album.title}</strong><p>The create response was lost. Select the actual app-created album; this will not start an upload or create another album.</p><button className="btn-secondary mt-2" disabled={busy || !mayContinue} onClick={() => void action(async () => { setChosen(""); setAlbums(await invoke<GooglePhotosExistingAlbum[]>("process_job_albums", { jobId: job.id })); setRecovering(album.key); })}>Choose existing app-created album</button>{recovering === album.key && albums && <div className="gp-field mt-2"><select aria-label={`Recover album ${album.key}`} value={chosen} onChange={event => setChosen(event.target.value)}><option value="">Choose the exact album — no automatic match</option>{albums.map(value => <option key={value.id} value={value.id}>{value.title} · ID …{value.id.slice(-12)}</option>)}</select><button className="btn-secondary" disabled={busy || !chosen || !mayContinue} onClick={() => void action(async () => { await invoke("process_job_reconcile_album", { jobId: job.id, albumKey: album.key, albumId: chosen }); setRecovering(null); await onChanged?.(); setMessage("Album association saved. Resume explicitly when ready."); })}>Associate selected album</button></div>}</div>)}
  </section>;
}
