import type { EventDescription, EventFavourite, NamingDay } from "../types/eventNaming";
export const emptyEvent = (): EventDescription => ({ eventGroup: "", eventType: "", venue: "", includePeriod: true, customName: null, peopleTags: [], groupTags: [], generalTags: [] });
export const suggestedEvents: EventFavourite[] = [
    { name: "Pony Club rally", description: { ...emptyEvent(), eventGroup: "Monbulk Pony Club", eventType: "Rally", includePeriod: false } },
    { name: "Polocrosse carnival", description: { ...emptyEvent(), eventGroup: "Polocrosse", eventType: "Spring Carnival", venue: "Sale" } },
    { name: "MGV teams", description: { ...emptyEvent(), eventGroup: "Mounted Games Victoria", eventType: "Teams", venue: "Ayr Hill" } },
];
export const tagsFromText = (value: string) => [...new Set(value.split(",").map(t => t.trim()).filter(Boolean))];
export function dateLabel(date: string, weekday = false): string {
    return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-AU", { ...(weekday ? { weekday: "short" } as const : {}), day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
export function eventPeriod(dates: string[]): string {
    const months = [...new Set(dates.map(d => d.slice(0, 7)))].sort();
    if (!months.length)
        return "";
    const sameYear = months.every(m => m.slice(0, 4) === months[0].slice(0, 4));
    const names = months.map(m => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("en-AU", { month: "long", ...(sameYear ? {} : { year: "numeric" } as const), timeZone: "UTC" }));
    return names.join(" & ") + (sameYear ? ` ${months[0].slice(0, 4)}` : "");
}
export function eventBase(draft: EventDescription): string {
    return draft.customName !== null ? draft.customName.trim() : [draft.eventGroup, draft.eventType, draft.venue].map(s => s.trim()).filter(Boolean).join(" - ");
}
export function eventTitle(draft: EventDescription, dates: string[]): string {
    const base = eventBase(draft);
    return base && draft.customName === null && draft.includePeriod && dates.length ? `${base} - ${eventPeriod(dates)}` : base;
}
export function draftForDay(day: NamingDay): EventDescription {
    if (day.event)
        return structuredClone(day.event.description);
    // Legacy hyphens are wording, not reliable field boundaries.
    return day.hasCustomName ? { ...emptyEvent(), includePeriod: false, customName: day.name.replace(/^\d{1,2}(?:\s*[-_]\s*|\s+)/, "") } : emptyEvent();
}
export function weekendPaths(day: NamingDay, all: NamingDay[]): string[] {
    const utc = new Date(`${day.dateKey}T12:00:00Z`);
    if (utc.getUTCDay() !== 0 && utc.getUTCDay() !== 6)
        return [day.path];
    utc.setUTCDate(utc.getUTCDate() + (utc.getUTCDay() === 6 ? 1 : -1));
    const adjacent = utc.toISOString().slice(0, 10);
    return all.filter(d => !d.warning && (d.dateKey === day.dateKey || d.dateKey === adjacent)).map(d => d.path);
}
