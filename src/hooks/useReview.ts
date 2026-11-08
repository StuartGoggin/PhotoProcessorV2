import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TreeNode, ImageSet } from "../types";
import { useSettings } from "./useSettings";
import { parseStars, isTrashed, applyStars, applyTrash } from "../utils";
import { lightboxCatalogue, lightboxAbsolute, neighborPaths, photoFolder, photoPaths, photoForSource, type LightboxPhoto, type OriginalSource } from "../utils/lightboxCatalogue";
import { LightboxCache, type LightboxImage, type LightboxImageInfo } from "../utils/lightboxCache";
import { LightboxFolderQueue } from "../utils/lightboxFolderQueue";

const emptyImages = (): ImageSet => ({ original: null, improved: null, bw: null });
type ImageKind = keyof ImageSet;
const folderInspections = new LightboxFolderQueue();
let inspectionOwnerSequence = 0;
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
  const [imageLoading, setImageLoading] = useState({ original: false, bw: false, improved: false });
  const [imageErrors, setImageErrors] = useState({ original: false, bw: false, improved: false });
  const [inspection, setInspection] = useState<{ folder: string; phase: "checking" | "incomplete" | "error"; files: number } | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [stagingDir, setStagingDir] = useState("");
  const [cropped, setCropped] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<LightboxPhoto | null>(null);
  const [originalSource, setOriginalSourceState] = useState<OriginalSource>("raw");
  const [originalInfo, setOriginalInfo] = useState<LightboxImageInfo | null>(null);
  // null means JPEG-first when a verified camera pair is available. Keep the
  // preference separate from the actual displayed source for exact-file checks.
  const sourceChoice = useRef<OriginalSource | null>(null);
  const displayedSource = useRef<OriginalSource>("raw");
  const physicalOriginal = useRef<string | null>(null);
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const showingCrop = useRef(false);
  const root = useRef("");
  const configuredRoot = useRef(settings?.staging_dir ?? "");
  configuredRoot.current = settings?.staging_dir ?? "";
  const catalogue = useRef(lightboxCatalogue([]));
  const rawTree = useRef<TreeNode | null>(null);
  const folderLoads = useRef(new Map<string, Promise<boolean>>());
  const folderReady = useRef(new Set<string>());
  const folderQueue = useRef(folderInspections);
  const inspectionOwner = useRef(0);
  if (!inspectionOwner.current) inspectionOwner.current = ++inspectionOwnerSequence;
  const originalPending = useRef(false);
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
      ++selectionRequest.current; ++treeRequest.current; cache.current!.clear(); folderQueue.current.clear(inspectionOwner.current+":");
    };
  }, []);

  function getSnapshot() {
    const path = selectedPath.current;
    const photo = path ? catalogue.current.photos.get(path) : undefined;
    if (!mounted.current || !path || !photo || !root.current || root.current !== configuredRoot.current) return null;
    return { context: { root: root.current, path, epoch: selectionRequest.current, cropped: showingCrop.current } as ReviewContext, photo: photoForSource(photo, displayedSource.current) };
  }
  function isContextCurrent(context: ReviewContext) {
    return mounted.current && context.root === root.current && context.root === configuredRoot.current
      && context.path === selectedPath.current && context.epoch === selectionRequest.current && context.cropped === showingCrop.current;
  }
  function isIdentityReady() {
    const snapshot = getSnapshot();
    return !!snapshot && !metadataSelection.current && !snapshot.photo.node.captureMetadataPending && !snapshot.photo.original.captureMetadataPending
      && !snapshot.photo.node.rawWarning && !snapshot.photo.original.rawWarning;
  }
  function isDisplayReady() { return !!getSnapshot() && viewReady.current && !renameBusy.current; }
  function isReady() { return isDisplayReady() && isIdentityReady() && !originalPending.current; }

  async function loadFolder(folder: string, reconcile = true, foreground = false): Promise<boolean> {
    const originalRoot=root.current, epoch=treeRequest.current;
    if (!mounted.current || !rawTree.current || originalRoot!==configuredRoot.current) return false;
    if (folderReady.current.has(folder)) return true;
    const find=(node:TreeNode):TreeNode|undefined=>node.path===folder?node:node.children?.map(find).find(Boolean);
    const target=find(rawTree.current);
    if (!target?.children?.some(node=>node.captureMetadataPending)) { folderReady.current.add(folder); return true; }
    const key=inspectionOwner.current+":"+JSON.stringify([originalRoot,epoch,folder]);
    const files = target.children?.filter(node => node.type === "file").length ?? 0;
    const markChecking=()=>{if(foreground || !selectedPath.current || photoFolder(selectedPath.current)===folder)setInspection({folder,phase:"checking",files});};
    const prior=folderLoads.current.get(folder);if(prior){if(foreground){folderQueue.current.promote(key);markChecking();}return prior;}
    markChecking();
    const pending=folderQueue.current.run(key,async()=>{
      try {
        if(!mounted.current||epoch!==treeRequest.current||originalRoot!==root.current||originalRoot!==configuredRoot.current)return false;
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
        if(result.captureMetadataComplete!==false) {
          folderReady.current.add(folder);
          setInspection(current => current?.folder === folder ? null : current);
        } else setInspection(current => current?.folder === folder ? { folder, phase: "incomplete", files } : current);
        if (before && photoFolder(before.context.path) === folder) {
          const pairedOwner = [...catalogue.current.photos.values()].find(photo => photo.cameraJpeg?.path === before.context.path);
          const next = catalogue.current.photos.get(before.context.path) ?? pairedOwner;
          // Pairing can retire a formerly standalone JPEG from navigation.
          // Revoke its old image identity before any action can use the new one.
          ++selectionRequest.current; viewReady.current = false; setImages(emptyImages()); setImageErrors({original:false,bw:false,improved:false});
          if (reconcile && next) await show(next, 1, before.context.cropped, pairedOwner ? "cameraJpeg" : sourceChoice.current);
          else if (reconcile) {
            selectedPath.current = null; intendedPath.current = null;
            setSelected(null); setSelectedPhoto(null); setSiblings([]); setLoading(false);
          }
        }
        return true;
      } catch(reason){if(mounted.current&&epoch===treeRequest.current&&originalRoot===configuredRoot.current){setInspection(current=>current?.folder===folder?{folder,phase:"error",files}:current);if(photoFolder(selectedPath.current??"")===folder)setError("Could not inspect this folder: "+String(reason));}return false;}
    },foreground).finally(()=>{if(folderLoads.current.get(folder)===pending)folderLoads.current.delete(folder);});
    folderLoads.current.set(folder,pending);return pending;
  }

  function acceptImage(kind: ImageKind, node: TreeNode | undefined, image: string | null, originalRoot: string) {
    setImageLoading(value => ({ ...value, [kind]: false }));
    setImageErrors(value => ({ ...value, [kind]: !!node && !image }));
    setImages(value => ({ ...value, [kind]: image }));
    if (kind === "original") {
      originalPending.current = false;
      setOriginalInfo(image && node ? cache.current!.info(lightboxAbsolute(originalRoot, node.path)) : null);
      setError(image ? "" : node && /\.(cr3|dng)$/i.test(node.name)
        ? "The RAW camera preview is unavailable. Its available developed versions are shown; try Photo Process → RAW Development for a full-quality decode."
        : "Could not display this original. It may be missing, unreadable or exceed the Lightbox safety limits. Retry its image or refresh.");
    }
    if (image) { viewReady.current = true; setLoading(false); }
  }

  async function retryImage(kind: ImageKind) {
    const snapshot = getSnapshot();
    if (!snapshot || renameBusy.current) return false;
    const version = snapshot.context.cropped && snapshot.photo.crop ? snapshot.photo.crop : snapshot.photo;
    const node = version[kind];
    if (!node) return false;
    const absolute = lightboxAbsolute(snapshot.context.root, node.path);
    cache.current!.invalidate(absolute);
    setImages(value => ({ ...value, [kind]: null }));
    setImageErrors(value => ({ ...value, [kind]: false }));
    setImageLoading(value => ({ ...value, [kind]: true }));
    viewReady.current = Object.entries(images).some(([other, value]) => other !== kind && !!value);
    if (kind === "original") originalPending.current = true;
    const image = await cache.current!.get(absolute);
    if (!isContextCurrent(snapshot.context)) return false;
    acceptImage(kind, node, image, snapshot.context.root);
    return !!image;
  }

  function imageFailed(context: ReviewContext | undefined, kind: ImageKind) {
    if (!context || !isContextCurrent(context)) return;
    const snapshot = getSnapshot();
    if (!snapshot) return;
    const version = context.cropped && snapshot.photo.crop ? snapshot.photo.crop : snapshot.photo;
    const node = version[kind];
    if (!node) return;
    cache.current!.invalidate(lightboxAbsolute(context.root, node.path));
    viewReady.current = Object.entries(images).some(([other, value]) => other !== kind && !!value);
    acceptImage(kind, node, null, context.root);
  }

  async function show(photo: LightboxPhoto, direction: 1 | -1 = 1, useCrop = false, choice: OriginalSource | null = sourceChoice.current): Promise<boolean> {
    if (!mounted.current || root.current !== configuredRoot.current) return false;
    ++pickRequest.current;metadataSelection.current=false;
    photo = catalogue.current.photos.get(photo.node.path) ?? photo;
    const request = ++selectionRequest.current, originalRoot = root.current;
    const group = catalogue.current.folders.get(photoFolder(photo.node.path)) ?? [];
    const index = group.findIndex(item => item.node.path === photo.node.path);
    const source = choice ?? (photo.cameraJpeg ? "cameraJpeg" : "raw");
    const display = photoForSource(photo, source);
    const activeCrop = useCrop && !!display.crop, version = activeCrop ? display.crop! : display;
    cache.current!.select(photoPaths(display, activeCrop).map(path => lightboxAbsolute(originalRoot, path)));
    selectedPath.current = photo.node.path; viewReady.current = false;
    intendedPath.current=photo.node.path;
    sourceChoice.current = choice;
    displayedSource.current = source === "cameraJpeg" && photo.cameraJpeg ? "cameraJpeg" : "raw";
    physicalOriginal.current = display.original.path;
    setOriginalSourceState(displayedSource.current);
    showingCrop.current = activeCrop; setCropped(activeCrop); setSelectedPhoto(display); setOriginalInfo(null);
    setSelected(photo.node); setSiblings(group.map(item => item.node)); setSiblingIdx(Math.max(0, index));
    setZoom(1); setLoading(true); setError(""); setImages(emptyImages());
    setImageErrors({ original: false, bw: false, improved: false });
    originalPending.current=true;
    const load = (node?: TreeNode) => node ? cache.current!.get(lightboxAbsolute(originalRoot, node.path)) : Promise.resolve(null);
    setImageLoading({ original: true, bw: !!version.bw, improved: !!version.improved });
    let resolveFirst!: (value: boolean) => void;
    const first = new Promise<boolean>(resolve => { resolveFirst = resolve; });
    const current = () => mounted.current && request === selectionRequest.current && selectedPath.current === photo.node.path
      && originalRoot === root.current && originalRoot === configuredRoot.current;
    const panels = (["original", "bw", "improved"] as const).map(async kind => {
      const image = await load(version[kind]);
      if (!current()) { resolveFirst(false); return; }
      acceptImage(kind, version[kind], image, originalRoot);
      if (image) resolveFirst(true);
    });
    void Promise.all(panels).then(() => {
      if (!current()) { resolveFirst(false); return; }
      setLoading(false); resolveFirst(viewReady.current);
      if (isIdentityReady()) cache.current!.prefetch(neighborPaths(group, index, direction).map(path => lightboxAbsolute(originalRoot, path)));
    });
    return first;
  }

  async function refreshTree(dir?: string, preferCrop?: boolean, preferPath?: string | null, keepCache = false): Promise<boolean> {
    const target = dir ?? root.current;
    if (!target || !mounted.current || target !== configuredRoot.current) return false;
    let request = ++treeRequest.current; ++selectionRequest.current; viewReady.current = false;
    if (!keepCache) cache.current!.clear();
    setLoading(true); setImages(emptyImages()); setImageErrors({original:false,bw:false,improved:false}); setError("");
    try {
      const result = await invoke<TreeNode>("list_staging_tree", { stagingDir: target });
      if (!mounted.current || request !== treeRequest.current || target !== root.current || target !== configuredRoot.current) return false;
      // A newer pick may have become visible while directory IO was pending.
      // Replacing its catalogue must revoke that exact displayed identity.
      request=++treeRequest.current;++selectionRequest.current;viewReady.current=false;
      const replacementPick=++pickRequest.current;metadataSelection.current=false;setLoading(true);setImages(emptyImages());setImageErrors({original:false,bw:false,improved:false});
      rawTree.current=result;folderLoads.current.clear();folderReady.current.clear();folderQueue.current.clear(inspectionOwner.current+":");setInspection(null);
      catalogue.current = lightboxCatalogue(result?.children ?? []);
      setCatalogueRevision(value => value + 1); setTree(catalogue.current.tree);
      // Ordinary refresh follows a newer dial selection made during its scan.
      // Save-and-next supplies an explicit target that remains pinned.
      const targetPath = preferPath === undefined ? intendedPath.current??selectedPath.current : preferPath;
      if(!mounted.current||request!==treeRequest.current||target!==configuredRoot.current||replacementPick!==pickRequest.current)return false;
      const basename=(path:string)=>path.replace(/\\/g,"/").split("/").pop();
      const preserveCameraJpeg=targetPath && displayedSource.current==="cameraJpeg" && physicalOriginal.current
        && (targetPath===selectedPath.current || basename(targetPath)===basename(selectedPath.current??""));
      const physicalPath=preserveCameraJpeg ? [photoFolder(targetPath!),basename(physicalOriginal.current!)].filter(Boolean).join("/") : targetPath;
      const companion=physicalPath?[...catalogue.current.photos.values()].find(p=>p.cameraJpeg?.path===physicalPath):undefined;
      if(preserveCameraJpeg && physicalPath && !catalogue.current.photos.has(physicalPath) && !companion) {
        selectedPath.current=null;intendedPath.current=null;physicalOriginal.current=null;sourceChoice.current=null;displayedSource.current="raw";
        setSelected(null);setSelectedPhoto(null);setSiblings([]);setLoading(false);
        setError("The selected Camera JPEG is missing or unavailable. Choose an original in the photo list to continue; the RAW preview was not substituted.");
        if(targetPath)void loadFolder(photoFolder(targetPath));
        return false;
      }
      const preferred = physicalPath ? catalogue.current.photos.get(physicalPath)??companion??(targetPath?catalogue.current.photos.get(targetPath):undefined) : undefined;
      const fallback = selectedPath.current ? catalogue.current.photos.get(selectedPath.current) : undefined;
      if (preferred || fallback) {
        const photo=(preferred??fallback)!;
        const shown=show(photo,1,preferCrop??showingCrop.current,companion?"cameraJpeg":sourceChoice.current);
        void loadFolder(photoFolder(photo.node.path),true,true);
        return await shown;
      }
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
    selectedPath.current = null;intendedPath.current=null; physicalOriginal.current=null; viewReady.current = false; showingCrop.current = false; sourceChoice.current = null; displayedSource.current = "raw";
    setOriginalSourceState("raw"); setOriginalInfo(null);
    setSelected(null); setSelectedPhoto(null); setSiblings([]); setSiblingIdx(0); setCropped(false);
    ++selectionRequest.current; ++treeRequest.current; cache.current!.clear(); setImages(emptyImages()); setImageErrors({original:false,bw:false,improved:false}); setError("");
    ++pickRequest.current;rawTree.current=null;folderLoads.current.clear();folderReady.current.clear();folderQueue.current.clear(inspectionOwner.current+":");setInspection(null);
    metadataSelection.current=false;
    if (root.current) void refreshTree(root.current);
    else { setTree([]); setLoading(false); catalogue.current = lightboxCatalogue([]); }
  }, [settings?.staging_dir]);

  async function selectNode(node: TreeNode, direction: 1 | -1 = 1) {
    if (renameBusy.current) return false;
    ++pickRequest.current;
    intendedPath.current=node.path;
    metadataSelection.current=false;
    const photo = catalogue.current.photos.get(node.path);
    const owner=[...catalogue.current.photos.values()].find(p=>p.cameraJpeg?.path===node.path);
    if(photo || owner) {
      const shown=show((photo??owner)!,direction,false,owner?"cameraJpeg":sourceChoice.current);
      void loadFolder(photoFolder(node.path),true,true);
      return await shown;
    }
    ++selectionRequest.current;viewReady.current=false;originalPending.current=false;cache.current!.select([]);
    selectedPath.current=null;intendedPath.current=null;
    setLoading(false);setImages(emptyImages());setImageErrors({original:false,bw:false,improved:false});setImageLoading({original:false,bw:false,improved:false});setOriginalInfo(null);
    setSelected(null);setSelectedPhoto(null);setSiblings([]);setSiblingIdx(0);
    return false;
  }
  async function setCropVersion(useCrop: boolean) {
    if (renameBusy.current || !isIdentityReady()) return false;
    const snapshot = getSnapshot();
    return snapshot ? show(snapshot.photo, 1, useCrop) : false;
  }
  async function setOriginalSource(source: OriginalSource) {
    if (renameBusy.current || !isIdentityReady()) return false;
    const snapshot = getSnapshot();
    if (!snapshot || (source === "cameraJpeg" && !snapshot.photo.cameraJpeg)) return false;
    return show(snapshot.photo, 1, false, source);
  }
  async function navigate(direction: 1 | -1) {
    if (renameBusy.current) return false;
    const snapshot = getSnapshot();
    if (!snapshot) return false;
    const group = catalogue.current.folders.get(photoFolder(snapshot.context.path)) ?? [];
    const index = group.findIndex(photo => photo.node.path === snapshot.context.path);
    return index >= 0 && group[index + direction] ? selectNode(group[index + direction].node, direction) : false;
  }
  async function navigateToEdge(edge: "first" | "last") {
    if (renameBusy.current) return false;
    const snapshot = getSnapshot();
    if (!snapshot) return false;
    const group = catalogue.current.folders.get(photoFolder(snapshot.context.path)) ?? [];
    const photo = edge === "first" ? group[0] : group[group.length - 1];
    return photo ? selectNode(photo.node, edge === "first" ? -1 : 1) : false;
  }
  async function advanceFromContext(context: ReviewContext) {
    if (!isReady() || !isContextCurrent(context)) return false;
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
    tree, selected, siblings, siblingIdx, images, imageLoading, imageErrors, inspection, zoom, loading, error, renaming, stagingDir,
    cropped, selectedPhoto, catalogueRevision, originalSource, originalInfo,
    trashed: selected ? isTrashed(selected.name) : false,
    stars: selected ? parseStars(selected.name) : 0,
    refreshTree, selectNode, loadFolder, retryImage, imageFailed, handleStars, handleTrash, navigate, navigateToEdge, setZoom, setCropVersion, setOriginalSource,
    getSnapshot, isContextCurrent, isReady, isDisplayReady, isIdentityReady, advanceFromContext,
  };
}
