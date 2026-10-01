import type { SnapshotClip, SnapshotFrame, SnapshotRecipe, SnapshotSelection, SnapshotSession, SnapshotSource } from "../types/videoSnapshots";

export const MAX_SNAPSHOT_CLIPS = 64;
export const MAX_SNAPSHOTS = 200;
const MAX_FRAME_INDEX = 10_000_000;

export function snapshotTime(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const seconds = Math.floor(value / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`;
}

/** An explicit offset is required; local dates cannot silently inherit this PC's zone. */
export function validShootingStart(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function snapshotCapturedAt(start: string, atMs: number): string | null {
  if (!validShootingStart(start) || !Number.isFinite(atMs)) return null;
  const timestamp = Date.parse(start) + atMs;
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? new Date(timestamp).toISOString() : null;
}

export function frameAtTime(times: number[], atMs: number): number {
  let low = 0, high = times.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (times[mid] <= atMs) low = mid; else high = mid - 1;
  }
  return Math.max(0, low);
}

export function snapshotPathKey(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/\//g, "\\").toLowerCase();
}

/** A previous receipt is not proof that a photo was saved into a newly chosen folder. */
export function snapshotExportMatchesDestination(photo: SnapshotSelection, destination: string): boolean {
  const folderKey = (path: string) => snapshotPathKey(path).replace(/\\+$/, "");
  return !!photo.exported && !!photo.exportedDestination && !!destination
    && folderKey(photo.exportedDestination) === folderKey(destination);
}

export function validateSnapshotClip(clip: SnapshotClip): SnapshotClip {
  if (!clip || typeof clip.id !== "string" || !clip.id || typeof clip.identity !== "string" || !clip.identity || typeof clip.path !== "string" || typeof clip.name !== "string" || !Array.isArray(clip.frameTimesMs) || !clip.frameTimesMs.length || clip.frameTimesMs.length > MAX_FRAME_INDEX || !Number.isFinite(clip.width) || clip.width <= 0 || !Number.isFinite(clip.height) || clip.height <= 0) throw new Error("The video did not return a usable original-frame index.");
  let previous = -1;
  for (const time of clip.frameTimesMs) {
    if (!Number.isFinite(time) || time < 0 || time < previous) throw new Error("The video's frame timestamps are invalid.");
    previous = time;
  }
  return clip;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, limit: number, empty = false): string {
  if (typeof value !== "string" || value.length > limit || (!empty && !value.trim()) || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label} is outside its supported range.`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

export function validateSnapshotRecipe(value: unknown): SnapshotRecipe {
  const r = record(value, "Photo adjustments");
  const recipe: SnapshotRecipe = {
    brightness: number(r.brightness, "Brightness", -0.5, 0.5),
    contrast: number(r.contrast, "Contrast", -50, 50),
    sharpness: number(r.sharpness, "Sharpness", 0, 2),
    crop: null,
  };
  if (r.crop !== null) {
    const c = record(r.crop, "Crop");
    const crop = { x: number(c.x, "Crop left", 0, 1), y: number(c.y, "Crop top", 0, 1), width: number(c.width, "Crop width", 0.01, 1), height: number(c.height, "Crop height", 0.01, 1) };
    if (crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) throw new Error("The crop extends beyond the photo.");
    recipe.crop = crop;
  }
  return recipe;
}

/** Read only the known bounded fields. No identifiers, previews or frame indexes are trusted. */
export function parseSnapshotSession(json: string): SnapshotSession {
  if (json.length > 2 * 1024 * 1024) throw new Error("This session is too large (maximum 2 MB).");
  const root = record(JSON.parse(json), "Session");
  if (root.kind !== "photogogo-video-snapshots" || root.version !== 1) throw new Error("Choose a PhotoGoGo Video Snapshots session (version 1).");
  if (!Array.isArray(root.sources) || root.sources.length > MAX_SNAPSHOT_CLIPS || !Array.isArray(root.selections) || root.selections.length > MAX_SNAPSHOTS) throw new Error("A session supports up to 64 videos and 200 photos.");
  const seen = new Set<string>();
  const sources = root.sources.map((value) => {
    const s = record(value, "Video");
    const path = text(s.path, "Video path", 32767);
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(path)) throw new Error("Session videos must use absolute local paths.");
    const key = snapshotPathKey(path);
    if (seen.has(key)) throw new Error("This session contains the same video more than once.");
    seen.add(key);
    const shootingStart = text(s.shootingStart, "Shooting start", 40, true);
    const timeConfirmed = boolean(s.timeConfirmed, "Time confirmation");
    if (shootingStart && !validShootingStart(shootingStart)) throw new Error("A saved shooting start must include a valid date, time and UTC offset.");
    if (timeConfirmed && !shootingStart) throw new Error("A confirmed shooting start cannot be empty.");
    return { path, identity: text(s.identity, "Video identity", 512), shootingStart, timeConfirmed, position: number(s.position, "Video position", 0, MAX_FRAME_INDEX, true) };
  });
  const photos = new Set<string>();
  const selections = root.selections.map((value) => {
    const s = record(value, "Photo");
    const sourcePath = text(s.sourcePath, "Photo source", 32767);
    const identity = text(s.identity, "Photo source identity", 512);
    const source = sources.find((item) => item.path === sourcePath && item.identity === identity);
    if (!source) throw new Error("A photo references a video that is not in this session.");
    const index = number(s.index, "Photo frame", 0, MAX_FRAME_INDEX, true);
    const key = `${sourcePath}\0${index}`;
    if (photos.has(key)) throw new Error("This session contains duplicate photo selections.");
    photos.add(key);
    return { sourcePath, identity, index, personName: text(s.personName, "Person name", 120, true), recipe: validateSnapshotRecipe(s.recipe) };
  });
  return { kind: "photogogo-video-snapshots", version: 1, sources, selections };
}

export function createSnapshotSession(sources: SnapshotSource[], selections: SnapshotSelection[]): SnapshotSession {
  const saved: SnapshotSession = {
    kind: "photogogo-video-snapshots", version: 1,
    sources: sources.map((s) => ({ path: s.clip.path, identity: s.clip.identity, shootingStart: s.shootingStart, timeConfirmed: s.timeConfirmed, position: s.position })),
    selections: selections.flatMap((selection) => {
      const source = sources.find((s) => s.clip.id === selection.clipId);
      return source ? [{ sourcePath: source.clip.path, identity: source.clip.identity, index: selection.index, personName: selection.personName, recipe: selection.recipe }] : [];
    }),
  };
  return parseSnapshotSession(JSON.stringify(saved));
}

/** Bounded encoded-image LRU. Decoded originals never enter browser state. */
export class SnapshotFrameCache {
  private entries = new Map<string, { frame: SnapshotFrame; bytes: number }>();
  private bytes = 0;
  private priority = new Map<string, number>();
  private largestFrame = 0;
  constructor(private budget = 32 * 1024 * 1024) {}
  has(clipId: string, index: number): boolean { return this.entries.has(`${clipId}:${index}`); }
  peek(clipId: string, index: number): SnapshotFrame | undefined { return this.entries.get(`${clipId}:${index}`)?.frame; }
  /** Planning never touches LRU order. The requested frame always outranks speculation. */
  focus(clipId: string, indexes: number[]): void {
    this.priority = new Map(indexes.map((index, rank) => [`${clipId}:${index}`, rank]));
  }
  canPrepare(clipId: string, index: number): boolean {
    if (this.has(clipId, index)) return false;
    const estimate = this.largestFrame || 128 * 1024;
    if (estimate > this.budget) return false;
    if (this.bytes + estimate <= this.budget) return true;
    const rank = this.priority.get(`${clipId}:${index}`) ?? Infinity;
    let available = this.budget - this.bytes;
    for (const [key, entry] of this.entries) {
      if ((this.priority.get(key) ?? Infinity) > rank) available += entry.bytes;
      if (available >= estimate) return true;
    }
    return false;
  }
  stats(): { bytes: number; budget: number; frames: number } { return { bytes: this.bytes, budget: this.budget, frames: this.entries.size }; }
  get(clipId: string, index: number): SnapshotFrame | undefined {
    const key = `${clipId}:${index}`, entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.frame;
  }
  put(clipId: string, frame: SnapshotFrame): void {
    const key = `${clipId}:${frame.index}`, existing = this.entries.get(key);
    if (existing) this.bytes -= existing.bytes;
    this.entries.delete(key);
    const bytes = frame.data.length * 2 + 64;
    this.largestFrame = Math.max(this.largestFrame, bytes);
    if (bytes <= this.budget) { this.entries.set(key, { frame, bytes }); this.bytes += bytes; }
    this.trim();
  }
  setBudget(bytes: number): void { this.budget = bytes; this.trim(); }
  clear(): void { this.entries.clear(); this.priority.clear(); this.bytes = 0; this.largestFrame = 0; }
  private trim(): void {
    while (this.bytes > this.budget && this.entries.size) {
      let key = this.entries.keys().next().value as string;
      for (const candidate of this.entries.keys()) {
        if ((this.priority.get(candidate) ?? Infinity) > (this.priority.get(key) ?? Infinity)) key = candidate;
      }
      this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
    }
  }
}

/** Small near-first runs keep IPC/extraction bounded; idle expands on both sides. */
export function snapshotReadAheadOrder(index: number, length: number, direction: number, moving: boolean): number[] {
  const result = [index], forward = direction < 0 ? -1 : 1;
  const add = (from: number, to: number, sign: number) => {
    for (let offset = from; offset <= to; offset++) {
      const candidate = index + sign * offset;
      if (candidate >= 0 && candidate < length) result.push(candidate);
    }
  };
  add(1, 10, forward); add(1, 10, -forward);
  for (let from = 11; from <= 100; from += 12) {
    add(from, Math.min(100, from + 11), forward);
    if (!moving) add(from, Math.min(100, from + 11), -forward);
  }
  return result;
}

/** At most four 960x540 decoded previews (~8 MiB pixels), never original photographs. */
export class SnapshotPreviewWarmup {
  private images = new Map<string, HTMLImageElement>();
  warm(frames: SnapshotFrame[]): void {
    const wanted = new Set(frames.slice(0, 4).map(frame => frame.data));
    for (const [data, image] of this.images) {
      if (!wanted.has(data)) { image.src = ""; this.images.delete(data); }
    }
    for (const data of wanted) {
      if (this.images.has(data)) continue;
      const image = new Image(); image.src = data; this.images.set(data, image);
      void image.decode().catch(() => undefined); // A warm-up failure never blocks actual display.
    }
  }
  clear(): void { for (const image of this.images.values()) image.src = ""; this.images.clear(); }
}
