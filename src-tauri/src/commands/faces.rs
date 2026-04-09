use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Face embedding vector and metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct FaceEmbedding {
    pub person_id: String,
    pub person_name: String,
    #[serde(skip)]
    pub embedding: Vec<f32>,
    pub source_video: String,
    pub timestamp_ms: u64,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceDatabase {
    pub version: u32,
    pub faces: Vec<FaceEmbedding>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonIdentity {
    pub person_id: String,
    pub person_name: String,
    pub distinct_embeddings: usize,
    pub video_count: usize,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMatch {
    pub video_path: String,
    pub relative_path: String,
    pub match_count: usize,
    pub timestamps: Vec<u64>,
    pub first_match: u64,
    pub last_match: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPersonResult {
    pub person_identity: PersonIdentity,
    pub matches: Vec<VideoMatch>,
}

/// Configuration for face scanning
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ScanFacesConfig {
    pub archive_dir: String,
    pub frames_per_second: usize,
    pub similarity_threshold: f32,
}

/// Result from face scanning operation
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFacesResult {
    pub videos_scanned: usize,
    pub faces_detected: usize,
    pub unique_people: usize,
    pub db_path: String,
}

impl FaceDatabase {
    pub fn new() -> Self {
        Self {
            version: 1,
            faces: Vec::new(),
            updated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }

    pub fn load(db_path: &Path) -> Result<Self, String> {
        if !db_path.exists() {
            return Ok(Self::new());
        }

        let contents = fs::read_to_string(db_path)
            .map_err(|e| format!("Failed to read face database: {}", e))?;
        
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse face database: {}", e))
    }

    pub fn save(&self, db_path: &Path) -> Result<(), String> {
        fs::create_dir_all(db_path.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(|e| format!("Failed to create database directory: {}", e))?;

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize face database: {}", e))?;

        fs::write(db_path, contents)
            .map_err(|e| format!("Failed to write face database: {}", e))
    }

    pub fn get_people(&self) -> Vec<PersonIdentity> {
        let mut people_map: HashMap<String, (String, HashSet<String>, u64)> = HashMap::new();

        for face in &self.faces {
            let entry = people_map
                .entry(face.person_id.clone())
                .or_insert_with(|| (face.person_name.clone(), HashSet::new(), 0));
            
            entry.1.insert(face.source_video.clone());
            entry.2 = entry.2.max(face.timestamp_ms);
        }

        people_map
            .into_iter()
            .map(|(person_id, (person_name, videos, last_seen_ms))| {
                let pid_copy = person_id.clone();
                PersonIdentity {
                    person_id,
                    person_name,
                    distinct_embeddings: self.faces.iter()
                        .filter(|f| f.person_id == pid_copy)
                        .count(),
                    video_count: videos.len(),
                    last_seen: format_timestamp(last_seen_ms),
                }
            })
            .collect()
    }

    pub fn search_person(&self, person_id: &str, archive_dir: &Path) -> SearchPersonResult {
        let mut video_matches: HashMap<String, Vec<u64>> = HashMap::new();
        let mut person_name = person_id.to_string();

        for face in &self.faces {
            if face.person_id == person_id {
                person_name = face.person_name.clone();
                video_matches
                    .entry(face.source_video.clone())
                    .or_insert_with(Vec::new)
                    .push(face.timestamp_ms);
            }
        }

        let video_count = video_matches.len();
        
        let matches = video_matches
            .into_iter()
            .map(|(video_path, mut timestamps)| {
                timestamps.sort_unstable();
                let first_match = timestamps.first().copied().unwrap_or(0);
                let last_match = timestamps.last().copied().unwrap_or(0);

                let relative_path = PathBuf::from(&video_path)
                    .strip_prefix(archive_dir)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| video_path.clone());

                VideoMatch {
                    video_path,
                    relative_path,
                    match_count: timestamps.len(),
                    timestamps,
                    first_match,
                    last_match,
                }
            })
            .collect();

        SearchPersonResult {
            person_identity: PersonIdentity {
                person_id: person_id.to_string(),
                person_name,
                distinct_embeddings: self.faces.iter()
                    .filter(|f| f.person_id == person_id)
                    .count(),
                video_count,
                last_seen: self.faces.iter()
                    .filter(|f| f.person_id == person_id)
                    .map(|f| f.timestamp_ms)
                    .max()
                    .map(format_timestamp)
                    .unwrap_or_default(),
            },
            matches,
        }
    }
}

fn format_timestamp(ms: u64) -> String {
    let secs = ms / 1000;
    let mins = secs / 60;
    let hours = mins / 60;
    let days = hours / 24;

    if days > 0 {
        format!("{}d ago", days)
    } else if hours > 0 {
        format!("{}h ago", hours)
    } else if mins > 0 {
        format!("{}m ago", mins)
    } else {
        format!("{}s ago", secs)
    }
}

/// Collect all video files from archive directory
pub fn collect_video_files(archive_dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut videos = Vec::new();
    let video_extensions = ["mp4", "mkv", "avi", "mov", "flv", "wmv", "webm"];

    if recursive {
        for entry in WalkDir::new(archive_dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_lc = ext.to_string_lossy().to_ascii_lowercase();
                if video_extensions.contains(&ext_lc.as_str()) {
                    videos.push(path.to_path_buf());
                }
            }
        }
    } else {
        if let Ok(dir) = fs::read_dir(archive_dir) {
            for entry in dir.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        let ext_lc = ext.to_string_lossy().to_ascii_lowercase();
                        if video_extensions.contains(&ext_lc.as_str()) {
                            videos.push(path);
                        }
                    }
                }
            }
        }
    }

    videos
}

/// Call Python script to detect faces in videos using deepface
pub fn detect_faces_in_video(
    _video_path: &Path,
    _frames_per_second: usize,
    _similarity_threshold: f32,
) -> Result<Vec<(String, Vec<f32>, u64, f32)>, String> {
    // This is a placeholder - in production, you'd call Python with deepface
    // Format: (person_id, embedding_vector, timestamp_ms, confidence)
    
    // For now, return empty result - Python script would be called here
    // Example command:
    // python -c "
    // import sys
    // import json
    // from deepface import DeepFace
    // # Video processing logic here
    // "
    
    Ok(Vec::new())
}

/// Generate a unique person ID from face embeddings
#[allow(dead_code)]
pub fn generate_person_id(embedding: &[f32]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    for val in embedding {
        val.to_bits().hash(&mut hasher);
    }
    format!("person_{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_face_database_new() {
        let db = FaceDatabase::new();
        assert_eq!(db.version, 1);
        assert!(db.faces.is_empty());
    }
}
