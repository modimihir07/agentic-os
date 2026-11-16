//! Voice I/O through local OpenAI-compatible servers.
//!
//!   STT: Whisper  — POST {base}/audio/transcriptions (multipart, 16 kHz mono WAV)
//!   TTS: Kokoro   — POST {base}/audio/speech → audio bytes
//!
//! Audio crosses IPC as raw bytes (no JSON number arrays), both directions.

use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::dispatch::{short, DispatchState, Kind};

const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024; // ~8 min of 16 kHz mono PCM

#[tauri::command]
pub async fn stt_transcribe(state: State<'_, DispatchState>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw WAV bytes".into());
    };
    if bytes.len() < 1024 || bytes.len() > MAX_AUDIO_BYTES {
        return Err("audio too short or too long".into());
    }
    let audio = bytes.clone();

    let cfg = state.snapshot();
    let p = state
        .provider(&cfg.policy.stt)
        .filter(|p| p.kind == Kind::Stt)
        .ok_or("no STT provider configured")?;
    let key = state.key_for(&p)?;

    let part = reqwest::multipart::Part::bytes(audio).file_name("speech.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", p.model.clone())
        .text("response_format", "json")
        .text("temperature", "0");

    let mut rb = state
        .http
        .post(format!("{}/audio/transcriptions", p.base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(60))
        .multipart(form);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let body: serde_json::Value = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.json().await.map_err(short)?;
    let text = body["text"].as_str().unwrap_or_default().trim().to_string();
    // Whisper emits these on silence (the client-side VAD avoids most of it).
    let junk = ["[BLANK_AUDIO]", "(silence)", "[ Silence ]", "[silence]"];
    Ok(if junk.iter().any(|j| text.eq_ignore_ascii_case(j)) { String::new() } else { text })
}

#[tauri::command]
pub async fn tts_synthesize(state: State<'_, DispatchState>, text: String) -> Result<Response, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 2000 {
        return Err("text must be 1–2000 characters".into());
    }
    let cfg = state.snapshot();
    let p = state
        .provider(&cfg.policy.tts)
        .filter(|p| p.kind == Kind::Tts)
        .ok_or("no TTS provider configured")?;
    let key = state.key_for(&p)?;

    let mut rb = state
        .http
        .post(format!("{}/audio/speech", p.base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({
            "model": p.model,
            "input": text,
            "voice": p.voice.clone().unwrap_or_else(|| "af_bella".into()),
            "response_format": "mp3",
            "speed": 1.05,
        }));
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let bytes = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.bytes().await.map_err(short)?;
    Ok(Response::new(bytes.to_vec()))
}
