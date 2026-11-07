//! Small, typed controller preferences; never persisted beside user media.
use super::{persist, ControllerManager};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::Path};
use tauri::State;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Turn {
    Browse,
    Zoom,
    Versions,
    Off,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Press {
    Fit,
    SelectActive,
    CropVersion,
    Previous,
    Next,
    Trash,
    Off,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dial {
    turn: Turn,
    press: Press,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LightboxBindings {
    version: u8,
    dials: [Dial; 3],
}

impl Default for LightboxBindings {
    fn default() -> Self {
        Self {
            version: 1,
            dials: [
                Dial {
                    turn: Turn::Browse,
                    press: Press::Fit,
                },
                Dial {
                    turn: Turn::Zoom,
                    press: Press::Fit,
                },
                Dial {
                    turn: Turn::Versions,
                    press: Press::SelectActive,
                },
            ],
        }
    }
}

fn read(path: &Path) -> Result<LightboxBindings, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LightboxBindings::default())
        }
        Err(_) => return Err("Cannot read the saved Lightbox dial assignments.".into()),
    };
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the saved Lightbox dial assignments.")?;
    if bytes.len() > 4096 {
        return Err("Saved Lightbox dial assignments exceed the size limit.".into());
    }
    let bindings: LightboxBindings = serde_json::from_slice(&bytes).map_err(|_| "Saved Lightbox dial assignments are invalid. Use Reset defaults and Apply to replace them deliberately.")?;
    validate(&bindings)?;
    Ok(bindings)
}

fn validate(bindings: &LightboxBindings) -> Result<(), String> {
    if bindings.version != 1 {
        return Err("Unsupported Lightbox dial assignment version.".into());
    }
    Ok(())
}

fn save(path: &Path, bindings: LightboxBindings) -> Result<LightboxBindings, String> {
    validate(&bindings)?;
    let bytes =
        serde_json::to_vec(&bindings).map_err(|_| "Could not encode Lightbox dial assignments.")?;
    persist(path, &bytes)?;
    Ok(bindings)
}

#[tauri::command]
pub fn controller_lightbox_bindings(
    manager: State<'_, ControllerManager>,
    bindings: Option<LightboxBindings>,
) -> Result<LightboxBindings, String> {
    let path = manager.0.directory.join("bindings.json");
    match bindings {
        Some(bindings) => save(&path, bindings),
        None => read(&path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assignments_roundtrip_without_changing_automatic_mode_or_stage_files() {
        let temp = std::env::temp_dir().join(format!(
            "photogogo-dial-bindings-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir(&temp).unwrap();
        let path = temp.join("bindings.json");
        let preferences = temp.join("preferences.json");
        std::fs::write(&preferences, br#"{"enabled":false,"brightness":35}"#).unwrap();
        assert_eq!(read(&path).unwrap(), LightboxBindings::default());
        assert!(!path.exists());
        let mut changed = LightboxBindings::default();
        changed.dials[2] = Dial {
            turn: Turn::Browse,
            press: Press::Trash,
        };
        save(&path, changed.clone()).unwrap();
        assert_eq!(read(&path).unwrap(), changed);
        let accepted = std::fs::read(&path).unwrap();
        let mut invalid = changed;
        invalid.version = 2;
        assert!(save(&path, invalid).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), accepted);
        assert_eq!(
            std::fs::read(&preferences).unwrap(),
            br#"{"enabled":false,"brightness":35}"#
        );
        std::fs::write(&path, vec![b' '; 8192]).unwrap();
        assert!(read(&path).is_err());
        assert_eq!(path.parent(), Some(temp.as_path()));
        for file in ["bindings.json", "bindings.lock", "preferences.json"] {
            std::fs::remove_file(temp.join(file)).unwrap();
        }
        std::fs::remove_dir(temp).unwrap();
    }
    #[test]
    fn unsupported_actions_fields_counts_and_versions_are_rejected() {
        let valid = serde_json::to_value(LightboxBindings::default()).unwrap();
        for field in ["turn", "press"] {
            let mut edited = valid.clone();
            edited["dials"][0][field] = "execute-shell".into();
            assert!(serde_json::from_value::<LightboxBindings>(edited).is_err());
        }
        let mut edited = valid.clone();
        edited["path"] = "somewhere-else".into();
        assert!(serde_json::from_value::<LightboxBindings>(edited).is_err());
        let mut edited = valid.clone();
        edited["dials"].as_array_mut().unwrap().pop();
        assert!(serde_json::from_value::<LightboxBindings>(edited).is_err());
        let mut edited = valid.clone();
        edited["dials"]
            .as_array_mut()
            .unwrap()
            .push(valid["dials"][0].clone());
        assert!(serde_json::from_value::<LightboxBindings>(edited).is_err());
        let mut edited = valid;
        edited["version"] = 2.into();
        assert!(validate(&serde_json::from_value(edited).unwrap()).is_err());
    }
}
