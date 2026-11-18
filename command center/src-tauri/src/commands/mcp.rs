//! The OS's own tools: built-in MCP equivalents implemented natively (no
//! process to spawn, always available) plus a minimal MCP client for any
//! stdio / HTTP server the user adds in Settings → Skills & MCP Library.
//!
//! Safety:
//!   - Every tool the model's router is offered is read-only, with ONE explicit
//!     exception: Tony's router may pick the Spotify tools in `SPOTIFY_ROUTER_TOOLS`
//!     (`spotify_intent::ALL_TOOLS`): playback control, and — only when the line names a
//!     playlist / Liked Songs (agents.rs `router_offer`) — library edits. They still run
//!     through `call_tool`'s MCP permission gate (Ask ⇒ card), the destructive gate for
//!     removals, and Spotify's kill-switch check. Sub-agents get only the Spotify read
//!     tools (`spotify_intent::READ_TOOLS`). Nothing
//!     else here writes files, sends messages or runs arbitrary commands; the
//!     one other mutating builtin (`gmail.create_draft`) is hidden from the
//!     router and refuses to run unless the user approved it, and every other
//!     mutating tool (`is_mutating_tool`) stays excluded from the router.
//!   - Filesystem / git are confined to the allowed roots (canonicalised).
//!   - Fetch refuses loopback / private / mesh addresses (no SSRF into your
//!     own services) and is blocked by the kill switch.
//!   - User-added MCP servers run with the command line the user typed into
//!     Settings — never one proposed by a model.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;
use tokio::sync::watch;

#[path = "mcp_session.rs"]
mod session;

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
        "spotify" => spotify_tools(id),
        _ => vec![],
    }
}

/// Spotify's 23 tools (`spotify_intent::ALL_TOOLS` order) with their §4.4 argument names.
/// Aliases (`spotify.recent`, `spotify.playlists`) are accepted by dispatch but never listed.
fn spotify_tools(id: &str) -> Vec<ToolInfo> {
    const ONLY: &str = " Spotify only (not YouTube or local audio).";
    let rows: [(&str, &str, &[&str]); 23] = [
        ("spotify.now_playing", "What's playing on Spotify: song, artist, album, position, playlist and whether it's in Liked Songs.", &[]),
        ("spotify.get_queue", "The next songs in the Spotify queue.", &[]),
        ("spotify.recently_played", "Songs the user played recently on Spotify.", &["limit?"]),
        ("spotify.top_items", "The user's top Spotify songs or artists (type: tracks|artists; time_range: short_term|medium_term|long_term).", &["type?", "time_range?", "limit?"]),
        ("spotify.list_playlists", "The user's Spotify playlists with song counts.", &[]),
        ("spotify.get_playlist_tracks", "The songs in one of the user's playlists, by name.", &["playlist_name"]),
        ("spotify.play", "Play music: query (song, artist, \"song by artist\"), optional type track|artist|album|playlist, or playlist_name for the user's own playlist; device_name to play on a named device; shuffle true to shuffle.", &["query?", "type?", "playlist_name?", "device_name?", "shuffle?"]),
        ("spotify.pause", "Pause Spotify playback.", &[]),
        ("spotify.resume", "Resume Spotify playback (optionally on a named device).", &["device_name?"]),
        ("spotify.next", "Skip to the next track (count 1-5).", &["count?"]),
        ("spotify.previous", "Go back to the previous track.", &[]),
        ("spotify.seek", "Jump in the current song: position_sec (absolute) or offset_sec (+/- seconds).", &["position_sec?", "offset_sec?"]),
        ("spotify.restart_track", "Restart the current song.", &[]),
        ("spotify.volume", "Set Spotify volume (0-100, or \"+N\"/\"-N\").", &["percent"]),
        ("spotify.shuffle", "Turn shuffle on or off (state true|false).", &["state"]),
        ("spotify.repeat", "Set repeat (mode off|track|context).", &["mode"]),
        ("spotify.transfer_device", "Move Spotify playback to a named device (\"my phone\", \"this computer\", \"kitchen speaker\").", &["device_name"]),
        ("spotify.queue_add", "Add a song to the Spotify queue (query, or \"current\").", &["query"]),
        ("spotify.create_playlist", "Create a playlist (private unless public is true), optionally with songs from initial_queries.", &["name", "public?", "initial_queries?", "description?"]),
        ("spotify.add_to_playlist", "Add a song (track_query, default the current song) to one of the user's playlists; create true makes the playlist if missing.", &["playlist_name", "track_query?", "create?"]),
        ("spotify.remove_from_playlist", "Remove a song (track_query, default the current song) from one of the user's playlists.", &["playlist_name", "track_query?"]),
        ("spotify.like_track", "Add a song (track_query, default the current song) to Liked Songs.", &["track_query?"]),
        ("spotify.unlike_track", "Remove a song (track_query, default the current song) from Liked Songs.", &["track_query?"]),
    ];
    rows.iter().map(|(name, desc, args)| t(id, name, &format!("{desc}{ONLY}"), args)).collect()
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
    /// "ok" | "off" | "needs_token" | "auth_failed" | "starting" | "error": lets the UI offer a
    /// Configure action, and show a server that is still cold-starting as such (not failed).
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
    // `a.env` is `envfile::ENV_FOR[a.secret]` (pinned by `remote_auth_env_matches_env_for`).
    super::envfile::os_key(state, a.secret).map(Some).ok_or_else(|| needs_token_msg(&s.name, a))
}

#[cfg(test)]
mod remote_auth_tests {
    use super::*;

    #[test]
    fn remote_auth_env_matches_env_for() {
        for a in &REMOTE_AUTH {
            assert_eq!(super::super::envfile::env_var_for(a.secret), Some(a.env), "{} must map to {} in envfile::ENV_FOR", a.secret, a.env);
            assert!(os_core::OS_SECRETS.contains(&a.secret));
        }
    }
}

fn needs_token_msg(name: &str, a: &RemoteAuth) -> String {
    format!("{name}: needs a {} ({NEEDS_TOKEN}) — add it under Configure in Settings → Skills & MCP Library, or set {} in the repo .env", a.label, a.env)
}

const NEEDS_TOKEN: &str = "no token set";
const TOKEN_REJECTED: &str = "token was rejected";

/// The error says a server is still cold-starting (not a failure).
pub(crate) fn is_starting_error(err: &str) -> bool {
    err.contains(session::STARTING)
}

fn status_of(err: &str) -> &'static str {
    if err.contains(NEEDS_TOKEN) {
        "needs_token"
    } else if err.contains(TOKEN_REJECTED) {
        "auth_failed"
    } else if err.contains(session::STARTING) {
        "starting"
    } else {
        "error"
    }
}

fn rejected_msg(name: &str, code: u16) -> String {
    format!("{name}: {TOKEN_REJECTED} (HTTP {code}) — it may have expired; update it under Configure in Settings → Skills & MCP Library")
}

/// Failed listings of external servers, so a server that's down or refusing us isn't
/// re-asked (and re-logged) on every chat turn. Keyed by server id plus a fingerprint of
/// its whole config and token (`server_fingerprint`), so saving a new token, editing the
/// command line or reinstalling retries at once. Memory only; the token isn't kept.
static FAILED: Mutex<Option<HashMap<String, (u64, u64, String)>>> = Mutex::new(None);
const FAILED_TTL: u64 = 300;
/// A cached listing is fresh this long; older ones (same config) are still served while
/// a background re-list runs, up to `STALE_MAX`.
const LIST_FRESH: u64 = 600;
const STALE_MAX: u64 = 24 * 3600;
/// A stdio server whose session was reaped (idle) keeps its listing this long without a
/// re-list: re-listing would cold-spawn it just to read the same tool names.
const STDIO_IDLE_KEEP: u64 = 6 * 3600;

/// How a cached listing (same config) of `age` seconds is used.
#[derive(Debug, PartialEq, Clone, Copy)]
enum CacheUse {
    /// Serve it, no re-list.
    Fresh,
    /// Serve it and re-list in the background.
    Revalidate,
    /// Too old: list again before answering.
    Expired,
}

fn cache_use(stdio: bool, age: u64, session_alive: bool) -> CacheUse {
    if age < LIST_FRESH || (stdio && !session_alive && age < STDIO_IDLE_KEEP) {
        CacheUse::Fresh
    } else if age < STALE_MAX {
        CacheUse::Revalidate
    } else {
        CacheUse::Expired
    }
}

/// `cache_use` for server `s` (config `fp`) right now. The long idle keep applies only
/// to a session the reaper stopped: one that crashed or hung proves nothing about its tools.
fn cache_use_of(s: &McpServer, fp: u64, at: u64, now: u64) -> CacheUse {
    let stdio = s.transport == "stdio";
    let idle_stopped = stdio && !session::alive(&s.id) && !matches!(session::last_end(&s.id, fp), Some(session::End::Crashed(_)));
    cache_use(idle_stopped, now.saturating_sub(at), false)
}

/// Remote HTTP servers are off-limits while the kill switch is on (no listing, no call).
fn remote_blocked(cfg: &os_core::OsConfig, s: &McpServer) -> bool {
    cfg.privacy.kill_switch && s.transport == "http" && os_core::is_remote(&dummy_provider(&s.url))
}
const KILL_SWITCH_MCP: &str = "kill switch is on — remote MCP blocked";

/// A process-local hash of everything that decides how a server is reached: transport,
/// command, args, env, URL, working folder, timeout and token. Never stored on disk or
/// shown; the token itself is not kept.
pub(crate) fn server_fingerprint(s: &McpServer, token: Option<&str>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&s.transport, &s.command, &s.args, &s.env, &s.url, &s.cwd, &s.timeout_secs, token).hash(&mut h);
    h.finish()
}

fn failed_get(id: &str, fp: u64, now: u64) -> Option<String> {
    let g = FAILED.lock().unwrap();
    let (at, f, e) = g.as_ref()?.get(id)?;
    (*f == fp && now.saturating_sub(*at) < FAILED_TTL).then(|| e.clone())
}

/// Deep-scan timeouts (System Map only, never read by routing), so the bus can say why a
/// server shows no listing. Same TTL as FAILED.
static SCAN_TIMEOUTS: Mutex<Option<HashMap<String, (u64, String)>>> = Mutex::new(None);

fn scan_timeout_get(id: &str, now: u64) -> Option<String> {
    let g = SCAN_TIMEOUTS.lock().unwrap();
    let (at, e) = g.as_ref()?.get(id)?;
    (now.saturating_sub(*at) < FAILED_TTL).then(|| e.clone())
}

