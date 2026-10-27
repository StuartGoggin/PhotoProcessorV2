import { DEFAULT_BW } from "../types/photoProcess";
import type { RawPreset, RawRecipe } from "../types/rawDevelopment";

export const RAW_DEFAULTS_KEY = "photogogo.rawDevelopment.defaults.v1";
const bounded = (value: unknown, min: number, max: number, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function rawPreset(preset: Exclude<RawPreset, "custom">): RawRecipe {
  const neutral = preset === "neutral";
  const highIso = preset === "highIso";
  const web = preset === "webBright";
  return {
    schemaVersion: 1, preset, whiteBalance: "asShot", temperature: 6500, tint: 1,
    autoExposure: web, finishingStrength:web?65:0, exposure: 0, highlights: neutral ? 0 : 20, shadows: 0, blackPoint: 0,
    contrast: 0, saturation: 0, curveStrength: neutral ? 0 : 0.15,
    sharpening: neutral ? 0 : highIso ? 10 : 20,
    luminanceNoise: highIso ? 20 : 0, chromaNoise: neutral ? 0 : highIso ? 30 : 15,
    output: "jpeg", colour: true, bw: false, keepGps: true, bwParams: { ...DEFAULT_BW },
  };
}

export function normalizeRawRecipe(value?: Partial<RawRecipe> | null): RawRecipe {
  const base = rawPreset("natural");
  const bw = value?.bwParams;
  return {
    ...base,
    preset: ["natural", "neutral", "highIso", "webBright", "custom"].includes(value?.preset || "") ? value!.preset! : base.preset,
    whiteBalance: ["asShot", "auto", "custom"].includes(value?.whiteBalance || "") ? value!.whiteBalance! : base.whiteBalance,
    temperature: bounded(value?.temperature, 2000, 12000, base.temperature),
    tint: bounded(value?.tint, .5, 2, base.tint),
    autoExposure: typeof value?.autoExposure === "boolean" ? value.autoExposure : false,
    finishingStrength: bounded(value?.finishingStrength,0,100,0),
    exposure: bounded(value?.exposure, -3, 3, base.exposure),
    highlights: bounded(value?.highlights, 0, 100, base.highlights),
    shadows: bounded(value?.shadows, 0, 100, base.shadows),
    blackPoint: bounded(value?.blackPoint, -100, 100, base.blackPoint),
    contrast: bounded(value?.contrast, -100, 100, base.contrast),
    saturation: bounded(value?.saturation, -100, 100, base.saturation),
    curveStrength: bounded(value?.curveStrength, 0, 1, base.curveStrength),
    sharpening: bounded(value?.sharpening, 0, 100, base.sharpening),
    luminanceNoise: bounded(value?.luminanceNoise, 0, 100, base.luminanceNoise),
    chromaNoise: bounded(value?.chromaNoise, 0, 100, base.chromaNoise),
    output: value?.output === "tiff16" ? "tiff16" : "jpeg",
    colour: typeof value?.colour === "boolean" ? value.colour : true,
    bw: typeof value?.bw === "boolean" ? value.bw : false,
    keepGps: typeof value?.keepGps === "boolean" ? value.keepGps : true,
    bwParams: {
      localContrast: bounded(bw?.localContrast, 0, 1, DEFAULT_BW.localContrast),
      sharpness: bounded(bw?.sharpness, 0, 1, DEFAULT_BW.sharpness),
      curveStrength: bounded(bw?.curveStrength, 0, 1, DEFAULT_BW.curveStrength),
      shadowDepth: bounded(bw?.shadowDepth, 0, .25, DEFAULT_BW.shadowDepth),
      highlightLift: bounded(bw?.highlightLift, 0, .25, DEFAULT_BW.highlightLift),
      midpoint: bounded(bw?.midpoint, .25, .75, DEFAULT_BW.midpoint),
    },
  };
}

export function loadRawDefaults(): RawRecipe {
  try { return normalizeRawRecipe(JSON.parse(localStorage.getItem(RAW_DEFAULTS_KEY) || "null")); }
  catch { return rawPreset("natural"); }
}
export function saveRawDefaults(recipe: RawRecipe): boolean {
  try { localStorage.setItem(RAW_DEFAULTS_KEY, JSON.stringify(normalizeRawRecipe(recipe))); return true; }
  catch { return false; }
}
