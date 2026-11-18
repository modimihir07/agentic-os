//! Full-duplex engine: cpal capture → capture ring → VAD worker, and TTS writer → playback ring →
//! cpal output, with barge-in wired between them.
//!
//! Threads:
//! - **cpal I/O threads** (owned by cpal; MMCSS real-time via the `realtime` feature). The
//!   callbacks only convert, resample, copy into fixed frames and touch atomics: no locks, no
//!   allocation, no syscalls.
//! - **`audio-io`**: owns the `cpal::Stream`s for their whole life and parks until stop.
//! - **`audio-vad`**: drains the capture ring, runs the [`Vad`], triggers barge-in, keeps the
//!   current utterance for STT, and emits [`EngineEvent`]s.
//! - **TTS producers** (any thread): write through a [`PlaybackWriter`] bound to a [`Turn`].

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use serde::{Deserialize, Serialize};

use super::barge::{BargeIn, PlaybackRing, Turn};
use super::resample::Resampler;
use super::ring::{Frame, PcmRing, PushError, CAPTURE_HOP, MAX_STALE_DISCARDS, PLAYBACK_CHUNK};
use super::vad::{EnergyVad, EnergyVadConfig, Vad, VadEvent};

/// VAD / STT rate.
pub const CAPTURE_RATE: u32 = 16_000;
/// 2 s of capture headroom if the VAD worker stalls (oldest audio is overwritten past that).
const CAPTURE_FRAMES: usize = 200;
/// ~2 s of playback at 48 kHz; TTS writers block (sleeping) when it's full.
const PLAYBACK_FRAMES: usize = 200;
/// Audio kept from before the onset so the first syllable reaches STT (20 × 10 ms).
const PREROLL_HOPS: usize = 20;
/// Longest utterance kept for STT (30 s at 16 kHz); longer speech keeps only the first 30 s.
const MAX_UTTERANCE_SAMPLES: usize = CAPTURE_RATE as usize * 30;
/// Completed utterances kept for STT before the oldest is dropped.
const MAX_PENDING_UTTERANCES: usize = 8;
const VAD_POLL: Duration = Duration::from_millis(2);
const WRITER_BACKOFF: Duration = Duration::from_millis(5);
/// A writer that can't push for this long assumes the output side is gone and gives up.
const WRITER_STALL: Duration = Duration::from_secs(2);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------------------------

pub struct Shared {
    pub capture: PcmRing<CAPTURE_HOP>,
    pub playback: Arc<PlaybackRing>,
    pub barge: BargeIn,
    pub output_rate: u32,
    running: AtomicBool,
    playing: AtomicBool,
    in_speech: AtomicBool,
    underruns: AtomicU64,
    level_db: AtomicU32,
    stream_failed: AtomicBool,
    last_error: Mutex<Option<String>>,
    utterances: Mutex<VecDeque<Vec<f32>>>,
}

