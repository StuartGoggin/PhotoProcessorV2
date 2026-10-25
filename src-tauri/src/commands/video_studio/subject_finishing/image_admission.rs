//! One bounded finishing image pipeline at a time. This is admission only;
//! it does not choose or invoke a camera-motion algorithm or hardware backend.
use std::sync::{Mutex, OnceLock};

pub(super) struct ImageSlot;
fn slot() -> &'static Mutex<bool> {
    static SLOT: OnceLock<Mutex<bool>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(false))
}
impl ImageSlot {
    pub(super) fn try_acquire() -> Result<Option<Self>, String> {
        let mut held = slot().lock().map_err(|_| "Finishing image queue lock failed")?;
        if *held { return Ok(None); }
        *held = true;
        Ok(Some(Self))
    }
}
impl Drop for ImageSlot {
    fn drop(&mut self) { if let Ok(mut held) = slot().lock() { *held = false; } }
}
