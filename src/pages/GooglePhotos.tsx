import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettings } from "../hooks";
import type { GooglePhotoAlbumEdit, GooglePhotoMode, GooglePhotoPlanItem, GooglePhotoVariant, GooglePhotosPlan, GooglePhotosPlanRequest, GooglePhotosStatus } from "../types/googlePhotos";
import { GOOGLE_PHOTO_VARIANTS, googlePhotoCounts, googlePhotoSize, googlePhotoVariantLabel } from "../utils/googlePhotos";
import { METADATA_TOOL_SOURCES, type MetadataToolStatus } from "../types/metadataTool";
import "./GooglePhotos.css";

const MODES: { id: GooglePhotoMode; label: string; detail: string }[] = [
  { id: "checked", label: "Use my Lightbox selections", detail: "Upload only the exact images checked in Photo Lightbox. Recommended." },
  { id: "variants", label: "Choose versions for this upload", detail: "Choose which photo versions to include without changing Lightbox checks." },
];
const ADVANCED_MODES: { id: GooglePhotoMode; label: string; detail: string }[] = [
  { id: "preferred_colour", label: "Best available colour", detail: "One per original: crop enhanced → crop → enhanced → original." },
  { id: "originals", label: "All originals", detail: "Untouched originals in this scope, with your filters applied." },
];
type PhotoFraming = "uncropped" | "cropped" | "both";
type UploadVersion = "original" | "enhanced" | "bw";
const PHOTO_VERSIONS: { id: UploadVersion; label: string; uncropped: GooglePhotoVariant; cropped: GooglePhotoVariant }[] = [
  { id: "original", label: "Original", uncropped: "original", cropped: "crop" },
  { id: "enhanced", label: "Enhanced", uncropped: "enhanced", cropped: "crop_enhanced" },
  { id: "bw", label: "B&W", uncropped: "bw", cropped: "crop_bw" },
];
const emptyStatus: GooglePhotosStatus = { configured: false, connecting: false };
const defaultRequest = (root: string): GooglePhotosPlanRequest => ({ root, mode: "checked", variants: ["original"], minStars: 0, favouritesOnly: false, excludeTrash: true, stripGps: false, albumMode: "new", groupByEventDay: true });
const thumbnailQueue: (() => Promise<void>)[] = [];
let thumbnailReads = 0;
function readThumbnail(planId: string, itemId: string, cancelled: () => boolean): Promise<string | null> {
  const pump = () => {
    while (thumbnailReads < 2 && thumbnailQueue.length) {
      const run = thumbnailQueue.shift()!; thumbnailReads++;
      void run().finally(() => { thumbnailReads--; pump(); });
    }
  };
  const result = new Promise<string | null>((resolve, reject) => thumbnailQueue.push(async () => {
    if (cancelled()) { resolve(null); return; }
    try { resolve(await invoke<string>("google_photos_thumbnail", { planId, itemId })); }
    catch (error) { reject(error); }
  }));
  pump(); return result;
}

/** Preview reads are local only and never become upload payloads. Read a bounded
 * visible page, two at a time; source-resolution upload remains native-owned. */
function useThumbnails(planId: string, items: GooglePhotoPlanItem[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = items.map(item => `${item.id}:${item.relativePath}`).join("\n");
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    const queue = items.filter(item => /\.(jpe?g|png)$/i.test(item.relativePath)).slice(0, 48);
    setUrls({});
    async function worker() {
      while (!cancelled) {
        const item = queue.shift();
        if (!item) return;
        try {
          const payload = await readThumbnail(planId, item.id, () => cancelled);
          if (cancelled || !payload) continue;
          const binary = atob(payload), bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
          created.push(url); setUrls(previous => ({ ...previous, [item.id]: url }));
        } catch { /* An unavailable preview is explicit; it never substitutes a different photo. */ }
      }
    }
    if (planId) { void worker(); void worker(); }
    return () => { cancelled = true; for (const url of created) URL.revokeObjectURL(url); };
  }, [planId, key]);
  return urls;
}

