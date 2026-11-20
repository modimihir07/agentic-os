//! Dev task queue (System Memory Map, Phase 3).
//!
//! A Rust-owned SQLite database, `<app config dir>/devqueue.db`
//! (`%APPDATA%\os.agentic.commandcenter` on Windows), so it works with the gateway
//! down. Every row carries a `context_snapshot`: what the OS looked like when the
//! task was logged (services, MCP bus statuses, active agents, voice/UI state, git),
//! built from cached data only (no network calls) and scrubbed of secrets.
//!
//! `dev_brief_export` writes a Markdown session brief to the fixed directory
//! `<gateway.workdir>/memory/session_handoffs/` under a generated name.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

use super::dispatch::DispatchState;
use super::os_core::{self, OsState};

pub const CATEGORIES: [&str; 5] = ["mcp", "auth", "ui", "backend", "routing"];
pub const STATUSES: [&str; 4] = ["Pending", "Queued", "In Progress", "Done"];
pub const KINDS: [&str; 3] = ["task", "note", "fix"];
pub const SOURCES: [&str; 4] = ["typed", "voice", "trace", "phone"];

const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 8000;
const ERR_MAX: usize = 300;
/// An introspection snapshot older than this is ignored by `context_snapshot`.
const INTROSPECTION_TTL: u64 = 120;

// ── Schema ──────────────────────────────────────────────────────────────────

/// `PRAGMA user_version` ladder: entry `i` takes the schema from version `i` to `i + 1`.
/// Append new steps; never edit a shipped one.
const MIGRATIONS: &[&str] = &[
    // v1: the queue, plus a tiny key/value table (last brief export time).
    "CREATE TABLE dev_task_queue (
       id               TEXT PRIMARY KEY,
       title            TEXT NOT NULL,
       category         TEXT NOT NULL DEFAULT 'backend'
                        CHECK (category IN ('mcp','auth','ui','backend','routing')),
       priority         INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
       status           TEXT NOT NULL DEFAULT 'Pending'
                        CHECK (status IN ('Pending','Queued','In Progress','Done')),
       context_snapshot TEXT NOT NULL DEFAULT '{}',
       kind             TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','note','fix')),
       body             TEXT NOT NULL DEFAULT '',
       source           TEXT NOT NULL DEFAULT 'typed' CHECK (source IN ('typed','voice','trace','phone')),
       created_at       INTEGER NOT NULL,
       updated_at       INTEGER NOT NULL
     );
     CREATE INDEX dtq_open ON dev_task_queue(status, priority, created_at);
     CREATE TABLE dev_queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
];

fn sql_err(e: rusqlite::Error) -> String {
    format!("task queue: {e}")
}

/// Bring `conn` up to the latest schema. Returns the resulting version.
pub(crate) fn migrate(conn: &mut Connection) -> Result<u32, String> {
    let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(sql_err)?;
    if v as usize > MIGRATIONS.len() {
        return Err(format!("task queue: devqueue.db is schema v{v}, newer than this app (v{})", MIGRATIONS.len()));
    }
    for (i, step) in MIGRATIONS.iter().enumerate().skip(v as usize) {
        let tx = conn.transaction().map_err(sql_err)?;
        tx.execute_batch(step).map_err(sql_err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
    }
    Ok(MIGRATIONS.len() as u32)
}

pub(crate) fn open_db(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(sql_err)?;
    conn.busy_timeout(Duration::from_millis(3000)).map_err(sql_err)?;
    // journal_mode answers with a row, so it can't go through execute_batch.
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql_err)?;
    migrate(&mut conn)?;
    Ok(conn)
}

// ── State ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DevQueueState {
    conn: Mutex<Option<Connection>>,
    path: Mutex<Option<PathBuf>>,
}

impl DevQueueState {
    /// Open (or create) `<dir>/devqueue.db`. A failure is logged and retried on first use.
    pub fn init(&self, dir: &Path) {
        let path = dir.join("devqueue.db");
        *self.path.lock().unwrap() = Some(path.clone());
        match std::fs::create_dir_all(dir).map_err(|e| e.to_string()).and_then(|_| open_db(&path)) {
            Ok(c) => *self.conn.lock().unwrap() = Some(c),
            Err(e) => eprintln!("[devqueue] {e}"),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.conn.lock().unwrap();
        if g.is_none() {
            let path = self.path.lock().unwrap().clone().ok_or("task queue isn't initialised")?;
            *g = Some(open_db(&path)?);
        }
        f(g.as_mut().expect("connection just opened"))
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        Self { conn: Mutex::new(Some(c)), path: Mutex::new(None) }
    }
}

// ── Rows ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevTask {
    pub id: String,
    pub title: String,
    pub category: String,
    pub priority: u8,
    pub status: String,
    pub context_snapshot: Value,
    pub kind: String,
    pub body: String,
    pub source: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
}

const COLS: &str = "id, title, category, priority, status, context_snapshot, kind, body, source, created_at, updated_at";

fn row_task(r: &Row) -> rusqlite::Result<DevTask> {
    let snap: String = r.get(5)?;
    Ok(DevTask {
        id: r.get(0)?,
        title: r.get(1)?,
        category: r.get(2)?,
        priority: r.get::<_, i64>(3)?.clamp(0, 3) as u8,
        status: r.get(4)?,
        context_snapshot: serde_json::from_str(&snap).unwrap_or_else(|_| json!({})),
        kind: r.get(6)?,
        body: r.get(7)?,
        source: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn new_id() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; 16];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40; // v4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn one_of(field: &str, v: &str, allowed: &[&str]) -> Result<String, String> {
    allowed.iter().find(|a| **a == v).map(|a| a.to_string()).ok_or_else(|| format!("{field} must be one of: {}", allowed.join(", ")))
}

fn clean_title(t: &str) -> Result<String, String> {
    let t: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err("title is empty".into());
    }
    Ok(t.chars().take(TITLE_MAX).collect())
}

/// Everything `dev_task_add` stores, already validated and scrubbed.
#[derive(Debug, Clone)]
pub(crate) struct NewTask {
    pub title: String,
    pub category: String,
    pub priority: u8,
    pub kind: String,
    pub body: String,
    pub source: String,
    pub snapshot: Value,
}

/// Validate the caller's fields, fill in inferred category/priority, scrub secrets.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_new(title: &str, category: Option<&str>, priority: Option<u8>, body: Option<&str>, kind: Option<&str>, source: Option<&str>, snapshot: Value, known: &[String]) -> Result<NewTask, String> {
    let title = scrub(&clean_title(title)?, known);
    let body: String = scrub(body.unwrap_or("").trim(), known).chars().take(BODY_MAX).collect();
    let kind = one_of("kind", kind.unwrap_or("task"), &KINDS)?;
    let source = one_of("source", source.unwrap_or("typed"), &SOURCES)?;
    let text = format!("{title} {body}");
    let category = match category.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => one_of("category", c, &CATEGORIES)?,
        None => infer_category(&text).to_string(),
    };
    let priority = match priority {
        Some(p) if p <= 3 => p,
        Some(_) => return Err("priority must be 0–3 (0 = urgent)".into()),
        None => infer_priority(&text, &kind),
    };
    Ok(NewTask { title, category, priority, kind, body, source, snapshot })
}

