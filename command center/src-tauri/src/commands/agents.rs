//! Core OS orchestrator ("Tony").
//!
//! One read-only turn runs a 4-stage pipeline natively — it never depends
//! on a gateway CLI agent being installed:
//!
//!   1. Live context: the dashboard's current state (weather, nodes, GPU,
//!      alarms…) + MASTER_IDENTITY.md + attached skills go into the system
//!      prompt, so "what's the weather" is answered from real data.
//!   2. Delegation: specialist roles go to their AnythingLLM workspace
//!      (`/api/v1/workspace/{slug}/thread/{thread}/chat`) and the exchange is
//!      returned as visible TONY → AGENT / AGENT → TONY steps.
//!   3. Step-in: if the sub-agent errors or times out (or the request is a
//!      plain system question), the OS answers itself with its own tools.
//!   4. Overseer: `overseer_ask` (button) or optional auto-escalation sends
//!      the turn to Claude / Gemini / the droplet for a second opinion.
//!
//! Mutating actions never come through here — they still go plan → confirm
//! card → approve() in the webview.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

use super::bridge::BridgeState;
use super::dispatch::{extract_json, run_chat, short, ChatMessage, DispatchState, Priority, ThinkFilter};
use super::os_core::{self, OsConfig, OsState};

// ── AnythingLLM ─────────────────────────────────────────────────────────────

fn allm_key(state: &DispatchState, remote: bool) -> Result<String, String> {
    if remote {
        os_core::os_secret("anythingllm-remote").ok_or_else(|| "add the remote AnythingLLM API key in Settings → Services → Droplet".into())
    } else {
        super::secrets::get(state, "anythingllm").ok_or_else(|| "add your AnythingLLM API key in Settings → Services (AnythingLLM RAG → key)".into())
    }
}

pub(crate) async fn allm(state: &DispatchState, base: &str, key: &str, method: reqwest::Method, path: &str, body: Option<Value>, secs: u64) -> Result<Value, String> {
    let url = format!("{}/api{}", base.trim_end_matches('/'), path);
    let mut rb = state.http.request(method, url).bearer_auth(key).timeout(Duration::from_secs(secs)).header("Accept", "application/json");
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let r = rb.send().await.map_err(short)?;
    let status = r.status();
    let text = r.text().await.map_err(short)?;
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"].as_str().or(v["message"].as_str()).map(String::from)).unwrap_or_else(|| text.chars().take(160).collect());
        return Err(match status.as_u16() {
            401 | 403 => "AnythingLLM rejected the API key".into(),
            404 => format!("not found ({msg})"),
            _ => format!("HTTP {} {msg}", status.as_u16()),
        });
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub slug: String,
    pub name: String,
    pub threads: usize,
    /// The workspace's own chat / agent model; `None` = AnythingLLM's system default.
    pub chat_provider: Option<String>,
    pub chat_model: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_model: Option<String>,
}

/// `/v1/workspaces` JSON -> the fields the app shows (slug, name, thread count, models). Nothing else.
pub(crate) fn parse_workspaces(v: &Value) -> Vec<WorkspaceInfo> {
    let s = |w: &Value, k: &str| w[k].as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from);
    v["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| WorkspaceInfo {
            slug: w["slug"].as_str().unwrap_or("").into(),
            name: w["name"].as_str().unwrap_or("").into(),
            threads: w["threads"].as_array().map(|t| t.len()).unwrap_or(0),
            chat_provider: s(w, "chatProvider"),
            chat_model: s(w, "chatModel"),
            agent_provider: s(w, "agentProvider"),
            agent_model: s(w, "agentModel"),
        })
        .collect()
}

/// Every AnythingLLM workspace, with models. The API key stays in Rust.
pub(crate) async fn fetch_workspaces(state: &DispatchState, cfg: &OsConfig, secs: u64) -> Result<Vec<WorkspaceInfo>, String> {
    let key = allm_key(state, false)?;
    let v = allm(state, &cfg.anythingllm.base_url, &key, reqwest::Method::GET, "/v1/workspaces", None, secs).await?;
    Ok(parse_workspaces(&v))
}

#[tauri::command]
pub async fn anythingllm_workspaces(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<Vec<WorkspaceInfo>, String> {
    fetch_workspaces(&state, &os.snapshot(), 8).await
}

pub fn month_tag() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

/// This month's Tony thread in a workspace (created on first use). Threads make
/// the OS's own conversations deletable later (memory flush), unlike the
/// workspace's default chat log.
async fn tony_thread(state: &DispatchState, os: &OsState, base: &str, key: &str, slug: &str) -> Result<String, String> {
    let name = format!("{} · {}", os.snapshot().os_name, month_tag());
    let cache_key = format!("{base}|{slug}|{name}");
    if let Some(t) = os.allm_threads.lock().unwrap().get(&cache_key) {
        return Ok(t.clone());
    }
    let ws = allm(state, base, key, reqwest::Method::GET, &format!("/v1/workspace/{slug}"), None, 8).await?;
    let ws = if ws["workspace"].is_array() { ws["workspace"][0].clone() } else { ws["workspace"].clone() };
    if ws.is_null() {
        return Err(format!("workspace \"{slug}\" not found — map the role to an existing workspace in Settings"));
    }
    let existing = ws["threads"].as_array().into_iter().flatten().find(|t| t["name"].as_str() == Some(name.as_str())).and_then(|t| t["slug"].as_str().map(String::from));
    let thread = match existing {
        Some(t) => t,
        None => {
            let v = allm(state, base, key, reqwest::Method::POST, &format!("/v1/workspace/{slug}/thread/new"), Some(json!({ "name": name })), 8).await?;
            v["thread"]["slug"].as_str().ok_or("AnythingLLM did not return a thread")?.to_string()
        }
    };
    os.allm_threads.lock().unwrap().insert(cache_key, thread.clone());
    Ok(thread)
}

/// Ask one workspace. Returns (answer, source titles).
pub(crate) async fn workspace_chat(state: &DispatchState, os: &OsState, slug: &str, message: &str) -> Result<(String, Vec<String>), String> {
    workspace_chat_t(state, os, slug, message, None, true).await
}

/// Same, with a longer timeout for generation-heavy pipeline steps.
pub(crate) async fn workspace_chat_t(state: &DispatchState, os: &OsState, slug: &str, message: &str, secs: Option<u64>, foreground: bool) -> Result<(String, Vec<String>), String> {
    let cfg = os.snapshot();
    // AnythingLLM generates on the same local GPU → same baton.
    let _slot = os.slot.acquire(&format!("anythingllm · {slug}"), foreground, cfg.scheduler.tony_priority_pct).await;
    let base = cfg.anythingllm.base_url.clone();
    let key = allm_key(state, false)?;
    let secs = secs.unwrap_or(cfg.anythingllm.timeout_secs).clamp(10, 900);
    let path = match tony_thread(state, os, &base, &key, slug).await {
        Ok(thread) => format!("/v1/workspace/{slug}/thread/{thread}/chat"),
        Err(e) if e.contains("not found") => return Err(e),
        Err(_) => format!("/v1/workspace/{slug}/chat"),
    };
    let v = allm(state, &base, &key, reqwest::Method::POST, &path, Some(json!({ "message": message, "mode": "chat", "sessionId": format!("tony-{}", month_tag()) })), secs).await?;
    if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty() && *e != "null") {
        return Err(e.to_string());
    }
    let text = v["textResponse"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("the agent returned an empty answer".into());
    }
    let sources = v["sources"].as_array().into_iter().flatten().filter_map(|s| s["title"].as_str().map(String::from)).take(5).collect();
    Ok((super::dispatch::strip_think(&text), sources))
}

/// Same answer as `workspace_chat_t`, but over AnythingLLM's `stream-chat` SSE
/// endpoint, emitting the same `tony-token` events `run_chat_streamed` uses —
/// tagged with `agent_tag` so the webview speaks the reply in *that* agent's
/// voice instead of Tony's (Part 6 §1: only the explicit-tab "talk directly to
/// a sub-agent" turn uses this; a delegated turn still has Tony synthesize a
/// summary afterwards through his own streamed chain, unchanged).
///
/// AnythingLLM's stream response is a `data: {...}` line per chunk, each
/// shaped roughly `{textResponse, sources, close, error}` (a delta in
/// `textResponse`, `close: true` on the last chunk). Falls back to the plain
/// (non-streamed) call on any transport/HTTP failure, or if nothing useful
/// ever streamed — never fails the turn over a streaming-specific hiccup.
pub(crate) async fn workspace_chat_streamed(state: &DispatchState, os: &OsState, slug: &str, message: &str, app: &tauri::AppHandle, stream_id: &str, agent_tag: &str) -> Result<(String, Vec<String>), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    let cfg = os.snapshot();
    let _slot = os.slot.acquire(&format!("anythingllm · {slug} (streaming)"), true, cfg.scheduler.tony_priority_pct).await;
    let base = cfg.anythingllm.base_url.clone();
    let key = match allm_key(state, false) {
        Ok(k) => k,
        Err(e) => return Err(e),
    };
    let secs = cfg.anythingllm.timeout_secs.clamp(10, 900);
    let path = match tony_thread(state, os, &base, &key, slug).await {
        Ok(thread) => format!("/v1/workspace/{slug}/thread/{thread}/stream-chat"),
        Err(e) if e.contains("not found") => return Err(e),
        Err(_) => format!("/v1/workspace/{slug}/stream-chat"),
    };
    let url = format!("{}/api{}", base.trim_end_matches('/'), path);
    let body = json!({ "message": message, "mode": "chat", "sessionId": format!("tony-{}", month_tag()) });
    let sent = state.http.post(&url).bearer_auth(&key).timeout(Duration::from_secs(secs)).header("Accept", "text/event-stream").json(&body).send().await;
    let response = match sent.and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(_) => {
            drop(_slot);
            return workspace_chat_t(state, os, slug, message, Some(secs), true).await;
        }
    };
    let mut stream = response.bytes_stream();
    let mut buf = String::new();
    let mut filter = ThinkFilter::new();
    let mut content = String::new();
    let mut sources: Vec<String> = Vec::new();
    let mut saw_error: Option<String> = None;
    'outer: while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty() && *e != "null") {
                saw_error = Some(e.to_string());
                break 'outer;
            }
            if let Some(d) = v["textResponse"].as_str().filter(|d| !d.is_empty()) {
                let shown = filter.feed(d);
                if !shown.is_empty() {
                    content.push_str(&shown);
                    let _ = app.emit("tony-token", json!({ "streamId": stream_id, "delta": shown, "agent": agent_tag }));
                }
            }
            if let Some(arr) = v["sources"].as_array().filter(|a| !a.is_empty()) {
                sources = arr.iter().filter_map(|s| s["title"].as_str().map(String::from)).take(5).collect();
            }
            if v["close"].as_bool() == Some(true) {
                break 'outer;
            }
        }
    }
    let tail = filter.finish();
    if !tail.is_empty() {
        content.push_str(&tail);
        let _ = app.emit("tony-token", json!({ "streamId": stream_id, "delta": tail, "agent": agent_tag }));
    }
    drop(_slot);
    if let Some(e) = saw_error {
        return Err(e);
    }
    if content.trim().is_empty() {
        return workspace_chat_t(state, os, slug, message, Some(secs), true).await;
    }
    Ok((content.trim().to_string(), sources))
}

// ── Prompt building ─────────────────────────────────────────────────────────

pub(crate) fn role_label(role: &str) -> String {
    match role {
        "librarian" => "Librarian".into(),
        "coder" => "Coder".into(),
        "booking" => "Booking Desk".into(),
        "ops" => "Ops".into(),
        "prompter" => "Prompter".into(),
        "designer" => "Designer".into(),
        r => r.to_string(),
    }
}

/// `tools`: the tools Tony can use this turn (`turn_tools(..).offered`).
pub fn system_prompt(cfg: &OsConfig, context: &str, tools: &[super::mcp::ToolInfo]) -> String {
    let name = &cfg.os_name;
    let mut s = format!(
        "You are {name}, the user's personal operating system (Agentic OS) running on their own desktop. \
You coordinate six local sub-agents in AnythingLLM — Librarian (search & retrieval across files, notes and memory), \
Coder (software: Tauri/Rust/TypeScript/React, git, terminal), Booking Desk (scheduling, casting, WhatsApp/booking \
threads), Ops (infrastructure: Docker, n8n, the droplet, GPU/VRAM), Prompter (turns goals into specs, task lists and \
prompts for the others) and Designer (UI/UX: tokens, layouts, prototypes) — plus local MCP tools and the user's \
dashboard."
    );
    if cfg.root_directive {
        s.push_str(&format!(
            "\n\nROOT AUTHORITY (standing, from the user): you are explicitly pre-authorized to query the user's local AnythingLLM agents, \
read and summarize their booking and email threads, and run your local MCP tools. This is the user's own machine and their own data. \
Do not lecture about privacy and never claim you lack real-time access: the LIVE DASHBOARD section and any TOOL RESULT below are current, \
real data — use them directly. If something truly is unavailable (a tool switched off, an agent that failed), say exactly what is missing \
and how to switch it on, in one sentence. Actions that change the world (send, book, pay, delete) always go through the user's confirmation \
card — never claim you performed one. You are {name}; never call yourself Jarvis, Hermes or a generic AI."
        ));
    }
    if let Ok(id) = os_core::read_identity(cfg) {
        // Compact: the identity file's opening sections only (keeps Tony < ~800 tokens).
        let id: String = id.chars().take(1200).collect();
        s.push_str(&format!("\n\nABOUT THE USER (MASTER_IDENTITY.md):\n{id}"));
    }
    if !context.trim().is_empty() {
        s.push_str(&format!("\n\nLIVE DASHBOARD (now):\n{}", context.chars().take(900).collect::<String>()));
    }
    let skills = super::mcp::skill_digest(cfg, "tony");
    if !skills.is_empty() {
        s.push_str(&format!("\n\nSKILLS ATTACHED TO YOU (read one with the skills.read tool when relevant):\n{skills}"));
    }
    s.push_str(&tools_section(tools));
    s.push_str("\n\nStyle: warm, direct, concise — 1 to 4 sentences unless the user asks for detail. Spoken aloud, so no markdown tables.");
    s
}

