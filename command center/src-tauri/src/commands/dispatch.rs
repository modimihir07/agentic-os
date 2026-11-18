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
use serde_json::{json, Value};
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
    /// Agentic OS server.py `/api/chat` (opencode / agy / claude / gemini / llm CLIs).
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
    /// STT: Whisper vocabulary-biasing prompt, sent as the multipart `prompt` field.
    /// `None` = the built-in default (`DEFAULT_STT_PROMPT`); `Some("")` = send none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_prompt: Option<String>,
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
    /// Part 3: per-agent TTS voice roster, keyed by role id ("general" = Tony).
    /// Empty by default — nothing here means "use policy.tts" exactly as before.
    #[serde(default)]
    pub agent_voices: BTreeMap<String, AgentVoice>,
}

/// Agent ids a voice-roster entry (or any other per-agent config in this
/// file) can key on. Kept local here rather than importing `roles.ts`'s
/// list from the TS side: the roster lives in providers.json, not OsConfig,
/// so it has no Rust-side shared list of its own yet.
pub(crate) const ROLE_IDS: [&str; 7] = ["general", "booking", "prompter", "coder", "designer", "librarian", "ops"];

/// `"tony"` is accepted as an alias of `"general"` (ground rule) wherever a
/// role id arrives from the outside (Settings UI, `tts_synthesize`'s `agent`).
pub(crate) fn canon_role(r: &str) -> String {
    let r = r.trim().to_ascii_lowercase();
    if r == "tony" {
        "general".into()
    } else {
        r
    }
}

pub(crate) fn valid_role(r: &str) -> bool {
    ROLE_IDS.contains(&r)
}

/// Part 3: one agent's voice. `engine` is "elevenlabs" or "kokoro" (the two
/// engines this app drives); `voice`/`model` override the matching
/// provider's own `voice`/`model` when set, and fall back to them when not.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentVoice {
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub auto_speak: bool,
}

