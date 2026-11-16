//! Provider configuration + LLM routing.
//!
//! The webview sends `{messages, priority, provider?, maxSecs?}`; Rust decides
//! WHERE it runs, injects the API key from the keychain, and reports what
//! happened.
//!
//! Chat policy:
//!   * interactive  → local first, cloud on local failure/timeout
//!   * background   → cloud straight away when the GPU is over threshold,
//!                    otherwise local first like interactive
//!   * explicit `provider` → that provider only (used for the verifier)
//!
//! Every endpoint (chat, verifier, Whisper STT, Kokoro TTS, n8n) comes from
//! `<app-config>/providers.json`, written with defaults on first run and
//! merged with new defaults on upgrade. It is deliberately NOT editable from
//! the webview.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use tauri::State;

use super::{secrets, system};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// OpenAI-compatible chat on this machine (LM Studio, AnythingLLM, llama.cpp).
    Local,
    /// OpenAI-compatible chat elsewhere (droplet over NetBird, OpenRouter, …).
    Cloud,
    /// Agentic OS server.py `/api/chat`.
    AgenticOs,
    /// OpenAI-compatible `/audio/transcriptions` (whisper.cpp server, speaches).
    Stt,
    /// OpenAI-compatible `/audio/speech` (Kokoro-FastAPI).
    Tts,
    /// n8n base URL; workflows map names → webhook paths.
    N8n,
}

impl Kind {
    pub fn is_chat(self) -> bool {
        matches!(self, Kind::Local | Kind::Cloud | Kind::AgenticOs)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub base_url: String,
    pub model: String,
    pub needs_key: bool,
    /// TTS voice id (Kokoro: e.g. "af_bella", "am_michael").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// Background work moves to cloud when GPU utilisation is above this…
    pub gpu_util_max: f32,
    /// …or VRAM use is above this percentage.
    pub vram_max_pct: f32,
    pub primary_local: String,
    pub fallback_cloud: String,
    /// Cross-checks mutating plans against the user's words (hallucination guard).
    #[serde(default = "default_verifier")]
    pub verifier: String,
    #[serde(default = "default_stt")]
    pub stt: String,
    #[serde(default = "default_tts")]
    pub tts: String,
    pub local_timeout_secs: u64,
    pub cloud_timeout_secs: u64,
}

fn default_verifier() -> String {
    "verifier".into()
}
fn default_stt() -> String {
    "whisper".into()
}
fn default_tts() -> String {
    "kokoro".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub providers: Vec<Provider>,
    pub policy: Policy,
    /// Named n8n workflows the orchestrator may trigger: name → webhook path
    /// under the `n8n` provider's baseUrl. Only these names can ever be called.
    #[serde(default)]
    pub n8n_workflows: BTreeMap<String, String>,
}

impl Default for Config {
    fn default() -> Self {
        let p = |id: &str, label: &str, kind, base_url: &str, model: &str, needs_key| Provider {
            id: id.into(),
            label: label.into(),
            kind,
            base_url: base_url.into(),
            model: model.into(),
            needs_key,
            voice: None,
        };
        let mut kokoro = p("kokoro", "Kokoro TTS", Kind::Tts, "http://127.0.0.1:8880/v1", "kokoro", false);
        kokoro.voice = Some("am_michael".into());
        Self {
            providers: vec![
                // Heavy lifting: your local (uncensored) model in LM Studio.
                p("lmstudio", "LM Studio", Kind::Local, "http://127.0.0.1:1234/v1", "local-model", false),
                p("anythingllm", "AnythingLLM RAG", Kind::Local, "http://127.0.0.1:3001/api/v1/openai", "my-workspace", true),
                // Reach the droplet over NetBird; replace with its 100.x address.
                p("droplet", "Cloud Droplet", Kind::Cloud, "http://100.64.0.10:8000/v1", "deepseek-r1-distill", true),
                // Verified account that double-checks mutating plans.
                p("verifier", "Verifier (cloud account)", Kind::Cloud, "https://openrouter.ai/api/v1", "openrouter/auto", true),
                p("agentic-os", "Agentic OS (opencode)", Kind::AgenticOs, "http://127.0.0.1:8080", "opencode", false),
                // whisper.cpp: `whisper-server -m ggml-base.en.bin --port 8178 --inference-path /v1/audio/transcriptions`
                p("whisper", "Whisper STT", Kind::Stt, "http://127.0.0.1:8178/v1", "whisper-1", false),
                kokoro,
                p("n8n", "n8n", Kind::N8n, "http://127.0.0.1:5678", "-", false),
            ],
            policy: Policy {
                gpu_util_max: 85.0,
                vram_max_pct: 90.0,
                primary_local: "lmstudio".into(),
                fallback_cloud: "droplet".into(),
                verifier: default_verifier(),
                stt: default_stt(),
                tts: default_tts(),
                local_timeout_secs: 90,
                cloud_timeout_secs: 120,
            },
            n8n_workflows: BTreeMap::new(),
        }
    }
}

pub struct DispatchState {
    config: RwLock<Config>,
    pub(crate) http: reqwest::Client,
}

impl Default for DispatchState {
    fn default() -> Self {
        Self {
            config: RwLock::new(Config::default()),
            http: reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).build().expect("http client"),
        }
    }
}

