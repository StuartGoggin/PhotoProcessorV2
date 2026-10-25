import { DEFAULT_BW, type BwParams } from "../types/photoProcess";

export interface PhotoProcessRecipe { bwParams: BwParams; enhanceContrastLevel: number; enhanceSharpnessLevel: number }
export const PHOTO_PROCESS_RECIPE_KEY = "photogogo.photoProcess.recipe.v1";
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function normalizePhotoProcessRecipe(value?: Partial<PhotoProcessRecipe> | null): PhotoProcessRecipe {
  const bw = value?.bwParams;
  return {
    bwParams: {
      localContrast: clamp(bw?.localContrast, 0, 1, DEFAULT_BW.localContrast),
      sharpness: clamp(bw?.sharpness, 0, 1, DEFAULT_BW.sharpness),
      curveStrength: clamp(bw?.curveStrength, 0, 1, DEFAULT_BW.curveStrength),
      shadowDepth: clamp(bw?.shadowDepth, 0, .25, DEFAULT_BW.shadowDepth),
      highlightLift: clamp(bw?.highlightLift, 0, .25, DEFAULT_BW.highlightLift),
      midpoint: clamp(bw?.midpoint, .25, .75, DEFAULT_BW.midpoint),
    },
    enhanceContrastLevel: clamp(value?.enhanceContrastLevel, 0, 2, 1),
    enhanceSharpnessLevel: clamp(value?.enhanceSharpnessLevel, 0, 1, .5),
  };
}
export function loadPhotoProcessRecipe(): PhotoProcessRecipe {
  try { return normalizePhotoProcessRecipe(JSON.parse(localStorage.getItem(PHOTO_PROCESS_RECIPE_KEY) ?? "null")); }
  catch { return normalizePhotoProcessRecipe(); }
}
export function savePhotoProcessRecipe(recipe: PhotoProcessRecipe): void {
  try { localStorage.setItem(PHOTO_PROCESS_RECIPE_KEY, JSON.stringify(normalizePhotoProcessRecipe(recipe))); }
  catch { /* Storage may be disabled: the current operation still has its recipe. */ }
}
