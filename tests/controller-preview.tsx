// Deterministic controller adapter: never opens a device or touches a vendor app.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ControllerPanel from "../src/components/ControllerPanel";
import { ControllerRuntime, type ControllerAdapter } from "../src/controller/runtime";
import { useControllerSurface } from "../src/controller/useControllerSurface";
import type { ControllerInput, ControllerStatus } from "../src/controller/types";
import { defaultLightboxBindings, parseLightboxBindings } from "../src/controller/lightboxBindings";
import "../src/styles.css";

const fixture = window as any;
fixture.__controllerCalls = []; fixture.__controllerAcks = []; fixture.__controllerFrames = []; fixture.__underlyingKeys = [];
let session = 0, enabled = true, brightness = 60, client = "", lastInput = "";
let bindings = parseLightboxBindings(fixture.__controllerInitialBindings || defaultLightboxBindings());
const listeners = new Set<(input: ControllerInput) => void>();
const status = (): ControllerStatus => ({ enabled, phase: enabled ? "connected" : "disabled", message: enabled ? "AKP03E connected. PhotoGoGo owns this session." : "Controller released. Restart AJAZZ manually.", device: "AJAZZ AKP03E · synthetic adapter", session: enabled ? "native-" + session : undefined, client, vendorStopped: true, brightness, lastInput });
const adapter: ControllerAdapter = {
  claim: async next => { fixture.__controllerCalls.push({ command: "claim", client: next }); client = next; session++; return status(); },
  status: async () => status(),
  configure: async (next, value) => { fixture.__controllerCalls.push({ command: "configure", enabled: next, brightness: value }); enabled = next; if (value !== undefined) brightness = value; },
  surface: async surface => { fixture.__controllerFrames.push(surface); if (fixture.__controllerFrames.length > 40) fixture.__controllerFrames.shift(); },
  acknowledge: async ack => { fixture.__controllerAcks.push(ack); },
  lightboxBindings: async value => {
    if (value) {
      fixture.__controllerCalls.push({ command: "bindings", bindings: structuredClone(value) });
      if (fixture.__controllerFailBindings) throw new Error("Synthetic settings write failure");
      if (fixture.__controllerDeferBindings) await new Promise<void>(resolve => { fixture.__finishBindingsSave = resolve; });
      bindings = parseLightboxBindings(value);
    }
    return structuredClone(bindings);
  },
  subscribe: async callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
};
const runtime = new ControllerRuntime(adapter);
let input = 0;
fixture.__controllerInput = (override: Partial<ControllerInput> = {}) => {
  const event = { session: "native-" + session, revision: runtime.getSnapshot().surface?.revision || 0, id: String(++input), kind: "key", index: 0, delta: 1, ...override } as ControllerInput;
  lastInput = `${event.kind} ${event.index + 1}`;
  for (const listener of listeners) listener(event);
};
fixture.__controllerState = () => runtime.getSnapshot();
function Fixture() {
  const [photo, setPhoto] = useState(1), [stars, setStars] = useState(0), [selected, setSelected] = useState(false), [busy, setBusy] = useState(false), [zoom, setZoom] = useState(1);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { fixture.__underlyingKeys.push(event.key); if (event.key === "Delete") setStars(-1); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  useControllerSurface({ id: "lightbox", title: "Lightbox · Review originals", contextKey: "photo-" + photo,
    keys: [
      { id: "rate-3", label: "Three stars", icon: "star", enabled: !busy, active: stars === 3, detail: stars ? `${stars} STARS` : "" },
      { id: "select", label: "Google select", icon: "check", enabled: !busy, active: selected, detail: selected ? "SELECTED" : "" },
      { id: "next", label: "Next original", icon: "next", enabled: !busy },
      { id: "crop", label: "Crop photo", icon: "crop", enabled: false },
      { id: "save", label: "Save photo", icon: "save", enabled: !busy, status: busy ? "saving" : "idle" },
      { id: "fit", label: "Fit view", icon: "zoom", enabled: !busy, detail: `${zoom.toFixed(1)}X` },
    ],
    dials: [{ label: "Photos", left: "previous", right: "next", press: "select" }, { label: "Zoom", left: "zoom-out", right: "zoom-in", press: "fit" }, { label: "Version", left: "previous", right: "next", press: "select" }],
    sideButtons: [{ label: "Previous", id: "previous" }, { label: "Next", id: "next" }, { label: "Select", id: "select" }],
    execute: async command => {
      fixture.__controllerCalls.push({ command });
      if (busy) return;
      if (command === "rate-3") setStars(3);
      else if (command === "select") setSelected(value => !value);
      else if (command === "next" || command === "previous") { setPhoto(value => Math.max(1, value + (command === "next" ? 1 : -1))); setStars(0); setSelected(false); }
      else if (command === "zoom-in" || command === "zoom-out") setZoom(value => Math.max(1, value + (command === "zoom-in" ? .25 : -.25)));
      else if (command === "fit") setZoom(1);
      else if (command === "save") { setBusy(true); await new Promise<void>(resolve => { fixture.__finishControllerSave = resolve; }); setBusy(false); }
    },
  }, true, runtime);
  return <main className="min-h-screen bg-surface-900 text-gray-200 p-5"><div className="max-w-4xl mx-auto"><h1 className="text-2xl font-semibold text-white">Photo Lightbox</h1><p className="mt-2 text-sm text-gray-400">Synthetic controller regression image · no media operations</p><div className="w-64 mt-5"><ControllerPanel runtime={runtime}/></div><div className="p-5 mt-6 rounded-xl bg-slate-800" data-testid="fixture-photo">Horse {photo} · stars {stars} · {selected ? "Selected" : "Not selected"}</div></div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
