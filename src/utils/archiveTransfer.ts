import type { ArchivePreferences, ArchiveRuleMode, ArchiveVariantKey } from "../types/archiveTransfer";

export const ARCHIVE_PREFERENCES_KEY = "photogogo.archive-rules.v1";
export const ARCHIVE_CONCURRENCY_KEY = "photogogo.archive-concurrency.v1";
export function readArchiveConcurrency(): string {
  try { const value=localStorage.getItem(ARCHIVE_CONCURRENCY_KEY); if(value && ["auto","1","2","4","8"].includes(value))return value; } catch { /* Safe default. */ }
  return "auto";
}
export const ARCHIVE_VARIANTS: Array<{ key: ArchiveVariantKey; label: string }> = [
  { key: "originals", label: "Originals" }, { key: "bw", label: "B&W" },
  { key: "enhanced", label: "Enhanced" }, { key: "crops", label: "Crops" },
  { key: "cropBw", label: "Cropped B&W" }, { key: "cropEnhanced", label: "Cropped enhanced" },
];
const MODES: ArchiveRuleMode[] = ["all", "rated", "google_selected", "none"];
export function archiveDefaults(): ArchivePreferences {
  return {
    rules: {
      originals: { mode: "all", minStars: 1 }, bw: { mode: "google_selected", minStars: 1 },
      enhanced: { mode: "google_selected", minStars: 1 }, crops: { mode: "google_selected", minStars: 1 },
      cropBw: { mode: "google_selected", minStars: 1 }, cropEnhanced: { mode: "google_selected", minStars: 1 },
    },
    excludeTrash: true, includeVideos: true, includeSourceOriginals: false,
    includeLibraryMetadata: false, includeCameraSidecars: true,
  };
}
/** Only known rule values are restored. Paths and native preview tokens never persist. */
export function readArchivePreferences(): ArchivePreferences {
  const preferences = archiveDefaults();
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_PREFERENCES_KEY) || "null");
    if (!raw || typeof raw !== "object") return preferences;
    for (const { key } of ARCHIVE_VARIANTS) {
      const rule = raw.rules?.[key];
      if (MODES.includes(rule?.mode)) preferences.rules[key].mode = rule.mode;
      if (Number.isInteger(rule?.minStars) && rule.minStars >= 1 && rule.minStars <= 3) preferences.rules[key].minStars = rule.minStars;
    }
    for (const key of ["excludeTrash", "includeVideos", "includeSourceOriginals", "includeLibraryMetadata", "includeCameraSidecars"] as const) {
      if (typeof raw[key] === "boolean") preferences[key] = raw[key];
    }
  } catch { /* Invalid or inaccessible preferences use safe defaults. */ }
  return preferences;
}
export function archivePreset(id: string): ArchivePreferences {
  const preferences = archiveDefaults();
  if (id === "rated") preferences.rules.originals.mode = "rated";
  if (id === "originals") {
    for (const { key } of ARCHIVE_VARIANTS) if (key !== "originals") preferences.rules[key].mode = "none";
    preferences.includeVideos = false;
  }
  if (id === "all") for (const { key } of ARCHIVE_VARIANTS) preferences.rules[key].mode = "all";
  if (id === "selected") {
    for (const { key } of ARCHIVE_VARIANTS) preferences.rules[key].mode = "google_selected";
    preferences.includeVideos = false;
  }
  return preferences;
}
export function archiveKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    original: "Originals", originals: "Originals", bw: "B&W", enhanced: "Enhanced",
    crop: "Crops", crops: "Crops", crop_bw: "Cropped B&W", cropBw: "Cropped B&W",
    crop_enhanced: "Cropped enhanced", cropEnhanced: "Cropped enhanced",
    video: "Videos", videos: "Videos", metadata: "Library metadata", library_metadata: "Library metadata",
    sidecar: "Camera / user sidecars", camera_sidecar: "Camera / user sidecars", camera_sidecars: "Camera / user sidecars",
    cache: "PhotoGoGo cache", app_working_files: "PhotoGoGo working files", temporary: "Temporary files",
    unresolved: "Needs classification", unknown: "Other files", other: "Other files",
  };
  return labels[kind] || kind.replace(/_/g, " ");
}
export function archiveBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
