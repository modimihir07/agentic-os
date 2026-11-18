//! Live service health, model discovery, and keeping the gateway alive.
//!
//! Nodes are only shown green after a real probe answers. Before this, the
//! UI showed "configured" as if it meant "running".

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::State;

use super::dispatch::{short, DispatchState, Kind, Provider};
use super::os_core;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    id: String,
    label: String,
    kind: String,
    up: bool,
    latency_ms: u128,
    detail: String,
    /// Switched off by the user (droplet master switch / kill switch) — not a fault.
    manual: bool,
}

fn origin(base: &str) -> String {
    url::Url::parse(base).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| base.to_string())
}

/// Which URL proves a provider is alive, per kind/engine.
fn probe_url(p: &Provider) -> String {
    let base = p.base_url.trim_end_matches('/');
    match p.kind {
        Kind::AgenticOs => format!("{base}/api/status"),
        Kind::N8n => format!("{base}/healthz"),
        Kind::Tts if p.engine.as_deref() == Some("xtts") => format!("{}/speakers_list", origin(base)),
        Kind::Tts => format!("{base}/audio/voices"),
        Kind::Stt if p.engine.as_deref() == Some("whispercpp") => format!("{}/", origin(base)),
        _ => format!("{base}/models"),
    }
}

async fn probe(state: &DispatchState, osc: &os_core::OsConfig, p: Provider, timeout: Duration) -> ServiceHealth {
    let started = Instant::now();
    let kind = serde_json::to_value(p.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let off = if os_core::is_droplet(&p, osc) && !osc.droplet.enabled {
        Some("OFFLINE (MANUAL)")
    } else if osc.privacy.kill_switch && os_core::is_remote(&p) {
        Some("OFFLINE (KILL SWITCH)")
    } else if osc.compute.mode == os_core::ComputeMode::Local && os_core::is_remote(&p) && p.kind.is_chat() {
        Some("OFFLINE (LOCAL ONLY)")
    } else {
        None
    };
    if let Some(why) = off {
        return ServiceHealth { id: p.id.clone(), label: p.label.clone(), kind, up: false, latency_ms: 0, detail: why.into(), manual: true };
    }
    let eleven = p.engine.as_deref() == Some("elevenlabs");
    let url = if eleven { format!("{}/models", p.base_url.trim_end_matches('/')) } else { probe_url(&p) };
    let mut rb = state.http.get(url).timeout(timeout);
    if eleven {
        if let (Some(k), _) = super::elevenlabs::api_key(state, &p) {
            rb = rb.header("xi-api-key", k);
        }
    } else if let Ok(Some(k)) = state.key_for(&p) {
        rb = rb.bearer_auth(k);
    }
    let (up, detail) = match rb.send().await {
        Ok(r) if r.status().is_success() => (true, format!("{}", r.status().as_u16())),
        // whisper.cpp answers 404 on / in some builds but is clearly listening.
        Ok(r) if p.kind == Kind::Stt && r.status().as_u16() < 500 => (true, format!("{}", r.status().as_u16())),
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => (false, "auth failed — check API key".into()),
        Ok(r) => (false, format!("HTTP {}", r.status().as_u16())),
        Err(e) => (false, short(e)),
    };
    ServiceHealth {
        id: p.id.clone(),
        label: p.label.clone(),
        kind,
        up,
        latency_ms: started.elapsed().as_millis(),
        detail,
        manual: false,
    }
}

/// Every configured service (integrations excluded) with the gateway (server.py) first.
fn targets(cfg: &super::dispatch::Config) -> Vec<Provider> {
    let mut targets: Vec<Provider> = cfg.providers.iter().filter(|p| p.kind != Kind::Integration).cloned().collect();
    // The gateway (server.py) as its own node — it is the sync hub for the phone.
    let mut gw = targets.iter().find(|p| p.kind == Kind::AgenticOs).cloned().unwrap_or_else(|| Provider {
        id: String::new(),
        label: String::new(),
        kind: Kind::AgenticOs,
        base_url: String::new(),
        model: String::new(),
        needs_key: false,
        voice: None,
        engine: None,
        language: None,
        models_dir: None,
        voices_dir: None,
        stt_prompt: None,
        custom: false,
    });
    gw.id = "gateway".into();
    gw.label = "Gateway (server.py)".into();
    gw.base_url = cfg.gateway.url.clone();
    targets.insert(0, gw);
    targets
}

/// Probe every configured service plus the gateway, concurrently.
#[tauri::command]
pub async fn services_health(state: State<'_, DispatchState>, os: State<'_, os_core::OsState>) -> Result<Vec<ServiceHealth>, String> {
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let futs = targets(&cfg).into_iter().map(|p| probe(&state, &osc, p, Duration::from_secs(4)));
    let mut out = Vec::new();
    for f in futs {
        out.push(f);
    }
    let res = futures_join(out).await;
    *LAST_HEALTH.lock().unwrap() = Some((os_core::now_secs(), res.clone()));
    Ok(res)
}

/// The most recent `services_health` result, so snapshots (dev task queue, System Map)
/// can describe the services without probing again. Memory only.
static LAST_HEALTH: std::sync::Mutex<Option<(u64, Vec<ServiceHealth>)>> = std::sync::Mutex::new(None);

/// `(unix secs of the probe, entries as JSON)` from the last `services_health` call, if any.
pub(crate) fn cached_health() -> Option<(u64, Vec<serde_json::Value>)> {
    let g = LAST_HEALTH.lock().unwrap();
    let (at, list) = g.as_ref()?;
    Some((*at, list.iter().filter_map(|h| serde_json::to_value(h).ok()).collect()))
}

/// LM Studio's out-of-the-box port. Probed as its own node when no provider already
/// points at it, so a second LM Studio server (or a stale default) shows up honestly.
const LMSTUDIO_DEFAULT_PORT: u16 = 1234;

fn port_of(url: &str) -> Option<u16> {
    url::Url::parse(url).ok()?.port_or_known_default()
}

/// The local (loopback) services only, each probed once (`timeout` each, all
/// concurrently), with its port: the System Map's `services` block. Remote nodes
/// (droplet, cloud TTS) are left out — they have their own monitors.
pub(crate) async fn probe_local(state: &DispatchState, osc: &os_core::OsConfig, timeout: Duration) -> Vec<serde_json::Value> {
    let cfg = state.snapshot();
    let mut seen = std::collections::HashSet::new();
    let mut list: Vec<Provider> = targets(&cfg).into_iter().filter(|p| !os_core::is_remote(p) && seen.insert(probe_url(p))).collect();
    let lm = list.iter().find(|p| p.id == "lmstudio" || p.id == cfg.policy.primary_local).cloned();
    if let Some(mut extra) = lm {
        if !list.iter().any(|p| port_of(&p.base_url) == Some(LMSTUDIO_DEFAULT_PORT)) {
            if let Ok(mut u) = url::Url::parse(&extra.base_url) {
                if u.set_port(Some(LMSTUDIO_DEFAULT_PORT)).is_ok() {
                    extra.id = format!("{}-{LMSTUDIO_DEFAULT_PORT}", extra.id);
                    extra.label = format!("{} (default port :{LMSTUDIO_DEFAULT_PORT})", extra.label);
                    extra.base_url = u.to_string();
                    extra.needs_key = false;
                    list.push(extra);
                }
            }
        }
    }
    let ports: Vec<Option<u16>> = list.iter().map(|p| port_of(&p.base_url)).collect();
    let res = futures_join(list.into_iter().map(|p| probe(state, osc, p, timeout)).collect()).await;
    res.into_iter()
        .zip(ports)
        .filter_map(|(h, port)| {
            let mut v = serde_json::to_value(h).ok()?;
            v["port"] = serde_json::json!(port);
            Some(v)
        })
        .collect()
}

/// Minimal join_all without pulling in the `futures` crate.
async fn futures_join<F: std::future::Future<Output = ServiceHealth>>(futs: Vec<F>) -> Vec<ServiceHealth> {
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut results: Vec<Option<ServiceHealth>> = vec![None; pinned.len()];
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (i, f) in pinned.iter_mut().enumerate() {
            if results[i].is_none() {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => results[i] = Some(v),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(())
        }
    })
    .await;
    results.into_iter().flatten().collect()
}

