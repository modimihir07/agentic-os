//! Lock-free PCM rings between the cpal callbacks and the worker threads.
//!
//! Frames are fixed-size arrays stored inline in a `crossbeam_queue::ArrayQueue`, so a push or pop
//! never allocates and never takes a lock: safe on the real-time audio thread. Each ring is used
//! single-producer / single-consumer (ArrayQueue itself tolerates more, which costs nothing here).
//!
//! `ArrayQueue` has no O(1) clear, so flushing is done by epoch instead: every frame carries the
//! epoch it was written for, `flush()` bumps the ring's epoch with one atomic add, and consumers
//! discard frames from older epochs. Producers write through a [`Ticket`] taken when their turn
//! started, so frames computed before a flush but pushed after it are still stale.
//!
//! Accepted trade-off (decided 2026-11-18): `ArrayQueue` is lock-free but not wait-free. If a
//! producer is preempted between claiming a slot and publishing it, the consumer's `pop` spins
//! until the producer resumes. Kept anyway because the handoff specifies `ArrayQueue`; if
//! callback overruns ever trace back to that spin, swap in a wait-free SPSC ring such as `rtrb`.

use crossbeam_queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};

/// 10 ms at 16 kHz: the capture hop fed to the VAD (TEN VAD accepts 160 or 256).
pub const CAPTURE_HOP: usize = 160;
/// Playback chunk in device-rate mono samples (10 ms at 48 kHz).
pub const PLAYBACK_CHUNK: usize = 480;
/// Most stale frames the output callback discards per invocation, keeping its work bounded
/// right after a flush. The callback outputs silence while it catches up.
pub const MAX_STALE_DISCARDS: usize = 64;

#[derive(Clone, Copy)]
pub struct Frame<const N: usize> {
    pub epoch: u64,
    pub len: usize,
    pub data: [f32; N],
}

impl<const N: usize> Frame<N> {
    pub const fn silent(epoch: u64) -> Self {
        Self { epoch, len: 0, data: [0.0; N] }
    }

    pub fn samples(&self) -> &[f32] {
        &self.data[..self.len.min(N)]
    }
}

/// A producer's claim on one epoch. Stale once the ring is flushed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket(pub(crate) u64);

#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    /// The ring is full; retry after the consumer catches up.
    Full,
    /// The ring was flushed (barge-in) since the ticket was taken; stop producing.
    Stale,
}

pub struct PcmRing<const N: usize> {
    queue: ArrayQueue<Frame<N>>,
    epoch: AtomicU64,
    /// Frames lost to a full ring (capture overwrites the oldest).
    overruns: AtomicU64,
    /// Stale frames discarded by consumers after flushes.
    discarded: AtomicU64,
}

impl<const N: usize> PcmRing<N> {
    pub fn new(capacity_frames: usize) -> Self {
        Self {
            queue: ArrayQueue::new(capacity_frames.max(1)),
            epoch: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            discarded: AtomicU64::new(0),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn ticket(&self) -> Ticket {
        Ticket(self.epoch())
    }

    pub fn is_current(&self, ticket: Ticket) -> bool {
        ticket.0 == self.epoch()
    }

    /// O(1): invalidates every queued frame and every outstanding ticket.
    pub fn flush(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Push for a ticket's epoch. Never blocks.
    pub fn push(&self, ticket: Ticket, samples: &[f32]) -> Result<(), PushError> {
        if !self.is_current(ticket) {
            return Err(PushError::Stale);
        }
        let mut frame = Frame::<N>::silent(ticket.0);
        let n = samples.len().min(N);
        frame.data[..n].copy_from_slice(&samples[..n]);
        frame.len = n;
        self.queue.push(frame).map_err(|_| PushError::Full)
    }

    /// Push at the current epoch, overwriting the oldest frame when full. For capture, where
    /// the newest audio matters most and the producer is the real-time callback.
    pub fn push_overwrite(&self, samples: &[f32]) {
        let mut frame = Frame::<N>::silent(self.epoch());
        let n = samples.len().min(N);
        frame.data[..n].copy_from_slice(&samples[..n]);
        frame.len = n;
        if self.queue.force_push(frame).is_some() {
            self.overruns.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Next frame of the current epoch, discarding at most `max_stale` older frames first.
    pub fn pop_current(&self, max_stale: usize) -> Option<Frame<N>> {
        let mut epoch = self.epoch();
        let mut skipped = 0;
        let found = loop {
            let Some(frame) = self.queue.pop() else {
                break None; // empty: still record what was skipped
            };
            if frame.epoch > epoch {
                // Flushed and refilled while we were discarding: re-read before judging it.
                epoch = self.epoch();
            }
            if frame.epoch == epoch {
                break Some(frame);
            }
            skipped += 1;
            if skipped >= max_stale {
                break None;
            }
        };
        if skipped > 0 {
            self.discarded.fetch_add(skipped as u64, Ordering::Relaxed);
        }
        found
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn overruns(&self) -> u64 {
        self.overruns.load(Ordering::Relaxed)
    }

    pub fn discarded(&self) -> u64 {
        self.discarded.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flush_invalidates_queued_frames_and_tickets() {
        let ring = PcmRing::<4>::new(8);
        let t = ring.ticket();
        ring.push(t, &[1.0, 2.0]).unwrap();
        ring.push(t, &[3.0]).unwrap();
        assert_eq!(ring.flush(), 1);
        // Queued frames are stale: nothing current to pop.
        assert!(ring.pop_current(MAX_STALE_DISCARDS).is_none());
        assert_eq!(ring.discarded(), 2);
        // A producer still holding the old ticket is told to stop.
        assert_eq!(ring.push(t, &[4.0]), Err(PushError::Stale));
        // A new ticket works.
        let t2 = ring.ticket();
        ring.push(t2, &[5.0, 6.0]).unwrap();
        assert_eq!(ring.pop_current(MAX_STALE_DISCARDS).unwrap().samples(), &[5.0, 6.0]);
    }

    #[test]
    fn stale_discards_are_bounded_per_pop() {
        let ring = PcmRing::<1>::new(16);
        let t = ring.ticket();
        for i in 0..10 {
            ring.push(t, &[i as f32]).unwrap();
        }
        ring.flush();
        ring.push(ring.ticket(), &[99.0]).unwrap();
        assert!(ring.pop_current(4).is_none(), "gives up after 4 stale frames");
        assert!(ring.pop_current(4).is_none());
        assert_eq!(ring.pop_current(4).unwrap().samples(), &[99.0]);
        assert_eq!(ring.discarded(), 10);
    }

    #[test]
    fn full_ring_reports_full_and_capture_overwrites_oldest() {
        let ring = PcmRing::<1>::new(2);
        let t = ring.ticket();
        ring.push(t, &[1.0]).unwrap();
        ring.push(t, &[2.0]).unwrap();
        assert_eq!(ring.push(t, &[3.0]), Err(PushError::Full));
        ring.push_overwrite(&[3.0]);
        assert_eq!(ring.overruns(), 1);
        assert_eq!(ring.pop_current(1).unwrap().samples(), &[2.0]);
        assert_eq!(ring.pop_current(1).unwrap().samples(), &[3.0]);
    }

    #[test]
    fn oversized_input_is_truncated_to_frame() {
        let ring = PcmRing::<2>::new(1);
        ring.push(ring.ticket(), &[1.0, 2.0, 3.0]).unwrap();
        assert_eq!(ring.pop_current(1).unwrap().samples(), &[1.0, 2.0]);
    }
}
