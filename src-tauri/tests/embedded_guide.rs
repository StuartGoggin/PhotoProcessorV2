#[test]
fn bundled_guide_matches_generated_manual() {
    use sha2::{Digest, Sha256};
    assert!(!tauri::is_dev(), "Run with --features custom-protocol");
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let key = tauri::utils::assets::AssetKey::from("help/user-guide.html");
    let bundled = context.assets().get(&key).expect("guide is embedded");
    let generated = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../public/help/user-guide.html"
    ))
    .unwrap();
    assert_eq!(bundled.as_ref(), generated.as_slice());
    let key = tauri::utils::assets::AssetKey::from("help/manifest.json");
    let manifest = context
        .assets()
        .get(&key)
        .expect("guide manifest is embedded");
    let value: serde_json::Value = serde_json::from_slice(manifest.as_ref()).unwrap();
    assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["chapters"], 18);
    assert_eq!(
        value["sha256"],
        hex::encode(Sha256::digest(bundled.as_ref()))
    );
}