impl DispatchState {
    /// Load `providers.json`, writing defaults if missing and appending any new
    /// default providers on upgrade. Invalid files are reported and ignored
    /// (defaults stay active) rather than crashing the app.
    pub fn load_or_init(&self, dir: &Path) {
        let path = dir.join("providers.json");
        let defaults = Config::default();
        let cfg = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Config>(&text) {
                Ok(mut cfg) if config_valid(&cfg) => {
                    for d in &defaults.providers {
                        if !cfg.providers.iter().any(|p| p.id == d.id) {
                            cfg.providers.push(d.clone());
                        }
                    }
                    cfg
                }
                Ok(_) => {
                    eprintln!("[dispatch] {} has an invalid URL — using defaults", path.display());
                    return;
                }
                Err(e) => {
                    eprintln!("[dispatch] {} unreadable ({e}) — using defaults", path.display());
                    return;
                }
            },
            Err(_) => defaults,
        };
        let _ = std::fs::create_dir_all(dir);
        if let Err(e) = std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap()) {
            eprintln!("[dispatch] could not write {}: {e}", path.display());
        }
        *self.config.write().unwrap() = cfg;
    }

    pub(crate) fn snapshot(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    pub(crate) fn provider(&self, id: &str) -> Option<Provider> {
        self.config.read().ok()?.providers.iter().find(|p| p.id == id).cloned()
    }

    /// `host[:port]` of a provider — used to bind keychain entries to a destination.
    pub fn provider_host(&self, id: &str) -> Option<String> {
        let p = self.provider(id)?;
        let u = url::Url::parse(&p.base_url).ok()?;
        Some(match u.port() {
            Some(port) => format!("{}:{port}", u.host_str()?),
            None => u.host_str()?.to_string(),
        })
    }

    /// Bearer key for a provider, if it needs one.
    pub(crate) fn key_for(&self, p: &Provider) -> Result<Option<String>, String> {
        if !p.needs_key {
            return Ok(None);
        }
        secrets::get(self, &p.id).map(Some).ok_or_else(|| format!("no API key stored for {}", p.label))
    }
}

fn valid_url(s: &str) -> bool {
    url::Url::parse(s).map(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some()).unwrap_or(false)
}

fn config_valid(cfg: &Config) -> bool {
    cfg.providers.iter().all(|p| valid_url(&p.base_url))
        && cfg.n8n_workflows.values().all(|path| !path.contains("://") && !path.contains(".."))
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    #[serde(flatten)]
    provider: Provider,
    has_key: bool,
}

#[tauri::command]
pub fn providers_list(state: State<'_, DispatchState>) -> Vec<ProviderInfo> {
    state
        .snapshot()
        .providers
        .into_iter()
        .map(|p| {
            let has_key = p.needs_key && secrets::get(&state, &p.id).is_some();
            ProviderInfo { provider: p, has_key }
        })
        .collect()
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Interactive,
    Background,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    messages: Vec<ChatMessage>,
    priority: Priority,
    provider: Option<String>,
    /// Per-request cap (e.g. the planner wants an answer in ~12 s or falls back).
    max_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    provider_id: String,
    content: String,
    fell_back: bool,
    reason: String,
    latency_ms: u128,
}

