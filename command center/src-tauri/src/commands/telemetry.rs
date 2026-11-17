//! Read-only infrastructure probes. Fixed binaries + fixed args only.

use serde::Serialize;

use crate::proc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    id: String,
    name: String,
    image: String,
    state: String,
    status: String,
}

#[tauri::command]
pub async fn docker_ps() -> Result<Vec<DockerContainer>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = proc::stdout("docker", &["ps", "-a", "--format", "{{json .}}"])?;
        Ok(out
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .map(|v| {
                let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
                DockerContainer { id: s("ID"), name: s("Names"), image: s("Image"), state: s("State"), status: s("Status") }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetbirdStatus {
    connected: bool,
    peers_connected: u64,
    peers_total: u64,
    ip: Option<String>,
    raw: Option<String>,
}

#[tauri::command]
pub async fn netbird_status() -> Result<NetbirdStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = proc::stdout("netbird", &["status", "--json"])?;
        let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| format!("unexpected netbird output: {e}"))?;
        let mgmt = v["management"]["connected"].as_bool().unwrap_or(false);
        let signal = v["signal"]["connected"].as_bool().unwrap_or(false);
        Ok(NetbirdStatus {
            connected: mgmt && signal,
            peers_connected: v["peers"]["connected"].as_u64().unwrap_or(0),
            peers_total: v["peers"]["total"].as_u64().unwrap_or(0),
            ip: v["netbirdIp"].as_str().map(|s| s.split('/').next().unwrap_or(s).to_string()),
            raw: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
