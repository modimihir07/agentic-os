//! The OS's own tools: built-in MCP equivalents implemented natively (no
//! process to spawn, always available) plus a minimal MCP client for any
//! stdio / HTTP server the user adds in Settings → Skills & MCP Library.
//!
//! Safety:
//!   - Every tool is read-only from the model's point of view. Nothing here
//!     writes files, sends messages or runs arbitrary commands; the one
//!     mutating builtin (`gmail.create_draft`) is hidden from the router and
//!     refuses to run unless the user approved it. Spotify playback tools are
//!     hidden from the router too; only deterministic plans call them.
//!   - Filesystem / git are confined to the allowed roots (canonicalised).
//!   - Fetch refuses loopback / private / mesh addresses (no SSRF into your
//!     own services) and is blocked by the kill switch.
//!   - User-added MCP servers run with the command line the user typed into
//!     Settings — never one proposed by a model.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

use super::bridge::BridgeState;
use super::dispatch::{short, DispatchState};
use super::gmail::Source as GmailSource;
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

pub(crate) fn builtin_tools(id: &str) -> Vec<ToolInfo> {
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
        "gmail" => vec![
            t(id, "gmail.recent", "Most recent inbox emails (sender, subject, date, preview).", &["count?"]),
            t(id, "gmail.search", "Search Gmail with Gmail query syntax (from:sam, is:unread, subject:rates, newer_than:7d).", &["query", "limit?"]),
            t(id, "gmail.read_thread", "Read one email thread in full by its thread id (from gmail.recent / gmail.search).", &["threadId"]),
            t(id, "gmail.create_draft", "Save a draft email (not sent). Only after the user's confirmation card.", &["to", "subject", "body"]),
        ],
        "spotify" => vec![
            t(id, "spotify.now_playing", "What's playing on Spotify right now (track, artist, device, volume).", &[]),
            t(id, "spotify.recent", "The user's recently played Spotify tracks.", &[]),
            t(id, "spotify.playlists", "The user's Spotify playlists.", &[]),
            t(id, "spotify.play", "Search Spotify and play the first hit.", &["query", "kind?"]),
            t(id, "spotify.pause", "Pause Spotify playback.", &[]),
            t(id, "spotify.resume", "Resume Spotify playback.", &[]),
            t(id, "spotify.next", "Skip to the next track.", &[]),
            t(id, "spotify.previous", "Go back to the previous track.", &[]),
            t(id, "spotify.volume", "Set Spotify volume (0-100, or \"+N\"/\"-N\").", &["percent"]),
        ],
        _ => vec![],
    }
}

/// A builtin's tools, or an error when its backend isn't configured, so the
/// registry never shows a false "ok" for a server that can't answer.
fn builtin_listing(id: &str, gmail: impl Fn() -> GmailSource, has_brave_key: impl Fn() -> bool, spotify: impl Fn() -> Result<(), String>) -> Result<Vec<ToolInfo>, String> {
    match id {
        "gmail" => match gmail() {
            GmailSource::None => Err(super::gmail::NO_BACKEND.into()),
            GmailSource::N8n(_) => Ok(builtin_tools(id).into_iter().filter(|t| t.name == "gmail.recent").collect()),
            GmailSource::Script => Ok(builtin_tools(id)),
        },
        "brave-search" if !has_brave_key() => Err("Brave Search: no API key — add one in Settings → Integrations".into()),
        "spotify" => spotify().map(|_| builtin_tools(id)),
        _ => Ok(builtin_tools(id)),
    }
}

/// Why server `id` can't serve tools right now (switched off, or no backend), if so.
pub(crate) fn unavailable_reason(state: &DispatchState, cfg: &OsConfig, id: &str) -> Option<String> {
    let s = cfg.mcps.iter().find(|m| m.id == id)?;
    if !s.enabled {
        return Some(format!("{} is switched off — enable it in Settings → Skills & MCP Library", s.name));
    }
    if s.transport != "builtin" {
        // Cheap, no network: a remote server whose token is missing.
        return remote_token(state, s).err();
    }
    listing(state, id).err()
}

