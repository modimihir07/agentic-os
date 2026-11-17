//! Provider configuration + LLM routing.
//!
//! The webview sends `{messages, priority, provider?, maxSecs?}`; Rust decides
//! WHERE it runs, injects the API key from the keychain, and reports what
//! happened.
//!
//! Chat policy:
//!   * interactive  → walk `policy.chain` in order (default: LM Studio →
//!                    AnythingLLM → Agentic OS → droplet) until one answers
//!   * background   → if the GPU is over threshold, skip local entries
//!   * explicit `provider` → that provider only (used for the verifier)
//!
//! Every endpoint comes from `<app-config>/providers.json`. Settings may switch
//! models, voices, base URLs and the chain at runtime. That is safe because
//! API keys are bound to their provider's host (see secrets.rs): re-pointing
//! a provider can never send its key somewhere new. Spawning the gateway is
//! file-only (see services.rs).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};
use tauri::State;

use super::os_core::{self, OsState};
use super::{secrets, system};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// OpenAI-compatible chat on this machine / LAN (LM Studio, AnythingLLM, llama.cpp, Ollama).
    Local,
    /// OpenAI-compatible chat elsewhere (droplet over NetBird, hosted APIs).
    Cloud,
    /// Agentic OS server.py `/api/chat` (opencode / hermes / agy).
    AgenticOs,
    /// OpenAI-compatible `/audio/transcriptions` (whisper.cpp server, speaches).
    Stt,
    /// Text-to-speech (Kokoro-FastAPI or Coqui XTTS api-server).
    Tts,
    /// n8n base URL; workflows map names → webhook paths.
    N8n,
    /// Credentials-only integrations (e.g. Google OAuth client). Never called for chat.
    Integration,
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
    /// TTS voice id (Kokoro "am_michael", XTTS speaker file stem).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    /// STT: "whispercpp" | "openai" (speaches / faster-whisper). TTS: "kokoro" | "xtts".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// STT language code ("en", "fr", …) or None for auto-detect. TTS language for XTTS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// STT (whisper.cpp): folder holding ggml-<variant>.bin for hot model switching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_dir: Option<String>,
    /// TTS: folder for custom voices (mount it into Kokoro / XTTS — see HANDOFF.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voices_dir: Option<String>,
    /// Added from Settings (removable there). Built-ins are not.
    #[serde(default)]
    pub custom: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// Background work skips local providers when GPU utilisation is above this…
    pub gpu_util_max: f32,
    /// …or VRAM use is above this percentage.
    pub vram_max_pct: f32,
    pub primary_local: String,
    pub fallback_cloud: String,
    /// Ordered failover for chat. Empty = [primaryLocal, fallbackCloud].
    #[serde(default)]
    pub chain: Vec<String>,
    /// Cross-checks mutating plans against the user's words (runs locally by default).
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

/// An n8n workflow the orchestrator may call. `mutating: false` workflows
/// (e.g. "calendar-upcoming", "gmail-digest") can be read by widgets without a
/// confirmation; anything else only runs after the human approves.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum WorkflowSpec {
    Path(String),
    Full {
        path: String,
        #[serde(default = "yes")]
        mutating: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

fn yes() -> bool {
    true
}

impl WorkflowSpec {
    pub fn path(&self) -> &str {
        match self {
            WorkflowSpec::Path(p) => p,
            WorkflowSpec::Full { path, .. } => path,
        }
    }
    pub fn mutating(&self) -> bool {
        match self {
            WorkflowSpec::Path(_) => true,
            WorkflowSpec::Full { mutating, .. } => *mutating,
        }
    }
}

/// How the desktop app keeps the Agentic OS gateway (server.py) alive.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    pub url: String,
    pub autostart: bool,
    pub workdir: String,
    pub command: String,
    pub args: Vec<String>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        // At build time this crate lives in "<repo>/command center/src-tauri", so the repo is two up.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent).map(PathBuf::from).unwrap_or_default();
        Self {
            url: "http://127.0.0.1:8080".into(),
            autostart: true,
            workdir: repo.to_string_lossy().into_owned(),
            command: "python".into(),
            args: vec!["server.py".into(), "--port".into(), "8080".into()],
        }
    }
}

