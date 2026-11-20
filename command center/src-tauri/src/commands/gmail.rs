//! Gmail through the user's Google Apps Script web app — the same deployment
//! AnythingLLM's Gmail agent uses: `POST https://script.google.com/macros/s/{id}/exec`
//! with `{key, action, ...args}` → `{status, data}`.
//!
//! The deployment ID and key come from `GMAIL_SCRIPT_ID` + `GMAIL_SCRIPT_KEY` (environment
//! or repo-root `.env`, both required), else the OS keychain pair (`gmail-script-id`,
//! `gmail-script-key`); they never reach the webview, logs or error strings.
//! A read-only n8n workflow (`gmail-recent` or `gmail-digest`) is the fallback
//! for `gmail.recent` when no deployment is configured.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

use super::bridge::BridgeState;
use super::dispatch::{short, DispatchState};
use super::os_core::{self, OsState};

const SECRET_ID: &str = "gmail-script-id";
const SECRET_KEY: &str = "gmail-script-key";
const N8N_WORKFLOWS: [&str; 2] = ["gmail-recent", "gmail-digest"];
pub(crate) const NO_BACKEND: &str = "Gmail: no backend — add the Apps Script deployment in Settings → Integrations, or import it from AnythingLLM";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Source {
    Script,
    N8n(&'static str),
    None,
}

/// The Apps Script deployment ID + key, in priority order: `GMAIL_SCRIPT_ID` /
/// `GMAIL_SCRIPT_KEY` from the environment or repo-root `.env` (the direct credential),
/// then the keychain pair (Settings, or the AnythingLLM import). `source()` falls back to
/// an n8n workflow after that. Read on every call, so a change takes effect without a restart.
fn creds(state: &DispatchState) -> Option<(String, String)> {
    env_pair(state).or_else(|| Some((os_core::os_secret(SECRET_ID)?, os_core::os_secret(SECRET_KEY)?)))
}

/// `GMAIL_SCRIPT_ID` + `GMAIL_SCRIPT_KEY` from the environment / repo-root `.env`, only
/// when BOTH are set (half a pair is never mixed with a keychain half). The Settings badges
/// (`envfile::os_secret_sources`) apply the same rule.
pub(crate) fn env_pair(state: &DispatchState) -> Option<(String, String)> {
    let env = |k| super::envfile::env_or_file(state, k);
    Some((env("GMAIL_SCRIPT_ID")?, env("GMAIL_SCRIPT_KEY")?))
}

/// Where the Gmail backend comes from, for the System Map: `"env"` (.env / environment),
/// `"keychain"`, `"n8n:<workflow>"` or `"none"`. Names only, never the values.
pub(crate) fn source_label(state: &DispatchState) -> String {
    if env_pair(state).is_some() {
        return "env".into();
    }
    match source(state) {
        Source::Script => "keychain".into(),
        Source::N8n(wf) => format!("n8n:{wf}"),
        Source::None => "none".into(),
    }
}

/// AnythingLLM Desktop's SQLite database (`%APPDATA%nythingllm-desktop\storagenythingllm.db`).
pub(crate) fn anythingllm_db_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("anythingllm-desktop").join("storage").join("anythingllm.db"))
}

pub(crate) fn source(state: &DispatchState) -> Source {
    if creds(state).is_some() {
        return Source::Script;
    }
    let wfs = state.snapshot().n8n_workflows;
    N8N_WORKFLOWS.iter().find(|n| wfs.contains_key(**n)).map_or(Source::None, |n| Source::N8n(n))
}

