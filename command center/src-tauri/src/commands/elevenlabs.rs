//! ElevenLabs text-to-speech: dynamic voice loading + synthesis with the
//! voice the user picked.
//!
//! REST, no SDK (there's no official Rust one): base `https://api.elevenlabs.io`,
//! key in the `xi-api-key` header.
//!
//! The API key is read at call time, never stored in config, never sent to
//! the webview and never logged. Resolution order:
//!   1. `ELEVENLABS_API_KEY` environment variable
//!   2. `ELEVENLABS_API_KEY=` line in the project's `.env` (written by
//!      `npx @elevenlabs/cli onboard`), i.e. `<repo>/.env`
//!   3. the OS keychain entry for the `elevenlabs` provider (Settings)

use futures_util::StreamExt;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

use super::dispatch::{DispatchState, Provider};
use super::secrets;

pub const ENV_KEY: &str = "ELEVENLABS_API_KEY";

/// Models offered in Settings (from ElevenLabs' TTS docs) when the live
/// `GET /v1/models` lookup (`list_models`) fails or the key is missing.
pub const MODELS: [&str; 6] = ["eleven_v4", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_flash_v2", "eleven_multilingual_v2", "eleven_v3"];

/// v4 models (`eleven_v4`, `eleven_v4_conversational`, …) 400 outright on
/// `optimize_streaming_latency` — only the older models accept it.
fn supports_streaming_latency(model: &str) -> bool {
    !model.to_ascii_lowercase().contains("v4")
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    Env,
    EnvFile,
    Keychain,
    Missing,
}

fn from_env_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix("export ").unwrap_or(line);
        let (k, v) = rest.split_once('=')?;
        if k.trim() != ENV_KEY {
            return None;
        }
        let v = v.trim().trim_matches('"').trim_matches('\'').trim();
        (!v.is_empty()).then(|| v.to_string())
    })
}

/// The key and where it came from. Never exposed beyond this crate.
pub(crate) fn api_key(state: &DispatchState, p: &Provider) -> (Option<String>, KeySource) {
    if let Ok(v) = std::env::var(ENV_KEY) {
        if !v.trim().is_empty() {
            return (Some(v.trim().to_string()), KeySource::Env);
        }
    }
    let repo = state.snapshot().gateway.workdir;
    if let Some(v) = from_env_file(&Path::new(&repo).join(".env")) {
        return (Some(v), KeySource::EnvFile);
    }
    if let Some(v) = secrets::get(state, &p.id) {
        return (Some(v), KeySource::Keychain);
    }
    (None, KeySource::Missing)
}

pub(crate) fn valid_voice_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// ElevenLabs' REST host, pinned regardless of `p.base_url`. An env-var or
/// `.env` key (unlike the keychain, which is bound to provider@host — see
/// `api_key` above) is not scoped to a destination; `base_url` is editable
/// in Settings, so basing the request on it would let that edit redirect an
/// unscoped key to a different host. The key only ever goes to ElevenLabs.
fn base(_p: &Provider) -> String {
    "https://api.elevenlabs.io".to_string()
}

/// Turn an ElevenLabs error response into something a person can act on.
async fn explain(res: reqwest::Response) -> String {
    let code = res.status().as_u16();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    let detail = body["detail"]["message"].as_str().or(body["detail"]["status"].as_str()).or(body["detail"].as_str()).unwrap_or("").to_string();
    let hint = match code {
        401 => "ElevenLabs rejected the API key — re-run `npx -y @elevenlabs/cli@latest onboard init`",
        402 => "this voice needs a paid ElevenLabs plan (cloned and Voice Library voices aren't available to free accounts via the API)",
        404 => "voice not found on this ElevenLabs account",
        422 => "ElevenLabs rejected the request (check the voice and model)",
        429 => "ElevenLabs quota or rate limit reached",
        _ => "ElevenLabs request failed",
    };
    if detail.is_empty() {
        format!("{hint} (HTTP {code})")
    } else {
        format!("{hint} (HTTP {code}: {})", detail.chars().take(160).collect::<String>())
    }
}

#[derive(Serialize)]
pub struct ElevenVoice {
    pub id: String,
    pub name: String,
    /// cloned | professional | generated | premade | …
    pub category: String,
}