fn default_voice_engine() -> String {
    "elevenlabs".into()
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
        stt_prompt: None,
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
            agent_voices: BTreeMap::new(),
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
                    // The hermes CLI is gone: rewrite the stale "Agentic OS (hermes)" label
                    // (and a hermes model) so Settings stops advertising it. Saved below.
                    if migrate_hermes(&mut cfg) {
                        eprintln!("[dispatch] migrated stale hermes provider label/model");
                    }
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
    for (role, v) in &cfg.agent_voices {
        if !valid_role(role) {
            return Err(format!("agentVoices: unknown role '{role}'"));
        }
        if v.engine != "elevenlabs" && v.engine != "kokoro" {
            return Err(format!("agentVoices.{role}: engine must be 'elevenlabs' or 'kokoro'"));
        }
        if v.voice.as_ref().is_some_and(|s| s.chars().count() > 120) || v.model.as_ref().is_some_and(|s| s.chars().count() > 64) {
            return Err(format!("agentVoices.{role}: voice/model too long"));
        }
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
    /// Part 3: the voice roster, by role id.
    agent_voices: BTreeMap<String, AgentVoice>,
}

fn view(state: &DispatchState, cfg: Config) -> ProvidersView {
    let agent_voices = cfg.agent_voices.clone();
    ProvidersView {
        providers: cfg
            .providers
            .into_iter()
            .map(|mut p| {
                let has_key = p.needs_key && secrets::get(state, &p.id).is_some();
                // Settings shows the prompt actually in effect (the default until edited).
                if p.kind == Kind::Stt && p.stt_prompt.is_none() {
                    p.stt_prompt = Some(DEFAULT_STT_PROMPT.to_string());
                }
                ProviderInfo { provider: p, has_key }
            })
            .collect(),
        policy: cfg.policy,
        agent_voices,
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
    stt_prompt: Option<String>,
}

/// Whisper vocabulary bias (Phase 2 §1). Natural speech on purpose, not a comma list:
/// Whisper treats the prompt as preceding transcript, so it biases spelling best this way.
pub const DEFAULT_STT_PROMPT: &str = "Tony, Gabagool mode. Take it ease. Cut it. Whoa. Madone, aspetta. Prompter, Designer, Coder, Booking Desk, Librarian and Ops. Bilmuri, Erra. WhatsApp, Gmail, Spotify, Tauri, Kokoro, Serena, checkpoint.";

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
        if let Some(v) = patch.stt_prompt {
            // Kept as Some("") when cleared: an empty prompt means "send none", not "use the default".
            p.stt_prompt = Some(short(v, 800));
        }
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVoicePatch {
    engine: Option<String>,
    voice: Option<String>,
    model: Option<String>,
    auto_speak: Option<bool>,
}

/// Pure merge of a patch into one roster entry, kept separate from the
/// command below so it is unit-testable without a live `DispatchState`.
pub(crate) fn apply_agent_voice_patch(entry: &mut AgentVoice, patch: AgentVoicePatch) -> Result<(), String> {
    if let Some(v) = patch.engine {
        let v = v.trim().to_ascii_lowercase();
        if v != "elevenlabs" && v != "kokoro" {
            return Err("engine must be 'elevenlabs' or 'kokoro'".into());
        }
        entry.engine = v;
    }
    if let Some(v) = patch.voice {
        entry.voice = Some(v.trim().chars().take(120).collect::<String>()).filter(|s| !s.is_empty());
    }
    if let Some(v) = patch.model {
        entry.model = Some(v.trim().chars().take(64).collect::<String>()).filter(|s| !s.is_empty());
    }
    if let Some(v) = patch.auto_speak {
        entry.auto_speak = v;
    }
    Ok(())
}

/// Settings → Voice: edit one agent's roster row ("tony" accepted as an
/// alias of "general"). A role with no entry yet starts from the app's
/// default engine (ElevenLabs) before the patch is applied.
#[tauri::command]
pub fn agent_voice_update(state: State<'_, DispatchState>, role: String, patch: AgentVoicePatch) -> Result<ProvidersView, String> {
    let role = canon_role(&role);
    if !valid_role(&role) {
        return Err(format!("unknown agent role '{role}'"));
    }
    let cfg = state.update(|cfg| {
        let entry = cfg.agent_voices.entry(role.clone()).or_insert_with(|| AgentVoice { engine: default_voice_engine(), voice: None, model: None, auto_speak: false });
        apply_agent_voice_patch(entry, patch)
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
    /// Tokens/s of a streamed reply (System Map trace only; never serialized).
    #[serde(skip)]
    pub(crate) tps: Option<f64>,
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
                tps: None,
            });
        }
    }

    let chars: usize = messages.iter().map(|m| m.content.len()).sum();
    // The Agentic OS gateway forwards only the last user message: a planner / router /
    // verifier call would lose its system prompt and come back as prose, not JSON.
    let skip_gateway = skip_agentic_os(&messages, max_secs);
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
        let (mut shaped, notes) = os_core::shape_chain(&osc, chain, vram, chars, false);
        let mut r = busy.map(|w| format!("background + {w} → off-GPU")).unwrap_or_else(|| "chain".into());
        if !notes.is_empty() {
            r = format!("{r} · {}", notes.join(", "));
        }
        if skip_gateway && shaped.iter().any(|p| p.kind == Kind::AgenticOs) {
            shaped.retain(|p| p.kind != Kind::AgenticOs);
            r = format!("{r} · agentic-os skipped (system prompt + JSON)");
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
                    tps: None,
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
        let status = res.status();
        if !status.is_success() {
            // 503 = "CLI not installed": an Err so the chain falls through, never a reply.
            let detail = res.json::<serde_json::Value>().await.ok().and_then(|b| b["detail"].as_str().map(str::to_owned));
            return Err(match detail {
                Some(d) => format!("HTTP {} — {}", status.as_u16(), gateway_detail(&d)),
                None => format!("HTTP {status}"),
            });
        }
        let body: serde_json::Value = res.json().await.map_err(short)?;
        let content = body["response"]["content"].as_str().ok_or("malformed gateway reply")?;
        if let Some(e) = gateway_reply_error(content) {
            return Err(e);
        }
        return Ok(content.to_owned());
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
    Ok(usable_text_from_message(&body["choices"][0]["message"]).ok_or("malformed completion")?)
}

/// Pull something usable out of a chat completion's `message`, instead of
/// requiring a plain string `content` (Part 6 §3 — "never malformed
/// completion when there's usable text"). Some models answer a router/tool
/// prompt with `content: null` and a `tool_calls` array, or put their whole
/// answer in `reasoning_content` when the server strips `content`. Preferred
/// order: a real string `content`; else the first `tool_calls` entry, mapped
/// to the `{"tool":…, "args":…}` shape the router expects; else
/// `reasoning_content` prose. `None` only when literally nothing is usable.
pub(crate) fn usable_text_from_message(msg: &Value) -> Option<String> {
    if let Some(s) = msg["content"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(strip_think(s));
    }
    if let Some(tc) = msg["tool_calls"].as_array().and_then(|a| a.first()) {
        let f = &tc["function"];
        let name = f["name"].as_str().unwrap_or_default();
        if !name.is_empty() {
            let args = f["arguments"].as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or_else(|| f["arguments"].clone());
            return Some(json!({ "tool": name, "args": args }).to_string());
        }
    }
    if let Some(r) = msg["reasoning_content"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(strip_think(r));
    }
    None
}

/// Planner / router / verifier calls (short budget) that carry a system prompt expect
/// JSON shaped by that prompt. The Agentic OS gateway drops system prompts, so it is
/// excluded from such chains (a pinned `provider` is left alone).
pub(crate) fn skip_agentic_os(messages: &[ChatMessage], max_secs: Option<u64>) -> bool {
    let system: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "system").collect();
    if system.is_empty() {
        return false;
    }
    let internal = max_secs.is_some_and(|m| m <= 45);
    internal || system.iter().any(|m| m.content.to_ascii_lowercase().contains("json"))
}

