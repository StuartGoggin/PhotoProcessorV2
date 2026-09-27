import type { StudioClip, StudioProject } from "../types/videoStudio";

// Match native stabilization::prevent_rotation: dormant settings do not stale video.
export const effectivePreventRotation = (project: Pick<StudioProject, "defaultPreventRotation">, clip: StudioClip): boolean =>
  clip.stabilization !== "off" && (clip.stabilizationMethod ?? "quality") === "quality"
    && (clip.preventRotation ?? project.defaultPreventRotation ?? false);