fn listing(state: &DispatchState, id: &str) -> Result<Vec<ToolInfo>, String> {
    builtin_listing(id, || super::gmail::source(state), || brave_key(state).is_some(), || super::spotify::readiness(state))
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
    /// "ok" | "off" | "needs_token" | "auth_failed" | "error": lets the UI offer a Configure action.
    status: &'static str,
    /// For a remote server that takes a token: which keychain secret / `.env` key holds it.
    auth: Option<AuthInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthInfo {
    secret: &'static str,
    env: &'static str,
    label: &'static str,
}

// ── Remote MCP tokens ───────────────────────────────────────────────────────

/// A remote MCP host that needs a bearer token. The token is bound to `host`: it is only
/// ever attached to requests for a server whose URL is on that exact host.
pub(crate) struct RemoteAuth {
    host: &'static str,
    secret: &'static str,
    env: &'static str,
    label: &'static str,
}

pub(crate) const REMOTE_AUTH: [RemoteAuth; 3] = [
    RemoteAuth { host: "api.githubcopilot.com", secret: "github-pat", env: "GITHUB_PAT", label: "GitHub personal access token" },
    RemoteAuth { host: "mcp.sentry.dev", secret: "sentry-token", env: "SENTRY_AUTH_TOKEN", label: "Sentry auth token" },
    RemoteAuth { host: "mcp.agentmail.to", secret: "agentmail-key", env: "AGENTMAIL_API_KEY", label: "AgentMail API key" },
];

fn remote_auth(s: &McpServer) -> Option<&'static RemoteAuth> {
    if s.transport != "http" {
        return None;
    }
    let u = reqwest::Url::parse(&s.url).ok()?;
    // Only over TLS to the service's own port: a plain-http or odd-port URL never gets a token.
    if u.scheme() != "https" || u.port_or_known_default() != Some(443) {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    REMOTE_AUTH.iter().find(|a| a.host == host)
}

/// The token for a token-taking remote server: `.env` / environment first, then the
/// keychain (Settings → Skills & MCP Library). `Ok(None)` = this server takes no token.
fn remote_token(state: &DispatchState, s: &McpServer) -> Result<Option<String>, String> {
    let Some(a) = remote_auth(s) else { return Ok(None) };
    // The user set their own Authorization header on this server: use only that one.
    if s.env.keys().any(|k| k.eq_ignore_ascii_case("authorization")) {
        return Ok(None);
    }
    super::envfile::env_or_file(state, a.env)
        .or_else(|| os_core::os_secret(a.secret))
        .map(Some)
        .ok_or_else(|| needs_token_msg(&s.name, a))
}

fn needs_token_msg(name: &str, a: &RemoteAuth) -> String {
    format!("{name}: needs a {} ({NEEDS_TOKEN}) — add it under Configure in Settings → Skills & MCP Library, or set {} in the repo .env", a.label, a.env)
}

const NEEDS_TOKEN: &str = "no token set";
const TOKEN_REJECTED: &str = "token was rejected";

fn status_of(err: &str) -> &'static str {
    if err.contains(NEEDS_TOKEN) {
        "needs_token"
    } else if err.contains(TOKEN_REJECTED) {
        "auth_failed"
    } else {
        "error"
    }
}

fn rejected_msg(name: &str, code: u16) -> String {
    format!("{name}: {TOKEN_REJECTED} (HTTP {code}) — it may have expired; update it under Configure in Settings → Skills & MCP Library")
}

/// Failed listings of external servers, so a server that's down or refusing us isn't
/// re-asked (and re-logged) on every chat turn. Keyed by server id plus a fingerprint of
/// its token, so saving a new token retries at once. Memory only; the token isn't kept.
static FAILED: Mutex<Option<HashMap<String, (u64, u64, String)>>> = Mutex::new(None);
const FAILED_TTL: u64 = 300;

