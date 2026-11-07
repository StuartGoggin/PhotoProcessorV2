import type { ControllerDial } from "./types";

export const LIGHTBOX_TURNS = ["browse", "zoom", "versions", "off"] as const;
export const LIGHTBOX_PRESSES = ["fit", "select-active", "crop-version", "previous", "next", "trash", "off"] as const;
export type LightboxTurn = typeof LIGHTBOX_TURNS[number];
export type LightboxPress = typeof LIGHTBOX_PRESSES[number];
export interface LightboxDialBinding { turn: LightboxTurn; press: LightboxPress }
export interface LightboxBindings { version: 1; dials: LightboxDialBinding[] }

export function defaultLightboxBindings(): LightboxBindings {
  return { version: 1, dials: [{ turn: "browse", press: "fit" }, { turn: "zoom", press: "fit" }, { turn: "versions", press: "select-active" }] };
}

/** The native file is versioned and contains exactly three allow-listed assignments. */
export function parseLightboxBindings(value: unknown): LightboxBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Lightbox controller settings.");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || Object.keys(data).some(key => !["version", "dials"].includes(key)) || !Array.isArray(data.dials) || data.dials.length !== 3) throw new Error("Lightbox controller settings require version 1 and three dials.");
  const dials = data.dials.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid dial assignment.");
    const dial = raw as Record<string, unknown>;
    if (Object.keys(dial).length !== 2 || !Object.keys(dial).every(key => ["turn", "press"].includes(key))
      || !LIGHTBOX_TURNS.includes(dial.turn as LightboxTurn) || !LIGHTBOX_PRESSES.includes(dial.press as LightboxPress)) throw new Error("Unsupported Lightbox dial action.");
    return { turn: dial.turn as LightboxTurn, press: dial.press as LightboxPress };
  });
  return { version: 1, dials };
}

export const turnLabels: Record<LightboxTurn, string> = { browse: "Browse original photos", zoom: "Zoom image", versions: "Switch image version", off: "Off" };
export const pressLabels: Record<LightboxPress, string> = { fit: "Fit / reset view", "select-active": "Toggle active Google Photos selection", "crop-version": "Original / Cropped view", previous: "Previous original", next: "Next original", trash: "Toggle trash", off: "Off" };

export function lightboxDials(bindings: LightboxBindings, enabled: boolean, versionLabel: string): ControllerDial[] {
  return bindings.dials.map(({ turn, press }) => ({
    label: turn === "versions" ? `Version: ${versionLabel}` : turn === "browse" ? "Browse originals" : turn === "zoom" ? "Zoom image" : "Turn off",
    ...(turn === "browse" ? { left: "previous", right: "next" } : turn === "zoom" ? { left: "zoom-out", right: "zoom-in" } : turn === "versions" ? { left: "panel-previous", right: "panel-next" } : {}),
    ...(press !== "off" ? { press } : {}), enabled: enabled && (turn !== "off" || press !== "off"),
  }));
}
