import type { StudioProject } from "../../types/videoStudio";
import { chapterPlan } from "../../utils/studioGraphics";

const marker = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60].map((part) => String(part).padStart(2, "0")).join(":");
};

export default function StudioChapterEditor({ project, onName, onSelect, onMove, disabled = false }: {
  project: StudioProject;
  onName: (clipId: string, name: string) => void;
  onSelect: (clipId: string, tab: "titles" | "scorecard") => void;
  onMove: (clipId: string, delta: number) => void;
  disabled?: boolean;
}) {
  const chapters = chapterPlan(project);
  function move(index: number, direction: number) {
    const current = project.clips.findIndex((clip) => clip.id === chapters[index].clipId);
    const target = project.clips.findIndex((clip) => clip.id === chapters[index + direction]?.clipId);
    if (current >= 0 && target >= 0) onMove(chapters[index].clipId, target - current);
  }
  return <details className="studio-chapter-editor" open>
    <summary className="studio-panel-heading">Chapters & finishing <span>{chapters.length} included · estimated timing</span></summary>
    <p className="studio-graphics-help">Edit chapter names here, or use the row buttons to open a clip's Titles or Scorecard editor. Order follows the current sequence; excluded clips are omitted. Exact markers are generated after assembly; finished export descriptions are kept.</p>
    {!chapters.length ? <p className="studio-graphics-help">Add an included clip to plan chapters and scorecards.</p>
      : <ol className="studio-chapter-list" aria-label="Ordered chapters" tabIndex={0}>
        {chapters.map((chapter, index) => <li key={chapter.clipId} className="studio-chapter-row">
          <div className="studio-chapter-time"><span>{String(index + 1).padStart(2, "0")}</span><time>≈{marker(chapter.start)}</time></div>
          <div className="studio-chapter-name"><label><span className="sr-only">Chapter {index + 1} name</span><input disabled={disabled} value={chapter.title} placeholder="Chapter name" onChange={(event) => onName(chapter.clipId, event.target.value)} /></label>
            <small>{chapter.cardStart == null ? "No scorecard" : `${chapter.extraSeconds ? "Standalone card" : "Score overlay"} ≈${marker(chapter.cardStart)}–${marker(chapter.cardEnd!)}${chapter.extraSeconds ? ` · adds ${chapter.extraSeconds}s` : ""}`} · segment ends ≈{marker(chapter.end)}</small></div>
          <div className="studio-chapter-actions"><button type="button" className="btn-secondary" disabled={disabled || index === 0} aria-label={`Move chapter ${index + 1} up`} title="Move chapter up" onClick={() => move(index, -1)}>↑</button><button type="button" className="btn-secondary" disabled={disabled || index === chapters.length - 1} aria-label={`Move chapter ${index + 1} down`} title="Move chapter down" onClick={() => move(index, 1)}>↓</button><button type="button" className="btn-secondary" disabled={disabled} aria-label={`Edit chapter ${index + 1} title`} onClick={() => onSelect(chapter.clipId, "titles")}>Titles</button><button type="button" className="btn-secondary" disabled={disabled} aria-label={`Edit chapter ${index + 1} scorecard`} onClick={() => onSelect(chapter.clipId, "scorecard")}>Scorecard</button></div>
        </li>)}
      </ol>}
  </details>;
}
