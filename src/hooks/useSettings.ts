import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types";

interface UseSettingsResult {
  settings: Settings | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads app settings from the Tauri backend on mount.
 * Shared by all pages that need directory configuration.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("load_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { settings, loading, error };
}
