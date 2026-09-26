import type { BackgroundMusic, StudioClip, StudioJob, StudioProject } from "../../types/videoStudio";
import { outputLabel } from "../../utils/studioWorkflow";
import { normalizeWindReduction, windReductionPresets } from "../../utils/studioAudio";
import StudioBackgroundMusic from "../StudioBackgroundMusic";
import StudioOutputSettings from "../StudioOutputSettings";
import StudioStabilizationFields from "../StudioStabilizationFields";
import { StudioProjectGraphics } from "./StudioGraphicsControls";

const input = "bg-surface-900 rounded border border-surface-600 px-3 py-2 w-full text-sm";
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const sections = ["project", "filters", "graphics", "music", "output"] as const;
export type ProjectSettingsSection = typeof sections[number];

export default function StudioProjectSettings({
  project, selectedClip, jobs, busy, onChange, onMusicChange, onApplyStabilization,
  onResetWind, onOutputFolder, onError, onMessage, getStagingDir, expanded, onSectionChange, onOpenTitles,
}: {
  project: StudioProject;
  selectedClip?: StudioClip;
  jobs: StudioJob[];
  busy: boolean;
  onChange: (change: Partial<StudioProject>) => void;
  onMusicChange: (change: Partial<BackgroundMusic>) => void;
  onApplyStabilization: (onlySelected: boolean) => void;
  onResetWind: () => void;
  onOutputFolder: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
  getStagingDir: () => Promise<string>;
  expanded: ProjectSettingsSection | null;
  onSectionChange: (section: ProjectSettingsSection | null) => void;
  onOpenTitles: () => void;
}) {
  const included = project.clips.filter((clip) => clip.include);
  const overrides = project.clips.filter((clip) => clip.windReduction != null && clip.windReduction !== "inherit");
  const summaries: Record<ProjectSettingsSection, string> = {
    project: project.name,
    filters: `Wind: ${title(normalizeWindReduction(project.defaultWindReduction))} · ${overrides.length} override(s)`,
    graphics: `${project.clips.filter((clip) => clip.scorecard?.enabled).length} scorecard(s) · ${project.graphics?.styledTitles ? "Styled titles" : "Legacy titles"}`,
    music: project.music.enabled ? project.music.audioPath ? "Ready to mix" : "Audio file needed" : "Off",
    output: outputLabel(project),
  };
  return <section id="studio-project-settings" className="studio-project-settings" aria-label="Project settings">
    <div className="studio-project-bar">
      <h2 className="studio-panel-heading">Project settings</h2>
      <div className="studio-project-toggles" role="group" aria-label="Project settings sections">
        {sections.map((section) => <button key={section} type="button" id={`studio-project-toggle-${section}`}
          aria-label={title(section)} aria-expanded={expanded === section} aria-controls={`studio-project-panel-${section}`}
          aria-describedby={`studio-project-summary-${section}`}
          onClick={() => onSectionChange(expanded === section ? null : section)}>
          <span>{title(section)}</span><small id={`studio-project-summary-${section}`} title={summaries[section]}>{summaries[section]}</small>
        </button>)}
      </div>
    </div>
    <div id="studio-project-panel-project" className="studio-project-panel" role="region" aria-labelledby="studio-project-toggle-project" hidden={expanded !== "project"}>
      <h3 className="studio-panel-heading">Project details</h3>
      <fieldset disabled={busy}>
        <section className="mt-4 grid md:grid-cols-2 gap-4">
        <label>
          Project name
          <input
            className={input}
            maxLength={200}
            value={project.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label>
          Team description
          <input
            className={input}
            value={project.team}
            onChange={(e) => onChange({ team: e.target.value })}
            placeholder="Navy/white jerseys; yellow helmet covers in afternoon"
          />
        </label>
      </section>
      </fieldset>
      <button type="button" className="btn-secondary mt-4" onClick={onOpenTitles}>Edit opening title in Titles & graphics</button>
    </div>
    <div id="studio-project-panel-graphics" className="studio-project-panel" role="region" aria-labelledby="studio-project-toggle-graphics" hidden={expanded !== "graphics"}>
      <StudioProjectGraphics project={project} disabled={busy} onChange={onChange} />
      <button type="button" className="btn-secondary mt-4" onClick={onOpenTitles}>Preview opening title in Titles & graphics</button>
    </div>
    <div id="studio-project-panel-filters" className="studio-project-panel" role="region" aria-labelledby="studio-project-toggle-filters" hidden={expanded !== "filters"}>
      <div className="studio-project-filter-grid">
        <fieldset disabled={busy} className="studio-project-filter">
          <legend>Camera sound · wind reduction</legend>
          <label>Wind reduction default
            <select className={input} value={normalizeWindReduction(project.defaultWindReduction)}
              onChange={(event) => onChange({ defaultWindReduction: event.target.value as StudioProject["defaultWindReduction"] })}>
              {windReductionPresets.map((preset) => <option key={preset} value={preset}>{title(preset)}</option>)}
            </select>
          </label>
          <p>Clips using the project default follow changes here. Individual overrides, including Off, are kept. New clips follow this default.</p>
          <p className="text-cyan-200">{project.clips.length - overrides.length} following project · {overrides.length} override(s) across all {project.clips.length} clips</p>
          <button type="button" className="btn-secondary" disabled={busy || !overrides.length} onClick={onResetWind}>Reset all clips to project wind default</button>
          <p className="text-xs text-gray-400">Reset asks before replacing overrides, including excluded clips and explicit Off. Picture approval and cached video are preserved. Create a new final export to hear changes.</p>
          <p className="text-xs text-gray-400">Camera audio only, before music mixing. These bass/high-frequency cuts can soften wanted sounds too. Select a clip → Sound to compare its actual setting with the original.</p>
        </fieldset>
        <fieldset disabled={busy} className="studio-project-filter space-y-3">
          <legend>Picture · stabilisation defaults & performance</legend>
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
          <label>
            Stabiliser for new clips
            <select className={input} value={project.defaultStabilizationMethod} onChange={(e) => onChange({
              defaultStabilizationMethod: e.target.value as StudioProject["defaultStabilizationMethod"],
              ...(e.target.value === "quality" && project.defaultStabilization === "custom" ? { defaultStabilization: "balanced" as const } : {}),
            })}>
              <option value="fast">Fast — one pass</option>
              <option value="quality">Quality — two passes</option>
            </select>
          </label>
          <label>
            New clip preset
            <select className={input} value={project.defaultStabilization} onChange={(e) => onChange({ defaultStabilization: e.target.value as StudioProject["defaultStabilization"] })}>
              <option value="off">Off</option>
              <option value="gentle">Gentle — tracking pans</option>
              <option value="balanced">Balanced</option>
              <option value="strong">Strong</option>
              {project.defaultStabilizationMethod === "fast" && <option value="custom">Custom</option>}
            </select>
          </label>
          <label>
            Hardware use
            <select className={input} value={project.performance} onChange={(e) => onChange({ performance: e.target.value as StudioProject["performance"] })}>
              <option value="max">Maximum throughput</option>
              <option value="balanced">Balanced — more room for other apps</option>
            </select>
          </label>
          <label>
            Encoder
            <select aria-label="Encoder" className={input} value={project.encoderPreference} onChange={(e) => onChange({ encoderPreference: e.target.value as StudioProject["encoderPreference"] })}>
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
            onChange={(e) => onChange({ adaptiveScheduling: e.target.checked })}
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
        {project.defaultStabilization === "custom" && <StudioStabilizationFields value={project.defaultCustomStabilization} onChange={(defaultCustomStabilization) => onChange({ defaultCustomStabilization })} />}
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
          <button className="btn-secondary" disabled={!included.length || busy} onClick={() => onApplyStabilization(false)}>Apply to {included.length} included clip(s)</button>
          <button className="btn-secondary" disabled={!selectedClip || busy} onClick={() => onApplyStabilization(true)}>Apply to selected clip</button>
          <span className="text-xs text-amber-200">Applying defaults resets the affected clips’ review approval.</span>
        </div>

        </fieldset>
      </div>
    </div>
    <div id="studio-project-panel-music" className="studio-project-panel" role="region" aria-labelledby="studio-project-toggle-music" hidden={expanded !== "music"}>
      <p className="text-sm text-cyan-200">Music and the overall camera/music balance apply to the whole final video, not the selected clip. Camera wind reduction is applied before mixing; music is never wind-filtered.</p>
      <fieldset disabled={busy}>
        <StudioBackgroundMusic project={project} jobs={jobs} onChange={onMusicChange} busy={busy}
          onError={onError} onMessage={onMessage} getStagingDir={getStagingDir} />
      </fieldset>
    </div>
    <div id="studio-project-panel-output" className="studio-project-panel" role="region" aria-labelledby="studio-project-toggle-output" hidden={expanded !== "output"}>
      <fieldset disabled={busy}><StudioOutputSettings project={project} onChange={onChange} onFolder={onOutputFolder} /></fieldset>
    </div>
  </section>;
}
