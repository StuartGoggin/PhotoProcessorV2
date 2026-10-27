import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TreeNode, ImageSet } from "../types";
import { useSettings } from "./useSettings";
import { parseStars, isTrashed, applyStars, applyTrash } from "../utils";
import { lightboxCatalogue, lightboxAbsolute, neighborPaths, photoFolder, photoPaths, photoForSource, type LightboxPhoto, type OriginalSource } from "../utils/lightboxCatalogue";
import { LightboxCache, type LightboxImage, type LightboxImageInfo } from "../utils/lightboxCache";

const emptyImages = (): ImageSet => ({ original: null, improved: null, bw: null });
export interface ReviewContext { root: string; path: string; epoch: number; cropped: boolean }

/** The view and writes share a pinned selection identity. Failed writes never
 * advance; stale reads and writes cannot replace a newer root or selection. */
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
  const [originalSource, setOriginalSourceState] = useState<OriginalSource>("raw");
  const [originalInfo, setOriginalInfo] = useState<LightboxImageInfo | null>(null);
  const sourceChoice = useRef<OriginalSource>("raw");
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const showingCrop = useRef(false);
  const root = useRef("");
  const configuredRoot = useRef(settings?.staging_dir ?? "");
  configuredRoot.current = settings?.staging_dir ?? "";
  const catalogue = useRef(lightboxCatalogue([]));
  const rawTree = useRef<TreeNode | null>(null);
  const folderLoads = useRef(new Map<string, Promise<boolean>>());
  const folderReady = useRef(new Set<string>());
  const pickRequest = useRef(0);
  const metadataSelection = useRef(false);
  const selectedPath = useRef<string | null>(null);
  const intendedPath = useRef<string | null>(null);
  const selectionRequest = useRef(0);
  const treeRequest = useRef(0);
  const renameBusy = useRef(false);
  const viewReady = useRef(false);
  const mounted = useRef(true);
  const cache = useRef<LightboxCache>();
  if (!cache.current) cache.current = new LightboxCache(path => invoke<LightboxImage>("read_lightbox_image", { path }));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; viewReady.current = false;
      ++selectionRequest.current; ++treeRequest.current; cache.current!.clear();
    };
  }, []);

  function getSnapshot() {
    const path = selectedPath.current;
    const photo = path ? catalogue.current.photos.get(path) : undefined;
    if (!mounted.current || !path || !photo || !root.current || root.current !== configuredRoot.current) return null;
    return { context: { root: root.current, path, epoch: selectionRequest.current, cropped: showingCrop.current } as ReviewContext, photo: photoForSource(photo, sourceChoice.current) };
  }
  function isContextCurrent(context: ReviewContext) {
    return mounted.current && context.root === root.current && context.root === configuredRoot.current
      && context.path === selectedPath.current && context.epoch === selectionRequest.current && context.cropped === showingCrop.current;
  }
  function isReady() { return !!getSnapshot() && viewReady.current && !renameBusy.current; }

  async function loadFolder(folder: string, reconcile = true): Promise<boolean> {
    const originalRoot=root.current, epoch=treeRequest.current;
    if (!mounted.current || !rawTree.current || originalRoot!==configuredRoot.current) return false;
    if (folderReady.current.has(folder)) return true;
    const find=(node:TreeNode):TreeNode|undefined=>node.path===folder?node:node.children?.map(find).find(Boolean);
    const target=find(rawTree.current);
    if (!target?.children?.some(node=>node.captureMetadataPending)) { folderReady.current.add(folder); return true; }
    const prior=folderLoads.current.get(folder);if(prior)return prior;
    const pending=(async()=>{
      try {
        const result=await invoke<TreeNode>("read_lightbox_folder",{stagingDir:originalRoot,relativeDir:folder});
        if(!mounted.current||epoch!==treeRequest.current||originalRoot!==root.current||originalRoot!==configuredRoot.current)return false;
        if(result?.type!=="dir"||result.path!==folder||!Array.isArray(result.children))throw new Error("Invalid folder metadata response");
        const merge=(node:TreeNode):TreeNode=>{
          if(node.path===folder){const oldDirs=new Map((node.children??[]).filter(n=>n.type==="dir").map(n=>[n.path,n]));return {...node,...result,children:result.children!.map(n=>n.type==="dir"?oldDirs.get(n.path)??n:n)};}
          return node.type==="dir"?{...node,children:node.children?.map(merge)}:node;
        };
        const before = getSnapshot();
        rawTree.current=merge(rawTree.current!);catalogue.current=lightboxCatalogue(rawTree.current.children??[]);
        setTree(catalogue.current.tree);setCatalogueRevision(value=>value+1);
        if(result.captureMetadataComplete!==false)folderReady.current.add(folder);
        else setError("Some capture metadata could not be read. Originals remain separate; refresh this folder to retry.");
        if (before && !metadataSelection.current && photoFolder(before.context.path) === folder) {
          const pairedOwner = [...catalogue.current.photos.values()].find(photo => photo.cameraJpeg?.path === before.context.path);
          const next = catalogue.current.photos.get(before.context.path) ?? pairedOwner;
          // Pairing can retire a formerly standalone JPEG from navigation.
          // Revoke its old image identity before any action can use the new one.
          ++selectionRequest.current; viewReady.current = false; setImages(emptyImages());
          if (reconcile && next) await show(next, 1, before.context.cropped, pairedOwner ? "cameraJpeg" : sourceChoice.current);
          else if (reconcile) {
            selectedPath.current = null; intendedPath.current = null;
            setSelected(null); setSelectedPhoto(null); setSiblings([]); setLoading(false);
          }
        }
        return true;
      } catch(reason){if(mounted.current&&epoch===treeRequest.current&&originalRoot===configuredRoot.current)setError("Could not inspect this folder: "+String(reason));return false;}
      finally{if(epoch===treeRequest.current)folderLoads.current.delete(folder);}
    })();
    folderLoads.current.set(folder,pending);return pending;
  }

  async function show(photo: LightboxPhoto, direction: 1 | -1 = 1, useCrop = false, source: OriginalSource = sourceChoice.current): Promise<boolean> {
    if (!mounted.current || root.current !== configuredRoot.current) return false;
    ++pickRequest.current;metadataSelection.current=false;
    photo = catalogue.current.photos.get(photo.node.path) ?? photo;
    const request = ++selectionRequest.current, originalRoot = root.current;
    const group = catalogue.current.folders.get(photoFolder(photo.node.path)) ?? [];
    const index = group.findIndex(item => item.node.path === photo.node.path);
    const display = photoForSource(photo, source);
    const activeCrop = useCrop && !!display.crop, version = activeCrop ? display.crop! : display;
    cache.current!.select(photoPaths(display, activeCrop).map(path => lightboxAbsolute(originalRoot, path)));
    selectedPath.current = photo.node.path; viewReady.current = false;
    intendedPath.current=photo.node.path;
    sourceChoice.current = source;
    setOriginalSourceState(source === "cameraJpeg" && photo.cameraJpeg ? "cameraJpeg" : "raw");
    showingCrop.current = activeCrop; setCropped(activeCrop); setSelectedPhoto(display); setOriginalInfo(null);
    setSelected(photo.node); setSiblings(group.map(item => item.node)); setSiblingIdx(Math.max(0, index));
    setZoom(1); setLoading(true); setError(""); setImages(emptyImages());
    const load = (node?: TreeNode) => node ? cache.current!.get(lightboxAbsolute(originalRoot, node.path)) : Promise.resolve(null);
    const [original, bw, improved] = await Promise.all([load(version.original), load(version.bw), load(version.improved)]);
    if (!mounted.current || request !== selectionRequest.current || originalRoot !== root.current || originalRoot !== configuredRoot.current) return false;
    viewReady.current = !!(original || bw || improved);
    setOriginalInfo(original ? cache.current!.info(lightboxAbsolute(originalRoot, version.original.path)) : null);
    setImages({ original, bw, improved }); setLoading(false);
    if (!original) setError(/\.(cr3|dng)$/i.test(photo.node.name)
      ? "The RAW camera preview is unavailable. Its available developed versions are shown; try Photo Process → RAW Development for a full-quality decode."
      : "Could not display this original. It may be missing, unreadable or exceed the Lightbox safety limits. Refresh to retry.");
    cache.current!.prefetch(neighborPaths(group, index, direction).map(path => lightboxAbsolute(originalRoot, path)));
    return viewReady.current;
  }

  async function refreshTree(dir?: string, preferCrop?: boolean, preferPath?: string | null, keepCache = false): Promise<boolean> {
    const target = dir ?? root.current;
    if (!target || !mounted.current || target !== configuredRoot.current) return false;
    let request = ++treeRequest.current; ++selectionRequest.current; viewReady.current = false;
    if (!keepCache) cache.current!.clear();
    setLoading(true); setImages(emptyImages()); setError("");
    try {
      const result = await invoke<TreeNode>("list_staging_tree", { stagingDir: target });
      if (!mounted.current || request !== treeRequest.current || target !== root.current || target !== configuredRoot.current) return false;
      // A newer pick may have become visible while directory IO was pending.
      // Replacing its catalogue must revoke that exact displayed identity.
      request=++treeRequest.current;++selectionRequest.current;viewReady.current=false;
      const replacementPick=++pickRequest.current;metadataSelection.current=false;setLoading(true);setImages(emptyImages());
      rawTree.current=result;folderLoads.current.clear();folderReady.current.clear();
      catalogue.current = lightboxCatalogue(result?.children ?? []);
      setCatalogueRevision(value => value + 1); setTree(catalogue.current.tree);
      // Ordinary refresh follows a newer dial selection made during its scan.
      // Save-and-next supplies an explicit target that remains pinned.
      const targetPath = preferPath === undefined ? intendedPath.current??selectedPath.current : preferPath;
      if(targetPath) {
        if(!await loadFolder(photoFolder(targetPath), false)) {
          if (mounted.current && request === treeRequest.current && target === configuredRoot.current && replacementPick === pickRequest.current) setLoading(false);
          return false;
        }
        if(!mounted.current||request!==treeRequest.current||target!==configuredRoot.current)return false;
        if(replacementPick!==pickRequest.current)return false;
      }
      const companion=targetPath?[...catalogue.current.photos.values()].find(p=>p.cameraJpeg?.path===targetPath):undefined;
      const preferred = targetPath ? catalogue.current.photos.get(targetPath)??companion : undefined;
      const fallback = selectedPath.current ? catalogue.current.photos.get(selectedPath.current) : undefined;
      if (preferred || fallback) return await show((preferred ?? fallback)!, 1, preferCrop ?? showingCrop.current,companion?"cameraJpeg":sourceChoice.current);
      selectedPath.current = null; setSelected(null); setSelectedPhoto(null); setSiblings([]); setSiblingIdx(0); setLoading(false);
      void loadFolder("");
      return false;
    } catch (reason) {
      if (mounted.current && request === treeRequest.current && target === configuredRoot.current) {
        setError("Could not refresh the Lightbox: " + String(reason)); setLoading(false);
      }
      return false;
    }
  }

  useEffect(() => {
    root.current = settings?.staging_dir ?? "";
    setStagingDir(root.current); setCatalogueRevision(0);
    selectedPath.current = null;intendedPath.current=null; viewReady.current = false; showingCrop.current = false; sourceChoice.current = "raw";
    setOriginalSourceState("raw"); setOriginalInfo(null);
    setSelected(null); setSelectedPhoto(null); setSiblings([]); setSiblingIdx(0); setCropped(false);
    ++selectionRequest.current; ++treeRequest.current; cache.current!.clear(); setImages(emptyImages()); setError("");
    ++pickRequest.current;rawTree.current=null;folderLoads.current.clear();folderReady.current.clear();
    metadataSelection.current=false;
    if (root.current) void refreshTree(root.current);
    else { setTree([]); setLoading(false); catalogue.current = lightboxCatalogue([]); }
  }, [settings?.staging_dir]);

  async function selectNode(node: TreeNode) {
    if (renameBusy.current) return false;
    const pick=++pickRequest.current, originalRoot=root.current;
    intendedPath.current=node.path;
    metadataSelection.current=true;viewReady.current=false;++selectionRequest.current;setLoading(true);setImages(emptyImages());
    const loaded=await loadFolder(photoFolder(node.path), false);
    if(pick!==pickRequest.current||originalRoot!==configuredRoot.current)return false;
    metadataSelection.current=false;
    if(!loaded){setLoading(false);return false;}
    const photo = catalogue.current.photos.get(node.path);
    if(photo)return show(photo);
    const owner=[...catalogue.current.photos.values()].find(p=>p.cameraJpeg?.path===node.path);
    if (owner) return show(owner,1,false,"cameraJpeg");
    setLoading(false);setSelected(null);setSelectedPhoto(null);selectedPath.current=null;
    return false;
  }
  async function setCropVersion(useCrop: boolean) {
    if (renameBusy.current) return false;
    const snapshot = getSnapshot();
    return snapshot ? show(snapshot.photo, 1, useCrop) : false;
  }
  async function setOriginalSource(source: OriginalSource) {
    if (renameBusy.current) return false;
    const snapshot = getSnapshot();
    if (!snapshot || (source === "cameraJpeg" && !snapshot.photo.cameraJpeg)) return false;
    return show(snapshot.photo, 1, false, source);
  }
  async function navigate(direction: 1 | -1) {
    if (renameBusy.current || metadataSelection.current) return false;
    const snapshot = getSnapshot();
    if (!snapshot) return false;
    const group = catalogue.current.folders.get(photoFolder(snapshot.context.path)) ?? [];
    const index = group.findIndex(photo => photo.node.path === snapshot.context.path);
    return index >= 0 && group[index + direction] ? show(group[index + direction], direction) : false;
  }
  async function navigateToEdge(edge: "first" | "last") {
    if (renameBusy.current || metadataSelection.current) return false;
    const snapshot = getSnapshot();
    if (!snapshot) return false;
    const group = catalogue.current.folders.get(photoFolder(snapshot.context.path)) ?? [];
    const photo = edge === "first" ? group[0] : group[group.length - 1];
    return photo ? show(photo, edge === "first" ? -1 : 1) : false;
  }
  async function advanceFromContext(context: ReviewContext) {
    if (!isContextCurrent(context)) return false;
    const group = catalogue.current.folders.get(photoFolder(context.path)) ?? [];
    const index = group.findIndex(photo => photo.node.path === context.path);
    return index >= 0 && group[index + 1] ? show(group[index + 1]) : true;
  }

  async function renameSelected(newName: string, advance = false): Promise<boolean> {
    const snapshot = getSnapshot();
    if (!snapshot || !isReady()) return false;
    const { context, photo } = snapshot;
    const group = catalogue.current.folders.get(photoFolder(context.path)) ?? [];
    const index = group.findIndex(item => item.node.path === context.path);
    const nextPath = advance && index >= 0 ? group[index + 1]?.node.path : undefined;
    renameBusy.current = true; setRenaming(true);
    try {
      if (newName === photo.node.name) return nextPath ? await show(catalogue.current.photos.get(nextPath)!) : true;
      await invoke("rename_file", { oldPath: lightboxAbsolute(context.root, context.path), newName });
      if (!isContextCurrent(context)) return false;
      const folder = photoFolder(context.path);
      const renamedPath = folder ? folder + "/" + newName : newName;
      selectedPath.current = renamedPath;
      setSelected({ ...photo.node, name: newName, path: renamedPath });
      // Keep bounded, already-decoded neighbours warm for controller review.
      // An explicit Refresh still invalidates all cached images.
      return await refreshTree(context.root, !nextPath && context.cropped, nextPath ?? renamedPath, true);
    } catch (reason) {
      if (mounted.current && context.root === configuredRoot.current) setError("Could not save this photo decision: " + String(reason));
      return false;
    } finally {
      renameBusy.current = false;
      if (mounted.current) setRenaming(false);
    }
  }
  async function handleStars(value: number, advance = false) {
    const snapshot = getSnapshot();
    return snapshot ? renameSelected(applyStars(snapshot.photo.node.name, value), advance) : false;
  }
  async function handleTrash(desired?: boolean, advance = false) {
    const snapshot = getSnapshot();
    return snapshot ? renameSelected(applyTrash(snapshot.photo.node.name, desired ?? !isTrashed(snapshot.photo.node.name)), advance) : false;
  }

  return {
    tree, selected, siblings, siblingIdx, images, zoom, loading, error, renaming, stagingDir,
    cropped, selectedPhoto, catalogueRevision, originalSource, originalInfo,
    trashed: selected ? isTrashed(selected.name) : false,
    stars: selected ? parseStars(selected.name) : 0,
    refreshTree, selectNode, loadFolder, handleStars, handleTrash, navigate, navigateToEdge, setZoom, setCropVersion, setOriginalSource,
    getSnapshot, isContextCurrent, isReady, advanceFromContext,
  };
}