pub(crate) fn insert(conn: &Connection, t: &NewTask) -> Result<DevTask, String> {
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO dev_task_queue (id, title, category, priority, status, context_snapshot, kind, body, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'Pending', ?5, ?6, ?7, ?8, ?9, ?9)",
        params![id, t.title, t.category, t.priority as i64, t.snapshot.to_string(), t.kind, t.body, t.source, now],
    )
    .map_err(sql_err)?;
    get(conn, &id)?.ok_or_else(|| "task queue: insert vanished".into())
}

pub(crate) fn get(conn: &Connection, id: &str) -> Result<Option<DevTask>, String> {
    conn.query_row(&format!("SELECT {COLS} FROM dev_task_queue WHERE id = ?1"), params![id], row_task).optional().map_err(sql_err)
}

/// Open work first (In Progress, Pending, Queued, then Done), most urgent first, oldest first.
pub(crate) fn list(conn: &Connection, status: Option<&str>, category: Option<&str>) -> Result<Vec<DevTask>, String> {
    let status = status.map(|s| one_of("status", s, &STATUSES)).transpose()?;
    let category = category.map(|c| one_of("category", c, &CATEGORIES)).transpose()?;
    let sql = format!(
        "SELECT {COLS} FROM dev_task_queue
         WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR category = ?2)
         ORDER BY CASE status WHEN 'In Progress' THEN 0 WHEN 'Pending' THEN 1 WHEN 'Queued' THEN 2 ELSE 3 END,
                  priority, created_at
         LIMIT 500"
    );
    let mut st = conn.prepare(&sql).map_err(sql_err)?;
    let rows = st.query_map(params![status, category], row_task).map_err(sql_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
}

#[derive(Default, Debug, Clone)]
pub(crate) struct Patch {
    pub status: Option<String>,
    pub priority: Option<u8>,
    pub title: Option<String>,
    pub category: Option<String>,
}

pub(crate) fn update(conn: &Connection, id: &str, p: &Patch, known: &[String]) -> Result<DevTask, String> {
    let status = p.status.as_deref().map(|s| one_of("status", s, &STATUSES)).transpose()?;
    let category = p.category.as_deref().map(|c| one_of("category", c, &CATEGORIES)).transpose()?;
    let title = p.title.as_deref().map(|t| clean_title(t).map(|t| scrub(&t, known))).transpose()?;
    if let Some(pr) = p.priority {
        if pr > 3 {
            return Err("priority must be 0–3 (0 = urgent)".into());
        }
    }
    let n = conn
        .execute(
            "UPDATE dev_task_queue SET
               status = COALESCE(?2, status), priority = COALESCE(?3, priority),
               title = COALESCE(?4, title), category = COALESCE(?5, category), updated_at = ?6
             WHERE id = ?1",
            params![id, status, p.priority.map(|v| v as i64), title, category, now_ms()],
        )
        .map_err(sql_err)?;
    if n == 0 {
        return Err("no such task".into());
    }
    get(conn, id)?.ok_or_else(|| "no such task".into())
}

pub(crate) fn delete(conn: &Connection, id: &str) -> Result<bool, String> {
    Ok(conn.execute("DELETE FROM dev_task_queue WHERE id = ?1", params![id]).map_err(sql_err)? > 0)
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM dev_queue_meta WHERE key = ?1", params![key], |r| r.get(0)).optional().map_err(sql_err)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT INTO dev_queue_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(sql_err)?;
    Ok(())
}

// ── Inference ───────────────────────────────────────────────────────────────

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Category from free text, checked in plan order: auth, mcp, routing, ui, else backend.
pub fn infer_category(text: &str) -> &'static str {
    let w = words(text);
    let any = |f: &dyn Fn(&str) -> bool| w.iter().any(|x| f(x));
    if any(&|x| x.starts_with("auth") || matches!(x, "oauth" | "token" | "tokens" | "401" | "403" | "unauthorized" | "forbidden")) {
        "auth"
    } else if any(&|x| x.starts_with("mcp") || matches!(x, "connector" | "connectors" | "tool" | "tools")) {
        "mcp"
    } else if any(&|x| matches!(x, "route" | "routes" | "routed" | "router" | "routing" | "intent" | "intents")) {
        "routing"
    } else if any(&|x| matches!(x, "ui" | "layout" | "css" | "widget" | "widgets")) {
        "ui"
    } else {
        "backend"
    }
}

/// Priority from free text (0 = urgent … 3 = someday). A `fix` defaults to 1, everything else to 2.
pub fn infer_priority(text: &str, kind: &str) -> u8 {
    let w = words(text);
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    let lower = text.to_lowercase();
    if has(&["urgent", "asap", "critical", "p0", "blocker", "blocking", "crash", "crashes", "crashing"]) || lower.contains("right now") {
        0
    } else if has(&["p3", "someday", "eventually", "maybe"]) || lower.contains("nice to have") || lower.contains("low priority") {
        3
    } else if kind == "fix" || has(&["p1", "broken", "bug", "error", "fails", "failing", "regression"]) {
        1
    } else {
        2
    }
}

// ── Secret scrubbing ────────────────────────────────────────────────────────

fn secret_patterns() -> &'static [regex::Regex] {
    static P: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    P.get_or_init(|| {
        [
            // Well-known key shapes.
            r"\b(?:sk-ant-[A-Za-z0-9_\-]{10,}|sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})",
            // "Bearer xyz" / "Basic xyz".
            r"(?i)\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=\-]{8,}",
            // "token=xyz", "OPENROUTER_API_KEY=xyz", "{'api_key': 'xyz'}", "password = xyz"… (an
            // assignment, not prose like "token rejected"). The whole name is captured, so a
            // prefixed env name keeps its prefix; quotes around the separator are allowed.
            r#"(?i)\b([A-Za-z0-9_\-]*?(?:authorization|api[_\-]?key|apikey|access[_\-]?token|refresh[_\-]?token|client[_\-]?secret|secret|password|passwd|pwd|token|key))(["']?\s*[:=]\s*["']?)[^\s,;"']{6,}"#,
            // URL userinfo: "postgresql://user:pass@host" → "postgresql://user:[redacted]@host".
            r"(?i)\b([a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@/]+@",
        ]
        .iter()
        .map(|re| regex::Regex::new(re).expect("devqueue secret regex"))
        .collect()
    })
}