fn valid_deployment_id(id: &str) -> bool {
    (10..=200).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The Apps Script reply → its `data`, or a fix-it message (never echoing credentials).
fn parse_script_reply(status: u16, body: &str) -> Result<Value, String> {
    if !(200..300).contains(&status) {
        return Err(match status {
            404 => "Gmail Apps Script deployment not found (HTTP 404) — check the deployment ID in Settings → Integrations".into(),
            401 | 403 => format!("Gmail Apps Script refused access (HTTP {status}) — deploy it as a Web app with access \"Anyone\""),
            _ => format!("Gmail Apps Script failed (HTTP {status})"),
        });
    }
    let v: Value = serde_json::from_str(body).map_err(|_| "Gmail Apps Script didn't return JSON — deploy it as a Web app with access \"Anyone\" and use that deployment ID".to_string())?;
    if v["status"] == "error" {
        let e = v["error"].as_str().unwrap_or("unknown error");
        return Err(format!("Gmail Apps Script error: {}", e.chars().take(300).collect::<String>()));
    }
    Ok(v["data"].clone())
}

async fn script(state: &DispatchState, action: &str, args: Value, secs: u64) -> Result<Value, String> {
    let Some((id, key)) = creds(state) else {
        return Err(NO_BACKEND.into());
    };
    let id = id.trim().to_string();
    if !valid_deployment_id(&id) {
        return Err("the saved Gmail Apps Script deployment ID is malformed — paste it again in Settings → Integrations".into());
    }
    let mut body = args.as_object().cloned().unwrap_or_default();
    body.insert("key".into(), json!(key.trim()));
    body.insert("action".into(), json!(action));
    // Apps Script answers the POST with a 302 to script.googleusercontent.com; reqwest follows it as a GET.
    let r = state
        .http
        .post(format!("https://script.google.com/macros/s/{id}/exec"))
        .timeout(Duration::from_secs(secs))
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Gmail Apps Script {}", short(e)))?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| format!("Gmail Apps Script {}", short(e)))?;
    parse_script_reply(status, &text)
}

fn arg_str<'a>(args: &'a Value, k: &str) -> &'a str {
    args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn arg_num(args: &Value, k: &str, default: u64, max: u64) -> u64 {
    args.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())).unwrap_or(default).clamp(1, max)
}

/// `name` is a `gmail.*` builtin tool. `approved` matters only for `create_draft`.
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value, approved: bool) -> Result<String, String> {
    if os.snapshot().privacy.kill_switch {
        return Err("kill switch is on — Gmail is a cloud service".into());
    }
    match name {
        "gmail.recent" => {
            let n = arg_num(args, "count", 5, 20);
            match source(state) {
                Source::Script => recent(state, n).await,
                Source::N8n(wf) => {
                    let v = super::n8n::fetch_readonly(state, wf, json!({ "count": n })).await.map_err(|e| format!("Gmail (n8n \"{wf}\"): {e}"))?;
                    Ok(v.to_string().chars().take(6000).collect())
                }
                Source::None => Err(NO_BACKEND.into()),
            }
        }
        "gmail.search" => {
            let query = arg_str(args, "query");
            if query.is_empty() || query.len() > 500 {
                return Err("gmail.search needs a query (Gmail search syntax, e.g. from:sam is:unread)".into());
            }
            let limit = arg_num(args, "limit", 10, 25);
            let data = script(state, "search", json!({ "query": query, "limit": limit, "start": 0 }), 15).await?;
            Ok(format_threads(&data, &[], 240))
        }
        "gmail.read_thread" => {
            let id = arg_str(args, "threadId");
            if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Err("gmail.read_thread needs a threadId from gmail.recent or gmail.search".into());
            }
            let data = script(state, "read_thread", json!({ "threadId": id }), 15).await?;
            Ok(format_thread(&data))
        }
        "gmail.create_draft" => {
            if !approved {
                return Err("PERMISSION_REQUIRED:gmail-draft".into());
            }
            let (to, subject, body) = draft_fields(args)?;
            let data = script(state, "create_draft", json!({ "to": to, "subject": subject, "body": body }), 15).await?;
            let to = data["to"].as_str().unwrap_or(&to).to_string();
            Ok(format!("Draft saved in Gmail (not sent) — to {to}, subject \"{subject}\"."))
        }
        _ => Err(format!("unknown Gmail tool {name}")),
    }
}

fn draft_fields(args: &Value) -> Result<(String, String, String), String> {
    let to = arg_str(args, "to");
    let addresses: Vec<&str> = to.split(',').map(str::trim).filter(|a| !a.is_empty()).collect();
    let valid = |a: &str| a.len() <= 254 && !a.chars().any(char::is_whitespace) && a.split_once('@').is_some_and(|(u, d)| !u.is_empty() && d.contains('.'));
    if addresses.is_empty() || to.len() > 1000 || !addresses.iter().all(|a| valid(a)) {
        return Err("a Gmail draft needs a valid recipient email address".into());
    }
    let subject: String = arg_str(args, "subject").chars().map(|c| if c.is_control() { ' ' } else { c }).take(300).collect();
    let body = arg_str(args, "body");
    if body.is_empty() || body.len() > 20_000 {
        return Err("a Gmail draft needs a body (up to 20,000 characters)".into());
    }
    Ok((addresses.join(", "), subject.trim().to_string(), body.to_string()))
}

