export interface LightboxImage { data: string; mime: string; width: number; height: number }
interface Loaded { url: string; bytes: number; pixels: number; image?: HTMLImageElement }
interface Pending { path: string; foreground: boolean; generation: number; resolve: (url: string | null) => void; promise: Promise<string | null> }

const MiB = 1024 * 1024;

/** Session-local, full-resolution read-ahead. No writes, thumbnail substitutions
 * or unbounded queues. Browser-owned active panel memory is separate from these
 * explicit 64 MiB compressed / 128 MiB speculative decoded cache limits.
 */
export class LightboxCache {
  private entries = new Map<string, Loaded>();
  private pending = new Map<string, Pending>();
  private queue: Pending[] = [];
  private active = new Set<string>();
  private wanted = new Set<string>();
  private running = 0;
  private backgroundRunning = 0;
  private generation = 0;
  private bytes = 0;
  private decoded = 0;
  constructor(private read: (path: string) => Promise<LightboxImage>, private byteLimit = 64 * MiB, private decodedLimit = 128 * MiB) {}

  select(paths: string[]) {
    this.active = new Set(paths);
    this.queue = this.queue.filter(item => {
      if (this.active.has(item.path)) return true;
      if (this.pending.get(item.path) === item) this.pending.delete(item.path);
      item.resolve(null); return false;
    });
    this.prefetch([]);
    this.trim();
  }

  get(path: string, foreground = true): Promise<string | null> {
    const hit = this.entries.get(path);
    if (hit) {
      this.entries.delete(path); this.entries.set(path, hit);
      return Promise.resolve(hit.url);
    }
    const prior = this.pending.get(path);
    if (prior) { if (foreground) prior.foreground = true; this.pump(); return prior.promise; }
    let resolve!: Pending["resolve"];
    const promise = new Promise<string | null>(done => { resolve = done; });
    const item = { path, foreground, generation: this.generation, resolve, promise };
    this.pending.set(path, item); this.queue.push(item); this.pump();
    return promise;
  }

  prefetch(paths: string[]) {
    this.wanted = new Set(paths.slice(0, 9));
    this.queue = this.queue.filter(item => {
      if (item.foreground || this.wanted.has(item.path)) return true;
      if (this.pending.get(item.path) === item) this.pending.delete(item.path);
      item.resolve(null); return false;
    });
    for (const path of this.wanted) void this.get(path, false);
    this.pump();
  }

  clear() {
    this.generation++;
    for (const item of this.pending.values()) item.resolve(null);
    this.pending.clear(); this.queue = []; this.active.clear(); this.wanted.clear();
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear(); this.bytes = 0; this.decoded = 0;
  }

  stats() { return { entries: this.entries.size, bytes: this.bytes, decodedBytes: this.decoded, running: this.running, queued: this.queue.length }; }

  private release(entry: Loaded) {
    if (entry.image) { entry.image.src = ""; this.decoded -= entry.pixels; }
    URL.revokeObjectURL(entry.url);
  }

  private trim(reserve = 0) {
    for (const [path, entry] of this.entries) {
      if (this.bytes + reserve <= this.byteLimit) break;
      if (this.active.has(path)) continue;
      this.entries.delete(path); this.bytes -= entry.bytes; this.release(entry);
    }
  }

  private pump() {
    while (this.running < 2) {
      let index = this.queue.findIndex(item => item.foreground);
      if (index < 0) {
        if (this.backgroundRunning || this.running) return;
        index = this.queue.findIndex(item => this.wanted.has(item.path));
      }
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      const background = !item.foreground;
      this.running++; if (background) this.backgroundRunning++;
      void this.load(item).finally(() => {
        this.running--; if (background) this.backgroundRunning--;
        if (this.pending.get(item.path) === item) this.pending.delete(item.path);
        this.pump();
      });
    }
  }

  private async load(item: Pending) {
    try {
      const payload = await this.read(item.path);
      if (item.generation !== this.generation || (!this.active.has(item.path) && !this.wanted.has(item.path))) { item.resolve(null); return; }
      const bytes = Math.ceil(payload.data.length * 3 / 4);
      const pixels = payload.width * payload.height * 4;
      if (!Number.isSafeInteger(pixels) || pixels <= 0 || !/^image\/(jpeg|png)$/.test(payload.mime)) throw new Error("Unsupported Lightbox image");
      this.trim(bytes);
      // Foreground images must remain available even if one exceeds the cache
      // budget; there are at most three active panels. Never admit such a
      // speculative read, and evict it as soon as it stops being active.
      if (!this.active.has(item.path) && this.bytes + bytes > this.byteLimit) { item.resolve(null); return; }
      const binary = atob(payload.data);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      const entry: Loaded = { url: URL.createObjectURL(new Blob([array], { type: payload.mime })), bytes, pixels };
      this.entries.set(item.path, entry); this.bytes += bytes;
      if (!this.active.has(item.path) && this.decoded + pixels <= this.decodedLimit && typeof Image !== "undefined") {
        entry.image = new Image(); this.decoded += pixels;
        entry.image.src = entry.url;
        void entry.image.decode().catch(() => { /* A failed decode is shown by the panel, never an unhandled rejection. */ });
      }
      item.resolve(entry.url);
    } catch { item.resolve(null); }
  }
}
