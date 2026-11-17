//! The OS's own tools: built-in MCP equivalents implemented natively (no
//! process to spawn, always available) plus a minimal MCP client for any
//! stdio / HTTP server the user adds in Settings → Skills & MCP Library.
//!
//! Safety:
//!   - Every tool is read-only from the model's point of view. Nothing here
//!     writes files, sends messages or runs arbitrary commands.
//!   - Filesystem / git are confined to the allowed roots (canonicalised).
//!   - Fetch refuses loopback / private / mesh addresses (no SSRF into your
//!     own services) and is blocked by the kill switch.
//!   - User-added MCP servers run with the command line the user typed into
//!     Settings — never one proposed by a model.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

use super::bridge::BridgeState;
use super::dispatch::{short, DispatchState};
use super::os_core::{self, McpServer, OsConfig, OsState};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub server: String,
    #[serde(default)]
    pub args: Vec<String>,
}

fn t(server: &str, name: &str, description: &str, args: &[&str]) -> ToolInfo {
    ToolInfo { name: name.into(), description: description.into(), server: server.into(), args: args.iter().map(|a| a.to_string()).collect() }
}

fn builtin_tools(id: &str) -> Vec<ToolInfo> {
    match id {
        "weather" => vec![t(id, "weather.current", "Live conditions + 3-day forecast. Omit place for the user's home (Toronto).", &["place?"])],
        "time" => vec![t(id, "time.now", "Current local date, time and weekday.", &[])],
        "fetch" => vec![t(id, "fetch.url", "Fetch a public web page as plain text.", &["url"])],
        "filesystem" => vec![
            t(id, "fs.list", "List a folder under the allowed roots.", &["path"]),
            t(id, "fs.read", "Read a text file under the allowed roots.", &["path"]),
        ],
        "git" => vec![t(id, "git.status", "Branch, changed files and last commits of a repo under the allowed roots.", &["path"])],
        "knowledge-graph" => vec![t(id, "kg.search", "Search the personal knowledge graph (people, projects, facts).", &["query"])],
        "brave-search" => vec![t(id, "web.search", "Search the web (Brave).", &["query"])],
        "gmail" => vec![t(id, "gmail.recent", "Most recent inbox messages (sender, subject, snippet).", &["count?"])],
        _ => vec![],
    }
}

// ── Listing ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTools {
    id: String,
    name: String,
    enabled: bool,
    ok: bool,
    error: Option<String>,
    tools: Vec<ToolInfo>,
}

/// Tools of every enabled server (external ones cached for 10 minutes).
/// Tools that change the world (send, delete, write…) are never offered to the
/// model's router — those go through the confirmation card (e.g. Comms → send).
pub fn is_mutating_tool(name: &str) -> bool {
    let tool = name.rsplit('.').next().unwrap_or(name).to_ascii_lowercase();
    ["send", "reply", "post", "delete", "remove", "write", "create", "update", "edit", "move", "rename", "upload", "download_media", "set_", "add_", "run", "exec", "execute", "click", "type", "fill", "navigate", "install", "commit", "push", "pay", "book"]
        .iter()
        .any(|v| tool.starts_with(v) || tool.contains(&format!("_{v}")))
}

pub async fn enabled_tools(state: &DispatchState, os: &OsState) -> Vec<ToolInfo> {
    let cfg = os.snapshot();
    let mut out = Vec::new();
    for s in cfg.mcps.iter().filter(|s| s.enabled) {
        match tools_of(state, os, s, false).await {
            Ok(v) => out.extend(v.into_iter().filter(|t| !is_mutating_tool(&t.name))),
            Err(e) => eprintln!("[mcp] {}: {e}", s.id),
        }
    }
    if cfg.skills.grants.values().any(|a| a.iter().any(|x| x == "tony")) {
        out.push(t("skills", "skills.read", "Read the full instructions of one of your attached skills.", &["name"]));
    }
    out
}

