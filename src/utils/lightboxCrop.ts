import type { CropRect } from "../types/lightboxCrop";
export type CropHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const limit = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
export function cropPixelSize(rect: CropRect, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  return {
    width: Math.min(sourceWidth, Math.ceil((rect.x + rect.width) * sourceWidth)) - Math.floor(rect.x * sourceWidth),
    height: Math.min(sourceHeight, Math.ceil((rect.y + rect.height) * sourceHeight)) - Math.floor(rect.y * sourceHeight),
  };
}
export function validCrop(value?: CropRect | null): value is CropRect {
  return !!value && Object.values(value).every(Number.isFinite) && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 && value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001;
}
/** Ratio is in displayed source pixels; coordinates always remain normalized. */
export function fitCropRatio(rect: CropRect, pixelRatio: number | null, sourceWidth: number, sourceHeight: number): CropRect {
  if (!pixelRatio) return { ...rect };
  const ratio = pixelRatio * sourceHeight / sourceWidth;
  let width = rect.width, height = width / ratio;
  if (height > rect.height) { height = rect.height; width = height * ratio; }
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}
export function dragCrop(start: CropRect, handle: CropHandle, dx: number, dy: number, pixelRatio: number | null, sourceWidth: number, sourceHeight: number): CropRect {
  if (![dx, dy].every(Number.isFinite)) return start;
  if (handle === "move") return { ...start, x: limit(start.x + dx, 0, 1 - start.width), y: limit(start.y + dy, 0, 1 - start.height) };
  const minWidth = Math.min(start.width, 16 / sourceWidth), minHeight = Math.min(start.height, 16 / sourceHeight);
  const west = handle.includes("w"), east = handle.includes("e"), north = handle.includes("n"), south = handle.includes("s");
  let left = start.x, top = start.y, right = left + start.width, bottom = top + start.height;
  if (!pixelRatio) {
    if (west) left = limit(left + dx, 0, right - minWidth);
    if (east) right = limit(right + dx, left + minWidth, 1);
    if (north) top = limit(top + dy, 0, bottom - minHeight);
    if (south) bottom = limit(bottom + dy, top + minHeight, 1);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  const ratio = pixelRatio * sourceHeight / sourceWidth;
  const centreX = (left + right) / 2, centreY = (top + bottom) / 2;
  if ((west || east) && (north || south)) {
    const anchorX = west ? right : left, anchorY = north ? bottom : top;
    const proposedWidth = start.width + (west ? -dx : dx), proposedHeight = start.height + (north ? -dy : dy);
    const byWidth = Math.abs(dx) >= Math.abs(dy * ratio);
    const maxWidth = Math.min(west ? anchorX : 1 - anchorX, (north ? anchorY : 1 - anchorY) * ratio);
    const width = limit(byWidth ? proposedWidth : proposedHeight * ratio, Math.min(maxWidth, Math.max(minWidth, minHeight * ratio)), maxWidth);
    const height = width / ratio;
    return { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
  }
  if (west || east) {
    const anchorX = west ? right : left;
    const maxWidth = Math.min(west ? anchorX : 1 - anchorX, 2 * Math.min(centreY, 1 - centreY) * ratio);
    const width = limit(start.width + (west ? -dx : dx), Math.min(maxWidth, Math.max(minWidth, minHeight * ratio)), maxWidth);
    const height = width / ratio;
    return { x: west ? anchorX - width : anchorX, y: centreY - height / 2, width, height };
  }
  const anchorY = north ? bottom : top;
  const maxHeight = Math.min(north ? anchorY : 1 - anchorY, 2 * Math.min(centreX, 1 - centreX) / ratio);
  const height = limit(start.height + (north ? -dy : dy), Math.min(maxHeight, Math.max(minHeight, minWidth / ratio)), maxHeight);
  const width = height * ratio;
  return { x: centreX - width / 2, y: north ? anchorY - height : anchorY, width, height };
}
