import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { controllerKeyJpeg } from "./artwork";
import { ControllerRouter } from "./router";
import { initialControllerStatus, type ControllerAcknowledgement, type ControllerInput, type ControllerSnapshot, type ControllerStatus, type ControllerSurface, type NativeControllerSurface } from "./types";

export interface ControllerAdapter {
  claim(client: string): Promise<ControllerStatus>;
  status(): Promise<ControllerStatus>;
  configure(enabled: boolean, brightness?: number): Promise<unknown>;
  surface(surface: NativeControllerSurface): Promise<unknown>;
  acknowledge(ack: ControllerAcknowledgement): Promise<unknown>;
  subscribe(handler: (input: ControllerInput) => void): Promise<() => void>;
}

const nativeAdapter: ControllerAdapter = {
  claim: client => invoke("controller_claim_client", { client }),
  status: () => invoke("controller_status"),
  configure: (enabled, brightness) => invoke("controller_configure", { enabled, ...(brightness === undefined ? {} : { brightness }) }),
  surface: surface => invoke("controller_surface", { surface }),
  acknowledge: ack => invoke("controller_ack", { ...ack }),
  subscribe: handler => listen<ControllerInput>("controller-input", event => handler(event.payload)),
};
const explain = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).slice(0, 300);

/** One bounded local bridge; it owns listening, current layout and input acknowledgements. */
export class ControllerRuntime {
  private snapshot: ControllerSnapshot = { status: initialControllerStatus, surface: null, actionBusy: false, configuring: false, notice: "", error: "" };
  private subscribers = new Set<() => void>();
  private router: ControllerRouter;
  private users = 0;
  private generation = 0;
  private claimed = false;
  private readonly client = crypto.randomUUID();
  private unlisten?: () => void;
  private pollTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private refreshRequested = false;
  private statusEpoch = 0;
  private publishing = false;
  private publishRequested = false;
  private art = new Map<string, string>();
  private mirrorId = 0;

  constructor(private adapter: ControllerAdapter = nativeAdapter, private draw = controllerKeyJpeg) {
    this.router = new ControllerRouter((surface, actionBusy) => {
      const changed = surface !== this.snapshot.surface;
      this.update({ surface, actionBusy });
      if (changed) this.requestPublish();
    }, async ack => { await this.adapter.acknowledge(ack); }, error => this.update({ error }));
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; };
  private update(change: Partial<ControllerSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; this.subscribers.forEach(listener => listener()); }

  start = () => {
    this.users++;
    if (this.users === 1) {
      const generation = ++this.generation;
      this.claimed = false;
      void this.adapter.subscribe(input => { if (generation === this.generation && this.claimed && this.users) void this.router.input(input); }).then(stop => {
        if (generation !== this.generation || !this.users) stop(); else this.unlisten = stop;
      }).catch(reason => { if (generation === this.generation) this.update({ error: "Controller events could not connect: " + explain(reason) }); });
      void this.adapter.claim(this.client).then(async () => {
        if (generation !== this.generation || !this.users) return;
        this.claimed = true; await this.refresh(); this.requestPublish();
      }).catch(reason => { if (generation === this.generation) this.update({ error: "Controller ownership could not connect: " + explain(reason) }); });
      this.pollTimer = setInterval(() => void this.refresh(), 1500);
      this.heartbeatTimer = setInterval(() => this.requestPublish(), 3000);
      this.requestPublish();
    }
    let stopped = false;
    return () => {
      if (stopped) return; stopped = true;
      if (--this.users > 0) return;
      this.generation++; this.unlisten?.(); this.unlisten = undefined;
      this.claimed = false;
      clearInterval(this.pollTimer); clearInterval(this.heartbeatTimer);
      this.router.setAccepting(false);
    };
  };

  register(owner: symbol, surface: ControllerSurface) { this.router.register(owner, surface); }
  remove(owner: symbol) { this.router.remove(owner); }

