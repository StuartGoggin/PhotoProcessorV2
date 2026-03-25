use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;
use walkdir::WalkDir;
use crate::utils::rename_path_with_retry;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventTypeDefinition {
    pub name: String,
    pub locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventNamingCatalog {
    pub event_types: Vec<EventTypeDefinition>,
    #[serde(default)]
    pub people_tags: Vec<String>,
    #[serde(default)]
    pub group_tags: Vec<String>,
    #[serde(default)]
    pub general_tags: Vec<String>,
    #[serde(default, skip_serializing)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedEventNaming {
    event_type: String,
    location: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDayDirectory {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub date_key: String,
    pub has_custom_name: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventNamingAssignment {
    pub directory: String,
    pub event_type: String,
    pub location: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub target_name: Option<String>,
    #[serde(default)]
    pub people_tags: Vec<String>,
    #[serde(default)]
    pub group_tags: Vec<String>,
    #[serde(default)]
    pub general_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEventNamingRequest {
    pub directories: Vec<String>,
    pub event_type: String,
    pub location: String,
    #[serde(default)]
    pub people_tags: Vec<String>,
    #[serde(default)]
    pub group_tags: Vec<String>,
    #[serde(default)]
    pub general_tags: Vec<String>,
    #[serde(default)]
    pub assignments: Vec<EventNamingAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedEventDirectory {
    pub old_path: String,
    pub new_path: String,
    pub old_name: String,
    pub new_name: String,
    pub day: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct EventNamingPlan {
    pub old_path: PathBuf,
    pub new_path: PathBuf,
    pub old_name: String,
    pub new_name: String,
    pub day: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEventNamingResult {
    pub renamed: Vec<RenamedEventDirectory>,
    pub catalog: EventNamingCatalog,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEventNamingLibraryResult {
    pub catalog: EventNamingCatalog,
    pub discovered_directories: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefillEventNamingFromArchiveResult {
    pub catalog: EventNamingCatalog,
    pub matched_directories: usize,
    pub assignments: Vec<EventNamingAssignment>,
}

fn naming_catalog_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("event-naming-catalog.json");
    path
}

fn normalize_list(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::<String>::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }

        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }

    out.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    out
}

fn normalize_catalog(mut catalog: EventNamingCatalog) -> EventNamingCatalog {
    let mut merged_general = catalog.general_tags;
    merged_general.extend(catalog.tags.drain(..));

    catalog.people_tags = normalize_list(&catalog.people_tags);
    catalog.group_tags = normalize_list(&catalog.group_tags);
    catalog.general_tags = normalize_list(&merged_general);

    let mut merged = Vec::<EventTypeDefinition>::new();
    for event_type in catalog.event_types.drain(..) {
        let name = event_type.name.trim().to_string();
        if name.is_empty() {
            continue;
        }

        if let Some(existing) = merged
            .iter_mut()
            .find(|item| item.name.eq_ignore_ascii_case(&name))
        {
            existing.locations.extend(event_type.locations);
            existing.locations = normalize_list(&existing.locations);
        } else {
            merged.push(EventTypeDefinition {
                name,
                locations: normalize_list(&event_type.locations),
            });
        }
    }

    merged.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    catalog.event_types = merged;
    catalog
}

pub(crate) fn load_catalog_internal(app: &AppHandle) -> Result<EventNamingCatalog, String> {
    let path = naming_catalog_path(app);
    if !path.exists() {
        return Ok(EventNamingCatalog::default());
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<EventNamingCatalog>(&raw).map_err(|e| e.to_string())?;
    Ok(normalize_catalog(parsed))
}

pub(crate) fn save_catalog_internal(app: &AppHandle, catalog: &EventNamingCatalog) -> Result<(), String> {
    let path = naming_catalog_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let normalized = normalize_catalog(catalog.clone());
    let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn parse_day_prefix(name: &str) -> Option<u32> {
    let prefix: String = name.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if prefix.len() < 1 || prefix.len() > 2 {
        return None;
    }
    prefix.parse::<u32>().ok().filter(|day| (1..=31).contains(day))
}

fn format_event_directory_name(day: u32, event_type: &str, location: &str, tags: &[String]) -> String {
    let mut parts = vec![format!("{:02}", day)];

    let event_type = event_type.trim();
    let location = location.trim();
    let clean_tags = normalize_list(tags);

    if !event_type.is_empty() && !location.is_empty() {
        parts.push(format!("{} - {}", event_type, location));
    } else if !event_type.is_empty() {
        parts.push(event_type.to_string());
    } else if !location.is_empty() {
        parts.push(location.to_string());
    }

    if !clean_tags.is_empty() {
        parts.push(clean_tags.join(", "));
    }

    parts.join(" - ")
}

fn combine_tag_lists(people_tags: &[String], group_tags: &[String], general_tags: &[String]) -> Vec<String> {
    let mut combined = Vec::<String>::new();
    combined.extend_from_slice(people_tags);
    combined.extend_from_slice(group_tags);
    combined.extend_from_slice(general_tags);
    normalize_list(&combined)
}

fn format_event_directory_name_from_categories(
    day: u32,
    event_type: &str,
    location: &str,
    people_tags: &[String],
    group_tags: &[String],
    general_tags: &[String],
) -> String {
    let combined = combine_tag_lists(people_tags, group_tags, general_tags);
    format_event_directory_name(day, event_type, location, &combined)
}

fn parse_named_directory(name: &str) -> Option<ParsedEventNaming> {
    let parts: Vec<&str> = name.split(" - ").collect();
    if parts.len() < 2 {
        return None;
    }

    parse_day_prefix(parts[0])?;

    let event_type = parts.get(1)?.trim().to_string();
    let location = parts.get(2).map(|value| value.trim().to_string()).unwrap_or_default();
    let tags = if parts.len() > 3 {
        parts[3..]
            .join(" - ")
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };

    Some(ParsedEventNaming {
        event_type,
        location,
        tags,
    })
}

fn strip_wrapped_segments(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut paren_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut brace_depth = 0usize;

    for ch in value.chars() {
        match ch {
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            _ if paren_depth == 0 && bracket_depth == 0 && brace_depth == 0 => out.push(ch),
            _ => {}
        }
    }

    out
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_naming_component(value: &str) -> String {
    let stripped = strip_wrapped_segments(value)
        .replace('_', " ")
        .replace("–", "-")
        .replace("—", "-");
    let trimmed = stripped
        .trim()
        .trim_matches(|ch: char| ch.is_ascii_punctuation() || ch.is_whitespace());
    collapse_whitespace(trimmed)
}

fn parse_legacy_named_directory(name: &str) -> Option<ParsedEventNaming> {
    let day = parse_day_prefix(name)?;
    let mut remainder = name.trim_start();
    let day_prefix = format!("{:02}", day);
    if let Some(stripped) = remainder.strip_prefix(&day_prefix) {
        remainder = stripped;
    } else if let Some(stripped) = remainder.strip_prefix(&day.to_string()) {
        remainder = stripped;
    }

    remainder = remainder.trim_start_matches(|ch: char| ch == '-' || ch == '_' || ch == ' ');
    if remainder.is_empty() {
        return None;
    }

    let normalized = remainder
        .replace(" — ", " - ")
        .replace(" – ", " - ")
        .replace(" | ", " - ");
    let parts = normalized
        .split(" - ")
        .map(clean_naming_component)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    if parts.is_empty() {
        return None;
    }

    let event_type = parts.first().cloned().unwrap_or_default();
    let location = parts.get(1).cloned().unwrap_or_default();
    let tags = if parts.len() > 2 {
        parts[2..]
            .join(", ")
            .split(',')
            .map(clean_naming_component)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    } else {
        vec![]
    };

    if event_type.is_empty() && location.is_empty() && tags.is_empty() {
        return None;
    }

    Some(ParsedEventNaming {
        event_type,
        location,
        tags,
    })
}

fn parse_archive_directory_for_prefill(name: &str) -> Option<ParsedEventNaming> {
    parse_named_directory(name).or_else(|| parse_legacy_named_directory(name))
}

fn categorize_scanned_tag(tag: &str) -> &'static str {
    let lower = tag.to_ascii_lowercase();
    if ["team", "club", "family", "crew", "squad", "school"]
        .iter()
        .any(|keyword| lower.contains(keyword))
    {
        return "group";
    }

    let looks_like_person = tag
        .split_whitespace()
        .all(|part| !part.is_empty() && part.chars().next().map(|ch| ch.is_uppercase()).unwrap_or(false));

    if looks_like_person && !lower.chars().any(|ch| ch.is_ascii_digit()) {
        return "person";
    }

    "general"
}

fn is_candidate_day_directory(root: &Path, path: &Path) -> Option<(u32, u32, u32)> {
    let relative = path.strip_prefix(root).ok()?;
    let components: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();

    if components.len() != 3 {
        return None;
    }

    let year = components[0].parse::<u32>().ok()?;
    let month = components[1].parse::<u32>().ok()?;
    let day = parse_day_prefix(&components[2])?;
    Some((year, month, day))
}

fn merge_catalog_values(
    mut catalog: EventNamingCatalog,
    event_type: &str,
    location: &str,
    people_tags: &[String],
    group_tags: &[String],
    general_tags: &[String],
) -> EventNamingCatalog {
    let event_type = event_type.trim();
    let location = location.trim();
    let people_tags = normalize_list(people_tags);
    let group_tags = normalize_list(group_tags);
    let general_tags = normalize_list(general_tags);

    if !event_type.is_empty() {
        if let Some(existing) = catalog
            .event_types
            .iter_mut()
            .find(|item| item.name.eq_ignore_ascii_case(event_type))
        {
            existing.locations.push(location.to_string());
            existing.locations = normalize_list(&existing.locations);
        } else {
            catalog.event_types.push(EventTypeDefinition {
                name: event_type.to_string(),
                locations: if location.is_empty() {
                    vec![]
                } else {
                    vec![location.to_string()]
                },
            });
        }
    }

    catalog.people_tags.extend(people_tags);
    catalog.group_tags.extend(group_tags);
    catalog.general_tags.extend(general_tags);
    normalize_catalog(catalog)
}

pub(crate) fn collect_naming_scan_candidates(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return vec![];
    }

    let mut candidates = Vec::<PathBuf>::new();
    for entry in WalkDir::new(root)
        .min_depth(3)
        .max_depth(3)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_dir() {
            continue;
        }

        let path = entry.path().to_path_buf();
        if is_candidate_day_directory(root, &path).is_some() {
            candidates.push(path);
        }
    }

    candidates.sort();
    candidates
}

pub(crate) fn scan_catalog_entry(
    catalog: EventNamingCatalog,
    path: &Path,
) -> Result<(EventNamingCatalog, bool), String> {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return Ok((catalog, false));
    };
    let Some(parsed) = parse_named_directory(name) else {
        return Ok((catalog, false));
    };

    let mut people = Vec::<String>::new();
    let mut groups = Vec::<String>::new();
    let mut general = Vec::<String>::new();
    for tag in parsed.tags {
        match categorize_scanned_tag(&tag) {
            "person" => people.push(tag),
            "group" => groups.push(tag),
            _ => general.push(tag),
        }
    }

    Ok((
        merge_catalog_values(catalog, &parsed.event_type, &parsed.location, &people, &groups, &general),
        true,
    ))
}

fn matching_archive_day_directory(archive_root: &Path, year: u32, month: u32, day: u32) -> Option<PathBuf> {
    let month_dir = archive_root.join(year.to_string()).join(format!("{:02}", month));
    if !month_dir.exists() || !month_dir.is_dir() {
        return None;
    }

    let mut candidates = fs::read_dir(month_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let parsed_day = parse_day_prefix(&name)?;
            (parsed_day == day).then_some(entry.path())
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates.into_iter().next()
}

#[tauri::command]
pub fn prefill_event_naming_from_archive(
    app: AppHandle,
    staging_dir: String,
    archive_dir: String,
) -> Result<PrefillEventNamingFromArchiveResult, String> {
    let staging_directories = list_event_day_directories(staging_dir)?;
    let archive_root = PathBuf::from(&archive_dir);
    let catalog = load_catalog_internal(&app).unwrap_or_default();
    let mut assignments = Vec::<EventNamingAssignment>::new();

    for directory in staging_directories.into_iter().filter(|directory| !directory.has_custom_name) {
        let Some(archive_match) = matching_archive_day_directory(&archive_root, directory.year, directory.month, directory.day) else {
            continue;
        };

        let Some(archive_name) = archive_match.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(parsed) = parse_archive_directory_for_prefill(archive_name) else {
            continue;
        };

        let mut people_tags = Vec::<String>::new();
        let mut group_tags = Vec::<String>::new();
        let mut general_tags = Vec::<String>::new();
        for tag in parsed.tags {
            match categorize_scanned_tag(&tag) {
                "person" => people_tags.push(tag),
                "group" => group_tags.push(tag),
                _ => general_tags.push(tag),
            }
        }

        assignments.push(EventNamingAssignment {
            directory: directory.path,
            event_type: parsed.event_type,
            location: parsed.location,
            source: Some("archive_prefill".to_string()),
            target_name: Some(archive_name.to_string()),
            people_tags,
            group_tags,
            general_tags,
        });
    }

    Ok(PrefillEventNamingFromArchiveResult {
        catalog,
        matched_directories: assignments.len(),
        assignments,
    })
}

pub(crate) fn scan_catalog_from_root<F>(
    mut catalog: EventNamingCatalog,
    root: &Path,
    mut on_progress: F,
) -> Result<(EventNamingCatalog, usize, usize), String>
where
    F: FnMut(usize, usize, &Path) -> Result<(), String>,
{
    let candidates = collect_naming_scan_candidates(root);
    let total = candidates.len();
    let mut discovered_directories = 0usize;

    for (index, path) in candidates.iter().enumerate() {
        on_progress(index, total, path)?;
        let (next_catalog, discovered) = scan_catalog_entry(catalog, path)?;
        catalog = next_catalog;
        if discovered {
            discovered_directories += 1;
        }
    }

    Ok((catalog, discovered_directories, total))
}

pub(crate) fn build_event_naming_plans(
    request: &ApplyEventNamingRequest,
) -> Result<Vec<EventNamingPlan>, String> {
    let requested_directories = if request.assignments.is_empty() {
        request.directories.len()
    } else {
        request.assignments.len()
    };
    if requested_directories == 0 {
        return Err("No directories selected".to_string());
    }

    let mut plans = Vec::<EventNamingPlan>::new();
    let mut seen_targets = HashSet::<String>::new();
    let mut seen_sources = HashSet::<String>::new();

    let assignments = if request.assignments.is_empty() {
        request
            .directories
            .iter()
            .map(|directory| EventNamingAssignment {
                directory: directory.clone(),
                event_type: request.event_type.clone(),
                location: request.location.clone(),
                source: Some("manual".to_string()),
                target_name: None,
                people_tags: request.people_tags.clone(),
                group_tags: request.group_tags.clone(),
                general_tags: request.general_tags.clone(),
            })
            .collect::<Vec<_>>()
    } else {
        request.assignments.clone()
    };

    for assignment in assignments {
        let source_key = assignment.directory.to_ascii_lowercase();
        if !seen_sources.insert(source_key) {
            return Err(format!("Duplicate directory assignment: {}", assignment.directory));
        }

        let old_path = PathBuf::from(&assignment.directory);
        if !old_path.exists() || !old_path.is_dir() {
            return Err(format!("Directory does not exist: {}", old_path.display()));
        }

        let old_name = old_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid directory name: {}", old_path.display()))?
            .to_string();
        let day = parse_day_prefix(&old_name)
            .ok_or_else(|| format!("Could not determine day from directory name: {}", old_name))?;
        let new_name = assignment
            .target_name
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                format_event_directory_name_from_categories(
                    day,
                    &assignment.event_type,
                    &assignment.location,
                    &assignment.people_tags,
                    &assignment.group_tags,
                    &assignment.general_tags,
                )
            });

        let parent = old_path
            .parent()
            .ok_or_else(|| format!("Directory has no parent: {}", old_path.display()))?;
        let new_path = parent.join(&new_name);
        let target_key = new_path.to_string_lossy().to_ascii_lowercase();

        if !seen_targets.insert(target_key) {
            return Err(format!("Duplicate target name generated: {}", new_name));
        }

        if new_path != old_path && new_path.exists() {
            return Err(format!("Target directory already exists: {}", new_path.display()));
        }

        plans.push(EventNamingPlan {
            old_path,
            new_path,
            old_name,
            new_name,
            day,
        });
    }

    Ok(plans)
}

pub(crate) fn apply_event_naming_plan(plan: &EventNamingPlan) -> Result<RenamedEventDirectory, String> {
    if plan.old_path != plan.new_path {
        rename_path_with_retry(&plan.old_path, &plan.new_path)?;
    }

    Ok(RenamedEventDirectory {
        old_path: plan.old_path.to_string_lossy().to_string(),
        new_path: plan.new_path.to_string_lossy().to_string(),
        old_name: plan.old_name.clone(),
        new_name: plan.new_name.clone(),
        day: plan.day,
    })
}

pub(crate) fn apply_event_naming_plan_once(plan: &EventNamingPlan) -> io::Result<RenamedEventDirectory> {
    if plan.old_path != plan.new_path {
        fs::rename(&plan.old_path, &plan.new_path)?;
    }

    Ok(RenamedEventDirectory {
        old_path: plan.old_path.to_string_lossy().to_string(),
        new_path: plan.new_path.to_string_lossy().to_string(),
        old_name: plan.old_name.clone(),
        new_name: plan.new_name.clone(),
        day: plan.day,
    })
}

pub(crate) fn merge_event_naming_request_into_catalog(
    app: &AppHandle,
    request: &ApplyEventNamingRequest,
) -> Result<EventNamingCatalog, String> {
    let mut catalog = load_catalog_internal(app).unwrap_or_default();
    if request.assignments.is_empty() {
        catalog = merge_catalog_values(
            catalog,
            &request.event_type,
            &request.location,
            &request.people_tags,
            &request.group_tags,
            &request.general_tags,
        );
    } else {
        for assignment in &request.assignments {
            catalog = merge_catalog_values(
                catalog,
                &assignment.event_type,
                &assignment.location,
                &assignment.people_tags,
                &assignment.group_tags,
                &assignment.general_tags,
            );
        }
    }
    save_catalog_internal(app, &catalog)?;
    Ok(catalog)
}

#[tauri::command]
pub fn load_event_naming_catalog(app: AppHandle) -> Result<EventNamingCatalog, String> {
    load_catalog_internal(&app)
}

#[tauri::command]
pub fn save_event_naming_catalog(app: AppHandle, catalog: EventNamingCatalog) -> Result<EventNamingCatalog, String> {
    let normalized = normalize_catalog(catalog);
    save_catalog_internal(&app, &normalized)?;
    Ok(normalized)
}

#[tauri::command]
pub fn scan_event_naming_library(app: AppHandle, root_dir: String) -> Result<ScanEventNamingLibraryResult, String> {
    let existing = load_catalog_internal(&app).unwrap_or_default();
    let (catalog, discovered_directories, _) = scan_catalog_from_root(existing, Path::new(&root_dir), |_, _, _| Ok(()))?;
    save_catalog_internal(&app, &catalog)?;
    Ok(ScanEventNamingLibraryResult {
        catalog,
        discovered_directories,
    })
}

#[tauri::command]
pub fn list_event_day_directories(staging_dir: String) -> Result<Vec<EventDayDirectory>, String> {
    let root = PathBuf::from(&staging_dir);
    if !root.exists() {
        return Ok(vec![]);
    }

    let mut out = Vec::<EventDayDirectory>::new();
    for entry in WalkDir::new(&root)
        .min_depth(3)
        .max_depth(3)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_dir() {
            continue;
        }

        let path = entry.path().to_path_buf();
        let Some((year, month, day)) = is_candidate_day_directory(&root, &path) else {
            continue;
        };

        let relative = match path.strip_prefix(&root) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        out.push(EventDayDirectory {
            path: path.to_string_lossy().to_string(),
            relative_path: relative,
            name: name.clone(),
            year,
            month,
            day,
            date_key: format!("{:04}-{:02}-{:02}", year, month, day),
            has_custom_name: name != format!("{:02}", day),
        });
    }

    out.sort_by(|a, b| a.date_key.cmp(&b.date_key));
    Ok(out)
}

#[tauri::command]
pub fn apply_event_naming(
    app: AppHandle,
    request: ApplyEventNamingRequest,
) -> Result<ApplyEventNamingResult, String> {
    let plans = build_event_naming_plans(&request)?;
    let mut renamed = Vec::<RenamedEventDirectory>::new();
    for plan in &plans {
        renamed.push(apply_event_naming_plan(plan)?);
    }

    let catalog = merge_event_naming_request_into_catalog(&app, &request)?;

    Ok(ApplyEventNamingResult { renamed, catalog })
}