async fn tools_of(state: &DispatchState, os: &OsState, s: &McpServer, refresh: bool) -> Result<Vec<ToolInfo>, String> {
    if s.transport == "builtin" {
        return Ok(builtin_tools(&s.id));
    }
    let now = os_core::now_secs();
    if !refresh {
        if let Some((at, tools)) = os.mcp_tools.lock().unwrap().get(&s.id) {
            if now - at < 600 {
                return Ok(tools.clone());
            }
        }
    }
    let res = rpc(state, s, "tools/list", json!({})).await?;
    let tools: Vec<ToolInfo> = res["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tl| {
            let name = tl["name"].as_str()?;
            let args = tl["inputSchema"]["properties"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            Some(ToolInfo { name: format!("{}.{name}", s.id), description: tl["description"].as_str().unwrap_or("").chars().take(200).collect(), server: s.id.clone(), args })
        })
        .collect();
    os.mcp_tools.lock().unwrap().insert(s.id.clone(), (now, tools.clone()));
    Ok(tools)
}

#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, DispatchState>, os: State<'_, OsState>, refresh: Option<bool>) -> Result<Vec<ServerTools>, String> {
    let cfg = os.snapshot();
    let mut out = Vec::new();
    for s in &cfg.mcps {
        if !s.enabled {
            out.push(ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: false, ok: false, error: None, tools: builtin_tools(&s.id) });
            continue;
        }
        let r = tools_of(&state, &os, s, refresh.unwrap_or(false)).await;
        out.push(match r {
            Ok(tools) => ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: true, ok: true, error: None, tools },
            Err(e) => ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: true, ok: false, error: Some(e), tools: vec![] },
        });
    }
    Ok(out)
}

/// Run one tool from Settings ("Test") — same gates as when Tony calls it.
#[tauri::command]
pub async fn mcp_call(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, name: String, args: Value, approved: Option<bool>) -> Result<String, String> {
    call_tool(&state, &os, &bridge, &name, &args, approved.unwrap_or(false)).await
}

// ── Calling ─────────────────────────────────────────────────────────────────

