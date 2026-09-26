import { normalizeProject as normalizeHardware, newBackgroundMusic, type StudioClip, type StudioJob, type StudioProject } from "../types/videoStudio";
import { effectiveWindReduction } from "./studioAudio";
import { graphicsRecipe, titleStyleKey } from "./studioGraphics";

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

// Shared v1/v2 value contract with native video_studio/sequence.rs. Compare recipes,
// not cache/progress state or just counts. This is not a source-file hash check.
export function sequenceRecipe(p: StudioProject): unknown[] {
  const recipe: unknown[] = [1, [p.name, p.title, p.subtitle, p.titleSeconds, p.openingTitleMode || "card"],
    [p.width, p.height, p.fps, p.bitrateMbps || suggestedBitrate(p.width)],
    p.music.enabled ? [p.music.audioPath, p.music.musicVolume, p.music.originalVolume] : null,
    p.clips.filter((c) => c.include).map((c) => [c.id, c.path, c.revision ?? 0, c.duration, c.chapter,
      c.title, c.titleSeconds, c.stabilization, c.stabilizationMethod || "quality",
      [c.customStabilization.radius, c.customStabilization.blockSize, c.customStabilization.contrast], c.framing,
      c.replays.filter((r) => r.enabled).map((r) => [r.id, r.start, r.end, r.speed, r.caption])])];
  const audio = p.clips.filter((c) => c.include).map((c) => [c.id, effectiveWindReduction(p, c)]);
  // All-off must retain the exact existing recipe so 2.0.17 exports stay current.
  if (audio.some(([, preset]) => preset !== "off")) {
    recipe[0] = 2;
    recipe.push([1, audio]);
  }
  const graphics = graphicsRecipe(p);
  if (graphics) {
    recipe[0] = 3;
    if (recipe.length === 5) recipe.push(null);
    recipe.push(graphics);
  }
  return recipe;
}
export type SequenceStatus = "current" | "outdated" | "unknown";
export function sequenceStatus(job: Pick<StudioJob, "sequence" | "targets">, p: StudioProject): SequenceStatus {
  if (Array.isArray(job.sequence) && ((job.sequence.length === 5 && job.sequence[0] === 1)
      || (job.sequence.length === 6 && job.sequence[0] === 2)
      || (job.sequence.length === 7 && job.sequence[0] === 3))) {
    return JSON.stringify(job.sequence) === JSON.stringify(sequenceRecipe(p)) ? "current" : "outdated";
  }
  // Legacy targets can prove a mismatch, but cannot establish a matching recipe.
  if (job.targets?.length) {
    const clips = p.clips.filter((c) => c.include);
    if (clips.length !== job.targets.length || clips.some((c, i) => {
      const t = job.targets![i];
      return c.id !== t.clipId || c.path !== t.sourcePath || (c.revision ?? 0) !== t.revision;
    })) return "outdated";
  }
  return "unknown";
}
export function sequenceClipCount(job: Pick<StudioJob, "sequence" | "targets">): number | null {
  if (Array.isArray(job.sequence) && [1, 2, 3].includes(job.sequence[0]) && Array.isArray(job.sequence[4])) return job.sequence[4].length;
  return job.targets?.length ? job.targets.length : null;
}
export const normalizeProject = (p: StudioProject): StudioProject => ({
  ...normalizeHardware(p), bitrateMbps: p.bitrateMbps || suggestedBitrate(p.width),
  music: { ...newBackgroundMusic(), ...p.music },
  clips: normalizeHardware(p).clips.map((clip) => ({ ...clip, revision: clip.revision ?? 0 })),
});
export function isClipReady(clip: StudioClip, p: StudioProject): boolean {
  const r = clip.rendered;
  return !!r?.signature && r.available !== false && r.revision === (clip.revision ?? 0) && r.width === p.width
    && r.height === p.height && r.fps === p.fps && r.bitrateMbps === p.bitrateMbps
    && (r.titleStyleKey ?? "") === titleStyleKey(p, clip);
}
export function editClip(clip: StudioClip, patch: Partial<StudioClip>): StudioClip {
  const changed = ["path", "duration", "title", "titleSeconds", "stabilization", "stabilizationMethod", "customStabilization", "framing", "replays"]
    .some((key) => key in patch && JSON.stringify(patch[key as keyof StudioClip]) !== JSON.stringify(clip[key as keyof StudioClip]));
  return { ...clip, ...patch, revision: (clip.revision ?? 0) + (changed ? 1 : 0),
    reviewed: patch.reviewed ?? (changed ? false : clip.reviewed) };
}
// Review navigation skips excluded/already-approved clips and wraps only once.
export function approveAndNext(project: StudioProject, clipId: string): { project: StudioProject; nextClipId: string | null } {
  const index = project.clips.findIndex((clip) => clip.id === clipId && clip.include);
  if (index < 0) return { project, nextClipId: null };
  const clips = project.clips.map((clip, i) => i === index ? editClip(clip, { reviewed: true }) : clip);
  const order = [...clips.slice(index + 1), ...clips.slice(0, index)];
  return { project: { ...project, clips }, nextClipId: order.find((clip) => clip.include && !clip.reviewed)?.id ?? null };
}

