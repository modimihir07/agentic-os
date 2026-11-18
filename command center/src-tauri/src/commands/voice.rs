//! Voice I/O through local servers.
//!
//!   STT: Whisper  — POST {base}/audio/transcriptions (multipart, 16 kHz mono WAV)
//!                   whisper.cpp models switch live via POST {origin}/load
//!   TTS: Kokoro   — POST {base}/audio/speech → mp3; voices from GET {base}/audio/voices
//!        XTTS     — POST {origin}/tts_to_audio/ {text, speaker_wav, language} → wav
//!                   (Coqui XTTS api-server; a speaker = a reference .wav)
//!
//! Custom voices are written to the TTS provider's `voicesDir` (mount that
//! folder into the Kokoro / XTTS container). Audio crosses IPC as raw bytes.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::dispatch::{canon_role, short, AgentVoice, DispatchState, Kind, Provider};
use super::elevenlabs;

const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024; // ~8 min of 16 kHz mono PCM
const MAX_VOICE_BYTES: usize = 200 * 1024 * 1024; // .pth / .onnx voice models can be large
const VOICE_EXTS: [&str; 8] = ["wav", "mp3", "flac", "ogg", "pt", "pth", "onnx", "json"];
/// Samples ElevenLabs can clone from.
const CLONE_EXTS: [&str; 6] = ["wav", "mp3", "flac", "ogg", "m4a", "webm"];
const MAX_CLONE_BYTES: usize = 11 * 1024 * 1024;

fn origin(base: &str) -> String {
    url::Url::parse(base).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| base.to_string())
}

fn stt_provider(state: &DispatchState) -> Result<Provider, String> {
    let id = state.snapshot().policy.stt;
    state.provider(&id).filter(|p| p.kind == Kind::Stt).ok_or_else(|| "no STT provider configured".into())
}

fn tts_provider(state: &DispatchState) -> Result<Provider, String> {
    let id = state.snapshot().policy.tts;
    state.provider(&id).filter(|p| p.kind == Kind::Tts).ok_or_else(|| "no TTS provider configured".into())
}

fn voices_dir(state: &DispatchState, p: &Provider) -> Option<PathBuf> {
    p.voices_dir.as_ref().map(PathBuf::from).or_else(|| state.config_dir().map(|d| d.join("voices")))
}

// ── STT ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn stt_transcribe(state: State<'_, DispatchState>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw WAV bytes".into());
    };
    if bytes.len() < 1024 || bytes.len() > MAX_AUDIO_BYTES {
        return Err("audio too short or too long".into());
    }
    let audio = bytes.clone();
    let p = stt_provider(&state)?;
    let key = state.key_for(&p)?;

    let part = reqwest::multipart::Part::bytes(audio).file_name("speech.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", p.model.clone())
        .text("response_format", "json")
        .text("temperature", "0");
    if let Some(lang) = p.language.clone() {
        form = form.text("language", lang);
    }

    let mut rb = state
        .http
        .post(format!("{}/audio/transcriptions", p.base_url.trim_end_matches('/')))
        // Relaxed/continuous Brainstorm dictation can hand Whisper up to a ~2 min clip
        // (MAX_AUDIO_BYTES ≈ 8 min of audio); 60 s was too tight for that on a slow CPU.
        .timeout(Duration::from_secs(180))
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

/// Whisper selector: model variant + language. whisper.cpp loads the new
/// model immediately (POST /load) when `modelsDir` holds ggml-<variant>.bin.
#[tauri::command]
pub async fn stt_configure(state: State<'_, DispatchState>, model: Option<String>, language: Option<String>) -> Result<String, String> {
    let p = stt_provider(&state)?;
    let mut note = "saved".to_string();
    if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
        if !m.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c)) {
            return Err("bad model name".into());
        }
        if p.engine.as_deref() == Some("whispercpp") {
            if let Some(dir) = p.models_dir.as_deref() {
                let file = Path::new(dir).join(format!("ggml-{m}.bin"));
                if !file.exists() {
                    return Err(format!("{} not found — download it into {dir}", file.display()));
                }
                let form = reqwest::multipart::Form::new().text("model", file.to_string_lossy().into_owned());
                state
                    .http
                    .post(format!("{}/load", origin(&p.base_url)))
                    .timeout(Duration::from_secs(120))
                    .multipart(form)
                    .send()
                    .await
                    .map_err(short)?
                    .error_for_status()
                    .map_err(short)?;
                note = format!("loaded ggml-{m}.bin");
            } else {
                note = "saved — set modelsDir to hot-swap whisper.cpp models".into();
            }
        }
    }
    state.update(|cfg| {
        let t = cfg.providers.iter_mut().find(|x| x.id == p.id).ok_or("provider vanished")?;
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            t.model = m;
        }
        if let Some(l) = language {
            t.language = Some(l).filter(|s| !s.is_empty() && s != "auto");
        }
        Ok(())
    })?;
    Ok(note)
}

