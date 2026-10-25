import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessPreviewCandidates, ProcessPreviewRequest, ProcessPreviewResult } from "../types/photoProcess";

// A page can switch tasks while native work is finishing. Keep all instances on
// one serial lane; queued obsolete requests are skipped before they reach IPC.
let previewLane: Promise<void> = Promise.resolve();

interface PreviewProps { request: ProcessPreviewRequest }
type DisplayResult = ProcessPreviewResult & { urls: string[] };
const basename = (path: string) => path.split(/[\\/]/).pop() || path;

function imageUrl(data: string | undefined, urls: string[]): string | undefined {
  if (!data) return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
  if (!match) throw new Error("The preview did not contain a supported image or video.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
  urls.push(url);
  return url;
}

/** Read-only previews use the same options and scope as the queued job. */
export default function PhotoProcessPreview({ request }: PreviewProps) {
  const [candidates, setCandidates] = useState<ProcessPreviewCandidates | null>(null);
  const [path, setPath] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fullResolution, setFullResolution] = useState(false);
  const [actualPixels, setActualPixels] = useState(false);
  const [startSeconds, setStartSeconds] = useState(0);
  const generation = useRef(0);
  const candidateGeneration = useRef(0);
  const resultRef = useRef<DisplayResult | null>(null);
  const originalScroll = useRef<HTMLDivElement>(null);
  const processedScroll = useRef<HTMLDivElement>(null);
  const originalVideo = useRef<HTMLVideoElement>(null);
  const processedVideo = useRef<HTMLVideoElement>(null);
  const cleanup = request.task.startsWith("remove_");
  const video = request.task === "stabilize";
  const scopeKey = JSON.stringify([request.stagingDir, request.scopeDir, request.scopeMode, request.task]);
  const optionsKey = JSON.stringify(request);

  function clearResult() {
    for (const url of resultRef.current?.urls || []) URL.revokeObjectURL(url);
    resultRef.current = null;
    setResult(null);
  }

  useEffect(() => () => {
    generation.current++;
    candidateGeneration.current++;
    for (const url of resultRef.current?.urls || []) URL.revokeObjectURL(url);
    resultRef.current = null;
  }, []);

  useEffect(() => {
    const current = ++candidateGeneration.current;
    generation.current++;
    clearResult();
    setPath(""); setCandidates(null); setError(null); setFullResolution(false); setActualPixels(false);
    if (cleanup) { setLoadingCandidates(false); return; }
    setLoadingCandidates(true);
    invoke<ProcessPreviewCandidates>("process_preview_candidates", {
      stagingDir: request.stagingDir, scopeDir: request.scopeDir,
      scopeMode: request.scopeMode, task: request.task,
    }).then((data) => {
      if (current !== candidateGeneration.current) return;
      setCandidates(data);
      setPath(data.paths.length ? data.paths[Math.floor(Math.random() * data.paths.length)] : "");
    }).catch((reason) => {
      if (current === candidateGeneration.current) setError(String(reason));
    }).finally(() => {
      if (current === candidateGeneration.current) setLoadingCandidates(false);
    });
    return () => { candidateGeneration.current++; };
  }, [scopeKey]);

  // A parameter change always returns to the bounded draft. Full-size checks
  // are an explicit action, not an expensive side effect of every slider move.
  useEffect(() => { setFullResolution(false); setActualPixels(false); }, [optionsKey, path]);

  function generate(full: boolean) {
    const current = ++generation.current;
    clearResult(); setError(null); setBusy(true);
    const snapshot: ProcessPreviewRequest = {
      ...request, ...(cleanup ? {} : { path }), fullResolution: full,
      ...(video ? { startSeconds } : {}),
    };
    previewLane = previewLane.catch(() => {}).then(async () => {
      if (current !== generation.current) return;
      try {
        const data = await invoke<ProcessPreviewResult>("process_preview", { request: snapshot });
        if (current !== generation.current) return;
        const urls: string[] = [];
        try {
          const display = { ...data, original: imageUrl(data.original, urls), processed: imageUrl(data.processed, urls), urls };
          resultRef.current = display;
          setResult(display);
        } catch (reason) {
          for (const url of urls) URL.revokeObjectURL(url);
          throw reason;
        }
      } catch (reason) {
        if (current === generation.current) setError(String(reason));
      } finally {
        if (current === generation.current) setBusy(false);
      }
    });
  }

  useEffect(() => {
    generation.current++;
    clearResult(); setError(null); setBusy(false);
    if (video || (!cleanup && !path)) return;
    setBusy(true);
    const timer = window.setTimeout(() => generate(fullResolution), fullResolution || cleanup ? 0 : 350);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [optionsKey, path, fullResolution, startSeconds]);

  function syncScroll(source: HTMLDivElement, target: HTMLDivElement | null) {
    if (!target) return;
    if (target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft;
    if (target.scrollTop !== source.scrollTop) target.scrollTop = source.scrollTop;
  }

  function syncVideo(source: HTMLVideoElement, target: HTMLVideoElement | null, action: "play" | "pause" | "seek") {
    if (!target) return;
    if (Math.abs(target.currentTime - source.currentTime) > 0.08) target.currentTime = source.currentTime;
    if (action === "play" && target.paused) void target.play().catch(() => {});
    if (action === "pause" && !target.paused) target.pause();
  }

  const visiblePaths = (candidates?.paths || []).filter((item) => item.toLowerCase().includes(filter.toLowerCase()));
  const canPreview = cleanup || Boolean(path);
  return (
    <section className="rounded-lg border border-surface-600 bg-surface-900/70 p-3 space-y-3 min-w-0" aria-label={`${request.task} preview`} aria-busy={busy || loadingCandidates}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-medium text-white">{cleanup ? "Cleanup dry run" : "Preview before queuing"}</h4>
        <span className="text-xs text-emerald-300">{cleanup ? "Read-only · no files changed" : "Original files remain untouched"}</span>
      </div>
      <p className="text-xs text-gray-400">Queue scope: <span className="break-all">{request.scopeDir}</span> · {request.scopeMode === "folderOnly" ? "this folder only" : "including subfolders"}. Previewing does not queue a job.</p>
      {!cleanup && <>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className="btn-secondary text-xs" disabled={loadingCandidates || !candidates?.paths.length} onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>Choose {video ? "video" : "photo"}…</button>
          <button type="button" className="btn-secondary text-xs" disabled={(candidates?.paths.length || 0) < 2} onClick={() => {
            const other = (candidates?.paths || []).filter((item) => item !== path);
            if (other.length) setPath(other[Math.floor(Math.random() * other.length)]);
          }}>Another random {video ? "video" : "photo"}</button>
          <span className="text-xs text-gray-200 break-all min-w-0" title={path}>{path ? basename(path) : loadingCandidates ? "Finding originals…" : "No eligible originals in this scope"}</span>
        </div>
        {choosing && <div className="space-y-2">
          <label className="block text-xs text-gray-300">Filter sample list<input aria-label="Filter preview originals" type="search" className="input mt-1 w-full" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
          <select size={Math.min(6, Math.max(2, visiblePaths.length))} aria-label="Preview original" value={path} className="input w-full text-xs" onChange={(event) => { setPath(event.target.value); setChoosing(false); }}>
            {visiblePaths.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          {candidates?.truncated && <p className="text-xs text-amber-300">Showing a bounded sample of {candidates.total.toLocaleString()} eligible originals. Choose a narrower processing folder to find other files.</p>}
        </div>}
      </>}
      {video ? <div className="flex gap-3 items-end flex-wrap">
        <label className="text-xs text-gray-300">Start time (seconds)<input type="number" aria-label="Video preview start seconds" min="0" step="1" value={startSeconds} className="input mt-1 block w-32" onChange={(event) => setStartSeconds(Math.max(0, Number(event.target.value) || 0))} /></label>
        <button type="button" className="btn-primary text-xs" disabled={!canPreview || busy} onClick={() => generate(false)}>{busy ? "Generating preview…" : "Generate 5-second preview"}</button>
        <p className="text-xs text-gray-400">720p draft · short-clip motion context may differ from the complete job.</p>
      </div> : !cleanup && <div className="flex gap-2 items-center flex-wrap">
        <button type="button" className="btn-secondary text-xs" onClick={() => setActualPixels(false)} aria-pressed={!actualPixels}>Fit</button>
        <button type="button" className="btn-secondary text-xs" disabled={!canPreview} onClick={() => { setActualPixels(true); setFullResolution(true); }} aria-pressed={actualPixels}>100% · full-resolution check</button>
        <span className="text-xs text-gray-400">{fullResolution ? "Full-resolution source pixels" : "Responsive draft · up to 1600 px; use 100% to judge fine detail"}</span>
      </div>}
      {error && <div role="alert" className="text-sm text-red-300 rounded border border-red-900 p-2 space-y-2">
        <p className="break-words">Preview unavailable: {error}</p>
        <p className="text-xs text-gray-400">Previewing does not queue a job or alter originals.</p>
        {canPreview && <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => generate(fullResolution)}>Retry preview</button>}
      </div>}
      {busy && <p role="status" className="text-xs text-cyan-200 py-5 text-center">{cleanup ? "Reading the exact cleanup targets…" : "Preparing the latest settings…"}</p>}
      {!busy && result && <>
        {result.warning && <p className="text-xs text-amber-200 rounded bg-amber-950/30 p-2">{result.warning}</p>}
        {result.kind === "cleanup" ? <div className="space-y-2">
          <p className="text-sm text-white">{(result.total || 0).toLocaleString()} file{result.total === 1 ? "" : "s"} would be affected by this cleanup job.</p>
          <ul className="max-h-64 overflow-auto text-xs text-gray-300 break-all space-y-1" aria-label="Cleanup affected files">{(result.affected || []).map((item) => <li key={item}>{item}</li>)}</ul>
          {(result.total || 0) > (result.affected?.length || 0) && <p className="text-xs text-gray-400">The displayed list is capped; the total above covers the full queue scope.</p>}
          <p className="text-xs text-gray-400">This is a snapshot, not a reservation. The queued job rechecks files when it runs and keeps its existing safety checks.</p>
        </div> : <>
          {result.focus && <div className="rounded border border-orange-800 bg-orange-950/20 p-3 text-xs text-gray-300" aria-label="Focus analysis result">
            <strong className={result.focus.flagged ? "text-orange-300" : "text-emerald-300"}>{result.focus.flagged ? "Would flag this original as out of focus" : "Would not flag this original"}</strong>
            <div className="mt-1">Maximum focus score: {result.focus.max.toFixed(1)} · Average score: {result.focus.average.toFixed(1)} · Regions above threshold: {result.focus.percent.toFixed(1)}%</div>
            <div className="mt-1 text-gray-400">Preview does not rename the original. Focus scores are an aid, not a substitute for visual review.</div>
          </div>}
          <div className={`grid gap-2 min-w-0 ${result.processed ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>
            {[{ label: "Original", src: result.original, scroll: originalScroll, videoRef: originalVideo, otherScroll: processedScroll, otherVideo: processedVideo },
              { label: "Result", src: result.processed, scroll: processedScroll, videoRef: processedVideo, otherScroll: originalScroll, otherVideo: originalVideo }].filter((item) => item.src).map((item) => <div key={item.label} className="min-w-0 rounded border border-surface-600 overflow-hidden">
              <div className="px-2 py-1 text-xs text-gray-300 bg-surface-800">{item.label}</div>
              {result.kind === "video" ? <video ref={item.videoRef} src={item.src} controls muted playsInline preload="metadata" aria-label={`${item.label} video preview`} className="w-full max-h-80 bg-black"
                onPlay={(event) => syncVideo(event.currentTarget, item.otherVideo.current, "play")} onPause={(event) => syncVideo(event.currentTarget, item.otherVideo.current, "pause")} onSeeked={(event) => syncVideo(event.currentTarget, item.otherVideo.current, "seek")} /> :
                <div ref={item.scroll} className="h-80 overflow-auto bg-black/40 flex" onScroll={(event) => syncScroll(event.currentTarget, item.otherScroll.current)}>
                  <img src={item.src} alt={`${item.label} photo preview`} className={actualPixels ? "shrink-0 self-start" : "w-full h-full object-contain"} style={actualPixels ? { width: result.width, maxWidth: "none" } : undefined} />
                </div>}
            </div>)}
          </div>
          <p className="text-xs text-gray-500">{result.width && result.height ? `${result.width} × ${result.height} · ` : ""}{result.fullResolution ? "Full-resolution check" : result.kind === "video" ? "Bounded video draft" : "Draft preview"} · {(result.elapsedMs / 1000).toFixed(2)} s. Queue Job applies the selected settings to every eligible original in the queue scope.</p>
        </>}
      </>}
    </section>
  );
}