/// n8n session telemetry + Google Drive backup. n8n *instances* are simply the
/// providers of kind `n8n` (local Docker + any remote droplets), so they share
/// host-bound keychain storage with everything else.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelinesConfig {
    /// POLL_INTERVAL_SECONDS
    #[serde(default = "default_poll")]
    pub poll_interval_seconds: u64,
    /// GDRIVE_SYNC_WEBHOOK_URL — an n8n webhook whose workflow writes to Google Drive.
    #[serde(default)]
    pub gdrive_sync_webhook_url: String,
    /// GDRIVE_TRACKED_PATHS — folders/files to back up. "@os-config" = this
    /// app's config files (providers.json, permissions.json, gateway config).
    #[serde(default = "default_tracked")]
    pub gdrive_tracked_paths: Vec<String>,
    /// AUTO_SYNC_ENABLED
    #[serde(default)]
    pub auto_sync_enabled: bool,
    #[serde(default = "default_auto_hours")]
    pub auto_sync_hours: f64,
    /// Also sync when the app closes cleanly (only if auto-sync is on).
    #[serde(default = "yes")]
    pub sync_on_exit: bool,
}

fn default_poll() -> u64 {
    15
}
fn default_auto_hours() -> f64 {
    6.0
}
fn default_tracked() -> Vec<String> {
    let repo = GatewayConfig::default().workdir;
    vec![
        Path::new(&repo).join("training_logs").to_string_lossy().into_owned(),
        Path::new(&repo).join("memory").to_string_lossy().into_owned(),
        "@os-config".into(),
    ]
}

