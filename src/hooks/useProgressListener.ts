import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

interface UseProgressListenerResult {
  /** Start listening for progress events. Call before invoking a long-running command. */
  subscribe: (handler: (data: unknown) => void) => Promise<void>;
  /** Stop listening. Call in the finally block after the command resolves. */
  unsubscribe: () => void;
}

/**
 * Manages a Tauri event listener for a single long-running operation.
 * Handles cleanup automatically on component unmount.
 *
 * @param eventName  The Tauri event name to listen for (e.g. "import-progress")
 */
export function useProgressListener<T = unknown>(
  eventName: string
): UseProgressListenerResult {
  const unlistenRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  const subscribe = useCallback(
    async (handler: (data: T) => void) => {
      // Remove any stale listener first
      unlistenRef.current?.();
      const unlisten = await listen<T>(eventName, (e) => handler(e.payload));
      unlistenRef.current = unlisten;
    },
    [eventName]
  );

  const unsubscribe = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  return { subscribe, unsubscribe };
}
