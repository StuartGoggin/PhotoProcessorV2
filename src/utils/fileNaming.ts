/**
 * Utilities for encoding star ratings and trash markers in filenames.
 *
 * Convention:
 *   {Like o}   = 1 star
 *   {Like oo}  = 2 stars
 *   {Like ooo} = 3 stars
 *   {trash}    = marked for deletion
 *
 * Tags are inserted before the file extension, e.g.:
 *   20240101_120000{Like oo}.jpg
 */

const STAR_TAGS = ["{Like ooo}", "{Like oo}", "{Like o}"] as const;

/** Extract star rating (0–3) from a filename. */
export function parseStars(filename: string): number {
  if (filename.includes("{Like ooo}")) return 3;
  if (filename.includes("{Like oo}")) return 2;
  if (filename.includes("{Like o}")) return 1;
  return 0;
}

/** Remove all star tags from a filename. */
function stripStars(filename: string): string {
  return STAR_TAGS.reduce((name, tag) => name.replace(new RegExp(escapeRegex(tag), "g"), ""), filename).trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return filename with the given star rating applied (0 = no stars). */
export function applyStars(filename: string, stars: number): string {
  const name = stripStars(filename);
  if (stars === 0) return name;
  const tag = stars === 3 ? "{Like ooo}" : stars === 2 ? "{Like oo}" : "{Like o}";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name + tag : name.slice(0, dot) + tag + name.slice(dot);
}

/** Return true if the filename carries the trash marker. */
export function isTrashed(filename: string): boolean {
  return filename.includes("{trash}");
}

/** Return filename with the trash marker applied or removed. */
export function applyTrash(filename: string, trashed: boolean): string {
  const clean = filename.replace(/\{trash\}/g, "").trim();
  if (!trashed) return clean;
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? clean + "{trash}" : clean.slice(0, dot) + "{trash}" + clean.slice(dot);
}
