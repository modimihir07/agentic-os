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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    slug: String,
    name: String,
    threads: usize,
}

#[tauri::command]
pub async fn anythingllm_workspaces(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<Vec<WorkspaceInfo>, String> {
    let cfg = os.snapshot();
    let key = allm_key(&state, false)?;
    let v = allm(&state, &cfg.anythingllm.base_url, &key, reqwest::Method::GET, "/v1/workspaces", None, 8).await?;
    Ok(v["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| WorkspaceInfo {
            slug: w["slug"].as_str().unwrap_or("").into(),
            name: w["name"].as_str().unwrap_or("").into(),
            threads: w["threads"].as_array().map(|t| t.len()).unwrap_or(0),
        })
        .collect())
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

fn role_label(role: &str) -> String {
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

pub fn system_prompt(cfg: &OsConfig, context: &str) -> String {
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
    s.push_str("\n\nStyle: warm, direct, concise — 1 to 4 sentences unless the user asks for detail. Spoken aloud, so no markdown tables.");
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

/// Widened per Part 2: also catches "what's up" (Whisper's mangle of
/// "WhatsApp"), plural messages/texts/chats, inbox, "files", and "latest" —
/// the exact gaps the MCP map found causing false WhatsApp/email refusals.
fn wants_tools(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(weather|forecast|temperature|rain|snow|wind|time|date|today|tomorrow|fetch|url|https?://|website|web ?page|page|files?|folder|read|open|list|repo|git|commit|branch|search|look ?up|google|find|news|knowledge|remember|who is|emails?|inbox|gmail|what'?s ?app|whatsapp|messages?|texts?|chats?|what'?s ?up|dm|group|skill|status|latest)\b").unwrap()
    })
    .is_match(text)
}

// ── Tool pre-executor (Part 2) ──────────────────────────────────────────────
//
// Runs BEFORE a sub-agent sees its task (and for Tony's own turns), using
// only the tools the target agent is actually granted (`mcp::enabled_tools`).
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

fn deterministic_plan(text: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    whatsapp_plan(text, tools).or_else(|| time_plan(text, tools))
}

/// Run the existing JSON tool router, restricted to `tools`, for up to two
/// sequential calls (so a second lookup can build on the first), capped by
/// `deadline`. Each call gets its own short timeout so a dead server can't
/// stall the turn — the caller already bounds the whole thing to ~20s.
async fn run_tool_router(
    state: &DispatchState,
    os: &OsState,
    bridge: &BridgeState,
    tools: &[super::mcp::ToolInfo],
    context: &str,
    text: &str,
    approved: bool,
    agent: &str,
    deadline: Instant,
) -> (String, Vec<OsStep>, Option<String>) {
    let mut block = String::new();
    let mut steps = Vec::new();
    let mut last = None;
    let mut extra = String::new();
    for _ in 0..2 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let list: Vec<String> = tools.iter().map(|t| format!("- {}({}): {}", t.name, t.args.join(", "), t.description)).collect();
        let router = format!(
            "You route a request to at most ONE tool. Tools:\n{}\n\nLIVE DASHBOARD:\n{}{extra}\n\nReply ONLY with JSON: {{\"tool\": \"<tool name>\" or null, \"args\": {{…}}}}. \
Use null if the dashboard/previous tool result already answers it or no tool helps.",
            list.join("\n"),
            context.chars().take(1500).collect::<String>()
        );
        let router_secs = left.as_secs().clamp(1, 15);
        let Ok(r) = run_chat(state, os, vec![ChatMessage::new("system", router), ChatMessage::new("user", text.to_string())], Priority::Interactive, None, Some(router_secs)).await else { break };
        // A router reply that isn't usable JSON, or names a tool it wasn't
        // offered, used to be silent (no step, turn just continued without a
        // tool). Now it's a visible (non-error) step, then synthesis proceeds
        // exactly as before — Part 6 §3's "push a non-error step and continue".
        let Some(j) = extract_json(&r.content) else {
            steps.push(step("tool", "os", "router", "no tool (router reply not JSON)", true, 0));
            break;
        };
        if j["tool"].is_null() {
            break; // router decided no tool is needed — expected, not a failure
        }
        let Some(name) = j["tool"].as_str().filter(|n| tools.iter().any(|t| t.name == *n)).map(String::from) else {
            steps.push(step("tool", "os", "router", format!("no tool (router named an unmatched tool: {})", j["tool"]), true, 0));
            break;
        };
        let args = if j["args"].is_object() { j["args"].clone() } else { json!({}) };
        let t0 = Instant::now();
        let call_secs = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(10));
        if call_secs.is_zero() {
            steps.push(step("tool", "os", &name, format!("{name} skipped — out of time"), false, 0));
            break;
        }
        match tokio::time::timeout(call_secs, super::mcp::call_tool(state, os, bridge, &name, &args, approved, agent)).await {
            Ok(Ok(out)) => {
                steps.push(step("tool", "os", &name, format!("{args}\n→ {}", out.chars().take(600).collect::<String>()), true, t0.elapsed().as_millis()));
                let server = name.split('.').next().unwrap_or(&name);
                block.push_str(&format!("\n\n[LIVE MCP TOOL DATA - {server}]:\n{}", out.chars().take(2000).collect::<String>()));
                extra = format!("\n\nTool {name} already returned:\n{}", out.chars().take(500).collect::<String>());
                last = Some(name);
            }
            Ok(Err(e)) if e.starts_with("PERMISSION_") => {
                steps.push(step("tool", "os", &name, format!("blocked: {e}"), false, t0.elapsed().as_millis()));
                break;
            }
            Ok(Err(e)) => {
                steps.push(step("tool", "os", &name, format!("failed: {e}"), false, t0.elapsed().as_millis()));
                break;
            }
            Err(_) => {
                steps.push(step("tool", "os", &name, format!("{name} timed out"), false, t0.elapsed().as_millis()));
                break;
            }
        }
    }
    (block, steps, last)
}

