import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "../components";
import type { FaceDatabase, PersonIdentity, ProcessScopeMode, TreeNode, VideoMatch } from "../types";
import { useSettings } from "../hooks";

interface FaceIdentifyProps {
  onOpenJobs?: () => void;
}

interface FaceScanEnvironmentCheck {
  ready: boolean;
  pythonCommand?: string | null;
  scriptPath?: string | null;
  details: string[];
  error?: string | null;
}

const SCOPE_MODES: Array<{ id: ProcessScopeMode; label: string; description: string }> = [
  { id: "entireStaging", label: "Entire source tree", description: "Ignore selected folder and process the whole source tree." },
  { id: "folderRecursive", label: "Folder recursively", description: "Process the selected folder and all of its subfolders." },
  { id: "folderOnly", label: "This folder only", description: "Process only files directly inside the selected folder." },
];

export default function FaceIdentify({ onOpenJobs }: FaceIdentifyProps) {
  const { settings } = useSettings();
  
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeHint, setTreeHint] = useState<string | null>(null);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedScope, setSelectedScope] = useState<string>("");
  const [scopeMode, setScopeMode] = useState<ProcessScopeMode>("entireStaging");
  
  // Scan parameters
  const [framesPerSecond, setFramesPerSecond] = useState(1);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.6);
  
  // People list
  const [people, setPeople] = useState<PersonIdentity[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<PersonIdentity | null>(null);
  const [searchResults, setSearchResults] = useState<VideoMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  
  const scopeRoot = settings?.staging_dir || settings?.archive_dir || "";
  const canScan = Boolean(scopeRoot);
  const effectiveScope = useMemo(() => {
    if (!scopeRoot) return "";
    if (scopeMode === "entireStaging") return scopeRoot;
    return selectedScope || scopeRoot;
  }, [scopeRoot, scopeMode, selectedScope]);
  const scopeModeLabel = useMemo(
    () => SCOPE_MODES.find((mode) => mode.id === scopeMode)?.label ?? scopeMode,
    [scopeMode]
  );

  useEffect(() => {
    void loadPeopleList();
  }, [scopeRoot]);

  useEffect(() => {
    async function loadTree() {
      if (!scopeRoot) {
        setTree([]);
        setSelectedScope("");
        setTreeHint(null);
        return;
      }

      try {
        setTreeLoading(true);
        setTreeHint(null);
        const data = await invoke<TreeNode | TreeNode[]>("list_staging_tree", {
          stagingDir: scopeRoot,
        });
        const nodes = Array.isArray(data) ? data : [data];
        setTree(nodes);
        setSelectedScope(scopeRoot);
        if (nodes.length === 0) {
          const looksLikeMappedDrive = /^[A-Za-z]:\\/.test(scopeRoot);
          setTreeHint(
            looksLikeMappedDrive
              ? "Source path is not reachable from the app process. If this is a mapped network drive, use its UNC path (\\\\server\\share\\folder) in Settings."
              : "Source path is empty or not reachable from the app process."
          );
        }
      } catch (e) {
        setError(`Failed to load source folders: ${String(e)}`);
      } finally {
        setTreeLoading(false);
      }
    }

    void loadTree();
  }, [scopeRoot]);

  async function loadPeopleList() {
    if (!scopeRoot) return;

    try {
      setLoading(true);
      // In production, would call a Tauri command to load people from database
      // For now, fetch from local database file that gets created during scan
      const dbPath = `${scopeRoot}\\.faces_db.json`;
      try {
        const contents = await invoke<string>("read_text_file", { path: dbPath });
        const db: FaceDatabase = JSON.parse(contents);
        const peopleList = db.faces
          .reduce((acc, face) => {
            const existing = acc.find(p => p.personId === face.personId);
            if (!existing) {
              acc.push({
                personId: face.personId,
                personName: face.personName,
                distinctEmbeddings: 1,
                videoCount: 1,
                lastSeen: face.timestampMs.toString(),
              });
            } else {
              existing.distinctEmbeddings += 1;
              existing.videoCount = Math.max(existing.videoCount, 1);
            }
            return acc;
          }, [] as PersonIdentity[]);
        setPeople(peopleList);
      } catch {
        // Database doesn't exist yet or Tauri command not available
        setPeople([]);
      }
    } catch (e) {
      setError(`Failed to load people list: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function startScan() {
    if (!scopeRoot) {
      setError("Source directory not configured in Settings.");
      return;
    }

    try {
      const env = await invoke<FaceScanEnvironmentCheck>("check_face_scan_environment");
      if (!env.ready) {
        const detailText = env.details.length > 0 ? `\n${env.details.join("\n")}` : "";
        setError(`Face scan environment not ready. ${env.error ?? "Unknown setup error."}${detailText}`);
        return;
      }
    } catch (e) {
      setError(`Failed to validate face scan environment: ${String(e)}`);
      return;
    }

    const confirmed = window.confirm(
      `Scan for faces in selected source tree?\n\nSettings:\n• Frames per second: ${framesPerSecond}\n• Similarity threshold: ${similarityThreshold.toFixed(2)}\n\nThis may take a while if you have many videos.`
    );
    if (!confirmed) return;

    setIsScanning(true);
    setError(null);
    setMessage(null);

    try {
      const jobId = await invoke<string>("start_process_job", {
        stagingDir: scopeRoot,
        scopeDir: effectiveScope,
        scopeMode,
        task: "scan_faces",
        framesPerSecond,
        similarityThreshold,
      });
      setMessage(`Queued face scanning job ${jobId}. If it finishes quickly, open Jobs and switch filter to All or Finished.`);
    } catch (e) {
      setError(`Failed to start scan: ${String(e)}`);
    } finally {
      setIsScanning(false);
    }
  }

  async function searchPerson(person: PersonIdentity) {
    if (!scopeRoot) {
      setError("Source directory not configured.");
      return;
    }

    setSearchLoading(true);
    setError(null);

    try {
      const jobId = await invoke<string>("start_process_job", {
        stagingDir: scopeRoot,
        scopeDir: effectiveScope,
        scopeMode,
        task: "search_person_videos",
        personName: person.personName,
      });
      setMessage(`Queued search for '${person.personName}' (${jobId}). If it finishes quickly, open Jobs and switch filter to All or Finished.`);
      setSelectedPerson(person);
      setSearchResults([]);
    } catch (e) {
      setError(`Failed to search: ${String(e)}`);
    } finally {
      setSearchLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Face Recognition</h2>
      <p className="text-gray-400 text-sm mb-6">
        Scan your selected source tree to build a face database, then identify videos containing specific people.
      </p>

      {!canScan && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-3 mb-4 text-yellow-200 text-sm">
          Set the source directory in Settings before scanning for faces.
        </div>
      )}

      {scopeRoot && (
        <div className="card mb-4 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <h3 className="text-white font-medium">Current Queue Target</h3>
            <span className="text-xs px-2 py-1 rounded bg-surface-700 text-gray-200">{scopeModeLabel}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <span className="text-gray-400">Source: </span>
              <span className="text-gray-200 break-all">{scopeRoot}</span>
            </div>
            <div>
              <span className="text-gray-400">Scope: </span>
              <span className="text-gray-200 break-all">{effectiveScope}</span>
            </div>
          </div>
        </div>
      )}

      {scopeRoot && (
        <div className="card mb-6">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <h3 className="text-white font-medium">Recognition Scope</h3>
              <p className="text-xs text-gray-400">Select a folder inside the source tree, then choose whether to process just that folder, recursively, or the full source tree.</p>
            </div>
            <button
              className="btn-secondary"
              onClick={() => {
                setSelectedScope(scopeRoot);
                setScopeMode("entireStaging");
              }}
              disabled={scopeMode === "entireStaging" && selectedScope === scopeRoot}
            >
              Use Full Source
            </button>
          </div>
          <div className="text-xs text-gray-400 mb-3">
            Selected target: <span className="text-gray-200 break-all">{effectiveScope}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
            {SCOPE_MODES.map((mode) => (
              <button
                key={mode.id}
                className={`text-left rounded-lg border px-3 py-2 transition-colors ${scopeMode === mode.id ? "border-accent bg-accent/10 text-white" : "border-surface-600 bg-surface-800 text-gray-300 hover:bg-surface-700"}`}
                onClick={() => setScopeMode(mode.id)}
              >
                <div className="text-sm font-medium">{mode.label}</div>
                <div className="text-xs text-gray-400 mt-1">{mode.description}</div>
              </button>
            ))}
          </div>
          <div className="h-64 rounded-lg border border-surface-600 bg-surface-900/60 overflow-hidden">
            {treeLoading ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-400">Loading archive tree...</div>
            ) : tree.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-500 px-4 text-center">
                No folders found in source path: {scopeRoot}
              </div>
            ) : (
              <FileTree
                nodes={tree}
                selected={selectedScope.replace(scopeRoot, "").replace(/^[\\/]+/, "")}
                onSelect={(node) => {
                  if (node.type !== "dir") return;
                  const relative = node.path.replace(/^[\\/]+/, "");
                  const absolute = relative ? `${scopeRoot}\\${relative.replace(/\//g, "\\")}` : scopeRoot;
                  setSelectedScope(absolute);
                }}
              />
            )}
          </div>
          {treeHint && (
            <div className="mt-2 text-xs text-amber-300">{treeHint}</div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {message && (
        <div className="bg-green-900/40 border border-green-700 rounded-lg px-4 py-3 mb-4 text-green-300 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{message}</span>
            {onOpenJobs && (
              <button className="btn-secondary px-3 py-1.5 text-sm" onClick={onOpenJobs}>
                Open Jobs
              </button>
            )}
          </div>
        </div>
      )}

      {/* Scan Library Section */}
      <div className="card mb-6 space-y-4">
        <div className="space-y-1">
          <h3 className="font-medium text-cyan-300">Scan Library for Faces</h3>
          <p className="text-sm text-gray-400">
            Analyze the selected source tree to detect and catalog faces. This creates a database that can be searched later.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-surface-900/60 rounded-lg border border-surface-600 p-4">
          {/* Frames Per Second */}
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-400 mb-2">
              Frames Per Second
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="30"
                value={framesPerSecond}
                onChange={(e) => setFramesPerSecond(parseInt(e.target.value))}
                className="flex-1"
                disabled={isScanning}
              />
              <span className="text-sm font-medium text-white min-w-12">{framesPerSecond} fps</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              1 = sample 1 frame/sec (fast), 30 = every frame (thorough)
            </p>
          </div>

          {/* Similarity Threshold */}
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-400 mb-2">
              Similarity Threshold
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0.3"
                max="1.0"
                step="0.05"
                value={similarityThreshold}
                onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                className="flex-1"
                disabled={isScanning}
              />
              <span className="text-sm font-medium text-white min-w-12">{similarityThreshold.toFixed(2)}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Higher = stricter matching (fewer false positives), Lower = more matches
            </p>
          </div>
        </div>

        <button
          className="btn-primary w-full"
          onClick={startScan}
          disabled={isScanning || !canScan}
        >
          {isScanning ? "Scanning..." : "Start Face Scan"}
        </button>
        <p className="text-xs text-gray-500">
          Note: this scans video files only. Jobs can complete quickly; in Jobs page switch filter to All or Finished to see completed scans.
        </p>
      </div>

      {/* People List & Search Section */}
      <div className="card space-y-4">
        <div className="space-y-1">
          <h3 className="font-medium text-emerald-300">Identified People</h3>
          <p className="text-sm text-gray-400">
            {people.length === 0
              ? "No faces found yet. Run a scan first."
              : `Found ${people.length} unique person/people in your videos.`}
          </p>
        </div>

        {people.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-500 text-sm">
              Scan your library to discover and catalog faces.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto">
            {people.map((person) => (
              <button
                key={person.personId}
                onClick={() => void searchPerson(person)}
                className={`text-left rounded-lg border p-4 transition-colors ${
                  selectedPerson?.personId === person.personId
                    ? "border-emerald-500 bg-emerald-900/30 text-white"
                    : "border-surface-600 bg-surface-900/60 text-gray-300 hover:bg-surface-800"
                }`}
                disabled={searchLoading}
              >
                <div className="font-medium text-sm">{person.personName}</div>
                <div className="text-xs text-gray-400 mt-2 space-y-1">
                  <div>📹 {person.videoCount} video{person.videoCount !== 1 ? "s" : ""}</div>
                  <div>🔍 {person.distinctEmbeddings} appearance{person.distinctEmbeddings !== 1 ? "s" : ""}</div>
                  <div>⏱️ {person.lastSeen}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {selectedPerson && (
          <div className="mt-6 pt-6 border-t border-surface-600 space-y-4">
            <div className="space-y-1">
              <h4 className="font-medium text-white">
                Videos with "{selectedPerson.personName}"
              </h4>
              <p className="text-xs text-gray-400">
                {searchResults.length === 0
                  ? "Run a search or wait for active job to complete..."
                  : `Found in ${searchResults.length} video${searchResults.length !== 1 ? "s" : ""}`}
              </p>
            </div>

            {searchResults.length > 0 && (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {searchResults.map((match) => (
                  <div
                    key={match.videoPath}
                    className="rounded-lg border border-surface-600 bg-surface-900/60 p-3"
                  >
                    <div className="font-mono text-xs text-emerald-300 truncate">
                      {match.relativePath}
                    </div>
                    <div className="text-xs text-gray-400 mt-1 flex gap-4 flex-wrap">
                      <span>📊 {match.matchCount} matches</span>
                      <span>⏱️ First: {(match.firstMatch / 1000).toFixed(1)}s</span>
                      <span>Last: {(match.lastMatch / 1000).toFixed(1)}s</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
