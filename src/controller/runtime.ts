import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { controllerKeyJpeg } from "./artwork";
import { ControllerRouter } from "./router";
import { defaultLightboxBindings, parseLightboxBindings, type LightboxBindings } from "./lightboxBindings";
import { initialControllerStatus, type ControllerAcknowledgement, type ControllerInput, type ControllerSnapshot, type ControllerStatus, type ControllerSurface, type NativeControllerSurface } from "./types";

export interface ControllerAdapter {
  claim(client: string): Promise<ControllerStatus>;
  status(): Promise<ControllerStatus>;
  configure(enabled: boolean, brightness?: number): Promise<unknown>;
  surface(surface: NativeControllerSurface): Promise<unknown>;
  acknowledge(ack: ControllerAcknowledgement): Promise<unknown>;
  lightboxBindings(bindings: LightboxBindings | null): Promise<LightboxBindings>;
  subscribe(handler: (input: ControllerInput) => void): Promise<() => void>;
}

const nativeAdapter: ControllerAdapter = {
  claim: client => invoke("controller_claim_client", { client }),
  status: () => invoke("controller_status"),
  configure: (enabled, brightness) => invoke("controller_configure", { enabled, ...(brightness === undefined ? {} : { brightness }) }),
  surface: surface => invoke("controller_surface", { surface }),
  acknowledge: ack => invoke("controller_ack", { ...ack }),
  lightboxBindings: bindings => invoke("controller_lightbox_bindings", { bindings }),
  subscribe: handler => listen<ControllerInput>("controller-input", event => handler(event.payload)),
};
const explain = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).slice(0, 300);

/** One bounded local bridge; it owns listening, current layout and input acknowledgements. */
export class ControllerRuntime {
  private snapshot: ControllerSnapshot = { status: initialControllerStatus, surface: null, actionBusy: false, configuring: false, notice: "", error: "",
    lightboxBindings: defaultLightboxBindings(), bindingsReady: false, bindingsBusy: false, bindingsError: "", identify: { active: false, index: null, session: null } };
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
  private bindingsEpoch = 0;
  private identifyOwner = Symbol("identify-controller-dial");
  private identifyOrigin: { owner: symbol | null; id: string; contextKey: string } | null = null;
  private identifySequence = 0;
  private identifyTimer?: ReturnType<typeof setTimeout>;

  constructor(private adapter: ControllerAdapter = nativeAdapter, private draw = controllerKeyJpeg) {
    this.router = new ControllerRouter((surface, actionBusy) => {
      const changed = surface !== this.snapshot.surface;
      this.update({ surface, actionBusy });
      if (changed) this.requestPublish();
    }, async ack => { await this.adapter.acknowledge(ack); }, error => {
      this.cancelIdentify("Identification stopped because a controller error occurred."); this.update({ error });
    }, () => performance.now(), (input, mirror) => this.identifyInput(input, mirror));
  }

