//! Native full-duplex audio engine with O(1) barge-in (handoff §6.5).
//!
//! ```text
//!  mic ─cpal(RT)─► InputCapture ─► capture ring ─► audio-vad: Vad ─► SpeechStart / SpeechEnd
//!                  mono, 16 kHz,   (ArrayQueue,        │  onset while the assistant is busy
//!                  10 ms hops       160-sample hops)   ▼
//!                                             BargeIn::trigger()  (Arc<AtomicBool>)
//!                                               ├─ flag → OutputRenderer writes silence next period
//!                                               ├─ playback ring epoch += 1 (O(1) flush)
//!                                               └─ Notify → until_cancelled() drops LLM SSE / TTS
//!  speaker ◄─cpal(RT)─ OutputRenderer ◄─ playback ring ◄─ PlaybackWriter (TTS, any thread)
//! ```
//!
//! Scaffold status: device I/O, rings, barge-in, the placeholder energy VAD and the Tauri surface
//! are real and tested. Not wired yet: TEN VAD (implements [`vad::Vad`]), Moonshine STT (consumes
//! `Shared::take_utterance`), Kokoro streaming into a [`engine::PlaybackWriter`], and the LM Studio
//! SSE loop wrapped in [`barge::BargeIn::until_cancelled`]. No echo cancellation: on open speakers
//! the assistant's own voice can trigger barge-in, so use a headset or set `bargeIn: false` until
//! AEC lands.

pub mod barge;
pub mod commands;
pub mod engine;
pub mod resample;
pub mod ring;
pub mod vad;