fn scan_timeout_set(id: &str, entry: Option<(u64, String)>) {
    let mut g = SCAN_TIMEOUTS.lock().unwrap();
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
    // "append" / "insert" / "replace" / "drop" / "alter" / "truncate": SQLite's write_query /
    // create_table / append_insight and Serena's code edits; "clink" (PAL) runs other CLIs;
    // "evaluate" / "repl" run code; "activate" / "switch" / "restart" / "kill" change state;
    // "open_dashboard" (Serena) opens a browser window. Browser side effects: "new_" (new_page
    // loads any URL), "close", "select", "press", "handle_dialog", "drag", "emulate", "resize",
    // "hover", "tabs", "performance_start" (reloads the page).
    [
        "send", "reply", "post", "delete", "remove", "write", "create", "update", "edit", "move", "rename", "upload", "download_media", "set_", "add_", "run", "exec", "execute", "click", "type", "fill", "navigate", "install", "commit", "push", "pay", "book", "append", "insert", "replace", "drop", "alter", "truncate", "clink", "evaluate", "activate", "switch", "restart", "kill", "repl", "open_dashboard", "new_", "close", "select", "press", "handle_dialog", "drag", "emulate", "resize", "hover", "tabs", "performance_start",
    ]
        .iter()
        .any(|v| tool.starts_with(v) || tool.contains(&format!("_{v}")))
}

/// Spotify tools Tony's LLM router may pick: every listed tool. The one deliberate
/// exception to the read-only router (see the module docs); library edits are further
/// limited to lines that name a playlist / Liked Songs (agents.rs `router_offer`).
/// Anything Spotify adds later stays hidden until it is listed in `ALL_TOOLS` on purpose.
const SPOTIFY_ROUTER_TOOLS: [&str; 23] = super::spotify_intent::ALL_TOOLS;
/// What a sub-agent's router sees of Spotify: reads only.
const SPOTIFY_READ_TOOLS: [&str; 6] = super::spotify_intent::READ_TOOLS;

/// `name` is a Spotify write the router may run (not a read).
pub(crate) fn is_spotify_actuator(name: &str) -> bool {
    SPOTIFY_ROUTER_TOOLS.contains(&name) && super::spotify_intent::is_write_tool(name)
}

/// Whether `name` changes data: Spotify uses its own read/write table (critic #28), every
/// other tool the verb list.
fn changes_data(name: &str) -> bool {
    if name.starts_with("spotify.") {
        super::spotify_intent::is_write_tool(name)
    } else {
        is_mutating_tool(name)
    }
}

/// Browser-driving servers: the router only ever sees their read-only tools (an allowlist,
/// so a tool a new version adds stays hidden instead of slipping past the verb list).
const BROWSER_SERVERS: [&str; 2] = ["chrome-devtools", "playwright"];
const BROWSER_READ_TOOLS: [&str; 14] = [
    "take_snapshot", "take_screenshot", "list_pages", "list_console_messages", "get_console_message", "list_network_requests", "get_network_request",
    "browser_snapshot", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_network_request", "browser_find", "browser_wait_for",
];

/// Whether the model's router may be offered `name`. `tony`: Tony's own turn.
pub(crate) fn offered_to_router(name: &str, tony: bool) -> bool {
    if name.starts_with("spotify.") {
        return if tony { SPOTIFY_ROUTER_TOOLS.contains(&name) } else { SPOTIFY_READ_TOOLS.contains(&name) };
    }
    if let Some((server, tool)) = name.split_once('.') {
        if BROWSER_SERVERS.contains(&server) {
            return BROWSER_READ_TOOLS.contains(&tool);
        }
    }
    !is_mutating_tool(name)
}

/// A read-only server (`McpServer.read_only`) never lists its mutating tools.
fn visible_tools(s: &McpServer, tools: Vec<ToolInfo>) -> Vec<ToolInfo> {
    if s.read_only {
        tools.into_iter().filter(|t| !changes_data(&t.name)).collect()
    } else {
        tools
    }
}

/// Error prefix for a mutating tool on a read-only server (`Prefetch` labels it "blocked").
pub(crate) const READ_ONLY_PREFIX: &str = "PERMISSION_READ_ONLY:";

/// Refuse a mutating tool of a read-only server, for every caller.
fn read_only_refusal(cfg: &os_core::OsConfig, name: &str) -> Option<String> {
    let sid = server_of_tool(name);
    let s = cfg.mcps.iter().find(|m| m.id == sid && m.read_only)?;
    changes_data(name).then(|| format!("{READ_ONLY_PREFIX}{sid} — {} is set to read-only, so {name} (it changes data) is blocked; untick Read-only for it in Settings → Skills & MCP Library to allow it", s.name))
}

/// Pure part of `tool_set`: the router-visible subset of `all`, order kept.
pub(crate) fn router_filter(all: &[ToolInfo], tony: bool) -> Vec<ToolInfo> {
    all.iter().filter(|t| offered_to_router(&t.name, tony)).cloned().collect()
}

pub(crate) fn is_tony(agent: &str) -> bool {
    agent == "general" || agent == "tony"
}

/// Every tool of the servers `agent` may use (`all`) and the subset its LLM
/// router is offered (`offered`). The single source of truth for a turn's tool
/// list: `agents::prefetch_tools` and the `tony_tools_preview` command both use it.
pub struct ToolSet {
    pub all: Vec<ToolInfo>,
    pub offered: Vec<ToolInfo>,
}

/// Tools `agent` is actually allowed to use: every enabled server it is
/// granted (`McpServer.grants`); `offered` drops tools the router may not be
/// offered (`offered_to_router`). Tony (`"general"` or `"tony"`) always gets
/// every enabled server, regardless of its grant list (Part 2 spec). Servers
/// are queried concurrently with a short per-server timeout so one dead
/// external server can't stall the whole listing.
pub async fn tool_set(state: &DispatchState, os: &OsState, agent: &str) -> ToolSet {
    let cfg = os.snapshot();
    let is_tony = is_tony(agent);
    let servers: Vec<McpServer> = cfg.mcps.iter().filter(|s| s.enabled && (is_tony || s.grants(agent))).cloned().collect();
    // A cold server costs a turn at most `CHAT_LIST_WAIT`: its listing keeps going in the
    // background and lands in the cache for the next turn. The outer timeout is only a
    // backstop and never writes FAILED.
    let results = futures_util::future::join_all(servers.iter().map(|s| async move {
        match tokio::time::timeout(CHAT_LIST_WAIT + Duration::from_secs(2), tools_of(state, os, s, false, CHAT_LIST_WAIT)).await {
            Ok(Ok(v)) => v,
            // tools_of / the background listing logged a fresh failure once; cached,
            // starting and token-less ones stay quiet.
            Ok(Err(_)) | Err(_) => vec![],
        }
    }))
    .await;
    let mut all: Vec<ToolInfo> = results.into_iter().flatten().collect();
    if cfg.skills.grants.values().any(|a| os_core::agent_matches(a, agent)) {
        all.push(t("skills", "skills.read", "Read the full instructions of one of your attached skills.", &["name"]));
    }
    let offered = router_filter(&all, is_tony);
    ToolSet { all, offered }
}

/// Tell the webview the set of tools a turn can use changed (Spotify connected /
/// disconnected / revoked, MCP registry saved): `tools-changed` `{reason}`.
pub(crate) fn emit_tools_changed(app: &tauri::AppHandle, reason: &str) {
    use tauri::Emitter;
    let _ = app.emit("tools-changed", json!({ "reason": reason }));
}

/// How long a chat turn waits for a server that isn't listed yet.
const CHAT_LIST_WAIT: Duration = Duration::from_secs(3);
/// How long a chat tool call waits for a cold-starting server before saying "starting".
pub(crate) const CHAT_START_WAIT: Duration = Duration::from_secs(3);
/// `tools/list` over a ready session / one HTTP request.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// stdio `initialize` deadline: the server's own `timeout_secs`, else 120 s for package
/// launchers (npx / uvx / uv / pnpm / pnpx / bunx / pipx / serena), else 45 s.
pub(crate) fn startup_timeout(s: &McpServer) -> Duration {
    startup_secs(s.timeout_secs, &s.command)
}

fn startup_secs(timeout_secs: Option<u32>, command: &str) -> Duration {
    Duration::from_secs(match timeout_secs {
        Some(t) => u64::from(t),
        None if crate::exe_resolve::is_slow_launcher(command) => 120,
        None => 45,
    })
}

/// Per-request deadline for a tool call: 60 s, or the server's `timeout_secs` if larger
/// (a low startup timeout must never make slow tool calls fail).
fn request_timeout(s: &McpServer) -> Duration {
    Duration::from_secs(s.timeout_secs.map(u64::from).unwrap_or(60).max(60))
}

type ListResult = Result<Vec<ToolInfo>, String>;
type InflightMap = HashMap<String, (u64, u64, watch::Receiver<Option<ListResult>>)>;

/// Listings running in the background, by server id: (fingerprint, generation, result
/// channel). Joined by every caller for the same config, so a server is never spawned
/// twice for one listing.
static INFLIGHT: Mutex<Option<InflightMap>> = Mutex::new(None);
static INFLIGHT_GEN: AtomicU64 = AtomicU64::new(1);
/// Finished background listings not yet copied into `OsState::mcp_tools` (the task that
/// produced them has no `OsState`): (unix secs, fingerprint, tools).
static LISTED: Mutex<Option<HashMap<String, (u64, u64, Vec<ToolInfo>)>>> = Mutex::new(None);

fn lock<T>(m: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Releases a server's INFLIGHT slot when its background listing ends (even on panic).
struct InflightGuard {
    id: String,
    gen: u64,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Some(m) = lock(&INFLIGHT).as_mut() {
            if m.get(&self.id).is_some_and(|(_, g, _)| *g == self.gen) {
                m.remove(&self.id);
            }
        }
    }
}

fn inflight(id: &str) -> bool {
    lock(&INFLIGHT).as_ref().is_some_and(|m| m.contains_key(id))
}

/// Copy finished background listings into the managed cache.
fn promote_listed(os: &OsState) {
    let done: Vec<(String, (u64, u64, Vec<ToolInfo>))> = match lock(&LISTED).as_mut() {
        Some(m) if !m.is_empty() => m.drain().collect(),
        _ => return,
    };
    let mut cache = os.mcp_tools.lock().unwrap();
    for (id, entry) in done {
        if cache.get(&id).map_or(true, |(at, _, _)| *at <= entry.0) {
            cache.insert(id, entry);
        }
    }
}

/// The cached listing of `id` for config `fp`, if any: (unix secs, tools).
fn cached_listing(os: &OsState, id: &str, fp: u64) -> Option<(u64, Vec<ToolInfo>)> {
    os.mcp_tools.lock().unwrap().get(id).filter(|(_, f, _)| *f == fp).map(|(at, _, t)| (*at, t.clone()))
}

/// What the network side needs, owned, so a listing can outlive the caller's turn.
#[derive(Clone)]
struct Ctx {
    http: reqwest::Client,
    workdir: Option<PathBuf>,
}

