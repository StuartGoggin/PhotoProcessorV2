import type { ApplyEventNamingRequest, EventDayDirectory, EventNamingAssignment, EventNamingCatalog } from "./api";
export interface EventDescription {
    eventGroup: string;
    eventType: string;
    venue: string;
    includePeriod: boolean;
    customName: string | null;
    peopleTags: string[];
    groupTags: string[];
    generalTags: string[];
}
export interface SavedEvent {
    schemaVersion: number;
    description: EventDescription;
    dates: string[];
    title: string;
}
export interface EventFavourite {
    name: string;
    description: EventDescription;
}
export interface EventLibrary {
    schemaVersion: number;
    favourites: EventFavourite[];
    recentEvents: EventDescription[];
}
export interface NamingCatalog extends EventNamingCatalog {
    favourites?: EventFavourite[];
    recentEvents?: EventDescription[];
}
export interface NamingDay extends EventDayDirectory {
    event?: SavedEvent | null;
    warning?: string | null;
}
export interface ReviewedAssignment extends EventNamingAssignment {
    event: SavedEvent;
    expectedName: string;
    expectedEventHash: string;
    replaceExisting: boolean;
}
export interface ReviewedNamingRequest extends ApplyEventNamingRequest {
    reviewedRoot: string;
    assignments: ReviewedAssignment[];
}
export interface NamingPreview {
    request: ReviewedNamingRequest;
    changes: {
        path: string;
        dateKey: string;
        oldName: string;
        newName: string;
        replacesExisting: boolean;
        changed: boolean;
    }[];
    warnings: string[];
}
