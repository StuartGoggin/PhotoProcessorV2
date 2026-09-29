// Development-only, isolated regression fixture. It never reads real projects/media.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import StudioVideoPreview from "../src/components/StudioVideoPreview";
import type { StudioVideoPreviewProps } from "../src/components/StudioVideoPreview";
import "../src/styles.css";

const fixture = window as any;
fixture.__previewCalls = [];
fixture.__pendingPreviewReads = [];
fixture.__selectedPreviewTimes = [];
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  fixture.__previewCalls.push({ command, args });
  if (command === "studio_read_preview") {
    if (fixture.__previewReadMode === "deferred") return new Promise((resolve, reject) => fixture.__pendingPreviewReads.push({ jobId: args.jobId, resolve, reject }));
    if (fixture.__previewReadMode === "error") throw new Error("Preview exceeds the 64 MiB inline playback limit.");
    if (fixture.__previewReadMode === "invalid") return "https://example.invalid/not-a-preview";
    return fixture.__previewDataUrl;
  }
  if (command === "open_in_default_app" && fixture.__previewOpenError) throw new Error("No associated application.");
  return null;
} };

function Fixture() {
  const [props, setProps] = useState<Omit<StudioVideoPreviewProps, "onTimeSelected">>({ jobId: null, jobs: [], sourceStart: 10 });
  const [linear, setLinear] = useState(true);
  const [visible, setVisible] = useState(true);
  fixture.__setPreview = (next: typeof props, linearPreview = true) => { setProps(next); setLinear(linearPreview); };
  fixture.__showPreview = setVisible;
  return <main style={{ maxWidth: 700, padding: 12, margin: "0 auto" }}>
    {visible && <StudioVideoPreview {...props} onTimeSelected={linear ? (seconds) => fixture.__selectedPreviewTimes.push(seconds) : undefined} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
