import type { StudioProject } from "../../types/videoStudio";
import StudioGraphicsPreview from "./StudioGraphicsPreview";

export function openingTitleSummary(project: StudioProject) {
  if (project.openingTitleMode === "none" || !project.titleSeconds) return "Opening title · Off";
  if (!project.title.trim()) return "Opening title · Add title text";
  return project.openingTitleMode === "overlay"
    ? "Opening overlay · first clip · no added time"
    : `Opening card · ${project.titleSeconds} seconds · adds ${project.titleSeconds} seconds`;
}

export default function StudioOpeningTitle({ project, disabled, onChange, onOpenDefaults, getStagingDir }: {
  project: StudioProject;
  disabled: boolean;
  onChange: (change: Partial<StudioProject>) => void;
  onOpenDefaults: () => void;
  getStagingDir: () => Promise<string>;
}) {
  const first = project.clips.find((clip) => clip.include);
  return <section className="studio-opening-editor" aria-labelledby="studio-opening-heading">
    <div className="studio-opening-topline">
      <div><h3 id="studio-opening-heading" tabIndex={-1}>Opening title</h3><p>{openingTitleSummary(project)}</p></div>
      <button type="button" className="btn-secondary" onClick={onOpenDefaults}>Edit shared graphics defaults</button>
    </div>
    <div className="studio-opening-layout">
      <fieldset disabled={disabled} className="studio-graphics-fields">
        <legend>Make your introduction</legend>
        <label>Heading (optional)<input maxLength={60} placeholder="e.g. SYDNEY POLO CHAMPIONSHIPS" value={project.titleHeading ?? ""} onChange={(event) => onChange({ titleHeading: event.target.value })} /></label>
        <label>Opening title<input maxLength={70} value={project.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
        <label>Subtitle / event date<input maxLength={110} value={project.subtitle} onChange={(event) => onChange({ subtitle: event.target.value })} /></label>
        <div className="studio-graphics-field-grid">
          <label>Opening title style<select value={project.openingTitleMode} onChange={(event) => onChange({ openingTitleMode: event.target.value as StudioProject["openingTitleMode"] })}>
            <option value="card">Separate title card</option><option value="overlay">Overlay on first video</option><option value="none">None</option>
          </select></label>
          <label>Opening title duration · seconds (0 = hidden)<input type="number" min={0} max={30} step={0.5} value={project.titleSeconds}
            onChange={(event) => onChange({ titleSeconds: Math.max(0, Math.min(30, Number(event.target.value) || 0)) })} /></label>
        </div>
        <p className="studio-graphics-help">{project.openingTitleMode === "overlay"
          ? `Shown on the first included clip (${first?.chapter || "add a clip to begin"}), shortened to fit that clip. Reordering changes which clip carries it.`
          : project.openingTitleMode === "none" ? "No opening title is added. Your text is kept if you turn it back on."
          : "A separate card appears before the first clip and adds its duration to the finished video."}</p>
        <p className="studio-graphics-help">Opening text, placement and duration are applied at final assembly. They keep prepared clips and picture approval, without repeating stabilisation.</p>
        <p className="studio-graphics-help">The heading sits above the main title. Leave it blank to hide that line. A main title is required to show the introduction.</p>
        <p className="studio-graphics-help">Font, colour and panel styling come from Project settings → Graphics. Shared style changes can also refresh visible clip titles.</p>
      </fieldset>
      <StudioGraphicsPreview project={project} target="opening" getStagingDir={getStagingDir} disabled={disabled} />
    </div>
  </section>;
}
