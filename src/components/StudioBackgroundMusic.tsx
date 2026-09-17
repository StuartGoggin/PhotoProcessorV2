import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import type { BackgroundMusic, MusicDirection, StudioProject, StudioJob } from "../types/videoStudio";

const field = "block w-full bg-surface-900 rounded border border-surface-600 px-3 py-2 text-sm";

export default function StudioBackgroundMusic({
  project,
  jobs,
  onChange,
  busy,
  onError,
  onMessage,
  getStagingDir,
}: {
  project: StudioProject;
  jobs: StudioJob[];
  onChange: (music: Partial<BackgroundMusic>) => void;
  busy: boolean;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
  getStagingDir: () => Promise<string>;
}) {
  const music = project.music;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-5.4");
  const [analysing, setAnalysing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const included = project.clips.filter((clip) => clip.include);
  const musicJob = jobs.find((j) => j.kind === "music" && j.musicRequestId === music.requestId && ["queued", "running"].includes(j.status));
  const patch = (change: Partial<BackgroundMusic>) => onChange(change);
  const patchDirection = (change: Partial<MusicDirection>) => {
    if (music.direction) patch({ direction: { ...music.direction, ...change }, requestId: "" });
  };

  async function analyse() {
    if (
      !(await confirm(
        `Send sparse still frames from up to ${Math.min(included.length, 12)} included clips and your creative brief to OpenAI to draft a music direction? No video file or audio is uploaded. This uses separately billed API access.`,
        { title: "Approve AI frame upload", kind: "warning" }
      ))
    )
      return;
    setAnalysing(true);
    onError("");
    try {
      const direction = await invoke<MusicDirection>("studio_ai_music_direction", {
        apiKey,
        model,
        creativeBrief: music.creativeBrief,
        project,
        stagingDir: await getStagingDir(),
        consent: true,
      });
      patch({ direction, midiPath: "", requestId: "" });
      onMessage("Music direction drafted from the supplied clips. Review it, then generate the soundtrack.");
    } catch (error) {
      onError(String(error));
    } finally {
      setAnalysing(false);
    }
  }

  async function createMidi() {
    if (!music.direction) return;
    setCreating(true);
    onError("");
    try {
      const midiPath = await invoke<string>("studio_create_music_midi", {
        project,
        direction: music.direction,
      });
      patch({ midiPath });
      onMessage("Editable MIDI score created. Open it in LMMS, choose instruments, then export WAV or MP3.");
    } catch (error) {
      onError(String(error));
    } finally {
      setCreating(false);
    }
  }

  async function chooseLmms() {
    const path = await open({
      filters: [{ name: "LMMS", extensions: ["exe"] }],
    });
    if (typeof path === "string") patch({ lmmsPath: path });
  }
  async function generateSoundtrack() {
    const requestId = crypto.randomUUID();
    setCreating(true); onError("");
    try {
      await invoke("studio_start_music", { project: { ...project, music: { ...music, requestId } }, stagingDir: await getStagingDir() });
      patch({ requestId });
      onMessage("Soundtrack queued in Jobs. LMMS will render an editable synth arrangement; the verified audio will be attached here when ready.");
    } catch (error) { onError(String(error)); }
    finally { setCreating(false); }
  }
  async function openLmms() {
    if ((!music.midiPath && !music.projectPath) || !music.lmmsPath) return;
    setOpening(true);
    onError("");
    try {
      await invoke("studio_open_lmms", { lmmsPath: music.lmmsPath, midiPath: music.projectPath || music.midiPath });
      onMessage("LMMS opened with your editable score. After making changes, export an audio file and choose it here.");
    } catch (error) {
      onError(String(error));
    } finally {
      setOpening(false);
    }
  }
  async function chooseAudio() {
    const path = await open({
      filters: [{ name: "Rendered music", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac"] }],
    });
    if (typeof path === "string") patch({ audioPath: path, enabled: true, requestId: "" });
  }

  return (
    <section className="bg-surface-800 rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg">Background music</h2>
          <p className="text-sm text-gray-400">AI direction from your clips, rendered locally with LMMS</p>
        </div>
        <label className="inline-flex items-center gap-2 rounded-full bg-surface-900 px-3 py-2 text-sm">
          <input
            type="checkbox"
            aria-label="Include background music in complete video"
            checked={music.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          Include in final render
        </label>
      </div>

      {music.enabled && !music.audioPath && <p role="status" className="rounded border border-amber-800 bg-amber-950/20 p-3 text-sm text-amber-200">Choose a rendered audio file before creating the complete video, or turn background music off. Individual clips can still be rendered.</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => void chooseAudio().catch((e) => onError(String(e)))}>Use an existing music file</button>
        {music.audioPath && <button className="btn-secondary" onClick={() => void invoke("open_in_default_app", { path: music.audioPath }).catch((e) => onError(String(e)))}>Listen to music</button>}
      </div>

      <div className="grid gap-2 text-sm md:grid-cols-5" aria-label="Background music workflow">
        {[
          ["1", "Read clips"],
          ["2", "Review direction"],
          ["3", "Generate soundtrack"],
          ["4", "Listen & refine"],
          ["5", "Mix into video"],
        ].map(([number, label]) => (
          <div key={number} className="flex items-center gap-2 rounded bg-[#0c1930] px-3 py-2">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-cyan-700 font-semibold">{number}</span>
            {label}
          </div>
        ))}
      </div>

      <p className="text-sm text-cyan-100">
        AI uses representative clip stills to suggest tempo, mood and chords. A local arranger creates an original synth score, and LMMS renders it to audio. You can open the editable project in LMMS or use your own audio file.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="md:col-span-2">
          Creative brief <span className="text-gray-400">(optional)</span>
          <textarea
            className={`${field} min-h-20`}
            maxLength={1000}
            value={music.creativeBrief}
            placeholder="e.g. warm, understated electronic pulse; leave space for coach instructions; avoid dramatic drops"
            onChange={(event) => patch({ creativeBrief: event.target.value })}
          />
        </label>
        <label>
          OpenAI API key <span className="text-gray-400">(session only)</span>
          <input
            className={field}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label>
          Vision-capable model
          <input className={field} value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-secondary"
          disabled={busy || analysing || !included.length || !apiKey || !model}
          onClick={() => void analyse()}
        >
          {analysing ? "Reading clip mood…" : `Draft music direction from ${included.length} clip${included.length === 1 ? "" : "s"}`}
        </button>
        <button className="btn-secondary" onClick={() => setApiKey("")}>Clear key</button>
      </div>

      {music.direction && (
        <div className="space-y-3 rounded border border-cyan-800 bg-surface-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">{music.direction.title}</h3>
              <p className="text-sm text-gray-400">{music.direction.summary}</p>
            </div>
            <span className="rounded-full bg-cyan-950 px-3 py-1 text-sm">Energy {music.direction.energy}/5</span>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <label>Genre<input className={field} maxLength={80} value={music.direction.genre} onChange={(event) => patchDirection({ genre: event.target.value })} /></label>
            <label>Mood<input className={field} maxLength={80} value={music.direction.mood} onChange={(event) => patchDirection({ mood: event.target.value })} /></label>
            <label>Key<select className={field} value={music.direction.key} onChange={(event) => patchDirection({ key: event.target.value })}>{["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].map((key) => <option key={key}>{key}</option>)}</select></label>
            <label>Tempo (BPM)<input className={field} type="number" min="60" max="180" value={music.direction.bpm} onChange={(event) => patchDirection({ bpm: Number(event.target.value) })} /></label>
          </div>
          <p className="text-sm"><span className="text-gray-400">Palette:</span> {music.direction.instruments.join(" · ")}</p>
          <p className="text-sm"><span className="text-gray-400">Progression:</span> {music.direction.chordProgression.join(" – ")}</p>
          <div className="grid gap-2 md:grid-cols-4">
            {music.direction.arrangement.map((section, index) => (
              <div key={`${section.name}-${index}`} className="rounded bg-surface-800 px-3 py-2 text-sm">
                <strong>{section.name}</strong><br />{section.bars} bars · energy {section.energy}/5
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || creating || !!musicJob || !music.lmmsPath || !project.outputDir} onClick={() => void generateSoundtrack()}>{musicJob ? `Soundtrack ${musicJob.status}…` : "Generate soundtrack with LMMS"}</button>
            <button className="btn-secondary" disabled={busy || creating} onClick={() => void createMidi()}>Export MIDI for manual editing</button>
          </div>
          {!music.lmmsPath && <p className="text-xs text-amber-200">Choose your installed lmms.exe below to generate audio.</p>}
          {musicJob && <p className="text-sm text-cyan-200">{musicJob.phase} · You can keep preparing clips.</p>}
        </div>
      )}

      <div className="grid gap-3 border-t border-surface-600 pt-4 lg:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <label>
            Editable score
            <input className={field} readOnly value={music.projectPath || music.midiPath || "Generate a soundtrack or export MIDI"} />
          </label>
          <label>
            LMMS executable
            <input className={field} readOnly value={music.lmmsPath || "Choose lmms.exe"} />
          </label>
        </div>
        <div className="flex flex-wrap content-end gap-2">
          <button className="btn-secondary" onClick={() => void chooseLmms().catch((e) => onError(String(e)))}>Choose LMMS</button>
          <button className="btn-secondary" disabled={(!music.midiPath && !music.projectPath) || !music.lmmsPath || opening} onClick={() => void openLmms()}>
            {opening ? "Opening LMMS…" : "Open score in LMMS"}
          </button>
        </div>
      </div>

      <div className="rounded bg-[#0c1930] p-3 text-sm text-gray-200">
        Generated audio is attached automatically when its job completes. To refine it, open the score in LMMS, export your changes, then select that audio file below.
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
        <label>
          Rendered music file
          <input className={field} readOnly value={music.audioPath || "No rendered music selected"} />
        </label>
        <button className="btn-secondary self-end" onClick={() => void chooseAudio().catch((e) => onError(String(e)))}>Choose rendered audio</button>
      </div>
      {music.audioPath && (
        <div className="grid gap-4 rounded bg-surface-900 p-3 md:grid-cols-2">
          <label>
            Music level <span className="text-cyan-200">{music.musicVolume}%</span>
            <input className="block w-full accent-cyan-500" type="range" min="0" max="100" value={music.musicVolume} onChange={(event) => patch({ musicVolume: Number(event.target.value) })} />
          </label>
          <label>
            Original clip sound <span className="text-cyan-200">{music.originalVolume}%</span>
            <input className="block w-full accent-cyan-500" type="range" min="0" max="100" value={music.originalVolume} onChange={(event) => patch({ originalVolume: Number(event.target.value) })} />
          </label>
        </div>
      )}
    </section>
  );
}
