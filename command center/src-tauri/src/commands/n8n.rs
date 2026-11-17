//! n8n, bound to the local Docker container.
//!
//! * `n8n_discover` finds the running n8n container (`docker ps`) and points
//!   the n8n provider at its published port. It runs on startup, and from Settings.
//! * The webview can only name a workflow from providers.json → `n8nWorkflows`;
//!   it never supplies a URL.
//! * `n8n_fetch` runs ONLY workflows marked `"mutating": false` (calendar
//!   reads, Gmail digests) — widgets use it without a confirmation.
//! * `n8n_trigger` runs anything; the UI only calls it after the human approves.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::State;

use super::dispatch::{short, valid_id, DispatchState, Kind, WorkflowSpec};
use crate::proc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInfo {
    name: String,
    path: String,
    mutating: bool,
    description: Option<String>,
}

#[tauri::command]
pub fn n8n_workflows(state: State<'_, DispatchState>) -> Vec<WorkflowInfo> {
    state
        .snapshot()
        .n8n_workflows
        .into_iter()
        .map(|(name, wf)| WorkflowInfo {
            path: wf.path().to_string(),
            mutating: wf.mutating(),
            description: match &wf {
                WorkflowSpec::Full { description, .. } => description.clone(),
                _ => None,
            },
            name,
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    name: String,
    path: String,
    mutating: bool,
    description: Option<String>,
}

/// Replace the workflow map (Settings → n8n). Only the n8n host can ever be reached.
#[tauri::command]
pub fn n8n_workflows_set(state: State<'_, DispatchState>, workflows: Vec<WorkflowInput>) -> Result<Vec<WorkflowInfo>, String> {
    if workflows.len() > 64 {
        return Err("too many workflows".into());
    }
    state.update(|cfg| {
        let mut map = BTreeMap::new();
        for w in workflows {
            if !valid_id(&w.name) {
                return Err(format!("bad workflow name '{}'", w.name));
            }
            map.insert(
                w.name,
                WorkflowSpec::Full {
                    path: w.path.trim().trim_start_matches('/').to_string(),
                    mutating: w.mutating,
                    description: w.description.map(|d| d.chars().take(160).collect()),
                },
            );
        }
        cfg.n8n_workflows = map;
        Ok(())
    })?;
    Ok(n8n_workflows(state))
}

async fn post_workflow(state: &DispatchState, path: &str, payload: &serde_json::Value) -> Result<String, String> {
    let p = state.provider("n8n").filter(|p| p.kind == Kind::N8n).ok_or("n8n provider not configured")?;
    let key = state.key_for(&p)?;
    if serde_json::to_vec(payload).map(|v| v.len()).unwrap_or(usize::MAX) > 256 * 1024 {
        return Err("payload too large".into());
    }
    let mut rb = state
        .http
        .post(format!("{}/{}", p.base_url.trim_end_matches('/'), path.trim_start_matches('/')))
        .timeout(Duration::from_secs(60))
        .json(payload);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let res = rb.send().await.map_err(short)?.error_for_status().map_err(short)?;
    let text = res.text().await.map_err(short)?;
    Ok(text.chars().take(64_000).collect())
}

#[tauri::command]
pub async fn n8n_trigger(state: State<'_, DispatchState>, name: String, payload: serde_json::Value) -> Result<String, String> {
    let wf = state.snapshot().n8n_workflows.get(&name).cloned().ok_or("unknown workflow")?;
    let out = post_workflow(&state, wf.path(), &payload).await?;
    Ok(out.chars().take(4000).collect())
}

/// Read-only workflows only. Mutating ones are refused here, whatever the caller says.
#[tauri::command]
pub async fn n8n_fetch(state: State<'_, DispatchState>, name: String, payload: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    fetch_readonly(&state, &name, payload.unwrap_or(serde_json::json!({}))).await
}

pub(crate) async fn fetch_readonly(state: &DispatchState, name: &str, payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let wf = state.snapshot().n8n_workflows.get(name).cloned().ok_or("unknown workflow")?;
    if wf.mutating() {
        return Err(format!("'{name}' is a mutating workflow — it needs a confirmation, not a fetch"));
    }
    let text = post_workflow(state, wf.path(), &payload).await?;
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct N8nDiscovery {
    found: bool,
    container: Option<String>,
    image: Option<String>,
    status: Option<String>,
    url: Option<String>,
    healthy: bool,
    adopted: bool,
}

/// Find the local n8n Docker container and bind the n8n provider to it.
#[tauri::command]
pub async fn n8n_discover(state: State<'_, DispatchState>, adopt: Option<bool>) -> Result<N8nDiscovery, String> {
    let found = tauri::async_runtime::spawn_blocking(|| -> Option<(String, String, String, u16)> {
        let out = proc::stdout("docker", &["ps", "--format", "{{json .}}"]).ok()?;
        out.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).find_map(|v| {
            let image = v["Image"].as_str().unwrap_or_default();
            let name = v["Names"].as_str().unwrap_or_default();
            if !image.contains("n8n") && !name.contains("n8n") {
                return None;
            }
            // "0.0.0.0:5678->5678/tcp, [::]:5678->5678/tcp"
            let ports = v["Ports"].as_str().unwrap_or_default();
            let host_port = ports
                .split(',')
                .filter_map(|seg| {
                    let (host, inner) = seg.trim().split_once("->")?;
                    inner.starts_with("5678/").then(|| host.rsplit(':').next()?.parse::<u16>().ok()).flatten()
                })
                .next()?;
            Some((name.to_string(), image.to_string(), v["Status"].as_str().unwrap_or_default().to_string(), host_port))
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some((container, image, status, port)) = found else {
        return Ok(N8nDiscovery { found: false, container: None, image: None, status: None, url: None, healthy: false, adopted: false });
    };
    let url = format!("http://127.0.0.1:{port}");
    let healthy = state
        .http
        .get(format!("{url}/healthz"))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success());
    let current = state.provider("n8n").map(|p| p.base_url).unwrap_or_default();
    let adopted = healthy && adopt.unwrap_or(true) && current.trim_end_matches('/') != url;
    if adopted {
        state.update(|cfg| {
            if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == "n8n") {
                p.base_url = url.clone();
                p.label = format!("n8n (Docker: {container})");
            }
            Ok(())
        })?;
    }
    Ok(N8nDiscovery { found: true, container: Some(container), image: Some(image), status: Some(status), url: Some(url), healthy, adopted })
}
