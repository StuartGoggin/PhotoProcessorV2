import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GooglePhotoAsset, GooglePhotoCatalogue } from "../types/googlePhotos";
import { googlePhotoPathKey } from "../utils/googlePhotos";
import { curationWriter as writer } from "../utils/curationPersistence";

type Changes = { selected?: boolean; favourite?: boolean };
interface Intent { id: number; assetId: string; changes: Changes }
const createModel = (root: string) => ({ root, assets: new Map<string, GooglePhotoAsset>(), paths: new Map<string, string | null>(),
  pending: [] as Intent[], warnings: [] as string[], loading: false, error: "", generation: 0, scanning: false, deferred: false, deferredClear: false });

/** Requested flags paint immediately. Only compact native acknowledgements
 * update confirmed flags; older completions cannot erase newer queued intent. */
export function useGooglePhotoCuration(root: string, refreshKey?: unknown) {
  const [, redraw] = useState(0);
  const modelRef = useRef(createModel(root));
  if (modelRef.current.root !== root) modelRef.current = createModel(root);
  const mounted = useRef(true), sequence = useRef(0);
  const refreshLatest = useRef<(clearErrors?: boolean) => Promise<void>>(async () => {});
  const notify = (model: ReturnType<typeof createModel>) => {
    if (mounted.current && model === modelRef.current) redraw(value => value + 1);
  };
  const refresh = useCallback(async (clearErrors = false) => {
    const model = modelRef.current;
    if (model.root !== root) return;
    if (model.scanning || model.pending.length) { model.generation++; model.deferred = true; model.deferredClear ||= clearErrors; return; }
    const request = ++model.generation;
    if (!root) { model.assets.clear(); model.paths.clear(); model.loading = false; notify(model); return; }
    model.loading = true; model.error = ""; model.scanning = true; notify(model);
    try {
      // A prior Review can have accepted writes still draining after unmount.
      await writer.settled();
      const result = await invoke<GooglePhotoCatalogue>("google_photos_catalogue", { root });
      if (mounted.current && model === modelRef.current && request === model.generation) {
        model.assets = new Map(result.assets.map(asset => [asset.id, asset]));
        model.paths.clear();
        for (const asset of result.assets) {
          const key = googlePhotoPathKey(asset.relativePath);
          model.paths.set(key, model.paths.has(key) ? null : asset.id);
        }
        model.warnings = result.warnings;
        if (clearErrors) writer.clearErrors(root);
      }
    } catch (error) {
      if (model === modelRef.current && request === model.generation) model.error = `Upload selections unavailable: ${String(error)}`;
    } finally {
      model.scanning = false;
      if (mounted.current && model === modelRef.current) {
        if (model.deferred && !model.pending.length) { const clear = clearErrors || model.deferredClear; model.deferred = false; model.deferredClear = false; void refreshLatest.current(clear); }
        else if (request === model.generation) model.loading = false;
        notify(model);
      }
    }
  }, [root]);
  refreshLatest.current = refresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; modelRef.current.generation++; }; }, []);
  useEffect(() => { void refresh(); return () => { modelRef.current.generation++; }; }, [refresh, refreshKey]);

  function effective(asset: GooglePhotoAsset) {
    let view = asset;
    for (const intent of modelRef.current.pending) if (intent.assetId === asset.id) view = { ...view, ...intent.changes };
    return view;
  }
  function assetForPath(path: string | undefined) {
    const model = modelRef.current;
    const id = path ? model.paths.get(googlePhotoPathKey(path)) : undefined;
    const asset = id ? model.assets.get(id) : undefined;
    return asset ? effective(asset) : undefined;
  }
  async function update(asset: GooglePhotoAsset, changes: Changes) {
    const model = modelRef.current;
    if (!root || model.root !== root || !mounted.current || model.loading || !model.assets.has(asset.id)
      || model.assets.get(asset.id)?.relativePath !== asset.relativePath) return false;
    const intent: Intent = { id: ++sequence.current, assetId: asset.id, changes: { ...changes } };
    model.pending.push(intent); ++model.generation; model.error = ""; notify(model);
    let saved = false;
    try {
      const result = await writer.enqueue({ root, assetId: asset.id, relativePath: asset.relativePath, ...changes });
      const confirmed = model.assets.get(asset.id);
      if (confirmed) model.assets.set(asset.id, { ...confirmed, selected: result.selected, favourite: result.favourite });
      saved = true;
    } catch (error) {
      // Queue admission failures also need a visible error; native failures are
      // retained by the writer for a view reopened after a late completion.
      if (!writer.error(root, asset.id)) model.error = `Selection save was not confirmed: ${String(error)}. Try again.`;
    }
    finally {
      model.pending = model.pending.filter(item => item.id !== intent.id);
      if (mounted.current && model === modelRef.current) {
        if (model.deferred && !model.pending.length && !model.scanning) { const clear = model.deferredClear; model.deferred = false; model.deferredClear = false; void refreshLatest.current(clear); }
        notify(model);
      }
    }
    return saved && mounted.current && model === modelRef.current;
  }
  const model = modelRef.current;
  return { get assets() { return [...model.assets.values()].map(effective); }, warnings: model.warnings, loading: model.loading,
    saving: model.pending.length > 0, error: model.error || writer.error(root), refresh, update, assetForPath,
    hasPending: () => modelRef.current.pending.length > 0,
    pendingFor: (id?: string) => !!id && modelRef.current.pending.some(intent => intent.assetId === id),
    errorFor: (id?: string) => id ? writer.error(root, id) : "",
  };
}
