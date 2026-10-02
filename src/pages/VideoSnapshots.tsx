import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { defaultSnapshotRecipe } from "../types/videoSnapshots";
import type { SnapshotClip, SnapshotExport, SnapshotFrame, SnapshotFrames, SnapshotRecipe, SnapshotSelection, SnapshotSession, SnapshotSessionDocument, SnapshotSessionLibrary, SnapshotSessionSummary, SnapshotSource } from "../types/videoSnapshots";
import { frameAtTime, MAX_SNAPSHOT_CLIPS, MAX_SNAPSHOTS, mergeSnapshotSession, parseSnapshotSession, SnapshotFrameCache, SnapshotPreviewWarmup, snapshotReadAheadOrder, snapshotCapturedAt, snapshotExportMatchesDestination, snapshotPathKey, snapshotTime, validShootingStart, validateSnapshotClip } from "../utils/videoSnapshots";
import { SnapshotSessionWriter } from "../utils/snapshotSessionWriter";
import type { SnapshotSaveState } from "../utils/snapshotSessionWriter";
import SnapshotSessionsHome from "./SnapshotSessionsHome";
import "./VideoSnapshots.css";

type QueueItem = { id: string; path: string; status: "queued" | "indexing" | "ready" | "cancelled" | "error"; error?: string; saved?: SnapshotSession["sources"][number]; photos?: SnapshotSession["selections"] };
type DisplayFrame = { clipId: string; frame: SnapshotFrame };
const requestId = () => `snap-${crypto.randomUUID()}`;
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
const explain = (error: unknown) => error instanceof Error ? error.message : String(error);
const isField = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable=true],[role=textbox]");
const emptySession = (): SnapshotSession => ({ kind: "photogogo-video-snapshots", version: 1, sources: [], selections: [], pendingPaths: [], workspace: { personName: "", destination: "", selectedSourcePath: "" } });
const lastSessionKey = "photogogo.snapshots.last-session";
const lastSessionId = () => { try { return localStorage.getItem(lastSessionKey) || ""; } catch { return ""; } };

async function smallThumbnail(data: string): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 240 / image.width, 160 / image.height);
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) { resolve(""); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch { resolve(""); }
    };
    image.onerror = () => resolve("");
    image.src = data;
  });
}