function AlbumReview({ planId, items, edit, disabled, expanded, onToggle, onChange }: { planId: string; items: GooglePhotoPlanItem[]; edit: GooglePhotoAlbumEdit; disabled: boolean; expanded: boolean; onToggle: () => void; onChange: (edit: GooglePhotoAlbumEdit) => void }) {
  const [page, setPage] = useState(0);
  const count = 24;
  const visible = items.slice(page * count, page * count + count);
  const urls = useThumbnails(planId, expanded ? visible : []);
  const coverOptions = items.filter(item => ["ready", "changed", "already_uploaded"].includes(item.status));
  const selectOptions = coverOptions.slice(0, 200);
  const currentCover = coverOptions.find(item => item.id === edit.coverItemId);
  if (currentCover && !selectOptions.some(item => item.id === currentCover.id)) selectOptions.push(currentCover);
  return <div className="gp-album">
    <div className="gp-album-heading">
      <label className="gp-field"><span>Album name</span><input aria-label={`Album name ${edit.key}`} value={edit.title} disabled={disabled} maxLength={500} onChange={event => onChange({ ...edit, title: event.target.value })} /><small>{items.length.toLocaleString()} planned version{items.length === 1 ? "" : "s"}. Name changes apply to this publish job only.</small></label>
      <label className="gp-field"><span>Album cover</span><select aria-label={`Album cover ${edit.key}`} value={edit.coverItemId ?? ""} disabled={disabled} onChange={event => onChange({ ...edit, coverItemId: event.target.value || undefined })}><option value="">Let Google choose</option>{selectOptions.map(item => <option key={item.id} value={item.id}>{item.relativePath.split(/[\\/]/).pop()} · {googlePhotoVariantLabel(item.variant)}</option>)}</select><small>Or select a frame in the paged preview. The cover must be successfully added to this album.{coverOptions.length > 200 ? " The menu shows the first 200; use the preview for all photos." : ""}</small></label>
    </div>
    <button className="btn-secondary text-xs mb-2" aria-expanded={expanded} onClick={onToggle}>{expanded ? "Hide photo preview" : `Preview photos in ${edit.title}`}</button>
    {expanded && <div className="gp-filmstrip" aria-label={`Album preview ${edit.title}`}>
      {visible.map(item => <div className="gp-frame" key={item.id} aria-current={edit.coverItemId === item.id}>
        <button type="button" disabled={disabled || !coverOptions.some(option => option.id === item.id)} aria-label={`Use ${item.relativePath} as album cover`} onClick={() => onChange({ ...edit, coverItemId: item.id })}>
          {urls[item.id] ? <img className="gp-thumb" src={urls[item.id]} alt={`Preview ${item.relativePath}`} /> : <span className="gp-thumb gp-thumb-empty">Local preview unavailable</span>}
          <div className="gp-frame-caption"><strong>{item.relativePath.split(/[\\/]/).pop()}</strong><span>{googlePhotoVariantLabel(item.variant)} · {googlePhotoSize(item.bytes)}</span><br /><span>{item.status.replace(/_/g, " ")}</span>{edit.coverItemId === item.id && <span className="gp-cover-tag">★ Album cover</span>}</div>
        </button>
      </div>)}
    </div>}
    {expanded && items.length > count && <div className="gp-row gp-between" style={{ marginTop: 10 }}><button className="btn-secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous photos</button><span className="gp-muted">{page * count + 1}–{Math.min(items.length, (page + 1) * count)} of {items.length}</span><button className="btn-secondary" disabled={(page + 1) * count >= items.length} onClick={() => setPage(value => value + 1)}>Next photos</button></div>}
  </div>;
}

export default function GooglePhotos({ onViewJob }: { onViewJob?: (jobId: string) => void }) {
  const { settings, error: settingsError } = useSettings();
  const root = settings?.staging_dir ?? "";
  const [status, setStatus] = useState<GooglePhotosStatus>(emptyStatus);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [request, setRequest] = useState<GooglePhotosPlanRequest>(defaultRequest(""));
  const [framing, setFraming] = useState<PhotoFraming>("uncropped");
  const [plan, setPlan] = useState<GooglePhotosPlan | null>(null);
  const [albumEdits, setAlbumEdits] = useState<GooglePhotoAlbumEdit[]>([]);
  const [previewAlbum, setPreviewAlbum] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pollError, setPollError] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [revoke, setRevoke] = useState(true);
  const [metadataStatus, setMetadataStatus] = useState<MetadataToolStatus | null>(null);
  const [checkingMetadata, setCheckingMetadata] = useState(false);
  const metadataBusy = useRef(false);
  const mounted = useRef(true);
  const planGeneration = useRef(0);
  const pollBusy = useRef(false);
  const actionBusy = useRef(false);
  useEffect(() => { setRequest(defaultRequest(root)); setFraming("uncropped"); setPlan(null); ++planGeneration.current; }, [root]);

  const refresh = useCallback(async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    const results = await Promise.allSettled([invoke<GooglePhotosStatus>("google_photos_status")]);
    if (mounted.current) {
      if (results[0].status === "fulfilled") { setStatus(results[0].value); setStatusLoaded(true); }
      setPollError(results.some(result => result.status === "rejected") ? "Google Photos status could not be refreshed. Local work is unaffected; retry to get current cloud status." : "");
    }
    pollBusy.current = false;
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; ++planGeneration.current; };
  }, [refresh]);
  useEffect(() => {
    if (!status.connecting) return;
    const interval = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(interval);
  }, [refresh, status.connecting]);

  const checkMetadataTool = useCallback(async () => {
    if (metadataBusy.current) return;
    metadataBusy.current = true; setCheckingMetadata(true);
    try {
      // Omit directory: Google Photos must resolve SAVED settings, not replace
      // a saved custom override with an accidental empty automatic override.
      const result = await invoke<MetadataToolStatus>("metadata_tool_status");
      if (mounted.current) setMetadataStatus(result);
    } catch (reason) {
      if (mounted.current) setMetadataStatus({ ready: false, source: "unavailable", message: `Could not check the metadata tool: ${String(reason)}` });
    } finally { metadataBusy.current = false; if (mounted.current) setCheckingMetadata(false); }
  }, []);
  useEffect(() => { void checkMetadataTool(); }, [checkMetadataTool]);

  function changeRequest(update: Partial<GooglePhotosPlanRequest>) {
    ++planGeneration.current; setRequest(previous => ({ ...previous, ...update })); setPlan(null); setAccepted(false); setMessage("");
  }
  const selectedVersions = PHOTO_VERSIONS.filter(version => request.variants.includes(version.uncropped) || request.variants.includes(version.cropped)).map(version => version.id);
  function changeVersions(versions: UploadVersion[], nextFraming = framing) {
    const variants = PHOTO_VERSIONS.filter(version => versions.includes(version.id)).flatMap(version => nextFraming === "cropped" ? [version.cropped] : nextFraming === "both" ? [version.uncropped, version.cropped] : [version.uncropped]);
    setFraming(nextFraming); changeRequest({ variants });
  }
  async function action(name: string, run: () => Promise<unknown>, success?: string) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(name); setError(""); setMessage("");
    try { await run(); if (mounted.current && success) setMessage(success); await refresh(); }
    catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { actionBusy.current = false; if (mounted.current) setBusy(""); }
  }
  async function configure() {
    await action("configure", async () => {
      const path = await open({ title: "Choose your Google desktop OAuth client JSON", multiple: false, directory: false, filters: [{ name: "Google OAuth client", extensions: ["json"] }] });
      if (typeof path === "string") await invoke("google_photos_configure", { configPath: path });
    });
  }
  async function chooseScope() {
    setError("");
    try {
      const path = await open({ title: "Choose a photo folder inside staging", directory: true, multiple: false, defaultPath: root || undefined });
      if (typeof path === "string") changeRequest({ scopeDir: path });
    } catch (reason) { setError(String(reason)); }
  }
  async function preview() {
    const generation = ++planGeneration.current;
    await action("plan", async () => {
      const result = await invoke<GooglePhotosPlan>("google_photos_plan", { request: { ...request, root } });
      if (!mounted.current || generation !== planGeneration.current) return;
      setPlan(result); setAlbumEdits(result.albums.map(album => ({ key: album.key, title: album.title, coverItemId: album.coverItemId || undefined }))); setPreviewAlbum(result.albums[0]?.key ?? null); setAccepted(false);
    });
  }
  async function publish() {
    if (!plan || !accepted) return;
    const planId = plan.id;
    await action("start", async () => {
      const jobId = await invoke<string>("google_photos_start", { planId, albums: albumEdits, acknowledgeWarnings: accepted });
      if (mounted.current) { setLastJobId(jobId); setPlan(null); setAccepted(false); }
    }, "Upload job saved in Jobs. Local photos and Lightbox selections are unchanged.");
  }
  const counts = useMemo(() => googlePhotoCounts(plan?.items ?? []), [plan]);
  const reviewedVersions = useMemo(() => GOOGLE_PHOTO_VARIANTS.map(variant => ({ ...variant, count: plan?.items.filter(item => item.variant === variant.id).length ?? 0 })).filter(variant => variant.count > 0), [plan]);
  const hasWarnings = !!plan && (plan.warnings.length > 0 || plan.items.some(item => item.warnings.length > 0));
  const albumOnlyEdit = !!plan && counts.skipped > 0 && plan.albums.some(album => {
    const edit = albumEdits.find(item => item.key === album.key);
    return !!album.albumId && !!edit && (edit.title.trim() !== album.title.trim() || edit.coverItemId !== (album.coverItemId || undefined));
  });
  const canPublish = !!plan && (counts.ready > 0 || albumOnlyEdit) && accepted && !busy && !!status.account && status.account.id === plan.accountId && albumEdits.every(album => album.title.trim().length > 0 && album.title.length <= 500);
  const canPreview = !!root && !!status.account && !busy && (request.mode !== "variants" || request.variants.length > 0);

  return <div className="google-photos">
    <header className="gp-header"><div><div className="gp-eyebrow">Transfer · Curate → review → publish</div><h2>Transfer to Google Photos</h2><p className="gp-muted">Publish the versions you love, at full resolution. Your local originals, crops and processing recipes stay untouched.</p></div><span className="gp-pill">New albums are private · continued albums retain their sharing settings</span></header>
    {settingsError && <div className="gp-error" role="alert">Could not load staging settings: {settingsError}</div>}
    {error && <div className="gp-error" role="alert">{error}</div>}
    {message && <div className="gp-success" role="status">{message}</div>}
    {pollError && <div className="gp-note" role="status">{pollError} <button className="underline" onClick={() => void refresh()}>Retry status</button></div>}

    <section className="gp-section" aria-labelledby="gp-account-heading"><h3 id="gp-account-heading"><span className="gp-step" aria-hidden="true">1</span>Your Google account</h3>
      <div className="gp-row gp-between">
        <div className="gp-account"><span className="gp-account-icon" aria-hidden="true">{status.account ? "✓" : "G"}</span><div>{status.account ? <><strong>{status.account.email}</strong><p className="gp-muted">{status.account.displayName} · album history is isolated to this account</p></> : <><strong>{statusLoaded ? "Not connected" : "Checking connection…"}</strong><p className="gp-muted">Sign in using your normal browser. Passwords never pass through PhotoGoGo.</p></>}</div></div>
        <div className="gp-row gp-actions"><button className="btn-secondary" disabled={!!busy} onClick={() => void refresh()}>Refresh account</button><button className="btn-secondary" disabled={!!busy || !!status.account || status.connecting} onClick={() => void configure()}>Import OAuth setup</button>{status.account ? <button className="btn-secondary" disabled={!!busy} onClick={() => setDisconnectOpen(value => !value)}>Disconnect</button> : <button className="btn-primary" disabled={!status.configured || !!busy || status.connecting} onClick={() => void action("connect", () => invoke("google_photos_connect"))}>{status.connecting || busy === "connect" ? "Waiting for browser sign-in…" : "Connect Google Photos"}</button>}</div>
      </div>
      {status.configured && <p className="gp-muted" style={{ marginTop: 8 }}>Desktop OAuth setup configured{status.clientIdHint ? ` · ${status.clientIdHint}` : ""}. Refresh tokens and upload sessions are kept in protected native storage, not browser storage.</p>}
      {status.error && <div className="gp-note" role="status">{status.error}</div>}
      {disconnectOpen && <div className="gp-disconnect"><p>Disconnect this account? Existing Google Photos albums are never deleted. Paused jobs remain tied to this account and cannot run as a different user.</p><label className="gp-checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={revoke} onChange={event => setRevoke(event.target.checked)} />Also revoke Google access for this OAuth project</label><p className="gp-muted mt-1">Checked: Google may invalidate this project’s tokens on your other installations too. Unchecked: forget this installation’s saved tokens only. Neither choice removes uploaded photos.</p><div className="gp-row gp-actions" style={{ marginTop: 10 }}><button className="btn-danger" disabled={!!busy} onClick={() => void action("disconnect", async () => { await invoke("google_photos_disconnect", { revoke }); setDisconnectOpen(false); setPlan(null); }, "Disconnected. Local photos and Google albums are unchanged.")}>Confirm disconnect</button><button className="btn-secondary" onClick={() => setDisconnectOpen(false)}>Keep connected</button></div></div>}
      <details className="gp-details"><summary>Personal account setup and privacy</summary><ol className="list-decimal ml-5 space-y-1 mt-2"><li>Create or select your personal Google Cloud project and enable the Google Photos Library API.</li><li>Configure the OAuth consent screen, add your account as a test user if using Testing, and download an OAuth client of type Desktop app.</li><li>Import that JSON here, then connect. Do not paste passwords, refresh tokens or credentials into chat.</li></ol><p className="gp-muted mt-2">PhotoGoGo requests permission to add photos and to read/edit only content it created, including album covers. It cannot browse unrelated Google Photos albums. Google Testing access can require reconnecting after seven days. Cloud storage usage counts against your Google account.</p><p className="gp-muted mt-2">Selections are local curation data; cloud history is account-specific. Disconnect revokes access when selected but does not delete uploaded photos. Google Photos links are private account links, not public sharing links.</p></details>
    </section>

    <section className="gp-section" aria-labelledby="gp-select-heading"><h3 id="gp-select-heading"><span className="gp-step" aria-hidden="true">2</span>Choose photos and publishing rules</h3>
      <div role="group" aria-label="Metadata tool readiness" className={`gp-metadata ${metadataStatus?.ready ? "gp-metadata-ready" : metadataStatus ? "gp-metadata-unavailable" : ""}`}>
        <div className="gp-row gp-between"><div role="status"><strong>{checkingMetadata ? "Checking metadata tool…" : metadataStatus?.ready ? "Metadata tool ready" : metadataStatus ? "Metadata tool unavailable" : "Metadata tool not checked"}</strong>{metadataStatus && !checkingMetadata && <span className="gp-muted"> · {METADATA_TOOL_SOURCES[metadataStatus.source] ?? "Unavailable"}{metadataStatus.version ? ` · Version ${metadataStatus.version}` : ""}</span>}</div><button type="button" className="btn-secondary text-xs" disabled={checkingMetadata} onClick={() => void checkMetadataTool()}>Recheck metadata tool</button></div>
        {metadataStatus && !checkingMetadata && <p className="gp-muted">{metadataStatus.message}</p>}
        <p className="gp-muted">{metadataStatus?.ready ? "Processed versions and GPS-safe upload copies can use this metadata tool. Every file is still checked during review." : "Processed versions and GPS removal need a working metadata tool. Untouched originals without GPS removal can still be reviewed; native preflight checks each file. Check the optional override in Settings if needed."}</p>
      </div>
      <div className="gp-row gp-between"><div className="gp-muted" style={{ overflowWrap: "anywhere" }}><strong className="text-gray-200">Scope:</strong> {request.scopeDir || root || "Set a local staging directory in Settings"}</div><div className="gp-row gp-actions"><button className="btn-secondary" disabled={!root || !!busy} onClick={() => void chooseScope()}>Choose folder</button>{request.scopeDir && <button className="btn-secondary" disabled={!!busy} onClick={() => changeRequest({ scopeDir: undefined })}>Entire staging</button>}</div></div>
      <div className="gp-mode-list" role="radiogroup" aria-label="Photo selection mode">{MODES.map(mode => <label className="gp-mode" key={mode.id}><input type="radio" name="google-photo-mode" value={mode.id} checked={request.mode === mode.id} disabled={!!busy} onChange={() => changeRequest({ mode: mode.id })} /><span><strong>{mode.label}</strong><small>{mode.detail}</small></span></label>)}</div>
      {request.mode !== "checked" && <div className="gp-note">This is a one-job override. It does not alter any checkbox in Photo Lightbox.</div>}
      {request.mode === "variants" && <div className="gp-version-choice"><fieldset className="gp-row" aria-label="Photo version types"><legend>Photo versions</legend>{PHOTO_VERSIONS.map(version => <label className="gp-checkbox" key={version.id}><input type="checkbox" checked={selectedVersions.includes(version.id)} disabled={!!busy} onChange={event => changeVersions(event.target.checked ? [...selectedVersions, version.id] : selectedVersions.filter(id => id !== version.id))} />{version.label}</label>)}</fieldset><label className="gp-field"><span>Photo framing</span><select aria-label="Photo framing" value={framing} disabled={!!busy} onChange={event => changeVersions(selectedVersions, event.target.value as PhotoFraming)}><option value="uncropped">Uncropped versions</option><option value="cropped">Cropped versions only</option><option value="both">Both uncropped and cropped</option></select></label>{framing === "cropped" && <p className="gp-muted">Only existing cropped versions will be included. Missing crops are skipped; uncropped files are never substituted.</p>}{framing === "both" && <p className="gp-muted">Each chosen version is included both uncropped and cropped where those files exist. Missing versions are skipped.</p>}</div>}
      <details className="gp-details gp-advanced"><summary><span>Advanced photo selection</span>{(request.mode === "preferred_colour" || request.mode === "originals" || request.minStars > 0 || request.favouritesOnly) && <span className="gp-pill">Active</span>}</summary><div className="gp-mode-list" role="radiogroup" aria-label="Advanced selection strategies">{ADVANCED_MODES.map(mode => <label className="gp-mode" key={mode.id}><input type="radio" name="google-photo-advanced-mode" value={mode.id} checked={request.mode === mode.id} disabled={!!busy} onChange={() => changeRequest({ mode: mode.id })} /><span><strong>{mode.label}</strong><small>{mode.detail}</small></span></label>)}</div><div className="gp-grid"><label className="gp-field"><span>Minimum Lightbox stars</span><select aria-label="Minimum Lightbox stars" value={request.minStars} disabled={!!busy} onChange={event => changeRequest({ minStars: Number(event.target.value) })}><option value={0}>All ratings</option><option value={1}>★ or higher</option><option value={2}>★★ or higher</option><option value={3}>★★★ only</option></select></label><label className="gp-checkbox"><input type="checkbox" checked={request.favouritesOnly} disabled={!!busy} onChange={event => changeRequest({ favouritesOnly: event.target.checked })} />Only Google Photos favourites from Lightbox</label></div></details>
      {(request.mode === "preferred_colour" || request.mode === "originals" || request.minStars > 0 || request.favouritesOnly) && <p className="gp-muted">Advanced selection active: {ADVANCED_MODES.find(mode => mode.id === request.mode)?.label ?? (request.mode === "checked" ? "Lightbox selections" : "Chosen versions")}{request.minStars > 0 ? ` · ${request.minStars}+ stars` : ""}{request.favouritesOnly ? " · favourites only" : ""}.</p>}
      <div className="gp-grid" style={{ marginTop: 16 }}><div className="space-y-3"><label className="gp-checkbox"><input type="checkbox" checked={request.excludeTrash} disabled={!!busy} onChange={event => changeRequest({ excludeTrash: event.target.checked })} />Exclude photos marked as trash</label><br /><label className="gp-checkbox"><input type="checkbox" checked={request.stripGps} disabled={!!busy} onChange={event => changeRequest({ stripGps: event.target.checked })} />Remove GPS location from upload copies</label></div>
      <div className="space-y-3"><label className="gp-field"><span>Album destination</span><select aria-label="Album destination" value={request.albumMode} disabled={!!busy} onChange={event => changeRequest({ albumMode: event.target.value as "new" | "continue" })}><option value="new">Create new album(s)</option><option value="continue">Continue PhotoGoGo event album(s)</option></select><small>Continue uses this account’s saved PhotoGoGo-created albums, never a title-only match.</small></label><label className="gp-checkbox"><input type="checkbox" checked={request.groupByEventDay} disabled={!!busy} onChange={event => changeRequest({ groupByEventDay: event.target.checked })} />Separate album for each event / shooting day</label></div></div>
      <details className="gp-details"><summary>Optional event and date override</summary><p className="gp-muted">Album names use event folders and shooting dates when available. Override only when that information is missing or you intentionally want a different grouping; local capture metadata is not invented from this label.</p><div className="gp-grid" style={{ marginTop: 10 }}><label className="gp-field"><span>Event name</span><input aria-label="Event name override" value={request.eventName ?? ""} disabled={!!busy} onChange={event => changeRequest({ eventName: event.target.value || undefined })} placeholder="Use event folder names" /></label><label className="gp-field"><span>Event date</span><input type="date" aria-label="Event date override" value={request.eventDate ?? ""} disabled={!!busy} onChange={event => changeRequest({ eventDate: event.target.value || undefined })} /></label></div></details>
      <p className="gp-muted">Full resolution · no extra image recompression · originals remain untouched. Metadata and privacy changes use temporary upload copies. Changed files become new Google media versions; existing Google images are not overwritten.</p>
      <div className="gp-row gp-actions" style={{ marginTop: 14 }}><button className="btn-primary" disabled={!canPreview} onClick={() => void preview()}>{busy === "plan" ? "Inspecting local photos…" : "Review publish plan"}</button><span className="gp-muted">No album or photo is created until you confirm the plan.</span></div>
      {!status.account && <p className="gp-muted mt-2">Connect your Google account to review account-specific upload history.</p>}
    </section>

    {plan && <section className="gp-section" aria-labelledby="gp-review-heading"><h3 id="gp-review-heading"><span className="gp-step" aria-hidden="true">3</span>Review before publishing</h3><p className="gp-muted">Destination account: <strong className="text-gray-100">{plan.accountEmail}</strong>. This saved plan pins the versions inspected now; changed or missing files will not be silently substituted.</p>
      <div className="gp-summary"><div className="gp-stat"><strong>{counts.ready.toLocaleString()}</strong><span>Ready to upload{counts.changed ? ` · ${counts.changed} changed` : ""}</span></div><div className="gp-stat"><strong>{counts.skipped.toLocaleString()}</strong><span>Already uploaded · skipped</span></div><div className="gp-stat"><strong>{counts.blocked.toLocaleString()}</strong><span>Blocked / missing / unsupported</span></div><div className="gp-stat"><strong>{googlePhotoSize(plan.totalBytes)}</strong><span>{plan.albums.length} album{plan.albums.length === 1 ? "" : "s"} · full-resolution payload</span></div></div>
      <div className="gp-version-summary" role="group" aria-label="Exact photo versions in this plan"><strong>Exact versions inspected</strong><div className="gp-pills">{reviewedVersions.map(variant => <span className="gp-pill" key={variant.id}>{variant.label}: {variant.count.toLocaleString()}</span>)}</div><p className="gp-muted">These counts include already-uploaded and excluded versions; the totals above show what will actually upload. No missing version is silently replaced.</p></div>
      {hasWarnings && <div className="gp-note"><strong>Review these checks</strong><ul className="list-disc ml-4 mt-1">{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{plan.items.some(item => item.warnings.length > 0) && <details className="gp-details"><summary>Per-photo metadata and availability warnings</summary><ul>{plan.items.filter(item => item.warnings.length > 0).map(item => <li key={item.id}><strong>{item.relativePath}:</strong> {item.warnings.join("; ")}</li>)}</ul></details>}</div>}
      {status.account?.id !== plan.accountId && <div className="gp-error" role="alert">The connected account has changed. Create a fresh plan for the intended account.</div>}
      {plan.albums.map(album => { const edit = albumEdits.find(item => item.key === album.key)!; const ids = new Set(album.itemIds); const albumItems = plan.items.filter(item => ids.has(item.id)); return <div key={album.key}><div className="gp-pills"><span className="gp-pill">{album.albumId ? "Continuing an app-created album" : "New private album"}</span>{album.date && <span className="gp-pill">{album.date}</span>}</div><AlbumReview planId={plan.id} items={albumItems} edit={edit} disabled={!!busy} expanded={previewAlbum === album.key} onToggle={() => setPreviewAlbum(previous => previous === album.key ? null : album.key)} onChange={changed => { setAlbumEdits(previous => previous.map(item => item.key === changed.key ? changed : item)); setAccepted(false); }} /></div>; })}
      {counts.blocked > 0 && <details className="gp-details"><summary>Photos that will not be uploaded ({counts.blocked})</summary><ul>{plan.items.filter(item => !["ready", "changed", "already_uploaded"].includes(item.status)).map(item => <li key={item.id}>{item.relativePath} — {item.status.replace(/_/g, " ")}{item.warnings.length ? `: ${item.warnings.join("; ")}` : ""}</li>)}</ul></details>}
      <div className="gp-publish"><label className="gp-checkbox"><input type="checkbox" checked={accepted} disabled={!!busy} onChange={event => setAccepted(event.target.checked)} />I reviewed this account, albums and warnings. Uploads use my Google storage; no public sharing or local file changes will be made.</label><button className="btn-primary" disabled={!canPublish} onClick={() => void publish()}>{busy === "start" ? "Saving upload job…" : counts.ready > 0 ? `Publish ${counts.ready} photo${counts.ready === 1 ? "" : "s"}` : "Update album details"}</button></div>
      {counts.ready === 0 && <p className="gp-muted mt-2">{albumOnlyEdit ? "Only the reviewed existing album title/cover will change; already-uploaded photos are not uploaded again." : "Nothing new is ready to upload. Change your selection, resolve the reported checks, or edit the title/cover of an existing app-created album."}</p>}
    </section>}

    {lastJobId && <div className="gp-section"><p className="gp-muted">This upload is a normal process job. Progress, controls, receipt details and recovery are in Jobs.</p><button className="btn-primary mt-2" onClick={() => onViewJob?.(lastJobId)}>View job</button></div>}
  </div>;
}
