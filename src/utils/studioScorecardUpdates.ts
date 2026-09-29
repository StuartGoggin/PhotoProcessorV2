import type { StudioProject } from "../types/videoStudio";

export const scorecardTextFields = ["heading", "result", "subtitle"] as const;
export type ScorecardTextField = typeof scorecardTextFields[number];
export const scorecardTextLabels: Record<ScorecardTextField, string> = {
  heading: "Top line / heading", result: "Main line / result", subtitle: "Bottom line / subtitle",
};
export interface ScorecardTextUpdate {
  key: string;
  clipId: string;
  clipName: string;
  clipNumber: number;
  enabled: boolean;
  included: boolean;
  field: ScorecardTextField;
  before: string;
  after: string;
}
export interface ScorecardUpdatePlan { snapshot: string; items: ScorecardTextUpdate[] }

// Fence only the review's inputs. Background render completions, review approval,
// music edits and other unrelated project state must not be copied from a stale plan.
export function scorecardUpdateSnapshot(project: StudioProject): string {
  return JSON.stringify([project.graphics?.scorecardTemplate ?? null,
    project.clips.map(c => [c.id, c.path, c.chapter, c.include, c.scorecard ?? null])]);
}
export function planScorecardTextUpdates(project: StudioProject): ScorecardUpdatePlan {
  const template = project.graphics?.scorecardTemplate;
  const items: ScorecardTextUpdate[] = [];
  if (template?.enabled) project.clips.forEach((clip, index) => {
    if (!clip.scorecard) return;
    for (const field of scorecardTextFields) {
      const before = clip.scorecard[field], after = template[field] ?? "";
      if (before === after) continue;
      items.push({ key: JSON.stringify([clip.id, field]), clipId: clip.id,
        clipName: clip.chapter || clip.path.split(/[\\/]/).pop() || `Clip ${index + 1}`,
        clipNumber: index + 1, enabled: clip.scorecard.enabled, included: clip.include, field, before, after });
    }
  });
  return { snapshot: scorecardUpdateSnapshot(project), items };
}

export function applyScorecardTextUpdates(project: StudioProject, plan: ScorecardUpdatePlan, selectedKeys: readonly string[]): StudioProject {
  if (scorecardUpdateSnapshot(project) !== plan.snapshot) throw new Error("The project or defaults changed. Refresh the review and choose the text changes again. Nothing was updated.");
  if (new Set(project.clips.map(c => c.id)).size !== project.clips.length) throw new Error("Clip identifiers are duplicated. Reopen a valid project before updating scorecards.");
  // Recompute trusted values from the current project, not mutable UI plan rows.
  const candidates = new Map(planScorecardTextUpdates(project).items.map(item => [item.key, item]));
  const selected = new Set(selectedKeys);
  if ([...selected].some(key => !candidates.has(key))) throw new Error("The selected text changes are no longer available. Refresh the review. Nothing was updated.");
  if (!selected.size) return project;
  const changes = new Map<string, Partial<Record<ScorecardTextField, string>>>();
  for (const key of selected) {
    const item = candidates.get(key)!;
    changes.set(item.clipId, { ...changes.get(item.clipId), [item.field]: item.after });
  }
  return { ...project, clips: project.clips.map(clip => {
    const text = changes.get(clip.id);
    // Never change enabled, layout, scores in table cells, timing or picture state.
    return text ? { ...clip, scorecard: { ...clip.scorecard!, ...text } } : clip;
  }) };
}
