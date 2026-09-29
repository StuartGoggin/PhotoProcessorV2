import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob } from "../types/videoStudio";
import { timecode } from "../types/videoStudio";
import "../styles/studio-video-preview.css";

export interface StudioVideoPreviewProps {
  jobId: string | null;
  jobs: StudioJob[];
  /** Original-clip position of the first preview frame, not final-video time. */
  sourceStart: number;
  /** Additional session identity. Clear jobId when a changed recipe has no matching preview. */
  resetKey?: string;
  /** Supply only when preview time maps linearly to the original clip. */
  onTimeSelected?: (absoluteSeconds: number) => void;
}

// A session owns its media and pending read. Changing clips/recipes unmounts it;
// late native responses cannot expose an earlier clip or retain its media URL.
export default function StudioVideoPreview(props: StudioVideoPreviewProps) {
  const job = props.jobs.find((candidate) => candidate.id === props.jobId);
  return <PreviewSession key={JSON.stringify([props.jobId, props.resetKey, props.sourceStart])}
    job={job} jobId={props.jobId} sourceStart={props.sourceStart} onTimeSelected={props.onTimeSelected} />;
}

function PreviewSession({ job, jobId, sourceStart, onTimeSelected }: {
  job?: StudioJob;
  jobId: string | null;
  sourceStart: number;
  onTimeSelected?: StudioVideoPreviewProps["onTimeSelected"];
}) {
  const player = useRef<HTMLVideoElement>(null);
  const [media, setMedia] = useState<{ output: string; url: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [position, setPosition] = useState(0);
  const [canSeek, setCanSeek] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const mounted = useRef(true);
  const preview = job?.kind === "preview";
  const completed = preview && job.status === "completed" && !!job.output;
  const output = completed ? job.output! : "";
  const current = output && media?.output === output ? media : null;
  const linear = !!onTimeSelected && Number.isFinite(sourceStart) && sourceStart >= 0;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    setMedia(null); setError(""); setPlayerError(""); setPosition(0); setCanSeek(false);
    if (!jobId || !output) { setLoading(false); return; }
    setLoading(true);
    void invoke<string>("studio_read_preview", { jobId }).then((url) => {
      if (!alive) return;
      // This is generated preview media, never a filesystem URL or arbitrary
      // page supplied by a project. Native code enforces the 64 MiB file cap.
      const maxDataUrlLength = 4 * Math.ceil(64 * 1024 * 1024 / 3) + 64;
      if (typeof url !== "string" || url.length > maxDataUrlLength || !url.startsWith("data:video/mp4;base64,")) {
        throw new Error("The preview response was not a supported MP4. Open it externally or retry.");
      }
      setMedia({ output, url });
    }).catch((failure) => { if (alive) setError(String(failure)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  // Polling produces fresh job objects. Only a different media identity or an
  // explicit retry should reread a potentially large preview.
  }, [jobId, output, attempt]);

  async function openExternal() {
    if (!output || opening) return;
    setOpening(true); setError("");
    try { await invoke("open_in_default_app", { path: output }); }
    catch (failure) { if (mounted.current) setError(`Could not open the preview: ${String(failure)}`); }
    finally { if (mounted.current) setOpening(false); }
  }
  function selectTime() {
    const value = player.current?.currentTime;
    if (linear && canSeek && !playerError && value != null && Number.isFinite(value) && value >= 0) {
      onTimeSelected!(sourceStart + value);
    }
  }
  const stateText = !jobId ? "Generate a quick preview to review movement here."
    : !job ? "Waiting for the preview job…"
    : !preview ? "This job is not a preview. Generate a new quick preview."
    : job.status === "completed" && !job.output ? "This preview has no saved output. Generate a new quick preview."
    : completed ? loading ? "Loading preview for playback…" : current ? job.cacheHits > 0 ? "Cached preview ready" : "Preview ready" : "Preview unavailable in the app"
    : job.status === "failed" ? `Preview failed: ${job.error || "See the job details for more information."}`
    : job.status === "cancelled" ? "Preview cancelled. Generate a new quick preview when ready."
    : job.status === "paused" || job.status === "interrupted" ? "Preview paused or interrupted. Resume it from Jobs."
    : job.status === "queued" ? "Preview queued. It will appear here when ready."
    : `${job.phase || "Generating preview"}${Number.isFinite(job.progress) ? ` · ${Math.round(Math.max(0, Math.min(100, job.progress)))}%` : ""}`;
  return <section className="studio-video-preview" aria-label="Video preview" data-preview-job-id={jobId || undefined}>
    <div className="studio-video-preview-heading"><strong>Movement preview</strong><span>720p · original sound · no music</span></div>
    <p className="studio-video-preview-status" role="status">{stateText}</p>
    {current && <video key={`${current.output}:${attempt}`} ref={player} src={current.url} controls playsInline preload="metadata" aria-label="Studio movement preview"
      onLoadedMetadata={(event) => setCanSeek(Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0)}
      onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
      onError={() => { setCanSeek(false); setPlayerError("This preview cannot be played in the app. You can still open the saved video externally."); }} />}
    {linear && current && <div className="studio-video-preview-position">
      <span>Source time <output aria-label="Preview source time">{timecode(sourceStart + position)}</output></span>
      <button type="button" className="btn-secondary" disabled={!canSeek || !!playerError} onClick={selectTime}>Use current source time</button>
    </div>}
    <p className="studio-video-preview-help">This short preview checks movement and framing. A full-clip stabilisation pass can differ near the preview edges.</p>
    {(error || playerError) && <p role="alert" className="studio-video-preview-error">{error || playerError}</p>}
    {completed && <div className="studio-video-preview-actions">
      <button type="button" className="btn-secondary" disabled={opening} onClick={() => void openExternal()}>{opening ? "Opening…" : "Open preview externally"}</button>
      {(error || playerError) && <button type="button" className="btn-secondary" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>Retry preview playback</button>}
    </div>}
  </section>;
}
