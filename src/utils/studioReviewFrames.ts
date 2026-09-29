export type ReviewMode = "all" | "selected" | "manual";
export interface ReviewClip { id: string; path: string; duration: number }
export interface ReviewImage { at: number; data: string }
export interface ReviewReply { at: number; data: string | null; cached: boolean; deferred: boolean; sourceKey?: string }
export interface ReviewRequest { path: string; duration: number; count: number; index: number; refresh: boolean; cacheOnly: boolean }
export interface ReviewSnapshot { selected: string; frames: ReviewImage[]; error: string; working: boolean; prepared: number; failed: number }
interface Entry { clip: ReviewClip; index: number; done: boolean; error: string; manual: boolean; refresh: boolean; missing: boolean; waiting?: boolean; sourceKey?: string }

export function reviewOptions(settings: { studio_review_frames_mode?: string; studio_review_frames_count?: number }) {
  return { mode: (["all", "selected", "manual"].includes(settings.studio_review_frames_mode ?? "") ? settings.studio_review_frames_mode : "all") as ReviewMode,
    count: [4, 8, 12].includes(settings.studio_review_frames_count ?? 0) ? settings.studio_review_frames_count! : 8 };
}

// One in-flight call and only the selected clip's JPEGs in memory. Disk cache is
// native-owned. This queue never mutates a project or a clip's approval/render state.
export class ReviewFrameQueue {
  private entries: Entry[];
  private selected = "";
  private frames: ReviewImage[] = [];
  private busy = false;
  private stopped = false;
  private selectionVersion = 0;
  constructor(clips: ReviewClip[], private mode: ReviewMode, private count: number,
    private read: (request: ReviewRequest) => Promise<ReviewReply>, private changed: (snapshot: ReviewSnapshot) => void) {
    this.entries = clips.map(clip => ({ clip, index: 0, done: false, error: "", manual: false, refresh: false, missing: false }));
  }
  select(id: string, refresh = false) {
    this.selected = id; this.selectionVersion++; this.frames = [];
    const entry = this.entries.find(e => e.clip.id === id);
    if (entry) Object.assign(entry, { index: 0, done: false, error: "", manual: refresh, refresh, missing: false, waiting: false, sourceKey: undefined });
    this.publish();
  }
  stop() { this.stopped = true; this.frames = []; }
  private publish() {
    if (this.stopped) return;
    const entry = this.entries.find(e => e.clip.id === this.selected);
    this.changed({ selected: this.selected, frames: [...this.frames], error: entry?.error ?? "", working: this.busy,
      prepared: this.entries.filter(e => e.done && !e.missing).length, failed: this.entries.filter(e => !!e.error).length });
  }
  async step(blocked: boolean) {
    if (this.stopped || this.busy) return;
    const selected = this.entries.find(e => e.clip.id === this.selected);
    const entry = selected && !selected.done && !selected.error ? selected
      : this.mode === "all" && !blocked ? this.entries.find(e => !e.done && !e.error) : undefined;
    if (!entry) return;
    if (blocked && (entry.waiting || entry.refresh)) return;
    if (!blocked) entry.waiting = false;
    const version = this.selectionVersion, index = entry.index;
    const manualLookup = this.mode === "manual" && !entry.manual;
    this.busy = true; this.publish();
    try {
      const result = await this.read({ path: entry.clip.path, duration: entry.clip.duration, count: this.count,
        index, refresh: entry.refresh && !blocked, cacheOnly: blocked || manualLookup });
      if (this.stopped || version !== this.selectionVersion) return;
      if (!result || typeof result.deferred !== "boolean" || !Number.isFinite(result.at) || result.at < 0) throw new Error("Invalid review-frame response. Refresh frames to retry.");
      if (result.deferred) return;
      if (result.data && result.sourceKey && entry.sourceKey && result.sourceKey !== entry.sourceKey) {
        if (entry.clip.id === this.selected) this.frames = [];
        throw new Error("This clip changed while frames were being prepared. Refresh frames after copying finishes.");
      }
      if (result.data) {
        entry.sourceKey = result.sourceKey;
        if (entry.clip.id === this.selected) this.frames.push({ at: result.at, data: result.data });
      } else if (blocked) { entry.waiting = true; return; }
      else if (!manualLookup) throw new Error("No review frame was returned. Refresh frames to retry.");
      else entry.missing = true;
      entry.index++; entry.done = entry.index >= this.count;
    } catch (e) {
      if (!this.stopped && version === this.selectionVersion) entry.error = String(e);
    } finally { this.busy = false; this.publish(); }
  }
}