/// A long run that looks like a random token: mixed case and digits (a git SHA is lowercase hex, so it survives).
fn looks_random(s: &str) -> bool {
    s.len() >= 32 && s.chars().any(|c| c.is_ascii_uppercase()) && s.chars().any(|c| c.is_ascii_lowercase()) && s.chars().any(|c| c.is_ascii_digit())
}

/// Remove secrets from `text`: every `known` value (keychain / .env / header values, at
/// least 6 chars), well-known key shapes, `key=value` style assignments and random-looking runs.
pub fn scrub(text: &str, known: &[String]) -> String {
    let mut out = text.to_string();
    let mut known: Vec<&String> = known.iter().filter(|k| k.trim().len() >= 6).collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.len()));
    for k in known {
        out = out.replace(k.as_str(), "[redacted]");
    }
    let pats = secret_patterns();
    out = pats[0].replace_all(&out, "[redacted]").into_owned();
    out = pats[1].replace_all(&out, "$1$2[redacted]").into_owned();
    out = pats[2].replace_all(&out, "$1$2[redacted]").into_owned();
    out = pats[3].replace_all(&out, "$1[redacted]@").into_owned();
    static RUN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let run = RUN.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9_\-+/=]{32,}").unwrap());
    run.replace_all(&out, |c: &regex::Captures| if looks_random(&c[0]) { "[redacted]".to_string() } else { c[0].to_string() }).into_owned()
}

/// Scrub every string inside a JSON value (keys are ours and stay).
pub fn scrub_value(v: &Value, known: &[String]) -> Value {
    match v {
        Value::String(s) => Value::String(scrub(s, known)),
        Value::Array(a) => Value::Array(a.iter().map(|x| scrub_value(x, known)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), scrub_value(x, known))).collect()),
        other => other.clone(),
    }
}

/// Names of every credential env var runtime may read from the process environment.
fn secret_env_vars() -> impl Iterator<Item = &'static str> {
    super::envfile::ENV_FOR.iter().map(|(_, v)| *v).chain(super::envfile::OTHER_SECRET_ENV.iter().copied())
}