fn token_fingerprint(token: Option<&str>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

fn failed_get(id: &str, fp: u64, now: u64) -> Option<String> {
    let g = FAILED.lock().unwrap();
    let (at, f, e) = g.as_ref()?.get(id)?;
    (*f == fp && now.saturating_sub(*at) < FAILED_TTL).then(|| e.clone())
}

fn failed_set(id: &str, entry: Option<(u64, u64, String)>) {
    let mut g = FAILED.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    match entry {
        Some(e) => {
            m.insert(id.to_string(), e);
        }
        None => {
            m.remove(id);
        }
    }
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

/// Spotify tools the router may pick; playback runs only from deterministic
/// plans (`agents::spotify_plan`) or the UI, so the router stays read-only.
const SPOTIFY_ROUTER_TOOLS: [&str; 3] = ["spotify.now_playing", "spotify.recent", "spotify.playlists"];

fn offered_to_router(name: &str) -> bool {
    !is_mutating_tool(name) && (!name.starts_with("spotify.") || SPOTIFY_ROUTER_TOOLS.contains(&name))
}

/// Tools `agent` is actually allowed to use: every enabled server it is
/// granted (`McpServer.grants`), minus mutating tools and Spotify playback. Tony (`"general"` or
/// `"tony"`) always gets every enabled server, regardless of its grant list
/// (Part 2 spec). Servers are queried concurrently with a short per-server
/// timeout so one dead external server can't stall the whole listing.
pub async fn enabled_tools(state: &DispatchState, os: &OsState, agent: &str) -> Vec<ToolInfo> {
    let cfg = os.snapshot();
    let is_tony = agent == "general" || agent == "tony";
    let servers: Vec<McpServer> = cfg.mcps.iter().filter(|s| s.enabled && (is_tony || s.grants(agent))).cloned().collect();
    let results = futures_util::future::join_all(servers.iter().map(|s| async move {
        match tokio::time::timeout(Duration::from_secs(10), tools_of(state, os, s, false)).await {
            Ok(Ok(v)) => v,
            // tools_of logged a fresh failure once; cached and token-less ones stay quiet.
            Ok(Err(_)) => vec![],
            Err(_) => {
                eprintln!("[mcp] {}: tools/list timed out", s.id);
                vec![]
            }
        }
    }))
    .await;
    let mut out: Vec<ToolInfo> = results.into_iter().flatten().filter(|t| offered_to_router(&t.name)).collect();
    if cfg.skills.grants.values().any(|a| os_core::agent_matches(a, agent)) {
        out.push(t("skills", "skills.read", "Read the full instructions of one of your attached skills.", &["name"]));
    }
    out
}

async fn tools_of(state: &DispatchState, os: &OsState, s: &McpServer, refresh: bool) -> Result<Vec<ToolInfo>, String> {
    if s.transport == "builtin" {
        return listing(state, &s.id);
    }
    // No token: say so without a network call (and without logging it every turn).
    let token = remote_token(state, s)?;
    let now = os_core::now_secs();
    let fp = token_fingerprint(token.as_deref());
    if !refresh {
        if let Some((at, tools)) = os.mcp_tools.lock().unwrap().get(&s.id) {
            if now - at < 600 {
                return Ok(tools.clone());
            }
        }
        if let Some(e) = failed_get(&s.id, fp, now) {
            return Err(e);
        }
    }
    let res = match rpc(state, s, "tools/list", json!({})).await {
        Ok(v) => {
            failed_set(&s.id, None);
            v
        }
        Err(e) => {
            eprintln!("[mcp] {}: {e}", s.id);
            failed_set(&s.id, Some((now, fp, e.clone())));
            return Err(e);
        }
    };
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
        let auth = remote_auth(s).map(|a| AuthInfo { secret: a.secret, env: a.env, label: a.label });
        if !s.enabled {
            out.push(ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: false, ok: false, error: None, tools: builtin_tools(&s.id), status: "off", auth });
            continue;
        }
        let r = tools_of(&state, &os, s, refresh.unwrap_or(false)).await;
        out.push(match r {
            Ok(tools) => ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: true, ok: true, error: None, tools, status: "ok", auth },
            Err(e) => {
                let status = status_of(&e);
                ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: true, ok: false, error: Some(e), tools: vec![], status, auth }
            }
        });
    }
    Ok(out)
}

