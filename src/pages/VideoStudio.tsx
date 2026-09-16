import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../types";
import StudioJobs from "../components/StudioJobs";
import StudioAiReview from "../components/StudioAiReview";
import { clipName, newProject, projectDuration, timecode } from "../types/videoStudio";
import type { StudioClip, StudioProject, StudioReplay } from "../types/videoStudio";

const KEY = "photogogo.videoStudio.project.v1";
const input = "bg-surface-900 rounded border border-surface-600 px-3 py-2 w-full text-sm";
async function stagingFolder() {
  const settings = await invoke<Settings>("load_settings");
  if (!settings.staging_dir) throw new Error("Configure a staging folder in Settings first.");
  return settings.staging_dir;
}
export default function VideoStudio({ onOpenJobs }: { onOpenJobs: () => void }) {
  const [project, setProject] = useState<StudioProject>(newProject);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [frames, setFrames] = useState<{ at: number; data: string }[]>([]);
  const [frameBusy, setFrameBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const p = JSON.parse(raw);
          await invoke("studio_validate_project", { project: p });
          if (alive) setProject(p);
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
      } catch {
        setError("Autosave failed. Save a snapshot before closing.");
      }
    }
  }, [project, loaded]);
  const clip = project.clips.find((c) => c.id === selected);
  useEffect(() => {
    request.current++;
    setFrames([]);
  }, [clip?.id, clip?.path]);
  function patch(p: Partial<StudioProject>) {
    setProject((prev) => ({ ...prev, ...p }));
  }
  function edit(id: string, p: Partial<StudioClip>) {
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((c) =>
        c.id === id ? { ...c, ...p, reviewed: p.reviewed ?? false } : c
      ),
    }));
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
            stabilization: "off" as const,
            framing: "edgeSafe" as const,
            reviewed: false,
            notes: "",
            replays: [],
          }));
        return {
          ...prev,
          clips: [...prev.clips, ...added],
          outputDir: prev.outputDir || stagingDir,
        };
      });
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
        setProject(p);
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
    const clips = [...project.clips],
      i = clips.findIndex((c) => c.id === clip.id),
      j = i + delta;
    if (j < 0 || j >= clips.length) return;
    [clips[i], clips[j]] = [clips[j], clips[i]];
    patch({ clips });
  }
  async function render(preview: boolean, r?: StudioReplay, fragmentOnly = false) {
    await action(async () => {
      const stagingDir = await stagingFolder();
      let p = project,
        previewStart: number | null = null,
        previewLength: number | null = null;
      if (fragmentOnly) {
        if (!clip || !clip.reviewed) throw new Error("Review and approve this clip first.");
        p = {
          ...project,
          title: "",
          subtitle: "",
          titleSeconds: 0,
          clips: [{ ...clip, include: true, title: "", replays: [] }],
        };
      }
      if (preview) {
        if (!clip) throw new Error("Select a clip to preview.");
        const c = { ...clip, include: true };
        if (r) {
          previewStart = r.start;
          previewLength = Math.min(60, r.end - r.start);
          c.replays = [{ ...r, start: 0, end: previewLength, enabled: true }];
          p = { ...project, title: "", titleSeconds: 0, clips: [c] };
        } else p = { ...project, clips: [{ ...c, replays: c.replays.filter((r) => r.end <= 12) }] };
      } else if (
        !(await confirm(
          "Render this approved project? A new folder will be created; previous videos will not be overwritten.",
          { title: "Final render", kind: "info" }
        ))
      )
        return;
      const id = await invoke<string>("studio_start_render", {
        project: p,
        stagingDir,
        preview,
        previewStart,
        previewLength,
      });
      setMessage(
        `Queued ${preview ? "preview" : "render"} ${id}. You may change pages; keep the app open.`
      );
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
  if (!loaded) return <p className="p-6 text-gray-400">Loading Video Studio project…</p>;
  return (
    <div className="p-6 space-y-5 text-gray-200">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Video Studio</h1>
          <p className="text-sm text-gray-400">
            Select → review → titles & replays → preview → render
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                if (
                  await confirm("Start a new project? Save a snapshot first to keep this edit.")
                ) {
                  setProject(newProject());
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
      {(error || message) && (
        <p role={error ? "alert" : "status"} className={error ? "text-red-400" : "text-green-400"}>
          {error || message}
        </p>
      )}
      <section className="bg-surface-800 rounded-lg p-4 grid md:grid-cols-2 gap-4">
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
          Opening title duration (0 = hidden)
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
          <p className="text-xl break-words">{project.title || "Title hidden"}</p>
          <p className="text-sm mt-3 break-words">{project.subtitle}</p>
          <small className="text-gray-400">
            Layout sketch · render a preview to check final typography
          </small>
        </div>
      </section>
      <div className="grid xl:grid-cols-[minmax(260px,1fr)_minmax(400px,2fr)] gap-4">
        <section className="bg-surface-800 rounded-lg p-4 space-y-3">
          <div className="flex justify-between">
            <h2 className="font-semibold">Clips ({included.length} included)</h2>
            <button className="btn-primary" disabled={busy} onClick={() => void add()}>
              Add clips
            </button>
          </div>
          <button
            className="btn-secondary"
            onClick={() =>
              patch({ clips: [...project.clips].sort((a, b) => a.path.localeCompare(b.path)) })
            }
          >
            Sort by filename (timestamp names)
          </button>
          <p className="text-xs text-gray-400">
            Full clips are preserved. Untick to exclude; select a row to review. Edits autosave
            locally.
          </p>
          <div className="max-h-[650px] overflow-auto space-y-2">
            {project.clips.map((c) => (
              <div
                key={c.id}
                className={`rounded p-2 flex gap-2 ${c.id === selected ? "bg-cyan-900" : "bg-surface-900"}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Include ${clipName(c.path)}`}
                  checked={c.include}
                  onChange={(e) => edit(c.id, { include: e.target.checked })}
                />
                <button className="text-left flex-1 min-w-0" onClick={() => setSelected(c.id)}>
                  <span className="block truncate text-sm">{c.chapter}</span>
                  <small>
                    {timecode(c.duration)} · {c.reviewed ? "Approved" : "Needs review"} ·{" "}
                    {c.stabilization}
                  </small>
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="bg-surface-800 rounded-lg p-4 space-y-4">
          {!clip ? (
            <p>Select a clip to review its titles, stabilisation and replays.</p>
          ) : (
            <>
              <h2 className="font-semibold break-all">{clipName(clip.path)}</h2>
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
                <button
                  className="btn-secondary"
                  disabled={frameBusy}
                  onClick={() => void contactSheet()}
                >
                  {frameBusy ? "Sampling…" : "Generate review frames"}
                </button>
                <button className="btn-secondary" onClick={() => move(-1)}>
                  Move up
                </button>
                <button className="btn-secondary" onClick={() => move(1)}>
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
              {!!frames.length && (
                <>
                  <div className="grid grid-cols-4 gap-2">
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
              <div className="grid md:grid-cols-2 gap-3">
                <label>
                  Chapter name
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
                <label>
                  Stabilisation
                  <select
                    className={input}
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
                    <option value="edgeSafe">Edge-safe automatic zoom</option>
                    <option value="maxFrame">Maximum frame — borders may show</option>
                    <option value="aggressiveCrop">More crop</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-gray-400">
                Stabilisation precedes titles and recaps. Automatic zoom is not a fixed crop limit;
                compare previews for rider framing.
              </p>
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
                  <div className="flex gap-2">
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
              <div className="flex flex-wrap gap-3 items-center">
                <button className="btn-secondary" disabled={busy} onClick={() => void render(true)}>
                  Render clip preview (first 12s)
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy || !clip.reviewed || !project.outputDir}
                  onClick={() => void render(false, undefined, true)}
                >
                  Export this fragment only (no titles/recaps)
                </button>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={clip.reviewed}
                    onChange={(e) => edit(clip.id, { reviewed: e.target.checked })}
                  />
                  I reviewed this clip, titles and replay ranges
                </label>
              </div>
            </>
          )}
        </section>
      </div>
      <section className="bg-surface-800 rounded p-4 space-y-3">
        <h2 className="font-semibold">Export</h2>
        <div className="flex flex-wrap gap-3">
          <label>
            Resolution
            <select
              className={input}
              value={project.width}
              onChange={(e) => {
                const width = Number(e.target.value);
                patch({ width, height: width === 3840 ? 2160 : width === 1920 ? 1080 : 720 });
              }}
            >
              <option value={3840}>4K</option>
              <option value={1920}>1080p</option>
              <option value={1280}>720p</option>
            </select>
          </label>
          <label>
            Frame rate
            <select
              className={input}
              value={project.fps}
              onChange={(e) => patch({ fps: Number(e.target.value) })}
            >
              {[25, 30, 50, 60].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <button className="btn-secondary" onClick={() => void action(outputFolder)}>
            Choose output folder
          </button>
          <span className="self-center text-sm break-all">
            {project.outputDir || "No folder selected"}
          </span>
        </div>
        <p>
          Estimated duration: {timecode(projectDuration(project))} ·{" "}
          {included.filter((c) => c.reviewed).length}/{included.length} included clips approved
        </p>
        <p className="text-sm text-gray-400">
          Each render creates a new folder with video, project snapshot and verification record.
          Originals are untouched. Rendering needs temporary disk space and may take longer than
          playback at 4K.
        </p>
        <p className="text-sm text-cyan-200">
          Finished fragments are retained in <code>.photogogo-video-studio-cache</code>, grouped
          by resolution and frame rate. Unchanged source and edit settings are reused; only changed
          clips, titles, or recaps are rendered again.
        </p>
        <button
          className="btn-primary"
          disabled={busy || !included.length || !approved || !project.outputDir}
          onClick={() => void render(false)}
        >
          Approve and render new version
        </button>
      </section>
      <StudioJobs />
      <button className="btn-secondary" onClick={onOpenJobs}>
        Other application jobs
      </button>
    </div>
  );
}
