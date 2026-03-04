import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings, TreeNode } from "../types";
import FileTree from "../components/FileTree";
import ImagePanel from "../components/ImagePanel";
import StarRating, {
  applyStars,
  applyTrash,
  isTrashed,
  parseStars,
} from "../components/StarRating";

interface ImageSet {
  original: string | null;
  improved: string | null;
  bw: string | null;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "cr3", "dng", "png"]);

function isViewable(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

function findSiblings(node: TreeNode, tree: TreeNode[]): TreeNode[] {
  // Flat list of all file nodes in same directory as node
  function findParentChildren(
    nodes: TreeNode[],
    target: string
  ): TreeNode[] | null {
    for (const n of nodes) {
      if (n.type === "dir" && n.children) {
        const found = n.children.find((c) => c.path === target);
        if (found) return n.children.filter((c) => c.type === "file" && isViewable(c.name));
        const deeper = findParentChildren(n.children, target);
        if (deeper) return deeper;
      }
    }
    return null;
  }
  return findParentChildren(tree, node.path) ?? [];
}

export default function Review() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [siblings, setSiblings] = useState<TreeNode[]>([]);
  const [siblingIdx, setSiblingIdx] = useState(0);
  const [images, setImages] = useState<ImageSet>({ original: null, improved: null, bw: null });
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [trashed, setTrashed] = useState(false);
  const [stars, setStars] = useState(0);
  const [stagingDir, setStagingDir] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<Settings>("load_settings").then((s) => {
      setSettings(s);
      if (s.staging_dir) {
        setStagingDir(s.staging_dir);
        refreshTree(s.staging_dir);
      }
    });
  }, []);

  function refreshTree(dir: string) {
    invoke<TreeNode>("list_staging_tree", { stagingDir: dir })
      .then((root) => {
        if (root && root.children) setTree(root.children);
        else setTree([]);
      })
      .catch(console.error);
  }

  async function loadImages(node: TreeNode, dir: string) {
    setLoading(true);
    try {
      // Determine companion files
      const stem = node.name.replace(/\.[^.]+$/, "");
      const ext = node.name.split(".").pop()?.toLowerCase() ?? "jpg";
      const parentDir = node.path.includes("/")
        ? node.path.split("/").slice(0, -1).join("/")
        : "";
      const absParent = dir + (parentDir ? "/" + parentDir : "");
      const absParent2 = absParent.replace(/\//g, "\\");

      const toAbs = (name: string) => absParent2 + "\\" + name;

      const [originalData, improvedData, bwData] = await Promise.allSettled([
        invoke<string>("read_image_base64", { path: toAbs(node.name) }),
        invoke<string>("read_image_base64", { path: toAbs(`${stem}_improved.${ext}`) }),
        invoke<string>("read_image_base64", { path: toAbs(`${stem}_BW.${ext}`) }),
      ]);

      const toDataUrl = (r: PromiseSettledResult<string>) =>
        r.status === "fulfilled" ? `data:image/jpeg;base64,${r.value}` : null;

      setImages({
        original: toDataUrl(originalData),
        improved: toDataUrl(improvedData),
        bw: toDataUrl(bwData),
      });
      setStars(parseStars(node.name));
      setTrashed(isTrashed(node.name));
    } finally {
      setLoading(false);
    }
  }

  function selectNode(node: TreeNode) {
    if (node.type === "dir") return;
    if (!isViewable(node.name)) return;

    const sibs = findSiblings(node, tree);
    const idx = sibs.findIndex((s) => s.path === node.path);
    setSiblings(sibs);
    setSiblingIdx(idx >= 0 ? idx : 0);
    setSelected(node);
    setZoom(1);
    loadImages(node, stagingDir);
  }

  async function renameSelected(newName: string) {
    if (!selected) return;
    const dir = stagingDir.replace(/\//g, "\\");
    const parentPath = selected.path.includes("/")
      ? selected.path.split("/").slice(0, -1).join("\\")
      : "";
    const absOld = dir + (parentPath ? "\\" + parentPath : "") + "\\" + selected.name;

    try {
      await invoke("rename_file", { oldPath: absOld, newName });
      // Update tree
      refreshTree(stagingDir);
      // Update selected
      const newNode = { ...selected, name: newName };
      setSelected(newNode);
      setStars(parseStars(newName));
      setTrashed(isTrashed(newName));
    } catch (e) {
      console.error(e);
    }
  }

  async function handleStars(val: number) {
    if (!selected) return;
    const newName = applyStars(applyTrash(selected.name, trashed), val);
    await renameSelected(newName);
  }

  async function handleTrash() {
    if (!selected) return;
    const newTrashed = !trashed;
    const newName = applyTrash(applyStars(selected.name, stars), newTrashed);
    await renameSelected(newName);
  }

  const navigate = useCallback(
    (dir: 1 | -1) => {
      if (siblings.length === 0) return;
      const newIdx = Math.max(0, Math.min(siblings.length - 1, siblingIdx + dir));
      if (newIdx === siblingIdx) return;
      setSiblingIdx(newIdx);
      const node = siblings[newIdx];
      setSelected(node);
      setZoom(1);
      loadImages(node, stagingDir);
    },
    [siblings, siblingIdx, stagingDir]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") navigate(1);
      else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(5, z + 0.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.25, z - 0.25));
      else if (e.key === "0") setZoom(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // Separate handler for keys that depend on selected/stars/trashed state
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Delete") handleTrash();
      else if (e.key === "1") handleStars(1);
      else if (e.key === "2") handleStars(2);
      else if (e.key === "3") handleStars(3);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // intentionally no deps - runs after every render to capture latest handlers

  return (
    <div className="flex h-full" ref={containerRef}>
      {/* Left panel: file tree */}
      <div className="w-56 flex-shrink-0 bg-surface-800 border-r border-surface-600 flex flex-col">
        <div className="px-3 py-2 border-b border-surface-600 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300">Files</span>
          <button
            className="text-xs text-gray-500 hover:text-gray-300"
            onClick={() => stagingDir && refreshTree(stagingDir)}
          >
            ↺
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileTree
            nodes={tree}
            onSelect={selectNode}
            selected={selected?.path}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex-shrink-0 bg-surface-800 border-b border-surface-600 px-4 py-2 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary py-1 px-2 text-xs"
              onClick={() => navigate(-1)}
              disabled={siblingIdx <= 0}
            >
              ←
            </button>
            <span className="text-xs text-gray-400">
              {siblings.length > 0 ? `${siblingIdx + 1} / ${siblings.length}` : "—"}
            </span>
            <button
              className="btn-secondary py-1 px-2 text-xs"
              onClick={() => navigate(1)}
              disabled={siblingIdx >= siblings.length - 1}
            >
              →
            </button>
          </div>

          <div className="flex items-center gap-2 ml-2">
            <button className="btn-secondary py-1 px-2 text-xs" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
            <span className="text-xs text-gray-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button className="btn-secondary py-1 px-2 text-xs" onClick={() => setZoom((z) => Math.min(5, z + 0.25))}>+</button>
            <button className="btn-secondary py-1 px-2 text-xs" onClick={() => setZoom(1)}>1:1</button>
          </div>

          {selected && (
            <>
              <div className="ml-2">
                <StarRating value={stars} onChange={handleStars} />
              </div>
              <button
                className={`py-1 px-3 text-xs rounded-lg font-medium transition-colors ${
                  trashed
                    ? "bg-red-700 text-white hover:bg-red-600"
                    : "btn-secondary"
                }`}
                onClick={handleTrash}
              >
                {trashed ? "✗ Trashed" : "🗑 Trash"}
              </button>
            </>
          )}

          {selected && (
            <span className="ml-auto text-xs text-gray-500 truncate max-w-xs">
              {selected.name}
            </span>
          )}
        </div>

        {/* 3-panel image display */}
        <div className="flex-1 flex min-h-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Loading...
            </div>
          ) : (
            <>
              <div className="flex-1 border-r border-surface-700 min-w-0">
                <ImagePanel
                  src={images.original}
                  label="Original"
                  zoom={zoom}
                />
              </div>
              <div className="flex-1 border-r border-surface-700 min-w-0">
                <ImagePanel
                  src={images.bw}
                  label="B&W"
                  zoom={zoom}
                />
              </div>
              <div className="flex-1 min-w-0">
                <ImagePanel
                  src={images.improved}
                  label="Enhanced"
                  zoom={zoom}
                />
              </div>
            </>
          )}
        </div>

        {/* Status bar */}
        <div className="flex-shrink-0 bg-surface-800 border-t border-surface-600 px-4 py-1.5 flex items-center gap-6 text-xs text-gray-500">
          <span>← → navigate</span>
          <span>+ − zoom</span>
          <span>0 reset zoom</span>
          <span>Del trash</span>
          <span>1/2/3 stars</span>
        </div>
      </div>
    </div>
  );
}