pub async fn call_tool(state: &DispatchState, os: &OsState, bridge: &BridgeState, name: &str, args: &Value, approved: bool) -> Result<String, String> {
    let cfg = os.snapshot();
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", approved, json!({ "tool": name }))?;
    let arg = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
    let server_on = |id: &str| cfg.mcps.iter().any(|m| m.id == id && m.enabled);
    let out = match name {
        "weather.current" if server_on("weather") => weather(state, &arg("place")).await,
        "time.now" if server_on("time") => Ok(chrono::Local::now().format("%A, %B %-d %Y · %-I:%M %p (%Z local time)").to_string()),
        "fetch.url" if server_on("fetch") => {
            if cfg.privacy.kill_switch {
                return Err("kill switch is on — no outbound web requests".into());
            }
            fetch_public(state, &arg("url")).await
        }
        "fs.list" | "fs.read" if server_on("filesystem") => {
            os_core::gate(bridge, cfg.permissions.filesystem, "filesystem", approved, json!({ "path": arg("path") }))?;
            let path = confine(&cfg, state, &arg("path"))?;
            if name == "fs.list" {
                list_dir(&path)
            } else {
                read_text(&path)
            }
        }
        "git.status" if server_on("git") => {
            os_core::gate(bridge, cfg.permissions.filesystem, "filesystem", approved, json!({ "path": arg("path") }))?;
            let path = confine(&cfg, state, &arg("path"))?;
            git_status(path).await
        }
        "kg.search" if server_on("knowledge-graph") => kg_search(&arg("query")),
        "web.search" if server_on("brave-search") => {
            if cfg.privacy.kill_switch {
                return Err("kill switch is on — no outbound web requests".into());
            }
            brave(state, &arg("query")).await
        }
        "gmail.recent" if server_on("gmail") => {
            let n = args.get("count").and_then(|v| v.as_u64()).unwrap_or(5).clamp(1, 20);
            let v = super::n8n::fetch_readonly(state, "gmail-recent", json!({ "count": n })).await.map_err(|e| format!("{e} — import a read-only n8n workflow named \"gmail-recent\""))?;
            Ok(v.to_string().chars().take(6000).collect())
        }
        "skills.read" => read_skill(&cfg, &arg("name"), "tony"),
        other => {
            let (sid, tool) = other.split_once('.').ok_or("unknown tool")?;
            let s = cfg.mcps.iter().find(|m| m.id == sid && m.enabled && m.transport != "builtin").ok_or_else(|| format!("tool {other} is not available (server off?)"))?;
            if cfg.privacy.kill_switch && s.transport == "http" && os_core::is_remote(&dummy_provider(&s.url)) {
                return Err("kill switch is on — remote MCP blocked".into());
            }
            let res = rpc(state, s, "tools/call", json!({ "name": tool, "arguments": args })).await?;
            let text: Vec<String> = res["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str().map(String::from)).collect();
            let joined = if text.is_empty() { res.to_string() } else { text.join("\n") };
            if res["isError"].as_bool() == Some(true) {
                Err(joined.chars().take(500).collect())
            } else {
                Ok(joined)
            }
        }
    };
    let out = out.map(|s| s.chars().take(8000).collect::<String>());
    bridge.log(json!({ "type": "os-tool", "tool": name, "ok": out.is_ok(), "chars": out.as_ref().map(|s| s.len()).unwrap_or(0) }));
    out
}

fn dummy_provider(url: &str) -> super::dispatch::Provider {
    super::dispatch::Provider {
        id: String::new(),
        label: String::new(),
        kind: super::dispatch::Kind::Local,
        base_url: url.into(),
        model: String::new(),
        needs_key: false,
        voice: None,
        engine: None,
        language: None,
        models_dir: None,
        voices_dir: None,
        custom: false,
    }
}

// ── Built-ins ───────────────────────────────────────────────────────────────

fn wmo(code: i64) -> &'static str {
    match code {
        0 => "clear",
        1 => "mainly clear",
        2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "fog",
        51..=57 => "drizzle",
        61..=67 => "rain",
        71..=77 => "snow",
        80..=82 => "rain showers",
        85 | 86 => "snow showers",
        95..=99 => "thunderstorm",
        _ => "unknown",
    }
}

async fn weather(state: &DispatchState, place: &str) -> Result<String, String> {
    let (lat, lon, label) = if place.is_empty() || place.eq_ignore_ascii_case("toronto") || place.eq_ignore_ascii_case("home") {
        (43.6532, -79.3832, "Toronto".to_string())
    } else {
        let g: Value = state
            .http
            .get("https://geocoding-api.open-meteo.com/v1/search")
            .query(&[("name", place), ("count", "1")])
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .map_err(short)?
            .json()
            .await
            .map_err(short)?;
        let r = &g["results"][0];
        let lat = r["latitude"].as_f64().ok_or_else(|| format!("couldn't find \"{place}\""))?;
        (lat, r["longitude"].as_f64().unwrap_or(0.0), format!("{}, {}", r["name"].as_str().unwrap_or(place), r["country"].as_str().unwrap_or("")))
    };
    let w: Value = state
        .http
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m".into()),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max".into()),
            ("timezone", "auto".into()),
            ("forecast_days", "3".into()),
        ])
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(short)?
        .json()
        .await
        .map_err(short)?;
    let c = &w["current"];
    let mut s = format!(
        "{label}: {:.0}°C (feels {:.0}°C), {}, humidity {}%, wind {:.0} km/h.",
        c["temperature_2m"].as_f64().unwrap_or(f64::NAN),
        c["apparent_temperature"].as_f64().unwrap_or(f64::NAN),
        wmo(c["weather_code"].as_i64().unwrap_or(-1)),
        c["relative_humidity_2m"].as_i64().unwrap_or(0),
        c["wind_speed_10m"].as_f64().unwrap_or(0.0)
    );
    let d = &w["daily"];
    for i in 0..3 {
        if let Some(day) = d["time"][i].as_str() {
            s.push_str(&format!(
                "\n{day}: {}, {:.0}–{:.0}°C, precip {}%",
                wmo(d["weather_code"][i].as_i64().unwrap_or(-1)),
                d["temperature_2m_min"][i].as_f64().unwrap_or(f64::NAN),
                d["temperature_2m_max"][i].as_f64().unwrap_or(f64::NAN),
                d["precipitation_probability_max"][i].as_i64().unwrap_or(0)
            ));
        }
    }
    Ok(s)
}

