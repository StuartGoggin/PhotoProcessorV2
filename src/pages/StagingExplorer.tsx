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
  TimelineMediaItem,
  TreeNode,
} from "../types";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "cr3", "dng"]);
const VIDEO_EXTS = new Set(["avi", "mp4", "mkv", "mov", "mts"]);
const SIDECAR_EXTS = new Set(["xmp", "aae", "thm", "pp3", "dop", "cos", "md5", "nks"]);

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
type ViewMode = "list" | "timeline";
type ResizableColumn = "name" | "tags" | "group" | "size";
type ColumnWidths = Record<ResizableColumn, number>;
type PaneResizeSide = "left" | "right";

type TimelineSequence = {
  id: string;
  breakBeforePath: string | null;
  sessionIndex: number;
  sequenceIndex: number;
  items: TimelineMediaItem[];
  startMs: number;
  endMs: number;
  totalDurationMs: number;
  gapFromPreviousMs: number | null;
};

type TimelineLayoutItem = {
  item: TimelineMediaItem;
  lane: 0 | 1;
  markerTop: number;
  markerHeight: number;
  cardTop: number;
  sequenceIndex: number;
  sessionIndex: number;
};

type TimelineSession = {
  id: string;
  sessionIndex: number;
  label: string;
  sequences: TimelineSequence[];
  items: TimelineMediaItem[];
  startMs: number;
  endMs: number;
};

type TimelineGapMode = "auto" | "manual";

type TimelineHoverPreview = {
  relativePath: string;
  name: string;
  kind: "image" | "video";
  x: number;
  y: number;
};

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatClock(timestampMs: number): string {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestampMs);
}

function formatTimelineTick(timestampMs: number): string {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestampMs);
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "Photo";
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function suggestTimelineThresholds(items: TimelineMediaItem[]): { sequenceGapMs: number; sessionGapMs: number } {
  if (items.length === 0) {
    return { sequenceGapMs: 90_000, sessionGapMs: 10 * 60_000 };
  }

  const sorted = [...items].sort((left, right) =>
    left.timestampMs - right.timestampMs || left.relativePath.localeCompare(right.relativePath),
  );
  const positiveGaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gap = Math.max(0, current.timestampMs - previous.endTimestampMs);
    if (gap > 0) {
      positiveGaps.push(gap);
    }
  }

  const shortGapSeed = median(positiveGaps.length > 0 ? positiveGaps.slice(0, Math.max(1, Math.ceil(positiveGaps.length * 0.5))) : [20_000]);
  return {
    sequenceGapMs: clamp(Math.round(shortGapSeed * 4), 45_000, 3 * 60_000),
    sessionGapMs: clamp(Math.round(Math.max(shortGapSeed * 18, shortGapSeed * 4 * 4)), 8 * 60_000, 30 * 60_000),
  };
}

function buildTimelineSequences(
  items: TimelineMediaItem[],
  sequenceGapMs: number,
  sessionGapMs: number,
  forcedBreaks: Set<string>,
  suppressedBreaks: Set<string>,
): TimelineSequence[] {
  if (items.length === 0) {
    return [];
  }

  const sorted = [...items].sort((left, right) =>
    left.timestampMs - right.timestampMs || left.relativePath.localeCompare(right.relativePath),
  );

  const sequences: TimelineSequence[] = [];
  let sessionIndex = 0;
  let currentItems: TimelineMediaItem[] = [sorted[0]];
  let currentStartMs = sorted[0].timestampMs;
  let currentEndMs = sorted[0].endTimestampMs;
  let lastSequenceEndMs = sorted[0].endTimestampMs;
  let currentBreakBeforePath: string | null = null;

  function pushCurrentSequence(gapFromPreviousMs: number | null) {
    if (currentItems.length === 0) {
      return;
    }

    sequences.push({
      id: `${sessionIndex}-${sequences.length}`,
      breakBeforePath: currentBreakBeforePath,
      sessionIndex,
      sequenceIndex: sequences.length,
      items: currentItems,
      startMs: currentStartMs,
      endMs: currentEndMs,
      totalDurationMs: currentItems.reduce((total, item) => total + (item.durationMs ?? 0), 0),
      gapFromPreviousMs,
    });
  }

  let gapFromPreviousSequence: number | null = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const gap = Math.max(0, current.timestampMs - currentEndMs);
    const autoBreak = gap > sequenceGapMs;
    const forceBreak = forcedBreaks.has(current.relativePath);
    const suppressBreak = suppressedBreaks.has(current.relativePath);
    if (forceBreak || (autoBreak && !suppressBreak)) {
      pushCurrentSequence(gapFromPreviousSequence);
      const sessionGap = Math.max(0, current.timestampMs - lastSequenceEndMs);
      if (sessionGap > sessionGapMs) {
        sessionIndex += 1;
      }
      gapFromPreviousSequence = sessionGap;
      currentItems = [current];
      currentStartMs = current.timestampMs;
      currentEndMs = current.endTimestampMs;
      lastSequenceEndMs = current.endTimestampMs;
      currentBreakBeforePath = current.relativePath;
    } else {
      currentItems.push(current);
      currentEndMs = Math.max(currentEndMs, current.endTimestampMs);
      lastSequenceEndMs = currentEndMs;
    }
  }

  pushCurrentSequence(gapFromPreviousSequence);
  return sequences;
}