impl Shared {
    pub(crate) fn new(output_rate: u32) -> Arc<Self> {
        let playback = Arc::new(PlaybackRing::new(PLAYBACK_FRAMES));
        Arc::new(Self {
            capture: PcmRing::new(CAPTURE_FRAMES),
            barge: BargeIn::new(Arc::clone(&playback)),
            playback,
            output_rate,
            running: AtomicBool::new(true),
            playing: AtomicBool::new(false),
            in_speech: AtomicBool::new(false),
            underruns: AtomicU64::new(0),
            level_db: AtomicU32::new((-100.0f32).to_bits()),
            stream_failed: AtomicBool::new(false),
            last_error: Mutex::new(None),
            utterances: Mutex::new(VecDeque::with_capacity(MAX_PENDING_UTTERANCES)),
        })
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    /// Take the oldest completed utterance (16 kHz mono f32), for STT. The Moonshine seam.
    #[allow(dead_code)] // integration seam: Moonshine STT consumes this
    pub fn take_utterance(&self) -> Option<Vec<f32>> {
        lock(&self.utterances).pop_front()
    }

    /// Streams open and healthy.
    pub fn is_healthy(&self) -> bool {
        self.is_running() && !self.stream_failed.load(Ordering::Acquire)
    }

    fn set_error(&self, msg: String) {
        *lock(&self.last_error) = Some(msg);
        self.stream_failed.store(true, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------------------------
// Real-time callback bodies (plain structs so tests can drive them without hardware)
// ---------------------------------------------------------------------------------------------

/// Input callback state: interleaved device samples → mono → 16 kHz → 10 ms hops → capture ring.
pub(crate) struct InputCapture {
    shared: Arc<Shared>,
    channels: usize,
    resampler: Resampler,
    hop: [f32; CAPTURE_HOP],
    fill: usize,
}

impl InputCapture {
    pub(crate) fn new(shared: Arc<Shared>, channels: usize, device_rate: u32) -> Self {
        Self { shared, channels: channels.max(1), resampler: Resampler::new(device_rate, CAPTURE_RATE), hop: [0.0; CAPTURE_HOP], fill: 0 }
    }

    pub(crate) fn capture<T>(&mut self, data: &[T])
    where
        T: Sample,
        f32: FromSample<T>,
    {
        let scale = 1.0 / self.channels as f32;
        let Self { shared, channels, resampler, hop, fill } = self;
        for frame in data.chunks_exact(*channels) {
            let mono = frame.iter().map(|&s| f32::from_sample(s)).sum::<f32>() * scale;
            resampler.process(&[mono], |x| {
                hop[*fill] = x;
                *fill += 1;
                if *fill == CAPTURE_HOP {
                    shared.capture.push_overwrite(&hop[..]);
                    *fill = 0;
                }
            });
        }
    }
}

/// Output callback state: playback ring → every channel; silence the instant barge-in is set.
pub(crate) struct OutputRenderer {
    shared: Arc<Shared>,
    flag: Arc<AtomicBool>,
    channels: usize,
    current: Option<Frame<PLAYBACK_CHUNK>>,
    pos: usize,
}

impl OutputRenderer {
    pub(crate) fn new(shared: Arc<Shared>, channels: usize) -> Self {
        let flag = shared.barge.flag();
        Self { shared, flag, channels: channels.max(1), current: None, pos: 0 }
    }

    pub(crate) fn render<T>(&mut self, out: &mut [T])
    where
        T: Sample + FromSample<f32>,
    {
        let playback = &self.shared.playback;
        if self.flag.load(Ordering::Acquire) {
            self.current = None;
            out.fill(T::EQUILIBRIUM);
            self.shared.playing.store(false, Ordering::Relaxed);
            return;
        }
        // A newer turn flushed the ring without barge-in: drop the half-played old frame too.
        if self.current.as_ref().is_some_and(|f| f.epoch != playback.epoch()) {
            self.current = None;
        }
        let mut played = false;
        let mut starved = false;
        for frame in out.chunks_mut(self.channels) {
            let sample = loop {
                if let Some(f) = &self.current {
                    if self.pos < f.len {
                        let s = f.data[self.pos];
                        self.pos += 1;
                        break Some(s);
                    }
                }
                if starved {
                    break None;
                }
                match playback.pop_current(MAX_STALE_DISCARDS) {
                    Some(f) => {
                        self.current = Some(f);
                        self.pos = 0;
                    }
                    None => {
                        self.current = None;
                        starved = true;
                        break None;
                    }
                }
            };
            let value = match sample {
                Some(s) => {
                    played = true;
                    T::from_sample(s.clamp(-1.0, 1.0))
                }
                None => T::EQUILIBRIUM,
            };
            frame.fill(value);
        }
        if played && starved && self.shared.barge.turn_active() {
            // Ran dry mid-buffer while the turn still has audio coming: TTS fell behind.
            self.shared.underruns.fetch_add(1, Ordering::Relaxed);
        }
        self.shared.playing.store(played, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------------------------
// TTS producer side
// ---------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub struct Cancelled;

/// Writes one turn's synthesized PCM into the playback ring at the device rate.
/// Blocking: call from a worker thread (`spawn_blocking` from async code).
pub struct PlaybackWriter {
    shared: Arc<Shared>,
    turn: Turn,
    resampler: Resampler,
    chunk: Vec<f32>,
    scratch: Vec<f32>,
}

impl PlaybackWriter {
    pub fn new(shared: Arc<Shared>, turn: Turn, source_rate: u32) -> Self {
        let resampler = Resampler::new(source_rate, shared.output_rate);
        Self { shared, turn, resampler, chunk: Vec::with_capacity(PLAYBACK_CHUNK), scratch: Vec::new() }
    }

    pub fn is_cancelled(&self) -> bool {
        self.shared.barge.is_cancelled(&self.turn)
    }

    /// Queue mono PCM at the source rate. `Err(Cancelled)` once barge-in or a newer turn hits.
    pub fn write(&mut self, pcm: &[f32]) -> Result<(), Cancelled> {
        if self.is_cancelled() {
            return Err(Cancelled);
        }
        self.scratch.clear();
        let scratch = &mut self.scratch;
        self.resampler.process(pcm, |s| scratch.push(s));
        let mut i = 0;
        while i < self.scratch.len() {
            let take = (PLAYBACK_CHUNK - self.chunk.len()).min(self.scratch.len() - i);
            self.chunk.extend_from_slice(&self.scratch[i..i + take]);
            i += take;
            if self.chunk.len() == PLAYBACK_CHUNK {
                self.push_chunk()?;
            }
        }
        Ok(())
    }

    /// Queue the partial last chunk. The turn stays active until the caller ends it.
    pub fn finish(mut self) -> Result<(), Cancelled> {
        if !self.chunk.is_empty() {
            self.push_chunk()?;
        }
        Ok(())
    }

    fn push_chunk(&mut self) -> Result<(), Cancelled> {
        let mut waited = Duration::ZERO;
        loop {
            match self.shared.playback.push(self.turn.ticket, &self.chunk) {
                Ok(()) => {
                    self.chunk.clear();
                    return Ok(());
                }
                Err(PushError::Stale) => return Err(Cancelled),
                Err(PushError::Full) => {
                    // Cancelled, stopped, or the output stream died and nothing drains the ring.
                    if self.is_cancelled() || !self.shared.is_healthy() || waited >= WRITER_STALL {
                        return Err(Cancelled);
                    }
                    std::thread::sleep(WRITER_BACKOFF);
                    waited += WRITER_BACKOFF;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// VAD worker
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    /// Speech started. `bargedIn` is true when it cut off the assistant.
    #[serde(rename_all = "camelCase")]
    SpeechStart { barged_in: bool },
    /// Speech ended; the utterance is ready via `take_utterance`.
    #[serde(rename_all = "camelCase")]
    SpeechEnd { duration_ms: u64 },
    /// Barge-in fired outside VAD (manual / API).
    BargeIn,
    /// A cpal stream reported an error; the engine should be restarted.
    StreamError { message: String },
}

pub trait EventSink: Send + 'static {
    fn emit(&self, event: EngineEvent);
}

pub(crate) fn vad_loop(shared: Arc<Shared>, mut vad: Box<dyn Vad>, barge_on_speech: bool, sink: impl EventSink) {
    let mut utterance: Vec<f32> = Vec::with_capacity(CAPTURE_RATE as usize * 10);
    let mut preroll: VecDeque<Frame<CAPTURE_HOP>> = VecDeque::with_capacity(PREROLL_HOPS);
    let mut error_reported = false;
    while shared.is_running() {
        if !error_reported && shared.stream_failed.load(Ordering::Acquire) {
            error_reported = true;
            let message = lock(&shared.last_error).clone().unwrap_or_default();
            sink.emit(EngineEvent::StreamError { message });
        }
        let Some(frame) = shared.capture.pop_current(usize::MAX) else {
            std::thread::sleep(VAD_POLL);
            continue;
        };
        let event = vad.process(frame.samples());
        shared.level_db.store(vad.last_level_db().to_bits(), Ordering::Relaxed);
        match event {
            VadEvent::SpeechOnset => {
                shared.in_speech.store(true, Ordering::Relaxed);
                let assistant_busy = shared.barge.turn_active() || shared.is_playing();
                let barged_in = barge_on_speech && assistant_busy && shared.barge.trigger();
                sink.emit(EngineEvent::SpeechStart { barged_in });
                utterance.clear();
                for f in preroll.drain(..) {
                    utterance.extend_from_slice(f.samples());
                }
                utterance.extend_from_slice(frame.samples());
            }
            VadEvent::Speech => {
                if utterance.len() + frame.len <= MAX_UTTERANCE_SAMPLES {
                    utterance.extend_from_slice(frame.samples());
                }
            }
            VadEvent::SpeechEnd => {
                shared.in_speech.store(false, Ordering::Relaxed);
                let duration_ms = (utterance.len() as u64 * 1000) / CAPTURE_RATE as u64;
                {
                    let mut pending = lock(&shared.utterances);
                    if pending.len() == MAX_PENDING_UTTERANCES {
                        pending.pop_front();
                    }
                    pending.push_back(std::mem::take(&mut utterance));
                }
                utterance.reserve(CAPTURE_RATE as usize * 10);
                sink.emit(EngineEvent::SpeechEnd { duration_ms });
            }
            VadEvent::Silence => {
                if preroll.len() == PREROLL_HOPS {
                    preroll.pop_front();
                }
                preroll.push_back(frame);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Devices and lifecycle
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StartOptions {
    /// cpal device id (from `list_devices`); None / "default" = system default.
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub vad: EnergyVadConfig,
    /// Cut the assistant off when the user starts talking. Default true.
    pub barge_in: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub host: String,
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub input: Option<StreamInfo>,
    pub output: Option<StreamInfo>,
    pub capture_queued: usize,
    pub capture_overruns: u64,
    pub playback_queued: usize,
    pub playback_discarded: u64,
    pub playback_underruns: u64,
    pub barge_ins: u64,
    pub barge_flag: bool,
    pub turn_active: bool,
    pub playing: bool,
    pub in_speech: bool,
    pub level_db: f32,
    pub last_error: Option<String>,
}

fn device_name(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| "unknown device".into())
}

fn device_id(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|id| id.to_string())
}

pub fn list_devices() -> Result<AudioDevices, String> {
    let host = cpal::default_host();
    let default_in = host.default_input_device().and_then(|d| device_id(&d));
    let default_out = host.default_output_device().and_then(|d| device_id(&d));
    let describe = |d: cpal::Device, default: &Option<String>| {
        let id = device_id(&d)?;
        Some(DeviceInfo { is_default: default.as_ref() == Some(&id), name: device_name(&d), id })
    };
    let inputs = host.input_devices().map_err(|e| format!("listing input devices: {e}"))?.filter_map(|d| describe(d, &default_in)).collect();
    let outputs = host.output_devices().map_err(|e| format!("listing output devices: {e}"))?.filter_map(|d| describe(d, &default_out)).collect();
    Ok(AudioDevices { host: format!("{:?}", host.id()), inputs, outputs })
}

fn pick_device(host: &cpal::Host, wanted: Option<&str>, input: bool) -> Result<cpal::Device, String> {
    let kind = if input { "input" } else { "output" };
    match wanted.map(str::trim).filter(|w| !w.is_empty() && *w != "default") {
        None => if input { host.default_input_device() } else { host.default_output_device() }.ok_or_else(|| format!("no default {kind} device")),
        Some(id) => {
            let mut devices: Box<dyn Iterator<Item = cpal::Device>> = if input {
                Box::new(host.input_devices().map_err(|e| format!("listing {kind} devices: {e}"))?)
            } else {
                Box::new(host.output_devices().map_err(|e| format!("listing {kind} devices: {e}"))?)
            };
            devices.find(|d| device_id(d).as_deref() == Some(id)).ok_or_else(|| format!("{kind} device not found: {id}"))
        }
    }
}

fn build_input<T>(device: &cpal::Device, config: StreamConfig, shared: &Arc<Shared>) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut capture = InputCapture::new(Arc::clone(shared), config.channels as usize, config.sample_rate);
    let errs = Arc::clone(shared);
    device
        .build_input_stream::<T, _, _>(config, move |data: &[T], _| capture.capture(data), move |e| errs.set_error(format!("input stream: {e}")), None)
        .map_err(|e| format!("opening input stream: {e}"))
}

fn build_output<T>(device: &cpal::Device, config: StreamConfig, shared: &Arc<Shared>) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let mut renderer = OutputRenderer::new(Arc::clone(shared), config.channels as usize);
    let errs = Arc::clone(shared);
    device
        .build_output_stream::<T, _, _>(config, move |out: &mut [T], _| renderer.render(out), move |e| errs.set_error(format!("output stream: {e}")), None)
        .map_err(|e| format!("opening output stream: {e}"))
}

macro_rules! by_format {
    ($format:expr, $build:ident, $($arg:expr),+) => {
        match $format {
            SampleFormat::F32 => $build::<f32>($($arg),+),
            SampleFormat::I16 => $build::<i16>($($arg),+),
            SampleFormat::U16 => $build::<u16>($($arg),+),
            SampleFormat::I32 => $build::<i32>($($arg),+),
            SampleFormat::I8 => $build::<i8>($($arg),+),
            SampleFormat::U8 => $build::<u8>($($arg),+),
            SampleFormat::F64 => $build::<f64>($($arg),+),
            SampleFormat::I24 => $build::<cpal::I24>($($arg),+),
            SampleFormat::U24 => $build::<cpal::U24>($($arg),+),
            SampleFormat::U32 => $build::<u32>($($arg),+),
            SampleFormat::I64 => $build::<i64>($($arg),+),
            SampleFormat::U64 => $build::<u64>($($arg),+),
            other => Err(format!("unsupported sample format {other:?}")),
        }
    };
}

/// A running engine. Dropping it stops the streams and joins the threads.
pub struct EngineHandle {
    pub shared: Arc<Shared>,
    pub input: StreamInfo,
    pub output: StreamInfo,
    stop_tx: Option<mpsc::Sender<()>>,
    io_thread: Option<JoinHandle<()>>,
    vad_thread: Option<JoinHandle<()>>,
}

type Opened = (Arc<Shared>, StreamInfo, StreamInfo);

/// Runs on `audio-io`: opens both devices, starts the streams, reports back, parks until stop.
fn io_thread(opts: StartOptions, ready: mpsc::SyncSender<Result<Opened, String>>, stop_rx: mpsc::Receiver<()>) {
    let opened = (|| -> Result<(cpal::Stream, cpal::Stream, Opened), String> {
        let host = cpal::default_host();
        let in_dev = pick_device(&host, opts.input_device.as_deref(), true)?;
        let out_dev = pick_device(&host, opts.output_device.as_deref(), false)?;
        let in_cfg = in_dev.default_input_config().map_err(|e| format!("input config: {e}"))?;
        let out_cfg = out_dev.default_output_config().map_err(|e| format!("output config: {e}"))?;
        let shared = Shared::new(out_cfg.sample_rate());
        let info = |d: &cpal::Device, c: &cpal::SupportedStreamConfig| StreamInfo {
            device: device_name(d),
            sample_rate: c.sample_rate(),
            channels: c.channels(),
            format: format!("{:?}", c.sample_format()),
        };
        let (in_info, out_info) = (info(&in_dev, &in_cfg), info(&out_dev, &out_cfg));
        let input = by_format!(in_cfg.sample_format(), build_input, &in_dev, in_cfg.config(), &shared)?;
        let output = by_format!(out_cfg.sample_format(), build_output, &out_dev, out_cfg.config(), &shared)?;
        output.play().map_err(|e| format!("starting output: {e}"))?;
        input.play().map_err(|e| format!("starting input: {e}"))?;
        Ok((input, output, (shared, in_info, out_info)))
    })();
    match opened {
        Ok((input, output, opened)) => {
            let shared = Arc::clone(&opened.0);
            if ready.send(Ok(opened)).is_err() {
                return;
            }
            // Park until stop (or until the handle is dropped and the sender disconnects).
            let _ = stop_rx.recv();
            shared.running.store(false, Ordering::Release);
            drop(input);
            drop(output);
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
}

pub fn start(opts: StartOptions, sink: impl EventSink) -> Result<EngineHandle, String> {
    let barge_on_speech = opts.barge_in.unwrap_or(true);
    let vad_cfg = opts.vad.sanitized();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (stop_tx, stop_rx) = mpsc::channel();
    let io = std::thread::Builder::new()
        .name("audio-io".into())
        .spawn(move || io_thread(opts, ready_tx, stop_rx))
        .map_err(|e| format!("spawning audio thread: {e}"))?;
    let (shared, input, output) = match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(opened)) => opened,
        Ok(Err(e)) => {
            let _ = io.join();
            return Err(e);
        }
        Err(_) => {
            drop(stop_tx);
            return Err("audio devices didn't open within 10 s".into());
        }
    };
    let vad_shared = Arc::clone(&shared);
    let vad = std::thread::Builder::new()
        .name("audio-vad".into())
        .spawn(move || vad_loop(vad_shared, Box::new(EnergyVad::new(vad_cfg)), barge_on_speech, sink));
    let vad = match vad {
        Ok(h) => h,
        Err(e) => {
            let _ = stop_tx.send(());
            let _ = io.join();
            return Err(format!("spawning VAD thread: {e}"));
        }
    };
    Ok(EngineHandle { shared, input, output, stop_tx: Some(stop_tx), io_thread: Some(io), vad_thread: Some(vad) })
}

impl EngineHandle {
    pub fn status(&self) -> EngineStatus {
        let s = &self.shared;
        EngineStatus {
            running: s.is_healthy(),
            input: Some(self.input.clone()),
            output: Some(self.output.clone()),
            capture_queued: s.capture.len(),
            capture_overruns: s.capture.overruns(),
            playback_queued: s.playback.len(),
            playback_discarded: s.playback.discarded(),
            playback_underruns: s.underruns.load(Ordering::Relaxed),
            barge_ins: s.barge.fired_count(),
            barge_flag: s.barge.is_set(),
            turn_active: s.barge.turn_active(),
            playing: s.is_playing(),
            in_speech: s.in_speech.load(Ordering::Relaxed),
            level_db: f32::from_bits(s.level_db.load(Ordering::Relaxed)),
            last_error: lock(&s.last_error).clone(),
        }
    }

    /// Stop streams and join threads. Idempotent.
    pub fn stop(&mut self) {
        self.shared.running.store(false, Ordering::Release);
        // Cancel any turn so blocked writers and awaiting LLM/TTS tasks unwind.
        self.shared.barge.trigger();
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.io_thread.take() {
            let _ = h.join();
        }
        if let Some(h) = self.vad_thread.take() {
            let _ = h.join();
        }
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------------------------------------
// Tests (no audio hardware needed)
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct Collect(Arc<Mutex<Vec<EngineEvent>>>);
    impl EventSink for Collect {
        fn emit(&self, event: EngineEvent) {
            lock(&self.0).push(event);
        }
    }

    fn sine(rate: u32, hz: f32, amp: f32, samples: usize) -> Vec<f32> {
        (0..samples).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect()
    }

    #[test]
    fn writer_resamples_into_playback_and_renderer_plays_it() {
        let shared = Shared::new(48_000);
        let turn = shared.barge.begin_turn();
        let mut w = PlaybackWriter::new(Arc::clone(&shared), turn, 24_000);
        w.write(&sine(24_000, 440.0, 0.5, 2_400)).unwrap(); // 100 ms
        w.finish().unwrap();
        // ~100 ms at 48 kHz = ~4 800 samples ≈ 10 chunks.
        assert!((9..=11).contains(&shared.playback.len()), "{}", shared.playback.len());

        let mut r = OutputRenderer::new(Arc::clone(&shared), 2);
        let mut out = vec![0.0f32; 960]; // 480 stereo frames = 10 ms
        r.render(&mut out);
        assert!(shared.is_playing());
        assert!(out.chunks(2).all(|f| f[0] == f[1]), "mono duplicated to both channels");
        assert!(out.iter().any(|s| s.abs() > 0.1));
    }

    #[test]
    fn barge_in_silences_the_very_next_callback_and_cancels_writer() {
        let shared = Shared::new(48_000);
        let turn = shared.barge.begin_turn();
        let mut w = PlaybackWriter::new(Arc::clone(&shared), turn, 48_000);
        w.write(&sine(48_000, 440.0, 0.5, 9_600)).unwrap();
        let mut r = OutputRenderer::new(Arc::clone(&shared), 1);
        let mut out = vec![0.0f32; 480];
        r.render(&mut out);
        assert!(out.iter().any(|s| s.abs() > 0.1));

        assert!(shared.barge.trigger());
        r.render(&mut out);
        assert!(out.iter().all(|s| *s == 0.0), "cut off within one callback");
        assert!(!shared.is_playing());
        assert_eq!(w.write(&[0.1; 100]), Err(Cancelled));
    }

    #[test]
    fn new_turn_drops_half_played_frame_of_previous_turn() {
        let shared = Shared::new(48_000);
        let t1 = shared.barge.begin_turn();
        let mut w = PlaybackWriter::new(Arc::clone(&shared), t1, 48_000);
        w.write(&[0.5; PLAYBACK_CHUNK * 2]).unwrap();
        let mut r = OutputRenderer::new(Arc::clone(&shared), 1);
        let mut out = vec![0.0f32; 100]; // leaves a partial frame in the renderer
        r.render(&mut out);
        let t2 = shared.barge.begin_turn();
        let mut w2 = PlaybackWriter::new(Arc::clone(&shared), t2, 48_000);
        w2.write(&[-0.25; PLAYBACK_CHUNK]).unwrap();
        w2.finish().unwrap();
        r.render(&mut out);
        assert!(out.iter().all(|s| *s == -0.25), "only the new turn's audio plays");
    }

    #[test]
    fn integer_sample_formats_render_and_capture() {
        let shared = Shared::new(48_000);
        let turn = shared.barge.begin_turn();
        shared.playback.push(turn.ticket, &[1.0; 4]).unwrap();
        let mut r = OutputRenderer::new(Arc::clone(&shared), 1);
        let mut out = [0i16; 6];
        r.render(&mut out);
        assert_eq!(&out[..4], &[i16::MAX; 4]);
        assert_eq!(&out[4..], &[0; 2]);

        let mut c = InputCapture::new(Arc::clone(&shared), 1, 16_000);
        c.capture(&[i16::MAX / 2; CAPTURE_HOP + 1]); // +1 for the resampler's priming sample
        let hop = shared.capture.pop_current(1).unwrap();
        assert!((hop.samples()[0] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn speech_onset_during_playback_barges_in_end_to_end() {
        let shared = Shared::new(48_000);
        let turn = shared.barge.begin_turn();
        let mut w = PlaybackWriter::new(Arc::clone(&shared), turn, 48_000);
        w.write(&sine(48_000, 220.0, 0.5, 48_000)).unwrap(); // 1 s queued
        let events = Arc::new(Mutex::new(Vec::new()));
        let vad_shared = Arc::clone(&shared);
        let sink = Collect(Arc::clone(&events));
        let vad = std::thread::spawn(move || vad_loop(vad_shared, Box::new(EnergyVad::new(EnergyVadConfig::default())), true, sink));

        let mut mic = InputCapture::new(Arc::clone(&shared), 2, 48_000);
        let quiet: Vec<f32> = sine(48_000, 300.0, 0.0005, 4_800).into_iter().flat_map(|s| [s, s]).collect();
        let voice: Vec<f32> = sine(48_000, 300.0, 0.4, 4_800).into_iter().flat_map(|s| [s, s]).collect();
        mic.capture(&quiet); // 100 ms room tone
        mic.capture(&voice); // 100 ms speech
        mic.capture(&quiet);
        mic.capture(&quiet);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while lock(&events).len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        shared.running.store(false, Ordering::Release);
        vad.join().unwrap();

        let ev = lock(&events).clone();
        assert_eq!(ev.first(), Some(&EngineEvent::SpeechStart { barged_in: true }), "{ev:?}");
        assert!(matches!(ev.get(1), Some(EngineEvent::SpeechEnd { duration_ms }) if *duration_ms >= 100), "{ev:?}");
        assert!(shared.barge.is_set());
        assert_eq!(w.write(&[0.0; 10]), Err(Cancelled));
        let utterance = shared.take_utterance().expect("utterance kept for STT");
        assert!(utterance.len() >= CAPTURE_RATE as usize / 10);
    }

    #[test]
    fn speech_with_idle_assistant_does_not_barge() {
        let shared = Shared::new(48_000);
        let events = Arc::new(Mutex::new(Vec::new()));
        let vad_shared = Arc::clone(&shared);
        let sink = Collect(Arc::clone(&events));
        let vad = std::thread::spawn(move || vad_loop(vad_shared, Box::new(EnergyVad::new(EnergyVadConfig::default())), true, sink));
        let mut mic = InputCapture::new(Arc::clone(&shared), 1, 16_000);
        mic.capture(&sine(16_000, 300.0, 0.0005, 1_600));
        mic.capture(&sine(16_000, 300.0, 0.4, 1_600));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while lock(&events).is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        shared.running.store(false, Ordering::Release);
        vad.join().unwrap();
        assert_eq!(lock(&events).first(), Some(&EngineEvent::SpeechStart { barged_in: false }));
        assert_eq!(shared.barge.fired_count(), 0);
    }

    /// Opens the real default devices for ~1 s (nothing recorded or played).
    /// `cargo test --lib audio::engine::tests::hardware_smoke -- --ignored --nocapture`
    #[test]
    #[ignore = "needs audio hardware"]
    fn hardware_smoke() {
        let devices = list_devices().expect("list devices");
        println!("host {}: {} inputs, {} outputs", devices.host, devices.inputs.len(), devices.outputs.len());
        struct Quiet;
        impl EventSink for Quiet {
            fn emit(&self, _: EngineEvent) {}
        }
        let mut engine = start(StartOptions::default(), Quiet).expect("start engine");
        std::thread::sleep(Duration::from_millis(1_000));
        let status = engine.status();
        println!("in {:?}
out {:?}
level {:.1} dBFS, overruns {}", status.input, status.output, status.level_db, status.capture_overruns);
        assert!(status.running, "{:?}", status.last_error);
        assert!(status.level_db > -100.0 || status.capture_queued == 0, "VAD consumed capture hops");
        engine.stop();
        assert!(!engine.shared.is_running());
    }

    #[test]
    fn event_payloads_are_camel_case_tagged() {
        let v = serde_json::to_value(EngineEvent::SpeechStart { barged_in: true }).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "speechStart", "bargedIn": true }));
        let v = serde_json::to_value(EngineEvent::SpeechEnd { duration_ms: 420 }).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "speechEnd", "durationMs": 420 }));
    }
}