fn ctx(state: &DispatchState) -> Ctx {
    let wd = PathBuf::from(state.snapshot().gateway.workdir);
    Ctx { http: state.http.clone(), workdir: wd.is_dir().then_some(wd) }
}

/// Every secret value that could show up in a server's stderr: the known secrets plus
/// the server's own env values (PAL's API key…). Used only to scrub; never stored.
fn known_for(state: &DispatchState, os: &OsState, s: &McpServer) -> Vec<String> {
    let mut known = super::devqueue::known_secrets(state, os);
    known.extend(s.env.values().cloned());
    known.extend(arg_secrets(&s.args));
    // The child inherits this process's whole environment: any credential-named variable
    // it may read (OPENAI_API_KEY, HF_TOKEN…) could show up in its stderr.
    known.extend(std::env::vars().filter(|(k, v)| credential_name(k) && v.trim().len() >= 6).map(|(_, v)| v.trim().to_string()));
    known
}

fn credential_name(k: &str) -> bool {
    let k = k.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASS", "_PAT", "AUTH", "CREDENTIAL"].iter().any(|n| k.contains(n))
}

/// The secret-bearing parts of a server's args: `--api-key X` / `--token=X` values, URL
/// passwords, and random-looking values. Package names, paths etc. are left alone.
fn arg_secrets(args: &[String]) -> Vec<String> {
    let flag = |a: &str| {
        let a = a.trim_start_matches('-').to_ascii_lowercase();
        ["key", "token", "secret", "pass", "pwd", "auth", "credential"].iter().any(|n| a.contains(n))
    };
    let mut out = Vec::new();
    for (i, a) in args.iter().enumerate() {
        if let Some((k, v)) = a.split_once('=') {
            if k.starts_with('-') && flag(k) {
                out.push(v.to_string());
            }
        }
        if a.starts_with('-') && !a.contains('=') && flag(a) {
            if let Some(next) = args.get(i + 1) {
                out.push(next.clone());
            }
        }
        if let Ok(u) = url::Url::parse(a) {
            if let Some(p) = u.password() {
                out.push(p.to_string());
                if let Ok(d) = urlencoding_decode(p) {
                    out.push(d);
                }
            }
        }
        if a.len() >= 32 && a.chars().any(|c| c.is_ascii_uppercase()) && a.chars().any(|c| c.is_ascii_lowercase()) && a.chars().any(|c| c.is_ascii_digit()) {
            out.push(a.clone());
        }
    }
    out.retain(|v| v.trim().len() >= 6);
    out
}

/// Percent-decode a URL password (`url` keeps it encoded).
fn urlencoding_decode(s: &str) -> Result<String, ()> {
    url::form_urlencoded::parse(format!("x={s}").as_bytes()).next().map(|(_, v)| v.into_owned()).ok_or(())
}

fn parse_tools(s: &McpServer, res: &Value) -> Vec<ToolInfo> {
    res["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tl| {
            let name = tl["name"].as_str()?;
            let args = tl["inputSchema"]["properties"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            Some(ToolInfo { name: format!("{}.{name}", s.id), description: tl["description"].as_str().unwrap_or("").chars().take(200).collect(), server: s.id.clone(), args })
        })
        .collect()
}

/// Join the running background listing of `s` (same config), or start one. It writes
/// LISTED / FAILED itself when it finishes, whether or not anyone is still waiting.
fn start_or_join_listing(state: &DispatchState, os: &OsState, s: &McpServer, token: Option<String>, fp: u64) -> watch::Receiver<Option<ListResult>> {
    let mut g = lock(&INFLIGHT);
    let m = g.get_or_insert_with(HashMap::new);
    if let Some((f, _, rx)) = m.get(&s.id) {
        if *f == fp {
            return rx.clone();
        }
    }
    let (tx, rx) = watch::channel(None);
    let gen = INFLIGHT_GEN.fetch_add(1, Ordering::SeqCst);
    m.insert(s.id.clone(), (fp, gen, rx.clone()));
    drop(g);
    let known = known_for(state, os, s);
    let c = ctx(state);
    let s = s.clone();
    tauri::async_runtime::spawn(async move {
        let _slot = InflightGuard { id: s.id.clone(), gen };
        let res = rpc(&c, &s, token, fp, "tools/list", json!({}), startup_timeout(&s), LIST_TIMEOUT).await.map(|v| parse_tools(&s, &v)).map_err(|e| super::devqueue::scrub(&e, &known));
        let now = os_core::now_secs();
        match &res {
            Ok(tools) => {
                failed_set(&s.id, None);
                lock(&LISTED).get_or_insert_with(HashMap::new).insert(s.id.clone(), (now, fp, tools.clone()));
            }
            Err(e) => {
                eprintln!("[mcp] {}: {e}", s.id);
                // A tools/list that timed out behind other calls on a shared session says the
                // server is busy, not broken: leave FAILED alone so the next revalidation retries.
                let queued = s.transport == "stdio" && e.contains("no reply to tools/list") && session::busy(&s.id) > 0;
                if !queued {
                    failed_set(&s.id, Some((now, fp, e.clone())));
                }
            }
        }
        let _ = tx.send(Some(res));
    });
    rx
}

/// Wait up to `wait` for a listing; `None` = still running.
async fn await_listing(mut rx: watch::Receiver<Option<ListResult>>, wait: Duration) -> Option<ListResult> {
    if wait.is_zero() {
        return rx.borrow().clone();
    }
    match tokio::time::timeout(wait, rx.wait_for(|v| v.is_some())).await {
        Ok(Ok(v)) => v.clone(),
        Ok(Err(_)) => Some(Err("MCP listing stopped unexpectedly".into())),
        Err(_) => None,
    }
}

fn listing_starting_msg(s: &McpServer) -> String {
    format!("{} {} — its tools will be ready shortly (allowing up to {}s for a cold start)", s.name, session::STARTING, startup_timeout(s).as_secs())
}

/// The tools of one server. `refresh` skips the caches; `wait` bounds how long this call
/// waits for a listing that has to run (it keeps running in the background either way,
/// and the next call finds it cached). A remote server whose token is missing returns
/// `needs_token` here, before any network call.
async fn tools_of(state: &DispatchState, os: &OsState, s: &McpServer, refresh: bool, wait: Duration) -> ListResult {
    tools_of_all(state, os, s, refresh, wait).await.map(|t| visible_tools(s, t))
}

/// Pure part of `tools_of`'s cache policy: what a non-refresh call does with a cached
/// listing (`use_`), a recent failure (`failed`) and whether the server's last session
/// crashed while it isn't running (`crashed`).
#[derive(Debug, PartialEq)]
enum CacheAnswer {
    Serve,
    Fail,
    List,
}

fn cache_answer(use_: Option<CacheUse>, failed: bool, crashed: bool) -> CacheAnswer {
    match use_ {
        // A crash the call path recorded beats a listing from before it.
        Some(CacheUse::Fresh) if !(crashed && failed) => CacheAnswer::Serve,
        // A recent failure only throttles the re-list; the stale listing of the same config
        // still answers (a slow tools/list behind a long call must not hide every tool).
        Some(CacheUse::Revalidate) if failed && !crashed => CacheAnswer::Serve,
        _ if failed => CacheAnswer::Fail,
        _ => CacheAnswer::List,
    }
}

async fn tools_of_all(state: &DispatchState, os: &OsState, s: &McpServer, refresh: bool, wait: Duration) -> ListResult {
    if s.transport == "builtin" {
        return listing(state, &s.id);
    }
    // Kill switch: no request to a remote host at all — not even loading its token.
    if remote_blocked(&os.snapshot(), s) {
        return Err(format!("{}: {KILL_SWITCH_MCP}", s.name));
    }
    // No token: say so without a network call (and without logging it every turn).
    let token = remote_token(state, s)?;
    let now = os_core::now_secs();
    let fp = server_fingerprint(s, token.as_deref());
    promote_listed(os);
    let cached = cached_listing(os, &s.id, fp);
    if !refresh {
        let failed = failed_get(&s.id, fp, now);
        let crashed = s.transport == "stdio" && !session::alive(&s.id) && matches!(session::last_end(&s.id, fp), Some(session::End::Crashed(_)));
        match cache_answer(cached.as_ref().map(|(at, _)| cache_use_of(s, fp, *at, now)), failed.is_some(), crashed) {
            CacheAnswer::Serve => return Ok(cached.map(|(_, t)| t).unwrap_or_default()),
            CacheAnswer::Fail => return Err(failed.unwrap_or_default()),
            CacheAnswer::List => {}
        }
    }
    let rx = start_or_join_listing(state, os, s, token, fp);
    // Stale-while-revalidate: an older listing of the same config answers now.
    if !refresh {
        if let Some((at, tools)) = cached {
            if cache_use_of(s, fp, at, now) != CacheUse::Expired {
                return Ok(tools);
            }
        }
    }
    match await_listing(rx, wait).await {
        Some(Ok(tools)) => {
            promote_listed(os);
            Ok(tools)
        }
        Some(Err(e)) => Err(e),
        None => Err(listing_starting_msg(s)),
    }
}

/// Settings → Skills & MCP Library: every server's listing, all servers at once. Each
/// waits up to its startup timeout + 5 s; one still going after that reports "starting".
#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, DispatchState>, os: State<'_, OsState>, refresh: Option<bool>) -> Result<Vec<ServerTools>, String> {
    let cfg = os.snapshot();
    let refresh = refresh.unwrap_or(false);
    let (state, os) = (&*state, &*os);
    let out = futures_util::future::join_all(cfg.mcps.iter().map(|s| async move {
        let auth = remote_auth(s).map(|a| AuthInfo { secret: a.secret, env: a.env, label: a.label });
        if !s.enabled {
            return ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: false, ok: false, error: None, tools: builtin_tools(&s.id), status: "off", auth };
        }
        let wait = if s.transport == "http" { LIST_TIMEOUT * 2 } else { startup_timeout(s) } + Duration::from_secs(5);
        match tools_of(state, os, s, refresh, wait).await {
            Ok(tools) => ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: true, ok: true, error: None, tools, status: "ok", auth },
            Err(e) => {
                let status = status_of(&e);
                ServerTools { id: s.id.clone(), name: s.name.clone(), enabled: true, ok: false, error: Some(e), tools: vec![], status, auth }
            }
        }
    }))
    .await;
    Ok(out)
}

