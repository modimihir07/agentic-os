//! Model Lab: try local models one at a time on the 12 GB card.
//!
//!   model_lab_list   — every LLM Bionic/LM Studio knows, with size + a VRAM-fit estimate
//!   model_bench      — load ONE model alone at a context that fits, measure load time,
//!                      time-to-first-token, tokens/s and VRAM, answer a real prompt
//!   model_use        — make it Tony's brain: providers.json + AnythingLLM default +
//!                      every AnythingLLM workspace on LM Studio, so a second model is
//!                      never auto-loaded next to it (the VRAM-spill trap).

use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::State;

use super::dispatch::{short, DispatchState};

const VRAM_RESERVED_GB: f64 = 3.3; // Windows compositor + browsers + headroom

fn api_base(state: &DispatchState) -> Result<String, String> {
    let cfg = state.snapshot();
    let p = cfg.providers.iter().find(|p| p.id == "lmstudio").ok_or("no lmstudio provider")?;
    let u = url::Url::parse(&p.base_url).map_err(|e| e.to_string())?;
    Ok(u.origin().ascii_serialization())
}

/// Context that keeps weights + KV cache inside VRAM (rough but conservative).
pub fn fit_context(size_gb: f64, vram_total_gb: f64) -> (u64, &'static str) {
    let budget = vram_total_gb - VRAM_RESERVED_GB - size_gb;
    if budget > 2.5 {
        (32_768, "fits")
    } else if budget > 1.4 {
        (16_384, "fits")
    } else if budget > 0.7 {
        (8_192, "tight")
    } else if budget > 0.2 {
        (4_096, "tight")
    } else {
        (4_096, "spills to RAM — slow")
    }
}

