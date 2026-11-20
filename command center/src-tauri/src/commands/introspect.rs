//! System Map ("architectural X-ray"): one read-only snapshot of how the OS is wired.
//!
//! `system_introspect` gathers the host, the local services, the agent roster, the
//! rules file, the skill library, the background routines, the persistent stores and
//! the tool bus in one call. It never calls a model, never writes, and never returns a
//! secret: the finished snapshot is scrubbed with every secret value the process can
//! see before it leaves Rust. Anything without a live source comes back `null` with a
//! `*Note` / `error` string saying why, so the page can show "—" honestly.
//!
//! Cached for 10 s (the page polls every 10 s while visible); `deep: true` refreshes
//! the probes and re-lists every external MCP server.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Manager, State};

use super::dispatch::{DispatchState, Kind};
use super::os_core::{self, OsConfig, OsState};

const TTL_MS: u64 = 10_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const DEEP_MCP_TIMEOUT: Duration = Duration::from_secs(10);
const N8N_TIMEOUT: Duration = Duration::from_secs(4);

/// Extra skill roots scanned besides os.json `skills.dir` and `<repo>/skills`.
const EXTRA_SKILL_ROOTS: [&str; 1] = [r"C:\ai-hub\.claude\skills"];
const SKILL_DEPTH: usize = 4;
const SKILL_LIMIT: usize = 600;
const SKILL_DESC_MAX: usize = 200;
const MAX_TABLES: usize = 64;
const MAX_LINES_BYTES: u64 = 64 * 1024 * 1024;
const KG_PARSE_MAX: u64 = 8 * 1024 * 1024;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

// ── App uptime ──────────────────────────────────────────────────────────────

static STARTED: OnceLock<(Instant, u64)> = OnceLock::new();

/// Record the app start (called first thing in `setup`). Later calls are no-ops.
pub fn mark_started() {
    STARTED.get_or_init(|| (Instant::now(), now_ms()));
}

