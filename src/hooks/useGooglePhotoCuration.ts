import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GooglePhotoAsset, GooglePhotoCatalogue } from "../types/googlePhotos";

/** Native curation owns stable asset identity. The browser never persists photo
 * paths, account data or credentials, and a failed write never appears saved. */
export function useGooglePhotoCuration(root: string, refreshKey?: unknown) {
  const [catalogue, setCatalogue] = useState<GooglePhotoCatalogue | null>(null);
  const [catalogueRoot, setCatalogueRoot] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const operation = useRef(false);
  const scanRunning = useRef(false);
  const deferredRefresh = useRef(false);
  const mounted = useRef(true);
  const refreshLatest = useRef<() => Promise<void>>(async () => {});
  const currentRoot = useRef(root);
  currentRoot.current = root;
  const refresh = useCallback(async () => {
    if (operation.current || scanRunning.current) { ++generation.current; deferredRefresh.current = true; return; }
    const request = ++generation.current;
    if (!root) { setCatalogue(null); setLoading(false); return; }
    setLoading(true); setError("");
    scanRunning.current = true;
    try {
      const result = await invoke<GooglePhotoCatalogue>("google_photos_catalogue", { root });
      if (mounted.current && request === generation.current && currentRoot.current === root) { setCatalogue(result); setCatalogueRoot(root); }
    } catch (reason) {
      if (mounted.current && request === generation.current) { setCatalogue(null); setError(`Upload selections unavailable: ${String(reason)}`); }
    } finally {
      scanRunning.current = false;
      if (mounted.current && deferredRefresh.current && !operation.current) {
        deferredRefresh.current = false; void refreshLatest.current();
      } else if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [root]);
  refreshLatest.current = refresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [refresh, refreshKey]);

  const update = useCallback(async (asset: GooglePhotoAsset, changes: { selected?: boolean; favourite?: boolean }) => {
    if (!root || operation.current || !mounted.current || currentRoot.current !== root) return false;
    operation.current = true; setSaving(true); setError("");
    // Invalidates an older scan so it cannot roll back a successful checkbox.
    ++generation.current;
    setLoading(false);
    try {
      const result = await invoke<GooglePhotoCatalogue>("google_photos_set_selection", {
        root, assetId: asset.id, selected: changes.selected,
        favourite: changes.favourite,
      });
      if (mounted.current && currentRoot.current === root) { setCatalogue(result); setCatalogueRoot(root); return true; }
      return false;
    } catch (reason) {
      if (mounted.current && currentRoot.current === root) setError(`Selection was not saved: ${String(reason)}. Try again.`);
      return false;
    } finally {
      operation.current = false;
      if (mounted.current) {
        setSaving(false);
        if (deferredRefresh.current) { deferredRefresh.current = false; void refreshLatest.current(); }
      }
    }
  }, [root]);
  return { assets: catalogueRoot === root ? catalogue?.assets ?? [] : [], warnings: catalogueRoot === root ? catalogue?.warnings ?? [] : [], loading, saving, error, refresh, update };
}
