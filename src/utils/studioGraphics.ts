import type { StudioClip, StudioGraphicsSettings, StudioProject, StudioScorecard } from "../types/videoStudio";

export const graphicsDefaults = (): StudioGraphicsSettings => ({ version: 1,
  theme: { font: "segoe", palette: "midnight", accent: "#D5B46B", position: "bottom", opacity: 88 },
  styledTitles: false, scorecardTiming: "clipEnd", scorecardSeconds: 6, scorecardStart: 0 });
export const newScorecard = (): StudioScorecard => ({ enabled: true, template: "line", heading: "RESULT",
  result: "", subtitle: "", columns: ["Place", "Team", "Score"], rows: [["1", "", ""]],
  timing: "inherit", seconds: 6, start: 0 });

export function titleStyleKey(p: StudioProject, c: StudioClip): string {
  if (!c.title.trim() || c.titleSeconds <= 0) return "";
  const g = p.graphics ?? graphicsDefaults(), t = g.theme;
  const heading = c.titleHeading?.trim() ?? "", subtitle = c.titleSubtitle?.trim() ?? "";
  if (heading || subtitle) return JSON.stringify([2, g.styledTitles ? [t.font, t.palette, t.accent.toUpperCase(), t.position, t.opacity] : null, heading, subtitle]);
  if (!g.styledTitles) return "";
  return JSON.stringify([1, t.font, t.palette, t.accent.toUpperCase(), t.position, t.opacity]);
}

// Estimates for the editor. Native export resolves the same windows from measured frames.
export function scoreWindow(p: StudioProject, c: StudioClip, main = c.duration,
  total = main + c.replays.filter(r => r.enabled).reduce((n, r) => n + (r.end - r.start) / r.speed, 0)) {
  if (!c.scorecard?.enabled) return { start: 0, end: 0, extraSeconds: 0 };
  const s = c.scorecard, g = p.graphics ?? graphicsDefaults();
  const timing = s.timing === "inherit" ? g.scorecardTiming : s.timing;
  const seconds = s.timing === "inherit" ? g.scorecardSeconds : s.seconds;
  const at = s.timing === "inherit" ? g.scorecardStart : s.start;
  if (timing === "separateCard") return { start: total, end: total + seconds, extraSeconds: seconds };
  const limit = timing === "afterReplays" ? total : main;
  const start = timing === "clipStart" ? 0 : timing === "custom" ? Math.min(at, limit) : Math.max(0, limit - seconds);
  return { start, end: Math.min(limit, start + seconds), extraSeconds: 0 };
}

export function graphicsRecipe(p: StudioProject): unknown[] | null {
  const g = p.graphics ?? graphicsDefaults();
  const cards = p.clips.filter(c => c.include && c.scorecard?.enabled);
  const openingHeading = p.openingTitleMode !== "none" && p.title.trim() && p.titleSeconds > 0 ? p.titleHeading?.trim() ?? "" : "";
  const titleLines = p.clips.filter(c => c.include && c.title.trim() && c.titleSeconds > 0 && (c.titleHeading?.trim() || c.titleSubtitle?.trim()))
    .map(c => [c.id, c.titleHeading?.trim() ?? "", c.titleSubtitle?.trim() ?? ""]);
  if (!openingHeading && !titleLines.length && !cards.length && !(g.styledTitles && (p.clips.some(c => c.include && c.title.trim())
      || (p.openingTitleMode !== "none" && (p.title.trim() || p.subtitle.trim()))))) return null;
  const t = g.theme;
  const recipe: unknown[] = [1, [t.font, t.palette, t.accent.toUpperCase(), t.position, t.opacity], g.styledTitles,
    cards.map(c => { const s = c.scorecard!; return [c.id, s.template, s.heading, s.result, s.subtitle,
      s.template === "table" ? s.columns : [], s.template === "table" ? s.rows : [],
      s.timing === "inherit" ? g.scorecardTiming : s.timing,
      s.timing === "inherit" ? g.scorecardSeconds : s.seconds,
      s.timing === "inherit" ? g.scorecardStart : s.start]; })];
  // Keep every legacy recipe byte-identical until optional title lines are used.
  if (openingHeading || titleLines.length) { recipe[0] = 2; recipe.push([openingHeading, titleLines]); }
  return recipe;
}

export function chapterPlan(p: StudioProject) {
  let offset = p.title.trim() && p.openingTitleMode === "card" ? p.titleSeconds : 0;
  return p.clips.filter(c => c.include).map(c => {
    const length = c.duration + c.replays.filter(r => r.enabled).reduce((n, r) => n + (r.end - r.start) / r.speed, 0);
    const card = scoreWindow(p, c, c.duration, length), start = offset;
    offset += length + card.extraSeconds;
    return { clipId: c.id, title: c.chapter, start, end: offset,
      cardStart: c.scorecard?.enabled ? start + card.start : null,
      cardEnd: c.scorecard?.enabled ? start + card.end : null, extraSeconds: card.extraSeconds };
  });
}
