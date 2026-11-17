//! "Tony-First" GPU slot scheduler ("baton pass").
//!
//! A 12 GB card can run one generation well; two at once both crawl (and
//! AnythingLLM + LM Studio + verifier calls used to collide). Every call that
//! runs on the local GPU takes a slot here:
//!
//!   foreground (Tony's turn, a sub-agent you're waiting on) → front of the line
//!   background (pipeline stages, verifier, memory condense)  → waits while any
//!       foreground request is queued; after `bg_max_wait` it runs anyway, so a
//!       90 % Tony-priority split still lets 10 % of the time go to the queue.
//!
//! `max_concurrency` = slots (1 on the 3060; raise it on a bigger server).
//! The live state is emitted as `gpu-slot` for the top-bar pill.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SchedulerConfig {
    /// "sequential" (12 GB, Tony priority) | "hybrid" (local + cloud/CLI) | "parallel" (big GPU / server).
    pub profile: String,
    /// Slider 1: share of GPU time reserved for Tony's fast path (50–100).
    pub tony_priority_pct: u8,
    /// Simultaneous local generations.
    pub max_concurrency: u8,
    /// Slider 2: how aggressively heavy steps (coding, design) go to cloud/CLI (0 = never, 100 = always).
    pub offload_pct: u8,
    /// Engine for offloaded steps: "claude-cli" | "gemini-cli" | "llm-cli" | "claude-api" | "gemini-api" | "droplet".
    pub offload_engine: String,
    /// Rolling chat history sent with each Tony turn.
    pub history_turns: u8,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self { profile: "sequential".into(), tony_priority_pct: 90, max_concurrency: 1, offload_pct: 0, offload_engine: "claude-cli".into(), history_turns: 6 }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub active: Vec<String>,
    pub queued_foreground: usize,
    pub queued_background: usize,
    pub capacity: usize,
}

type Notify = Box<dyn Fn(SlotView) + Send + Sync>;

pub struct GpuSlot {
    sem: Arc<Semaphore>,
    capacity: AtomicUsize,
    fg_waiting: AtomicUsize,
    bg_waiting: AtomicUsize,
    active: Mutex<Vec<(u64, String)>>,
    next_id: AtomicUsize,
    /// Publishes slot changes (wired to the `gpu-slot` event in lib.rs). A plain callback
    /// keeps the window runtime out of this module (and its unit tests).
    notify: Mutex<Option<Notify>>,
}

impl Default for GpuSlot {
    fn default() -> Self {
        Self {
            sem: Arc::new(Semaphore::new(1)),
            capacity: AtomicUsize::new(1),
            fg_waiting: AtomicUsize::new(0),
            bg_waiting: AtomicUsize::new(0),
            active: Mutex::new(vec![]),
            next_id: AtomicUsize::new(1),
            notify: Mutex::new(None),
        }
    }
}

pub struct SlotGuard<'a> {
    slot: &'a GpuSlot,
    id: u64,
    _permit: OwnedSemaphorePermit,
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        self.slot.active.lock().unwrap().retain(|(i, _)| *i != self.id);
        self.slot.emit();
    }
}

impl GpuSlot {
    pub fn set_notify(&self, f: impl Fn(SlotView) + Send + Sync + 'static) {
        *self.notify.lock().unwrap() = Some(Box::new(f));
    }

    /// Resize to `n` slots (profile / server upgrade).
    pub fn set_capacity(&self, n: usize) {
        let n = n.clamp(1, 8);
        let cur = self.capacity.swap(n, Ordering::SeqCst);
        if n > cur {
            self.sem.add_permits(n - cur);
        } else if n < cur {
            self.sem.forget_permits(cur - n);
        }
        self.emit();
    }

    pub fn view(&self) -> SlotView {
        SlotView {
            active: self.active.lock().unwrap().iter().map(|(_, l)| l.clone()).collect(),
            queued_foreground: self.fg_waiting.load(Ordering::SeqCst),
            queued_background: self.bg_waiting.load(Ordering::SeqCst),
            capacity: self.capacity.load(Ordering::SeqCst),
        }
    }

    fn emit(&self) {
        let view = self.view();
        if let Some(f) = self.notify.lock().unwrap().as_ref() {
            f(view);
        }
    }

    /// Take a GPU slot. Foreground jumps the queue; background yields to it
    /// (up to `bg_max_wait`, derived from the Tony-priority slider).
    pub async fn acquire(&self, label: &str, foreground: bool, tony_priority_pct: u8) -> SlotGuard<'_> {
        let counter = if foreground { &self.fg_waiting } else { &self.bg_waiting };
        counter.fetch_add(1, Ordering::SeqCst);
        self.emit();
        if !foreground {
            // 90 % → wait up to 45 s for Tony's queue to clear; 50 % → 0 s.
            let max_wait = Duration::from_millis(((tony_priority_pct.clamp(50, 100) as u64 - 50) * 1125).min(60_000));
            let t0 = Instant::now();
            while self.fg_waiting.load(Ordering::SeqCst) > 0 && t0.elapsed() < max_wait {
                tokio::time::sleep(Duration::from_millis(60)).await;
            }
        }
        let permit = loop {
            let p = self.sem.clone().acquire_owned().await.expect("gpu slot semaphore");
            // A background step that won the race while Tony is now waiting hands the baton back.
            if !foreground && self.fg_waiting.load(Ordering::SeqCst) > 0 && tony_priority_pct >= 90 {
                drop(p);
                tokio::time::sleep(Duration::from_millis(80)).await;
                continue;
            }
            break p;
        };
        counter.fetch_sub(1, Ordering::SeqCst);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) as u64;
        self.active.lock().unwrap().push((id, label.to_string()));
        self.emit();
        SlotGuard { slot: self, id, _permit: permit }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_jumps_background() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(GpuSlot::default());
            let order = Arc::new(Mutex::new(Vec::<&str>::new()));
            let g = slot.acquire("holder", true, 90).await;
            let (s1, o1) = (slot.clone(), order.clone());
            let bg = tauri::async_runtime::spawn(async move {
                let _g = s1.acquire("bg", false, 90).await;
                o1.lock().unwrap().push("bg");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            let (s2, o2) = (slot.clone(), order.clone());
            let fg = tauri::async_runtime::spawn(async move {
                let _g = s2.acquire("tony", true, 90).await;
                o2.lock().unwrap().push("tony");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(g);
            let _ = fg.await;
            let _ = bg.await;
            assert_eq!(*order.lock().unwrap(), vec!["tony", "bg"]);
        });
    }

    #[test]
    fn capacity_scales() {
        let slot = GpuSlot::default();
        slot.set_capacity(3);
        assert_eq!(slot.view().capacity, 3);
        slot.set_capacity(1);
        assert_eq!(slot.view().capacity, 1);
    }
}
