//! n8n multi-session pipeline telemetry + Google Drive sync.
//!
//! * Instances = providers of kind `n8n` (local Docker + remote droplets).
//!   Each is polled through the n8n public REST API (`/api/v1/workflows`,
//!   `/api/v1/executions`) with the instance's API key (keychain slot "api",
//!   sent as `X-N8N-API-KEY`). Status pings that n8n workflows POST to the
//!   gateway (`/api/cc/n8n/ping`) are merged in, so "running" shows live.
//! * Every network call has a hard 3 s timeout and every instance is polled
//!   concurrently; an unreachable n8n/Docker yields an `offline` badge, never a
//!   hang or an unhandled error.
//! * Run / Active-Pause / Drive sync all pass through the Permission Bridge
//!   (Execute + Network) and are written to `training_logs/`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

use super::bridge::{Actor, BridgeState, Scope};
use super::dispatch::{valid_url, DispatchState, Kind, PipelinesConfig, Provider};
use super::secrets;

const NET_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_FILE_INLINE: u64 = 1024 * 1024; // files above 1 MB are sent as metadata only
const MAX_PAYLOAD_INLINE: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 2000;

#[derive(Default)]
pub struct PipelineState {
    last_sync: RwLock<Option<SyncResult>>,
    syncing: Mutex<bool>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn api_base(p: &Provider) -> String {
    let b = p.base_url.trim_end_matches('/');
    if b.ends_with("/api/v1") {
        b.to_string()
    } else {
        format!("{b}/api/v1")
    }
}

fn origin_of(p: &Provider) -> String {
    api_base(p).trim_end_matches("/api/v1").to_string()
}

fn instances(state: &DispatchState) -> Vec<Provider> {
    state.snapshot().providers.into_iter().filter(|p| p.kind == Kind::N8n).collect()
}

fn short(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout (3 s)".into()
    } else if e.is_connect() {
        "offline".into()
    } else if let Some(s) = e.status() {
        format!("HTTP {s}")
    } else {
        e.without_url().to_string()
    }
}

async fn get_json(state: &DispatchState, url: &str, key: Option<&str>) -> Result<serde_json::Value, (Option<u16>, String)> {
    let mut rb = state.http.get(url).timeout(NET_TIMEOUT);
    if let Some(k) = key {
        rb = rb.header("X-N8N-API-KEY", k);
    }
    let res = rb.send().await.map_err(|e| (e.status().map(|s| s.as_u16()), short(e)))?;
    let code = res.status().as_u16();
    if !res.status().is_success() {
        return Err((Some(code), format!("HTTP {code}")));
    }
    res.json().await.map_err(|e| (Some(code), short(e)))
}

// ── Status ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStatus {
    workflow_id: String,
    name: String,
    instance_id: String,
    instance_label: String,
    is_active: bool,
    /// success | error | running | idle
    last_status: String,
    /// ISO-8601 of the last execution start, if any.
    last_run_timestamp: Option<String>,
    duration_ms: Option<i64>,
    /// Has a Webhook trigger, so "Run" can fire it.
    runnable: bool,
    tags: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatus {
    id: String,
    label: String,
    base_url: String,
    /// online | offline | unauthorized | no-key | error
    status: String,
    detail: String,
    latency_ms: u128,
    has_api_key: bool,
    workflows: Vec<WorkflowStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelinesView {
    online: bool,
    active_sessions: usize,
    running: usize,
    instances: Vec<InstanceStatus>,
    poll_interval_seconds: u64,
    last_sync: Option<SyncResult>,
    polled_at: u64,
}

fn map_status(s: &str) -> &'static str {
    match s {
        "success" => "success",
        "error" | "crashed" | "failed" => "error",
        "running" | "new" | "waiting" => "running",
        _ => "idle",
    }
}

fn parse_ms(iso: &str) -> Option<i64> {
    // RFC-3339 "2026-11-16T23:02:04.174Z" → epoch ms (UTC), no date crate needed.
    let (date, time) = iso.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let t = time.trim_end_matches('Z');
    let t = t.split(['+']).next()?;
    let mut parts = t.split(':');
    let (hh, mm) = (parts.next()?.parse::<i64>().ok()?, parts.next()?.parse::<i64>().ok()?);
    let ss: f64 = parts.next().unwrap_or("0").parse().ok()?;
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + hh * 3_600_000 + mm * 60_000 + (ss * 1000.0) as i64)
}