/// Run one tool from Settings ("Test") — same gates as when Tony calls it.
#[tauri::command]
pub async fn mcp_call(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, name: String, args: Value, approved: Option<bool>, agent: Option<String>) -> Result<String, String> {
    call_tool(&state, &os, &bridge, &name, &args, approved.unwrap_or(false), agent.as_deref().unwrap_or("tony")).await
}

// ── Calling ─────────────────────────────────────────────────────────────────

/// `agent` is whichever role is making the call (`"tony"`/`"general"` for the
/// OS's own calls and Settings → Test). It only gates `skills.read` here —
/// which tools are *offered* at all is `enabled_tools`'s job; a caller that
/// already knows the tool name (the Settings tester, a deterministic plan)
/// can still call it even if it wasn't in that agent's list, same as before
/// Part 2 — the real gate against a sub-agent reaching tools it has no
/// business touching is that the pre-executor in `agents.rs` only ever
/// builds a plan from `enabled_tools(..., agent)` in the first place.
pub async fn call_tool(state: &DispatchState, os: &OsState, bridge: &BridgeState, name: &str, args: &Value, approved: bool, agent: &str) -> Result<String, String> {
    let cfg = os.snapshot();
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", approved, json!({ "tool": name }))?;
    let arg = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
    let server_on = |id: &str| cfg.mcps.iter().any(|m| m.id == id && m.enabled);
    // An async block, so an early `?`/`return` still reaches `bridge.log` below.
    let out: Result<String, String> = async {
        match name {
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
            // Drafts never run from here (whatever `approved` says): only `gmail_create_draft`, after the confirmation card.
            gmail if gmail.starts_with("gmail.") && server_on("gmail") => super::gmail::tool(state, os, gmail, args, false).await,
            spotify if spotify.starts_with("spotify.") && server_on("spotify") => super::spotify::tool(state, os, spotify, args).await,
            "skills.read" => read_skill(&cfg, &arg("name"), agent),
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
        }
    }
    .await;
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

/// `BRAVE_API_KEY` from the environment / repo-root `.env` first (the direct credential),
/// else the keychain entry Settings saves. Read fresh each call, so a new key works
/// without a restart.
fn brave_key(state: &DispatchState) -> Option<String> {
    super::envfile::env_or_file(state, "BRAVE_API_KEY").or_else(|| os_core::os_secret("brave"))
}

async fn brave(state: &DispatchState, q: &str) -> Result<String, String> {
    let key = brave_key(state).ok_or("add a Brave Search API key in Settings → Integrations")?;
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
    let attached: Vec<&String> = cfg.skills.grants.iter().filter(|(_, a)| os_core::agent_matches(a, agent)).map(|(n, _)| n).collect();
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
    if !cfg.skills.grants.get(name).is_some_and(|a| os_core::agent_matches(a, agent)) {
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
    let token = remote_token(state, s)?;
    // Only a token we attached can be "rejected"; other servers keep their plain HTTP error.
    let managed = token.is_some();
    let rejected = |r: &reqwest::Response| (managed && matches!(r.status().as_u16(), 401 | 403)).then(|| rejected_msg(&s.name, r.status().as_u16()));
    let post = |body: Value, session: Option<String>| {
        let mut rb = state.http.post(&s.url).timeout(Duration::from_secs(30)).header("Accept", "application/json, text/event-stream").header("MCP-Protocol-Version", PROTOCOL).json(&body);
        if let Some(sid) = session {
            rb = rb.header("Mcp-Session-Id", sid);
        }
        for (k, v) in &s.env {
            // HTTP servers: "env" entries become request headers (e.g. Authorization).
            rb = rb.header(k.as_str(), v.as_str());
        }
        if let Some(t) = &token {
            rb = rb.bearer_auth(t);
        }
        rb
    };
    let r = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "agentic-os", "version": "1.0" } } }), None).send().await.map_err(short)?;
    if let Some(e) = rejected(&r) {
        return Err(e);
    }
    let sid = r.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(String::from);
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = r.error_for_status().map_err(short)?.text().await.map_err(short)?;
    parse_rpc_body(&ct, &body, 1)?;
    let _ = post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), sid.clone()).send().await;
    let r = post(json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }), sid).send().await.map_err(short)?;
    if let Some(e) = rejected(&r) {
        return Err(e);
    }
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = r.error_for_status().map_err(short)?.text().await.map_err(short)?;
    parse_rpc_body(&ct, &body, 2)
}