/// server.py's error strings that older gateways returned with HTTP 200. They are
/// failures, not answers: returning Err lets the chain fall through.
pub(crate) fn gateway_reply_error(content: &str) -> Option<String> {
    let t = content.trim_start();
    const FAIL: [&str; 4] = ["⚠ Agent", "⚠ Error communicating", "⏱ Agent", "Unknown agent:"];
    FAIL.iter().any(|p| t.starts_with(p)).then(|| gateway_detail(t))
}

/// One short line of a gateway error (no markdown, capped).
fn gateway_detail(s: &str) -> String {
    let line = s.trim().trim_start_matches(['⚠', '⏱']).trim().lines().next().unwrap_or("").to_string();
    line.chars().take(160).collect()
}

/// One-time migration: the hermes CLI was removed. Returns true when anything changed.
pub(crate) fn migrate_hermes(cfg: &mut Config) -> bool {
    let mut changed = false;
    for p in cfg.providers.iter_mut() {
        if p.label.to_lowercase().contains("hermes") {
            p.label = "Agentic OS (opencode)".into();
            changed = true;
        }
        if p.kind == Kind::AgenticOs && p.model.eq_ignore_ascii_case("hermes") {
            p.model = "opencode".into();
            changed = true;
        }
    }
    changed
}

pub(crate) fn strip_think(s: &str) -> String {
    match (s.find("<think>"), s.find("</think>")) {
        (Some(a), Some(b)) if b > a => format!("{}{}", &s[..a], &s[b + 8..]).trim().to_string(),
        _ => s.trim().to_string(),
    }
}

/// Filters `<think>…</think>` out of a token-by-token stream, including an
/// unclosed block (the model was still "thinking" when the turn ended). Feed
/// every delta as it arrives; `feed` returns only the text that is safe to
/// show/speak right now — never think content, and never a partial tag (a
/// `<think>` split across two deltas is held back until it resolves one way
/// or the other). Using this on the LIVE stream, instead of only on the final
/// `content` (as `strip_think` does), is what keeps the webview's `buffered`
/// text identical to the final answer: there is no separate stripping pass
/// afterwards to drift out of sync with the `spokenUpTo` offsets already
/// computed against the raw stream (Part 6 §1's "spokenUpTo offset drift").
pub struct ThinkFilter {
    pending: String,
    in_think: bool,
}

impl ThinkFilter {
    pub fn new() -> Self {
        Self { pending: String::new(), in_think: false }
    }