pub(crate) async fn poll_instance(state: &DispatchState, p: Provider, pings: &HashMap<String, serde_json::Value>) -> InstanceStatus {
    let started = Instant::now();
    let key = secrets::get_slot(state, &p.id, "api");
    let mut out = InstanceStatus {
        id: p.id.clone(),
        label: p.label.clone(),
        base_url: p.base_url.clone(),
        status: "offline".into(),
        detail: String::new(),
        latency_ms: 0,
        has_api_key: key.is_some(),
        workflows: vec![],
    };

    // Reachability first (healthz needs no key) so "offline" and "no key" differ.
    match get_json(state, &format!("{}/healthz", origin_of(&p)), None).await {
        Ok(_) => {}
        Err((_, e)) => {
            out.detail = e;
            out.latency_ms = started.elapsed().as_millis();
            return out;
        }
    }
    let Some(key) = key else {
        out.status = "no-key".into();
        out.detail = "n8n is up — add its API key (n8n → Settings → n8n API) to see workflows".into();
        out.latency_ms = started.elapsed().as_millis();
        return out;
    };

    let base = api_base(&p);
    let wf_url = format!("{base}/workflows?limit=250");
    let ex_url = format!("{base}/executions?limit=100");
    let (wfs, exs) = join2(get_json(state, &wf_url, Some(&key)), get_json(state, &ex_url, Some(&key))).await;
    out.latency_ms = started.elapsed().as_millis();
    let wfs = match wfs {
        Ok(v) => v,
        Err((Some(401 | 403), _)) => {
            out.status = "unauthorized".into();
            out.detail = "API key rejected".into();
            return out;
        }
        Err((_, e)) => {
            out.status = "error".into();
            out.detail = e;
            return out;
        }
    };

    // Latest execution per workflow.
    let mut latest: HashMap<String, (i64, String, Option<i64>, String)> = HashMap::new();
    if let Ok(exs) = exs {
        for e in exs["data"].as_array().into_iter().flatten() {
            let wid = e["workflowId"].as_str().map(String::from).or_else(|| e["workflowId"].as_i64().map(|n| n.to_string()));
            let (Some(wid), Some(start)) = (wid, e["startedAt"].as_str()) else { continue };
            let Some(start_ms) = parse_ms(start) else { continue };
            let stop_ms = e["stoppedAt"].as_str().and_then(parse_ms);
            let status = e["status"].as_str().unwrap_or(if e["finished"].as_bool() == Some(true) { "success" } else { "running" });
            if latest.get(&wid).is_none_or(|l| start_ms > l.0) {
                latest.insert(wid, (start_ms, map_status(status).to_string(), stop_ms.map(|s| s - start_ms), start.to_string()));
            }
        }
    }

    for w in wfs["data"].as_array().into_iter().flatten() {
        let id = w["id"].as_str().map(String::from).or_else(|| w["id"].as_i64().map(|n| n.to_string())).unwrap_or_default();
        let runnable = w["nodes"].as_array().into_iter().flatten().any(|n| n["type"].as_str() == Some("n8n-nodes-base.webhook"));
        let (mut last_status, mut ts, mut dur) = match latest.get(&id) {
            Some((_, s, d, iso)) => (s.clone(), Some(iso.clone()), *d),
            None => ("idle".to_string(), None, None),
        };
        // A newer webhook ping (sent by the workflow itself) wins — that's how "running" shows live.
        if let Some(ping) = pings.get(&id) {
            let ping_at = ping["at"].as_f64().map(|s| (s * 1000.0) as i64).unwrap_or(0);
            let exec_at = latest.get(&id).map(|l| l.0).unwrap_or(0);
            if ping_at > exec_at {
                last_status = map_status(ping["status"].as_str().unwrap_or("running")).to_string();
                ts = ping["iso"].as_str().map(String::from).or(ts);
                dur = ping["durationMs"].as_i64().or(dur);
            }
        }
        out.workflows.push(WorkflowStatus {
            workflow_id: id,
            name: w["name"].as_str().unwrap_or("(unnamed)").to_string(),
            instance_id: p.id.clone(),
            instance_label: p.label.clone(),
            is_active: w["active"].as_bool().unwrap_or(false),
            last_status,
            last_run_timestamp: ts,
            duration_ms: dur,
            runnable,
            tags: w["tags"].as_array().into_iter().flatten().filter_map(|t| t["name"].as_str().map(String::from)).collect(),
        });
    }
    out.workflows.sort_by(|a, b| b.is_active.cmp(&a.is_active).then(a.name.cmp(&b.name)));
    out.status = "online".into();
    out.detail = format!("{} workflows", out.workflows.len());
    out
}

