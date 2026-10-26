//! Shared in-process worker admission and cooperative stop handles.
//! Durable task state stays with its executor; this registry owns no receipts.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    PhotoProcess,
    GooglePhotos,
}
#[derive(Default)]
pub(crate) struct Control {
    pub stop: AtomicBool,
    pub abort: AtomicBool,
}
struct Worker {
    kind: Kind,
    control: Arc<Control>,
}
fn workers() -> &'static Mutex<HashMap<String, Worker>> {
    static WORKERS: OnceLock<Mutex<HashMap<String, Worker>>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) struct Lease {
    id: String,
    pub control: Arc<Control>,
}
pub(crate) fn register(kind: Kind, id: &str) -> Result<Lease, String> {
    let mut workers = workers()
        .lock()
        .map_err(|_| "Core job worker lock failed.")?;
    if workers.contains_key(id) {
        return Err("This job already has an active worker.".into());
    }
    if kind == Kind::GooglePhotos && workers.values().any(|worker| worker.kind == kind) {
        return Err(
            "Another Google Photos job is active. Pause it at a safe checkpoint before continuing."
                .into(),
        );
    }
    let control = Arc::new(Control::default());
    workers.insert(
        id.into(),
        Worker {
            kind,
            control: control.clone(),
        },
    );
    Ok(Lease {
        id: id.into(),
        control,
    })
}
pub(crate) fn active(kind: Kind) -> Result<Vec<String>, String> {
    Ok(workers()
        .lock()
        .map_err(|_| "Core job worker lock failed.")?
        .iter()
        .filter(|(_, worker)| worker.kind == kind)
        .map(|(id, _)| id.clone())
        .collect())
}
pub(crate) fn request_stop(id: &str, abort: bool) -> Result<bool, String> {
    let workers = workers()
        .lock()
        .map_err(|_| "Core job worker lock failed.")?;
    let Some(worker) = workers.get(id) else {
        return Ok(false);
    };
    if abort {
        worker.control.abort.store(true, Ordering::Relaxed);
    }
    worker.control.stop.store(true, Ordering::Relaxed);
    Ok(true)
}
pub(crate) fn stop_state(id: &str) -> (bool, bool) {
    workers()
        .lock()
        .ok()
        .and_then(|workers| {
            workers.get(id).map(|worker| {
                (
                    worker.control.stop.load(Ordering::Relaxed),
                    worker.control.abort.load(Ordering::Relaxed),
                )
            })
        })
        .unwrap_or((false, false))
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut workers) = workers().lock() {
            if workers
                .get(&self.id)
                .is_some_and(|worker| Arc::ptr_eq(&worker.control, &self.control))
            {
                workers.remove(&self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_worker_guard_cannot_remove_a_replacement_registration() {
        let old = register(Kind::GooglePhotos, "runtime-generation").unwrap();
        // Simulate cleanup/replacement before a stale completion is delivered.
        workers().lock().unwrap().remove("runtime-generation");
        let current = register(Kind::GooglePhotos, "runtime-generation").unwrap();
        drop(old);
        assert!(request_stop("runtime-generation", false).unwrap());
        assert!(current.control.stop.load(Ordering::Relaxed));
        assert!(!current.control.abort.load(Ordering::Relaxed));
        drop(current);
        assert!(!request_stop("runtime-generation", true).unwrap());
    }
    #[test]
    fn one_registry_admits_photo_and_google_workers_and_releases_only_its_lease() {
        let local = register(Kind::PhotoProcess, "runtime-local").unwrap();
        let google = register(Kind::GooglePhotos, "runtime-google").unwrap();
        assert!(active(Kind::PhotoProcess)
            .unwrap()
            .contains(&"runtime-local".into()));
        assert!(active(Kind::GooglePhotos)
            .unwrap()
            .contains(&"runtime-google".into()));
        assert!(register(Kind::GooglePhotos, "runtime-google-second").is_err());
        assert!(register(Kind::PhotoProcess, "runtime-local").is_err());
        assert!(request_stop("runtime-google", true).unwrap());
        assert!(google.control.stop.load(Ordering::Relaxed));
        assert!(google.control.abort.load(Ordering::Relaxed));
        assert!(!local.control.stop.load(Ordering::Relaxed));
        drop(google);
        assert!(!request_stop("runtime-google", false).unwrap());
        let replacement = register(Kind::GooglePhotos, "runtime-google-second").unwrap();
        drop(replacement);
        drop(local);
    }
}