    pub fn feed(&mut self, delta: &str) -> String {
        self.pending.push_str(delta);
        let mut out = String::new();
        loop {
            if self.in_think {
                if let Some(pos) = self.pending.find("</think>") {
                    self.pending.drain(..pos + "</think>".len());
                    self.in_think = false;
                    continue;
                }
                // Still inside the block: hold everything but a short tail (long
                // enough to still catch "</think>" split across the next feed),
                // so a never-closing block can't grow `pending` without bound.
                let keep = "</think>".len() - 1;
                if self.pending.len() > keep {
                    let cut = floor_char_boundary(&self.pending, self.pending.len() - keep);
                    self.pending.drain(..cut);
                }
                break;
            }
            if let Some(pos) = self.pending.find("<think>") {
                out.push_str(&self.pending[..pos]);
                self.pending.drain(..pos + "<think>".len());
                self.in_think = true;
                continue;
            }
            // No full "<think>" seen yet — hold back only a tail that could still
            // be the START of one, so a stray "<" isn't flushed too eagerly.
            let hold = partial_tag_suffix_len(&self.pending, "<think>");
            let safe_len = self.pending.len() - hold;
            out.push_str(&self.pending[..safe_len]);
            self.pending.drain(..safe_len);
            break;
        }
        out
    }

    /// End of stream: whatever is left, unless it's an unclosed `<think>`
    /// block (dropped — a scratchpad that never closed has nothing to show).
    pub fn finish(self) -> String {
        if self.in_think {
            String::new()
        } else {
            self.pending
        }
    }
}

impl Default for ThinkFilter {
    fn default() -> Self {
        Self::new()
    }
}

fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Longest suffix of `s` that is a (possibly empty) prefix of `tag`, so a
/// partially-arrived tag ("<thi") is never mistaken for literal text.
fn partial_tag_suffix_len(s: &str, tag: &str) -> usize {
    let max = (tag.len() - 1).min(s.len());
    for len in (1..=max).rev() {
        let start = s.len() - len;
        if !s.is_char_boundary(start) {
            continue;
        }
        if s.as_bytes()[start..] == tag.as_bytes()[..len] {
            return len;
        }
    }
    0
}

// ── Model-agnostic JSON / tool-call extraction (Part 6) ─────────────────────
//
// Replaces the naive "first `{` … last `}`" copies that used to live in
// agents.rs and pipeline.rs (and are mirrored in TS `plan.ts` and Python
// `command_center_api.py`). Handles: a model's reasoning scratchpad sitting
// right next to the JSON, a ```json fence, more than one `{…}` span in the
// reply (tries each, outermost first), light formatting slips, and either
// `{"tool":…,"args":…}` or the OpenAI-style `{"name":…,"arguments":…}` shape.

fn strip_think_loose(s: &str) -> String {
    let mut out = s.to_string();
    loop {
        match (out.find("<think>"), out.find("</think>")) {
            (Some(a), Some(b)) if b > a => out = format!("{}{}", &out[..a], &out[b + 8..]),
            (Some(a), None) => {
                out.truncate(a);
                break;
            }
            _ => break,
        }
    }
    out.trim().to_string()
}

fn fenced_json(s: &str) -> Option<&str> {
    let lower = s.to_ascii_lowercase();
    let start = lower.find("```json")? + "```json".len();
    let end = s[start..].find("```")?;
    Some(s[start..start + end].trim())
}