impl Default for PipelinesConfig {
    fn default() -> Self {
        Self {
            poll_interval_seconds: default_poll(),
            gdrive_sync_webhook_url: String::new(),
            gdrive_tracked_paths: default_tracked(),
            auto_sync_enabled: false,
            auto_sync_hours: default_auto_hours(),
            sync_on_exit: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub providers: Vec<Provider>,
    pub policy: Policy,
    /// Named n8n workflows: name → webhook path (or {path, mutating, description})
    /// under the `n8n` provider's baseUrl. Only these names can ever be called.
    #[serde(default)]
    pub n8n_workflows: BTreeMap<String, WorkflowSpec>,
    #[serde(default)]
    pub gateway: GatewayConfig,
    #[serde(default)]
    pub pipelines: PipelinesConfig,
}

fn p(id: &str, label: &str, kind: Kind, base_url: &str, model: &str, needs_key: bool) -> Provider {
    Provider {
        id: id.into(),
        label: label.into(),
        kind,
        base_url: base_url.into(),
        model: model.into(),
        needs_key,
        voice: None,
        engine: None,
        language: None,
        models_dir: None,
        voices_dir: None,
        custom: false,
    }
}

impl Default for Config {
    fn default() -> Self {
        let mut kokoro = p("kokoro", "Kokoro TTS", Kind::Tts, "http://127.0.0.1:8880/v1", "kokoro", false);
        kokoro.voice = Some("am_michael".into());
        kokoro.engine = Some("kokoro".into());
        // ElevenLabs cloud TTS. Key comes from ELEVENLABS_API_KEY / the project .env / keychain
        // (see elevenlabs.rs); the voice is whichever account voice is picked in Settings.
        let mut eleven = p("elevenlabs", "ElevenLabs", Kind::Tts, "https://api.elevenlabs.io/v1", "eleven_v4", false);
        eleven.engine = Some("elevenlabs".into());
        eleven.voice = Some("QhEKgDl6KUJsO1FPiuSD".into());
        let mut whisper = p("whisper", "Whisper STT", Kind::Stt, "http://127.0.0.1:8178/v1", "base.en", false);
        whisper.engine = Some("whispercpp".into());
        whisper.language = Some("en".into());
        Self {
            providers: vec![
                // Heavy lifting: your local (uncensored) model in LM Studio.
                p("lmstudio", "LM Studio", Kind::Local, "http://127.0.0.1:1234/v1", "local-model", false),
                p("anythingllm", "AnythingLLM RAG", Kind::Local, "http://127.0.0.1:3001/api/v1/openai", "my-workspace", true),
                // Reach the droplet over NetBird; replace with its 100.x address.
                p("droplet", "Cloud Droplet", Kind::Cloud, "http://100.64.0.10:8000/v1", "deepseek-r1-distill", true),
                // Zero-cost verifier on LM Studio. Load a DIFFERENT model than the planner
                // for an independent second opinion, then pick it in Settings.
                p("verifier", "Verifier (local LM Studio)", Kind::Local, "http://127.0.0.1:1234/v1", "local-model", false),
                p("agentic-os", "Agentic OS (opencode)", Kind::AgenticOs, "http://127.0.0.1:8080", "opencode", false),
                // whisper.cpp: `whisper-server -m ggml-base.en.bin --port 8178 --inference-path /v1/audio/transcriptions`
                whisper,
                kokoro,
                eleven,
                // Bound to the local Docker container on first run (see n8n_discover).
                p("n8n", "n8n (Docker)", Kind::N8n, "http://127.0.0.1:5678", "-", false),
                p("google", "Google (Gmail + Calendar)", Kind::Integration, "https://oauth2.googleapis.com", "-", true),
            ],
            policy: Policy {
                gpu_util_max: 85.0,
                vram_max_pct: 90.0,
                primary_local: "lmstudio".into(),
                fallback_cloud: "droplet".into(),
                chain: vec!["lmstudio".into(), "anythingllm".into(), "agentic-os".into(), "droplet".into()],
                verifier: default_verifier(),
                stt: default_stt(),
                tts: default_tts(),
                local_timeout_secs: 90,
                cloud_timeout_secs: 120,
            },
            n8n_workflows: BTreeMap::new(),
            gateway: GatewayConfig::default(),
            pipelines: PipelinesConfig::default(),
        }
    }
}

pub struct DispatchState {
    config: RwLock<Config>,
    path: RwLock<Option<PathBuf>>,
    pub(crate) http: reqwest::Client,
}

impl Default for DispatchState {
    fn default() -> Self {
        Self {
            config: RwLock::new(Config::default()),
            path: RwLock::new(None),
            // Long-lived pooled connections: the first TLS handshake to ElevenLabs/Claude costs
            // ~1 s, so keep sockets alive between turns (the TTS warm loop pings every 60 s).
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(4))
                .pool_idle_timeout(Duration::from_secs(300))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .expect("http client"),
        }
    }
}

impl DispatchState {
    /// Load `providers.json`, writing defaults if missing and appending any new
    /// default providers on upgrade. Invalid files are reported and ignored
    /// (defaults stay active) rather than crashing the app.
    pub fn load_or_init(&self, dir: &Path) {
        let path = dir.join("providers.json");
        *self.path.write().unwrap() = Some(path.clone());
        let defaults = Config::default();
        let cfg = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Config>(&text) {
                Ok(mut cfg) if validate(&cfg).is_ok() => {
                    for d in &defaults.providers {
                        if !cfg.providers.iter().any(|p| p.id == d.id) {
                            cfg.providers.push(d.clone());
                        }
                    }
                    if cfg.policy.chain.is_empty() {
                        cfg.policy.chain = vec![cfg.policy.primary_local.clone(), cfg.policy.fallback_cloud.clone()];
                    }
                    cfg
                }
                Ok(c) => {
                    eprintln!("[dispatch] {} invalid ({}) — using defaults", path.display(), validate(&c).unwrap_err());
                    return;
                }
                Err(e) => {
                    eprintln!("[dispatch] {} unreadable ({e}) — using defaults", path.display());
                    return;
                }
            },
            Err(_) => defaults,
        };
        *self.config.write().unwrap() = cfg;
        if let Err(e) = self.persist() {
            eprintln!("[dispatch] {e}");
        }
    }

    pub(crate) fn snapshot(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    /// Apply a change, validate the result, and write providers.json. All-or-nothing.
    pub(crate) fn update(&self, f: impl FnOnce(&mut Config) -> Result<(), String>) -> Result<Config, String> {
        let mut next = self.snapshot();
        f(&mut next)?;
        validate(&next)?;
        *self.config.write().unwrap() = next.clone();
        self.persist()?;
        Ok(next)
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = self.path.read().unwrap().clone() else { return Ok(()) };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let json = serde_json::to_string_pretty(&*self.config.read().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))
    }