/// Fetch live tool data for `agent`'s upcoming turn (its own granted tools;
/// Tony's own turns pass `"general"`, which `enabled_tools` always gives
/// every enabled server). Tries a deterministic plan first (instant, no LLM
/// call), then — if the text still plausibly wants a tool — the JSON router,
/// restricted to that agent's tools. Mutating tools are never offered
/// (`mcp::is_mutating_tool`, enforced inside `mcp::enabled_tools`). The whole
/// thing is capped at ~20s so one dead server can't stall the turn.
async fn prefetch_tools(state: &DispatchState, os: &OsState, bridge: &BridgeState, cfg: &OsConfig, agent: &str, text: &str, context: &str, approved: bool) -> (String, Vec<OsStep>, Option<String>) {
    if cfg.permissions.mcp == super::bridge::Tier::Deny {
        return (String::new(), Vec::new(), None);
    }
    let tools = super::mcp::enabled_tools(state, os, agent).await;
    if tools.is_empty() {
        return (String::new(), Vec::new(), None);
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    if let Some((name, args)) = deterministic_plan(text, &tools) {
        let t0 = Instant::now();
        let call_secs = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(12));
        return match tokio::time::timeout(call_secs, super::mcp::call_tool(state, os, bridge, &name, &args, approved, agent)).await {
            Ok(Ok(out)) => {
                let step = step("tool", "os", &name, format!("{args}\n→ {}", out.chars().take(600).collect::<String>()), true, t0.elapsed().as_millis());
                let server = name.split('.').next().unwrap_or(&name);
                (format!("\n\n[LIVE MCP TOOL DATA - {server}]:\n{}", out.chars().take(2000).collect::<String>()), vec![step], Some(name))
            }
            Ok(Err(e)) => (String::new(), vec![step("tool", "os", &name, format!("failed: {e}"), false, t0.elapsed().as_millis())], None),
            Err(_) => (String::new(), vec![step("tool", "os", &name, format!("{name} timed out"), false, t0.elapsed().as_millis())], None),
        };
    }
    if wants_tools(text) {
        return run_tool_router(state, os, bridge, &tools, context, text, approved, agent, deadline).await;
    }
    (String::new(), Vec::new(), None)
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
}

pub(crate) fn step(kind: &str, from: &str, to: &str, text: impl Into<String>, ok: bool, ms: u128) -> OsStep {
    OsStep { kind: kind.into(), from: from.into(), to: to.into(), text: text.into(), ok, ms }
}

#[tauri::command]
pub async fn os_turn(app: tauri::AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: OsTurnRequest) -> Result<OsTurnResult, String> {
    run_os_turn(&state, &os, &bridge, req, Some(&app)).await
}

