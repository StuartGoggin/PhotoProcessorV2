//! Import-only admission. This deliberately has no CPU/video scheduler dependency.
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub const MAX_SOURCES: usize = 4;

#[derive(Clone, Debug)]
pub struct Request {
    pub devices: Vec<String>,
    pub known: bool,
    pub staging: PathBuf,
    pub source: PathBuf,
    pub exclusive: bool,
}

fn overlaps(a: &std::path::Path, b: &std::path::Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

fn conflict(a: &Request, b: &Request) -> Option<&'static str> {
    if a.exclusive || b.exclusive {
        return Some("Waiting for exclusive staging reprocessing");
    }
    if !a.known || !b.known || a.devices.is_empty() || b.devices.is_empty() {
        return Some("Waiting: source device identity is uncertain; using safe serial imports");
    }
    if a.devices.iter().any(|key| b.devices.contains(key)) {
        return Some("Waiting for this source device");
    }
    if (a.staging != b.staging && overlaps(&a.staging, &b.staging))
        || overlaps(&a.source, &b.staging)
        || overlaps(&b.source, &a.staging)
    {
        return Some("Waiting for an overlapping source or staging folder");
    }
    None
}

#[derive(Default)]
struct State {
    next: u64,
    waiting: VecDeque<(u64, Request)>,
    active: HashMap<u64, Request>,
}

#[derive(Clone, Default)]
pub struct Scheduler(Arc<Mutex<State>>);

pub struct Ticket {
    scheduler: Scheduler,
    id: u64,
}
pub struct Permit {
    scheduler: Scheduler,
    id: u64,
}

impl Scheduler {
    pub fn queue(&self, request: Request) -> Result<Ticket, String> {
        let mut state = self.0.lock().map_err(|_| "Import scheduler lock failed")?;
        state.next += 1;
        let id = state.next;
        state.waiting.push_back((id, request));
        Ok(Ticket {
            scheduler: self.clone(),
            id,
        })
    }
    pub fn active_sources(&self) -> usize {
        self.0.lock().map(|s| s.active.len()).unwrap_or(0)
    }
}