/// Every secret value this process can see, so it can be cut out of free text. Held only
/// for the duration of one scrub; never stored, logged or returned.
pub(crate) fn known_secrets(state: &DispatchState, os: &OsState) -> Vec<String> {
    let mut v: Vec<String> = os_core::OS_SECRETS.iter().chain(os_core::INTERNAL_SECRETS.iter()).filter_map(|n| os_core::os_secret(n)).collect();
    // Internal entries may hold JSON (`spotify-session` = {access_token, …}): scrub each token field too.
    let fields: Vec<String> = v
        .iter()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .flat_map(|j| j.as_object().map(|o| o.iter().filter(|(k, _)| k.contains("token")).filter_map(|(_, x)| x.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default())
        .collect();
    v.extend(fields);
    let cfg = state.snapshot();
    v.extend(cfg.providers.iter().filter_map(|p| super::secrets::get(state, &p.id)));
    // Every value in the repo .env whose key names a credential.
    if let Ok(text) = std::fs::read_to_string(Path::new(&cfg.gateway.workdir).join(".env")) {
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        for line in text.lines() {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if let Some((k, val)) = line.split_once('=') {
                let k = k.trim().to_ascii_uppercase();
                if ["KEY", "SECRET", "TOKEN", "PASS", "SCRIPT_ID", "CLIENT_ID", "PAT", "AUTH"].iter().any(|n| k.contains(n)) {
                    v.push(val.trim().trim_matches('"').trim_matches('\'').trim().to_string());
                }
            }
        }
    }
    // Credential env vars runtime reads from the process environment (`envfile::os_key` etc.).
    v.extend(secret_env_vars().filter_map(|k| std::env::var(k).ok()).map(|s| s.trim().to_string()));
    // Header / env values configured on MCP servers (may hold tokens).
    v.extend(os.snapshot().mcps.iter().flat_map(|m| m.env.values().cloned()));
    v.retain(|s| s.trim().len() >= 6);
    v
}

#[cfg(test)]
mod secret_env_tests {
    #[test]
    fn scrubbed_env_vars_cover_every_env_credential() {
        let all: Vec<&str> = super::secret_env_vars().collect();
        for k in ["BRAVE_API_KEY", "GMAIL_SCRIPT_ID", "GMAIL_SCRIPT_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "TWELVEDATA_API_KEY", "GITHUB_PAT", "SENTRY_AUTH_TOKEN", "AGENTMAIL_API_KEY", "ELEVENLABS_API_KEY", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN"] {
            assert!(all.contains(&k), "{k} is not scrubbed");
        }
    }
}

// ── Context snapshot ────────────────────────────────────────────────────────

/// UI keys the webview may attach (voice state lives in TS). Scalars only.
pub const UI_KEYS: [&str; 8] = ["voiceState", "voiceChannel", "listening", "section", "thread", "sttEngine", "ttsEngine", "viewMode"];
/// Scalar keys of the introspection `summary` block kept as the snapshot's `system`.
pub const SUMMARY_KEYS: [&str; 12] = [
    "uptimeSecs", "cpuPct", "memUsedMb", "memTotalMb", "gpuUtilPct", "vramUsedMb", "vramTotalMb", "servicesUp", "servicesTotal", "skills", "storesOk", "storesTotal",
];
/// `TraceStep` fields kept for a `fix` (no arguments, results or payloads).
pub const TRACE_KEYS: [&str; 9] = ["traceId", "seq", "hop", "zone", "label", "ok", "ms", "error", "at"];

fn short_str(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

/// Keep only `keys`, scalar values only, strings capped at `n` chars.
fn pick_scalars(v: Option<&Value>, keys: &[&str], n: usize) -> Option<Value> {
    let o = v?.as_object()?;
    let mut out = Map::new();
    for k in keys {
        match o.get(*k) {
            Some(Value::String(s)) => {
                out.insert(k.to_string(), Value::String(short_str(s, n)));
            }
            Some(x @ (Value::Bool(_) | Value::Number(_))) => {
                out.insert(k.to_string(), x.clone());
            }
            _ => {}
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Inputs to `snapshot_from`, all gathered without a network call.
#[derive(Default, Debug, Clone)]
pub struct SnapshotParts {
    /// `(probed at, ServiceHealth JSON list)` from the last `services_health`.
    pub services: Option<(u64, Vec<Value>)>,
    /// `mcp::cached_statuses`.
    pub bus: Vec<Value>,
    /// `gpu_slot_view` as JSON.
    pub slot: Option<Value>,
    pub ui: Option<Value>,
    pub trace: Option<Value>,
    pub git: Option<GitState>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct GitState {
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// Build the stored snapshot. `introspection` is the hook for the System Map's cached
/// `system_introspect` snapshot (Part 2): when given, its `services` / `bus` / `agents`
/// blocks replace the cheaper ones gathered here (whitelisted fields only).
/// The whole result is scrubbed with `known` before it is returned.
pub fn snapshot_from(parts: &SnapshotParts, introspection: Option<&Value>, known: &[String], now: u64) -> Value {
    let mut s = Map::new();
    s.insert("at".into(), json!(now));

    let svc_fields = ["id", "label", "port", "up", "latencyMs", "detail", "manual"];
    let services: Option<Vec<Value>> = introspection
        .and_then(|i| i.get("services")?.as_array().cloned())
        .or_else(|| parts.services.as_ref().map(|(_, l)| l.clone()));
    if let Some(list) = services {
        let list: Vec<Value> = list.iter().filter_map(|x| pick_scalars(Some(x), &svc_fields, ERR_MAX)).collect();
        s.insert("services".into(), json!(list));
        if let (None, Some((at, _))) = (introspection.and_then(|i| i.get("services")), &parts.services) {
            s.insert("servicesAt".into(), json!(at));
        }
    }

    let bus_fields = ["id", "name", "transport", "status", "error", "lastError", "tools", "lastMs", "lastOk"];
    let bus: Vec<Value> = introspection.and_then(|i| i.get("bus")?.as_array().cloned()).unwrap_or_else(|| parts.bus.clone());
    if !bus.is_empty() {
        let list: Vec<Value> = bus.iter().filter_map(|x| pick_scalars(Some(x), &bus_fields, ERR_MAX)).collect();
        s.insert("bus".into(), json!(list));
    }

    let mut agents = Map::new();
    if let Some(slot) = &parts.slot {
        if let Some(a) = slot.get("active").and_then(Value::as_array) {
            agents.insert("active".into(), json!(a.iter().filter_map(Value::as_str).map(|x| short_str(x, 80)).collect::<Vec<_>>()));
        }
        for k in ["queuedForeground", "queuedBackground", "capacity"] {
            if let Some(n) = slot.get(k).filter(|v| v.is_number()) {
                agents.insert(k.into(), n.clone());
            }
        }
    }
    if let Some(list) = introspection.and_then(|i| i.get("agents")?.as_array().cloned()) {
        let fields = ["role", "label", "slug", "chatModel", "agentModel", "active"];
        agents.insert("roster".into(), json!(list.iter().filter_map(|x| pick_scalars(Some(x), &fields, 80)).collect::<Vec<_>>()));
    }
    if !agents.is_empty() {
        s.insert("agents".into(), Value::Object(agents));
    }

    if let Some(sys) = pick_scalars(introspection.and_then(|i| i.get("summary")), &SUMMARY_KEYS, 80) {
        s.insert("system".into(), sys);
    }
    if let Some(ui) = pick_scalars(parts.ui.as_ref(), &UI_KEYS, 120) {
        s.insert("ui".into(), ui);
    }
    if let Some(g) = &parts.git {
        s.insert("git".into(), json!(g));
    }
    if let Some(t) = pick_scalars(parts.trace.as_ref(), &TRACE_KEYS, ERR_MAX) {
        s.insert("trace".into(), t);
    }
    scrub_value(&Value::Object(s), known)
}

/// The last `system_introspect` result, set by Part 2 (`set_introspection`). Memory only.
static INTROSPECTION: Mutex<Option<(u64, Value)>> = Mutex::new(None);

/// Hook for `system_introspect`: hand the latest (already secret-free) snapshot here so new
/// tasks capture it. Read back only while younger than `INTROSPECTION_TTL`.
pub fn set_introspection(snapshot: Value) {
    *INTROSPECTION.lock().unwrap() = Some((os_core::now_secs(), snapshot));
}

fn fresh_introspection(now: u64) -> Option<Value> {
    let g = INTROSPECTION.lock().unwrap();
    let (at, v) = g.as_ref()?;
    (now.saturating_sub(*at) < INTROSPECTION_TTL).then(|| v.clone())
}

/// Branch and HEAD commit of the repo at `repo`, read from `.git` (no shelling out).
pub fn git_state(repo: &Path) -> GitState {
    let git = repo.join(".git");
    let Ok(head) = std::fs::read_to_string(git.join("HEAD")) else { return GitState::default() };
    let head = head.trim();
    let valid_sha = |s: &str| s.len() >= 7 && s.chars().all(|c| c.is_ascii_hexdigit());
    if let Some(r) = head.strip_prefix("ref: ") {
        let r = r.trim();
        let branch = r.strip_prefix("refs/heads/").unwrap_or(r).to_string();
        // Refuse odd ref names rather than read outside .git.
        if r.contains("..") || !r.starts_with("refs/") {
            return GitState { branch: Some(branch), head: None };
        }
        let loose = std::fs::read_to_string(git.join(r)).ok().map(|s| s.trim().to_string()).filter(|s| valid_sha(s));
        let packed = || {
            std::fs::read_to_string(git.join("packed-refs")).ok().and_then(|t| {
                t.lines().find_map(|l| {
                    let (sha, name) = l.split_once(' ')?;
                    (name.trim() == r && valid_sha(sha)).then(|| sha.to_string())
                })
            })
        };
        GitState { branch: Some(branch), head: loose.or_else(packed) }
    } else {
        GitState { branch: None, head: valid_sha(head).then(|| head.to_string()) }
    }
}

fn gather(state: &DispatchState, os: &OsState, ui: Option<Value>, trace: Option<Value>) -> SnapshotParts {
    let repo = PathBuf::from(state.snapshot().gateway.workdir);
    SnapshotParts {
        services: super::services::cached_health(),
        bus: super::mcp::cached_statuses(state, os),
        slot: serde_json::to_value(os.slot.view()).ok(),
        ui,
        trace,
        git: Some(git_state(&repo)),
    }
}

// ── Session brief ───────────────────────────────────────────────────────────

fn md_inline(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "\\|").replace('`', "'")
}

fn fmt_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_else(|| "—".into())
}

const PRIORITY_LABEL: [&str; 4] = ["P0 · urgent", "P1 · high", "P2 · normal", "P3 · low"];

/// Markdown for a session brief. Pure: everything comes in as arguments.
/// `open` = Pending / Queued / In Progress tasks; `notes` = notes logged since `last_export`.
pub fn build_brief(open: &[DevTask], notes: &[DevTask], snapshot: &Value, now_label: &str, last_export: Option<i64>, known: &[String]) -> String {
    let mut md = String::new();
    let line = |md: &mut String, s: &str| {
        md.push_str(s);
        md.push('\n');
    };
    line(&mut md, &format!("# Session brief — {now_label}"));
    line(&mut md, "");
    let git = snapshot.get("git");
    let branch = git.and_then(|g| g.get("branch")).and_then(Value::as_str).unwrap_or("—");
    let head = git.and_then(|g| g.get("head")).and_then(Value::as_str).map(|h| h.chars().take(12).collect::<String>()).unwrap_or_else(|| "—".into());
    line(&mut md, &format!("Git: branch `{}` @ `{}`", md_inline(branch), md_inline(&head)));
    line(&mut md, "");

    line(&mut md, &format!("## Open tasks ({})", open.len()));
    if open.is_empty() {
        line(&mut md, "");
        line(&mut md, "_Nothing open._");
    }
    for p in 0..=3u8 {
        let group: Vec<&DevTask> = open.iter().filter(|t| t.priority == p).collect();
        if group.is_empty() {
            continue;
        }
        line(&mut md, "");
        line(&mut md, &format!("### {}", PRIORITY_LABEL[p as usize]));
        for t in group {
            line(&mut md, &format!("- [{}] **{}** · `{}` · {} · {} · {}", t.status, md_inline(&t.title), t.category, t.kind, t.source, fmt_ms(t.created_at)));
            if !t.body.trim().is_empty() {
                line(&mut md, &format!("  > {}", md_inline(&short_str(&t.body, 400))));
            }
            if let Some(tr) = t.context_snapshot.get("trace") {
                let hop = tr.get("hop").and_then(Value::as_str).unwrap_or("?");
                let err = tr.get("error").and_then(Value::as_str).unwrap_or("");
                line(&mut md, &format!("  > failing hop `{}`{}", md_inline(hop), if err.is_empty() { String::new() } else { format!(": {}", md_inline(err)) }));
            }
        }
    }
    line(&mut md, "");

    let since = last_export.map(fmt_ms).unwrap_or_else(|| "the start".into());
    line(&mut md, &format!("## Notes since {} ({})", since, notes.len()));
    line(&mut md, "");
    if notes.is_empty() {
        line(&mut md, "_No new notes._");
    }
    for n in notes {
        let body = if n.body.trim().is_empty() { String::new() } else { format!(" — {}", md_inline(&short_str(&n.body, 400))) };
        line(&mut md, &format!("- {} · **{}**{}", fmt_ms(n.created_at), md_inline(&n.title), body));
    }
    line(&mut md, "");

    line(&mut md, "## Connector diagnostics");
    line(&mut md, "");
    let bus = snapshot.get("bus").and_then(Value::as_array).cloned().unwrap_or_default();
    if bus.is_empty() {
        line(&mut md, "_No MCP status cached._");
    } else {
        line(&mut md, "| Server | Status | Last error |");
        line(&mut md, "|---|---|---|");
        for b in &bus {
            let g = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let err = if g("error").is_empty() { g("lastError") } else { g("error") };
            let name = if g("name").is_empty() { g("id") } else { g("name") };
            line(&mut md, &format!("| {} | {} | {} |", md_inline(&name), md_inline(&g("status")), if err.is_empty() { "—".into() } else { md_inline(&err) }));
        }
    }
    line(&mut md, "");

    line(&mut md, "## Services");
    line(&mut md, "");
    match snapshot.get("services").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => {
            line(&mut md, "| Service | Up | Latency | Detail |");
            line(&mut md, "|---|---|---|---|");
            for v in list {
                let label = v.get("label").or(v.get("id")).and_then(Value::as_str).unwrap_or("?");
                let up = match v.get("up").and_then(Value::as_bool) {
                    Some(true) => "up",
                    Some(false) => "down",
                    None => "—",
                };
                let lat = v.get("latencyMs").and_then(Value::as_u64).map(|m| format!("{m} ms")).unwrap_or_else(|| "—".into());
                let detail = v.get("detail").and_then(Value::as_str).unwrap_or("");
                line(&mut md, &format!("| {} | {} | {} | {} |", md_inline(label), up, lat, md_inline(detail)));
            }
        }
        _ => line(&mut md, "_Not probed this session (open the System Map or Agent Nodes to probe)._"),
    }
    line(&mut md, "");

    line(&mut md, "## Active agents");
    line(&mut md, "");
    let active: Vec<String> = snapshot.pointer("/agents/active").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(md_inline).collect()).unwrap_or_default();
    line(&mut md, &if active.is_empty() { "_None holding the GPU slot._".to_string() } else { active.join(", ") });
    line(&mut md, "");

    line(&mut md, "## Suggested next command");
    line(&mut md, "");
    let top = open.iter().find(|t| t.status == "In Progress").or_else(|| open.first());
    match top {
        Some(t) => line(&mut md, &format!("Pick up **{}** ({}, `{}`).", md_inline(&t.title), PRIORITY_LABEL[t.priority.min(3) as usize], t.category)),
        None => line(&mut md, "Queue is clear; verify the build before starting new work."),
    }
    if let Some(b) = bus.iter().find(|b| matches!(b.get("status").and_then(Value::as_str), Some("needs_token" | "auth_failed"))) {
        let name = b.get("name").or(b.get("id")).and_then(Value::as_str).unwrap_or("?");
        line(&mut md, &format!("Fix the {} connector token in Settings → Skills & MCP Library.", md_inline(name)));
    }
    line(&mut md, "");
    line(&mut md, "```powershell");
    line(&mut md, "cd \"command center\"; npm run typecheck; npx vitest run; cd src-tauri; cargo test --lib");
    line(&mut md, "```");
    scrub(&md, known)
}

/// `<repo>/memory/session_handoffs`, created and confirmed to resolve inside the repo.
fn handoff_dir(repo: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(repo).map_err(|e| format!("repo folder unavailable: {e}"))?;
    let dir = root.join("memory").join("session_handoffs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create memory/session_handoffs: {e}"))?;
    let real = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err("memory/session_handoffs resolves outside the repo; refusing to write".into());
    }
    Ok(real)
}

/// `YYYY-MM-DD-HHMM.md`, or `…-2.md`, `…-3.md` if that minute is taken.
pub fn brief_file_name(dir: &Path, stamp: &str) -> PathBuf {
    let first = dir.join(format!("{stamp}.md"));
    if !first.exists() {
        return first;
    }
    (2..1000).map(|n| dir.join(format!("{stamp}-{n}.md"))).find(|p| !p.exists()).unwrap_or(first)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefExport {
    pub markdown: String,
    pub path: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dev_task_add(
    dq: State<'_, DevQueueState>,
    state: State<'_, DispatchState>,
    os: State<'_, OsState>,
    title: String,
    category: Option<String>,
    priority: Option<u8>,
    body: Option<String>,
    kind: Option<String>,
    source: Option<String>,
    trace: Option<Value>,
    ui: Option<Value>,
) -> Result<DevTask, String> {
    let known = known_secrets(&state, &os);
    let now = os_core::now_secs();
    let parts = gather(&state, &os, ui, trace);
    let snapshot = snapshot_from(&parts, fresh_introspection(now).as_ref(), &known, now);
    let t = prepare_new(&title, category.as_deref(), priority, body.as_deref(), kind.as_deref(), source.as_deref(), snapshot, &known)?;
    dq.with(|c| insert(c, &t))
}

#[tauri::command]
pub async fn dev_task_list(dq: State<'_, DevQueueState>, status: Option<String>, category: Option<String>) -> Result<Vec<DevTask>, String> {
    dq.with(|c| list(c, status.as_deref(), category.as_deref()))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dev_task_update(
    dq: State<'_, DevQueueState>,
    state: State<'_, DispatchState>,
    os: State<'_, OsState>,
    id: String,
    status: Option<String>,
    priority: Option<u8>,
    title: Option<String>,
    category: Option<String>,
) -> Result<DevTask, String> {
    let known = if title.is_some() { known_secrets(&state, &os) } else { vec![] };
    let patch = Patch { status, priority, title, category };
    dq.with(|c| update(c, &id, &patch, &known))
}

#[tauri::command]
pub async fn dev_task_delete(dq: State<'_, DevQueueState>, id: String) -> Result<bool, String> {
    dq.with(|c| delete(c, &id))
}

/// Build the session brief, write it to `<repo>/memory/session_handoffs/`, return it.
#[tauri::command]
pub async fn dev_brief_export(dq: State<'_, DevQueueState>, state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<BriefExport, String> {
    let known = known_secrets(&state, &os);
    let now = os_core::now_secs();
    let snapshot = snapshot_from(&gather(&state, &os, None, None), fresh_introspection(now).as_ref(), &known, now);
    let local = chrono::Local::now();
    let (open, notes, last) = dq.with(|c| {
        let last: Option<i64> = meta_get(c, "last_brief_export")?.and_then(|s| s.parse().ok());
        let all = list(c, None, None)?;
        // Notes are observations, not work: they appear under "Notes since…", never as
        // open tasks or as the suggested next command.
        let open: Vec<DevTask> = all.iter().filter(|t| t.status != "Done" && t.kind != "note").cloned().collect();
        let notes: Vec<DevTask> = all.into_iter().filter(|t| t.kind == "note" && last.map_or(true, |l| t.created_at > l)).collect();
        Ok((open, notes, last))
    })?;
    let markdown = build_brief(&open, &notes, &snapshot, &local.format("%Y-%m-%d %H:%M").to_string(), last, &known);
    let dir = handoff_dir(Path::new(&state.snapshot().gateway.workdir))?;
    let path = brief_file_name(&dir, &local.format("%Y-%m-%d-%H%M").to_string());
    std::fs::write(&path, &markdown).map_err(|e| format!("couldn't write the brief: {e}"))?;
    dq.with(|c| meta_set(c, "last_brief_export", &now_ms().to_string()))?;
    // canonicalize() gives a `\\?\` verbatim path on Windows; show the familiar form.
    let shown = path.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    Ok(BriefExport { markdown, path: shown })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("devqueue-{tag}-{}-{}", std::process::id(), new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn new_task(title: &str) -> NewTask {
        prepare_new(title, None, None, None, None, None, json!({}), &[]).unwrap()
    }

    #[test]
    fn migrations_on_a_temp_db() {
        let dir = tmp_dir("mig");
        let path = dir.join("devqueue.db");
        {
            let c = open_db(&path).unwrap();
            let v: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, MIGRATIONS.len() as u32);
            let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
            assert_eq!(mode.to_lowercase(), "wal");
            insert(&c, &new_task("survives reopen")).unwrap();
        }
        // Re-opening is a no-op migration and keeps the data.
        let mut c = open_db(&path).unwrap();
        assert_eq!(migrate(&mut c).unwrap(), MIGRATIONS.len() as u32);
        assert_eq!(list(&c, None, None).unwrap().len(), 1);
        // The CHECK constraints are live.
        assert!(c.execute("UPDATE dev_task_queue SET status = 'Bogus'", []).is_err());
        assert!(c.execute("UPDATE dev_task_queue SET priority = 9", []).is_err());
        // A database from a newer app is refused, not clobbered.
        c.execute_batch("PRAGMA user_version = 99").unwrap();
        assert!(migrate(&mut c).unwrap_err().contains("newer"));
        drop(c);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn add_list_update_delete() {
        let dq = DevQueueState::in_memory();
        let a = dq.with(|c| insert(c, &new_task("Spotify 401 on now playing"))).unwrap();
        assert_eq!(a.status, "Pending");
        assert_eq!(a.category, "auth");
        assert_eq!(a.id.len(), 36);
        let b = dq.with(|c| insert(c, &prepare_new("tidy the widget grid", None, Some(3), Some("css gaps"), Some("note"), Some("voice"), json!({"git": {"branch": "x"}}), &[]).unwrap())).unwrap();
        assert_eq!((b.category.as_str(), b.priority, b.kind.as_str(), b.source.as_str()), ("ui", 3, "note", "voice"));
        assert_eq!(b.context_snapshot["git"]["branch"], "x");

        assert_eq!(dq.with(|c| list(c, None, None)).unwrap().len(), 2);
        assert_eq!(dq.with(|c| list(c, None, Some("ui"))).unwrap().len(), 1);
        assert!(dq.with(|c| list(c, Some("nope"), None)).is_err());

        let up = dq.with(|c| update(c, &a.id, &Patch { status: Some("In Progress".into()), priority: Some(0), ..Default::default() }, &[])).unwrap();
        assert_eq!((up.status.as_str(), up.priority), ("In Progress", 0));
        assert!(up.updated_at >= a.updated_at);
        assert_eq!(dq.with(|c| list(c, Some("In Progress"), None)).unwrap()[0].id, a.id);
        let renamed = dq.with(|c| update(c, &a.id, &Patch { title: Some("  new   title ".into()), category: Some("mcp".into()), ..Default::default() }, &[])).unwrap();
        assert_eq!((renamed.title.as_str(), renamed.category.as_str(), renamed.status.as_str()), ("new title", "mcp", "In Progress"));
        assert!(dq.with(|c| update(c, &a.id, &Patch { status: Some("Bogus".into()), ..Default::default() }, &[])).is_err());
        assert!(dq.with(|c| update(c, &a.id, &Patch { priority: Some(4), ..Default::default() }, &[])).is_err());
        assert!(dq.with(|c| update(c, "missing", &Patch::default(), &[])).unwrap_err().contains("no such task"));

        assert!(dq.with(|c| delete(c, &a.id)).unwrap());
        assert!(!dq.with(|c| delete(c, &a.id)).unwrap());
        assert_eq!(dq.with(|c| list(c, None, None)).unwrap().len(), 1);
    }

    #[test]
    fn validation() {
        assert!(prepare_new("   ", None, None, None, None, None, json!({}), &[]).is_err());
        assert!(prepare_new("x", Some("frontend"), None, None, None, None, json!({}), &[]).is_err());
        assert!(prepare_new("x", None, Some(7), None, None, None, json!({}), &[]).is_err());
        assert!(prepare_new("x", None, None, None, Some("chore"), None, json!({}), &[]).is_err());
        assert!(prepare_new("x", None, None, None, None, Some("email"), json!({}), &[]).is_err());
        let long = "a ".repeat(500);
        assert_eq!(prepare_new(&long, None, None, None, None, None, json!({}), &[]).unwrap().title.chars().count(), TITLE_MAX);
        // An explicit category beats inference.
        assert_eq!(prepare_new("token refresh", Some("ui"), None, None, None, None, json!({}), &[]).unwrap().category, "ui");
    }

    #[test]
    fn category_inference() {
        assert_eq!(infer_category("GitHub MCP returns 401"), "auth");
        assert_eq!(infer_category("refresh the OAuth token"), "auth");
        assert_eq!(infer_category("Authentication popup loops"), "auth");
        assert_eq!(infer_category("Add a Notion connector"), "mcp");
        assert_eq!(infer_category("tools list is slow"), "mcp");
        assert_eq!(infer_category("router picks the wrong intent"), "routing");
        assert_eq!(infer_category("Fix the layout of the widget"), "ui");
        assert_eq!(infer_category("UI flickers"), "ui");
        // Substrings don't count: "build" has "ui" in it, "author" isn't auth… but is "auth*".
        assert_eq!(infer_category("rebuild the guide"), "backend");
        assert_eq!(infer_category("sqlite migration"), "backend");
    }

    #[test]
    fn priority_inference() {
        assert_eq!(infer_priority("URGENT: voice crashes", "task"), 0);
        assert_eq!(infer_priority("do this right now", "note"), 0);
        assert_eq!(infer_priority("nice to have: dark mode", "task"), 3);
        assert_eq!(infer_priority("whisper error on start", "task"), 1);
        assert_eq!(infer_priority("anything", "fix"), 1);
        assert_eq!(infer_priority("rename a label", "task"), 2);
    }

    #[test]
    fn scrubbing_removes_secrets_and_keeps_shas() {
        let known = vec!["s3cr3t-value-123".to_string(), "abc".to_string()];
        let s = scrub("got s3cr3t-value-123 back; abc stays", &known);
        assert!(!s.contains("s3cr3t-value-123"));
        assert!(s.contains("abc stays"));
        let s = scrub("Authorization: Bearer abcdefghijklmnop and api_key=zzzzzzzzzz9", &[]);
        assert!(!s.contains("abcdefghijklmnop") && !s.contains("zzzzzzzzzz9"), "{s}");
        let s = scrub("key sk-ant-api03-AAAAAAAAAAAAAAAA and ghp_ABCDEFGHIJKLMNOPQRSTUV12", &[]);
        assert!(!s.contains("sk-ant-api03") && !s.contains("ghp_ABCD"), "{s}");
        let s = scrub("random Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z here", &[]);
        assert!(s.contains("[redacted]") && !s.contains("Ab3dEf6h"), "{s}");
        let sha = "d3a2175c0ffee0123456789abcdef0123456789a";
        assert!(scrub(&format!("HEAD {sha}"), &[]).contains(sha));
        assert_eq!(scrub("GitHub: token was rejected (HTTP 401)", &[]), "GitHub: token was rejected (HTTP 401)");
    }

    #[test]
    fn scrubbing_catches_prefixed_names_quoted_keys_and_url_passwords() {
        for (line, value, name) in [
            ("OPENROUTER_API_KEY=abcdef1234567890", "abcdef1234567890", "OPENROUTER_API_KEY"),
            ("SENTRY_AUTH_TOKEN=abcdef123456", "abcdef123456", "SENTRY_AUTH_TOKEN"),
            ("GEMINI_API_KEY: abcdef123456", "abcdef123456", "GEMINI_API_KEY"),
            (r#"{"api_key": "abcdef1234567890"}"#, "abcdef1234567890", "api_key"),
            ("{'token': 'abcdef123456'}", "abcdef123456", "token"),
            ("x-api-key: abcdef123456", "abcdef123456", "x-api-key"),
        ] {
            let s = scrub(line, &[]);
            assert!(!s.contains(value) && s.contains(name) && s.contains("[redacted]"), "{line} -> {s}");
        }
        let s = scrub("connect postgresql://user:hunter22@db.local/app failed", &[]);
        assert!(!s.contains("hunter22") && s.contains("postgresql://user:[redacted]@db.local/app"), "{s}");
        assert_eq!(scrub("the token rejected our request", &[]), "the token rejected our request");
        assert_eq!(scrub("see https://example.com/a:b for details", &[]), "see https://example.com/a:b for details");
    }

    #[test]
    fn snapshot_redaction_and_whitelists() {
        let secret = "ya29.SuperSecretSpotifyRefreshToken";
        let parts = SnapshotParts {
            services: Some((10, vec![json!({"id": "gateway", "label": "Gateway", "up": true, "latencyMs": 12, "detail": "200", "kind": "agentic-os", "apiKey": secret})])),
            bus: vec![json!({"id": "github", "name": "GitHub", "status": "auth_failed", "error": format!("rejected {secret}"), "headers": {"Authorization": secret}})],
            slot: Some(json!({"active": ["lmstudio · Tony"], "queuedForeground": 1, "queuedBackground": 0, "capacity": 1})),
            ui: Some(json!({"voiceState": "listening", "section": "memorymap", "token": secret, "nested": {"a": 1}, "thread": format!("x {secret}")})),
            trace: Some(json!({"traceId": "t1", "seq": 3, "hop": "tool", "zone": "exhaust", "label": "spotify.now_playing", "ok": false, "ms": 41, "error": "HTTP 401", "args": {"q": secret}, "result": secret})),
            git: Some(GitState { branch: Some("feat/command-center".into()), head: Some("d3a2175".into()) }),
        };
        let snap = snapshot_from(&parts, None, &[secret.to_string()], 99);
        let text = snap.to_string();
        assert!(!text.contains(secret), "{text}");
        assert!(!text.contains("SuperSecret"), "{text}");
        assert!(snap["services"][0].get("apiKey").is_none());
        assert_eq!(snap["services"][0]["latencyMs"], 12);
        assert_eq!(snap["servicesAt"], 10);
        assert!(snap["bus"][0].get("headers").is_none());
        assert_eq!(snap["bus"][0]["status"], "auth_failed");
        assert_eq!(snap["agents"]["active"][0], "lmstudio · Tony");
        assert!(snap["ui"].get("token").is_none() && snap["ui"].get("nested").is_none());
        assert_eq!(snap["ui"]["voiceState"], "listening");
        assert!(snap["trace"].get("args").is_none() && snap["trace"].get("result").is_none());
        assert_eq!(snap["trace"]["hop"], "tool");
        assert_eq!(snap["git"]["branch"], "feat/command-center");

        // The introspection hook replaces services/bus and adds the roster.
        let intro = json!({"services": [{"id": "lmstudio", "port": 1235, "up": false, "latencyMs": 0, "detail": "unreachable"}],
                           "bus": [{"id": "spotify", "status": "ok", "lastMs": 120, "secretThing": secret}],
                           "agents": [{"role": "coder", "chatModel": "qwen", "active": true, "key": secret}],
                           "summary": {"uptimeSecs": 61, "cpuPct": 12.5, "skills": 118, "storesOk": 5, "hostname": "box", "nested": {"a": 1}}});
        let snap = snapshot_from(&parts, Some(&intro), &[secret.to_string()], 99);
        assert_eq!(snap["system"]["uptimeSecs"], 61);
        assert_eq!(snap["system"]["skills"], 118);
        assert!(snap["system"].get("hostname").is_none() && snap["system"].get("nested").is_none());
        assert_eq!(snap["services"][0]["port"], 1235);
        assert!(snap.get("servicesAt").is_none());
        assert_eq!(snap["bus"][0]["id"], "spotify");
        assert_eq!(snap["agents"]["roster"][0]["role"], "coder");
        assert!(!snap.to_string().contains(secret));
    }

    #[test]
    fn git_state_reads_branch_and_head() {
        let dir = tmp_dir("git");
        let git = dir.join(".git");
        std::fs::create_dir_all(git.join("refs/heads/feat")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feat/command-center\n").unwrap();
        // Packed only at first.
        std::fs::write(git.join("packed-refs"), "# pack-refs\nd3a2175aaaa refs/heads/feat/command-center\n").unwrap();
        assert_eq!(git_state(&dir), GitState { branch: Some("feat/command-center".into()), head: Some("d3a2175aaaa".into()) });
        std::fs::write(git.join("refs/heads/feat/command-center"), "b8b7852bbbb\n").unwrap();
        assert_eq!(git_state(&dir).head.as_deref(), Some("b8b7852bbbb"));
        // Detached HEAD.
        std::fs::write(git.join("HEAD"), "edef429cccc\n").unwrap();
        assert_eq!(git_state(&dir), GitState { branch: None, head: Some("edef429cccc".into()) });
        // No repo at all.
        assert_eq!(git_state(&dir.join("nope")), GitState::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn task(title: &str, status: &str, priority: u8, kind: &str, created_at: i64) -> DevTask {
        DevTask {
            id: new_id(),
            title: title.into(),
            category: infer_category(title).into(),
            priority,
            status: status.into(),
            context_snapshot: json!({}),
            kind: kind.into(),
            body: String::new(),
            source: "typed".into(),
            created_at,
            updated_at: created_at,
        }
    }

    #[test]
    fn brief_markdown() {
        let mut fix = task("GitHub | MCP 401", "In Progress", 0, "fix", 1_700_000_000_000);
        fix.context_snapshot = json!({"trace": {"hop": "tool", "error": "token was rejected (HTTP 401)"}});
        fix.body = "seen while asking\nfor repos".into();
        let open = vec![fix, task("tidy layout", "Pending", 2, "task", 1_700_000_100_000)];
        let notes = vec![task("remember the plate texture", "Pending", 2, "note", 1_700_000_200_000)];
        let snap = json!({
            "git": {"branch": "feat/command-center", "head": "d3a2175c0ffee0123"},
            "bus": [{"id": "github", "name": "GitHub", "status": "needs_token", "error": "GitHub: needs a token (no token set)"}],
            "services": [{"label": "Gateway", "up": true, "latencyMs": 12, "detail": "200"}],
            "agents": {"active": ["lmstudio · Tony"]}
        });
        let md = build_brief(&open, &notes, &snap, "2026-11-18 14:05", None, &["seen while".to_string()]);
        assert!(md.starts_with("# Session brief — 2026-11-18 14:05\n"));
        assert!(md.contains("branch `feat/command-center` @ `d3a2175c0ffe`"));
        assert!(md.contains("## Open tasks (2)"));
        assert!(md.find("### P0").unwrap() < md.find("### P2").unwrap());
        assert!(md.contains("**GitHub \\| MCP 401**"), "{md}");
        assert!(md.contains("failing hop `tool`: token was rejected (HTTP 401)"));
        assert!(!md.contains("seen while"), "known secrets are scrubbed from the brief");
        assert!(md.contains("## Notes since the start (1)"));
        assert!(md.contains("remember the plate texture"));
        assert!(md.contains("| GitHub | needs_token | GitHub: needs a token (no token set) |"));
        assert!(md.contains("| Gateway | up | 12 ms | 200 |"));
        assert!(md.contains("lmstudio · Tony"));
        assert!(md.contains("Pick up **GitHub \\| MCP 401**"));
        assert!(md.contains("Fix the GitHub connector token"));

        let empty = build_brief(&[], &[], &json!({}), "now", Some(1_700_000_000_000), &[]);
        assert!(empty.contains("_Nothing open._") && empty.contains("_No new notes._") && empty.contains("_No MCP status cached._"));
        assert!(empty.contains("branch `—` @ `—`"));
    }

    #[test]
    fn brief_files_land_in_the_fixed_dir() {
        let repo = tmp_dir("brief");
        let dir = handoff_dir(&repo).unwrap();
        assert!(dir.ends_with(Path::new("memory").join("session_handoffs")));
        let a = brief_file_name(&dir, "2026-11-18-1405");
        assert_eq!(a.file_name().unwrap(), "2026-11-18-1405.md");
        std::fs::write(&a, "x").unwrap();
        assert_eq!(brief_file_name(&dir, "2026-11-18-1405").file_name().unwrap(), "2026-11-18-1405-2.md");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn meta_round_trip() {
        let dq = DevQueueState::in_memory();
        assert_eq!(dq.with(|c| meta_get(c, "last_brief_export")).unwrap(), None);
        dq.with(|c| meta_set(c, "last_brief_export", "1")).unwrap();
        dq.with(|c| meta_set(c, "last_brief_export", "2")).unwrap();
        assert_eq!(dq.with(|c| meta_get(c, "last_brief_export")).unwrap().as_deref(), Some("2"));
    }
}