/// Pings that workflows POSTed to the gateway (best-effort, 3 s).
async fn fetch_pings(state: &DispatchState) -> HashMap<String, serde_json::Value> {
    let url = format!("{}/api/cc/n8n/pings", state.snapshot().gateway.url.trim_end_matches('/'));
    match get_json(state, &url, None).await {
        Ok(v) => v["pings"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

#[tauri::command]
pub async fn pipelines_status(state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, pipes: State<'_, PipelineState>) -> Result<PipelinesView, String> {
    // Polls are frequent; only denials are logged (see bridge.check), so the
    // training log captures decisions, not noise.
    bridge.check_quiet("pipelines.poll", &[Scope::Read, Scope::Network], Actor::User)?;
    let pings = fetch_pings(&state).await;
    let mut futs = Vec::new();
    for p in instances(&state) {
        futs.push(poll_instance(&state, p, &pings));
    }
    let instances = join_all(futs).await;
    let online = instances.iter().any(|i| i.status == "online" || i.status == "no-key" || i.status == "unauthorized");
    Ok(PipelinesView {
        online,
        active_sessions: instances.iter().flat_map(|i| &i.workflows).filter(|w| w.is_active).count(),
        running: instances.iter().flat_map(|i| &i.workflows).filter(|w| w.last_status == "running").count(),
        poll_interval_seconds: state.snapshot().pipelines.poll_interval_seconds,
        last_sync: pipes.last_sync.read().unwrap().clone(),
        polled_at: now_ms(),
        instances,
    })
}

// ── Run / Active-Pause ───────────────────────────────────────────────────────

fn instance(state: &DispatchState, id: &str) -> Result<Provider, String> {
    state.provider(id).filter(|p| p.kind == Kind::N8n).ok_or_else(|| "unknown n8n instance".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// completed | dispatched | error
    status: String,
    http_status: Option<u16>,
    latency_ms: u128,
    detail: String,
}

/// Fire a workflow through its own Webhook trigger (n8n's public API has no
/// generic "run" endpoint). A webhook that takes longer than 3 s to answer is
/// reported as `dispatched` — it's running; the next poll shows the outcome.
#[tauri::command]
pub async fn pipeline_run(state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, instance_id: String, workflow_id: String, approved: Option<bool>) -> Result<RunResult, String> {
    let p = instance(&state, &instance_id)?;
    let detail = serde_json::json!({ "instance": p.label, "workflowId": workflow_id });
    bridge.check("n8n.run", &[Scope::Execute, Scope::Network], approved.unwrap_or(false), Actor::User, false, detail.clone())?;
    let key = secrets::get_slot(&state, &p.id, "api").ok_or("add this instance's n8n API key first")?;
    let wf = get_json(&state, &format!("{}/workflows/{}", api_base(&p), urlenc(&workflow_id)), Some(&key)).await.map_err(|(_, e)| e)?;
    if wf["active"].as_bool() != Some(true) {
        return Err("workflow is paused — activate it first (production webhooks only run when active)".into());
    }
    let hook = wf["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|n| n["type"].as_str() == Some("n8n-nodes-base.webhook"))
        .ok_or("no Webhook trigger in this workflow — add one to make it runnable from here")?;
    let path = hook["parameters"]["path"].as_str().or(hook["webhookId"].as_str()).ok_or("webhook has no path")?;
    if path.contains("://") || path.contains("..") {
        return Err("refusing odd webhook path".into());
    }
    let method = hook["parameters"]["httpMethod"].as_str().unwrap_or("GET").to_uppercase();
    let url = format!("{}/webhook/{}", origin_of(&p), path.trim_start_matches('/'));
    let started = Instant::now();
    let body = serde_json::json!({ "source": "jarvis-command-center", "triggeredAt": now_ms(), "workflowId": workflow_id });
    let req = match method.as_str() {
        "POST" => state.http.post(&url).json(&body),
        "PUT" => state.http.put(&url).json(&body),
        _ => state.http.get(&url),
    };
    let res = req.timeout(NET_TIMEOUT).send().await;
    let result = match res {
        Ok(r) => RunResult {
            status: if r.status().is_success() { "completed" } else { "error" }.into(),
            http_status: Some(r.status().as_u16()),
            latency_ms: started.elapsed().as_millis(),
            detail: format!("{method} webhook → HTTP {}", r.status().as_u16()),
        },
        Err(e) if e.is_timeout() => RunResult { status: "dispatched".into(), http_status: None, latency_ms: 3000, detail: "still running after 3 s (webhook responds on completion)".into() },
        Err(e) => RunResult { status: "error".into(), http_status: None, latency_ms: started.elapsed().as_millis(), detail: short(e) },
    };
    bridge.log(serde_json::json!({
        "type": "dispatch", "upstream": "user", "downstream": format!("n8n:{}/{}", p.id, workflow_id),
        "action": "n8n.run", "input": { "method": method }, "outcome": result.status, "verification": result.detail, "latencyMs": result.latency_ms as u64,
    }));
    Ok(result)
}

#[tauri::command]
pub async fn pipeline_set_active(state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, instance_id: String, workflow_id: String, active: bool, approved: Option<bool>) -> Result<bool, String> {
    let p = instance(&state, &instance_id)?;
    let detail = serde_json::json!({ "instance": p.label, "workflowId": workflow_id, "active": active });
    bridge.check("n8n.toggle", &[Scope::Execute, Scope::Network], approved.unwrap_or(false), Actor::User, false, detail)?;
    let key = secrets::get_slot(&state, &p.id, "api").ok_or("add this instance's n8n API key first")?;
    let url = format!("{}/workflows/{}/{}", api_base(&p), urlenc(&workflow_id), if active { "activate" } else { "deactivate" });
    let started = Instant::now();
    let res = state.http.post(&url).header("X-N8N-API-KEY", key).timeout(NET_TIMEOUT).send().await.map_err(short)?;
    let ok = res.status().is_success();
    let code = res.status().as_u16();
    // Verify by reading back, so the log records the real resulting state.
    let after = get_json(&state, &format!("{}/workflows/{}", api_base(&p), urlenc(&workflow_id)), secrets::get_slot(&state, &p.id, "api").as_deref())
        .await
        .ok()
        .and_then(|w| w["active"].as_bool());
    bridge.log(serde_json::json!({
        "type": "dispatch", "upstream": "user", "downstream": format!("n8n:{}/{}", p.id, workflow_id),
        "action": if active { "n8n.activate" } else { "n8n.deactivate" }, "outcome": if ok { "ok" } else { "error" },
        "verification": { "httpStatus": code, "activeAfter": after }, "latencyMs": started.elapsed().as_millis() as u64,
    }));
    if !ok {
        return Err(format!("n8n refused: HTTP {code}"));
    }
    Ok(after.unwrap_or(active))
}

fn urlenc(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

// ── Settings ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelinesSettings {
    #[serde(flatten)]
    config: PipelinesConfig,
    instances: Vec<InstanceInfo>,
    resolved_paths: Vec<TrackedPath>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    id: String,
    label: String,
    base_url: String,
    has_api_key: bool,
    custom: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPath {
    path: String,
    exists: bool,
}

fn settings_view(state: &DispatchState) -> PipelinesSettings {
    let cfg = state.snapshot();
    PipelinesSettings {
        instances: instances(state)
            .into_iter()
            .map(|p| InstanceInfo { has_api_key: secrets::get_slot(state, &p.id, "api").is_some(), id: p.id, label: p.label, base_url: p.base_url, custom: p.custom })
            .collect(),
        resolved_paths: resolve_tracked(state, &cfg.pipelines.gdrive_tracked_paths)
            .into_iter()
            .map(|(_, p)| TrackedPath { exists: p.exists(), path: p.to_string_lossy().into_owned() })
            .collect(),
        config: cfg.pipelines,
    }
}

#[tauri::command]
pub fn pipelines_settings(state: State<'_, DispatchState>) -> PipelinesSettings {
    settings_view(&state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelinesPatch {
    poll_interval_seconds: Option<u64>,
    gdrive_sync_webhook_url: Option<String>,
    gdrive_tracked_paths: Option<Vec<String>>,
    auto_sync_enabled: Option<bool>,
    auto_sync_hours: Option<f64>,
    sync_on_exit: Option<bool>,
}

#[tauri::command]
pub fn pipelines_settings_update(state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, patch: PipelinesPatch, approved: Option<bool>) -> Result<PipelinesSettings, String> {
    // Switching auto-sync ON is the standing consent for unattended Drive uploads.
    if patch.auto_sync_enabled == Some(true) {
        bridge.check("gdrive.autosync.enable", &[Scope::Execute, Scope::Network], approved.unwrap_or(false), Actor::User, false, serde_json::Value::Null)?;
    }
    state.update(|cfg| {
        let p = &mut cfg.pipelines;
        if let Some(v) = patch.poll_interval_seconds {
            p.poll_interval_seconds = v;
        }
        if let Some(v) = patch.gdrive_sync_webhook_url {
            p.gdrive_sync_webhook_url = v.trim().to_string();
        }
        if let Some(v) = patch.gdrive_tracked_paths {
            p.gdrive_tracked_paths = v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        }
        if let Some(v) = patch.auto_sync_enabled {
            p.auto_sync_enabled = v;
        }
        if let Some(v) = patch.auto_sync_hours {
            p.auto_sync_hours = v;
        }
        if let Some(v) = patch.sync_on_exit {
            p.sync_on_exit = v;
        }
        Ok(())
    })?;
    Ok(settings_view(&state))
}

/// Add a remote n8n instance (e.g. on the droplet over NetBird).
#[tauri::command]
pub fn n8n_instance_add(state: State<'_, DispatchState>, label: String, base_url: String) -> Result<PipelinesSettings, String> {
    let base = base_url.trim().trim_end_matches('/').trim_end_matches("/api/v1").to_string();
    if !valid_url(&base) {
        return Err("base URL must be http(s)".into());
    }
    let slug: String = label.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').chars().take(30).collect();
    let id = format!("n8n-{}", if slug.is_empty() { "remote" } else { &slug });
    state.update(|cfg| {
        if cfg.providers.iter().any(|p| p.id == id) {
            return Err("an instance with that name exists".into());
        }
        cfg.providers.push(Provider {
            id: id.clone(),
            label: label.trim().chars().take(60).collect(),
            kind: Kind::N8n,
            base_url: base.clone(),
            model: "-".into(),
            needs_key: false,
            voice: None,
            engine: None,
            language: None,
            models_dir: None,
            voices_dir: None,
            stt_prompt: None,
            custom: true,
        });
        Ok(())
    })?;
    Ok(settings_view(&state))
}

// ── Google Drive sync ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// synced | up-to-date | failed | offline | not-configured | busy
    status: String,
    at: u64,
    files: usize,
    bytes: u64,
    skipped_large: usize,
    detail: String,
    trigger: String,
}

type Manifest = BTreeMap<String, (u64, u64)>; // path → (size, mtime secs)

fn resolve_tracked(state: &DispatchState, paths: &[String]) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for p in paths {
        if p == "@os-config" {
            if let Some(dir) = state.config_dir() {
                out.push(("os-config".into(), dir.join("providers.json")));
                out.push(("os-config".into(), dir.join("permissions.json")));
            }
            let repo = PathBuf::from(state.snapshot().gateway.workdir);
            out.push(("os-config".into(), repo.join("data").join("command-center").join("config.json")));
            out.push(("os-config".into(), repo.join("data").join("settings.json")));
            // Config files only — secrets live in the keychain and are never included.
        } else {
            let pb = PathBuf::from(p);
            let label = pb.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| "root".into());
            out.push((label, pb));
        }
    }
    out
}

fn walk(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if out.len() >= MAX_FILES || depth > 8 {
        return;
    }
    if root.is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "__pycache__" {
            continue;
        }
        walk(&e.path(), out, depth + 1);
    }
}

fn manifest_path(state: &DispatchState) -> Option<PathBuf> {
    state.config_dir().map(|d| d.join("gdrive-manifest.json"))
}

fn last_sync_path(state: &DispatchState) -> Option<PathBuf> {
    state.config_dir().map(|d| d.join("gdrive-last-sync.json"))
}

pub fn load_last_sync(state: &DispatchState, pipes: &PipelineState) {
    if let Some(p) = last_sync_path(state) {
        if let Ok(t) = std::fs::read_to_string(p) {
            if let Ok(r) = serde_json::from_str::<SyncResult>(&t) {
                *pipes.last_sync.write().unwrap() = Some(r);
            }
        }
    }
}

/// Package changed files from the tracked paths and POST them to the Drive
/// sync webhook. The manifest only advances after n8n accepts the payload,
/// so a failed or offline sync is simply retried next time.
pub async fn run_gdrive_sync(state: &DispatchState, bridge: &BridgeState, pipes: &PipelineState, actor: Actor, approved: bool, trigger: &str) -> Result<SyncResult, String> {
    let cfg = state.snapshot().pipelines;
    let pre_consented = actor == Actor::Scheduler && cfg.auto_sync_enabled;
    bridge.check("gdrive.sync", &[Scope::Read, Scope::Execute, Scope::Network], approved, actor, pre_consented, serde_json::json!({ "trigger": trigger }))?;

    let finish = |r: SyncResult| {
        *pipes.last_sync.write().unwrap() = Some(r.clone());
        if let Some(p) = last_sync_path(state) {
            let _ = std::fs::write(p, serde_json::to_string_pretty(&r).unwrap_or_default());
        }
        bridge.log(serde_json::json!({
            "type": "dispatch", "upstream": actor, "downstream": "n8n:gdrive-sync-webhook", "action": "gdrive.sync",
            "input": { "trigger": trigger, "files": r.files, "bytes": r.bytes }, "outcome": r.status, "verification": r.detail,
        }));
        r
    };
    let base = |status: &str, detail: String| SyncResult { status: status.into(), at: now_ms(), files: 0, bytes: 0, skipped_large: 0, detail, trigger: trigger.into() };

    if cfg.gdrive_sync_webhook_url.is_empty() {
        return Ok(finish(base("not-configured", "Set the Drive sync webhook URL in Settings → Integrations".into())));
    }
    {
        let mut busy = pipes.syncing.lock().unwrap();
        if *busy {
            return Ok(base("busy", "a sync is already running".into()));
        }
        *busy = true;
    }
    let result = sync_inner(state, &cfg, trigger).await;
    *pipes.syncing.lock().unwrap() = false;
    Ok(finish(result))
}

async fn sync_inner(state: &DispatchState, cfg: &PipelinesConfig, trigger: &str) -> SyncResult {
    let mut result = SyncResult { status: "failed".into(), at: now_ms(), files: 0, bytes: 0, skipped_large: 0, detail: String::new(), trigger: trigger.into() };
    let old: Manifest = manifest_path(state).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();

    let roots = resolve_tracked(state, &cfg.gdrive_tracked_paths);
    let mut entries = Vec::new();
    let mut next = old.clone();
    let mut inline_total = 0u64;
    let mut missing = Vec::new();
    for (label, root) in &roots {
        if !root.exists() {
            missing.push(root.to_string_lossy().into_owned());
            continue;
        }
        let mut files = Vec::new();
        walk(root, &mut files, 0);
        for f in files {
            let Ok(meta) = std::fs::metadata(&f) else { continue };
            let key = f.to_string_lossy().into_owned();
            let mtime = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let sig = (meta.len(), mtime);
            if old.get(&key) == Some(&sig) {
                continue;
            }
            let rel = f.strip_prefix(root.parent().unwrap_or(root)).unwrap_or(&f).to_string_lossy().replace('\\', "/");
            let mut entry = serde_json::json!({ "root": label, "path": rel, "size": meta.len(), "modified": mtime });
            if meta.len() <= MAX_FILE_INLINE && inline_total + meta.len() <= MAX_PAYLOAD_INLINE {
                if let Ok(bytes) = std::fs::read(&f) {
                    inline_total += meta.len();
                    entry["encoding"] = "base64".into();
                    entry["content"] = base64::engine::general_purpose::STANDARD.encode(&bytes).into();
                    next.insert(key, sig);
                }
            } else {
                entry["contentOmitted"] = true.into();
                result.skipped_large += 1;
            }
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        result.status = "up-to-date".into();
        result.detail = if missing.is_empty() { "nothing changed since the last backup".into() } else { format!("nothing changed · missing: {}", missing.join(", ")) };
        return result;
    }

    let payload = serde_json::json!({
        "source": "jarvis-command-center",
        "host": sysinfo::System::host_name(),
        "trigger": trigger,
        "generatedAt": now_ms(),
        "files": entries,
        "missing": missing,
    });
    result.files = entries.len();
    result.bytes = inline_total;
    match state.http.post(&cfg.gdrive_sync_webhook_url).json(&payload).timeout(NET_TIMEOUT).send().await {
        Ok(r) if r.status().is_success() => {
            if let Some(p) = manifest_path(state) {
                let _ = std::fs::write(p, serde_json::to_string(&next).unwrap_or_default());
            }
            result.status = "synced".into();
            result.detail = format!("{} files ({} KB) accepted by n8n{}", result.files, inline_total / 1024, if result.skipped_large > 0 { format!(", {} over 1 MB sent as metadata only", result.skipped_large) } else { String::new() });
        }
        Ok(r) => {
            result.detail = format!("webhook answered HTTP {}", r.status().as_u16());
        }
        Err(e) if e.is_connect() => {
            result.status = "offline".into();
            result.detail = "n8n / Docker unreachable — will retry".into();
        }
        Err(e) => {
            result.detail = short(e);
        }
    }
    result
}

#[tauri::command]
pub async fn trigger_gdrive_sync(state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, pipes: State<'_, PipelineState>, approved: Option<bool>) -> Result<SyncResult, String> {
    run_gdrive_sync(&state, &bridge, &pipes, Actor::User, approved.unwrap_or(false), "manual").await
}

/// Background auto-sync: checks once a minute, syncs when the interval has elapsed.
pub async fn auto_sync_loop(handle: tauri::AppHandle) {
    use tauri::Manager;
    loop {
        tokio_sleep(Duration::from_secs(60)).await;
        let state = handle.state::<DispatchState>();
        let bridge = handle.state::<BridgeState>();
        let pipes = handle.state::<PipelineState>();
        let cfg = state.snapshot().pipelines;
        if !cfg.auto_sync_enabled || cfg.gdrive_sync_webhook_url.is_empty() {
            continue;
        }
        let last = pipes.last_sync.read().unwrap().as_ref().filter(|r| r.status == "synced" || r.status == "up-to-date").map(|r| r.at).unwrap_or(0);
        if now_ms().saturating_sub(last) as f64 >= cfg.auto_sync_hours * 3_600_000.0 {
            let _ = run_gdrive_sync(&state, &bridge, &pipes, Actor::Scheduler, false, "schedule").await;
        }
    }
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

// ── tiny futures helpers (no `futures` crate) ────────────────────────────────

async fn join2<A: std::future::Future, B: std::future::Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = Box::pin(a);
    let mut b = Box::pin(b);
    let mut ra = None;
    let mut rb = None;
    std::future::poll_fn(|cx| {
        if ra.is_none() {
            if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) {
                ra = Some(v);
            }
        }
        if rb.is_none() {
            if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) {
                rb = Some(v);
            }
        }
        if ra.is_some() && rb.is_some() {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    (ra.unwrap(), rb.unwrap())
}

async fn join_all<F: std::future::Future>(futs: Vec<F>) -> Vec<F::Output> {
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut results: Vec<Option<F::Output>> = (0..pinned.len()).map(|_| None).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_to_ms() {
        assert_eq!(parse_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_ms("2026-11-17T00:00:01.500Z"), Some(1_794_873_601_500));
    }

    #[test]
    fn status_map() {
        assert_eq!(map_status("crashed"), "error");
        assert_eq!(map_status("waiting"), "running");
        assert_eq!(map_status("canceled"), "idle");
    }
}
