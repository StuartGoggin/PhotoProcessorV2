import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyEventNamingRequest,
  EventDayDirectory,
  EventNamingAssignment,
  EventNamingCatalog,
  PrefillEventNamingFromArchiveResult,
  ProcessJob,
} from "../types";
import { useJobsMonitor, useSettings } from "../hooks";

type NameEventsTab = "naming" | "library";
type DirectoryTreeMonth = {
  id: string;
  year: number;
  month: number;
  label: string;
  directories: EventDayDirectory[];
};

type DirectoryTreeYear = {
  id: string;
  year: number;
  label: string;
  months: DirectoryTreeMonth[];
};

type NamingDraftValues = {
  eventType: string;
  location: string;
  peopleTags: string[];
  groupTags: string[];
  generalTags: string[];
};

function normalizeTagList(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function cloneCatalog(catalog: EventNamingCatalog): EventNamingCatalog {
  return {
    eventTypes: catalog.eventTypes.map((item) => ({ ...item, locations: [...item.locations] })),
    peopleTags: [...catalog.peopleTags],
    groupTags: [...catalog.groupTags],
    generalTags: [...catalog.generalTags],
  };
}

function combineTags(peopleTags: string[], groupTags: string[], generalTags: string[]): string[] {
  return normalizeTagList([...peopleTags, ...groupTags, ...generalTags]);
}

function formatPreviewName(
  day: number,
  eventType: string,
  location: string,
  peopleTags: string[],
  groupTags: string[],
  generalTags: string[],
): string {
  const parts = [String(day).padStart(2, "0")];
  const cleanEventType = eventType.trim();
  const cleanLocation = location.trim();
  const cleanTags = combineTags(peopleTags, groupTags, generalTags);

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

function isoToDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function isConsecutiveDay(previous: string, next: string): boolean {
  const prevDate = isoToDate(previous);
  const nextDate = isoToDate(next);
  const diffMs = nextDate.getTime() - prevDate.getTime();
  return diffMs === 24 * 60 * 60 * 1000;
}

function categorizeParsedTags(tags: string[], catalog: EventNamingCatalog) {
  const peopleLookup = new Set(catalog.peopleTags.map((tag) => tag.toLowerCase()));
  const groupLookup = new Set(catalog.groupTags.map((tag) => tag.toLowerCase()));

  const peopleTags: string[] = [];
  const groupTags: string[] = [];
  const generalTags: string[] = [];

  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (peopleLookup.has(key)) {
      peopleTags.push(tag);
    } else if (groupLookup.has(key)) {
      groupTags.push(tag);
    } else {
      generalTags.push(tag);
    }
  }

  return { peopleTags, groupTags, generalTags };
}

function parseNamedDirectory(name: string, catalog: EventNamingCatalog) {
  const parts = name.split(" - ");
  if (parts.length < 2) {
    return null;
  }

  const eventType = parts[1]?.trim() ?? "";
  const trailingParts = parts.slice(2);
  let location = "";
  let rawTags: string[] = [];

  if (trailingParts.length === 1) {
    if (trailingParts[0].includes(",")) {
      rawTags = trailingParts[0].split(",").map((value) => value.trim()).filter(Boolean);
    } else {
      location = trailingParts[0].trim();
    }
  } else if (trailingParts.length > 1) {
    location = trailingParts[0].trim();
    rawTags = trailingParts.slice(1).join(" - ").split(",").map((value) => value.trim()).filter(Boolean);
  }

  return {
    eventType,
    location,
    ...categorizeParsedTags(rawTags, catalog),
  };
}

function EditableStringListSection({
  title,
  description,
  items,
  accentClass,
  emptyLabel,
  addLabel,
  onChange,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  items: string[];
  accentClass: string;
  emptyLabel: string;
  addLabel: string;
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className={`rounded-lg border px-4 py-4 space-y-3 ${accentClass}`}>
      <div>
        <div className="text-xs uppercase tracking-wide font-medium">{title}</div>
        <div className="mt-1 text-xs text-gray-400">{description}</div>
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="rounded border border-dashed border-surface-600 px-3 py-3 text-sm text-gray-500">{emptyLabel}</div>
        ) : (
          items.map((item, index) => (
            <div key={`${title}-${index}`} className="flex items-center gap-2">
              <input
                type="text"
                className="input-field flex-1"
                value={item}
                onChange={(e) => onChange(index, e.target.value)}
                placeholder={title}
              />
              <button className="btn-danger px-3 py-2 text-xs" type="button" onClick={() => onRemove(index)}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <button className="btn-secondary" type="button" onClick={onAdd}>
        {addLabel}
      </button>
    </div>
  );
}

function filterLookupOptions(options: string[], rawInput: string): string[] {
  const input = rawInput.trim().toLowerCase();
  const uniqueOptions = [...new Set(options.map((option) => option.trim()).filter(Boolean))];

  if (!input) {
    return uniqueOptions.slice(0, 8);
  }

  return uniqueOptions
    .filter((option) => option.toLowerCase().includes(input))
    .sort((left, right) => {
      const leftValue = left.toLowerCase();
      const rightValue = right.toLowerCase();
      const leftStarts = leftValue.startsWith(input) ? 0 : 1;
      const rightStarts = rightValue.startsWith(input) ? 0 : 1;
      if (leftStarts !== rightStarts) {
        return leftStarts - rightStarts;
      }
      return left.localeCompare(right);
    })
    .slice(0, 8);
}

function LookupInput({
  value,
  placeholder,
  title,
  widthClass,
  options,
  open,
  onFocus,
  onBlur,
  onChange,
  onSelect,
  onCommit,
}: {
  value: string;
  placeholder: string;
  title: string;
  widthClass: string;
  options: string[];
  open: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className={`relative ${widthClass}`}>
      <input
        type="text"
        className="input-field h-9 w-full"
        value={value}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Tab") {
            onCommit();
          }
        }}
        placeholder={placeholder}
        title={title}
        autoComplete="off"
      />
      {open && options.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-20 overflow-hidden rounded-lg border border-surface-600 bg-gray-950 shadow-xl shadow-black/30">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="block w-full border-b border-surface-800 px-3 py-2 text-left text-xs text-gray-200 hover:bg-surface-800 last:border-b-0"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function pct(done: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (done / total) * 100));
}

export default function NameEvents() {
  const { settings, loading: settingsLoading, error: settingsError } = useSettings();
  const [activeTab, setActiveTab] = useState<NameEventsTab>("naming");
  const [openYearIds, setOpenYearIds] = useState<string[]>([]);
  const [openMonthIds, setOpenMonthIds] = useState<string[]>([]);
  const [activeComposerPath, setActiveComposerPath] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<EventNamingCatalog>({ eventTypes: [], peopleTags: [], groupTags: [], generalTags: [] });
  const [libraryDraft, setLibraryDraft] = useState<EventNamingCatalog>({ eventTypes: [], peopleTags: [], groupTags: [], generalTags: [] });
  const [directories, setDirectories] = useState<EventDayDirectory[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [eventType, setEventType] = useState("");
  const [location, setLocation] = useState("");
  const [peopleTags, setPeopleTags] = useState<string[]>([]);
  const [groupTags, setGroupTags] = useState<string[]>([]);
  const [generalTags, setGeneralTags] = useState<string[]>([]);
  const [peopleTagInput, setPeopleTagInput] = useState("");
  const [groupTagInput, setGroupTagInput] = useState("");
  const [generalTagInput, setGeneralTagInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [purgingLibrary, setPurgingLibrary] = useState(false);
  const [queueingArchiveScan, setQueueingArchiveScan] = useState(false);
  const [queuedArchiveScanJobId, setQueuedArchiveScanJobId] = useState<string | null>(null);
  const [queueingNamingJob, setQueueingNamingJob] = useState(false);
  const [queuedNamingJobId, setQueuedNamingJobId] = useState<string | null>(null);
  const [plannedAssignments, setPlannedAssignments] = useState<Record<string, EventNamingAssignment>>({});
  const [lastCheckedPath, setLastCheckedPath] = useState<string | null>(null);
  const [showPlannedOnly, setShowPlannedOnly] = useState(false);
  const [persistingLookup, setPersistingLookup] = useState(false);
  const [eventLookupOpen, setEventLookupOpen] = useState(false);
  const [locationLookupOpen, setLocationLookupOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { processJobs } = useJobsMonitor(true, 1000);

  const stagingDir = settings?.staging_dir ?? "";
  const archiveDir = settings?.archive_dir ?? "";

  async function loadCatalog() {
    const loaded = await invoke<EventNamingCatalog>("load_event_naming_catalog");
    setCatalog(loaded);
  }

  async function loadDirectories() {
    if (!stagingDir) {
      setDirectories([]);
      return;
    }

    const loaded = await invoke<EventDayDirectory[]>("list_event_day_directories", { stagingDir });
    setDirectories(loaded);
  }

  async function refreshAll() {
    if (!stagingDir) {
      setError("Set the staging directory in Settings before naming event folders.");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await Promise.all([loadCatalog(), loadDirectories()]);
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
    setLibraryDraft(cloneCatalog(catalog));
  }, [catalog]);

  useEffect(() => {
    const tree = buildDirectoryTree(directories);
    setOpenYearIds((current) => (current.length > 0 ? current : tree.map((year) => year.id)));
    setOpenMonthIds((current) => {
      if (current.length > 0) {
        return current;
      }
      return tree.flatMap((year) => year.months.map((month) => month.id));
    });
  }, [directories]);

  useEffect(() => {
    const validPaths = new Set(directories.map((directory) => directory.path));
    setSelectedPaths((current) => current.filter((path) => validPaths.has(path)));
    setPlannedAssignments((current) =>
      Object.fromEntries(Object.entries(current).filter(([path]) => validPaths.has(path))),
    );
    setActiveComposerPath((current) => (current && validPaths.has(current) ? current : null));
  }, [directories]);

  useEffect(() => {
    if (!queuedArchiveScanJobId) {
      return;
    }

    const job = processJobs.find((item) => item.id === queuedArchiveScanJobId);
    if (!job) {
      return;
    }

    if (job.status === "completed") {
      void loadCatalog();
      setQueuedArchiveScanJobId(null);
      setMessage(`Archive scan completed. Scanned ${job.processed} day folders and matched ${job.resultCount} named directories.`);
    } else if (job.status === "failed") {
      setQueuedArchiveScanJobId(null);
      setError(job.errors[job.errors.length - 1] ?? "Archive scan failed. Check Jobs for details.");
    } else if (job.status === "aborted") {
      setQueuedArchiveScanJobId(null);
      setError("Archive scan was aborted.");
    }
  }, [processJobs, queuedArchiveScanJobId]);

  useEffect(() => {
    if (!queuedNamingJobId) {
      return;
    }

    const job = processJobs.find((item) => item.id === queuedNamingJobId);
    if (!job) {
      return;
    }

    if (job.status === "completed") {
      setQueuedNamingJobId(null);
      setSelectedPaths([]);
      setActiveComposerPath(null);
      void refreshAll();
      setMessage(`Naming job completed. Processed ${job.processed} folder${job.processed === 1 ? "" : "s"}; renamed ${job.resultCount}.`);
    } else if (job.status === "failed") {
      setQueuedNamingJobId(null);
      setError(job.errors[job.errors.length - 1] ?? "Naming job failed. Check Jobs for details.");
    } else if (job.status === "aborted") {
      setQueuedNamingJobId(null);
      setError("Naming job was aborted.");
      void refreshAll();
    }
  }, [processJobs, queuedNamingJobId]);

  const visibleDirectories = useMemo(
    () => directories.filter((directory) => !showPlannedOnly || Boolean(plannedAssignments[directory.path])),
    [directories, plannedAssignments, showPlannedOnly],
  );

  const selectedDirectories = useMemo(() => {
    const selected = new Set(selectedPaths);
    return directories.filter((directory) => selected.has(directory.path));
  }, [directories, selectedPaths]);

  const activeComposerDirectory = useMemo(
    () => directories.find((directory) => directory.path === activeComposerPath) ?? null,
    [activeComposerPath, directories],
  );

  const draftSelection = useMemo(
    () => (selectedDirectories.length > 0 ? selectedDirectories : activeComposerDirectory ? [activeComposerDirectory] : []),
    [activeComposerDirectory, selectedDirectories],
  );

  const plannedRows = useMemo(
    () => directories
      .filter((directory) => plannedAssignments[directory.path])
      .map((directory) => {
        const assignment = plannedAssignments[directory.path];
        return {
          ...directory,
          assignment,
          previewName: getAssignmentPreviewName(directory.day, assignment),
        };
      }),
    [directories, plannedAssignments],
  );

  const draftPreviewRows = useMemo(
    () => draftSelection.map((directory) => ({
      ...directory,
      previewName: formatPreviewName(directory.day, eventType, location, peopleTags, groupTags, generalTags),
    })),
    [draftSelection, eventType, location, peopleTags, groupTags, generalTags],
  );

  const suggestionAnchorDirectory = useMemo(
    () => activeComposerDirectory ?? [...selectedDirectories].sort((a, b) => a.dateKey.localeCompare(b.dateKey))[0] ?? null,
    [activeComposerDirectory, selectedDirectories],
  );

  const previousDaySuggestion = useMemo(() => {
    if (!suggestionAnchorDirectory) {
      return null;
    }

    const index = directories.findIndex((directory) => directory.path === suggestionAnchorDirectory.path);
    if (index <= 0) {
      return null;
    }

    const previous = directories[index - 1];
    if (!previous.hasCustomName || !isConsecutiveDay(previous.dateKey, suggestionAnchorDirectory.dateKey)) {
      return null;
    }

    const parsed = parseNamedDirectory(previous.name, catalog);
    if (!parsed) {
      return null;
    }

    return {
      label: `Use previous day naming from ${previous.dateKey}`,
      ...parsed,
    };
  }, [catalog, directories, suggestionAnchorDirectory]);

  const holidaySuggestion = useMemo(() => {
    if (draftSelection.some((directory) => directory.month === 12 && directory.day === 25)) {
      return {
        label: "Use Christmas suggestion",
        eventType: "Christmas",
        location: "",
        peopleTags: [] as string[],
        groupTags: [] as string[],
        generalTags: [] as string[],
      };
    }

    return null;
  }, [draftSelection]);

  const archiveScanJobs = useMemo(
    () => processJobs.filter((job) => job.task === "scan_archive_naming").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [processJobs],
  );
  const namingJobs = useMemo(
    () => processJobs.filter((job) => job.task === "apply_event_naming").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [processJobs],
  );

  const latestArchiveScanJob = archiveScanJobs[0] ?? null;
  const latestNamingJob = namingJobs[0] ?? null;
  const directoryTree = useMemo(() => buildDirectoryTree(visibleDirectories), [visibleDirectories]);
  const currentEventTypeDefinition = useMemo(
    () => catalog.eventTypes.find((item) => item.name.toLowerCase() === eventType.trim().toLowerCase()) ?? null,
    [catalog.eventTypes, eventType],
  );
  const matchingEventTypes = useMemo(
    () => filterLookupOptions(catalog.eventTypes.map((item) => item.name), eventType),
    [catalog.eventTypes, eventType],
  );
  const locationOptions = useMemo(() => {
    if (currentEventTypeDefinition) {
      return currentEventTypeDefinition.locations;
    }

    const partialMatches = catalog.eventTypes.filter((item) => item.name.toLowerCase().includes(eventType.trim().toLowerCase()));
    if (partialMatches.length === 1) {
      return partialMatches[0].locations;
    }

    return [];
  }, [catalog.eventTypes, currentEventTypeDefinition, eventType]);
  const matchingLocations = useMemo(
    () => filterLookupOptions(locationOptions, location),
    [locationOptions, location],
  );
  const libraryDirty = useMemo(
    () => JSON.stringify(libraryDraft) !== JSON.stringify(catalog),
    [libraryDraft, catalog],
  );

  function toggleDirectory(path: string, checked: boolean, useRange = false) {
    const visibleIndex = visibleDirectories.findIndex((directory) => directory.path === path);

    setSelectedPaths((current) => {
      if (useRange && lastCheckedPath) {
        const anchorIndex = visibleDirectories.findIndex((directory) => directory.path === lastCheckedPath);
        if (anchorIndex >= 0 && visibleIndex >= 0) {
          const start = Math.min(anchorIndex, visibleIndex);
          const end = Math.max(anchorIndex, visibleIndex);
          const rangePaths = visibleDirectories.slice(start, end + 1).map((directory) => directory.path);
          const nextSet = new Set(current);
          for (const rangePath of rangePaths) {
            if (checked) {
              nextSet.add(rangePath);
            } else {
              nextSet.delete(rangePath);
            }
          }
          return directories.filter((directory) => nextSet.has(directory.path)).map((directory) => directory.path);
        }
      }

      if (checked) {
        if (current.includes(path)) {
          return current;
        }
        return [...current, path];
      }

      return current.filter((value) => value !== path);
    });

    setLastCheckedPath(path);
  }

  function toggleYear(yearId: string) {
    setOpenYearIds((current) => (current.includes(yearId) ? current.filter((id) => id !== yearId) : [...current, yearId]));
  }

  function toggleMonth(monthId: string) {
    setOpenMonthIds((current) => (current.includes(monthId) ? current.filter((id) => id !== monthId) : [...current, monthId]));
  }

  function openInlineComposer(directory: EventDayDirectory) {
    setActiveComposerPath((current) => (current === directory.path ? null : directory.path));
  }

  function createCurrentAssignment(directoryPath: string): EventNamingAssignment {
    return {
      directory: directoryPath,
      eventType: eventType.trim(),
      location: location.trim(),
      source: "manual",
      targetName: undefined,
      peopleTags: normalizeTagList(peopleTags),
      groupTags: normalizeTagList(groupTags),
      generalTags: normalizeTagList(generalTags),
    };
  }

  function loadDraftValues(values: NamingDraftValues) {
    setEventType(values.eventType);
    setLocation(values.location);
    setPeopleTags(values.peopleTags);
    setGroupTags(values.groupTags);
    setGeneralTags(values.generalTags);
  }

  function selectOnlyDirectory(path: string) {
    setSelectedPaths([path]);
    setLastCheckedPath(path);
  }

  function clearSelection() {
    setSelectedPaths([]);
    setLastCheckedPath(null);
  }

  function clearNamingPlan() {
    setPlannedAssignments({});
    setMessage("Cleared the queued naming plan.");
    setError(null);
  }

  function selectConsecutiveDays() {
    const anchorPath = activeComposerPath ?? selectedPaths[0];
    if (!anchorPath) {
      setError("Focus a day or check at least one day folder first.");
      return;
    }

    const firstIndex = directories.findIndex((directory) => directory.path === anchorPath);
    if (firstIndex < 0) {
      return;
    }

    const nextSelection = [directories[firstIndex].path];
    for (let index = firstIndex + 1; index < directories.length; index += 1) {
      const previous = directories[index - 1];
      const current = directories[index];
      if (!isConsecutiveDay(previous.dateKey, current.dateKey)) {
        break;
      }
      nextSelection.push(current.path);
    }

    setSelectedPaths(nextSelection);
  }

  function applyDraftToCheckedDays() {
    if (draftSelection.length === 0) {
      setError("Focus a day or check one or more days before applying the draft.");
      return;
    }

    const nextAssignment = createCurrentAssignment(draftSelection[0].path);
    setPlannedAssignments((current) => {
      const next = { ...current };
      for (const directory of draftSelection) {
        next[directory.path] = {
          ...nextAssignment,
          directory: directory.path,
        };
      }
      return next;
    });
    setMessage(
      `Added ${draftSelection.length} day folder${draftSelection.length === 1 ? "" : "s"} to the naming plan.`,
    );
    setError(null);
  }

  function removePlannedDay(path: string) {
    setPlannedAssignments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  function addTag(value: string, currentValues: string[], setValues: (next: string[]) => void, clearInput: () => void) {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    if (!currentValues.some((tag) => tag.toLowerCase() === trimmed.toLowerCase())) {
      setValues([...currentValues, trimmed]);
    }
    clearInput();
  }

  function removeTag(tag: string, currentValues: string[], setValues: (next: string[]) => void) {
    setValues(currentValues.filter((value) => value !== tag));
  }

  function applySuggestion(suggestion: {
    eventType: string;
    location: string;
    peopleTags: string[];
    groupTags: string[];
    generalTags: string[];
  }) {
    loadDraftValues({
      eventType: suggestion.eventType,
      location: suggestion.location,
      peopleTags: suggestion.peopleTags,
      groupTags: suggestion.groupTags,
      generalTags: suggestion.generalTags,
    });
  }

  async function persistEventLocationLookup(nextEventType: string, nextLocation: string) {
    const cleanEventType = nextEventType.trim();
    const cleanLocation = nextLocation.trim();
    if (!cleanEventType) {
      return;
    }

    const existingEvent = catalog.eventTypes.find((item) => item.name.toLowerCase() === cleanEventType.toLowerCase());
    const eventAlreadyExists = Boolean(existingEvent);
    const locationAlreadyExists = !cleanLocation || existingEvent?.locations.some((item) => item.toLowerCase() === cleanLocation.toLowerCase());
    if (eventAlreadyExists && locationAlreadyExists) {
      return;
    }

    const nextCatalog = cloneCatalog(catalog);
    if (existingEvent) {
      if (cleanLocation && !locationAlreadyExists) {
        existingEvent.locations = normalizeTagList([...existingEvent.locations, cleanLocation]);
      }
    } else {
      nextCatalog.eventTypes.push({
        name: cleanEventType,
        locations: cleanLocation ? [cleanLocation] : [],
      });
      nextCatalog.eventTypes.sort((left, right) => left.name.localeCompare(right.name));
    }

    setPersistingLookup(true);
    try {
      const saved = await invoke<EventNamingCatalog>("save_event_naming_catalog", { catalog: nextCatalog });
      setCatalog(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setPersistingLookup(false);
    }
  }

  function handleEventTypeSelect(nextValue: string) {
    setEventType(nextValue);
    setEventLookupOpen(false);
    void persistEventLocationLookup(nextValue, location);
  }

  function handleLocationSelect(nextValue: string) {
    setLocation(nextValue);
    setLocationLookupOpen(false);
    void persistEventLocationLookup(eventType, nextValue);
  }

  function commitEventLookup() {
    setEventLookupOpen(false);
    void persistEventLocationLookup(eventType, location);
  }

  function commitLocationLookup() {
    setLocationLookupOpen(false);
    void persistEventLocationLookup(eventType, location);
  }

  function updateLibraryDraft(mutator: (draft: EventNamingCatalog) => void) {
    setLibraryDraft((current) => {
      const next = cloneCatalog(current);
      mutator(next);
      return next;
    });
  }

  function addDraftEventType() {
    updateLibraryDraft((draft) => {
      draft.eventTypes.push({ name: "", locations: [] });
    });
  }

  function updateDraftEventTypeName(index: number, value: string) {
    updateLibraryDraft((draft) => {
      draft.eventTypes[index].name = value;
    });
  }

  function removeDraftEventType(index: number) {
    updateLibraryDraft((draft) => {
      draft.eventTypes.splice(index, 1);
    });
  }

  function addDraftLocation(eventTypeIndex: number) {
    updateLibraryDraft((draft) => {
      draft.eventTypes[eventTypeIndex].locations.push("");
    });
  }

  function updateDraftLocation(eventTypeIndex: number, locationIndex: number, value: string) {
    updateLibraryDraft((draft) => {
      draft.eventTypes[eventTypeIndex].locations[locationIndex] = value;
    });
  }

  function removeDraftLocation(eventTypeIndex: number, locationIndex: number) {
    updateLibraryDraft((draft) => {
      draft.eventTypes[eventTypeIndex].locations.splice(locationIndex, 1);
    });
  }

  function addDraftTag(listKey: "peopleTags" | "groupTags" | "generalTags") {
    updateLibraryDraft((draft) => {
      draft[listKey].push("");
    });
  }

  function updateDraftTag(listKey: "peopleTags" | "groupTags" | "generalTags", index: number, value: string) {
    updateLibraryDraft((draft) => {
      draft[listKey][index] = value;
    });
  }

  function removeDraftTag(listKey: "peopleTags" | "groupTags" | "generalTags", index: number) {
    updateLibraryDraft((draft) => {
      draft[listKey].splice(index, 1);
    });
  }

  function discardLibraryDraft() {
    setLibraryDraft(cloneCatalog(catalog));
    setMessage("Reverted unsaved library changes.");
    setError(null);
  }

  function loadDirectoryIntoComposer(directory: EventDayDirectory) {
    const planned = plannedAssignments[directory.path];
    if (planned) {
      loadDraftValues(assignmentToDraftValues(planned));
      return;
    }

    const parsed = parseNamedDirectory(directory.name, catalog);
    if (!parsed) {
      loadDraftValues({
        eventType: "",
        location: "",
        peopleTags: [],
        groupTags: [],
        generalTags: [],
      });
      return;
    }

    loadDraftValues({
      eventType: parsed.eventType,
      location: parsed.location,
      peopleTags: parsed.peopleTags,
      groupTags: parsed.groupTags,
      generalTags: parsed.generalTags,
    });
  }

  async function saveLibraryDraft() {
    setSavingLibrary(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await invoke<EventNamingCatalog>("save_event_naming_catalog", { catalog: libraryDraft });
      setCatalog(saved);
      setMessage("Naming library updated.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingLibrary(false);
    }
  }

  async function queueNamingJob() {
    if (plannedRows.length === 0) {
      setError("Apply the draft to at least one day before queueing the naming job.");
      return;
    }

    setQueueingNamingJob(true);
    setError(null);
    setMessage(null);
    try {
      const request: ApplyEventNamingRequest = {
        directories: plannedRows.map((directory) => directory.path),
        eventType: "",
        location: "",
        peopleTags: [],
        groupTags: [],
        generalTags: [],
        assignments: plannedRows.map((row) => ({
          directory: row.path,
          eventType: row.assignment.eventType,
          location: row.assignment.location,
          source: row.assignment.source,
          targetName: row.assignment.targetName,
          peopleTags: row.assignment.peopleTags,
          groupTags: row.assignment.groupTags,
          generalTags: row.assignment.generalTags,
        })),
      };
      const jobId = await invoke<string>("start_event_naming_job", {
        stagingDir,
        request,
      });
      setQueuedNamingJobId(jobId);
      setMessage(`Queued naming job ${jobId}. Progress will appear in Jobs.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingNamingJob(false);
    }
  }

  async function scanArchiveLibrary() {
    if (!archiveDir) {
      setError("Set the archive directory in Settings before scanning the existing library.");
      return;
    }

    setQueueingArchiveScan(true);
    setError(null);
    setMessage(null);
    try {
      try {
        await invoke("reveal_in_explorer", { path: archiveDir });
      } catch {
      }

      const prefill = await invoke<PrefillEventNamingFromArchiveResult>("prefill_event_naming_from_archive", {
        stagingDir,
        archiveDir,
      });
      setCatalog(prefill.catalog);
      setPlannedAssignments((current) => {
        const next = { ...current };
        for (const assignment of prefill.assignments) {
          if (!next[assignment.directory]) {
            next[assignment.directory] = assignment;
          }
        }
        return next;
      });
      if (prefill.assignments.length > 0) {
        setShowPlannedOnly(true);
      }
      setMessage(
        prefill.matchedDirectories > 0
          ? `Prefilled ${prefill.matchedDirectories} unnamed day folder${prefill.matchedDirectories === 1 ? "" : "s"} from the archive using the exact NAS folder names.`
          : "No same-day archive matches were found for unnamed staging folders.",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingArchiveScan(false);
    }
  }

  async function purgeLibraryData() {
    const confirmed = window.confirm(
      "Purge all saved event types, locations, and tags from the naming library?\n\nThis does not rename or remove any photo folders. It only clears the saved naming catalog.",
    );
    if (!confirmed) {
      return;
    }

    setPurgingLibrary(true);
    setError(null);
    setMessage(null);
    try {
      const emptyCatalog: EventNamingCatalog = {
        eventTypes: [],
        peopleTags: [],
        groupTags: [],
        generalTags: [],
      };
      const saved = await invoke<EventNamingCatalog>("save_event_naming_catalog", { catalog: emptyCatalog });
      setCatalog(saved);
      setMessage("Naming library cleared.");
    } catch (e) {
      setError(String(e));
    } finally {
      setPurgingLibrary(false);
    }
  }

  async function pauseArchiveScan(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("pause_process_job", { jobId });
    } catch (e) {
      setError(String(e));
    }
  }

  async function resumeArchiveScan(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("resume_process_job", { jobId });
    } catch (e) {
      setError(String(e));
    }
  }

  async function abortArchiveScan(jobId: string) {
    setError(null);
    try {
      await invoke<boolean>("abort_process_job", { jobId });
    } catch (e) {
      setError(String(e));
    }
  }

  function renderArchiveScanJob(job: ProcessJob) {
    const progress = pct(job.done, job.total);
    const canPause = job.status === "queued" || job.status === "running";
    const canResume = job.status === "paused";
    const canAbort = job.status === "queued" || job.status === "running" || job.status === "paused";

    return (
      <div key={job.id} className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-3 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-medium text-white">Archive Naming Scan</div>
            <div className="text-xs text-gray-500 break-all">{job.scopeDir}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-surface-500 bg-surface-800 px-2 py-1 text-xs capitalize text-gray-200">
              {job.status}
            </span>
          </div>
        </div>

        <div className="space-y-1">
          <progress
            className={`progress-native ${job.status === "running" ? "progress-emerald" : job.status === "paused" ? "progress-amber" : "progress-blue"}`}
            max={Math.max(job.total, 1)}
            value={Math.min(Math.max(job.done, 0), Math.max(job.total, 1))}
            aria-label="Archive naming scan progress"
          />
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>{progress.toFixed(0)}%</span>
            <span>{job.done}/{job.total || 0} scanned</span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="rounded bg-surface-800 px-2 py-1.5">
            <div className="text-gray-500">Scanned</div>
            <div className="font-semibold text-white">{job.processed}</div>
          </div>
          <div className="rounded bg-surface-800 px-2 py-1.5">
            <div className="text-gray-500">Matched</div>
            <div className="font-semibold text-yellow-300">{job.resultCount}</div>
          </div>
          <div className="rounded bg-surface-800 px-2 py-1.5">
            <div className="text-gray-500">Created</div>
            <div className="font-semibold text-gray-200">{job.createdAt}</div>
          </div>
          <div className="rounded bg-surface-800 px-2 py-1.5">
            <div className="text-gray-500">Current</div>
            <div className="font-semibold text-gray-200 truncate">{job.currentFile}</div>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" onClick={() => pauseArchiveScan(job.id)} disabled={!canPause}>Pause</button>
          <button className="btn-secondary" onClick={() => resumeArchiveScan(job.id)} disabled={!canResume}>Resume</button>
          <button className="btn-danger" onClick={() => abortArchiveScan(job.id)} disabled={!canAbort}>Abort</button>
        </div>

        {job.logs.length > 0 && (
          <div className="rounded border border-surface-600 bg-gray-950 px-3 py-2 text-xs text-green-300 font-mono max-h-36 overflow-auto whitespace-pre-wrap">
            {job.logs.slice(-8).join("\n")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-white mb-2">Name Events</h2>
        <p className="text-gray-400 text-sm max-w-4xl">
          Rename day folders using a structured format such as <span className="text-gray-200">DD - PoloX - Sale - Patrick, Trafalgar Team</span>.
          Build up reusable event types, locations, and categorized tags while applying one naming pattern across consecutive days.
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          className={activeTab === "naming" ? "btn-primary" : "btn-secondary"}
          onClick={() => setActiveTab("naming")}
        >
          Name Folders
        </button>
        <button
          className={activeTab === "library" ? "btn-primary" : "btn-secondary"}
          onClick={() => setActiveTab("library")}
        >
          Manage Library
        </button>
      </div>

      {(settingsError || error) && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-red-300 text-sm">
          {settingsError ?? error}
        </div>
      )}

      {message && (
        <div className="bg-emerald-900/30 border border-emerald-700 rounded-lg px-4 py-3 text-emerald-200 text-sm">
          {message}
        </div>
      )}

      {activeTab === "naming" ? (
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.8fr)] gap-6 items-start">
        <section className="card flex flex-col space-y-4 xl:min-h-[76vh]">
          <div className="space-y-4 border-b border-surface-700 pb-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Day Folders</h3>
              <p className="text-xs text-gray-500 mt-1">
                Staging root: <span className="text-gray-300 break-all">{stagingDir || "Not configured"}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Archive root: <span className="text-gray-300 break-all">{archiveDir || "Not configured"}</span>
              </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button className="btn-secondary" onClick={refreshAll} disabled={loading || !stagingDir}>
                  Refresh
                </button>
                <button
                  className="btn-secondary"
                  onClick={scanArchiveLibrary}
                  disabled={queueingArchiveScan}
                  title={archiveDir ? "Scan the archive to grow the naming library" : "Set Archive / NAS Directory in Settings first"}
                >
                  {queueingArchiveScan ? "Queueing Archive Scan..." : "Scan Archive Library"}
                </button>
                <button className="btn-secondary" onClick={selectConsecutiveDays} disabled={selectedPaths.length === 0 && !activeComposerDirectory}>
                  Check Consecutive Days
                </button>
                <button className="btn-secondary" onClick={clearSelection} disabled={selectedPaths.length === 0}>
                  Clear Checks
                </button>
                <button className="btn-secondary" onClick={clearNamingPlan} disabled={plannedRows.length === 0}>
                  Clear Plan
                </button>
                <button className={showPlannedOnly ? "btn-primary" : "btn-secondary"} onClick={() => setShowPlannedOnly((current) => !current)} disabled={plannedRows.length === 0 && !showPlannedOnly}>
                  {showPlannedOnly ? "Show All Days" : "Planned Only"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
              <div className="rounded-lg border border-surface-700 bg-surface-900/80 px-3 py-3">
                <div className="uppercase tracking-wide text-gray-500">Day Folders</div>
                <div className="mt-1 text-lg font-semibold text-white">{directories.length}</div>
              </div>
              <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-3">
                <div className="uppercase tracking-wide text-accent/80">Checked</div>
                <div className="mt-1 text-lg font-semibold text-white">{selectedDirectories.length}</div>
              </div>
              <div className="rounded-lg border border-surface-700 bg-surface-900/80 px-3 py-3">
                <div className="uppercase tracking-wide text-gray-500">Years</div>
                <div className="mt-1 text-lg font-semibold text-white">{directoryTree.length}</div>
              </div>
              <div className="rounded-lg border border-emerald-700/30 bg-emerald-900/10 px-3 py-3">
                <div className="uppercase tracking-wide text-emerald-300/80">Planned</div>
                <div className="mt-1 text-lg font-semibold text-white">{plannedRows.length}</div>
              </div>
              <div className="rounded-lg border border-surface-700 bg-surface-900/80 px-3 py-3 lg:col-span-4">
                <div className="uppercase tracking-wide text-gray-500">Focused Row</div>
                <div className="mt-1 truncate text-sm font-medium text-cyan-300" title={activeComposerDirectory?.name ?? "None"}>
                  {activeComposerDirectory?.name ?? "None"}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 px-1">
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">Folder Tree</div>
              <div className="mt-1 text-xs text-gray-500">Check a batch, shift-click to extend a range, then apply that draft to the checked days.</div>
            </div>
            <div className="text-xs text-gray-500">
              {showPlannedOnly ? `Showing ${plannedRows.length} planned day folder${plannedRows.length === 1 ? "" : "s"}` : `Showing ${directoryTree.length} year groups`}
            </div>
          </div>

          <div className="flex-1 min-h-[68vh] max-h-[78vh] overflow-auto space-y-2 pr-1">
            {directoryTree.length === 0 ? (
              <div className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-6 text-sm text-gray-400">
                {stagingDir
                  ? showPlannedOnly
                    ? "No planned day folders are visible yet. Apply a draft to one or more days first."
                    : "No day folders found under the staging directory yet."
                  : "Set the staging directory in Settings to load day folders."}
              </div>
            ) : (
              directoryTree.map((yearNode) => {
                const yearOpen = openYearIds.includes(yearNode.id);
                return (
                  <div key={yearNode.id} className="rounded-xl border border-surface-600 bg-surface-900/90 overflow-hidden shadow-sm shadow-black/20">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-850 transition-colors"
                      onClick={() => toggleYear(yearNode.id)}
                    >
                      <span className="text-sm font-semibold text-white">{yearOpen ? "▾" : "▸"} {yearNode.label}</span>
                      <span className="text-xs text-gray-500">{yearNode.months.reduce((sum, month) => sum + month.directories.length, 0)} days</span>
                    </button>

                    {yearOpen && (
                      <div className="border-t border-surface-700">
                        {yearNode.months.map((monthNode) => {
                          const monthOpen = openMonthIds.includes(monthNode.id);
                          return (
                            <div key={monthNode.id} className="border-b border-surface-800 last:border-b-0">
                              <button
                                type="button"
                                className="w-full flex items-center justify-between px-7 py-2.5 text-left hover:bg-surface-850 transition-colors"
                                onClick={() => toggleMonth(monthNode.id)}
                              >
                                <span className="text-sm text-gray-200">{monthOpen ? "▾" : "▸"} Month {monthNode.label}</span>
                                <span className="text-xs text-gray-500">{monthNode.directories.length} folders</span>
                              </button>

                              {monthOpen && (
                                <div className="space-y-2 px-4 pb-4">
                                  {monthNode.directories.map((directory) => {
                                    const selected = selectedPaths.includes(directory.path);
                                    const plannedAssignment = plannedAssignments[directory.path];
                                    const composerOpen = activeComposerPath === directory.path;
                                    const previewName = formatInlinePreview(directory, eventType, location, peopleTags, groupTags, generalTags);
                                    const assignmentSourceLabel = plannedAssignment ? getAssignmentSourceLabel(plannedAssignment) : null;
                                    const plannedPreviewName = plannedAssignment ? getAssignmentPreviewName(directory.day, plannedAssignment) : null;
                                    return (
                                      <div
                                        key={directory.path}
                                        className={`rounded-lg border transition-colors ${selected ? "border-accent bg-accent/10" : plannedAssignment ? "border-emerald-700/60 bg-emerald-950/10 hover:border-emerald-500" : "border-surface-700 bg-surface-850/80 hover:border-surface-500"}`}
                                      >
                                        <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-start px-3 py-3">
                                          <input
                                            type="checkbox"
                                            checked={selected}
                                            onChange={(e) => toggleDirectory(directory.path, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                                            className="mt-1 h-4 w-4"
                                            aria-label={`Check ${directory.name}`}
                                            title={`Check ${directory.name}${showPlannedOnly ? "" : " (shift-click for a range)"}`}
                                          />
                                          <div className="min-w-0">
                                            <button
                                              type="button"
                                              className="text-left w-full"
                                              onClick={() => {
                                                openInlineComposer(directory);
                                                loadDirectoryIntoComposer(directory);
                                              }}
                                            >
                                              <div className="text-sm text-white break-all hover:text-cyan-300 transition-colors">{directory.name}</div>
                                            </button>
                                            <div className="text-xs text-gray-500 mt-1">{directory.dateKey} · {directory.relativePath}</div>
                                            {plannedPreviewName ? (
                                              <div className="text-xs text-emerald-300 break-all mt-1">Planned Rename: {plannedPreviewName}</div>
                                            ) : selected && (eventType.trim() || location.trim() || combineTags(peopleTags, groupTags, generalTags).length > 0) && (
                                              <div className="text-xs text-cyan-300 break-all mt-1">Checked Draft: {previewName}</div>
                                            )}
                                          </div>
                                          <div className="flex flex-col items-end gap-1">
                                            {plannedAssignment && (
                                              <div className="text-[11px] px-2 py-1 rounded border border-emerald-700 text-emerald-200 bg-emerald-900/20">
                                                Planned
                                              </div>
                                            )}
                                            {assignmentSourceLabel && (
                                              <div className={`text-[11px] px-2 py-1 rounded border ${plannedAssignment?.source === "archive_prefill" ? "border-cyan-700 text-cyan-200 bg-cyan-900/20" : "border-surface-600 text-gray-300 bg-surface-800"}`}>
                                                {assignmentSourceLabel}
                                              </div>
                                            )}
                                            <div className={`text-xs px-2 py-1 rounded border ${directory.hasCustomName ? "border-amber-700 text-amber-200 bg-amber-900/20" : "border-surface-600 text-gray-400 bg-surface-800"}`}>
                                              {directory.hasCustomName ? "Named" : "Day Only"}
                                            </div>
                                          </div>
                                        </div>

                                        {composerOpen && (
                                          <div className="border-t border-surface-700 px-3 py-2 bg-surface-900">
                                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                              <span className="text-cyan-300 font-medium">Edit</span>
                                              {previousDaySuggestion && (
                                                <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => applySuggestion(previousDaySuggestion)}>
                                                  Prev Day
                                                </button>
                                              )}
                                              {holidaySuggestion && (
                                                <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => applySuggestion(holidaySuggestion)}>
                                                  Christmas
                                                </button>
                                              )}
                                              <LookupInput
                                                value={eventType}
                                                placeholder="Event"
                                                title="Event type"
                                                widthClass="w-36"
                                                options={matchingEventTypes}
                                                open={eventLookupOpen}
                                                onFocus={() => setEventLookupOpen(true)}
                                                onBlur={() => window.setTimeout(() => {
                                                  setEventLookupOpen(false);
                                                  void persistEventLocationLookup(eventType, location);
                                                }, 120)}
                                                onChange={(nextValue) => {
                                                  setEventType(nextValue);
                                                  setEventLookupOpen(true);
                                                }}
                                                onSelect={handleEventTypeSelect}
                                                onCommit={commitEventLookup}
                                              />
                                              <LookupInput
                                                value={location}
                                                placeholder="Location"
                                                title="Location"
                                                widthClass="w-32"
                                                options={matchingLocations}
                                                open={locationLookupOpen && matchingLocations.length > 0}
                                                onFocus={() => setLocationLookupOpen(true)}
                                                onBlur={() => window.setTimeout(() => {
                                                  setLocationLookupOpen(false);
                                                  void persistEventLocationLookup(eventType, location);
                                                }, 120)}
                                                onChange={(nextValue) => {
                                                  setLocation(nextValue);
                                                  setLocationLookupOpen(true);
                                                }}
                                                onSelect={handleLocationSelect}
                                                onCommit={commitLocationLookup}
                                              />
                                              <input
                                                type="text"
                                                list="event-people-tag-options-inline"
                                                className="input-field h-9 w-36"
                                                value={peopleTagInput}
                                                onChange={(e) => setPeopleTagInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                  if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    addTag(peopleTagInput, peopleTags, setPeopleTags, () => setPeopleTagInput(""));
                                                  }
                                                }}
                                                placeholder="People tags"
                                                title="People tags"
                                              />
                                              <input
                                                type="text"
                                                list="event-group-tag-options-inline"
                                                className="input-field h-9 w-36"
                                                value={groupTagInput}
                                                onChange={(e) => setGroupTagInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                  if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    addTag(groupTagInput, groupTags, setGroupTags, () => setGroupTagInput(""));
                                                  }
                                                }}
                                                placeholder="Group tags"
                                                title="Group tags"
                                              />
                                              <input
                                                type="text"
                                                list="event-general-tag-options-inline"
                                                className="input-field h-9 w-40"
                                                value={generalTagInput}
                                                onChange={(e) => setGeneralTagInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                  if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    addTag(generalTagInput, generalTags, setGeneralTags, () => setGeneralTagInput(""));
                                                  }
                                                }}
                                                placeholder="General tags"
                                                title="General tags"
                                              />
                                              <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => selectOnlyDirectory(directory.path)}>
                                                Check Only
                                              </button>
                                              <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => toggleDirectory(directory.path, !selected)}>
                                                {selected ? "Uncheck" : "Check"}
                                              </button>
                                              <button className="btn-primary px-2 py-1 text-xs" type="button" onClick={applyDraftToCheckedDays}>
                                                {selectedDirectories.length > 0 ? `Apply to ${selectedDirectories.length} Checked` : "Apply to Focused Day"}
                                              </button>
                                              {plannedAssignment && (
                                                <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => removePlannedDay(directory.path)}>
                                                  Remove Plan
                                                </button>
                                              )}
                                              <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => setActiveComposerPath(null)}>
                                                Close
                                              </button>
                                              <span className="min-w-[18rem] flex-1 text-cyan-300 truncate" title={formatInlinePreview(directory, eventType, location, peopleTags, groupTags, generalTags)}>
                                                {formatInlinePreview(directory, eventType, location, peopleTags, groupTags, generalTags)}
                                              </span>
                                              {persistingLookup && <span className="text-[11px] text-gray-500">Saving lookup...</span>}
                                              <datalist id="event-people-tag-options-inline">
                                                {catalog.peopleTags.map((tag) => (
                                                  <option key={tag} value={tag} />
                                                ))}
                                              </datalist>
                                              <datalist id="event-group-tag-options-inline">
                                                {catalog.groupTags.map((tag) => (
                                                  <option key={tag} value={tag} />
                                                ))}
                                              </datalist>
                                              <datalist id="event-general-tag-options-inline">
                                                {catalog.generalTags.map((tag) => (
                                                  <option key={tag} value={tag} />
                                                ))}
                                              </datalist>
                                            </div>
                                            {(peopleTags.length > 0 || groupTags.length > 0 || generalTags.length > 0) && (
                                              <div className="mt-2 flex flex-wrap gap-2">
                                                {peopleTags.map((tag) => (
                                                  <button
                                                    key={`person-${tag}`}
                                                    type="button"
                                                    className="rounded-full border border-cyan-700 bg-cyan-900/20 px-2 py-1 text-[11px] text-cyan-200"
                                                    onClick={() => removeTag(tag, peopleTags, setPeopleTags)}
                                                    title="Remove people tag"
                                                  >
                                                    {tag} ×
                                                  </button>
                                                ))}
                                                {groupTags.map((tag) => (
                                                  <button
                                                    key={`group-${tag}`}
                                                    type="button"
                                                    className="rounded-full border border-violet-700 bg-violet-900/20 px-2 py-1 text-[11px] text-violet-200"
                                                    onClick={() => removeTag(tag, groupTags, setGroupTags)}
                                                    title="Remove group tag"
                                                  >
                                                    {tag} ×
                                                  </button>
                                                ))}
                                                {generalTags.map((tag) => (
                                                  <button
                                                    key={`general-${tag}`}
                                                    type="button"
                                                    className="rounded-full border border-emerald-700 bg-emerald-900/20 px-2 py-1 text-[11px] text-emerald-200"
                                                    onClick={() => removeTag(tag, generalTags, setGeneralTags)}
                                                    title="Remove general tag"
                                                  >
                                                    {tag} ×
                                                  </button>
                                                ))}
                                              </div>
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
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="card space-y-4 xl:sticky xl:top-6 xl:max-h-[82vh] xl:overflow-auto">
          <div>
            <h3 className="text-sm uppercase tracking-wide text-gray-400">Naming Plan</h3>
            <p className="text-xs text-gray-500 mt-1">
              Check the days you want to group together, apply the current draft to those days, then move on to the next group. Queueing uses the saved plan, not just the current checks.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-3">
              <div className="uppercase tracking-wide text-gray-500">Checked</div>
              <div className="mt-1 text-lg font-semibold text-white">{selectedDirectories.length}</div>
            </div>
            <div className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-3">
              <div className="uppercase tracking-wide text-gray-500">Focused Day</div>
              <div className="mt-1 truncate text-sm font-medium text-cyan-300" title={activeComposerDirectory?.dateKey ?? "No row open"}>
                {activeComposerDirectory?.dateKey ?? "No row open"}
              </div>
            </div>
            <div className="rounded-lg border border-emerald-700/30 bg-emerald-900/10 px-3 py-3">
              <div className="uppercase tracking-wide text-emerald-300/80">Planned</div>
              <div className="mt-1 text-lg font-semibold text-white">{plannedRows.length}</div>
            </div>
            <div className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-3">
              <div className="uppercase tracking-wide text-gray-500">Latest Naming Job</div>
              <div className="mt-1 truncate text-sm font-medium text-white capitalize" title={latestNamingJob?.status ?? "No jobs yet"}>
                {latestNamingJob?.status ?? "No jobs yet"}
              </div>
            </div>
            <div className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-3 col-span-2">
              <div className="uppercase tracking-wide text-gray-500">Current Draft</div>
              <div className="mt-1 truncate text-sm font-medium text-cyan-300" title={eventType.trim() || location.trim() || combineTags(peopleTags, groupTags, generalTags).join(", ") || "Not set"}>
                {eventType.trim() || location.trim() || combineTags(peopleTags, groupTags, generalTags).join(", ") || "Not set"}
              </div>
            </div>
          </div>

          {(previousDaySuggestion || holidaySuggestion) && (
            <div className="rounded-lg border border-cyan-800 bg-cyan-950/20 px-4 py-3 space-y-2">
              <div className="text-xs uppercase tracking-wide text-cyan-300">Suggestions</div>
              <div className="flex gap-2 flex-wrap">
                {previousDaySuggestion && (
                  <button className="btn-secondary" onClick={() => applySuggestion(previousDaySuggestion)}>
                    {previousDaySuggestion.label}
                  </button>
                )}
                {holidaySuggestion && (
                  <button className="btn-secondary" onClick={() => applySuggestion(holidaySuggestion)}>
                    {holidaySuggestion.label}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-3 space-y-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Draft Values</div>
            <div className="grid grid-cols-1 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Event Type</div>
                <div className="mt-1 text-white">{eventType.trim() || "Not set"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Location</div>
                <div className="mt-1 text-white">{location.trim() || "Not set"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-cyan-300">People Tags</div>
                <div className="mt-2 flex flex-wrap gap-2 min-h-6">
                  {peopleTags.length === 0 ? <span className="text-xs text-gray-500">None</span> : peopleTags.map((tag) => <span key={`summary-person-${tag}`} className="rounded-full border border-cyan-700 bg-cyan-900/20 px-2 py-1 text-xs text-cyan-200">{tag}</span>)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-violet-300">Group Tags</div>
                <div className="mt-2 flex flex-wrap gap-2 min-h-6">
                  {groupTags.length === 0 ? <span className="text-xs text-gray-500">None</span> : groupTags.map((tag) => <span key={`summary-group-${tag}`} className="rounded-full border border-violet-700 bg-violet-900/20 px-2 py-1 text-xs text-violet-200">{tag}</span>)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-300">General Tags</div>
                <div className="mt-2 flex flex-wrap gap-2 min-h-6">
                  {generalTags.length === 0 ? <span className="text-xs text-gray-500">None</span> : generalTags.map((tag) => <span key={`summary-general-${tag}`} className="rounded-full border border-emerald-700 bg-emerald-900/20 px-2 py-1 text-xs text-emerald-200">{tag}</span>)}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-3 space-y-2 max-h-64 overflow-auto">
            <div className="text-xs uppercase tracking-wide text-gray-500">Planned Renames</div>
            {plannedRows.length === 0 ? (
              <div className="text-sm text-gray-500">No days have been added to the naming plan yet.</div>
            ) : (
              plannedRows.map((row) => (
                <div key={row.path} className="flex items-start justify-between gap-3 text-sm text-gray-200 break-all">
                  <div>
                    {row.dateKey}: <span className="text-emerald-300">{row.previewName}</span>
                    {getAssignmentSourceLabel(row.assignment) && (
                      <div className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] ${row.assignment.source === "archive_prefill" ? "border-cyan-700 bg-cyan-900/20 text-cyan-200" : "border-surface-600 bg-surface-800 text-gray-300"}`}>
                        {getAssignmentSourceLabel(row.assignment)}
                      </div>
                    )}
                  </div>
                  <button className="btn-secondary px-2 py-1 text-xs" type="button" onClick={() => removePlannedDay(row.path)}>
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-3 space-y-2 max-h-48 overflow-auto">
            <div className="text-xs uppercase tracking-wide text-gray-500">Current Draft Preview</div>
            {draftPreviewRows.length === 0 ? (
              <div className="text-sm text-gray-500">Focus a day or check one or more days to see where the current draft will land.</div>
            ) : (
              draftPreviewRows.map((row) => (
                <div key={row.path} className="text-sm text-gray-200 break-all">
                  {row.dateKey}: <span className="text-cyan-300">{row.previewName}</span>
                </div>
              ))
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            <button className="btn-primary" onClick={applyDraftToCheckedDays} disabled={draftSelection.length === 0}>
              {selectedDirectories.length > 0 ? `Apply Draft to ${selectedDirectories.length} Checked` : "Apply Draft to Focused Day"}
            </button>
            <button className="btn-primary" onClick={queueNamingJob} disabled={queueingNamingJob || plannedRows.length === 0}>
              {queueingNamingJob ? "Queueing..." : "Queue Naming Job"}
            </button>
          </div>
        </section>
      </div>
      ) : (
      <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.05fr] gap-6">
        <section className="card space-y-4">
          <div>
            <h3 className="text-sm uppercase tracking-wide text-gray-400">Library Data</h3>
            <p className="text-xs text-gray-500 mt-1">Edit event types, locations, and every saved tag bucket, then save the whole catalog in one pass.</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="rounded bg-surface-900 px-3 py-2">
              <div className="text-gray-500">Event Types</div>
              <div className="text-lg font-semibold text-white">{catalog.eventTypes.length}</div>
            </div>
            <div className="rounded bg-surface-900 px-3 py-2">
              <div className="text-gray-500">People Tags</div>
              <div className="text-lg font-semibold text-cyan-300">{catalog.peopleTags.length}</div>
            </div>
            <div className="rounded bg-surface-900 px-3 py-2">
              <div className="text-gray-500">Group Tags</div>
              <div className="text-lg font-semibold text-violet-300">{catalog.groupTags.length}</div>
            </div>
            <div className="rounded bg-surface-900 px-3 py-2">
              <div className="text-gray-500">General Tags</div>
              <div className="text-lg font-semibold text-emerald-300">{catalog.generalTags.length}</div>
            </div>
          </div>

          <div className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-3 space-y-3">
            <div>
              <div className="text-sm font-medium text-white">Archive Prefill</div>
              <div className="text-xs text-gray-500 mt-1 break-all">Archive root: {archiveDir || "Not configured"}</div>
              {latestArchiveScanJob && (
                <div className="text-xs text-gray-500 mt-1">Latest historical archive scan job: <span className="text-gray-300 capitalize">{latestArchiveScanJob.status}</span></div>
              )}
              <div className="text-xs text-gray-500 mt-1">Same-day NAS matches now prefill exact server folder names without adding them to the lookup library.</div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                className="btn-secondary"
                onClick={scanArchiveLibrary}
                disabled={queueingArchiveScan}
                title={archiveDir ? "Open the archive and prefill local unnamed day folders from same-day NAS names" : "Set Archive / NAS Directory in Settings first"}
              >
                {queueingArchiveScan ? "Prefilling from Archive..." : "Scan Archive Library"}
              </button>
              <button className="btn-danger" onClick={purgeLibraryData} disabled={purgingLibrary || savingLibrary}>
                {purgingLibrary ? "Purging..." : "Purge Library Data"}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-surface-600 bg-surface-900/80 px-4 py-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Catalog Editor</div>
                <div className="mt-1 text-xs text-gray-500">Blank rows are ignored when you save. Duplicate names and locations are merged automatically.</div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className={`text-xs rounded-full px-3 py-1 border ${libraryDirty ? "border-amber-700 bg-amber-900/20 text-amber-200" : "border-emerald-700 bg-emerald-900/20 text-emerald-200"}`}>
                  {libraryDirty ? "Unsaved changes" : "Saved"}
                </div>
                <button className="btn-secondary" type="button" onClick={discardLibraryDraft} disabled={!libraryDirty || savingLibrary}>
                  Discard Changes
                </button>
                <button className="btn-primary" type="button" onClick={saveLibraryDraft} disabled={savingLibrary || !libraryDirty}>
                  {savingLibrary ? "Saving..." : "Save Library Changes"}
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-xs uppercase tracking-wide text-gray-500">Event Types</div>
                  <div className="mt-1 text-xs text-gray-500">Rename event types directly and manage all of their allowed locations.</div>
                </div>
                <button className="btn-secondary" type="button" onClick={addDraftEventType}>
                  Add Event Type
                </button>
              </div>

              <div className="mt-3 space-y-3 max-h-[48vh] overflow-auto pr-1">
                {libraryDraft.eventTypes.length === 0 ? (
                  <div className="rounded border border-dashed border-surface-600 px-4 py-4 text-sm text-gray-500">
                    No event types yet. Add one to start curating the library.
                  </div>
                ) : (
                  libraryDraft.eventTypes.map((item, eventTypeIndex) => (
                    <div key={`draft-event-${eventTypeIndex}`} className="rounded-lg border border-surface-600 bg-surface-950/70 px-4 py-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          className="input-field flex-1"
                          value={item.name}
                          onChange={(e) => updateDraftEventTypeName(eventTypeIndex, e.target.value)}
                          placeholder="Event type name"
                        />
                        <button className="btn-danger px-3 py-2 text-xs" type="button" onClick={() => removeDraftEventType(eventTypeIndex)}>
                          Remove Event
                        </button>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="text-xs uppercase tracking-wide text-gray-500">Locations</div>
                          <button className="btn-secondary px-3 py-2 text-xs" type="button" onClick={() => addDraftLocation(eventTypeIndex)}>
                            Add Location
                          </button>
                        </div>

                        {item.locations.length === 0 ? (
                          <div className="rounded border border-dashed border-surface-600 px-3 py-3 text-sm text-gray-500">
                            No locations saved for this event type yet.
                          </div>
                        ) : (
                          item.locations.map((savedLocation, locationIndex) => (
                            <div key={`draft-location-${eventTypeIndex}-${locationIndex}`} className="flex items-center gap-2">
                              <input
                                type="text"
                                className="input-field flex-1"
                                value={savedLocation}
                                onChange={(e) => updateDraftLocation(eventTypeIndex, locationIndex, e.target.value)}
                                placeholder="Location"
                              />
                              <button className="btn-danger px-3 py-2 text-xs" type="button" onClick={() => removeDraftLocation(eventTypeIndex, locationIndex)}>
                                Remove
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
              <EditableStringListSection
                title="People Tags"
                description="Names of individual people that should stay in the people bucket."
                items={libraryDraft.peopleTags}
                accentClass="border-cyan-800 bg-cyan-950/10 text-cyan-200"
                emptyLabel="No people tags saved yet."
                addLabel="Add People Tag"
                onChange={(index, value) => updateDraftTag("peopleTags", index, value)}
                onAdd={() => addDraftTag("peopleTags")}
                onRemove={(index) => removeDraftTag("peopleTags", index)}
              />

              <EditableStringListSection
                title="Group Tags"
                description="Teams, barns, clubs, or other collective labels."
                items={libraryDraft.groupTags}
                accentClass="border-violet-800 bg-violet-950/10 text-violet-200"
                emptyLabel="No group tags saved yet."
                addLabel="Add Group Tag"
                onChange={(index, value) => updateDraftTag("groupTags", index, value)}
                onAdd={() => addDraftTag("groupTags")}
                onRemove={(index) => removeDraftTag("groupTags", index)}
              />

              <EditableStringListSection
                title="General Tags"
                description="Everything else, including horses, rounds, themes, and misc labels."
                items={libraryDraft.generalTags}
                accentClass="border-emerald-800 bg-emerald-950/10 text-emerald-200"
                emptyLabel="No general tags saved yet."
                addLabel="Add General Tag"
                onChange={(index, value) => updateDraftTag("generalTags", index, value)}
                onAdd={() => addDraftTag("generalTags")}
                onRemove={(index) => removeDraftTag("generalTags", index)}
              />
            </div>

            <div className="flex justify-end gap-2 flex-wrap pt-1">
              <button className="btn-secondary" type="button" onClick={discardLibraryDraft} disabled={!libraryDirty || savingLibrary}>
                Discard Changes
              </button>
              <button className="btn-primary" type="button" onClick={saveLibraryDraft} disabled={savingLibrary || !libraryDirty}>
                {savingLibrary ? "Saving..." : "Save Library Changes"}
              </button>
            </div>
          </div>
        </section>

        <section className="card space-y-4">
          <div>
            <h3 className="text-sm uppercase tracking-wide text-gray-400">Archive Scan Jobs</h3>
            <p className="text-xs text-gray-500 mt-1">This tab shows naming-library scan jobs directly, with progress, recent log lines, and controls.</p>
          </div>

          <div className="space-y-3 max-h-[70vh] overflow-auto pr-1">
            {archiveScanJobs.length === 0 ? (
              <div className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-6 text-sm text-gray-400">
                No archive scan jobs yet.
              </div>
            ) : (
              archiveScanJobs.map((job) => renderArchiveScanJob(job))
            )}
          </div>
        </section>
      </div>
      )}
    </div>
  );
}

function buildDirectoryTree(directories: EventDayDirectory[]): DirectoryTreeYear[] {
  const years = new Map<number, Map<number, EventDayDirectory[]>>();

  for (const directory of directories) {
    if (!years.has(directory.year)) {
      years.set(directory.year, new Map<number, EventDayDirectory[]>());
    }
    const months = years.get(directory.year)!;
    if (!months.has(directory.month)) {
      months.set(directory.month, []);
    }
    months.get(directory.month)!.push(directory);
  }

  return [...years.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, months]) => ({
      id: `year-${year}`,
      year,
      label: String(year),
      months: [...months.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([month, monthDirectories]) => ({
          id: `month-${year}-${month}`,
          year,
          month,
          label: `${String(month).padStart(2, "0")}`,
          directories: [...monthDirectories].sort((a, b) => a.day - b.day),
        })),
    }));
}

function formatInlinePreview(directory: EventDayDirectory, eventType: string, location: string, peopleTags: string[], groupTags: string[], generalTags: string[]) {
  return formatPreviewName(directory.day, eventType, location, peopleTags, groupTags, generalTags);
}

function createDraftValues(values: NamingDraftValues): NamingDraftValues {
  return {
    eventType: values.eventType,
    location: values.location,
    peopleTags: [...values.peopleTags],
    groupTags: [...values.groupTags],
    generalTags: [...values.generalTags],
  };
}

function assignmentToDraftValues(assignment: EventNamingAssignment): NamingDraftValues {
  return createDraftValues({
    eventType: assignment.eventType,
    location: assignment.location,
    peopleTags: assignment.peopleTags,
    groupTags: assignment.groupTags,
    generalTags: assignment.generalTags,
  });
}

function getAssignmentSourceLabel(assignment: EventNamingAssignment): string | null {
  if (assignment.source === "archive_prefill") {
    return "Prefilled from Archive";
  }

  if (assignment.source === "manual") {
    return "Manual";
  }

  return null;
}

function getAssignmentPreviewName(day: number, assignment: EventNamingAssignment): string {
  const exactTarget = assignment.targetName?.trim();
  if (exactTarget) {
    return exactTarget;
  }

  return formatPreviewName(
    day,
    assignment.eventType,
    assignment.location,
    assignment.peopleTags,
    assignment.groupTags,
    assignment.generalTags,
  );
}