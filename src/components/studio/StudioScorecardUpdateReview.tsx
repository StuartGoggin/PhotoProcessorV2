import { useEffect, useRef, useState } from "react";
import type { StudioProject } from "../../types/videoStudio";
import { planScorecardTextUpdates, scorecardTextLabels, scorecardUpdateSnapshot, type ScorecardUpdatePlan } from "../../utils/studioScorecardUpdates";

export type ApplyScorecardUpdates = (plan: ScorecardUpdatePlan, selectedKeys: string[]) => string | null;

const showText = (text: string) => text.length === 0 ? "(blank)" : text.trim().length === 0 ? "(whitespace only)" : text;

export default function StudioScorecardUpdateReview({ project, disabled, onApply, onClose }: {
  project: StudioProject;
  disabled: boolean;
  onApply: ApplyScorecardUpdates;
  onClose: (message?: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState(() => planScorecardTextUpdates(project));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const stale = plan.snapshot !== scorecardUpdateSnapshot(project);
  const selectedItems = plan.items.filter(item => selected.has(item.key));
  const replacing = selectedItems.filter(item => item.before.length > 0).length;
  const clearing = selectedItems.filter(item => item.before.length > 0 && !item.after.trim()).length;
  const visible = plan.items.filter(item => `${item.clipNumber} ${item.clipName}`.toLowerCase().includes(search.toLowerCase()));
  const groups = [...new Set(visible.map(item => item.clipId))].map(id => visible.filter(item => item.clipId === id));
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  function refresh() {
    if (disabled) return;
    setPlan(planScorecardTextUpdates(project)); setSelected(new Set()); setError("");
  }
  function apply() {
    if (disabled || stale || !selectedItems.length) return;
    const failure = onApply(plan, [...selected]);
    if (failure) { setError(failure); return; }
    const cards = new Set(selectedItems.map(item => item.clipId)).size;
    onClose(`Updated ${selectedItems.length} text item(s) across ${cards} scorecard(s). Unselected text and every card’s on/off setting were kept. Stabilised video is unchanged. Create a new final export to see enabled-card changes.`);
  }
  return <dialog ref={dialog} className="studio-score-update-dialog" aria-labelledby="score-update-title" aria-describedby="score-update-help"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="studio-score-update-header">
      <div><p className="studio-score-update-kicker">PROJECT DEFAULTS → CLIP TEXT</p><h2 id="score-update-title">Review scorecard text updates</h2></div>
      <button type="button" className="btn-secondary" autoFocus onClick={() => onClose()}>Cancel</button>
    </header>
    <div className="studio-score-update-body">
      <p id="score-update-help">Choose each text item you want to update. Nothing is selected automatically. Unchecked items stay exactly as they are. Only differing text is listed.</p>
      <p className="studio-score-update-warning"><strong>Existing text is protected until you select it.</strong> Replacing a line can overwrite a score or name. An empty project default will clear that line if selected.</p>
      <p className="studio-graphics-help">Card on/off settings, layouts, table cells, timing, clip approval and stabilised video are not changed. Excluded clips and cards switched off are labelled below.</p>
      <div className="studio-score-update-tools">
        <label>Find a clip<input type="search" aria-label="Find a clip in scorecard review" value={search} onChange={e => setSearch(e.target.value)} placeholder="Clip name or number" /></label>
        <button type="button" className="btn-secondary" disabled={disabled || stale} onClick={() => setSelected(new Set(plan.items.filter(item => item.before.length === 0 && item.after.length > 0).map(item => item.key)))}>Select blank items · all clips</button>
        <button type="button" className="btn-secondary" disabled={disabled || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>
      {stale && <p role="alert" className="studio-score-update-warning">The project or defaults changed. Nothing has been applied. <button type="button" className="btn-secondary" disabled={disabled} onClick={refresh}>Refresh review</button> to review again; this clears your selections.</p>}
      {error && <p role="alert" className="studio-score-update-warning">{error}</p>}
      {!plan.items.length && <p role="status">No text changes to apply. Configured scorecards already match these defaults.</p>}
      {!!plan.items.length && !groups.length && <p role="status">No clips match this search. Selections on other clips are retained.</p>}
      <div className="studio-score-update-clips">
        {groups.map(items => <section className="studio-score-update-clip" key={items[0].clipId} aria-label={`Clip ${items[0].clipNumber}: ${items[0].clipName}`}>
          <h3><span>{String(items[0].clipNumber).padStart(2, "0")}</span> {items[0].clipName}</h3>
          <p className="studio-graphics-help">Scorecard {items[0].enabled ? "ON — selected changes affect the next final export" : "OFF — remains off after updating"}{!items[0].included && " · Clip excluded from final video"}</p>
          {items.map(item => <div className={`studio-score-update-item${selected.has(item.key) ? " is-selected" : ""}`} key={item.key}>
            <label className="studio-graphics-check"><input type="checkbox" aria-label={`Update ${scorecardTextLabels[item.field]} for clip ${item.clipNumber}: ${item.clipName}`}
              checked={selected.has(item.key)} disabled={disabled || stale} onChange={event => setSelected(previous => {
                const next = new Set(previous); if (event.target.checked) next.add(item.key); else next.delete(item.key); return next;
              })} />{scorecardTextLabels[item.field]}</label>
            <span className={item.before.length > 0 ? "studio-score-update-replace" : "studio-graphics-help"}>{item.before.length > 0 ? !item.after.trim() ? "Will clear existing text if selected" : "Will replace existing text if selected" : "Will fill a blank line if selected"}</span>
            <div className="studio-score-update-comparison"><div><small>Current clip text</small><p>{showText(item.before)}</p></div><div><small>Proposed project text</small><p>{showText(item.after)}</p></div></div>
          </div>)}
        </section>)}
      </div>
    </div>
    <footer className="studio-score-update-footer">
      <div aria-live="polite"><strong>{selectedItems.length} of {plan.items.length} text changes selected</strong><p>{replacing} replace existing text{clearing ? ` · ${clearing} clear a line` : ""}{search ? " · Counts include clips hidden by your search" : ""}</p></div>
      <button type="button" className="btn-primary" disabled={disabled || stale || !selectedItems.length} onClick={apply}>Apply {selectedItems.length} selected text change{selectedItems.length === 1 ? "" : "s"}</button>
    </footer>
  </dialog>;
}
