import type { SnapshotSessionDocument } from "../types/videoSnapshots";

export type SnapshotSaveState = "saved" | "unsaved" | "saving" | "failed";

/** One serial, revision-checked writer. The maximum delay also covers continuous scrubbing. */
export class SnapshotSessionWriter {
  private entry: SnapshotSessionDocument | null = null;
  private generation = 0;
  private acknowledged = 0;
  private firstDirty = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private disposed = false;
  private failed = false;
  constructor(
    private read: () => string,
    private put: (entry: SnapshotSessionDocument, json: string) => Promise<SnapshotSessionDocument>,
    private report: (state: SnapshotSaveState, entry: SnapshotSessionDocument | null, error?: string) => void,
    private delay = 750,
    private maximumDelay = 4000,
  ) {}
  get current() { return this.entry; }
  get dirty() { return this.generation !== this.acknowledged; }
  /** Recovery copies may follow a failed save, but must never race an unsettled one. */
  async settle() { if (this.flight) await this.flight.catch(() => undefined); this.clearTimer(); }
  attach(entry: SnapshotSessionDocument | null) {
    if (this.flight || this.dirty) throw new Error("Save the current session before switching.");
    this.clearTimer(); this.entry = entry; this.failed = false; this.firstDirty = 0;
    this.report("saved", entry);
  }
  /** Only after a new library entry has durably saved the full current document. */
  adoptSavedCopy(entry: SnapshotSessionDocument) {
    if (this.flight) throw new Error("Wait for the current save to finish.");
    this.acknowledged = this.generation;
    this.attach(entry);
  }
  mark() {
    if (!this.entry || this.disposed) return;
    this.generation++;
    if (!this.firstDirty) this.firstDirty = Date.now();
    // After an error, keep the error visible until the user explicitly retries.
    if (this.failed) return;
    this.report(this.flight ? "saving" : "unsaved", this.entry);
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, Math.min(this.delay, Math.max(0, this.maximumDelay - (Date.now() - this.firstDirty))));
  }
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.flight) { await this.flight; if (this.dirty) return this.flush(); return; }
    if (!this.entry || !this.dirty) return;
    this.failed = false;
    const run = async () => {
      while (this.entry && this.dirty) {
        const generation = this.generation;
        this.report("saving", this.entry);
        try {
          const json = this.read();
          const saved = await this.put(this.entry, json);
          this.entry = saved; this.acknowledged = generation;
        } catch (reason) {
          this.failed = true;
          this.report("failed", this.entry, reason instanceof Error ? reason.message : String(reason));
          throw reason;
        }
      }
      this.firstDirty = 0; this.report("saved", this.entry);
    };
    this.flight = run();
    try { await this.flight; } finally { this.flight = null; }
  }
  dispose() { this.disposed = true; this.clearTimer(); }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
