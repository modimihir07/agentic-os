//! n8n workflow triggers. The webview can only name a workflow that exists in
//! providers.json → `n8nWorkflows`; it can never supply a URL. The UI only
//! calls `n8n_trigger` after the human-in-the-loop confirmation.

use std::time::Duration;
use tauri::State;

use super::dispatch::{short, DispatchState, Kind};

#[tauri::command]
pub fn n8n_workflows(state: State<'_, DispatchState>) -> Vec<String> {
    state.snapshot().n8n_workflows.into_keys().collect()
}

#[tauri::command]
pub async fn n8n_trigger(state: State<'_, DispatchState>, name: String, payload: serde_json::Value) -> Result<String, String> {
    let cfg = state.snapshot();
    let path = cfg.n8n_workflows.get(&name).ok_or("unknown workflow")?.clone();
    let p = state.provider("n8n").filter(|p| p.kind == Kind::N8n).ok_or("n8n provider not configured")?;
    let key = state.key_for(&p)?;
    if serde_json::to_vec(&payload).map(|v| v.len()).unwrap_or(usize::MAX) > 256 * 1024 {
        return Err("payload too large".into());
    }

    let mut rb = state
        .http
        .post(format!("{}/{}", p.base_url.trim_end_matches('/'), path.trim_start_matches('/')))
        .timeout(Duration::from_secs(60))
        .json(&payload);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let res = rb.send().await.map_err(short)?.error_for_status().map_err(short)?;
    let text = res.text().await.map_err(short)?;
    Ok(text.chars().take(4000).collect())
}