/// Start listing every enabled stdio server in the background shortly after launch, so
/// the first chat turn finds their tools cached. HTTP servers are left alone (no network
/// on boot — a token-gated one would only be refused anyway).
pub async fn warm(app: tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let state = app.state::<DispatchState>();
    let os = app.state::<OsState>();
    let cfg = os.snapshot();
    // Kill switch: no server is spawned at boot (npx / uvx launchers reach package registries).
    if cfg.permissions.mcp == super::bridge::Tier::Deny || cfg.privacy.kill_switch {
        return;
    }
    for s in cfg.mcps.iter().filter(|s| s.enabled && s.transport == "stdio") {
        let _ = tools_of(&state, &os, s, false, Duration::ZERO).await;
    }
}

/// Each server's state as far as it is known *without a network call*: off, the
/// builtin's local readiness, a missing token, a cached failure or a cached success.
/// `"unknown"` = not listed in the last 10 minutes. Error text only, never tokens.
pub(crate) fn cached_statuses(state: &DispatchState, os: &OsState) -> Vec<Value> {
    let cfg = os.snapshot();
    let now = os_core::now_secs();
    promote_listed(os);
    cfg.mcps
        .iter()
        .map(|s| {
            // Only for a server that can be reached (token present): its config fingerprint.
            let mut fp = None;
            let (status, error): (&str, Option<String>) = if !s.enabled {
                ("off", None)
            } else if s.transport == "builtin" {
                match listing(state, &s.id) {
                    Ok(_) => ("ok", None),
                    Err(e) => (status_of(&e), Some(e)),
                }
            } else {
                match remote_token(state, s) {
                    _ if remote_blocked(&cfg, s) => ("off", Some(format!("{}: {KILL_SWITCH_MCP}", s.name))),
                    // Missing token: a muted "needs_token", known without any network call.
                    Err(e) => (status_of(&e), Some(e)),
                    Ok(token) => {
                        let f = server_fingerprint(s, token.as_deref());
                        fp = Some(f);
                        if cached_listing(os, &s.id, f).is_some_and(|(at, _)| cache_use_of(s, f, at, now) == CacheUse::Fresh) {
                            ("ok", None)
                        } else if inflight(&s.id) || session::is_starting(&s.id) {
                            ("starting", None)
                        } else if let Some(e) = failed_get(&s.id, f, now) {
                            (status_of(&e), Some(e))
                        } else if let Some(e) = scan_timeout_get(&s.id, now) {
                            ("error", Some(e))
                        } else {
                            ("unknown", None)
                        }
                    }
                }
            };
            let tools = if !s.enabled {
                None
            } else if s.transport == "builtin" {
                listing(state, &s.id).ok().map(|t| t.len())
            } else {
                fp.and_then(|f| cached_listing(os, &s.id, f).filter(|(at, _)| cache_use_of(s, f, *at, now) == CacheUse::Fresh)).map(|(_, t)| visible_tools(s, t).len())
            };
            let mut v = json!({ "id": s.id, "name": s.name, "transport": s.transport, "status": status, "error": error, "tools": tools });
            if let Some(c) = call_stats(&s.id) {
                v["calls"] = json!(c.calls);
                v["failures"] = json!(c.failures);
                v["lastMs"] = json!(c.last_ms);
                v["lastOk"] = json!(c.last_ok);
                v["lastError"] = json!(c.last_error);
                v["lastAt"] = json!(c.last_at);
            }
            v
        })
        .collect()
}

/// Run one tool from Settings ("Test") — same gates as when Tony calls it.
#[tauri::command]
pub async fn mcp_call(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, name: String, args: Value, approved: Option<bool>, agent: Option<String>) -> Result<String, String> {
    call_tool(&state, &os, &bridge, &name, &args, approved.unwrap_or(false), agent.as_deref().unwrap_or("tony")).await
}

// ── Calling ─────────────────────────────────────────────────────────────────

/// `agent` is whichever role is making the call (`"tony"`/`"general"` for the
/// OS's own calls and Settings → Test). It only gates `skills.read` here —
/// which tools are *offered* at all is `tool_set`'s job; a caller that
/// already knows the tool name (the Settings tester, a deterministic plan)
/// can still call it even if it wasn't in that agent's list, same as before
/// Part 2 — the real gate against a sub-agent reaching tools it has no
/// business touching is that the pre-executor in `agents.rs` only ever
/// builds a plan from `tool_set(..., agent).offered` in the first place.
pub async fn call_tool(state: &DispatchState, os: &OsState, bridge: &BridgeState, name: &str, args: &Value, approved: bool, agent: &str) -> Result<String, String> {
    call_tool_with(state, os, bridge, name, args, approved, agent, None).await
}

/// `call_tool`, choosing how long to wait for an external stdio server that is still
/// starting (`None` = its full startup timeout). A chat turn passes a few seconds and
/// gets a "… is still starting" error instead of blocking; the start carries on and the
/// next call reuses the running server.
#[allow(clippy::too_many_arguments)]
pub async fn call_tool_with(state: &DispatchState, os: &OsState, bridge: &BridgeState, name: &str, args: &Value, approved: bool, agent: &str, start_wait: Option<Duration>) -> Result<String, String> {
    let cfg = os.snapshot();
    // A read-only server's write tools are refused for every caller, before any card asks.
    if let Some(e) = read_only_refusal(&cfg, name) {
        trace_tool(state, os, name, 0, Some(&e));
        return Err(e);
    }
    // Spotify: reads skip the Ask card (kill switch + Deny only, D27); writes take the MCP tier
    // and, for removals, the destructive gate. Everything else: the MCP tier.
    let gate = if name.starts_with("spotify.") && super::spotify_intent::ALL_TOOLS.contains(&super::spotify_intent::canonical(name)) {
        super::spotify::tool_gate(&cfg, bridge, super::spotify_intent::canonical(name), approved)
    } else {
        os_core::gate(bridge, cfg.permissions.mcp, "mcp", approved, json!({ "tool": name }))
    };
    if let Err(e) = gate {
        trace_tool(state, os, name, 0, Some(&e));
        return Err(e);
    }
    let started = std::time::Instant::now();
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
                if remote_blocked(&cfg, s) {
                    return Err(KILL_SWITCH_MCP.into());
                }
                // A token-gated server without its token stops here, before any network call.
                let token = remote_token(state, s)?;
                let fp = server_fingerprint(s, token.as_deref());
                let wait = start_wait.unwrap_or_else(|| startup_timeout(s));
                let res = rpc(&ctx(state), s, token, fp, "tools/call", json!({ "name": tool, "arguments": args }), wait, request_timeout(s)).await.map_err(|e| {
                    let e = super::devqueue::scrub(&e, &known_for(state, os, s));
                    // The server died / couldn't start: stop offering its (cached) tools until
                    // FAILED_TTL passes or its config changes, instead of cold-spawning a crash per turn.
                    if s.transport == "stdio" && session_broken(&e) {
                        failed_set(&s.id, Some((os_core::now_secs(), fp, e.clone())));
                    }
                    e
                })?;
                let text: Vec<String> = res["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str().map(String::from)).collect();
                let joined = if text.is_empty() { res.to_string() } else { text.join("\n") };
                if res["isError"].as_bool() == Some(true) {
                    // Scrub before capping, so a cut can't leave a fragment of a known value.
                    Err(super::devqueue::scrub(&joined, &known_for(state, os, s)).chars().take(500).collect())
                } else {
                    Ok(joined)
                }
            }
        }
    }
    .await;
    let out = out.map(|s| s.chars().take(8000).collect::<String>());
    record_call(server_of_tool(name), started.elapsed().as_millis() as u64, out.as_ref().err().map(String::as_str), os_core::now_secs());
    trace_tool(state, os, name, started.elapsed().as_millis(), out.as_ref().err().map(String::as_str));
    bridge.log(json!({ "type": "os-tool", "tool": name, "ok": out.is_ok(), "chars": out.as_ref().map(|s| s.len()).unwrap_or(0) }));
    out
}

/// System Map `os-trace` step for one tool call: the tool name, outcome, latency and error
/// text only (never arguments or results); the error is scrubbed against every known secret.
fn trace_tool(state: &DispatchState, os: &OsState, name: &str, ms: u128, error: Option<&str>) {
    let known = if error.is_some() { super::devqueue::known_secrets(state, os) } else { Vec::new() };
    super::trace::emit_with(super::trace::Hop::Tool, name, error.is_none(), ms, error, None, &known);
}

// -- Per-server call stats (System Map "bus") --------------------------------

/// Calls, last latency, last outcome and last error text per server id. Memory only;
/// never arguments or results. Error text is capped here and scrubbed again before display.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallStats {
    pub calls: u64,
    pub failures: u64,
    pub last_ms: u64,
    pub last_ok: bool,
    pub last_error: Option<String>,
    /// Unix secs of the last call.
    pub last_at: u64,
}

static CALLS: Mutex<Option<HashMap<String, CallStats>>> = Mutex::new(None);
const CALL_ERR_MAX: usize = 200;

/// The registry server a tool name belongs to (`fs.read` -> `filesystem`, `whatsapp.send_message` -> `whatsapp`).
pub(crate) fn server_of_tool(name: &str) -> &str {
    let prefix = name.split_once('.').map_or(name, |(p, _)| p);
    match prefix {
        "fs" => "filesystem",
        "kg" => "knowledge-graph",
        "web" => "brave-search",
        other => other,
    }
}

pub(crate) fn record_call(server: &str, ms: u64, err: Option<&str>, now: u64) {
    let mut g = CALLS.lock().unwrap();
    let e = g.get_or_insert_with(HashMap::new).entry(server.to_string()).or_default();
    e.calls += 1;
    e.last_ms = ms;
    e.last_ok = err.is_none();
    e.last_at = now;
    if let Some(err) = err {
        e.failures += 1;
        e.last_error = Some(cap_words(err, CALL_ERR_MAX));
    }
}

/// `s` cut to at most `max` chars, at a word boundary (plus "…"), so the cut never leaves a
/// fragment of a secret the later scrub couldn't recognise.
fn cap_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let cut = match cut.rfind(' ') {
        Some(i) => cut[..i].to_string(),
        None => cut,
    };
    format!("{cut}…")
}

/// A stdio tool error that means the session itself is gone (crash, failed start, hung),
/// not a slow cold start or the tool's own error.
fn session_broken(e: &str) -> bool {
    e.contains("exited before replying") || e.contains("could not start") || e.contains(session::NOT_READING)
}

/// Stats for server `id`, if it has been called since the app started.
pub(crate) fn call_stats(id: &str) -> Option<CallStats> {
    CALLS.lock().unwrap().as_ref()?.get(id).cloned()
}