function buildTimelineSessions(sequences: TimelineSequence[], labels: Record<string, string>): TimelineSession[] {
  const bySession = new Map<number, TimelineSequence[]>();
  for (const sequence of sequences) {
    const list = bySession.get(sequence.sessionIndex) ?? [];
    list.push(sequence);
    bySession.set(sequence.sessionIndex, list);
  }

  return [...bySession.entries()].map(([sessionIndex, sessionSequences]) => {
    const items = sessionSequences.flatMap((sequence) => sequence.items);
    const sessionId = `session-${sessionIndex}`;
    return {
      id: sessionId,
      sessionIndex,
      label: labels[sessionId]?.trim() || `Session ${sessionIndex + 1}`,
      sequences: sessionSequences,
      items,
      startMs: Math.min(...items.map((item) => item.timestampMs)),
      endMs: Math.max(...items.map((item) => item.endTimestampMs)),
    };
  });
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
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [showDetailsPane, setShowDetailsPane] = useState(false);
  const [showSidecarFiles, setShowSidecarFiles] = useState(false);
  const [timelineItems, setTimelineItems] = useState<TimelineMediaItem[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [preloadVisibleThumbs, setPreloadVisibleThumbs] = useState(true);
  const [timelineThumbByPath, setTimelineThumbByPath] = useState<Record<string, string>>({});
  const [timelineHoverPreview, setTimelineHoverPreview] = useState<TimelineHoverPreview | null>(null);
  const [timelineGapMode, setTimelineGapMode] = useState<TimelineGapMode>("auto");
  const [manualSequenceGapMs, setManualSequenceGapMs] = useState(90_000);
  const [manualSessionGapMs, setManualSessionGapMs] = useState(10 * 60_000);
  const [forcedSequenceBreaks, setForcedSequenceBreaks] = useState<string[]>([]);
  const [suppressedSequenceBreaks, setSuppressedSequenceBreaks] = useState<string[]>([]);
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<string[]>([]);
  const [sessionLabels, setSessionLabels] = useState<Record<string, string>>({});
  const [contextMenuFilePath, setContextMenuFilePath] = useState<string | null>(null);
  const [contextMenuTagOpen, setContextMenuTagOpen] = useState(false);
  const [contextMenuFocusIndex, setContextMenuFocusIndex] = useState(0);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 120, y: 120 });
  const [editTagsFilePath, setEditTagsFilePath] = useState<string | null>(null);
  const [editTagsText, setEditTagsText] = useState("");
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
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const prewarmStartedForRef = useRef<string | null>(null);
  const loadingTimelineThumbsRef = useRef(new Set<string>());
  const queuedTimelineThumbsRef = useRef(new Set<string>());
  const timelineThumbQueueRef = useRef<Array<{ relativePath: string; kind: "image" | "video"; priority: number; order: number }>>([]);
  const timelineThumbQueueOrderRef = useRef(0);
  const timelineThumbWorkersRef = useRef(0);
  const timelineThumbPreloadRafRef = useRef<number | null>(null);

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
    const withoutSidecars = showSidecarFiles
      ? raw
      : raw.filter((file) => {
          const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
          return !SIDECAR_EXTS.has(ext);
        });
    const filtered = query
      ? withoutSidecars.filter((file) =>
          file.name.toLowerCase().includes(query) ||
          file.relativePath.toLowerCase().includes(query) ||
          fileKind(file).toLowerCase().includes(query),
        )
      : withoutSidecars;

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
  }, [selectedDayNode, searchQuery, sortColumn, sortDirection, tagEntryByPath, groupLabelById, showSidecarFiles]);

  const visibleTimelineItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? timelineItems.filter((item) =>
          item.name.toLowerCase().includes(query) ||
          item.relativePath.toLowerCase().includes(query) ||
          item.kind.toLowerCase().includes(query),
        )
      : timelineItems;

    return [...filtered].sort((left, right) =>
      left.timestampMs - right.timestampMs || left.relativePath.localeCompare(right.relativePath),
    );
  }, [timelineItems, searchQuery]);

  const suggestedThresholds = useMemo(
    () => suggestTimelineThresholds(visibleTimelineItems),
    [visibleTimelineItems],
  );

  const effectiveSequenceGapMs = timelineGapMode === "auto" ? suggestedThresholds.sequenceGapMs : manualSequenceGapMs;
  const effectiveSessionGapMs = timelineGapMode === "auto" ? suggestedThresholds.sessionGapMs : manualSessionGapMs;

  const timelineSequences = useMemo(
    () => buildTimelineSequences(
      visibleTimelineItems,
      effectiveSequenceGapMs,
      effectiveSessionGapMs,
      new Set(forcedSequenceBreaks),
      new Set(suppressedSequenceBreaks),
    ),
    [visibleTimelineItems, effectiveSequenceGapMs, effectiveSessionGapMs, forcedSequenceBreaks, suppressedSequenceBreaks],
  );

  const timelineSessions = useMemo(
    () => buildTimelineSessions(timelineSequences, sessionLabels),
    [timelineSequences, sessionLabels],
  );

  const renderTimelineItems = visibleTimelineItems;

  const timelineItemIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    visibleTimelineItems.forEach((item, index) => map.set(item.relativePath, index));
    return map;
  }, [visibleTimelineItems]);

  const timelineLayout = useMemo(() => {
    if (renderTimelineItems.length === 0) {
      return null;
    }

    const minMs = Math.min(...renderTimelineItems.map((item) => item.timestampMs));
    const maxMs = Math.max(...renderTimelineItems.map((item) => item.endTimestampMs));
    const spanMs = Math.max(60_000, maxMs - minMs);
    const spanMinutes = spanMs / 60_000;
    const pxPerMinute = clamp((1100 / Math.max(spanMinutes, 45)) * timelineZoom, 8, 64);
    const baseHeight = Math.max(820, spanMinutes * pxPerMinute + 140);
    const topPadding = 60;
    const pxPerMs = (baseHeight - topPadding * 2) / spanMs;

    const laneBottoms: [number, number] = [topPadding, topPadding];
    const items: TimelineLayoutItem[] = [];
    for (const sequence of timelineSequences) {
      sequence.items.forEach((item, itemIndex) => {
        const lane = ((sequence.sessionIndex + itemIndex) % 2) as 0 | 1;
        const markerTop = topPadding + (item.timestampMs - minMs) * pxPerMs;
        const markerHeight = Math.max(item.durationMs ? item.durationMs * pxPerMs : 0, item.kind === "video" ? 16 : 10);
        const cardHeight = item.kind === "video" ? 96 : 76;
        const desiredTop = markerTop - cardHeight / 2;
        const cardTop = Math.max(desiredTop, laneBottoms[lane]);
        laneBottoms[lane] = cardTop + cardHeight + 14;

        items.push({
          item,
          lane,
          markerTop,
          markerHeight,
          cardTop,
          sequenceIndex: sequence.sequenceIndex,
          sessionIndex: sequence.sessionIndex,
        });
      });
    }

    const packedBottom = Math.max(laneBottoms[0], laneBottoms[1]) + 56;
    const height = Math.max(baseHeight, packedBottom);

    const tickIntervalMinutes = spanMinutes <= 30 ? 5 : spanMinutes <= 120 ? 10 : 15;
    const tickIntervalMs = tickIntervalMinutes * 60_000;
    const tickStartMs = Math.floor(minMs / tickIntervalMs) * tickIntervalMs;
    const ticks: Array<{ label: string; top: number }> = [];
    for (let tickMs = tickStartMs; tickMs <= maxMs + tickIntervalMs; tickMs += tickIntervalMs) {
      const top = topPadding + (tickMs - minMs) * pxPerMs;
      if (top >= 0 && top <= height) {
        ticks.push({ label: formatTimelineTick(tickMs), top });
      }
    }

    return { minMs, maxMs, height, topPadding, items, ticks, pxPerMs };
  }, [timelineSequences, renderTimelineItems, timelineZoom]);

  const selectedPreviewFile = useMemo(() => {
    const fromFiles = files.find((file) => file.relativePath === selectedPreviewPath);
    if (fromFiles) {
      return fromFiles;
    }

    const fromTimeline = timelineItems.find((item) => item.relativePath === selectedPreviewPath);
    if (!fromTimeline) {
      return null;
    }

    return {
      relativePath: fromTimeline.relativePath,
      name: fromTimeline.name,
      size: fromTimeline.size,
      isImage: fromTimeline.kind === "image",
      isVideo: fromTimeline.kind === "video",
    };
  }, [files, selectedPreviewPath, timelineItems]);

  const contextMenuFile = useMemo(
    () => files.find((file) => file.relativePath === contextMenuFilePath)
      ?? timelineItems.find((file) => file.relativePath === contextMenuFilePath)
      ?? null,
    [files, contextMenuFilePath, timelineItems],
  );

  const selectionOrder = useMemo(
    () => (viewMode === "timeline" ? renderTimelineItems.map((item) => item.relativePath) : files.map((file) => file.relativePath)),
    [files, viewMode, renderTimelineItems],
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
        viewMode?: ViewMode;
        showDetailsPane?: boolean;
        columnWidths?: Partial<ColumnWidths>;
        leftPaneWidth?: number;
        rightPaneWidth?: number;
        showSidecarFiles?: boolean;
        timelineGapMode?: TimelineGapMode;
        timelineZoom?: number;
        preloadVisibleThumbs?: boolean;
        manualSequenceGapMs?: number;
        manualSessionGapMs?: number;
        forcedSequenceBreaks?: string[];
        suppressedSequenceBreaks?: string[];
        collapsedSessionIds?: string[];
        sessionLabels?: Record<string, string>;
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
      if (parsed.viewMode === "list" || parsed.viewMode === "timeline") {
        setViewMode(parsed.viewMode);
      }
      if (typeof parsed.showDetailsPane === "boolean") {
        setShowDetailsPane(parsed.showDetailsPane);
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
      if (typeof parsed.showSidecarFiles === "boolean") {
        setShowSidecarFiles(parsed.showSidecarFiles);
      }
      if (parsed.timelineGapMode === "auto" || parsed.timelineGapMode === "manual") {
        setTimelineGapMode(parsed.timelineGapMode);
      }
      if (typeof parsed.timelineZoom === "number") {
        setTimelineZoom(clamp(parsed.timelineZoom, 0.5, 2.5));
      }
      if (typeof parsed.preloadVisibleThumbs === "boolean") {
        setPreloadVisibleThumbs(parsed.preloadVisibleThumbs);
      }
      if (typeof parsed.manualSequenceGapMs === "number") {
        setManualSequenceGapMs(parsed.manualSequenceGapMs);
      }
      if (typeof parsed.manualSessionGapMs === "number") {
        setManualSessionGapMs(parsed.manualSessionGapMs);
      }
      if (Array.isArray(parsed.forcedSequenceBreaks)) {
        setForcedSequenceBreaks(parsed.forcedSequenceBreaks.filter((value): value is string => typeof value === "string"));
      }
      if (Array.isArray(parsed.suppressedSequenceBreaks)) {
        setSuppressedSequenceBreaks(parsed.suppressedSequenceBreaks.filter((value): value is string => typeof value === "string"));
      }
      if (Array.isArray(parsed.collapsedSessionIds)) {
        setCollapsedSessionIds(parsed.collapsedSessionIds.filter((value): value is string => typeof value === "string"));
      }
      if (parsed.sessionLabels && typeof parsed.sessionLabels === "object") {
        setSessionLabels(parsed.sessionLabels);
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
      viewMode,
      showDetailsPane,
      columnWidths,
      leftPaneWidth,
      rightPaneWidth,
      showSidecarFiles,
      timelineGapMode,
      timelineZoom,
      preloadVisibleThumbs,
      manualSequenceGapMs,
      manualSessionGapMs,
      forcedSequenceBreaks,
      suppressedSequenceBreaks,
      collapsedSessionIds,
      sessionLabels,
    };
    try {
      window.localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(payload));
    } catch {
    }
  }, [searchQuery, sortColumn, sortDirection, density, viewMode, showDetailsPane, columnWidths, leftPaneWidth, rightPaneWidth, showSidecarFiles, timelineGapMode, timelineZoom, preloadVisibleThumbs, manualSequenceGapMs, manualSessionGapMs, forcedSequenceBreaks, suppressedSequenceBreaks, collapsedSessionIds, sessionLabels]);

  useEffect(() => {
    if (!stagingDir || !selectedDay?.relativePath) {
      setTimelineItems([]);
      return;
    }

    let cancelled = false;
    setTimelineLoading(true);

    void invoke<TimelineMediaItem[]>("load_staging_timeline", {
      stagingDir,
      relativeDir: selectedDay.relativePath,
    })
      .then((items) => {
        if (!cancelled) {
          setTimelineItems(items);
        }
      })
      .catch((timelineError) => {
        if (!cancelled) {
          setTimelineItems([]);
          setError(String(timelineError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTimelineLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [stagingDir, selectedDay?.relativePath]);

  useEffect(() => {
    setTimelineThumbByPath({});
    setTimelineHoverPreview(null);
    loadingTimelineThumbsRef.current.clear();
    queuedTimelineThumbsRef.current.clear();
    timelineThumbQueueRef.current = [];
    timelineThumbQueueOrderRef.current = 0;
    timelineThumbWorkersRef.current = 0;
  }, [selectedDayPath]);

  useEffect(() => {
    schedulePreloadVisibleTimelineThumbs();
  }, [timelineLayout, viewMode, preloadVisibleThumbs, timelineZoom]);

  useEffect(() => () => {
    if (timelineThumbPreloadRafRef.current !== null) {
      window.cancelAnimationFrame(timelineThumbPreloadRafRef.current);
      timelineThumbPreloadRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!stagingDir || directories.length === 0) {
      return;
    }

    if (prewarmStartedForRef.current === stagingDir) {
      return;
    }
    prewarmStartedForRef.current = stagingDir;

    const timer = window.setTimeout(() => {
      void invoke<number>("prewarm_staging_timeline_cache", { stagingDir }).catch(() => {
      });
    }, 1400);

    return () => window.clearTimeout(timer);
  }, [stagingDir, directories.length]);

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
        setCheckedPaths(selectionOrder);
        if (selectionOrder.length > 0) {
          setLastCheckedPath(selectionOrder[selectionOrder.length - 1]);
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
  }, [selectionOrder, contextMenuFilePath, contextMenuFocusIndex]);

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
    const fileIndex = selectionOrder.findIndex((relativePath) => relativePath === path);

    setCheckedPaths((current) => {
      if (useRange && lastCheckedPath) {
        const anchorIndex = selectionOrder.findIndex((relativePath) => relativePath === lastCheckedPath);
        if (anchorIndex >= 0 && fileIndex >= 0) {
          const start = Math.min(anchorIndex, fileIndex);
          const end = Math.max(anchorIndex, fileIndex);
          const rangePaths = selectionOrder.slice(start, end + 1);
          const next = new Set(current);
          for (const rangePath of rangePaths) {
            if (checked) {
              next.add(rangePath);
            } else {
              next.delete(rangePath);
            }
          }
          return selectionOrder.filter((relativePath) => next.has(relativePath));
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

  function onRowClick(filePath: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
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

  async function openFileInExternalViewer(relativePath: string) {
    if (!stagingDir) {
      return;
    }

    try {
      await invoke("open_with_default_app", { path: toAbsolutePath(relativePath) });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openSelectedPreviewExternally() {
    if (!selectedPreviewFile) {
      return;
    }

    await openFileInExternalViewer(selectedPreviewFile.relativePath);
  }

  function selectSameGroup(relativePath: string) {
    const primaryGroupId = tagEntryByPath.get(relativePath)?.groupIds[0] ?? null;
    if (!primaryGroupId) {
      return;
    }

    const sameGroup = files
      .map((file) => file.relativePath)
      .filter((relativePath) => (tagEntryByPath.get(relativePath)?.groupIds ?? []).includes(primaryGroupId));
    const visibleSameGroup = selectionOrder.filter((relativePath) => sameGroup.includes(relativePath));
    setCheckedPaths(visibleSameGroup.length > 0 ? visibleSameGroup : sameGroup);
    setLastCheckedPath(visibleSameGroup.length > 0 ? visibleSameGroup[visibleSameGroup.length - 1] : sameGroup.length > 0 ? sameGroup[sameGroup.length - 1] : null);
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

  function openEditTagsForFile(relativePath: string) {
    const existing = tagEntryByPath.get(relativePath);
    setEditTagsText(existing?.tags.join(", ") ?? "");
    setEditTagsFilePath(relativePath);
    setContextMenuFilePath(null);
    setContextMenuTagOpen(false);
    setContextMenuFocusIndex(0);
  }

  async function saveEditedTags() {
    if (!editTagsFilePath || !stagingDir) {
      return;
    }

    const parsedTags = normalizeTagList(editTagsText.split(","));
    setError(null);
    try {
      const nextState = await invoke<StagingTagsState>("set_file_staging_tags", {
        stagingDir,
        relativePath: editTagsFilePath,
        tags: parsedTags,
      });
      setTagsState(nextState);
      setMessage(parsedTags.length === 0 ? "Tags cleared." : "Tags updated.");
    } catch (e) {
      setError(String(e));
    } finally {
      setEditTagsFilePath(null);
      setEditTagsText("");
    }
  }

  async function deleteTagsForFile(relativePath: string) {
    if (!stagingDir) {
      return;
    }

    setContextMenuFilePath(null);
    setContextMenuTagOpen(false);
    setContextMenuFocusIndex(0);
    setError(null);
    try {
      const nextState = await invoke<StagingTagsState>("set_file_staging_tags", {
        stagingDir,
        relativePath,
        tags: [],
      });
      setTagsState(nextState);
      setMessage("Tags cleared.");
    } catch (e) {
      setError(String(e));
    }
  }

  function splitSequenceBefore(relativePath: string) {
    setForcedSequenceBreaks((current) => (current.includes(relativePath) ? current : [...current, relativePath]));
    setSuppressedSequenceBreaks((current) => current.filter((value) => value !== relativePath));
  }

  function mergeSequenceWithPrevious(relativePath: string) {
    setSuppressedSequenceBreaks((current) => (current.includes(relativePath) ? current : [...current, relativePath]));
    setForcedSequenceBreaks((current) => current.filter((value) => value !== relativePath));
  }

  function clearSequenceOverride(relativePath: string) {
    setForcedSequenceBreaks((current) => current.filter((value) => value !== relativePath));
    setSuppressedSequenceBreaks((current) => current.filter((value) => value !== relativePath));
  }

  function toggleSessionCollapsed(sessionId: string) {
    setCollapsedSessionIds((current) => current.includes(sessionId)
      ? current.filter((value) => value !== sessionId)
      : [...current, sessionId]);
  }

  function selectSession(session: TimelineSession) {
    const paths = session.items.map((item) => item.relativePath).filter((path) => selectionOrder.includes(path));
    setCheckedPaths(paths);
    setLastCheckedPath(paths.length > 0 ? paths[paths.length - 1] : null);
  }

  async function tagSession(session: TimelineSession) {
    const parsedTags = normalizeTagList(tagText.split(","));
    if (!stagingDir || parsedTags.length === 0) {
      setError("Enter one or more tags before tagging a session.");
      return;
    }

    setError(null);
    try {
      const nextState = await invoke<StagingTagsState>("apply_staging_tags", {
        stagingDir,
        relativePaths: session.items.map((item) => item.relativePath),
        tags: parsedTags,
        createGroup: false,
        groupLabel: null,
      });
      setTagsState(nextState);
      setMessage(`Applied tags to ${session.label}.`);
    } catch (e) {
      setError(String(e));
    }
  }

  function resetTimelineOverrides() {
    setForcedSequenceBreaks([]);
    setSuppressedSequenceBreaks([]);
    setCollapsedSessionIds([]);
  }

  function setZoomLevel(nextZoom: number) {
    setTimelineZoom(clamp(nextZoom, 0.5, 2.5));
  }

  function nudgeZoom(delta: number) {
    setTimelineZoom((current) => clamp(current + delta, 0.5, 2.5));
  }

  function processTimelineThumbQueue() {
    const maxWorkers = 3;

    while (timelineThumbWorkersRef.current < maxWorkers && timelineThumbQueueRef.current.length > 0) {
      const next = timelineThumbQueueRef.current.shift();
      if (!next || !stagingDir) {
        continue;
      }

      queuedTimelineThumbsRef.current.delete(next.relativePath);
      if (timelineThumbByPath[next.relativePath] || loadingTimelineThumbsRef.current.has(next.relativePath)) {
        continue;
      }

      timelineThumbWorkersRef.current += 1;
      loadingTimelineThumbsRef.current.add(next.relativePath);

      const path = toAbsolutePath(next.relativePath);
      const command = next.kind === "video" ? "read_video_thumbnail_base64" : "read_image_thumbnail_base64";
      const payload = next.kind === "video"
        ? { path, maxWidth: 220, maxHeight: 140 }
        : { path, maxWidth: 220, maxHeight: 140, quality: 68 };

      void invoke<string>(command, payload)
        .then((base64) => {
          setTimelineThumbByPath((current) => ({
            ...current,
            [next.relativePath]: `data:image/jpeg;base64,${base64}`,
          }));
        })
        .catch(() => {
        })
        .finally(() => {
          loadingTimelineThumbsRef.current.delete(next.relativePath);
          timelineThumbWorkersRef.current = Math.max(0, timelineThumbWorkersRef.current - 1);
          processTimelineThumbQueue();
        });
    }
  }

  function enqueueTimelineThumb(relativePath: string, kind: "image" | "video", priority = 1) {
    if (!stagingDir || timelineThumbByPath[relativePath] || loadingTimelineThumbsRef.current.has(relativePath) || queuedTimelineThumbsRef.current.has(relativePath)) {
      return;
    }

    queuedTimelineThumbsRef.current.add(relativePath);
    timelineThumbQueueRef.current.push({
      relativePath,
      kind,
      priority,
      order: timelineThumbQueueOrderRef.current,
    });
    timelineThumbQueueOrderRef.current += 1;
    timelineThumbQueueRef.current.sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return left.order - right.order;
    });

    processTimelineThumbQueue();
  }

  function preloadVisibleTimelineThumbs() {
    if (!preloadVisibleThumbs || viewMode !== "timeline" || !timelineLayout || !timelineViewportRef.current) {
      return;
    }

    const viewport = timelineViewportRef.current;
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewportTop + viewport.clientHeight;
    const buffer = 320;

    for (const layoutItem of timelineLayout.items) {
      const cardTop = layoutItem.cardTop;
      const cardBottom = layoutItem.cardTop + (layoutItem.item.kind === "video" ? 96 : 76);
      if (cardBottom < viewportTop - buffer || cardTop > viewportBottom + buffer) {
        continue;
      }

      const kind = layoutItem.item.kind as "image" | "video";
      // Bias toward still images during passive prefetch, then videos.
      enqueueTimelineThumb(layoutItem.item.relativePath, kind, kind === "image" ? 2 : 1);
    }
  }

  function schedulePreloadVisibleTimelineThumbs() {
    if (timelineThumbPreloadRafRef.current !== null) {
      window.cancelAnimationFrame(timelineThumbPreloadRafRef.current);
    }
    timelineThumbPreloadRafRef.current = window.requestAnimationFrame(() => {
      timelineThumbPreloadRafRef.current = null;
      preloadVisibleTimelineThumbs();
    });
  }

  function loadTimelineThumb(relativePath: string, kind: "image" | "video", priority = 3) {
    enqueueTimelineThumb(relativePath, kind, priority);
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

  const activeItemCount = viewMode === "timeline" ? renderTimelineItems.length : files.length;
  const sessionCount = timelineSessions.length;
  const timelineDynamicCss = useMemo(() => {
    if (!timelineLayout) {
      return "";
    }

    const rules: string[] = [`.staging-timeline-day{height:${timelineLayout.height}px;}`];
    timelineLayout.ticks.forEach((tick, index) => {
      rules.push(`.timeline-tick-${index}{top:${tick.top}px;}`);
    });
    timelineSequences.forEach((sequence, index) => {
      const top = timelineLayout.topPadding + (sequence.startMs - timelineLayout.minMs) * timelineLayout.pxPerMs;
      const bottom = timelineLayout.topPadding + (sequence.endMs - timelineLayout.minMs) * timelineLayout.pxPerMs;
      rules.push(`.timeline-sequence-${index}{top:${top}px;height:${Math.max(26, bottom - top)}px;}`);
    });
    timelineLayout.items.forEach((layoutItem, index) => {
      rules.push(`.timeline-marker-${index}{top:${layoutItem.markerTop}px;height:${layoutItem.markerHeight}px;}`);
      rules.push(`.timeline-card-${index}{top:${layoutItem.cardTop}px;animation-delay:${index * 28}ms;}`);
      rules.push(`.timeline-connector-${index}{top:${layoutItem.markerTop - layoutItem.cardTop + 6}px;}`);
    });
    return rules.join("\n");
  }, [timelineLayout, timelineSequences]);

  const timelineHoverPreviewCss = useMemo(() => {
    if (!timelineHoverPreview) {
      return "";
    }

    const x = Math.min(window.innerWidth - 340, timelineHoverPreview.x + 18);
    const y = Math.min(window.innerHeight - 260, timelineHoverPreview.y + 18);
    return `.staging-timeline-hover-preview{left:${x}px;top:${y}px;}`;
  }, [timelineHoverPreview]);

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
                className={`px-2 py-1.5 text-xs ${viewMode === "timeline" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setViewMode("timeline")}
                type="button"
              >
                Timeline
              </button>
              <button
                className={`px-2 py-1.5 text-xs border-l border-surface-600 ${viewMode === "list" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setViewMode("list")}
                type="button"
              >
                List
              </button>
            </div>
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
            <button
              className={`px-3 py-1.5 text-xs rounded border ${showSidecarFiles ? "border-accent bg-accent/20 text-white" : "border-surface-600 bg-surface-900 text-gray-400"}`}
              onClick={() => setShowSidecarFiles((v) => !v)}
              title="Toggle visibility of sidecar files (.xmp, .aae, .md5, etc.)"
              type="button"
            >
              Show Sidecars
            </button>
            <button
              className={`px-3 py-1.5 text-xs rounded border ${showDetailsPane ? "border-accent bg-accent/20 text-white" : "border-surface-600 bg-surface-900 text-gray-400"}`}
              onClick={() => setShowDetailsPane((current) => !current)}
              title="Show or hide the details pane"
              type="button"
            >
              {showDetailsPane ? "Hide Details" : "Show Details"}
            </button>
            <div className="ml-auto text-xs text-gray-500">
              {viewMode === "timeline" ? `Timeline items: ${activeItemCount} • Sequences: ${timelineSequences.length} • Sessions: ${sessionCount}` : `Items: ${activeItemCount}`} • Checked: {checkedPaths.length}
            </div>
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

          <section className="staging-explorer-pane-center min-h-0 flex flex-col overflow-hidden">
            <div className="staging-explorer-grid-scope h-full min-h-0 flex flex-col">
              <div className={`flex-1 min-h-0 ${viewMode === "timeline" ? "overflow-hidden" : "overflow-auto"}`}>
                {viewMode === "list" ? (
                  <>
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
                  </>
                ) : timelineLoading ? (
                  <div className="p-6 text-sm text-gray-400">Analyzing media timestamps and video durations...</div>
                ) : !timelineLayout || visibleTimelineItems.length === 0 ? (
                  <div className="p-6 text-sm text-gray-500">No photos or videos were found for the current day.</div>
                ) : (
                  <div
                    className="staging-timeline-viewport h-full overflow-auto px-2 py-2"
                    ref={timelineViewportRef}
                    onScroll={() => schedulePreloadVisibleTimelineThumbs()}
                    onWheel={(event) => {
                      if (!event.ctrlKey) {
                        return;
                      }

                      event.preventDefault();
                      const delta = event.deltaY < 0 ? 0.08 : -0.08;
                      nudgeZoom(delta);
                    }}
                    title="Scroll to move timeline. Use Ctrl + Mouse Wheel to zoom."
                  >
                  <div className="staging-timeline-shell px-4 py-5">
                    {timelineDynamicCss && <style>{timelineDynamicCss}</style>}
                    <div className="mb-4 rounded-2xl border border-surface-700 bg-surface-850/75 p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-gray-400">Sequence Detector</div>
                        <div className="flex items-center rounded-md border border-surface-600 overflow-hidden">
                          <button
                            className={`px-2 py-1.5 text-xs ${timelineGapMode === "auto" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                            onClick={() => setTimelineGapMode("auto")}
                            type="button"
                          >
                            Auto
                          </button>
                          <button
                            className={`px-2 py-1.5 text-xs border-l border-surface-600 ${timelineGapMode === "manual" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                            onClick={() => setTimelineGapMode("manual")}
                            type="button"
                          >
                            Manual
                          </button>
                        </div>
                        <label className="text-xs text-gray-400">
                          Sequence gap (sec)
                          <input
                            className="input-field mt-1 h-8 text-xs"
                            type="number"
                            min={15}
                            max={600}
                            step={5}
                            value={Math.round(manualSequenceGapMs / 1000)}
                            disabled={timelineGapMode === "auto"}
                            onChange={(event) => setManualSequenceGapMs(Math.max(15_000, Number(event.target.value || 15) * 1000))}
                          />
                        </label>
                        <label className="text-xs text-gray-400">
                          Session gap (min)
                          <input
                            className="input-field mt-1 h-8 text-xs"
                            type="number"
                            min={1}
                            max={120}
                            step={1}
                            value={Math.round(manualSessionGapMs / 60_000)}
                            disabled={timelineGapMode === "auto"}
                            onChange={(event) => setManualSessionGapMs(Math.max(60_000, Number(event.target.value || 1) * 60_000))}
                          />
                        </label>
                        <div className="text-xs text-gray-500">
                          Auto suggests {Math.round(suggestedThresholds.sequenceGapMs / 1000)}s and {Math.round(suggestedThresholds.sessionGapMs / 60_000)}m
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          <span className="text-xs text-gray-400">Zoom</span>
                          <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => nudgeZoom(-0.1)}>-</button>
                          <input
                            className="w-28"
                            type="range"
                            min={0.5}
                            max={2.5}
                            step={0.05}
                            value={timelineZoom}
                            onChange={(event) => setZoomLevel(Number(event.target.value))}
                            title="Timeline zoom"
                          />
                          <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => nudgeZoom(0.1)}>+</button>
                          <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => setZoomLevel(1)}>100%</button>
                          <span className="text-xs text-gray-300 w-12 text-right">{Math.round(timelineZoom * 100)}%</span>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-gray-300">
                          <input
                            type="checkbox"
                            checked={preloadVisibleThumbs}
                            onChange={(event) => setPreloadVisibleThumbs(event.target.checked)}
                            className="h-4 w-4"
                          />
                          Preload visible thumbs
                        </label>
                        <button className="btn-secondary px-3 py-1.5 text-xs" onClick={resetTimelineOverrides} type="button">
                          Reset Overrides
                        </button>
                      </div>
                    </div>

                    <div className="mb-4 grid gap-3 xl:grid-cols-2">
                      {timelineSessions.map((session) => {
                        const collapsed = collapsedSessionIds.includes(session.id);
                        return (
                          <div key={session.id} className="rounded-2xl border border-surface-700 bg-surface-850/70 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                className="input-field h-8 max-w-[220px] text-sm"
                                value={sessionLabels[session.id] ?? session.label}
                                onChange={(event) => setSessionLabels((current) => ({ ...current, [session.id]: event.target.value }))}
                                placeholder={`Session ${session.sessionIndex + 1}`}
                              />
                              <div className="text-xs text-gray-400">{formatTimelineTick(session.startMs)} to {formatTimelineTick(session.endMs)}</div>
                              <button className="btn-secondary px-3 py-1.5 text-xs ml-auto" type="button" onClick={() => toggleSessionCollapsed(session.id)}>
                                {collapsed ? "Expand" : "Collapse"}
                              </button>
                              <button className="btn-secondary px-3 py-1.5 text-xs" type="button" onClick={() => selectSession(session)}>
                                Select
                              </button>
                              <button className="btn-secondary px-3 py-1.5 text-xs" type="button" onClick={() => void tagSession(session)}>
                                Tag Session
                              </button>
                            </div>
                            <div className="mt-2 text-xs text-gray-500">
                              {session.sequences.length} sequence{session.sequences.length === 1 ? "" : "s"} • {session.items.length} item{session.items.length === 1 ? "" : "s"}
                            </div>
                            {!collapsed && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {session.sequences.map((sequence) => {
                                const breakPath = sequence.breakBeforePath;
                                const hasForcedBreak = breakPath ? forcedSequenceBreaks.includes(breakPath) : false;
                                const hasSuppressedBreak = breakPath ? suppressedSequenceBreaks.includes(breakPath) : false;
                                return (
                                  <div key={sequence.id} className="rounded-xl border border-surface-700 bg-surface-900/80 px-3 py-2 text-xs text-gray-300">
                                    <div className="font-medium text-white">{formatTimelineTick(sequence.startMs)} to {formatTimelineTick(sequence.endMs)}</div>
                                    <div className="mt-1 text-gray-500">{sequence.items.length} item{sequence.items.length === 1 ? "" : "s"}</div>
                                    {breakPath && (
                                      <div className="mt-2 flex gap-2">
                                        <button className="btn-secondary px-2 py-1 text-[11px]" type="button" onClick={() => mergeSequenceWithPrevious(breakPath)}>
                                          Merge Prev
                                        </button>
                                        <button className="btn-secondary px-2 py-1 text-[11px]" type="button" onClick={() => splitSequenceBefore(breakPath)}>
                                          Split Here
                                        </button>
                                        {(hasForcedBreak || hasSuppressedBreak) && (
                                          <button className="btn-secondary px-2 py-1 text-[11px]" type="button" onClick={() => clearSequenceOverride(breakPath)}>
                                            Clear
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mb-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-xl border border-surface-700 bg-surface-850/70 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-cyan-300/80">Detected Sessions</div>
                        <div className="mt-1 text-2xl font-semibold text-white">{sessionCount}</div>
                        <div className="text-xs text-gray-400">Large gaps create new match blocks.</div>
                      </div>
                      <div className="rounded-xl border border-surface-700 bg-surface-850/70 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-emerald-300/80">Detected Sequences</div>
                        <div className="mt-1 text-2xl font-semibold text-white">{timelineSequences.length}</div>
                        <div className="text-xs text-gray-400">Short gaps keep clips together inside a sequence.</div>
                      </div>
                      <div className="rounded-xl border border-surface-700 bg-surface-850/70 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-amber-300/80">Covered Range</div>
                        <div className="mt-1 text-sm font-semibold text-white">{formatTimelineTick(timelineLayout.minMs)} to {formatTimelineTick(timelineLayout.maxMs)}</div>
                        <div className="text-xs text-gray-400">Video bars use measured duration from ffprobe when available.</div>
                      </div>
                    </div>

                    <div className="staging-timeline staging-timeline-day rounded-[28px] border border-surface-700 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_transparent_36%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(2,6,23,0.92))]">
                      <div className="staging-timeline-axis" />

                      {timelineLayout.ticks.map((tick, index) => (
                        <div key={`${tick.label}-${tick.top}`} className={`staging-timeline-tick timeline-tick-${index}`}>
                          <div className="staging-timeline-tick-label">{tick.label}</div>
                        </div>
                      ))}

                      {timelineSequences.map((sequence, index) => (
                        <div key={sequence.id} className={`staging-timeline-sequence timeline-sequence-${index}`}>
                          <div className="staging-timeline-sequence-label">
                            <span>Session {sequence.sessionIndex + 1}</span>
                            <span>Sequence {sequence.sequenceIndex + 1}</span>
                            <span>{sequence.items.length} item{sequence.items.length === 1 ? "" : "s"}</span>
                          </div>
                        </div>
                      ))}

                      {timelineLayout.items.map((layoutItem, index) => {
                        const entry = tagEntryByPath.get(layoutItem.item.relativePath);
                        const checked = checkedPaths.includes(layoutItem.item.relativePath);
                        const selectedPreview = selectedPreviewPath === layoutItem.item.relativePath;
                        const primaryGroupId = entry?.groupIds[0] ?? null;
                        const groupLabel = primaryGroupId ? (groupLabelById.get(primaryGroupId) ?? primaryGroupId) : null;
                        const kind = layoutItem.item.kind as "image" | "video";
                        const thumbSrc = timelineThumbByPath[layoutItem.item.relativePath] ?? null;

                        return (
                          <div key={layoutItem.item.relativePath}>
                            <div className={`staging-timeline-marker timeline-marker-${index} ${layoutItem.item.kind === "video" ? "is-video" : "is-image"}`} />
                            <div
                              className={`staging-timeline-card timeline-card-${index} ${selectedPreview ? "is-selected" : ""} ${layoutItem.lane === 0 ? "is-left" : "is-right"}`}
                              onMouseEnter={(event) => {
                                loadTimelineThumb(layoutItem.item.relativePath, kind, 4);
                                setTimelineHoverPreview({
                                  relativePath: layoutItem.item.relativePath,
                                  name: layoutItem.item.name,
                                  kind,
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                              onMouseMove={(event) => {
                                setTimelineHoverPreview((current) => current && current.relativePath === layoutItem.item.relativePath
                                  ? { ...current, x: event.clientX, y: event.clientY }
                                  : current);
                              }}
                              onMouseLeave={() => {
                                setTimelineHoverPreview((current) => current && current.relativePath === layoutItem.item.relativePath ? null : current);
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                openContextMenu(layoutItem.item.relativePath, event.clientX, event.clientY);
                                setSelectedPreviewPath(layoutItem.item.relativePath);
                              }}
                              title="Click to preview. Ctrl+Click toggles check. Shift+Click checks range."
                            >
                              <span className={`staging-timeline-card-connector timeline-connector-${index}`} />
                              <div className="flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    toggleFileSelection(layoutItem.item.relativePath, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey);
                                  }}
                                  onClick={(event) => event.stopPropagation()}
                                  className="mt-1 h-4 w-4 shrink-0"
                                  aria-label={`Select ${layoutItem.item.name}`}
                                />
                                <button
                                  type="button"
                                  className="staging-timeline-mini-thumb"
                                  onMouseEnter={() => loadTimelineThumb(layoutItem.item.relativePath, kind, 4)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onRowClick(layoutItem.item.relativePath, event);
                                  }}
                                  aria-label={`Preview ${layoutItem.item.name}`}
                                >
                                  {thumbSrc ? (
                                    <img src={thumbSrc} alt={layoutItem.item.name} className="staging-timeline-mini-thumb-img" loading="lazy" />
                                  ) : (
                                    <span className="staging-timeline-mini-thumb-fallback">{kind === "video" ? "VID" : "IMG"}</span>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="min-w-0 flex-1 text-left"
                                  onClick={(event) => onRowClick(layoutItem.item.relativePath, event)}
                                  title="Click to preview. Ctrl+Click toggles check. Shift+Click checks range."
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="truncate text-sm font-semibold text-white">{layoutItem.item.name}</div>
                                    <div className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ${layoutItem.item.kind === "video" ? "bg-cyan-400/15 text-cyan-200" : "bg-amber-300/15 text-amber-100"}`}>
                                      {layoutItem.item.kind}
                                    </div>
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
                                    <span>{formatClock(layoutItem.item.timestampMs)}</span>
                                    <span>{formatDuration(layoutItem.item.durationMs)}</span>
                                    <span>{formatSize(layoutItem.item.size)}</span>
                                  </div>
                                  <div className="mt-2 truncate text-[11px] text-gray-500">{layoutItem.item.relativePath}</div>
                                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                                    <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-emerald-200">{entry?.tags.length ? entry.tags.join(", ") : "No tags"}</span>
                                    {groupLabel && <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-amber-200">{groupLabel}</span>}
                                    <span className="rounded-full bg-surface-800 px-2 py-0.5 text-gray-300">{layoutItem.item.timestampSource}</span>
                                  </div>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {timelineHoverPreview && (
                      <div className="staging-timeline-hover-preview">
                        {timelineHoverPreviewCss && <style>{timelineHoverPreviewCss}</style>}
                        <div className="staging-timeline-hover-preview-head">
                          <span>{timelineHoverPreview.name}</span>
                          <span className="staging-timeline-hover-preview-kind">{timelineHoverPreview.kind}</span>
                        </div>
                        <div className="staging-timeline-hover-preview-body">
                          {timelineThumbByPath[timelineHoverPreview.relativePath] ? (
                            <img
                              src={timelineThumbByPath[timelineHoverPreview.relativePath]}
                              alt={timelineHoverPreview.name}
                              className="staging-timeline-hover-preview-img"
                            />
                          ) : (
                            <div className="staging-timeline-hover-preview-loading">Loading preview...</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  </div>
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
                  className="w-full text-left px-2 py-1.5 text-xs text-sky-300 hover:bg-surface-700 rounded disabled:opacity-40"
                  onClick={() => openEditTagsForFile(contextMenuFile.relativePath)}
                  disabled={!tagEntryByPath.get(contextMenuFile.relativePath)?.tags.length}
                >
                  ✏️ Edit Tags
                </button>
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-red-400 hover:bg-surface-700 rounded disabled:opacity-40"
                  onClick={() => deleteTagsForFile(contextMenuFile.relativePath)}
                  disabled={!tagEntryByPath.get(contextMenuFile.relativePath)?.tags.length}
                >
                  🗑 Delete Tags
                </button>

                <div className="my-1 border-t border-surface-700" role="separator" />
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-cyan-200 hover:bg-surface-700 rounded disabled:opacity-40"
                  onClick={() => {
                    mergeSequenceWithPrevious(contextMenuFile.relativePath);
                    setContextMenuFilePath(null);
                  }}
                  disabled={(timelineItemIndexByPath.get(contextMenuFile.relativePath) ?? 0) <= 0}
                >
                  ⤴ Merge Sequence With Previous
                </button>
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-cyan-200 hover:bg-surface-700 rounded disabled:opacity-40"
                  onClick={() => {
                    splitSequenceBefore(contextMenuFile.relativePath);
                    setContextMenuFilePath(null);
                  }}
                  disabled={(timelineItemIndexByPath.get(contextMenuFile.relativePath) ?? 0) <= 0}
                >
                  ⤵ Split Sequence Before This
                </button>
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-cyan-200 hover:bg-surface-700 rounded disabled:opacity-40"
                  onClick={() => {
                    clearSequenceOverride(contextMenuFile.relativePath);
                    setContextMenuFilePath(null);
                  }}
                  disabled={!forcedSequenceBreaks.includes(contextMenuFile.relativePath) && !suppressedSequenceBreaks.includes(contextMenuFile.relativePath)}
                >
                  ↺ Clear Sequence Override
                </button>

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

          {editTagsFilePath && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={(e) => { if (e.target === e.currentTarget) { setEditTagsFilePath(null); setEditTagsText(""); } }}>
              <div className="w-96 rounded-xl border border-surface-600 bg-surface-900 shadow-xl p-5 space-y-3">
                <div className="text-sm font-semibold text-white">Edit Tags</div>
                <div className="text-[11px] text-gray-400 break-all">{editTagsFilePath}</div>
                <input
                  className="input-field text-sm"
                  placeholder="Tags (comma-separated)"
                  value={editTagsText}
                  onChange={(e) => setEditTagsText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void saveEditedTags(); if (e.key === "Escape") { setEditTagsFilePath(null); setEditTagsText(""); } }}
                  autoFocus
                />
                <div className="text-[11px] text-gray-500">Leave blank and save to clear all tags from this file.</div>
                <div className="flex gap-2 justify-end">
                  <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => { setEditTagsFilePath(null); setEditTagsText(""); }}>Cancel</button>
                  <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => void saveEditedTags()}>Save</button>
                </div>
              </div>
            </div>
          )}

          {showDetailsPane && (
            <div
              className="staging-explorer-pane-resizer hidden xl:block"
              onMouseDown={(event) => onPaneResizeStart("right", event)}
              title="Drag to resize right pane"
              role="separator"
              aria-orientation="vertical"
            />
          )}

          {showDetailsPane && (
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
                    <button className="btn-secondary w-full" onClick={() => void openSelectedPreviewExternally()}>
                      Open In Default Viewer/Player
                    </button>
                    <div className="rounded-md border border-surface-700 bg-black min-h-56 flex items-center justify-center overflow-hidden">
                      {selectedPreviewFile.isImage && previewDataUrl ? (
                        <img
                          src={previewDataUrl}
                          alt={selectedPreviewFile.name}
                          className="max-h-[320px] max-w-full object-contain cursor-zoom-in"
                          onClick={() => void openSelectedPreviewExternally()}
                          title="Open in default viewer"
                        />
                      ) : selectedPreviewFile.isVideo ? (
                        <div className="text-sm text-gray-500 p-4 text-center">
                          Video selected. Inline video preview is not enabled yet.
                          <div className="mt-3">
                            <button className="btn-secondary" onClick={() => void openSelectedPreviewExternally()}>
                              Open Video In Player
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500 p-4 text-center">
                          No preview available for this file type.
                          <div className="mt-3">
                            <button className="btn-secondary" onClick={() => void openSelectedPreviewExternally()}>
                              Open File Externally
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-500">Select a file to preview.</div>
                )}
              </div>
            </div>
          </aside>
          )}
        </div>
      </div>
    </div>
  );
}
