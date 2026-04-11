import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../hooks";
import type {
  ApplyEventNamingRequest,
  EventDayDirectory,
  EventNamingCatalog,
  MetadataTagWriteResult,
  StagingTagEntry,
  StagingTagsState,
  TreeNode,
} from "../types";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "cr3", "dng"]);
const VIDEO_EXTS = new Set(["avi", "mp4", "mkv", "mov", "mts"]);

type FileRow = {
  relativePath: string;
  name: string;
  size: number;
  isImage: boolean;
  isVideo: boolean;
};

type SortColumn = "name" | "tags" | "group" | "size";
type SortDirection = "asc" | "desc";
type DensityMode = "compact" | "comfortable";
type ResizableColumn = "name" | "tags" | "group" | "size";
type ColumnWidths = Record<ResizableColumn, number>;
type PaneResizeSide = "left" | "right";

const VIEW_PREFS_KEY = "photogogo.stagingExplorer.viewPrefs.v1";

function normalizeTagList(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function formatPreviewName(day: number, eventType: string, location: string, tags: string[]): string {
  const parts = [String(day).padStart(2, "0")];
  const cleanEventType = eventType.trim();
  const cleanLocation = location.trim();
  const cleanTags = normalizeTagList(tags);

  if (cleanEventType && cleanLocation) {
    parts.push(`${cleanEventType} - ${cleanLocation}`);
  } else if (cleanEventType) {
    parts.push(cleanEventType);
  } else if (cleanLocation) {
    parts.push(cleanLocation);
  }

  if (cleanTags.length > 0) {
    parts.push(cleanTags.join(", "));
  }

  return parts.join(" - ");
}

function findNodeByPath(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }
    if (node.type === "dir" && node.children) {
      const found = findNodeByPath(node.children, targetPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function flattenFiles(node: TreeNode): FileRow[] {
  if (node.type === "file") {
    const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
    return [{
      relativePath: node.path,
      name: node.name,
      size: node.size ?? 0,
      isImage: IMAGE_EXTS.has(ext),
      isVideo: VIDEO_EXTS.has(ext),
    }];
  }

  const out: FileRow[] = [];
  for (const child of node.children ?? []) {
    out.push(...flattenFiles(child));
  }
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileKind(file: FileRow): string {
  if (file.isImage) {
    return "Image";
  }
  if (file.isVideo) {
    return "Video";
  }
  return "File";
}

export default function StagingExplorer() {
  const { settings, loading: settingsLoading, error: settingsError } = useSettings();

  const [directories, setDirectories] = useState<EventDayDirectory[]>([]);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [catalog, setCatalog] = useState<EventNamingCatalog>({ eventTypes: [], peopleTags: [], groupTags: [], generalTags: [] });
  const [tagsState, setTagsState] = useState<StagingTagsState>({ version: 1, entries: [], groups: [] });

  const [selectedDayPath, setSelectedDayPath] = useState<string | null>(null);
  const [selectedPreviewPath, setSelectedPreviewPath] = useState<string | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);

  const [checkedPaths, setCheckedPaths] = useState<string[]>([]);
  const [lastCheckedPath, setLastCheckedPath] = useState<string | null>(null);

  const [eventType, setEventType] = useState("");
  const [location, setLocation] = useState("");
  const [namingTagsText, setNamingTagsText] = useState("");

  const [tagText, setTagText] = useState("");
  const [groupLabel, setGroupLabel] = useState("");
  const [createGroup, setCreateGroup] = useState(true);
  const [metadataBackupEnabled, setMetadataBackupEnabled] = useState(true);
  const [metadataDryRunEnabled, setMetadataDryRunEnabled] = useState(false);
  const [metadataVerifyEnabled, setMetadataVerifyEnabled] = useState(true);
  const [metadataMd5ReportEnabled, setMetadataMd5ReportEnabled] = useState(true);
  const [writingMetadata, setWritingMetadata] = useState(false);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [density, setDensity] = useState<DensityMode>("comfortable");
  const [contextMenuFilePath, setContextMenuFilePath] = useState<string | null>(null);
  const [contextMenuTagOpen, setContextMenuTagOpen] = useState(false);
  const [contextMenuFocusIndex, setContextMenuFocusIndex] = useState(0);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 120, y: 120 });
  const [leftPaneWidth, setLeftPaneWidth] = useState(250);
  const [rightPaneWidth, setRightPaneWidth] = useState(360);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({
    name: 420,
    tags: 170,
    group: 180,
    size: 100,
  });
  const resizeStateRef = useRef<{ column: ResizableColumn; startX: number; startWidth: number } | null>(null);
  const paneResizeRef = useRef<{ side: PaneResizeSide; startX: number; startWidth: number } | null>(null);
  const detailsGridScopeRef = useRef<HTMLDivElement | null>(null);
  const contextMenuLayerRef = useRef<HTMLDivElement | null>(null);
  const paneScopeRef = useRef<HTMLDivElement | null>(null);

  const stagingDir = settings?.staging_dir ?? "";

  const selectedDay = useMemo(
    () => directories.find((directory) => directory.path === selectedDayPath) ?? null,
    [directories, selectedDayPath],
  );

  const selectedDayNode = useMemo(
    () => (selectedDay ? findNodeByPath(treeNodes, selectedDay.relativePath) : null),
    [selectedDay, treeNodes],
  );

  const tagEntryByPath = useMemo(() => {
    const map = new Map<string, StagingTagEntry>();
    for (const entry of tagsState.entries) {
      map.set(entry.relativePath, entry);
    }
    return map;
  }, [tagsState.entries]);

  const groupLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of tagsState.groups) {
      map.set(group.id, group.label);
    }
    return map;
  }, [tagsState.groups]);

  const files = useMemo(() => {
    if (!selectedDayNode) {
      return [];
    }

    const raw = flattenFiles(selectedDayNode);
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? raw.filter((file) =>
          file.name.toLowerCase().includes(query) ||
          file.relativePath.toLowerCase().includes(query) ||
          fileKind(file).toLowerCase().includes(query),
        )
      : raw;

    const sorted = [...filtered].sort((left, right) => {
      const leftEntry = tagEntryByPath.get(left.relativePath);
      const rightEntry = tagEntryByPath.get(right.relativePath);
      const leftPrimaryGroup = leftEntry?.groupIds[0] ?? "";
      const rightPrimaryGroup = rightEntry?.groupIds[0] ?? "";
      const leftGroupLabel = leftPrimaryGroup ? (groupLabelById.get(leftPrimaryGroup) ?? leftPrimaryGroup) : "";
      const rightGroupLabel = rightPrimaryGroup ? (groupLabelById.get(rightPrimaryGroup) ?? rightPrimaryGroup) : "";
      const leftTags = leftEntry?.tags.join(", ") ?? "";
      const rightTags = rightEntry?.tags.join(", ") ?? "";

      let result = 0;
      if (sortColumn === "name") {
        result = left.name.localeCompare(right.name);
      } else if (sortColumn === "tags") {
        result = leftTags.localeCompare(rightTags);
      } else if (sortColumn === "group") {
        result = leftGroupLabel.localeCompare(rightGroupLabel);
      } else {
        result = left.size - right.size;
      }

      if (result === 0) {
        result = left.relativePath.localeCompare(right.relativePath);
      }

      return sortDirection === "asc" ? result : -result;
    });

    return sorted;
  }, [selectedDayNode, searchQuery, sortColumn, sortDirection, tagEntryByPath, groupLabelById]);

  const selectedPreviewFile = useMemo(
    () => files.find((file) => file.relativePath === selectedPreviewPath) ?? null,
    [files, selectedPreviewPath],
  );

  const contextMenuFile = useMemo(
    () => files.find((file) => file.relativePath === contextMenuFilePath) ?? null,
    [files, contextMenuFilePath],
  );

  async function refreshAll() {
    if (!stagingDir) {
      setDirectories([]);
      setTreeNodes([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [loadedDirectories, loadedTree, loadedCatalog, loadedTags] = await Promise.all([
        invoke<EventDayDirectory[]>("list_event_day_directories", { stagingDir }),
        invoke<TreeNode>("list_staging_tree", { stagingDir }),
        invoke<EventNamingCatalog>("load_event_naming_catalog"),
        invoke<StagingTagsState>("load_staging_tags", { stagingDir }),
      ]);

      setDirectories(loadedDirectories);
      setTreeNodes(loadedTree?.children ?? []);
      setCatalog(loadedCatalog);
      setTagsState(loadedTags);

      if (!selectedDayPath && loadedDirectories.length > 0) {
        setSelectedDayPath(loadedDirectories[0].path);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!settingsLoading && stagingDir) {
      void refreshAll();
    }
  }, [settingsLoading, stagingDir]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VIEW_PREFS_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        searchQuery?: string;
        sortColumn?: SortColumn;
        sortDirection?: SortDirection;
        density?: DensityMode;
        columnWidths?: Partial<ColumnWidths>;
        leftPaneWidth?: number;
        rightPaneWidth?: number;
      };

      if (typeof parsed.searchQuery === "string") {
        setSearchQuery(parsed.searchQuery);
      }
      if (parsed.sortColumn === "name" || parsed.sortColumn === "tags" || parsed.sortColumn === "group" || parsed.sortColumn === "size") {
        setSortColumn(parsed.sortColumn);
      }
      if (parsed.sortDirection === "asc" || parsed.sortDirection === "desc") {
        setSortDirection(parsed.sortDirection);
      }
      if (parsed.density === "compact" || parsed.density === "comfortable") {
        setDensity(parsed.density);
      }
      if (parsed.columnWidths) {
        setColumnWidths((current) => ({
          name: Math.max(180, Math.min(900, parsed.columnWidths?.name ?? current.name)),
          tags: Math.max(110, Math.min(420, parsed.columnWidths?.tags ?? current.tags)),
          group: Math.max(120, Math.min(420, parsed.columnWidths?.group ?? current.group)),
          size: Math.max(70, Math.min(240, parsed.columnWidths?.size ?? current.size)),
        }));
      }
      if (typeof parsed.leftPaneWidth === "number") {
        setLeftPaneWidth(Math.max(180, Math.min(520, parsed.leftPaneWidth)));
      }
      if (typeof parsed.rightPaneWidth === "number") {
        setRightPaneWidth(Math.max(240, Math.min(640, parsed.rightPaneWidth)));
      }
    } catch {
    }
  }, []);

  useEffect(() => {
    const payload = {
      searchQuery,
      sortColumn,
      sortDirection,
      density,
      columnWidths,
      leftPaneWidth,
      rightPaneWidth,
    };
    try {
      window.localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(payload));
    } catch {
    }
  }, [searchQuery, sortColumn, sortDirection, density, columnWidths, leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    if (!contextMenuLayerRef.current) {
      return;
    }

    contextMenuLayerRef.current.style.setProperty("--sx-cm-x", `${contextMenuPos.x}px`);
    contextMenuLayerRef.current.style.setProperty("--sx-cm-y", `${contextMenuPos.y}px`);
  }, [contextMenuPos]);

  useEffect(() => {
    if (!paneScopeRef.current) {
      return;
    }

    paneScopeRef.current.style.setProperty("--sx-pane-left", `${leftPaneWidth}px`);
    paneScopeRef.current.style.setProperty("--sx-pane-right", `${rightPaneWidth}px`);
  }, [leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    if (!detailsGridScopeRef.current) {
      return;
    }

    detailsGridScopeRef.current.style.setProperty("--sx-col-name", `${columnWidths.name}px`);
    detailsGridScopeRef.current.style.setProperty("--sx-col-tags", `${columnWidths.tags}px`);
    detailsGridScopeRef.current.style.setProperty("--sx-col-group", `${columnWidths.group}px`);
    detailsGridScopeRef.current.style.setProperty("--sx-col-size", `${columnWidths.size}px`);
  }, [columnWidths]);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const resize = resizeStateRef.current;
      if (!resize) {
        return;
      }

      const delta = event.clientX - resize.startX;
      const nextWidth = resize.startWidth + delta;
      setColumnWidths((current) => {
        const limits: Record<ResizableColumn, [number, number]> = {
          name: [180, 900],
          tags: [110, 420],
          group: [120, 420],
          size: [70, 240],
        };
        const [min, max] = limits[resize.column];
        return {
          ...current,
          [resize.column]: Math.max(min, Math.min(max, nextWidth)),
        };
      });
    }

    function onMouseUp() {
      resizeStateRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const resize = paneResizeRef.current;
      if (!resize) {
        return;
      }

      const delta = event.clientX - resize.startX;
      if (resize.side === "left") {
        setLeftPaneWidth(Math.max(180, Math.min(520, resize.startWidth + delta)));
      } else {
        setRightPaneWidth(Math.max(240, Math.min(640, resize.startWidth - delta)));
      }
    }

    function onMouseUp() {
      paneResizeRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement;
      const tagName = activeElement?.tagName ?? "";
      const editable = tagName === "INPUT" || tagName === "TEXTAREA" || (activeElement as HTMLElement | null)?.isContentEditable;

      if (contextMenuFilePath) {
        const menuButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".staging-context-menu [data-cm-item='true']"));
        if (menuButtons.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setContextMenuFocusIndex((current) => (current + 1) % menuButtons.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setContextMenuFocusIndex((current) => (current - 1 + menuButtons.length) % menuButtons.length);
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            setContextMenuFocusIndex(0);
            return;
          }
          if (event.key === "End") {
            event.preventDefault();
            setContextMenuFocusIndex(menuButtons.length - 1);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const idx = Math.max(0, Math.min(contextMenuFocusIndex, menuButtons.length - 1));
            menuButtons[idx]?.click();
            return;
          }
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !editable) {
        event.preventDefault();
        setCheckedPaths(files.map((file) => file.relativePath));
        if (files.length > 0) {
          setLastCheckedPath(files[files.length - 1].relativePath);
        }
      }

      if (event.key === "Escape") {
        setContextMenuFilePath(null);
        setContextMenuTagOpen(false);
        setContextMenuFocusIndex(0);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [files, contextMenuFilePath, contextMenuFocusIndex]);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(".staging-context-menu")) {
        setContextMenuFilePath(null);
        setContextMenuTagOpen(false);
        setContextMenuFocusIndex(0);
      }
    }

    window.addEventListener("click", onDocumentClick);
    return () => window.removeEventListener("click", onDocumentClick);
  }, []);

  useEffect(() => {
    if (!contextMenuFilePath) {
      return;
    }

    const menuButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".staging-context-menu [data-cm-item='true']"));
    if (menuButtons.length === 0) {
      return;
    }

    const idx = Math.max(0, Math.min(contextMenuFocusIndex, menuButtons.length - 1));
    menuButtons[idx]?.focus();
  }, [contextMenuFilePath, contextMenuTagOpen, contextMenuFocusIndex]);

  useEffect(() => {
    if (!selectedPreviewFile || !selectedPreviewFile.isImage || !stagingDir) {
      setPreviewDataUrl(null);
      return;
    }

    const absPath = `${stagingDir.replace(/\//g, "\\")}\\${selectedPreviewFile.relativePath.replace(/\//g, "\\")}`;
    void invoke<string>("read_image_base64", { path: absPath })
      .then((base64) => setPreviewDataUrl(`data:image/jpeg;base64,${base64}`))
      .catch(() => setPreviewDataUrl(null));
  }, [selectedPreviewFile, stagingDir]);

  function toggleFileSelection(path: string, checked: boolean, useRange: boolean) {
    const fileIndex = files.findIndex((file) => file.relativePath === path);

    setCheckedPaths((current) => {
      if (useRange && lastCheckedPath) {
        const anchorIndex = files.findIndex((file) => file.relativePath === lastCheckedPath);
        if (anchorIndex >= 0 && fileIndex >= 0) {
          const start = Math.min(anchorIndex, fileIndex);
          const end = Math.max(anchorIndex, fileIndex);
          const rangePaths = files.slice(start, end + 1).map((file) => file.relativePath);
          const next = new Set(current);
          for (const rangePath of rangePaths) {
            if (checked) {
              next.add(rangePath);
            } else {
              next.delete(rangePath);
            }
          }
          return files.filter((file) => next.has(file.relativePath)).map((file) => file.relativePath);
        }
      }

      if (checked) {
        return current.includes(path) ? current : [...current, path];
      }
      return current.filter((value) => value !== path);
    });

    setLastCheckedPath(path);
  }

  function onResizeStart(column: ResizableColumn, event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStateRef.current = {
      column,
      startX: event.clientX,
      startWidth: columnWidths[column],
    };
  }

  function onPaneResizeStart(side: PaneResizeSide, event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    paneResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? leftPaneWidth : rightPaneWidth,
    };
  }

  function onRowClick(filePath: string, event: React.MouseEvent<HTMLButtonElement>) {
    setContextMenuFilePath(null);
    setContextMenuTagOpen(false);
    setSelectedPreviewPath(filePath);

    if (event.ctrlKey || event.metaKey) {
      const checked = checkedPaths.includes(filePath);
      toggleFileSelection(filePath, !checked, false);
      return;
    }

    if (event.shiftKey) {
      toggleFileSelection(filePath, true, true);
    }
  }

  function toAbsolutePath(relativePath: string): string {
    return `${stagingDir.replace(/\//g, "\\")}\\${relativePath.replace(/\//g, "\\")}`;
  }

  function openContextMenu(relativePath: string, clientX: number, clientY: number) {
    const menuWidth = 230;
    const menuHeight = 280;
    const margin = 8;
    const clampedX = Math.max(margin, Math.min(clientX, window.innerWidth - menuWidth - margin));
    const clampedY = Math.max(margin, Math.min(clientY, window.innerHeight - menuHeight - margin));

    setContextMenuPos({ x: clampedX, y: clampedY });
    setContextMenuFilePath(relativePath);
    setContextMenuTagOpen(false);
    setContextMenuFocusIndex(0);
  }

  async function revealFile(relativePath: string) {
    if (!stagingDir) {
      return;
    }

    setContextMenuFilePath(null);
    try {
      await invoke("reveal_in_explorer", { path: toAbsolutePath(relativePath) });
    } catch (e) {
      setError(String(e));
    }
  }

  function selectSameGroup(relativePath: string) {
    const primaryGroupId = tagEntryByPath.get(relativePath)?.groupIds[0] ?? null;
    if (!primaryGroupId) {
      return;
    }

    const sameGroup = files
      .filter((file) => (tagEntryByPath.get(file.relativePath)?.groupIds ?? []).includes(primaryGroupId))
      .map((file) => file.relativePath);
    setCheckedPaths(sameGroup);
    setLastCheckedPath(sameGroup.length > 0 ? sameGroup[sameGroup.length - 1] : null);
    setContextMenuFilePath(null);
    setContextMenuTagOpen(false);
    setContextMenuFocusIndex(0);
  }

  async function applyQuickTagToFile(relativePath: string) {
    const parsedTags = normalizeTagList(tagText.split(","));
    if (!stagingDir || parsedTags.length === 0) {
      setError("Enter one or more tags before using Quick Tag.");
      setContextMenuFilePath(null);
      setContextMenuTagOpen(false);
      setContextMenuFocusIndex(0);
      return;
    }

    setError(null);
    try {
      const nextState = await invoke<StagingTagsState>("apply_staging_tags", {
        stagingDir,
        relativePaths: [relativePath],
        tags: parsedTags,
        createGroup: false,
        groupLabel: null,
      });
      setTagsState(nextState);
      setMessage("Quick tag applied to selected file.");
    } catch (e) {
      setError(String(e));
    } finally {
      setContextMenuFilePath(null);
      setContextMenuTagOpen(false);
      setContextMenuFocusIndex(0);
    }
  }

  async function applyQuickTagAndGroupToFile(relativePath: string) {
    const parsedTags = normalizeTagList(tagText.split(","));
    if (!stagingDir || parsedTags.length === 0) {
      setError("Enter one or more tags before using tag actions.");
      setContextMenuFilePath(null);
      setContextMenuTagOpen(false);
      return;
    }

    setError(null);
    try {
      const nextState = await invoke<StagingTagsState>("apply_staging_tags", {
        stagingDir,
        relativePaths: [relativePath],
        tags: parsedTags,
        createGroup: true,
        groupLabel: groupLabel.trim() || null,
      });
      setTagsState(nextState);
      setMessage("Quick tag + group applied to selected file.");
    } catch (e) {
      setError(String(e));
    } finally {
      setContextMenuFilePath(null);
      setContextMenuTagOpen(false);
      setContextMenuFocusIndex(0);
    }
  }

  function onHeaderClick(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  }

  function sortMarker(column: SortColumn): string {
    if (sortColumn !== column) {
      return "";
    }
    return sortDirection === "asc" ? " ▲" : " ▼";
  }

  async function applyTagsToChecked() {
    if (!stagingDir) {
      setError("Staging directory is not configured.");
      return;
    }

    if (checkedPaths.length === 0) {
      setError("Check one or more files first.");
      return;
    }

    const parsedTags = normalizeTagList(tagText.split(","));
    if (parsedTags.length === 0 && !createGroup) {
      setError("Enter at least one tag or create a group marker.");
      return;
    }

    setError(null);
    setMessage(null);

    try {
      const nextState = await invoke<StagingTagsState>("apply_staging_tags", {
        stagingDir,
        relativePaths: checkedPaths,
        tags: parsedTags,
        createGroup,
        groupLabel: groupLabel.trim() || null,
      });
      setTagsState(nextState);
      setMessage(`Updated ${checkedPaths.length} file${checkedPaths.length === 1 ? "" : "s"} with tags/group.`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function writeCheckedTagsToMetadata() {
    if (!stagingDir) {
      setError("Staging directory is not configured.");
      return;
    }

    if (checkedPaths.length === 0) {
      setError("Check one or more files first.");
      return;
    }

    setWritingMetadata(true);
    setError(null);
    setMessage(null);

    try {
      const additionalTags = normalizeTagList(tagText.split(","));
      const result = await invoke<MetadataTagWriteResult>("write_staging_tags_to_metadata", {
        stagingDir,
        relativePaths: checkedPaths,
        additionalTags,
        backupOriginal: metadataBackupEnabled,
        dryRun: metadataDryRunEnabled,
        verifyAfterWrite: metadataVerifyEnabled,
        generateMd5Report: metadataMd5ReportEnabled,
      });

      const prefix = result.dryRun ? "Metadata dry run" : `Metadata write finished (ExifTool ${result.exiftoolVersion})`;
      const summary = `${prefix}: planned ${result.planned}, updated ${result.updated}, verified ${result.verified}, verification failed ${result.verificationFailed}, skipped unsupported ${result.skippedUnsupported}, skipped with no tags ${result.skippedNoTags}, failed ${result.failed}.`;
      const backupInfo = result.backupDir ? ` Backup: ${result.backupDir}` : "";
      const md5Info = result.md5ReportPath ? ` MD5 report: ${result.md5ReportPath}` : "";

      if (result.failed > 0 && result.errors.length > 0) {
        setError(`${summary} First error: ${result.errors[0]}.${backupInfo}${md5Info}`);
      } else {
        setMessage(`${summary}${backupInfo}${md5Info}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setWritingMetadata(false);
    }
  }

  async function applyDayNaming() {
    if (!selectedDay) {
      setError("Select a day folder first.");
      return;
    }

    const tags = normalizeTagList(namingTagsText.split(","));
    const request: ApplyEventNamingRequest = {
      directories: [selectedDay.path],
      eventType: eventType.trim(),
      location: location.trim(),
      peopleTags: [],
      groupTags: [],
      generalTags: tags,
      assignments: [],
    };

    setError(null);
    setMessage(null);

    try {
      await invoke("apply_event_naming", { request });
      setMessage("Day folder renamed.");
      await refreshAll();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="p-4 h-full">
      <div className="h-full flex flex-col rounded-xl border border-surface-600 bg-surface-900 overflow-hidden shadow-lg shadow-black/30">
        <div className="px-4 py-2 border-b border-surface-700 bg-surface-800/90">
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={refreshAll} disabled={!stagingDir || loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={applyTagsToChecked} disabled={checkedPaths.length === 0}>
              Tag Selected
            </button>
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={applyDayNaming} disabled={!selectedDay}>
              Rename Day Folder
            </button>
            <div className="flex items-center rounded-md border border-surface-600 overflow-hidden">
              <button
                className={`px-2 py-1.5 text-xs ${density === "compact" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setDensity("compact")}
                type="button"
              >
                Compact
              </button>
              <button
                className={`px-2 py-1.5 text-xs border-l border-surface-600 ${density === "comfortable" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setDensity("comfortable")}
                type="button"
              >
                Comfortable
              </button>
            </div>
            <div className="ml-auto text-xs text-gray-500">Items: {files.length} • Checked: {checkedPaths.length}</div>
          </div>
        </div>

        <div className="px-4 py-2 border-b border-surface-700 bg-surface-850/70">
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_280px] gap-2 items-center">
            <div className="rounded-md border border-surface-600 bg-surface-900 px-3 py-1.5 text-xs text-gray-300 truncate">
              This PC &gt; Staging &gt; {selectedDay?.relativePath || ""}
            </div>
            <input
              className="input-field h-8 text-xs"
              placeholder="Search current day"
              title="Search current day"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {(settingsError || error) && (
          <div className="mx-4 mt-3 bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-red-300 text-sm">
            {settingsError ?? error}
          </div>
        )}

        {message && (
          <div className="mx-4 mt-3 bg-emerald-900/30 border border-emerald-700 rounded-lg px-4 py-3 text-emerald-200 text-sm">
            {message}
          </div>
        )}

        <div ref={paneScopeRef} className="flex-1 min-h-0 staging-explorer-pane-layout">
          <aside className="staging-explorer-pane-left border-r border-surface-700 bg-surface-850/60 min-h-0 flex flex-col">
            <div className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400 border-b border-surface-700">Navigation</div>
            <div className="flex-1 overflow-auto p-2 space-y-1">
              {directories.length === 0 ? (
                <div className="text-xs text-gray-500 px-2 py-2">No day folders found.</div>
              ) : (
                directories.map((directory) => (
                  <button
                    key={directory.path}
                    type="button"
                    className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${selectedDayPath === directory.path ? "bg-accent/20 text-white" : "text-gray-300 hover:bg-surface-700"}`}
                    onClick={() => {
                      setSelectedDayPath(directory.path);
                      setCheckedPaths([]);
                      setLastCheckedPath(null);
                      setSelectedPreviewPath(null);
                    }}
                    title={directory.name}
                  >
                    <div className="text-sm truncate">{directory.name}</div>
                    <div className="text-[11px] text-gray-500 truncate">{directory.dateKey}</div>
                  </button>
                ))
              )}
            </div>
          </aside>

          <div
            className="staging-explorer-pane-resizer hidden xl:block"
            onMouseDown={(event) => onPaneResizeStart("left", event)}
            title="Drag to resize left pane"
            role="separator"
            aria-orientation="vertical"
          />

          <section className="staging-explorer-pane-center min-h-0 flex flex-col overflow-x-auto">
            <div className="staging-explorer-grid-scope">
              <div className="flex-1 overflow-auto">
                <div ref={detailsGridScopeRef} className="staging-explorer-details-grid gap-2 px-3 py-2 border-b border-surface-700 bg-surface-800 text-xs uppercase tracking-wide text-gray-400 sticky top-0 z-10">
                  <span>Sel</span>
                  <div className="relative pr-2">
                    <button type="button" className="text-left" onClick={() => onHeaderClick("name")}>Name{sortMarker("name")}</button>
                    <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize" onMouseDown={(event) => onResizeStart("name", event)} />
                  </div>
                  <div className="relative pr-2">
                    <button type="button" className="text-left" onClick={() => onHeaderClick("tags")}>Tags{sortMarker("tags")}</button>
                    <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize" onMouseDown={(event) => onResizeStart("tags", event)} />
                  </div>
                  <div className="relative pr-2">
                    <button type="button" className="text-left" onClick={() => onHeaderClick("group")}>Group{sortMarker("group")}</button>
                    <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize" onMouseDown={(event) => onResizeStart("group", event)} />
                  </div>
                  <div className="relative pr-2">
                    <button type="button" className="text-left" onClick={() => onHeaderClick("size")}>Size{sortMarker("size")}</button>
                    <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize" onMouseDown={(event) => onResizeStart("size", event)} />
                  </div>
                </div>

                {files.length === 0 ? (
                  <div className="text-sm text-gray-500 p-4">Select a day folder to list files.</div>
                ) : (
                  files.map((file, index) => {
                    const checked = checkedPaths.includes(file.relativePath);
                    const selectedPreview = selectedPreviewPath === file.relativePath;
                    const entry = tagEntryByPath.get(file.relativePath);
                    const primaryGroupId = entry?.groupIds[0] ?? null;
                    const previousGroupId = index > 0 ? (tagEntryByPath.get(files[index - 1].relativePath)?.groupIds[0] ?? null) : null;
                    const nextGroupId = index < files.length - 1 ? (tagEntryByPath.get(files[index + 1].relativePath)?.groupIds[0] ?? null) : null;
                    const sameAsPrevious = Boolean(primaryGroupId && primaryGroupId === previousGroupId);
                    const sameAsNext = Boolean(primaryGroupId && primaryGroupId === nextGroupId);
                    const connector = !primaryGroupId ? "" : sameAsPrevious && sameAsNext ? "|" : !sameAsPrevious && sameAsNext ? "+" : sameAsPrevious && !sameAsNext ? "'" : "*";

                    return (
                      <div
                        key={file.relativePath}
                        className={`staging-explorer-details-grid relative gap-2 px-3 ${density === "compact" ? "py-1" : "py-2"} border-b border-surface-800 text-sm ${selectedPreview ? "bg-accent/20" : "hover:bg-surface-800/70"}`}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          openContextMenu(file.relativePath, event.clientX, event.clientY);
                          setSelectedPreviewPath(file.relativePath);
                        }}
                      >
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleFileSelection(file.relativePath, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                            className="h-4 w-4"
                            aria-label={`Select ${file.name}`}
                            title={`Select ${file.name}`}
                          />
                        </div>
                        <button
                          type="button"
                          className="text-left min-w-0"
                          onClick={(event) => onRowClick(file.relativePath, event)}
                          title="Click to preview. Ctrl+Click toggles check. Shift+Click checks range."
                        >
                          <div className="truncate text-gray-100">{file.name}</div>
                          <div className="truncate text-[11px] text-gray-500">{fileKind(file)} • {file.relativePath}</div>
                        </button>
                        <div className="flex items-center text-[11px] text-emerald-300 truncate" title={entry?.tags.join(", ") || ""}>
                          {entry?.tags.length ? entry.tags.join(", ") : "-"}
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-amber-300 truncate" title={primaryGroupId ? groupLabelById.get(primaryGroupId) ?? primaryGroupId : ""}>
                          <span className="w-3 text-center font-mono">{connector}</span>
                          <span className="truncate">{primaryGroupId ? groupLabelById.get(primaryGroupId) ?? primaryGroupId : "-"}</span>
                        </div>
                        <div className="flex items-center text-[11px] text-gray-400">{formatSize(file.size)}</div>
                      </div>
                    );
                  })
                )}
              </div>

            {contextMenuFile && (
              <div ref={contextMenuLayerRef} className="staging-context-menu fixed z-30 w-56 rounded-md border border-surface-600 bg-surface-900 shadow-lg shadow-black/50 p-1">
                <button type="button" data-cm-item="true" className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded" onClick={() => {
                  setSelectedPreviewPath(contextMenuFile.relativePath);
                  setContextMenuFilePath(null);
                  setContextMenuTagOpen(false);
                  setContextMenuFocusIndex(0);
                }}>
                  👁 Preview
                </button>
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded"
                  onClick={() => toggleFileSelection(contextMenuFile.relativePath, !checkedPaths.includes(contextMenuFile.relativePath), false)}
                >
                  {checkedPaths.includes(contextMenuFile.relativePath) ? "☐ Uncheck" : "☑ Check"}
                </button>
                <button type="button" data-cm-item="true" className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded" onClick={() => revealFile(contextMenuFile.relativePath)}>
                  📂 Reveal In Explorer
                </button>

                <div className="my-1 border-t border-surface-700" role="separator" />
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded flex items-center justify-between"
                  onClick={() => setContextMenuTagOpen((open) => !open)}
                >
                  <span>🏷 Tag</span>
                  <span>{contextMenuTagOpen ? "▾" : "▸"}</span>
                </button>
                {contextMenuTagOpen && (
                  <div className="pl-2 pr-1 py-1 space-y-1">
                    <button type="button" data-cm-item="true" className="w-full text-left px-2 py-1.5 text-xs text-emerald-200 hover:bg-surface-700 rounded" onClick={() => applyQuickTagToFile(contextMenuFile.relativePath)}>
                      ➕ Apply Tag Text
                    </button>
                    <button type="button" data-cm-item="true" className="w-full text-left px-2 py-1.5 text-xs text-emerald-200 hover:bg-surface-700 rounded" onClick={() => applyQuickTagAndGroupToFile(contextMenuFile.relativePath)}>
                      🧩 Apply Tag + New Group
                    </button>
                  </div>
                )}

                <div className="my-1 border-t border-surface-700" role="separator" />
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded disabled:opacity-40"
                  onClick={() => selectSameGroup(contextMenuFile.relativePath)}
                  disabled={!tagEntryByPath.get(contextMenuFile.relativePath)?.groupIds[0]}
                >
                  🔗 Select Same Group
                </button>
              </div>
            )}
            </div>
          </section>

          <div
            className="staging-explorer-pane-resizer hidden xl:block"
            onMouseDown={(event) => onPaneResizeStart("right", event)}
            title="Drag to resize right pane"
            role="separator"
            aria-orientation="vertical"
          />

          <aside className="staging-explorer-pane-right border-l border-surface-700 bg-surface-850/60 min-h-0 flex flex-col">
            <div className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400 border-b border-surface-700">Details Pane</div>
            <div className="flex-1 overflow-auto p-3 space-y-3">
              <div className="space-y-2 rounded-md border border-surface-700 bg-surface-900 p-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Rename Day Folder</div>
                <div className="text-xs text-gray-400">Selected day: {selectedDay?.name ?? "None"}</div>
                <div className="text-xs text-cyan-300 break-all">
                  {selectedDay ? formatPreviewName(selectedDay.day, eventType, location, normalizeTagList(namingTagsText.split(","))) : ""}
                </div>
                <input
                  className="input-field"
                  placeholder="Event type"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  list="event-types-staging-explorer"
                />
                <input
                  className="input-field"
                  placeholder="Location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
                <input
                  className="input-field"
                  placeholder="Naming tags (comma-separated)"
                  value={namingTagsText}
                  onChange={(e) => setNamingTagsText(e.target.value)}
                />
                <button className="btn-primary w-full" onClick={applyDayNaming} disabled={!selectedDay}>
                  Rename Selected Day Folder
                </button>
                <datalist id="event-types-staging-explorer">
                  {catalog.eventTypes.map((item) => (
                    <option key={item.name} value={item.name} />
                  ))}
                </datalist>
              </div>

              <div className="space-y-2 rounded-md border border-surface-700 bg-surface-900 p-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Tag Checked Files</div>
                <input
                  className="input-field"
                  placeholder="Tags (comma-separated)"
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <input
                    id="create-group-toggle"
                    type="checkbox"
                    checked={createGroup}
                    onChange={(e) => setCreateGroup(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="create-group-toggle" className="text-xs text-gray-300">Create group marker for this batch</label>
                </div>
                <input
                  className="input-field"
                  placeholder="Group label (optional)"
                  value={groupLabel}
                  onChange={(e) => setGroupLabel(e.target.value)}
                  disabled={!createGroup}
                />
                <button className="btn-primary w-full" onClick={applyTagsToChecked} disabled={checkedPaths.length === 0}>
                  Apply To Checked Files
                </button>
                <div className="flex items-center gap-2">
                  <input
                    id="metadata-backup-toggle"
                    type="checkbox"
                    checked={metadataBackupEnabled}
                    onChange={(e) => setMetadataBackupEnabled(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="metadata-backup-toggle" className="text-xs text-gray-300">Backup originals before metadata write</label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="metadata-dryrun-toggle"
                    type="checkbox"
                    checked={metadataDryRunEnabled}
                    onChange={(e) => setMetadataDryRunEnabled(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="metadata-dryrun-toggle" className="text-xs text-gray-300">Dry run only</label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="metadata-verify-toggle"
                    type="checkbox"
                    checked={metadataVerifyEnabled}
                    onChange={(e) => setMetadataVerifyEnabled(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="metadata-verify-toggle" className="text-xs text-gray-300">Verify metadata after write</label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="metadata-md5-report-toggle"
                    type="checkbox"
                    checked={metadataMd5ReportEnabled}
                    onChange={(e) => setMetadataMd5ReportEnabled(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <label htmlFor="metadata-md5-report-toggle" className="text-xs text-gray-300">Generate MD5 report for modified files</label>
                </div>
                <button className="btn-secondary w-full" onClick={writeCheckedTagsToMetadata} disabled={checkedPaths.length === 0 || writingMetadata}>
                  {writingMetadata ? "Running Metadata Action..." : metadataDryRunEnabled ? "Dry Run Metadata Write" : "Write Tags To JPG/MP4 Metadata"}
                </button>
                <div className="text-[11px] text-gray-500">
                  Uses ExifTool to write tags into JPG and MP4 files only. Real writes modify file bytes and may invalidate existing checksums.
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-surface-700 bg-surface-900 p-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Preview</div>
                {selectedPreviewFile ? (
                  <>
                    <div className="text-xs text-gray-300 break-all">{selectedPreviewFile.relativePath}</div>
                    <div className="rounded-md border border-surface-700 bg-black min-h-56 flex items-center justify-center overflow-hidden">
                      {selectedPreviewFile.isImage && previewDataUrl ? (
                        <img src={previewDataUrl} alt={selectedPreviewFile.name} className="max-h-[320px] max-w-full object-contain" />
                      ) : selectedPreviewFile.isVideo ? (
                        <div className="text-sm text-gray-500 p-4 text-center">Video selected. Inline video preview is not enabled yet.</div>
                      ) : (
                        <div className="text-sm text-gray-500 p-4 text-center">No preview available for this file type.</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-500">Select a file to preview.</div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