pub async fn run_os_turn(state: &DispatchState, os: &OsState, bridge: &BridgeState, req: OsTurnRequest, app: Option<&tauri::AppHandle>) -> Result<OsTurnResult, String> {
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
    }
    let keep = cfg.scheduler.history_turns.max(2) as usize;
    let history: Vec<ChatMessage> = req.history.into_iter().rev().take(keep).collect::<Vec<_>>().into_iter().rev().collect();

    // ── Tool pre-executor (Part 2) — runs BEFORE delegation, using only the
    // target agent's own granted tools, and regardless of whether a
    // sub-agent later answers (that gate used to skip tools entirely). ──
    let prefetch_agent = if role == "general" { "general" } else { role.as_str() };
    let (tool_raw, tool_steps, tool_used) = if comms_thread.is_none() {
        prefetch_tools(state, os, bridge, &cfg, prefetch_agent, &text, &req.context, req.approved).await
    } else {
        (String::new(), Vec::new(), None)
    };
    steps.extend(tool_steps);
    let tool_note = if tool_raw.is_empty() {
        String::new()
    } else {
        format!(
            "{tool_raw}\n\nYou have live tool access through {}. The data above was fetched just now; answer from it directly. Never say you lack access to WhatsApp, email, files or the internet.",
            cfg.os_name
        )
    };

    // ── 2. Delegation ──
    let slug = cfg.anythingllm.workspaces.get(&role).filter(|s| !s.is_empty()).cloned();
    if role != "general" && comms_thread.is_none() {
        if let Some(slug) = slug {
            os_core::gate(bridge, cfg.permissions.delegation, "delegation", req.approved, json!({ "workspace": slug }))?;
            let label = role_label(&role);
            let skills = super::mcp::skill_digest(&cfg, &role);
            // Designer / Prompter also get the user's identity file (taste, brand, goals).
            let identity = if matches!(role.as_str(), "designer" | "prompter") {
                os_core::read_identity(&cfg).map(|i| format!("\n\nABOUT THE USER (MASTER_IDENTITY.md):\n{}", i.chars().take(2000).collect::<String>())).unwrap_or_default()
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
            match chat_result {
                Ok((answer, sources)) => {
                    let src = if sources.is_empty() { String::new() } else { format!("\n\nSources: {}", sources.join(", ")) };
                    steps.push(step("reply", &role, "os", format!("{answer}{src}"), true, t0.elapsed().as_millis()));
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
        };
        log_turn(bridge, &role, &text, &res);
        return Ok(res);
    }

    // ── 1 + 3. OS context + synthesis ──
    // The tool data for a delegated (non-general) turn already rode along in
    // the task above; Tony's own turns (role == "general") get it here, in
    // his own system prompt, since there was no delegated task to carry it.
    let sys = system_prompt(&cfg, &req.context);
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

    let answer = match (app, req.stream_id.as_deref()) {
        (Some(app), Some(sid)) => super::dispatch::run_chat_streamed(state, os, msgs.clone(), Some(90), app, sid).await,
        _ => run_chat(state, os, msgs.clone(), Priority::Interactive, None, Some(90)).await,
    };
    let res = match answer {
        Ok(r) => r,
        Err(e) if cfg.overseer.auto_escalate => {
            steps.push(step("error", "os", "user", format!("local chain failed: {e}"), false, 0));
            let t0 = Instant::now();
            let (answer, engine, redacted) = overseer_call(state, os, &cfg, &msgs).await?;
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
    let key = os_core::os_secret("anthropic").ok_or("add an Anthropic API key in Settings → Integrations → Overseer")?;
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
    let key = os_core::os_secret("gemini").ok_or("add a Gemini API key in Settings → Integrations → Overseer")?;
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
            let sys = system_prompt(&cfg, "Weather (Toronto): 5°C Overcast, wind 11 km/h");
            let t0 = Instant::now();
            let r = run_chat(&state, &os, vec![ChatMessage::new("system", sys), ChatMessage::new("user", "What's the weather like right now?")], Priority::Interactive, None, Some(90)).await;
            println!("CHAT ({}ms): {:?}", t0.elapsed().as_millis(), r.map(|x| format!("[{}] ({}) {}", x.provider_id, x.reason, x.content.chars().take(300).collect::<String>())));
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
            let sys = system_prompt(&cfg, "Weather (Toronto): 5°C Overcast, wind 11 km/h");
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