fn started() -> (Instant, u64) {
    *STARTED.get_or_init(|| (Instant::now(), now_ms()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUptime {
    /// Unix ms when the desktop app started.
    started_at: u64,
    uptime_secs: u64,
}

#[tauri::command]
pub fn app_uptime() -> AppUptime {
    let (t, at) = started();
    AppUptime { started_at: at, uptime_secs: t.elapsed().as_secs() }
}

// ── Background loop registry ────────────────────────────────────────────────

pub struct LoopDef {
    pub id: &'static str,
    pub label: &'static str,
    pub interval_secs: u64,
    pub source: &'static str,
}

/// The Rust background loops that report here (each calls `loop_ran` once per pass).
pub const LOOPS: [LoopDef; 4] = [
    LoopDef { id: "inbox", label: "Phone inbox drain", interval_secs: 3, source: "pipeline::inbox_loop" },
    LoopDef { id: "whisper", label: "Whisper keep-alive", interval_secs: 300, source: "services::whisper_ensure" },
    LoopDef { id: "local-fit", label: "Local model fit guard", interval_secs: 300, source: "services::local_fit_loop" },
    LoopDef { id: "droplet", label: "Droplet link monitor", interval_secs: 15, source: "os_core::droplet_link_loop" },
];

#[derive(Clone, Debug, Default, PartialEq)]
struct LoopRun {
    at_ms: u64,
    ok: bool,
    detail: String,
    runs: u64,
}

static RUNS: Mutex<BTreeMap<String, LoopRun>> = Mutex::new(BTreeMap::new());

/// A background loop finished one pass. `detail` is a status line (never a payload).
pub(crate) fn loop_ran(id: &str, ok: bool, detail: &str) {
    let mut g = RUNS.lock().unwrap();
    let e = g.entry(id.to_string()).or_default();
    e.at_ms = now_ms();
    e.ok = ok;
    e.detail = detail.chars().take(160).collect();
    e.runs += 1;
}

/// A loop is overdue when it hasn't reported for 3 intervals (+10 s slack), or never
/// reported although the app has been up longer than that.
pub(crate) fn loop_overdue(last_ms: Option<u64>, now: u64, interval_secs: u64, uptime_secs: u64) -> bool {
    let grace = (interval_secs * 3 + 10) * 1000;
    match last_ms {
        Some(at) => now.saturating_sub(at) > grace,
        None => uptime_secs * 1000 > grace,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopInfo {
    id: &'static str,
    label: &'static str,
    interval_secs: u64,
    source: &'static str,
    last_run: Option<u64>,
    last_ok: Option<bool>,
    detail: Option<String>,
    runs: u64,
    overdue: bool,
}

fn loops_view(now: u64, uptime_secs: u64) -> Vec<LoopInfo> {
    let runs = RUNS.lock().unwrap().clone();
    LOOPS
        .iter()
        .map(|d| {
            let r = runs.get(d.id);
            LoopInfo {
                id: d.id,
                label: d.label,
                interval_secs: d.interval_secs,
                source: d.source,
                last_run: r.map(|r| r.at_ms),
                last_ok: r.map(|r| r.ok),
                detail: r.map(|r| r.detail.clone()),
                runs: r.map_or(0, |r| r.runs),
                overdue: loop_overdue(r.map(|r| r.at_ms), now, d.interval_secs, uptime_secs),
            }
        })
        .collect()
}

// ── Cache ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct IntrospectState {
    /// (built at, unix ms; scrubbed snapshot). Held across a rebuild so concurrent callers share one.
    cache: tokio::sync::Mutex<Option<(u64, Value)>>,
}

pub(crate) fn is_fresh(at_ms: u64, now: u64, deep: bool) -> bool {
    !deep && now.saturating_sub(at_ms) < TTL_MS
}

#[tauri::command]
pub async fn system_introspect(app: tauri::AppHandle, cache: State<'_, IntrospectState>, deep: Option<bool>) -> Result<Value, String> {
    let deep = deep.unwrap_or(false);
    let mut g = cache.cache.lock().await;
    if let Some((at, snap)) = g.as_ref() {
        if is_fresh(*at, now_ms(), deep) {
            return Ok(snap.clone());
        }
    }
    let snap = build(&app, deep).await?;
    super::devqueue::set_introspection(compact(&snap));
    *g = Some((now_ms(), snap.clone()));
    Ok(snap)
}

/// What the dev task queue keeps from a snapshot (it whitelists fields again).
fn compact(snap: &Value) -> Value {
    json!({ "services": snap["services"], "bus": snap["bus"], "agents": snap["agents"], "summary": snap["summary"] })
}

async fn build(app: &tauri::AppHandle, deep: bool) -> Result<Value, String> {
    let t0 = Instant::now();
    let st = app.state::<DispatchState>();
    let os = app.state::<OsState>();
    let cfg = st.snapshot();
    let osc = os.snapshot();

    let local = {
        let app = app.clone();
        let osc = osc.clone();
        let workdir = PathBuf::from(&cfg.gateway.workdir);
        let config_dir = st.config_dir();
        tauri::async_runtime::spawn_blocking(move || {
            let host = host_block(&app);
            let rules = rules_block(&osc, &workdir);
            let skills = skills_block(&osc, &workdir);
            let stores = stores_block(config_dir.as_deref(), &workdir);
            (host, rules, skills, stores)
        })
    };
    let bus = async {
        if deep {
            super::mcp::refresh_listings(&st, &os, DEEP_MCP_TIMEOUT).await;
        }
        bus_block(&st, &os)
    };
    let routines = futures_util::future::join(scheduler_jobs(&st, &osc), n8n_block(&st));
    let (services, (agents, agents_note), (sched, n8n), bus) =
        futures_util::future::join4(super::services::probe_local(&st, &osc, PROBE_TIMEOUT), agents_block(&st, &os, &osc), routines, bus).await;
    let (host, rules, skills, stores) = local.await.map_err(|e| e.to_string())?;

    let (start, _) = started();
    let uptime_secs = start.elapsed().as_secs();
    let now = now_ms();
    let (sched_jobs, sched_note) = match sched {
        Ok(j) => (Some(j), None),
        Err(e) => (None, Some(e)),
    };
    let routines = json!({
        "loops": loops_view(now, uptime_secs),
        "schedulerJobs": sched_jobs,
        "schedulerNote": sched_note,
        "n8nConfigured": cfg.n8n_workflows.iter().map(|(name, wf)| json!({ "name": name, "mutating": wf.mutating() })).collect::<Vec<_>>(),
        "n8n": n8n.0,
        "n8nNote": n8n.1,
    });
    let chain: Vec<Value> = cfg
        .policy
        .chain
        .iter()
        .filter_map(|id| cfg.providers.iter().find(|p| &p.id == id))
        .map(|p| json!({ "id": p.id, "label": p.label, "kind": p.kind, "model": p.model, "local": !os_core::is_remote(p) }))
        .collect();
    let summary = summary(uptime_secs, &host, &services, &skills, &stores);
    let snap = json!({
        "at": now,
        "deep": deep,
        "tookMs": t0.elapsed().as_millis() as u64,
        "uptimeSecs": uptime_secs,
        "host": host,
        "services": services,
        "chain": chain,
        "agents": agents,
        "agentsNote": agents_note,
        "slot": os.slot.view(),
        "rules": rules,
        "skills": skills,
        "routines": routines,
        "stores": stores,
        "bus": bus,
        "summary": summary,
    });
    let known = super::devqueue::known_secrets(&st, &os);
    Ok(super::devqueue::scrub_value(&snap, &known))
}

fn summary(uptime_secs: u64, host: &Value, services: &[Value], skills: &Value, stores: &[Value]) -> Value {
    json!({
        "uptimeSecs": uptime_secs,
        "cpuPct": host["cpuPct"],
        "memUsedMb": host["memUsedMb"],
        "memTotalMb": host["memTotalMb"],
        "gpuUtilPct": host["gpu"]["utilPct"],
        "vramUsedMb": host["gpu"]["vramUsedMb"],
        "vramTotalMb": host["gpu"]["vramTotalMb"],
        "servicesUp": services.iter().filter(|s| s["up"] == true).count(),
        "servicesTotal": services.len(),
        "skills": skills["total"],
        "storesOk": stores.iter().filter(|s| s["health"] == "ok").count(),
        "storesTotal": stores.len(),
    })
}

// ── Host ────────────────────────────────────────────────────────────────────

fn host_block(app: &tauri::AppHandle) -> Value {
    let sys = app.state::<super::system::SysState>();
    let (brand, threads) = super::system::cpu_info();
    let mut v = match super::system::sample(&sys) {
        Ok(s) => serde_json::to_value(s).unwrap_or(Value::Null),
        Err(e) => json!({ "error": e }),
    };
    if let Some(o) = v.as_object_mut() {
        o.insert("cpuBrand".into(), json!(brand));
        o.insert("cpuThreads".into(), json!(threads));
        if o.get("gpu").is_none_or(Value::is_null) {
            o.insert("gpuNote".into(), json!("no NVIDIA GPU reading (nvidia-smi missing or failed); AMD / Intel aren't probed"));
        }
    }
    v
}

// ── Agents ──────────────────────────────────────────────────────────────────

/// Is the agent on `slug` holding the GPU slot? Labels look like `"anythingllm · coder"`,
/// `"anythingllm · coder (streaming)"` or, for Tony's own turns, `"lmstudio · Tony"`.
pub(crate) fn role_active(labels: &[String], slug: &str, is_tony: bool) -> bool {
    labels.iter().any(|l| {
        let Some((_, who)) = l.rsplit_once(" · ") else { return false };
        let who = who.split(" (").next().unwrap_or(who).trim();
        (!slug.is_empty() && who == slug) || (is_tony && who == "Tony")
    })
}

async fn agents_block(st: &DispatchState, os: &OsState, osc: &OsConfig) -> (Vec<Value>, Option<String>) {
    let (workspaces, note) = match super::agents::fetch_workspaces(st, osc, PROBE_TIMEOUT.as_secs()).await {
        Ok(w) => (Some(w), None),
        Err(e) => (None, Some(format!("models unavailable: {e}"))),
    };
    let active = os.slot.view().active;
    let mut roles: Vec<(&String, &String)> = osc.anythingllm.workspaces.iter().collect();
    // Tony first, then the dispatcher's role order.
    let order = |r: &str| super::dispatch::ROLE_IDS.iter().position(|x| *x == r).unwrap_or(usize::MAX);
    roles.sort_by_key(|(r, _)| order(r.as_str()));
    let list = roles
        .into_iter()
        .map(|(role, slug)| {
            let is_tony = role == "general";
            let ws = workspaces.as_ref().and_then(|w| w.iter().find(|x| &x.slug == slug));
            json!({
                "role": role,
                "label": if is_tony { osc.os_name.clone() } else { super::agents::role_label(role) },
                "slug": slug,
                "found": workspaces.as_ref().map(|_| ws.is_some()),
                "threads": ws.map(|w| w.threads),
                "chatProvider": ws.and_then(|w| w.chat_provider.clone()),
                "chatModel": ws.and_then(|w| w.chat_model.clone()),
                "agentProvider": ws.and_then(|w| w.agent_provider.clone()),
                "agentModel": ws.and_then(|w| w.agent_model.clone()),
                "active": role_active(&active, slug, is_tony),
            })
        })
        .collect();
    (list, note)
}

// ── Rules ───────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Default)]
pub(crate) struct MdStats {
    pub lines: usize,
    pub headings: usize,
    pub bullets: usize,
    /// `## ` titles, in order (max 24).
    pub sections: Vec<String>,
}

fn is_bullet(t: &str) -> bool {
    if t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") {
        return true;
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && t[digits..].starts_with(". ")
}

/// Line, heading and bullet counts of a Markdown file (fenced code ignored).
pub(crate) fn md_stats(text: &str) -> MdStats {
    let mut s = MdStats::default();
    let mut fenced = false;
    for line in text.lines() {
        s.lines += 1;
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if line.starts_with('#') {
            let level = line.chars().take_while(|c| *c == '#').count();
            if level <= 6 && line[level..].starts_with(' ') {
                s.headings += 1;
                if level == 2 && s.sections.len() < 24 {
                    s.sections.push(line[level..].trim().chars().take(60).collect());
                }
            }
        } else if is_bullet(t) {
            s.bullets += 1;
        }
    }
    s
}

/// Bullets under the first heading whose title contains "Guardrails" (to the next heading of the same or higher level).
pub(crate) fn guardrail_count(text: &str) -> Option<usize> {
    let mut level = None;
    let mut n = 0;
    for line in text.lines() {
        let hashes = line.chars().take_while(|c| *c == '#').count();
        let heading = hashes > 0 && line[hashes..].starts_with(' ');
        match level {
            None if heading && line.to_ascii_lowercase().contains("guardrail") => level = Some(hashes),
            Some(l) if heading && hashes <= l => break,
            Some(_) if is_bullet(line.trim_start()) && !line.starts_with("  ") => n += 1,
            _ => {}
        }
    }
    level.map(|_| n)
}

fn file_meta(p: &Path) -> (Option<u64>, Option<u64>) {
    match std::fs::metadata(p) {
        Ok(m) => (Some(m.len()), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)),
        Err(_) => (None, None),
    }
}

fn rules_block(osc: &OsConfig, workdir: &Path) -> Value {
    let path = PathBuf::from(&osc.identity_path);
    let (identity, identity_error) = match std::fs::read_to_string(&path) {
        Ok(text) => {
            let (bytes, modified) = file_meta(&path);
            let s = md_stats(&text);
            (Some(json!({ "path": path.display().to_string(), "bytes": bytes, "modifiedMs": modified, "lines": s.lines, "headings": s.headings, "bullets": s.bullets, "sections": s.sections, "promptChars": text.chars().count().min(6000) })), None)
        }
        Err(e) => (None, Some(format!("{}: {e}", path.display()))),
    };
    let handoff = workdir.join("command center").join("HANDOFF.md");
    let (guardrails, guardrails_note) = match std::fs::read_to_string(&handoff) {
        Ok(t) => match guardrail_count(&t) {
            Some(n) => (Some(n), None),
            None => (None, Some("HANDOFF.md has no Guardrails section".to_string())),
        },
        Err(e) => (None, Some(format!("{}: {e}", handoff.display()))),
    };
    json!({
        "identity": identity,
        "identityError": identity_error,
        "rootDirective": osc.root_directive,
        "guardrails": guardrails,
        "guardrailsPath": handoff.display().to_string(),
        "guardrailsNote": guardrails_note,
    })
}

// ── Skills ──────────────────────────────────────────────────────────────────

/// `name` / `description` from SKILL.md frontmatter. Handles quoted values and YAML
/// block scalars (`description: >` / `|` followed by indented lines).
pub(crate) fn skill_meta(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let field = |key: &str| -> Option<String> {
        let i = body.iter().position(|l| l.split_once(':').is_some_and(|(k, _)| k.trim() == key && !l.starts_with(' ')))?;
        let raw = body[i].split_once(':')?.1.trim();
        let v = if matches!(raw, ">" | "|" | ">-" | "|-" | ">+" | "|+" | "") {
            body[i + 1..].iter().take_while(|l| l.starts_with(' ') || l.starts_with('\t') || l.trim().is_empty()).map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
        } else {
            raw.trim_matches('"').trim_matches('\'').to_string()
        };
        (!v.is_empty()).then_some(v)
    };
    (field("name"), field("description"))
}

fn read_head(p: &Path, n: u64) -> Option<String> {
    let mut buf = Vec::new();
    std::fs::File::open(p).ok()?.take(n).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// SKILL.md files under `root` (a folder holding SKILL.md is a skill; its subfolders
/// aren't searched). Depth- and count-bounded; returns whether the limit cut it short.
pub(crate) fn scan_skill_root(root: &Path, depth: usize, limit: usize, out: &mut Vec<(String, String, PathBuf)>) -> bool {
    fn walk(dir: &Path, depth: usize, limit: usize, out: &mut Vec<(String, String, PathBuf)>) -> bool {
        let Ok(rd) = std::fs::read_dir(dir) else { return false };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for d in dirs {
            if out.len() >= limit {
                return true;
            }
            let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let skill = d.join("SKILL.md");
            if skill.is_file() {
                let (n, desc) = read_head(&skill, 8192).map(|t| skill_meta(&t)).unwrap_or_default();
                out.push((n.unwrap_or(name), desc.unwrap_or_default(), skill));
            } else if depth > 1 && walk(&d, depth - 1, limit, out) {
                return true;
            }
        }
        false
    }
    walk(root, depth, limit, out)
}

fn skills_block(osc: &OsConfig, workdir: &Path) -> Value {
    skills_in(osc, workdir, &EXTRA_SKILL_ROOTS.map(PathBuf::from))
}

fn skills_in(osc: &OsConfig, workdir: &Path, extra_roots: &[PathBuf]) -> Value {
    let mut roots: Vec<PathBuf> = vec![PathBuf::from(&osc.skills.dir)];
    roots.extend(extra_roots.iter().cloned());
    roots.push(workdir.join("skills"));
    let mut seen: HashMap<PathBuf, String> = HashMap::new();
    let mut root_views = Vec::new();
    let mut items = Vec::new();
    let mut found_names = HashSet::new();
    for root in roots {
        let key = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        if let Some(first) = seen.get(&key) {
            // Same folder reached another way (a junction / symlink): shown, counted once.
            root_views.push(json!({ "path": root.display().to_string(), "exists": true, "count": 0, "truncated": false, "sameAs": first }));
            continue;
        }
        seen.insert(key, root.display().to_string());
        let exists = root.is_dir();
        let mut found = Vec::new();
        let left = SKILL_LIMIT.saturating_sub(items.len());
        let truncated = exists && scan_skill_root(&root, SKILL_DEPTH, left, &mut found);
        root_views.push(json!({ "path": root.display().to_string(), "exists": exists, "count": found.len(), "truncated": truncated }));
        for (name, desc, path) in found {
            // Grants are keyed by the skill's name or its folder name (they differ for e.g. `stitch::generate-design`).
            let folder = path.parent().and_then(Path::file_name).map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            let mut agents: Vec<String> = Vec::new();
            for key in [&name, &folder] {
                for a in osc.skills.grants.get(key).into_iter().flatten() {
                    if !agents.contains(a) {
                        agents.push(a.clone());
                    }
                }
            }
            found_names.insert(name.clone());
            found_names.insert(folder.clone());
            items.push(json!({
                "name": name,
                "folder": folder,
                "description": desc.chars().take(SKILL_DESC_MAX).collect::<String>(),
                "path": path.display().to_string(),
                "root": root.display().to_string(),
                "agents": agents,
            }));
        }
    }
    let granted_missing: Vec<&String> = osc.skills.grants.keys().filter(|n| !found_names.contains(*n)).collect();
    json!({ "total": items.len(), "roots": root_views, "items": items, "grantedMissing": granted_missing })
}

// ── Stores ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct TableCount {
    pub name: String,
    /// `None` when the count failed (e.g. a virtual table whose module isn't built in).
    pub rows: Option<i64>,
}

fn open_ro(path: &Path) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let c = rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| e.to_string())?;
    let _ = c.busy_timeout(Duration::from_millis(500));
    Ok(c)
}

/// User tables (FTS shadow tables folded into their virtual table) and their row counts,
/// at most `max`. Read-only open. Returns whether the list was cut short.
pub(crate) fn sqlite_tables(path: &Path, max: usize) -> Result<(Vec<TableCount>, bool), String> {
    let c = open_ro(path)?;
    let mut stmt = c.prepare("SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(|e| e.to_string())?;
    let all: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.flatten().collect();
    let virtuals: Vec<String> = all.iter().filter(|(_, sql)| sql.trim_start().to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE")).map(|(n, _)| format!("{n}_")).collect();
    let names: Vec<&String> = all.iter().map(|(n, _)| n).filter(|n| !virtuals.iter().any(|v| n.starts_with(v.as_str()))).collect();
    let truncated = names.len() > max;
    let out = names
        .into_iter()
        .take(max)
        .map(|n| TableCount { name: n.clone(), rows: c.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", n.replace('"', "\"\"")), [], |r| r.get(0)).ok() })
        .collect();
    Ok((out, truncated))
}

fn sqlite_scalar(path: &Path, sql: &str) -> Option<i64> {
    open_ro(path).ok()?.query_row(sql, [], |r| r.get(0)).ok()
}

/// Lines in a file (bounded read).
pub(crate) fn count_lines(path: &Path, max_bytes: u64) -> std::io::Result<usize> {
    let f = std::fs::File::open(path)?;
    Ok(std::io::BufReader::new(f.take(max_bytes)).split(b'\n').filter(|l| l.as_ref().is_ok_and(|l| !l.iter().all(u8::is_ascii_whitespace))).count())
}

/// Entities in a knowledge-graph file: `{entities: [...]}` JSON or the MCP memory server's JSONL.
pub(crate) fn kg_entities(raw: &str) -> usize {
    match serde_json::from_str::<Value>(raw) {
        Ok(v) => v["entities"].as_array().map_or(0, Vec::len),
        Err(_) => raw.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["type"] == "entity").count(),
    }
}

fn store_base(id: &str, label: &str, kind: &str, path: &Path) -> serde_json::Map<String, Value> {
    let (bytes, modified) = file_meta(path);
    let writable = std::fs::metadata(path).ok().map(|m| !m.permissions().readonly());
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(id));
    m.insert("label".into(), json!(label));
    m.insert("kind".into(), json!(kind));
    m.insert("path".into(), json!(path.display().to_string()));
    m.insert("exists".into(), json!(bytes.is_some()));
    m.insert("bytes".into(), json!(bytes));
    m.insert("modifiedMs".into(), json!(modified));
    m.insert("writable".into(), json!(writable));
    m.insert("tables".into(), json!([]));
    m.insert("metrics".into(), json!({}));
    m
}

fn sqlite_store(id: &str, label: &str, path: &Path, extra: impl FnOnce(&Path, &mut serde_json::Map<String, Value>)) -> Value {
    let mut m = store_base(id, label, "sqlite", path);
    if m["exists"] != true {
        m.insert("health".into(), json!("missing"));
        m.insert("error".into(), json!(format!("not found: {}", path.display())));
        return Value::Object(m);
    }
    match sqlite_tables(path, MAX_TABLES) {
        Ok((tables, truncated)) => {
            m.insert("health".into(), json!("ok"));
            m.insert("tables".into(), json!(tables));
            m.insert("tablesTruncated".into(), json!(truncated));
            let mut metrics = serde_json::Map::new();
            extra(path, &mut metrics);
            m.insert("metrics".into(), Value::Object(metrics));
        }
        Err(e) => {
            m.insert("health".into(), json!("error"));
            m.insert("error".into(), json!(e));
        }
    }
    Value::Object(m)
}

fn stores_block(config_dir: Option<&Path>, workdir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    match config_dir {
        Some(d) => out.push(sqlite_store("devqueue", "Dev task queue", &d.join("devqueue.db"), |_, _| {})),
        None => out.push(json!({ "id": "devqueue", "label": "Dev task queue", "kind": "sqlite", "exists": false, "health": "missing", "error": "app config dir unknown", "tables": [], "metrics": {} })),
    }
    out.push(sqlite_store("cc", "Gateway store (cc.db)", &workdir.join("data").join("command-center").join("cc.db"), |p, m| {
        // RAG vectors = vault rows that carry an embedding (what /api/cc/health reports as `embedded`).
        m.insert("ragVectors".into(), json!(sqlite_scalar(p, "SELECT COUNT(*) FROM vault WHERE vector IS NOT NULL")));
        m.insert("vaultItems".into(), json!(sqlite_scalar(p, "SELECT COUNT(*) FROM vault")));
    }));
    out.push(sqlite_store("memory", "Memory FTS (memory.db)", &workdir.join("data").join("memory.db"), |_, _| {}));
    match super::gmail::anythingllm_db_path() {
        Some(p) => out.push(sqlite_store("anythingllm", "AnythingLLM (anythingllm.db)", &p, |_, _| {})),
        None => out.push(json!({ "id": "anythingllm", "label": "AnythingLLM (anythingllm.db)", "kind": "sqlite", "exists": false, "health": "missing", "error": "%APPDATA% is not set", "tables": [], "metrics": {} })),
    }

    // Synaptic training log: today's (UTC, as BridgeState::log names it) JSONL.
    let dir = workdir.join("training_logs");
    let today = dir.join(format!("pipelines-{}.jsonl", chrono::Utc::now().format("%Y-%m-%d")));
    let mut m = store_base("training-logs", "Training log (today)", "jsonl", &today);
    let files = std::fs::read_dir(&dir).map(|rd| rd.flatten().take(5000).filter(|e| e.path().extension().is_some_and(|x| x == "jsonl")).count()).ok();
    match count_lines(&today, MAX_LINES_BYTES) {
        Ok(n) => {
            m.insert("health".into(), json!("ok"));
            m.insert("metrics".into(), json!({ "todayLines": n, "files": files }));
        }
        Err(e) => {
            m.insert("health".into(), json!("missing"));
            m.insert("error".into(), json!(format!("no log written today yet ({e})")));
            m.insert("metrics".into(), json!({ "todayLines": Value::Null, "files": files }));
        }
    }
    out.push(Value::Object(m));

    // Knowledge graph (`kg.search` reads it). Reported missing honestly.
    let kg = PathBuf::from(super::mcp::KG_PATH);
    let mut m = store_base("knowledge-graph", "Knowledge graph", "json", &kg);
    if m["exists"] == true {
        let entities = (m["bytes"].as_u64().unwrap_or(0) <= KG_PARSE_MAX).then(|| std::fs::read_to_string(&kg).ok().map(|t| kg_entities(&t))).flatten();
        m.insert("health".into(), json!("ok"));
        m.insert("metrics".into(), json!({ "entities": entities }));
    } else {
        m.insert("health".into(), json!("missing"));
        m.insert("error".into(), json!(format!("{} does not exist — kg.search has nothing to read", kg.display())));
    }
    out.push(Value::Object(m));
    out
}

// ── Routines (gateway scheduler, n8n) ───────────────────────────────────────

/// Gateway `/api/scheduler/jobs` (optional: the gateway may be down).
async fn scheduler_jobs(st: &DispatchState, osc: &OsConfig) -> Result<Vec<Value>, String> {
    let url = format!("{}/api/scheduler/jobs", st.snapshot().gateway.url.trim_end_matches('/'));
    let mut rb = st.http.get(url).timeout(PROBE_TIMEOUT);
    if let Some(t) = os_core::mesh_bearer(osc) {
        rb = rb.bearer_auth(t);
    }
    let r = rb.send().await.map_err(|e| format!("gateway unreachable ({})", super::dispatch::short(e)))?;
    if !r.status().is_success() {
        return Err(format!("gateway HTTP {}", r.status().as_u16()));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .take(100)
        .map(|j| json!({ "id": j["id"], "name": j["name"], "skill": j["skill"], "cron": j["cron"], "enabled": j["enabled"], "lastRun": j["last_run"], "nextRun": j["next_run"] }))
        .collect())
}

/// Workflows from the local n8n API — only for instances that have an API key; others
/// are listed with why there's nothing to show. Remote instances are left to Pipelines.
async fn n8n_block(st: &DispatchState) -> (Vec<Value>, Option<String>) {
    let instances: Vec<_> = st.snapshot().providers.into_iter().filter(|p| p.kind == Kind::N8n).collect();
    if instances.is_empty() {
        return (vec![], Some("no n8n instance configured".into()));
    }
    let empty = HashMap::new();
    let polls = instances.into_iter().map(|p| {
        let empty = &empty;
        async move {
            if os_core::is_remote(&p) {
                return json!({ "id": p.id, "label": p.label, "status": "skipped", "detail": "remote instance — see Pipelines", "workflows": [] });
            }
            if super::secrets::get_slot(st, &p.id, "api").is_none() {
                return json!({ "id": p.id, "label": p.label, "status": "no-key", "detail": "no n8n API key — add it in Settings → Pipelines to list workflows", "workflows": [] });
            }
            let (id, label) = (p.id.clone(), p.label.clone());
            match tokio::time::timeout(N8N_TIMEOUT, super::pipelines::poll_instance(st, p, empty)).await {
                Ok(i) => {
                    let v = serde_json::to_value(i).unwrap_or(Value::Null);
                    let wfs: Vec<Value> = v["workflows"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|w| json!({ "name": w["name"], "active": w["isActive"], "lastStatus": w["lastStatus"], "lastRun": w["lastRunTimestamp"] }))
                        .collect();
                    json!({ "id": id, "label": label, "status": v["status"], "detail": v["detail"], "workflows": wfs })
                }
                Err(_) => json!({ "id": id, "label": label, "status": "error", "detail": format!("timed out ({} s)", N8N_TIMEOUT.as_secs()), "workflows": [] }),
            }
        }
    });
    (futures_util::future::join_all(polls).await, None)
}

// ── Bus ─────────────────────────────────────────────────────────────────────

/// Every MCP server / direct API from cached data (no network): status, tool count,
/// call stats, plus where the Brave / Gmail / Spotify credentials come from (names only).
fn bus_block(st: &DispatchState, os: &OsState) -> Vec<Value> {
    let mut bus = super::mcp::cached_statuses(st, os);
    for v in bus.iter_mut() {
        let source = match v["id"].as_str() {
            Some("brave-search") => Some(super::mcp::brave_source(st).to_string()),
            Some("gmail") => Some(super::gmail::source_label(st)),
            Some("spotify") => Some(match super::spotify::readiness(st) {
                Ok(()) => "env + keychain".to_string(),
                Err(_) => "none".to_string(),
            }),
            _ => None,
        };
        if let Some(s) = source {
            v["source"] = json!(s);
        }
    }
    bus
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("introspect-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn cache_freshness() {
        assert!(is_fresh(1_000, 1_000, false));
        assert!(is_fresh(1_000, 1_000 + TTL_MS - 1, false));
        assert!(!is_fresh(1_000, 1_000 + TTL_MS, false));
        assert!(!is_fresh(1_000, 1_001, true), "deep always rebuilds");
        // A clock that went backwards doesn't make the cache stale forever or panic.
        assert!(is_fresh(5_000, 1_000, false));
    }

    #[test]
    fn loop_overdue_rules() {
        // Ran 5 s ago on a 3 s loop: fine (grace = 3*3+10 = 19 s).
        assert!(!loop_overdue(Some(100_000), 105_000, 3, 600));
        assert!(loop_overdue(Some(100_000), 120_000, 3, 600));
        // Never ran: only overdue once the app has been up past the grace.
        assert!(!loop_overdue(None, 0, 300, 60));
        assert!(loop_overdue(None, 0, 300, 2_000));
    }

    #[test]
    fn loop_registry_records_runs() {
        loop_ran("test-loop", true, "first");
        loop_ran("test-loop", false, &"x".repeat(400));
        let r = RUNS.lock().unwrap().get("test-loop").cloned().unwrap();
        assert_eq!(r.runs, 2);
        assert!(!r.ok);
        assert_eq!(r.detail.len(), 160);
        let view = loops_view(now_ms(), 0);
        assert_eq!(view.len(), LOOPS.len());
        assert!(view.iter().all(|l| l.id != "test-loop"), "only the declared loops are shown");
    }

    #[test]
    fn uptime_counts_from_start() {
        mark_started();
        let a = app_uptime();
        assert!(a.started_at > 0 && a.started_at <= now_ms());
    }

    #[test]
    fn frontmatter_name_and_description() {
        let plain = "---\nname: animate\ndescription: \"Build an animation: from scratch\"\n---\n# Body";
        assert_eq!(skill_meta(plain), (Some("animate".into()), Some("Build an animation: from scratch".into())));
        let folded = "---\nname: 'pdf'\ndescription: >\n  Read and write PDFs.\n  Also forms.\nlicense: MIT\n---\n";
        assert_eq!(skill_meta(folded), (Some("pdf".into()), Some("Read and write PDFs. Also forms.".into())));
        let nested = "---\nmetadata:\n  name: inner\nname: outer\n---\n";
        assert_eq!(skill_meta(nested).0.as_deref(), Some("outer"));
        assert_eq!(skill_meta("# no frontmatter\nname: x"), (None, None));
        assert_eq!(skill_meta("---\nname:\n---\n"), (None, None));
    }

    #[test]
    fn skill_scan_is_bounded_and_skips_nested() {
        let root = tmp_dir("skills");
        for (dir, body) in [("a", "---\nname: alpha\ndescription: first\n---\n"), ("b", "no frontmatter"), ("group/c", "---\nname: gamma\n---\n"), ("a/inner", "---\nname: hidden\n---\n"), (".git/x", "---\nname: dot\n---\n")] {
            let d = root.join(dir);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), body).unwrap();
        }
        let mut out = Vec::new();
        assert!(!scan_skill_root(&root, 4, 100, &mut out));
        let names: Vec<&str> = out.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(names, vec!["alpha", "b", "gamma"], "folder name is the fallback; skills inside a skill and dot-dirs are skipped");
        assert_eq!(out[0].1, "first");
        let mut shallow = Vec::new();
        scan_skill_root(&root, 1, 100, &mut shallow);
        assert_eq!(shallow.len(), 2, "depth 1 doesn't reach group/c");
        let mut capped = Vec::new();
        assert!(scan_skill_root(&root, 4, 1, &mut capped));
        assert_eq!(capped.len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn skills_join_grants_by_name_or_folder_and_dedupe_roots() {
        let root = tmp_dir("skillroot");
        for (dir, body) in [("stitch-x", "---
name: stitch::x
description: d
---
"), ("plain", "---
name: plain
---
")] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("SKILL.md"), body).unwrap();
        }
        let mut osc = OsConfig::default();
        osc.skills.dir = root.display().to_string();
        osc.skills.grants.insert("stitch-x".into(), vec!["designer".into()]);
        osc.skills.grants.insert("plain".into(), vec!["coder".into(), "designer".into()]);
        osc.skills.grants.insert("gone".into(), vec!["ops".into()]);
        // A separate workdir without a skills/ folder.
        let work = tmp_dir("skillwork");
        let v = skills_in(&osc, &work, &[]);
        let items = v["items"].as_array().unwrap();
        let x = items.iter().find(|i| i["name"] == "stitch::x").unwrap();
        assert_eq!(x["folder"], "stitch-x");
        assert_eq!(x["agents"], json!(["designer"]));
        assert_eq!(items.iter().find(|i| i["name"] == "plain").unwrap()["agents"], json!(["coder", "designer"]));
        assert_eq!(v["grantedMissing"], json!(["gone"]));
        assert_eq!(v["total"], 2);
        // Listing the same folder twice (the configured dir doubles as <workdir>/skills) counts it once.
        let mut osc2 = osc.clone();
        osc2.skills.dir = work.join("skills").display().to_string();
        std::fs::create_dir_all(work.join("skills").join("one")).unwrap();
        std::fs::write(work.join("skills").join("one").join("SKILL.md"), "---
name: one
---
").unwrap();
        let v2 = skills_in(&osc2, &work, &[]);
        assert_eq!(v2["total"], 1);
        assert!(v2["roots"].as_array().unwrap().iter().any(|r| r["sameAs"].is_string()));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(work);
    }

    #[test]
    fn identity_and_guardrail_stats() {
        let md = "# Title\nintro\n## CORE\n- one\n- two\n  - nested\n```\n# not a heading\n- not a bullet\n```\n## GOALS\n1. first\n#hashtag\n### Sub\n* star\n";
        let s = md_stats(md);
        assert_eq!(s.headings, 4);
        assert_eq!(s.bullets, 5);
        assert_eq!(s.sections, vec!["CORE", "GOALS"]);
        assert_eq!(s.lines, md.lines().count());

        let handoff = "## 7. Fixes\n- a\n## 8. Guardrails\n- No mutating plan without approve().\n- Finance stays local.\n  continued line\n- Respect reduced motion.\n### Notes\n- after a subheading\n## 9. Next\n- not counted\n";
        // Sub-headings stay inside the section; the next `##` ends it.
        assert_eq!(guardrail_count(handoff), Some(4));
        assert_eq!(guardrail_count("# Nothing here\n- x"), None);
    }

    #[test]
    fn sqlite_counts_on_temp_dbs() {
        let dir = tmp_dir("sqlite");
        let p = dir.join("t.db");
        {
            let c = rusqlite::Connection::open(&p).unwrap();
            c.pragma_update(None, "journal_mode", "WAL").unwrap();
            c.execute_batch(
                "CREATE TABLE vault(item_id TEXT PRIMARY KEY, vector BLOB);
                 INSERT INTO vault VALUES ('a', x'00'), ('b', NULL), ('c', x'01');
                 CREATE TABLE \"we\"\"ird\"(x);
                 INSERT INTO \"we\"\"ird\" VALUES (1);
                 CREATE VIRTUAL TABLE memory_fts USING fts5(body);
                 INSERT INTO memory_fts VALUES ('hello');",
            )
            .unwrap();
        }
        let (tables, truncated) = sqlite_tables(&p, 10).unwrap();
        assert!(!truncated);
        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["memory_fts", "vault", "we\"ird"], "FTS shadow tables are folded away");
        assert_eq!(tables.iter().find(|t| t.name == "vault").unwrap().rows, Some(3));
        assert_eq!(tables.iter().find(|t| t.name == "we\"ird").unwrap().rows, Some(1));
        assert_eq!(sqlite_scalar(&p, "SELECT COUNT(*) FROM vault WHERE vector IS NOT NULL"), Some(2));
        let (cut, truncated) = sqlite_tables(&p, 1).unwrap();
        assert!(truncated && cut.len() == 1);
        // Read-only: a write through the same open path fails.
        assert!(open_ro(&p).unwrap().execute("INSERT INTO vault VALUES ('d', NULL)", []).is_err());
        assert!(sqlite_tables(&dir.join("missing.db"), 10).is_err());

        let store = sqlite_store("t", "T", &p, |p, m| {
            m.insert("ragVectors".into(), json!(sqlite_scalar(p, "SELECT COUNT(*) FROM vault WHERE vector IS NOT NULL")));
        });
        assert_eq!(store["health"], "ok");
        assert_eq!(store["metrics"]["ragVectors"], 2);
        let missing = sqlite_store("m", "M", &dir.join("nope.db"), |_, _| {});
        assert_eq!(missing["health"], "missing");
        assert_eq!(missing["exists"], false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn line_and_entity_counts() {
        let dir = tmp_dir("lines");
        let p = dir.join("log.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":2}\n\n{\"c\":3}").unwrap();
        assert_eq!(count_lines(&p, 1024).unwrap(), 3);
        assert_eq!(count_lines(&p, 8).unwrap(), 1, "bounded read");
        assert!(count_lines(&dir.join("none.jsonl"), 1024).is_err());
        assert_eq!(kg_entities("{\"entities\":[{\"name\":\"a\"},{\"name\":\"b\"}]}"), 2);
        assert_eq!(kg_entities("{\"type\":\"entity\",\"name\":\"a\"}\n{\"type\":\"relation\"}\n{\"type\":\"entity\"}"), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn active_roles_from_slot_labels() {
        let labels = vec!["anythingllm · coder (streaming)".to_string(), "lmstudio · Tony".to_string()];
        assert!(role_active(&labels, "coder", false));
        assert!(!role_active(&labels, "code", false));
        assert!(!role_active(&labels, "designer", false));
        assert!(role_active(&labels, "my-workspace", true), "Tony's own turn");
        assert!(!role_active(&["anythingllm · booking".to_string()], "my-workspace", true));
        assert!(role_active(&["anythingllm · my-workspace".to_string()], "my-workspace", true));
        assert!(!role_active(&[], "coder", false));
    }

    #[test]
    fn workspace_models_parsed_without_extras() {
        let v = json!({ "workspaces": [
            { "slug": "coder", "name": "Coder", "threads": [{}, {}], "chatProvider": "lmstudio", "chatModel": "qwen/qwen3.5-9b", "agentModel": "qwen2.5-coder-14b-instruct", "openAiPrompt": "secret system prompt" },
            { "slug": "ops", "name": "Ops", "chatModel": null, "chatProvider": "  " }
        ]});
        let w = super::super::agents::parse_workspaces(&v);
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].threads, w[0].chat_model.as_deref(), w[0].agent_model.as_deref(), w[0].agent_provider.as_deref()), (2, Some("qwen/qwen3.5-9b"), Some("qwen2.5-coder-14b-instruct"), None));
        assert_eq!((w[1].chat_model.as_deref(), w[1].chat_provider.as_deref()), (None, None), "null / blank = system default");
        assert!(!serde_json::to_string(&w).unwrap().contains("secret system prompt"));
        assert!(super::super::agents::parse_workspaces(&json!({})).is_empty());
    }

    #[test]
    fn cpu_info_reads_threads() {
        assert!(super::super::system::cpu_info().1 > 0);
    }

    /// Reads the real stores / skills / rules on this machine (no network). `cargo test -- --ignored live_local_blocks --nocapture`
    #[test]
    #[ignore]
    fn live_local_blocks() {
        let appdata = PathBuf::from(std::env::var_os("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let osc: OsConfig = serde_json::from_str(&std::fs::read_to_string(appdata.join("os.json")).unwrap()).unwrap();
        let workdir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        println!("cpu {:?}", super::super::system::cpu_info());
        for s in stores_block(Some(&appdata), &workdir) {
            println!("store {} {} {} tables={} metrics={}", s["id"], s["health"], s["error"], s["tables"].as_array().map_or(0, Vec::len), s["metrics"]);
        }
        let sk = skills_block(&osc, &workdir);
        println!("skills total={} roots={} missing={}", sk["total"], sk["roots"], sk["grantedMissing"]);
        let r = rules_block(&osc, &workdir);
        println!("rules identity bytes={} headings={} bullets={} guardrails={} note={}", r["identity"]["bytes"], r["identity"]["headings"], r["identity"]["bullets"], r["guardrails"], r["guardrailsNote"]);
    }

    #[test]
    fn summary_counts() {
        let host = json!({ "cpuPct": 12.0, "memUsedMb": 1, "memTotalMb": 2, "gpu": { "utilPct": 5.0, "vramUsedMb": 3, "vramTotalMb": 4 } });
        let services = vec![json!({ "up": true }), json!({ "up": false })];
        let stores = vec![json!({ "health": "ok" }), json!({ "health": "missing" }), json!({ "health": "ok" })];
        let s = summary(9, &host, &services, &json!({ "total": 7 }), &stores);
        assert_eq!(s["servicesUp"], 1);
        assert_eq!(s["servicesTotal"], 2);
        assert_eq!(s["storesOk"], 2);
        assert_eq!(s["skills"], 7);
        assert_eq!(s["vramTotalMb"], 4);
        let no_gpu = summary(9, &json!({ "gpu": null }), &[], &json!({}), &[]);
        assert!(no_gpu["gpuUtilPct"].is_null());
    }
}
