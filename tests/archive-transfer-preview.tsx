// The real Transfer page with a deterministic command adapter. Native selection
// semantics are covered by Rust tests, not simulated as proof by this fixture.
import React from "react";
import { createRoot } from "react-dom/client";
import Transfer from "../src/pages/Transfer";
import type { ArchivePreview, ArchivePreviewItem, ArchiveRequest } from "../src/types/archiveTransfer";
import "../src/styles.css";
const fixture = window as any;
fixture.__archiveCalls = [];
fixture.__archiveJobs = [];
fixture.__archivePreviewSerial = 0;
const stock: ArchivePreviewItem[] = [
  { relativePath: "2026/10/Event/01-rider{Like oo}.jpg", kind: "original", bytes: 6400000, included: true, reason: "Originals: all" },
  { relativePath: "2026/10/Event/01-rider{Like oo}_BW.jpg", kind: "bw", bytes: 4100000, included: true, reason: "Marked for Google Photos" },
  { relativePath: "2026/10/Event/01-rider{Like oo}_improved.jpg", kind: "enhanced", bytes: 5200000, included: false, reason: "Not marked for Google Photos" },
  { relativePath: "2026/10/Event/02-horse{trash}.jpg", kind: "original", bytes: 6300000, included: false, reason: "Trashed original" },
  { relativePath: "2026/10/Event/.photogogo-curation.json", kind: "metadata", bytes: 512, included: false, reason: "PhotoGoGo library metadata excluded" },
  { relativePath: "2026/10/Event/01-rider.pgg.preview.240x135.jpg", kind: "cache", bytes: 11000, included: false, reason: "PhotoGoGo preview/cache always excluded" },
  { relativePath: "2026/10/Event/camera.MOV", kind: "video", bytes: 128000000, included: true, reason: "Videos included" },
  { relativePath: "2026/10/Event/01-rider{Like oo}.xmp", kind: "sidecar", bytes: 800, included: true, reason: "Companion of selected media" },
];
function preview(request: ArchiveRequest): ArchivePreview {
  const items: ArchivePreviewItem[] = fixture.__archiveEmpty ? stock.map(item => ({ ...item, included: false })) : structuredClone(stock);
  if (fixture.__archiveMany) for (let index = 0; index < 110; index++) items.push({ relativePath: `2026/10/Event/extra-${String(index).padStart(3, "0")}.jpg`, kind: "original", bytes: 4000000, included: true, reason: "Originals: all" });
  const groups = [...new Set(items.map(item => item.kind))].map(kind => {
    const members = items.filter(item => item.kind === kind), included = members.filter(item => item.included);
    return { kind, includedCount: included.length, excludedCount: members.length - included.length, includedBytes: included.reduce((sum, item) => sum + item.bytes, 0) };
  });
  return { id: `archive-preview-${++fixture.__archivePreviewSerial}`, stagingDir: request.stagingDir, archiveDir: request.archiveDir, scopeDir: request.scopeDir || request.stagingDir, createdAt: "2026-10-26T10:00:00Z", canStart: !fixture.__archiveBlocked, summary: { includedCount: items.filter(item => item.included).length, excludedCount: items.filter(item => !item.included).length, includedBytes: items.filter(item => item.included).reduce((sum, item) => sum + item.bytes, 0), groups }, items, warnings: fixture.__archiveBlocked ? ["An ambiguous original/version relationship requires review."] : [] };
}
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
  fixture.__archiveCalls.push({ command, args: structuredClone(args) });
  if (command === "load_settings") return { staging_dir: "D:\\Stage", archive_dir: "E:\\Archive" };
  if (command === "list_import_jobs" || command === "studio_list_jobs") return [];
  if (command === "process_jobs_snapshot") return { jobs: structuredClone(fixture.__archiveJobs), warnings: [] };
  if (command === "plugin:dialog|open") return "D:\\Stage\\2026\\10\\Event";
  if (command === "preview_archive_transfer") {
    if (fixture.__archivePreviewDelay) await new Promise<void>(resolve => { fixture.__resolveArchivePreview = resolve; });
    if (fixture.__archivePreviewError) throw new Error("Photo curation is invalid; no selection was inferred.");
    return preview(args.request);
  }
  if (command === "start_transfer") {
    if (fixture.__archiveQueueDelay) await new Promise<void>(resolve => { fixture.__resolveArchiveQueue = resolve; });
    if (fixture.__archiveStale) throw new Error("The staging library changed after preview.");
    const id = `transfer-${fixture.__archiveCalls.filter((call: any) => call.command === "start_transfer").length}`;
    fixture.__archiveJobs.push({ id, task: "transfer", status: "queued", createdAt: "2026-10-26T10:01:00Z", stagingDir: args.stagingDir, archiveDir: args.archiveDir, scopeDir: args.stagingDir, total: 4, done: 0, processed: 0, resultCount: 0, currentFile: "Queued reviewed archive selection", errors: [], logs: ["Reviewed selection queued in core Jobs."], statusLine: "Queued", pauseRequested: false, abortRequested: false });
    return id;
  }
  if (command === "verify_checksums") return "verify-1";
  if (["pause_process_job", "resume_process_job", "abort_process_job"].includes(command)) return true;
  throw new Error(`Unexpected archive fixture command: ${command}`);
} };
createRoot(document.getElementById("root")!).render(<div className="archive-fixture" style={{ height: "100%", overflow: "auto" }}><Transfer /></div>);