fn private_host(h: &str) -> bool {
    if os_core::is_loopback_host(h) || h.ends_with(".local") || h.ends_with(".internal") || h == "0.0.0.0" {
        return true;
    }
    if let Ok(ip) = h.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local() || v.is_unspecified() || (v.octets()[0] == 100 && (64..128).contains(&v.octets()[1])),
            std::net::IpAddr::V6(v) => v.is_loopback() || v.is_unspecified() || (v.segments()[0] & 0xfe00) == 0xfc00,
        };
    }
    false
}

async fn fetch_public(state: &DispatchState, url: &str) -> Result<String, String> {
    let u = url::Url::parse(url).map_err(|_| "invalid URL")?;
    if !matches!(u.scheme(), "http" | "https") || private_host(u.host_str().unwrap_or("")) {
        return Err("only public http(s) URLs can be fetched".into());
    }
    let res = state.http.get(u).timeout(Duration::from_secs(15)).header("user-agent", "agentic-os/1.0").send().await.map_err(short)?;
    let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = res.bytes().await.map_err(short)?;
    let body = String::from_utf8_lossy(&bytes[..bytes.len().min(2_000_000)]).into_owned();
    Ok(if ct.contains("html") { html_to_text(&body) } else { body }.chars().take(8000).collect())
}

fn html_to_text(html: &str) -> String {
    let re_drop = regex::Regex::new(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</(script|style|noscript|svg|head)>").unwrap();
    let re_tag = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let re_ws = regex::Regex::new(r"[ \t\r\f]+").unwrap();
    let re_nl = regex::Regex::new(r"\n\s*\n+").unwrap();
    let s = re_drop.replace_all(html, " ");
    let s = re_tag.replace_all(&s, "\n");
    let s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    let s = re_ws.replace_all(&s, " ");
    re_nl.replace_all(&s, "\n").trim().to_string()
}

fn roots(cfg: &OsConfig, state: &DispatchState) -> Vec<PathBuf> {
    let mut r: Vec<PathBuf> = cfg.fs_roots.iter().map(PathBuf::from).collect();
    r.push(PathBuf::from(state.snapshot().gateway.workdir));
    r.into_iter().filter_map(|p| std::fs::canonicalize(p).ok()).collect()
}

fn confine(cfg: &OsConfig, state: &DispatchState, path: &str) -> Result<PathBuf, String> {
    let roots = roots(cfg, state);
    let p = if path.is_empty() { roots.first().cloned().ok_or("no allowed roots")? } else { PathBuf::from(path) };
    let canon = std::fs::canonicalize(&p).map_err(|_| format!("not found: {path}"))?;
    if !roots.iter().any(|r| canon.starts_with(r)) {
        return Err(format!("{path} is outside the allowed roots ({})", cfg.fs_roots.join(", ")));
    }
    let name = canon.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    let secret = name == ".env" || name.starts_with(".env.") || name.ends_with(".pem") || name.ends_with(".key") || name.starts_with("id_rsa") || name.starts_with("id_ed25519") || name.contains("credential") || name.ends_with(".token");
    if secret {
        return Err("that file holds secrets — it is never read into a prompt".into());
    }
    Ok(canon)
}

fn list_dir(p: &Path) -> Result<String, String> {
    let mut items: Vec<String> = std::fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() {
                format!("{n}/")
            } else {
                n
            }
        })
        .collect();
    items.sort();
    let total = items.len();
    items.truncate(200);
    Ok(format!("{} ({total} entries)\n{}", p.display(), items.join("\n")))
}

