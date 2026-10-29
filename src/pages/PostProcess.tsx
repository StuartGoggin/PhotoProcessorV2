import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "../components";
import type { ProcessScopeMode, ProcessTask, StabilizationMode, StabilizationStrength, TreeNode } from "../types";
import { useSettings } from "../hooks";
import PhotoProcessPreview from "../components/PhotoProcessPreview";
import RawDevelopment from "../components/RawDevelopment";
import { DEFAULT_BW, type BwParams } from "../types/photoProcess";
import { loadPhotoProcessRecipe, savePhotoProcessRecipe } from "../utils/photoProcessRecipe";
import { useEventNaming } from "../hooks/useEventNaming";
import { eventAbsolutePath, eventPathInRoot, namedEventPath, namingRootKey } from "../utils/eventNamingContext";

interface TaskConfig {
  label: string;
  description: string;
  color: string;
  runTaskId: ProcessTask;
  removeTaskId: ProcessTask;
  removeLabel: string;
  removeDescription: string;
}

interface PostProcessProps {
  onOpenJobs?: () => void;
}

const TASKS: TaskConfig[] = [
  {
    label: "Focus Detection",
    description: "Analyse JPGs for blur using Laplacian variance. Blurry files get {Out of Focus N} appended to filename.",
    color: "text-orange-400",
    runTaskId: "focus",
    removeTaskId: "remove_focus",
    removeLabel: "Remove Focus Flags",
    removeDescription: "Rename files with {Out of Focus N} back to their original filenames when the original name is free.",
  },
  {
    label: "JPG Enhancement",
    description: "CLAHE contrast enhancement + gentle sharpening. Saves as _improved.jpg alongside originals.",
    color: "text-blue-400",
    runTaskId: "enhance",
    removeTaskId: "remove_enhance",
    removeLabel: "Remove Enhancement Outputs",
    removeDescription: "Delete only generated _improved.jpg files inside the selected scope.",
  },
  {
    label: "B&W Conversion",
    description: "Independent conversion from the original, with adjustable local contrast, sharpening and a gentle tonal S-curve. Saves as _BW.jpg with the original's displayed orientation.",
    color: "text-gray-300",
    runTaskId: "bw",
    removeTaskId: "remove_bw",
    removeLabel: "Remove B&W Outputs",
    removeDescription: "Delete only generated _BW.jpg files inside the selected scope.",
  },
  {
    label: "MP4 Stabilisation",
    description: "Two-pass vid.stab stabilization for MP4s with edge-safe auto-zoom to hide black borders. Writes _stabilized.mp4 beside the source, preserves timestamps, reuses the same output name on reruns, and prefers NVIDIA H.264 encode when FFmpeg exposes NVENC.",
    color: "text-cyan-300",
    runTaskId: "stabilize",
    removeTaskId: "remove_stabilize",
    removeLabel: "Remove Stabilised MP4s",
    removeDescription: "Delete only generated _stabilized.mp4 files inside the selected scope.",
  },
];

const SCOPE_MODES: Array<{ id: ProcessScopeMode; label: string; description: string }> = [
  { id: "entireStaging", label: "Entire staging", description: "Ignore selected folder and process the whole staging tree." },
  { id: "folderRecursive", label: "Folder recursively", description: "Process the selected folder and all of its subfolders." },
  { id: "folderOnly", label: "This folder only", description: "Process only files directly inside the selected folder." },
];

const STABILIZATION_MODES: Array<{ id: StabilizationMode; label: string; description: string }> = [
  {
    id: "maxFrame",
    label: "Max Frame",
    description: "Keeps most of the original frame. May show edge artifacts in very shaky clips.",
  },
  {
    id: "edgeSafe",
    label: "Edge-Safe",
    description: "Recommended. Auto-zooms enough to hide most black borders while preserving detail.",
  },
  {
    id: "aggressiveCrop",
    label: "Aggressive Crop",
    description: "Strongest edge removal for highly shaky footage. Crops more of the frame.",
  },
];

