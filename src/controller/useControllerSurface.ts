import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { controllerRuntime, type ControllerRuntime } from "./runtime";
import type { ControllerSurface } from "./types";

/** Register the visible page/editor. Higher-priority editors own the temporary layout. */
export function useControllerSurface(surface: ControllerSurface, active = true, runtime: ControllerRuntime = controllerRuntime()) {
  const owner = useRef(Symbol("controller-surface"));
  useLayoutEffect(() => () => runtime.remove(owner.current), [runtime]);
  useLayoutEffect(() => { if (active) runtime.register(owner.current, surface); else runtime.remove(owner.current); });
}

export function useControllerStatus(runtime: ControllerRuntime = controllerRuntime()) {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}

export function useLightboxBindings(runtime: ControllerRuntime = controllerRuntime()) {
  return useSyncExternalStore(runtime.subscribe, runtime.getLightboxBindings, runtime.getLightboxBindings);
}
