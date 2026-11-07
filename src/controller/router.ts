import type { ControllerAcknowledgement, ControllerInput, ControllerSurface, ControllerSurfaceView } from "./types";

type Entry = { surface: ControllerSurface; order: number };
const unavailable = (): ControllerSurfaceView["keys"][number] => ({ id: "", label: "Unavailable", enabled: false });
const short = (value: string, max = 96) => value.slice(0, max);

function viewOf(surface: ControllerSurface, revision: number): ControllerSurfaceView {
  return {
    id: short(surface.id), title: short(surface.title), contextKey: surface.contextKey,
    revision,
    keys: Array.from({ length: 6 }, (_, i) => surface.keys[i] ? {
      id: short(surface.keys[i].id), label: short(surface.keys[i].label, 40),
      icon: surface.keys[i].icon, detail: surface.keys[i].detail ? short(surface.keys[i].detail, 24) : undefined,
      enabled: !!surface.keys[i].enabled, active: !!surface.keys[i].active, status: surface.keys[i].status,
    } : unavailable()),
    dials: Array.from({ length: 3 }, (_, i) => surface.dials?.[i] ? { ...surface.dials[i], label: short(surface.dials[i].label, 48) } : { label: "Unassigned", enabled: false }),
    sideButtons: Array.from({ length: 3 }, (_, i) => surface.sideButtons?.[i] ? { ...surface.sideButtons[i], label: short(surface.sideButtons[i].label, 40) } : { label: "Unassigned", enabled: false }),
  };
}

/** Shared seam for real native events and the on-screen controller mirror. */
export class ControllerRouter {
  private entries = new Map<symbol, Entry>();
  private selected: Entry | null = null;
  private fingerprint = "";
  private revision = 0;
  private order = 0;
  private busy = false;
  private accepting = false;
  private session: string | null = null;
  private seen = new Set<string>();
  private dialRun: { command: string; context: string; time: number; count: number } | null = null;
  current: ControllerSurfaceView | null = null;
  currentOwner: symbol | null = null;

  constructor(
    private changed: (view: ControllerSurfaceView | null, busy: boolean) => void,
    private acknowledge: (ack: ControllerAcknowledgement) => void | Promise<void>,
    private failed: (message: string) => void = () => {},
    private clock: () => number = () => performance.now(),
    private intercept?: (event: ControllerInput, mirror: boolean) => ControllerAcknowledgement["result"] | null,
  ) {}

  register(owner: symbol, surface: ControllerSurface) {
    const prior = this.entries.get(owner);
    this.entries.set(owner, { surface, order: prior?.order ?? ++this.order });
    this.select();
  }

  remove(owner: symbol) { this.entries.delete(owner); this.select(); }
  setAccepting(value: boolean) { this.accepting = value && !!this.session; if (!this.accepting) this.dialRun = null; }
  setSession(session: string | null) {
    if (session !== this.session) { this.session = session; this.seen.clear(); this.dialRun = null; }
    if (!session) this.accepting = false;
  }
  /** A mode/settings transition makes already-emitted device input stale. */
  fence() {
    this.revision++;
    if (this.current) this.current = { ...this.current, revision: this.revision };
    this.dialRun = null;
    this.changed(this.current, this.busy);
  }

  private select() {
    const selected = [...this.entries.entries()].sort(([, a], [, b]) => (b.surface.priority ?? 100) - (a.surface.priority ?? 100) || b.order - a.order)[0];
    this.currentOwner = selected?.[0] ?? null;
    this.selected = selected?.[1] ?? null;
    const candidate = this.selected ? viewOf(this.selected.surface, this.revision) : null;
    const fingerprint = candidate ? JSON.stringify({ ...candidate, revision: 0 }) : "";
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.revision++;
    if (candidate?.id !== this.current?.id || candidate?.contextKey !== this.current?.contextKey) this.dialRun = null;
    this.current = candidate ? { ...candidate, revision: this.revision } : null;
    this.changed(this.current, this.busy);
  }

  private command(event: ControllerInput) {
    const current = this.current;
    if (!current || !Number.isInteger(event.index)) return null;
    if (event.kind === "key" && event.delta === 1) {
      const key = current.keys[event.index];
      return event.index >= 0 && key?.enabled && key.id ? { id: key.id, amount: 1 } : null;
    }
    if (event.kind === "side" && event.delta === 1) {
      const key = current.sideButtons[event.index];
      return event.index >= 0 && key && key.enabled !== false && key.id ? { id: key.id, amount: 1 } : null;
    }
    if (event.kind !== "dial" || ![-1, 0, 1].includes(event.delta)) return null;
    const dial = current.dials[event.index];
    if (event.index < 0 || !dial || dial.enabled === false) return null;
    const id = event.delta < 0 ? dial.left : event.delta > 0 ? dial.right : dial.press;
    if (!id) return null;
    let amount = 1;
    if (dial.accelerate && event.delta !== 0) {
      const now = this.clock(), previous = this.dialRun;
      const count = previous?.command === id && previous.context === current.contextKey && now - previous.time < 100 ? Math.min(4, previous.count + 1) : 1;
      this.dialRun = { command: id, context: current.contextKey, time: now, count };
      amount = [1, 2, 4, 8][count - 1];
    } else this.dialRun = null;
    return { id, amount };
  }

  async input(event: ControllerInput, mirror = false): Promise<void> {
    let result: ControllerAcknowledgement["result"] = "ignored", message: string | undefined;
    const validIdentity = typeof event?.session === "string" && event.session.length > 0 && event.session.length <= 160
      && typeof event.id === "string" && event.id.length > 0 && event.id.length <= 160;
    if (!validIdentity) return;
    try {
      if (!this.accepting || (!mirror && event.session !== this.session) || this.busy || !this.selected || !this.current || event.revision !== this.current.revision) return;
      const identity = `${event.session}|${event.id}`;
      if (this.seen.has(identity)) return;
      this.seen.add(identity);
      if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
      const intercepted = this.intercept?.(event, mirror);
      if (intercepted) { result = intercepted; return; }
      const command = this.command(event);
      if (!command) return;
      // Capture the callback selected for this revision; no delayed input queue.
      const execute = this.selected.surface.execute;
      this.busy = true; this.changed(this.current, true);
      try { await execute(command.id, command.amount); result = "handled"; }
      finally { this.busy = false; this.changed(this.current, false); }
    } catch (reason) {
      result = "error"; message = short(reason instanceof Error ? reason.message : String(reason), 240);
      this.failed(message);
    } finally {
      if (!mirror) {
        try { await this.acknowledge({ session: event.session, id: event.id, result, ...(message ? { message } : {}) }); }
        catch (reason) { this.failed("Controller acknowledgement failed: " + short(reason instanceof Error ? reason.message : String(reason), 180)); }
      }
    }
  }
}