// ── TTS ──────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    id: String,
    source: &'static str, // "server" | "custom"
    file: Option<String>,
    /// Display name when it differs from the id (ElevenLabs voice IDs are opaque).
    label: Option<String>,
    /// ElevenLabs: cloned | professional | generated | premade
    category: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicesView {
    provider: String,
    engine: String,
    current: Option<String>,
    voices_dir: Option<String>,
    voices: Vec<VoiceInfo>,
    server_error: Option<String>,
    /// Where the API key came from (cloud engines only): env | env-file | keychain | missing.
    key_source: Option<elevenlabs::KeySource>,
}

/// Every voice the TTS server reports, plus custom files in voicesDir.
/// `engine` (Part 3: the voice roster, previewing an engine the global
/// `policy.tts` isn't currently set to) picks that provider by its `engine`
/// field instead of the policy default; omit it for the old behaviour.
#[tauri::command]
pub async fn tts_voices(state: State<'_, DispatchState>, engine: Option<String>) -> Result<VoicesView, String> {
    let p = match engine.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(want) => state.snapshot().providers.into_iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() == Some(want)).ok_or_else(|| format!("no TTS provider configured for engine '{want}'"))?,
        None => tts_provider(&state)?,
    };
    let engine = p.engine.clone().unwrap_or_else(|| "kokoro".into());

    // ElevenLabs: the account's voices (cloned first), fetched live.
    if engine == "elevenlabs" {
        let (_, key_source) = elevenlabs::api_key(&state, &p);
        let (voices, server_error) = match elevenlabs::list_voices(&state, &p).await {
            Ok(v) => (
                v.into_iter().map(|v| VoiceInfo { id: v.id, source: "server", file: None, label: Some(v.name), category: Some(v.category) }).collect(),
                None,
            ),
            Err(e) => (vec![], Some(e)),
        };
        return Ok(VoicesView { provider: p.id.clone(), engine, current: p.voice.clone(), voices_dir: None, voices, server_error, key_source: Some(key_source) });
    }

    let mut voices = Vec::new();
    let mut server_error = None;

    let url = if engine == "xtts" { format!("{}/speakers_list", origin(&p.base_url)) } else { format!("{}/audio/voices", p.base_url.trim_end_matches('/')) };
    match state.http.get(url).timeout(Duration::from_secs(5)).send().await {
        Ok(r) if r.status().is_success() => {
            let v: serde_json::Value = r.json().await.map_err(short)?;
            // Kokoro: {"voices":[...]}; XTTS: [...] (strings or {name}).
            let list = v.get("voices").cloned().unwrap_or(v);
            for item in list.as_array().into_iter().flatten() {
                let id = item.as_str().map(String::from).or_else(|| item["name"].as_str().map(String::from));
                if let Some(id) = id {
                    voices.push(VoiceInfo { id, source: "server", file: None, label: None, category: None });
                }
            }
        }
        Ok(r) => server_error = Some(format!("HTTP {}", r.status().as_u16())),
        Err(e) => server_error = Some(short(e)),
    }

    let dir = voices_dir(&state, &p);
    if let Some(d) = dir.as_ref().filter(|d| d.exists()) {
        for entry in std::fs::read_dir(d).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if VOICE_EXTS.contains(&ext.as_str()) {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if !voices.iter().any(|v| v.id == stem) {
                    voices.push(VoiceInfo { id: stem, source: "custom", file: path.file_name().map(|f| f.to_string_lossy().into_owned()), label: None, category: None });
                }
            }
        }
    }
    voices.sort_by(|a, b| (a.source, &a.id).cmp(&(b.source, &b.id)));
    Ok(VoicesView {
        provider: p.id.clone(),
        engine,
        current: p.voice.clone(),
        voices_dir: dir.map(|d| d.to_string_lossy().into_owned()),
        voices,
        server_error,
        key_source: None,
    })
}

