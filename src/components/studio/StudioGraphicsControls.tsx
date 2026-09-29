import { useState } from "react";
import type { StudioClip, StudioGraphicsSettings, StudioProject, StudioScorecard, StudioScorecardTemplate, StudioScoreTiming } from "../../types/videoStudio";
import { applyScorecardTemplate, graphicsDefaults, newScorecard, scorecardTemplateDefaults, scoreWindow } from "../../utils/studioGraphics";
import { scorecardReady, timecode } from "../../types/videoStudio";
import StudioGraphicsPreview from "./StudioGraphicsPreview";
import StudioScorecardUpdateReview, { type ApplyScorecardUpdates } from "./StudioScorecardUpdateReview";

const timings: [StudioScoreTiming, string][] = [["clipEnd", "End of main clip"], ["afterReplays", "End of clip + replays"], ["separateCard", "Standalone card after replays"], ["clipStart", "Start of clip"], ["custom", "Custom time in main clip"]];
const bounded = (value: string, min: number, max: number) => Math.max(min, Math.min(max, Number(value) || min));
interface Common { project: StudioProject; getStagingDir: () => Promise<string>; disabled?: boolean }

export function StudioProjectGraphics({ project, disabled = false, onChange, onApplyScorecardUpdates }: Omit<Common, "getStagingDir"> & { onChange: (patch: Partial<StudioProject>) => void; onApplyScorecardUpdates: ApplyScorecardUpdates }) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const graphics = project.graphics ?? graphicsDefaults();
  const patch = (change: Partial<StudioGraphicsSettings>) => onChange({ graphics: { ...graphics, ...change } });
  const theme = (change: Partial<StudioGraphicsSettings["theme"]>) => patch({ theme: { ...graphics.theme, ...change } });
  const template = graphics.scorecardTemplate ?? scorecardTemplateDefaults();
  const unconfigured = project.clips.filter((clip) => clip.scorecard == null).length;
  const templatePatch = (change: Partial<StudioScorecardTemplate>) => {
    const updated = { ...graphics, scorecardTemplate: { ...template, ...change } };
    // Enabling seeds existing unconfigured clips once. Later edits change only
    // starting defaults for future clips, never a previously configured card.
    const clips = change.enabled === true && !template.enabled
      ? applyScorecardTemplate({ ...project, graphics: updated }).clips : project.clips;
    onChange({ graphics: updated, clips });
  };
  return <div className="studio-graphics-project">
    <fieldset disabled={disabled} className="studio-graphics-fields">
      <legend>Default scorecard template</legend>
      <label className="studio-graphics-check"><input aria-label="Use project scorecard template" type="checkbox" checked={template.enabled} onChange={(e) => templatePatch({ enabled: e.target.checked })} />Prepare scorecards from this project template</label>
      <p className="studio-graphics-help">Default text for all three lines. New clip cards start OFF, even with text filled in. Turn on Include scorecard for each clip that should display one. Editing these defaults does not change existing cards until you review and apply selected text updates.</p>
      <div className="studio-graphics-field-grid">
        <label>Default card layout<select aria-label="Default card layout" value={template.template} onChange={(e) => templatePatch({ template: e.target.value as StudioScorecardTemplate["template"] })}><option value="line">Lower-third line</option><option value="result">Result card</option><option value="table">Score table</option></select></label>
        <label>Top line / heading<input aria-label="Default card heading" maxLength={60} value={template.heading} onChange={(e) => templatePatch({ heading: e.target.value })} /></label>
        <label>Main line / result<input aria-label="Default card result" maxLength={90} value={template.result ?? ""} placeholder="Optional default main line" onChange={(e) => templatePatch({ result: e.target.value })} /></label>
        <label>Bottom line / subtitle<input aria-label="Default card subtitle" maxLength={120} value={template.subtitle} placeholder="Optional shared event description" onChange={(e) => templatePatch({ subtitle: e.target.value })} /></label>
      </div>
      {template.template === "table" && <div className="studio-score-table-editor">
        <div className="studio-graphics-field-grid">
          <label>Default table columns<input aria-label="Default table columns" type="number" min={1} max={5} value={template.columns.length} onChange={(e) => templatePatch({ columns: Array.from({ length: Math.trunc(bounded(e.target.value, 1, 5)) }, (_, i) => template.columns[i] ?? `Column ${i + 1}`) })} /></label>
          <label>Initially blank rows<input aria-label="Initially blank rows" type="number" min={1} max={8} value={template.blankRows} onChange={(e) => templatePatch({ blankRows: Math.trunc(bounded(e.target.value, 1, 8)) })} /></label>
          {template.columns.map((column, index) => <label key={index}>Default column {index + 1}<input aria-label={`Default column ${index + 1}`} maxLength={24} value={column} onChange={(e) => templatePatch({ columns: template.columns.map((value, at) => at === index ? e.target.value : value) })} /></label>)}
        </div>
        <p className="studio-graphics-help">Rows start completely blank. Names, places and scores are entered separately for each clip.</p>
      </div>}
      <div className="studio-graphics-preview-actions">
        <button type="button" className="btn-secondary" disabled={!template.enabled || !unconfigured} onClick={() => onChange({ clips: applyScorecardTemplate(project).clips })}>Prepare missing cards ({unconfigured})</button>
        <button type="button" className="btn-secondary" disabled={!template.enabled || !project.clips.some(c => c.scorecard)} onClick={() => { setUpdateMessage(""); setReviewOpen(true); }}>Update clip scorecards from project defaults…</button>
      </div>
      <p className="studio-graphics-help">Updates open a review with a separate choice for each line; nothing is selected automatically. Layout, table entries and on/off settings are kept. Disabling this template stops future cards being prepared, without changing existing cards.</p>
      {updateMessage && <p role="status" className="studio-score-update-success">{updateMessage}</p>}
    </fieldset>
    {reviewOpen && <StudioScorecardUpdateReview project={project} disabled={disabled} onApply={onApplyScorecardUpdates} onClose={message => { setReviewOpen(false); if (message) setUpdateMessage(message); }} />}
    <fieldset disabled={disabled} className="studio-graphics-fields">
      <legend>Shared graphics style</legend>
      <p className="studio-graphics-help">One visual style for scorecards and optional styled titles. Existing titles keep their legacy appearance until you opt in.</p>
      <div className="studio-graphics-field-grid">
        <label>Graphics font<select aria-label="Graphics font" value={graphics.theme.font} onChange={(e) => theme({ font: e.target.value as typeof graphics.theme.font })}><option value="segoe">Segoe UI · clean</option><option value="georgia">Georgia · editorial</option><option value="trebuchet">Trebuchet MS · humanist</option></select></label>
        <label>Graphics palette<select aria-label="Graphics palette" value={graphics.theme.palette} onChange={(e) => theme({ palette: e.target.value as typeof graphics.theme.palette })}><option value="midnight">Midnight</option><option value="ivory">Ivory</option><option value="slate">Slate</option></select></label>
        <label>Accent colour<input aria-label="Accent colour" type="color" value={graphics.theme.accent} onChange={(e) => theme({ accent: e.target.value })} /></label>
        <label>Graphics position<select aria-label="Graphics position" value={graphics.theme.position} onChange={(e) => theme({ position: e.target.value as "top" | "bottom" })}><option value="bottom">Lower third</option><option value="top">Upper third</option></select></label>
        <label>Panel opacity · %<input aria-label="Panel opacity · %" type="number" min={0} max={100} value={graphics.theme.opacity} onChange={(e) => theme({ opacity: bounded(e.target.value, 0, 100) })} /></label>
      </div>
      <label className="studio-graphics-check"><input type="checkbox" checked={graphics.styledTitles} onChange={(e) => patch({ styledTitles: e.target.checked })} />Use shared style for opening and clip titles</label>
      <p className="studio-graphics-help">Changing the style of a visible clip title can require its picture render to be refreshed. Scorecards and opening titles are applied at final assembly.</p>
      <div className="studio-graphics-field-grid">
        <label>Default scorecard timing<select aria-label="Default scorecard timing" value={graphics.scorecardTiming} onChange={(e) => patch({ scorecardTiming: e.target.value as StudioScoreTiming })}>{timings.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Default scorecard seconds<input aria-label="Default scorecard seconds" type="number" min={1} max={30} step={0.5} value={graphics.scorecardSeconds} onChange={(e) => patch({ scorecardSeconds: bounded(e.target.value, 1, 30) })} /></label>
        {graphics.scorecardTiming === "custom" && <label>Default scorecard start · seconds<input aria-label="Default scorecard start · seconds" type="number" min={0} step={0.5} value={graphics.scorecardStart} onChange={(e) => patch({ scorecardStart: Math.max(0, Number(e.target.value) || 0) })} /></label>}
      </div>
      <p className="studio-graphics-help">Only scorecards set to Use project default follow these timing changes. A standalone card adds time after all replays: camera audio is silent; project music continues.</p>
    </fieldset>
  </div>;
}