fn vram_total_gb() -> f64 {
    super::system::query_gpu().map(|g| g.vram_total_mb as f64 / 1024.0).unwrap_or(12.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabModel {
    key: String,
    name: String,
    params: String,
    quant: String,
    size_gb: f64,
    vision: bool,
    loaded: bool,
    context: u64,
    fit: String,
    tony: bool,
}

#[tauri::command]
pub async fn model_lab_list(state: State<'_, DispatchState>) -> Result<Vec<LabModel>, String> {
    let base = api_base(&state)?;
    let v: Value = state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await.map_err(short)?.json().await.map_err(short)?;
    let total = tauri::async_runtime::spawn_blocking(vram_total_gb).await.unwrap_or(12.0);
    let tony = state.provider("lmstudio").map(|p| p.model).unwrap_or_default();
    let mut out: Vec<LabModel> = v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["type"] == "llm")
        .map(|m| {
            let size = m["size_bytes"].as_f64().unwrap_or(0.0) / 1e9;
            let (ctx, fit) = fit_context(size, total);
            LabModel {
                key: m["key"].as_str().unwrap_or("").into(),
                name: m["display_name"].as_str().unwrap_or("").into(),
                params: m["params_string"].as_str().unwrap_or("").into(),
                quant: m["quantization"]["name"].as_str().unwrap_or("").into(),
                size_gb: (size * 10.0).round() / 10.0,
                vision: m["capabilities"]["vision"].as_bool().unwrap_or(false),
                loaded: m["loaded_instances"].as_array().is_some_and(|a| !a.is_empty()),
                context: ctx,
                fit: fit.into(),
                tony: m["key"].as_str() == Some(tony.as_str()),
            }
        })
        .collect();
    out.sort_by(|a, b| a.size_gb.partial_cmp(&b.size_gb).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchResult {
    model: String,
    context: u64,
    load_ms: u128,
    first_token_ms: u128,
    tokens_per_sec: f64,
    vram_used_gb: f64,
    vram_total_gb: f64,
    reply: String,
    error: Option<String>,
}

async fn unload_all(state: &DispatchState, base: &str) {
    if let Ok(r) = state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await {
        if let Ok(v) = r.json::<Value>().await {
            for m in v["models"].as_array().into_iter().flatten().filter(|m| m["type"] == "llm") {
                for i in m["loaded_instances"].as_array().into_iter().flatten() {
                    if let Some(id) = i["id"].as_str() {
                        let _ = state.http.post(format!("{base}/api/v1/models/unload")).json(&json!({ "instance_id": id })).timeout(Duration::from_secs(60)).send().await;
                    }
                }
            }
        }
    }
}

pub async fn bench(state: &DispatchState, model: &str, context: Option<u64>) -> BenchResult {
    let total = tauri::async_runtime::spawn_blocking(vram_total_gb).await.unwrap_or(12.0);
    let mut res = BenchResult { model: model.into(), context: 0, load_ms: 0, first_token_ms: 0, tokens_per_sec: 0.0, vram_used_gb: 0.0, vram_total_gb: (total * 10.0).round() / 10.0, reply: String::new(), error: None };
    let base = match api_base(state) {
        Ok(b) => b,
        Err(e) => {
            res.error = Some(e);
            return res;
        }
    };
    // Size → context that fits.
    let size: Option<Value> = match state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await {
        Ok(r) => r.json().await.ok(),
        Err(_) => None,
    };
    let size_gb = size
        .as_ref()
        .and_then(|v| v["models"].as_array()?.iter().find(|m| m["key"] == model).and_then(|m| m["size_bytes"].as_f64()))
        .unwrap_or(6e9)
        / 1e9;
    let ctx = context.unwrap_or_else(|| fit_context(size_gb, total).0);
    res.context = ctx;
    unload_all(state, &base).await;
    let t0 = Instant::now();
    let load = state.http.post(format!("{base}/api/v1/models/load")).json(&json!({ "model": model, "context_length": ctx, "flash_attention": true, "parallel": 2, "offload_kv_cache_to_gpu": true })).timeout(Duration::from_secs(300)).send().await;
    match load {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => {
            res.error = Some(format!("load failed: HTTP {} {}", r.status().as_u16(), r.text().await.unwrap_or_default().chars().take(200).collect::<String>()));
            return res;
        }
        Err(e) => {
            res.error = Some(format!("load failed: {}", short(e)));
            return res;
        }
    }
    res.load_ms = t0.elapsed().as_millis();

    // Streamed answer: time to first token + generation speed.
    use futures_util::StreamExt;
    let body = json!({ "model": model, "stream": true, "max_tokens": 160, "reasoning_effort": "none",
        "messages": [{ "role": "system", "content": "You are Tony, a concise assistant." }, { "role": "user", "content": "In two short sentences: what should I focus on today if I'm an actor who builds apps?" }] });
    let t1 = Instant::now();
    let r = match state.http.post(format!("{base}/v1/chat/completions")).json(&body).timeout(Duration::from_secs(180)).send().await {
        Ok(r) => r,
        Err(e) => {
            res.error = Some(short(e));
            return res;
        }
    };
    let mut first = None;
    let mut tokens = 0usize;
    let mut buf = String::new();
    let mut stream = r.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            if let Some(d) = line.strip_prefix("data:").map(str::trim).filter(|d| *d != "[DONE]") {
                if let Ok(v) = serde_json::from_str::<Value>(d) {
                    let delta = &v["choices"][0]["delta"];
                    let piece = delta["content"].as_str().or(delta["reasoning_content"].as_str()).unwrap_or("");
                    if !piece.is_empty() {
                        first.get_or_insert_with(|| t1.elapsed().as_millis());
                        tokens += 1;
                        if delta["content"].is_string() {
                            res.reply.push_str(piece);
                        }
                    }
                }
            }
        }
    }
    let gen_secs = (t1.elapsed().as_millis().saturating_sub(first.unwrap_or(0))) as f64 / 1000.0;
    res.first_token_ms = first.unwrap_or(0);
    res.tokens_per_sec = if gen_secs > 0.0 { (tokens as f64 / gen_secs * 10.0).round() / 10.0 } else { 0.0 };
    res.vram_used_gb = tauri::async_runtime::spawn_blocking(super::system::query_gpu).await.ok().flatten().map(|g| (g.vram_used_mb as f64 / 102.4).round() / 10.0).unwrap_or(0.0);
    res.reply = super::dispatch::strip_think(&res.reply).chars().take(300).collect();
    if tokens == 0 {
        res.error = Some("no tokens came back".into());
    }
    res
}

#[tauri::command]
pub async fn model_bench(state: State<'_, DispatchState>, model: String, context: Option<u64>) -> Result<BenchResult, String> {
    Ok(bench(&state, &model, context).await)
}

/// Make `model` Tony's brain everywhere (one model on the GPU).
#[tauri::command]
pub async fn model_use(state: State<'_, DispatchState>, model: String) -> Result<Vec<String>, String> {
    use_model(&state, model).await
}

pub async fn use_model(state: &DispatchState, model: String) -> Result<Vec<String>, String> {
    if model.is_empty() || model.len() > 200 {
        return Err("bad model id".into());
    }
    let mut notes = vec![];
    state.update(|c| {
        for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
            p.model = model.clone();
        }
        Ok(())
    })?;
    notes.push(format!("Tony → {model}"));
    if let Some(key) = super::secrets::get(state, "anythingllm") {
        let base = "http://127.0.0.1:3001";
        if super::agents::allm(state, base, &key, reqwest::Method::POST, "/v1/system/update-env", Some(json!({ "LMStudioModelPref": model })), 20).await.is_ok() {
            notes.push("AnythingLLM default → same model".into());
        }
        if let Ok(v) = super::agents::allm(state, base, &key, reqwest::Method::GET, "/v1/workspaces", None, 10).await {
            for w in v["workspaces"].as_array().into_iter().flatten().filter(|w| w["chatProvider"] == "lmstudio") {
                let slug = w["slug"].as_str().unwrap_or("");
                if super::agents::allm(state, base, &key, reqwest::Method::POST, &format!("/v1/workspace/{slug}/update"), Some(json!({ "chatModel": model })), 20).await.is_ok() {
                    notes.push(format!("workspace {slug} → same model"));
                }
            }
        }
    }
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit() {
        assert_eq!(fit_context(6.5, 12.0).0, 32_768 - 16_384); // 9B: 2.2 GB budget → 16k
        assert_eq!(fit_context(3.4, 12.0).0, 32_768); // 4B
        assert_eq!(fit_context(9.0, 12.0).1, "spills to RAM — slow"); // 14B on 12 GB
    }

    /// `MODEL=… cargo test --lib live_model_use -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_model_use() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            println!("USE {:?}", use_model(&state, std::env::var("MODEL").unwrap()).await);
        });
    }

    /// `cargo test --lib live_model_bench -- --ignored --nocapture` — benchmark every local LLM,
    /// then put the current Tony model back.
    #[test]
    #[ignore]
    fn live_model_bench() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let tony = state.provider("lmstudio").unwrap().model;
            let base = api_base(&state).unwrap();
            let v: Value = state.http.get(format!("{base}/api/v1/models")).send().await.unwrap().json().await.unwrap();
            let only: Vec<String> = std::env::var("MODELS").map(|m| m.split(',').map(|x| x.trim().to_string()).collect()).unwrap_or_default();
            let models: Vec<String> = v["models"].as_array().unwrap().iter().filter(|m| m["type"] == "llm").filter_map(|m| m["key"].as_str().map(String::from)).filter(|k| only.is_empty() || only.contains(k)).collect();
            for m in models {
                let r = bench(&state, &m, None).await;
                println!(
                    "BENCH {:<34} ctx {:>6} | load {:>5} ms | first token {:>5} ms | {:>5.1} tok/s | VRAM {:>4.1}/{:.0} GB | {}",
                    r.model, r.context, r.load_ms, r.first_token_ms, r.tokens_per_sec, r.vram_used_gb, r.vram_total_gb,
                    r.error.unwrap_or_else(|| format!("“{}”", r.reply.replace('\n', " ").chars().take(70).collect::<String>()))
                );
            }
            let r = bench(&state, &tony, Some(32_768)).await;
            println!("RESTORED {} ({})", r.model, r.error.unwrap_or_else(|| "ok".into()));
        });
    }
}