#[tauri::command]
pub async fn dispatch_chat(state: State<'_, DispatchState>, req: DispatchRequest) -> Result<DispatchResult, String> {
    if req.messages.is_empty() || req.messages.len() > 64 {
        return Err("1–64 messages required".into());
    }
    let cfg = state.snapshot();
    let find = |id: &str| cfg.providers.iter().find(|p| p.id == id && p.kind.is_chat()).cloned();

    let (plan, reason): (Vec<Provider>, String) = if let Some(id) = &req.provider {
        // "verifier" is an alias for whatever the policy names.
        let id = if id == "verifier" { cfg.policy.verifier.as_str() } else { id.as_str() };
        (vec![find(id).ok_or("unknown chat provider")?], format!("pinned to {id}"))
    } else {
        let local = find(&cfg.policy.primary_local);
        let cloud = find(&cfg.policy.fallback_cloud);
        let busy = if req.priority == Priority::Background { gpu_busy(&cfg.policy).await } else { None };
        match busy {
            Some(why) => (cloud.into_iter().collect(), format!("background + {why} → cloud")),
            None => (local.into_iter().chain(cloud).collect(), "local first".into()),
        }
    };
    if plan.is_empty() {
        return Err("no providers configured — edit providers.json".into());
    }

    let mut errors = Vec::new();
    for (i, p) in plan.iter().enumerate() {
        let started = Instant::now();
        match call(&state, &cfg.policy, p, &req.messages, req.max_secs).await {
            Ok(content) => {
                return Ok(DispatchResult {
                    provider_id: p.id.clone(),
                    content,
                    fell_back: i > 0,
                    reason: if i > 0 { format!("{} failed ({}) → {}", plan[0].id, errors.join("; "), p.id) } else { reason },
                    latency_ms: started.elapsed().as_millis(),
                })
            }
            Err(e) => errors.push(format!("{}: {e}", p.id)),
        }
    }
    Err(format!("all providers failed — {}", errors.join(" | ")))
}

async fn gpu_busy(policy: &Policy) -> Option<String> {
    let gpu = tauri::async_runtime::spawn_blocking(system::query_gpu).await.ok().flatten()?;
    let vram_pct = gpu.vram_used_mb as f32 / gpu.vram_total_mb.max(1) as f32 * 100.0;
    if gpu.util_pct > policy.gpu_util_max {
        Some(format!("GPU {:.0}%", gpu.util_pct))
    } else if vram_pct > policy.vram_max_pct {
        Some(format!("VRAM {vram_pct:.0}%"))
    } else {
        None
    }
}

async fn call(state: &DispatchState, policy: &Policy, p: &Provider, messages: &[ChatMessage], max_secs: Option<u64>) -> Result<String, String> {
    let base_timeout = if p.kind == Kind::Cloud { policy.cloud_timeout_secs } else { policy.local_timeout_secs };
    let timeout = Duration::from_secs(max_secs.map_or(base_timeout, |m| m.clamp(3, base_timeout)));
    let base = p.base_url.trim_end_matches('/');

    if p.kind == Kind::AgenticOs {
        // server.py: POST /api/chat {agent, message} → {status, response: {content}}
        let last = messages.iter().rev().find(|m| m.role == "user").map(|m| m.content.clone()).unwrap_or_default();
        let res = state
            .http
            .post(format!("{base}/api/chat"))
            .timeout(timeout)
            .json(&serde_json::json!({ "agent": p.model, "message": last }))
            .send()
            .await
            .map_err(short)?;
        let body: serde_json::Value = res.error_for_status().map_err(short)?.json().await.map_err(short)?;
        return body["response"]["content"].as_str().map(str::to_owned).ok_or_else(|| "malformed gateway reply".into());
    }

    // OpenAI-compatible /chat/completions (LM Studio, AnythingLLM, vLLM, Ollama, OpenRouter).
    let mut rb = state
        .http
        .post(format!("{base}/chat/completions"))
        .timeout(timeout)
        .json(&serde_json::json!({ "model": p.model, "messages": messages, "stream": false }));
    if let Some(key) = state.key_for(p)? {
        rb = rb.bearer_auth(key);
    }
    let res = rb.send().await.map_err(short)?;
    let body: serde_json::Value = res.error_for_status().map_err(short)?.json().await.map_err(short)?;
    body["choices"][0]["message"]["content"].as_str().map(str::to_owned).ok_or_else(|| "malformed completion".into())
}

/// Error text without the URL (keeps internal addresses out of the UI log).
pub(crate) fn short(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "unreachable".into()
    } else if let Some(s) = e.status() {
        format!("HTTP {s}")
    } else {
        e.without_url().to_string()
    }
}
