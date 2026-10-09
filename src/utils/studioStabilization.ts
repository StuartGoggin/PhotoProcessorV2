import type { StudioClip, StudioProject } from "../types/videoStudio";

export const GPU_TRIPOD_ENGINE = "gpu-tripod-d3d11-v1";

export const effectiveStabilizationEngine = (clip: StudioClip): string =>
  clip.stabilization !== "off" && clip.stabilizationMethod === "gpuTripod" ? GPU_TRIPOD_ENGINE : "";

// Match native stabilization::prevent_rotation: dormant settings do not stale video.
export const effectivePreventRotation = (project: Pick<StudioProject, "defaultPreventRotation">, clip: StudioClip): boolean =>
  clip.stabilization !== "off" && (clip.stabilizationMethod === "gpuTripod"
    || ((clip.stabilizationMethod ?? "quality") === "quality"
      && (clip.preventRotation ?? project.defaultPreventRotation ?? false)));
