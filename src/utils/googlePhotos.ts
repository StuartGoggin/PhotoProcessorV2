import type { GooglePhotoAsset, GooglePhotoPlanItem, GooglePhotoVariant } from "../types/googlePhotos";

export const GOOGLE_PHOTO_VARIANTS: { id: GooglePhotoVariant; label: string }[] = [
  { id: "original", label: "Original" }, { id: "bw", label: "B&W" }, { id: "enhanced", label: "Enhanced" },
  { id: "crop", label: "Crop" }, { id: "crop_bw", label: "Crop B&W" }, { id: "crop_enhanced", label: "Crop enhanced" },
];
export const googlePhotoPathKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();
export const googlePhotoVariantLabel = (variant: GooglePhotoVariant) => GOOGLE_PHOTO_VARIANTS.find(item => item.id === variant)?.label ?? variant;
export function googlePhotoAssetForPath(assets: GooglePhotoAsset[], path: string | undefined) {
  if (!path) return undefined;
  const wanted = googlePhotoPathKey(path);
  const matches = assets.filter(asset => googlePhotoPathKey(asset.relativePath) === wanted);
  // Never attach a checkbox to an ambiguous version.
  return matches.length === 1 ? matches[0] : undefined;
}
export function googlePhotoSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
export function googlePhotoCounts(items: GooglePhotoPlanItem[]) {
  const result = { ready: 0, changed: 0, skipped: 0, blocked: 0 };
  for (const item of items) {
    if (item.status === "ready") result.ready++;
    else if (item.status === "changed") { result.ready++; result.changed++; }
    else if (item.status === "already_uploaded") result.skipped++;
    else result.blocked++;
  }
  return result;
}
