import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types";
import type { StudioClip, StudioJob } from "../types/videoStudio";
import { ReviewFrameQueue, reviewOptions, type ReviewReply, type ReviewSnapshot } from "../utils/studioReviewFrames";

const empty: ReviewSnapshot = { selected: "", frames: [], error: "", working: false, prepared: 0, failed: 0 };
export function useStudioReviewFrames(clips: StudioClip[], selected: string, epoch: number, loaded: boolean, jobs: StudioJob[], active: boolean) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [snapshot, setSnapshot] = useState<{ scope: string; value: ReviewSnapshot }>({ scope: "", value: empty });
  const queue = useRef<ReviewFrameQueue | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const blocked = jobs.some(job => ["running", "queued", "paused"].includes(job.status));
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const clipKey = JSON.stringify(clips.map(c => ({ id: c.id, path: c.path, duration: c.duration })));
  const { mode, count } = reviewOptions(settings ?? {});
  const config = JSON.stringify([epoch, clipKey, settings?.staging_dir, mode, count]);
  const scope = JSON.stringify([config, selected]);
  const configRef = useRef(config); configRef.current = config;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const value = await invoke<Settings>("load_settings"); if (alive) { setSettings(value); setSettingsError(""); } }
      catch (e) { if (alive) { setSettings(null); setSettingsError(`Review frame settings unavailable: ${String(e)}`); } }
    };
    void load(); window.addEventListener("photogogo-settings-saved", load);
    return () => { alive = false; window.removeEventListener("photogogo-settings-saved", load); };
  }, []);
  useEffect(() => {
    if (!active || !loaded || !settings?.staging_dir) return;
    const value = new ReviewFrameQueue(JSON.parse(clipKey), mode, count,
      request => invoke<ReviewReply>("studio_review_frame", { ...request, stagingDir: settings.staging_dir }),
      value => setSnapshot({ scope: JSON.stringify([config, value.selected]), value }));
    queue.current = value; value.select(selectedRef.current);
    const tick = () => { if (configRef.current === config) void value.step(blockedRef.current); };
    const timer = window.setInterval(tick, 300); tick();
    const focus = () => value.select(selectedRef.current);
    window.addEventListener("focus", focus);
    return () => { value.stop(); if (queue.current === value) queue.current = null; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [config, loaded, !!settings, active]); // Only the source list/settings identity or page visibility restarts the queue.
  useEffect(() => { queue.current?.select(selected); }, [selected]);
  const current = active && snapshot.scope === scope ? snapshot.value : empty;
  return { ...current, count, mode, blocked,
    error: settingsError || (settings && !settings.staging_dir ? "Configure a staging folder in Settings to prepare review frames." : current.error),
    refresh: () => queue.current?.select(selected, true) };
}
