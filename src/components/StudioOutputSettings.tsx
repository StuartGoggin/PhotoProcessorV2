import type { StudioProject } from "../types/videoStudio";
import { outputLabel, suggestedBitrate } from "../utils/studioWorkflow";

export default function StudioOutputSettings({ project, onChange, onFolder }: {
  project: StudioProject; onChange: (change: Partial<StudioProject>) => void; onFolder: () => void;
}) {
  const input = "block mt-1 w-full bg-surface-900 border border-surface-600 rounded-lg px-3 py-2 text-white";
  return (
    <section className="rounded-xl border border-cyan-800/60 bg-surface-800 p-5 space-y-4" aria-labelledby="studio-output-heading">
      <div className="flex flex-wrap justify-between gap-2">
        <div><p className="text-xs uppercase tracking-widest text-cyan-300 mb-1">01 / Output</p><h2 id="studio-output-heading" className="text-lg font-semibold text-white">Choose once. Use for every clip.</h2></div>
        <span className="self-center rounded-full bg-cyan-950 px-3 py-1 text-xs text-cyan-200">MP4 · H.264 video · AAC sound</span>
      </div>
      <div className="grid sm:grid-cols-3 gap-4 text-sm">
        <label>Resolution<select aria-label="Resolution" className={input} value={project.width} onChange={(e) => {
          const width = Number(e.target.value);
          onChange({ width, height: width === 3840 ? 2160 : width === 1920 ? 1080 : 720, bitrateMbps: suggestedBitrate(width) });
        }}><option value={3840}>4K UHD — 3840 × 2160</option><option value={1920}>Full HD — 1920 × 1080</option><option value={1280}>HD — 1280 × 720</option></select></label>
        <label>Frame rate<select aria-label="Frame rate" className={input} value={project.fps} onChange={(e) => onChange({ fps: Number(e.target.value) })}>{[25,30,50,60].map((fps) => <option value={fps} key={fps}>{fps} frames / second</option>)}</select></label>
        <label>Video bitrate · Mbps<input className={input} type="number" min="1" max="150" step="1" value={project.bitrateMbps} onChange={(e) => onChange({ bitrateMbps: Number(e.target.value) })} /></label>
      </div>
      <p className="text-xs text-gray-400">Bitrate is a target: higher values allow more detail and larger files. Changing resolution selects a suggested bitrate; you can adjust it. Format changes mark existing clips for re-rendering.</p>
      <div className="flex flex-wrap items-center gap-3 border-t border-surface-600 pt-3">
        <button className="btn-secondary" onClick={onFolder}>Choose output folder</button>
        <span className="min-w-0 flex-1 text-sm break-all text-gray-300">{project.outputDir || "Choose where your clips and complete videos will be saved"}</span>
      </div>
      <p className="text-sm text-cyan-200">Full renders: {outputLabel(project)} <span className="text-gray-400">· Quick previews: 720p</span></p>
    </section>
  );
}
