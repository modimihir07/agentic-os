//! Core OS settings: identity ("Tony"), compute routing (local / hybrid /
//! cloud), droplet, AnythingLLM workspaces, skills + MCP registry, OS master
//! permissions, privacy shield and the memory lifecycle. Stored in
//! `os.json` next to providers.json — never edited from the webview except
//! through the validated commands below.
//!
//! A mirror without secrets is written to `<repo>/data/command-center/os-state.json`
//! so the gateway can serve it to the phone (`GET /api/os/state`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::Duration;
use tauri::State;

use super::bridge::{BridgeState, Tier};
use super::dispatch::{short, DispatchState, Provider};
use super::privacy::Replacement;

// ── Config ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ComputeMode {
    /// 100 % local hardware; every remote/cloud call is blocked.
    Local,
    /// Local first; offload a turn when VRAM is over the threshold or the prompt is huge.
    #[default]
    Hybrid,
    /// Remote/droplet first to keep the GPU free; local stays as fallback.
    Cloud,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ComputeConfig {
    pub mode: ComputeMode,
    pub vram_threshold_pct: f32,
    pub heavy_context_chars: usize,
    /// Let reasoning models (Qwen3.5…) think before *answers*. Off = much faster.
    /// Internal calls (planner, tool router, verifier) never think either way.
    pub deep_thinking: bool,
}
impl Default for ComputeConfig {
    fn default() -> Self {
        Self { mode: ComputeMode::Hybrid, vram_threshold_pct: 90.0, heavy_context_chars: 24_000, deep_thinking: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct DropletConfig {
    /// Master switch. Off = shown as OFFLINE (MANUAL) and never contacted.
    pub enabled: bool,
    pub host: String,
    pub qdrant_url: String,
    pub n8n_url: String,
    /// OpenAI-compatible model / proxy endpoint (Ollama, vLLM, OpenRouter bridge…).
    pub model_url: String,
    pub anythingllm_url: String,
}
impl Default for DropletConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: "100.64.0.10".into(),
            qdrant_url: "http://100.64.0.10:6333".into(),
            n8n_url: "http://100.64.0.10:5678".into(),
            model_url: "http://100.64.0.10:8000/v1".into(),
            anythingllm_url: "http://100.64.0.10:3001".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AnythingLlmConfig {
    pub base_url: String,
    /// Agent role → workspace slug.
    pub workspaces: BTreeMap<String, String>,
    pub timeout_secs: u64,
}
impl Default for AnythingLlmConfig {
    fn default() -> Self {
        let ws = [("librarian", "librarian"), ("coder", "coder"), ("booking", "booking"), ("ops", "ops"), ("general", "my-workspace"), ("prompter", "prompter-dispatcher"), ("designer", "designer")];
        Self {
            base_url: "http://127.0.0.1:3001".into(),
            workspaces: ws.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            timeout_secs: 90,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillsConfig {
    pub dir: String,
    /// Skill name → agents it is attached to ("tony", "booking", "coder", "librarian", "ops", "claude").
    pub grants: BTreeMap<String, Vec<String>>,
}
impl Default for SkillsConfig {
    fn default() -> Self {
        Self { dir: default_skills_dir(), grants: BTreeMap::new() }
    }
}

fn default_skills_dir() -> String {
    let hub = PathBuf::from(r"C:\ai-hub\skills");
    if hub.is_dir() {
        return hub.display().to_string();
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let claude = PathBuf::from(home).join(".claude").join("skills");
        if claude.is_dir() {
            return claude.display().to_string();
        }
    }
    hub.display().to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    /// "builtin" (implemented natively in Rust) | "stdio" | "http".
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub description: String,
}

fn builtin(id: &str, name: &str, enabled: bool, description: &str) -> McpServer {
    McpServer {
        id: id.into(),
        name: name.into(),
        transport: "builtin".into(),
        command: String::new(),
        args: vec![],
        env: BTreeMap::new(),
        url: String::new(),
        enabled,
        builtin: true,
        description: description.into(),
    }
}

pub fn default_mcps() -> Vec<McpServer> {
    vec![
        builtin("weather", "Weather / Open-Meteo", true, "Live conditions and 3-day forecast for any place."),
        builtin("time", "Time (America/Toronto)", true, "Current local date and time."),
        builtin("fetch", "Fetch", true, "Download a web page as plain text."),
        builtin("filesystem", "Filesystem", true, "List and read files under the allowed roots (C:\\ai-hub, this project)."),
        builtin("git", "Git", true, "Status and recent commits of a repository under the allowed roots."),
        builtin("knowledge-graph", "Knowledge Graph", true, "Search C:\\ai-hub\\memory\\knowledge-graph.json."),
        builtin("brave-search", "Brave Search", false, "Web search (needs a Brave API key in Settings)."),
        builtin("gmail", "Gmail", false, "Recent inbox messages via the read-only n8n workflow \"gmail-recent\"."),
        McpServer {
            id: "whatsapp".into(),
            name: "WhatsApp Bridge".into(),
            transport: "stdio".into(),
            command: "uv".into(),
            args: vec!["--directory".into(), r"C:\ai-hub\whatsapp-mcp\whatsapp-mcp-server".into(), "run".into(), "main.py".into()],
            env: BTreeMap::new(),
            url: String::new(),
            enabled: false,
            builtin: true,
            description: "lharries/whatsapp-mcp — start the Go bridge (whatsapp-bridge) first.".into(),
        },
    ]
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OsPermissions {
    /// Tony → AnythingLLM sub-agents.
    pub delegation: Tier,
    /// Tony runs its own MCP tools.
    pub mcp: Tier,
    /// Filesystem MCP read access (writes are never exposed to the model).
    pub filesystem: Tier,
    /// Anything that leaves this machine (cloud models, droplet, overseer).
    pub cloud: Tier,
}
impl Default for OsPermissions {
    fn default() -> Self {
        Self { delegation: Tier::Allow, mcp: Tier::Allow, filesystem: Tier::Allow, cloud: Tier::Allow }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PrivacyConfig {
    pub diffuser: bool,
    pub network_lock: bool,
    pub kill_switch: bool,
    pub destructive_gate: bool,
    /// Client names, venues, anything else to always redact.
    pub sensitive_terms: Vec<String>,
}
impl Default for PrivacyConfig {
    fn default() -> Self {
        Self { diffuser: true, network_lock: true, kill_switch: false, destructive_gate: true, sensitive_terms: vec![] }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OverseerConfig {
    /// "claude-cli" | "claude-api" | "gemini-cli" | "gemini-api" | "droplet" | "local".
    pub engine: String,
    pub claude_model: String,
    pub gemini_model: String,
    /// Off = only the "Ask Claude Overseer" button escalates.
    pub auto_escalate: bool,
    /// Manual Overseer Mode: every mutating plan also gets an overseer review on the card.
    pub manual_mode: bool,
}
impl Default for OverseerConfig {
    fn default() -> Self {
        Self {
            engine: "claude-cli".into(),
            claude_model: "claude-opus-5-5".into(),
            gemini_model: "gemini-2.5-pro".into(),
            auto_escalate: false,
            manual_mode: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryConfig {
    /// "local" | "droplet" | "hybrid" — where Memory Books get mounted for RAG.
    pub storage: String,
    pub auto_monthly: bool,
    pub auto_flush: bool,
    pub vault_dir: String,
    /// "chatml" | "alpaca" | "sharegpt".
    pub dataset_format: String,
    /// Workspace that receives mounted Memory Books.
    pub mount_workspace: String,
    /// Droplet Qdrant collections treated as disposable cache (flushed after backup).
    pub cache_collections: Vec<String>,
    pub last_auto_month: String,
}
impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            storage: "local".into(),
            auto_monthly: false,
            auto_flush: false,
            vault_dir: r"C:\ai-hub\vault\locked-archives".into(),
            dataset_format: "chatml".into(),
            mount_workspace: "my-workspace".into(),
            cache_collections: vec![],
            last_auto_month: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OsConfig {
    pub os_name: String,
    pub wake_words: Vec<String>,
    pub identity_path: String,
    pub root_directive: bool,
    pub compute: ComputeConfig,
    pub droplet: DropletConfig,
    pub anythingllm: AnythingLlmConfig,
    pub skills: SkillsConfig,
    pub mcps: Vec<McpServer>,
    pub fs_roots: Vec<String>,
    pub permissions: OsPermissions,
    pub privacy: PrivacyConfig,
    pub overseer: OverseerConfig,
    pub memory: MemoryConfig,
    pub scheduler: super::scheduler::SchedulerConfig,
}

impl Default for OsConfig {
    fn default() -> Self {
        Self {
            os_name: "Tony".into(),
            wake_words: vec!["hey tony".into(), "yo tony".into(), "tony".into()],
            identity_path: r"C:\ai-hub\master\MASTER_IDENTITY.md".into(),
            root_directive: true,
            compute: ComputeConfig::default(),
            droplet: DropletConfig::default(),
            anythingllm: AnythingLlmConfig::default(),
            skills: SkillsConfig::default(),
            mcps: default_mcps(),
            fs_roots: vec![r"C:\ai-hub".into()],
            permissions: OsPermissions::default(),
            privacy: PrivacyConfig::default(),
            overseer: OverseerConfig::default(),
            memory: MemoryConfig::default(),
            scheduler: super::scheduler::SchedulerConfig::default(),
        }
    }
}

// ── State ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRecord {
    pub at: u64,
    pub destination: String,
    pub payload: serde_json::Value,
    pub replacements: Vec<Replacement>,
}

#[derive(Default)]
pub struct OsState {
    config: RwLock<OsConfig>,
    path: RwLock<Option<PathBuf>>,
    mirror: RwLock<Option<PathBuf>>,
    pub(crate) last_redaction: Mutex<Option<RedactionRecord>>,
    pub(crate) mcp_tools: Mutex<BTreeMap<String, (u64, Vec<super::mcp::ToolInfo>)>>,
    /// AnythingLLM workspace slug → this month's Tony thread slug.
    pub(crate) allm_threads: Mutex<BTreeMap<String, String>>,
    /// The local-GPU baton (Tony-first scheduler).
    pub(crate) slot: super::scheduler::GpuSlot,
    /// Live, non-persisted status merged into the phone mirror (droplet link…).
    pub(crate) runtime: Mutex<serde_json::Map<String, serde_json::Value>>,
}

impl OsState {
    pub fn load_or_init(&self, dir: &Path, repo: &Path) {
        let path = dir.join("os.json");
        *self.path.write().unwrap() = Some(path.clone());
        *self.mirror.write().unwrap() = Some(repo.join("data").join("command-center").join("os-state.json"));
        let mut cfg = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<OsConfig>(&s).unwrap_or_else(|e| {
                eprintln!("[os] os.json invalid ({e}); using defaults");
                OsConfig::default()
            }),
            Err(_) => OsConfig::default(),
        };
        // Upgrades: add new built-in MCPs without touching the user's toggles.
        for d in default_mcps() {
            if !cfg.mcps.iter().any(|m| m.id == d.id) {
                cfg.mcps.push(d);
            }
        }
        // …and new role → workspace mappings (Phase 2: designer).
        for (role, slug) in AnythingLlmConfig::default().workspaces {
            cfg.anythingllm.workspaces.entry(role).or_insert(slug);
        }
        // Designer starts with the UI/UX pack attached (taste, impeccable, Kowalski motion, Stitch).
        if !cfg.skills.grants.values().any(|a| a.iter().any(|x| x == "designer")) {
            let dir = std::path::PathBuf::from(&cfg.skills.dir);
            for name in ["design-taste-frontend", "taste-design", "impeccable", "emil-design-eng", "animate", "stitch-generate-design", "stitch-manage-design-system", "frontend-design"] {
                if dir.join(name).join("SKILL.md").exists() {
                    let e = cfg.skills.grants.entry(name.to_string()).or_default();
                    if !e.iter().any(|x| x == "designer") {
                        e.push("designer".into());
                    }
                }
            }
        }
        self.slot.set_capacity(cfg.scheduler.max_concurrency as usize);
        *self.config.write().unwrap() = cfg;
        let _ = self.persist();
    }

    pub fn snapshot(&self) -> OsConfig {
        self.config.read().unwrap().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut OsConfig) -> Result<(), String>) -> Result<OsConfig, String> {
        let mut next = self.snapshot();
        f(&mut next)?;
        validate(&next)?;
        self.slot.set_capacity(next.scheduler.max_concurrency as usize);
        *self.config.write().unwrap() = next.clone();
        self.persist()?;
        Ok(next)
    }

    fn persist(&self) -> Result<(), String> {
        let cfg = self.snapshot();
        if let Some(p) = self.path.read().unwrap().clone() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            std::fs::write(&p, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        if let Some(m) = self.mirror.read().unwrap().clone() {
            if let Some(d) = m.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let mirror = serde_json::json!({
                "osName": cfg.os_name,
                "wakeWords": cfg.wake_words,
                "computeMode": cfg.compute.mode,
                "droplet": { "enabled": cfg.droplet.enabled, "host": cfg.droplet.host },
                "privacy": { "diffuser": cfg.privacy.diffuser, "networkLock": cfg.privacy.network_lock, "killSwitch": cfg.privacy.kill_switch, "destructiveGate": cfg.privacy.destructive_gate },
                "memory": { "storage": cfg.memory.storage, "autoMonthly": cfg.memory.auto_monthly, "autoFlush": cfg.memory.auto_flush },
                "scheduler": { "profile": cfg.scheduler.profile, "tonyPriorityPct": cfg.scheduler.tony_priority_pct, "offloadPct": cfg.scheduler.offload_pct, "maxConcurrency": cfg.scheduler.max_concurrency },
                "runtime": serde_json::Value::Object(self.runtime.lock().unwrap().clone()),
                "updatedAt": now_secs(),
            });
            let _ = std::fs::write(m, mirror.to_string());
        }
        Ok(())
    }

    /// Update a live status field (e.g. droplet link) and refresh the phone mirror.
    pub fn set_runtime(&self, key: &str, value: serde_json::Value) {
        let changed = self.runtime.lock().unwrap().insert(key.into(), value.clone()) != Some(value);
        if changed {
            let _ = self.persist();
        }
    }

    pub fn record_redaction(&self, destination: &str, payload: serde_json::Value, replacements: Vec<Replacement>) {
        *self.last_redaction.lock().unwrap() = Some(RedactionRecord { at: now_secs(), destination: destination.into(), payload, replacements });
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn validate(c: &OsConfig) -> Result<(), String> {
    let name = c.os_name.trim();
    if name.is_empty() || name.len() > 32 || !name.chars().all(|ch| ch.is_alphanumeric() || ch == ' ' || ch == '-' || ch == '_') {
        return Err("OS name: 1–32 letters, digits, spaces or dashes".into());
    }
    for u in [&c.droplet.qdrant_url, &c.droplet.n8n_url, &c.droplet.model_url, &c.droplet.anythingllm_url, &c.anythingllm.base_url] {
        if !u.is_empty() && !super::dispatch::valid_url(u) {
            return Err(format!("invalid URL: {u}"));
        }
    }
    if !(10.0..=100.0).contains(&c.compute.vram_threshold_pct) {
        return Err("VRAM threshold must be 10–100 %".into());
    }
    let sc = &c.scheduler;
    if !["sequential", "hybrid", "parallel"].contains(&sc.profile.as_str()) || !(50..=100).contains(&sc.tony_priority_pct) || !(1..=8).contains(&sc.max_concurrency) || sc.offload_pct > 100 || !(2..=20).contains(&sc.history_turns) {
        return Err("scheduler: profile sequential|hybrid|parallel, Tony priority 50–100 %, 1–8 slots, offload 0–100 %, 2–20 history turns".into());
    }
    if !["claude-cli", "gemini-cli", "llm-cli", "claude-api", "gemini-api", "droplet"].contains(&sc.offload_engine.as_str()) {
        return Err("unknown offload engine".into());
    }
    if !["local", "droplet", "hybrid"].contains(&c.memory.storage.as_str()) {
        return Err("memory storage must be local, droplet or hybrid".into());
    }
    if !["chatml", "alpaca", "sharegpt"].contains(&c.memory.dataset_format.as_str()) {
        return Err("dataset format must be chatml, alpaca or sharegpt".into());
    }
    if !["claude-cli", "claude-api", "gemini-cli", "gemini-api", "droplet", "local"].contains(&c.overseer.engine.as_str()) {
        return Err("unknown overseer engine".into());
    }
    for (role, slug) in &c.anythingllm.workspaces {
        if !super::dispatch::valid_id(role) || !(slug.is_empty() || slug.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')) {
            return Err(format!("invalid workspace mapping {role} → {slug}"));
        }
    }
    let mut ids = std::collections::HashSet::new();
    for m in &c.mcps {
        if !super::dispatch::valid_id(&m.id) || !ids.insert(m.id.clone()) {
            return Err(format!("invalid or duplicate MCP id: {}", m.id));
        }
        match m.transport.as_str() {
            "builtin" => {}
            "stdio" if !m.command.trim().is_empty() => {}
            "http" if super::dispatch::valid_url(&m.url) => {}
            _ => return Err(format!("MCP {}: stdio needs a command, http needs a URL", m.name)),
        }
    }
    Ok(())
}

// ── Routing helpers used by dispatch.rs ─────────────────────────────────────

/// Host of a URL, lowercased.
pub fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase())).unwrap_or_default()
}

pub fn is_loopback_host(h: &str) -> bool {
    h == "localhost" || h == "::1" || h == "[::1]" || h.starts_with("127.") || h.ends_with(".localhost")
}

/// Leaves this machine (droplet over NetBird counts — it's someone else's disk).
pub fn is_remote(p: &Provider) -> bool {
    !is_loopback_host(&host_of(&p.base_url))
}

pub fn is_droplet(p: &Provider, os: &OsConfig) -> bool {
    p.id == "droplet" || (!os.droplet.host.is_empty() && host_of(&p.base_url) == os.droplet.host)
}

/// Apply compute mode, kill switch, droplet switch and the cloud permission to a
/// provider chain. Returns the reordered chain and a note for the UI.
pub fn shape_chain(os: &OsConfig, mut chain: Vec<Provider>, vram_pct: Option<f32>, chars: usize, pinned: bool) -> (Vec<Provider>, Vec<String>) {
    let mut notes = Vec::new();
    let before = chain.len();
    chain.retain(|p| !(is_droplet(p, os) && !os.droplet.enabled));
    if chain.len() < before {
        notes.push("droplet off (manual)".into());
    }
    let block_remote = if os.privacy.kill_switch {
        Some("kill switch on — local only")
    } else if os.compute.mode == ComputeMode::Local {
        Some("LOCAL ONLY mode")
    } else if os.permissions.cloud == Tier::Deny {
        Some("cloud routing denied")
    } else if os.permissions.cloud == Tier::Ask && !pinned {
        Some("cloud routing set to Ask — pin a remote backend to use it")
    } else {
        None
    };
    if let Some(why) = block_remote {
        let n = chain.len();
        chain.retain(|p| !is_remote(p));
        if chain.len() < n {
            notes.push(why.into());
        }
        return (chain, notes);
    }
    let remote_first = match os.compute.mode {
        ComputeMode::Cloud => {
            notes.push("CLOUD PRIORITY".into());
            true
        }
        ComputeMode::Hybrid => {
            if let Some(v) = vram_pct.filter(|v| *v >= os.compute.vram_threshold_pct) {
                notes.push(format!("VRAM {v:.0}% ≥ {:.0}% → offload", os.compute.vram_threshold_pct));
                true
            } else if chars >= os.compute.heavy_context_chars {
                notes.push(format!("heavy context ({chars} chars) → offload"));
                true
            } else {
                false
            }
        }
        ComputeMode::Local => false,
    };
    if remote_first {
        chain.sort_by_key(|p| !is_remote(p)); // stable: remote providers first
    }
    (chain, notes)
}

/// Current VRAM %, if an NVIDIA GPU is visible.
pub async fn vram_pct() -> Option<f32> {
    let gpu = tauri::async_runtime::spawn_blocking(super::system::query_gpu).await.ok().flatten()?;
    Some(gpu.vram_used_mb as f32 / gpu.vram_total_mb.max(1) as f32 * 100.0)
}

/// Enforce an OS master permission tier. Ask → `PERMISSION_REQUIRED:<what>` unless approved.
pub fn gate(bridge: &BridgeState, tier: Tier, what: &str, approved: bool, detail: serde_json::Value) -> Result<(), String> {
    let outcome = match tier {
        Tier::Deny => Err(format!("PERMISSION_DENIED:{what}")),
        Tier::Ask if !approved => Err(format!("PERMISSION_REQUIRED:{what}")),
        _ => Ok(()),
    };
    if outcome.is_err() || tier != Tier::Allow {
        bridge.log(serde_json::json!({ "type": "permission", "action": what, "decision": match &outcome { Ok(()) => "allow".to_string(), Err(e) => e.clone() }, "detail": detail }));
    }
    outcome
}

// ── OS-level secrets (not bound to a provider) ──────────────────────────────
//
// Each name maps to a fixed host in Rust, so these keys can only ever be sent
// to that service. The webview can set / check / delete, never read.

const SERVICE: &str = "agentic-os-command-center";
pub const OS_SECRETS: [&str; 7] = ["anthropic", "gemini", "brave", "twelvedata", "vault", "gateway-token", "anythingllm-remote"];

fn os_entry(name: &str) -> Result<keyring::Entry, String> {
    if !OS_SECRETS.contains(&name) {
        return Err("unknown secret".into());
    }
    keyring::Entry::new(SERVICE, &format!("os:{name}")).map_err(|e| e.to_string())
}

pub(crate) fn os_secret(name: &str) -> Option<String> {
    os_entry(name).ok()?.get_password().ok()
}

#[tauri::command]
pub fn os_secret_set(name: String, value: String) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() || v.len() > 4096 {
        return Err("value must be 1–4096 characters".into());
    }
    if name == "vault" && v.len() < 10 {
        return Err("vault password must be at least 10 characters".into());
    }
    os_entry(&name)?.set_password(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn os_secret_status() -> BTreeMap<String, bool> {
    OS_SECRETS.iter().map(|n| (n.to_string(), os_secret(n).is_some())).collect()
}

#[tauri::command]
pub fn os_secret_delete(name: String) -> Result<(), String> {
    match os_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn os_config_get(os: State<'_, OsState>) -> OsConfig {
    os.snapshot()
}

/// Shallow-merge a JSON patch (top-level sections are merged one level deep).
#[tauri::command]
pub fn os_config_update(os: State<'_, OsState>, state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, patch: serde_json::Value) -> Result<OsConfig, String> {
    let before = os.snapshot();
    let next = os.update(|cfg| {
        let mut cur = serde_json::to_value(&*cfg).map_err(|e| e.to_string())?;
        let (Some(dst), Some(src)) = (cur.as_object_mut(), patch.as_object()) else { return Err("patch must be an object".into()) };
        for (k, v) in src {
            match (dst.get_mut(k), v) {
                (Some(serde_json::Value::Object(d)), serde_json::Value::Object(s)) => {
                    for (k2, v2) in s {
                        d.insert(k2.clone(), v2.clone());
                    }
                }
                (Some(slot), _) => *slot = v.clone(),
                (None, _) => return Err(format!("unknown setting: {k}")),
            }
        }
        *cfg = serde_json::from_value(cur).map_err(|e| format!("invalid settings: {e}"))?;
        Ok(())
    })?;
    // Keep the droplet provider's endpoint in step with the droplet card.
    if next.droplet.model_url != before.droplet.model_url && !next.droplet.model_url.is_empty() {
        let url = next.droplet.model_url.clone();
        let _ = state.update(|c| {
            if let Some(p) = c.providers.iter_mut().find(|p| p.id == "droplet") {
                p.base_url = url;
            }
            Ok(())
        });
    }
    if next.privacy.kill_switch != before.privacy.kill_switch || next.compute.mode != before.compute.mode {
        bridge.log(serde_json::json!({ "type": "os-config", "killSwitch": next.privacy.kill_switch, "computeMode": next.compute.mode }));
    }
    if next.privacy.network_lock && !before.privacy.network_lock {
        ensure_gateway_token(&state);
    }
    Ok(next)
}

/// MASTER_IDENTITY.md (truncated), for the OS system prompt and Settings preview.
#[tauri::command]
pub fn os_identity(os: State<'_, OsState>) -> Result<String, String> {
    read_identity(&os.snapshot())
}

pub fn read_identity(cfg: &OsConfig) -> Result<String, String> {
    let s = std::fs::read_to_string(&cfg.identity_path).map_err(|e| format!("{}: {e}", cfg.identity_path))?;
    Ok(s.chars().take(6000).collect())
}

#[tauri::command]
pub fn privacy_last_payload(os: State<'_, OsState>) -> Option<RedactionRecord> {
    os.last_redaction.lock().unwrap().clone()
}

/// Preview what the diffuser would send (Settings → "Test the diffuser").
#[tauri::command]
pub fn privacy_preview(os: State<'_, OsState>, text: String) -> serde_json::Value {
    let mut r = super::privacy::Redactor::default();
    let red = r.redact(&text, &os.snapshot().privacy.sensitive_terms);
    serde_json::json!({ "redacted": red, "replacements": r.replacements })
}

// ── Droplet ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbe {
    id: String,
    label: String,
    url: String,
    up: bool,
    detail: String,
    latency_ms: u128,
}

async fn probe(state: &DispatchState, id: &str, label: &str, url: &str, path: &str, bearer: Option<String>) -> EndpointProbe {
    let started = std::time::Instant::now();
    if url.is_empty() {
        return EndpointProbe { id: id.into(), label: label.into(), url: url.into(), up: false, detail: "not set".into(), latency_ms: 0 };
    }
    let mut rb = state.http.get(format!("{}{path}", url.trim_end_matches('/'))).timeout(Duration::from_secs(4));
    if let Some(b) = bearer {
        rb = rb.bearer_auth(b);
    }
    let (up, detail) = match rb.send().await {
        Ok(r) if r.status().is_success() => (true, format!("{}", r.status().as_u16())),
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => (true, "reachable · auth required".into()),
        Ok(r) => (false, format!("HTTP {}", r.status().as_u16())),
        Err(e) => (false, short(e)),
    };
    EndpointProbe { id: id.into(), label: label.into(), url: url.into(), up, detail, latency_ms: started.elapsed().as_millis() }
}

/// Test & reconnect: probe every droplet endpoint (works even while the switch is off).
#[tauri::command]
pub async fn droplet_test(os: State<'_, OsState>, state: State<'_, DispatchState>) -> Result<Vec<EndpointProbe>, String> {
    let d = os.snapshot().droplet;
    let key = state.provider("droplet").and_then(|p| state.key_for(&p).ok().flatten());
    let (a, b, c, e) = (
        probe(&state, "model", "Model / proxy", &d.model_url, "/models", key),
        probe(&state, "qdrant", "Qdrant vector DB", &d.qdrant_url, "/healthz", None),
        probe(&state, "n8n", "n8n webhooks", &d.n8n_url, "/healthz", None),
        probe(&state, "anythingllm", "AnythingLLM (remote)", &d.anythingllm_url, "/api/ping", None),
    );
    Ok(vec![a.await, b.await, c.await, e.await])
}

// ── Network lock ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenFinding {
    port: u16,
    service: String,
    bind: String,
    exposed: bool,
    fix: String,
}

/// Which known service ports listen on every interface (0.0.0.0 / [::]) rather
/// than loopback or the NetBird mesh. We can't rebind other apps; we report and
/// say exactly how to fix each.
#[tauri::command]
pub async fn network_audit() -> Result<Vec<ListenFinding>, String> {
    let out = tauri::async_runtime::spawn_blocking(|| crate::proc::stdout("netstat", &["-ano", "-p", "TCP"])).await.map_err(|e| e.to_string())??;
    let known: [(u16, &str, &str); 8] = [
        (1234, "LM Studio", "LM Studio → Developer → Server settings → untick “Serve on local network”."),
        (1235, "Bionic (LM Studio)", "Server settings → untick “Serve on local network”."),
        (3001, "AnythingLLM", "AnythingLLM Desktop binds all interfaces by default — block port 3001 inbound in Windows Firewall."),
        (5678, "n8n (Docker)", "Recreate the container with -p 127.0.0.1:5678:5678."),
        (8080, "Gateway (server.py)", "Start with --host 127.0.0.1 (the default) or your NetBird IP."),
        (8178, "Whisper", "Start whisper-server with --host 127.0.0.1."),
        (8880, "Kokoro", "Recreate the container with -p 127.0.0.1:8880:8880."),
        (8888, "AnythingLLM collector", "Internal to AnythingLLM; block inbound 8888 in Windows Firewall."),
    ];
    let mut found: BTreeMap<u16, ListenFinding> = BTreeMap::new();
    for line in out.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[0] != "TCP" || cols[3] != "LISTENING" {
            continue;
        }
        let local = cols[1];
        let Some((addr, port)) = local.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        let Some((_, name, fix)) = known.iter().find(|(p, _, _)| *p == port) else { continue };
        let exposed = addr == "0.0.0.0" || addr == "[::]";
        let entry = found.entry(port).or_insert(ListenFinding { port, service: name.to_string(), bind: addr.to_string(), exposed, fix: String::new() });
        if exposed {
            entry.exposed = true;
            entry.bind = addr.to_string();
        }
        entry.fix = if entry.exposed { fix.to_string() } else { String::new() };
    }
    Ok(found.into_values().collect())
}

/// Gateway bearer token for zero-trust mode: desktop (loopback) is trusted;
/// anything else (the phone over NetBird) must present this token. Written to
/// `<repo>/data/command-center/gateway.token` for server.py (that folder is
/// gitignored). Returns true if a token exists.
pub fn ensure_gateway_token(state: &DispatchState) -> bool {
    let token = match os_secret("gateway-token") {
        Some(t) => t,
        None => {
            let t = random_token();
            if os_entry("gateway-token").and_then(|e| e.set_password(&t).map_err(|e| e.to_string())).is_err() {
                return false;
            }
            t
        }
    };
    write_token_file(state, &token);
    true
}

fn write_token_file(state: &DispatchState, token: &str) {
    let dir = PathBuf::from(state.snapshot().gateway.workdir).join("data").join("command-center");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("gateway.token"), token);
}

fn random_token() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; 32];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Make a new gateway token and show it ONCE so it can be typed into the phone.
#[tauri::command]
pub fn gateway_token_rotate(state: State<'_, DispatchState>) -> Result<String, String> {
    let t = random_token();
    os_entry("gateway-token")?.set_password(&t).map_err(|e| e.to_string())?;
    write_token_file(&state, &t);
    Ok(t)
}

/// Bearer for gateway / droplet calls when the network lock is on.
pub fn mesh_bearer(os: &OsConfig) -> Option<String> {
    if os.privacy.network_lock {
        os_secret("gateway-token")
    } else {
        None
    }
}


// ── Droplet connection manager ──────────────────────────────────────────────
//
// After a reboot the NetBird client can come up "Idle" or logged out, so the
// droplet looks dead. Every 15 s (while the droplet switch is on): probe the
// model endpoint; after two misses run `netbird up`, re-probe, and publish the
// state (`droplet-status` event + phone mirror) for the top-bar badge.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DropletLink {
    pub state: String,
    pub detail: String,
    pub latency_ms: u128,
    pub at: u64,
}

async fn droplet_probe(state: &DispatchState, url: &str) -> Result<u128, String> {
    let t0 = std::time::Instant::now();
    let r = state.http.get(format!("{}/models", url.trim_end_matches('/'))).timeout(Duration::from_secs(5)).send().await.map_err(short)?;
    // 401 = the server is there and wants its key — that's "connected".
    if r.status().is_success() || r.status().as_u16() == 401 {
        Ok(t0.elapsed().as_millis())
    } else {
        Err(format!("HTTP {}", r.status().as_u16()))
    }
}

fn netbird_up() -> String {
    match crate::proc::stdout("netbird", &["up"]) {
        Ok(o) => o.lines().last().unwrap_or("netbird up").trim().to_string(),
        Err(e) => e,
    }
}

pub async fn droplet_link_loop(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let mut misses = 0u32;
    loop {
        let os = app.state::<OsState>();
        let st = app.state::<DispatchState>();
        let cfg = os.snapshot();
        let link = if !cfg.droplet.enabled {
            misses = 0;
            DropletLink { state: "disabled".into(), detail: "switched off".into(), latency_ms: 0, at: now_secs() }
        } else {
            match droplet_probe(&st, &cfg.droplet.model_url).await {
                Ok(ms) => {
                    misses = 0;
                    DropletLink { state: "connected".into(), detail: cfg.droplet.host.clone(), latency_ms: ms, at: now_secs() }
                }
                Err(e) => {
                    misses += 1;
                    if misses >= 2 && misses % 2 == 0 {
                        // Wake the mesh, then re-check right away.
                        let out = tauri::async_runtime::spawn_blocking(netbird_up).await.unwrap_or_default();
                        let _ = app.emit("droplet-status", DropletLink { state: "reconnecting".into(), detail: out.chars().take(120).collect(), latency_ms: 0, at: now_secs() });
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        match droplet_probe(&st, &cfg.droplet.model_url).await {
                            Ok(ms) => {
                                misses = 0;
                                DropletLink { state: "connected".into(), detail: format!("{} (reconnected)", cfg.droplet.host), latency_ms: ms, at: now_secs() }
                            }
                            Err(e2) => DropletLink { state: "offline".into(), detail: format!("{e2} — netbird up tried"), latency_ms: 0, at: now_secs() },
                        }
                    } else {
                        DropletLink { state: if misses == 1 { "checking".into() } else { "offline".into() }, detail: e, latency_ms: 0, at: now_secs() }
                    }
                }
            }
        };
        let _ = app.emit("droplet-status", link.clone());
        os.set_runtime("droplet", serde_json::to_value(&link).unwrap_or_default());
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

#[tauri::command]
pub async fn droplet_link(os: State<'_, OsState>, state: State<'_, DispatchState>) -> Result<DropletLink, String> {
    let cfg = os.snapshot();
    if !cfg.droplet.enabled {
        return Ok(DropletLink { state: "disabled".into(), detail: "switched off".into(), latency_ms: 0, at: now_secs() });
    }
    Ok(match droplet_probe(&state, &cfg.droplet.model_url).await {
        Ok(ms) => DropletLink { state: "connected".into(), detail: cfg.droplet.host.clone(), latency_ms: ms, at: now_secs() },
        Err(e) => DropletLink { state: "offline".into(), detail: e, latency_ms: 0, at: now_secs() },
    })
}

#[tauri::command]
pub fn gpu_slot_view(os: State<'_, OsState>) -> super::scheduler::SlotView {
    os.slot.view()
}