async fn recent(state: &DispatchState, n: u64) -> Result<String, String> {
    let data = script(state, "search", json!({ "query": "is:inbox", "limit": n, "start": 0 }), 15).await?;
    // Search summaries carry no sender or body, so read the newest few threads too.
    let ids: Vec<String> = data["threads"].as_array().into_iter().flatten().take(n.min(3) as usize).filter_map(|t| t["id"].as_str().map(String::from)).collect();
    let reads = futures_util::future::join_all(ids.iter().map(|id| script(state, "read_thread", json!({ "threadId": id }), 8)));
    let details: Vec<Value> = match tokio::time::timeout(Duration::from_secs(8), reads).await {
        Ok(v) => v.into_iter().map(|r| r.unwrap_or(Value::Null)).collect(),
        Err(_) => vec![],
    };
    Ok(format_threads(&data, &details, if n == 1 { 1500 } else { 240 }))
}

fn local_date(s: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(s).map(|d| d.with_timezone(&chrono::Local).format("%a %b %-d, %-I:%M %p").to_string()).unwrap_or_else(|_| s.to_string())
}

fn compact(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v[*k].as_str().map(str::trim).filter(|s| !s.is_empty()))
}

/// `search` data (`{threads, resultCount}`) as numbered lines; `details[i]` is
/// thread i's `read_thread` data when it was fetched (sender + body preview).
fn format_threads(data: &Value, details: &[Value], preview: usize) -> String {
    let threads: Vec<&Value> = data["threads"].as_array().into_iter().flatten().collect();
    if threads.is_empty() {
        return "No emails found.".into();
    }
    let lines: Vec<String> = threads
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let latest = details.get(i).and_then(|d| d["messages"].as_array()).and_then(|m| m.last());
            let from = latest.and_then(|m| first_str(m, &["from"])).or_else(|| first_str(t, &["from", "lastMessageFrom"])).unwrap_or("unknown sender");
            let subject = first_str(t, &["subject"]).unwrap_or("(no subject)");
            let date = first_str(t, &["lastMessageDate", "date"]).map(local_date).unwrap_or_default();
            let unread = if t["isUnread"].as_bool() == Some(true) { "[UNREAD] " } else { "" };
            let mut line = format!("{}. {unread}From: {from} · Subject: \"{subject}\"", i + 1);
            if !date.is_empty() {
                line.push_str(&format!(" · {date}"));
            }
            if let Some(id) = first_str(t, &["id"]) {
                line.push_str(&format!(" [thread {id}]"));
            }
            let body = latest.and_then(|m| first_str(m, &["body"])).or_else(|| first_str(t, &["snippet"])).map(|b| compact(b, preview)).unwrap_or_default();
            if !body.is_empty() {
                line.push_str(&format!("\n   {body}"));
            }
            line
        })
        .collect();
    let total = data["resultCount"].as_u64().unwrap_or(threads.len() as u64);
    format!("{total} email thread(s):\n{}", lines.join("\n"))
}

/// `read_thread` data → the latest message in full (truncated) plus who else wrote.
fn format_thread(data: &Value) -> String {
    let subject = first_str(data, &["subject"]).unwrap_or("(no subject)");
    let msgs: Vec<&Value> = data["messages"].as_array().into_iter().flatten().collect();
    let Some(last) = msgs.last() else {
        return format!("Thread \"{subject}\" has no messages.");
    };
    let mut s = format!(
        "Thread: \"{subject}\" ({} message{})\nLatest — From: {} · To: {} · {}\n{}",
        msgs.len(),
        if msgs.len() == 1 { "" } else { "s" },
        first_str(last, &["from"]).unwrap_or("unknown sender"),
        first_str(last, &["to"]).unwrap_or("?"),
        first_str(last, &["date"]).map(local_date).unwrap_or_default(),
        compact(first_str(last, &["body"]).unwrap_or("(empty)"), 3000)
    );
    let mut earlier: Vec<&str> = msgs[..msgs.len() - 1].iter().filter_map(|m| first_str(m, &["from"])).collect();
    earlier.dedup();
    if !earlier.is_empty() {
        s.push_str(&format!("\nEarlier messages from: {}", earlier.join(", ")));
    }
    s
}

