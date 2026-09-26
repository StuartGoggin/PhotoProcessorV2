import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioClip, StudioProject } from "../../types/videoStudio";
import { graphicsDefaults, newScorecard } from "../../utils/studioGraphics";

type Target = "scorecard" | "clipTitle" | "opening";
interface RenderedPreview { dataUrl: string; background: string; atSeconds: number; key: string }
interface Props {
  project: StudioProject;
  clip?: StudioClip;
  target: Target;
  getStagingDir: () => Promise<string>;
  disabled?: boolean;
}

export default function StudioGraphicsPreview({ project, clip, target, getStagingDir, disabled = false }: Props) {
  const graphics = project.graphics ?? graphicsDefaults();
  const card = clip?.scorecard ?? newScorecard();
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0), mounted = useRef(true), inFlight = useRef(false);
  const key = JSON.stringify([project, clip?.id ?? null, target]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => { version.current++; setPreview(null); setError(""); }, [key]);
  const current = preview?.key === key ? preview : null;
  const title = target === "scorecard" ? card.result : target === "opening" ? project.title : clip?.title ?? "";
  const heading = target === "scorecard" ? card.heading : target === "opening" ? "OPENING TITLE" : "CLIP TITLE";
  const subtitle = target === "scorecard" ? card.subtitle : target === "opening" ? project.subtitle : "";
  const absent = target === "scorecard" ? !clip?.scorecard?.enabled : target === "opening"
    ? project.openingTitleMode === "none" || !project.titleSeconds || !project.title.trim()
    : !clip?.title.trim() || !clip.titleSeconds;
  const font = { segoe: '"Segoe UI", sans-serif', georgia: 'Georgia, serif', trebuchet: '"Trebuchet MS", sans-serif' }[graphics.theme.font];
  const style = { "--graphic-accent": graphics.theme.accent, "--graphic-alpha": graphics.theme.opacity / 100, fontFamily: font } as CSSProperties;
  async function renderPreview() {
    if (disabled || absent || inFlight.current) return;
    const token = ++version.current, capturedKey = key;
    inFlight.current = true; setBusy(true); setError(""); setPreview(null);
    try {
      const stagingDir = await getStagingDir();
      if (!mounted.current || token !== version.current || capturedKey !== currentKey.current) return;
      const result = await invoke<Omit<RenderedPreview, "key">>("studio_graphics_preview", { stagingDir, project, clipId: clip?.id ?? null, target });
      if (!mounted.current || token !== version.current || capturedKey !== currentKey.current) return;
      if (!result || typeof result.dataUrl !== "string" || result.dataUrl.length > 32_000_000
        || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.dataUrl)
        || typeof result.background !== "string" || !Number.isFinite(result.atSeconds) || result.atSeconds < 0) {
        throw new Error("The rendered preview response was invalid. Please try again.");
      }
      setPreview({ ...result, key: capturedKey });
    } catch (failure) {
      if (mounted.current && token === version.current && capturedKey === currentKey.current) setError(String(failure));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <section className="studio-graphics-preview" aria-label={`${target === "scorecard" ? "Scorecard" : target === "opening" ? "Opening title" : "Clip title"} preview`}>
    <div className="studio-graphics-preview-heading"><span>{current ? "Rendered frame" : "Live layout sketch"}</span><small>{current ? "Actual compositor" : "Illustration · not footage"}</small></div>
    {current ? <figure><img src={current.dataUrl} alt={`Rendered ${target === "scorecard" ? "scorecard" : "title"} preview`} /><figcaption>{current.background} · {current.atSeconds.toFixed(2)} seconds</figcaption></figure>
      : <div className={`studio-graphics-stage palette-${graphics.theme.palette} position-${graphics.theme.position} template-${target === "scorecard" ? card.template : "line"}`} style={style}>
        <span className="studio-graphics-stage-label">LAYOUT SKETCH</span>
        {absent ? <p className="studio-graphics-hidden">{target === "scorecard" ? "Enable this scorecard to compose it" : "Title hidden"}</p>
          : <div className="studio-graphics-card"><span className="studio-graphics-eyebrow">{heading}</span>
            {title && <strong>{title}</strong>}
            {target === "scorecard" && card.template === "table" && <table><thead><tr>{card.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{card.rows.map((row, index) => <tr key={index}>{card.columns.map((_, col) => <td key={col}>{row[col] ?? ""}</td>)}</tr>)}</tbody></table>}
            {subtitle && <span className="studio-graphics-subtitle">{subtitle}</span>}
          </div>}
      </div>}
    <div className="studio-graphics-preview-actions"><button type="button" className="btn-secondary" disabled={disabled || busy || absent} onClick={() => void renderPreview()}>{busy ? "Rendering preview…" : "Rendered preview"}</button>
      {current && <button type="button" className="btn-secondary" onClick={() => setPreview(null)}>Show layout sketch</button>}
      <small>One frame only · never starts a video render</small></div>
    {target !== "scorecard" && !graphics.styledTitles && <p className="studio-graphics-help">Legacy title style is kept. The sketch illustrates the shared style; enable styled titles in Project → Graphics to use it. Rendered preview shows the actual current style.</p>}
    {error && <p role="alert">Could not render preview: {error}</p>}
  </section>;
}
