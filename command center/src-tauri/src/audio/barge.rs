//! Barge-in: one `Arc<AtomicBool>` the whole voice turn hangs off.
//!
//! `trigger()` (called from the VAD worker on speech onset) does, in this order:
//!   1. sets the flag: the output callback reads it on its next invocation and writes silence,
//!      so the audible cut-off is one device period (~10 ms), not a queue drain;
//!   2. flushes the playback ring in O(1) (epoch bump; see `ring.rs`), which also turns every
//!      TTS producer's [`Ticket`] stale so it stops pushing;
//!   3. wakes every task awaiting [`BargeIn::cancelled`], so an in-flight LM Studio SSE stream or
//!      Kokoro request wrapped in [`BargeIn::until_cancelled`] is dropped at once (dropping the
//!      reqwest stream closes the connection, which stops generation server-side).
//!
//! `begin_turn` / `trigger` / `end_turn` are serialized by a small mutex so their multi-step
//! updates can't interleave (a trigger landing mid-`begin_turn` would otherwise leave a turn whose
//! audio is dropped but whose LLM/TTS work is never cancelled). That mutex and `Notify` are why
//! these run on worker threads, never inside the cpal callbacks, which only read the atomics.

use std::future::Future;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::{select, Either};
use tokio::sync::Notify;

use super::ring::{PcmRing, Ticket, PLAYBACK_CHUNK};

pub type PlaybackRing = PcmRing<PLAYBACK_CHUNK>;

/// One assistant turn: LLM stream + TTS + playback. Cancelled by barge-in or by a newer turn.
#[derive(Clone, Copy, Debug)]
pub struct Turn {
    generation: u64,
    /// Playback epoch this turn's audio is written for.
    pub ticket: Ticket,
}

pub struct BargeIn {
    flag: Arc<AtomicBool>,
    generation: AtomicU64,
    active: AtomicBool,
    fired: AtomicU64,
    notify: Notify,
    playback: Arc<PlaybackRing>,
    transition: Mutex<()>,
}

impl BargeIn {
    pub fn new(playback: Arc<PlaybackRing>) -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            generation: AtomicU64::new(0),
            active: AtomicBool::new(false),
            fired: AtomicU64::new(0),
            notify: Notify::new(),
            playback,
            transition: Mutex::new(()),
        }
    }

    /// The raw flag, shared with the output callback.
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }

    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Whether an assistant turn is in flight (generating or speaking).
    pub fn turn_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn fired_count(&self) -> u64 {
        self.fired.load(Ordering::Relaxed)
    }

    /// Start a new assistant turn. Supersedes (and silences) any previous turn.
    pub fn begin_turn(&self) -> Turn {
        let _serial = self.transition.lock().unwrap_or_else(|e| e.into_inner());
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        // Flush before clearing the flag so the output callback never sees old frames as current.
        // The flush's own epoch is the ticket, so every turn owns a unique epoch.
        let ticket = Ticket(self.playback.flush());
        self.flag.store(false, Ordering::Release);
        self.active.store(true, Ordering::Release);
        // Wake waiters of the superseded turn; they re-check and see the generation moved.
        self.notify.notify_waiters();
        Turn { generation, ticket }
    }

    /// Mark the turn finished (its audio is fully queued or it failed). No-op for a stale turn.
    pub fn end_turn(&self, turn: &Turn) {
        let _serial = self.transition.lock().unwrap_or_else(|e| e.into_inner());
        if self.generation.load(Ordering::Acquire) == turn.generation {
            self.active.store(false, Ordering::Release);
        }
    }

    /// Cut the assistant off. Returns false if the flag was already set (idempotent).
    pub fn trigger(&self) -> bool {
        let _serial = self.transition.lock().unwrap_or_else(|e| e.into_inner());
        if self.flag.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.playback.flush();
        self.active.store(false, Ordering::Release);
        self.fired.fetch_add(1, Ordering::Relaxed);
        self.notify.notify_waiters();
        true
    }

    pub fn is_cancelled(&self, turn: &Turn) -> bool {
        self.flag.load(Ordering::Acquire) || self.generation.load(Ordering::Acquire) != turn.generation
    }

    /// Resolves once `turn` is cancelled (barge-in or superseded).
    #[allow(dead_code)] // integration seam: LM Studio SSE / Kokoro tasks await this
    pub async fn cancelled(&self, turn: &Turn) {
        loop {
            let mut notified = pin!(self.notify.notified());
            // Register before checking, so a trigger between the check and the await isn't lost.
            notified.as_mut().enable();
            if self.is_cancelled(turn) {
                return;
            }
            notified.await;
        }
    }

    /// Run `fut` unless the turn is cancelled first; on cancel `fut` is dropped and `None` returned.
    /// Wrap the LM Studio SSE read loop and each Kokoro synth request in this.
    #[allow(dead_code)] // integration seam, see module docs
    pub async fn until_cancelled<F: Future>(&self, turn: &Turn, fut: F) -> Option<F::Output> {
        let work = pin!(fut);
        let cancel = pin!(self.cancelled(turn));
        match select(work, cancel).await {
            Either::Left((out, _)) => Some(out),
            Either::Right(((), _)) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn barge() -> BargeIn {
        BargeIn::new(Arc::new(PlaybackRing::new(16)))
    }

    #[test]
    fn trigger_flushes_playback_and_is_idempotent() {
        let b = barge();
        let turn = b.begin_turn();
        b.playback.push(turn.ticket, &[0.5; 8]).unwrap();
        assert!(b.turn_active());
        assert!(b.trigger());
        assert!(!b.trigger(), "second trigger is a no-op");
        assert_eq!(b.fired_count(), 1);
        assert!(b.is_cancelled(&turn));
        assert!(!b.turn_active());
        assert!(b.playback.pop_current(16).is_none(), "queued audio is stale");
        assert!(!b.playback.is_current(turn.ticket));
    }

    #[test]
    fn new_turn_clears_flag_but_old_turn_stays_cancelled() {
        let b = barge();
        let old = b.begin_turn();
        b.trigger();
        let new = b.begin_turn();
        assert!(!b.is_set());
        assert!(b.is_cancelled(&old));
        assert!(!b.is_cancelled(&new));
        b.end_turn(&old);
        assert!(b.turn_active(), "ending a stale turn doesn't end the current one");
        b.end_turn(&new);
        assert!(!b.turn_active());
    }

    #[test]
    fn until_cancelled_drops_work_on_trigger() {
        let b = Arc::new(barge());
        let turn = b.begin_turn();
        let trig = Arc::clone(&b);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            trig.trigger();
        });
        let out = tauri::async_runtime::block_on(b.until_cancelled(&turn, async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            "finished"
        }));
        t.join().unwrap();
        assert_eq!(out, None);
    }

    #[test]
    fn until_cancelled_passes_through_when_not_cancelled() {
        let b = barge();
        let turn = b.begin_turn();
        let out = tauri::async_runtime::block_on(b.until_cancelled(&turn, async { 7 }));
        assert_eq!(out, Some(7));
    }

    #[test]
    fn newer_turn_cancels_waiters_of_older_turn() {
        let b = Arc::new(barge());
        let old = b.begin_turn();
        let b2 = Arc::clone(&b);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            b2.begin_turn();
        });
        tauri::async_runtime::block_on(b.cancelled(&old));
        t.join().unwrap();
    }
}
