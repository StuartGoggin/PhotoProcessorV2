import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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

function isGeneratedPreviewSidecarName(name: string): boolean {
  return name.toLowerCase().includes(".pgg.video-hover-preview.");
}

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
type MediaFilter = "videos" | "photos" | "all";
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
  laneSide: "left" | "right";
  laneDepth: 0 | 1;
  compact: boolean;
  cardHeight: number;
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

type TimelineSessionBand = {
  sessionId: string;
  sessionIndex: number;
  label: string;
  top: number;
  height: number;
  color: string;
  startMs: number;
  endMs: number;
};

type TimelineSessionBoundary = {
  boundaryIndex: number;
  top: number;
  gapMs: number;
  leftEndMs: number;
  rightStartMs: number;
  gapTop: number;
  gapHeight: number;
  leftSessionLabel: string;
  rightSessionLabel: string;
  leftSessionIndex: number;
  rightSessionIndex: number;
  currentBreakPath: string | null;
};

type TimelineSessionContextMenu = {
  sessionId: string;
  x: number;
  y: number;
  splitBreakPath: string | null;
  boundaryBreakPath: string | null;
  clearBreakPath: string | null;
};

type TimelineGapMode = "auto" | "manual";

type TimelineHoverPreview = {
  relativePath: string;
  name: string;
  kind: "image" | "video";
  x: number;
  y: number;
};

type TimelineGapHover = {
  boundaryIndex: number;
  x: number;
  y: number;
};

const VIEW_PREFS_KEY = "photogogo.stagingExplorer.viewPrefs.v1";

const SESSION_BAND_COLORS = [
  "rgba(56, 189, 248, 0.18)",
  "rgba(16, 185, 129, 0.18)",
  "rgba(251, 191, 36, 0.18)",
  "rgba(244, 114, 182, 0.18)",
  "rgba(168, 85, 247, 0.18)",
  "rgba(14, 165, 233, 0.18)",
];

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

function formatGapDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
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
      // A user-forced break always starts a new session so the session bands
      // visibly split. Auto-breaks only promote to a new session when the gap
      // exceeds the session threshold.
      if (forceBreak || sessionGap > sessionGapMs) {
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
      startMs: items.reduce((min, item) => Math.min(min, item.timestampMs), Infinity),
      endMs: items.reduce((max, item) => Math.max(max, item.endTimestampMs), -Infinity),
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
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("videos");
  const [showDetailsPane, setShowDetailsPane] = useState(false);
  const [showSidecarFiles, setShowSidecarFiles] = useState(false);
  const [timelineItems, setTimelineItems] = useState<TimelineMediaItem[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(0.6);
  const [timelineVirtualizationEnabled, setTimelineVirtualizationEnabled] = useState(true);
  const [alwaysCompactCards, setAlwaysCompactCards] = useState(false);
  const [preloadVisibleThumbs, setPreloadVisibleThumbs] = useState(false);
  const [autoPrewarmEnabled, setAutoPrewarmEnabled] = useState(false);
  const [timelineThumbByPath, setTimelineThumbByPath] = useState<Record<string, string>>({});
  const [timelineVideoPreviewByPath, setTimelineVideoPreviewByPath] = useState<Record<string, string>>({});
  const [timelineVideoPreviewLoadingByPath, setTimelineVideoPreviewLoadingByPath] = useState<Record<string, boolean>>({});
  const [timelineVideoPreviewErrorByPath, setTimelineVideoPreviewErrorByPath] = useState<Record<string, string>>({});
  const [timelineHoverPreview, setTimelineHoverPreview] = useState<TimelineHoverPreview | null>(null);
  const [timelineHoverVideoError, setTimelineHoverVideoError] = useState(false);
  const [timelineGapHover, setTimelineGapHover] = useState<TimelineGapHover | null>(null);
  const [timelineViewportRange, setTimelineViewportRange] = useState({ top: 0, height: 0 });
  const [timelineGapMode, setTimelineGapMode] = useState<TimelineGapMode>("auto");
  const [manualSequenceGapMs, setManualSequenceGapMs] = useState(90_000);
  const [manualSessionGapMs, setManualSessionGapMs] = useState(10 * 60_000);
  const [forcedSequenceBreaks, setForcedSequenceBreaks] = useState<string[]>([]);
  const [suppressedSequenceBreaks, setSuppressedSequenceBreaks] = useState<string[]>([]);
  const [sessionLabels, setSessionLabels] = useState<Record<string, string>>({});
  const [timelineSessionMenu, setTimelineSessionMenu] = useState<TimelineSessionContextMenu | null>(null);
  const [draggingBoundary, setDraggingBoundary] = useState<{
    boundaryIndex: number;
    currentBreakPath: string | null;
  } | null>(null);
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
  const thumbPrewarmStartedForRef = useRef(new Set<string>());
  const loadingTimelineThumbsRef = useRef(new Set<string>());
  const queuedTimelineThumbsRef = useRef(new Set<string>());
  const timelineThumbQueueRef = useRef<Array<{ relativePath: string; kind: "image" | "video"; priority: number; order: number }>>([]);
  const timelineThumbQueueOrderRef = useRef(0);
  const timelineThumbWorkersRef = useRef(0);
  const timelineScrollingRef = useRef(false);
  const timelineScrollIdleTimerRef = useRef<number | null>(null);
  const timelineThumbPreloadRafRef = useRef<number | null>(null);
  const timelineViewportRafRef = useRef<number | null>(null);
  const loadingTimelineVideoPreviewsRef = useRef(new Set<string>());

  const stagingDir = settings?.staging_dir ?? "";
  const previewWidth = Math.max(120, settings?.timeline_preview_width ?? 420);
  const previewHeight = Math.max(68, settings?.timeline_preview_height ?? 240);
  const previewFps = Math.max(2, Math.min(30, settings?.timeline_preview_fps ?? 8));

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
          return !SIDECAR_EXTS.has(ext) && !isGeneratedPreviewSidecarName(file.name);
        });
    const byMedia = mediaFilter === "videos"
      ? withoutSidecars.filter((file) => file.isVideo)
      : mediaFilter === "photos"
        ? withoutSidecars.filter((file) => file.isImage)
        : withoutSidecars;
    const filtered = query
      ? byMedia.filter((file) =>
          file.name.toLowerCase().includes(query) ||
          file.relativePath.toLowerCase().includes(query) ||
          fileKind(file).toLowerCase().includes(query),
        )
      : byMedia;

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
  }, [selectedDayNode, searchQuery, sortColumn, sortDirection, tagEntryByPath, groupLabelById, showSidecarFiles, mediaFilter]);

  const visibleTimelineItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const byMedia = mediaFilter === "videos"
      ? timelineItems.filter((item) => item.kind === "video")
      : mediaFilter === "photos"
        ? timelineItems.filter((item) => item.kind === "image")
        : timelineItems;
    const filtered = query
      ? byMedia.filter((item) =>
          item.name.toLowerCase().includes(query) ||
          item.relativePath.toLowerCase().includes(query) ||
          item.kind.toLowerCase().includes(query),
        )
      : byMedia;

    return [...filtered].sort((left, right) =>
      left.timestampMs - right.timestampMs || left.relativePath.localeCompare(right.relativePath),
    );
  }, [timelineItems, searchQuery, mediaFilter]);

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
    // Quadratic zoom curve so higher zoom values dramatically spread cards apart.
    // Cap raised to 800px/min so zoom can fully expand dense multi-hour days.
    const basePxPerMinute = 1100 / Math.max(spanMinutes, 45);
    const pxPerMinute = clamp(basePxPerMinute * Math.pow(timelineZoom, 2.5), 8, 800);
    const baseHeight = Math.max(820, spanMinutes * pxPerMinute + 140);
    const topPadding = 60;
    const pxPerMs = (baseHeight - topPadding * 2) / spanMs;
    const compactCards = alwaysCompactCards || timelineZoom < 0.9;
    const laneSpacing = compactCards ? 56 : 72;

    const items: TimelineLayoutItem[] = [];
    const lastTopByLane: [[number, number], [number, number]] = [[-100_000, -100_000], [-100_000, -100_000]];
    for (const sequence of timelineSequences) {
      sequence.items.forEach((item, itemIndex) => {
        const markerTop = topPadding + (item.timestampMs - minMs) * pxPerMs;
        const markerHeight = Math.max(item.durationMs ? item.durationMs * pxPerMs : 0, item.kind === "video" ? 16 : 10);
        const cardHeight = compactCards
          ? item.kind === "video" ? 76 : 62
          : item.kind === "video" ? 96 : 76;
        // Anchor cards to timeline time so they stay aligned with marker position.
        const desiredTop = markerTop - cardHeight / 2;
        const cardTop = clamp(desiredTop, 12, baseHeight - cardHeight - 12);

        // Adaptive lane spread: choose among 4 lanes (left/right x depth) to minimize overlap.
        let bestSide: 0 | 1 = ((sequence.sessionIndex + itemIndex) % 2) as 0 | 1;
        let bestDepth: 0 | 1 = 0;
        let bestScore = -Number.MAX_VALUE;
        for (const side of [0, 1] as const) {
          for (const depth of [0, 1] as const) {
            const gap = cardTop - lastTopByLane[side][depth];
            const nonOverlapBonus = gap >= laneSpacing ? 120 : 0;
            const preferredSideBonus = side === (((sequence.sessionIndex + itemIndex) % 2) as 0 | 1) ? 8 : 0;
            const depthPenalty = depth === 0 ? 4 : 0;
            const score = gap + nonOverlapBonus + preferredSideBonus + depthPenalty;
            if (score > bestScore) {
              bestScore = score;
              bestSide = side;
              bestDepth = depth;
            }
          }
        }
        lastTopByLane[bestSide][bestDepth] = cardTop;

        items.push({
          item,
          laneSide: bestSide === 0 ? "left" : "right",
          laneDepth: bestDepth,
          compact: compactCards,
          cardHeight,
          markerTop,
          markerHeight,
          cardTop,
          sequenceIndex: sequence.sequenceIndex,
          sessionIndex: sequence.sessionIndex,
        });
      });
    }

    const height = baseHeight;

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
  }, [timelineSequences, renderTimelineItems, timelineZoom, alwaysCompactCards]);

  const visibleTimelineLayoutItems = useMemo(() => {
    if (!timelineLayout) {
      return [] as Array<{ layoutItem: TimelineLayoutItem; index: number }>;
    }

    const allItems = timelineLayout.items.map((layoutItem, index) => ({ layoutItem, index }));
    if (!timelineVirtualizationEnabled) {
      return allItems;
    }

    const viewportHeight = timelineViewportRange.height;
    if (viewportHeight < 80) {
      // If viewport metrics are not stable yet, avoid culling to prevent flicker/disappear.
      return allItems;
    }

    const buffer = Math.max(1200, viewportHeight * 2);
    const visibleTop = timelineViewportRange.top - buffer;
    const visibleBottom = timelineViewportRange.top + viewportHeight + buffer;
    const virtualized = allItems.filter(({ layoutItem }) => {
      const cardTop = layoutItem.cardTop;
        const cardBottom = cardTop + layoutItem.cardHeight;
      return !(cardBottom < visibleTop || cardTop > visibleBottom);
    });

    return virtualized.length > 0 ? virtualized : allItems;
  }, [timelineLayout, timelineVirtualizationEnabled, timelineViewportRange]);

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
      // Phase 1: load lightweight data first so the directory list and timeline
      // can render without waiting for the full recursive tree walk.
      const [loadedDirectories, loadedCatalog, loadedTags] = await Promise.all([
        invoke<EventDayDirectory[]>("list_event_day_directories", { stagingDir }),
        invoke<EventNamingCatalog>("load_event_naming_catalog"),
        invoke<StagingTagsState>("load_staging_tags", { stagingDir }),
      ]);

      setDirectories(loadedDirectories);
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

    // Phase 2: load the full file tree in the background — only needed for the List view.
    void invoke<TreeNode>("list_staging_tree", { stagingDir })
      .then((loadedTree) => {
        setTreeNodes(loadedTree?.children ?? []);
      })
      .catch(() => {
        setTreeNodes([]);
      });
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
        mediaFilter?: MediaFilter;
        showDetailsPane?: boolean;
        columnWidths?: Partial<ColumnWidths>;
        leftPaneWidth?: number;
        rightPaneWidth?: number;
        showSidecarFiles?: boolean;
        timelineGapMode?: TimelineGapMode;
        timelineZoom?: number;
        timelineVirtualizationEnabled?: boolean;
        alwaysCompactCards?: boolean;
        preloadVisibleThumbs?: boolean;
        autoPrewarmEnabled?: boolean;
        manualSequenceGapMs?: number;
        manualSessionGapMs?: number;
        forcedSequenceBreaks?: string[];
        suppressedSequenceBreaks?: string[];
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
      if (parsed.mediaFilter === "videos" || parsed.mediaFilter === "photos" || parsed.mediaFilter === "all") {
        setMediaFilter(parsed.mediaFilter);
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
        setTimelineZoom(clamp(parsed.timelineZoom, 0.2, 4.0));
      }
      if (typeof parsed.timelineVirtualizationEnabled === "boolean") {
        setTimelineVirtualizationEnabled(parsed.timelineVirtualizationEnabled);
      }
      if (typeof parsed.alwaysCompactCards === "boolean") {
        setAlwaysCompactCards(parsed.alwaysCompactCards);
      }
      if (typeof parsed.preloadVisibleThumbs === "boolean") {
        setPreloadVisibleThumbs(parsed.preloadVisibleThumbs);
      }
      if (typeof parsed.autoPrewarmEnabled === "boolean") {
        setAutoPrewarmEnabled(parsed.autoPrewarmEnabled);
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
      mediaFilter,
      showDetailsPane,
      columnWidths,
      leftPaneWidth,
      rightPaneWidth,
      showSidecarFiles,
      timelineGapMode,
      timelineZoom,
      timelineVirtualizationEnabled,
      alwaysCompactCards,
      preloadVisibleThumbs,
      autoPrewarmEnabled,
      manualSequenceGapMs,
      manualSessionGapMs,
      forcedSequenceBreaks,
      suppressedSequenceBreaks,
      sessionLabels,
    };
    try {
      window.localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(payload));
    } catch {
    }
  }, [searchQuery, sortColumn, sortDirection, density, viewMode, mediaFilter, showDetailsPane, columnWidths, leftPaneWidth, rightPaneWidth, showSidecarFiles, timelineGapMode, timelineZoom, timelineVirtualizationEnabled, alwaysCompactCards, preloadVisibleThumbs, autoPrewarmEnabled, manualSequenceGapMs, manualSessionGapMs, forcedSequenceBreaks, suppressedSequenceBreaks, sessionLabels]);

  useEffect(() => {
    if (!stagingDir || !selectedDay?.relativePath) {
      setTimelineItems([]);
      return;
    }

    let cancelled = false;
    const relativeDir = selectedDay.relativePath;
    setTimelineLoading(true);

    // Phase 1: fast load — uses cached timestamps or filesystem mtime (no EXIF/ffprobe).
    // The UI becomes interactive immediately.
    invoke<TimelineMediaItem[]>("load_staging_timeline", {
      stagingDir,
      relativeDir,
      fastMode: true,
    })
      .then((items) => {
        if (cancelled) {
          return;
        }
        setTimelineItems(items);
        setTimelineLoading(false);

        // Phase 2: if any items used filesystem timestamps (not served from EXIF cache),
        // rebuild in the background to get accurate capture times. This also populates the
        // disk cache so subsequent cold starts are instant.
        if (!items.some((item) => item.timestampSource === "filesystem")) {
          return;
        }
        void invoke<TimelineMediaItem[]>("load_staging_timeline", {
          stagingDir,
          relativeDir,
          fastMode: false,
        })
          .then((accurateItems) => {
            if (!cancelled) {
              setTimelineItems(accurateItems);
            }
          })
          .catch(() => {});
      })
      .catch((timelineError) => {
        if (!cancelled) {
          setTimelineItems([]);
          setError(String(timelineError));
          setTimelineLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [stagingDir, selectedDay?.relativePath]);

  useEffect(() => {
    setTimelineThumbByPath({});
    setTimelineVideoPreviewByPath({});
    setTimelineVideoPreviewLoadingByPath({});
    setTimelineVideoPreviewErrorByPath({});
    setTimelineHoverPreview(null);
    setTimelineHoverVideoError(false);
    loadingTimelineThumbsRef.current.clear();
    loadingTimelineVideoPreviewsRef.current.clear();
    queuedTimelineThumbsRef.current.clear();
    timelineThumbQueueRef.current = [];
    timelineThumbQueueOrderRef.current = 0;
    timelineThumbWorkersRef.current = 0;
    timelineScrollingRef.current = false;
    if (timelineScrollIdleTimerRef.current !== null) {
      window.clearTimeout(timelineScrollIdleTimerRef.current);
      timelineScrollIdleTimerRef.current = null;
    }
  }, [selectedDayPath]);

  // When the timeline items load, kick off background hover-frame generation for all videos
  // so that hovering over them is instant (frames are already cached).
  useEffect(() => {
    if (!stagingDir || timelineItems.length === 0) return;
    const videoPaths = timelineItems
      .filter((item) => item.kind === "video")
      .map((item) => toAbsolutePath(item.relativePath));
    if (videoPaths.length === 0) return;
    void invoke("prewarm_video_hover_frames", {
      paths: videoPaths,
      stagingDir,
      maxWidth: previewWidth,
      maxHeight: previewHeight,
      previewFps,
    });
  }, [stagingDir, timelineItems, previewWidth, previewHeight, previewFps]);

  useEffect(() => {
    if (!stagingDir) {
      return;
    }
    void invoke<boolean>("start_preview_monitor_worker", {
      stagingDir,
      maxWidth: previewWidth,
      maxHeight: previewHeight,
      previewFps,
    }).catch(() => {
    });
  }, [stagingDir, previewWidth, previewHeight, previewFps]);

  useEffect(() => {
    schedulePreloadVisibleTimelineThumbs();
  }, [timelineLayout, viewMode, preloadVisibleThumbs, timelineZoom]);

  useEffect(() => {
    if (viewMode !== "timeline") {
      return;
    }

    for (const { layoutItem } of visibleTimelineLayoutItems) {
      const kind = layoutItem.item.kind as "image" | "video";
      enqueueTimelineThumb(layoutItem.item.relativePath, kind, kind === "video" ? 4 : 3);
    }
  }, [visibleTimelineLayoutItems, viewMode, stagingDir]);

  const handleTimelineScroll = useCallback(() => {
    if (viewMode !== "timeline" || !timelineViewportRef.current) {
      return;
    }
    const viewport = timelineViewportRef.current;
    setTimelineViewportRange({
      top: viewport.scrollTop,
      height: viewport.clientHeight,
    });
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "timeline" || !timelineViewportRef.current) {
      return;
    }
    const viewport = timelineViewportRef.current;
    const debounceTimer = setTimeout(() => {
      handleTimelineScroll();
    }, 50);
    return () => clearTimeout(debounceTimer);
  }, [viewMode, timelineLayout, handleTimelineScroll]);

  useEffect(() => () => {
    if (timelineThumbPreloadRafRef.current !== null) {
      window.cancelAnimationFrame(timelineThumbPreloadRafRef.current);
      timelineThumbPreloadRafRef.current = null;
    }
    if (timelineScrollIdleTimerRef.current !== null) {
      window.clearTimeout(timelineScrollIdleTimerRef.current);
      timelineScrollIdleTimerRef.current = null;
    }
    if (timelineViewportRafRef.current !== null) {
      window.cancelAnimationFrame(timelineViewportRafRef.current);
      timelineViewportRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!autoPrewarmEnabled) {
      return;
    }
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
  }, [autoPrewarmEnabled, stagingDir, directories.length]);

  useEffect(() => {
    if (!autoPrewarmEnabled) {
      return;
    }
    if (!stagingDir || !selectedDay?.relativePath || timelineItems.length === 0) {
      return;
    }

    const key = `${stagingDir}|${selectedDay.relativePath}`;
    if (thumbPrewarmStartedForRef.current.has(key)) {
      return;
    }
    thumbPrewarmStartedForRef.current.add(key);

    const timer = window.setTimeout(() => {
      void invoke<number>("prewarm_staging_timeline_thumbnails", {
        stagingDir,
        relativeDir: selectedDay.relativePath,
        maxWidth: 220,
        maxHeight: 140,
        maxItems: 220,
      }).catch(() => {
      });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [autoPrewarmEnabled, stagingDir, selectedDay?.relativePath, timelineItems.length]);

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
        setTimelineSessionMenu(null);
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
      if (!target.closest(".staging-session-menu")) {
        setTimelineSessionMenu(null);
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
    setTimelineSessionMenu(null);
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
    setTimelineSessionMenu(null);
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

  async function openFileInSystemViewer(relativePath: string) {
    if (!stagingDir) {
      return;
    }

    setError(null);
    try {
      await invoke("open_in_default_app", { path: toAbsolutePath(relativePath) });
    } catch (e) {
      setError(`Could not open file in system viewer: ${String(e)}`);
    }
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

  function selectSession(session: TimelineSession) {
    const paths = session.items.map((item) => item.relativePath).filter((path) => selectionOrder.includes(path));
    setCheckedPaths(paths);
    setLastCheckedPath(paths.length > 0 ? paths[paths.length - 1] : null);
  }

  function findClosestSplitPath(timestampMs: number, minIndex: number, maxIndex: number): string | null {
    if (maxIndex - minIndex < 1) {
      return null;
    }

    const clampedMin = Math.max(1, minIndex + 1);
    const clampedMax = Math.min(visibleTimelineItems.length - 1, maxIndex);
    if (clampedMin > clampedMax) {
      return null;
    }

    let bestPath: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = clampedMin; index <= clampedMax; index += 1) {
      const item = visibleTimelineItems[index];
      const distance = Math.abs(item.timestampMs - timestampMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPath = item.relativePath;
      }
    }

    return bestPath;
  }

  function splitSessionAtTimestamp(session: TimelineSession, timestampMs: number) {
    const indices = session.items
      .map((item) => timelineItemIndexByPath.get(item.relativePath))
      .filter((index): index is number => typeof index === "number")
      .sort((left, right) => left - right);
    if (indices.length < 2) {
      return;
    }

    const breakPath = findClosestSplitPath(timestampMs, indices[0], indices[indices.length - 1]);
    if (breakPath) {
      splitSequenceBefore(breakPath);
    }
  }

  function moveSessionBoundary(currentBreakPath: string | null, timestampMs: number, minIndex: number, maxIndex: number): string | null {
    const nextBreakPath = findClosestSplitPath(timestampMs, minIndex, maxIndex);
    if (!nextBreakPath) {
      return currentBreakPath;
    }

    if (currentBreakPath === nextBreakPath) {
      return currentBreakPath;
    }

    if (currentBreakPath) {
      mergeSequenceWithPrevious(currentBreakPath);
    }
    splitSequenceBefore(nextBreakPath);
    return nextBreakPath;
  }

  function openTimelineSessionMenu(session: TimelineSession, event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();

    const timestampMs = clientYToTimelineTimestamp(event.clientY) ?? session.startMs;
    const indices = session.items
      .map((item) => timelineItemIndexByPath.get(item.relativePath))
      .filter((index): index is number => typeof index === "number")
      .sort((left, right) => left - right);

    const minIndex = indices[0] ?? 0;
    const maxIndex = indices[indices.length - 1] ?? 0;
    const splitBreakPath = indices.length >= 2
      ? findClosestSplitPath(timestampMs, minIndex, maxIndex)
      : null;
    const boundaryBreakPath = minIndex > 0
      ? visibleTimelineItems[minIndex]?.relativePath ?? null
      : null;
    const clearBreakPath = [splitBreakPath, boundaryBreakPath].find((path) =>
      Boolean(path && (forcedSequenceBreaks.includes(path) || suppressedSequenceBreaks.includes(path))),
    ) ?? null;

    const menuWidth = 230;
    const menuHeight = 220;
    const margin = 8;
    const x = Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin));
    const y = Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin));

    setTimelineSessionMenu({
      sessionId: session.id,
      x,
      y,
      splitBreakPath,
      boundaryBreakPath,
      clearBreakPath,
    });
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
  }

  function setZoomLevel(nextZoom: number) {
    setTimelineZoom(clamp(nextZoom, 0.2, 4.0));
  }

  function nudgeZoom(delta: number) {
    setTimelineZoom((current) => clamp(current + delta, 0.2, 4.0));
  }

  function processTimelineThumbQueue() {
    const maxWorkers = timelineScrollingRef.current ? 1 : 3;

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
        ? { path, maxWidth: 220, maxHeight: 140, stagingDir: stagingDir }
        : { path, maxWidth: 220, maxHeight: 140, quality: 68, stagingDir: stagingDir };

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

  function onTimelineViewportScroll() {
    const viewport = timelineViewportRef.current;
    if (viewport) {
      if (timelineViewportRafRef.current !== null) {
        window.cancelAnimationFrame(timelineViewportRafRef.current);
      }
      timelineViewportRafRef.current = window.requestAnimationFrame(() => {
        timelineViewportRafRef.current = null;
        setTimelineViewportRange({ top: viewport.scrollTop, height: viewport.clientHeight });
      });
    }

    timelineScrollingRef.current = true;
    if (timelineScrollIdleTimerRef.current !== null) {
      window.clearTimeout(timelineScrollIdleTimerRef.current);
    }

    schedulePreloadVisibleTimelineThumbs();
    timelineScrollIdleTimerRef.current = window.setTimeout(() => {
      timelineScrollingRef.current = false;
      timelineScrollIdleTimerRef.current = null;
      processTimelineThumbQueue();
    }, 220);
  }

  function loadTimelineThumb(relativePath: string, kind: "image" | "video", priority = 3) {
    enqueueTimelineThumb(relativePath, kind, priority);
  }

  function loadTimelineVideoPreview(relativePath: string) {
    if (!stagingDir || timelineVideoPreviewByPath[relativePath] || loadingTimelineVideoPreviewsRef.current.has(relativePath)) {
      return;
    }

    loadingTimelineVideoPreviewsRef.current.add(relativePath);
    setTimelineVideoPreviewLoadingByPath((current) => ({ ...current, [relativePath]: true }));
    setTimelineVideoPreviewErrorByPath((current) => {
      const next = { ...current };
      delete next[relativePath];
      return next;
    });
    void invoke<string>("read_video_hover_preview_base64", {
      path: toAbsolutePath(relativePath),
      maxWidth: previewWidth,
      maxHeight: previewHeight,
      previewFps,
      stagingDir,
    })
      .then((base64Data) => {
        if (!base64Data || typeof base64Data !== "string") {
          throw new Error("No hover preview data returned");
        }
        const previewSrc = `data:video/mp4;base64,${base64Data}`;
        setTimelineVideoPreviewByPath((current) => ({
          ...current,
          [relativePath]: previewSrc,
        }));
      })
      .catch((previewError) => {
        setTimelineVideoPreviewErrorByPath((current) => ({
          ...current,
          [relativePath]: String(previewError),
        }));
      })
      .finally(() => {
        loadingTimelineVideoPreviewsRef.current.delete(relativePath);
        setTimelineVideoPreviewLoadingByPath((current) => ({ ...current, [relativePath]: false }));
      });
  }

  function clientYToTimelineTimestamp(clientY: number): number | null {
    const viewport = timelineViewportRef.current;
    if (!viewport || !timelineLayout) {
      return null;
    }

    const rect = viewport.getBoundingClientRect();
    const yInViewport = clientY - rect.top;
    const yInTimeline = viewport.scrollTop + yInViewport;
    const relativeY = clamp(yInTimeline - timelineLayout.topPadding, 0, timelineLayout.height - timelineLayout.topPadding * 2);
    return Math.round(timelineLayout.minMs + (relativeY / timelineLayout.pxPerMs));
  }

  useEffect(() => {
    if (!draggingBoundary) {
      return;
    }
    const activeBoundary = draggingBoundary;

    function onMouseMove(event: MouseEvent) {
      const timestampMs = clientYToTimelineTimestamp(event.clientY);
      if (timestampMs === null) {
        return;
      }

      const leftSession = timelineSessions[activeBoundary.boundaryIndex];
      const rightSession = timelineSessions[activeBoundary.boundaryIndex + 1];
      if (!leftSession || !rightSession) {
        return;
      }

      const leftIndices = leftSession.items
        .map((item) => timelineItemIndexByPath.get(item.relativePath))
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => left - right);
      const rightIndices = rightSession.items
        .map((item) => timelineItemIndexByPath.get(item.relativePath))
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => left - right);

      if (leftIndices.length === 0 || rightIndices.length === 0) {
        return;
      }

      const minIndex = leftIndices[0];
      const maxIndex = rightIndices[rightIndices.length - 1];
      const nextBreakPath = moveSessionBoundary(activeBoundary.currentBreakPath, timestampMs, minIndex, maxIndex);
      if (nextBreakPath !== activeBoundary.currentBreakPath) {
        setDraggingBoundary((current) => current ? { ...current, currentBreakPath: nextBreakPath } : current);
      }
    }

    function onMouseUp() {
      setDraggingBoundary(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [draggingBoundary, timelineSessions, timelineItemIndexByPath, timelineLayout]);

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

  const sessionBands = useMemo((): TimelineSessionBand[] => {
    if (!timelineLayout) {
      return [];
    }

    return timelineSessions.map((session, index) => {
      const top = timelineLayout.topPadding + (session.startMs - timelineLayout.minMs) * timelineLayout.pxPerMs;
      const bottom = timelineLayout.topPadding + (session.endMs - timelineLayout.minMs) * timelineLayout.pxPerMs;
      return {
        sessionId: session.id,
        sessionIndex: session.sessionIndex,
        label: session.label,
        top,
        height: Math.max(24, bottom - top),
        color: SESSION_BAND_COLORS[index % SESSION_BAND_COLORS.length],
        startMs: session.startMs,
        endMs: session.endMs,
      };
    });
  }, [timelineLayout, timelineSessions]);

  const sessionBoundaries = useMemo((): TimelineSessionBoundary[] => {
    if (timelineSessions.length < 2 || !timelineLayout) {
      return [];
    }

    const boundaries: TimelineSessionBoundary[] = [];
    for (let index = 0; index < timelineSessions.length - 1; index += 1) {
      const left = timelineSessions[index];
      const right = timelineSessions[index + 1];
      const top = timelineLayout.topPadding + (right.startMs - timelineLayout.minMs) * timelineLayout.pxPerMs;
      const leftEndTop = timelineLayout.topPadding + (left.endMs - timelineLayout.minMs) * timelineLayout.pxPerMs;
      const rightFirstSequence = right.sequences[0];
      const gapMs = Math.max(0, right.startMs - left.endMs);
      boundaries.push({
        boundaryIndex: index,
        top,
        gapMs,
        leftEndMs: left.endMs,
        rightStartMs: right.startMs,
        gapTop: Math.min(leftEndTop, top),
        gapHeight: Math.max(14, Math.abs(top - leftEndTop)),
        leftSessionLabel: left.label,
        rightSessionLabel: right.label,
        leftSessionIndex: left.sessionIndex,
        rightSessionIndex: right.sessionIndex,
        currentBreakPath: rightFirstSequence?.breakBeforePath ?? null,
      });
    }

    return boundaries;
  }, [timelineSessions, timelineLayout]);

  const hoveredGapBoundary = useMemo(
    () => (timelineGapHover ? sessionBoundaries.find((entry) => entry.boundaryIndex === timelineGapHover.boundaryIndex) ?? null : null),
    [timelineGapHover, sessionBoundaries],
  );

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

  const timelineHoverVideoSrc = useMemo(() => {
    if (!timelineHoverPreview || timelineHoverPreview.kind !== "video") {
      return null;
    }
    return timelineVideoPreviewByPath[timelineHoverPreview.relativePath] ?? null;
  }, [timelineHoverPreview, timelineVideoPreviewByPath]);

  const timelineHoverVideoStatus = useMemo(() => {
    if (!timelineHoverPreview || timelineHoverPreview.kind !== "video") {
      return { loading: false, error: null as string | null };
    }

    const path = timelineHoverPreview.relativePath;
    return {
      loading: Boolean(timelineVideoPreviewLoadingByPath[path]),
      error: timelineVideoPreviewErrorByPath[path] ?? null,
    };
  }, [timelineHoverPreview, timelineVideoPreviewLoadingByPath, timelineVideoPreviewErrorByPath]);

  useEffect(() => {
    setTimelineHoverVideoError(false);
  }, [timelineHoverPreview?.relativePath, timelineHoverPreview?.kind]);

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
            <div className="flex items-center rounded-md border border-surface-600 overflow-hidden" title="Filter media shown in list and timeline">
              <button
                className={`px-2 py-1.5 text-xs ${mediaFilter === "videos" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setMediaFilter("videos")}
                type="button"
              >
                Videos
              </button>
              <button
                className={`px-2 py-1.5 text-xs border-l border-surface-600 ${mediaFilter === "photos" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setMediaFilter("photos")}
                type="button"
              >
                Photos
              </button>
              <button
                className={`px-2 py-1.5 text-xs border-l border-surface-600 ${mediaFilter === "all" ? "bg-accent/20 text-white" : "bg-surface-900 text-gray-300"}`}
                onClick={() => setMediaFilter("all")}
                type="button"
              >
                All
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
            {selectedPreviewFile?.isVideo && (
              <button
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={() => void openFileInSystemViewer(selectedPreviewFile.relativePath)}
                type="button"
                title="Open selected video in your default system player"
              >
                Open Video
              </button>
            )}
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
                    onScroll={onTimelineViewportScroll}
                    onWheel={(event) => {
                      if (!event.ctrlKey) {
                        return;
                      }

                      event.preventDefault();
                      // Larger nudge at higher zoom levels for consistent perceptual feel.
                      const step = clamp(timelineZoom * 0.12, 0.06, 0.28);
                      const delta = event.deltaY < 0 ? step : -step;
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
                            min={0.2}
                            max={4.0}
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
                            checked={timelineVirtualizationEnabled}
                            onChange={(event) => setTimelineVirtualizationEnabled(event.target.checked)}
                            className="h-4 w-4"
                          />
                          Virtualize timeline cards
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-300">
                          <input
                            type="checkbox"
                            checked={alwaysCompactCards}
                            onChange={(event) => setAlwaysCompactCards(event.target.checked)}
                            className="h-4 w-4"
                          />
                          Always compact cards
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-300">
                          <input
                            type="checkbox"
                            checked={preloadVisibleThumbs}
                            onChange={(event) => setPreloadVisibleThumbs(event.target.checked)}
                            className="h-4 w-4"
                          />
                          Preload nearby thumbs
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-300">
                          <input
                            type="checkbox"
                            checked={autoPrewarmEnabled}
                            onChange={(event) => setAutoPrewarmEnabled(event.target.checked)}
                            className="h-4 w-4"
                          />
                          Background prewarm
                        </label>
                        <button className="btn-secondary px-3 py-1.5 text-xs" onClick={resetTimelineOverrides} type="button">
                          Reset Overrides
                        </button>
                      </div>
                    </div>

                    <div className="mb-3 rounded-xl border border-surface-700 bg-surface-850/70 px-4 py-2 text-xs text-gray-400">
                      Sessions are shown as color bands on the timeline. Click a band to split a session there, or drag a boundary handle to rebalance adjacent sessions.
                    </div>

                    <div className="staging-timeline staging-timeline-day rounded-[28px] border border-surface-700 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_transparent_36%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(2,6,23,0.92))]">
                      <div className="staging-timeline-axis" />

                      {timelineLayout.ticks.map((tick, index) => (
                        <div key={`${tick.label}-${tick.top}`} className={`staging-timeline-tick timeline-tick-${index}`}>
                          <div className="staging-timeline-tick-label">{tick.label}</div>
                        </div>
                      ))}

                      {sessionBands.map((band) => {
                        const session = timelineSessions.find((entry) => entry.id === band.sessionId);
                        return (
                          <div
                            key={band.sessionId}
                            className="staging-timeline-session-band"
                            style={{ top: band.top, height: band.height, backgroundColor: band.color }}
                            onContextMenu={(event) => {
                              if (!session) {
                                return;
                              }
                              openTimelineSessionMenu(session, event);
                            }}
                            onClick={(event) => {
                              const timestampMs = clientYToTimelineTimestamp(event.clientY);
                              if (!session || timestampMs === null) {
                                return;
                              }
                              splitSessionAtTimestamp(session, timestampMs);
                            }}
                            onDoubleClick={() => {
                              if (session) {
                                selectSession(session);
                              }
                            }}
                            title={`${band.label} (${formatTimelineTick(band.startMs)} to ${formatTimelineTick(band.endMs)}). Click to split. Double-click to select session.`}
                          >
                            <div className="staging-timeline-session-band-label">
                              <span>{band.label}</span>
                              <span>{formatTimelineTick(band.startMs)} to {formatTimelineTick(band.endMs)}</span>
                            </div>
                          </div>
                        );
                      })}

                      {sessionBoundaries.map((boundary) => {
                        const leftSession = timelineSessions.find((session) => session.sessionIndex === boundary.leftSessionIndex);
                        const rightSession = timelineSessions.find((session) => session.sessionIndex === boundary.rightSessionIndex);
                        if (!leftSession || !rightSession) {
                          return null;
                        }

                        const leftIndices = leftSession.items
                          .map((item) => timelineItemIndexByPath.get(item.relativePath))
                          .filter((value): value is number => typeof value === "number")
                          .sort((left, right) => left - right);
                        const rightIndices = rightSession.items
                          .map((item) => timelineItemIndexByPath.get(item.relativePath))
                          .filter((value): value is number => typeof value === "number")
                          .sort((left, right) => left - right);
                        const dragDisabled = leftIndices.length < 1 || rightIndices.length < 1 || rightIndices[rightIndices.length - 1] - leftIndices[0] < 2;

                        return (
                          <div key={`session-boundary-${boundary.boundaryIndex}`}>
                            <div
                              className="staging-timeline-gap-hit-area"
                              style={{ top: boundary.gapTop, height: boundary.gapHeight }}
                              onMouseEnter={(event) => {
                                setTimelineGapHover({
                                  boundaryIndex: boundary.boundaryIndex,
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                              onMouseMove={(event) => {
                                setTimelineGapHover((current) => current && current.boundaryIndex === boundary.boundaryIndex
                                  ? { ...current, x: event.clientX, y: event.clientY }
                                  : {
                                      boundaryIndex: boundary.boundaryIndex,
                                      x: event.clientX,
                                      y: event.clientY,
                                    });
                              }}
                              onMouseLeave={() => {
                                setTimelineGapHover((current) =>
                                  current?.boundaryIndex === boundary.boundaryIndex ? null : current,
                                );
                              }}
                            />
                            <button
                              type="button"
                              className="staging-timeline-session-boundary"
                              style={{ top: boundary.top }}
                              onMouseEnter={(event) => {
                                setTimelineGapHover({
                                  boundaryIndex: boundary.boundaryIndex,
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                              onMouseMove={(event) => {
                                setTimelineGapHover((current) => current && current.boundaryIndex === boundary.boundaryIndex
                                  ? { ...current, x: event.clientX, y: event.clientY }
                                  : {
                                      boundaryIndex: boundary.boundaryIndex,
                                      x: event.clientX,
                                      y: event.clientY,
                                    });
                              }}
                              onMouseLeave={() => {
                                setTimelineGapHover((current) =>
                                  current?.boundaryIndex === boundary.boundaryIndex ? null : current,
                                );
                              }}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                if (dragDisabled) {
                                  return;
                                }
                                setDraggingBoundary({
                                  boundaryIndex: boundary.boundaryIndex,
                                  currentBreakPath: boundary.currentBreakPath,
                                });
                              }}
                              disabled={dragDisabled}
                              title={`Drag to move boundary between ${boundary.leftSessionLabel} and ${boundary.rightSessionLabel}`}
                            >
                              <span className="staging-timeline-session-boundary-line" />
                              <span className="staging-timeline-session-boundary-handle">Drag split</span>
                            </button>
                          </div>
                        );
                      })}

                      {timelineGapHover && hoveredGapBoundary && (
                        <div
                          className="staging-timeline-gap-tooltip"
                          style={{
                            left: Math.min(window.innerWidth - 280, timelineGapHover.x + 14),
                            top: Math.min(window.innerHeight - 120, timelineGapHover.y + 14),
                          }}
                        >
                          <div className="staging-timeline-gap-tooltip-title">Session Gap</div>
                          <div className="staging-timeline-gap-tooltip-duration">{formatGapDuration(hoveredGapBoundary.gapMs)}</div>
                          <div className="staging-timeline-gap-tooltip-range">
                            {formatClock(hoveredGapBoundary.leftEndMs)} to {formatClock(hoveredGapBoundary.rightStartMs)}
                          </div>
                        </div>
                      )}

                      {timelineSequences.map((sequence, index) => (
                        <div key={sequence.id} className={`staging-timeline-sequence timeline-sequence-${index}`}>
                          <div className={`staging-timeline-sequence-label ${index % 2 === 0 ? "is-right" : "is-left"}`}>
                            <span>Session {sequence.sessionIndex + 1}</span>
                            <span>Sequence {sequence.sequenceIndex + 1}</span>
                            <span>{sequence.items.length} item{sequence.items.length === 1 ? "" : "s"}</span>
                          </div>
                        </div>
                      ))}

                      {visibleTimelineLayoutItems.map(({ layoutItem, index }) => {
                        const entry = tagEntryByPath.get(layoutItem.item.relativePath);
                        const checked = checkedPaths.includes(layoutItem.item.relativePath);
                        const selectedPreview = selectedPreviewPath === layoutItem.item.relativePath;
                        const primaryGroupId = entry?.groupIds[0] ?? null;
                        const groupLabel = primaryGroupId ? (groupLabelById.get(primaryGroupId) ?? primaryGroupId) : null;
                        const kind = layoutItem.item.kind as "image" | "video";
                        const thumbSrc = timelineThumbByPath[layoutItem.item.relativePath] ?? null;

                        return (
                          <div key={layoutItem.item.relativePath}>
                            <div
                              className={`staging-timeline-marker ${layoutItem.item.kind === "video" ? "is-video" : "is-image"}`}
                              style={{ top: layoutItem.markerTop, height: layoutItem.markerHeight }}
                            />
                            <div
                              className={`staging-timeline-card ${selectedPreview ? "is-selected" : ""} ${layoutItem.laneSide === "left" ? "is-left" : "is-right"} ${layoutItem.laneDepth === 1 ? "lane-deep" : ""} ${layoutItem.compact ? "is-compact" : ""}`}
                              style={{ top: layoutItem.cardTop }}
                              onMouseEnter={(event) => {
                                loadTimelineThumb(layoutItem.item.relativePath, kind, 4);
                                if (kind === "video") {
                                  loadTimelineVideoPreview(layoutItem.item.relativePath);
                                }
                                setTimelineHoverPreview({
                                  relativePath: layoutItem.item.relativePath,
                                  name: layoutItem.item.name,
                                  kind,
                                  x: event.clientX,
                                  y: event.clientY,
                                });
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
                              <span
                                className="staging-timeline-card-connector"
                                style={{ top: layoutItem.markerTop - layoutItem.cardTop + 6 }}
                              />
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
                                <div
                                  className="min-w-0 flex-1 cursor-pointer"
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => onRowClick(layoutItem.item.relativePath, event)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      onRowClick(layoutItem.item.relativePath, event);
                                    }
                                  }}
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
                                  {!layoutItem.compact && (
                                    <>
                                      <div className="mt-2 truncate text-[11px] text-gray-500">{layoutItem.item.relativePath}</div>
                                      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                                        <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-emerald-200">{entry?.tags.length ? entry.tags.join(", ") : "No tags"}</span>
                                        {groupLabel && <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-amber-200">{groupLabel}</span>}
                                        <span className="rounded-full bg-surface-800 px-2 py-0.5 text-gray-300">{layoutItem.item.timestampSource}</span>
                                      </div>
                                    </>
                                  )}
                                </div>
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
                          {timelineHoverPreview.kind === "video" && timelineHoverVideoSrc && !timelineHoverVideoError ? (
                            <video
                              key={timelineHoverPreview.relativePath}
                              className="staging-timeline-hover-preview-video"
                              src={timelineHoverVideoSrc}
                              autoPlay
                              muted
                              loop
                              playsInline
                              preload="metadata"
                              onError={() => setTimelineHoverVideoError(true)}
                            />
                          ) : timelineHoverPreview.kind === "video" && timelineHoverVideoStatus.loading ? (
                            <div className="staging-timeline-hover-preview-loading">Rendering motion preview...</div>
                          ) : timelineHoverPreview.kind === "video" && timelineHoverVideoStatus.error ? (
                            <div className="staging-timeline-hover-preview-loading">
                              Motion preview failed. Showing thumbnail fallback.
                            </div>
                          ) : timelineThumbByPath[timelineHoverPreview.relativePath] ? (
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

            {timelineSessionMenu && (() => {
              const session = timelineSessions.find((entry) => entry.id === timelineSessionMenu.sessionId);
              if (!session) {
                return null;
              }

              return (
                <div
                  className="staging-session-menu fixed z-30 w-56 rounded-md border border-surface-600 bg-surface-900 shadow-lg shadow-black/50 p-1"
                  style={{ left: timelineSessionMenu.x, top: timelineSessionMenu.y }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-200 truncate" title={session.label}>
                    {session.label}
                  </div>
                  <div className="my-1 border-t border-surface-700" role="separator" />
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded disabled:opacity-40"
                    onClick={() => {
                      if (timelineSessionMenu.splitBreakPath) {
                        splitSequenceBefore(timelineSessionMenu.splitBreakPath);
                      }
                      setTimelineSessionMenu(null);
                    }}
                    disabled={!timelineSessionMenu.splitBreakPath}
                  >
                    ✂ Split Here
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded disabled:opacity-40"
                    onClick={() => {
                      if (timelineSessionMenu.boundaryBreakPath) {
                        mergeSequenceWithPrevious(timelineSessionMenu.boundaryBreakPath);
                      }
                      setTimelineSessionMenu(null);
                    }}
                    disabled={!timelineSessionMenu.boundaryBreakPath}
                  >
                    ⤴ Merge With Previous
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded disabled:opacity-40"
                    onClick={() => {
                      if (timelineSessionMenu.clearBreakPath) {
                        clearSequenceOverride(timelineSessionMenu.clearBreakPath);
                      }
                      setTimelineSessionMenu(null);
                    }}
                    disabled={!timelineSessionMenu.clearBreakPath}
                  >
                    ↺ Clear Override
                  </button>
                  <div className="my-1 border-t border-surface-700" role="separator" />
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded"
                    onClick={() => {
                      selectSession(session);
                      setTimelineSessionMenu(null);
                    }}
                  >
                    ☑ Select Session
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded"
                    onClick={() => {
                      void tagSession(session);
                      setTimelineSessionMenu(null);
                    }}
                  >
                    🏷 Tag Session
                  </button>
                </div>
              );
            })()}

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
                <button
                  type="button"
                  data-cm-item="true"
                  className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-surface-700 rounded"
                  onClick={() => {
                    void openFileInSystemViewer(contextMenuFile.relativePath);
                    setContextMenuFilePath(null);
                    setContextMenuTagOpen(false);
                    setContextMenuFocusIndex(0);
                  }}
                >
                  ▶ Open In Default App
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
                    <div className="rounded-md border border-surface-700 bg-black min-h-56 flex items-center justify-center overflow-hidden">
                      {selectedPreviewFile.isImage && previewDataUrl ? (
                        <img src={previewDataUrl} alt={selectedPreviewFile.name} className="max-h-[320px] max-w-full object-contain" />
                      ) : selectedPreviewFile.isVideo ? (
                        <div className="text-sm text-gray-400 p-4 text-center space-y-3">
                          <div>Video selected. Inline video preview is not enabled yet.</div>
                          <button
                            type="button"
                            className="btn-secondary px-3 py-1.5 text-xs"
                            onClick={() => void openFileInSystemViewer(selectedPreviewFile.relativePath)}
                          >
                            Open In System Video Player
                          </button>
                        </div>
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
          )}
        </div>
      </div>
    </div>
  );
}