/// "Add / Load Custom Voice": raw file bytes in, header `x-filename` (+ optional `x-voice-name`).
/// ElevenLabs: instant-clones the sample and returns the new voice ID.
/// Local engines: saved into voicesDir so the TTS server (with that folder mounted) can load it.
#[tauri::command]
pub async fn tts_voice_upload(state: State<'_, DispatchState>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file bytes".into());
    };
    let p = tts_provider(&state)?;
    if p.engine.as_deref() == Some("elevenlabs") {
        let raw_name = request.headers().get("x-filename").and_then(|h| h.to_str().ok()).unwrap_or("voice.mp3");
        let file = Path::new(raw_name).file_name().and_then(|n| n.to_str()).unwrap_or("voice.mp3").to_string();
        let ext = Path::new(&file).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !CLONE_EXTS.contains(&ext.as_str()) {
            return Err(format!("ElevenLabs clones from audio: use {}", CLONE_EXTS.join(", ")));
        }
        if bytes.is_empty() || bytes.len() > MAX_CLONE_BYTES {
            return Err("voice sample must be under 11 MB (30 s – 2 min of clean speech is ideal)".into());
        }
        let name = request
            .headers()
            .get("x-voice-name")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.trim().chars().take(60).collect::<String>())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Path::new(&file).file_stem().and_then(|s| s.to_str()).unwrap_or("Custom voice").to_string());
        return elevenlabs::add_voice(&state, &p, &name, &file, bytes.to_vec()).await;
    }
    if bytes.is_empty() || bytes.len() > MAX_VOICE_BYTES {
        return Err("file empty or larger than 200 MB".into());
    }
    let raw_name = request.headers().get("x-filename").and_then(|h| h.to_str().ok()).unwrap_or("voice.wav");
    let name = Path::new(raw_name).file_name().and_then(|n| n.to_str()).unwrap_or("voice.wav");
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !VOICE_EXTS.contains(&ext.as_str()) {
        return Err(format!("unsupported voice file .{ext} (use {})", VOICE_EXTS.join(", ")));
    }
    let stem: String = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(48)
        .collect();
    let dir = voices_dir(&state, &p).ok_or("no voicesDir configured")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{stem}.{ext}")), bytes).map_err(|e| e.to_string())?;
    Ok(stem)
}

/// The roster entry to speak `agent` with: that agent's own entry, else
/// Tony's ("general"), else `None`. Only consulted when `agent` is actually
/// named — a call that never identifies a speaker (a cue clip's own voice, a
/// Settings preview) skips the roster entirely and keeps using the single
/// global `policy.tts` provider, exactly as before Part 3's roster existed.
/// `agent` is already canonicalized ("tony" → "general") by the caller.
fn roster_entry_for<'a>(agent_voices: &'a std::collections::BTreeMap<String, AgentVoice>, agent: Option<&str>) -> Option<&'a AgentVoice> {
    let agent = agent?;
    agent_voices.get(agent).or_else(|| agent_voices.get("general"))
}

/// 1–2000 *characters* (was bytes — a non-ASCII reply under the character
/// cap could still be rejected as "too long").
fn text_len_ok(s: &str) -> bool {
    (1..=2000).contains(&s.chars().count())
}

