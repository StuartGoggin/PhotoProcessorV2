import type { ProcessScopeMode } from "./api";
import type { BwParams } from "./photoProcess";

export type RawPreset = "natural" | "neutral" | "highIso" | "custom";
export type RawSelection = "all" | "nonTrash" | "minRating" | "selected";
/** Versioned portable development recipe; no display thumbnail is an export. */
export interface RawRecipe {
  schemaVersion: 1;
  preset: RawPreset;
  whiteBalance: "asShot" | "auto" | "custom";
  temperature: number;
  tint: number;
  autoExposure: boolean;
  exposure: number;
  highlights: number;
  shadows: number;
  blackPoint: number;
  contrast: number;
  saturation: number;
  curveStrength: number;
  sharpening: number;
  luminanceNoise: number;
  chromaNoise: number;
  output: "jpeg" | "tiff16";
  colour: boolean;
  bw: boolean;
  keepGps: boolean;
  bwParams: BwParams;
}
export interface RawScope {
  stagingDir: string;
  scopeDir: string;
  scopeMode: ProcessScopeMode;
  selection: RawSelection;
  minRating: number;
  selectedPaths?: string[];
}
/** A saved override controls future jobs; the applied recipe is history only. */
export interface RawRecipeRecord {
  recipe: RawRecipe | null;
  lastAppliedRecipe?: RawRecipe | null;
}
export interface RawCandidates {
  paths: string[];
  total: number;
  truncated: boolean;
  runtime?: { available: boolean; version: string; message: string };
}
export interface RawHistogram {
  red: number[];
  green: number[];
  blue: number[];
  shadowPercent: number;
  highlightPercent: number;
}
export interface RawPreviewResult {
  path: string;
  original?: string | null;
  processed: string;
  width: number;
  height: number;
  originalWidth?: number;
  originalHeight?: number;
  fullResolution: boolean;
  elapsedMs: number;
  warning: string;
  sourceLabel?: string;
  histogram?: RawHistogram;
}