/// Every voice on the account, cloned voices first.
pub async fn list_voices(state: &DispatchState, p: &Provider) -> Result<Vec<ElevenVoice>, String> {
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let res = state
        .http
        .get(format!("{}/v1/voices", base(p)))
        .header("xi-api-key", key)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut voices: Vec<ElevenVoice> = body["voices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some(ElevenVoice {
                id: v["voice_id"].as_str()?.to_string(),
                name: v["name"].as_str().unwrap_or("(unnamed)").to_string(),
                category: v["category"].as_str().unwrap_or("premade").to_string(),
            })
        })
        .collect();
    let rank = |c: &str| match c {
        "cloned" => 0,
        "professional" => 1,
        "generated" => 2,
        _ => 3,
    };
    voices.sort_by(|a, b| rank(&a.category).cmp(&rank(&b.category)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(voices)
}

/// Text-to-speech-capable model ids from a `GET /v1/models` body. Split out
/// from `list_models` so the JSON shape is unit-testable without a network call.
pub(crate) fn tts_models_from_body(body: &serde_json::Value) -> Vec<String> {
    body.as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["can_do_text_to_speech"].as_bool().unwrap_or(false))
        .filter_map(|m| m["model_id"].as_str().map(String::from))
        .collect()
}

/// Every model the account can use for TTS, fetched live. Callers fall back
/// to the static `MODELS` list on any error (no key, offline, empty result).
pub async fn list_models(state: &DispatchState, p: &Provider) -> Result<Vec<String>, String> {
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let res = state
        .http
        .get(format!("{}/v1/models", base(p)))
        .header("xi-api-key", key)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let ids = tts_models_from_body(&body);
    if ids.is_empty() {
        return Err("ElevenLabs reported no text-to-speech models".into());
    }
    Ok(ids)
}

/// Instant voice clone: upload a sample (mp3/wav/m4a/flac/ogg) → new voice ID on the account.
pub async fn add_voice(state: &DispatchState, p: &Provider, name: &str, file_name: &str, bytes: Vec<u8>) -> Result<String, String> {
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let mime = match Path::new(file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "audio/mpeg",
    };
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name.to_string()).mime_str(mime).map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("name", name.to_string())
        .text("remove_background_noise", "true")
        .part("files", part);
    let res = state
        .http
        .post(format!("{}/v1/voices/add", base(p)))
        .header("xi-api-key", key)
        .multipart(form)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    body["voice_id"].as_str().map(String::from).ok_or_else(|| "ElevenLabs didn't return a voice ID".into())
}

