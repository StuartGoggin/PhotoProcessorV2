/** Serializes small local metadata writes across Lightbox roots/remounts.
 * Accepted writes continue after their view closes; a reopened view waits for
 * them before reading confirmed state. No credentials or disk paths persist. */
export interface CurationRequest {
  root: string; assetId: string; relativePath: string;
  selected?: boolean; favourite?: boolean;
}
export interface CurationReceipt {
  assetId: string; relativePath: string; selected: boolean; favourite: boolean; revision: number;
}
interface Failure { request: CurationRequest; field: "selected" | "favourite"; message: string }
export class CurationWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failures = new Map<string, Failure>();
  constructor(private persist: (request: CurationRequest) => Promise<CurationReceipt>) {}
  private key(request: Pick<CurationRequest, "root" | "assetId">, field: string) { return JSON.stringify([request.root, request.assetId, field]); }
  error(root: string, assetId?: string) {
    const failures = [...this.failures.values()].filter(failure => failure.request.root === root && (!assetId || failure.request.assetId === assetId));
    const last = failures[failures.length - 1];
    return last ? `Selection save was not confirmed for ${last.request.relativePath} (${last.field === "favourite" ? "favourite" : "Google Photos checkbox"}): ${last.message}. Try again.` : "";
  }
  clearErrors(root: string) { for (const [key, failure] of this.failures) if (failure.request.root === root) this.failures.delete(key); }
  async settled() {
    let current: Promise<void>;
    do { current = this.tail; await current; } while (current !== this.tail);
  }
  enqueue(request: CurationRequest): Promise<CurationReceipt> {
    if (this.pending >= 256) return Promise.reject(new Error("Wait for the pending photo selections to finish saving."));
    const captured = { ...request }; this.pending++;
    const fields = (["selected", "favourite"] as const).filter(field => typeof captured[field] === "boolean");
    const result = this.tail.then(async () => {
      try {
        const receipt = await this.persist(captured);
        if (!receipt || receipt.assetId !== captured.assetId || receipt.relativePath !== captured.relativePath
          || typeof receipt.selected !== "boolean" || typeof receipt.favourite !== "boolean"
          || !Number.isFinite(receipt.revision) || receipt.revision < 0) throw Error("The save acknowledgement did not match this exact photo. Reload selections.");
        for (const field of fields) this.failures.delete(this.key(captured, field));
        return receipt;
      } catch (error) {
        for (const field of fields) {
          const key = this.key(captured, field);
          this.failures.delete(key); this.failures.set(key, { request: captured, field, message: String(error) });
        }
        // Bounded, in-memory recovery notices; never a durable second job store.
        while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value!);
        throw error;
      } finally { this.pending--; }
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