export function StudioClipScorecard({ project, clip, getStagingDir, disabled = false, onChange }: Common & { clip: StudioClip; onChange: (patch: Partial<StudioClip>) => void }) {
  const score = clip.scorecard ?? { ...newScorecard(), enabled: false };
  const graphics = project.graphics ?? graphicsDefaults();
  const patch = (change: Partial<StudioScorecard>) => onChange({ scorecard: { ...score, ...change } });
  const timing = score.timing === "inherit" ? graphics.scorecardTiming : score.timing;
  const needsResults = score.enabled && !scorecardReady(score);
  const window = scoreWindow(project, clip);
  const overlaps = score.enabled && timing !== "separateCard" && window.end > window.start ? [
    clip.title.trim() && clip.titleSeconds > 0 && window.start < clip.titleSeconds ? "the clip title" : "",
    project.clips.find((candidate) => candidate.include)?.id === clip.id && project.openingTitleMode === "overlay"
      && project.title.trim() && project.titleSeconds > 0 && window.start < project.titleSeconds ? "the opening title" : "",
  ].filter(Boolean) : [];
  return <div className="studio-scorecard-editor">
    <div className="studio-scorecard-topline"><label className="studio-graphics-check"><input aria-label="Include scorecard" type="checkbox" disabled={disabled} checked={score.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />Include scorecard</label><span>FINISHING · picture render kept</span></div>
    {needsResults && <p role="status" className="studio-graphics-help"><strong>Needs results.</strong> This card was prepared from your project template. {score.template === "table" ? "Enter at least one table value" : "Enter a scorecard result"} to include it in the finished video. The common heading alone is not exported.</p>}
    <div className="studio-scorecard-layout">
      <fieldset className="studio-graphics-fields" disabled={disabled}>
        <legend>Scorecard content</legend>
        {!score.enabled && <p className="studio-graphics-help">This card is OFF. You can prepare its text without showing it in the video. Enable Include scorecard when ready.</p>}
        <label>Scorecard template<select aria-label="Scorecard template" value={score.template} onChange={(e) => patch({ template: e.target.value as StudioScorecard["template"] })}><option value="line">Lower-third line</option><option value="result">Result card</option><option value="table">Score table</option></select></label>
        <label>Scorecard heading<input aria-label="Scorecard heading" maxLength={60} value={score.heading} onChange={(e) => patch({ heading: e.target.value })} /></label>
        <label>Scorecard result<input aria-label="Scorecard result" maxLength={90} placeholder="Navy 12 · White 8" value={score.result} onChange={(e) => patch({ result: e.target.value })} /></label>
        <label>Scorecard subtitle<input aria-label="Scorecard subtitle" maxLength={120} placeholder="Final result · Afternoon match" value={score.subtitle} onChange={(e) => patch({ subtitle: e.target.value })} /></label>
        {score.template === "table" && <div className="studio-score-table-editor">
          <div className="studio-graphics-field-grid"><label>Table columns<input aria-label="Table columns" type="number" min={1} max={5} value={score.columns.length} onChange={(e) => {
            const count = Math.trunc(bounded(e.target.value, 1, 5));
            patch({ columns: Array.from({ length: count }, (_, i) => score.columns[i] ?? `Column ${i + 1}`), rows: score.rows.map((row) => Array.from({ length: count }, (_, i) => row[i] ?? "")) });
          }} /></label><label>Table rows<input aria-label="Table rows" type="number" min={1} max={8} value={score.rows.length} onChange={(e) => patch({ rows: Array.from({ length: Math.trunc(bounded(e.target.value, 1, 8)) }, (_, i) => score.rows[i] ?? score.columns.map(() => "")) })} /></label></div>
          <div className="studio-score-table-scroll" role="region" aria-label="Score table editor" tabIndex={0}><table><thead><tr>{score.columns.map((column, col) => <th key={col}><input aria-label={`Column ${col + 1} heading`} maxLength={24} value={column} onChange={(e) => patch({ columns: score.columns.map((value, index) => index === col ? e.target.value : value) })} /></th>)}</tr></thead><tbody>{score.rows.map((row, index) => <tr key={index}>{score.columns.map((_, col) => <td key={col}><input aria-label={`Row ${index + 1}, column ${col + 1}`} maxLength={24} value={row[col] ?? ""} onChange={(e) => patch({ rows: score.rows.map((values, at) => at === index ? values.map((value, cell) => cell === col ? e.target.value : value) : values) })} /></td>)}</tr>)}</tbody></table></div>
          <small>1–5 columns · 1–8 rows · 24 characters per cell</small>
        </div>}
        <label>Scorecard timing<select aria-label="Scorecard timing" value={score.timing} onChange={(e) => patch({ timing: e.target.value as StudioScorecard["timing"] })}><option value="inherit">Use project default</option>{timings.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {score.timing === "inherit" ? <p className="studio-graphics-help">Using project: {timings.find(([value]) => value === timing)?.[1]} · {graphics.scorecardSeconds}s</p>
          : <div className="studio-graphics-field-grid"><label>Scorecard duration · seconds<input aria-label="Scorecard duration · seconds" type="number" min={1} max={30} step={0.5} value={score.seconds} onChange={(e) => patch({ seconds: bounded(e.target.value, 1, 30) })} /></label>{timing === "custom" && <label>Scorecard start · seconds<input aria-label="Scorecard start · seconds" type="number" min={0} max={clip.duration} step={0.5} value={score.start} onChange={(e) => patch({ start: bounded(e.target.value, 0, clip.duration) })} /></label>}</div>}
        <p className="studio-graphics-help">{needsResults ? "Needs results · omitted from export; no added duration." : score.enabled ? `Estimated card window ${timecode(window.start)}–${timecode(window.end)} in this segment${window.extraSeconds ? ` · adds ${window.extraSeconds}s` : " · no added duration"}.` : "No scorecard in this segment."} Final timings use measured exported frames.</p>
        {score.enabled && !needsResults && window.end <= window.start && <p role="alert">This scorecard has no visible time in this clip. Choose an earlier custom start, change the inherited timing, or use a standalone card.</p>}
        {!!overlaps.length && <p role="alert">Scorecards are composited last. This window overlaps {overlaps.join(" and ")}, so the text can overlap. Choose later timing or a standalone card to keep both readable. Your timings and cached video have not been changed.</p>}
      </fieldset>
      <StudioGraphicsPreview project={project} clip={clip} target="scorecard" getStagingDir={getStagingDir} disabled={disabled || window.end <= window.start} />
    </div>
    <p className="studio-graphics-help">Final Export composites this card over the matching stabilised cached clip without repeating stabilisation. Scorecard edits keep picture approval and cached renders. {timing === "separateCard" ? "The standalone card follows every replay, adds duration, silences camera audio and keeps project music playing." : "Overlays do not add duration. End of clip + replays uses the end of that combined segment, rather than inserting an extra card."}</p>
  </div>;
}