  getSnapshot = () => this.snapshot;
  getLightboxBindings = () => this.snapshot.lightboxBindings;
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
        this.claimed = true; await this.loadBindings(); await this.refresh(); this.requestPublish();
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
      this.cancelIdentify();
      clearInterval(this.pollTimer); clearInterval(this.heartbeatTimer);
      this.router.setAccepting(false);
    };
  };

  register(owner: symbol, surface: ControllerSurface) {
    if (this.snapshot.identify.active && this.identifyOrigin &&
      ((owner === this.identifyOrigin.owner && surface.contextKey !== this.identifyOrigin.contextKey)
      || (surface.id !== this.identifyOrigin.id && (surface.priority ?? 100) >= 100))) this.cancelIdentify("The active photo or editor changed. Identify the dial again.");
    this.router.register(owner, surface);
  }
  remove(owner: symbol) { if (owner === this.identifyOrigin?.owner) this.cancelIdentify("The controller page closed. Identification was cancelled."); this.router.remove(owner); }

  private acceptCurrentStatus() {
    const { status, configuring, bindingsBusy, bindingsReady } = this.snapshot;
    this.router.setAccepting(this.claimed && status.enabled && status.phase === "connected" && status.client === this.client && !!status.session && !configuring && !bindingsBusy && bindingsReady);
  }

  private async loadBindings() {
    const epoch = ++this.bindingsEpoch, generation = this.generation;
    this.router.setAccepting(false);
    this.update({ bindingsBusy: true, bindingsReady: false, bindingsError: "" });
    try {
      const bindings = parseLightboxBindings(await this.adapter.lightboxBindings(null));
      if (epoch !== this.bindingsEpoch || generation !== this.generation) return;
      this.update({ lightboxBindings: bindings, bindingsReady: true });
    } catch (reason) {
      if (epoch === this.bindingsEpoch && generation === this.generation) this.update({ bindingsError: "Could not read saved Lightbox controls: " + explain(reason) });
    } finally {
      if (epoch === this.bindingsEpoch && generation === this.generation) { this.update({ bindingsBusy: false }); this.router.fence(); this.acceptCurrentStatus(); }
    }
  }

  async saveLightboxBindings(value: LightboxBindings): Promise<boolean> {
    if (!this.claimed || this.snapshot.bindingsBusy || this.snapshot.configuring || this.snapshot.actionBusy || (!this.snapshot.bindingsReady && !this.snapshot.bindingsError)) return false;
    let bindings: LightboxBindings;
    try { bindings = parseLightboxBindings(value); } catch (reason) { this.update({ bindingsError: explain(reason) }); return false; }
    const epoch = ++this.bindingsEpoch, generation = this.generation;
    this.router.setAccepting(false); this.router.fence();
    this.update({ bindingsBusy: true, bindingsError: "", notice: "" });
    try {
      const saved = parseLightboxBindings(await this.adapter.lightboxBindings(bindings));
      if (epoch !== this.bindingsEpoch || generation !== this.generation) return false;
      this.update({ lightboxBindings: saved, bindingsReady: true, notice: "Lightbox dial controls saved on this computer." });
      this.cancelIdentify();
      return true;
    } catch (reason) {
      if (epoch === this.bindingsEpoch && generation === this.generation) this.update({ bindingsError: "Dial controls were not saved. The previous saved controls remain unchanged. " + explain(reason) });
      return false;
    } finally {
      if (epoch === this.bindingsEpoch && generation === this.generation) {
        this.update({ bindingsBusy: false }); this.router.fence(); this.acceptCurrentStatus(); this.requestPublish();
      }
    }
  }

  beginIdentify(): boolean {
    const { status, actionBusy, configuring, bindingsBusy, bindingsReady } = this.snapshot;
    if (actionBusy || configuring || bindingsBusy || !bindingsReady || !status.enabled || status.phase !== "connected" || status.client !== this.client || !status.session) return false;
    if (!this.snapshot.identify.active) this.identifyOrigin = { owner: this.router.currentOwner, id: this.router.current?.id || "", contextKey: this.router.current?.contextKey || "" };
    clearTimeout(this.identifyTimer); this.identifySequence++;
    this.update({ identify: { active: true, index: null, session: status.session }, bindingsError: "", notice: "Turn the physical dial you want to use as the large browsing dial. Photo actions are paused." });
    this.publishIdentify(); this.acceptCurrentStatus();
    this.identifyTimer = setTimeout(() => this.cancelIdentify("Dial identification timed out. No controls were changed."), 60000);
    return true;
  }

  private publishIdentify() {
    const index = this.snapshot.identify.index;
    this.router.register(this.identifyOwner, {
      id: "controller-identify", title: "Identify a dial · Photo actions paused", contextKey: `identify-${this.identifySequence}-${index ?? "waiting"}`, priority: 1000,
      keys: Array.from({ length: 6 }, (_, i) => ({ id: "", label: i === 0 ? index === null ? "Turn large dial" : `Dial ${index + 1} found` : "Photos paused", icon: i === 0 ? "help" : "pause", enabled: false, active: i === 0 && index !== null })),
      dials: [0, 1, 2].map(i => ({ label: `Identify physical dial ${i + 1}`, enabled: false })), sideButtons: [0, 1, 2].map(() => ({ label: "Paused", enabled: false })), execute: () => {},
    });
  }

  private identifyInput(input: ControllerInput, mirror: boolean): ControllerAcknowledgement["result"] | null {
    if (!this.snapshot.identify.active) return null;
    if (!mirror && input.kind === "dial" && Number.isInteger(input.index) && input.index >= 0 && input.index < 3 && [-1, 1].includes(input.delta) && this.snapshot.identify.index === null) {
      this.update({ identify: { ...this.snapshot.identify, index: input.index }, notice: `Physical dial ${input.index + 1} identified. Apply to make it browse originals, or cancel without changing controls.` });
      this.publishIdentify(); return "handled";
    }
    return "ignored";
  }

  cancelIdentify(message?: string) {
    clearTimeout(this.identifyTimer);
    if (!this.snapshot.identify.active) return;
    this.identifyOrigin = null;
    this.update({ identify: { active: false, index: null, session: null }, ...(message ? { notice: message } : {}) });
    this.router.remove(this.identifyOwner);
  }

  async applyIdentifiedDial(draft: LightboxBindings): Promise<boolean> {
    const { identify, status } = this.snapshot;
    if (!identify.active || identify.index === null || status.phase !== "connected" || identify.session !== status.session) return false;
    const bindings = parseLightboxBindings(draft);
    bindings.dials[identify.index] = { turn: "browse", press: "fit" };
    return this.saveLightboxBindings(bindings);
  }

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
      if (this.snapshot.identify.active && (status.phase !== "connected" || status.session !== this.snapshot.identify.session)) this.cancelIdentify("The controller disconnected or reconnected. Identify the dial again.");
      this.router.setSession(status.phase === "connected" ? status.session! : null);
      const newlyConnected = status.phase === "connected" && this.snapshot.status.phase !== "connected";
      this.update({ status, ...(newlyConnected || this.snapshot.error.startsWith("Controller status unavailable:") ? { error: "" } : {}) });
      this.acceptCurrentStatus();
      if (newlyConnected) this.requestPublish();
    } catch (reason) {
      if (generation === this.generation && statusEpoch === this.statusEpoch) {
        this.router.setAccepting(false);
        this.router.setSession(null);
        this.cancelIdentify("Controller connection was lost. Identification was cancelled.");
        this.update({ error: "Controller status unavailable: " + explain(reason) });
      }
    } finally { this.polling = false; if (this.refreshRequested && this.users) { this.refreshRequested = false; void this.refresh(); } }
  }

  async configure(enabled: boolean, brightness?: number) {
    if (this.snapshot.configuring || this.snapshot.bindingsBusy) return;
    if (brightness !== undefined && (!Number.isFinite(brightness) || brightness < 0 || brightness > 100)) return;
    this.statusEpoch++;
    this.cancelIdentify();
    this.router.setAccepting(false);
    this.router.setSession(null);
    this.update({ configuring: true, notice: "", error: "" });
    try {
      await this.adapter.claim(this.client); this.claimed = true;
      await this.adapter.configure(enabled, brightness === undefined ? undefined : Math.round(brightness));
      await this.loadBindings();
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
    } catch (reason) { this.cancelIdentify("Dial identification stopped because its layout could not be displayed."); this.update({ error: "Controller layout could not be displayed: " + explain(reason) }); }
    finally { this.publishing = false; }
  }

  /** Mirror buttons go through the same context/revision gates, without a fake native ack. */
  mirror(kind: ControllerInput["kind"], index: number, delta: number) {
    if (this.snapshot.identify.active) return;
    const current = this.snapshot.surface;
    if (current) void this.router.input({ session: "mirror", id: String(++this.mirrorId), revision: current.revision, kind, index, delta }, true);
  }
}

let singleton: ControllerRuntime | undefined;
export function controllerRuntime() { return singleton ??= new ControllerRuntime(); }