const STABILIZATION_STRENGTHS: Array<{ id: StabilizationStrength; label: string; description: string }> = [
  {
    id: "gentle",
    label: "Gentle",
    description: "Light correction with minimal warping. Best for already stable clips.",
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Recommended default. Strong enough for most handheld movement.",
  },
  {
    id: "strong",
    label: "Strong",
    description: "Maximum correction for very shaky footage. Can introduce more crop/warp.",
  },
];

function resolveTaskAction(taskId: ProcessTask): { actionLabel: string; isCleanup: boolean } {
  for (const task of TASKS) {
    if (task.runTaskId === taskId) {
      return { actionLabel: task.label, isCleanup: false };
    }
    if (task.removeTaskId === taskId) {
      return { actionLabel: task.removeLabel, isCleanup: true };
    }
  }
  return { actionLabel: taskId, isCleanup: false };
}

function Adjustment({ label, value, min, max, step = 0.05, onChange, hint }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (value: number) => void; hint: string;
}) {
  return <label className="block min-w-0 space-y-1">
    <span className="flex justify-between gap-2 text-xs text-gray-300"><span>{label}</span><span className="text-cyan-200 tabular-nums">{value.toFixed(2)}</span></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-cyan-400" />
    <span className="block text-xs text-gray-500">{hint}</span>
  </label>;
}

