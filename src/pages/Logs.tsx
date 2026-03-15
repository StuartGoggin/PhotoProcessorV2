import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LogFileResponse {
  path: string;
  contents: string;
}

export default function Logs() {
  const [logPath, setLogPath] = useState("");
  const [contents, setContents] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(true);

  async function loadLogs() {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<LogFileResponse>("read_log_file");
      setLogPath(res.path);
      setContents(res.contents);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function clearLogs() {
    setLoading(true);
    setError(null);
    try {
      await invoke("clear_log_file");
      await loadLogs();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
  }, []);

  useEffect(() => {
    if (!tail) return;
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [tail]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Logs</h2>
      <p className="text-gray-400 text-sm mb-4">
        Detailed operation log written by the backend.
      </p>

      <div className="card mb-4 space-y-3">
        <div className="text-xs text-gray-400 break-all">
          <span className="text-gray-500">Log file:</span> {logPath || "(not created yet)"}
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <button className="btn-secondary" onClick={loadLogs} disabled={loading}>
            Refresh
          </button>
          <button className="btn-secondary" onClick={clearLogs} disabled={loading}>
            Clear Log
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-300 ml-2">
            <input type="checkbox" className="h-4 w-4" checked={tail} onChange={(e) => setTail(e.target.checked)} />
            Tail (auto-refresh)
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <pre className="m-0 p-4 text-xs text-gray-200 max-h-[70vh] overflow-auto whitespace-pre-wrap">
          {loading ? "Loading..." : contents || "(Log is empty)"}
        </pre>
      </div>
    </div>
  );
}
