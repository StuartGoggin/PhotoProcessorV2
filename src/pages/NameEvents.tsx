import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../hooks/useSettings";
import type { ProcessJob, EventNamingAssignment, PrefillEventNamingFromArchiveResult } from "../types";
import type { EventDescription, EventFavourite, EventLibrary, NamingCatalog, NamingDay, NamingPreview } from "../types/eventNaming";
import { dateLabel, draftForDay, emptyEvent, eventBase, eventPeriod, eventTitle, suggestedEvents, tagsFromText, weekendPaths } from "../utils/eventNaming";
import "./NameEvents.css";
const EMPTY_CATALOG: NamingCatalog = { eventTypes: [], peopleTags: [], groupTags: [], generalTags: [], favourites: [], recentEvents: [] };
const unique = (items: string[]) => [...new Set(items.map(s => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
type NamingJob = Pick<ProcessJob, "id" | "status" | "total" | "done" | "processed" | "resultCount" | "errors" | "currentFile">;
const activeJob = (job: NamingJob | null) => job && ["queued", "running", "paused"].includes(job.status);
export default function NameEvents() {
    const { settings, loading: settingsLoading, error: settingsError } = useSettings();
    const stagingDir = settings?.staging_dir ?? "";
    const [catalog, setCatalog] = useState<NamingCatalog>(EMPTY_CATALOG);
    const [days, setDays] = useState<NamingDay[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [draft, setDraft] = useState<EventDescription>(emptyEvent);
    const [filter, setFilter] = useState<"unnamed" | "all">("unnamed");
    const [month, setMonth] = useState("");
    const [query, setQuery] = useState("");
    const [lastPath, setLastPath] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [preview, setPreview] = useState<NamingPreview | null>(null);
    const [replacements, setReplacements] = useState<string[]>([]);
    const [favouriteName, setFavouriteName] = useState("");
    const [confirmFavourite, setConfirmFavourite] = useState(false);
    const [job, setJob] = useState<NamingJob | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);
    const [jobError, setJobError] = useState<string | null>(null);
    const [restoredKey, setRestoredKey] = useState("");
    const [archiveMatches, setArchiveMatches] = useState<EventNamingAssignment[]>([]);
    const actionPending = useRef(false);
    const generation = useRef(0);
    const key = stagingDir ? `photogogo.eventDraft.v1:${stagingDir.toLowerCase()}` : "";
    const locked = busy || Boolean(jobId) || Boolean(activeJob(job));
    async function refresh() {
        if (!stagingDir || actionPending.current)
            return;
        const epoch = ++generation.current;
        setLoading(true);
        setError(null);
        setPreview(null);
        try {
            const [nextCatalog, nextDays, library] = await Promise.all([
                invoke<NamingCatalog>("load_event_naming_catalog"),
                invoke<NamingDay[]>("list_event_day_directories", { stagingDir }),
                invoke<EventLibrary>("load_event_naming_library"),
            ]);
            if (epoch !== generation.current)
                return;
            setCatalog({ ...nextCatalog, ...library });
            setDays(nextDays);
            setSelected(current => current.filter(path => nextDays.some(d => d.path === path && !d.warning)));
        }
        catch (e) {
            if (epoch === generation.current)
                setError(String(e));
        }
        finally {
            if (epoch === generation.current)
                setLoading(false);
        }
    }
    useEffect(() => {
        setDays([]);
        setSelected([]);
        setDraft(emptyEvent());
        setPreview(null);
        setMonth("");
        setJob(null);
        setJobId(null);
        setNotice(null);
        if (!key)
            return;
        try {
            const saved = JSON.parse(localStorage.getItem(key) ?? "null");
            if (saved?.version === 1 && saved.draft && ["eventGroup", "eventType", "venue"].every(k => typeof saved.draft[k] === "string") && (saved.draft.customName === null || typeof saved.draft.customName === "string")) {
                const restored = { ...emptyEvent(), ...saved.draft };
                restored.includePeriod = typeof restored.includePeriod === "boolean" ? restored.includePeriod : true;
                for (const k of ["peopleTags", "groupTags", "generalTags"] as const)
                    restored[k] = Array.isArray(restored[k]) ? restored[k].filter((v: unknown) => typeof v === "string") : [];
                setDraft(restored);
                if (Array.isArray(saved.selected))
                    setSelected(saved.selected.filter((v: unknown) => typeof v === "string"));
                if (typeof saved.jobId === "string")
                    setJobId(saved.jobId);
            }
        }
        catch { /* A corrupt local draft never changes folders. */ }
        setRestoredKey(key);
        void refresh();
        return () => { generation.current++; };
    }, [key]);
    useEffect(() => {
        if (!key || restoredKey !== key)
            return;
        try {
            localStorage.setItem(key, JSON.stringify({ version: 1, draft, selected, jobId }));
        }
        catch { /* Local draft storage is optional. */ }
    }, [key, restoredKey, draft, selected, jobId]);
    useEffect(() => {
        if (!jobId)
            return;
        let alive = true, pending = false;
        const poll = async () => {
            if (pending)
                return;
            pending = true;
            try {
                const jobs = await invoke<ProcessJob[]>("list_process_jobs");
                if (!alive)
                    return;
                const next = jobs.find(j => j.id === jobId);
                if (!next) {
                    setJobId(null);
                    setJob(null);
                    setJobError("This naming job is no longer available. Refresh the dates to check which changes completed.");
                    void refresh();
                    return;
                }
                setJob(next);
                setJobError(null);
                if (!activeJob(next)) {
                    setJobId(null);
                    setPreview(null);
                    if (next.status === "completed") {
                        setSelected([]);
                        setNotice(`Updated ${next.processed} date folders; renamed ${next.resultCount}.${next.errors?.length ? ` ${next.errors.join(" ")}` : ""}`);
                    }
                    else
                        setNotice(next.errors?.[next.errors.length - 1] || `Naming ${next.status}. Completed changes are retained; review the remaining dates.`);
                    void refresh();
                }
            }
            catch (e) {
                if (alive)
                    setJobError(`Cannot read naming progress: ${String(e)}. The job may still be running.`);
            }
            finally {
                pending = false;
            }
        };
        void poll();
        const timer = window.setInterval(poll, 1200);
        return () => { alive = false; window.clearInterval(timer); };
    }, [jobId]);
    const selectedDays = useMemo(() => days.filter(d => selected.includes(d.path)), [days, selected]);
    const visible = useMemo(() => days.filter(d => (filter === "all" || !d.hasCustomName || selected.includes(d.path)) && (!month || d.dateKey.startsWith(month)) && (!query || `${d.dateKey} ${d.name} ${d.event?.title ?? ""}`.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.name.localeCompare(b.name)), [days, selected, filter, month, query]);
    const months = unique(days.map(d => d.dateKey.slice(0, 7))).reverse();
    const hiddenCount = selectedDays.filter(d => !visible.some(v => v.path === d.path)).length;
    const favourites = catalog.favourites ?? [];
    const descriptions = [...favourites, ...suggestedEvents].map(t => t.description).concat(catalog.recentEvents ?? []);
    const groups = unique(descriptions.map(d => d.eventGroup));
    const related = descriptions.filter(d => d.eventGroup.toLowerCase() === draft.eventGroup.trim().toLowerCase());
    const types = unique([...related.map(d => d.eventType), ...(draft.eventGroup.toLowerCase() === "mounted games victoria" ? ["Teams", "Pairs", "Individuals"] : [])]);
    const venues = unique(related.map(d => d.venue));
    const dates = selectedDays.map(d => d.dateKey);
    const changed = preview?.changes.filter(c => c.changed) ?? [];
    const canApply = changed.length > 0 && changed.filter(c => c.replacesExisting).every(c => replacements.includes(c.path));
    const duplicateFavourite = favourites.some(t => t.name.trim().toLowerCase() === favouriteName.trim().toLowerCase());
    function edit(next: Partial<EventDescription>) { setDraft(current => ({ ...current, ...next })); setPreview(null); setNotice(null); setConfirmFavourite(false); }
    function choose(description: EventDescription) { setDraft(structuredClone(description)); setPreview(null); setNotice("Description loaded for the selected dates. Review changes before applying."); setConfirmFavourite(false); }
    function toggle(day: NamingDay, shift: boolean) {
        setPreview(null);
        if (shift && lastPath) {
            const a = visible.findIndex(d => d.path === lastPath), b = visible.findIndex(d => d.path === day.path);
            if (a >= 0 && b >= 0) {
                setSelected(current => [...new Set([...current, ...visible.slice(Math.min(a, b), Math.max(a, b) + 1).map(d => d.path)])]);
                setLastPath(day.path);
                return;
            }
        }
        setSelected(current => current.includes(day.path) ? current.filter(p => p !== day.path) : [...current, day.path]);
        setLastPath(day.path);
    }
    function editDay(day: NamingDay) { setSelected([day.path]); setLastPath(day.path); choose(draftForDay(day)); }
    async function review() {
        if (actionPending.current || !selectedDays.length)
            return;
        actionPending.current = true;
        setBusy(true);
        setError(null);
        setReplacements([]);
        try {
            setPreview(await invoke<NamingPreview>("preview_event_naming", { stagingDir, directories: selectedDays.map(d => d.path), description: draft }));
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setBusy(false);
            actionPending.current = false;
        }
    }
    async function apply() {
        if (!preview || !canApply || actionPending.current)
            return;
        actionPending.current = true;
        setBusy(true);
        setError(null);
        const request = { ...preview.request, assignments: preview.request.assignments.filter(a => changed.some(c => c.path === a.directory)).map(a => ({ ...a, replaceExisting: replacements.includes(a.directory) })) };
        try {
            const id = await invoke<string>("start_event_naming_job", { stagingDir, request });
            setJob({ id, status: "queued", total: request.assignments.length, done: 0, processed: 0, resultCount: 0, errors: [], currentFile: "Queued" });
            setJobId(id);
            setNotice("Naming queued. Progress appears here and in Jobs.");
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setBusy(false);
            actionPending.current = false;
        }
    }
    async function saveFavourite() {
        if (!favouriteName.trim() || !eventBase(draft) || (duplicateFavourite && !confirmFavourite) || actionPending.current)
            return;
        actionPending.current = true;
        setBusy(true);
        setError(null);
        try {
            const library = await invoke<EventLibrary>("save_event_naming_favourite", { favourite: { name: favouriteName.trim(), description: draft }, replaceExisting: confirmFavourite });
            setCatalog(current => ({ ...current, ...library }));
            setFavouriteName("");
            setConfirmFavourite(false);
            setNotice("Favourite saved. Existing events have not changed.");
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            actionPending.current = false;
            setBusy(false);
        }
    }
    async function removeFavourite(item: EventFavourite) {
        if (!window.confirm(`Remove the favourite “${item.name}”? Existing event names will stay unchanged.`) || actionPending.current)
            return;
        actionPending.current = true;
        setBusy(true);
        try {
            const library = await invoke<EventLibrary>("remove_event_naming_favourite", { name: item.name });
            setCatalog(current => ({ ...current, ...library }));
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            actionPending.current = false;
            setBusy(false);
        }
    }
    async function control(action: string) {
        if (!job || actionPending.current)
            return;
        actionPending.current = true;
        setBusy(true);
        try {
            await invoke(`${action}_process_job`, { jobId: job.id });
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            actionPending.current = false;
            setBusy(false);
        }
    }
    async function findArchiveNames() {
        if (!selectedDays.length || !settings?.archive_dir || actionPending.current)
            return;
        actionPending.current = true;
        setBusy(true);
        setError(null);
        setArchiveMatches([]);
        try {
            const result = await invoke<PrefillEventNamingFromArchiveResult>("prefill_event_naming_from_archive", { stagingDir, archiveDir: settings.archive_dir, directories: selectedDays.map(d => d.path) });
            setArchiveMatches(result.assignments);
            setNotice(result.assignments.length ? "Archive descriptions found. Choose one to load it, then review the folder changes." : "No named archive folder matched the selected unnamed dates.");
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            actionPending.current = false;
            setBusy(false);
        }
    }
    function useArchiveName(assignment: EventNamingAssignment) {
        const day = days.find(d => d.path === assignment.directory);
        if (!day || !assignment.targetName)
            return;
        setSelected([day.path]);
        choose({ ...emptyEvent(), includePeriod: false, customName: assignment.targetName.replace(/^\d{1,2}(?:\s*[-_]\s*|\s+)/, ""), peopleTags: assignment.peopleTags, groupTags: assignment.groupTags, generalTags: assignment.generalTags });
    }
    return <div className="name-events">
    <header className="ne-header"><div><h2>Name Events</h2><p>Select dates, describe the event, then review the folder names.</p></div><button type="button" className="btn-secondary" disabled={loading || locked || !stagingDir} onClick={() => void refresh()}>Refresh dates</button></header>
    {(settingsError || error) && <div role="alert" className="ne-error">{settingsError || error}</div>}
    {notice && <div role="status" className="ne-notice">{notice}</div>}
    {jobError && <div role="alert" className="ne-warning">{jobError}</div>}
    {(settingsLoading || loading) && <p role="status">Loading date folders…</p>}
    {!settingsLoading && !stagingDir && <p className="ne-warning">Choose your Local Staging Directory in Settings to name event folders.</p>}
    {job && <section className="ne-job" aria-label="Naming job progress"><div><strong>{job.status === "completed" ? "Event names saved" : `Naming job: ${job.status}`}</strong><span>{job.done} / {job.total} folders · {job.currentFile}</span></div>{activeJob(job) && <div className="ne-actions">{job.status === "paused" ? <button type="button" className="btn-secondary" disabled={busy} onClick={() => void control("resume")}>Resume</button> : <button type="button" className="btn-secondary" disabled={busy} onClick={() => void control("pause")}>Pause</button>}<button type="button" className="btn-secondary" disabled={busy} onClick={() => void control("abort")}>Stop remaining changes</button></div>}</section>}
    {preview ? <section className="ne-panel ne-review" aria-label="Folder rename review">
      <div className="ne-section-head"><div><h3>Review folder names</h3><p>{changed.length} change{changed.length === 1 ? "" : "s"} · {preview.changes.length - changed.length} already up to date</p></div><button type="button" className="btn-secondary" disabled={locked} onClick={() => setPreview(null)}>Back to editing</button></div>
      <div className="ne-review-title">{preview.request.assignments[0]?.event.title}</div>
      {preview.warnings.map(w => <p className="ne-warning" key={w}>{w}</p>)}
      {preview.changes.map(c => <div className="ne-change" key={c.path} data-testid="event-change"><strong>{dateLabel(c.dateKey)}</strong><div><span>Current</span><code>{c.oldName}</code></div><div><span>Proposed</span><code>{c.newName}</code></div>{!c.changed && <p>Already up to date</p>}{c.changed && c.replacesExisting && <label className="ne-check ne-warning"><input type="checkbox" disabled={locked} checked={replacements.includes(c.path)} onChange={e => setReplacements(current => e.target.checked ? [...current, c.path] : current.filter(p => p !== c.path))}/>Replace existing event for {dateLabel(c.dateKey)}</label>}</div>)}
      <footer className="ne-footer"><span>Only these date folders will change. Photo filenames and pixels stay the same.</span><button type="button" className="btn-primary" disabled={locked || !canApply} onClick={() => void apply()}>{busy ? "Starting…" : `Apply ${changed.length} change${changed.length === 1 ? "" : "s"}`}</button></footer>
    </section> : <div className="ne-workspace">
      <section className="ne-panel ne-dates" aria-label="Choose date folders">
        <div className="ne-section-head"><h3>1. Choose dates <span>{selectedDays.length} selected</span></h3></div>
        <div className="ne-date-tools"><div className="ne-segments" aria-label="Folder filter"><button type="button" aria-pressed={filter === "unnamed"} disabled={locked} onClick={() => setFilter("unnamed")}>Unnamed</button><button type="button" aria-pressed={filter === "all"} disabled={locked} onClick={() => setFilter("all")}>All dates</button></div><input className="input-field" aria-label="Search dates and events" placeholder="Search dates or events" value={query} onChange={e => setQuery(e.target.value)} disabled={locked}/><select className="input-field" aria-label="Month" value={month} onChange={e => setMonth(e.target.value)} disabled={locked}><option value="">All months</option>{months.map(m => <option value={m} key={m}>{eventPeriod([`${m}-01`])}</option>)}</select></div>
        {hiddenCount > 0 && <p className="ne-warning">{hiddenCount} selected date{hiddenCount === 1 ? " is" : "s are"} outside this filter. They remain included in the review.</p>}
        <div className="ne-date-list">{visible.map((day, index) => <div key={day.path}>{index === 0 || day.dateKey.slice(0, 7) !== visible[index - 1].dateKey.slice(0, 7) ? <h4>{eventPeriod([day.dateKey])}</h4> : null}<div className={`ne-date-row ${selected.includes(day.path) ? "is-selected" : ""}`}><input type="checkbox" aria-label={`Select ${dateLabel(day.dateKey)}`} disabled={locked || !!day.warning} checked={selected.includes(day.path)} onChange={() => { }} onClick={e => toggle(day, e.shiftKey)}/><button type="button" className="ne-date-title" disabled={locked || !!day.warning} onClick={() => editDay(day)} aria-label={`Edit event on ${dateLabel(day.dateKey)}`}><strong>{dateLabel(day.dateKey, true)}</strong><span>{day.event?.title || (day.hasCustomName ? day.name.replace(/^\d{1,2}\s*[-_]?\s*/, "") : "Unnamed")}</span></button></div>{day.warning && <p className="ne-error">{day.warning}</p>}</div>)}{!loading && !visible.length && <div className="ne-empty">{days.length ? "No dates match this filter." : "No year / month / day folders found in the staging directory."}</div>}</div>
        <footer className="ne-date-footer"><span>{selectedDays.length} date{selectedDays.length === 1 ? "" : "s"} selected</span><div className="ne-actions"><button className="ne-text-button" type="button" disabled={locked || selectedDays.length !== 1} onClick={() => { setSelected(weekendPaths(selectedDays[0], days)); setPreview(null); }}>Select weekend</button><button className="ne-text-button" type="button" disabled={locked || !selected.length} onClick={() => setSelected([])}>Clear selection</button></div><small>Shift-click to select a range. Click a date name to edit its saved event.</small></footer>
      </section>
      <section className="ne-panel ne-description" aria-label="Event description">
        <div className="ne-section-head"><h3>2. Describe the event</h3></div>
        <fieldset disabled={locked || loading} className="ne-fields">
          <div><span className="ne-label">{favourites.length ? "Favourites" : "Suggested starting points"}</span><div className="ne-presets">{(favourites.length ? favourites : suggestedEvents).map(item => <button type="button" className="btn-secondary" key={item.name} onClick={() => choose(item.description)}>{item.name}</button>)}</div></div>
          <div className="ne-input-grid"><label className="ne-wide"><span className="ne-label">Event group <small>Club, organisation or sport</small></span><input className="input-field" aria-label="Event group" value={draft.eventGroup} onChange={e => edit({ eventGroup: e.target.value })} list="ne-groups" placeholder="Choose or type an event group" disabled={locked || draft.customName !== null}/></label><label><span className="ne-label">Event type</span><input className="input-field" aria-label="Event type" value={draft.eventType} onChange={e => edit({ eventType: e.target.value })} list="ne-types" placeholder="Rally, Teams, Carnival…" disabled={locked || draft.customName !== null}/></label><label><span className="ne-label">Venue <small>Optional</small></span><input className="input-field" aria-label="Venue" value={draft.venue} onChange={e => edit({ venue: e.target.value })} list="ne-venues" placeholder="Choose or type a venue" disabled={locked || draft.customName !== null}/></label></div>
          <datalist id="ne-groups">{groups.map(s => <option key={s} value={s}/>)}</datalist><datalist id="ne-types">{types.map(s => <option key={s} value={s}/>)}</datalist><datalist id="ne-venues">{venues.map(s => <option key={s} value={s}/>)}</datalist>
          <label className="ne-check"><input type="checkbox" checked={draft.includePeriod} disabled={locked || draft.customName !== null} onChange={e => edit({ includePeriod: e.target.checked })}/><span>Include month and year in the event name<small>{dates.length ? `From selected dates: ${eventPeriod(dates)}` : "Select dates to determine the month and year."}</small></span></label>
          <label className="ne-check"><input type="checkbox" checked={draft.customName !== null} onChange={e => edit({ customName: e.target.checked ? eventBase(draft) : null })}/>Use a custom event name</label>
          {draft.customName !== null && <label><span className="ne-label">Exact event name</span><input className="input-field" aria-label="Custom event name" value={draft.customName} onChange={e => edit({ customName: e.target.value })}/><small>Legacy names are preserved exactly. Switch off custom naming to use structured fields.</small></label>}
          <details className="ne-more"><summary>More details: people, horses and tags</summary>{(["peopleTags", "groupTags", "generalTags"] as const).map((tagKey, i) => <label key={tagKey}><span className="ne-label">{["People", "Teams and groups", "Horses and other tags"][i]}</span><input className="input-field" defaultValue={draft[tagKey].join(", ")} key={`${tagKey}:${JSON.stringify(draft[tagKey])}`} onBlur={e => edit({ [tagKey]: tagsFromText(e.target.value) })} placeholder="Separate names with commas"/></label>)}<small>Saved with the event; not added to the folder name.</small></details>
          <div className="ne-live-preview" aria-live="polite"><span className="ne-label">Event name</span><div data-testid="event-name-preview">{eventTitle(draft, dates) || "Describe the event to see its name"}</div>{selectedDays.length > 0 && eventBase(draft) && <p>Folder preview: <code>{selectedDays[0].year}\{String(selectedDays[0].month).padStart(2, "0")}\{String(selectedDays[0].day).padStart(2, "0")} - {eventBase(draft)}</code>{selectedDays.length > 1 && <span> · + {selectedDays.length - 1} more dates</span>}</p>}</div>
        </fieldset>
        <footer className="ne-footer"><span>{selectedDays.length} date folder{selectedDays.length === 1 ? "" : "s"} · one event</span><button type="button" className="btn-primary" disabled={locked || loading || !selectedDays.length || !eventBase(draft) || (draft.customName === null && !draft.eventGroup.trim())} onClick={() => void review()}>{busy ? "Checking folders…" : `Review ${selectedDays.length} change${selectedDays.length === 1 ? "" : "s"}`}</button></footer>
      </section>
    </div>}
    <details className="ne-library"><summary>Favourites &amp; recent events</summary><div className="ne-library-grid"><section><h3>Save the current description as a favourite</h3><p>Reuses the description and tags. Dates always come from your next selection.</p><label><span className="ne-label">Favourite name</span><input className="input-field" aria-label="Favourite name" value={favouriteName} onChange={e => { setFavouriteName(e.target.value); setConfirmFavourite(false); }} placeholder="For example, MGV teams at Ayr Hill" disabled={locked}/></label>{duplicateFavourite && <label className="ne-check ne-warning"><input type="checkbox" checked={confirmFavourite} onChange={e => setConfirmFavourite(e.target.checked)} disabled={locked}/>Replace the saved favourite with this description</label>}<button type="button" className="btn-secondary" onClick={() => void saveFavourite()} disabled={locked || !eventBase(draft) || !favouriteName.trim() || (duplicateFavourite && !confirmFavourite)}>Save favourite</button>{favourites.map(item => <div className="ne-favourite-row" key={item.name}><button type="button" className="ne-text-button" disabled={locked} onClick={() => choose(item.description)}>{item.name}</button><button type="button" className="ne-text-button" disabled={locked} onClick={() => void removeFavourite(item)} aria-label={`Remove favourite ${item.name}`}>Remove</button></div>)}</section><section><h3>Recent descriptions</h3><p>Added after successful naming. Choosing one does not change folders.</p><div className="ne-presets">{(catalog.recentEvents ?? []).map((description, i) => <button className="btn-secondary" type="button" key={i} disabled={locked} onClick={() => choose(description)}>{eventBase(description)}</button>)}</div>{!(catalog.recentEvents?.length) && <p>No completed events yet.</p>}<h3>Suggested starting points</h3><div className="ne-presets">{suggestedEvents.map(item => <button className="btn-secondary" type="button" key={item.name} disabled={locked} onClick={() => choose(item.description)}>{item.name}</button>)}</div></section></div></details>
    {job?.status === "completed" && <button type="button" className="btn-secondary" onClick={() => { const next = [...days].reverse().find(d => !d.hasCustomName && !d.warning); if (next) {
        setFilter("unnamed");
        setMonth("");
        setQuery("");
        editDay(next);
    } }} disabled={!days.some(d => !d.hasCustomName && !d.warning)}>Name next unnamed date</button>}
    <details className="ne-library">
      <summary>Previous names &amp; archive lookup</summary>
      <div className="ne-library-grid">
        <section><h3>Find the description used in your archive</h3><p>Select unnamed dates first. Look up matching dates in the configured archive, then choose a description to review.</p>
          <button type="button" className="btn-secondary" disabled={locked || loading || !selectedDays.some(d => !d.hasCustomName) || !settings?.archive_dir} onClick={() => void findArchiveNames()}>Find archive names for selected dates</button>
          {!settings?.archive_dir && <small>Set Archive / NAS Directory in Settings to use archive lookup.</small>}
          {archiveMatches.map(item => <button type="button" className="btn-secondary" disabled={locked} key={item.directory} onClick={() => useArchiveName(item)}>Use archive description: {item.targetName}</button>)}
        </section>
        <section><h3>Previous naming library</h3><p>Older descriptions remain available as custom names. Choosing one does not rename folders.</p><div className="ne-presets">{catalog.eventTypes.flatMap(item => (item.locations.length ? item.locations : [""]).map(location => { const name = [item.name, location].filter(Boolean).join(" - "); return <button type="button" className="btn-secondary" disabled={locked} key={name} onClick={() => choose({ ...emptyEvent(), customName: name, includePeriod: false })}>{name}</button>; }))}</div>{!catalog.eventTypes.length && <small>No previous library entries.</small>}</section>
      </div>
    </details>
    <p className="ne-root">Staging directory: {stagingDir || "Not configured"}</p>
  </div>;
}
