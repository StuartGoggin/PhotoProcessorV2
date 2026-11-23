use super::{blocking, inventory, safety, settings};
use crate::commands::{metadata_tools, raw_development};
use chrono::NaiveDate;
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageReader};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    io::BufReader,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::AppHandle;
use tokio::sync::Semaphore;

const PAGE_SIZE: usize = 48;
const BOOKS_CACHED: usize = 4;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 100_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub(super) books: Vec<Spine>,
    pub(super) skipped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Spine {
    pub(super) name: String,
    card: String,
    date_hint: Option<NaiveDate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPage {
    revision: String,
    card: String,
    archive_date: NaiveDate,
    total: usize,
    offset: usize,
    photos: Vec<PagePhoto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PagePhoto {
    index: usize,
    name: String,
    relative: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRange {
    first: NaiveDate,
    last: NaiveDate,
    estimated: bool,
    undated: usize,
}

struct Book {
    tree: PathBuf,
    revision: String,
    card: String,
    archive_date: NaiveDate,
    photos: Vec<ArchivedPhoto>,
    range: Mutex<Option<Option<PhotoRange>>>,
}

struct ArchivedPhoto {
    relative: String,
    stamp: inventory::Stamp,
    sha256: String,
}

struct CachedBook {
    receipt: PathBuf,
    identity: String,
    book: Arc<Book>,
}

static BOOKS: Mutex<VecDeque<CachedBook>> = Mutex::new(VecDeque::new());
static DATES: Semaphore = Semaphore::const_new(1);
static PREVIEWS: Semaphore = Semaphore::const_new(2);

fn repository(app: &AppHandle) -> Result<PathBuf, String> {
    let configuration = settings::load_settings(app.clone())?;
    inventory::root(Path::new(&configuration.sd_card_repository)).map_err(|_| {
        "The SD Card Repository is unavailable. Check its location in Settings.".into()
    })
}

fn book_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\', ':', '\0'])
}

fn date_hint(name: &str) -> Option<NaiveDate> {
    name.as_bytes().windows(10).find_map(|part| {
        NaiveDate::parse_from_str(std::str::from_utf8(part).ok()?, "%Y-%m-%d").ok()
    })
}

pub(super) fn list_shelf(repository: &Path) -> Result<Shelf, String> {
    let mut books = Vec::new();
    let mut skipped = 0;
    for entry in fs::read_dir(repository).map_err(|e| format!("Cannot list the repository: {e}"))? {
        let Ok(entry) = entry else {
            skipped += 1;
            continue;
        };
        let Some(name) = entry
            .file_name()
            .into_string()
            .ok()
            .filter(|name| book_name(name))
        else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        // Discovery lists names only. Opening each manifest is deferred until
        // a book is opened or its dates are requested in the background.
        let folder = entry.path();
        if crate::commands::google_photos::store::reject_link(&folder).is_err() {
            skipped += 1;
            continue;
        }
        let receipt = folder.join(inventory::manifest_name(&name));
        match fs::symlink_metadata(&receipt) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            _ => {
                skipped += 1;
                continue;
            }
        }
        let card = name
            .strip_prefix("SD-")
            .and_then(|part| part.split_once('_'))
            .map_or_else(|| name.clone(), |(id, _)| format!("SD-{id}"));
        books.push(Spine {
            date_hint: date_hint(&name),
            name,
            card,
        });
    }
    books.sort_by(|a, b| {
        b.date_hint
            .cmp(&a.date_hint)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(Shelf { books, skipped })
}

fn receipt_key(path: &Path) -> Result<String, String> {
    let identity = safety::identity(path)?;
    // This is only a cache invalidation key. The manifest digest identifies a
    // book revision, and preview reads still validate each exact file.
    Ok(format!(
        "{}:{}:{}",
        identity.file_id, identity.bytes, identity.modified
    ))
}

fn open_book(repository: &Path, name: &str) -> Result<Arc<Book>, String> {
    if !book_name(name) {
        return Err("Choose a book from the SD Card Repository shelf.".into());
    }
    let tree = inventory::published_folder(repository, name)?;
    let receipt = inventory::relative_path(&tree, &inventory::manifest_name(name), true)?;
    let identity = receipt_key(&receipt)?;
    if let Ok(mut cache) = BOOKS.lock() {
        if let Some(position) = cache
            .iter()
            .position(|item| item.receipt == receipt && item.identity == identity)
        {
            let item = cache.remove(position).unwrap();
            let book = item.book.clone();
            cache.push_back(item);
            return Ok(book);
        }
    }

    let (manifest, revision) = inventory::load_manifest(&tree, name)?;
    if receipt_key(&receipt)? != identity {
        return Err("The archive changed while it was opening. Refresh the shelf.".into());
    }
    let book = Arc::new(Book {
        tree,
        revision,
        card: manifest.card_reference,
        archive_date: manifest.date.date,
        photos: manifest
            .files
            .into_iter()
            .filter(|(name, _)| inventory::is_photo(name))
            .map(|(relative, file)| ArchivedPhoto {
                relative,
                stamp: file.stamp,
                sha256: file.sha256,
            })
            .collect(),
        range: Mutex::new(None),
    });
    if let Ok(mut cache) = BOOKS.lock() {
        cache.retain(|item| item.receipt != receipt);
        if cache.len() == BOOKS_CACHED {
            cache.pop_front();
        }
        cache.push_back(CachedBook {
            receipt,
            identity,
            book: book.clone(),
        });
    }
    Ok(book)
}

impl Book {
    fn check_revision(&self, expected: &str) -> Result<(), String> {
        if self.revision != expected {
            return Err("This archive changed. Go back to the shelf and open it again.".into());
        }
        Ok(())
    }

    fn page(&self, offset: usize) -> BookPage {
        let photos = self
            .photos
            .iter()
            .enumerate()
            .skip(offset)
            .take(PAGE_SIZE)
            .map(|(index, photo)| PagePhoto {
                index,
                name: photo
                    .relative
                    .rsplit('/')
                    .next()
                    .unwrap_or(&photo.relative)
                    .to_owned(),
                relative: photo.relative.clone(),
            })
            .collect();
        BookPage {
            revision: self.revision.clone(),
            card: self.card.clone(),
            archive_date: self.archive_date,
            total: self.photos.len(),
            offset,
            photos,
        }
    }

    fn dates(&self, tool: &Path) -> Result<Option<PhotoRange>, String> {
        if let Some(cached) = self
            .range
            .lock()
            .map_err(|_| "Date index unavailable.")?
            .clone()
        {
            return Ok(cached);
        }
        let mut first = None;
        let mut last = None;
        let mut dated = 0;
        inventory::visit_dates(
            &self.tree,
            tool,
            self.photos
                .iter()
                .map(|photo| (&photo.relative, &photo.stamp)),
            || false,
            |_, date, estimated| {
                let start = (date, estimated);
                let end = (std::cmp::Reverse(date), estimated);
                first = Some(first.map_or(start, |value| std::cmp::min(value, start)));
                last = Some(last.map_or(end, |value| std::cmp::min(value, end)));
                dated += 1;
            },
        )?;
        let result =
            first.zip(last).map(
                |((first, estimated_start), (last, estimated_end))| PhotoRange {
                    first,
                    last: last.0,
                    estimated: estimated_start || estimated_end,
                    undated: self.photos.len() - dated,
                },
            );
        *self.range.lock().map_err(|_| "Date index unavailable.")? = Some(result.clone());
        Ok(result)
    }

    fn preview(&self, index: usize, large: bool) -> Result<String, String> {
        let photo = self
            .photos
            .get(index)
            .ok_or("Photo is no longer in this archive.")?;
        let path = inventory::relative_path(&self.tree, &photo.relative, true)?;
        let file = inventory::guarded_read(&path)?;
        let observed = inventory::Stamp::read(&file.metadata().map_err(|e| e.to_string())?);
        // Early archives could preserve the bytes while losing precision in a
        // timestamp. Recheck the content only when the ordinary stamp differs.
        if photo.stamp.bytes != observed.bytes
            || (!photo.stamp.same_file(&observed)
                && inventory::hash_file(&path, || false)? != photo.sha256)
        {
            return Err("This photo differs from the saved archive. Verify the archive before relying on it.".into());
        }
        if !raw_development::is_raw(&path) && photo.stamp.bytes > MAX_IMAGE_BYTES {
            return Err("This file exceeds the preview size limit.".into());
        }
        let image = if raw_development::is_raw(&path) {
            raw_development::worker::camera_preview(&path)?.0
        } else {
            let mut decoder = ImageReader::new(BufReader::new(&file))
                .with_guessed_format()
                .map_err(|e| e.to_string())?
                .into_decoder()
                .map_err(|e| e.to_string())?;
            let (width, height) = decoder.dimensions();
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
                return Err("This photo exceeds the preview dimension limit.".into());
            }
            let orientation = decoder.orientation().map_err(|e| e.to_string())?;
            let mut image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
            image.apply_orientation(orientation);
            image
        };
        let edge = if large { 1800 } else { 250 };
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, if large { 85 } else { 72 })
            .encode_image(&image.thumbnail(edge, edge))
            .map_err(|e| e.to_string())?;
        Ok(crate::utils::base64_encode(&bytes))
    }
}

#[tauri::command]
pub async fn list_sd_archive_library(app: AppHandle) -> Result<Shelf, String> {
    blocking(move || list_shelf(&repository(&app)?)).await
}

#[tauri::command]
pub async fn sd_archive_library_page(
    app: AppHandle,
    name: String,
    offset: usize,
    revision: Option<String>,
) -> Result<BookPage, String> {
    blocking(move || {
        let book = open_book(&repository(&app)?, &name)?;
        if let Some(revision) = revision {
            book.check_revision(&revision)?;
        }
        Ok(book.page(offset))
    })
    .await
}

#[tauri::command]
pub async fn sd_archive_library_date_range(
    app: AppHandle,
    name: String,
) -> Result<Option<PhotoRange>, String> {
    let _permit = DATES
        .acquire()
        .await
        .map_err(|_| "Date index unavailable.")?;
    blocking(move || {
        let book = open_book(&repository(&app)?, &name)?;
        let configuration = settings::load_settings(app)?;
        let (tool, _) = metadata_tools::resolve(&configuration.exiftool_dir);
        book.dates(&tool)
    })
    .await
}

#[tauri::command]
pub async fn sd_archive_library_preview(
    app: AppHandle,
    name: String,
    revision: String,
    index: usize,
    large: bool,
) -> Result<String, String> {
    let _permit = PREVIEWS
        .acquire()
        .await
        .map_err(|_| "Photo preview unavailable.")?;
    blocking(move || {
        let book = open_book(&repository(&app)?, &name)?;
        book.check_revision(&revision)?;
        book.preview(index, large)
    })
    .await
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::commands::sd_archive::{copy, tests::Fixture, Progress};
    use chrono::{Local, TimeZone};
    use std::time::SystemTime;

    fn photo(path: &Path, date: (i32, u32, u32), colour: [u8; 3]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbImage::from_pixel(42, 63, image::Rgb(colour))
            .save(path)
            .unwrap();
        let time = Local
            .with_ymd_and_hms(date.0, date.1, date.2, 12, 0, 0)
            .single()
            .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(SystemTime::from(time)))
            .unwrap();
    }

    #[test]
    fn opens_saved_strict_and_legacy_archives_with_no_card_and_uses_scoped_previews() {
        let fixture = Fixture::new();
        photo(
            &fixture.source().join("DCIM/IMG_1001.JPG"),
            (2025, 10, 6),
            [30, 90, 150],
        );
        photo(
            &fixture.source().join("DCIM/IMG_1002.JPG"),
            (2025, 10, 8),
            [50, 60, 10],
        );
        fixture.put("DCIM/MVI_1001.MP4", b"not a photo");

        let mut first = fixture.job();
        let progress = Progress::new(&first);
        fixture.run(&mut first, || false, &progress).unwrap();
        let mut second = fixture.job();
        let progress = Progress::new(&second);
        fixture.run(&mut second, || false, &progress).unwrap();
        // Use the same legacy version and fields accepted by existing archive maintenance.
        let legacy = PathBuf::from(second.completed_folder.unwrap());
        let legacy_name = legacy.file_name().unwrap().to_str().unwrap();
        let (mut manifest, _) = inventory::load_manifest(&legacy, legacy_name).unwrap();
        manifest.version = 1;
        manifest.directory_stamps.clear();
        manifest.root_stamp = None;
        fs::write(
            legacy.join(inventory::manifest_name(legacy_name)),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let legacy_file = legacy.join("DCIM/IMG_1001.JPG");
        fs::OpenOptions::new()
            .write(true)
            .open(legacy_file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(SystemTime::now()))
            .unwrap();

        let draft = copy::work_dir(&fixture.repository(), &first.id);
        fs::create_dir_all(&draft).unwrap();
        let draft_name = draft.file_name().unwrap().to_str().unwrap();
        fs::write(
            draft.join(inventory::manifest_name(draft_name)),
            b"not a published manifest",
        )
        .unwrap();
        fs::rename(fixture.source(), fixture.0.join("unplugged")).unwrap();

        let shelf = list_shelf(&fixture.repository()).unwrap();
        assert_eq!(shelf.books.len(), 2);
        assert!(shelf.books.iter().all(|entry| entry.name != draft_name));
        for entry in shelf.books {
            let book = open_book(&fixture.repository(), &entry.name).unwrap();
            let page = book.page(0);
            assert_eq!(page.total, 2);
            assert_eq!(page.photos[0].name, "IMG_1001.JPG");
            let range = book.dates(&fixture.0.join("no-exiftool")).unwrap().unwrap();
            assert_eq!(
                (range.first.to_string(), range.last.to_string()),
                ("2025-10-06".into(), "2025-10-08".into())
            );
            assert!(range.estimated);
            assert_eq!(range.undated, 0);
            assert!(book.preview(0, true).unwrap().starts_with("/9j/"));
            assert!(book.preview(2, false).is_err());
            assert!(book.check_revision("different manifest").is_err());
            assert_eq!(book.page(48).photos.len(), 0);
        }
        assert!(open_book(&fixture.repository(), "../unplugged").is_err());
        assert!(open_book(&fixture.repository(), r"C:\Windows").is_err());
    }
}
