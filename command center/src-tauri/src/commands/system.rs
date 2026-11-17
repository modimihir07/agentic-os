use serde::Serialize;
use std::sync::Mutex;
use sysinfo::System;
use tauri::State;

use crate::proc;

pub struct SysState(Mutex<System>);

impl Default for SysState {
    fn default() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self(Mutex::new(sys))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub name: String,
    pub util_pct: f32,
    pub vram_used_mb: u64,
    pub vram_total_mb: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    cpu_pct: f32,
    mem_used_mb: u64,
    mem_total_mb: u64,
    hostname: Option<String>,
    gpu: Option<GpuStats>,
}

#[tauri::command]
pub fn system_stats(state: State<'_, SysState>) -> Result<SystemStats, String> {
    let (cpu_pct, mem_used_mb, mem_total_mb) = {
        let mut sys = state.0.lock().map_err(|_| "system state poisoned")?;
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (sys.global_cpu_usage(), sys.used_memory() / 1_048_576, sys.total_memory() / 1_048_576)
    };
    Ok(SystemStats {
        cpu_pct,
        mem_used_mb,
        mem_total_mb,
        hostname: System::host_name(),
        gpu: query_gpu(),
    })
}

/// First NVIDIA GPU via nvidia-smi. Returns None on AMD/Intel/no driver.
/// TODO(cline): add AMD (rocm-smi) / Apple (powermetrics) probes if needed.
pub fn query_gpu() -> Option<GpuStats> {
    let out = proc::stdout(
        "nvidia-smi",
        &["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
    )
    .ok()?;
    let line = out.lines().next()?;
    let mut parts = line.split(',').map(str::trim);
    Some(GpuStats {
        name: parts.next()?.to_string(),
        util_pct: parts.next()?.parse().ok()?,
        vram_used_mb: parts.next()?.parse().ok()?,
        vram_total_mb: parts.next()?.parse().ok()?,
    })
}
