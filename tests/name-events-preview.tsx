// Synthetic folders and IPC only. This fixture never accesses user media.
import React from "react";
import { createRoot } from "react-dom/client";
import NameEvents from "../src/pages/NameEvents";
import Review from "../src/pages/Review";
import PostProcess from "../src/pages/PostProcess";
import StagingExplorer from "../src/pages/StagingExplorer";
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
            return { staging_dir: fixture.__eventRoot || "D:\\Synthetic events", archive_dir: "D:\\Synthetic archive" };
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
        if (command === "process_jobs_snapshot")
            return { jobs: structuredClone(fixture.__eventJobs), warnings: [] };
        if (["list_import_jobs", "studio_list_jobs", "google_photos_list_jobs"].includes(command))
            return [];
        if (command === "preview_event_naming") {
            if (fixture.__eventPreviewError)
                throw new Error(fixture.__eventPreviewError);
            const selected = fixture.__eventDays.filter((d: any) => args.directories.includes(d.path));
            const description = args.description;
            const title = description.customName ?? [description.eventGroup, description.eventType, description.venue].filter(Boolean).join(" - ");
            const event = { schemaVersion: 1, description, dates: selected.map((d: any) => d.dateKey), title: title + (description.customName === null && description.includePeriod ? " - October 2026" : "") };
            const assignments = selected.map((d: any) => ({ directory: d.path, eventType: description.eventType, location: description.venue, peopleTags: [], groupTags: [], generalTags: [], source: "manual", targetName: fixture.__eventMetadataOnly ? d.name : `${String(d.day).padStart(2, "0")} - ${title}`, event, expectedName: d.name, expectedEventHash: "absent", replaceExisting: false }));
            return { request: { directories: [], eventType: "", location: "", peopleTags: [], groupTags: [], generalTags: [], assignments, reviewedRoot: args.stagingDir }, changes: selected.map((d: any, i: number) => ({ path: d.path, dateKey: d.dateKey, oldName: d.name, newName: assignments[i].targetName, replacesExisting: d.hasCustomName, changed: true })), warnings: [] };
        }
        if (command === "start_event_naming_job") {
            if (fixture.__eventStartError)
                throw new Error(fixture.__eventStartError);
            const id = fixture.__eventJobs.length ? `event-job-${fixture.__eventJobs.length + 1}` : "event-job";
            fixture.__eventJobs.push({ id, task: "apply_event_naming", stagingDir: args.stagingDir, status: "running", done: 0, total: args.request.assignments.length, processed: 0, resultCount: 0, errors: [], logs: [], currentFile: "Naming selected dates" });
            return id;
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
const root = createRoot(document.getElementById("root")!);
if (!fixture.__eventTreePage) root.render(<React.StrictMode><NameEvents /></React.StrictMode>);
else {
    const originalInvoke = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__eventImagePaths = new Map(); fixture.__eventSelections = new Map(); fixture.__eventSelectionWrites = [];
    fixture.__eventDeferred = []; fixture.__eventRequests = [];
    localStorage.setItem("photogogo.stagingExplorer.viewPrefs.v1", JSON.stringify({ viewMode: "list", mediaFilter: "all", autoPrewarmEnabled: false, preloadVisibleThumbs: false }));
    function tree() {
        const result: any = { type: "dir", path: "", name: "Synthetic events", children: [] };
        for (const day of fixture.__eventDays) {
            if (fixture.__eventOmitTreeDate === day.dateKey) continue;
            let parent = result, path = "";
            for (const part of day.relativePath.split("/")) {
                path += (path ? "/" : "") + part;
                let node = parent.children.find((child: any) => child.path === path);
                if (!node) { node = { type: "dir", name: part, path, children: [] }; parent.children.push(node); }
                parent = node;
            }
            parent.children = ["horse.jpg", "horse_BW.jpg", "horse_improved.jpg", "rider.jpg", ...(fixture.__eventCrops ? ["horse_crop.jpg", "horse_crop_BW.jpg", "horse_crop_improved.jpg"] : [])].map(name => ({ type: "file", path: day.relativePath + "/" + name, name, size: 32768 }));
            parent.children.push({ type: "dir", name: "Extras", path: day.relativePath + "/Extras", children: [] });
        }
        return result;
    }
    function allFiles(node: any): any[] { return node.type === "file" ? [node] : (node.children ?? []).flatMap(allFiles); }
    function image(path: string) {
        const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 320;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#3c5670"; ctx.fillRect(0, 0, 480, 320); ctx.fillStyle = "#efcf87"; ctx.font = "16px sans-serif"; ctx.fillText(path, 12, 70, 450);
        const data = canvas.toDataURL("image/jpeg").split(",")[1]; fixture.__eventImagePaths.set(data, path);
        return { data, mime: "image/jpeg", width: 480, height: 320 };
    }
    const hold = async (kind: string, value: any) => {
        if (!fixture["__eventHold" + kind]) return value;
        return new Promise(resolve => fixture.__eventDeferred.push({ kind, resolve: () => resolve(value) }));
    };
    fixture.__eventRelease = (kind: string) => {
        const ready = fixture.__eventDeferred.filter((item: any) => item.kind === kind);
        fixture.__eventDeferred = fixture.__eventDeferred.filter((item: any) => item.kind !== kind);
        ready.forEach((item: any) => item.resolve());
    };
    fixture.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
        const record = () => fixture.__eventCalls.push({ command, args: structuredClone(args) });
        if (command === "list_staging_tree") { record(); return hold("Tree", structuredClone(tree())); }
        if (command === "read_lightbox_image") { record(); return hold("Image", image(args.path)); }
        if (command === "read_image_base64" || command === "read_image_thumbnail_base64") { record(); return image(args.path).data; }
        if (command === "google_photos_catalogue") {
            record();
            return { root: args.root, revision: fixture.__eventSelectionWrites.length, warnings: [], assets: allFiles(tree()).map(node => ({ id: args.root + "|" + node.path, relativePath: node.path, variant: /_BW/.test(node.name) ? "bw" : /_improved/.test(node.name) ? "enhanced" : "original", ...(fixture.__eventSelections.get(args.root + "|" + node.path) ?? { selected: false, favourite: false }) })) };
        }
        if (command === "google_photos_update_selection") {
            record(); fixture.__eventSelectionWrites.push(structuredClone(args));
            const flags = { ...(fixture.__eventSelections.get(args.assetId) ?? { selected: false, favourite: false }), ...(args.selected === undefined ? {} : { selected: args.selected }), ...(args.favourite === undefined ? {} : { favourite: args.favourite }) };
            const receipt = { assetId: args.assetId, relativePath: args.relativePath, revision: fixture.__eventSelectionWrites.length, ...flags };
            await hold("Selection", null); fixture.__eventSelections.set(args.assetId, flags); return receipt;
        }
        if (command === "load_staging_tags") { record(); return { version: 1, entries: [], groups: [] }; }
        if (command === "load_staging_timeline") {
            record(); return ["horse.jpg", "rider.jpg"].map((name, i) => ({ name, relativePath: args.relativeDir + "/" + name, size: 32768, kind: "image", timestampMs: 1792857600000 + i * 1000, endTimestampMs: 1792857600000 + i * 1000, durationMs: null, timestampSource: "exif" }));
        }
        if (command === "start_process_job") { record(); return "photo-job"; }
        if (command === "raw_development_candidates") { record(); return { paths: [args.request.scopeDir + "\\Rider.CR3"], total: 1, truncated: false, runtime: { available: true, message: "Synthetic RAW list only" } }; }
        if (command === "get_raw_recipe") { record(); return { recipe: null, lastAppliedRecipe: null }; }
        if (command === "start_preview_monitor_worker") { record(); return false; }
        if (command.startsWith("prewarm_")) { record(); return 0; }
        const value = await originalInvoke(command, args);
        if (command === "start_event_naming_job") fixture.__eventRequests.push(structuredClone(args));
        return hold(command === "list_event_day_directories" ? "Days" : command === "preview_event_naming" ? "Preview" : "Unused", value);
    };
    fixture.__eventComplete = (status = "completed", count = Infinity) => {
        const request = fixture.__eventRequests.at(-1), job = fixture.__eventJobs.at(-1);
        let processed = 0;
        for (const assignment of request.request.assignments.slice(0, count)) {
            const day = fixture.__eventDays.find((item: any) => item.path === assignment.directory);
            if (!day) continue;
            const parent = day.relativePath.split("/").slice(0, -1).join("/");
            day.name = assignment.targetName; day.relativePath = parent + "/" + day.name;
            day.path = request.stagingDir + "\\" + day.relativePath.replace(/\//g, "\\");
            day.event = assignment.event; day.hasCustomName = true; processed++;
        }
        Object.assign(job, { status, processed, resultCount: processed, done: processed, errors: status === "failed" ? ["Synthetic partial naming failure"] : [] });
    };
    let page = fixture.__eventTreePage, generation = 0;
    function render() { root.render(<React.StrictMode><main id="app-main" className="h-screen overflow-auto">{page === "review" ? <Review key={generation} /> : page === "process" ? <PostProcess key={generation} /> : <StagingExplorer key={generation} />}</main></React.StrictMode>); }
    fixture.__eventSetPage = (next: string) => { page = next; generation++; render(); };
    fixture.__eventSwitchRoot = (next: string) => { fixture.__eventRoot = next; fixture.__eventDays.forEach((day: any) => { day.path = next + "\\" + day.relativePath.replace(/\//g, "\\"); }); generation++; render(); };
    render();
}
