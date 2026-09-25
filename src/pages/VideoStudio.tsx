import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../types";
import StudioJobs from "../components/StudioJobs";
import StudioAiReview from "../components/StudioAiReview";
import { clipName, newProject, projectDuration, timecode } from "../types/videoStudio";
import type { BackgroundMusic, StudioClip, StudioJob, StudioProject, StudioReplay } from "../types/videoStudio";
import StudioBackgroundMusic from "../components/StudioBackgroundMusic";
import StudioOutputSettings from "../components/StudioOutputSettings";
import { STUDIO_CLEARED, resetProjectRenders } from "../utils/studioWorkflow";
import { sequenceStatus, sequenceClipCount } from "../utils/studioWorkflow";
import { applyCompletedRenders, approveAndNext, clipJob, clipStatus, editClip, isClipReady, moveClip, normalizeProject, outputLabel } from "../utils/studioWorkflow";
import StudioStabilizationFields from "../components/StudioStabilizationFields";
import StudioApprovalButton from "../components/StudioApprovalButton";
import StudioAudioControls from "../components/studio/StudioAudioControls";
import StudioExportDescription from "../components/StudioExportDescription";
import "../styles/studio-editor.css";

const KEY = "photogogo.videoStudio.project.v1";
const input = "bg-surface-900 rounded border border-surface-600 px-3 py-2 w-full text-sm";
async function stagingFolder() {
  const settings = await invoke<Settings>("load_settings");
  if (!settings.staging_dir) throw new Error("Configure a staging folder in Settings first.");
  return settings.staging_dir;
}
export default function VideoStudio({ onOpenJobs, jobs }: { onOpenJobs: () => void; jobs: StudioJob[] }) {
  const [project, setProject] = useState<StudioProject>(newProject);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [clipFilter, setClipFilter] = useState("all");
  const [editorTab, setEditorTab] = useState("picture");
  const [density, setDensity] = useState<"compact" | "comfortable">(() => {
    try { return localStorage.getItem("photogogo.studio.density") === "comfortable" ? "comfortable" : "compact"; } catch { return "compact"; }
  });
  const [finishOpen, setFinishOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem("photogogo.studio.density", density); } catch { /* Optional display preference. */ } }, [density]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [frames, setFrames] = useState<{ at: number; data: string }[]>([]);
  const [frameBusy, setFrameBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [autosaveOk, setAutosaveOk] = useState(true);
  const request = useRef(0);
  const projectEpoch = useRef(0);
  const currentEpoch = projectEpoch.current;
  useEffect(() => {
    const clear = () => {
      projectEpoch.current++;
      setProject((prev) => resetProjectRenders(prev));
      setMessage("Studio renders cleared. Clips will render from scratch; your edits and media are preserved.");
    };
    window.addEventListener(STUDIO_CLEARED, clear);
    return () => window.removeEventListener(STUDIO_CLEARED, clear);
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const p = normalizeProject(JSON.parse(raw));
          await invoke("studio_validate_project", { project: p });
          if (alive) setProject(normalizeProject(p));
        }
      } catch {
        if (alive) setError("Autosaved project could not be read. Open a saved snapshot.");
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (loaded) {
      try {
        localStorage.setItem(KEY, JSON.stringify(project));
        setAutosaveOk(true);
      } catch {
        setAutosaveOk(false);
        setError("Autosave failed. Save a snapshot before closing.");
      }
    }
  }, [project, loaded]);
  const clip = project.clips.find((c) => c.id === selected);
  useEffect(() => {
    if (loaded && !project.clips.some((c) => c.id === selected)) setSelected(project.clips[0]?.id || "");
  }, [project.clips, loaded, selected]);
  useEffect(() => {
    request.current++;
    setFrames([]);
  }, [clip?.id, clip?.path]);
  function patch(p: Partial<StudioProject>) {
    setProject((prev) => ({ ...prev, ...p }));
  }
  function edit(id: string, change: Partial<StudioClip>) {
    setProject((prev) => ({ ...prev, clips: prev.clips.map((c) => c.id === id ? editClip(c, change) : c) }));
  }
  useEffect(() => {
    if (loaded) setProject((prev) => {
      const updated = applyCompletedRenders(prev, jobs);
      const music = jobs.find((j) => j.kind === "music" && j.status === "completed" && j.output && j.musicRequestId && j.musicRequestId === prev.music.requestId);
      if (!music || updated.music.audioPath === music.output) return updated;
      return { ...updated, music: { ...updated.music, enabled: true, audioPath: music.output!, projectPath: music.musicProjectPath || "", requestId: "" } };
    });
  }, [jobs, loaded]);
  const renderedPaths = JSON.stringify(project.clips.flatMap((c) => c.rendered ? [c.rendered.path] : []));
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    const paths: string[] = JSON.parse(renderedPaths);
    const refresh = async () => {
      if (!paths.length) return;
      try {
        const missing = new Set(await invoke<string[]>("studio_missing_outputs", { paths }));
        if (!alive) return;
        setProject((prev) => {
          let changed = false;
          const clips = prev.clips.map((c) => {
            if (!c.rendered || !paths.includes(c.rendered.path)) return c;
            const available = !missing.has(c.rendered.path);
            if ((c.rendered.available !== false) === available) return c;
            changed = true; return { ...c, rendered: { ...c.rendered, available } };
          });
          return changed ? { ...prev, clips } : prev;
        });
      } catch (e) { if (alive) setError(`Could not check saved render files: ${String(e)}`); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [renderedPaths, loaded]);
  function applyDefaults(onlySelected = false) {
    setProject((prev) => ({
      ...prev,
        clips: prev.clips.map((c) => (onlySelected ? c.id === selected : c.include) ? editClip(c, {
        stabilization: prev.defaultStabilization,
        stabilizationMethod: prev.defaultStabilizationMethod,
        customStabilization: { ...prev.defaultCustomStabilization },
        reviewed: false,
        }) : c),
    }));
    setMessage(`Project stabilisation applied to ${onlySelected ? "the selected clip" : "included clips"}. Review approval has been reset for those clips.`);
  }
  function replay(id: string, p: Partial<StudioReplay>) {
    if (clip)
      edit(clip.id, { replays: clip.replays.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    await action(async () => {
      const stagingDir = await stagingFolder();
      const paths = await open({
        multiple: true,
        defaultPath: stagingDir,
        filters: [{ name: "MP4 clips", extensions: ["mp4"] }],
      });
      if (!paths) return;
      const info = await invoke<{ path: string; duration: number }[]>("studio_inspect", {
        stagingDir,
        paths: Array.isArray(paths) ? paths : [paths],
      });
      const priorPaths = new Set(project.clips.map((c) => c.path.toLowerCase()));
      const addedPaths = new Set(info.map((c) => c.path.toLowerCase()).filter((path) => !priorPaths.has(path)));
      setProject((prev) => {
        const known = new Set(prev.clips.map((c) => c.path.toLowerCase()));
        const added = info
          .filter((c) => {
            const key = c.path.toLowerCase();
            if (known.has(key)) return false;
            known.add(key);
            return true;
          })
          .map((c) => ({
            id: crypto.randomUUID(),
            ...c,
            include: true,
            chapter: clipName(c.path),
            title: "",
            titleSeconds: 4,
            stabilization: prev.defaultStabilization,
            stabilizationMethod: prev.defaultStabilizationMethod,
            customStabilization: { ...prev.defaultCustomStabilization },
            framing: "edgeSafe" as const,
            reviewed: false,
            windReduction: "inherit" as const,
            notes: "",
            replays: [],
          }));
        return {
          ...prev,
          clips: [...prev.clips, ...added],
          outputDir: prev.outputDir || stagingDir,
        };
      });
      setMessage(`${addedPaths.size} new clip(s) added. Existing clip renders are preserved; earlier exports and saved jobs have not been updated. Review the new clips, then create an updated final video from the current sequence.`);
    });
  }
  async function saveProject() {
    await action(async () => {
      const path = await save({
        defaultPath: `video-studio-${Date.now()}.json`,
        filters: [{ name: "Studio project", extensions: ["json"] }],
      });
      if (path) {
        await invoke("studio_save_project", { path, project });
        setMessage("Project snapshot saved; earlier snapshots are preserved.");
      }
    });
  }
  async function loadProject() {
    await action(async () => {
      const path = await open({ filters: [{ name: "Studio project", extensions: ["json"] }] });
      if (typeof path === "string") {
        const p = await invoke<StudioProject>("studio_load_project", { path });
        projectEpoch.current++;
        setProject(normalizeProject(p));
        setSelected(p.clips[0]?.id || "");
      }
    });
  }
  async function outputFolder() {
    const path = await open({ directory: true, defaultPath: project.outputDir || undefined });
    if (typeof path === "string") patch({ outputDir: path });
  }
  function move(delta: number) {
    if (!clip) return;
    setProject((previous) => moveClip(previous, clip.id, delta));
  }
  function focusReview() {
    window.requestAnimationFrame(() => {
      const heading = document.getElementById("studio-review-heading");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  }
  function selectClip(id: string) {
    setSelected(id);
    if (window.matchMedia("(max-width: 1099px)").matches) focusReview();
  }
  function approveNext() {
    if (!clip) return;
    const result = approveAndNext(project, clip.id);
    setProject(result.project);
    if (result.nextClipId) {
      setEditorTab("picture");
      setSelected(result.nextClipId);
      setMessage("Clip approved. Continue with the next included clip needing review.");
      focusReview();
    } else setMessage("All included clips are approved. Arrange the sequence, then finish & export.");
  }
  async function queueClip(candidate: StudioClip, stagingDir: string) {
    return invoke<string>("studio_start_render", {
      project, stagingDir, preview: false, renderKind: "clip", clipId: candidate.id, assembleOnly: false,
    });
  }
  async function renderPending() {
    await action(async () => {
      const stagingDir = await stagingFolder();
      const pending = project.clips.filter((c) => c.include && c.reviewed && !isClipReady(c, project) && !clipJob(c, project, jobs));
      let queued = 0;
      try {
        for (const candidate of pending) { await queueClip(candidate, stagingDir); queued++; }
      } finally { setMessage(`${queued} clip render(s) queued. Completed work is saved for reuse after restart.`); }
    });
  }
  async function render(preview: boolean, r?: StudioReplay, clipOnly = false) {
    await action(async () => {
      const stagingDir = await stagingFolder();
      if (clipOnly) {
        if (!clip?.reviewed) throw new Error("Review this clip before rendering.");
        await queueClip(clip, stagingDir);
        setMessage(`Rendering ${clip.chapter} at ${outputLabel(project)}. Follow progress in Jobs.`);
        return;
      }
      let p = project;
      let previewStart: number | null = null, previewLength: number | null = null;
      if (preview) {
        if (!clip) throw new Error("Select a clip to preview.");
        const c = { ...clip, include: true, replays: [] as StudioReplay[] };
        if (r) {
          previewStart = r.start; previewLength = Math.min(60, r.end - r.start);
          c.replays = [{ ...r, start: 0, end: previewLength, enabled: true }];
        }
        p = { ...project, title: "", titleSeconds: 0, clips: [c], music: { ...project.music, enabled: false } };
      }
      await invoke<string>("studio_start_render", {
        project: p, stagingDir, preview, previewStart, previewLength,
        renderKind: preview ? "preview" : "project", clipId: null, assembleOnly: false,
      });
      setMessage(preview ? "720p preview queued; full renders use your output settings."
        : `Final video queued with ${p.clips.filter((c) => c.include).length} included clips. This saved request will not change if you edit the project. Matching clips will be reused, pending clips rendered, then the video assembled.`);
    });
  }
  async function contactSheet() {
    if (!clip) return;
    const token = ++request.current;
    setFrameBusy(true);
    setFrames([]);
    setError("");
    try {
      const stagingDir = await stagingFolder();
      for (let i = 0; i < 8; i++) {
        const at = Math.max(0, Math.min(clip.duration - 0.02, (clip.duration * (i + 0.5)) / 8));
        const data = await invoke<string>("studio_frame", {
          stagingDir,
          path: clip.path,
          at,
        });
        if (token !== request.current) return;
        setFrames((f) => [...f, { at, data }]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setFrameBusy(false);
    }
  }
  const included = project.clips.filter((c) => c.include),
    approved = included.every((c) => c.reviewed);
  const visibleClips = project.clips.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) =>
    (!search.trim() || `${candidate.chapter} ${clipName(candidate.path)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    && (clipFilter === "all" || clipFilter === "included" && candidate.include || clipFilter === "excluded" && !candidate.include || clipFilter === "review" && candidate.include && !candidate.reviewed || clipFilter === "render" && candidate.include && !isClipReady(candidate, project) || clipFilter === "ready" && isClipReady(candidate, project)));
  const editorTabs = ["picture", "titles", "replays", "notes", "sound"];
  const readyCount = included.filter((c) => isClipReady(c, project)).length;
  const reviewedCount = included.filter((c) => c.reviewed).length;
  const pendingCount = included.filter((c) => c.reviewed && !isClipReady(c, project) && !clipJob(c, project, jobs)).length;
  const activeClipJob = clip ? clipJob(clip, project, jobs) : undefined;
  const musicReady = !project.music.enabled || !!project.music.audioPath;
  const activeFinals = jobs.filter((j) => ["project", "assembly"].includes(j.kind || "") && ["queued", "running", "paused"].includes(j.status));
  const finalBusy = activeFinals.some((j) => sequenceStatus(j, project) === "current");
  const olderActiveFinal = activeFinals.find((j) => sequenceStatus(j, project) !== "current" && j.targets?.some((t) => included.some((c) => c.id === t.clipId)));
  const formatValid = Number.isInteger(project.bitrateMbps) && project.bitrateMbps >= 1 && project.bitrateMbps <= 150;
  const finalBlocked = !included.length ? "Add clips to begin." : !approved ? "Review the included clips before creating the video." : !project.outputDir ? "Choose an output folder." : !formatValid ? "Set bitrate between 1 and 150 Mbps." : !musicReady ? "Choose a music file or turn background music off." : "";
  if (!loaded) return <p className="p-6 text-gray-400">Loading Video Studio project…</p>;
  return (
    <div className={`studio-editor density-${density} text-gray-200`}>
      <header className="studio-header studio-toolbar">
        <div>
          <h1 className="font-semibold text-white">Video Studio</h1>
          <p className="studio-project-name" title={project.name}>{project.name} · {reviewedCount}/{included.length} approved · {timecode(projectDuration(project))}</p>
        </div>
        <div className="studio-toolbar-actions">
          <label className="studio-density">Density<select aria-label="Studio density" value={density} onChange={(event) => setDensity(event.target.value as "compact" | "comfortable")}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                if (
                  await confirm("Start a new project? Save a snapshot first to keep this edit.")
                ) {
                  setProject(newProject());
                  projectEpoch.current++;
                  setSelected("");
                }
              })
            }
          >
            New
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void loadProject()}>
            Open project
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void saveProject()}>
            Save snapshot
          </button>
        </div>
      </header>
      <nav className="studio-workflow" aria-label="Video editing workflow">
        <a href="#studio-sequence">Sequence <span>{included.length}</span></a>
        <a href="#studio-review">Review <span>{reviewedCount}/{included.length}</span></a>
        <a href="#studio-finish" onClick={() => setFinishOpen(true)}>Finish & export <span>{project.height}p</span></a>
        <span className="studio-autosave">{autosaveOk ? "Autosaved locally" : "Autosave unavailable — save a snapshot"} · {readyCount} reusable renders</span>
      </nav>
      {(error || message) && (
        <p role={error ? "alert" : "status"} className={error ? "text-red-400" : "text-green-400"}>
          {error || message}
        </p>
      )}
      <div className="studio-workspace">
        <section id="studio-sequence" className="studio-sequence bg-surface-800 rounded-xl p-4 space-y-3" aria-labelledby="studio-sequence-heading">
          <div className="flex flex-wrap justify-between gap-2">
            <div><h2 id="studio-sequence-heading" className="font-semibold">Sequence</h2><p className="text-xs text-gray-400">{included.length} included · {readyCount} ready</p></div>
            <button className="btn-primary" disabled={busy} onClick={() => void add()}>
              Add clips
            </button>
          </div>
          <div className="studio-sequence-tools">
            <input type="search" aria-label="Search clips" placeholder="Search clips…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <select aria-label="Filter clips" value={clipFilter} onChange={(event) => setClipFilter(event.target.value)}><option value="all">All clips</option><option value="review">Needs review</option><option value="render">Needs rendering</option><option value="excluded">Excluded</option><option value="included">Included</option><option value="ready">Ready</option></select>
          </div>
          <button
            className="btn-secondary studio-sort"
            onClick={() =>
              patch({ clips: [...project.clips].sort((a, b) => a.path.localeCompare(b.path)) })
            }
          >
            Sort by filename
          </button>
          <p className="text-xs text-gray-400">Untick to exclude; originals are kept. {visibleClips.length}/{project.clips.length} shown.</p>
          <button className="btn-primary w-full" disabled={busy || !pendingCount || !project.outputDir || !formatValid} onClick={() => void renderPending()}>
            Render pending clips ({pendingCount})
          </button>

          {!project.clips.length && <div className="rounded-lg border border-dashed border-surface-500 p-6 text-center text-sm text-gray-400">Add your source clips, then select one to review its title, stabilisation and replays.</div>}
          {!!project.clips.length && !visibleClips.length && <p className="text-gray-400">No matching clips. <button className="underline" onClick={() => { setSearch(""); setClipFilter("all"); }}>Clear filters</button></p>}
          <div className="studio-sequence-list" role="region" aria-label="Clip sequence" tabIndex={0}>
            {visibleClips.map(({ candidate: c, index }) => (
              <div
                key={c.id}
                className={`studio-sequence-row ${c.id === selected ? "is-selected bg-cyan-900" : "bg-surface-900"} ${c.include ? "" : "is-excluded"}`}
              >
                <label className="studio-include-target">
                <input
                  type="checkbox"
                  aria-label={`Include ${clipName(c.path)}`}
                  checked={c.include}
                  onChange={(e) => edit(c.id, { include: e.target.checked })}
                />
                </label>
                <button className="studio-clip-select text-left min-w-0" title={`${c.chapter || clipName(c.path)} · ${clipName(c.path)} · ${clipStatus(c, project, jobs)}`} aria-current={c.id === selected ? "true" : undefined} onClick={() => selectClip(c.id)}>
                  <span className="block truncate text-sm font-medium">{String(index + 1).padStart(2, "0")} · {c.chapter || clipName(c.path)}</span>
                  <small>
                    {timecode(c.duration)} · {c.include ? clipStatus(c, project, jobs) : "Excluded"}
                  </small>
                </button>
                <div className="studio-row-approval"><StudioApprovalButton approved={c.reviewed} name={c.chapter || clipName(c.path)} onChange={(reviewed) => edit(c.id, { reviewed })} /></div>
              </div>
            ))}
          </div>
        </section>
        <section id="studio-review" className="studio-review bg-surface-800 rounded-xl p-4 space-y-4" aria-labelledby="studio-review-heading">
          {!clip ? (
            <div><h2 id="studio-review-heading" tabIndex={-1} className="text-lg font-semibold">Review your footage</h2><p className="mt-2 text-gray-400">Select a clip to review its titles, stabilisation and replays.</p></div>
          ) : (
            <>
              <div className="studio-review-heading flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0"><p className="text-xs tracking-widest uppercase text-cyan-300 mb-1">Clip {project.clips.findIndex((c) => c.id === clip.id) + 1} / {project.clips.length}</p><h2 id="studio-review-heading" tabIndex={-1} className="font-semibold break-words">{clip.chapter || clipName(clip.path)}</h2><p className="text-xs text-gray-400 break-all">{clipName(clip.path)} · {timecode(clip.duration)}{!clip.include && " · Excluded from the final cut"}</p></div>
                <div className="flex flex-wrap items-center gap-2"><StudioApprovalButton approved={clip.reviewed} name={clip.chapter || clipName(clip.path)} onChange={(reviewed) => edit(clip.id, { reviewed })} />
                <button className="btn-primary" disabled={!clip.include} onClick={approveNext}>Approve & next</button></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-secondary"
                  onClick={() =>
                    void invoke("open_in_default_app", { path: clip.path }).catch((e) =>
                      setError(String(e))
                    )
                  }
                >
                  Play full original
                </button>
                {clip.rendered && (
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      void invoke("open_in_default_app", { path: clip.rendered!.path }).catch((e) =>
                        setError(String(e))
                      )
                    }
                  >
                    Play rendered clip
                  </button>
                )}
                <button
                  className="btn-secondary"
                  disabled={frameBusy}
                  onClick={() => void contactSheet()}
                >
                  {frameBusy ? "Sampling…" : "Generate review frames"}
                </button>
                <button className="btn-secondary" disabled={project.clips[0]?.id === clip.id} onClick={() => move(-1)}>
                  Move up
                </button>
                <button className="btn-secondary" disabled={project.clips[project.clips.length - 1]?.id === clip.id} onClick={() => move(1)}>
                  Move down
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    patch({ clips: project.clips.filter((c) => c.id !== clip.id) });
                    setSelected("");
                  }}
                >
                  Remove from project
                </button>
              </div>
              {!frames.length && <div className="studio-preview-empty"><span>Picture review</span><p>Generate sample frames or play the original to check framing and movement.</p></div>}
              {!!frames.length && (
                <>
                  <div className="studio-contact-sheet grid grid-cols-2 md:grid-cols-4 gap-2">
                    {frames.map((f) => (
                      <figure key={f.at}>
                        <img
                          src={`data:image/jpeg;base64,${f.data}`}
                          alt={`Source at ${timecode(f.at)}`}
                        />
                        <figcaption className="text-xs">{timecode(f.at)}</figcaption>
                      </figure>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400">
                    Sparse samples can miss brief drops. Check the original or a replay preview
                    before approving.
                  </p>
                </>
              )}
              <div className="studio-inspector-tabs" role="tablist" aria-label="Clip editing tools">
                {editorTabs.map((tab, index) => <button type="button" key={tab} id={`studio-tab-${tab}`} role="tab" aria-selected={editorTab === tab} aria-controls={`studio-panel-${tab}`} tabIndex={editorTab === tab ? 0 : -1} onClick={() => setEditorTab(tab)} onKeyDown={(event) => {
                  const next = event.key === "ArrowRight" ? (index + 1) % editorTabs.length : event.key === "ArrowLeft" ? (index + editorTabs.length - 1) % editorTabs.length : event.key === "Home" ? 0 : event.key === "End" ? editorTabs.length - 1 : -1;
                  if (next >= 0) { event.preventDefault(); setEditorTab(editorTabs[next]); document.getElementById(`studio-tab-${editorTabs[next]}`)?.focus(); }
                }}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
              </div>
              <div id="studio-panel-picture" className="studio-property-panel" role="tabpanel" aria-labelledby="studio-tab-picture" hidden={editorTab !== "picture"}>
              <div className="grid md:grid-cols-2 gap-3">
                <label>
                  Stabiliser for this clip
                  <select aria-label="Stabiliser for this clip" className={input} value={clip.stabilizationMethod} onChange={(e) => edit(clip.id, {
                    stabilizationMethod: e.target.value as StudioClip["stabilizationMethod"],
                    ...(e.target.value === "quality" && clip.stabilization === "custom" ? { stabilization: "balanced" as const } : {}),
                  })}>
                    <option value="fast">Fast — one pass</option>
                    <option value="quality">Quality — two passes</option>
                  </select>
                </label>
                <label>
                  Stabilisation preset
                  <select
                    className={input}
                    aria-label="Stabilisation preset"
                    value={clip.stabilization}
                    onChange={(e) =>
                      edit(clip.id, {
                        stabilization: e.target.value as StudioClip["stabilization"],
                      })
                    }
                  >
                    <option value="off">Off</option>
                    <option value="gentle">Gentle — tracking pans</option>
                    <option value="balanced">Balanced</option>
                    <option value="strong">Strong</option>
                    {clip.stabilizationMethod === "fast" && <option value="custom">Custom</option>}
                  </select>
                </label>
                <label>
                  Framing
                  <select
                    className={input}
                    value={clip.framing}
                    onChange={(e) =>
                      edit(clip.id, { framing: e.target.value as StudioClip["framing"] })
                    }
                  >
                    <option value="edgeSafe">{clip.stabilizationMethod === "fast" ? "Mirror edges + 4% crop" : "Edge-safe automatic zoom"}</option>
                    <option value="maxFrame">{clip.stabilizationMethod === "fast" ? "Mirror edges — no crop" : "Maximum frame — borders may show"}</option>
                    <option value="aggressiveCrop">{clip.stabilizationMethod === "fast" ? "Mirror edges + 10% crop" : "More crop"}</option>
                  </select>
                </label>
              </div>
              {clip.stabilization === "custom" && <StudioStabilizationFields key={clip.id} value={clip.customStabilization} onChange={(customStabilization) => edit(clip.id, { customStabilization })} />}
              <p className="text-xs text-gray-400">
                {clip.stabilizationMethod === "fast"
                  ? "Fast mode corrects movement in one pass and mirrors moving edges. Fixed crop reduces edge artifacts but cannot guarantee they disappear, and can cut off subjects. Preview pans and rider framing before approving."
                  : "Quality mode analyses movement before rendering. Automatic zoom is not a fixed crop limit; compare previews for rider framing."}
                {" "}Stabilisation precedes titles and recaps. Changing a clip’s settings resets its review approval.
              </p>

              </div>
              <div id="studio-panel-titles" className="studio-property-panel" role="tabpanel" aria-labelledby="studio-tab-titles" hidden={editorTab !== "titles"}>
              <div className="grid md:grid-cols-2 gap-3">
                <label>
                  Segment / chapter name
                  <input
                    className={input}
                    value={clip.chapter}
                    onChange={(e) => edit(clip.id, { chapter: e.target.value })}
                  />
                </label>
                <label>
                  Clip title (blank = hidden)
                  <input
                    className={input}
                    maxLength={100}
                    value={clip.title}
                    onChange={(e) => edit(clip.id, { title: e.target.value })}
                  />
                </label>
                <label>
                  Clip title seconds
                  <input
                    className={input}
                    type="number"
                    min="0"
                    max="30"
                    value={clip.titleSeconds}
                    onChange={(e) => edit(clip.id, { titleSeconds: Number(e.target.value) })}
                  />
                </label>
</div>
              </div>
              <div id="studio-panel-replays" className="studio-property-panel" role="tabpanel" aria-labelledby="studio-tab-replays" hidden={editorTab !== "replays"}>
              <div className="flex justify-between">
                <h3 className="font-semibold">Recaps after this full clip</h3>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    edit(clip.id, {
                      replays: [
                        ...clip.replays,
                        {
                          id: crypto.randomUUID(),
                          start: 0,
                          end: Math.min(6, clip.duration),
                          speed: 0.5,
                          caption: "Technique review",
                          enabled: true,
                        },
                      ],
                    })
                  }
                >
                  Add replay
                </button>
              </div>
              {clip.replays.map((r) => (
                <div key={r.id} className="bg-surface-900 rounded p-3 space-y-2">
                  <label className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => replay(r.id, { enabled: e.target.checked })}
                    />
                    Include recap
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label>
                      Start seconds
                      <input
                        className={input}
                        type="number"
                        step="0.02"
                        min="0"
                        max={clip.duration}
                        value={r.start}
                        onChange={(e) => replay(r.id, { start: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      End seconds
                      <input
                        className={input}
                        type="number"
                        step="0.02"
                        min="0"
                        max={clip.duration}
                        value={r.end}
                        onChange={(e) => replay(r.id, { end: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Speed
                      <select
                        className={input}
                        value={r.speed}
                        onChange={(e) => replay(r.id, { speed: Number(e.target.value) })}
                      >
                        <option value={0.25}>25%</option>
                        <option value={0.5}>50%</option>
                        <option value={1}>100%</option>
                      </select>
                    </label>
                  </div>
                  <label className="block">
                    Replay caption
                    <input
                      className={input}
                      maxLength={100}
                      value={r.caption}
                      onChange={(e) => replay(r.id, { caption: e.target.value })}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() => void render(true, r)}
                    >
                      Preview this moment (up to 60s source)
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() =>
                        edit(clip.id, { replays: clip.replays.filter((x) => x.id !== r.id) })
                      }
                    >
                      Remove recap
                    </button>
                  </div>
                </div>
              ))}

              </div>
              <div id="studio-panel-notes" className="studio-property-panel" role="tabpanel" aria-labelledby="studio-tab-notes" hidden={editorTab !== "notes"}>
              <StudioAiReview
                clip={clip}
                team={project.team}
                frames={frames}
                onReplay={(r) => edit(clip.id, { replays: [...clip.replays, r] })}
                onNotes={(s) => edit(clip.id, { notes: clip.notes ? `${clip.notes}\n\n${s}` : s })}
              />
              <label className="block">
                Review notes
                <textarea
                  className={input}
                  value={clip.notes}
                  onChange={(e) => edit(clip.id, { notes: e.target.value })}
                />
              </label>

              </div>
              <div id="studio-panel-sound" className="studio-property-panel" role="tabpanel" aria-labelledby="studio-tab-sound" hidden={editorTab !== "sound"}>
              <StudioAudioControls project={project} clip={clip} stagingDir={stagingFolder} onProjectChange={patch} onClipChange={(change) => edit(clip.id, change)} disabled={busy} />
      <details className="rounded-xl bg-surface-800 p-4">
        <summary className="cursor-pointer font-semibold"><span className="text-xs uppercase tracking-widest text-cyan-300 mr-3">03 / Sound</span>Optional background music <span className="text-gray-400 font-normal">· {project.music.enabled ? project.music.audioPath ? "Ready to mix" : "Audio file needed" : "Off — no background music"}</span></summary>
      <StudioBackgroundMusic
        project={project}
        jobs={jobs}
        onChange={(music: Partial<BackgroundMusic>) => {
          if (projectEpoch.current === currentEpoch) setProject((prev) => ({ ...prev, music: { ...prev.music, ...music } }));
        }}
        busy={busy}
        onError={setError}
        onMessage={setMessage}
        getStagingDir={stagingFolder}
      />
      </details>

              </div>
              <div className="flex flex-wrap gap-3 items-center">
                <button className="btn-secondary" disabled={busy} onClick={() => void render(true)}>
                  Quick preview · 720p / first 12s
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy || !clip.reviewed || !project.outputDir || !formatValid || !!activeClipJob}
                  onClick={() => void render(false, undefined, true)}
                >
                  {activeClipJob ? "Clip queued / rendering" : `Render clip · ${project.height}p / ${project.fps} fps / ${project.bitrateMbps} Mbps`}
                </button>
                {clip.rendered && (
                  <span className={`text-xs ${isClipReady(clip, project) ? "text-emerald-300" : "text-amber-200"}`}>
                    {isClipReady(clip, project) ? "Ready" : "Previous render · outdated"} · {clip.rendered.width}×{clip.rendered.height} · {clip.rendered.fps} fps
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400">{!clip.reviewed ? "Check the titles, framing and replay ranges, then choose Needs review to approve, or Approve & next to continue." : "Approved for rendering. Changing clip titles, stabilisation or replays will return it to Needs review."}</p>
            </>
          )}
        </section>
      <aside className="studio-project-settings" aria-label="Project settings"><h2 className="studio-panel-heading">Project settings</h2>
      <details className="bg-surface-800 rounded-xl p-4">
        <summary className="cursor-pointer font-semibold">Output settings <span className="text-gray-400 font-normal">· {outputLabel(project)}</span></summary>
        <div className="mt-4"><StudioOutputSettings project={project} onChange={patch} onFolder={() => void action(outputFolder)} /></div>
      </details>
      <details className="bg-surface-800 rounded-xl p-4">
        <summary className="cursor-pointer font-semibold">Project details & opening title <span className="text-gray-400 font-normal">· {project.name}</span></summary>
        <section className="mt-4 grid md:grid-cols-2 gap-4">
        <label>
          Project name
          <input
            className={input}
            maxLength={200}
            value={project.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <label>
          Opening title style
          <select className={input} value={project.openingTitleMode} onChange={(e) => patch({ openingTitleMode: e.target.value as StudioProject["openingTitleMode"] })}>
            <option value="card">Separate title card</option>
            <option value="overlay">Overlay on first video</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          Team description
          <input
            className={input}
            value={project.team}
            onChange={(e) => patch({ team: e.target.value })}
            placeholder="Navy/white jerseys; yellow helmet covers in afternoon"
          />
        </label>
        <label>
          Opening title
          <input
            className={input}
            maxLength={70}
            value={project.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <label>
          Subtitle / event date
          <input
            className={input}
            maxLength={110}
            value={project.subtitle}
            onChange={(e) => patch({ subtitle: e.target.value })}
          />
        </label>
        <label>
          Opening title duration · seconds (0 = hidden)
          <input
            className={input}
            type="number"
            min="0"
            max="30"
            step="0.5"
            value={project.titleSeconds}
            onChange={(e) => patch({ titleSeconds: Number(e.target.value) })}
          />
        </label>
        <div
          className="rounded p-4 bg-[#0c1930] text-white self-center"
          aria-label="Opening title layout preview"
        >
          <p className="text-xl break-words">{project.openingTitleMode === "none" || !project.titleSeconds ? "Title hidden" : project.title || "Title hidden"}</p>
          {project.openingTitleMode !== "none" && !!project.title && !!project.titleSeconds && <p className="text-sm mt-3 break-words">{project.subtitle}</p>}
          <small className="text-gray-400">
            Layout sketch only · opening titles are applied at final assembly, not in clip previews.
          </small>
        </div>
        <p className="md:col-span-2 text-sm text-cyan-200">{project.openingTitleMode === "overlay"
          ? `Overlay follows the first included clip (${included[0]?.chapter || "add a clip to begin"}). Reordering or editing this opening title preserves your reusable clip renders. The overlay ends within that first clip.`
          : project.openingTitleMode === "card" ? "A separate title card precedes your sequence at final assembly. Changing this title preserves reusable clip renders."
          : "No opening title is added. Individual clip titles are unchanged."}</p>
      </section>
      </details>
      <details className="bg-surface-800 rounded-lg p-4 space-y-3">
        <summary className="cursor-pointer font-semibold">Stabilisation defaults & performance <span className="text-gray-400 font-normal">· {project.defaultStabilization} / {project.defaultStabilizationMethod}</span></summary>
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
          <label>
            Stabiliser
            <select className={input} value={project.defaultStabilizationMethod} onChange={(e) => patch({
              defaultStabilizationMethod: e.target.value as StudioProject["defaultStabilizationMethod"],
              ...(e.target.value === "quality" && project.defaultStabilization === "custom" ? { defaultStabilization: "balanced" as const } : {}),
            })}>
              <option value="fast">Fast — one pass</option>
              <option value="quality">Quality — two passes</option>
            </select>
          </label>
          <label>
            Default preset
            <select className={input} value={project.defaultStabilization} onChange={(e) => patch({ defaultStabilization: e.target.value as StudioProject["defaultStabilization"] })}>
              <option value="off">Off</option>
              <option value="gentle">Gentle — tracking pans</option>
              <option value="balanced">Balanced</option>
              <option value="strong">Strong</option>
              {project.defaultStabilizationMethod === "fast" && <option value="custom">Custom</option>}
            </select>
          </label>
          <label>
            Hardware use
            <select className={input} value={project.performance} onChange={(e) => patch({ performance: e.target.value as StudioProject["performance"] })}>
              <option value="max">Maximum throughput</option>
              <option value="balanced">Balanced — more room for other apps</option>
            </select>
          </label>
          <label>
            Encoder
            <select aria-label="Encoder" className={input} value={project.encoderPreference} onChange={(e) => patch({ encoderPreference: e.target.value as StudioProject["encoderPreference"] })}>
              <option value="auto">Automatic — NVIDIA, Intel, then CPU</option>
              <option value="cpu">CPU — compatibility fallback</option>
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={project.adaptiveScheduling}
            onChange={(e) => patch({ adaptiveScheduling: e.target.checked })}
            aria-describedby="studio-adaptive-help"
          />
          <span>
            Adaptive scheduling
            <span id="studio-adaptive-help" className="block text-xs text-gray-400">
              Adjusts future task launches and thread allocations using measured load and available memory.
              Preserves video quality and lets active steps finish. Off uses fixed safety limits.
              This setting applies to new previews and renders; already queued work keeps its settings.
            </span>
          </span>
        </label>
        {project.defaultStabilization === "custom" && <StudioStabilizationFields value={project.defaultCustomStabilization} onChange={(defaultCustomStabilization) => patch({ defaultCustomStabilization })} />}
        <p className="text-sm text-gray-400">
          Fast stabilisation estimates movement while rendering, with no separate shake-analysis pass.
          Quality uses two passes and takes longer. Defaults apply to newly added clips; existing clips keep their settings until you apply them below.
        </p>
        <p className="text-xs text-gray-400">
          {project.encoderPreference === "cpu"
            ? "CPU encoding is selected for this project. Change Encoder above to use available hardware."
            : "Hardware encoding is selected automatically: NVIDIA when available, then Intel, then CPU."}{" "}
          Parallel work is bounded by CPU, memory and hardware capacity; utilisation varies with the footage and filters.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <button className="btn-secondary" disabled={!included.length || busy} onClick={() => applyDefaults()}>Apply to {included.length} included clip(s)</button>
          <button className="btn-secondary" disabled={!clip || busy} onClick={() => applyDefaults(true)}>Apply to selected clip</button>
          <span className="text-xs text-amber-200">Applying defaults resets the affected clips’ review approval.</span>
        </div>
      </details>
      </aside>
      </div>
      <details className="studio-export-panel" open={finishOpen} onToggle={(event) => setFinishOpen(event.currentTarget.open)}><summary className="studio-panel-heading">Finish & export · {included.length} clips · {readyCount} ready</summary>
      <section id="studio-finish" className="studio-finish rounded-xl border border-cyan-800/60 bg-gradient-to-br from-surface-800 to-[#0c1930] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs uppercase tracking-widest text-cyan-300 mb-1">03 / Finish & export</p><h2 className="text-xl font-semibold text-white">Bring it all together</h2></div>
          <span className="rounded-full bg-surface-900 px-3 py-1 text-sm">{readyCount} / {included.length} clips ready</span>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg bg-surface-900 p-3"><p className="text-gray-400 text-xs mb-1">OUTPUT</p>{outputLabel(project)}</div>
          <div className="rounded-lg bg-surface-900 p-3"><p className="text-gray-400 text-xs mb-1">DURATION / ESTIMATED SIZE</p>{timecode(projectDuration(project))} · ~{((projectDuration(project) * (project.bitrateMbps + 0.192)) / 8 / 1000).toFixed(2)} GB</div>
          <div className="rounded-lg bg-surface-900 p-3"><p className="text-gray-400 text-xs mb-1">SOUND</p>{project.music.enabled ? "Original sound + background music" : "Original clip sound"}</div>
        </div>
        <p className="text-sm text-gray-300">The video follows your clip order, with each clip's titles and replays. Matching renders are reused; remaining clips are prepared automatically before assembly.</p>
        <p className="text-sm text-cyan-200">Current sequence: {included.length} included · {reviewedCount} approved · {readyCount} reusable renders · {included.length - readyCount} to prepare. New exports need their own disk space; the previous video is kept.</p>
        {olderActiveFinal && <p role="status" className="text-sm text-amber-200">A saved {sequenceClipCount(olderActiveFinal) ?? "unknown"}-clip render is still active and will not pick up these edits. You can queue the current sequence separately; existing work will not be cancelled.</p>}
        <p className="text-sm text-cyan-200">Opening title: {project.openingTitleMode === "none" || !project.title || !project.titleSeconds ? "None" : project.openingTitleMode === "overlay" ? `Overlay on ${included[0]?.chapter || "the first included clip"} at final assembly` : "Separate title card"}. Chapter timings are generated from the finished export.</p>
        {finalBlocked && <p role="status" className="text-sm text-amber-200">{finalBlocked}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={busy || !!finalBlocked || finalBusy} onClick={() => void render(false)}>
            {finalBusy ? `Current ${included.length}-clip video queued / rendering` : `Create updated final video — ${included.length} clips`}
          </button>
          <button className="btn-secondary" onClick={onOpenJobs}>View render queue</button>
        </div>
        <p className="text-xs text-gray-400">This button always uses the current sequence. Resume saved render in Jobs continues that job's original clip list, not later additions. Projects autosave locally. Each export creates a new file; no cache clearing is needed.</p>
      </section>
      <StudioExportDescription jobs={jobs} project={project} />
      </details>
      <details className="studio-queue-details"><summary className="studio-panel-heading">Studio jobs & recovery</summary><StudioJobs /></details>

    </div>
  );
}