/// `{`-at-`i` to its matching `}`, skipping braces that appear inside a
/// quoted string. `None` if it never balances (truncated output).
fn matching_brace(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut escape = false;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every outermost `{…}` span in `s`, in order. Nested objects inside a
/// matched span are not reported separately (they're already covered by it).
fn balanced_spans(s: &str) -> Vec<(usize, usize)> {
    let bytes = s.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(s, i) {
                spans.push((i, end));
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    spans
}

/// Trailing commas before `}`/`]`, and curly quotes a model sometimes emits
/// instead of straight ones.
fn light_repair(s: &str) -> String {
    static TRAILING_COMMA: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TRAILING_COMMA.get_or_init(|| regex::Regex::new(r",\s*([}\]])").unwrap());
    let s = s.replace(['\u{201c}', '\u{201d}'], "\"").replace(['\u{2018}', '\u{2019}'], "'");
    re.replace_all(&s, "$1").into_owned()
}

/// An OpenAI-style tool call (`{"name":…, "arguments":…}`) is also usable as
/// `{"tool":…, "args":…}` — add the aliases so every existing caller that
/// reads `j["tool"]`/`j["args"]` keeps working without knowing which shape
/// the model used.
fn normalize_tool_shape(mut v: Value) -> Value {
    if v.get("tool").is_none() {
        if let (Some(name), true) = (v.get("name").and_then(Value::as_str).map(str::to_owned), v.get("arguments").is_some()) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("tool".into(), Value::String(name));
                obj.insert("args".into(), obj.get("arguments").cloned().unwrap_or(Value::Null));
            }
        }
    }
    v
}

pub(crate) fn extract_json(text: &str) -> Option<Value> {
    let cleaned = strip_think_loose(text);
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(f) = fenced_json(&cleaned) {
        candidates.push(f);
    }
    let without_tool_tags = cleaned.replace("<tool_call>", "").replace("</tool_call>", "");
    let spans = balanced_spans(&without_tool_tags);
    for (a, b) in &spans {
        candidates.push(&without_tool_tags[*a..=*b]);
    }
    for c in candidates {
        for attempt in [c.to_string(), light_repair(c)] {
            if let Ok(v) = serde_json::from_str::<Value>(&attempt) {
                if v.is_object() {
                    return Some(normalize_tool_shape(v));
                }
            }
        }
    }
    None
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
    // Filtering `<think>…</think>` out of the LIVE stream (not only the final
    // `content`, as before) keeps the webview's `buffered` text exactly equal
    // to what this function returns — see `ThinkFilter`'s doc comment.
    let mut filter = ThinkFilter::new();
    let mut content = String::new();
    // Generation rate for the System Map trace: content deltas between the first and last token.
    let (mut deltas, mut usage_tokens, mut first_at, mut last_at) = (0u32, None::<u64>, None::<Instant>, Instant::now());
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
                if let Some(u) = v["usage"]["completion_tokens"].as_u64() {
                    usage_tokens = Some(u);
                }
                if let Some(d) = v["choices"][0]["delta"]["content"].as_str().filter(|d| !d.is_empty()) {
                    deltas = deltas.saturating_add(1);
                    last_at = Instant::now();
                    first_at.get_or_insert(last_at);
                    let shown = filter.feed(d);
                    if !shown.is_empty() {
                        content.push_str(&shown);
                        let _ = app.emit("tony-token", serde_json::json!({ "streamId": stream_id, "delta": shown }));
                    }
                }
            }
        }
    }
    content.push_str(&filter.finish());
    if content.trim().is_empty() {
        drop(_slot);
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    }
    let tps = first_at.and_then(|f| super::trace::tokens_per_sec(deltas, usage_tokens, last_at.duration_since(f).as_secs_f64() * 1000.0));
    Ok(DispatchResult { provider_id: p.id.clone(), content: content.trim().to_string(), fell_back: false, reason: "chain · streamed".into(), latency_ms: started.elapsed().as_millis(), redacted: false, tps })
}

#[cfg(test)]
mod part4_tests {
    use super::*;

    #[test]
    fn hermes_label_and_model_migrate() {
        let mut cfg = Config::default();
        let gw = cfg.providers.iter_mut().find(|p| p.id == "agentic-os").unwrap();
        gw.label = "Agentic OS (Hermes)".into();
        gw.model = "hermes".into();
        assert!(migrate_hermes(&mut cfg));
        let gw = cfg.providers.iter().find(|p| p.id == "agentic-os").unwrap();
        assert_eq!(gw.label, "Agentic OS (opencode)");
        assert_eq!(gw.model, "opencode");
        // Idempotent; other providers untouched.
        assert!(!migrate_hermes(&mut cfg));
        assert!(cfg.providers.iter().any(|p| p.label == "LM Studio"));
    }

