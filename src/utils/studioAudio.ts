import type { StudioClip, StudioProject, StudioWindReductionPreset } from "../types/videoStudio";

export const windReductionPresets: readonly StudioWindReductionPreset[] = ["off", "light", "moderate", "strong"];

// Unknown input must never enable sound processing. Keep saved invalid values
// intact for native validation; this helper only resolves what the UI can use.
export function normalizeWindReduction(value: unknown): StudioWindReductionPreset {
  return windReductionPresets.includes(value as StudioWindReductionPreset) ? value as StudioWindReductionPreset : "off";
}

export function effectiveWindReduction(
  project: Pick<StudioProject, "defaultWindReduction">,
  clip: Pick<StudioClip, "windReduction">,
): StudioWindReductionPreset {
  return clip.windReduction == null || clip.windReduction === "inherit"
    ? normalizeWindReduction(project.defaultWindReduction)
    : normalizeWindReduction(clip.windReduction);
}

export function previewStartSeconds(value: number, duration: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(value, Math.max(0, duration - 0.1)));
}
