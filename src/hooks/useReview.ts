import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TreeNode, ImageSet } from "../types";
import { useSettings } from "./useSettings";
import { parseStars, isTrashed, applyStars, applyTrash } from "../utils";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "cr3", "dng", "png"]);

function isViewable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

function findSiblings(node: TreeNode, tree: TreeNode[]): TreeNode[] {
  function findParentChildren(nodes: TreeNode[], target: string): TreeNode[] | null {
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

export interface ReviewState {
  tree: TreeNode[];
  selected: TreeNode | null;
  siblings: TreeNode[];
  siblingIdx: number;
  images: ImageSet;
  zoom: number;
  loading: boolean;
  trashed: boolean;
  stars: number;
  stagingDir: string;
}

export interface ReviewActions {
  refreshTree: (dir?: string) => void;
  selectNode: (node: TreeNode) => void;
  handleStars: (val: number) => Promise<void>;
  handleTrash: () => Promise<void>;
  navigate: (dir: 1 | -1) => void;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
}

/**
 * Encapsulates all state and logic for the Review page.
 */
export function useReview(): ReviewState & ReviewActions {
  const { settings } = useSettings();

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

  useEffect(() => {
    if (settings?.staging_dir) {
      setStagingDir(settings.staging_dir);
      refreshTree(settings.staging_dir);
    }
  }, [settings]);

  function refreshTree(dir?: string) {
    const target = dir ?? stagingDir;
    if (!target) return;
    invoke<TreeNode>("list_staging_tree", { stagingDir: target })
      .then((root) => {
        setTree(root?.children ?? []);
      })
      .catch(console.error);
  }

  async function loadImages(node: TreeNode, dir: string) {
    setLoading(true);
    try {
      const stem = node.name.replace(/\.[^.]+$/, "");
      const ext = node.name.split(".").pop()?.toLowerCase() ?? "jpg";
      const parentPath = node.path.includes("/")
        ? node.path.split("/").slice(0, -1).join("\\")
        : "";
      const absParent = dir.replace(/\//g, "\\") + (parentPath ? "\\" + parentPath : "");
      const toAbs = (name: string) => absParent + "\\" + name;

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
    if (node.type === "dir" || !isViewable(node.name)) return;
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
      refreshTree();
      setSelected({ ...selected, name: newName });
      setStars(parseStars(newName));
      setTrashed(isTrashed(newName));
    } catch (e) {
      console.error(e);
    }
  }

  async function handleStars(val: number) {
    if (!selected) return;
    await renameSelected(applyStars(applyTrash(selected.name, trashed), val));
  }

  async function handleTrash() {
    if (!selected) return;
    const newTrashed = !trashed;
    await renameSelected(applyTrash(applyStars(selected.name, stars), newTrashed));
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

  return {
    tree, selected, siblings, siblingIdx, images,
    zoom, loading, trashed, stars, stagingDir,
    refreshTree, selectNode, handleStars, handleTrash, navigate, setZoom,
  };
}
