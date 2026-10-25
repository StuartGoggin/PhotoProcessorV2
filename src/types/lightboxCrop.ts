import type { PhotoProcessRecipe } from "../utils/photoProcessRecipe";
export interface CropRect { x: number; y: number; width: number; height: number }
export interface LightboxCropInfo { width: number; height: number; sourceFingerprint: string; original: string; crop?: CropRect | null; hasCrop: boolean }
export interface LightboxCropRequest extends PhotoProcessRecipe {
  stagingDir: string; path: string; sourceFingerprint: string; crop: CropRect;
  regenerateBw: boolean; regenerateEnhanced: boolean;
}
export interface LightboxCropResult { cropPath: string; width: number; height: number; outputs: string[]; errors: string[] }
