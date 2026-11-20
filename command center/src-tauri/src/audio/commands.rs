//! Tauri surface for the native audio engine. Events go out on `audio-engine` as
//! [`EngineEvent`] payloads (`{ type: "speechStart", bargedIn }`, …).

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use super::engine::{self, AudioDevices, EngineEvent, EngineHandle, EngineStatus, EventSink, PlaybackWriter, StartOptions};

pub const EVENT: &str = "audio-engine";
const TONE_RATE: u32 = 24_000; // Kokoro's output rate, so the test tone exercises the resampler

/// Lifecycle: a stop that lands while devices are still opening wins over that start.
enum Slot {
    Idle,
    Starting(u64),
    Running(EngineHandle),
}

struct Inner {
    slot: Slot,
    generation: u64,
}

pub struct AudioEngineState {
    inner: Mutex<Inner>,
}

impl Default for AudioEngineState {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner { slot: Slot::Idle, generation: 0 }) }
    }
}

impl AudioEngineState {
    fn guard(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn shared(&self) -> Result<Arc<engine::Shared>, String> {
        match &self.guard().slot {
            Slot::Running(h) => Ok(Arc::clone(&h.shared)),
            _ => Err("audio engine isn't running".into()),
        }
    }
}

struct AppSink(AppHandle);

impl EventSink for AppSink {
    fn emit(&self, event: EngineEvent) {
        let _ = self.0.emit(EVENT, event);
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("audio task failed: {e}"))
}

#[tauri::command]
pub async fn audio_engine_devices() -> Result<AudioDevices, String> {
    blocking(engine::list_devices).await?
}

#[tauri::command]
pub async fn audio_engine_start(app: AppHandle, state: State<'_, AudioEngineState>, options: Option<StartOptions>) -> Result<EngineStatus, String> {
    // Claim the slot under the lock; never hold the guard across an await.
    let (generation, dead) = {
        let mut inner = state.guard();
        match &inner.slot {
            Slot::Running(h) if h.shared.is_healthy() => return Ok(h.status()),
            Slot::Starting(_) => return Err("audio engine is already starting".into()),
            _ => {}
        }
        inner.generation += 1;
        let generation = inner.generation;
        // A Running engine here has a failed stream: replace it.
        let dead = match std::mem::replace(&mut inner.slot, Slot::Starting(generation)) {
            Slot::Running(h) => Some(h),
            _ => None,
        };
        (generation, dead)
    };
    if let Some(h) = dead {
        blocking(move || drop(h)).await?;
    }
    let opts = options.unwrap_or_default();
    let sink = AppSink(app);
    let started = blocking(move || engine::start(opts, sink)).await.and_then(|r| r);
    let (result, loser) = {
        let mut inner = state.guard();
        let still_ours = matches!(inner.slot, Slot::Starting(g) if g == generation);
        match started {
            Ok(handle) if still_ours => {
                let status = handle.status();
                inner.slot = Slot::Running(handle);
                (Ok(status), None)
            }
            Ok(handle) => (Err("audio engine start was cancelled by stop".to_string()), Some(handle)),
            Err(e) => {
                if still_ours {
                    inner.slot = Slot::Idle;
                }
                (Err(e), None)
            }
        }
    };
    if let Some(h) = loser {
        let _ = blocking(move || drop(h)).await;
    }
    result
}

#[tauri::command]
pub async fn audio_engine_stop(state: State<'_, AudioEngineState>) -> Result<(), String> {
    let handle = {
        let mut inner = state.guard();
        inner.generation += 1; // cancels an in-flight start
        match std::mem::replace(&mut inner.slot, Slot::Idle) {
            Slot::Running(h) => Some(h),
            _ => None,
        }
    };
    if let Some(h) = handle {
        blocking(move || drop(h)).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn audio_engine_status(state: State<'_, AudioEngineState>) -> EngineStatus {
    match &state.guard().slot {
        Slot::Running(h) => h.status(),
        _ => EngineStatus { level_db: -100.0, ..Default::default() },
    }
}

/// Cut the assistant off now (same path VAD onset takes). Returns false if already cut off.
#[tauri::command]
pub fn audio_engine_barge_in(app: AppHandle, state: State<'_, AudioEngineState>) -> Result<bool, String> {
    let fired = state.shared()?.barge.trigger();
    if fired {
        let _ = app.emit(EVENT, EngineEvent::BargeIn);
    }
    Ok(fired)
}

/// Play a tone as a fake assistant turn, to check output and barge-in by talking over it.
#[tauri::command]
pub fn audio_engine_test_tone(state: State<'_, AudioEngineState>, freq_hz: Option<f32>, ms: Option<u32>) -> Result<(), String> {
    let shared = state.shared()?;
    let freq = freq_hz.unwrap_or(440.0).clamp(50.0, 4_000.0);
    let total = (TONE_RATE as u64 * ms.unwrap_or(3_000).clamp(50, 15_000) as u64 / 1000) as usize;
    std::thread::Builder::new()
        .name("audio-test-tone".into())
        .spawn(move || {
            let turn = shared.barge.begin_turn();
            let mut writer = PlaybackWriter::new(Arc::clone(&shared), turn, TONE_RATE);
            let step = 2.0 * std::f32::consts::PI * freq / TONE_RATE as f32;
            let mut chunk = [0f32; 480];
            let mut n = 0usize;
            let ok = loop {
                if n >= total {
                    break true;
                }
                let len = chunk.len().min(total - n);
                for (i, s) in chunk[..len].iter_mut().enumerate() {
                    *s = 0.2 * (step * (n + i) as f32).sin();
                }
                n += len;
                if writer.write(&chunk[..len]).is_err() {
                    break false;
                }
            };
            if ok {
                let _ = writer.finish();
            }
            shared.barge.end_turn(&turn);
        })
        .map(|_| ())
        .map_err(|e| format!("spawning tone thread: {e}"))
}
