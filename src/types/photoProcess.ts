import type { ProcessScopeMode, ProcessTask, StabilizationMode, StabilizationStrength } from "./api";

export interface BwParams {
  localContrast: number;
  sharpness: number;
  curveStrength: number;
  shadowDepth: number;
  highlightLift: number;
  midpoint: number;
}
export const DEFAULT_BW: BwParams = { localContrast: 1, sharpness: 0.6, curveStrength: 0.25, shadowDepth: 0.12, highlightLift: 0.12, midpoint: 0.5 };

export interface ProcessPreviewRequest {
  stagingDir: string;
  scopeDir: string;
  scopeMode: ProcessScopeMode;
  task: ProcessTask;
  path?: string;
  fullResolution?: boolean;
  startSeconds?: number;
  enhanceContrastLevel?: number;
  enhanceSharpnessLevel?: number;
  bwParams?: BwParams;
  stabilizationMode?: StabilizationMode;
  stabilizationStrength?: StabilizationStrength;
  preserveSourceBitrate?: boolean;
}
export interface ProcessPreviewCandidates { paths: string[]; total: number; truncated: boolean }
export interface ProcessPreviewResult {
  kind: "image" | "focus" | "video" | "cleanup";
  path?: string;
  original?: string;
  processed?: string;
  width?: number;
  height?: number;
  fullResolution?: boolean;
  focus?: { max: number; average: number; percent: number; flagged: boolean };
  affected?: string[];
  total?: number;
  warning: string;
  elapsedMs: number;
}