pub const WHISPER_VARIANTS: [&str; 10] = ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v3", "large-v3-turbo"];

/// Models a provider can switch to (feeds the Settings dropdowns).
#[tauri::command]
pub async fn provider_models(state: State<'_, DispatchState>, id: String) -> Result<Vec<String>, String> {
    let p = state.provider(&id).ok_or("unknown provider")?;
    match p.kind {
        // Only the CLIs actually installed (the gateway resolves .cmd/.exe shims).
        Kind::AgenticOs => Ok(["opencode", "claude", "gemini", "llm", "agy"].iter().filter(|n| super::clihub::resolve(n).is_some()).map(|n| n.to_string()).collect()),
        Kind::Stt if p.engine.as_deref() == Some("whispercpp") => {
            // Variants with a model file present (if modelsDir is set), else the standard list.
            if let Some(dir) = p.models_dir.as_deref() {
                let have: Vec<String> = WHISPER_VARIANTS
                    .iter()
                    .filter(|v| std::path::Path::new(dir).join(format!("ggml-{v}.bin")).exists())
                    .map(|v| v.to_string())
                    .collect();
                if !have.is_empty() {
                    return Ok(have);
                }
            }
            Ok(WHISPER_VARIANTS.iter().map(|v| v.to_string()).collect())
        }
        // Live list (Part 3), falling back to the static MODELS on any failure (no key, offline…).
        Kind::Tts if p.engine.as_deref() == Some("elevenlabs") => match super::elevenlabs::list_models(&state, &p).await {
            Ok(ids) if !ids.is_empty() => Ok(ids),
            _ => Ok(super::elevenlabs::MODELS.iter().map(|m| m.to_string()).collect()),
        },
        Kind::Tts | Kind::N8n | Kind::Integration => Ok(vec![]),
        _ => {
            let mut rb = state.http.get(format!("{}/models", p.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(5));
            if let Some(k) = state.key_for(&p)? {
                rb = rb.bearer_auth(k);
            }
            let body: serde_json::Value = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.json().await.map_err(short)?;
            let mut ids: Vec<String> = body["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect();
            if p.kind == Kind::Stt && ids.is_empty() {
                ids = WHISPER_VARIANTS.iter().map(|v| v.to_string()).collect();
            }
            Ok(ids)
        }
    }
}

// ── Gateway (server.py) ──────────────────────────────────────────────────────

async fn gateway_up(state: &DispatchState, url: &str) -> bool {
    state
        .http
        .get(format!("{}/api/status", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    up: bool,
    started: bool,
    url: String,
    detail: String,
}

impl GatewayStatus {
    pub fn is_up(&self) -> bool {
        self.up
    }
}

/// Make sure the gateway is running: probe it, and if it's down (and
/// `gateway.autostart` is on), launch it from providers.json → `gateway`.
/// The command line comes ONLY from that file, never from the webview.
#[tauri::command]
pub async fn gateway_ensure(state: State<'_, DispatchState>) -> Result<GatewayStatus, String> {
    let gw = state.snapshot().gateway;
    if gateway_up(&state, &gw.url).await {
        return Ok(GatewayStatus { up: true, started: false, url: gw.url, detail: "running".into() });
    }
    if !gw.autostart {
        return Ok(GatewayStatus { up: false, started: false, url: gw.url, detail: "down (autostart off)".into() });
    }
    let workdir = std::path::PathBuf::from(&gw.workdir);
    if !workdir.join("server.py").exists() {
        return Ok(GatewayStatus {
            up: false,
            started: false,
            url: gw.url,
            detail: format!("server.py not found in {} — set gateway.workdir in providers.json", workdir.display()),
        });
    }
    let mut cmd = std::process::Command::new(&gw.command);
    cmd.args(&gw.args).current_dir(&workdir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().map_err(|e| format!("could not start gateway ({}): {e}", gw.command))?;
    for _ in 0..30 {
        tokio_sleep(Duration::from_millis(500)).await;
        if gateway_up(&state, &gw.url).await {
            return Ok(GatewayStatus { up: true, started: true, url: gw.url, detail: "started".into() });
        }
    }
    Ok(GatewayStatus { up: false, started: true, url: gw.url, detail: "launched but not answering yet — check Python deps".into() })
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

// ── Local model fit guard ────────────────────────────────────────────────────
//
// Bionic / LM Studio auto-load ("JIT") uses the model's saved defaults — for
// qwen3.5-9b that was a 123k context × 4 slots, which overflows the 12 GB card
// into system RAM and makes every answer crawl. Every 5 minutes: if the primary
// local model is loaded with more than FIT_CTX context, reload it at FIT_CTX.

const FIT_CTX: u64 = 32_768;

pub async fn local_fit_once(state: &DispatchState) -> Option<String> {
    let cfg = state.snapshot();
    let p = cfg.providers.iter().find(|p| p.id == cfg.policy.primary_local || p.id == "lmstudio")?.clone();
    let api = format!("{}/api/v1/models", origin(&p.base_url));
    let v: serde_json::Value = state.http.get(&api).timeout(Duration::from_secs(5)).send().await.ok()?.json().await.ok()?;
    let m = v["models"].as_array()?.iter().find(|m| m["key"].as_str() == Some(p.model.as_str()))?.clone();
    let inst = m["loaded_instances"].as_array()?.first()?.clone();
    let ctx = inst["config"]["context_length"].as_u64()?;
    if ctx <= FIT_CTX {
        return None;
    }
    let id = inst["id"].as_str()?.to_string();
    let base = origin(&p.base_url);
    state.http.post(format!("{base}/api/v1/models/unload")).json(&serde_json::json!({ "instance_id": id })).timeout(Duration::from_secs(60)).send().await.ok()?;
    let r = state
        .http
        .post(format!("{base}/api/v1/models/load"))
        .json(&serde_json::json!({ "model": p.model, "context_length": FIT_CTX, "flash_attention": true, "parallel": 2, "offload_kv_cache_to_gpu": true }))
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .ok()?;
    Some(format!("reloaded {} from {ctx} to {FIT_CTX} context (HTTP {})", p.model, r.status().as_u16()))
}

pub async fn local_fit_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    use super::introspect::loop_ran;
    loop {
        match whisper_ensure(&app.state::<DispatchState>()).await {
            Some(msg) => {
                eprintln!("[whisper] {msg}");
                loop_ran("whisper", msg.starts_with("started"), &msg);
            }
            None => loop_ran("whisper", true, "nothing to do (already up, or STT isn't a local whisper.cpp)"),
        }
        match local_fit_once(&app.state::<DispatchState>()).await {
            Some(msg) => {
                eprintln!("[fit] {msg}");
                loop_ran("local-fit", true, &msg);
            }
            None => loop_ran("local-fit", true, "nothing to do (fits, or the model isn't loaded / LM Studio is down)"),
        }
        tokio_sleep(Duration::from_secs(300)).await;
    }
}

// ── Whisper keep-alive ───────────────────────────────────────────────────────
//
// whisper.cpp runs as a plain process (not a service), so it was gone after
// every reboot ("cannot connect to whisper"). At launch and every 5 minutes:
// if the STT provider is a local whisper.cpp server and its port is closed,
// start it from C:\whisper\bin with ggml-<model>.bin from the provider's
// modelsDir. Paths come only from providers.json / these constants.

const WHISPER_EXE: &str = r"C:\whisper\bin\whisper-server.exe";

pub async fn whisper_ensure(state: &DispatchState) -> Option<String> {
    let cfg = state.snapshot();
    let p = cfg.providers.iter().find(|p| p.id == cfg.policy.stt && p.kind == Kind::Stt && p.engine.as_deref() == Some("whispercpp"))?.clone();
    let url = url::Url::parse(&p.base_url).ok()?;
    let host = url.host_str()?.to_string();
    if !(host == "127.0.0.1" || host == "localhost") {
        return None;
    }
    let port = url.port_or_known_default()?;
    if std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().ok()?, Duration::from_millis(400)).is_ok() {
        return None; // already up
    }
    let exe = std::path::PathBuf::from(WHISPER_EXE);
    let dir = std::path::PathBuf::from(p.models_dir.clone().unwrap_or_else(|| r"C:\whisper\models".into()));
    let mut model = dir.join(format!("ggml-{}.bin", p.model));
    if !model.exists() {
        // Fall back to any ggml model in the folder.
        model = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find(|f| f.extension().is_some_and(|x| x == "bin") && f.file_name().is_some_and(|n| n.to_string_lossy().starts_with("ggml-")))?;
    }
    if !exe.exists() {
        return Some(format!("whisper not installed ({WHISPER_EXE} missing)"));
    }
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(2, 8)).unwrap_or(4).to_string();
    let log = std::fs::File::create(r"C:\whisper\server.log").ok();
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["-m", &model.display().to_string(), "--host", "127.0.0.1", "--port", &port.to_string(), "--inference-path", "/v1/audio/transcriptions", "-t", &threads])
        .current_dir(r"C:\whisper")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());
    match log {
        Some(f) => cmd.stderr(f),
        None => cmd.stderr(std::process::Stdio::null()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_0008); // no window, detached
    }
    match cmd.spawn() {
        Ok(_) => Some(format!("started whisper on :{port} ({})", model.file_name()?.to_string_lossy())),
        Err(e) => Some(format!("could not start whisper: {e}")),
    }
}

/// Keep the ElevenLabs HTTPS connection warm (a free GET /models every 60 s) so
/// Tony's first spoken sentence doesn't pay a ~1 s TLS handshake.
pub async fn tts_warm_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    loop {
        {
            let st = app.state::<DispatchState>();
            let os = app.state::<super::os_core::OsState>();
            let cfg = st.snapshot();
            if !os.snapshot().privacy.kill_switch {
                if let Some(p) = cfg.providers.iter().find(|p| p.id == cfg.policy.tts && p.engine.as_deref() == Some("elevenlabs")).cloned() {
                    if let (Some(key), _) = super::elevenlabs::api_key(&st, &p) {
                        let _ = st.http.get(format!("{}/models", p.base_url.trim_end_matches('/'))).header("xi-api-key", key).timeout(Duration::from_secs(5)).send().await;
                    }
                }
            }
        }
        tokio_sleep(Duration::from_secs(60)).await;
    }
}