export default function PostProcess({ onOpenJobs }: PostProcessProps) {
  const { settings } = useSettings();
  const [initialRecipe] = useState(loadPhotoProcessRecipe);

  const [queueingTask, setQueueingTask] = useState<ProcessTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastQueuedJobId, setLastQueuedJobId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedScope, setSelectedScope] = useState<string>("");
  const [scopeMode, setScopeMode] = useState<ProcessScopeMode>("entireStaging");
  const [enhanceContrastLevel, setEnhanceContrastLevel] = useState(initialRecipe.enhanceContrastLevel);
  const [enhanceSharpnessLevel, setEnhanceSharpnessLevel] = useState(initialRecipe.enhanceSharpnessLevel);
  const [stabilizationMode, setStabilizationMode] = useState<StabilizationMode>("edgeSafe");
  const [stabilizationStrength, setStabilizationStrength] = useState<StabilizationStrength>("balanced");
  const [preserveSourceBitrate, setPreserveSourceBitrate] = useState(true);
  const [bwParams, setBwParams] = useState<BwParams>(initialRecipe.bwParams);
  const [previewTask, setPreviewTask] = useState<ProcessTask | null>(null);
  const [treeLoading, setTreeLoading] = useState(false), [scopeUnresolved, setScopeUnresolved] = useState(false);
  const [rawRevision, setRawRevision] = useState(0);
  const staging = settings?.staging_dir || "";
  const currentRoot = useRef(staging), treeGeneration = useRef(0), mounted = useRef(true);
  const rawNamingBlock = useRef<string | null>(null);
  const rawNamingStatus = useCallback((reason: string | null) => { rawNamingBlock.current = reason; }, []);
  currentRoot.current = staging;
  const naming = useEventNaming(staging, async result => {
    try {
      const preferred = eventAbsolutePath(result.root, namedEventPath(eventPathInRoot(result.root, selectedScope || result.root), result));
      await loadTree(preferred);
      if (result.changes.length) { setPreviewTask(null); setRawRevision(value => value + 1); }
    } catch (reason) { setScopeUnresolved(true); throw reason; }
  }, () => { if (rawNamingBlock.current) throw Error(rawNamingBlock.current); });
  useEffect(() => { savePhotoProcessRecipe({ bwParams, enhanceContrastLevel, enhanceSharpnessLevel }); }, [bwParams, enhanceContrastLevel, enhanceSharpnessLevel]);

  const canQueue = Boolean(staging) && !scopeUnresolved && !treeLoading && !naming.isOpen;
  const effectiveScope = useMemo(() => {
    if (!settings?.staging_dir) return "";
    if (scopeMode === "entireStaging") return settings.staging_dir;
    return selectedScope || settings.staging_dir;
  }, [scopeMode, selectedScope, settings?.staging_dir]);
  const scopeModeLabel = useMemo(
    () => SCOPE_MODES.find((mode) => mode.id === scopeMode)?.label ?? scopeMode,
    [scopeMode]
  );

  async function loadTree(preferred = staging) {
      const request = ++treeGeneration.current, originalRoot = staging;
      const current = () => mounted.current && request === treeGeneration.current && namingRootKey(originalRoot) === namingRootKey(currentRoot.current);
      if (!staging) {
        setTree([]);
        setSelectedScope("");
        return;
      }
      setTreeLoading(true);
      try {
        const data = await invoke<TreeNode | TreeNode[]>("list_staging_tree", {
          stagingDir: staging,
        });
        if (!current()) return;
        const nodes = Array.isArray(data) ? data : [data];
        setTree(nodes.filter((node) => node.type === "dir"));
        const relative = eventPathInRoot(staging, preferred);
        const hasFolder = (items: TreeNode[]): boolean => items.some(node => node.type === "dir" && (node.path.toLowerCase() === relative.toLowerCase() || hasFolder(node.children ?? [])));
        if (!hasFolder(nodes)) throw Error("The selected scope no longer exists. Choose a folder explicitly before queueing.");
        setSelectedScope(preferred); setScopeUnresolved(false);
      } catch (e) {
        if (current()) { setScopeUnresolved(true); setError(String(e)); }
        throw e;
      } finally {
        if (current()) setTreeLoading(false);
      }
  }
  useEffect(() => {
    mounted.current = true; setSelectedScope(staging); setScopeUnresolved(false); setError(null);
    void loadTree().catch(() => {});
    return () => { mounted.current = false; treeGeneration.current++; };
  }, [staging]);

  async function runTask(taskId: ProcessTask, params?: Record<string, unknown>) {
    if (!canQueue) return;
    if (!settings?.staging_dir) {
      setError("Staging directory not configured in Settings.");
      return;
    }

    const { actionLabel, isCleanup } = resolveTaskAction(taskId);
    if (isCleanup) {
      const confirmed = window.confirm(
        `Queue "${actionLabel}"?\n\nThis cleanup job will run in:\n${effectiveScope}`
      );
      if (!confirmed) return;
    }

    setQueueingTask(taskId);
    setError(null);
    setMessage(null);
    setLastQueuedJobId(null);

    try {
      const jobId = await invoke<string>("start_process_job", {
        stagingDir: settings.staging_dir,
        scopeDir: effectiveScope,
        scopeMode,
        task: taskId,
        ...params,
      });
      setMessage(`Queued ${actionLabel}. Job ID: ${jobId}.`);
      setLastQueuedJobId(jobId);
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingTask(null);
    }
  }

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto min-w-0">
      <h2 className="text-2xl font-semibold text-white mb-2">Photo Process</h2>
      <p className="text-gray-400 text-sm mb-6">
        Preview the effect on an original, then queue the same settings for your selected scope. Photo outputs preserve the original's displayed orientation; originals are never overwritten.
      </p>

      {!staging && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-3 mb-4 text-yellow-200 text-sm">
          Set the staging directory in Settings before queueing post-process jobs.
        </div>
      )}

      {settings?.staging_dir && (
        <div className="card mb-4 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <h3 className="text-white font-medium">Current Queue Target</h3>
            <span className="text-xs px-2 py-1 rounded bg-surface-700 text-gray-200">{scopeModeLabel}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <span className="text-gray-400">Staging: </span>
              <span className="text-gray-200 break-all">{settings.staging_dir}</span>
            </div>
            <div>
              <span className="text-gray-400">Scope: </span>
              <span className="text-gray-200 break-all">{effectiveScope}</span>
            </div>
          </div>
        </div>
      )}

      {settings?.staging_dir && (
        <div className="card mb-6">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <h3 className="text-white font-medium">Processing Scope</h3>
              <p className="text-xs text-gray-400">Select a folder inside staging, then choose whether to process just that folder, recursively, or the full staging tree.</p>
            </div>
            <button
              className="btn-secondary"
              onClick={() => {
                setSelectedScope(settings.staging_dir);
                setScopeMode("entireStaging");
              }}
              disabled={scopeMode === "entireStaging" && selectedScope === settings.staging_dir}
            >
              Use Full Staging
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
            <FileTree
              nodes={tree}
              onFolderMenu={(node, anchor, point) => { if (!queueingTask) naming.openMenu(node.path, anchor, point); }}
              selected={selectedScope.replace(settings.staging_dir, "").replace(/^[\\/]+/, "").replace(/\\/g, "/")}
              onSelect={(node) => {
                if (node.type !== "dir") return;
                const relative = node.path.replace(/^[\\/]+/, "");
                const absolute = relative ? `${settings.staging_dir}\\${relative.replace(/\//g, "\\")}` : settings.staging_dir;
                setSelectedScope(absolute);
                setScopeUnresolved(false); setError(null);
              }}
            />
          </div>
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
            {onOpenJobs && lastQueuedJobId && (
              <button className="btn-secondary px-3 py-1.5 text-sm" onClick={onOpenJobs}>
                Open Jobs
              </button>
            )}
          </div>
        </div>
      )}

      <RawDevelopment stagingDir={scopeUnresolved ? "" : staging} scopeDir={effectiveScope} scopeMode={scopeMode} onOpenJobs={onOpenJobs} onNamingBlockChange={rawNamingStatus} refreshKey={rawRevision} />

      <div className="space-y-4">
        {TASKS.map((task) => {
          const isQueueingRun = queueingTask === task.runTaskId;
          const isQueueingRemove = queueingTask === task.removeTaskId;
          const isEnhanceTask = task.runTaskId === "enhance";
          const isStabilizeTask = task.runTaskId === "stabilize";
          const isBwTask = task.runTaskId === "bw";
          const params = isEnhanceTask
            ? { enhanceContrastLevel, enhanceSharpnessLevel }
            : isStabilizeTask ? { stabilizationMode, stabilizationStrength, preserveSourceBitrate }
            : isBwTask ? { bwParams } : {};
          const previewActive = previewTask === task.runTaskId || previewTask === task.removeTaskId;

          return (
            <section key={task.runTaskId} className="card space-y-4 min-w-0" aria-label={task.label}>
              <div className="space-y-1">
                <h3 className={`font-medium ${task.color}`}>{task.label}</h3>
                <p className="text-sm text-gray-400">{task.description}</p>
              </div>

              {/* Enhancement parameters section */}
              {isEnhanceTask && (
                <div className="bg-blue-950/30 border border-blue-700/50 rounded-lg p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-blue-300">Enhancement Parameters</h4>
                    <button
                      onClick={() => {
                        setEnhanceContrastLevel(1.4);
                        setEnhanceSharpnessLevel(0.75);
                      }}
                      className="text-xs px-2.5 py-1 bg-emerald-900/40 hover:bg-emerald-900/60 border border-emerald-700 text-emerald-200 rounded transition-colors"
                    >
                      Suggested preset
                    </button>
                  </div>
                  <p className="text-xs text-blue-300/70 bg-blue-900/20 rounded px-2 py-1.5">
                    <strong>Suggested preset</strong> applies contrast <strong>1.40</strong> and sharpening <strong>0.75</strong>. Preview your own photo before queueing; stronger adjustments do not suit every image.
                  </p>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-gray-300">Contrast Enhancement</label>
                      <span className="text-xs px-2 py-1 bg-blue-900/50 rounded text-blue-200">
                        {enhanceContrastLevel.toFixed(2)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Enhancement contrast"
                      min="0"
                      max="2.0"
                      step="0.1"
                      value={enhanceContrastLevel}
                      onChange={(e) => setEnhanceContrastLevel(parseFloat(e.target.value))}
                      className="w-full h-2 bg-surface-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                    <p className="text-xs text-gray-500">0 = off, 0.5 = subtle, 1.0 = standard, 1.4 = suggested preset, 2.0 = aggressive</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-gray-300">Sharpening Strength</label>
                      <span className="text-xs px-2 py-1 bg-blue-900/50 rounded text-blue-200">
                        {enhanceSharpnessLevel.toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Enhancement sharpening"
                      min="0.0"
                      max="1.0"
                      step="0.1"
                      value={enhanceSharpnessLevel}
                      onChange={(e) => setEnhanceSharpnessLevel(parseFloat(e.target.value))}
                      className="w-full h-2 bg-surface-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                    <p className="text-xs text-gray-500">0.0 = none, 0.3 = light, 0.5 = default, 0.75 = suggested preset, 1.0 = strong</p>
                  </div>
                </div>
              )}

              {isBwTask && <div className="rounded-lg border border-surface-600 bg-surface-900/60 p-3 space-y-3">
                <div className="flex justify-between items-center gap-2 flex-wrap">
                  <h4 className="text-sm font-medium text-gray-100">B&W adjustments</h4>
                  <button type="button" className="btn-secondary text-xs" onClick={() => setBwParams({ ...DEFAULT_BW })}>Reset B&W defaults</button>
                </div>
                <p className="text-xs text-gray-400">Always starts from the original—not Enhanced. Zero turns an adjustment off. S-curve controls gently deepen shadows and lift highlights without reversing tonal order.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <Adjustment label="B&W local contrast" value={bwParams.localContrast} min={0} max={1} onChange={(value) => setBwParams((current) => ({ ...current, localContrast: value }))} hint="0 = off · 1 = standard local detail" />
                  <Adjustment label="B&W sharpening" value={bwParams.sharpness} min={0} max={1} onChange={(value) => setBwParams((current) => ({ ...current, sharpness: value }))} hint="0 = off · 1 = strong; judge at 100%" />
                  <Adjustment label="S-curve strength" value={bwParams.curveStrength} min={0} max={1} onChange={(value) => setBwParams((current) => ({ ...current, curveStrength: value }))} hint="0 = off · gentle default preserves event detail" />
                  <Adjustment label="S-curve shadow depth" value={bwParams.shadowDepth} min={0} max={0.25} step={0.01} onChange={(value) => setBwParams((current) => ({ ...current, shadowDepth: value }))} hint="Darken the lower tones; keep shadow texture" />
                  <Adjustment label="S-curve highlight lift" value={bwParams.highlightLift} min={0} max={0.25} step={0.01} onChange={(value) => setBwParams((current) => ({ ...current, highlightLift: value }))} hint="Brighten the upper tones; watch fine highlights" />
                  <Adjustment label="S-curve midpoint" value={bwParams.midpoint} min={0.25} max={0.75} step={0.01} onChange={(value) => setBwParams((current) => ({ ...current, midpoint: value }))} hint="0.50 = balanced · tonal pivot, not an on/off amount" />
                </div>
              </div>}

              {isStabilizeTask && (
                <div className="bg-cyan-950/30 border border-cyan-700/50 rounded-lg p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h4 className="text-sm font-medium text-cyan-300">Stabilization Controls</h4>
                    <span className="text-xs px-2 py-1 rounded bg-cyan-900/40 border border-cyan-700 text-cyan-200">
                      Recommended: Edge-Safe + Balanced
                    </span>
                  </div>

                  <div>
                    <div className="text-xs uppercase tracking-wide text-cyan-200/80 mb-2">Cropping / Framing Mode</div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      {STABILIZATION_MODES.map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => setStabilizationMode(mode.id)}
                          className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                            stabilizationMode === mode.id
                              ? "border-cyan-500 bg-cyan-900/30 text-white"
                              : "border-surface-600 bg-surface-900/60 text-gray-300 hover:bg-surface-800"
                          }`}
                        >
                          <div className="text-sm font-medium">{mode.label}</div>
                          <div className="text-xs text-gray-400 mt-1">{mode.description}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs uppercase tracking-wide text-cyan-200/80 mb-2">Stabilization Strength</div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      {STABILIZATION_STRENGTHS.map((strength) => (
                        <button
                          key={strength.id}
                          type="button"
                          onClick={() => setStabilizationStrength(strength.id)}
                          className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                            stabilizationStrength === strength.id
                              ? "border-teal-500 bg-teal-900/30 text-white"
                              : "border-surface-600 bg-surface-900/60 text-gray-300 hover:bg-surface-800"
                          }`}
                        >
                          <div className="text-sm font-medium">{strength.label}</div>
                          <div className="text-xs text-gray-400 mt-1">{strength.description}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-start gap-3 rounded-lg border border-surface-600 bg-surface-900/60 px-3 py-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={preserveSourceBitrate}
                      onChange={(e) => setPreserveSourceBitrate(e.target.checked)}
                    />
                    <span className="text-xs text-gray-300">
                      <span className="font-medium text-cyan-200">Preserve source bitrate</span>
                      <br />
                      Keep output bitrate close to the source clip when available. Turn off to prioritize encoder quality settings.
                    </span>
                  </label>

                  <p className="text-xs text-cyan-200/80 bg-cyan-900/20 rounded px-2 py-1.5">
                    Selected mode: <strong>{STABILIZATION_MODES.find((mode) => mode.id === stabilizationMode)?.label}</strong>
                    {" • "}
                    Strength: <strong>{STABILIZATION_STRENGTHS.find((strength) => strength.id === stabilizationStrength)?.label}</strong>
                    {" • "}
                    Bitrate policy: <strong>{preserveSourceBitrate ? "Preserve source" : "Encoder quality"}</strong>
                  </p>
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                <button type="button" className="btn-secondary text-xs" disabled={!canQueue} aria-expanded={previewTask === task.runTaskId} onClick={() => setPreviewTask(previewTask === task.runTaskId ? null : task.runTaskId)}>Preview {task.label}</button>
                <button type="button" className="btn-secondary text-xs" disabled={!canQueue} aria-expanded={previewTask === task.removeTaskId} onClick={() => setPreviewTask(previewTask === task.removeTaskId ? null : task.removeTaskId)}>Preview cleanup files</button>
              </div>
              {previewActive && settings?.staging_dir && <PhotoProcessPreview key={`${previewTask}-${effectiveScope}-${scopeMode}`} request={{ stagingDir: settings.staging_dir, scopeDir: effectiveScope, scopeMode, task: previewTask!, ...params }} />}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-lg border border-surface-600 bg-surface-900/60 px-3 py-3 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400">Run Task</div>
                    <p className="text-xs text-gray-500 mt-1 break-all">Apply these settings to every eligible original in: {effectiveScope || "Set staging in Settings"} · {scopeModeLabel}</p>
                  </div>
                  <button
                    className="btn-primary w-full md:w-auto"
                    onClick={() => void runTask(task.runTaskId, params)}
                    disabled={queueingTask !== null || !canQueue}
                  >
                    {isQueueingRun ? "Queueing..." : "Queue Job"}
                  </button>
                </div>
                <div className="rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-3 space-y-3">
                  <div>
                    <div className="text-sm font-medium text-red-300">{task.removeLabel}</div>
                    <p className="text-xs text-gray-400 mt-1">{task.removeDescription}</p>
                  </div>
                  <button
                    className="btn-danger w-full md:w-auto"
                    onClick={() => runTask(task.removeTaskId)}
                    disabled={queueingTask !== null || !canQueue}
                  >
                    {isQueueingRemove ? "Queueing..." : "Queue Cleanup Job"}
                  </button>
                </div>
              </div>
            </section>
          );
        })}
      </div>
      {naming.layer}
    </div>
  );
}