fn read_text(p: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return list_dir(p);
    }
    if meta.len() > 2_000_000 {
        return Err("file is larger than 2 MB".into());
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if bytes.iter().take(4096).any(|b| *b == 0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).chars().take(8000).collect())
}

async fn git_status(path: PathBuf) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = path.display().to_string();
        let st = crate::proc::stdout("git", &["-C", &p, "status", "--short", "--branch"])?;
        let log = crate::proc::stdout("git", &["-C", &p, "log", "--oneline", "-8"]).unwrap_or_default();
        Ok(format!("{st}\nRecent commits:\n{log}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn kg_search(query: &str) -> Result<String, String> {
    let path = Path::new(r"C:\ai-hub\memory\knowledge-graph.json");
    let raw = std::fs::read_to_string(path).map_err(|_| "no knowledge graph yet (C:\\ai-hub\\memory\\knowledge-graph.json)".to_string())?;
    // Accept {entities:[…]} JSON or the MCP memory server's JSONL.
    let entities: Vec<Value> = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v["entities"].as_array().cloned().unwrap_or_default(),
        Err(_) => raw.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["type"] == "entity").collect(),
    };
    let terms: Vec<String> = query.to_lowercase().split_whitespace().filter(|w| w.len() > 2).map(String::from).collect();
    let mut hits: Vec<(usize, String)> = entities
        .iter()
        .filter_map(|e| {
            let text = format!("{} ({}): {}", e["name"].as_str().unwrap_or("?"), e["entityType"].as_str().unwrap_or(""), e["observations"].as_array().map(|o| o.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default());
            let low = text.to_lowercase();
            let score = terms.iter().filter(|t| low.contains(t.as_str())).count();
            (score > 0 || terms.is_empty()).then_some((score, text))
        })
        .collect();
    hits.sort_by_key(|h| std::cmp::Reverse(h.0));
    if hits.is_empty() {
        return Ok(format!("no entries match \"{query}\""));
    }
    Ok(hits.into_iter().take(10).map(|h| h.1).collect::<Vec<_>>().join("\n"))
}

async fn brave(state: &DispatchState, q: &str) -> Result<String, String> {
    let key = os_core::os_secret("brave").ok_or("add a Brave Search API key in Settings → Integrations")?;
    let v: Value = state
        .http
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", q), ("count", "6")])
        .header("X-Subscription-Token", key)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(short)?
        .error_for_status()
        .map_err(short)?
        .json()
        .await
        .map_err(short)?;
    let lines: Vec<String> = v["web"]["results"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| format!("- {} — {}\n  {}", r["title"].as_str().unwrap_or(""), r["url"].as_str().unwrap_or(""), r["description"].as_str().unwrap_or("").replace("<strong>", "").replace("</strong>", "")))
        .collect();
    Ok(if lines.is_empty() { "no results".into() } else { lines.join("\n") })
}

// ── Skills ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    name: String,
    description: String,
    path: String,
    kind: String,
    agents: Vec<String>,
}

fn frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return m;
    }
    for l in lines {
        if l.trim() == "---" {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            m.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
        }
    }
    m
}

fn scan(dir: &Path) -> Vec<(String, String, PathBuf, String)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            let skill = p.join("SKILL.md");
            if let Ok(text) = std::fs::read_to_string(&skill) {
                let fm = frontmatter(&text);
                let name = fm.get("name").cloned().unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
                out.push((name, fm.get("description").cloned().unwrap_or_default(), skill, "skill".into()));
            }
        } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if ext == "md" {
                let text = std::fs::read_to_string(&p).unwrap_or_default();
                let fm = frontmatter(&text);
                let desc = fm.get("description").cloned().unwrap_or_else(|| text.lines().find(|l| !l.trim().is_empty() && !l.starts_with("---") && !l.starts_with('#')).unwrap_or("").to_string());
                out.push((fm.get("name").cloned().unwrap_or(stem), desc, p.clone(), "md".into()));
            } else if ext == "json" {
                let v: Value = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                if v.get("name").is_some() || v.get("description").is_some() {
                    out.push((v["name"].as_str().map(String::from).unwrap_or(stem), v["description"].as_str().unwrap_or("").to_string(), p.clone(), "json".into()));
                }
            }
        }
    }
    out.sort_by_key(|s| s.0.to_lowercase());
    out
}