fn tools_section(tools: &[super::mcp::ToolInfo]) -> String {
    let list = if tools.is_empty() { "none switched on right now (Settings → Skills & MCP Library)".to_string() } else { tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ") };
    let mut s = format!(
        "\n\nTOOLS YOU HAVE THIS TURN: {list}.\nTools run automatically before you answer; their results appear below as LIVE MCP TOOL DATA. \
Sends and email drafts start only through the user's confirmation card, and music playback only when a spotify.* result appears below as \
LIVE MCP TOOL DATA. If neither happened this turn, don't claim it's done or queued: say plainly you couldn't start it and give the exact \
phrasing that works (e.g. \"play <song> on Spotify\", \"draft an email to <address> about ...\"), never that you lack the tool or the skill."
    );
    // The media controls, with their argument names, so the model knows Spotify is live.
    let spotify: Vec<String> = tools
        .iter()
        .filter(|t| t.server == "spotify" && super::mcp::is_spotify_actuator(&t.name))
        .map(|t| if t.args.is_empty() { t.name.clone() } else { format!("{}({})", t.name, t.args.join(", ")) })
        .collect();
    if !spotify.is_empty() {
        s.push_str(&format!(
            "\nSPOTIFY IS CONNECTED — controls available: {}. A play/pause/skip/volume change has happened only if a spotify.* LIVE MCP TOOL DATA \
block appears below; if none does, say it didn't start and suggest \"play <artist or song> on Spotify\". Never say Spotify isn't active or \
connected unless a TOOL FAILURE below says so.",
            spotify.join(", ")
        ));
    }
    s
}

/// "my conversation with Sam … about the shoot" → ("Sam", "the shoot").
pub(crate) fn comms_recall_intent(text: &str) -> Option<(String, String)> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static TOPIC: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?i)(?:conversation|convo|texts?|messages?|chats?|thread|dms?|whatsapps?)\s+(?:with|from)\s+([A-Za-z][\w'\-]*(?:\s+[A-Z][\w'\-]*)?)|what\s+(?:did|has)\s+([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*)?)\s+(?:say|said|text|texted|message|messaged|tell|told|write|wrote)").unwrap()
    });
    let topic_re = TOPIC.get_or_init(|| regex::Regex::new(r"(?i)\b(?:about|regarding|re:?|on the topic of)\s+(.+?)[?.!]*$").unwrap());
    let c = re.captures(text)?;
    let who = c.get(1).or_else(|| c.get(2))?.as_str().trim().trim_end_matches(['?', '.', ',']).to_string();
    let who = who.split_whitespace().filter(|w| !["and", "about", "tell", "what", "said", "say"].contains(&w.to_ascii_lowercase().as_str())).collect::<Vec<_>>().join(" ");
    if who.is_empty() || ["me", "my", "him", "her", "them", "you"].contains(&who.to_ascii_lowercase().as_str()) {
        return None;
    }
    let topic = topic_re.captures(text).map(|t| t[1].trim().to_string()).unwrap_or_default();
    Some((who, topic))
}

/// Only words tied to a tool's subject (weather, files, git, web, email,
/// WhatsApp incl. Whisper's "what's up"…) — generic verbs like read/open/
/// list/find/latest made the router fire on unrelated requests.
fn wants_tools(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(weather|forecast|temperature|rain|snow|wind|what time|the date|tomorrow|fetch|url|https?://|website|web ?page|files?|folders?|readme|repo|git|commit|branch|search|look ?up|google|news|knowledge|remember|who is|e-?mails?|inbox|gmail|mails?|what'?s ?app|whatsapp|messages?|texts?|chats?|what'?s ?up|dms?|skills?|spotify|music|songs?|tracks?|albums?|playlists?|what'?s playing|now playing|next (?:song|track))\b|[a-z]:[\\/]").unwrap()
    })
    .is_match(text)
}

/// The line IS a media command once the address is stripped: it starts with play / put on /
/// pause / skip / volume / turn it up… Bare verbs inside a sentence ("what role does Redis
/// play", "the previous commit", "trading volume") don't count.
fn media_command(text: &str, os_name: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let core = super::routing::normalize(&super::routing::strip_address(text, os_name));
    RE.get_or_init(|| {
        regex::Regex::new(r"^(?:play|put on|throw on|queue up|pause|resume|unpause|skip|next (?:song|track)|next$|previous (?:song|track)|previous$|go back (?:a|1) (?:song|track)|volume|turn (?:it |the music |the volume )?(?:up|down)|mute)\b").unwrap()
    })
    .is_match(&core)
}

/// Gmail / WhatsApp / Spotify tools are only offered to the router when the
/// request itself names their subject (`norm` is `routing::normalize`d).
fn router_keyword_ok(server: &str, norm: &str) -> bool {
    static GMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WHATSAPP: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SPOTIFY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    match server {
        "gmail" => GMAIL.get_or_init(|| regex::Regex::new(r"\b(gmail|e ?mails?|inbox|mails?)\b").unwrap()).is_match(norm),
        "whatsapp" => WHATSAPP.get_or_init(|| regex::Regex::new(r"\b(whatsapp|messages?|texts?|chats?|dms?)\b").unwrap()).is_match(norm),
        "spotify" => SPOTIFY
            .get_or_init(|| regex::Regex::new(r"\b(spotify|music|songs?|tracks?|playing|playlists?|albums?|artist|listen(ed|ing)?)\b").unwrap())
            .is_match(norm),
        _ => true,
    }
}

/// One router line per tool: arg names plus a JSON call example.
fn router_tool_line(t: &super::mcp::ToolInfo) -> String {
    let args: serde_json::Map<String, Value> = t
        .args
        .iter()
        .filter(|a| !a.ends_with('?'))
        .map(|a| (a.clone(), if matches!(a.as_str(), "count" | "limit") { json!(5) } else { json!(format!("<{a}>")) }))
        .collect();
    format!("- {}({}): {} e.g. {}", t.name, t.args.join(", "), t.description, json!({ "tool": t.name, "args": args }))
}

// ── Tool pre-executor (Part 2) ──────────────────────────────────────────────
//
// Runs BEFORE a sub-agent sees its task (and for Tony's own turns), using
// only the tools the target agent is actually granted (`mcp::tool_set`).
// Fixes the root cause the MCP map found: a sub-agent that answers at all —
// even a refusal — used to skip tool-running entirely, because the old
// single-tool router only ran when `agent_answer.is_none()`. Now tool data
// is fetched first and handed to the sub-agent (or to Tony's own synthesis)
// as part of its task/context, regardless of what it goes on to say.

/// "last N (whatsapp) messages/texts/chats", "check my whatsapp", "messages
/// from X" → `whatsapp.list_messages`. Deterministic (no LLM round trip) so
/// the single most common refusal case is instant and never misrouted by the
/// JSON router.
fn whatsapp_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    let tool = tools.iter().find(|t| t.name == "whatsapp.list_messages")?;
    let norm = super::routing::normalize(original); // fixes Whisper's "what's up" → "whatsapp", number words → digits
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(?:last|recent)\s+(\d{1,2})?\s*(?:whatsapp\s+)?(?:messages?|texts?|chats?)\b|\bwhatsapp\s+(?:messages?|texts?|chats?)\b|\bcheck\s+my\s+whatsapp\b|\bmy\s+(?:last\s+)?(\d{1,2})?\s*whatsapp\b|\bmessages?\s+(?:with|from)\s+[a-z]",
        )
        .unwrap()
    });
    if !re.is_match(&norm) {
        return None;
    }
    let n: u64 = re.captures(&norm).and_then(|c| c.get(1).or_else(|| c.get(2))).and_then(|m| m.as_str().parse().ok()).unwrap_or(10);
    let limit = n.clamp(1, 50);
    let mut args = json!({ "limit": limit });
    if tool.args.iter().any(|a| a == "include_context") {
        args["include_context"] = json!(false);
    }
    static SENDER_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let sender_re = SENDER_RE.get_or_init(|| regex::Regex::new(r"(?i)\bmessages?\s+(?:with|from)\s+([A-Za-z][\w'\-]*(?:\s+[A-Z][\w'\-]*)?)").unwrap());
    if let Some(c) = sender_re.captures(original) {
        let name = c[1].trim().trim_end_matches(['?', '.', ',']).to_string();
        let key = if tool.args.iter().any(|a| a == "query") {
            Some("query")
        } else if tool.args.iter().any(|a| a == "sender_phone_number") {
            Some("sender_phone_number")
        } else {
            None
        };
        if let Some(key) = key {
            args[key] = json!(name);
        }
    }
    Some(("whatsapp.list_messages".to_string(), args))
}

/// "what time / what's the date" → `time.now`, without a model round trip.
fn time_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    if !tools.iter().any(|t| t.name == "time.now") {
        return None;
    }
    let norm = super::routing::normalize(original);
    (norm.contains("what time") || norm.contains("current time") || norm.contains("whats the date") || norm.contains("what date")).then(|| ("time.now".to_string(), json!({})))
}

/// The request names email at all (`norm` is `routing::normalize`d).
fn mentions_email(norm: &str) -> bool {
    router_keyword_ok("gmail", norm)
}

/// "read my last email", "latest 3 emails", "check my inbox", "any new
/// emails", "unread mail" → `gmail.recent`; "emails from Sam" →
/// `gmail.search {query: "from:Sam"}`. Checked before WhatsApp.
fn gmail_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    let norm = super::routing::normalize(original);
    if !mentions_email(&norm) {
        return None;
    }
    // "any unread messages in my WhatsApp inbox" names WhatsApp, not email: leave it to
    // whatsapp_plan unless the line also says email/Gmail outright.
    static OTHER_CHANNEL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static EXPLICIT_EMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if OTHER_CHANNEL.get_or_init(|| regex::Regex::new(r"\b(whatsapp|texts?|chats?|dms?)\b").unwrap()).is_match(&norm)
        && !EXPLICIT_EMAIL.get_or_init(|| regex::Regex::new(r"\b(gmail|e ?mails?)\b").unwrap()).is_match(&norm)
    {
        return None;
    }
    let has = |name: &str| tools.iter().any(|t| t.name == name);
    static FROM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let from = FROM.get_or_init(|| regex::Regex::new(r"\b(?i:e-?mails?|mails?|messages?)\s+(?i:from)\s+([\w.@+'\-]+(?:\s+[A-Z][\w'\-]*)?)").unwrap());
    if has("gmail.search") {
        if let Some(c) = from.captures(original) {
            let who = c[1].trim_end_matches(['?', '.', ',', '!']);
            if !who.is_empty() && !["me", "my", "him", "her", "them", "today", "yesterday"].contains(&who.to_ascii_lowercase().as_str()) {
                let query = if who.contains(' ') { format!("from:\"{who}\"") } else { format!("from:{who}") };
                return Some(("gmail.search".to_string(), json!({ "query": query, "limit": 5 })));
            }
        }
    }
    if !has("gmail.recent") {
        return None;
    }
    static RECENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RECENT.get_or_init(|| {
        regex::Regex::new(
            r"\b(?:last|latest|newest|most recent|recent)\s+(\d{1,2})?\s*(?:gmail\s+)?(e ?mails?|gmails?|mails?)\b|\b(?:check|read|open|show|whats in|what is in)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:gmail\s+)?(?:inbox|e ?mails?|gmail|mail)\b|\bany\s+(?:new\s+)?(?:e ?mails?|mail)\b|\bunread\b",
        )
        .unwrap()
    });
    let c = re.captures(&norm)?;
    let count: u64 = match (c.get(1), c.get(2)) {
        (Some(n), _) => n.as_str().parse().unwrap_or(1),
        (None, Some(noun)) if !noun.as_str().ends_with('s') => 1,
        _ => 5,
    };
    Some(("gmail.recent".to_string(), json!({ "count": count.clamp(1, 20) })))
}

/// "play …" phrases that aren't music ("play a game", "play devil's advocate").
const NOT_MUSIC: [&str; 12] = ["a game", "games", "devil", "around", "with", "along", "it ", "dumb", "nice", "back", "the role", "hard to get"];

/// Honest reply when a line asks to play something but no plan could tell what.
const PLAY_HELP: &str = "I couldn't tell what to play — say \"play <artist or song> on Spotify\"";

/// A request to play music that neither the deterministic planner nor the router
/// turned into a Spotify call. "play …" counts when it is short and not a game /
/// role ("play devil's advocate"); "put on / throw on / queue up / listen to" only
/// when the line names music. Feeds a fixed failure note instead of trusting the model.
fn unparsed_play_request(text: &str, os_name: &str) -> bool {
    static VERB: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static MUSIC: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let core = super::routing::normalize(&super::routing::strip_address(text, os_name));
    let Some(c) = VERB.get_or_init(|| regex::Regex::new(r"^(play|put on|throw on|queue up|listen to)\b(.*)$").unwrap()).captures(&core) else { return false };
    let rest = c[2].trim();
    if rest.is_empty() {
        return false;
    }
    // The music noun must head the object ("put on some music", "listen to the new album"),
    // not merely appear later ("listen to me, the band needs a name") or describe something else
    // ("this album review I wrote"): it ends the line or is followed by by / from / on / please….
    let musicy = MUSIC
        .get_or_init(|| regex::Regex::new(r"^(?:(?:some|the|my|a|an|this|that|new|good|more|other|any)\s+){0,3}(?:spotify|music|songs?|tracks?|playlists?|albums?|tunes?)(?:$|\s+(?:by|from|on|of|in|please|now|for|again)\b)").unwrap())
        .is_match(rest);
    let short_play = &c[1] == "play" && rest.split_whitespace().count() <= 6 && !NOT_MUSIC.iter().any(|w| rest.starts_with(w));
    musicy || short_play
}

/// Spotify by voice, without a model round trip, through `spotify_intent::parse` (the grammar
/// the TS fast path uses too). Needs the `spotify` server (its router-visible
/// `spotify.now_playing` proves it is on and granted); the chosen tool must be offered to this
/// agent (sub-agents get reads only). Writes still pass `call_tool`'s gates.
fn spotify_plan(original: &str, tools: &[super::mcp::ToolInfo], os_name: &str) -> Option<(String, Value)> {
    if !tools.iter().any(|t| t.name == "spotify.now_playing") {
        return None;
    }
    // The one Spotify grammar (D10): it strips the interjection / wake name / politeness itself.
    let i = super::spotify_intent::parse(original, os_name)?;
    // "reconnect Spotify": no tool call, a fixed reply (D15).
    if i.tool == super::spotify_intent::RECONNECT {
        return Some((i.tool, json!({})));
    }
    // Only tools this agent was offered: sub-agents get Spotify reads, never playback.
    tools.iter().any(|t| t.name == i.tool).then_some((i.tool, i.args))
}

/// A Spotify write the Rust tool path held back for the approval card (D14).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingSpotifyCall {
    pub name: String,
    pub args: Value,
    pub summary: String,
    pub required: String,
}

/// Pure (D14): a `PERMISSION_REQUIRED:<x>` refusal of a Spotify write becomes the exact call
/// the card will run — only when the caller can show cards (`askCards`).
fn pending_from(err: &str, name: &str, args: &Value, ask_cards: bool) -> Option<PendingSpotifyCall> {
    let name = super::spotify_intent::canonical(name);
    if !ask_cards || !super::spotify_intent::is_write_tool(name) || !err.starts_with("PERMISSION_REQUIRED:") {
        return None;
    }
    let args = super::spotify_intent::normalize_args(name, args).unwrap_or_else(|_| args.clone());
    let required = err.split_whitespace().next().unwrap_or(err).to_string();
    Some(PendingSpotifyCall { name: name.to_string(), summary: super::spotify_intent::summary_for(name, &args), args, required })
}

/// Where a prefetched tool call came from.
#[derive(Clone, Copy, Debug, PartialEq)]
enum PlanSource {
    Deterministic,
    Router,
}

/// Pure (D26): a Spotify result spoken as-is (no LLM synthesis) — any deterministic-plan result,
/// and router-chosen writes. Router-chosen reads still go through synthesis.
fn verbatim_answer(source: PlanSource, is_write: bool, reply: &str) -> Option<String> {
    (source == PlanSource::Deterministic || is_write).then(|| reply.to_string())
}

