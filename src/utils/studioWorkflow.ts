import { newBackgroundMusic, type StudioClip, type StudioJob, type StudioProject } from "../types/videoStudio";

export const STUDIO_CLEARED = "studio-renders-cleared";
export function resetProjectRenders(project: StudioProject): StudioProject {
  return { ...project, music: { ...project.music, requestId: "" },
    clips: project.clips.map((clip) => ({ ...clip, rendered: null, revision: (clip.revision ?? 0) + 1 })) };
}
export function notifyStudioCleared() {
  try {
    const key = "photogogo.videoStudio.project.v1";
    const raw = localStorage.getItem(key);
    if (raw) localStorage.setItem(key, JSON.stringify(resetProjectRenders(JSON.parse(raw))));
  } finally { window.dispatchEvent(new Event(STUDIO_CLEARED)); }
}

export const suggestedBitrate = (width: number) => width === 3840 ? 32 : width === 1920 ? 10 : 4;
export const outputLabel = (p: Pick<StudioProject, "width" | "height" | "fps" | "bitrateMbps">) =>
  `${p.width}×${p.height} · ${p.fps} fps · ${p.bitrateMbps} Mbps`;
export const normalizeProject = (p: StudioProject): StudioProject => ({
  ...p, bitrateMbps: p.bitrateMbps || suggestedBitrate(p.width),
  music: { ...newBackgroundMusic(), ...p.music },
  clips: p.clips.map((clip) => ({ ...clip, revision: clip.revision ?? 0 })),
});
export function isClipReady(clip: StudioClip, p: StudioProject): boolean {
  const r = clip.rendered;
  return !!r?.signature && r.available !== false && r.revision === (clip.revision ?? 0) && r.width === p.width
    && r.height === p.height && r.fps === p.fps && r.bitrateMbps === p.bitrateMbps;
}
export function editClip(clip: StudioClip, patch: Partial<StudioClip>): StudioClip {
  const changed = ["path", "duration", "title", "titleSeconds", "stabilization", "framing", "replays"]
    .some((key) => key in patch && JSON.stringify(patch[key as keyof StudioClip]) !== JSON.stringify(clip[key as keyof StudioClip]));
  return { ...clip, ...patch, revision: (clip.revision ?? 0) + (changed ? 1 : 0),
    reviewed: patch.reviewed ?? (changed ? false : clip.reviewed) };
}
export function applyCompletedRenders(project: StudioProject, jobs: StudioJob[]): StudioProject {
  let changed = false;
  const artifacts = jobs.flatMap((job) => job.artifacts ?? []).sort((a,b) => b.rendered.renderedAt.localeCompare(a.rendered.renderedAt));
  const clips = project.clips.map((clip) => {
    const match = artifacts.find((a) => a.clipId === clip.id && a.sourcePath === clip.path
      && isClipReady({ ...clip, rendered: a.rendered }, project));
    if (!match || match.rendered.path === clip.rendered?.path) return clip;
    changed = true;
    return { ...clip, rendered: match.rendered };
  });
  return changed ? { ...project, clips } : project;
}
export function clipJob(clip: StudioClip, project: StudioProject, jobs: StudioJob[]): StudioJob | undefined {
  return jobs.find((job) => job.kind !== "preview" && ["queued", "running"].includes(job.status)
    && job.width === project.width && job.height === project.height && job.fps === project.fps && job.bitrateMbps === project.bitrateMbps
    && job.targets?.some((target) => target.clipId === clip.id && target.sourcePath === clip.path && target.revision === (clip.revision ?? 0)));
}
export function clipStatus(clip: StudioClip, project: StudioProject, jobs: StudioJob[]): string {
  const active = clipJob(clip, project, jobs);
  if (active) return `${active.paused ? "Pause requested" : active.status === "queued" ? "Queued" : "Rendering"} · ${Math.round(active.progress)}%`;
  if (isClipReady(clip, project)) return "Ready to assemble";
  const stopped = jobs.find((job) => job.kind !== "preview" && ["failed", "interrupted", "cancelled"].includes(job.status)
    && job.width === project.width && job.height === project.height && job.fps === project.fps && job.bitrateMbps === project.bitrateMbps
    && job.targets?.some((target) => target.clipId === clip.id && target.sourcePath === clip.path && target.revision === (clip.revision ?? 0)));
  if (stopped) return `${stopped.status === "interrupted" ? "Interrupted" : stopped.status === "failed" ? "Render failed" : "Cancelled"} · resume in Jobs`;
  return clip.rendered?.available === false ? "Output missing · re-render needed" : clip.rendered ? "Needs re-render" : "Not rendered";
}