#[tauri::command]
pub fn skills_scan(os: State<'_, OsState>) -> Result<Vec<SkillInfo>, String> {
    let cfg = os.snapshot();
    let dir = PathBuf::from(&cfg.skills.dir);
    if !dir.is_dir() {
        return Err(format!("{} does not exist — create it or point the library at another folder", dir.display()));
    }
    Ok(scan(&dir)
        .into_iter()
        .map(|(name, description, path, kind)| SkillInfo {
            agents: cfg.skills.grants.get(&name).cloned().unwrap_or_default(),
            name,
            description: description.chars().take(240).collect(),
            path: path.display().to_string(),
            kind,
        })
        .collect())
}

/// "- name: description" for every skill attached to `agent`.
pub fn skill_digest(cfg: &OsConfig, agent: &str) -> String {
    let attached: Vec<&String> = cfg.skills.grants.iter().filter(|(_, a)| a.iter().any(|x| x == agent)).map(|(n, _)| n).collect();
    if attached.is_empty() {
        return String::new();
    }
    let all = scan(Path::new(&cfg.skills.dir));
    let lines: Vec<String> = attached
        .iter()
        .take(25)
        .map(|n| {
            let d = all.iter().find(|s| &&s.0 == n).map(|s| s.1.chars().take(140).collect::<String>()).unwrap_or_default();
            format!("- {n}: {d}")
        })
        .collect();
    lines.join("\n")
}

pub fn read_skill(cfg: &OsConfig, name: &str, agent: &str) -> Result<String, String> {
    if !cfg.skills.grants.get(name).is_some_and(|a| a.iter().any(|x| x == agent)) {
        return Err(format!("skill \"{name}\" is not attached to {agent}"));
    }
    let s = scan(Path::new(&cfg.skills.dir)).into_iter().find(|s| s.0 == name).ok_or("skill not found")?;
    Ok(std::fs::read_to_string(&s.2).map_err(|e| e.to_string())?.chars().take(6000).collect())
}

// ── MCP client (stdio / HTTP) ───────────────────────────────────────────────

const PROTOCOL: &str = "2025-06-18";

async fn rpc(state: &DispatchState, s: &McpServer, method: &str, params: Value) -> Result<Value, String> {
    match s.transport.as_str() {
        "stdio" => {
            let s = s.clone();
            let method = method.to_string();
            tauri::async_runtime::spawn_blocking(move || stdio_rpc(&s, &method, params, Duration::from_secs(45))).await.map_err(|e| e.to_string())?
        }
        "http" => http_rpc(state, s, method, params).await,
        _ => Err("not an external MCP server".into()),
    }
}