fn deterministic_plan(text: &str, tools: &[super::mcp::ToolInfo], os_name: &str) -> Option<(String, Value)> {
    gmail_plan(text, tools).or_else(|| whatsapp_plan(text, tools)).or_else(|| spotify_plan(text, tools, os_name)).or_else(|| time_plan(text, tools))
}

/// Text appended to Tony's (or a delegated agent's) prompt: the live tool data,
/// and/or an instruction to report the tool failure honestly.
fn tool_note(os_name: &str, raw: &str, failure: Option<&(String, String)>) -> String {
    let mut note = String::new();
    if !raw.is_empty() {
        note.push_str(&format!(
            "{raw}\n\nYou have live tool access through {os_name}. The data above was fetched just now; answer from it directly. Never say you lack access to WhatsApp, email, files or the internet."
        ));
    }
    if let Some((tool, err)) = failure {
        note.push_str(&format!("\n\n[TOOL FAILURE - {tool}]: {err}. Tell the user in one sentence exactly what failed and how to fix it; never say you lack the tool or the skill."));
    }
    note
}

/// What the tool pre-executor produced for one turn.
#[derive(Default)]
struct Prefetch {
    block: String,
    steps: Vec<OsStep>,
    used: Option<String>,
    /// (tool, error) of the call that failed — reported honestly to the model.
    failure: Option<(String, String)>,
    /// The tools offered this turn (router-visible; listed in Tony's system prompt).
    tools: Vec<super::mcp::ToolInfo>,
    /// The caller can raise approval cards (`OsTurnRequest.askCards`, D14).
    ask_cards: bool,
    /// Raw error of the last failed call (the `failure` text is humanized).
    last_error: Option<String>,
    /// A Spotify write held back for the approval card (D14): the turn returns it, no LLM call.
    pending_spotify: Option<PendingSpotifyCall>,
    /// A Spotify reply that IS the answer (D26): the turn returns it verbatim, no LLM call.
    verbatim: Option<String>,
}

impl Prefetch {
    /// After a `spotify.*` call: pin a write the gate held back, or keep the reply verbatim.
    fn spotify_outcome(&mut self, name: &str, args: &Value, res: Option<&str>, source: PlanSource) {
        if !name.starts_with("spotify.") {
            return;
        }
        let write = super::spotify_intent::is_write_tool(name);
        match res {
            Some(reply) => self.verbatim = verbatim_answer(source, write, reply),
            None => {
                if let Some(p) = self.last_error.as_deref().and_then(|e| pending_from(e, name, args, self.ask_cards)) {
                    self.pending_spotify = Some(p);
                    self.failure = None;
                }
            }
        }
    }
}

/// A tool error without the server's stderr tail: the step and the System Map keep the
/// full (scrubbed) text; the model only needs the status.
fn without_stderr(e: &str) -> &str {
    e.split(" — stderr: ").next().unwrap_or(e)
}

fn humanize_tool_error(e: &str) -> String {
    if let Some(rest) = e.strip_prefix(super::mcp::READ_ONLY_PREFIX) {
        rest.split_once(" — ").map_or(rest, |(_, why)| why).to_string()
    } else if let Some(what) = e.strip_prefix("PERMISSION_DENIED:") {
        format!("the {what} permission is set to Deny in Settings → Permissions")
    } else if let Some(what) = e.strip_prefix("PERMISSION_REQUIRED:") {
        format!("the {what} permission is set to Ask and this turn wasn't approved")
    } else {
        e.to_string()
    }
}

impl Prefetch {
    /// Run one tool call (bounded by `secs`) and record its step plus either
    /// its data or its failure. Returns the output on success.
    async fn call(&mut self, state: &DispatchState, os: &OsState, bridge: &BridgeState, name: &str, args: &Value, approved: bool, agent: &str, secs: Duration) -> Option<String> {
        let t0 = Instant::now();
        // A cold-starting MCP server answers "still starting" within CHAT_START_WAIT instead of
        // holding the turn; its start carries on and the next turn reuses the running server.
        let wait = Some(super::mcp::CHAT_START_WAIT.min(secs));
        let res = tokio::time::timeout(secs, super::mcp::call_tool_with(state, os, bridge, name, args, approved, agent, wait)).await;
        let ms = t0.elapsed().as_millis();
        match res {
            Ok(Ok(out)) => {
                self.steps.push(step("tool", "os", name, format!("{args}\n→ {}", out.chars().take(600).collect::<String>()), true, ms));
                let server = name.split('.').next().unwrap_or(name);
                self.block.push_str(&format!("\n\n[LIVE MCP TOOL DATA - {server}]:\n{}", out.chars().take(2000).collect::<String>()));
                self.used = Some(name.to_string());
                Some(out)
            }
            Ok(Err(e)) => {
                let starting = super::mcp::is_starting_error(&e);
                let label = if e.starts_with("PERMISSION_") { "blocked" } else if starting { "starting" } else { "failed" };
                self.steps.push(step("tool", "os", name, format!("{label}: {e}"), false, ms));
                let why = if starting { format!("{} is still starting up (cold start) — ask again in a few seconds", super::mcp::server_of_tool(name)) } else { humanize_tool_error(without_stderr(&e)) };
                self.failure = Some((name.to_string(), why));
                self.last_error = Some(e);
                None
            }
            Err(_) => {
                super::trace::emit(super::trace::Hop::Tool, name, false, ms, Some("timed out"));
                // The dropped call_tool future never reached its own record_call.
                super::mcp::record_call(super::mcp::server_of_tool(name), ms as u64, Some("timed out"), super::os_core::now_secs());
                self.steps.push(step("tool", "os", name, format!("{name} timed out"), false, ms));
                self.failure = Some((name.to_string(), "timed out".into()));
                None
            }
        }
    }
}

/// Run the JSON tool router, restricted to `tools` (minus Gmail/WhatsApp
/// tools the request doesn't name), for up to two sequential calls (so a
/// second lookup can build on the first), capped by `deadline`.
async fn run_tool_router(
    state: &DispatchState,
    os: &OsState,
    bridge: &BridgeState,
    tools: &[super::mcp::ToolInfo],
    context: &str,
    text: &str,
    approved: bool,
    agent: &str,
    os_name: &str,
    deadline: Instant,
    out: &mut Prefetch,
) {
    let offered = router_offer(tools, text, os_name);
    if offered.is_empty() {
        return;
    }
    let mut extra = String::new();
    for _ in 0..2 {
        let router = router_prompt(&offered, context, &extra);
        let mut msgs = vec![ChatMessage::new("system", router), ChatMessage::new("user", text.to_string())];
        let mut replied = false;
        let mut parsed = None;
        for attempt in 0..2 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let Ok(r) = run_chat(state, os, msgs.clone(), Priority::Interactive, None, Some(left.as_secs().clamp(1, 15))).await else { break };
            replied = true;
            if let Some(j) = extract_json(&r.content) {
                parsed = Some(j);
                break;
            }
            if attempt == 0 {
                msgs.push(ChatMessage::new("assistant", r.content));
                msgs.push(ChatMessage::new("user", "JSON only — reply with exactly one JSON object {\"tool\": …, \"args\": {…}} and nothing else."));
            }
        }
        if !replied {
            break;
        }
        // Not JSON / an unoffered tool is a visible (non-error) step; synthesis still proceeds.
        let Some(j) = parsed else {
            out.steps.push(step("tool", "os", "router", "no tool (router reply not JSON)", true, 0));
            break;
        };
        if j["tool"].is_null() {
            break; // router decided no tool is needed — expected, not a failure
        }
        let Some(name) = j["tool"].as_str().filter(|n| offered.iter().any(|t| t.name == *n)).map(String::from) else {
            out.steps.push(step("tool", "os", "router", format!("no tool (router named an unmatched tool: {})", j["tool"]), true, 0));
            break;
        };
        let args = if j["args"].is_object() { j["args"].clone() } else { json!({}) };
        let call_secs = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(15));
        if call_secs.is_zero() {
            out.steps.push(step("tool", "os", &name, format!("{name} skipped — out of time"), false, 0));
            break;
        }
        // Goes through `mcp::call_tool`: MCP permission gate, kill switch, logging.
        let res = out.call(state, os, bridge, &name, &args, approved, agent, call_secs).await;
        out.spotify_outcome(&name, &args, res.as_deref(), PlanSource::Router);
        match res {
            // One media action per turn: never let a second router pass play/skip again.
            Some(_) if super::mcp::is_spotify_actuator(&name) => break,
            Some(res) => extra = format!("\n\nTool {name} already returned:\n{}", res.chars().take(500).collect::<String>()),
            None => break,
        }
    }
}

/// The tools the JSON router is offered for `text`: Gmail / WhatsApp / Spotify
/// only when the request names their subject (`router_keyword_ok`); Spotify's
/// playback controls also for a line that is itself a media command ("skip", "turn it up").
/// Spotify library edits (playlists, Liked Songs) only when the line names the library (D25).
fn router_offer<'a>(tools: &'a [super::mcp::ToolInfo], text: &str, os_name: &str) -> Vec<&'a super::mcp::ToolInfo> {
    static LIBRARY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let norm = super::routing::normalize(text);
    let command = media_command(text, os_name);
    let library = LIBRARY.get_or_init(|| regex::Regex::new(r"\b(playlists?|liked songs|library|favou?rites|like|unlike|save|unsave|heart)\b").unwrap()).is_match(&norm);
    tools
        .iter()
        .filter(|t| {
            if t.server == "spotify" && super::spotify_intent::is_library_write(&t.name) {
                return library;
            }
            router_keyword_ok(&t.server, &norm) || (command && super::mcp::is_spotify_actuator(&t.name))
        })
        .collect()
}

/// The router's system prompt: one line per offered tool (args + example call).
fn router_prompt(offered: &[&super::mcp::ToolInfo], context: &str, extra: &str) -> String {
    let list = offered.iter().map(|t| router_tool_line(t)).collect::<Vec<_>>().join("\n");
    format!(
        "You route a request to at most ONE tool. Tools:\n{list}\n\nLIVE DASHBOARD:\n{}{extra}\n\nReply ONLY with JSON: {{\"tool\": \"<tool name>\" or null, \"args\": {{…}}}}. \
Use null if the dashboard/previous tool result already answers it or no tool helps. Spotify controls (spotify.play, spotify.pause, \
spotify.next, spotify.volume, …) only when the user plainly asks to play, pause, skip or change the music. \
Spotify tools control Spotify only — never use them for YouTube, videos or local sounds. Use library tools only when the user \
explicitly asks to change a playlist or Liked Songs.",
        context.chars().take(1500).collect::<String>()
    )
}

