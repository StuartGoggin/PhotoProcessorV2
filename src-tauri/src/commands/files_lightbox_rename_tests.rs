use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12]; getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("photogogo-review-rename-{}", hex::encode(random)));
        fs::create_dir(&root).unwrap(); Self(root)
    }
    fn source(&self) -> PathBuf { let p = self.0.join("horse.jpg"); fs::write(&p, b"original photo bytes").unwrap(); p }
}
impl Drop for Fixture { fn drop(&mut self) {let _ = fs::remove_dir_all(&self.0);} }

#[test]
fn rating_collision_preserves_both_photographs() {
    let f = Fixture::new(); let source = f.source(); let target = f.0.join("horse{Like oo}.jpg");
    fs::write(&target, b"another photograph").unwrap();
    assert!(rename_review_file(&source, "horse{Like oo}.jpg").unwrap_err().contains("Both files were preserved"));
    assert_eq!(fs::read(source).unwrap(), b"original photo bytes");
    assert_eq!(fs::read(target).unwrap(), b"another photograph");
}
#[test]
fn valid_tag_rename_retains_photo_bytes_and_changes_only_the_name() {
    let f = Fixture::new(); let source = f.source();
    let destination = PathBuf::from(rename_review_file(&source, "horse{Like ooo}{trash}.jpg").unwrap());
    assert!(!source.exists()); assert_eq!(fs::read(destination).unwrap(), b"original photo bytes");
}
#[test]
fn path_injection_and_directory_rename_are_refused() {
    let f = Fixture::new(); let source = f.source();
    for name in ["", "..", "../outside.jpg", "folder/photo.jpg", "folder\\photo.jpg", "C:other.jpg"] {
        assert!(rename_review_file(&source, name).is_err(), "{name}");
    }
    assert!(rename_review_file(&f.0, "renamed").is_err());
    assert_eq!(fs::read(source).unwrap(), b"original photo bytes");
}
#[test]
fn unchanged_name_is_an_idempotent_success() {
    let f = Fixture::new(); let source = f.source();
    rename_review_file(&source, "horse.jpg").unwrap();
    assert_eq!(fs::read(source).unwrap(), b"original photo bytes");
}
#[test]
fn missing_source_does_not_create_any_target() {
    let f = Fixture::new(); assert!(rename_review_file(&f.0.join("missing.jpg"), "rated.jpg").is_err());
    assert!(!f.0.join("rated.jpg").exists());
}