fn spawn(s: &McpServer) -> std::io::Result<std::process::Child> {
    let mk = |program: &str| {
        let mut c = Command::new(program);
        c.args(&s.args).envs(&s.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c
    };
    match mk(&s.command).spawn() {
        // npx / uvx / pnpm are .cmd shims on Windows.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && cfg!(windows) && !s.command.contains('.') => mk(&format!("{}.cmd", s.command)).spawn(),
        r => r,
    }
}

fn stdio_rpc(s: &McpServer, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let mut child = spawn(s).map_err(|e| format!("could not start {}: {e}", s.command))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = std::time::Instant::now() + timeout;
    let mut send = |v: Value| writeln!(stdin, "{v}").and_then(|_| stdin.flush()).map_err(|e| e.to_string());
    let wait = |id: u64| -> Result<Value, String> {
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let line = rx.recv_timeout(left).map_err(|_| "MCP server timed out".to_string())?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["id"].as_u64() == Some(id) {
                if let Some(e) = v.get("error") {
                    return Err(e["message"].as_str().unwrap_or("MCP error").to_string());
                }
                return Ok(v["result"].clone());
            }
        }
    };
    let result = (|| {
        send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "agentic-os", "version": "1.0" } } }))?;
        wait(1)?;
        send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        send(json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }))?;
        wait(2)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn parse_rpc_body(ct: &str, body: &str, id: u64) -> Result<Value, String> {
    let candidates: Vec<Value> = if ct.contains("event-stream") {
        body.lines().filter_map(|l| l.strip_prefix("data:")).filter_map(|d| serde_json::from_str(d.trim()).ok()).collect()
    } else {
        serde_json::from_str::<Value>(body).map(|v| vec![v]).map_err(|_| "MCP server returned non-JSON".to_string())?
    };
    let v = candidates.into_iter().find(|v| v["id"].as_u64() == Some(id)).ok_or("no MCP response")?;
    if let Some(e) = v.get("error") {
        return Err(e["message"].as_str().unwrap_or("MCP error").to_string());
    }
    Ok(v["result"].clone())
}

async fn http_rpc(state: &DispatchState, s: &McpServer, method: &str, params: Value) -> Result<Value, String> {
    let post = |body: Value, session: Option<String>| {
        let mut rb = state.http.post(&s.url).timeout(Duration::from_secs(30)).header("Accept", "application/json, text/event-stream").header("MCP-Protocol-Version", PROTOCOL).json(&body);
        if let Some(sid) = session {
            rb = rb.header("Mcp-Session-Id", sid);
        }
        for (k, v) in &s.env {
            // HTTP servers: "env" entries become request headers (e.g. Authorization).
            rb = rb.header(k.as_str(), v.as_str());
        }
        rb
    };
    let r = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "agentic-os", "version": "1.0" } } }), None).send().await.map_err(short)?;
    let sid = r.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(String::from);
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = r.error_for_status().map_err(short)?.text().await.map_err(short)?;
    parse_rpc_body(&ct, &body, 1)?;
    let _ = post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), sid.clone()).send().await;
    let r = post(json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }), sid).send().await.map_err(short)?;
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = r.error_for_status().map_err(short)?.text().await.map_err(short)?;
    parse_rpc_body(&ct, &body, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_tools_hidden_from_router() {
        for t in ["whatsapp.send_message", "whatsapp.send_file", "fs.write_file", "git.git_commit", "playwright.browser_click", "kg.delete_entities"] {
            assert!(is_mutating_tool(t), "{t}");
        }
        for t in ["whatsapp.list_messages", "whatsapp.search_contacts", "weather.current", "fs.read", "git.status", "kg.search"] {
            assert!(!is_mutating_tool(t), "{t}");
        }
    }

    #[test]
    fn private_hosts_blocked() {
        for h in ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.2", "100.64.0.10", "foo.local"] {
            assert!(private_host(h), "{h}");
        }
        assert!(!private_host("example.com"));
        assert!(!private_host("8.8.8.8"));
    }

    #[test]
    fn html_stripped() {
        assert_eq!(html_to_text("<html><head><title>x</title></head><body><p>Hi&amp;bye</p><script>evil()</script></body></html>"), "Hi&bye");
    }

    #[test]
    fn frontmatter_parsed() {
        let fm = frontmatter("---\nname: animate\ndescription: \"Make it move\"\n---\nbody");
        assert_eq!(fm.get("name").map(String::as_str), Some("animate"));
        assert_eq!(fm.get("description").map(String::as_str), Some("Make it move"));
    }

    #[test]
    fn sse_body_parsed() {
        let v = parse_rpc_body("text/event-stream", "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n", 2).unwrap();
        assert_eq!(v["ok"], true);
    }
}