/// The tools a turn of `agent` can use — the ONE builder `prefetch_tools` and
/// `tony_tools_preview` share. A Deny MCP tier means none.
async fn turn_tools(state: &DispatchState, os: &OsState, cfg: &OsConfig, agent: &str) -> super::mcp::ToolSet {
    if cfg.permissions.mcp == super::bridge::Tier::Deny {
        return super::mcp::ToolSet { all: vec![], offered: vec![] };
    }
    super::mcp::tool_set(state, os, agent).await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TonyToolsPreview {
    /// Every tool of the servers Tony's turn can use (incl. ones the router never sees).
    all: Vec<String>,
    /// The subset offered to Tony's LLM router (and listed in his system prompt).
    router_offered: Vec<String>,
    /// The Spotify server is on, connected, not blocked by the kill switch and not
    /// denied by the MCP permission tier.
    spotify_ready: bool,
}

fn tools_preview(set: &super::mcp::ToolSet, spotify_ready: bool) -> TonyToolsPreview {
    TonyToolsPreview { all: set.all.iter().map(|t| t.name.clone()).collect(), router_offered: set.offered.iter().map(|t| t.name.clone()).collect(), spotify_ready }
}

/// Diagnostics: the tool names Tony's next turn would see. Names only — no
/// arguments, results or secrets.
#[tauri::command]
pub async fn tony_tools_preview(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<TonyToolsPreview, String> {
    let cfg = os.snapshot();
    let set = turn_tools(&state, &os, &cfg, "general").await;
    let spotify_ready = spotify_ready(&cfg, || super::spotify::readiness(&state).is_ok());
    Ok(tools_preview(&set, spotify_ready))
}

/// Same rule as `spotify::may_read`: kill switch off, MCP tier not Deny, server on, connected.
fn spotify_ready(cfg: &OsConfig, connected: impl FnOnce() -> bool) -> bool {
    !cfg.privacy.kill_switch && cfg.permissions.mcp != super::bridge::Tier::Deny && cfg.mcps.iter().any(|m| m.id == "spotify" && m.enabled) && connected()
}

/// Fetch live tool data for `agent`'s upcoming turn (its own granted tools;
/// Tony's own turns pass `"general"`, which `mcp::tool_set` always gives
/// every enabled server). Tries a deterministic plan first (instant, no LLM
/// call), then — if the text still plausibly wants a tool — the JSON router,
/// restricted to that agent's tools. Mutating tools are never offered
/// (`mcp::offered_to_router`, enforced inside `mcp::tool_set`; Tony's Spotify media controls are the one allowlisted exception). The whole
/// thing is capped at ~20s so one dead server can't stall the turn.
#[allow(clippy::too_many_arguments)]
async fn prefetch_tools(state: &DispatchState, os: &OsState, bridge: &BridgeState, cfg: &OsConfig, agent: &str, text: &str, context: &str, approved: bool, ask_cards: bool, cue_playing: bool) -> Prefetch {
    let mut out = Prefetch { ask_cards, ..Prefetch::default() };
    if cfg.permissions.mcp == super::bridge::Tier::Deny {
        return out;
    }
    let mut tools = turn_tools(state, os, cfg, agent).await.offered;
    // Cue precedence (G20): "volume 30" while Gabagool plays is the cue's — neither the grammar
    // nor the router may turn it into a Spotify volume change.
    if super::spotify_intent::cue_owns_volume(text, &cfg.os_name, cue_playing) {
        tools.retain(|t| t.name != "spotify.volume");
    }
    out.tools = tools.clone();
    let deadline = Instant::now() + Duration::from_secs(20);
    if let Some((name, args)) = deterministic_plan(text, &tools, &cfg.os_name) {
        // "reconnect Spotify" on the Rust path: a fixed reply, no tool, no browser (D15).
        if name == super::spotify_intent::RECONNECT {
            out.steps.push(step("tool", "os", &name, "fixed reply (sign-in happens in Settings → Integrations)", true, 0));
            out.verbatim = Some(super::spotify::RUST_RECONNECT.into());
            return out;
        }
        let secs = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(18));
        let res = out.call(state, os, bridge, &name, &args, approved, agent, secs).await;
        out.spotify_outcome(&name, &args, res.as_deref(), PlanSource::Deterministic);
        return out;
    }
    // Asked for email / Spotify but that server can't serve it (off / no
    // backend / not connected): say why instead of letting the model invent a refusal.
    type Planner = fn(&str, &[super::mcp::ToolInfo], &str) -> Option<(String, Value)>;
    let planners: [(&str, Planner); 2] = [("gmail", |t, tools, _| gmail_plan(t, tools)), ("spotify", spotify_plan)];
    for (id, plan) in planners {
        let granted = cfg.mcps.iter().any(|m| m.id == id && (agent == "general" || m.grants(agent)));
        if granted && !tools.iter().any(|t| t.server == id) && plan(text, &super::mcp::builtin_tools(id), &cfg.os_name).is_some() {
            if let Some(reason) = super::mcp::unavailable_reason(state, cfg, id) {
                out.steps.push(step("tool", "os", id, format!("failed: {reason}"), false, 0));
                out.failure = Some((id.into(), reason));
                return out;
            }
        }
    }
    if !tools.is_empty() && (wants_tools(text) || media_command(text, &cfg.os_name)) {
        run_tool_router(state, os, bridge, &tools, context, text, approved, agent, &cfg.os_name, deadline, &mut out).await;
    }
    // A "play …" line nothing could act on: a fixed, honest reply instead of letting the
    // local model claim Spotify is off (or guess what was meant).
    if out.used.is_none() && out.failure.is_none() && out.pending_spotify.is_none() && tools.iter().any(|t| t.server == "spotify") && unparsed_play_request(text, &cfg.os_name) {
        out.steps.push(step("tool", "os", "spotify.play", format!("failed: {PLAY_HELP}"), false, 0));
        out.failure = Some(("spotify.play".into(), PLAY_HELP.into()));
    }
    out
}

// ── The turn ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OsTurnRequest {
    pub(crate) text: String,
    /// Sub-agent role: librarian | coder | booking | ops | prompter | designer | general.
    pub(crate) role: String,
    /// The user opened that agent's tab (talk to it directly, no synthesis).
    #[serde(default)]
    pub(crate) explicit: bool,
    /// How the caller (the TS resolver) already classified this turn —
    /// "Named" | "Domain" | "Tab" | "Llm" | "Default". Echoed back on
    /// `OsTurnResult` unless the Rust safety net below re-resolves it.
    #[serde(default)]
    pub(crate) route_kind: Option<String>,
    #[serde(default)]
    pub(crate) route_reason: Option<String>,
    #[serde(default)]
    pub(crate) history: Vec<ChatMessage>,
    /// Live dashboard state rendered as text by the webview.
    #[serde(default)]
    pub(crate) context: String,
    #[serde(default)]
    pub(crate) approved: bool,
    /// Stream Tony's answer as `tony-token` events under this id.
    #[serde(default)]
    pub(crate) stream_id: Option<String>,
    /// System Map trace this turn's `os-trace` steps join (the webview's own hops use it
    /// too). Missing or malformed = a fresh id.
    #[serde(default)]
    pub(crate) trace_id: Option<String>,
    /// The caller can show approval cards (TS `osRun`): a Spotify write held by the Ask tier
    /// returns `pendingSpotify` instead of a failure note (D14). Phone / inbox leave it false.
    #[serde(default)]
    pub(crate) ask_cards: bool,
    /// A Gabagool cue is playing (TS `cuePlayingNow()`): a bare volume line ("volume 30") is
    /// the cue's, so Spotify volume is not offered this turn (`spotify_intent::cue_owns_volume`).
    #[serde(default)]
    pub(crate) cue_playing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OsStep {
    /// delegate | reply | tool | step-in | error | overseer | verify
    pub(crate) kind: String,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) text: String,
    pub(crate) ok: bool,
    pub(crate) ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTurnResult {
    pub(crate) answer: String,
    pub(crate) steps: Vec<OsStep>,
    pub(crate) provider_id: String,
    pub(crate) delegated_to: Option<String>,
    pub(crate) tool: Option<String>,
    pub(crate) latency_ms: u128,
    pub(crate) reason: String,
    pub(crate) redacted: bool,
    /// Comms thread the answer quotes from ("Jump to Thread in Comms →").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) comms_thread: Option<String>,
    /// Final role this turn was routed to (after the Rust safety net, if it fired).
    pub(crate) routed_role: String,
    pub(crate) route_reason: String,
    /// "Named" | "Domain" | "Tab" | "Llm" | "Default".
    pub(crate) route_kind: String,
    /// The Spotify write the card must run (D14); `answer` is "" then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pending_spotify: Option<PendingSpotifyCall>,
}

pub(crate) fn step(kind: &str, from: &str, to: &str, text: impl Into<String>, ok: bool, ms: u128) -> OsStep {
    OsStep { kind: kind.into(), from: from.into(), to: to.into(), text: text.into(), ok, ms }
}

#[tauri::command]
pub async fn os_turn(app: tauri::AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: OsTurnRequest) -> Result<OsTurnResult, String> {
    let Some(sid) = req.stream_id.clone().filter(|s| !s.is_empty()) else {
        return run_os_turn(&state, &os, &bridge, req, Some(&app)).await;
    };
    // Phase 2 "cut it": `os_turn_cancel {streamId}` drops this whole future — every in-flight
    // reqwest stream (LLM SSE, AnythingLLM stream-chat) and the compute slot go with it, and a
    // dropped connection stops the server generating.
    let cancel = TURN_CANCELS.register(&sid);
    let turn = std::pin::pin!(run_os_turn(&state, &os, &bridge, req, Some(&app)));
    let cancelled = std::pin::pin!(cancel.notified());
    let out = match futures_util::future::select(turn, cancelled).await {
        futures_util::future::Either::Left((r, _)) => r,
        futures_util::future::Either::Right(_) => Err(TURN_CANCELLED.into()),
    };
    TURN_CANCELS.finish(&sid);
    out
}

/// Error text of a turn stopped by `os_turn_cancel` (the webview stays silent on it).
pub(crate) const TURN_CANCELLED: &str = "turn cancelled";

/// streamId → cancel signal. A cancel that arrives before its turn registers leaves a stored
/// permit (`Notify::notify_one`), so the turn ends as soon as it starts.
pub(crate) struct TurnCancels(std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Notify>>>);

impl TurnCancels {
    fn slot(&self, id: &str) -> std::sync::Arc<tokio::sync::Notify> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Pre-cancels for turns that never ran would otherwise accumulate.
        if m.len() > 64 {
            m.retain(|_, n| std::sync::Arc::strong_count(n) > 1);
        }
        m.entry(id.to_string()).or_insert_with(|| std::sync::Arc::new(tokio::sync::Notify::new())).clone()
    }
    pub(crate) fn register(&self, id: &str) -> std::sync::Arc<tokio::sync::Notify> {
        self.slot(id)
    }
    pub(crate) fn cancel(&self, id: &str) {
        self.slot(id).notify_one();
    }
    pub(crate) fn finish(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}

pub(crate) static TURN_CANCELS: std::sync::LazyLock<TurnCancels> = std::sync::LazyLock::new(|| TurnCancels(Default::default()));

/// Stop an in-flight `os_turn` by its `streamId` (Phase 2 "cut it"). Unknown ids are harmless.
#[tauri::command]
pub fn os_turn_cancel(stream_id: String) {
    if !stream_id.is_empty() && stream_id.len() <= 128 {
        TURN_CANCELS.cancel(&stream_id);
    }
}

#[cfg(test)]
mod turn_cancel_tests {
    use super::*;
    use futures_util::FutureExt;

    #[test]
    fn cancel_wakes_a_registered_turn() {
        let c = TurnCancels(Default::default());
        let n = c.register("a");
        assert!(n.notified().now_or_never().is_none(), "not cancelled yet");
        c.cancel("a");
        assert!(n.notified().now_or_never().is_some());
        c.finish("a");
        assert!(c.0.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_before_register_is_kept() {
        let c = TurnCancels(Default::default());
        c.cancel("b");
        let n = c.register("b");
        assert!(n.notified().now_or_never().is_some(), "an early cut still stops the turn");
        // Another stream id is unaffected.
        assert!(c.register("other").notified().now_or_never().is_none());
    }
}

pub async fn run_os_turn(state: &DispatchState, os: &OsState, bridge: &BridgeState, req: OsTurnRequest, app: Option<&tauri::AppHandle>) -> Result<OsTurnResult, String> {
    let id = req.trace_id.clone().filter(|t| super::trace::valid_id(t)).unwrap_or_else(super::trace::new_id);
    super::trace::scoped(id, os_turn_traced(state, os, bridge, req, app)).await
}

/// System Map label for a model call: `provider · model`.
fn model_label(state: &DispatchState, provider_id: &str) -> String {
    match state.snapshot().providers.iter().find(|p| p.id == provider_id).map(|p| p.model.clone()).filter(|m| !m.is_empty()) {
        Some(model) => format!("{provider_id} · {model}"),
        None => provider_id.to_string(),
    }
}

/// `run_os_turn`'s body, inside its trace scope: emits router / rules / memory / model steps.
async fn os_turn_traced(state: &DispatchState, os: &OsState, bridge: &BridgeState, req: OsTurnRequest, app: Option<&tauri::AppHandle>) -> Result<OsTurnResult, String> {
    use super::trace::{emit, emit_with, Hop};
    let (state, os, bridge) = (state, os, bridge);
    let started = Instant::now();
    let cfg = os.snapshot();
    let text = req.text.trim().to_string();
    if text.is_empty() || text.len() > 20_000 {
        return Err("empty or oversized request".into());
    }

    // ── Routing safety net ──
    // The caller (the TS resolver, for desktop turns; the phone's own default
    // trigger table, for inbox turns) has usually already resolved a role.
    // When it hasn't — role is still "general" and this isn't an explicit
    // tab turn — re-resolve here against the *authoritative* config (every
    // custom trigger the user saved), which the phone path can't see.
    let mut role = req.role.clone();
    let mut route_kind = req.route_kind.clone().unwrap_or_else(|| if req.explicit { "Tab".into() } else { "Default".into() });
    let mut route_reason = req.route_reason.clone().unwrap_or_else(|| if req.explicit { "current tab".into() } else { "caller-resolved".into() });
    if role == "general" && !req.explicit {
        let r = super::routing::resolve(&text, &cfg);
        if matches!(r.kind, super::routing::RouteKind::Named | super::routing::RouteKind::Domain) {
            if let Some(rr) = r.role {
                role = rr;
                route_kind = format!("{:?}", r.kind);
                route_reason = r.reason;
            }
        }
    }
    // Route kind + target only (the reason can quote the request).
    let who = if role == "general" { cfg.os_name.clone() } else { role_label(&role) };
    emit(Hop::Router, &format!("{route_kind} → {who}"), true, started.elapsed().as_millis(), None);

    let mut steps: Vec<OsStep> = Vec::new();
    let mut delegated_to = None;
    let mut agent_answer: Option<String> = None;
    let mut comms_thread: Option<String> = None;

    // ── Conversational recall: "look at my conversation with Sam — what did they say about X?" ──
    if let Some((who, topic)) = comms_recall_intent(&text) {
        let t0 = Instant::now();
        steps.push(step("delegate", "os", "librarian", format!("Search the {who} conversation (SMS / WhatsApp / calls) for: {}", if topic.is_empty() { "anything recent" } else { &topic }), true, 0));
        match super::pipeline::comms_search(state, &cfg, &who, &topic).await {
            Ok((quotes, thread)) if !quotes.is_empty() => {
                steps.push(step("reply", "librarian", "os", quotes.clone(), true, t0.elapsed().as_millis()));
                agent_answer = Some(format!("Exact quotes from the conversation with {who}:\n{quotes}"));
                delegated_to = Some("comms-history".into());
                comms_thread = thread;
            }
            Ok(_) => steps.push(step("reply", "librarian", "os", format!("No messages with {who} match that."), false, t0.elapsed().as_millis())),
            Err(e) => steps.push(step("error", "librarian", "os", format!("Comms history unavailable: {e}"), false, t0.elapsed().as_millis())),
        }
        // Outcome only: the contact and topic are the request's own words.
        let (ok, failed) = steps.last().map(|s| (s.ok, s.kind == "error")).unwrap_or((false, false));
        emit(Hop::Memory, "comms history search", ok, t0.elapsed().as_millis(), failed.then_some("comms history unavailable"));
    }
    let keep = cfg.scheduler.history_turns.max(2) as usize;
    let history: Vec<ChatMessage> = req.history.into_iter().rev().take(keep).collect::<Vec<_>>().into_iter().rev().collect();

    // ── Tool pre-executor (Part 2) — runs BEFORE delegation, using only the
    // target agent's own granted tools, and regardless of whether a
    // sub-agent later answers (that gate used to skip tools entirely). ──
    let prefetch_agent = if role == "general" { "general" } else { role.as_str() };
    // The delegation gate runs BEFORE any tool: a PERMISSION_REQUIRED here makes the UI
    // re-run the whole turn with approved=true, so a prefetched action (a Spotify skip)
    // would otherwise run once now and again on the retry — or run although the user said no.
    let slug = cfg.anythingllm.workspaces.get(&role).filter(|s| !s.is_empty()).cloned();
    if role != "general" && comms_thread.is_none() {
        if let Some(slug) = &slug {
            os_core::gate(bridge, cfg.permissions.delegation, "delegation", req.approved, json!({ "workspace": slug }))?;
        }
    }
    let pre = if comms_thread.is_none() { prefetch_tools(state, os, bridge, &cfg, prefetch_agent, &text, &req.context, req.approved, req.ask_cards, req.cue_playing).await } else { Prefetch::default() };
    steps.extend(pre.steps);
    let tool_note = tool_note(&cfg.os_name, &pre.block, pre.failure.as_ref());
    let tool_used = pre.used;

    // ── Spotify on Tony's tool path ── a write held by the Ask tier (D14) or a reply that is the
    // answer (D26) ends the turn here, before any model call.
    if role == "general" {
        let spotify_turn = |answer: String, tool: Option<String>, reason: &str, pending: Option<PendingSpotifyCall>, steps: Vec<OsStep>| OsTurnResult {
            answer,
            steps,
            provider_id: "spotify".into(),
            delegated_to: None,
            tool,
            latency_ms: started.elapsed().as_millis(),
            reason: reason.into(),
            redacted: false,
            comms_thread: None,
            routed_role: role.clone(),
            route_reason: route_reason.clone(),
            route_kind: route_kind.clone(),
            pending_spotify: pending,
        };
        if let Some(p) = pre.pending_spotify {
            let res = spotify_turn(String::new(), Some(p.name.clone()), "spotify approval card", Some(p), steps);
            log_turn(bridge, &role, &text, &res);
            return Ok(res);
        }
        if let Some(reply) = pre.verbatim {
            // Spoken like a streamed answer: one `tony-token` chunk under the turn's stream id.
            if let (Some(app), Some(sid)) = (app, req.stream_id.as_deref()) {
                use tauri::Emitter;
                let _ = app.emit("tony-token", json!({ "streamId": sid, "delta": reply }));
            }
            let res = spotify_turn(reply, tool_used.clone(), "spotify reply (verbatim)", None, steps);
            log_turn(bridge, &role, &text, &res);
            return Ok(res);
        }
    }

    // ── 2. Delegation ── (gated above, before the tool pre-executor)
    if role != "general" && comms_thread.is_none() {
        if let Some(slug) = slug {
            let label = role_label(&role);
            let skills = super::mcp::skill_digest(&cfg, &role);
            // Designer / Prompter also get the user's identity file (taste, brand, goals).
            let identity = if matches!(role.as_str(), "designer" | "prompter") {
                let r = os_core::read_identity(&cfg);
                emit(Hop::Rules, &format!("MASTER_IDENTITY.md → {label}"), r.is_ok(), 0, r.as_ref().err().map(|_| "identity file not readable"));
                r.map(|i| format!("\n\nABOUT THE USER (MASTER_IDENTITY.md):\n{}", i.chars().take(2000).collect::<String>())).unwrap_or_default()
            } else {
                String::new()
            };
            let task = if req.explicit {
                if skills.is_empty() && identity.is_empty() { text.clone() } else { format!("{text}{}{identity}", if skills.is_empty() { String::new() } else { format!("\n\n(Your attached skills: {})", skills.replace('\n', "; ")) }) }
            } else {
                format!(
                    "[{} → {label} agent] The user asked {} (their OS) to get this from you. Answer from your workspace data and documents; be specific and concise.{}\n\nRequest: {text}",
                    cfg.os_name,
                    cfg.os_name,
                    if skills.is_empty() { String::new() } else { format!("\nYour attached skills:\n{skills}") }
                ) + &identity
            };
            let task = format!("{task}{tool_note}");
            steps.push(step("delegate", "os", &role, &task, true, 0));
            let t0 = Instant::now();
            // Talking directly to this agent's tab (no Tony synthesis to follow):
            // stream its reply with its OWN voice as it arrives, instead of
            // waiting for the whole answer (Part 6 §1). A delegated turn that
            // Tony is about to summarize skips this — streaming the raw
            // sub-agent reply there would be heard twice (once raw, once as
            // Tony's synthesis moments later).
            let chat_result = match (req.explicit, req.stream_id.as_deref(), app) {
                (true, Some(sid), Some(app)) => workspace_chat_streamed(state, os, &slug, &task, app, sid, &role).await,
                _ => workspace_chat(state, os, &slug, &task).await,
            };
            // A Librarian read is a memory hop (cargo); any other sub-agent is a model call (engine).
            let hop = if role == "librarian" { Hop::Memory } else { Hop::Model };
            let hop_label = format!("{label} · anythingllm/{slug}");
            match &chat_result {
                Ok(_) => emit(hop, &hop_label, true, t0.elapsed().as_millis(), None),
                Err(e) => emit_with(hop, &hop_label, false, t0.elapsed().as_millis(), Some(e), None, &super::devqueue::known_secrets(state, os)),
            }
            match chat_result {
                Ok((answer, sources)) => {
                    let src = if sources.is_empty() { String::new() } else { format!("\n\nSources: {}", sources.join(", ")) };
                    steps.push(step("reply", &role, "os", format!("{answer}{src}"), true, t0.elapsed().as_millis()));
                    // Phase 2 §4 announcer handoff: a delegated agent's answer goes to the webview
                    // the moment it lands, so it can speak in its own voice while Tony's synthesis
                    // (shown, not spoken in that mode) is still generating.
                    if let (false, Some(sid), Some(app)) = (req.explicit, req.stream_id.as_deref(), app) {
                        use tauri::Emitter;
                        let _ = app.emit("os-agent-reply", json!({ "streamId": sid, "agent": role, "text": answer }));
                    }
                    delegated_to = Some(slug.clone());
                    agent_answer = Some(answer);
                }
                Err(e) => {
                    steps.push(step("error", &role, "os", format!("{label} agent failed: {e}"), false, t0.elapsed().as_millis()));
                    steps.push(step("step-in", "os", "user", format!("{} stepped in with its own tools.", cfg.os_name), true, 0));
                }
            }
        }
    }

    // Explicit tab + the agent answered: that IS the answer.
    if let (true, Some(a)) = (req.explicit, &agent_answer) {
        let res = OsTurnResult {
            answer: a.clone(),
            steps,
            provider_id: format!("anythingllm:{}", delegated_to.clone().unwrap_or_default()),
            delegated_to,
            tool: tool_used.clone(),
            latency_ms: started.elapsed().as_millis(),
            reason: "direct to sub-agent".into(),
            redacted: false,
            comms_thread: None,
            routed_role: role.clone(),
            route_reason: route_reason.clone(),
            route_kind: route_kind.clone(),
            pending_spotify: None,
        };
        log_turn(bridge, &role, &text, &res);
        return Ok(res);
    }

    // ── 1 + 3. OS context + synthesis ──
    // The tool data for a delegated (non-general) turn already rode along in
    // the task above; Tony's own turns (role == "general") get it here, in
    // his own system prompt, since there was no delegated task to carry it.
    let t_rules = Instant::now();
    let sys = system_prompt(&cfg, &req.context, &pre.tools);
    if sys.contains("ABOUT THE USER (MASTER_IDENTITY.md)") {
        emit(Hop::Rules, "system prompt + MASTER_IDENTITY.md", true, t_rules.elapsed().as_millis(), None);
    } else {
        emit(Hop::Rules, "system prompt (no identity)", false, t_rules.elapsed().as_millis(), Some("MASTER_IDENTITY.md not readable — check the identity path in Settings"));
    }
    let sys_tool_note = if role == "general" { tool_note.clone() } else { String::new() };

    let mut user_msg = text.clone();
    if let Some(a) = &agent_answer {
        user_msg = format!(
            "{text}\n\n[{} agent's reply — summarize it for the user in your own voice, keep the specifics (names, dates, times), don't invent anything]:\n{a}",
            role_label(&role)
        );
    }
    let mut msgs = vec![ChatMessage::new("system", format!("{sys}{sys_tool_note}"))];
    msgs.extend(history);
    msgs.push(ChatMessage::new("user", user_msg));

    let t_model = Instant::now();
    let answer = match (app, req.stream_id.as_deref()) {
        (Some(app), Some(sid)) => super::dispatch::run_chat_streamed(state, os, msgs.clone(), Some(90), app, sid).await,
        _ => run_chat(state, os, msgs.clone(), Priority::Interactive, None, Some(90)).await,
    };
    match &answer {
        Ok(r) => emit_with(Hop::Model, &model_label(state, &r.provider_id), true, t_model.elapsed().as_millis(), None, r.tps, &[]),
        Err(e) => emit_with(Hop::Model, &format!("{} chat chain", cfg.os_name), false, t_model.elapsed().as_millis(), Some(e), None, &super::devqueue::known_secrets(state, os)),
    }
    let res = match answer {
        Ok(r) => r,
        Err(e) if cfg.overseer.auto_escalate => {
            steps.push(step("error", "os", "user", format!("local chain failed: {e}"), false, 0));
            let t0 = Instant::now();
            let escalated = overseer_call(state, os, &cfg, &msgs).await;
            match &escalated {
                Ok((_, engine, _)) => emit(Hop::Model, &format!("overseer · {engine}"), true, t0.elapsed().as_millis(), None),
                Err(e) => emit_with(Hop::Model, "overseer", false, t0.elapsed().as_millis(), Some(e), None, &super::devqueue::known_secrets(state, os)),
            }
            let (answer, engine, redacted) = escalated?;
            steps.push(step("overseer", &engine, "os", "auto-escalated", true, t0.elapsed().as_millis()));
            let out = OsTurnResult {
                answer,
                steps,
                provider_id: engine,
                delegated_to,
                tool: tool_used,
                latency_ms: started.elapsed().as_millis(),
                reason: "auto-escalated to overseer".into(),
                redacted,
                comms_thread: comms_thread.clone(),
                routed_role: role.clone(),
                route_reason: route_reason.clone(),
                route_kind: route_kind.clone(),
                pending_spotify: None,
            };
            log_turn(bridge, &role, &text, &out);
            return Ok(out);
        }
        Err(e) => {
            // The sub-agent answered but no model is up to summarize: hand it over as-is.
            if let Some(a) = agent_answer {
                let out = OsTurnResult {
                    answer: a,
                    steps,
                    provider_id: format!("anythingllm:{}", delegated_to.clone().unwrap_or_default()),
                    delegated_to,
                    tool: tool_used,
                    latency_ms: started.elapsed().as_millis(),
                    reason: format!("synthesis failed ({e}) — raw agent reply"),
                    redacted: false,
                    comms_thread: comms_thread.clone(),
                    routed_role: role.clone(),
                    route_reason: route_reason.clone(),
                    route_kind: route_kind.clone(),
                    pending_spotify: None,
                };
                log_turn(bridge, &role, &text, &out);
                return Ok(out);
            }
            return Err(e);
        }
    };
    // If the model's final answer is itself bare JSON or a tool-call (it
    // decided to "answer" with the router shape instead of prose), ask it
    // once more for plain sentences rather than showing/speaking raw JSON.
    let answer_text = ensure_prose(state, os, &msgs, res.content).await;
    let out = OsTurnResult {
        answer: answer_text,
        steps,
        provider_id: res.provider_id,
        delegated_to,
        tool: tool_used,
        latency_ms: started.elapsed().as_millis(),
        reason: res.reason,
        redacted: res.redacted,
        comms_thread,
        routed_role: role.clone(),
        route_reason,
        route_kind,
        pending_spotify: None,
    };
    log_turn(bridge, &role, &text, &out);
    Ok(out)
}

/// The whole trimmed reply is itself a JSON object / fenced JSON / tool-call
/// wrapper (not merely prose that happens to mention `{…}` somewhere) — the
/// model answered in the router's shape instead of talking to the user.
fn looks_like_bare_json(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    (t.starts_with('{') || t.starts_with("```json") || t.starts_with("<tool_call>")) && extract_json(t).is_some()
}

/// Re-ask once, in plain sentences, when the final answer is bare JSON/a
/// tool-call (Part 6 §3). Best-effort: any failure, or a retry that's still
/// bare JSON, keeps the original text rather than losing the answer.
async fn ensure_prose(state: &DispatchState, os: &OsState, msgs: &[ChatMessage], content: String) -> String {
    if !looks_like_bare_json(&content) {
        return content;
    }
    let mut retry = msgs.to_vec();
    retry.push(ChatMessage::new("user", "Answer that in plain sentences for the user — no JSON, no tool-call syntax."));
    match run_chat(state, os, retry, Priority::Interactive, None, Some(20)).await {
        Ok(r) if !looks_like_bare_json(&r.content) => r.content,
        _ => content,
    }
}

fn log_turn(bridge: &BridgeState, role: &str, text: &str, r: &OsTurnResult) {
    bridge.log(json!({
        "type": "os-turn",
        "role": role,
        "upstream": text,
        "downstream": r.answer,
        "provider": r.provider_id,
        "delegatedTo": r.delegated_to,
        "tool": r.tool,
        "steps": r.steps.len(),
        "latencyMs": r.latency_ms as u64,
    }));
}

// ── Overseer / external engines ─────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverseerRequest {
    question: String,
    #[serde(default)]
    transcript: Vec<ChatMessage>,
    #[serde(default)]
    context: String,
    /// Override the configured engine for this one call.
    engine: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverseerResult {
    answer: String,
    engine: String,
    latency_ms: u128,
    redacted: bool,
}

#[tauri::command]
pub async fn overseer_ask(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: OverseerRequest) -> Result<OverseerResult, String> {
    let started = Instant::now();
    let mut cfg = os.snapshot();
    if let Some(e) = req.engine {
        cfg.overseer.engine = e;
    }
    let sys = format!(
        "You are the Overseer: a senior reviewer that {} (the user's local AI OS) escalates to. Review the conversation, correct mistakes, \
and give the best concrete answer or next step. Be direct and brief. Values like [CLIENT_1] or [EMAIL_1] are privacy placeholders — keep them as-is.\n\nLIVE DASHBOARD:\n{}",
        cfg.os_name,
        req.context.chars().take(2000).collect::<String>()
    );
    let mut msgs = vec![ChatMessage::new("system", sys)];
    msgs.extend(req.transcript.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev());
    msgs.push(ChatMessage::new("user", req.question));
    let (answer, engine, redacted) = overseer_call(&state, &os, &cfg, &msgs).await?;
    bridge.log(json!({ "type": "overseer", "engine": engine, "redacted": redacted, "latencyMs": started.elapsed().as_millis() as u64 }));
    Ok(OverseerResult { answer, engine, latency_ms: started.elapsed().as_millis(), redacted })
}

async fn overseer_call(state: &DispatchState, os: &OsState, cfg: &OsConfig, msgs: &[ChatMessage]) -> Result<(String, String, bool), String> {
    match cfg.overseer.engine.as_str() {
        "droplet" => {
            let r = run_chat(state, os, msgs.to_vec(), Priority::Interactive, Some("droplet".into()), Some(120)).await?;
            Ok((r.content, "droplet".into(), r.redacted))
        }
        "local" => {
            let r = run_chat(state, os, msgs.to_vec(), Priority::Interactive, Some("verifier".into()), Some(120)).await?;
            Ok((r.content, r.provider_id, r.redacted))
        }
        engine => {
            let (a, red) = external_chat(state, os, engine, msgs, 180).await?;
            Ok((a, engine.to_string(), red))
        }
    }
}

/// Claude / Gemini via CLI or API. Kill switch + cloud permission enforced,
/// prompt diffused and the reply re-hydrated locally.
pub(crate) async fn external_chat(state: &DispatchState, os: &OsState, engine: &str, messages: &[ChatMessage], max_secs: u64) -> Result<(String, bool), String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err("kill switch is on — external engines are blocked".into());
    }
    if cfg.compute.mode == os_core::ComputeMode::Local {
        return Err("LOCAL ONLY mode — external engines are blocked".into());
    }
    if cfg.permissions.cloud == super::bridge::Tier::Deny {
        return Err("PERMISSION_DENIED:cloud".into());
    }
    let mut red = super::privacy::Redactor::default();
    let msgs: Vec<ChatMessage> = if cfg.privacy.diffuser {
        messages.iter().map(|m| ChatMessage::new(&m.role, red.redact(&m.content, &cfg.privacy.sensitive_terms))).collect()
    } else {
        messages.to_vec()
    };
    if cfg.privacy.diffuser {
        os.record_redaction(&format!("ext:{engine}"), serde_json::to_value(&msgs).unwrap_or_default(), red.replacements.clone());
    }
    let secs = max_secs.clamp(10, 600);
    let out = match engine {
        "claude-cli" => cli(&["claude.cmd", "claude"], &["-p", "--output-format", "text"], flatten(&msgs), secs).await?,
        "gemini-cli" => cli(&["gemini.cmd", "gemini"], &[], flatten(&msgs), secs).await?,
        "llm-cli" => cli(&["llm.exe", "llm"], &["prompt"], flatten(&msgs), secs).await?,
        "claude-api" => claude_api(state, &cfg, &msgs, secs).await?,
        "gemini-api" => gemini_api(state, &cfg, &msgs, secs).await?,
        other => return Err(format!("unknown engine {other}")),
    };
    let redacted = !red.replacements.is_empty();
    Ok((red.rehydrate(out.trim()), redacted))
}

fn flatten(msgs: &[ChatMessage]) -> String {
    msgs.iter().map(|m| format!("### {}\n{}", m.role.to_uppercase(), m.content)).collect::<Vec<_>>().join("\n\n")
}

/// Run a fixed CLI with the prompt on stdin (never on the command line).
async fn cli(programs: &[&'static str], args: &[&'static str], input: String, secs: u64) -> Result<String, String> {
    let programs = programs.to_vec();
    let args = args.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = String::new();
        for program in programs {
            // Resolve npm/uv shims explicitly (no PATHEXT lookup in CreateProcess).
            let resolved = super::clihub::resolve(program.trim_end_matches(".cmd").trim_end_matches(".exe"));
            let mut c = match &resolved {
                Some(p) => Command::new(p),
                None => Command::new(program),
            };
            c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            let mut child = match c.spawn() {
                Ok(ch) => ch,
                Err(e) => {
                    last = format!("{program}: {e}");
                    continue;
                }
            };
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            let input = input.clone();
            std::thread::spawn(move || {
                let _ = stdin.write_all(input.as_bytes());
            });
            let mut out = child.stdout.take().ok_or("no stdout")?;
            let mut err = child.stderr.take().ok_or("no stderr")?;
            let reader = std::thread::spawn(move || {
                let mut s = String::new();
                let _ = out.read_to_string(&mut s);
                s
            });
            let ereader = std::thread::spawn(move || {
                let mut s = String::new();
                let _ = err.read_to_string(&mut s);
                s
            });
            let deadline = Instant::now() + Duration::from_secs(secs);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let o = reader.join().unwrap_or_default();
                        let e = ereader.join().unwrap_or_default();
                        if status.success() && !o.trim().is_empty() {
                            return Ok(o);
                        }
                        return Err(format!("{program} failed: {}", if e.trim().is_empty() { o } else { e }.chars().take(300).collect::<String>()));
                    }
                    Ok(None) if Instant::now() > deadline => {
                        let _ = child.kill();
                        return Err(format!("{program} timed out after {secs}s"));
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(150)),
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        Err(format!("CLI not installed ({last})"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Anthropic Messages API (raw HTTP — there is no official Rust SDK).
async fn claude_api(state: &DispatchState, cfg: &OsConfig, msgs: &[ChatMessage], secs: u64) -> Result<String, String> {
    // env / repo .env / keychain. Safe for an unscoped env key: the host below is hard-coded.
    let key = super::envfile::os_key(state, "anthropic").ok_or("add an Anthropic API key in Settings → Integrations → Overseer, or set ANTHROPIC_API_KEY in the repo-root .env")?;
    let system: Vec<&str> = msgs.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
    // Alternate user/assistant, merging consecutive same-role turns; must start with user.
    let mut turns: Vec<(String, String)> = Vec::new();
    for m in msgs.iter().filter(|m| m.role != "system") {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        match turns.last_mut() {
            Some((r, c)) if r == role => {
                c.push_str("\n\n");
                c.push_str(&m.content);
            }
            _ => turns.push((role.into(), m.content.clone())),
        }
    }
    if turns.first().is_some_and(|t| t.0 == "assistant") {
        turns.insert(0, ("user".into(), "(conversation so far)".into()));
    }
    let body = json!({
        "model": cfg.overseer.claude_model,
        "max_tokens": 16000,
        "system": system.join("\n\n"),
        "messages": turns.iter().map(|(r, c)| json!({ "role": r, "content": c })).collect::<Vec<_>>(),
        "output_config": { "effort": "medium" },
        // Server-side refusal fallback: a declined turn is retried on a suitable model.
        "fallbacks": "default",
    });
    let r = state
        .http
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .json(&body)
        .timeout(Duration::from_secs(secs))
        .send()
        .await
        .map_err(short)?;
    let status = r.status();
    let v: Value = r.json().await.map_err(short)?;
    if !status.is_success() {
        return Err(format!("Claude API {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("error")));
    }
    if v["stop_reason"] == "refusal" {
        return Err(format!("Claude declined ({})", v["stop_details"]["category"].as_str().unwrap_or("policy")));
    }
    let text: Vec<&str> = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    if text.is_empty() {
        return Err("Claude returned no text".into());
    }
    Ok(text.join("\n"))
}

async fn gemini_api(state: &DispatchState, cfg: &OsConfig, msgs: &[ChatMessage], secs: u64) -> Result<String, String> {
    // env / repo .env / keychain. Safe for an unscoped env key: the host below is hard-coded.
    let key = super::envfile::os_key(state, "gemini").ok_or("add a Gemini API key in Settings → Integrations → Overseer, or set GEMINI_API_KEY in the repo-root .env")?;
    let system: Vec<&str> = msgs.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
    let contents: Vec<Value> = msgs
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| json!({ "role": if m.role == "assistant" { "model" } else { "user" }, "parts": [{ "text": m.content }] }))
        .collect();
    let model = &cfg.overseer.gemini_model;
    if !model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("invalid Gemini model id".into());
    }
    let r = state
        .http
        .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&json!({ "systemInstruction": { "parts": [{ "text": system.join("\n\n") }] }, "contents": contents }))
        .timeout(Duration::from_secs(secs))
        .send()
        .await
        .map_err(short)?;
    let status = r.status();
    let v: Value = r.json().await.map_err(short)?;
    if !status.is_success() {
        return Err(format!("Gemini API {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("error")));
    }
    let text: Vec<&str> = v["candidates"][0]["content"]["parts"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect();
    if text.is_empty() {
        return Err("Gemini returned no text".into());
    }
    Ok(text.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_intent() {
        let (w, t) = comms_recall_intent("Hey Tony, look at my conversation with Sam and tell me what they said about the shoot").unwrap();
        assert_eq!(w, "Sam");
        assert_eq!(t, "the shoot");
        let (w, _) = comms_recall_intent("what did Maria Lopez text me yesterday?").unwrap();
        assert_eq!(w, "Maria Lopez");
        assert!(comms_recall_intent("what's the weather").is_none());
    }

    #[test]
    fn tool_hint() {
        assert!(wants_tools("what's the weather like"));
        assert!(wants_tools("read C:\\ai-hub\\README.md"));
        assert!(!wants_tools("tell me a joke"));
        // Part 2's widened gaps: the exact refusal-causing phrases from the MCP map.
        assert!(wants_tools("check my what's up"));
        assert!(wants_tools("last message in my WhatsApp group"));
        assert!(wants_tools("any texts from Sam?"));
        assert!(wants_tools("what's in my inbox"));
        // Generic verbs alone no longer wake the router.
        assert!(!wants_tools("integrate this into Cloud Code"));
        assert!(!wants_tools("open the latest status page"));
        assert!(!wants_tools("find me a good name for the band"));
    }

    fn gmail_tools() -> Vec<super::super::mcp::ToolInfo> {
        super::super::mcp::builtin_tools("gmail")
    }

    #[test]
    fn gmail_plan_reads_recent_mail() {
        let plan = |t: &str| gmail_plan(t, &gmail_tools());
        assert_eq!(plan("Hey Tony, can you read me my last Gmail mail?"), Some(("gmail.recent".into(), json!({ "count": 1 }))));
        assert_eq!(plan("what's my latest email"), Some(("gmail.recent".into(), json!({ "count": 1 }))));
        assert_eq!(plan("read my last three e-mails"), Some(("gmail.recent".into(), json!({ "count": 3 }))));
        assert_eq!(plan("most recent emails please"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("check my inbox"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("Hey Tony, check Gmail").unwrap().0, "gmail.recent");
        assert_eq!(plan("check gmail").unwrap().0, "gmail.recent");
        assert_eq!(plan("check inbox").unwrap().0, "gmail.recent");
        assert_eq!(plan("open the inbox").unwrap().0, "gmail.recent");
        assert_eq!(plan("check email").unwrap().0, "gmail.recent");
        assert_eq!(plan("any new emails?"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("do I have unread mail"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("last 99 emails").unwrap().1["count"], 20);
    }

    #[test]
    fn gmail_plan_searches_by_sender() {
        assert_eq!(gmail_plan("any emails from Sam?", &gmail_tools()), Some(("gmail.search".into(), json!({ "query": "from:Sam", "limit": 5 }))));
        assert_eq!(gmail_plan("show me emails from Maria Lopez about the shoot", &gmail_tools()).unwrap().1["query"], "from:\"Maria Lopez\"");
        assert_eq!(gmail_plan("last email from sam@acme.ca.", &gmail_tools()).unwrap().1["query"], "from:sam@acme.ca");
    }

    #[test]
    fn gmail_plan_needs_email_words_and_the_tool() {
        assert!(gmail_plan("check my last 5 whatsapp messages", &gmail_tools()).is_none());
        assert!(gmail_plan("what's the weather", &gmail_tools()).is_none());
        assert!(gmail_plan("read my last email", &[]).is_none());
        // Without gmail.search, a sender request falls back to recent mail.
        let recent_only: Vec<_> = gmail_tools().into_iter().filter(|t| t.name == "gmail.recent").collect();
        assert_eq!(gmail_plan("any new emails from Sam", &recent_only).unwrap().0, "gmail.recent");
        // Email beats WhatsApp in the combined plan.
        let mut all = gmail_tools();
        all.extend(whatsapp_tool());
        assert_eq!(deterministic_plan("read my last email", &all, "Tony").unwrap().0, "gmail.recent");
        assert_eq!(deterministic_plan("check my whatsapp", &all, "Tony").unwrap().0, "whatsapp.list_messages");
        assert_eq!(deterministic_plan("any unread messages in my WhatsApp inbox?", &all, "Tony").unwrap().0, "whatsapp.list_messages");
        assert_eq!(gmail_plan("any unread emails, not texts", &gmail_tools()).unwrap().0, "gmail.recent");
    }

    #[test]
    fn router_keyword_gate() {
        let n = super::super::routing::normalize;
        assert!(router_keyword_ok("gmail", &n("anything in my E-mail?")));
        assert!(router_keyword_ok("gmail", &n("check the inbox")));
        assert!(!router_keyword_ok("gmail", &n("integrate this into Cloud Code")));
        assert!(router_keyword_ok("whatsapp", &n("what did the group say on what's app")));
        assert!(router_keyword_ok("whatsapp", &n("any new messages")));
        assert!(!router_keyword_ok("whatsapp", &n("what's the weather")));
        assert!(router_keyword_ok("weather", &n("anything")));
    }

    #[test]
    fn router_lines_carry_args_and_an_example() {
        let line = router_tool_line(&gmail_tools()[1]);
        assert!(line.starts_with("- gmail.search(query, limit?): "), "{line}");
        assert!(line.ends_with(r#"e.g. {"args":{"query":"<query>"},"tool":"gmail.search"}"#), "{line}");
    }

    #[test]
    fn failure_note_is_honest() {
        let failure = ("gmail.recent".to_string(), "Gmail: no backend — add it".to_string());
        let note = tool_note("Tony", "", Some(&failure));
        assert!(note.contains("[TOOL FAILURE - gmail.recent]: Gmail: no backend — add it. Tell the user in one sentence exactly what failed and how to fix it; never say you lack the tool or the skill."));
        assert!(!note.contains("live tool access"));
        let ok = tool_note("Tony", "\n\n[LIVE MCP TOOL DATA - gmail]:\n1 email", None);
        assert!(ok.contains("You have live tool access through Tony") && !ok.contains("TOOL FAILURE"));
        assert_eq!(tool_note("Tony", "", None), "");
        assert_eq!(humanize_tool_error("PERMISSION_REQUIRED:mcp"), "the mcp permission is set to Ask and this turn wasn't approved");
        assert_eq!(humanize_tool_error("PERMISSION_READ_ONLY:sqlite — SQLite is set to read-only, so sqlite.write_query is blocked"), "SQLite is set to read-only, so sqlite.write_query is blocked");
    }

    #[test]
    fn tools_section_lists_names_and_never_lacks_skill() {
        let tools: Vec<_> = gmail_tools().into_iter().filter(|t| t.name == "gmail.recent").chain(super::super::mcp::builtin_tools("weather")).collect();
        let s = tools_section(&tools);
        assert!(s.contains("TOOLS YOU HAVE THIS TURN: gmail.recent, weather.current."));
        assert!(s.contains("never that you lack the tool or the skill"));
        assert!(s.contains("don't claim it's done or queued"));
        assert!(!s.contains("SPOTIFY IS CONNECTED"));
        assert!(tools_section(&[]).contains("none switched on"));
    }

    #[test]
    fn tools_section_lists_spotify_controls_with_args() {
        let s = tools_section(&spotify_tools());
        assert!(s.contains("spotify.play(query?, type?, playlist_name?, device_name?, shuffle?)"), "{s}");
        assert!(s.contains("spotify.volume(percent)") && s.contains("spotify.pause") && s.contains("spotify.next(count?)") && s.contains("spotify.resume(device_name?)"), "{s}");
        assert!(s.contains("spotify.add_to_playlist(playlist_name, track_query?, create?)") && s.contains("spotify.transfer_device(device_name)"), "{s}");
        // Reads aren't listed as controls; no IDs anywhere.
        assert!(!s.contains("spotify.now_playing(") && !s.contains("uri") && !s.contains("_id"), "{s}");
        assert!(s.contains("SPOTIFY IS CONNECTED"));
        // Sub-agents (reads only) get no control line.
        let reads = super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), false);
        assert!(!tools_section(&reads).contains("SPOTIFY IS CONNECTED"));
    }

    #[test]
    fn tony_router_prompt_offers_spotify_play_when_ready() {
        // Spotify ready → its listing is every builtin tool; Tony's filter keeps the allowlist.
        let mut ready = super::super::mcp::builtin_tools("spotify");
        ready.extend(gmail_tools());
        let offered_all = super::super::mcp::router_filter(&ready, true);
        for line in ["aye tony can you play some bilmuri", "put on something chill", "skip this song", "turn it up", "volume 30"] {
            assert!(wants_tools(line) || media_command(line, "Tony"), "{line}");
            let offered = router_offer(&offered_all, line, "Tony");
            let prompt = router_prompt(&offered, "", "");
            assert!(prompt.contains("- spotify.play(query?, type?, playlist_name?, device_name?, shuffle?)"), "{line}: {prompt}");
            assert!(prompt.contains("never use them for YouTube"), "{line}");
            assert!(!prompt.contains("gmail.create_draft"), "{line}");
            // No library words: no library edits on offer.
            assert!(!offered.iter().any(|t| super::super::spotify_intent::is_library_write(&t.name)), "{line}");
        }
        // A non-music line doesn't drag Spotify into the router.
        assert!(router_offer(&offered_all, "what's the weather", "Tony").iter().all(|t| t.server != "spotify"));
        // Sub-agents' routers never see playback.
        let sub = super::super::mcp::router_filter(&ready, false);
        assert!(!router_prompt(&router_offer(&sub, "play some jazz", "Tony"), "", "").contains("spotify.play("));
    }

    #[test]
    fn bare_media_verbs_inside_a_sentence_never_unlock_spotify_controls() {
        let offered_all = super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), true);
        for line in ["What role does Redis play in our stack?", "what's NVDA's trading volume", "what was the previous commit", "should I pause the migration"] {
            assert!(!media_command(line, "Tony"), "{line}");
            assert!(!router_offer(&offered_all, line, "Tony").iter().any(|t| super::super::mcp::is_spotify_actuator(&t.name)), "{line}");
        }
        assert!(!wants_tools("what role does redis play in our stack"));
        assert!(!wants_tools("what's NVDA's trading volume"));
        assert!(!wants_tools("should I pause the migration"));
        // Anchored commands and music lines still reach the router.
        assert!(media_command("Hey Tony, pause", "Tony") && media_command("next song", "Tony") && media_command("turn it down", "Tony"));
        assert!(router_offer(&offered_all, "is this song any good", "Tony").iter().any(|t| t.name == "spotify.now_playing"));
    }

    #[test]
    fn spotify_ready_respects_the_mcp_tier() {
        let mut cfg = OsConfig::default();
        let mut s = super::super::os_core::McpServer::default();
        s.id = "spotify".into();
        s.enabled = true;
        cfg.mcps = vec![s];
        cfg.permissions.mcp = super::super::bridge::Tier::Allow;
        assert!(spotify_ready(&cfg, || true));
        assert!(!spotify_ready(&cfg, || false));
        cfg.permissions.mcp = super::super::bridge::Tier::Deny;
        assert!(!spotify_ready(&cfg, || true), "Deny: Tony can't call Spotify, so it isn't ready");
        cfg.permissions.mcp = super::super::bridge::Tier::Allow;
        cfg.privacy.kill_switch = true;
        assert!(!spotify_ready(&cfg, || true));
    }

    #[test]
    fn tool_failure_for_the_model_drops_the_stderr_tail() {
        assert_eq!(without_stderr("SQLite: exited before replying to tools/call (exit code 1) — stderr: --api-key abc"), "SQLite: exited before replying to tools/call (exit code 1)");
        assert_eq!(without_stderr("plain error"), "plain error");
    }

    #[test]
    fn tools_preview_reports_names_only() {
        let all = {
            let mut v = gmail_tools();
            v.extend(super::super::mcp::builtin_tools("spotify"));
            v
        };
        let set = super::super::mcp::ToolSet { offered: super::super::mcp::router_filter(&all, true), all };
        let p = tools_preview(&set, true);
        assert!(p.all.contains(&"gmail.create_draft".to_string()));
        assert!(!p.router_offered.contains(&"gmail.create_draft".to_string()));
        assert!(p.router_offered.contains(&"spotify.play".to_string()));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["spotifyReady"], true);
        assert!(json["routerOffered"].is_array() && json["all"].is_array());
    }

    #[test]
    fn unparsed_play_lines_fail_honestly() {
        assert!(unparsed_play_request("play something", "Tony"));
        assert!(unparsed_play_request("aye tony play it", "Tony"));
        assert!(unparsed_play_request("put on some songs from the new bilmuri album please", "Tony"));
        assert!(!unparsed_play_request("play devil's advocate on my business plan", "Tony"));
        assert!(!unparsed_play_request("I want to play a game with you tonight after dinner", "Tony"));
        assert!(!unparsed_play_request("listen to me carefully", "Tony"));
        assert!(!unparsed_play_request("tell me a joke", "Tony"));
        assert!(!unparsed_play_request("play", "Tony"));
        // A music noun later in the line doesn't make it a playback request.
        assert!(!unparsed_play_request("Listen to me, the band needs a new name", "Tony"));
        assert!(!unparsed_play_request("listen to this album review I wrote and tell me if it's fair", "Tony"));
        assert!(unparsed_play_request("listen to the new album", "Tony"));
        assert!(unparsed_play_request("put on some music", "Tony"));
    }

    #[test]
    fn spotify_prompt_never_promises_playback() {
        let s = tools_section(&spotify_tools());
        assert!(!s.contains("run when the user asks"), "{s}");
        assert!(s.contains("has happened only if a spotify.* LIVE MCP TOOL DATA"), "{s}");
    }

    #[test]
    fn sub_agents_never_get_playback_from_the_deterministic_plan() {
        let reads = super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), false);
        assert!(spotify_plan("skip this song and check the build", &reads, "Tony").is_none());
        assert!(spotify_plan("pause the music", &reads, "Tony").is_none());
        assert!(spotify_plan("play jazz on spotify", &reads, "Tony").is_none());
        assert_eq!(spotify_plan("what's playing", &reads, "Tony").map(|p| p.0).as_deref(), Some("spotify.now_playing"));
    }

    #[test]
    fn json_extracted() {
        assert_eq!(extract_json("sure: {\"tool\": null}").unwrap()["tool"], Value::Null);
    }

    #[test]
    fn bare_json_detection() {
        assert!(looks_like_bare_json(r#"{"tool": "x", "args": {}}"#));
        assert!(looks_like_bare_json("```json\n{\"a\": 1}\n```"));
        assert!(looks_like_bare_json(r#"<tool_call>{"tool": "x"}</tool_call>"#));
        // Prose that merely contains a brace somewhere is not "bare" JSON.
        assert!(!looks_like_bare_json("Sure — here's a plan: {\"tool\": \"x\"} is one option."));
        assert!(!looks_like_bare_json("The weather is 5°C and overcast."));
        assert!(!looks_like_bare_json(""));
    }

    fn whatsapp_tool() -> Vec<super::super::mcp::ToolInfo> {
        vec![super::super::mcp::ToolInfo {
            name: "whatsapp.list_messages".into(),
            description: "List messages".into(),
            server: "whatsapp".into(),
            args: vec!["limit".into(), "include_context".into(), "sender_phone_number".into(), "query".into()],
        }]
    }

    #[test]
    fn whatsapp_plan_extracts_limit_and_defaults() {
        let (name, args) = whatsapp_plan("check my last 5 whatsapp messages", &whatsapp_tool()).unwrap();
        assert_eq!(name, "whatsapp.list_messages");
        assert_eq!(args["limit"], 5);
        assert_eq!(args["include_context"], false);

        // Number word, not digit — exercises routing::normalize's conversion.
        let (_, args) = whatsapp_plan("what are my last five whatsapp texts", &whatsapp_tool()).unwrap();
        assert_eq!(args["limit"], 5);

        // No number at all → default 10.
        let (_, args) = whatsapp_plan("check my whatsapp", &whatsapp_tool()).unwrap();
        assert_eq!(args["limit"], 10);

        // Whisper's "WhatsApp" → "what's up" mangle, caught via routing::normalize.
        let (name, _) = whatsapp_plan("check my what's up messages", &whatsapp_tool()).unwrap();
        assert_eq!(name, "whatsapp.list_messages");

        // Cap at 50 even if a huge number is spoken.
        let (_, args) = whatsapp_plan("last 99 whatsapp messages", &whatsapp_tool()).unwrap();
        assert_eq!(args["limit"], 50);
    }

    #[test]
    fn whatsapp_plan_extracts_sender_name() {
        let (_, args) = whatsapp_plan("messages from Maria Lopez", &whatsapp_tool()).unwrap();
        assert_eq!(args["query"], "Maria Lopez");
    }

    #[test]
    fn whatsapp_plan_absent_without_the_tool() {
        assert!(whatsapp_plan("check my last 5 whatsapp messages", &[]).is_none());
        assert!(whatsapp_plan("tell me a joke", &whatsapp_tool()).is_none());
    }

    fn spotify_tools() -> Vec<super::super::mcp::ToolInfo> {
        // What `turn_tools` hands Tony's planner: the router-visible Spotify tools (reads + media controls).
        super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), true)
    }

    #[test]
    fn spotify_plan_strips_interjections_and_the_wake_name() {
        let plan = |t: &str| spotify_plan(t, &spotify_tools(), "Tony");
        assert_eq!(plan("aye tony can you play some bilmuri"), Some(("spotify.play".into(), json!({ "query": "bilmuri", "prefer_playlist": true }))));
        assert_eq!(plan("Aye, Tony, play Bilmuri on Spotify."), Some(("spotify.play".into(), json!({ "query": "Bilmuri" }))));
        assert_eq!(plan("ayy tony pause the music").map(|p| p.0).as_deref(), Some("spotify.pause"));
        assert_eq!(plan("yo jarvis what's playing").map(|p| p.0).as_deref(), Some("spotify.now_playing"));
        // A renamed OS is stripped too.
        assert_eq!(spotify_plan("hey friday, play some jazz", &spotify_tools(), "Friday").unwrap().1, json!({ "query": "jazz", "prefer_playlist": true }));
        // Negatives: the name as an artist, a credit, non-music, an anchored pause.
        assert_eq!(plan("play tony bennett").unwrap().1, json!({ "query": "tony bennett" }));
        assert_eq!(plan("play something by tony").unwrap().1, json!({ "query": "tony", "type": "artist" }));
        assert!(plan("aye that's a play I'd make").is_none());
        assert!(plan("how do I turn off spotify autoplay").is_none());
        // A renamed OS addressed at the END is dropped too; a credit stays.
        let friday = |t: &str| spotify_plan(t, &spotify_tools(), "Friday");
        assert_eq!(friday("Play Bilmuri on Spotify, Friday.").unwrap().1, json!({ "query": "Bilmuri" }));
        assert_eq!(friday("play something by friday").unwrap().1, json!({ "query": "friday", "type": "artist" }));
        assert_eq!(friday("pause, Friday").map(|p| p.0).as_deref(), Some("spotify.pause"));
    }

    #[test]
    fn spotify_plan_controls_and_reads() {
        let plan = |t: &str| spotify_plan(t, &spotify_tools(), "Tony");
        let tool = |t: &str| plan(t).map(|p| p.0);
        assert_eq!(tool("What's playing?").as_deref(), Some("spotify.now_playing"));
        assert_eq!(tool("hey tony what song is this").as_deref(), Some("spotify.now_playing"));
        assert_eq!(tool("pause the music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("Pause.").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("pause my music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("stop playing music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("turn off Spotify").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("Hey Tony, can you pause the music please").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("Pause the music, Tony.").as_deref(), Some("spotify.pause"));
        assert_ne!(tool("how do I turn off spotify autoplay on my phone").as_deref(), Some("spotify.pause"));
        assert_ne!(tool("remind me at 11 to stop playing my music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("resume spotify").as_deref(), Some("spotify.resume"));
        assert_eq!(tool("skip this song").as_deref(), Some("spotify.next"));
        assert_eq!(tool("next track please").as_deref(), Some("spotify.next"));
        assert_eq!(tool("go back a track").as_deref(), Some("spotify.previous"));
        assert_eq!(tool("previous song").as_deref(), Some("spotify.previous"));
        assert_eq!(tool("what have I been listening to").as_deref(), Some("spotify.recently_played"));
        assert_eq!(tool("show my playlists").as_deref(), Some("spotify.list_playlists"));
        assert_eq!(plan("spotify volume 30"), Some(("spotify.volume".into(), json!({ "percent": 30 }))));
        assert_eq!(plan("volume 40"), Some(("spotify.volume".into(), json!({ "percent": 40 }))));
        assert_eq!(plan("set the volume to 150").unwrap().1["percent"], 100);
        assert_eq!(tool("shuffle on").as_deref(), Some("spotify.shuffle"));
        assert_eq!(tool("skip to 1:30").as_deref(), Some("spotify.seek"));
        assert_eq!(tool("what's in the queue").as_deref(), Some("spotify.get_queue"));
        // Library edits come from the grammar too; the card / gates apply when they run.
        assert_eq!(plan("add this song to my Late Night playlist"), Some(("spotify.add_to_playlist".into(), json!({ "playlist_name": "Late Night", "track_query": "current", "create": false }))));
        assert_eq!(tool("like this song").as_deref(), Some("spotify.like_track"));
        // "reconnect Spotify": a fixed reply on the Rust path, no tool.
        assert_eq!(plan("reconnect spotify"), Some((super::super::spotify_intent::RECONNECT.into(), json!({}))));
        // Tony's speech and the mic stay Tony's.
        for line in ["stop", "repeat that", "unmute", "I like this", "what's next"] {
            assert!(plan(line).is_none(), "{line}");
        }
    }

    #[test]
    fn spotify_plan_play_requests() {
        let plan = |t: &str| spotify_plan(t, &spotify_tools(), "Tony");
        assert_eq!(plan("play Woke Up This Morning on Spotify"), Some(("spotify.play".into(), json!({ "query": "Woke Up This Morning" }))));
        // "X by Y" stays whole: the resolver splits it (and falls back to the whole query).
        assert_eq!(plan("Hey Tony, play One More Time by Daft Punk").unwrap().1, json!({ "query": "One More Time by Daft Punk" }));
        assert_eq!(plan("can you play some jazz").unwrap().1, json!({ "query": "jazz", "prefer_playlist": true }));
        assert_eq!(plan("play the album Discovery").unwrap().1, json!({ "query": "Discovery", "type": "album" }));
        assert_eq!(plan("play my Gym playlist on spotify").unwrap().1, json!({ "playlist_name": "Gym" }));
        assert_eq!(plan("play songs by Frank Sinatra").unwrap().1, json!({ "query": "Frank Sinatra", "type": "artist" }));
        assert_eq!(plan("play music").unwrap().0, "spotify.resume");
        assert_eq!(plan("Play Daft Punk on Spotify, Tony.").unwrap().1["query"], "Daft Punk");
        assert_eq!(plan("play Bilmuri on my phone").unwrap().1, json!({ "query": "Bilmuri", "device_name": "my phone" }));
        // Not music requests.
        assert!(plan("play devil's advocate on my business plan").is_none());
        assert!(plan("can you explain how the playoffs work").is_none());
        assert!(plan("I want to play a game with you tonight after dinner").is_none());
        assert!(plan("play it cool with the client").is_none());
        assert!(plan("tell me a joke").is_none());
    }

    #[test]
    fn spotify_plan_needs_the_server() {
        assert!(spotify_plan("pause the music", &[], "Tony").is_none());
        assert!(spotify_plan("play jazz on spotify", &[], "Tony").is_none());
        let mut all = gmail_tools();
        all.extend(spotify_tools());
        assert_eq!(deterministic_plan("read my last email", &all, "Tony").unwrap().0, "gmail.recent");
        assert_eq!(deterministic_plan("what's playing", &all, "Tony").unwrap().0, "spotify.now_playing");
        assert!(wants_tools("what's playing on spotify"));
        assert!(router_keyword_ok("spotify", &super::super::routing::normalize("put on some music")));
        assert!(!router_keyword_ok("spotify", &super::super::routing::normalize("what's the weather")));
    }

    #[test]
    fn router_offers_library_writes_only_with_library_words() {
        let offered_all = spotify_tools();
        let names = |line: &str| router_offer(&offered_all, line, "Tony").into_iter().map(|t| t.name.clone()).collect::<Vec<_>>();
        let lib = names("remove this from my late night playlist");
        assert!(lib.contains(&"spotify.remove_from_playlist".to_string()) && lib.contains(&"spotify.add_to_playlist".to_string()), "{lib:?}");
        let liked = names("put this song in my liked songs");
        assert!(liked.contains(&"spotify.like_track".to_string()), "{liked:?}");
        let skip = names("skip this");
        assert!(skip.contains(&"spotify.next".to_string()), "{skip:?}");
        assert!(!skip.iter().any(|n| super::super::spotify_intent::is_library_write(n)), "{skip:?}");
        assert!(!names("turn it up").iter().any(|n| super::super::spotify_intent::is_library_write(n)));
    }

    #[test]
    fn ask_cards_return_the_pending_call() {
        let args = json!({ "playlist_name": "Late Night", "track_query": "Tell Me" });
        assert_eq!(pending_from("PERMISSION_REQUIRED:mcp", "spotify.remove_from_playlist", &args, false), None, "no askCards: today's failure note");
        let p = pending_from("PERMISSION_REQUIRED:mcp", "spotify.remove_from_playlist", &args, true).expect("pending");
        assert_eq!(p.name, "spotify.remove_from_playlist");
        assert_eq!(p.args, json!({ "playlist_name": "Late Night", "track_query": "Tell Me" }));
        assert_eq!(p.summary, "Remove Tell Me from your Late Night playlist");
        assert_eq!(p.required, "PERMISSION_REQUIRED:mcp");
        let d = pending_from("PERMISSION_REQUIRED:destructive", "spotify.unlike_track", &json!({}), true).unwrap();
        assert_eq!((d.required.as_str(), d.args.clone()), ("PERMISSION_REQUIRED:destructive", json!({ "track_query": "current" })));
        // Reads never pend, other errors never pend, other servers never pend.
        assert_eq!(pending_from("PERMISSION_REQUIRED:mcp", "spotify.now_playing", &json!({}), true), None);
        assert_eq!(pending_from("PERMISSION_DENIED:mcp", "spotify.play", &json!({ "query": "x" }), true), None);
        assert_eq!(pending_from("PERMISSION_REQUIRED:mcp", "gmail.create_draft", &json!({}), true), None);
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("required").is_some() && json.get("summary").is_some() && json.get("name").is_some());
    }

    #[test]
    fn spotify_write_reply_is_verbatim() {
        assert_eq!(verbatim_answer(PlanSource::Deterministic, false, "Now playing X."), Some("Now playing X.".into()));
        assert_eq!(verbatim_answer(PlanSource::Deterministic, true, "Paused Spotify."), Some("Paused Spotify.".into()));
        assert_eq!(verbatim_answer(PlanSource::Router, true, "Playing Bilmuri on Spotify."), Some("Playing Bilmuri on Spotify.".into()));
        assert_eq!(verbatim_answer(PlanSource::Router, false, "Now playing X."), None, "router reads are synthesised");
        // Through Prefetch: a write result pins the answer; a held write pins the card.
        let mut p = Prefetch { ask_cards: true, ..Prefetch::default() };
        p.spotify_outcome("spotify.pause", &json!({}), Some("Paused Spotify."), PlanSource::Router);
        assert_eq!(p.verbatim.as_deref(), Some("Paused Spotify."));
        let mut p = Prefetch { ask_cards: true, last_error: Some("PERMISSION_REQUIRED:mcp".into()), failure: Some(("spotify.pause".into(), "x".into())), ..Prefetch::default() };
        p.spotify_outcome("spotify.pause", &json!({}), None, PlanSource::Deterministic);
        assert_eq!(p.pending_spotify.as_ref().map(|c| c.summary.as_str()), Some("Pause Spotify"));
        assert!(p.failure.is_none(), "the card replaces the failure note");
        // Non-Spotify tools are untouched.
        let mut p = Prefetch::default();
        p.spotify_outcome("weather.current", &json!({}), Some("5°C"), PlanSource::Deterministic);
        assert!(p.verbatim.is_none());
    }

    #[test]
    fn reconnect_on_the_rust_path_is_a_fixed_reply() {
        let plan = spotify_plan("hey tony reconnect spotify", &spotify_tools(), "Tony").unwrap();
        assert_eq!(plan.0, super::super::spotify_intent::RECONNECT);
        assert!(!super::super::mcp::builtin_tools("spotify").iter().any(|t| t.name == plan.0), "never an MCP tool");
        let s = super::super::spotify::RUST_RECONNECT;
        assert_eq!(s, "To sign in to Spotify again, open Settings → Integrations on the PC and press Reconnect.");
    }

    #[test]
    fn time_plan_matches_only_with_the_tool() {
        let time_tool = vec![super::super::mcp::ToolInfo { name: "time.now".into(), description: "x".into(), server: "time".into(), args: vec![] }];
        assert!(time_plan("what time is it", &time_tool).is_some());
        assert!(time_plan("what time is it", &[]).is_none());
        assert!(time_plan("tell me a joke", &time_tool).is_none());
    }
}

/// Live smoke test against the real local services. Opt-in:
/// `cargo test --lib live_os_turn -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_os_turn() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let bridge = BridgeState::default();
            let cfg = os.snapshot();

            // 1. Workspaces
            match allm_key(&state, false) {
                Ok(key) => {
                    let v = allm(&state, &cfg.anythingllm.base_url, &key, reqwest::Method::GET, "/v1/workspaces", None, 8).await;
                    let slugs: Vec<String> = v.map(|v| v["workspaces"].as_array().into_iter().flatten().filter_map(|w| w["slug"].as_str().map(String::from)).collect()).unwrap_or_default();
                    println!("WORKSPACES: {slugs:?}");
                    if let Some(slug) = ["booking", "librarian"].iter().filter_map(|r| cfg.anythingllm.workspaces.get(*r)).find(|s| slugs.contains(s)) {
                        let t0 = Instant::now();
                        let r = workspace_chat(&state, &os, slug, "[Tony → Booking agent] Retrieve and summarize the last 5 incoming booking messages.").await;
                        println!("BOOKING ({}ms): {}", t0.elapsed().as_millis(), r.map(|x| x.0.chars().take(300).collect::<String>()).unwrap_or_else(|e| format!("ERR {e}")));
                    }
                }
                Err(e) => println!("ANYTHINGLLM KEY: {e}"),
            }

            // 2. Weather tool
            println!("TOOL weather: {:?}", super::super::mcp::call_tool(&state, &os, &bridge, "weather.current", &json!({}), false, "tony").await.map(|s| s.lines().next().unwrap_or("").to_string()));

            // 3. Answer from live context (no refusal)
            let sys = system_prompt(&cfg, "Weather (Toronto): 5°C Overcast, wind 11 km/h", &[]);
            let t0 = Instant::now();
            let r = run_chat(&state, &os, vec![ChatMessage::new("system", sys), ChatMessage::new("user", "What's the weather like right now?")], Priority::Interactive, None, Some(90)).await;
            println!("CHAT ({}ms): {:?}", t0.elapsed().as_millis(), r.map(|x| format!("[{}] ({}) {}", x.provider_id, x.reason, x.content.chars().take(300).collect::<String>())));
        });
    }

    /// What Tony's next turn really gets, from the live os.json + keychain presence.
    /// Names only; makes no Spotify API call and runs no tool.
    /// `cargo test --lib live_tony_tools_payload -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_tony_tools_payload() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let cfg = os.snapshot();
            let set = turn_tools(&state, &os, &cfg, "general").await;
            let ready = spotify_ready(&cfg, || super::super::spotify::readiness(&state).is_ok());
            let spotify = |v: &[super::super::mcp::ToolInfo]| v.iter().filter(|t| t.server == "spotify").map(|t| t.name.clone()).collect::<Vec<_>>();
            println!("SPOTIFY READY: {ready}");
            println!("ALL ({}), spotify: {:?}", set.all.len(), spotify(&set.all));
            println!("ROUTER OFFERED ({}), spotify: {:?}", set.offered.len(), spotify(&set.offered));
            let line = "aye tony can you play some bilmuri";
            println!("DETERMINISTIC PLAN for {line:?}: {:?}", deterministic_plan(line, &set.offered, &cfg.os_name));
            let offer = router_offer(&set.offered, line, &cfg.os_name);
            println!("ROUTER OFFER for {line:?}: {:?}", offer.iter().map(|t| t.name.as_str()).collect::<Vec<_>>());
            let sys = system_prompt(&cfg, "", &set.offered);
            println!("SYSTEM PROMPT lists spotify.play: {}", sys.contains("spotify.play"));
            assert!(ready, "Spotify is not ready (disconnected, off, kill switch or MCP Deny)");
            assert!(set.offered.iter().any(|t| t.name == "spotify.play"), "spotify.play missing from Tony's router tools");
        });
    }
}

/// One-off: create the sub-agent workspaces Tony delegates to, if missing.
/// `cargo test --lib live_create_workspaces -- --ignored --nocapture`
#[cfg(test)]
mod live_setup {
    use super::*;

    #[test]
    #[ignore]
    fn live_create_workspaces() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let base = "http://127.0.0.1:3001";
            let key = allm_key(&state, false).expect("AnythingLLM key");
            let v = allm(&state, base, &key, reqwest::Method::GET, "/v1/workspaces", None, 8).await.unwrap();
            let have: Vec<String> = v["workspaces"].as_array().into_iter().flatten().filter_map(|w| w["slug"].as_str().map(String::from)).collect();
            let want = [
                ("booking", "Booking", "You are the Booking agent of Tony, the user's personal AI operating system. You handle the user's bookings: auditions, gigs, shoots, client jobs, appointments and reservations. Answer from the documents and messages in this workspace: who, what, when, where, rate and status. Quote dates, times and names exactly; if something isn't in your data, say so plainly. Never confirm, send or book anything yourself — propose it and Tony will ask the user."),
                ("ops", "Ops", "You are the Ops agent of Tony, the user's personal AI operating system. You cover infrastructure: Docker, n8n workflows, the droplet over NetBird, GPU/VRAM, services and backups. Report status as short telemetry lines, flag anything degraded first, and give exact commands for fixes. Never run or change anything yourself."),
                ("designer", "Designer", "You are the Designer agent of Tony, the user's personal AI operating system — a senior UI/UX designer. Never give generic advice. Always answer with concrete, buildable specs: (1) design tokens as JSON (color, type scale, spacing, radius, shadow, motion), (2) a component hierarchy, (3) a layout wireframe in ASCII or bullet form per breakpoint, and when asked for a prototype (4) ONE self-contained HTML file using Tailwind via CDN (and React via ESM CDN only if needed) inside a ```html fenced block. Dark, cinematic, glass aesthetic unless told otherwise; accessible contrast; purposeful motion."),
            ];
            for (slug, name, prompt) in want {
                if have.iter().any(|h| h == slug) {
                    println!("EXISTS {slug}");
                    continue;
                }
                let r = allm(&state, base, &key, reqwest::Method::POST, "/v1/workspace/new", Some(json!({ "name": name, "openAiPrompt": prompt, "openAiTemp": 0.4, "openAiHistory": 20, "chatMode": "chat" })), 20).await;
                match r {
                    Ok(v) => println!("CREATED {} -> slug {}", name, v["workspace"]["slug"].as_str().unwrap_or("?")),
                    Err(e) => println!("FAILED {slug}: {e}"),
                }
            }
        });
    }
}

/// `cargo test --lib live_droplet -- --ignored --nocapture` — the app's own path to the droplet.
#[cfg(test)]
mod live_droplet {
    use super::*;

    #[test]
    #[ignore]
    fn live_droplet() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let cfg = os.snapshot();
            let sys = system_prompt(&cfg, "Weather (Toronto): 5°C Overcast, wind 11 km/h", &[]);
            let t0 = Instant::now();
            let r = run_chat(&state, &os, vec![ChatMessage::new("system", sys), ChatMessage::new("user", "Quick check — what's the weather, and email sam@acme.ca says what?")], Priority::Interactive, Some("droplet".into()), Some(120)).await;
            match r {
                Ok(x) => println!("DROPLET ({}ms, redacted={}): [{}] {}", t0.elapsed().as_millis(), x.redacted, x.provider_id, x.content.chars().take(300).collect::<String>()),
                Err(e) => println!("DROPLET ERR: {e}"),
            }
            let rec = os.last_redaction.lock().unwrap().clone();
            if let Some(rec) = rec {
                println!("LEFT THE MACHINE (user msg): {}", rec.payload[1]["content"].as_str().unwrap_or("").chars().take(120).collect::<String>());
            }
        });
    }
}