    pub(crate) fn config_dir(&self) -> Option<PathBuf> {
        self.path.read().unwrap().as_ref().and_then(|p| p.parent().map(PathBuf::from))
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

pub(crate) fn valid_url(s: &str) -> bool {
    url::Url::parse(s).map(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some()).unwrap_or(false)
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn validate(cfg: &Config) -> Result<(), String> {
    for p in &cfg.providers {
        if !valid_id(&p.id) {
            return Err(format!("bad provider id '{}'", p.id));
        }
        if !valid_url(&p.base_url) {
            return Err(format!("{}: baseUrl must be http(s)", p.id));
        }
    }
    let kind_of = |id: &str| cfg.providers.iter().find(|p| p.id == id).map(|p| p.kind);
    const EXT: [&str; 4] = ["ext:claude-cli", "ext:claude-api", "ext:gemini-cli", "ext:gemini-api"];
    for id in cfg.policy.chain.iter().chain([&cfg.policy.verifier]) {
        if id == &cfg.policy.verifier && EXT.contains(&id.as_str()) {
            continue;
        }
        if !kind_of(id).is_some_and(Kind::is_chat) {
            return Err(format!("'{id}' is not a chat provider"));
        }
    }
    if kind_of(&cfg.policy.stt).is_some_and(|k| k != Kind::Stt) || kind_of(&cfg.policy.tts).is_some_and(|k| k != Kind::Tts) {
        return Err("policy.stt / policy.tts must name STT / TTS providers".into());
    }
    for (name, wf) in &cfg.n8n_workflows {
        if !valid_id(name) || wf.path().contains("://") || wf.path().contains("..") {
            return Err(format!("bad n8n workflow '{name}'"));
        }
    }
    let pl = &cfg.pipelines;
    if !pl.gdrive_sync_webhook_url.is_empty() && !valid_url(&pl.gdrive_sync_webhook_url) {
        return Err("Drive sync webhook must be an http(s) URL".into());
    }
    if !(5..=3600).contains(&pl.poll_interval_seconds) || !(0.25..=168.0).contains(&pl.auto_sync_hours) || pl.gdrive_tracked_paths.len() > 32 {
        return Err("poll 5–3600 s, auto-sync 0.25–168 h, at most 32 tracked paths".into());
    }
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    #[serde(flatten)]
    provider: Provider,
    has_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersView {
    providers: Vec<ProviderInfo>,
    policy: Policy,
}

fn view(state: &DispatchState, cfg: Config) -> ProvidersView {
    ProvidersView {
        providers: cfg
            .providers
            .into_iter()
            .map(|p| {
                let has_key = p.needs_key && secrets::get(state, &p.id).is_some();
                ProviderInfo { provider: p, has_key }
            })
            .collect(),
        policy: cfg.policy,
    }
}

#[tauri::command]
pub fn providers_list(state: State<'_, DispatchState>) -> ProvidersView {
    view(&state, state.snapshot())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPatch {
    id: String,
    label: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    language: Option<String>,
    engine: Option<String>,
    models_dir: Option<String>,
    voices_dir: Option<String>,
}

/// Switch model / voice / URL etc. for one provider (Settings dropdowns).
#[tauri::command]
pub fn providers_update(state: State<'_, DispatchState>, patch: ProviderPatch) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        let p = cfg.providers.iter_mut().find(|p| p.id == patch.id).ok_or("unknown provider")?;
        let short = |s: String, n: usize| s.trim().chars().take(n).collect::<String>();
        if let Some(v) = patch.label {
            p.label = short(v, 60);
        }
        if let Some(v) = patch.base_url {
            p.base_url = v.trim().trim_end_matches('/').to_string();
        }
        if let Some(v) = patch.model {
            p.model = short(v, 200);
        }
        if let Some(v) = patch.voice {
            p.voice = Some(short(v, 120)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.language {
            p.language = Some(short(v, 12)).filter(|s| !s.is_empty() && s != "auto");
        }
        if let Some(v) = patch.engine {
            p.engine = Some(short(v, 24)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.models_dir {
            p.models_dir = Some(short(v, 400)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.voices_dir {
            p.voices_dir = Some(short(v, 400)).filter(|s| !s.is_empty());
        }
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProvider {
    id: String,
    label: String,
    kind: Kind,
    base_url: String,
    model: String,
    needs_key: bool,
}

/// Add a custom chat endpoint (e.g. Ollama, llama.cpp, vLLM on the LAN).
#[tauri::command]
pub fn provider_add(state: State<'_, DispatchState>, provider: NewProvider) -> Result<ProvidersView, String> {
    if !provider.kind.is_chat() {
        return Err("custom providers must be chat endpoints".into());
    }
    let cfg = state.update(|cfg| {
        if cfg.providers.iter().any(|p| p.id == provider.id) {
            return Err("that id already exists".into());
        }
        let mut np = p(&provider.id, &provider.label, provider.kind, provider.base_url.trim_end_matches('/'), &provider.model, provider.needs_key);
        np.custom = true;
        cfg.providers.push(np);
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[tauri::command]
pub fn provider_remove(state: State<'_, DispatchState>, id: String) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        let idx = cfg.providers.iter().position(|p| p.id == id).ok_or("unknown provider")?;
        if !cfg.providers[idx].custom {
            return Err("built-in providers can't be removed".into());
        }
        cfg.providers.remove(idx);
        cfg.policy.chain.retain(|c| c != &id);
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPatch {
    chain: Option<Vec<String>>,
    verifier: Option<String>,
    stt: Option<String>,
    tts: Option<String>,
    gpu_util_max: Option<f32>,
    vram_max_pct: Option<f32>,
}

/// Orchestrator switcher: reorder the failover chain, pick the verifier, STT and TTS.
#[tauri::command]
pub fn policy_update(state: State<'_, DispatchState>, patch: PolicyPatch) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        if let Some(chain) = patch.chain {
            if chain.is_empty() || chain.len() > 8 {
                return Err("chain needs 1–8 providers".into());
            }
            cfg.policy.primary_local = chain[0].clone();
            cfg.policy.chain = chain;
        }
        if let Some(v) = patch.verifier {
            cfg.policy.verifier = v;
        }
        if let Some(v) = patch.stt {
            cfg.policy.stt = v;
        }
        if let Some(v) = patch.tts {
            cfg.policy.tts = v;
        }
        if let Some(v) = patch.gpu_util_max {
            cfg.policy.gpu_util_max = v.clamp(10.0, 100.0);
        }
        if let Some(v) = patch.vram_max_pct {
            cfg.policy.vram_max_pct = v.clamp(10.0, 100.0);
        }
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ChatMessage {
    pub(crate) role: String,
    pub(crate) content: String,
}

impl ChatMessage {
    pub(crate) fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into() }
    }
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub(crate) provider_id: String,
    pub(crate) content: String,
    pub(crate) fell_back: bool,
    pub(crate) reason: String,
    pub(crate) latency_ms: u128,
    /// The prompt left this machine through the privacy diffuser.
    pub(crate) redacted: bool,
}

#[tauri::command]
pub async fn dispatch_chat(state: State<'_, DispatchState>, os: State<'_, OsState>, req: DispatchRequest) -> Result<DispatchResult, String> {
    run_chat(&state, &os, req.messages, req.priority, req.provider, req.max_secs).await
}

/// The chat chain, shared by `dispatch_chat`, the OS orchestrator and memory
/// condensation. Applies compute mode (local / hybrid / cloud), the droplet
/// switch, the kill switch, and the privacy diffuser for anything remote.
pub(crate) async fn run_chat(
    state: &DispatchState,
    os: &OsState,
    messages: Vec<ChatMessage>,
    priority: Priority,
    provider: Option<String>,
    max_secs: Option<u64>,
) -> Result<DispatchResult, String> {
    if messages.is_empty() || messages.len() > 64 {
        return Err("1–64 messages required".into());
    }
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let find = |id: &str| cfg.providers.iter().find(|p| p.id == id && p.kind.is_chat()).cloned();

    // External verifier / overseer engines ("ext:claude-cli" …).
    if let Some(id) = &provider {
        let id = if id == "verifier" { cfg.policy.verifier.as_str() } else { id.as_str() };
        if let Some(engine) = id.strip_prefix("ext:") {
            let started = Instant::now();
            let (content, redacted) = super::agents::external_chat(state, os, engine, &messages, max_secs.unwrap_or(120)).await?;
            return Ok(DispatchResult {
                provider_id: format!("ext:{engine}"),
                content,
                fell_back: false,
                reason: "external engine".into(),
                latency_ms: started.elapsed().as_millis(),
                redacted,
            });
        }
    }

    let chars: usize = messages.iter().map(|m| m.content.len()).sum();
    let (plan, mut reason): (Vec<Provider>, String) = if let Some(id) = &provider {
        // "verifier" is an alias for whatever the policy names.
        let id = if id == "verifier" { cfg.policy.verifier.as_str() } else { id.as_str() };
        let p = find(id).ok_or("unknown chat provider")?;
        let (shaped, notes) = os_core::shape_chain(&osc, vec![p], None, chars, true);
        if shaped.is_empty() {
            return Err(format!("{id} is blocked: {}", notes.join(", ")));
        }
        (shaped, format!("pinned to {id}"))
    } else {
        let chain: Vec<Provider> = cfg.policy.chain.iter().filter_map(|id| find(id)).collect();
        let busy = if priority == Priority::Background { gpu_busy(&cfg.policy).await } else { None };
        let chain: Vec<Provider> = match &busy {
            Some(_) if chain.iter().any(|p| p.kind != Kind::Local) => chain.into_iter().filter(|p| p.kind != Kind::Local).collect(),
            _ => chain,
        };
        let vram = if osc.compute.mode == os_core::ComputeMode::Hybrid { os_core::vram_pct().await } else { None };
        let (shaped, notes) = os_core::shape_chain(&osc, chain, vram, chars, false);
        let mut r = busy.map(|w| format!("background + {w} → off-GPU")).unwrap_or_else(|| "chain".into());
        if !notes.is_empty() {
            r = format!("{r} · {}", notes.join(", "));
        }
        (shaped, r)
    };
    if plan.is_empty() {
        return Err(format!("no reachable providers — {reason}"));
    }

    let mut errors = Vec::new();
    for (i, p) in plan.iter().enumerate() {
        let started = Instant::now();
        let diffuse = os_core::is_remote(p) && osc.privacy.diffuser;
        let mut redactor = super::privacy::Redactor::default();
        let outbound: Vec<ChatMessage> = if diffuse {
            messages.iter().map(|m| ChatMessage::new(&m.role, redactor.redact(&m.content, &osc.privacy.sensitive_terms))).collect()
        } else {
            messages.clone()
        };
        if diffuse {
            os.record_redaction(&p.id, serde_json::to_value(&outbound).unwrap_or_default(), redactor.replacements.clone());
        }
        // Local GPU generations take the baton; Tony (interactive) goes first.
        let _slot = if !os_core::is_remote(p) && p.kind != Kind::AgenticOs {
            Some(os.slot.acquire(&format!("{} · {}", p.id, if priority == Priority::Interactive { "Tony" } else { "background" }), priority == Priority::Interactive, osc.scheduler.tony_priority_pct).await)
        } else {
            None
        };
        match call(state, &osc, &cfg.policy, p, &outbound, max_secs).await {
            Ok(content) => {
                if i > 0 {
                    reason = format!("{} → {}", errors.join("; "), p.id);
                }
                return Ok(DispatchResult {
                    provider_id: p.id.clone(),
                    content: if diffuse { redactor.rehydrate(&content) } else { content },
                    fell_back: i > 0,
                    reason,
                    latency_ms: started.elapsed().as_millis(),
                    redacted: diffuse && !redactor.replacements.is_empty(),
                });
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

async fn call(state: &DispatchState, osc: &os_core::OsConfig, policy: &Policy, p: &Provider, messages: &[ChatMessage], max_secs: Option<u64>) -> Result<String, String> {
    let base_timeout = if p.kind == Kind::Cloud { policy.cloud_timeout_secs } else { policy.local_timeout_secs };
    let timeout = Duration::from_secs(max_secs.map_or(base_timeout, |m| m.clamp(3, base_timeout)));
    let base = p.base_url.trim_end_matches('/');

    if p.kind == Kind::AgenticOs {
        // server.py: POST /api/chat {agent, message} → {status, response: {content}}
        let last = messages.iter().rev().find(|m| m.role == "user").map(|m| m.content.clone()).unwrap_or_default();
        let mut rb = state.http.post(format!("{base}/api/chat")).timeout(timeout).json(&serde_json::json!({ "agent": p.model, "message": last }));
        if let Some(t) = os_core::mesh_bearer(osc) {
            rb = rb.bearer_auth(t);
        }
        let res = rb.send().await.map_err(short)?;
        let body: serde_json::Value = res.error_for_status().map_err(short)?.json().await.map_err(short)?;
        return body["response"]["content"].as_str().map(str::to_owned).ok_or_else(|| "malformed gateway reply".into());
    }

    // OpenAI-compatible /chat/completions (LM Studio, AnythingLLM, vLLM, Ollama, OpenRouter).
    let mut rb = state
        .http
        .post(format!("{base}/chat/completions"))
        .timeout(timeout)
        .json(&{
            let mut body = serde_json::json!({ "model": p.model, "messages": messages, "stream": false });
            // Reasoning models think for hundreds of tokens before answering (Qwen3.5 on
            // LM Studio/Bionic: 12 s and an empty reply vs 0.8 s). Short-budget internal
            // calls (planner, router, verifier: ≤ 45 s) never think; answers think only
            // with Deep thinking on. AnythingLLM's OpenAI shim doesn't take the field.
            let internal = max_secs.is_some_and(|m| m <= 45);
            if p.kind == Kind::Local && p.id != "anythingllm" && (internal || !osc.compute.deep_thinking) {
                body["reasoning_effort"] = serde_json::json!("none");
            }
            body
        });
    if let Some(key) = state.key_for(p)? {
        rb = rb.bearer_auth(key);
    } else if os_core::is_droplet(p, osc) {
        if let Some(t) = os_core::mesh_bearer(osc) {
            rb = rb.bearer_auth(t);
        }
    }
    let res = rb.send().await.map_err(short)?;
    let body: serde_json::Value = res.error_for_status().map_err(short)?.json().await.map_err(short)?;
    let text = body["choices"][0]["message"]["content"].as_str().ok_or("malformed completion")?;
    // Reasoning models wrap their scratchpad in <think>…</think>; never surface it.
    Ok(strip_think(text))
}

pub(crate) fn strip_think(s: &str) -> String {
    match (s.find("<think>"), s.find("</think>")) {
        (Some(a), Some(b)) if b > a => format!("{}{}", &s[..a], &s[b + 8..]).trim().to_string(),
        _ => s.trim().to_string(),
    }
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


/// Tony's answer with SSE token streaming (`tony-token` events) from the first
/// local OpenAI-compatible backend; falls back to `run_chat` on anything else.
pub(crate) async fn run_chat_streamed(state: &DispatchState, os: &OsState, messages: Vec<ChatMessage>, max_secs: Option<u64>, app: &tauri::AppHandle, stream_id: &str) -> Result<DispatchResult, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let first = cfg.policy.chain.iter().filter_map(|id| cfg.providers.iter().find(|p| &p.id == id && p.kind.is_chat())).next().cloned();
    let chars: usize = messages.iter().map(|m| m.content.len()).sum();
    let vram = if osc.compute.mode == os_core::ComputeMode::Hybrid { os_core::vram_pct().await } else { None };
    let shaped = first.clone().map(|p| os_core::shape_chain(&osc, vec![p], vram, chars, false).0).unwrap_or_default();
    let Some(p) = shaped.into_iter().next().filter(|p| p.kind == Kind::Local && p.id != "anythingllm" && !os_core::is_remote(p)) else {
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    };
    let started = Instant::now();
    let _slot = os.slot.acquire(&format!("{} · Tony (streaming)", p.id), true, osc.scheduler.tony_priority_pct).await;
    let mut body = serde_json::json!({ "model": p.model, "messages": messages, "stream": true });
    if !osc.compute.deep_thinking {
        body["reasoning_effort"] = serde_json::json!("none");
    }
    let mut rb = state.http.post(format!("{}/chat/completions", p.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(max_secs.unwrap_or(cfg.policy.local_timeout_secs))).json(&body);
    if let Some(k) = state.key_for(&p)? {
        rb = rb.bearer_auth(k);
    }
    let res = match rb.send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(_) => {
            drop(_slot);
            return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
        }
    };
    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    let mut content = String::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(d) = v["choices"][0]["delta"]["content"].as_str().filter(|d| !d.is_empty()) {
                    content.push_str(d);
                    let _ = app.emit("tony-token", serde_json::json!({ "streamId": stream_id, "delta": d }));
                }
            }
        }
    }
    if content.trim().is_empty() {
        drop(_slot);
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    }
    Ok(DispatchResult { provider_id: p.id.clone(), content: strip_think(&content), fell_back: false, reason: "chain · streamed".into(), latency_ms: started.elapsed().as_millis(), redacted: false })
}