// ── AnythingLLM MCP sync ─────────────────────────────────────────────────────
//
// AnythingLLM Desktop runs MCP servers on its own agent sessions, reading a
// separate registry file. Tony's own registry (above) is the single source
// of truth the user edits; this one-way sync *adds* Tony's non-builtin
// servers to AnythingLLM's file so its sub-agent sessions can reach the same
// tools, without ever touching an entry AnythingLLM already has (its `env`
// commonly holds API keys the user set there directly).

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllmSyncReport {
    pub added: Vec<String>,
    pub kept: Vec<String>,
    pub skipped: Vec<String>,
}

fn anythingllm_mcp_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("anythingllm-desktop").join("storage").join("plugins").join("anythingllm_mcp_servers.json"))
}

/// Pure merge: `existing` is the parsed `anythingllm_mcp_servers.json` (or
/// `{"mcpServers":{}}` if the file doesn't exist yet / is malformed).
/// Returns the new file content plus a report. Never overwrites or removes
/// an entry AnythingLLM already has; never converts a `builtin` server (it
/// has no command line to give AnythingLLM) or a disabled one.
fn merge_allm_servers(existing: &Value, mcps: &[McpServer]) -> (Value, AllmSyncReport) {
    let mut servers = existing.get("mcpServers").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut report = AllmSyncReport::default();
    for m in mcps {
        if m.transport == "builtin" {
            continue;
        }
        if !m.enabled {
            report.skipped.push(format!("{} (disabled)", m.id));
            continue;
        }
        if servers.contains_key(&m.id) {
            report.kept.push(m.id.clone());
            continue;
        }
        let entry = match m.transport.as_str() {
            "stdio" => json!({ "command": m.command, "args": m.args, "env": m.env }),
            // Best-effort shape for a streamable-HTTP MCP server — AnythingLLM's
            // registry otherwise only holds command-line (stdio) servers today
            // (confirmed by reading the live file); unverified against a real
            // HTTP entry, so it's one more reason to always keep the user's own
            // edit once they've confirmed it works.
            "http" => json!({ "type": "streamable-http", "url": m.url, "headers": m.env }),
            _ => {
                report.skipped.push(format!("{} (unknown transport \"{}\")", m.id, m.transport));
                continue;
            }
        };
        servers.insert(m.id.clone(), entry);
        report.added.push(m.id.clone());
    }
    (json!({ "mcpServers": Value::Object(servers) }), report)
}