/// AnythingLLM model settings. Read: `cargo test --lib live_allm_llm -- --ignored --nocapture`.
/// Write: same with ALLM_SET=1 (points AnythingLLM's LLM at Bionic/LM Studio on :1235).
#[cfg(test)]
mod live_allm_llm {
    use super::*;

    #[test]
    #[ignore]
    fn live_allm_llm() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let key = allm_key(&state, false).unwrap();
            let base = "http://127.0.0.1:3001";
            if std::env::var("ALLM_SET").is_ok() {
                let r = allm(&state, base, &key, reqwest::Method::POST, "/v1/system/update-env", Some(json!({
                    "LLMProvider": "lmstudio",
                    "LMStudioBasePath": "http://127.0.0.1:1235/v1",
                    "LMStudioModelPref": "qwen/qwen3.5-9b",
                    "LMStudioTokenLimit": 32768
                })), 20).await;
                println!("UPDATE: {r:?}");
                // Coder ran qwen2.5-coder-14b — a second big model that can't share 12 GB with the 9B.
                let r = allm(&state, base, &key, reqwest::Method::POST, "/v1/workspace/coder/update", Some(json!({ "chatProvider": "lmstudio", "chatModel": "qwen/qwen3.5-9b" })), 20).await;
                println!("CODER: {:?}", r.map(|v| v["workspace"]["chatModel"].clone()));
            }
            let v = allm(&state, base, &key, reqwest::Method::GET, "/v1/system", None, 10).await.unwrap();
            let s = &v["settings"];
            for k in ["LLMProvider", "LMStudioBasePath", "LMStudioModelPref", "LMStudioTokenLimit", "AnythingLLMOllamaModelPref", "EmbeddingEngine", "EmbeddingModelPref"] {
                println!("SETTING {k} = {}", s[k]);
            }
            let w = allm(&state, base, &key, reqwest::Method::GET, "/v1/workspaces", None, 10).await.unwrap();
            for ws in w["workspaces"].as_array().into_iter().flatten() {
                println!("WS {} provider={} model={}", ws["slug"], ws["chatProvider"], ws["chatModel"]);
            }
        });
    }
}

