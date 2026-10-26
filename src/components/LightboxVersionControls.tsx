import { useId } from "react";
import type { GooglePhotoAsset } from "../types/googlePhotos";

interface Props {
  label: string;
  shortcut: string;
  favouriteShortcut?: string;
  asset: GooglePhotoAsset | null;
  loading: boolean;
  disabled: boolean;
  saving: boolean;
  error?: string;
  onSelected: (value: boolean) => void;
  onFavourite: (value: boolean) => void;
}

/** Selection is confirmed native state. No optimistic checkmark implies a save. */
export default function LightboxVersionControls({ label, shortcut, favouriteShortcut, asset, loading, disabled, saving, error, onSelected, onFavourite }: Props) {
  const statusId = useId();
  const blocked = disabled || saving || loading || !asset;
  const state = saving ? "Saving…" : error ? "Not saved" : loading ? "Loading selection…" : !asset ? "Selection unavailable" : asset.selected ? "Selected · Saved" : "Not selected · Saved";
  return <div className="w-full space-y-1" data-testid={`lightbox-version-controls-${label.toLowerCase().replace(/\s+/g, "-")}`}>
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <label className={`flex flex-1 items-center gap-2 rounded-lg border px-2 py-1 min-w-0 ${blocked ? "cursor-default opacity-60" : "cursor-pointer hover:border-cyan-400/70"} ${asset?.selected ? "bg-cyan-950/50 border-cyan-500/70 text-cyan-100" : "bg-surface-900/50 border-surface-600 text-gray-200"}`}
        style={{ minHeight: 44, flexBasis: 128 }} title={`Select this exact ${label} version for Google Photos and Google-selected archive rules. This does not upload it. (${shortcut})`}>
        <input type="checkbox" className="accent-cyan-400 shrink-0 cursor-inherit" style={{ width: 24, height: 24, minWidth: 24, minHeight: 24 }}
          checked={asset?.selected ?? false} disabled={blocked} aria-label={`Upload ${label} to Google Photos`} aria-describedby={statusId}
          onChange={event => onSelected(event.target.checked)} />
        <span className="text-xs font-medium leading-tight">Google Photos</span>
        <kbd className="ml-auto rounded border border-surface-600 px-1.5 py-0.5 text-[10px] text-gray-400 shrink-0" aria-hidden="true">{shortcut}</kbd>
      </label>
      <button type="button" className={`w-11 h-11 shrink-0 rounded-lg border border-surface-600 text-2xl flex items-center justify-center disabled:opacity-50 ${asset?.favourite ? "text-amber-300 bg-amber-950/30" : "text-gray-400 bg-surface-900/50 hover:text-amber-200"}`}
        aria-label={`Favourite ${label}`} aria-pressed={asset?.favourite ?? false} disabled={blocked}
        title={`Favourite this version (${favouriteShortcut ?? `Shift+${shortcut}`})`} onClick={() => asset && onFavourite(!asset.favourite)}>{asset?.favourite ? "★" : "☆"}</button>
    </div>
    <div id={statusId} role="status" aria-live="polite" className={`px-1 text-[10px] leading-4 ${error ? "text-amber-200" : saving ? "text-cyan-200" : "text-gray-500"}`} title={error || undefined}>{state}</div>
    {asset?.uploadStatus && <span className="block px-1 text-[10px] text-cyan-200" title="A prior receipt is not proof that these current local bytes are unchanged. Review the publish plan before uploading again.">{asset.uploadStatus === "uploaded_previously" ? "Uploaded previously" : asset.uploadStatus.replace(/_/g, " ")}</span>}
  </div>;
}