/// Re-list every enabled external server now (concurrently, `timeout` each), refreshing
/// the success / failure caches that `cached_statuses` reads. System Map deep scan only.
pub(crate) async fn refresh_listings(state: &DispatchState, os: &OsState, timeout: Duration) {
    let servers: Vec<McpServer> = os.snapshot().mcps.into_iter().filter(|s| s.enabled && s.transport != "builtin").collect();
    futures_util::future::join_all(servers.iter().map(|s| async move {
        // A deep scan's own timeout is System Map display only: it must never land in
        // FAILED, which gates the tools Tony is offered on every turn (a server warming up
        // cold would otherwise drop out of routing for FAILED_TTL). A slow listing keeps
        // running in the background (the bus shows "starting") and lands in the cache.
        // A token-gated server without its token returns `needs_token` with no network call.
        let r = tokio::time::timeout(timeout + Duration::from_secs(2), tools_of(state, os, s, true, timeout)).await;
        match r {
            Err(_) => scan_timeout_set(&s.id, Some((os_core::now_secs(), format!("{}: tools/list timed out ({} s)", s.name, timeout.as_secs())))),
            Ok(Err(e)) if status_of(&e) == "starting" => scan_timeout_set(&s.id, Some((os_core::now_secs(), format!("{}: still starting after {} s", s.name, timeout.as_secs())))),
            Ok(_) => scan_timeout_set(&s.id, None),
        }
    }))
    .await;
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
        stt_prompt: None,
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

/// The personal knowledge graph `kg.search` reads (the System Map reports whether it exists).
pub(crate) const KG_PATH: &str = r"C:\ai-hub\memory\knowledge-graph.json";

fn kg_search(query: &str) -> Result<String, String> {
    let path = Path::new(KG_PATH);
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
    super::envfile::os_key(state, "brave")
}

/// Where the Brave key comes from (same resolver as `brave_key`): `"env"`, `"keychain"` or `"none"`.
pub(crate) fn brave_source(state: &DispatchState) -> &'static str {
    use super::envfile::KeySource;
    match super::envfile::key_source(state, "brave") {
        KeySource::Env | KeySource::EnvFile => "env",
        KeySource::Keychain => "keychain",
        KeySource::Missing => "none",
    }
}

async fn brave(state: &DispatchState, q: &str) -> Result<String, String> {
    let key = brave_key(state).ok_or("add a Brave Search API key in Settings → Integrations, or set BRAVE_API_KEY in the repo-root .env")?;
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

use session::PROTOCOL;

/// One request to an external server. stdio goes through the server's persistent session
/// (`mcp_session.rs`): `start_wait` bounds how long to wait for a cold start before
/// returning "… is still starting" (the start continues), `timeout` bounds the request.
/// http does its own initialize per call with the host-bound `token`.
#[allow(clippy::too_many_arguments)]
async fn rpc(c: &Ctx, s: &McpServer, token: Option<String>, fp: u64, method: &str, params: Value, start_wait: Duration, timeout: Duration) -> Result<Value, String> {
    match s.transport.as_str() {
        "stdio" => {
            let launch_s = s.clone();
            let workdir = c.workdir.clone();
            let sess = tauri::async_runtime::spawn_blocking(move || launch_for(&launch_s, workdir, fp).and_then(session::get_or_start)).await.map_err(|e| e.to_string())??;
            session::wait_ready(&sess, start_wait).await?;
            session::request(&sess, method, params, timeout).await
        }
        "http" => http_rpc(c.http.clone(), token, s.clone(), method.to_string(), params).await,
        _ => Err("not an external MCP server".into()),
    }
}

/// How to start a stdio server: the resolved program (see `exe_resolve`), its merged
/// PATH, its working folder (its own `cwd`, else the repo) and its startup timeout.
fn launch_for(s: &McpServer, workdir: Option<PathBuf>, fp: u64) -> Result<session::Launch, String> {
    let own = s.cwd.as_deref().map(str::trim).filter(|d| !d.is_empty());
    if let Some(d) = own {
        if !std::path::Path::new(d).is_dir() {
            return Err(format!("could not start {}: working folder {d} does not exist", s.command));
        }
    }
    let cwd = own.map(PathBuf::from).or(workdir);
    // The session runs in the RESOLVED folder: a new gateway workdir starts a fresh one.
    let fp = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (fp, &cwd).hash(&mut h);
        h.finish()
    };
    let r = crate::exe_resolve::resolve_program(&s.command, &s.env, cwd.as_deref())?;
    Ok(session::Launch {
        id: s.id.clone(),
        name: s.name.clone(),
        fp,
        program: r.program,
        display: s.command.clone(),
        args: s.args.clone(),
        env: s.env.clone(),
        path_env: r.path_env,
        cwd,
        startup: startup_timeout(s),
    })
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

/// Owned arguments so a background listing can run it after the caller's turn ended.
/// `token` comes from `remote_token` (host-bound); `None` for a server that takes none.
async fn http_rpc(http: reqwest::Client, token: Option<String>, s: McpServer, method: String, params: Value) -> Result<Value, String> {
    // Only a token we attached can be "rejected"; other servers keep their plain HTTP error.
    let managed = token.is_some();
    let rejected = |r: &reqwest::Response| (managed && matches!(r.status().as_u16(), 401 | 403)).then(|| rejected_msg(&s.name, r.status().as_u16()));
    let post = |body: Value, session: Option<String>| {
        let mut rb = http.post(&s.url).timeout(LIST_TIMEOUT).header("Accept", "application/json, text/event-stream").header("MCP-Protocol-Version", PROTOCOL).json(&body);
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
// commonly holds API keys the user set there directly) — except to repair the
// invalid `"type": "streamable-http"` that earlier versions of this sync wrote.

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllmSyncReport {
    pub added: Vec<String>,
    pub kept: Vec<String>,
    pub skipped: Vec<String>,
    /// Existing entries whose invalid `"streamable-http"` type was repaired.
    pub fixed: Vec<String>,
}

fn anythingllm_mcp_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("anythingllm-desktop").join("storage").join("plugins").join("anythingllm_mcp_servers.json"))
}

/// An HTTP entry pointing at a token-gated host with no Authorization header of its own:
/// AnythingLLM would only get 401s, and the host-bound token is never copied into its
/// plaintext file, so the entry is written with `anythingllm.autoStart: false`.
fn allm_needs_token(url: &str, headers: Option<&serde_json::Map<String, Value>>) -> bool {
    let probe = McpServer { transport: "http".into(), url: url.into(), ..Default::default() };
    remote_auth(&probe).is_some() && !headers.is_some_and(|h| h.keys().any(|k| k.eq_ignore_ascii_case("authorization")))
}

fn allm_no_autostart(entry: &mut Value) {
    if let Some(o) = entry.as_object_mut() {
        let a = o.entry("anythingllm").or_insert_with(|| json!({}));
        if let Some(a) = a.as_object_mut() {
            a.insert("autoStart".into(), json!(false));
        }
    }
}

/// Pure merge: `existing` is the parsed `anythingllm_mcp_servers.json` (or
/// `{"mcpServers":{}}` if the file doesn't exist yet / is malformed).
/// Returns the new file content plus a report. Never overwrites or removes
/// an entry AnythingLLM already has (apart from repairing a `streamable-http`
/// type only this sync can have written); never converts a `builtin` server
/// (it has no command line to give AnythingLLM) or a disabled one.
fn merge_allm_servers(existing: &Value, mcps: &[McpServer]) -> (Value, AllmSyncReport) {
    let mut servers = existing.get("mcpServers").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut report = AllmSyncReport::default();
    // AnythingLLM accepts only sse | streamable | http and rejects the whole entry otherwise.
    let ids: Vec<String> = servers.keys().cloned().collect();
    for id in ids {
        let Some(entry) = servers.get_mut(&id) else { continue };
        if entry.get("type").and_then(|t| t.as_str()) != Some("streamable-http") {
            continue;
        }
        entry["type"] = json!("streamable");
        let url = entry.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
        if allm_needs_token(&url, entry.get("headers").and_then(|h| h.as_object())) {
            allm_no_autostart(entry);
        }
        report.fixed.push(id);
    }
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
            "http" => {
                let mut e = json!({ "type": "streamable", "url": m.url, "headers": m.env });
                if allm_needs_token(&m.url, e.get("headers").and_then(|h| h.as_object())) {
                    allm_no_autostart(&mut e);
                    report.skipped.push(format!("{} (needs token: set Authorization in AnythingLLM)", m.id));
                }
                e
            }
            _ => {
                report.skipped.push(format!("{} (unknown transport \"{}\")", m.id, m.transport));
                continue;
            }
        };
        servers.insert(m.id.clone(), entry);
        report.added.push(m.id.clone());
    }
    let mut out = if existing.is_object() { existing.clone() } else { json!({}) };
    out["mcpServers"] = Value::Object(servers);
    (out, report)
}