/// Merge Tony's MCP registry into AnythingLLM Desktop's own MCP config so its
/// sub-agent sessions can reach the same stdio/HTTP servers. Writes a
/// timestamped `.bak` first whenever the file already exists and is about to
/// change. Called automatically after the MCP registry saves (`os_config_update`
/// with a `mcps` patch) and from a "Sync to AnythingLLM" button in the drawer.
#[tauri::command]
pub fn mcp_sync_anythingllm(os: State<'_, OsState>) -> Result<AllmSyncReport, String> {
    let cfg = os.snapshot();
    let path = anythingllm_mcp_path().ok_or("%APPDATA% is not set")?;
    let existing: Value = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({ "mcpServers": {} })),
        Err(_) => json!({ "mcpServers": {} }),
    };
    let (next, report) = merge_allm_servers(&existing, &cfg.mcps);
    if report.added.is_empty() {
        // Nothing to add — leave the file exactly as it is (no `.bak` churn).
        return Ok(report);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let bak = PathBuf::from(format!("{}.{}.bak", path.display(), os_core::now_secs()));
        let _ = std::fs::copy(&path, &bak);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(report)
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
    fn gmail_tools_split_read_only_and_draft() {
        let names: Vec<String> = builtin_tools("gmail").into_iter().map(|t| t.name).collect();
        assert_eq!(names, ["gmail.recent", "gmail.search", "gmail.read_thread", "gmail.create_draft"]);
        for t in ["gmail.recent", "gmail.search", "gmail.read_thread"] {
            assert!(!is_mutating_tool(t), "{t}");
        }
        assert!(is_mutating_tool("gmail.create_draft"));
    }

    #[test]
    fn remote_tokens_are_bound_to_their_host() {
        let srv = |url: &str, transport: &str| McpServer { id: "x".into(), name: "X".into(), transport: transport.into(), command: String::new(), args: vec![], env: BTreeMap::new(), url: url.into(), enabled: true, builtin: false, description: String::new(), agents: None };
        assert_eq!(remote_auth(&srv("https://api.githubcopilot.com/mcp/", "http")).map(|a| a.secret), Some("github-pat"));
        assert_eq!(remote_auth(&srv("https://API.githubcopilot.com/mcp/", "http")).map(|a| a.env), Some("GITHUB_PAT"));
        // A look-alike host or a stdio server never gets the GitHub token.
        assert!(remote_auth(&srv("https://api.githubcopilot.com.evil.example/mcp/", "http")).is_none());
        assert!(remote_auth(&srv("https://evil.example/?u=api.githubcopilot.com", "http")).is_none());
        assert!(remote_auth(&srv("https://api.githubcopilot.com/mcp/", "stdio")).is_none());
        assert!(remote_auth(&srv("https://mcp.context7.com/mcp", "http")).is_none());
        // Never over plain http or to another port of the same host.
        assert!(remote_auth(&srv("http://api.githubcopilot.com/mcp/", "http")).is_none());
        assert!(remote_auth(&srv("https://api.githubcopilot.com:8443/mcp/", "http")).is_none());
        assert!(remote_auth(&srv("https://api.githubcopilot.com:443/mcp/", "http")).is_some());
    }

    #[test]
    fn remote_auth_statuses() {
        let a = &REMOTE_AUTH[0];
        assert_eq!(status_of(&needs_token_msg("GitHub", a)), "needs_token");
        assert_eq!(status_of(&rejected_msg("GitHub", 401)), "auth_failed");
        assert_eq!(status_of("HTTP 500 Internal Server Error"), "error");
        assert!(!needs_token_msg("GitHub", a).contains("ghp_"));
        let fp = token_fingerprint(Some("t1"));
        failed_set("srv-test", Some((100, fp, "boom".into())));
        assert_eq!(failed_get("srv-test", fp, 200).as_deref(), Some("boom"));
        assert_eq!(failed_get("srv-test", token_fingerprint(Some("t2")), 200), None, "a new token retries at once");
        assert_eq!(failed_get("srv-test", fp, 100 + FAILED_TTL), None, "expires");
        failed_set("srv-test", None);
    }

    #[test]
    fn builtin_listing_is_honest_about_backends() {
        let ok = || Ok(());
        let e = builtin_listing("gmail", || GmailSource::None, || true, ok).unwrap_err();
        assert!(e.starts_with("Gmail: no backend"), "{e}");
        let n8n: Vec<String> = builtin_listing("gmail", || GmailSource::N8n("gmail-digest"), || true, ok).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(n8n, ["gmail.recent"]);
        assert_eq!(builtin_listing("gmail", || GmailSource::Script, || true, ok).unwrap().len(), 4);
        assert!(builtin_listing("brave-search", || GmailSource::None, || false, ok).is_err());
        assert_eq!(builtin_listing("brave-search", || GmailSource::None, || true, ok).unwrap().len(), 1);
        assert_eq!(builtin_listing("weather", || GmailSource::None, || false, ok).unwrap().len(), 1);
        let e = builtin_listing("spotify", || GmailSource::None, || true, || Err(super::super::spotify::NOT_CONNECTED.into())).unwrap_err();
        assert!(e.starts_with("Spotify isn't connected"), "{e}");
        assert_eq!(builtin_listing("spotify", || GmailSource::None, || true, ok).unwrap().len(), 9);
    }

    #[test]
    fn spotify_router_sees_only_read_tools() {
        let offered: Vec<String> = builtin_tools("spotify").into_iter().map(|t| t.name).filter(|n| offered_to_router(n)).collect();
        assert_eq!(offered, ["spotify.now_playing", "spotify.recent", "spotify.playlists"]);
        for t in ["spotify.play", "spotify.pause", "spotify.volume", "spotify.next"] {
            assert!(!offered_to_router(t), "{t}");
        }
        assert!(offered_to_router("weather.current") && !offered_to_router("gmail.create_draft"));
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

    fn mcp_stdio(id: &str, enabled: bool) -> McpServer {
        McpServer {
            id: id.into(),
            name: id.into(),
            transport: "stdio".into(),
            command: "uv".into(),
            args: vec!["run".into(), "main.py".into()],
            env: BTreeMap::new(),
            url: String::new(),
            enabled,
            builtin: false,
            description: String::new(),
            agents: None,
        }
    }

    fn mcp_builtin(id: &str, enabled: bool) -> McpServer {
        McpServer { id: id.into(), name: id.into(), transport: "builtin".into(), command: String::new(), args: vec![], env: BTreeMap::new(), url: String::new(), enabled, builtin: true, description: String::new(), agents: None }
    }

    #[test]
    fn allm_sync_adds_missing_keeps_existing_skips_builtin_and_disabled() {
        // Fixture: AnythingLLM already has "git" (with an API key in its env)
        // and nothing else. Tony's registry has a builtin (never synced), a
        // disabled stdio server (never synced) and a new enabled one ("whatsapp")
        // that should be added, plus "git" again (must NOT be overwritten).
        let existing = json!({
            "mcpServers": {
                "git": { "command": "uvx", "args": ["mcp-server-git"], "env": { "SOME_KEY": "keep-me" } }
            }
        });
        let mcps = vec![
            mcp_builtin("weather", true),
            mcp_stdio("git", true),
            mcp_stdio("disabled-one", false),
            mcp_stdio("whatsapp", true),
        ];
        let (next, report) = merge_allm_servers(&existing, &mcps);
        assert_eq!(report.added, vec!["whatsapp".to_string()]);
        assert_eq!(report.kept, vec!["git".to_string()]);
        assert_eq!(report.skipped, vec!["disabled-one (disabled)".to_string()]);
        // "git"'s existing entry (with the user's key) is untouched.
        assert_eq!(next["mcpServers"]["git"]["env"]["SOME_KEY"], json!("keep-me"));
        assert_eq!(next["mcpServers"]["git"]["args"], json!(["mcp-server-git"]));
        // "whatsapp" was added with Tony's command line.
        assert_eq!(next["mcpServers"]["whatsapp"]["command"], json!("uv"));
        // The builtin weather server never appears at all.
        assert!(next["mcpServers"].get("weather").is_none());
    }

    #[test]
    fn allm_sync_starts_from_empty_when_file_is_missing() {
        let (next, report) = merge_allm_servers(&json!({ "mcpServers": {} }), &[mcp_stdio("whatsapp", true)]);
        assert_eq!(report.added, vec!["whatsapp".to_string()]);
        assert!(report.kept.is_empty());
        assert_eq!(next["mcpServers"]["whatsapp"]["command"], json!("uv"));
    }

    #[test]
    fn allm_sync_http_server_gets_a_streamable_entry() {
        let http = McpServer { id: "custom-http".into(), name: "Custom".into(), transport: "http".into(), command: String::new(), args: vec![], env: BTreeMap::new(), url: "http://127.0.0.1:9000/mcp".into(), enabled: true, builtin: false, description: String::new(), agents: None };
        let (next, report) = merge_allm_servers(&json!({ "mcpServers": {} }), &[http]);
        assert_eq!(report.added, vec!["custom-http".to_string()]);
        assert_eq!(next["mcpServers"]["custom-http"]["url"], json!("http://127.0.0.1:9000/mcp"));
    }
}
