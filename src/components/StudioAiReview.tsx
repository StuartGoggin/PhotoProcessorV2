import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { StudioClip, StudioReplay } from "../types/videoStudio";
interface Suggestion {
  start: number;
  end: number;
  caption: string;
  reason: string;
}
interface Review {
  teamMatch: string;
  summary: string;
  replays: Suggestion[];
}
export default function StudioAiReview({
  clip,
  team,
  frames,
  onReplay,
  onNotes,
}: {
  clip: StudioClip;
  team: string;
  frames: { at: number; data: string }[];
  onReplay: (r: StudioReplay) => void;
  onNotes: (s: string) => void;
}) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState("gpt-5.4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [accepted, setAccepted] = useState<number[]>([]);
  const token = useRef(0);
  useEffect(() => {
    token.current++;
    setReview(null);
    setAccepted([]);
    setError("");
  }, [clip.id, clip.path, team]);
  async function run() {
    if (
      !(await confirm(
        `Send these ${frames.length} sampled frames and the team description to OpenAI for review? This uses separately billed API access. No video file or audio is uploaded.`,
        { title: "Approve AI frame upload", kind: "warning" }
      ))
    )
      return;
    const t = ++token.current;
    setBusy(true);
    setError("");
    setReview(null);
    setAccepted([]);
    try {
      const result = await invoke<Review>("studio_ai_review", {
        apiKey: key,
        model,
        team,
        duration: clip.duration,
        frames,
        consent: true,
      });
      if (t === token.current) setReview(result);
    } catch (e) {
      if (t === token.current) setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="border border-surface-600 rounded p-3">
      <summary className="cursor-pointer font-semibold">
        Optional AI review — suggestions only
      </summary>
      <div className="space-y-3 mt-3 text-sm">
        <p>
          Generate review frames first. AI can suggest team consistency and recap moments, but
          sparse frames may miss mistakes. Nothing is applied automatically.
        </p>
        <p className="text-gray-400">
          Uses the OpenAI API, billed separately from ChatGPT. The API key stays in memory for this
          session and is not saved in your project or logs. Requests use store:false; provider data
          policies still apply.
        </p>
        <label className="block">
          API key
          <input
            className="block w-full bg-surface-900 rounded p-2"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label className="block">
          Vision-capable model
          <input
            className="block w-full bg-surface-900 rounded p-2"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            disabled={busy || !key || !model || !frames.length}
            onClick={() => void run()}
          >
            {busy ? "Reviewing sampled frames…" : `Run AI review (${frames.length} frames)`}
          </button>
          <button className="btn-secondary" onClick={() => setKey("")}>
            Clear key
          </button>
        </div>
        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}
        {review && (
          <>
            <p>
              Suggested team match: <strong>{review.teamMatch}</strong>
            </p>
            <p className="whitespace-pre-wrap">{review.summary}</p>
            <button
              className="btn-secondary"
              onClick={() => onNotes(`AI team match: ${review.teamMatch}\n${review.summary}`)}
            >
              Copy summary into review notes
            </button>
            {review.replays.map((r, i) => (
              <div key={i} className="bg-surface-900 rounded p-3">
                <p>
                  {r.start.toFixed(2)}–{r.end.toFixed(2)}s · {r.caption}
                </p>
                <p className="text-gray-400">{r.reason}</p>
                <button
                  className="btn-secondary mt-2"
                  disabled={accepted.includes(i)}
                  onClick={() => {
                    onReplay({
                      id: crypto.randomUUID(),
                      start: r.start,
                      end: r.end,
                      speed: 0.5,
                      caption: r.caption,
                      enabled: true,
                    });
                    setAccepted((a) => [...a, i]);
                  }}
                >
                  {accepted.includes(i)
                    ? "Added — verify range below"
                    : "Add editable recap suggestion"}
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