export default function VideoSnapshots({ active = true }: { active?: boolean }) {
  const [sources, setSources] = useState<SnapshotSource[]>([]);
  const sourcesRef = useRef(sources);
  const [selections, setSelections] = useState<SnapshotSelection[]>([]);
  const selectionsRef = useRef(selections);
  const [selectedClip, setSelectedClip] = useState("");
  const selectedClipRef = useRef(selectedClip);
  selectedClipRef.current = selectedClip;
  const [selectedPhoto, setSelectedPhoto] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const queueRef = useRef(queue);
  const worker = useRef(false);
  const queueRequest = useRef<{ item: string; request: string } | null>(null);
  const epoch = useRef(0);
  const alive = useRef(true);
  const requests = useRef(new Set<string>());
  const flights = useRef(new Set<Promise<unknown>>());
  const forgetting = useRef(new Set<Promise<unknown>>());
  const queueFlight = useRef<Promise<void> | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const operationBusy = useRef(false);
  const baseline = useRef<SnapshotSession>(emptySession());
  const [currentSession, setCurrentSession] = useState<SnapshotSessionDocument | null>(null);
  const [sessionHome, setSessionHome] = useState(true);
  const sessionHomeRef = useRef(sessionHome); sessionHomeRef.current = sessionHome;
  const [sessionLibrary, setSessionLibrary] = useState<SnapshotSessionSummary[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [lastSession, setLastSession] = useState(lastSessionId);
  const [saveState, setSaveState] = useState<SnapshotSaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<{ mode: "new" | "rename" | "duplicate"; entry?: SnapshotSessionSummary } | null>(null);
  const [sessionName, setSessionName] = useState("");
  const readDocument = useRef<() => string>(() => JSON.stringify(emptySession()));
  const writer = useRef<SnapshotSessionWriter | null>(null);
  if (!writer.current) writer.current = new SnapshotSessionWriter(() => readDocument.current(),
    (entry, json) => invoke<SnapshotSessionDocument>("snapshot_session_put", { id: entry.id, expectedRevision: entry.revision, name: entry.name, json }),
    (state, entry, failure) => {
      if (!alive.current) return;
      setSaveState(state); setSaveError(failure || ""); setCurrentSession(entry);
      dirtyRef.current = state !== "saved"; setDirty(state !== "saved");
      if (entry) setSessionLibrary(items => [entry, ...items.filter(item => item.id !== entry.id)]);
    });
  const [display, setDisplay] = useState<DisplayFrame | null>(null);
  const [frameError, setFrameError] = useState("");
  const cache = useRef(new SnapshotFrameCache());
  const warmup = useRef(new SnapshotPreviewWarmup());
  const priorityRequests = useRef(new Set<string>());
  const suspendFrames = useRef<() => void>(() => {});
  const navigationDirection = useRef(0);
  const timelineMove = useRef(0);
  const viewerPaused = useRef(false);
  const [readAheadStatus, setReadAheadStatus] = useState("");
  const failedFrames = useRef(new Set<string>());
  const [cacheMB, setCacheMB] = useState(32);
  const desiredFrame = useRef({ clipId: "", index: 0, changed: 0, direction: 0 });
  const [shuttle, setShuttle] = useState(0);
  const shuttleRef = useRef(0);
  const hold = useRef<ReturnType<typeof setInterval> | null>(null);
  const [personName, setPersonName] = useState("");
  const [destination, setDestination] = useState("");
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  viewerPaused.current = sessionBusy || sessionHome || !!exporting;
  const exportingRef = useRef(false); exportingRef.current = !!exporting;
  const exportCancel = useRef(false);
  const exportRequest = useRef("");
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({});
  const [locationError, setLocationError] = useState<{ id: string; path: string; message: string } | null>(null);
  const [adjusted, setAdjusted] = useState<{ key: string; data: string } | null>(null);
  const [adjustError, setAdjustError] = useState("");
  const [showBefore, setShowBefore] = useState(false);
  const [tips, setTips] = useState(false);
  const source = sources.find((s) => s.clip.id === selectedClip);
  const photo = selections.find((s) => s.id === selectedPhoto);
  const photoSource = sources.find((s) => s.clip.id === photo?.clipId);
  const index = source?.position ?? 0;
  const exact = !!source && display?.clipId === source.clip.id && display.frame.index === index;
  const existing = selections.find((s) => s.clipId === selectedClip && s.index === index);
  const preservedPhotoCount = baseline.current.selections.filter(p => !sources.some(s => snapshotPathKey(s.clip.path) === snapshotPathKey(p.sourcePath) && s.clip.identity === p.identity)).length;
  const totalPhotoCount = selections.length + preservedPhotoCount;
  const indexing = queue.some((item) => item.status === "queued" || item.status === "indexing");
  const pendingCount = queue.filter((item) => item.status === "queued" || item.status === "indexing").length;
  const recipeKey = photo ? JSON.stringify([photo.id, photo.clipId, photo.index, photo.recipe]) : "";
  const editingCurrent = !!photo && photo.clipId === selectedClip && photo.index === index;
  const showingAdjusted = editingCurrent && !showBefore && adjusted?.key === recipeKey;
  const shownFrame = display?.clipId === selectedClip ? display.frame : null;
  const shownIndex = showingAdjusted ? index : shownFrame?.index;
  const imageData = showingAdjusted ? adjusted?.data : shownFrame?.data;
  const capturedAt = source && snapshotCapturedAt(source.shootingStart, source.clip.frameTimesMs[index]);
  const pendingExports = selections.filter((item) => !snapshotExportMatchesDestination(item, destination));
  const photoExportReason = exportBlockReason(photo ? [photo] : []);
  const batchExportReason = exportBlockReason(selections);
  readDocument.current = () => JSON.stringify(mergeSnapshotSession(baseline.current, sourcesRef.current, selectionsRef.current,
    queueRef.current.filter(q => q.status !== "ready" && !q.saved).map(q => q.path),
    { personName, destination, selectedSourcePath: sourcesRef.current.find(s => s.clip.id === selectedClipRef.current)?.clip.path || baseline.current.workspace?.selectedSourcePath || "" }));
  const savingLabel = !currentSession ? "No session open" : saveState === "failed" ? "Save failed · changes kept here" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Changes waiting to save…" : "Saved automatically";

  useEffect(() => {
    if (!photo || photo.thumbnail || !exact || photo.clipId !== selectedClip || photo.index !== index || !display) return;
    let disposed = false;
    void smallThumbnail(display.frame.data).then((thumbnail) => {
      if (!disposed && alive.current) updateSelections((items) => items.map((item) => item.id === photo.id ? { ...item, thumbnail } : item), false);
    });
    return () => { disposed = true; };
  }, [photo?.id, photo?.thumbnail, exact, selectedClip, index, display]);

  function changed() { revision.current++; dirtyRef.current = true; setDirty(true); writer.current!.mark(); }
  function updateSources(update: (value: SnapshotSource[]) => SnapshotSource[], mark = true) {
    const next = update(sourcesRef.current); sourcesRef.current = next; setSources(next); if (mark) changed();
  }
  function updateSelections(update: (value: SnapshotSelection[]) => SnapshotSelection[], mark = true) {
    const next = update(selectionsRef.current); selectionsRef.current = next; setSelections(next); if (mark) changed();
  }
  function updateQueue(update: (value: QueueItem[]) => QueueItem[]) {
    const next = update(queueRef.current); queueRef.current = next; setQueue(next);
  }
  async function cancelRequest(id: string) {
    if (id) await invoke("snapshot_cancel", { requestId: id }).catch(() => undefined);
  }
  async function forgetClips(clipIds: string[]) {
    if (!clipIds.length) return;
    const promise = invoke("snapshot_forget", { clipIds }); forgetting.current.add(promise); flights.current.add(promise);
    try { await promise; } finally { forgetting.current.delete(promise); flights.current.delete(promise); }
  }
  async function tracked<T>(command: string, args: Record<string, unknown>, id: string): Promise<T> {
    requests.current.add(id);
    const priority = command === "snapshot_export" || command === "snapshot_photo_preview";
    if (priority) { priorityRequests.current.add(id); suspendFrames.current(); }
    const promise = invoke<T>(command, { ...args, requestId: id }); flights.current.add(promise);
    try { return await promise; }
    finally { requests.current.delete(id); priorityRequests.current.delete(id); flights.current.delete(promise); }
  }
  function stop() {
    shuttleRef.current = 0; setShuttle(0);
    if (hold.current) { clearInterval(hold.current); hold.current = null; }
  }
  function seek(position: number, clipId = selectedClipRef.current, motion = false) {
    const current = sourcesRef.current.find((s) => s.clip.id === clipId);
    if (!current) return;
    const next = Math.min(current.clip.frameTimesMs.length - 1, Math.max(0, Math.round(position)));
    navigationDirection.current = motion ? Math.sign(next - current.position) : 0;
    if (next !== current.position) updateSources((items) => items.map((s) => s.clip.id === clipId ? { ...s, position: next } : s));
  }
  function step(delta: number) {
    const current = sourcesRef.current.find((s) => s.clip.id === selectedClipRef.current);
    if (current) seek(current.position + delta, current.clip.id, true);
  }
  function seekTimeline(position: number) {
    const now = performance.now();
    const continuing = timelineMove.current > 0 && now - timelineMove.current < 250;
    timelineMove.current = now;
    seek(position, selectedClipRef.current, continuing);
  }
  function chooseClip(clipId: string) { stop(); navigationDirection.current = 0; setSelectedClip(clipId); selectedClipRef.current = clipId; setSelectedPhoto(""); setShowBefore(false); changed(); }
  function startShuttle(direction: number) {
    if (hold.current) { clearInterval(hold.current); hold.current = null; }
    const current = shuttleRef.current;
    const speed = Math.sign(current) === direction ? Math.min(32, Math.max(1, Math.abs(current) * 2)) : 1;
    shuttleRef.current = speed * direction; setShuttle(speed * direction);
  }
  function startHold(direction: number) {
    stop(); step(direction);
    const started = performance.now();
    hold.current = setInterval(() => {
      const elapsed = performance.now() - started;
      if (elapsed < 280) return;
      step(direction * (elapsed > 2400 ? 40 : elapsed > 1400 ? 12 : elapsed > 700 ? 4 : 1));
    }, 75);
  }

  useEffect(() => {
    alive.current = true;
    void refreshSessions();
    return () => {
      alive.current = false; epoch.current++; stop();
      void writer.current!.flush().catch(() => undefined);
      for (const id of requests.current) void cancelRequest(id);
      void invoke("snapshot_forget", { clipIds: sourcesRef.current.map((s) => s.clip.id) }).catch(() => undefined);
      cache.current.clear();
      warmup.current.clear();
    };
  }, []);
  useEffect(() => {
    const flush = () => { if (document.hidden || !active) void writer.current!.flush().catch(() => undefined); };
    const unload = (event: BeforeUnloadEvent) => { if (writer.current!.dirty || exportingRef.current) { event.preventDefault(); event.returnValue = ""; } };
    document.addEventListener("visibilitychange", flush); window.addEventListener("beforeunload", unload); flush();
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("beforeunload", unload); };
  }, [active]);
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    // A close event can await saving; browser unload cannot. Never close through a failed save.
    try {
      const appWindow = getCurrentWindow();
      void appWindow.onCloseRequested(async event => {
        if (exportingRef.current || operationBusy.current) { event.preventDefault(); setError("Wait for the snapshot export or session operation to finish before closing."); return; }
        if (!writer.current!.dirty) return;
        event.preventDefault();
        await sessionOperation(async () => { await drainWork(); await writer.current!.flush(); await appWindow.destroy(); });
      }).then(stopListening => { if (disposed) stopListening(); else unlisten = stopListening; }).catch(reason => {
        if (!disposed) setError(`The close-save safeguard could not start. Wait for “Saved automatically” before closing. ${explain(reason)}`);
      });
    } catch { /* Browser fixtures have no native window; beforeunload still protects them. */ }
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => { cache.current.setBudget(cacheMB * 1024 * 1024); }, [cacheMB]);
  useEffect(() => {
    const stopOnHide = () => { if (document.hidden) stop(); };
    const stopHold = () => { if (hold.current) { clearInterval(hold.current); hold.current = null; } };
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", stopOnHide);
    window.addEventListener("pointerup", stopHold); window.addEventListener("pointercancel", stopHold);
    return () => {
      window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stopOnHide);
      window.removeEventListener("pointerup", stopHold); window.removeEventListener("pointercancel", stopHold);
    };
  }, []);
  useEffect(() => {
    if (!active) { stop(); return; }
    const key = (event: KeyboardEvent) => {
      if (sessionHomeRef.current || operationBusy.current || isField(event.target) || event.ctrlKey || event.metaKey || event.altKey || document.hidden) return;
      if (["ArrowLeft", "ArrowRight", " ", "j", "J", "k", "K", "l", "L"].includes(event.key)) event.preventDefault();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { stop(); step((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)); }
      else if (event.key === " " || event.key.toLowerCase() === "k") stop();
      else if (!event.repeat && event.key.toLowerCase() === "j") startShuttle(-1);
      else if (!event.repeat && event.key.toLowerCase() === "l") startShuttle(1);
    };
    window.addEventListener("keydown", key);
    return () => { stop(); window.removeEventListener("keydown", key); };
  }, [active]);
  useEffect(() => {
    if (!shuttle || !active) return;
    let last = performance.now();
    const current = sourcesRef.current.find((s) => s.clip.id === selectedClipRef.current);
    let cursor = current?.clip.frameTimesMs[current.position] ?? 0;
    const timer = setInterval(() => {
      const clip = sourcesRef.current.find((s) => s.clip.id === selectedClipRef.current);
      if (!clip || document.hidden) { stop(); return; }
      const now = performance.now();
      cursor += Math.min(250, now - last) * shuttle; last = now;
      const end = clip.clip.frameTimesMs[clip.clip.frameTimesMs.length - 1];
      seek(frameAtTime(clip.clip.frameTimesMs, Math.max(0, Math.min(end, cursor))), clip.clip.id, true);
      if (cursor <= 0 || cursor >= end) stop();
    }, 70);
    return () => clearInterval(timer);
  }, [shuttle, active]);

  useEffect(() => {
    desiredFrame.current = { clipId: selectedClip, index, changed: performance.now(), direction: navigationDirection.current };
    setFrameError(failedFrames.current.has(`${selectedClip}:${index}`) ? "This original frame could not be decoded. Retry or choose a neighbouring frame." : "");
    const cached = cache.current.get(selectedClip, index);
    if (cached) setDisplay({ clipId: selectedClip, frame: cached });
    else if (display?.clipId !== selectedClip) setDisplay(null);
  }, [selectedClip, index]);

  // One bounded request, never a native queue of speculative jobs. Foreground work
  // preempts read-ahead, but sustained shuttle may finish a frame to avoid starvation.
  useEffect(() => {
    if (!active || !selectedClip) { setReadAheadStatus(""); return; }
    let disposed = false;
    let flight: { id: string; key: string; start: number; count: number; speculative: boolean; cancelled: boolean } | null = null;
    let windowKey = "";
    let order: number[] = [];
    const attempted = new Set<number>();
    const cancelFlight = () => {
      if (flight && !flight.cancelled) {
        flight.cancelled = true;
        void cancelRequest(flight.id);
      }
    };
    suspendFrames.current = cancelFlight;
    const tick = () => {
      if (disposed) return;
      if (document.hidden || viewerPaused.current || priorityRequests.current.size) {
        cancelFlight(); warmup.current.clear(); return;
      }
      const desired = desiredFrame.current;
      const current = sourcesRef.current.find((s) => s.clip.id === desired.clipId);
      if (!current || desired.clipId !== selectedClip) return;
      const key = `${desired.clipId}:${desired.index}`;
      const moving = desired.direction !== 0 && performance.now() - desired.changed < 250;
      const nextWindow = `${key}:${desired.direction}:${moving}`;
      if (nextWindow !== windowKey) {
        windowKey = nextWindow;
        order = snapshotReadAheadOrder(desired.index, current.clip.frameTimesMs.length, desired.direction, moving);
        cache.current.focus(desired.clipId, order);
        attempted.clear();
      }
      const cached = cache.current.get(desired.clipId, desired.index);
      if (cached) {
        setDisplay((previous) => previous?.clipId === desired.clipId && previous.frame.index === desired.index ? previous : { clipId: desired.clipId, frame: cached });
        // Decoding just the closest four previews keeps display warm without a large
        // pool of full-sized browser bitmaps. These are still NOT export pixels.
        const sign = desired.direction < 0 ? -1 : 1;
        warmup.current.warm([desired.index, desired.index + sign, desired.index - sign, desired.index + 2 * sign].flatMap(i => { const f = cache.current.peek(desired.clipId, i); return f ? [f] : []; }));
      }
      const ready = (sign: number) => {
        let count = 0;
        while (count < 100 && cache.current.has(desired.clipId, desired.index + sign * (count + 1))) count++;
        return count;
      };
      const stats = cache.current.stats();
      const status = `${ready(-1)} before · ${ready(1)} after · ${(stats.bytes / 1024 / 1024).toFixed(1)} MB previews`;
      setReadAheadStatus(previous => previous === status ? previous : status);
      if (flight) {
        if (flight.speculative) {
          const useful = Array.from({ length: flight.count }, (_, i) => flight!.start + i).some(i => order.includes(i));
          if (!cached || !useful || (flight.key !== key && moving && (desired.direction > 0 ? flight.start + flight.count <= desired.index : flight.start > desired.index))) cancelFlight();
        } else if (flight.key !== key && (cached || performance.now() - desired.changed > 110)) cancelFlight();
        return; // Drain cancellation before scheduling another request.
      }
      if (!cached && failedFrames.current.has(key)) return;
      let start = desired.index, count = 1;
      const speculative = !!cached;
      if (speculative) {
        const first = order.findIndex(i => !attempted.has(i) && cache.current.canPrepare(desired.clipId, i));
        if (first < 0) return;
        const batch = [order[first]], direction = order[first + 1] - order[first];
        if (Math.abs(direction) === 1) {
          for (let p = first + 1; p < order.length && batch.length < 12; p++) {
            const i = order[p];
            if (i - batch[batch.length - 1] !== direction || attempted.has(i) || !cache.current.canPrepare(desired.clipId, i)) break;
            batch.push(i);
          }
        }
        start = Math.min(...batch); count = batch.length;
        batch.forEach(i => attempted.add(i));
      }
      const id = requestId();
      const request = { id, key, start, count, speculative, cancelled: false }; flight = request;
      void tracked<SnapshotFrames>("snapshot_frames", { clipId: desired.clipId, start, count }, id).then((result) => {
        if (disposed || request.cancelled || flight?.id !== id || selectedClipRef.current !== desired.clipId) return;
        const validFrames: SnapshotFrame[] = [];
        for (const frame of result.frames) {
          if (!Number.isInteger(frame.index) || frame.index < start || frame.index >= start + count || frame.atMs !== current.clip.frameTimesMs[frame.index] || !frame.data.startsWith("data:image/jpeg;base64,")) continue;
          cache.current.put(desired.clipId, frame);
          failedFrames.current.delete(`${desired.clipId}:${frame.index}`);
          validFrames.push(frame);
        }
        const latest = desiredFrame.current;
        const requested = validFrames.find((item) => item.index === desired.index);
        if (requested && !speculative) cache.current.put(desired.clipId, requested);
        const currentFrame = latest.clipId === desired.clipId ? validFrames.find((item) => item.index === latest.index) : undefined;
        if (currentFrame) cache.current.put(desired.clipId, currentFrame);
        const frame = cache.current.get(latest.clipId, latest.index);
        if (frame) { setDisplay({ clipId: latest.clipId, frame }); setFrameError(""); }
        else if (!speculative && latest.clipId === desired.clipId && validFrames.length) {
          const nearest = validFrames.reduce((best, item) => Math.abs(item.index - latest.index) < Math.abs(best.index - latest.index) ? item : best);
          setDisplay({ clipId: latest.clipId, frame: nearest });
        }
        if (!speculative && !validFrames.some(frame => frame.index === desired.index)) {
          failedFrames.current.add(key);
          if (latest.clipId === desired.clipId && latest.index === desired.index) setFrameError("This original frame could not be decoded. Retry or choose a neighbouring frame.");
        }
      }).catch((reason) => {
        if (disposed || request.cancelled || speculative || flight?.id !== id) return;
        failedFrames.current.add(key);
        if (`${desiredFrame.current.clipId}:${desiredFrame.current.index}` === key) setFrameError(explain(reason));
      }).finally(() => {
        // Interrupted preparation is eligible again after foreground work finishes.
        if (request.cancelled) for (let i = start; i < start + count; i++) attempted.delete(i);
        if (flight?.id === id) flight = null;
      });
    };
    const visibility = () => { if (document.hidden) { cancelFlight(); warmup.current.clear(); } else tick(); };
    document.addEventListener("visibilitychange", visibility);
    tick(); const timer = setInterval(tick, 80);
    return () => { disposed = true; clearInterval(timer); cancelFlight(); warmup.current.clear(); document.removeEventListener("visibilitychange", visibility); if (suspendFrames.current === cancelFlight) suspendFrames.current = () => {}; };
  }, [active, selectedClip, cacheMB]);

  useEffect(() => {
    if (!active || !photo || !photoSource) { setAdjusted(null); return; }
    let disposed = false; const id = requestId(); setAdjustError("");
    const timer = setTimeout(() => {
      void tracked<string>("snapshot_photo_preview", { clipId: photo.clipId, index: photo.index, recipe: photo.recipe }, id).then((data) => {
        if (!disposed && data.startsWith("data:image/")) setAdjusted({ key: recipeKey, data });
      }).catch((reason) => { if (!disposed) setAdjustError(explain(reason)); });
    }, 220);
    return () => { disposed = true; clearTimeout(timer); void cancelRequest(id); };
  }, [active, recipeKey]);

  function startQueue() { if (worker.current) return; const task = processQueue(); queueFlight.current = task; void task.finally(() => { if (queueFlight.current === task) queueFlight.current = null; }); }
  async function processQueue() {
    if (worker.current) return;
    worker.current = true;
    try {
      while (alive.current) {
        const item = queueRef.current.find((entry) => entry.status === "queued");
        if (!item) break;
        const runEpoch = epoch.current, id = requestId(); queueRequest.current = { item: item.id, request: id };
        updateQueue((items) => items.map((entry) => entry.id === item.id ? { ...entry, status: "indexing" } : entry));
        try {
          await Promise.all([...forgetting.current]);
          if (runEpoch !== epoch.current || queueRef.current.find(q => q.id === item.id)?.status !== "indexing") continue;
          const clip = validateSnapshotClip(await tracked<SnapshotClip>("snapshot_open", { path: item.path }, id));
          const cancelled = queueRef.current.find((entry) => entry.id === item.id)?.status !== "indexing";
          if (!alive.current || runEpoch !== epoch.current || cancelled) { if (!sourcesRef.current.some((s) => s.clip.id === clip.id)) await forgetClips([clip.id]).catch(() => undefined); continue; }
          if (sourcesRef.current.some((s) => s.clip.id === clip.id || snapshotPathKey(s.clip.path) === snapshotPathKey(clip.path))) {
            updateQueue((items) => items.map((entry) => entry.id === item.id ? { ...entry, status: "ready" } : entry));
            continue;
          }
          const matches = !item.saved || item.saved.identity === clip.identity;
          if (!matches || (item.photos || []).some(p => p.index >= clip.frameTimesMs.length)) {
            await forgetClips([clip.id]);
            throw new Error("The original video changed. Its saved frames are preserved, but cannot safely be opened. Restore the original file, then Retry.");
          }
          const restored = item.saved && matches;
          const start = item.saved?.shootingStart || clip.suggestedStart || "";
          updateSources((items) => [...items, { clip, shootingStart: restored ? start : validShootingStart(start) ? start : "", timeConfirmed: !!restored && item.saved!.timeConfirmed, position: restored ? Math.min(item.saved!.position, clip.frameTimesMs.length - 1) : 0 }], false);
          if (restored && item.photos) {
            const valid = item.photos.filter((p) => p.index < clip.frameTimesMs.length);
            updateSelections((items) => [...items, ...valid.map((p) => ({ id: requestId(), clipId: clip.id, index: p.index, thumbnail: "", personName: p.personName, recipe: p.recipe, exported: p.exported || null, exportedDestination: p.exportedDestination, exportedVerified: false }))].slice(0, MAX_SNAPSHOTS), false);
          }
          if (!selectedClipRef.current || baseline.current.workspace?.selectedSourcePath === item.path) { selectedClipRef.current = clip.id; setSelectedClip(clip.id); }
          updateQueue((items) => items.map((entry) => entry.id === item.id ? { ...entry, status: "ready" } : entry));
          if (!restored) changed();
        } catch (reason) {
          if (alive.current && runEpoch === epoch.current) updateQueue((items) => items.map((entry) => entry.id === item.id && entry.status === "indexing" ? { ...entry, status: "error", error: explain(reason) } : entry));
        } finally { if (queueRequest.current?.request === id) queueRequest.current = null; }
      }
    } finally {
      worker.current = false;
      const restored = queueRef.current.filter((item) => item.saved);
      if (alive.current && restored.length && restored.every((item) => item.status !== "queued" && item.status !== "indexing")) {
        const ready = restored.filter((item) => item.status === "ready").length;
        const failed = restored.filter((item) => item.status === "error").length;
        const cancelled = restored.filter((item) => item.status === "cancelled").length;
        setNotice((previous) => previous.startsWith("Opening session videos and checking")
          ? `Session opened: ${ready} video${ready === 1 ? "" : "s"} ready${failed ? ` · ${failed} failed; see the source list` : ""}${cancelled ? ` · ${cancelled} cancelled` : ""}.`
          : previous);
      }
    }
  }

  async function addVideos() {
    if (!currentSession || operationBusy.current || exportingRef.current) return;
    const runEpoch = epoch.current;
    try {
      const paths = await open({ title: "Add original videos", multiple: true, filters: [{ name: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "mts", "m2ts", "mxf", "webm"] }] });
      if (!paths || runEpoch !== epoch.current) return;
      const existingPaths = new Set([...sourcesRef.current.map((s) => s.clip.path), ...queueRef.current.map(q => q.path)].map(snapshotPathKey));
      const available = MAX_SNAPSHOT_CLIPS - existingPaths.size;
      const unique = (Array.isArray(paths) ? paths : [paths]).filter((path) => { const key = snapshotPathKey(path); if (existingPaths.has(key)) return false; existingPaths.add(key); return true; });
      if (unique.length > available) setNotice(`A session holds 64 videos. Added the first ${Math.max(0, available)} new videos.`);
      updateQueue((items) => [...items.filter((q) => q.status !== "ready"), ...unique.slice(0, Math.max(0, available)).map((path) => ({ id: requestId(), path, status: "queued" as const }))]);
      changed(); startQueue();
    } catch (reason) { setError(explain(reason)); }
  }
  function cancelIndexing(itemId?: string) {
    updateQueue((items) => items.map((entry) => (!itemId || entry.id === itemId) && (entry.status === "queued" || entry.status === "indexing") ? { ...entry, status: "cancelled" } : entry));
    if (queueRequest.current && (!itemId || queueRequest.current.item === itemId)) void cancelRequest(queueRequest.current.request);
  }
  async function removeClip(clip: SnapshotClip) {
    const runEpoch = epoch.current;
    const count = selectionsRef.current.filter((p) => p.clipId === clip.id).length;
    if (count && !await confirm(`Remove ${clip.name} and its ${count} selected photo(s) from this session? Exported files remain on disk.`, { title: "Remove video from session", kind: "warning" })) return;
    if (runEpoch !== epoch.current || operationBusy.current || exportingRef.current) return;
    baseline.current.sources = baseline.current.sources.filter(s => snapshotPathKey(s.path) !== snapshotPathKey(clip.path));
    baseline.current.selections = baseline.current.selections.filter(s => snapshotPathKey(s.sourcePath) !== snapshotPathKey(clip.path));
    updateQueue(items => items.filter(q => snapshotPathKey(q.path) !== snapshotPathKey(clip.path)));
    stop(); updateSelections((items) => items.filter((p) => p.clipId !== clip.id));
    updateSources((items) => items.filter((s) => s.clip.id !== clip.id));
    if (selectedClipRef.current === clip.id) chooseClip(sourcesRef.current[0]?.clip.id || "");
    await forgetClips([clip.id]).catch((reason) => setError(explain(reason)));
  }
  function selectFrame() {
    if (!source || !exact || !display || existing || selectionsRef.current.length + preservedPhotoCount >= MAX_SNAPSHOTS) return;
    stop(); const id = requestId(), data = display.frame.data;
    updateSelections((items) => [...items, { id, clipId: source.clip.id, index: display.frame.index, thumbnail: "", personName: personName.trim(), recipe: defaultSnapshotRecipe(), exported: null }]);
    setSelectedPhoto(id); setShowBefore(false);
    void smallThumbnail(data).then((thumbnail) => { if (alive.current) updateSelections((items) => items.map((p) => p.id === id ? { ...p, thumbnail } : p), false); });
  }
  function choosePhoto(selection: SnapshotSelection) {
    const changedClip = selectedClipRef.current !== selection.clipId;
    stop(); setSelectedPhoto(selection.id); setSelectedClip(selection.clipId); selectedClipRef.current = selection.clipId;
    seek(selection.index, selection.clipId); setShowBefore(false);
    if (changedClip) changed();
  }
  function explainPreviewSave(event: { preventDefault(): void }, selection?: SnapshotSelection) {
    event.preventDefault(); stop();
    if (selection) choosePhoto(selection);
    void message("This is a reduced preview, not the full-resolution photograph.\n\nSelect the frame in the Photo Tray, confirm its shooting start, choose an export folder, then use Export full-resolution photo.\n\nIf it already says Exported, use Show original in folder to find the saved full-size file. Right-click Save image as would only save this small preview.", { title: "Export the full-resolution photo", kind: "info" })
      .catch((reason) => setError(`Use the full-resolution export controls, not Save image as. ${explain(reason)}`));
  }
  async function showExportedFile(selection: SnapshotSelection, path: string) {
    setLocationError(null);
    try { await invoke("reveal_in_explorer", { path }); }
    catch (reason) { if (alive.current) setLocationError({ id: selection.id, path, message: explain(reason) }); }
  }
  function exportBlockReason(photos: SnapshotSelection[]): string {
    if (exporting) return "Wait for the current export to finish, or stop it.";
    if (sessionBusy) return "Wait for the session operation to finish.";
    if (!photos.length) return "Select an exact frame to add a photo to the tray.";
    if (!destination) return "Choose an export folder in the Photo Tray.";
    const pending = photos.filter((item) => !snapshotExportMatchesDestination(item, destination));
    if (!pending.length) return "These photos are already exported to this folder. Use Show original in folder, or choose another destination.";
    if (pending.some((item) => { const s = sourcesRef.current.find((entry) => entry.clip.id === item.clipId); return !s?.timeConfirmed || !validShootingStart(s.shootingStart); })) return "Confirm the shooting start and UTC offset below the viewer for each selected video's photos.";
    return "";
  }
  function editPhoto(change: Partial<SnapshotSelection>) {
    if (!photo || exporting) return;
    updateSelections((items) => items.map((p) => p.id === photo.id ? { ...p, ...change, exported: null } : p));
    setPhotoErrors((errors) => { const next = { ...errors }; delete next[photo.id]; return next; });
  }
  function editRecipe(change: Partial<SnapshotRecipe>) { if (photo) editPhoto({ recipe: { ...photo.recipe, ...change } }); }
  function editSource(change: Partial<SnapshotSource>) {
    if (!source || exporting) return;
    updateSources((items) => items.map((s) => s.clip.id === source.clip.id ? { ...s, ...change } : s));
    updateSelections((items) => items.map((p) => p.clipId === source.clip.id ? { ...p, exported: null } : p), false);
  }
  async function chooseDestination() {
    const runEpoch = epoch.current;
    try {
      const folder = await open({ title: "Choose snapshot export folder", directory: true, multiple: false });
      if (typeof folder === "string" && runEpoch === epoch.current) {
        setDestination(folder); changed();
        if (selectionsRef.current.some((item) => item.exported && !snapshotExportMatchesDestination(item, folder))) setNotice("Export folder selected. Photos saved elsewhere can be exported here too; their previous files remain untouched.");
      }
    }
    catch (reason) { setError(explain(reason)); }
  }
  async function exportPhotos(only?: SnapshotSelection) {
    const candidates = only ? [only] : selectionsRef.current;
    const blocked = exportBlockReason(candidates);
    if (blocked) { setError(blocked); return; }
    const photos = candidates.filter((item) => !snapshotExportMatchesDestination(item, destination));
    stop(); setError(""); setNotice(""); exportCancel.current = false; setExporting({ done: 0, total: photos.length });
    let done = 0, failed = 0;
    try {
      for (const selection of photos) {
        if (exportCancel.current || !alive.current) break;
        const s = sourcesRef.current.find((item) => item.clip.id === selection.clipId)!;
        const id = requestId(); exportRequest.current = id;
        setPhotoErrors((errors) => { const next = { ...errors }; delete next[selection.id]; return next; });
        try {
          const result = await tracked<SnapshotExport>("snapshot_export", { clipId: selection.clipId, index: selection.index, shootingStart: s.shootingStart, personName: selection.personName, destination, recipe: selection.recipe }, id);
          if (alive.current) {
            updateSelections((items) => items.map((p) => p.id === selection.id ? { ...p, exported: result, exportedDestination: destination, exportedVerified: true } : p));
            setLocationError((previous) => previous?.id === selection.id ? null : previous);
          }
          done++;
        } catch (reason) { failed++; if (alive.current) setPhotoErrors((errors) => ({ ...errors, [selection.id]: explain(reason) })); }
        if (alive.current) setExporting({ done: done + failed, total: photos.length });
      }
      if (alive.current) setNotice(`${done} photo${done === 1 ? "" : "s"} exported${failed ? ` · ${failed} failed; review the photo tray` : ""}${exportCancel.current ? " · export stopped" : ""}.`);
    } finally { exportRequest.current = ""; if (alive.current) setExporting(null); }
  }
  async function saveSession() {
    if (!currentSession || operationBusy.current || exportingRef.current) return;
    const runEpoch = epoch.current;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = await save({ title: "Save Video Snapshots session copy", defaultPath: `video-snapshots-${stamp}.json`, filters: [{ name: "PhotoGoGo session", extensions: ["json"] }] });
      if (!path || runEpoch !== epoch.current) return;
      const json = readDocument.current();
      await invoke("snapshot_save_session", { path, json });
      if (runEpoch === epoch.current) setNotice(`Portable session copy saved as ${basename(path)}. Your library session continues to save automatically.`);
    } catch (reason) { setError(explain(reason)); }
  }
  async function refreshSessions() {
    setLibraryLoading(true);
    try {
      const library = await invoke<SnapshotSessionLibrary>("snapshot_sessions_list");
      if (alive.current) { setSessionLibrary(library.sessions); if (library.warnings.length) setError(library.warnings.join(" ")); }
    } catch (reason) { if (alive.current) setError(`Cannot open the session library. ${explain(reason)}`); }
    finally { if (alive.current) setLibraryLoading(false); }
  }
  async function sessionOperation(operation: () => Promise<void>) {
    if (operationBusy.current || exportingRef.current) return;
    operationBusy.current = true; viewerPaused.current = true; setSessionBusy(true); setError(""); setMoreOpen(false); stop(); suspendFrames.current();
    try { await operation(); }
    catch (reason) { setError(explain(reason)); }
    finally { operationBusy.current = false; if (alive.current) setSessionBusy(false); }
  }
  async function drainWork() {
    stop(); epoch.current++; suspendFrames.current();
    cancelIndexing();
    await Promise.all([...requests.current].map(cancelRequest));
    await Promise.allSettled([...flights.current]);
    if (queueFlight.current) await queueFlight.current;
  }
  async function clearWorkspace() {
    const oldIds = sourcesRef.current.map(s => s.clip.id);
    await forgetClips(oldIds);
    updateSources(() => [], false); updateSelections(() => [], false); updateQueue(() => []);
    setSelectedClip(""); selectedClipRef.current = ""; setSelectedPhoto(""); setPersonName(""); setDestination("");
    setDisplay(null); setAdjusted(null); setAdjustError(""); setFrameError(""); setPhotoErrors({}); setLocationError(null); setShowBefore(false);
    cache.current.clear(); warmup.current.clear(); failedFrames.current.clear(); setReadAheadStatus("");
  }
  async function activateSession(entry: SnapshotSessionDocument) {
    const session = parseSnapshotSession(entry.json);
    await drainWork(); await writer.current!.flush(); await clearWorkspace();
    baseline.current = session;
    writer.current!.attach(entry); setSessionHome(false);
    setPersonName(session.workspace?.personName || ""); setDestination(session.workspace?.destination || "");
    updateQueue(() => [...session.sources.map(saved => ({ id: requestId(), path: saved.path, status: "queued" as const, saved, photos: session.selections.filter(p => p.sourcePath === saved.path) })), ...(session.pendingPaths || []).map(path => ({ id: requestId(), path, status: "queued" as const }))]);
    setLastSession(entry.id); try { localStorage.setItem(lastSessionKey, entry.id); } catch { /* The library itself remains authoritative. */ }
    setNotice(entry.recovered ? "Recovered the last-good save. Duplicate this session to save a recovered copy; the damaged file stays untouched." : session.sources.length || session.pendingPaths?.length ? "Opening session videos and checking their original-frame indexes. Missing or changed videos and their photos stay safely saved." : "A fresh session. Add original videos to begin; your work will save automatically.");
    startQueue();
  }
  async function openManagedSession(id: string) {
    await sessionOperation(async () => {
      if (writer.current!.current?.id === id) { await writer.current!.flush(); setSessionHome(false); return; }
      const entry = await invoke<SnapshotSessionDocument>("snapshot_session_get", { id });
      if (entry.deletedAt) throw new Error("Restore this session from Recently deleted before opening it.");
      await activateSession(entry);
    });
  }
  function promptName(mode: "new" | "rename" | "duplicate", entry?: SnapshotSessionSummary) {
    stop(); setMoreOpen(false); setSessionName(mode === "new" ? `Snapshots ${new Date().toLocaleDateString()}` : mode === "duplicate" ? `${entry?.name || "Snapshots"} copy` : entry?.name || ""); setNameDialog({ mode, entry });
  }
  async function submitName() {
    const dialog = nameDialog, name = sessionName.trim();
    if (!dialog || !name || name.length > 120) return;
    await sessionOperation(async () => {
      if (dialog.mode === "new") {
        await drainWork(); await writer.current!.flush();
        const entry = await invoke<SnapshotSessionDocument>("snapshot_session_put", { id: null, expectedRevision: null, name, json: JSON.stringify(emptySession()) });
        await activateSession(entry);
      } else {
        const id = dialog.entry!.id;
        const isCurrent = id === writer.current!.current?.id;
        // A copy is also the explicit recovery path for a read-only backup or CAS failure.
        if (dialog.mode === "duplicate" && isCurrent) {
          await drainWork();
          await writer.current!.settle();
          const entry = await invoke<SnapshotSessionDocument>("snapshot_session_put", { id: null, expectedRevision: null, name, json: readDocument.current() });
          writer.current!.adoptSavedCopy(entry); await activateSession(entry);
        } else {
          if (isCurrent) await drainWork();
          await writer.current!.flush();
          // Never adopt another window's revision while retaining stale local edits.
          const original = isCurrent ? writer.current!.current! : await invoke<SnapshotSessionDocument>("snapshot_session_get", { id });
          if (original.deletedAt) throw new Error("Restore the session before changing it.");
          const entry = await invoke<SnapshotSessionDocument>("snapshot_session_put", { id: dialog.mode === "duplicate" ? null : id, expectedRevision: dialog.mode === "duplicate" ? null : original.revision, name, json: isCurrent ? readDocument.current() : original.json });
          if (isCurrent) writer.current!.attach(entry);
          if (dialog.mode === "duplicate") await activateSession(entry);
        }
      }
      setNameDialog(null); await refreshSessions();
    });
  }
  async function deleteSession(entry: SnapshotSessionSummary) {
    await sessionOperation(async () => {
      if (!await confirm(`Move “${entry.name}” (${entry.sourceCount} videos, ${entry.photoCount} selected photos) to Recently deleted?\n\nYou can restore it later. Source videos and exported photographs will NOT be deleted.`, { title: "Delete snapshot session", kind: "warning" })) return;
      await drainWork(); await writer.current!.flush();
      const fresh = await invoke<SnapshotSessionDocument>("snapshot_session_get", { id: entry.id });
      await invoke("snapshot_session_set_deleted", { id: entry.id, expectedRevision: fresh.revision, deleted: true });
      if (writer.current!.current?.id === entry.id) { await clearWorkspace(); writer.current!.attach(null); baseline.current = emptySession(); setSessionHome(true); }
      setNotice(`“${entry.name}” moved to Recently deleted. Videos and exported photos were not touched.`); await refreshSessions();
    });
  }
  async function restoreSession(entry: SnapshotSessionSummary) {
    await sessionOperation(async () => {
      await invoke("snapshot_session_set_deleted", { id: entry.id, expectedRevision: entry.revision, deleted: false });
      setNotice(`“${entry.name}” restored to Recent sessions.`); await refreshSessions();
    });
  }
  async function showSessions() {
    await sessionOperation(async () => { await drainWork(); await writer.current!.flush(); setNotice(""); setSessionHome(true); await refreshSessions(); });
  }
  async function loadSession() {
    await sessionOperation(async () => {
      const path = await open({ title: "Import Video Snapshots session", multiple: false, filters: [{ name: "PhotoGoGo session", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      const session = parseSnapshotSession(await invoke<string>("snapshot_load_session", { path }));
      await drainWork(); await writer.current!.flush();
      const entry = await invoke<SnapshotSessionDocument>("snapshot_session_put", { id: null, expectedRevision: null, name: basename(path).replace(/\.json$/i, "").slice(0, 120), json: JSON.stringify(session) });
      await activateSession(entry); await refreshSessions();
    });
  }
  function retryVideo(id: string) {
    if (operationBusy.current || exportingRef.current) return;
    updateQueue(items => items.map(item => item.id === id ? { ...item, status: "queued", error: undefined } : item)); startQueue();
  }

  const wheel = useRef({ when: 0, streak: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !active) return;
    const onWheel = (event: WheelEvent) => {
      if (operationBusy.current || sessionHomeRef.current || event.ctrlKey || !sourcesRef.current.length || !event.deltaY) return;
      event.preventDefault(); stop();
      const now = performance.now(), delta = Math.sign(event.deltaY);
      wheel.current.streak = now - wheel.current.when < 150 ? Math.min(20, wheel.current.streak + 1) : 0; wheel.current.when = now;
      const acceleration = event.shiftKey ? 1 : Math.min(60, 1 + Math.floor(wheel.current.streak * wheel.current.streak / 5));
      step(delta * acceleration);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [active, sessionHome]);

  return <section className="snapshots-page" aria-label="Video Snapshots">
    <header className="snapshots-header">
      <div><div className="snapshots-eyebrow">ORIGINAL VIDEO · PRECISE PHOTOS</div><h1>Video Snapshots <span>PHOTO<span className="snapshots-wordmark">GOGO</span></span></h1><p>Find the moment. Keep the original detail.</p></div>
      <div className="snapshots-header-actions">{!sessionHome && <><button onClick={() => setTips(!tips)} aria-expanded={tips}>Shortcuts</button><button onClick={() => void showSessions()} disabled={sessionBusy || !!exporting}>Sessions</button><button onClick={() => promptName("new")} disabled={sessionBusy || !!exporting}>New session</button><button className="snapshots-primary" onClick={() => void addVideos()} disabled={sessionBusy || !!exporting || sources.length >= MAX_SNAPSHOT_CLIPS}>＋ Add videos</button></>}</div>
    </header>
    {currentSession && !sessionHome && <div className="snapshots-session-bar"><div><span className="snapshots-eyebrow">SESSION</span><strong>{currentSession.name}</strong></div><span role="status" aria-label="Session save status" className={`snapshots-save-state ${saveState}`}>{savingLabel}</span><div className="snapshots-session-more"><button aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)} disabled={sessionBusy || !!exporting}>More ▾</button>{moreOpen && <div className="snapshots-session-menu"><button onClick={() => promptName("rename", currentSession)}>Rename session</button><button onClick={() => promptName("duplicate", currentSession)}>Duplicate session</button><button onClick={() => { setMoreOpen(false); void saveSession(); }}>Export session copy</button><button onClick={() => void loadSession()}>Import saved session</button><button onClick={() => void deleteSession(currentSession)}>Delete session</button></div>}</div></div>}
    {saveState === "failed" && <div className="snapshots-alert" role="alert"><span><strong>Your latest changes have not been saved.</strong> {saveError} Keep this window open. Retry saving, or duplicate the session to keep a separate copy.</span><button onClick={() => void sessionOperation(() => writer.current!.flush())} disabled={sessionBusy || !!exporting}>Retry save</button>{currentSession && <button onClick={() => promptName("duplicate", currentSession)} disabled={sessionBusy || !!exporting}>Save recovery copy</button>}</div>}
    {currentSession?.recovered && <div className="snapshots-notice"><span>Recovered last-good save. Keep the original recovery files untouched and save a new copy to continue.</span><button onClick={() => promptName("duplicate", currentSession)} disabled={sessionBusy || !!exporting}>Save recovered copy</button></div>}
    {nameDialog && <div className="snapshots-session-modal-backdrop"><form role="dialog" aria-modal="true" aria-labelledby="snapshot-session-dialog-title" className="snapshots-session-modal" onSubmit={e => { e.preventDefault(); void submitName(); }}><span className="snapshots-eyebrow">VIDEO SNAPSHOTS</span><h2 id="snapshot-session-dialog-title">{nameDialog.mode === "new" ? "A fresh start" : nameDialog.mode === "rename" ? "Rename session" : "Keep a separate copy"}</h2><p>{nameDialog.mode === "new" ? "Your current session will be saved before starting with an empty workspace." : nameDialog.mode === "duplicate" ? "Selections, adjustments and video references are copied. Original media and photographs stay untouched." : "Choose a name that will be easy to find later."}</p><label>Session name<input autoFocus aria-label="Session name" maxLength={120} value={sessionName} onChange={e => setSessionName(e.target.value)} disabled={sessionBusy}/></label><div><button type="button" onClick={() => setNameDialog(null)} disabled={sessionBusy}>Cancel</button><button className="snapshots-primary" type="submit" disabled={sessionBusy || !sessionName.trim()}>{sessionBusy ? "Saving…" : nameDialog.mode === "new" ? "Create session" : nameDialog.mode === "duplicate" ? "Create copy" : "Save name"}</button></div></form></div>}
    {tips && <div className="snapshots-tips"><span><kbd>←</kbd> <kbd>→</kbd> one exact frame</span><span><kbd>Shift</kbd> + arrows ten frames</span><span><kbd>J</kbd> reverse · <kbd>K</kbd> stop · <kbd>L</kbd> forward; repeat for speed</span><span><kbd>Space</kbd> stop</span><span>Wheel over viewer: accelerate · <kbd>Shift</kbd> + wheel: one frame</span><span>Hold the frame buttons to accelerate.</span></div>}
    {error && <div className="snapshots-alert" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="snapshots-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}>×</button></div>}
    {sessionHome ? <SnapshotSessionsHome sessions={sessionLibrary} currentId={currentSession?.id} lastId={lastSession} busy={sessionBusy || !!exporting || !!nameDialog} loading={libraryLoading} onOpen={id => void openManagedSession(id)} onNew={() => promptName("new")} onImport={() => void loadSession()} onRename={entry => promptName("rename", entry)} onDuplicate={entry => promptName("duplicate", entry)} onDelete={entry => void deleteSession(entry)} onRestore={entry => void restoreSession(entry)} onRefresh={() => void refreshSessions()}/> : <fieldset className="snapshots-session-editor" disabled={sessionBusy || !!nameDialog}>
    <div className="snapshots-workspace">
      <aside className="snapshots-clips" aria-label="Video clips">
        <div className="snapshots-panel-heading"><h2>Source videos</h2><span>{sources.length} / 64</span></div>
        <div className="snapshots-clip-list">{sources.map((s, position) => <div key={s.clip.id} className={`snapshots-clip ${selectedClip === s.clip.id ? "is-active" : ""}`}>
          <button className="snapshots-clip-select" onClick={() => chooseClip(s.clip.id)} title={s.clip.path} aria-pressed={selectedClip === s.clip.id}><span className="snapshots-clip-number">{String(position + 1).padStart(2, "0")}</span><span><strong>{s.clip.name}</strong><small>{s.clip.width} × {s.clip.height} · {snapshotTime(s.clip.frameTimesMs[s.clip.frameTimesMs.length - 1])}</small><small>{selections.filter((p) => p.clipId === s.clip.id).length} selected <span className={s.timeConfirmed ? "snapshots-ok" : "snapshots-warning"}>· {s.timeConfirmed ? "time confirmed" : "confirm time"}</span></small></span></button>
          <button className="snapshots-remove-clip" title="Remove video from session" aria-label={`Remove ${s.clip.name}`} onClick={() => void removeClip(s.clip)} disabled={!!exporting || sessionBusy}>×</button>
        </div>)}
        {!sources.length && !indexing && <div className="snapshots-empty-rail"><span>01</span><p>Add your original videos to begin.</p><small>Local files stay on this computer.</small></div>}
        {queue.filter((q) => q.status !== "ready").map((item) => <div className={`snapshots-queue ${item.status}`} key={item.id}><strong title={item.path}>{basename(item.path)}</strong><span>{item.status === "indexing" ? "Building exact frame index…" : item.status === "queued" ? "Waiting to index" : item.status === "cancelled" ? "Indexing paused · saved references kept" : item.error}</span>{item.saved && item.status !== "indexing" && <span>{item.photos?.length || 0} saved photo selections preserved</span>}{["queued", "indexing"].includes(item.status) ? <button onClick={() => cancelIndexing(item.id)}>Cancel</button> : <button onClick={() => retryVideo(item.id)} disabled={!!exporting || sessionBusy}>Retry video</button>}</div>)}
        </div>
        {indexing && <div className="snapshots-indexing"><span className="snapshots-spinner" />{pendingCount} video{pendingCount === 1 ? "" : "s"} pending<button onClick={() => cancelIndexing()}>Stop indexing</button></div>}
        <button className="snapshots-add-more" onClick={() => void addVideos()} disabled={sessionBusy || !!exporting || sources.length >= MAX_SNAPSHOT_CLIPS}>＋ Add more videos</button>
        <label className="snapshots-cache" title="Encoded browsing previews only. Native decoding buffers and browser image memory are separate; at most four previews are retained for display warm-up.">Preview cache<select aria-label="Preview cache budget" value={cacheMB} onChange={(e) => setCacheMB(Number(e.target.value))}><option value={16}>16 MB</option><option value={32}>32 MB</option><option value={64}>64 MB</option></select></label>
        <div className="snapshots-read-ahead" aria-label="Read-ahead status"><span>Read-ahead · ±10 → ±100</span><small>{readAheadStatus || "Prepares nearby frames within your cache budget."}</small></div>
      </aside>
      <section className="snapshots-main" aria-label="Video frame workspace">
        <div className="snapshots-viewer-heading"><span>{source?.clip.name || "Your next great photo is already in your video."}</span>{source && <span className="snapshots-source-badge">ORIGINAL {source.clip.width} × {source.clip.height}</span>}</div>
        <div ref={viewport} className={`snapshots-viewer ${source && !exact ? "is-seeking" : ""}`} tabIndex={0} aria-label="Frame viewer; scroll to move through frames" onContextMenu={(event) => { if (imageData) explainPreviewSave(event); }}>
          {imageData && source ? <img src={imageData} alt={`${showingAdjusted ? "Adjusted" : "Original"} video frame ${(shownIndex ?? index) + 1} at ${snapshotTime(source.clip.frameTimesMs[shownIndex ?? index])}`} draggable={false} /> : <div className="snapshots-empty-viewer"><svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true"><rect x="9" y="16" width="54" height="42" rx="8" stroke="currentColor" strokeWidth="1.5"/><path d="M24 16L28 10H44L48 16" stroke="currentColor" strokeWidth="1.5"/><circle cx="36" cy="37" r="12" stroke="currentColor" strokeWidth="1.5"/><path d="M32 30L42 37L32 44V30Z" fill="currentColor"/></svg><h2>{source ? "Finding your frame" : "A great moment. A full-resolution photo."}</h2><p>{source ? "Reading the original video…" : "Scroll through the action, slow down, and select the exact instant."}</p>{!source && <button className="snapshots-primary" onClick={() => void addVideos()} disabled={sessionBusy}>Choose videos</button>}</div>}
          {source && <><div className="snapshots-viewer-top"><span className="snapshots-viewer-label">{showingAdjusted ? "ADJUSTED PREVIEW" : exact ? "ORIGINAL FRAME" : "BROWSING PREVIEW"}</span>{shuttle !== 0 && <span className="snapshots-shuttle-badge">{shuttle < 0 ? "◀" : "▶"} {Math.abs(shuttle)}×</span>}</div><div className="snapshots-viewer-bottom"><span>{shownIndex === undefined ? "Reading original…" : snapshotTime(source.clip.frameTimesMs[shownIndex])}</span><span>{exact ? `Frame ${(index + 1).toLocaleString()} / ${source.clip.frameTimesMs.length.toLocaleString()}` : shownIndex !== undefined ? `Showing frame ${shownIndex + 1} · seeking ${index + 1}` : "Seeking exact frame…"}</span></div></>}
        </div>
        {source && <p className="snapshots-preview-note">Reduced preview for browsing · exports use the original video’s full resolution.</p>}
        {frameError && <div className="snapshots-inline-error" role="alert">{frameError}<button onClick={() => { failedFrames.current.delete(`${selectedClip}:${index}`); setFrameError(""); }}>Retry frame</button></div>}
        <div className="snapshots-scrubber"><span>{source ? snapshotTime(source.clip.frameTimesMs[index]) : "00:00:00.000"}</span><input type="range" aria-label="Video frame position" min={0} max={Math.max(0, (source?.clip.frameTimesMs.length || 1) - 1)} step={1} value={index} disabled={!source} onPointerDown={() => { stop(); timelineMove.current = 0; }} onChange={(e) => seekTimeline(Number(e.target.value))}/><span>{source ? snapshotTime(source.clip.frameTimesMs[source.clip.frameTimesMs.length - 1]) : "00:00:00.000"}</span></div>
        <div className="snapshots-transport"><div className="snapshots-transport-buttons"><button title="Reverse shuttle (J); repeat to accelerate" aria-label="Reverse shuttle" disabled={!source} onClick={() => startShuttle(-1)}>◀◀</button><button aria-label="Previous frame; hold to accelerate" disabled={!source || index === 0} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startHold(-1); }} onClick={(e) => { if (e.detail === 0) { stop(); step(-1); } }}>│◀</button><button className={shuttle ? "is-active" : ""} aria-label="Stop shuttle" onClick={stop} disabled={!source}>■</button><button aria-label="Next frame; hold to accelerate" disabled={!source || index === source.clip.frameTimesMs.length - 1} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startHold(1); }} onClick={(e) => { if (e.detail === 0) { stop(); step(1); } }}>▶│</button><button title="Forward shuttle (L); repeat to accelerate" aria-label="Forward shuttle" disabled={!source} onClick={() => startShuttle(1)}>▶▶</button></div><span className="snapshots-transport-help">Wheel to scrub · arrows for precision</span><button className="snapshots-primary snapshots-capture" onClick={selectFrame} disabled={!exact || !!existing || totalPhotoCount >= MAX_SNAPSHOTS || !!exporting}>{existing ? "✓ Frame selected" : "＋ Select photo"}</button></div>
        <div className="snapshots-source-details"><div className="snapshots-time-heading"><h3>Shooting time</h3><span>{source?.clip.timeSource || "Confirm once for each source video"}</span></div><div className="snapshots-time-fields"><label>Video shooting start, with UTC offset<input aria-label="Shooting start with UTC offset" placeholder="2026-09-30T14:30:00+10:00" value={source?.shootingStart || ""} disabled={!source || !!exporting} onChange={(e) => editSource({ shootingStart: e.target.value, timeConfirmed: false })}/></label><label className="snapshots-time-confirm"><input type="checkbox" checked={source?.timeConfirmed || false} disabled={!source || !validShootingStart(source.shootingStart) || !!exporting} onChange={(e) => editSource({ timeConfirmed: e.target.checked })}/>I confirm this is the original shooting start</label></div><div className="snapshots-time-caption">{capturedAt ? <>Selected photo: <strong>{capturedAt.replace("T", " ").replace("Z", " UTC")}</strong> · start + {snapshotTime(source!.clip.frameTimesMs[index])}</> : "Enter the camera's real date, time and UTC offset before export. Metadata is a suggestion until confirmed."}</div>{source?.clip.warnings?.map((warning, i) => <div className="snapshots-warning snapshots-small" key={i}>{warning}</div>)}</div>
      </section>
      <aside className="snapshots-inspector" aria-label="Photo adjustments"><div className="snapshots-panel-heading"><h2>{photo ? "Selected photo" : "Photo details"}</h2>{photo && <span>#{selections.indexOf(photo) + 1}</span>}</div>
        {!photo ? <div className="snapshots-inspector-empty"><span>✧</span><h3>Keep the best moments</h3><p>Select a frame to add it to your photo tray. Then crop, adjust and export.</p><label>Person name for next selections<input aria-label="Person name for next selections" placeholder="Optional manual label" maxLength={120} value={personName} onChange={(e) => { setPersonName(e.target.value); changed(); }}/></label><p className="snapshots-small">This label is entered by you and included in exported filenames.</p></div> : <div className="snapshots-adjustments"><p className="snapshots-photo-source">{photoSource?.clip.name}<br/><span>Frame {photo.index + 1} · {snapshotTime(photoSource?.clip.frameTimesMs[photo.index] || 0)}</span></p><label>Person name<input aria-label="Selected photo person name" maxLength={120} placeholder="Optional manual label" value={photo.personName} disabled={!!exporting} onChange={(e) => editPhoto({ personName: e.target.value })}/></label>
          <div className="snapshots-adjustment-heading"><h3>Finishing</h3><button onClick={() => editPhoto({ recipe: defaultSnapshotRecipe() })} disabled={!!exporting}>Reset</button></div>
          <label className="snapshots-control">Brightness<span>{Math.round(photo.recipe.brightness * 100)}%</span><input aria-label="Brightness" type="range" min={-50} max={50} step={1} value={Math.round(photo.recipe.brightness * 100)} disabled={!!exporting} onChange={(e) => editRecipe({ brightness: Number(e.target.value) / 100 })}/></label>
          <label className="snapshots-control">Contrast<span>{photo.recipe.contrast}%</span><input aria-label="Contrast" type="range" min={-50} max={50} step={1} value={photo.recipe.contrast} disabled={!!exporting} onChange={(e) => editRecipe({ contrast: Number(e.target.value) })}/></label>
          <label className="snapshots-control">Sharpness<span>{photo.recipe.sharpness.toFixed(1)}</span><input aria-label="Sharpness" type="range" min={0} max={2} step={0.1} value={photo.recipe.sharpness} disabled={!!exporting} onChange={(e) => editRecipe({ sharpness: Number(e.target.value) })}/></label>
          <label className="snapshots-crop-toggle"><input type="checkbox" checked={!!photo.recipe.crop} disabled={!!exporting} onChange={(e) => editRecipe({ crop: e.target.checked ? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } : null })}/>Crop improved photo</label>
          {photo.recipe.crop && <div className="snapshots-crop-fields">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[field]} %<input type="number" aria-label={`Crop ${field} percent`} min={field === "x" || field === "y" ? 0 : 1} max={100} step={1} value={Math.round(photo.recipe.crop![field] * 100)} disabled={!!exporting} onChange={(e) => { const value = Number(e.target.value) / 100; if (!Number.isFinite(value)) return; const crop = { ...photo.recipe.crop! }; if (field === "x") crop.x = Math.max(0, Math.min(1 - crop.width, value)); else if (field === "y") crop.y = Math.max(0, Math.min(1 - crop.height, value)); else if (field === "width") crop.width = Math.max(0.01, Math.min(1 - crop.x, value)); else crop.height = Math.max(0.01, Math.min(1 - crop.y, value)); editRecipe({ crop }); }}/></label>)}</div>}
          <div className="snapshots-before-after"><button className={showBefore ? "is-active" : ""} onClick={() => { choosePhoto(photo); setShowBefore(true); }}>Before</button><button className={!showBefore ? "is-active" : ""} onClick={() => { choosePhoto(photo); setShowBefore(false); }}>After</button></div>
          <p className="snapshots-small">An unenhanced full-resolution JPEG is always saved. Adjustments create a separate improved photo.</p>{adjusted?.key !== recipeKey && !adjustError && <p className="snapshots-small" role="status">Preparing adjusted preview…</p>}{adjustError && <p className="snapshots-inline-error" role="alert">{adjustError}</p>}
          <div className="snapshots-photo-export">
            {photo.exported && <div className="snapshots-export-success"><strong>{snapshotExportMatchesDestination(photo, destination) ? "✓ Exported" : "Previously exported"}</strong>{photo.exportedVerified === false && <span>Saved history · file existence has not been checked.</span>}<span>Full-resolution original · {photo.exported.width} × {photo.exported.height}</span><span className="snapshots-export-path">{photo.exported.path}</span><button onClick={() => void showExportedFile(photo, photo.exported!.path)}>Show original in folder</button>{photo.exported.enhancedPath && <><span>Separate improved photo (cropping may reduce dimensions)</span><span className="snapshots-export-path">{photo.exported.enhancedPath}</span><button onClick={() => void showExportedFile(photo, photo.exported!.enhancedPath!)}>Show improved photo in folder</button></>}</div>}
            {locationError?.id === photo.id && (locationError.path === photo.exported?.path || locationError.path === photo.exported?.enhancedPath) && <p className="snapshots-inline-error snapshots-export-location-error" role="alert">{locationError.message}</p>}
            <button className="snapshots-export-single" onClick={() => void exportPhotos(photo)} disabled={!!photoExportReason} aria-describedby="snapshot-photo-export-reason">Export full-resolution photo</button>
            <p id="snapshot-photo-export-reason" className="snapshots-small">{photoExportReason || `Saves an uncropped ${photoSource?.clip.width} × ${photoSource?.clip.height} JPEG from the original video, not this thumbnail.`}</p>
            {photoErrors[photo.id] && <p className="snapshots-inline-error" role="alert">{photoErrors[photo.id]}</p>}
          </div>
          <button className="snapshots-remove-photo" disabled={!!exporting} onClick={() => { updateSelections((items) => items.filter((p) => p.id !== photo.id)); setSelectedPhoto(""); }}>Remove from tray</button>
        </div>}
      </aside>
    </div>
    <section className="snapshots-tray" aria-label="Selected photo tray"><div className="snapshots-tray-heading"><div><h2>Photo tray <span>{totalPhotoCount} / 200</span></h2><p>Thumbnails only · use Export for full-resolution photographs.{preservedPhotoCount > 0 && ` ${preservedPhotoCount} saved selections await their original video.`}</p></div><div className="snapshots-export-actions"><button className="snapshots-folder" onClick={() => void chooseDestination()} disabled={!!exporting || sessionBusy} title={destination}>{destination ? `Folder: ${basename(destination.replace(/[\\/]+$/, ""))}` : "Choose export folder"}</button>{exporting ? <><span role="status">Exporting {exporting.done} / {exporting.total}</span><button onClick={() => { exportCancel.current = true; void cancelRequest(exportRequest.current); }}>Stop export</button></> : <button className="snapshots-primary" disabled={!!batchExportReason} aria-describedby="snapshot-batch-export-reason" onClick={() => void exportPhotos()}>Export {pendingExports.length ? `${pendingExports.length} ` : ""}full-resolution photo{pendingExports.length === 1 ? "" : "s"}</button>}</div></div>
      <div className="snapshots-export-destination"><p>{destination ? <>Destination: <span>{destination}</span> · photos are saved inside shooting-date folders (YYYY / MM / DD).</> : "Choose where to save the full-resolution photographs."}</p><p id="snapshot-batch-export-reason">{batchExportReason || "Ready to export from the original videos. Existing files are never overwritten."}</p></div>
      <div className="snapshots-tray-list">{!selections.length ? <div className="snapshots-empty-tray"><span>＋</span> Select an exact frame above to collect your first photo.</div> : selections.map((selection, i) => { const clip = sources.find((s) => s.clip.id === selection.clipId); return <button key={selection.id} className={`snapshots-photo-card ${selectedPhoto === selection.id ? "is-active" : ""} ${photoErrors[selection.id] ? "has-error" : ""}`} aria-label={`Photo ${i + 1}, ${clip?.clip.name}, frame ${selection.index + 1}`} aria-pressed={selectedPhoto === selection.id} onClick={() => choosePhoto(selection)} onContextMenu={(event) => explainPreviewSave(event, selection)}><div className="snapshots-photo-thumb">{selection.thumbnail ? <img src={selection.thumbnail} alt="" draggable={false}/> : <span>{String(i + 1).padStart(2, "0")}</span>}<span className="snapshots-photo-number">{i + 1}</span>{snapshotExportMatchesDestination(selection, destination) && <span className="snapshots-photo-status" title="Exported to the selected folder">✓</span>}{photoErrors[selection.id] && <span className="snapshots-photo-status error">!</span>}</div><strong>{selection.personName || clip?.clip.name || "Photo"}</strong><small>{snapshotTime(clip?.clip.frameTimesMs[selection.index] || 0)}{!clip?.timeConfirmed ? " · confirm time" : ""}</small></button>; })}</div>
    </section>
    </fieldset>}
    <footer className="snapshots-footer"><span>Local originals · exact indexed frames · full-resolution JPEG export</span><span>{dirty ? savingLabel : currentSession ? "Saved automatically on this computer" : "Create or open a session to begin"}</span></footer>
  </section>;
}