  async refresh() {
    if (!this.claimed) { this.refreshRequested = true; return; }
    if (this.snapshot.configuring) { this.refreshRequested = true; return; }
    if (this.polling) { this.refreshRequested = true; return; }
    this.polling = true;
    const generation = this.generation;
    const statusEpoch = this.statusEpoch;
    try {
      const status = await this.adapter.status();
      if (generation !== this.generation || statusEpoch !== this.statusEpoch) return;
      if (typeof status?.enabled !== "boolean" || !["disabled", "searching", "taking-over", "connected", "error", "disconnected"].includes(status.phase)
        || !Number.isFinite(status.brightness) || status.brightness < 0 || status.brightness > 100) throw new Error("Invalid controller status response.");
      if (status.phase === "connected" && (typeof status.session !== "string" || !status.session || status.session.length > 160)) throw new Error("Controller session handshake is unavailable.");
      if (status.phase === "connected" && status.client !== this.client) throw new Error("Controller ownership belongs to another app client. Use Connect / retry to reclaim it.");
      this.router.setSession(status.phase === "connected" ? status.session! : null);
      this.router.setAccepting(status.enabled && status.phase === "connected" && !this.snapshot.configuring);
      const newlyConnected = status.phase === "connected" && this.snapshot.status.phase !== "connected";
      this.update({ status, ...(newlyConnected || this.snapshot.error.startsWith("Controller status unavailable:") ? { error: "" } : {}) });
      if (newlyConnected) this.requestPublish();
    } catch (reason) {
      if (generation === this.generation && statusEpoch === this.statusEpoch) {
        this.router.setAccepting(false);
        this.router.setSession(null);
        this.update({ error: "Controller status unavailable: " + explain(reason) });
      }
    } finally { this.polling = false; if (this.refreshRequested && this.users) { this.refreshRequested = false; void this.refresh(); } }
  }

  async configure(enabled: boolean, brightness?: number) {
    if (this.snapshot.configuring) return;
    if (brightness !== undefined && (!Number.isFinite(brightness) || brightness < 0 || brightness > 100)) return;
    this.statusEpoch++;
    this.router.setAccepting(false);
    this.router.setSession(null);
    this.update({ configuring: true, notice: "", error: "" });
    try {
      await this.adapter.claim(this.client); this.claimed = true;
      await this.adapter.configure(enabled, brightness === undefined ? undefined : Math.round(brightness));
      this.update({ status: { ...this.snapshot.status, enabled, ...(brightness === undefined ? {} : { brightness: Math.round(brightness) }), ...(!enabled ? { phase: "disabled", session: undefined, message: "Controller released." } : {}) }, notice: enabled ? "Automatic PhotoGoGo control is enabled." : "Controller released. Restart AJAZZ manually when you want to use it." });
    } catch (reason) { this.update({ error: "Controller setting was not applied: " + explain(reason) }); }
    finally { this.statusEpoch++; this.update({ configuring: false }); await this.refresh(); this.requestPublish(); }
  }

  private requestPublish() {
    this.publishRequested = true;
    if (!this.users || !this.claimed || this.publishing) return;
    void this.publish();
  }

  private async publish() {
    this.publishing = true;
    try {
      while (this.users && this.claimed && this.publishRequested) {
        this.publishRequested = false;
        const current = this.snapshot.surface;
        if (!current || !this.snapshot.status.enabled) continue;
        const keys = current.keys.map(key => {
          const fingerprint = JSON.stringify(key);
          let imageData = this.art.get(fingerprint);
          if (!imageData) {
            imageData = this.draw(key); this.art.set(fingerprint, imageData);
            if (this.art.size > 96) this.art.delete(this.art.keys().next().value!);
          }
          return { label: key.label, imageData, enabled: key.enabled, active: !!key.active };
        });
        await this.adapter.surface({ client: this.client, revision: current.revision, title: current.title, keys, dials: current.dials.map(dial => ({ label: dial.label })), sideButtons: current.sideButtons.map(button => ({ label: button.label })) });
        if (this.snapshot.error.startsWith("Controller layout could not be displayed:")) this.update({ error: "" });
      }
    } catch (reason) { this.update({ error: "Controller layout could not be displayed: " + explain(reason) }); }
    finally { this.publishing = false; }
  }

  /** Mirror buttons go through the same context/revision gates, without a fake native ack. */
  mirror(kind: ControllerInput["kind"], index: number, delta: number) {
    const current = this.snapshot.surface;
    if (current) void this.router.input({ session: "mirror", id: String(++this.mirrorId), revision: current.revision, kind, index, delta }, true);
  }
}

let singleton: ControllerRuntime | undefined;
export function controllerRuntime() { return singleton ??= new ControllerRuntime(); }