// Sequence edits never touch the reusable render or its revision.
export function moveClip(project: StudioProject, clipId: string, delta: number): StudioProject {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  const destination = index + delta;
  if (index < 0 || destination < 0 || destination >= project.clips.length) return project;
  const clips = [...project.clips];
  const [clip] = clips.splice(index, 1);
  clips.splice(destination, 0, clip);
  return { ...project, clips };
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
  return jobs.find((job) => job.kind !== "preview" && ["queued", "running", "paused"].includes(job.status)
    && jobTitleStyleMatches(job, clip, project)
    && job.width === project.width && job.height === project.height && job.fps === project.fps && job.bitrateMbps === project.bitrateMbps
    && job.targets?.some((target) => target.clipId === clip.id && target.sourcePath === clip.path && target.revision === (clip.revision ?? 0)));
}
function jobTitleStyleMatches(job: StudioJob, clip: StudioClip, project: StudioProject): boolean {
  const target = job.targets?.find((candidate) => candidate.clipId === clip.id && candidate.sourcePath === clip.path && candidate.revision === (clip.revision ?? 0));
  if (target?.titleStyleKey !== undefined) return target.titleStyleKey === titleStyleKey(project, clip);
  if (!clip.title.trim() || clip.titleSeconds <= 0) return true;
  const recipe = job.sequence;
  const graphics = Array.isArray(recipe) && recipe[0] === 3 && Array.isArray(recipe[6]) ? recipe[6] : null;
  const key = graphics?.[2] === true && Array.isArray(graphics[1]) ? JSON.stringify([1, ...graphics[1]]) : "";
  return key === titleStyleKey(project, clip);
}
export function clipStatus(clip: StudioClip, project: StudioProject, jobs: StudioJob[]): string {
  const active = clipJob(clip, project, jobs);
  if (active) return `${active.paused ? "Pause requested" : active.status === "queued" ? "Queued" : "Rendering"} · ${Math.round(active.progress)}%`;
  if (isClipReady(clip, project)) return "Ready to assemble";
  const stopped = jobs.find((job) => job.kind !== "preview" && ["failed", "interrupted", "cancelled"].includes(job.status)
    && jobTitleStyleMatches(job, clip, project)
    && job.width === project.width && job.height === project.height && job.fps === project.fps && job.bitrateMbps === project.bitrateMbps
    && job.targets?.some((target) => target.clipId === clip.id && target.sourcePath === clip.path && target.revision === (clip.revision ?? 0)));
  if (stopped) return `${stopped.status === "interrupted" ? "Interrupted" : stopped.status === "failed" ? "Render failed" : "Cancelled"} · resume in Jobs`;
  return clip.rendered?.available === false ? "Output missing · re-render needed" : clip.rendered ? "Needs re-render" : "Not rendered";
}
