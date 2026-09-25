import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioClip, StudioProject, StudioWindReductionPreset, StudioClipWindReduction } from "../../types/videoStudio";
import { clipName } from "../../types/videoStudio";
import { effectiveWindReduction, normalizeWindReduction, previewStartSeconds, windReductionPresets } from "../../utils/studioAudio";

interface AudioPreview {
  original: string;
  processed: string;
  seconds: number;
  preset: StudioWindReductionPreset;
}
interface PreviewResult extends AudioPreview { key: string }
type Side = "original" | "processed";

export interface StudioAudioControlsProps {
  project: StudioProject;
  clip?: StudioClip;
  stagingDir: () => Promise<string>;
  onProjectChange: (patch: Partial<StudioProject>) => void;
  onClipChange: (patch: Partial<StudioClip>) => void;
  disabled?: boolean;
}

const title = (preset: string) => preset.charAt(0).toUpperCase() + preset.slice(1);
const field = "block mt-1 w-full bg-surface-900 rounded border border-surface-600 px-3 py-2 text-sm";

export default function StudioAudioControls({ project, clip, stagingDir, onProjectChange, onClipChange, disabled = false }: StudioAudioControlsProps) {
  const [start, setStart] = useState(0);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [side, setSide] = useState<Side>("original");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const player = useRef<HTMLAudioElement>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const inFlight = useRef(false);
  const seek = useRef<{ side: Side; seconds: number; playing: boolean } | null>(null);
  const preset = clip ? effectiveWindReduction(project, clip) : normalizeWindReduction(project.defaultWindReduction);
  const boundedStart = previewStartSeconds(start, clip?.duration ?? 0);
  const key = JSON.stringify([clip?.id, clip?.path, clip?.duration, preset, boundedStart]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const current = preview?.key === key ? preview : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  useEffect(() => { setStart(0); }, [clip?.id, clip?.path]);
  useEffect(() => {
    request.current++;
    player.current?.pause();
    seek.current = null;
    setPreview(null); setSide("original"); setError("");
  }, [key]);

  async function generatePreview() {
    if (!clip || disabled || inFlight.current || !Number.isFinite(clip.duration) || clip.duration <= 0) return;
    const token = ++request.current;
    const context = key;
    inFlight.current = true;
    setGenerating(true); setError("");
    player.current?.pause();
    seek.current = null;
    setPreview(null);
    try {
      const directory = await stagingDir();
      if (!mounted.current || token !== request.current || context !== currentKey.current) return;
      const result = await invoke<AudioPreview>("studio_audio_preview", {
        stagingDir: directory, path: clip.path, start: boundedStart, seconds: 10, preset,
      });
      if (!mounted.current || token !== request.current || context !== currentKey.current) return;
      // Only bounded WAV data from this request is accepted, never a returned URL.
      if (result.preset !== preset || !Number.isFinite(result.seconds) || result.seconds <= 0 || result.seconds > 10
          || [result.original, result.processed].some((wav) => typeof wav !== "string" || !wav.length || wav.length > 8_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wav))) {
        throw new Error("The audio preview response was invalid. Please try again.");
      }
      setSide("original"); setPreview({ ...result, key: context });
    } catch (failure) {
      if (mounted.current && token === request.current && context === currentKey.current) setError(String(failure));
    } finally {
      inFlight.current = false;
      if (mounted.current) setGenerating(false);
    }
  }

  function switchSide(next: Side) {
    if (!current || next === side) return;
    const audio = player.current;
    seek.current = {
      side: next,
      seconds: audio?.readyState ? audio.currentTime : seek.current?.seconds ?? 0,
      playing: audio?.readyState ? !audio.paused : seek.current?.playing ?? false,
    };
    audio?.pause();
    setSide(next);
  }

  return <div className="studio-audio-controls space-y-3" aria-label="Camera audio wind reduction">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Wind reduction default
        <select className={field} disabled={disabled} value={normalizeWindReduction(project.defaultWindReduction)}
          onChange={(event) => onProjectChange({ defaultWindReduction: event.target.value as StudioWindReductionPreset })}>
          {windReductionPresets.map((value) => <option key={value} value={value}>{title(value)}</option>)}
        </select>
      </label>
      <label className="text-sm">Selected clip wind reduction
        <select className={field} disabled={disabled || !clip} value={clip?.windReduction ?? "inherit"}
          onChange={(event) => onClipChange({ windReduction: event.target.value as StudioClipWindReduction })}>
          <option value="inherit">Use project default</option>
          {windReductionPresets.map((value) => <option key={value} value={value}>{title(value)}</option>)}
        </select>
      </label>
    </div>
    <p className="text-xs text-gray-400">Camera audio only, before background music is mixed. A conservative bass cut and high-frequency hiss reduction—not speech denoising. Natural low and high sounds can also soften. Preview a windy section before choosing a strength. Picture approval and saved video renders are kept.</p>
    <p className="text-xs text-gray-400">Play rendered clip keeps the original camera sound. Use this A/B preview to hear cleanup, then create a new final video to include it.</p>
    {!clip ? <p className="text-sm text-gray-400">Select a clip to compare its camera audio.</p> : <>
      <p className="text-sm text-gray-300">{clipName(clip.path)} · effective setting: {title(preset)}{preset === "off" ? " — original camera audio" : ""}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Audio preview start · seconds
          <input className={field} type="number" min={0} max={Math.max(0, clip.duration - 0.1)} step="0.1" value={boundedStart} disabled={disabled}
            onChange={(event) => setStart(previewStartSeconds(Number(event.target.value), clip.duration))} />
        </label>
        <button className="btn-secondary" disabled={disabled || generating || !Number.isFinite(clip.duration) || clip.duration <= 0} onClick={() => void generatePreview()}>
          {generating ? "Preparing audio preview…" : "Preview up to 10 seconds"}
        </button>
      </div>
      {current && <div className="space-y-2">
        <div role="group" aria-label="Audio A/B comparison" className="flex flex-wrap gap-2">
          <button className="btn-secondary" aria-pressed={side === "original"} onClick={() => switchSide("original")}>A · Original</button>
          <button className="btn-secondary" aria-pressed={side === "processed"} onClick={() => switchSide("processed")}>B · {title(current.preset)}{current.preset === "off" ? " (unchanged)" : " wind reduction"}</button>
        </div>
        <audio ref={player} controls preload="metadata" aria-label="Camera audio preview" className="w-full" src={`data:audio/wav;base64,${current[side]}`}
          onLoadedMetadata={() => {
            const audio = player.current, pending = seek.current;
            if (!audio || !pending || pending.side !== side) return;
            seek.current = null;
            const duration = Number.isFinite(audio.duration) ? audio.duration : current.seconds;
            audio.currentTime = Math.min(pending.seconds, Math.max(0, duration - 0.01));
            if (pending.playing) void audio.play().catch(() => { if (mounted.current && currentKey.current === key) setError("Press Play to continue the audio preview."); });
          }}
          onError={() => setError("The audio preview could not be played. Try generating it again.")} />
        <p className="text-xs text-gray-400">{current.seconds.toFixed(1)}-second local preview. A/B uses one player and keeps your listening position; no background music or source files are changed.</p>
      </div>}
    </>}
    {error && <p role="alert" className="text-sm text-red-300 break-words">{error}</p>}
  </div>;
}
