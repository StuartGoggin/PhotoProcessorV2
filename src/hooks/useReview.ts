import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TreeNode, ImageSet } from "../types";
import { useSettings } from "./useSettings";
import { parseStars, isTrashed, applyStars, applyTrash } from "../utils";

import { lightboxCatalogue, lightboxAbsolute, neighborPaths, photoFolder, photoPaths, type LightboxPhoto } from "../utils/lightboxCatalogue";
import { LightboxCache, type LightboxImage } from "../utils/lightboxCache";

const emptyImages = (): ImageSet => ({ original: null, improved: null, bw: null });

/** One originals catalogue and one disposable cache; independent request tokens
 * prevent stale IO from replacing a selection or repopulating refreshed data. */
export function useReview() {
  const { settings } = useSettings();

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [siblings, setSiblings] = useState<TreeNode[]>([]);
  const [siblingIdx, setSiblingIdx] = useState(0);
  const [images, setImages] = useState<ImageSet>(emptyImages);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [stagingDir, setStagingDir] = useState("");
  const [cropped, setCropped] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  const showingCrop = useRef(false);
  const root = useRef("");
  const catalogue = useRef(lightboxCatalogue([]));
  const selectedPath = useRef<string | null>(null);
  const selectionRequest = useRef(0);
  const treeRequest = useRef(0);
  const renameBusy = useRef(false);
  const mounted = useRef(true);
  const cache = useRef<LightboxCache>();
  if (!cache.current) cache.current = new LightboxCache(path => invoke<LightboxImage>("read_lightbox_image", { path }));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++selectionRequest.current; ++treeRequest.current; cache.current!.clear();
    };
  }, []);

  function show(photo: LightboxPhoto, direction: 1 | -1 = 1, useCrop = false) {
    if (!mounted.current) return;
    const request = ++selectionRequest.current;
    const group = catalogue.current.folders.get(photoFolder(photo.node.path)) ?? [];
    const index = group.findIndex(item => item.node.path === photo.node.path);
    const activeCrop = useCrop && !!photo.crop;
    const version = activeCrop ? photo.crop! : photo;
    const paths = photoPaths(photo, activeCrop).map(path => lightboxAbsolute(root.current, path));
    cache.current!.select(paths);
    selectedPath.current = photo.node.path;
    showingCrop.current = activeCrop; setCropped(activeCrop); setSelectedPhoto(photo);
    setSelected(photo.node); setSiblings(group.map(item => item.node)); setSiblingIdx(Math.max(0, index));
    setZoom(1); setLoading(true); setError(""); setImages(emptyImages());
    const load = (node?: TreeNode) => node ? cache.current!.get(lightboxAbsolute(root.current, node.path)) : Promise.resolve(null);
    void Promise.all([load(version.original), load(version.bw), load(version.improved)]).then(([original, bw, improved]) => {
      if (request !== selectionRequest.current) return;
      setImages({ original, bw, improved }); setLoading(false);
      if (!original) setError(/\.(cr3|dng)$/i.test(photo.node.name)
        ? "RAW display is not supported in this Lightbox. Its available JPEG comparison versions are shown."
        : "Could not display this original. It may be missing, unreadable or exceed the Lightbox safety limits. Refresh to retry.");
      cache.current!.prefetch(neighborPaths(group, index, direction).map(path => lightboxAbsolute(root.current, path)));
    });
  }

  function refreshTree(dir?: string, preferCrop = showingCrop.current) {
    const target = dir ?? root.current;
    if (!target || !mounted.current) return;
    const request = ++treeRequest.current;
    ++selectionRequest.current;
    cache.current!.clear(); setLoading(false); setImages(emptyImages()); setError("");
    void invoke<TreeNode>("list_staging_tree", { stagingDir: target }).then(result => {
      if (request !== treeRequest.current) return;
      catalogue.current = lightboxCatalogue(result?.children ?? []);
      setTree(catalogue.current.tree);
      const photo = selectedPath.current ? catalogue.current.photos.get(selectedPath.current) : undefined;
      if (photo) show(photo, 1, preferCrop);
      else { selectedPath.current = null; setSelected(null); setSelectedPhoto(null); setSiblings([]); setSiblingIdx(0); }
    }).catch(reason => {
      if (request !== treeRequest.current) return;
      setError(`Could not refresh the Lightbox: ${String(reason)}`);
    });
  }

  useEffect(() => {
    if (!settings?.staging_dir) return;
    root.current = settings.staging_dir;
    setStagingDir(root.current); selectedPath.current = null;
    refreshTree(root.current);
  }, [settings?.staging_dir]);

  function selectNode(node: TreeNode) {
    const photo = catalogue.current.photos.get(node.path);
    if (photo) show(photo);
  }

  function setCropVersion(useCrop: boolean) {
    const photo = selectedPath.current ? catalogue.current.photos.get(selectedPath.current) : undefined;
    if (photo) show(photo, 1, useCrop);
  }

  function navigate(direction: 1 | -1) {
    const path = selectedPath.current;
    if (!path) return;
    const group = catalogue.current.folders.get(photoFolder(path)) ?? [];
    const index = group.findIndex(photo => photo.node.path === path);
    const next = group[index + direction];
    if (index >= 0 && next) show(next, direction);
  }

  async function renameSelected(newName: string) {
    const path = selectedPath.current;
    const photo = path ? catalogue.current.photos.get(path) : undefined;
    if (!photo || renameBusy.current || newName === photo.node.name) return;
    renameBusy.current = true; setRenaming(true);
    const originalRoot = root.current;
    try {
      await invoke("rename_file", { oldPath: lightboxAbsolute(originalRoot, photo.node.path), newName });
      if (!mounted.current || root.current !== originalRoot) return;
      if (selectedPath.current === photo.node.path) {
        const folder = photoFolder(photo.node.path);
        selectedPath.current = folder ? `${folder}/${newName}` : newName;
        setSelected({ ...photo.node, name: newName, path: selectedPath.current });
      }
      refreshTree();
    } catch (reason) { if (mounted.current) setError(`Could not rename this photo: ${String(reason)}`); }
    finally { renameBusy.current = false; if (mounted.current) setRenaming(false); }
  }

  async function handleStars(val: number) {
    const node = selectedPath.current ? catalogue.current.photos.get(selectedPath.current)?.node : null;
    if (node) await renameSelected(applyStars(node.name, val));
  }

  async function handleTrash() {
    const node = selectedPath.current ? catalogue.current.photos.get(selectedPath.current)?.node : null;
    if (node) await renameSelected(applyTrash(node.name, !isTrashed(node.name)));
  }

  return {
    tree, selected, siblings, siblingIdx, images,
    zoom, loading, error, renaming, stagingDir, cropped, selectedPhoto,
    trashed: selected ? isTrashed(selected.name) : false,
    stars: selected ? parseStars(selected.name) : 0,
    refreshTree, selectNode, handleStars, handleTrash, navigate, setZoom, setCropVersion,
  };
}
