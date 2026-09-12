import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportProgress, ImportResult } from "../types";
import { useSettings, useProgressListener } from "../hooks";
import { ProgressBar } from "../components";

interface LogEntry {
  time: string;
  message: string;
  type: "info" | "warn" | "error" | "success";
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-AU", { hour12: false });
}

export default function Import() {
  const { settings } = useSettings();
  const { subscribe, unsubscribe } = useProgressListener<ImportProgress>("import-progress");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const logEndRef = useRef<HTMLDivElement>(null);
  const lastFileRef = useRef<string>("");

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  function addLog(message: string, type: LogEntry["type"] = "info") {
    setLog((prev) => [...prev, { time: timestamp(), message, type }]);
  }

  async function startImport() {
    if (!settings?.source_root || !settings?.staging_dir) {
      setError("Please configure Source Root and Staging Directory in Settings first.");
      return;
    }

    setRunning(true);
    setResult(null);
    setError(null);
    setProgress(null);
    setLog([]);
    lastFileRef.current = "";

    addLog(`Source: ${settings.source_root}`);
    addLog(`Staging: ${settings.staging_dir}`);
    addLog("Scanning source directory for supported files...");

    await subscribe((p) => {
      setProgress(p);

      // Phase-based log messages
      if (p.phase === "scanning") {
        // already logged above
        return;
      }

      if (p.phase === "found") {
        if (p.total === 0) {
          addLog("No supported files found in source directory.", "warn");
        } else {
          addLog(p.current_file, "info"); // "Found X file(s) — starting copy..."
        }
        return;
      }

      // Copying phase — log each new file
      if (p.current_file && p.current_file !== lastFileRef.current) {
        lastFileRef.current = p.current_file;
        addLog(`[${p.done}/${p.total}] ${p.current_file} — ${p.speed_mbps.toFixed(1)} MB/s`);
      }

      if (p.errors.length > 0) {
        const lastError = p.errors[p.errors.length - 1];
        addLog(`Error: ${lastError}`, "error");
      }
    });

    try {
      const res = await invoke<ImportResult>("start_import", {
        sourceDir: settings.source_root,
        stagingDir: settings.staging_dir,
      });
      setResult(res);
      addLog(
        `✓ Done — ${res.imported} imported, ${res.skipped} skipped${res.errors.length > 0 ? `, ${res.errors.length} errors` : ""}`,
        res.errors.length > 0 ? "warn" : "success"
      );
      res.errors.forEach((e) => addLog(`  ${e}`, "error"));
    } catch (e) {
      setError(String(e));
      addLog(`✗ Import failed: ${e}`, "error");
    } finally {
      unsubscribe();
      setRunning(false);
    }
  }

  const logColors: Record<LogEntry["type"], string> = {
    info: "text-gray-300",
    warn: "text-yellow-400",
    error: "text-red-400",
    success: "text-green-400",
  };

  const phaseLabel: Record<string, string> = {
    scanning: "Scanning...",
    found: "Starting copy...",
    copying: "Copying",
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Import Photos</h2>
      <p className="text-gray-400 text-sm mb-6">
        Copy photos from SD card to local staging directory, renamed by EXIF date.
      </p>

      {settings && (
        <div className="card mb-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Source:</span>
            <span className="text-gray-200 truncate max-w-xs">
              {settings.source_root || <span className="text-red-400">Not set</span>}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Staging:</span>
            <span className="text-gray-200 truncate max-w-xs">
              {settings.staging_dir || <span className="text-red-400">Not set</span>}
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Progress bar — only show during copy phase */}
      {running && progress && progress.phase === "copying" && (
        <div className="card mb-4 space-y-3">
          <ProgressBar
            total={progress.total}
            done={progress.done}
            label={progress.current_file}
            extra={`${progress.done}/${progress.total} files • ${progress.speed_mbps.toFixed(1)} MB/s`}
          />
        </div>
      )}

      {/* Scanning spinner */}
      {running && progress && progress.phase !== "copying" && (
        <div className="card mb-4 flex items-center gap-3 text-sm text-gray-400">
          <span className="animate-spin">⟳</span>
          <span>{phaseLabel[progress.phase] ?? progress.phase}</span>
        </div>
      )}

      {result && !running && (
        <div className="card mb-4">
          <h3 className="text-green-400 font-medium mb-2">✓ Import Complete</h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Imported:</span>
              <span className="text-white">{result.imported} files</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Skipped:</span>
              <span className="text-white">{result.skipped} files</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <button className="btn-primary" onClick={startImport} disabled={running}>
          {running ? "Importing..." : "Start Import"}
        </button>
        {log.length > 0 && !running && (
          <button className="btn-secondary text-xs" onClick={() => setLog([])}>
            Clear Log
          </button>
        )}
      </div>

      {/* Console */}
      {log.length > 0 && (
        <div className="rounded-lg border border-surface-600 bg-black/60 overflow-hidden">
          <div className="px-3 py-2 bg-surface-800 border-b border-surface-600 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Console</span>
            {running && <span className="text-xs text-blue-400 animate-pulse">● Live</span>}
          </div>
          <div className="h-64 overflow-y-auto p-3 space-y-0.5 font-mono text-xs">
            {log.map((entry, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-gray-600 flex-shrink-0">{entry.time}</span>
                <span className={logColors[entry.type]}>{entry.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}