    #[test]
    fn migrate_keeps_llm_model() {
        let mut cfg = Config::default();
        let gw = cfg.providers.iter_mut().find(|p| p.id == "agentic-os").unwrap();
        gw.label = "Agentic OS (hermes)".into();
        gw.model = "llm".into();
        assert!(migrate_hermes(&mut cfg));
        assert_eq!(cfg.providers.iter().find(|p| p.id == "agentic-os").unwrap().model, "llm");
    }

    #[test]
    fn gateway_error_bodies_are_errors() {
        assert!(gateway_reply_error("⚠ Agent 'hermes' CLI not installed. Install it and try again.").is_some());
        assert!(gateway_reply_error("  ⚠ Agent 'opencode' CLI not installed.").unwrap().starts_with("Agent 'opencode'"));
        assert!(gateway_reply_error("⏱ Agent 'opencode' timed out.\n\nRun …").is_some());
        assert!(gateway_reply_error("⚠ Error communicating with llm: boom").is_some());
        assert!(gateway_reply_error("Unknown agent: x").is_some());
        assert!(gateway_reply_error("Sure — the weather is mild today.").is_none());
        assert!(gateway_reply_error("Note: ⚠ Agent names are case sensitive").is_none());
    }

    #[test]
    fn agentic_os_skipped_for_internal_json_calls() {
        let sys = ChatMessage::new("system", "You are a planner. Reply with ONLY JSON.");
        let user = ChatMessage::new("user", "turn off gabagool mode");
        // planner (system + short budget)
        assert!(skip_agentic_os(&[sys.clone(), user.clone()], Some(15)));
        // system prompt that asks for JSON, no budget
        assert!(skip_agentic_os(&[sys, user.clone()], None));
        // plain chat with a persona, long budget → gateway stays in the chain
        let persona = ChatMessage::new("system", "You are Tony, a calm assistant.");
        assert!(!skip_agentic_os(&[persona.clone(), user.clone()], Some(120)));
        assert!(!skip_agentic_os(&[persona, user.clone()], None));
        // no system prompt → nothing is lost
        assert!(!skip_agentic_os(&[user], Some(15)));
    }
}

#[cfg(test)]
mod part3_tests {
    use super::*;

    #[test]
    fn canon_role_aliases_tony_to_general() {
        assert_eq!(canon_role("tony"), "general");
        assert_eq!(canon_role("Tony"), "general");
        assert_eq!(canon_role("  TONY  "), "general");
        assert_eq!(canon_role("booking"), "booking");
        assert_eq!(canon_role("Booking"), "booking");
    }

    #[test]
    fn valid_role_matches_the_seven_roles_only() {
        for r in ROLE_IDS {
            assert!(valid_role(r), "{r} should be a valid role");
        }
        assert!(!valid_role("tony")); // caller must canon_role() first
        assert!(!valid_role("overseer"));
        assert!(!valid_role(""));
    }