/// Parse AnythingLLM's MCP file. Only a missing file counts as empty: an unreadable one,
/// invalid JSON or an unexpected shape is an error, so a sync can never replace the
/// user's entries (and their API keys) with Tony's.
fn parse_allm_file(read: std::io::Result<String>) -> Result<Value, String> {
    match read {
        Ok(s) => {
            let s = s.strip_prefix('\u{feff}').unwrap_or(&s);
            let v: Value = serde_json::from_str(s).map_err(|e| format!("AnythingLLM MCP file is not valid JSON ({e}); not touching it"))?;
            if !v.is_object() || v.get("mcpServers").is_some_and(|m| !m.is_object()) {
                return Err("AnythingLLM MCP file has an unexpected shape; not touching it".into());
            }
            Ok(v)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "mcpServers": {} })),
        Err(e) => Err(format!("cannot read AnythingLLM MCP file ({e}); not touching it")),
    }
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
    let existing = parse_allm_file(std::fs::read_to_string(&path))?;
    let (next, report) = merge_allm_servers(&existing, &cfg.mcps);
    if report.added.is_empty() && report.fixed.is_empty() {
        // Nothing to add or repair — leave the file exactly as it is (no `.bak` churn).
        return Ok(report);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let bak = PathBuf::from(format!("{}.{}.bak", path.display(), os_core::now_secs()));
        std::fs::copy(&path, &bak).map_err(|e| format!("couldn't back up the AnythingLLM MCP file ({e}); not writing it"))?;
    }
    // Temp file + rename: AnythingLLM never reads a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_map_to_their_server() {
        assert_eq!(server_of_tool("fs.read"), "filesystem");
        assert_eq!(server_of_tool("fs.list"), "filesystem");
        assert_eq!(server_of_tool("kg.search"), "knowledge-graph");
        assert_eq!(server_of_tool("web.search"), "brave-search");
        assert_eq!(server_of_tool("gmail.recent"), "gmail");
        assert_eq!(server_of_tool("spotify.play"), "spotify");
        // Aliases are never listed but still belong to the Spotify server.
        assert_eq!(server_of_tool("spotify.recent"), "spotify");
        assert!(!builtin_tools("spotify").iter().any(|t| t.name == "spotify.recent" || t.name == "spotify.playlists"));
        assert_eq!(server_of_tool("weather.current"), "weather");
        assert_eq!(server_of_tool("whatsapp.send_message"), "whatsapp");
        assert_eq!(server_of_tool("skills.read"), "skills");
        assert_eq!(server_of_tool("nodot"), "nodot");
    }

    #[test]
    fn call_stats_accumulate_and_cap_errors() {
        let id = "stats-test-server";
        record_call(id, 12, None, 100);
        assert_eq!(call_stats(id), Some(CallStats { calls: 1, failures: 0, last_ms: 12, last_ok: true, last_error: None, last_at: 100 }));
        let long = "x".repeat(500);
        record_call(id, 40, Some(&long), 105);
        let s = call_stats(id).unwrap();
        assert_eq!((s.calls, s.failures, s.last_ms, s.last_ok, s.last_at), (2, 1, 40, false, 105));
        assert!(s.last_error.as_deref().is_some_and(|e| e.chars().count() <= CALL_ERR_MAX + 1), "capped");
        assert_eq!(cap_words("alpha beta gamma", 12), "alpha beta…", "never mid-word");
        assert_eq!(cap_words("short", 12), "short");
        // A later success flips last_ok but keeps the last error text for diagnosis.
        record_call(id, 8, None, 110);
        let s = call_stats(id).unwrap();
        assert!(s.last_ok && s.last_error.is_some() && s.calls == 3);
        assert_eq!(call_stats("never-called"), None);
    }

    #[test]
    fn browser_side_effects_are_mutating_and_browsers_are_allowlisted() {
        for t in [
            "chrome-devtools.new_page", "chrome-devtools.close_page", "chrome-devtools.select_page", "chrome-devtools.press_key", "chrome-devtools.handle_dialog",
            "chrome-devtools.drag", "chrome-devtools.emulate", "chrome-devtools.resize_page", "chrome-devtools.hover", "chrome-devtools.performance_start_trace",
            "playwright.browser_tabs", "playwright.browser_press_key", "playwright.browser_select_option", "playwright.browser_handle_dialog", "playwright.browser_drag",
            "playwright.browser_close", "playwright.browser_resize", "playwright.browser_emulate_media", "playwright.browser_hover",
        ] {
            assert!(is_mutating_tool(t), "{t}");
            assert!(!offered_to_router(t, true), "{t}");
        }
        for t in [
            "chrome-devtools.take_snapshot", "chrome-devtools.take_screenshot", "chrome-devtools.list_pages", "chrome-devtools.list_console_messages",
            "chrome-devtools.get_console_message", "chrome-devtools.list_network_requests", "chrome-devtools.get_network_request",
            "playwright.browser_snapshot", "playwright.browser_take_screenshot", "playwright.browser_console_messages", "playwright.browser_network_requests",
        ] {
            assert!(!is_mutating_tool(t), "{t}");
            assert!(offered_to_router(t, true), "{t}");
        }
        // Allowlist: an unknown browser tool is hidden even if its verb isn't on the list.
        assert!(!offered_to_router("playwright.browser_some_new_thing", true));
        for t in ["sqlite.read_query", "sqlite.list_tables", "sqlite.describe_table", "serena.find_symbol", "pal.listmodels", "pal.thinkdeep", "serena.initial_instructions"] {
            assert!(!is_mutating_tool(t), "{t}");
        }
    }

    #[test]
    fn whatsapp_send_is_refused_by_default() {
        // `call_tool_with` runs this refusal first, for every caller.
        let cfg = OsConfig::default();
        let e = read_only_refusal(&cfg, "whatsapp.send_message").expect("send refused");
        assert!(e.starts_with(READ_ONLY_PREFIX));
        assert!(read_only_refusal(&cfg, "whatsapp.send_file").is_some());
        assert_eq!(read_only_refusal(&cfg, "whatsapp.list_messages"), None);
    }

    #[test]
    fn read_only_servers_hide_and_refuse_write_tools() {
        let mut cfg = os_core::OsConfig::default();
        cfg.mcps = vec![McpServer { id: "sqlite".into(), name: "SQLite".into(), transport: "stdio".into(), enabled: true, read_only: true, ..Default::default() }, McpServer { id: "rw".into(), name: "RW".into(), transport: "stdio".into(), enabled: true, ..Default::default() }];
        let tool = |n: &str, server: &str| ToolInfo { name: n.into(), description: String::new(), server: server.into(), args: vec![] };
        let listed = visible_tools(&cfg.mcps[0], vec![tool("sqlite.read_query", "sqlite"), tool("sqlite.write_query", "sqlite"), tool("sqlite.create_table", "sqlite"), tool("sqlite.list_tables", "sqlite")]);
        assert_eq!(listed.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["sqlite.read_query", "sqlite.list_tables"]);
        let e = read_only_refusal(&cfg, "sqlite.write_query").expect("refused");
        assert!(e.starts_with(READ_ONLY_PREFIX) && e.contains("read-only") && e.contains("sqlite.write_query"), "{e}");
        assert_eq!(read_only_refusal(&cfg, "sqlite.read_query"), None);
        assert_eq!(read_only_refusal(&cfg, "rw.write_query"), None, "only servers marked read-only");
        assert_eq!(visible_tools(&cfg.mcps[1], vec![tool("rw.write_query", "rw")]).len(), 1);
        // Serialised only when on; old configs load as read-write.
        let json = serde_json::to_value(&cfg.mcps[1]).unwrap();
        assert!(json.get("readOnly").is_none());
        assert_eq!(serde_json::to_value(&cfg.mcps[0]).unwrap()["readOnly"], true);
    }

    #[test]
    fn cache_beats_failure_for_a_stale_listing_but_not_after_a_crash() {
        assert_eq!(cache_answer(Some(CacheUse::Fresh), false, false), CacheAnswer::Serve);
        assert_eq!(cache_answer(Some(CacheUse::Fresh), true, false), CacheAnswer::Serve);
        assert_eq!(cache_answer(Some(CacheUse::Revalidate), true, false), CacheAnswer::Serve, "a slow re-list must not hide the tools");
        assert_eq!(cache_answer(Some(CacheUse::Revalidate), false, false), CacheAnswer::List);
        assert_eq!(cache_answer(Some(CacheUse::Expired), true, false), CacheAnswer::Fail);
        assert_eq!(cache_answer(None, true, false), CacheAnswer::Fail);
        assert_eq!(cache_answer(None, false, false), CacheAnswer::List);
        assert_eq!(cache_answer(Some(CacheUse::Fresh), true, true), CacheAnswer::Fail, "crashed and failing: stop offering it");
        assert_eq!(cache_answer(Some(CacheUse::Revalidate), true, true), CacheAnswer::Fail);
    }

    #[test]
    fn crashed_session_listing_is_not_kept_for_hours() {
        let s = McpServer { id: "crash-keep-test".into(), transport: "stdio".into(), command: "x".into(), ..Default::default() };
        let fp = server_fingerprint(&s, None);
        let now = 100_000;
        let at = now - LIST_FRESH - 1;
        assert_eq!(cache_use_of(&s, fp, at, now), CacheUse::Fresh, "idle-reaped (or never ran): kept");
        session::mark_end_for_test(&s.id, fp, session::End::Crashed("boom".into()));
        assert_eq!(cache_use_of(&s, fp, at, now), CacheUse::Revalidate, "crashed: normal freshness");
        session::mark_end_for_test(&s.id, fp, session::End::Reaped);
        assert_eq!(cache_use_of(&s, fp, at, now), CacheUse::Fresh);
    }

    #[test]
    fn kill_switch_blocks_remote_listing_and_warmup() {
        let mut cfg = os_core::OsConfig::default();
        let remote = McpServer { id: "sentry".into(), transport: "http".into(), url: "https://mcp.sentry.dev/mcp".into(), enabled: true, ..Default::default() };
        let local = McpServer { id: "local".into(), transport: "http".into(), url: "http://127.0.0.1:9000/mcp".into(), enabled: true, ..Default::default() };
        assert!(!remote_blocked(&cfg, &remote));
        cfg.privacy.kill_switch = true;
        assert!(remote_blocked(&cfg, &remote));
        assert!(!remote_blocked(&cfg, &local), "loopback stays reachable");
        assert_ne!(status_of(&format!("Sentry: {KILL_SWITCH_MCP}")), "starting");
    }

    #[test]
    fn stderr_scrub_covers_arg_secrets() {
        let args: Vec<String> = ["--api-key", "short-secret1", "--token=tok_abcdef", "postgresql://u:hunter22@h/db", "-y", "mcp-sqlite-server", "--db-path", "C:\\x.sqlite"].iter().map(|s| s.to_string()).collect();
        let known = arg_secrets(&args);
        assert!(known.contains(&"short-secret1".to_string()) && known.contains(&"tok_abcdef".to_string()) && known.contains(&"hunter22".to_string()), "{known:?}");
        assert!(!known.iter().any(|k| k == "mcp-sqlite-server" || k.contains("sqlite")), "{known:?}");
        let msg = session::exited_msg("X", "tools/call", Some(1), "usage: --api-key short-secret1 postgresql://u:hunter22@h/db");
        let s = super::super::devqueue::scrub(&msg, &known);
        assert!(!s.contains("short-secret1") && !s.contains("hunter22"), "{s}");
        assert!(credential_name("OPENROUTER_API_KEY") && credential_name("hf_token") && credential_name("GITHUB_PAT"));
        assert!(!credential_name("PATH") && !credential_name("PATHEXT") && !credential_name("USERPROFILE"));
    }

    #[test]
    fn launch_needs_an_existing_working_folder_and_binds_the_resolved_one() {
        let s = McpServer { id: "cwd-test".into(), transport: "stdio".into(), command: "cmd".into(), cwd: Some("C:\\definitely\\not\\here-4821".into()), ..Default::default() };
        let e = launch_for(&s, None, 1).unwrap_err();
        assert!(e.contains("does not exist"), "{e}");
        let s = McpServer { cwd: None, ..s };
        let tmp = std::env::temp_dir();
        if let (Ok(a), Ok(b)) = (launch_for(&s, Some(tmp.clone()), 1), launch_for(&s, None, 1)) {
            assert_ne!(a.fp, b.fp, "a new gateway workdir starts a fresh session");
        }
    }

    #[test]
    fn anythingllm_file_is_never_wiped() {
        assert!(parse_allm_file(Ok("{\"mcpServers\":{\"x\":{},}}".into())).is_err(), "trailing comma");
        assert!(parse_allm_file(Ok("[1,2]".into())).is_err());
        assert!(parse_allm_file(Ok("{\"mcpServers\":[]}".into())).is_err());
        assert!(parse_allm_file(Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))).is_err(), "sharing violation / unreadable");
        assert_eq!(parse_allm_file(Err(std::io::Error::from(std::io::ErrorKind::NotFound))).unwrap(), json!({ "mcpServers": {} }));
        let v = parse_allm_file(Ok("\u{feff}{\"mcpServers\":{\"mine\":{\"command\":\"a\"}},\"other\":1}".into())).expect("BOM is fine");
        let (next, _) = merge_allm_servers(&v, &[McpServer { id: "new".into(), transport: "stdio".into(), command: "b".into(), enabled: true, ..Default::default() }]);
        assert_eq!(next["other"], 1, "unknown top-level keys survive");
        assert!(next["mcpServers"]["mine"].is_object() && next["mcpServers"]["new"].is_object());
    }

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
        let srv = |url: &str, transport: &str| McpServer { id: "x".into(), name: "X".into(), transport: transport.into(), url: url.into(), enabled: true, ..Default::default() };
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
        let srv = McpServer { id: "srv-test".into(), transport: "http".into(), url: "https://mcp.sentry.dev/mcp".into(), ..Default::default() };
        let fp = server_fingerprint(&srv, Some("t1"));
        failed_set("srv-test", Some((100, fp, "boom".into())));
        assert_eq!(failed_get("srv-test", fp, 200).as_deref(), Some("boom"));
        assert_eq!(failed_get("srv-test", server_fingerprint(&srv, Some("t2")), 200), None, "a new token retries at once");
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
        assert_eq!(builtin_listing("spotify", || GmailSource::None, || true, ok).unwrap().len(), 23);
    }

    #[test]
    fn spotify_actuators_are_the_only_router_exception() {
        // Tony's router: every listed Spotify tool, in ALL_TOOLS order.
        let offered: Vec<String> = builtin_tools("spotify").into_iter().map(|t| t.name).filter(|n| offered_to_router(n, true)).collect();
        assert_eq!(offered, super::super::spotify_intent::ALL_TOOLS);
        assert_eq!(SPOTIFY_ROUTER_TOOLS.len(), 23);
        // Every description says which service it is.
        assert!(builtin_tools("spotify").iter().all(|t| t.description.contains("Spotify only (not YouTube or local audio)")));
        // A Spotify tool nobody listed on purpose stays hidden.
        assert!(!offered_to_router("spotify.play_uri", true) && !offered_to_router("spotify.delete_playlist", true) && !offered_to_router("spotify.recent", true));
        // Sub-agents: Spotify reads only.
        let sub: Vec<String> = builtin_tools("spotify").into_iter().map(|t| t.name).filter(|n| offered_to_router(n, false)).collect();
        assert_eq!(sub, super::super::spotify_intent::READ_TOOLS);
        assert!(is_spotify_actuator("spotify.play") && is_spotify_actuator("spotify.volume") && is_spotify_actuator("spotify.unlike_track"));
        assert!(!is_spotify_actuator("spotify.now_playing") && !is_spotify_actuator("spotify.recent") && !is_spotify_actuator("spotify.play_uri"));
        // Every other mutating tool is still excluded, for Tony too.
        for t in ["gmail.create_draft", "gmail.send", "fs.write", "filesystem.write_file", "whatsapp.send_message", "github.create_issue", "git.commit", "playwright.browser_click", "shell.run", "sqlite.execute"] {
            assert!(!offered_to_router(t, true), "{t}");
            assert!(!offered_to_router(t, false), "{t}");
        }
        assert!(offered_to_router("weather.current", true) && offered_to_router("weather.current", false));
    }

    fn spotify_cfg(tier: super::super::bridge::Tier, read_only: bool) -> OsConfig {
        let mut cfg = OsConfig::default();
        cfg.mcps = vec![McpServer { id: "spotify".into(), name: "Spotify".into(), transport: "builtin".into(), enabled: true, read_only, ..Default::default() }];
        cfg.permissions.mcp = tier;
        cfg
    }

    #[test]
    fn spotify_reads_ignore_ask_tier() {
        use super::super::bridge::{BridgeState, Tier};
        let gate = super::super::spotify::tool_gate;
        let bridge = BridgeState::default();
        let mut cfg = spotify_cfg(Tier::Ask, false);
        cfg.privacy.destructive_gate = false;
        assert_eq!(gate(&cfg, &bridge, "spotify.now_playing", false), Ok(()));
        assert_eq!(gate(&cfg, &bridge, "spotify.get_queue", false), Ok(()));
        assert_eq!(gate(&cfg, &bridge, "spotify.play", false), Err("PERMISSION_REQUIRED:mcp".into()));
        assert_eq!(gate(&cfg, &bridge, "spotify.play", true), Ok(()));
        let cfg = spotify_cfg(Tier::Deny, false);
        assert_eq!(gate(&cfg, &bridge, "spotify.now_playing", false), Err("PERMISSION_DENIED:mcp".into()));
        assert_eq!(gate(&cfg, &bridge, "spotify.pause", true), Err("PERMISSION_DENIED:mcp".into()));
        let mut cfg = spotify_cfg(Tier::Allow, false);
        cfg.privacy.kill_switch = true;
        assert!(gate(&cfg, &bridge, "spotify.now_playing", false).unwrap_err().contains("kill switch"));
        assert!(gate(&cfg, &bridge, "spotify.pause", true).unwrap_err().contains("kill switch"));
    }

    #[test]
    fn spotify_read_only_blocks_every_write() {
        let cfg = spotify_cfg(super::super::bridge::Tier::Allow, true);
        for w in ["spotify.like_track", "spotify.play", "spotify.transfer_device", "spotify.create_playlist", "spotify.shuffle"] {
            let e = read_only_refusal(&cfg, w).unwrap_or_else(|| panic!("{w} not refused"));
            assert!(e.starts_with(READ_ONLY_PREFIX), "{e}");
        }
        for r in ["spotify.now_playing", "spotify.list_playlists", "spotify.recent", "spotify.get_playlist_tracks"] {
            assert_eq!(read_only_refusal(&cfg, r), None, "{r}");
        }
        let listed: Vec<String> = visible_tools(&cfg.mcps[0], builtin_tools("spotify")).into_iter().map(|t| t.name).collect();
        assert_eq!(listed, super::super::spotify_intent::READ_TOOLS);
    }

    #[test]
    fn destructive_spotify_tools_need_the_destructive_gate() {
        use super::super::bridge::{BridgeState, Tier};
        let gate = super::super::spotify::tool_gate;
        let bridge = BridgeState::default();
        let mut cfg = spotify_cfg(Tier::Allow, false);
        cfg.privacy.destructive_gate = true;
        for d in ["spotify.remove_from_playlist", "spotify.unlike_track"] {
            assert_eq!(gate(&cfg, &bridge, d, false), Err("PERMISSION_REQUIRED:destructive".into()), "{d}");
            assert_eq!(gate(&cfg, &bridge, d, true), Ok(()), "{d}");
        }
        // Additive library edits and playback don't need it.
        assert_eq!(gate(&cfg, &bridge, "spotify.add_to_playlist", false), Ok(()));
        assert_eq!(gate(&cfg, &bridge, "spotify.like_track", false), Ok(()));
        cfg.privacy.destructive_gate = false;
        assert_eq!(gate(&cfg, &bridge, "spotify.unlike_track", false), Ok(()));
    }

    #[test]
    fn router_filter_keeps_order_and_drops_unsafe() {
        let mut all = builtin_tools("gmail");
        all.extend(builtin_tools("spotify"));
        all.extend(builtin_tools("weather"));
        let tony: Vec<String> = router_filter(&all, true).into_iter().map(|t| t.name).collect();
        assert!(!tony.contains(&"gmail.create_draft".to_string()));
        assert!(tony.contains(&"spotify.play".to_string()) && tony.contains(&"gmail.recent".to_string()));
        assert_eq!(tony.last().map(String::as_str), Some("weather.current"));
        assert_eq!(tony.len(), all.len() - 1);
        let sub: Vec<String> = router_filter(&all, false).into_iter().map(|t| t.name).collect();
        assert!(!sub.contains(&"spotify.play".to_string()) && sub.contains(&"spotify.now_playing".to_string()));
        assert!(is_tony("general") && is_tony("tony") && !is_tony("booking"));
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
        McpServer { id: id.into(), name: id.into(), transport: "stdio".into(), command: "uv".into(), args: vec!["run".into(), "main.py".into()], enabled, ..Default::default() }
    }

    fn mcp_builtin(id: &str, enabled: bool) -> McpServer {
        McpServer { id: id.into(), name: id.into(), transport: "builtin".into(), enabled, builtin: true, ..Default::default() }
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
        let http = McpServer { id: "custom-http".into(), name: "Custom".into(), transport: "http".into(), url: "http://127.0.0.1:9000/mcp".into(), enabled: true, ..Default::default() };
        let (next, report) = merge_allm_servers(&json!({ "mcpServers": {} }), &[http]);
        assert_eq!(report.added, vec!["custom-http".to_string()]);
        assert_eq!(next["mcpServers"]["custom-http"]["url"], json!("http://127.0.0.1:9000/mcp"));
        // AnythingLLM accepts only sse | streamable | http.
        assert_eq!(next["mcpServers"]["custom-http"]["type"], json!("streamable"));
        assert!(next["mcpServers"]["custom-http"].get("anythingllm").is_none(), "no token needed: starts normally");
    }

    #[test]
    fn allm_sync_token_host_is_written_without_autostart() {
        let sentry = McpServer { id: "sentry".into(), name: "Sentry".into(), transport: "http".into(), url: "https://mcp.sentry.dev/mcp".into(), enabled: true, ..Default::default() };
        let (next, report) = merge_allm_servers(&json!({ "mcpServers": {} }), &[sentry.clone()]);
        assert_eq!(report.added, vec!["sentry".to_string()]);
        assert_eq!(report.skipped, vec!["sentry (needs token: set Authorization in AnythingLLM)".to_string()]);
        assert_eq!(next["mcpServers"]["sentry"]["anythingllm"]["autoStart"], json!(false));
        assert_eq!(next["mcpServers"]["sentry"]["headers"], json!({}), "the host-bound token is never written");
        // With the user's own Authorization header it starts normally.
        let mut own = sentry;
        own.env.insert("Authorization".into(), "Bearer user-set".into());
        let (next, report) = merge_allm_servers(&json!({ "mcpServers": {} }), &[own]);
        assert!(report.skipped.is_empty());
        assert!(next["mcpServers"]["sentry"].get("anythingllm").is_none());
    }

    #[test]
    fn allm_sync_repairs_streamable_http_and_leaves_user_entries() {
        let existing = json!({
            "mcpServers": {
                "context7": { "type": "streamable-http", "url": "https://mcp.context7.com/mcp", "headers": { "X-Custom": "keep" } },
                "github": { "type": "streamable-http", "url": "https://api.githubcopilot.com/mcp/", "headers": {} },
                "mine": { "type": "sse", "url": "https://example.com/sse", "headers": { "Authorization": "Bearer x" } },
                "local": { "command": "uvx", "args": ["x"] }
            }
        });
        let (next, report) = merge_allm_servers(&existing, &[]);
        let mut fixed = report.fixed.clone();
        fixed.sort();
        assert_eq!(fixed, vec!["context7".to_string(), "github".to_string()]);
        assert_eq!(next["mcpServers"]["context7"]["type"], json!("streamable"));
        assert_eq!(next["mcpServers"]["context7"]["headers"]["X-Custom"], json!("keep"));
        assert_eq!(next["mcpServers"]["context7"]["url"], json!("https://mcp.context7.com/mcp"));
        assert!(next["mcpServers"]["context7"].get("anythingllm").is_none());
        assert_eq!(next["mcpServers"]["github"]["anythingllm"]["autoStart"], json!(false));
        // Entries with any other shape are the user's: untouched.
        assert_eq!(next["mcpServers"]["mine"], existing["mcpServers"]["mine"]);
        assert_eq!(next["mcpServers"]["local"], existing["mcpServers"]["local"]);
        // Already repaired: nothing to do the second time.
        let (_, again) = merge_allm_servers(&next, &[]);
        assert!(again.fixed.is_empty());
    }

    #[test]
    fn sqlite_and_serena_write_tools_are_mutating() {
        for t in ["sqlite.write_query", "sqlite.create_table", "sqlite.append_insight", "serena.replace_symbol_body", "serena.insert_after_symbol", "serena.replace_content", "serena.delete_lines", "serena.execute_shell_command", "serena.write_memory", "serena.rename_symbol", "serena.activate_project", "pal.clink", "chrome-devtools.evaluate_script", "serena.serena_repl", "serena.open_dashboard"] {
            assert!(is_mutating_tool(t), "{t}");
        }
        for t in ["sqlite.read_query", "sqlite.list_tables", "sqlite.describe_table", "serena.find_symbol", "serena.read_file", "serena.list_dir", "serena.search_for_pattern", "serena.get_symbols_overview", "serena.find_referencing_symbols", "serena.read_memory", "serena.list_memories", "serena.get_diagnostics_for_file", "serena.initial_instructions", "pal.chat", "pal.thinkdeep", "pal.listmodels"] {
            assert!(!is_mutating_tool(t), "{t}");
        }
    }

    #[test]
    fn startup_timeouts() {
        assert_eq!(startup_secs(None, "npx"), Duration::from_secs(120));
        assert_eq!(startup_secs(None, "serena"), Duration::from_secs(120));
        assert_eq!(startup_secs(None, r"C:\Users\x\.local\bin\uvx.exe"), Duration::from_secs(120));
        assert_eq!(startup_secs(None, "multi-account-gmail-mcp"), Duration::from_secs(45));
        assert_eq!(startup_secs(Some(300), "node"), Duration::from_secs(300));
        assert_eq!(startup_secs(Some(10), "npx"), Duration::from_secs(10), "the server's own value wins");
        let s = McpServer { command: "pal-mcp-server".into(), timeout_secs: Some(90), ..Default::default() };
        assert_eq!(request_timeout(&s), Duration::from_secs(90));
        assert_eq!(request_timeout(&McpServer::default()), Duration::from_secs(60));
        // A low (fail-fast) startup timeout never shortens tool calls.
        assert_eq!(request_timeout(&McpServer { timeout_secs: Some(10), ..Default::default() }), Duration::from_secs(60));
        assert_eq!(startup_timeout(&McpServer { timeout_secs: Some(10), ..Default::default() }), Duration::from_secs(10));
    }

    #[test]
    fn fingerprint_tracks_the_whole_config() {
        let base = McpServer { id: "sqlite".into(), transport: "stdio".into(), command: "npx".into(), args: vec!["-y".into(), "mcp-sqlite-server".into()], ..Default::default() };
        let fp = server_fingerprint(&base, None);
        assert_eq!(fp, server_fingerprint(&base.clone(), None), "stable");
        let mut cmd = base.clone();
        cmd.command = "mcp-server-sqlite".into();
        let mut args = base.clone();
        args.args.push("--x".into());
        let mut env = base.clone();
        env.env.insert("K".into(), "v".into());
        let mut cwd = base.clone();
        cwd.cwd = Some("C:\\x".into());
        let mut to = base.clone();
        to.timeout_secs = Some(30);
        for (what, other) in [("command", cmd), ("args", args), ("env", env), ("cwd", cwd), ("timeout", to)] {
            assert_ne!(fp, server_fingerprint(&other, None), "{what}");
        }
        assert_ne!(fp, server_fingerprint(&base, Some("tok")));
        // Name / description / enabled don't restart a server.
        let mut cosmetic = base.clone();
        cosmetic.name = "Renamed".into();
        cosmetic.description = "x".into();
        assert_eq!(fp, server_fingerprint(&cosmetic, None));
    }

    #[test]
    fn cache_use_decisions() {
        assert_eq!(cache_use(false, 0, false), CacheUse::Fresh);
        assert_eq!(cache_use(false, LIST_FRESH, false), CacheUse::Revalidate);
        assert_eq!(cache_use(false, STALE_MAX, false), CacheUse::Expired);
        // An idle (reaped) stdio server isn't cold-spawned just to re-read its tool names…
        assert_eq!(cache_use(true, LIST_FRESH + 1, false), CacheUse::Fresh);
        assert_eq!(cache_use(true, STDIO_IDLE_KEEP, false), CacheUse::Revalidate);
        // …but a running one is re-listed over its live session.
        assert_eq!(cache_use(true, LIST_FRESH + 1, true), CacheUse::Revalidate);
    }

    #[test]
    fn starting_is_its_own_status() {
        let s = McpServer { name: "Serena".into(), command: "serena".into(), ..Default::default() };
        assert_eq!(status_of(&listing_starting_msg(&s)), "starting");
        assert_eq!(status_of(&session::starting_msg("Serena", Duration::from_secs(3), Duration::from_secs(120))), "starting");
        assert_eq!(status_of("Serena: no reply to initialize within 120s"), "error");
    }

    /// The listing cache is keyed by config: a listing made for an old command line is
    /// never served for the new one, and a background result is promoted into OsState.
    #[test]
    fn listing_cache_is_config_keyed() {
        let os = OsState::default();
        let s = McpServer { id: "cache-test".into(), transport: "stdio".into(), command: "old".into(), ..Default::default() };
        let old_fp = server_fingerprint(&s, None);
        let tools = vec![t("cache-test", "cache-test.x", "", &[])];
        lock(&LISTED).get_or_insert_with(HashMap::new).insert("cache-test".into(), (os_core::now_secs(), old_fp, tools));
        promote_listed(&os);
        assert_eq!(cached_listing(&os, "cache-test", old_fp).map(|(_, t)| t.len()), Some(1));
        let mut edited = s.clone();
        edited.command = "new".into();
        assert!(cached_listing(&os, "cache-test", server_fingerprint(&edited, None)).is_none());
    }

    /// Token-gated HTTP servers without a token: needs_token everywhere, no network call.
    #[test]
    fn needs_token_servers_never_reach_the_network() {
        let state = DispatchState::default();
        let os = OsState::default();
        // An unroutable URL on the gated host's name can't be faked, so instead prove the
        // gate: with no token in env/.env/keychain, every path returns needs_token at once.
        let s = McpServer { id: "agentmail".into(), name: "AgentMail".into(), transport: "http".into(), url: "https://mcp.agentmail.to/mcp".into(), enabled: true, ..Default::default() };
        if remote_token(&state, &s).is_ok() {
            eprintln!("an AgentMail token is configured on this machine — skipping");
            return;
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let t0 = std::time::Instant::now();
        let r = rt.block_on(tools_of(&state, &os, &s, true, Duration::from_secs(30)));
        assert_eq!(status_of(&r.unwrap_err()), "needs_token");
        assert!(!inflight("agentmail"), "no listing was started");
        assert!(t0.elapsed() < Duration::from_secs(2));
    }

    /// Machine check (not run by default): load the real os.json and, for serena, sqlite
    /// and pal, run initialize + tools/list through the real session path. Prints id,
    /// ok/err, tool count and elapsed ms — never env values (errors are scrubbed).
    /// `cargo test --lib live_stdio_servers_start -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_stdio_servers_start() {
        let dir = PathBuf::from(std::env::var("APPDATA").expect("APPDATA")).join("os.agentic.commandcenter");
        let cfg: OsConfig = serde_json::from_str(&std::fs::read_to_string(dir.join("os.json")).expect("os.json")).expect("parse os.json");
        let workdir = std::fs::read_to_string(dir.join("providers.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["gateway"]["workdir"].as_str().map(PathBuf::from))
            .filter(|p| p.is_dir());
        let c = Ctx { http: reqwest::Client::new(), workdir };
        let ids = ["serena", "sqlite", "pal"];
        let servers: Vec<McpServer> = cfg.mcps.into_iter().filter(|m| ids.contains(&m.id.as_str())).collect();
        assert_eq!(servers.len(), ids.len(), "all three are configured");
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let results = rt.block_on(futures_util::future::join_all(servers.iter().map(|s| {
            let c = c.clone();
            async move {
                let t0 = std::time::Instant::now();
                let fp = server_fingerprint(s, None);
                let r = rpc(&c, s, None, fp, "tools/list", json!({}), startup_timeout(s), LIST_TIMEOUT).await.map(|v| parse_tools(s, &v));
                (s.clone(), r, t0.elapsed())
            }
        })));
        let mut failed = vec![];
        for (s, r, el) in results {
            let known: Vec<String> = s.env.values().cloned().collect();
            match r {
                Ok(tools) => println!("LIVE {:<8} ok   tools={:<3} {} ms (startup limit {} s) [{}]", s.id, tools.len(), el.as_millis(), startup_timeout(&s).as_secs(), tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ")),
                Err(e) => {
                    println!("LIVE {:<8} ERR  {} ms: {}", s.id, el.as_millis(), super::super::devqueue::scrub(&e, &known));
                    failed.push(s.id.clone());
                }
            }
        }
        assert!(failed.is_empty(), "failed: {failed:?}");
        // A tool call reuses the running session (no cold spawn): SQLite's read-only list_tables.
        if let Some(s) = servers.iter().find(|s| s.id == "sqlite") {
            let t0 = std::time::Instant::now();
            let r = rt.block_on(rpc(&c, s, None, server_fingerprint(s, None), "tools/call", json!({ "name": "list_tables", "arguments": {} }), CHAT_START_WAIT, request_timeout(s)));
            println!("LIVE sqlite   call list_tables over the warm session: {} in {} ms", if r.is_ok() { "ok" } else { "ERR" }, t0.elapsed().as_millis());
            assert!(r.is_ok());
        }
    }
}
