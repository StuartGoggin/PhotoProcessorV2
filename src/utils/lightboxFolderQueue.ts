interface Job { key: string; foreground: boolean; work: () => Promise<boolean>; promise: Promise<boolean>; resolve: (value: boolean) => void }

/** One running inspection and one latest queued inspection. Superseded queued
 * work is never sent to native IO; a running read remains fenced by its caller. */
export class LightboxFolderQueue {
  private active?: Job;
  private next?: Job;
  promote(key: string) { if (this.next?.key === key) this.next.foreground = true; }
  run(key: string, work: () => Promise<boolean>, foreground = false): Promise<boolean> {
    if (this.active?.key === key) return this.active.promise;
    if (this.next?.key === key) { this.next.foreground ||= foreground; return this.next.promise; }
    let resolve!: Job["resolve"];
    const promise = new Promise<boolean>(done => { resolve = done; });
    const job = { key, foreground, work, promise, resolve };
    if (this.active) {
      if (this.next?.foreground && !foreground) resolve(false);
      else { this.next?.resolve(false); this.next = job; }
    }
    else this.start(job);
    return promise;
  }
  clear(ownerPrefix?: string) { if (!ownerPrefix || this.next?.key.startsWith(ownerPrefix)) { this.next?.resolve(false); this.next = undefined; } }
  private start(job: Job) {
    this.active = job;
    void Promise.resolve().then(job.work).then(job.resolve, () => job.resolve(false)).finally(() => {
      this.active = undefined;
      const next = this.next; this.next = undefined;
      if (next) this.start(next);
    });
  }
}
