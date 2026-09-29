import { useRef, useState } from "react";
import type { StudioClip, StudioProject } from "../../types/videoStudio";
import StudioGraphicsPreview from "./StudioGraphicsPreview";

export default function StudioClipTitle({ project, clip, onChange, getStagingDir, disabled = false }: {
  project: StudioProject; clip: StudioClip; onChange: (change: Partial<StudioClip>) => void;
  getStagingDir: () => Promise<string>; disabled?: boolean;
}) {
  // Zero duration is already the native/export contract for hiding title text.
  const [editing, setEditing] = useState(!!clip.title.trim() && clip.titleSeconds > 0);
  const lastSeconds = useRef(clip.titleSeconds > 0 ? clip.titleSeconds : 4);
  const enabled = clip.titleSeconds > 0 && (editing || !!clip.title.trim());
  return <div className="studio-graphics-fields">
    <label className="studio-graphics-check"><input aria-label="Show title in video" type="checkbox" disabled={disabled} checked={enabled} onChange={(e) => {
      setEditing(e.target.checked);
      if (clip.titleSeconds > 0) lastSeconds.current = clip.titleSeconds;
      onChange({ titleSeconds: e.target.checked ? lastSeconds.current : 0 });
    }} />Show title in video</label>
    <p className="studio-graphics-help">Optional text drawn over the start of this clip. This is separate from its YouTube chapter name. Turn it off to hide the title while keeping the text for later.</p>
    <fieldset className="studio-graphics-fields" disabled={disabled || !enabled}>
      <legend>On-screen clip title</legend>
      <div className="studio-graphics-field-grid">
        <label>Clip title<input aria-label="On-screen clip title" maxLength={100} value={clip.title} onChange={e => onChange({ title: e.target.value })} /></label>
        <label>Heading (optional)<input maxLength={60} value={clip.titleHeading ?? ""} onChange={e => onChange({ titleHeading: e.target.value })} /></label>
        <label>Subtitle (optional)<input maxLength={110} value={clip.titleSubtitle ?? ""} onChange={e => onChange({ titleSubtitle: e.target.value })} /></label>
        <label>Clip title seconds<input aria-label="Clip title seconds" type="number" min={0.5} max={30} step={0.5} value={enabled ? clip.titleSeconds : lastSeconds.current} onChange={e => {
          const seconds = Math.max(0.5, Math.min(30, Number(e.target.value) || 4)); lastSeconds.current = seconds; onChange({ titleSeconds: seconds });
        }} /></label>
      </div>
      <button type="button" className="btn-secondary" disabled={!clip.chapter.trim()} onClick={() => onChange({ title: clip.chapter.slice(0, 100) })}>Copy chapter name into title</button>
    </fieldset>
    {enabled && !clip.title.trim() && <p className="studio-graphics-help">Enter a main title to show text in the video. The chapter name is not copied automatically.</p>}
    <StudioGraphicsPreview project={project} clip={clip} target="clipTitle" getStagingDir={getStagingDir} disabled={disabled || !enabled || !clip.title.trim()} />
    <p className="studio-graphics-help">Changing an on-screen title refreshes the titled fragment while keeping an unchanged verified stabilised base. Renaming the YouTube chapter does not change the video picture.</p>
  </div>;
}