    #[test]
    fn agent_voices_pass_validation_when_well_formed() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("general".into(), AgentVoice { engine: "elevenlabs".into(), voice: Some("QhEKgDl6KUJsO1FPiuSD".into()), model: Some("eleven_v4".into()), auto_speak: false });
        cfg.agent_voices.insert("booking".into(), AgentVoice { engine: "kokoro".into(), voice: Some("am_michael".into()), model: None, auto_speak: true });
        assert!(validate(&cfg).is_ok());
    }

    #[test]
    fn agent_voices_reject_unknown_role() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("overseer".into(), AgentVoice { engine: "elevenlabs".into(), voice: None, model: None, auto_speak: false });
        assert!(validate(&cfg).unwrap_err().contains("unknown role"));
    }

    #[test]
    fn agent_voices_reject_bad_engine() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("coder".into(), AgentVoice { engine: "xtts".into(), voice: None, model: None, auto_speak: false });
        assert!(validate(&cfg).unwrap_err().contains("engine must be"));
    }

    #[test]
    fn agent_voices_reject_oversized_fields() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("coder".into(), AgentVoice { engine: "kokoro".into(), voice: Some("x".repeat(121)), model: None, auto_speak: false });
        assert!(validate(&cfg).unwrap_err().contains("too long"));
    }

    #[test]
    fn apply_agent_voice_patch_merges_only_given_fields() {
        let mut entry = AgentVoice { engine: "elevenlabs".into(), voice: Some("old-voice".into()), model: Some("eleven_v4".into()), auto_speak: false };
        apply_agent_voice_patch(&mut entry, AgentVoicePatch { engine: None, voice: Some("new-voice".into()), model: None, auto_speak: Some(true) }).unwrap();
        assert_eq!(entry.engine, "elevenlabs"); // untouched
        assert_eq!(entry.voice.as_deref(), Some("new-voice"));
        assert_eq!(entry.model.as_deref(), Some("eleven_v4")); // untouched
        assert!(entry.auto_speak);
    }

    #[test]
    fn apply_agent_voice_patch_rejects_bad_engine() {
        let mut entry = AgentVoice { engine: "kokoro".into(), voice: None, model: None, auto_speak: false };
        let err = apply_agent_voice_patch(&mut entry, AgentVoicePatch { engine: Some("xtts".into()), voice: None, model: None, auto_speak: None }).unwrap_err();
        assert!(err.contains("elevenlabs"));
        assert_eq!(entry.engine, "kokoro"); // unchanged on error
    }

    #[test]
    fn apply_agent_voice_patch_clearing_voice_with_blank_string() {
        let mut entry = AgentVoice { engine: "kokoro".into(), voice: Some("am_michael".into()), model: None, auto_speak: false };
        apply_agent_voice_patch(&mut entry, AgentVoicePatch { engine: None, voice: Some("   ".into()), model: None, auto_speak: None }).unwrap();
        assert_eq!(entry.voice, None); // blank clears it, matching every other trimmed-string patch field in this file
    }
}

#[cfg(test)]
mod part6_tests {
    use super::*;

    // ── ThinkFilter ──────────────────────────────────────────────────────────

    #[test]
    fn think_filter_passes_plain_text_through() {
        let mut f = ThinkFilter::new();
        assert_eq!(f.feed("Hello "), "Hello ");
        assert_eq!(f.feed("there."), "there.");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn think_filter_strips_a_closed_block_in_one_feed() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <think>scratch</think> after."));
        out.push_str(&f.finish());
        assert_eq!(out, "Before  after.");
    }