// ── Settings commands ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    configured: bool,
    /// "script" | "n8n" | "none"
    source: &'static str,
}

#[tauri::command]
pub async fn gmail_status(state: State<'_, DispatchState>) -> Result<GmailStatus, String> {
    let source = match source(&state) {
        Source::Script => "script",
        Source::N8n(_) => "n8n",
        Source::None => "none",
    };
    Ok(GmailStatus { configured: source != "none", source })
}

/// The approved-plan path for drafts: refuses unless the user approved the confirmation card.
#[tauri::command]
pub async fn gmail_create_draft(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, to: String, subject: String, body: String, approved: Option<bool>) -> Result<String, String> {
    if !approved.unwrap_or(false) {
        return Err("PERMISSION_REQUIRED:gmail-draft".into());
    }
    let cfg = os.snapshot();
    os_core::gate(&bridge, cfg.permissions.mcp, "mcp", true, json!({ "tool": "gmail.create_draft" }))?;
    if !cfg.mcps.iter().any(|m| m.id == "gmail" && m.enabled) {
        return Err("Gmail is switched off — enable it in Settings → Skills & MCP Library".into());
    }
    let out = tool(&state, &os, "gmail.create_draft", &json!({ "to": to, "subject": subject, "body": body }), true).await;
    bridge.log(json!({ "type": "os-tool", "tool": "gmail.create_draft", "ok": out.is_ok(), "chars": body.len() }));
    out
}

#[derive(Serialize)]
pub struct ImportResult {
    imported: bool,
    detail: String,
}

/// Copy AnythingLLM Desktop's Gmail agent deployment straight into the keychain.
#[tauri::command]
pub async fn gmail_import_anythingllm(state: State<'_, DispatchState>) -> Result<ImportResult, String> {
    let r = tauri::async_runtime::spawn_blocking(import_from_anythingllm).await.map_err(|e| e.to_string())?;
    let shadowed = env_pair(&state).is_some();
    Ok(match r {
        Ok(()) if shadowed => ImportResult {
            imported: true,
            detail: "Imported the Gmail Apps Script deployment from AnythingLLM into the keychain — but GMAIL_SCRIPT_ID and GMAIL_SCRIPT_KEY are set in the environment / repo .env, and those are used first.".into(),
        },
        Ok(()) => ImportResult { imported: true, detail: "Imported the Gmail Apps Script deployment from AnythingLLM.".into() },
        Err(detail) => ImportResult { imported: false, detail },
    })
}

fn import_from_anythingllm() -> Result<(), String> {
    use rusqlite::{OpenFlags, OptionalExtension};
    let path = anythingllm_db_path().ok_or("%APPDATA% is not set")?;
    if !path.is_file() {
        return Err("AnythingLLM Desktop's database wasn't found — is AnythingLLM installed?".into());
    }
    let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| format!("couldn't open AnythingLLM's database: {e}"))?;
    let _ = conn.busy_timeout(Duration::from_secs(3));
    let raw: Option<Option<String>> = conn
        .query_row("SELECT value FROM system_settings WHERE label = 'gmail_agent_config'", [], |r| r.get(0))
        .optional()
        .map_err(|e| format!("couldn't read AnythingLLM's settings: {e}"))?;
    let (id, key) = parse_allm_config(raw.flatten().as_deref().unwrap_or(""))?;
    os_core::os_secret_store(SECRET_ID, &id)?;
    os_core::os_secret_store(SECRET_KEY, &key)
}

