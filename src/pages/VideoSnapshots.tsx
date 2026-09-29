import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { defaultSnapshotRecipe } from "../types/videoSnapshots";
import type { SnapshotClip, SnapshotExport, SnapshotFrame, SnapshotFrames, SnapshotRecipe, SnapshotSelection, SnapshotSession, SnapshotSource } from "../types/videoSnapshots";
import { createSnapshotSession, frameAtTime, MAX_SNAPSHOT_CLIPS, MAX_SNAPSHOTS, parseSnapshotSession, SnapshotFrameCache, snapshotCapturedAt, snapshotPathKey, snapshotTime, validShootingStart, validateSnapshotClip } from "../utils/videoSnapshots";
import "./VideoSnapshots.css";

type QueueItem = { id: string; path: string; status: "queued" | "indexing" | "ready" | "cancelled" | "error"; error?: string; saved?: SnapshotSession["sources"][number]; photos?: SnapshotSession["selections"] };
type DisplayFrame = { clipId: string; frame: SnapshotFrame };
const requestId = () => `snap-${crypto.randomUUID()}`;
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
const explain = (error: unknown) => error instanceof Error ? error.message : String(error);
const isField = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable=true],[role=textbox]");

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
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [display, setDisplay] = useState<DisplayFrame | null>(null);
  const [frameError, setFrameError] = useState("");
  const cache = useRef(new SnapshotFrameCache());
  const failedFrames = useRef(new Set<string>());
  const [cacheMB, setCacheMB] = useState(32);
  const desiredFrame = useRef<{ clipId: string; index: number; changed: number }>({ clipId: "", index: 0, changed: 0 });
  const [shuttle, setShuttle] = useState(0);
  const shuttleRef = useRef(0);
  const hold = useRef<ReturnType<typeof setInterval> | null>(null);
  const [personName, setPersonName] = useState("");
  const [destination, setDestination] = useState("");
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const exportCancel = useRef(false);
  const exportRequest = useRef("");
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({});
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
  const indexing = queue.some((item) => item.status === "queued" || item.status === "indexing");
  const pendingCount = queue.filter((item) => item.status === "queued" || item.status === "indexing").length;
  const recipeKey = photo ? JSON.stringify([photo.id, photo.clipId, photo.index, photo.recipe]) : "";
  const editingCurrent = !!photo && photo.clipId === selectedClip && photo.index === index;
  const showingAdjusted = editingCurrent && !showBefore && adjusted?.key === recipeKey;
  const shownFrame = display?.clipId === selectedClip ? display.frame : null;
  const shownIndex = showingAdjusted ? index : shownFrame?.index;
  const imageData = showingAdjusted ? adjusted?.data : shownFrame?.data;
  const capturedAt = source && snapshotCapturedAt(source.shootingStart, source.clip.frameTimesMs[index]);

  useEffect(() => {
    if (!photo || photo.thumbnail || !exact || photo.clipId !== selectedClip || photo.index !== index || !display) return;
    let disposed = false;
    void smallThumbnail(display.frame.data).then((thumbnail) => {
      if (!disposed && alive.current) updateSelections((items) => items.map((item) => item.id === photo.id ? { ...item, thumbnail } : item), false);
    });
    return () => { disposed = true; };
  }, [photo?.id, photo?.thumbnail, exact, selectedClip, index, display]);

  function changed() { revision.current++; dirtyRef.current = true; setDirty(true); }
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
  async function tracked<T>(command: string, args: Record<string, unknown>, id: string): Promise<T> {
    requests.current.add(id);
    try { return await invoke<T>(command, { ...args, requestId: id }); }
    finally { requests.current.delete(id); }
  }
  function stop() {
    shuttleRef.current = 0; setShuttle(0);
    if (hold.current) { clearInterval(hold.current); hold.current = null; }
  }
  function seek(position: number, clipId = selectedClipRef.current) {
    const current = sourcesRef.current.find((s) => s.clip.id === clipId);
    if (!current) return;
    const next = Math.min(current.clip.frameTimesMs.length - 1, Math.max(0, Math.round(position)));
    if (next !== current.position) updateSources((items) => items.map((s) => s.clip.id === clipId ? { ...s, position: next } : s));
  }
  function step(delta: number) {
    const current = sourcesRef.current.find((s) => s.clip.id === selectedClipRef.current);
    if (current) seek(current.position + delta);
  }
  function chooseClip(clipId: string) { stop(); setSelectedClip(clipId); selectedClipRef.current = clipId; setSelectedPhoto(""); setShowBefore(false); }
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
    return () => {
      alive.current = false; epoch.current++; stop();
      for (const id of requests.current) void cancelRequest(id);
      void invoke("snapshot_forget", { clipIds: sourcesRef.current.map((s) => s.clip.id) }).catch(() => undefined);
      cache.current.clear();
    };
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
      if (isField(event.target) || event.ctrlKey || event.metaKey || event.altKey || document.hidden) return;
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
      seek(frameAtTime(clip.clip.frameTimesMs, Math.max(0, Math.min(end, cursor))));
      if (cursor <= 0 || cursor >= end) stop();
    }, 70);
    return () => clearInterval(timer);
  }, [shuttle, active]);

  useEffect(() => {
    desiredFrame.current = { clipId: selectedClip, index, changed: performance.now() };
    setFrameError(failedFrames.current.has(`${selectedClip}:${index}`) ? "This original frame could not be decoded. Retry or choose a neighbouring frame." : "");
    const cached = cache.current.get(selectedClip, index);
    if (cached) setDisplay({ clipId: selectedClip, frame: cached });
    else if (display?.clipId !== selectedClip) setDisplay(null);
  }, [selectedClip, index]);

  // One native extraction at a time, latest desired position wins. Continuous motion
  // can use a completed neighbour batch; settling cancels an obsolete extraction.
  useEffect(() => {
    if (!active || !selectedClip) return;
    let disposed = false;
    let flight: { id: string; key: string; started: number } | null = null;
    const tick = () => {
      if (disposed || document.hidden) return;
      const desired = desiredFrame.current;
      const current = sourcesRef.current.find((s) => s.clip.id === desired.clipId);
      if (!current) return;
      const key = `${desired.clipId}:${desired.index}`;
      const cached = cache.current.get(desired.clipId, desired.index);
      if (cached) {
        if (flight && flight.key !== key) { const old = flight; flight = null; void cancelRequest(old.id); }
        setDisplay((previous) => previous?.clipId === desired.clipId && previous.frame.index === desired.index ? previous : { clipId: desired.clipId, frame: cached });
        return;
      }
      if (flight) {
        if (flight.key !== key && performance.now() - desired.changed > 110) {
          const old = flight; flight = null; void cancelRequest(old.id);
        } else return;
      }
      if (failedFrames.current.has(key)) return;
      const id = requestId(), start = Math.max(0, desired.index - 3);
      const request = { id, key, started: performance.now() }; flight = request;
      void tracked<SnapshotFrames>("snapshot_frames", { clipId: desired.clipId, start, count: Math.min(12, current.clip.frameTimesMs.length - start) }, id).then((result) => {
        if (disposed || flight?.id !== id) return;
        const validFrames: SnapshotFrame[] = [];
        for (const frame of result.frames) {
          if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= current.clip.frameTimesMs.length || frame.atMs !== current.clip.frameTimesMs[frame.index] || !frame.data.startsWith("data:image/")) continue;
          cache.current.put(desired.clipId, frame);
          failedFrames.current.delete(`${desired.clipId}:${frame.index}`);
          validFrames.push(frame);
        }
        const latest = desiredFrame.current;
        const requested = validFrames.find((item) => item.index === desired.index);
        if (requested) cache.current.put(desired.clipId, requested);
        const currentFrame = latest.clipId === desired.clipId ? validFrames.find((item) => item.index === latest.index) : undefined;
        if (currentFrame) cache.current.put(desired.clipId, currentFrame);
        const frame = cache.current.get(latest.clipId, latest.index);
        if (frame) { setDisplay({ clipId: latest.clipId, frame }); setFrameError(""); }
        else if (latest.clipId === desired.clipId && validFrames.length) {
          const nearest = validFrames.reduce((best, item) => Math.abs(item.index - latest.index) < Math.abs(best.index - latest.index) ? item : best);
          setDisplay({ clipId: latest.clipId, frame: nearest });
        }
        if (!cache.current.get(desired.clipId, desired.index)) {
          failedFrames.current.add(key);
          if (latest.clipId === desired.clipId && latest.index === desired.index) setFrameError("This original frame could not be decoded. Retry or choose a neighbouring frame.");
        }
      }).catch((reason) => {
        if (disposed || flight?.id !== id) return;
        failedFrames.current.add(key);
        if (`${desiredFrame.current.clipId}:${desiredFrame.current.index}` === key) setFrameError(explain(reason));
      }).finally(() => { if (flight?.id === id) flight = null; });
    };
    tick(); const timer = setInterval(tick, 80);
    return () => { disposed = true; clearInterval(timer); if (flight) void cancelRequest(flight.id); };
  }, [active, selectedClip]);

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
          const clip = validateSnapshotClip(await tracked<SnapshotClip>("snapshot_open", { path: item.path }, id));
          const cancelled = queueRef.current.find((entry) => entry.id === item.id)?.status !== "indexing";
          if (!alive.current || runEpoch !== epoch.current || cancelled) { if (!sourcesRef.current.some((s) => s.clip.id === clip.id)) void invoke("snapshot_forget", { clipIds: [clip.id] }).catch(() => undefined); continue; }
          if (sourcesRef.current.some((s) => s.clip.id === clip.id || snapshotPathKey(s.clip.path) === snapshotPathKey(clip.path))) {
            updateQueue((items) => items.map((entry) => entry.id === item.id ? { ...entry, status: "ready" } : entry));
            continue;
          }
          const matches = !item.saved || item.saved.identity === clip.identity;
          const restored = item.saved && matches;
          const start = item.saved?.shootingStart || clip.suggestedStart || "";
          updateSources((items) => [...items, { clip, shootingStart: validShootingStart(start) ? start : "", timeConfirmed: !!restored && item.saved!.timeConfirmed, position: restored ? Math.min(item.saved!.position, clip.frameTimesMs.length - 1) : 0 }]);
          if (restored && item.photos) {
            const valid = item.photos.filter((p) => p.index < clip.frameTimesMs.length);
            updateSelections((items) => [...items, ...valid.map((p) => ({ id: requestId(), clipId: clip.id, index: p.index, thumbnail: "", personName: p.personName, recipe: p.recipe, exported: null }))].slice(0, MAX_SNAPSHOTS));
            if (valid.length !== item.photos.length) setNotice("Some saved frames no longer exist and were skipped. Review the restored photos.");
          }
          if (!matches) setNotice(`${clip.name} changed since this session was saved. Its saved photos were discarded; confirm the shooting time again.`);
          if (!selectedClipRef.current) { selectedClipRef.current = clip.id; setSelectedClip(clip.id); }
          updateQueue((items) => items.map((entry) => entry.id === item.id ? { ...entry, status: "ready" } : entry));
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
    try {
      const paths = await open({ title: "Add original videos", multiple: true, filters: [{ name: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "mts", "m2ts", "mxf", "webm"] }] });
      if (!paths) return;
      const existingPaths = new Set([...sourcesRef.current.map((s) => s.clip.path), ...queueRef.current.filter((q) => ["queued", "indexing"].includes(q.status)).map((q) => q.path)].map(snapshotPathKey));
      const unique = (Array.isArray(paths) ? paths : [paths]).filter((path) => { const key = snapshotPathKey(path); if (existingPaths.has(key)) return false; existingPaths.add(key); return true; });
      const available = MAX_SNAPSHOT_CLIPS - sourcesRef.current.length - queueRef.current.filter((q) => ["queued", "indexing"].includes(q.status)).length;
      if (unique.length > available) setNotice(`A session holds 64 videos. Added the first ${Math.max(0, available)} new videos.`);
      updateQueue((items) => [...items.filter((q) => q.status !== "ready"), ...unique.slice(0, Math.max(0, available)).map((path) => ({ id: requestId(), path, status: "queued" as const }))]);
      void processQueue();
    } catch (reason) { setError(explain(reason)); }
  }
  function cancelIndexing(itemId?: string) {
    updateQueue((items) => items.map((entry) => (!itemId || entry.id === itemId) && (entry.status === "queued" || entry.status === "indexing") ? { ...entry, status: "cancelled" } : entry));
    if (queueRequest.current && (!itemId || queueRequest.current.item === itemId)) void cancelRequest(queueRequest.current.request);
  }
  async function removeClip(clip: SnapshotClip) {
    const count = selectionsRef.current.filter((p) => p.clipId === clip.id).length;
    if (count && !await confirm(`Remove ${clip.name} and its ${count} selected photo(s) from this session? Exported files remain on disk.`, { title: "Remove video from session", kind: "warning" })) return;
    stop(); updateSelections((items) => items.filter((p) => p.clipId !== clip.id));
    updateSources((items) => items.filter((s) => s.clip.id !== clip.id));
    if (selectedClipRef.current === clip.id) chooseClip(sourcesRef.current[0]?.clip.id || "");
    void invoke("snapshot_forget", { clipIds: [clip.id] }).catch((reason) => setError(explain(reason)));
  }
  function selectFrame() {
    if (!source || !exact || !display || existing || selectionsRef.current.length >= MAX_SNAPSHOTS) return;
    stop(); const id = requestId(), data = display.frame.data;
    updateSelections((items) => [...items, { id, clipId: source.clip.id, index: display.frame.index, thumbnail: "", personName: personName.trim(), recipe: defaultSnapshotRecipe(), exported: null }]);
    setSelectedPhoto(id); setShowBefore(false);
    void smallThumbnail(data).then((thumbnail) => { if (alive.current) updateSelections((items) => items.map((p) => p.id === id ? { ...p, thumbnail } : p), false); });
  }
  function choosePhoto(selection: SnapshotSelection) {
    stop(); setSelectedPhoto(selection.id); setSelectedClip(selection.clipId); selectedClipRef.current = selection.clipId;
    seek(selection.index, selection.clipId); setShowBefore(false);
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
    try { const folder = await open({ title: "Choose snapshot export folder", directory: true, multiple: false }); if (typeof folder === "string") setDestination(folder); }
    catch (reason) { setError(explain(reason)); }
  }
  async function exportPhotos(only?: SnapshotSelection) {
    if (exporting || sessionBusy) return;
    const photos = only ? [only] : selectionsRef.current.filter((p) => !p.exported);
    if (!photos.length) return;
    if (!destination) { setError("Choose an export folder first."); return; }
    if (photos.some((p) => { const s = sourcesRef.current.find((item) => item.clip.id === p.clipId); return !s?.timeConfirmed || !validShootingStart(s.shootingStart); })) { setError("Confirm the shooting start and UTC offset for each selected video's photos before export."); return; }
    stop(); setError(""); exportCancel.current = false; setExporting({ done: 0, total: photos.length });
    let done = 0, failed = 0;
    try {
      for (const selection of photos) {
        if (exportCancel.current || !alive.current) break;
        const s = sourcesRef.current.find((item) => item.clip.id === selection.clipId)!;
        const id = requestId(); exportRequest.current = id;
        setPhotoErrors((errors) => { const next = { ...errors }; delete next[selection.id]; return next; });
        try {
          const result = await tracked<SnapshotExport>("snapshot_export", { clipId: selection.clipId, index: selection.index, shootingStart: s.shootingStart, personName: selection.personName, destination, recipe: selection.recipe }, id);
          if (alive.current) updateSelections((items) => items.map((p) => p.id === selection.id ? { ...p, exported: result } : p), false);
          done++;
        } catch (reason) { failed++; if (alive.current) setPhotoErrors((errors) => ({ ...errors, [selection.id]: explain(reason) })); }
        if (alive.current) setExporting({ done: done + failed, total: photos.length });
      }
      if (alive.current) setNotice(`${done} photo${done === 1 ? "" : "s"} exported${failed ? ` · ${failed} failed; review the photo tray` : ""}${exportCancel.current ? " · export stopped" : ""}.`);
    } finally { exportRequest.current = ""; if (alive.current) setExporting(null); }
  }
  async function saveSession() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = await save({ title: "Save Video Snapshots session copy", defaultPath: `video-snapshots-${stamp}.json`, filters: [{ name: "PhotoGoGo session", extensions: ["json"] }] });
      if (!path) return;
      const savedRevision = revision.current;
      const json = JSON.stringify(createSnapshotSession(sourcesRef.current, selectionsRef.current), null, 2);
      setSessionBusy(true); await invoke("snapshot_save_session", { path, json });
      if (revision.current === savedRevision) { dirtyRef.current = false; setDirty(false); }
      setNotice(`Session saved as ${basename(path)}.`);
    } catch (reason) { setError(explain(reason)); }
    finally { setSessionBusy(false); }
  }
  async function loadSession() {
    if (sessionBusy || indexing || exporting) return;
    try {
      const path = await open({ title: "Open Video Snapshots session", multiple: false, filters: [{ name: "PhotoGoGo session", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      setSessionBusy(true);
      const session = parseSnapshotSession(await invoke<string>("snapshot_load_session", { path }));
      if (dirtyRef.current && !await confirm("Replace the current unsaved session? Save it first if you need to keep its selections and adjustments.", { title: "Open another session", kind: "warning" })) return;
      stop(); epoch.current++;
      const oldIds = sourcesRef.current.map((s) => s.clip.id);
      for (const id of requests.current) void cancelRequest(id);
      updateSources(() => [], false); updateSelections(() => [], false); setSelectedClip(""); selectedClipRef.current = ""; setSelectedPhoto(""); setDisplay(null); setAdjusted(null); cache.current.clear(); failedFrames.current.clear(); setPhotoErrors({});
      updateQueue(() => session.sources.map((saved) => ({ id: requestId(), path: saved.path, status: "queued", saved, photos: session.selections.filter((p) => p.sourcePath === saved.path) })));
      await invoke("snapshot_forget", { clipIds: oldIds }).catch(() => undefined);
      setNotice("Opening session videos and checking their original-frame indexes. Changed sources require a new time confirmation.");
      dirtyRef.current = false; setDirty(false); revision.current++;
      void processQueue();
    } catch (reason) { setError(explain(reason)); }
    finally { setSessionBusy(false); }
  }

  const wheel = useRef({ when: 0, streak: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !active) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !sourcesRef.current.length || !event.deltaY) return;
      event.preventDefault(); stop();
      const now = performance.now(), delta = Math.sign(event.deltaY);
      wheel.current.streak = now - wheel.current.when < 150 ? Math.min(20, wheel.current.streak + 1) : 0; wheel.current.when = now;
      const acceleration = event.shiftKey ? 1 : Math.min(60, 1 + Math.floor(wheel.current.streak * wheel.current.streak / 5));
      step(delta * acceleration);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [active]);

  return <section className="snapshots-page" aria-label="Video Snapshots">
    <header className="snapshots-header">
      <div><div className="snapshots-eyebrow">ORIGINAL VIDEO · PRECISE PHOTOS</div><h1>Video Snapshots <span>PHOTO<span className="snapshots-wordmark">GOGO</span></span></h1><p>Find the moment. Keep the original detail.</p></div>
      <div className="snapshots-header-actions"><button onClick={() => setTips(!tips)} aria-expanded={tips}>Shortcuts</button><button onClick={() => void loadSession()} disabled={sessionBusy || indexing || !!exporting}>Open session</button><button onClick={() => void saveSession()} disabled={!sources.length || sessionBusy || indexing || !!exporting}>Save session copy{dirty ? " •" : ""}</button><button className="snapshots-primary" onClick={() => void addVideos()} disabled={sessionBusy || !!exporting || sources.length >= MAX_SNAPSHOT_CLIPS}>＋ Add videos</button></div>
    </header>
    {tips && <div className="snapshots-tips"><span><kbd>←</kbd> <kbd>→</kbd> one exact frame</span><span><kbd>Shift</kbd> + arrows ten frames</span><span><kbd>J</kbd> reverse · <kbd>K</kbd> stop · <kbd>L</kbd> forward; repeat for speed</span><span><kbd>Space</kbd> stop</span><span>Wheel over viewer: accelerate · <kbd>Shift</kbd> + wheel: one frame</span><span>Hold the frame buttons to accelerate.</span></div>}
    {error && <div className="snapshots-alert" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="snapshots-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}>×</button></div>}
    <div className="snapshots-workspace">
      <aside className="snapshots-clips" aria-label="Video clips">
        <div className="snapshots-panel-heading"><h2>Source videos</h2><span>{sources.length} / 64</span></div>
        <div className="snapshots-clip-list">{sources.map((s, position) => <div key={s.clip.id} className={`snapshots-clip ${selectedClip === s.clip.id ? "is-active" : ""}`}>
          <button className="snapshots-clip-select" onClick={() => chooseClip(s.clip.id)} title={s.clip.path} aria-pressed={selectedClip === s.clip.id}><span className="snapshots-clip-number">{String(position + 1).padStart(2, "0")}</span><span><strong>{s.clip.name}</strong><small>{s.clip.width} × {s.clip.height} · {snapshotTime(s.clip.frameTimesMs[s.clip.frameTimesMs.length - 1])}</small><small>{selections.filter((p) => p.clipId === s.clip.id).length} selected <span className={s.timeConfirmed ? "snapshots-ok" : "snapshots-warning"}>· {s.timeConfirmed ? "time confirmed" : "confirm time"}</span></small></span></button>
          <button className="snapshots-remove-clip" title="Remove video from session" aria-label={`Remove ${s.clip.name}`} onClick={() => void removeClip(s.clip)} disabled={!!exporting || sessionBusy}>×</button>
        </div>)}
        {!sources.length && !indexing && <div className="snapshots-empty-rail"><span>01</span><p>Add your original videos to begin.</p><small>Local files stay on this computer.</small></div>}
        {queue.filter((q) => q.status !== "ready").map((item) => <div className={`snapshots-queue ${item.status}`} key={item.id}><strong title={item.path}>{basename(item.path)}</strong><span>{item.status === "indexing" ? "Building exact frame index…" : item.status === "queued" ? "Waiting to index" : item.status === "cancelled" ? "Cancelled" : item.error}</span>{["queued", "indexing"].includes(item.status) && <button onClick={() => cancelIndexing(item.id)}>Cancel</button>}</div>)}
        </div>
        {indexing && <div className="snapshots-indexing"><span className="snapshots-spinner" />{pendingCount} video{pendingCount === 1 ? "" : "s"} pending<button onClick={() => cancelIndexing()}>Stop indexing</button></div>}
        <button className="snapshots-add-more" onClick={() => void addVideos()} disabled={sessionBusy || !!exporting || sources.length >= MAX_SNAPSHOT_CLIPS}>＋ Add more videos</button>
        <label className="snapshots-cache">Frame cache<select value={cacheMB} onChange={(e) => setCacheMB(Number(e.target.value))}><option value={16}>16 MB</option><option value={32}>32 MB</option><option value={64}>64 MB</option></select></label>
      </aside>
      <section className="snapshots-main" aria-label="Video frame workspace">
        <div className="snapshots-viewer-heading"><span>{source?.clip.name || "Your next great photo is already in your video."}</span>{source && <span className="snapshots-source-badge">ORIGINAL {source.clip.width} × {source.clip.height}</span>}</div>
        <div ref={viewport} className={`snapshots-viewer ${source && !exact ? "is-seeking" : ""}`} tabIndex={0} aria-label="Frame viewer; scroll to move through frames">
          {imageData && source ? <img src={imageData} alt={`${showingAdjusted ? "Adjusted" : "Original"} video frame ${(shownIndex ?? index) + 1} at ${snapshotTime(source.clip.frameTimesMs[shownIndex ?? index])}`} draggable={false} /> : <div className="snapshots-empty-viewer"><svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true"><rect x="9" y="16" width="54" height="42" rx="8" stroke="currentColor" strokeWidth="1.5"/><path d="M24 16L28 10H44L48 16" stroke="currentColor" strokeWidth="1.5"/><circle cx="36" cy="37" r="12" stroke="currentColor" strokeWidth="1.5"/><path d="M32 30L42 37L32 44V30Z" fill="currentColor"/></svg><h2>{source ? "Finding your frame" : "A great moment. A full-resolution photo."}</h2><p>{source ? "Reading the original video…" : "Scroll through the action, slow down, and select the exact instant."}</p>{!source && <button className="snapshots-primary" onClick={() => void addVideos()} disabled={sessionBusy}>Choose videos</button>}</div>}
          {source && <><div className="snapshots-viewer-top"><span className="snapshots-viewer-label">{showingAdjusted ? "ADJUSTED PREVIEW" : exact ? "ORIGINAL FRAME" : "BROWSING PREVIEW"}</span>{shuttle !== 0 && <span className="snapshots-shuttle-badge">{shuttle < 0 ? "◀" : "▶"} {Math.abs(shuttle)}×</span>}</div><div className="snapshots-viewer-bottom"><span>{shownIndex === undefined ? "Reading original…" : snapshotTime(source.clip.frameTimesMs[shownIndex])}</span><span>{exact ? `Frame ${(index + 1).toLocaleString()} / ${source.clip.frameTimesMs.length.toLocaleString()}` : shownIndex !== undefined ? `Showing frame ${shownIndex + 1} · seeking ${index + 1}` : "Seeking exact frame…"}</span></div></>}
        </div>
        {frameError && <div className="snapshots-inline-error" role="alert">{frameError}<button onClick={() => { failedFrames.current.delete(`${selectedClip}:${index}`); setFrameError(""); }}>Retry frame</button></div>}
        <div className="snapshots-scrubber"><span>{source ? snapshotTime(source.clip.frameTimesMs[index]) : "00:00:00.000"}</span><input type="range" aria-label="Video frame position" min={0} max={Math.max(0, (source?.clip.frameTimesMs.length || 1) - 1)} step={1} value={index} disabled={!source} onPointerDown={stop} onChange={(e) => seek(Number(e.target.value))}/><span>{source ? snapshotTime(source.clip.frameTimesMs[source.clip.frameTimesMs.length - 1]) : "00:00:00.000"}</span></div>
        <div className="snapshots-transport"><div className="snapshots-transport-buttons"><button title="Reverse shuttle (J); repeat to accelerate" aria-label="Reverse shuttle" disabled={!source} onClick={() => startShuttle(-1)}>◀◀</button><button aria-label="Previous frame; hold to accelerate" disabled={!source || index === 0} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startHold(-1); }} onClick={(e) => { if (e.detail === 0) { stop(); step(-1); } }}>│◀</button><button className={shuttle ? "is-active" : ""} aria-label="Stop shuttle" onClick={stop} disabled={!source}>■</button><button aria-label="Next frame; hold to accelerate" disabled={!source || index === source.clip.frameTimesMs.length - 1} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startHold(1); }} onClick={(e) => { if (e.detail === 0) { stop(); step(1); } }}>▶│</button><button title="Forward shuttle (L); repeat to accelerate" aria-label="Forward shuttle" disabled={!source} onClick={() => startShuttle(1)}>▶▶</button></div><span className="snapshots-transport-help">Wheel to scrub · arrows for precision</span><button className="snapshots-primary snapshots-capture" onClick={selectFrame} disabled={!exact || !!existing || selections.length >= MAX_SNAPSHOTS || !!exporting}>{existing ? "✓ Frame selected" : "＋ Select photo"}</button></div>
        <div className="snapshots-source-details"><div className="snapshots-time-heading"><h3>Shooting time</h3><span>{source?.clip.timeSource || "Confirm once for each source video"}</span></div><div className="snapshots-time-fields"><label>Video shooting start, with UTC offset<input aria-label="Shooting start with UTC offset" placeholder="2026-09-30T14:30:00+10:00" value={source?.shootingStart || ""} disabled={!source || !!exporting} onChange={(e) => editSource({ shootingStart: e.target.value, timeConfirmed: false })}/></label><label className="snapshots-time-confirm"><input type="checkbox" checked={source?.timeConfirmed || false} disabled={!source || !validShootingStart(source.shootingStart) || !!exporting} onChange={(e) => editSource({ timeConfirmed: e.target.checked })}/>I confirm this is the original shooting start</label></div><div className="snapshots-time-caption">{capturedAt ? <>Selected photo: <strong>{capturedAt.replace("T", " ").replace("Z", " UTC")}</strong> · start + {snapshotTime(source!.clip.frameTimesMs[index])}</> : "Enter the camera's real date, time and UTC offset before export. Metadata is a suggestion until confirmed."}</div>{source?.clip.warnings?.map((warning, i) => <div className="snapshots-warning snapshots-small" key={i}>{warning}</div>)}</div>
      </section>
      <aside className="snapshots-inspector" aria-label="Photo adjustments"><div className="snapshots-panel-heading"><h2>{photo ? "Selected photo" : "Photo details"}</h2>{photo && <span>#{selections.indexOf(photo) + 1}</span>}</div>
        {!photo ? <div className="snapshots-inspector-empty"><span>✧</span><h3>Keep the best moments</h3><p>Select a frame to add it to your photo tray. Then crop, adjust and export.</p><label>Person name for next selections<input aria-label="Person name for next selections" placeholder="Optional manual label" maxLength={120} value={personName} onChange={(e) => setPersonName(e.target.value)}/></label><p className="snapshots-small">This label is entered by you and included in exported filenames.</p></div> : <div className="snapshots-adjustments"><p className="snapshots-photo-source">{photoSource?.clip.name}<br/><span>Frame {photo.index + 1} · {snapshotTime(photoSource?.clip.frameTimesMs[photo.index] || 0)}</span></p><label>Person name<input aria-label="Selected photo person name" maxLength={120} placeholder="Optional manual label" value={photo.personName} disabled={!!exporting} onChange={(e) => editPhoto({ personName: e.target.value })}/></label>
          <div className="snapshots-adjustment-heading"><h3>Finishing</h3><button onClick={() => editPhoto({ recipe: defaultSnapshotRecipe() })} disabled={!!exporting}>Reset</button></div>
          <label className="snapshots-control">Brightness<span>{Math.round(photo.recipe.brightness * 100)}%</span><input aria-label="Brightness" type="range" min={-50} max={50} step={1} value={Math.round(photo.recipe.brightness * 100)} disabled={!!exporting} onChange={(e) => editRecipe({ brightness: Number(e.target.value) / 100 })}/></label>
          <label className="snapshots-control">Contrast<span>{photo.recipe.contrast}%</span><input aria-label="Contrast" type="range" min={-50} max={50} step={1} value={photo.recipe.contrast} disabled={!!exporting} onChange={(e) => editRecipe({ contrast: Number(e.target.value) })}/></label>
          <label className="snapshots-control">Sharpness<span>{photo.recipe.sharpness.toFixed(1)}</span><input aria-label="Sharpness" type="range" min={0} max={2} step={0.1} value={photo.recipe.sharpness} disabled={!!exporting} onChange={(e) => editRecipe({ sharpness: Number(e.target.value) })}/></label>
          <label className="snapshots-crop-toggle"><input type="checkbox" checked={!!photo.recipe.crop} disabled={!!exporting} onChange={(e) => editRecipe({ crop: e.target.checked ? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } : null })}/>Crop improved photo</label>
          {photo.recipe.crop && <div className="snapshots-crop-fields">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[field]} %<input type="number" aria-label={`Crop ${field} percent`} min={field === "x" || field === "y" ? 0 : 1} max={100} step={1} value={Math.round(photo.recipe.crop![field] * 100)} disabled={!!exporting} onChange={(e) => { const value = Number(e.target.value) / 100; if (!Number.isFinite(value)) return; const crop = { ...photo.recipe.crop! }; if (field === "x") crop.x = Math.max(0, Math.min(1 - crop.width, value)); else if (field === "y") crop.y = Math.max(0, Math.min(1 - crop.height, value)); else if (field === "width") crop.width = Math.max(0.01, Math.min(1 - crop.x, value)); else crop.height = Math.max(0.01, Math.min(1 - crop.y, value)); editRecipe({ crop }); }}/></label>)}</div>}
          <div className="snapshots-before-after"><button className={showBefore ? "is-active" : ""} onClick={() => { choosePhoto(photo); setShowBefore(true); }}>Before</button><button className={!showBefore ? "is-active" : ""} onClick={() => { choosePhoto(photo); setShowBefore(false); }}>After</button></div>
          <p className="snapshots-small">An unenhanced full-resolution JPEG is always saved. Adjustments create a separate improved photo.</p>{adjusted?.key !== recipeKey && !adjustError && <p className="snapshots-small" role="status">Preparing adjusted preview…</p>}{adjustError && <p className="snapshots-inline-error" role="alert">{adjustError}</p>}
          {photo.exported ? <div className="snapshots-export-success"><strong>✓ Exported</strong><span title={photo.exported.path}>{basename(photo.exported.path)}</span>{photo.exported.enhancedPath && <span title={photo.exported.enhancedPath}>{basename(photo.exported.enhancedPath)}</span>}</div> : <button className="snapshots-export-single" onClick={() => void exportPhotos(photo)} disabled={!!exporting || !destination || !photoSource?.timeConfirmed}>Export this photo</button>}{photoErrors[photo.id] && <p className="snapshots-inline-error" role="alert">{photoErrors[photo.id]}</p>}
          <button className="snapshots-remove-photo" disabled={!!exporting} onClick={() => { updateSelections((items) => items.filter((p) => p.id !== photo.id)); setSelectedPhoto(""); }}>Remove from tray</button>
        </div>}
      </aside>
    </div>
    <section className="snapshots-tray" aria-label="Selected photo tray"><div className="snapshots-tray-heading"><div><h2>Photo tray <span>{selections.length} / 200</span></h2><p>Exact original frames, ready to finish.</p></div><div className="snapshots-export-actions"><button className="snapshots-folder" onClick={() => void chooseDestination()} disabled={!!exporting} title={destination}>{destination ? `Folder: ${basename(destination)}` : "Choose export folder"}</button>{exporting ? <><span role="status">Exporting {exporting.done} / {exporting.total}</span><button onClick={() => { exportCancel.current = true; void cancelRequest(exportRequest.current); }}>Stop export</button></> : <button className="snapshots-primary" disabled={!selections.some((p) => !p.exported) || !destination || sessionBusy} onClick={() => void exportPhotos()}>Export {selections.filter((p) => !p.exported).length || ""} photo{selections.filter((p) => !p.exported).length === 1 ? "" : "s"}</button>}</div></div>
      <div className="snapshots-tray-list">{!selections.length ? <div className="snapshots-empty-tray"><span>＋</span> Select an exact frame above to collect your first photo.</div> : selections.map((selection, i) => { const clip = sources.find((s) => s.clip.id === selection.clipId); return <button key={selection.id} className={`snapshots-photo-card ${selectedPhoto === selection.id ? "is-active" : ""} ${photoErrors[selection.id] ? "has-error" : ""}`} aria-label={`Photo ${i + 1}, ${clip?.clip.name}, frame ${selection.index + 1}`} aria-pressed={selectedPhoto === selection.id} onClick={() => choosePhoto(selection)}><div className="snapshots-photo-thumb">{selection.thumbnail ? <img src={selection.thumbnail} alt=""/> : <span>{String(i + 1).padStart(2, "0")}</span>}<span className="snapshots-photo-number">{i + 1}</span>{selection.exported && <span className="snapshots-photo-status">✓</span>}{photoErrors[selection.id] && <span className="snapshots-photo-status error">!</span>}</div><strong>{selection.personName || clip?.clip.name || "Photo"}</strong><small>{snapshotTime(clip?.clip.frameTimesMs[selection.index] || 0)}{!clip?.timeConfirmed ? " · confirm time" : ""}</small></button>; })}</div>
    </section>
    <footer className="snapshots-footer"><span>Local originals · exact indexed frames · full-resolution JPEG export</span><span>{dirty ? "Unsaved session changes" : sources.length ? "Session saved" : "No session open"}</span></footer>
  </section>;
}