/// Speak `text` with `voice_id` (mp3). The voice is always the caller's choice.
/// `model_override` (Part 3: an agent's roster model) wins over `p.model` when
/// set. `previous_text` (Part 6 §2 — the sentence spoken immediately before
/// this one in the same reply, when there is one) is passed through so
/// prosody stays continuous across the sentence-by-sentence calls the
/// streaming sentence pipeline makes, instead of each sentence sounding like
/// the start of a new thought.
///
/// Uses ElevenLabs' `/stream` endpoint (`optimize_streaming_latency=3`)
/// rather than the plain one: lower time-to-first-byte, even though the
/// bytes are still collected fully here before returning (the webview needs
/// a complete file for `decodeAudioData`) — the latency win is in how much
/// sooner ElevenLabs starts sending audio for a given sentence, not in
/// partial playback.
pub async fn synthesize(state: &DispatchState, p: &Provider, text: &str, voice_id: &str, model_override: Option<&str>, previous_text: Option<&str>) -> Result<Vec<u8>, String> {
    if !valid_voice_id(voice_id) {
        return Err(format!("'{voice_id}' isn't an ElevenLabs voice ID — pick one in Settings → Voice"));
    }
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let model = model_override.filter(|m| !m.is_empty()).unwrap_or_else(|| if p.model.is_empty() || p.model == "-" { "eleven_v4" } else { p.model.as_str() });
    let mut body = serde_json::json!({
        "text": text,
        "model_id": model,
        // Eleven v4 accepts only stability + similarity_boost.
        "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 },
    });
    if let Some(lang) = p.language.as_deref().filter(|l| !l.is_empty() && model != "eleven_multilingual_v2") {
        body["language_code"] = lang.into();
    }
    if let Some(prev) = previous_text.filter(|s| !s.trim().is_empty()) {
        // ElevenLabs caps previous_text at 1000 chars; a single sentence never
        // comes close, but keep the call safe if a caller ever passes more.
        body["previous_text"] = prev.chars().rev().take(1000).collect::<Vec<_>>().into_iter().rev().collect::<String>().into();
    }
    // v4 models (eleven_v4, eleven_v4_conversational, …) reject `optimize_streaming_latency`
    // outright with a 400 — append it only for the older models that actually support it.
    let url = if supports_streaming_latency(model) {
        format!("{}/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3", base(p))
    } else {
        format!("{}/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128", base(p))
    };
    let res = state
        .http
        .post(url)
        .header("xi-api-key", key)
        .json(&body)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let mut stream = res.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_ids() {
        assert!(valid_voice_id("QhEKgDl6KUJsO1FPiuSD"));
        assert!(!valid_voice_id("am_michael"));
        assert!(!valid_voice_id("../../v1/user"));
    }

    #[test]
    fn streaming_latency_excluded_only_for_v4_models() {
        assert!(!supports_streaming_latency("eleven_v4"));
        assert!(!supports_streaming_latency("eleven_v4_conversational"));
        assert!(!supports_streaming_latency("ELEVEN_V4"));
        assert!(supports_streaming_latency("eleven_flash_v2_5"));
        assert!(supports_streaming_latency("eleven_turbo_v2_5"));
        assert!(supports_streaming_latency("eleven_multilingual_v2"));
    }

    #[test]
    fn base_is_pinned_regardless_of_base_url() {
        let p = Provider { id: "elevenlabs".into(), label: "x".into(), kind: super::super::dispatch::Kind::Tts, base_url: "https://evil.example.com/v1".into(), model: "-".into(), needs_key: false, voice: None, engine: Some("elevenlabs".into()), language: None, models_dir: None, voices_dir: None, custom: false };
        assert_eq!(base(&p), "https://api.elevenlabs.io");
    }

    #[test]
    fn tts_models_from_body_filters_by_capability() {
        let body = serde_json::json!([
            { "model_id": "eleven_v4", "can_do_text_to_speech": true },
            { "model_id": "eleven_turbo_v2_5", "can_do_text_to_speech": true },
            { "model_id": "scribe_v1", "can_do_text_to_speech": false },
            { "model_id": "no_flag_field" },
        ]);
        assert_eq!(tts_models_from_body(&body), vec!["eleven_v4".to_string(), "eleven_turbo_v2_5".to_string()]);
    }

    #[test]
    fn tts_models_from_body_handles_non_array() {
        assert_eq!(tts_models_from_body(&serde_json::json!({"error": "nope"})), Vec::<String>::new());
    }

    #[test]
    fn env_file_parsing() {
        let dir = std::env::temp_dir().join(format!("el-env-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(".env");
        std::fs::write(&f, "# comment\nOTHER=1\nexport ELEVENLABS_API_KEY=\"sk_test_123\"\n").unwrap();
        assert_eq!(from_env_file(&f).as_deref(), Some("sk_test_123"));
        std::fs::write(&f, "ELEVENLABS_API_KEY=\n").unwrap();
        assert_eq!(from_env_file(&f), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `cargo test --lib live_tts_latency -- --ignored --nocapture` — v4 vs flash with the configured voice.
#[cfg(test)]
mod live_latency {
    use super::*;

    #[test]
    #[ignore]
    fn live_tts_latency() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let mut p = state.provider("elevenlabs").expect("elevenlabs provider");
            let voice = p.voice.clone().unwrap_or_default();
            for model in ["eleven_v4", "eleven_flash_v2_5"] {
                p.model = model.into();
                for _ in 0..2 {
                    let t0 = std::time::Instant::now();
                    let r = synthesize(&state, &p, "Yo, it's Tony. Weather's five degrees and overcast.", &voice, None, None).await;
                    println!("TTS {model}: {} ms ({})", t0.elapsed().as_millis(), r.map(|b| format!("{} KB", b.len() / 1024)).unwrap_or_else(|e| e));
                }
            }
        });
    }
}

/// `cargo test --lib live_voice_info -- --ignored --nocapture` — which models each cloned voice supports.
#[cfg(test)]
mod live_voice_info {
    use super::*;

    #[test]
    #[ignore]
    fn live_voice_info() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let p = state.provider("elevenlabs").unwrap();
            let (key, src) = api_key(&state, &p);
            println!("CONFIG voice={:?} model={} key_source={:?}", p.voice, p.model, src);
            let key = key.expect("key");
            let sub: serde_json::Value = state.http.get("https://api.elevenlabs.io/v1/user/subscription").header("xi-api-key", &key).send().await.unwrap().json().await.unwrap();
            println!("QUOTA tier={} used={} limit={} resets={}", sub["tier"], sub["character_count"], sub["character_limit"], sub["next_character_count_reset_unix"]);
            let v: serde_json::Value = state.http.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", &key).send().await.unwrap().json().await.unwrap();
            for vc in v["voices"].as_array().unwrap().iter().filter(|x| x["category"] != "premade") {
                println!(
                    "VOICE {} | {} | category={} | hq_models={} | fine_tuning={}",
                    vc["voice_id"].as_str().unwrap_or(""),
                    vc["name"].as_str().unwrap_or(""),
                    vc["category"],
                    vc["high_quality_base_model_ids"],
                    vc["fine_tuning"]["state"]
                );
            }
        });
    }
}
