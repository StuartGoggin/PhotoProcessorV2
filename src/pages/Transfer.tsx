import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings, TransferProgress, TransferResult } from "../types";
import ProgressBar from "../components/ProgressBar";

export default function Transfer() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<TransferResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    invoke<Settings>("load_settings").then(setSettings).catch(console.error);
    return () => unlistenRef.current?.();
  }, []);

  async function startTransfer() {
    if (!settings?.staging_dir || !settings?.archive_dir) {
      setError("Staging and Archive directories must be configured in Settings.");
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    setProgress(null);

    const unlisten = await listen<TransferProgress>("transfer-progress", (e) => {
      setProgress(e.payload);
    });
    unlistenRef.current = unlisten;

    try {
      const res = await invoke<TransferResult>("start_transfer", {
        stagingDir: settings.staging_dir,
        archiveDir: settings.archive_dir,
      });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      unlistenRef.current = null;
      setRunning(false);
    }
  }

  async function verifyChecksums() {
    if (!settings?.archive_dir) {
      setError("Archive directory not configured.");
      return;
    }
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    setProgress(null);

    const unlisten = await listen<TransferProgress>("transfer-progress", (e) => {
      setProgress(e.payload);
    });
    unlistenRef.current = unlisten;

    try {
      const res = await invoke<TransferResult>("verify_checksums", {
        archiveDir: settings.archive_dir,
      });
      setVerifyResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      unlistenRef.current = null;
      setVerifying(false);
    }
  }

  const phaseLabel: Record<string, string> = {
    copy: "Copying files",
    md5: "Generating checksums",
    verify: "Verifying checksums",
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Transfer to Archive</h2>
      <p className="text-gray-400 text-sm mb-6">
        Copy staging directory to archive (NAS), then generate and verify MD5 checksums.
      </p>

      {settings && (
        <div className="card mb-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Staging:</span>
            <span className="text-gray-200 truncate max-w-xs">{settings.staging_dir || <span className="text-red-400">Not set</span>}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Archive:</span>
            <span className="text-gray-200 truncate max-w-xs">{settings.archive_dir || <span className="text-red-400">Not set</span>}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {(running || verifying) && progress && (
        <div className="card mb-6 space-y-2">
          <p className="text-xs text-gray-400 font-medium">
            {phaseLabel[progress.phase] ?? progress.phase}
          </p>
          <ProgressBar
            total={progress.total}
            done={progress.done}
            label={progress.current_file}
            extra={
              progress.speed_mbps > 0
                ? `${progress.done}/${progress.total} • ${progress.speed_mbps.toFixed(1)} MB/s`
                : `${progress.done}/${progress.total}`
            }
          />
        </div>
      )}

      {result && (
        <div className="card mb-6">
          <h3 className="text-green-400 font-medium mb-2">✓ Transfer Complete</h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Copied:</span>
              <span className="text-white">{result.copied} files</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Checksums generated:</span>
              <span className="text-white">{result.verified} files</span>
            </div>
            {result.errors.length > 0 && (
              <div className="mt-2 max-h-28 overflow-y-auto">
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs text-red-300">{e}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {verifyResult && (
        <div className="card mb-6">
          {verifyResult.errors.length === 0 ? (
            <h3 className="text-green-400 font-medium">
              ✓ All {verifyResult.verified} checksums verified OK
            </h3>
          ) : (
            <>
              <h3 className="text-red-400 font-medium mb-2">
                ✗ {verifyResult.errors.length} checksum failures
              </h3>
              <div className="max-h-32 overflow-y-auto">
                {verifyResult.errors.map((e, i) => (
                  <p key={i} className="text-xs text-red-300">{e}</p>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex gap-3">
        <button
          className="btn-primary"
          onClick={startTransfer}
          disabled={running || verifying}
        >
          {running ? "Transferring..." : "Start Transfer"}
        </button>
        <button
          className="btn-secondary"
          onClick={verifyChecksums}
          disabled={running || verifying}
        >
          {verifying ? "Verifying..." : "Verify Checksums"}
        </button>
      </div>
    </div>
  );
}
