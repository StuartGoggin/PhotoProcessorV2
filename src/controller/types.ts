import type { LightboxBindings } from "./lightboxBindings";

/** Page actions stay in PhotoGoGo. No controller action synthesises OS keys. */
export interface ControllerKey {
  id: string;
  label: string;
  icon?: string;
  detail?: string;
  enabled: boolean;
  active?: boolean;
  status?: "idle" | "saving" | "saved" | "error";
}

export interface ControllerDial {
  label: string;
  left?: string;
  right?: string;
  press?: string;
  enabled?: boolean;
  /** Accelerated increments are useful for video scrubbing, not rating/saving. */
  accelerate?: boolean;
}

export interface ControllerSideButton { label: string; id?: string; enabled?: boolean }

export interface ControllerSurface {
  id: string;
  title: string;
  /** Include the actual photo/frame/editing context, so old input is rejected. */
  contextKey: string;
  keys: readonly ControllerKey[];
  dials?: readonly ControllerDial[];
  sideButtons?: readonly ControllerSideButton[];
  priority?: number;
  execute: (commandId: string, amount?: number) => void | Promise<void>;
}

export type ControllerSurfaceView = Omit<ControllerSurface, "execute" | "priority"> & {
  revision: number;
  keys: ControllerKey[];
  dials: ControllerDial[];
  sideButtons: ControllerSideButton[];
};

export interface ControllerInput {
  session: string;
  revision: number;
  id: string;
  kind: "key" | "dial" | "side";
  index: number;
  delta: number;
}

export interface ControllerAcknowledgement {
  session: string;
  id: string;
  result: "handled" | "ignored" | "error";
  message?: string;
}

export interface ControllerStatus {
  enabled: boolean;
  phase: "disabled" | "searching" | "taking-over" | "connected" | "error" | "disconnected";
  message: string;
  device?: string;
  /** Native USB ownership session; changes after every reconnection/takeover. */
  session?: string;
  client?: string;
  vendorStopped: boolean;
  lastInput?: string;
  error?: string;
  brightness: number;
}

export interface NativeControllerSurface {
  client: string;
  revision: number;
  title: string;
  keys: Array<{ label: string; imageData: string; enabled: boolean; active: boolean }>;
  dials: Array<{ label: string }>;
  sideButtons: Array<{ label: string }>;
}

export interface ControllerSnapshot {
  status: ControllerStatus;
  surface: ControllerSurfaceView | null;
  actionBusy: boolean;
  configuring: boolean;
  notice: string;
  error: string;
  lightboxBindings: LightboxBindings;
  bindingsReady: boolean;
  bindingsBusy: boolean;
  bindingsError: string;
  identify: { active: boolean; index: number | null; session: string | null };
}

export const initialControllerStatus: ControllerStatus = {
  enabled: true, phase: "searching", message: "Checking for your AKP03E…",
  vendorStopped: false, brightness: 60,
};