impl Ticket {
    pub fn try_acquire(&mut self) -> Result<Result<Permit, &'static str>, String> {
        let mut state = self
            .scheduler
            .0
            .lock()
            .map_err(|_| "Import scheduler lock failed")?;
        let index = state
            .waiting
            .iter()
            .position(|(id, _)| *id == self.id)
            .ok_or("Import admission ticket already consumed")?;
        let request = &state.waiting[index].1;
        if let Some(reason) = state
            .active
            .values()
            .find_map(|active| conflict(request, active))
        {
            return Ok(Err(reason));
        }
        // FIFO only among conflicting requests. A2 never blocks an independent B1.
        if let Some(reason) = state
            .waiting
            .iter()
            .take(index)
            .find_map(|(_, earlier)| conflict(request, earlier))
        {
            return Ok(Err(reason));
        }
        if state.active.len() >= MAX_SOURCES {
            return Ok(Err("Waiting for a free import lane (maximum four sources)"));
        }
        let (_, request) = state.waiting.remove(index).unwrap();
        state.active.insert(self.id, request);
        Ok(Ok(Permit {
            scheduler: self.scheduler.clone(),
            id: self.id,
        }))
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut state) = self.scheduler.0.lock() {
            state.waiting.retain(|(id, _)| *id != self.id);
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.scheduler.0.lock() {
            state.active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(device: &str) -> Request {
        Request {
            devices: vec![device.into()],
            known: true,
            staging: PathBuf::from("staging"),
            source: PathBuf::from(device),
            exclusive: false,
        }
    }
    #[test]
    fn separate_card_starts_while_same_card_waits() {
        let scheduler = Scheduler::default();
        let mut a1 = scheduler.queue(request("card-a")).unwrap();
        let active_a = a1.try_acquire().unwrap().unwrap();
        let mut a2 = scheduler.queue(request("card-a")).unwrap();
        assert!(a2.try_acquire().unwrap().is_err());
        let mut b1 = scheduler.queue(request("card-b")).unwrap();
        let active_b = b1
            .try_acquire()
            .unwrap()
            .expect("card B must start while A1 runs and A2 waits");
        assert_eq!(scheduler.active_sources(), 2);
        assert!(a2.try_acquire().unwrap().is_err());
        drop(active_a);
        let _a2 = a2.try_acquire().unwrap().unwrap();
        drop(active_b);
    }
    #[test]
    fn independent_devices_are_bounded_and_permits_release() {
        let scheduler = Scheduler::default();
        let mut permits = Vec::new();
        for i in 0..MAX_SOURCES {
            permits.push(
                scheduler
                    .queue(request(&format!("card-{i}")))
                    .unwrap()
                    .try_acquire()
                    .unwrap()
                    .unwrap(),
            );
        }
        let mut fifth = scheduler.queue(request("fifth")).unwrap();
        assert!(fifth.try_acquire().unwrap().is_err());
        permits.pop();
        let _fifth = fifth.try_acquire().unwrap().unwrap();
        assert_eq!(scheduler.active_sources(), MAX_SOURCES);
    }
    #[test]
    fn cancellation_removes_waiter_and_does_not_release_another_permit() {
        let scheduler = Scheduler::default();
        let active = scheduler
            .queue(request("a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let waiting = scheduler.queue(request("a")).unwrap();
        drop(waiting);
        assert_eq!(scheduler.active_sources(), 1);
        drop(active);
        assert!(scheduler
            .queue(request("a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .is_ok());
    }
    #[test]
    fn unknown_and_shared_disk_keys_never_claim_independence() {
        let scheduler = Scheduler::default();
        let _active = scheduler
            .queue(request("disk-a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let mut unknown = request("unknown");
        unknown.known = false;
        assert!(scheduler
            .queue(unknown)
            .unwrap()
            .try_acquire()
            .unwrap()
            .is_err());
        let mut multi = request("disk-b");
        multi.devices.push("disk-a".into());
        assert!(scheduler
            .queue(multi)
            .unwrap()
            .try_acquire()
            .unwrap()
            .is_err());
    }
    #[test]
    fn reprocess_and_nested_staging_remain_exclusive() {
        let scheduler = Scheduler::default();
        let active = scheduler
            .queue(request("a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let mut nested = request("b");
        nested.staging.push("nested");
        assert!(scheduler
            .queue(nested)
            .unwrap()
            .try_acquire()
            .unwrap()
            .is_err());
        let mut reprocess = request("nvme");
        reprocess.exclusive = true;
        let mut ticket = scheduler.queue(reprocess).unwrap();
        assert!(ticket.try_acquire().unwrap().is_err());
        let mut later = scheduler.queue(request("c")).unwrap();
        assert!(later.try_acquire().unwrap().is_err());
        drop(active);
        let exclusive = ticket.try_acquire().unwrap().unwrap();
        assert!(later.try_acquire().unwrap().is_err());
        drop(exclusive);
        assert!(later.try_acquire().unwrap().is_ok());
    }
    #[test]
    fn source_inside_another_jobs_destination_waits() {
        let scheduler = Scheduler::default();
        let _active = scheduler
            .queue(request("a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let mut other = request("nvme");
        other.source = PathBuf::from("staging/photos");
        other.staging = PathBuf::from("archive");
        assert!(scheduler
            .queue(other)
            .unwrap()
            .try_acquire()
            .unwrap()
            .is_err());
    }
    #[test]
    fn withdrawing_a_paused_exclusive_waiter_unblocks_other_cards() {
        let scheduler = Scheduler::default();
        let _a = scheduler
            .queue(request("a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let mut exclusive = request("nvme");
        exclusive.exclusive = true;
        let paused = scheduler.queue(exclusive).unwrap();
        let mut b = scheduler.queue(request("b")).unwrap();
        assert!(b.try_acquire().unwrap().is_err());
        drop(paused);
        assert!(b.try_acquire().unwrap().is_ok());
    }
}