#[tauri::command]
pub async fn tts_synthesize(
    state: State<'_, DispatchState>,
    os: State<'_, super::os_core::OsState>,
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
    agent: Option<String>,
    // Part 6 §2: the sentence spoken immediately before this one in the same
    // reply, so ElevenLabs can keep prosody continuous across the
    // sentence-by-sentence calls the streaming pipeline makes. Ignored by
    // local engines (Kokoro/XTTS) and by previews/cue clips that don't pass it.
    previous_text: Option<String>,
) -> Result<Response, String> {
    use tauri::Emitter;
    let text = text.trim();
    if !text_len_ok(text) {
        return Err("text must be 1–2000 characters".into());
    }
    // `explicit` is the caller's own `voice` argument (previews, cue clips) —
    // it keeps deciding whether a failed ElevenLabs call may fall back to a
    // local engine, exactly as before the roster existed. The roster below
    // only decides WHICH provider/voice/model a plain live reply uses.
    let explicit = voice.filter(|v| !v.is_empty());

    // Part 3: per-agent voice roster — that agent's entry, else Tony's
    // ("general"), else nothing (today's single `policy.tts` provider).
    let cfg = state.snapshot();
    let role = agent.as_deref().map(canon_role);
    let roster = roster_entry_for(&cfg.agent_voices, role.as_deref()).cloned();
    let (p, roster_voice, roster_model) = match &roster {
        Some(av) => match cfg.providers.iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() == Some(av.engine.as_str())).cloned() {
            Some(b) => (b, av.voice.clone(), av.model.clone()),
            // The roster names an engine with no matching provider configured:
            // fall back to the policy provider rather than erroring the whole turn.
            None => (tts_provider(&state)?, av.voice.clone(), av.model.clone()),
        },
        None => (tts_provider(&state)?, None, None),
    };

    // Kill switch / LOCAL ONLY: never send speech text to the cloud — speak locally.
    // Only the kill switch silences ElevenLabs. LOCAL ONLY is about where the *thinking*
    // runs — taking away the user's cloned voice there was a bug (fell back to Kokoro).
    let lockdown = os.snapshot().privacy.kill_switch;
    if p.engine.as_deref() == Some("elevenlabs") && lockdown {
        let local = state.snapshot().providers.into_iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() != Some("elevenlabs")).ok_or("kill switch on and no local TTS configured")?;
        let bytes = synth_local(&state, &local, text, local.voice.clone()).await?;
        return Ok(Response::new(bytes));
    }
    if p.engine.as_deref() == Some("elevenlabs") {
        let chosen = explicit.clone().or_else(|| roster_voice.clone()).or_else(|| p.voice.clone()).ok_or("pick an ElevenLabs voice in Settings → Voice")?;
        let model = roster_model.as_deref().filter(|m| !m.is_empty());
        match elevenlabs::synthesize(&state, &p, text, &chosen, model, previous_text.as_deref()).await {
            Ok(bytes) => return Ok(Response::new(bytes)),
            // Live speech (no explicit voice = a real reply, not a preview — a roster
            // voice counts as live here): fall back to local TTS so Jarvis still talks
            // when ElevenLabs is offline or out of quota.
            Err(e) if explicit.is_none() => {
                let local = state.snapshot().providers.into_iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() != Some("elevenlabs"));
                if let Some(local) = local {
                    if let Ok(bytes) = synth_local(&state, &local, text, local.voice.clone()).await {
                        eprintln!("[tts] ElevenLabs failed ({e}); spoke with {} instead", local.label);
                        // Reported to the UI (not only stderr) so a silent voice swap
                        // is visible; best-effort — a missing listener is harmless.
                        let _ = app.emit("tts-fallback", serde_json::json!({ "from": "elevenlabs", "to": local.id, "reason": e }));
                        return Ok(Response::new(bytes));
                    }
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    }
    let bytes = synth_local(&state, &p, text, explicit.or(roster_voice)).await?;
    Ok(Response::new(bytes))
}

/// Kokoro / XTTS on this machine.
async fn synth_local(state: &DispatchState, p: &Provider, text: &str, voice: Option<String>) -> Result<Vec<u8>, String> {
    let key = state.key_for(p)?;
    let voice = voice.or_else(|| p.voice.clone()).unwrap_or_else(|| "af_bella".into());

    let mut rb = if p.engine.as_deref() == Some("xtts") {
        state.http.post(format!("{}/tts_to_audio/", origin(&p.base_url))).json(&serde_json::json!({
            "text": text,
            "speaker_wav": voice,
            "language": p.language.clone().unwrap_or_else(|| "en".into()),
        }))
    } else {
        state.http.post(format!("{}/audio/speech", p.base_url.trim_end_matches('/'))).json(&serde_json::json!({
            "model": p.model,
            "input": text,
            "voice": voice,
            "response_format": "mp3",
            "speed": 1.05,
        }))
    };
    rb = rb.timeout(Duration::from_secs(45));
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let bytes = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.bytes().await.map_err(short)?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod part3_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn av(engine: &str, voice: &str) -> AgentVoice {
        AgentVoice { engine: engine.into(), voice: Some(voice.into()), model: None, auto_speak: false }
    }

    #[test]
    fn roster_entry_prefers_the_named_agent() {
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("elevenlabs", "tony-voice"));
        m.insert("booking".into(), av("kokoro", "booking-voice"));
        let got = roster_entry_for(&m, Some("booking")).unwrap();
        assert_eq!(got.voice.as_deref(), Some("booking-voice"));
    }

    #[test]
    fn roster_entry_falls_back_to_general() {
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("elevenlabs", "tony-voice"));
        // "coder" has no entry of its own.
        let got = roster_entry_for(&m, Some("coder")).unwrap();
        assert_eq!(got.voice.as_deref(), Some("tony-voice"));
    }

    #[test]
    fn roster_entry_skips_the_roster_when_no_agent_is_named() {
        // A cue clip's own voice or a bare Settings preview never names a
        // speaker — the roster (including its "general" fallback) must not
        // kick in, so `policy.tts` keeps deciding exactly as before Part 3.
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("kokoro", "tony-voice"));
        assert!(roster_entry_for(&m, None).is_none());
    }

    #[test]
    fn roster_entry_none_when_roster_is_empty() {
        let m: BTreeMap<String, AgentVoice> = BTreeMap::new();
        assert!(roster_entry_for(&m, Some("general")).is_none());
        assert!(roster_entry_for(&m, None).is_none());
    }

    #[test]
    fn text_len_counts_characters_not_bytes() {
        // Multi-byte text that is well under 2000 *characters* but would be
        // over 2000 *bytes* at a much shorter character count — the old
        // `.len()` (byte) check could reject a short, valid reply like this.
        let s: String = "é".repeat(1999); // 1999 chars, 3998 bytes
        assert!(text_len_ok(&s));
        assert!(!text_len_ok(""));
        assert!(!text_len_ok(&"x".repeat(2001)));
        assert!(text_len_ok(&"x".repeat(2000)));
    }
}
