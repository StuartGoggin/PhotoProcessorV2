// Synthetic folders and IPC only. This fixture never accesses user media.
import React from "react";
import { createRoot } from "react-dom/client";
import NameEvents from "../src/pages/NameEvents";
import "../src/styles.css";
const fixture = window as any;
fixture.__eventCalls = [];
fixture.__eventCatalog ??= { eventTypes: [{ name: "Legacy rally", locations: ["Monbulk"] }], peopleTags: [], groupTags: [], generalTags: [], favourites: [], recentEvents: [] };
fixture.__eventJobs ??= [];
fixture.__eventDays ??= [
    { date: "2026-10-04", name: "04 - Monbulk Pony Club - Rally" },
    { date: "2026-10-24", name: "24" }, { date: "2026-10-25", name: "25" },
    { date: "2026-10-31", name: "31" }, { date: "2026-11-01", name: "01" },
].map(({ date, name }: {
    date: string;
    name: string;
}) => ({
    path: `D:\\Synthetic events\\${date.slice(0, 4)}\\${date.slice(5, 7)}\\${name}`,
    relativePath: `${date.slice(0, 4)}/${date.slice(5, 7)}/${name}`, name,
    year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8), dateKey: date,
    hasCustomName: name.length > 2, event: null, warning: null,
}));
fixture.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
        fixture.__eventCalls.push({ command, args: structuredClone(args) });
        if (command === "load_settings")
            return { staging_dir: "D:\\Synthetic events", archive_dir: "D:\\Synthetic archive" };
        if (command === "load_event_naming_catalog")
            return structuredClone(fixture.__eventCatalog);
        if (command === "load_event_naming_library")
            return structuredClone(fixture.__eventCatalog);
        if (command === "list_event_day_directories") {
            if (fixture.__eventLoadError)
                throw new Error(fixture.__eventLoadError);
            return structuredClone(fixture.__eventDays);
        }
        if (command === "list_process_jobs")
            return structuredClone(fixture.__eventJobs);
        if (["list_import_jobs", "studio_list_jobs", "google_photos_list_jobs"].includes(command))
            return [];
        if (command === "preview_event_naming") {
            if (fixture.__eventPreviewError)
                throw new Error(fixture.__eventPreviewError);
            const selected = fixture.__eventDays.filter((d: any) => args.directories.includes(d.path));
            const description = args.description;
            const title = description.customName ?? [description.eventGroup, description.eventType, description.venue].filter(Boolean).join(" - ");
            const event = { schemaVersion: 1, description, dates: selected.map((d: any) => d.dateKey), title: title + (description.customName === null && description.includePeriod ? " - October 2026" : "") };
            const assignments = selected.map((d: any) => ({ directory: d.path, eventType: description.eventType, location: description.venue, peopleTags: [], groupTags: [], generalTags: [], source: "manual", targetName: `${String(d.day).padStart(2, "0")} - ${title}`, event, expectedName: d.name, expectedEventHash: "absent", replaceExisting: false }));
            return { request: { directories: [], eventType: "", location: "", peopleTags: [], groupTags: [], generalTags: [], assignments, reviewedRoot: args.stagingDir }, changes: selected.map((d: any, i: number) => ({ path: d.path, dateKey: d.dateKey, oldName: d.name, newName: assignments[i].targetName, replacesExisting: d.hasCustomName, changed: true })), warnings: [] };
        }
        if (command === "start_event_naming_job") {
            if (fixture.__eventStartError)
                throw new Error(fixture.__eventStartError);
            fixture.__eventJobs.push({ id: "event-job", task: "apply_event_naming", status: "running", done: 0, total: args.request.assignments.length, processed: 0, resultCount: 0, errors: [], logs: [], currentFile: "Naming selected dates" });
            return "event-job";
        }
        if (command === "prefill_event_naming_from_archive") {
            return { catalog: fixture.__eventCatalog, matchedDirectories: 1, assignments: [{ directory: args.directories[0], targetName: "24 - PoloX - Sale - Spring Carnival", eventType: "PoloX", location: "Sale", peopleTags: [], groupTags: [], generalTags: [] }] };
        }
        if (command === "save_event_naming_catalog") {
            fixture.__eventCatalog = structuredClone(args.catalog);
            return fixture.__eventCatalog;
        }
        if (command === "save_event_naming_favourite") {
            fixture.__eventCatalog.favourites = [...fixture.__eventCatalog.favourites.filter((t: any) => t.name !== args.favourite.name), args.favourite];
            return structuredClone(fixture.__eventCatalog);
        }
        if (command === "remove_event_naming_favourite") {
            fixture.__eventCatalog.favourites = fixture.__eventCatalog.favourites.filter((t: any) => t.name !== args.name);
            return structuredClone(fixture.__eventCatalog);
        }
        if (["pause_process_job", "resume_process_job", "abort_process_job"].includes(command))
            return null;
        throw new Error(`Unexpected event fixture command: ${command}`);
    } };
createRoot(document.getElementById("root")!).render(<React.StrictMode><NameEvents /></React.StrictMode>);