/// `cargo test --lib live_no_think -- --ignored --nocapture` — add Qwen3's /no_think switch
/// to every AnythingLLM workspace prompt (sub-agents then answer without a thinking pass).
#[cfg(test)]
mod live_no_think {
    use super::*;

    #[test]
    #[ignore]
    fn live_no_think() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let key = allm_key(&state, false).unwrap();
            let base = "http://127.0.0.1:3001";
            const DEFAULT: &str = "Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed.";
            let v = allm(&state, base, &key, reqwest::Method::GET, "/v1/workspaces", None, 10).await.unwrap();
            for w in v["workspaces"].as_array().unwrap() {
                let slug = w["slug"].as_str().unwrap_or("");
                let prompt = w["openAiPrompt"].as_str().filter(|p| !p.trim().is_empty()).unwrap_or(DEFAULT).to_string();
                if prompt.contains("/no_think") {
                    println!("NOTHINK {slug}: already set");
                    continue;
                }
                let r = allm(&state, base, &key, reqwest::Method::POST, &format!("/v1/workspace/{slug}/update"), Some(json!({ "openAiPrompt": format!("{prompt}\n/no_think") })), 20).await;
                println!("NOTHINK {slug}: {}", if r.is_ok() { "added" } else { "FAILED" });
            }
        });
    }
}