/// AnythingLLM's `gmail_agent_config` JSON → (deploymentId, apiKey).
fn parse_allm_config(raw: &str) -> Result<(String, String), String> {
    const MISSING: &str = "AnythingLLM has no Gmail deployment configured (Agent Skills → Gmail)";
    let v: Value = serde_json::from_str(raw).map_err(|_| MISSING.to_string())?;
    let id = v["deploymentId"].as_str().map(str::trim).unwrap_or("");
    let key = v["apiKey"].as_str().map(str::trim).unwrap_or("");
    if id.is_empty() || key.is_empty() || key.chars().all(|c| c == '*') {
        return Err(MISSING.into());
    }
    if !valid_deployment_id(id) || key.len() > 4096 {
        return Err("AnythingLLM's Gmail deployment ID doesn't look valid — paste it manually instead".into());
    }
    Ok((id.to_string(), key.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_reply_mapping() {
        assert_eq!(parse_script_reply(200, r#"{"status":"success","data":{"threads":[]}}"#).unwrap(), json!({ "threads": [] }));
        assert_eq!(parse_script_reply(200, r#"{"status":"error","error":"Invalid API key"}"#).unwrap_err(), "Gmail Apps Script error: Invalid API key");
        assert!(parse_script_reply(200, "<html>Sign in</html>").unwrap_err().contains("didn't return JSON"));
        assert!(parse_script_reply(404, "").unwrap_err().contains("not found"));
        assert!(parse_script_reply(403, "").unwrap_err().contains("\"Anyone\""));
    }

    #[test]
    fn deployment_ids_validated() {
        assert!(valid_deployment_id("AKfycbx-abc_DEF1234567890"));
        assert!(!valid_deployment_id("short"));
        assert!(!valid_deployment_id("AKfycbx/../../evil?x=1"));
    }

    #[test]
    fn allm_config_parsed_without_leaking() {
        let (id, key) = parse_allm_config(r#"{"deploymentId":" AKfycbx1234567890 ","apiKey":"k123"}"#).unwrap();
        assert_eq!((id.as_str(), key.as_str()), ("AKfycbx1234567890", "k123"));
        assert!(parse_allm_config("{}").is_err());
        assert!(parse_allm_config("").is_err());
        assert!(parse_allm_config(r#"{"deploymentId":"AKfycbx1234567890","apiKey":"*****"}"#).is_err());
        let e = parse_allm_config(r#"{"deploymentId":"bad id!","apiKey":"secret-key"}"#).unwrap_err();
        assert!(!e.contains("secret-key") && !e.contains("bad id"));
    }

    #[test]
    fn threads_formatted_with_details() {
        let data = json!({
            "resultCount": 2,
            "threads": [
                { "id": "t1", "subject": "Shoot Friday", "isUnread": true, "messageCount": 2, "lastMessageDate": "not-a-date" },
                { "id": "t2", "subject": "", "isUnread": false, "snippet": "see   you\nthere" }
            ]
        });
        let details = vec![json!({ "messages": [{ "from": "Old <o@x.com>", "body": "first" }, { "from": "Sam <sam@acme.ca>", "body": "Call time\n\n is 9am." }] })];
        let s = format_threads(&data, &details, 240);
        assert!(s.starts_with("2 email thread(s):"));
        assert!(s.contains("1. [UNREAD] From: Sam <sam@acme.ca> · Subject: \"Shoot Friday\" · not-a-date [thread t1]\n   Call time is 9am."));
        assert!(s.contains("2. From: unknown sender · Subject: \"(no subject)\" [thread t2]\n   see you there"));
        assert_eq!(format_threads(&json!({ "threads": [] }), &[], 240), "No emails found.");
    }

    #[test]
    fn thread_shows_latest_body_truncated() {
        let body = "word ".repeat(1000);
        let data = json!({ "subject": "Re: rates", "messages": [{ "from": "A" }, { "from": "B", "to": "me", "body": body }] });
        let s = format_thread(&data);
        assert!(s.starts_with("Thread: \"Re: rates\" (2 messages)\nLatest — From: B · To: me"));
        assert!(s.contains('…'));
        assert!(s.ends_with("Earlier messages from: A"));
    }

    #[test]
    fn draft_fields_validated() {
        let (to, subject, _) = draft_fields(&json!({ "to": "sam@acme.ca, jo@x.io", "subject": "Hi\nthere", "body": "Hello" })).unwrap();
        assert_eq!(to, "sam@acme.ca, jo@x.io");
        assert_eq!(subject, "Hi there");
        assert!(draft_fields(&json!({ "to": "sam", "subject": "x", "body": "y" })).is_err());
        assert!(draft_fields(&json!({ "to": "sam@acme.ca", "subject": "x", "body": "" })).is_err());
    }
}