    #[test]
    fn think_filter_handles_the_open_tag_split_across_feeds() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <thi"));
        out.push_str(&f.feed("nk>scratch</think> after."));
        out.push_str(&f.finish());
        assert_eq!(out, "Before  after.");
    }

    #[test]
    fn think_filter_handles_the_close_tag_split_across_feeds() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <think>scratch</thi"));
        out.push_str(&f.feed("nk> after."));
        out.push_str(&f.finish());
        assert_eq!(out, "Before  after.");
    }

    #[test]
    fn think_filter_drops_an_unclosed_block_at_end_of_stream() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <think>never closes"));
        out.push_str(&f.finish()); // dropped, not shown
        assert_eq!(out, "Before ");
    }

    #[test]
    fn think_filter_handles_multiple_blocks() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("A <think>x</think> B <think>y</think> C"));
        out.push_str(&f.finish());
        assert_eq!(out, "A  B  C");
    }

    #[test]
    fn think_filter_never_flushes_a_stray_bracket_as_a_partial_tag() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        // "5 < 10" should never be mistaken for the start of "<think>".
        out.push_str(&f.feed("5 < 10, done."));
        out.push_str(&f.finish());
        assert_eq!(out, "5 < 10, done.");
    }

    // ── extract_json ─────────────────────────────────────────────────────────

    #[test]
    fn extract_json_plain_object() {
        assert_eq!(extract_json(r#"{"tool": "x", "args": {}}"#).unwrap()["tool"], "x");
    }

    #[test]
    fn extract_json_strips_a_closed_think_block_first() {
        let v = extract_json(r#"<think>let me think about {"fake": 1}</think>{"tool": "real", "args": {}}"#).unwrap();
        assert_eq!(v["tool"], "real");
    }

    #[test]
    fn extract_json_strips_an_unclosed_think_block() {
        // Nothing usable follows an unclosed scratchpad — None, not a crash.
        assert!(extract_json(r#"<think>still thinking about {"tool":"x"}"#).is_none());
    }

    #[test]
    fn extract_json_prefers_a_json_fence() {
        let text = "Sure, here you go:\n```json\n{\"tool\": \"fenced\", \"args\": {\"a\": 1}}\n```\nHope that helps.";
        assert_eq!(extract_json(text).unwrap()["tool"], "fenced");
    }

    #[test]
    fn extract_json_tries_each_brace_span_when_the_first_is_junk() {
        // The first `{…}` isn't even valid JSON on its own; the second is.
        let text = r#"note: {this isn't json} but then {"tool": "second", "args": {}}"#;
        assert_eq!(extract_json(text).unwrap()["tool"], "second");
    }

    #[test]
    fn extract_json_ignores_braces_inside_string_values() {
        let text = r#"{"tool": "x", "args": {"note": "use { and } in prose"}}"#;
        let v = extract_json(text).unwrap();
        assert_eq!(v["tool"], "x");
        assert_eq!(v["args"]["note"], "use { and } in prose");
    }

    #[test]
    fn extract_json_repairs_trailing_commas_and_smart_quotes() {
        let text = "{\u{201c}tool\u{201d}: \u{201c}x\u{201d}, \u{201c}args\u{201d}: {\u{201c}a\u{201d}: 1,},}";
        let v = extract_json(text).unwrap();
        assert_eq!(v["tool"], "x");
        assert_eq!(v["args"]["a"], 1);
    }

    #[test]
    fn extract_json_accepts_tool_call_tag_wrapper() {
        let text = r#"<tool_call>{"tool": "wrapped", "args": {}}</tool_call>"#;
        assert_eq!(extract_json(text).unwrap()["tool"], "wrapped");
    }

    #[test]
    fn extract_json_normalizes_name_arguments_shape() {
        let text = r#"{"name": "whatsapp.list_messages", "arguments": {"limit": 5}}"#;
        let v = extract_json(text).unwrap();
        assert_eq!(v["tool"], "whatsapp.list_messages");
        assert_eq!(v["args"]["limit"], 5);
        // Original keys stay too — callers reading either shape still work.
        assert_eq!(v["name"], "whatsapp.list_messages");
    }

    #[test]
    fn extract_json_none_when_there_is_no_json_at_all() {
        assert!(extract_json("just a plain sentence, no JSON here").is_none());
    }

    #[test]
    fn extract_json_none_on_empty_input() {
        assert!(extract_json("").is_none());
    }

    // ── usable_text_from_message ─────────────────────────────────────────────

    #[test]
    fn usable_text_prefers_plain_content() {
        let msg = json!({ "content": "hello", "tool_calls": [{"function": {"name": "x", "arguments": "{}"}}] });
        assert_eq!(usable_text_from_message(&msg).unwrap(), "hello");
    }

    #[test]
    fn usable_text_falls_back_to_tool_calls_when_content_is_null() {
        let msg = json!({ "content": Value::Null, "tool_calls": [{"function": {"name": "whatsapp.list_messages", "arguments": "{\"limit\":5}"}}] });
        let v: Value = serde_json::from_str(&usable_text_from_message(&msg).unwrap()).unwrap();
        assert_eq!(v["tool"], "whatsapp.list_messages");
        assert_eq!(v["args"]["limit"], 5);
    }

    #[test]
    fn usable_text_accepts_a_tool_call_with_object_arguments() {
        let msg = json!({ "content": Value::Null, "tool_calls": [{"function": {"name": "time.now", "arguments": {}}}] });
        let v: Value = serde_json::from_str(&usable_text_from_message(&msg).unwrap()).unwrap();
        assert_eq!(v["tool"], "time.now");
    }

    #[test]
    fn usable_text_falls_back_to_reasoning_content() {
        let msg = json!({ "content": Value::Null, "reasoning_content": "<think>x</think>here's my answer" });
        assert_eq!(usable_text_from_message(&msg).unwrap(), "here's my answer");
    }

    #[test]
    fn usable_text_none_when_nothing_is_usable() {
        let msg = json!({ "content": Value::Null });
        assert!(usable_text_from_message(&msg).is_none());
    }
}
