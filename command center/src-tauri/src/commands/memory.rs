//! RAG memory lifecycle: Harvest → Condense → Fine-tune dataset → Locked vault,
//! then (optionally) flush the remote cache, and mount / unmount condensed
//! Memory Books back into AnythingLLM when they're needed.
//!
//!   A. Pull & verify  — AnythingLLM chats (each mapped workspace + Tony's
//!      monthly threads), the month's training logs, droplet Qdrant cache
//!      payloads; bundled and SHA-256'd.
//!   B. Condense       — the local model distils the month into a Memory Book
//!      (summary_YYYY_MM.md) + a searchable ledger (ledger_YYYY_MM.json).
//!   C. Dataset        — deduplicated instruction pairs (ChatML / Alpaca /
//!      ShareGPT) in finetune_dataset_YYYY_MM.jsonl for Unsloth / LM Studio.
//!   D. Vault          — everything lands in `<vault>/YYYY-MM/`. With a vault
//!      password set (OS keychain), content files are AES-256-GCM encrypted
//!      (key = PBKDF2-SHA256, 600k rounds); the ledger stays readable metadata.
//!
//! Flushing remote data is destructive: it requires the backup's checksum to
//! re-verify and the destructive-action gate (confirmation card).

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

use super::agents::allm;
use super::bridge::BridgeState;
use super::dispatch::{run_chat, short, ChatMessage, DispatchState, Priority};
use super::os_core::{self, OsConfig, OsState};

// ── Crypto ──────────────────────────────────────────────────────────────────

const MAGIC: &[u8; 5] = b"AOSV1";
const ROUNDS: u32 = 600_000;

fn derive(pass: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(pass.as_bytes(), salt, ROUNDS, &mut key);
    key
}

pub fn seal(data: &[u8], pass: &str) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::rand_core::RngCore;
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive(pass, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher.encrypt(&nonce, data).map_err(|_| "encryption failed")?;
    let mut out = Vec::with_capacity(5 + 16 + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open(data: &[u8], pass: &str) -> Result<Vec<u8>, String> {
    if data.len() < 33 || &data[..5] != MAGIC {
        return Err("not a vault file".into());
    }
    let key = derive(pass, &data[5..21]);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher.decrypt(Nonce::from_slice(&data[21..33]), &data[33..]).map_err(|_| "wrong vault password or corrupted file".into())
}

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Write `name` (or `name.enc` when a vault password is set). Returns the file name.
fn vault_write(dir: &Path, name: &str, data: &[u8], pass: Option<&str>) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (fname, bytes) = match pass {
        Some(p) => (format!("{name}.enc"), seal(data, p)?),
        None => (name.to_string(), data.to_vec()),
    };
    std::fs::write(dir.join(&fname), bytes).map_err(|e| e.to_string())?;
    Ok(fname)
}

fn vault_read(dir: &Path, fname: &str) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(dir.join(fname)).map_err(|e| format!("{fname}: {e}"))?;
    if fname.ends_with(".enc") {
        let pass = os_core::os_secret("vault").ok_or("this archive is locked — set the vault password in Settings")?;
        open(&raw, &pass)
    } else {
        Ok(raw)
    }
}

// ── Ledger ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Mount {
    pub target: String,
    pub workspace: String,
    pub location: String,
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LedgerEntry {
    pub id: String,
    pub month: String,
    pub created_at: u64,
    pub sha256: String,
    pub verified: bool,
    pub encrypted: bool,
    pub records: usize,
    pub pairs: usize,
    pub summary_tokens: usize,
    pub agents: Vec<String>,
    pub sources: BTreeMap<String, usize>,
    pub files: BTreeMap<String, String>,
    pub mounts: Vec<Mount>,
    pub flushed_at: Option<u64>,
    pub condensed_by: String,
    pub notes: Vec<String>,
    /// Section headings of the Memory Book — the searchable index.
    pub topics: Vec<String>,
}

fn vault_dir(cfg: &OsConfig) -> PathBuf {
    PathBuf::from(&cfg.memory.vault_dir)
}

fn ledger_path(cfg: &OsConfig, month: &str) -> PathBuf {
    vault_dir(cfg).join(month).join(format!("ledger_{}.json", month.replace('-', "_")))
}

fn save_ledger(cfg: &OsConfig, l: &LedgerEntry) -> Result<(), String> {
    let p = ledger_path(cfg, &l.month);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_string_pretty(l).unwrap()).map_err(|e| e.to_string())
}

fn load_ledger(cfg: &OsConfig, month: &str) -> Result<LedgerEntry, String> {
    let s = std::fs::read_to_string(ledger_path(cfg, month)).map_err(|_| format!("no Memory Book for {month}"))?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_ledger(os: State<'_, OsState>) -> Vec<LedgerEntry> {
    let cfg = os.snapshot();
    let mut out: Vec<LedgerEntry> = std::fs::read_dir(vault_dir(&cfg))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| load_ledger(&cfg, &e.file_name().to_string_lossy()).ok())
        .collect();
    out.sort_by(|a, b| b.month.cmp(&a.month));
    out
}

fn valid_month(m: &str) -> bool {
    m.len() == 7 && m.as_bytes()[4] == b'-' && m[..4].chars().all(|c| c.is_ascii_digit()) && m[5..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n))
}

fn month_bounds(month: &str) -> (i64, i64) {
    use chrono::{Datelike, Local, NaiveDate, TimeZone};
    let y: i32 = month[..4].parse().unwrap_or(1970);
    let m: u32 = month[5..].parse().unwrap_or(1);
    let start = NaiveDate::from_ymd_opt(y, m, 1).unwrap();
    let end = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) }.unwrap();
    let ts = |d: NaiveDate| Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).single().map(|t| t.timestamp()).unwrap_or(0);
    let _ = start.year();
    (ts(start), ts(end))
}

pub fn previous_month() -> String {
    use chrono::{Datelike, Local};
    let now = Local::now();
    let (y, m) = if now.month() == 1 { (now.year() - 1, 12) } else { (now.year(), now.month() - 1) };
    format!("{y:04}-{m:02}")
}

// ── Harvest ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    step: String,
    detail: String,
}

fn progress(app: &Option<tauri::AppHandle>, step: &str, detail: impl Into<String>) {
    if let Some(a) = app {
        let _ = a.emit("memory-progress", Progress { step: step.into(), detail: detail.into() });
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Record {
    source: String,
    agent: String,
    role: String,
    content: String,
    at: i64,
}

#[allow(clippy::too_many_arguments)]
async fn pull_allm(state: &DispatchState, base: &str, key: &str, slug: &str, thread_name: &str, (from, to): (i64, i64), agent: &str, label: &str, out: &mut Vec<Record>) -> Result<usize, String> {
    let mut n = 0;
    let mut push = |v: &Value, source: &str, out: &mut Vec<Record>| {
        for h in v["history"].as_array().into_iter().flatten() {
            let at = h["sentAt"].as_i64().unwrap_or(0);
            if at != 0 && (at < from || at >= to) {
                continue;
            }
            let content = h["content"].as_str().unwrap_or("").trim();
            if content.is_empty() {
                continue;
            }
            out.push(Record { source: source.into(), agent: agent.into(), role: h["role"].as_str().unwrap_or("user").into(), content: content.into(), at });
            n += 1;
        }
    };
    let v = allm(state, base, key, reqwest::Method::GET, &format!("/v1/workspace/{slug}/chats?limit=2000&orderBy=asc"), None, 20).await?;
    push(&v, &format!("{label}:{slug}"), out);
    let ws = allm(state, base, key, reqwest::Method::GET, &format!("/v1/workspace/{slug}"), None, 10).await.unwrap_or(Value::Null);
    let ws = if ws["workspace"].is_array() { ws["workspace"][0].clone() } else { ws["workspace"].clone() };
    for t in ws["threads"].as_array().into_iter().flatten() {
        if t["name"].as_str() == Some(thread_name) {
            if let Some(ts) = t["slug"].as_str() {
                if let Ok(v) = allm(state, base, key, reqwest::Method::GET, &format!("/v1/workspace/{slug}/thread/{ts}/chats"), None, 20).await {
                    push(&v, &format!("{label}:{slug}/{ts}"), out);
                }
            }
        }
    }
    Ok(n)
}

fn pull_training_logs(repo: &Path, month: &str, out: &mut Vec<Record>) -> usize {
    let mut n = 0;
    let dir = repo.join("training_logs");
    let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.contains(month) || !name.ends_with(".jsonl") {
            continue;
        }
        for line in std::fs::read_to_string(e.path()).unwrap_or_default().lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let at = v["ts"].as_i64().map(|t| t / 1000).unwrap_or(0);
            if v["type"] == "os-turn" {
                let agent = v["role"].as_str().unwrap_or("general").to_string();
                out.push(Record { source: format!("training_logs/{name}"), agent: agent.clone(), role: "user".into(), content: v["upstream"].as_str().unwrap_or("").into(), at });
                out.push(Record { source: format!("training_logs/{name}"), agent, role: "assistant".into(), content: v["downstream"].as_str().unwrap_or("").into(), at });
                n += 2;
            } else {
                out.push(Record { source: format!("training_logs/{name}"), agent: "system".into(), role: "event".into(), content: v.to_string(), at });
                n += 1;
            }
        }
    }
    n
}

async fn pull_qdrant(state: &DispatchState, base: &str, coll: &str, out: &mut Vec<Record>) -> Result<usize, String> {
    let mut offset = Value::Null;
    let mut n = 0;
    for _ in 0..20 {
        let v: Value = state
            .http
            .post(format!("{}/collections/{coll}/points/scroll", base.trim_end_matches('/')))
            .json(&json!({ "limit": 256, "with_payload": true, "with_vector": false, "offset": offset }))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(short)?
            .error_for_status()
            .map_err(short)?
            .json()
            .await
            .map_err(short)?;
        for p in v["result"]["points"].as_array().into_iter().flatten() {
            out.push(Record { source: format!("qdrant:{coll}"), agent: "droplet".into(), role: "vector".into(), content: p["payload"].to_string(), at: 0 });
            n += 1;
        }
        offset = v["result"]["next_page_offset"].clone();
        if offset.is_null() {
            break;
        }
    }
    Ok(n)
}

/// User/assistant pairs in order, per agent.
fn pairs(records: &[Record]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut by_source: BTreeMap<&str, Vec<&Record>> = BTreeMap::new();
    for r in records.iter().filter(|r| r.role == "user" || r.role == "assistant") {
        by_source.entry(r.source.as_str()).or_default().push(r);
    }
    for recs in by_source.values() {
        let mut pending: Option<&Record> = None;
        for r in recs {
            match (r.role.as_str(), pending) {
                ("user", _) => pending = Some(r),
                ("assistant", Some(u)) => {
                    out.push((u.agent.clone(), u.content.clone(), r.content.clone()));
                    pending = None;
                }
                _ => {}
            }
        }
    }
    out
}

fn low_signal(a: &str) -> bool {
    let l = a.to_lowercase();
    a.trim().len() < 20
        || ["i am unable", "i'm unable", "i don't have access", "i do not have access", "as an ai", "unreachable", "timed out", "all providers failed", "error:"].iter().any(|p| l.contains(p))
}

fn dataset(cfg: &OsConfig, prs: &[(String, String, String)]) -> (String, usize) {
    let mut seen = HashSet::new();
    let sys = format!("You are {}, the user's personal AI operating system.", cfg.os_name);
    let mut lines = Vec::new();
    for (_, u, a) in prs {
        if u.trim().len() < 4 || low_signal(a) {
            continue;
        }
        let norm = format!("{}\u{1}{}", u.trim().to_lowercase(), a.trim().to_lowercase());
        if !seen.insert(sha256_hex(norm.as_bytes())) {
            continue;
        }
        let v = match cfg.memory.dataset_format.as_str() {
            "alpaca" => json!({ "instruction": u.trim(), "input": "", "output": a.trim() }),
            "sharegpt" => json!({ "conversations": [{ "from": "system", "value": sys }, { "from": "human", "value": u.trim() }, { "from": "gpt", "value": a.trim() }] }),
            _ => json!({ "messages": [{ "role": "system", "content": sys }, { "role": "user", "content": u.trim() }, { "role": "assistant", "content": a.trim() }] }),
        };
        lines.push(v.to_string());
    }
    let n = lines.len();
    (lines.join("\n") + if n > 0 { "\n" } else { "" }, n)
}

const BOOK_SECTIONS: &str = "## Key facts\n## Client & contact preferences\n## Booking rules & availability\n## Code patterns & fixes\n## High-performing prompts\n## Open threads & follow-ups";

async fn condense(state: &DispatchState, os: &OsState, month: &str, prs: &[(String, String, String)], app: &Option<tauri::AppHandle>) -> (String, String) {
    if prs.is_empty() {
        return (format!("# Memory Book — {month}\n\nNo conversations were recorded this month.\n"), "none".into());
    }
    let transcript: Vec<String> = prs.iter().map(|(ag, u, a)| format!("[{ag}] USER: {}\n[{ag}] ASSISTANT: {}", u.chars().take(1200).collect::<String>(), a.chars().take(1800).collect::<String>())).collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for t in transcript {
        if cur.len() + t.len() > 10_000 && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push_str(&t);
        cur.push_str("\n\n");
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks.truncate(16);
    let mut notes = Vec::new();
    let mut by = String::new();
    for (i, c) in chunks.iter().enumerate() {
        progress(app, "condense", format!("chunk {}/{}", i + 1, chunks.len()));
        let msgs = vec![
            ChatMessage::new("system", format!("Extract durable memory from these conversations as terse bullet points under these headings (skip empty ones):\n{BOOK_SECTIONS}\nOnly facts actually stated. Keep names, dates, prices, rules. No commentary.")),
            ChatMessage::new("user", c.clone()),
        ];
        match run_chat(state, os, msgs, Priority::Background, None, Some(180)).await {
            Ok(r) => {
                by = r.provider_id;
                notes.push(r.content);
            }
            Err(e) => notes.push(format!("(chunk {} not condensed: {e})", i + 1)),
        }
    }
    progress(app, "condense", "merging");
    let merged = if notes.len() > 1 {
        let msgs = vec![
            ChatMessage::new("system", format!("Merge these partial notes into ONE Memory Book in markdown with exactly these headings:\n{BOOK_SECTIONS}\nDeduplicate, keep every concrete fact, newest wins on conflict. Under 1500 words.")),
            ChatMessage::new("user", notes.join("\n\n---\n\n")),
        ];
        run_chat(state, os, msgs, Priority::Background, None, Some(240)).await.map(|r| r.content).unwrap_or_else(|_| notes.join("\n\n"))
    } else {
        notes.join("\n\n")
    };
    (format!("# Memory Book — {month}\n\n_{} conversations · condensed by {}_\n\n{merged}\n", prs.len(), if by.is_empty() { "fallback" } else { &by }), by)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestRequest {
    month: Option<String>,
}

#[tauri::command]
pub async fn memory_harvest(app: tauri::AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: HarvestRequest) -> Result<LedgerEntry, String> {
    let month = req.month.unwrap_or_else(super::agents::month_tag);
    harvest(&state, &os, &bridge, &month, Some(app)).await
}

pub async fn harvest(state: &DispatchState, os: &OsState, bridge: &BridgeState, month: &str, app: Option<tauri::AppHandle>) -> Result<LedgerEntry, String> {
    if !valid_month(month) {
        return Err("month must be YYYY-MM".into());
    }
    let cfg = os.snapshot();
    let repo = PathBuf::from(state.snapshot().gateway.workdir);
    let bounds = month_bounds(month);
    let thread_name = format!("{} · {month}", cfg.os_name);
    let mut records = Vec::new();
    let mut sources = BTreeMap::new();
    let mut notes = Vec::new();

    // A. Pull
    progress(&app, "pull", "AnythingLLM workspaces");
    let slugs: BTreeSet<(String, String)> = cfg.anythingllm.workspaces.iter().filter(|(_, s)| !s.is_empty()).map(|(r, s)| (s.clone(), r.clone())).collect();
    match super::secrets::get(state, "anythingllm") {
        Some(key) => {
            for (slug, role) in &slugs {
                match pull_allm(state, &cfg.anythingllm.base_url, &key, slug, &thread_name, bounds, role, "local", &mut records).await {
                    Ok(n) => {
                        sources.insert(format!("anythingllm:{slug}"), n);
                    }
                    Err(e) => notes.push(format!("{slug}: {e}")),
                }
            }
        }
        None => notes.push("AnythingLLM key missing — workspaces skipped".into()),
    }
    if cfg.droplet.enabled && cfg.memory.storage != "local" && !cfg.privacy.kill_switch {
        progress(&app, "pull", "droplet");
        if let Some(key) = os_core::os_secret("anythingllm-remote") {
            for (slug, role) in &slugs {
                if let Ok(n) = pull_allm(state, &cfg.droplet.anythingllm_url, &key, slug, &thread_name, bounds, role, "droplet", &mut records).await {
                    sources.insert(format!("droplet-anythingllm:{slug}"), n);
                }
            }
        }
        for c in &cfg.memory.cache_collections {
            match pull_qdrant(state, &cfg.droplet.qdrant_url, c, &mut records).await {
                Ok(n) => {
                    sources.insert(format!("qdrant:{c}"), n);
                }
                Err(e) => notes.push(format!("qdrant {c}: {e}")),
            }
        }
    }
    progress(&app, "pull", "training logs");
    sources.insert("training_logs".into(), pull_training_logs(&repo, month, &mut records));

    let bundle = json!({ "schema": "agentic-os.memory.v1", "month": month, "harvestedAt": os_core::now_secs(), "osName": cfg.os_name, "sources": sources, "records": records });
    let raw = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
    let sha = sha256_hex(&raw);
    let pass = os_core::os_secret("vault");
    let dir = vault_dir(&cfg).join(month);
    let m_ = month.replace('-', "_");
    progress(&app, "verify", "writing + checksumming raw backup");
    let raw_file = vault_write(&dir, &format!("raw_backup_{m_}.json"), &raw, pass.as_deref())?;
    let verified = vault_read(&dir, &raw_file).map(|b| sha256_hex(&b) == sha).unwrap_or(false);
    if !verified {
        return Err("raw backup failed its checksum re-read — nothing else was written".into());
    }

    // B. Condense
    let prs = pairs(&records);
    let (book, by) = condense(state, os, month, &prs, &app).await;
    let topics: Vec<String> = book.lines().filter(|l| l.starts_with("## ")).map(|l| l[3..].trim().to_string()).collect();
    let summary_file = vault_write(&dir, &format!("summary_{m_}.md"), book.as_bytes(), pass.as_deref())?;

    // C. Dataset
    progress(&app, "dataset", format!("{} candidate pairs", prs.len()));
    let (jsonl, n_pairs) = dataset(&cfg, &prs);
    let ds_file = vault_write(&dir, &format!("finetune_dataset_{m_}.jsonl"), jsonl.as_bytes(), pass.as_deref())?;

    // D. Ledger (keeps mounts from an earlier harvest of the same month)
    let prev = load_ledger(&cfg, month).ok();
    let agents: BTreeSet<String> = records.iter().map(|r| r.agent.clone()).filter(|a| a != "system").collect();
    if pass.is_none() {
        notes.push("no vault password set — files are NOT encrypted".into());
    }
    let entry = LedgerEntry {
        id: month.to_string(),
        month: month.to_string(),
        created_at: os_core::now_secs(),
        sha256: sha,
        verified,
        encrypted: pass.is_some(),
        records: records.len(),
        pairs: n_pairs,
        summary_tokens: book.len() / 4,
        agents: agents.into_iter().collect(),
        sources,
        files: BTreeMap::from([("raw".into(), raw_file), ("summary".into(), summary_file), ("dataset".into(), ds_file)]),
        mounts: prev.as_ref().map(|p| p.mounts.clone()).unwrap_or_default(),
        flushed_at: None,
        condensed_by: by,
        notes,
        topics,
    };
    save_ledger(&cfg, &entry)?;
    bridge.log(json!({ "type": "memory-harvest", "month": month, "records": entry.records, "pairs": entry.pairs, "encrypted": entry.encrypted, "sha256": entry.sha256 }));
    progress(&app, "done", format!("{} records → {}", entry.records, dir.display()));
    Ok(entry)
}

// ── Flush ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushRequest {
    month: String,
    /// Also delete Tony's monthly threads in the LOCAL AnythingLLM.
    #[serde(default)]
    include_local: bool,
    #[serde(default)]
    approved: bool,
}

#[tauri::command]
pub async fn memory_flush(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: FlushRequest) -> Result<Vec<String>, String> {
    flush(&state, &os, &bridge, &req.month, req.include_local, req.approved).await
}

pub async fn flush(state: &DispatchState, os: &OsState, bridge: &BridgeState, month: &str, include_local: bool, approved: bool) -> Result<Vec<String>, String> {
    let cfg = os.snapshot();
    if cfg.privacy.destructive_gate && !approved {
        return Err("PERMISSION_REQUIRED:destructive".into());
    }
    let mut l = load_ledger(&cfg, month)?;
    // Re-verify the local backup before anything remote is wiped.
    let dir = vault_dir(&cfg).join(month);
    let raw = vault_read(&dir, l.files.get("raw").ok_or("ledger has no raw backup")?)?;
    if sha256_hex(&raw) != l.sha256 {
        return Err("local backup checksum mismatch — refusing to flush".into());
    }
    let mut report = vec![format!("backup verified · sha256 {}…", &l.sha256[..12])];
    let thread_name = format!("{} · {month}", cfg.os_name);
    let mut targets: Vec<(String, String, String)> = Vec::new(); // (label, base, key)
    if cfg.droplet.enabled && !cfg.privacy.kill_switch {
        if let Some(k) = os_core::os_secret("anythingllm-remote") {
            targets.push(("droplet AnythingLLM".into(), cfg.droplet.anythingllm_url.clone(), k));
        }
    }
    if include_local {
        if let Some(k) = super::secrets::get(state, "anythingllm") {
            targets.push(("local AnythingLLM".into(), cfg.anythingllm.base_url.clone(), k));
        }
    }
    for (label, base, key) in &targets {
        for slug in cfg.anythingllm.workspaces.values().filter(|s| !s.is_empty()).collect::<BTreeSet<_>>() {
            let ws = allm(state, base, key, reqwest::Method::GET, &format!("/v1/workspace/{slug}"), None, 10).await.unwrap_or(Value::Null);
            let ws = if ws["workspace"].is_array() { ws["workspace"][0].clone() } else { ws["workspace"].clone() };
            for t in ws["threads"].as_array().into_iter().flatten().filter(|t| t["name"].as_str() == Some(thread_name.as_str())) {
                let ts = t["slug"].as_str().unwrap_or("");
                match allm(state, base, key, reqwest::Method::DELETE, &format!("/v1/workspace/{slug}/thread/{ts}"), None, 10).await {
                    Ok(_) => report.push(format!("{label}: deleted thread “{thread_name}” in {slug}")),
                    Err(e) => report.push(format!("{label}: {slug} thread not deleted ({e})")),
                }
            }
        }
    }
    os.allm_threads.lock().unwrap().clear();
    if cfg.droplet.enabled && !cfg.privacy.kill_switch {
        for c in &cfg.memory.cache_collections {
            let r = state.http.delete(format!("{}/collections/{c}", cfg.droplet.qdrant_url.trim_end_matches('/'))).timeout(Duration::from_secs(15)).send().await;
            report.push(match r {
                Ok(r) if r.status().is_success() => format!("droplet Qdrant: dropped cache collection {c}"),
                Ok(r) => format!("droplet Qdrant: {c} → HTTP {}", r.status().as_u16()),
                Err(e) => format!("droplet Qdrant: {c} → {}", short(e)),
            });
        }
    } else if !cfg.memory.cache_collections.is_empty() {
        report.push("droplet off — Qdrant cache untouched".into());
    }
    if targets.is_empty() && cfg.memory.cache_collections.is_empty() {
        report.push("nothing remote configured to flush (droplet off, no cache collections)".into());
    }
    l.flushed_at = Some(os_core::now_secs());
    save_ledger(&cfg, &l)?;
    bridge.log(json!({ "type": "memory-flush", "month": month, "report": report }));
    Ok(report)
}

// ── Mount / unmount ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRequest {
    month: String,
    /// "local" | "droplet"
    target: String,
    #[serde(default)]
    approved: bool,
}

fn mount_endpoint(state: &DispatchState, cfg: &OsConfig, target: &str) -> Result<(String, String), String> {
    match target {
        "local" => Ok((cfg.anythingllm.base_url.clone(), super::secrets::get(state, "anythingllm").ok_or("AnythingLLM key missing")?)),
        "droplet" => {
            if !cfg.droplet.enabled {
                return Err("droplet is switched off".into());
            }
            if cfg.privacy.kill_switch || cfg.compute.mode == os_core::ComputeMode::Local {
                return Err("kill switch / LOCAL ONLY — cloud mounts are blocked".into());
            }
            Ok((cfg.droplet.anythingllm_url.clone(), os_core::os_secret("anythingllm-remote").ok_or("remote AnythingLLM key missing")?))
        }
        _ => Err("target must be local or droplet".into()),
    }
}

#[tauri::command]
pub async fn memory_mount(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: MountRequest) -> Result<LedgerEntry, String> {
    let cfg = os.snapshot();
    if req.target == "droplet" {
        os_core::gate(&bridge, cfg.permissions.cloud, "cloud", req.approved, json!({ "action": "memory-mount", "month": req.month }))?;
    }
    let mut l = load_ledger(&cfg, &req.month)?;
    if l.mounts.iter().any(|m| m.target == req.target) {
        return Ok(l);
    }
    let (base, key) = mount_endpoint(&state, &cfg, &req.target)?;
    let book = String::from_utf8(vault_read(&vault_dir(&cfg).join(&req.month), l.files.get("summary").ok_or("no summary")?)?).map_err(|e| e.to_string())?;
    let ws = cfg.memory.mount_workspace.clone();
    let v = allm(
        &state,
        &base,
        &key,
        reqwest::Method::POST,
        "/v1/document/raw-text",
        Some(json!({ "textContent": book, "addToWorkspaces": ws, "metadata": { "title": format!("Memory Book {}", req.month), "docSource": "agentic-os memory vault" } })),
        120,
    )
    .await?;
    let location = v["documents"][0]["location"].as_str().ok_or("AnythingLLM did not return the document location")?.to_string();
    l.mounts.push(Mount { target: req.target.clone(), workspace: ws, location, at: os_core::now_secs() });
    save_ledger(&cfg, &l)?;
    bridge.log(json!({ "type": "memory-mount", "month": req.month, "target": req.target }));
    Ok(l)
}

#[tauri::command]
pub async fn memory_unmount(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: MountRequest) -> Result<LedgerEntry, String> {
    let cfg = os.snapshot();
    let mut l = load_ledger(&cfg, &req.month)?;
    let Some(m) = l.mounts.iter().find(|m| m.target == req.target).cloned() else { return Ok(l) };
    let (base, key) = mount_endpoint(&state, &cfg, &req.target)?;
    let _ = allm(&state, &base, &key, reqwest::Method::POST, &format!("/v1/workspace/{}/update-embeddings", m.workspace), Some(json!({ "adds": [], "deletes": [m.location] })), 60).await;
    allm(&state, &base, &key, reqwest::Method::DELETE, "/v1/system/remove-documents", Some(json!({ "names": [m.location] })), 60).await?;
    l.mounts.retain(|x| x.target != req.target);
    save_ledger(&cfg, &l)?;
    bridge.log(json!({ "type": "memory-unmount", "month": req.month, "target": req.target }));
    Ok(l)
}

/// Decrypt one archive file into `<vault>/<month>/unlocked/` (for training / reading).
#[tauri::command]
pub fn memory_export(os: State<'_, OsState>, month: String, kind: String) -> Result<String, String> {
    let cfg = os.snapshot();
    if !valid_month(&month) {
        return Err("bad month".into());
    }
    let l = load_ledger(&cfg, &month)?;
    let fname = l.files.get(&kind).ok_or("kind must be raw, summary or dataset")?;
    let dir = vault_dir(&cfg).join(&month);
    let bytes = vault_read(&dir, fname)?;
    let out_dir = dir.join("unlocked");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out = out_dir.join(fname.trim_end_matches(".enc"));
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.display().to_string())
}

/// Hourly: on the 1st of the month, harvest last month (and flush if enabled).
/// Turning "Auto-run monthly" on is the standing consent for both.
pub async fn auto_monthly_loop(app: tauri::AppHandle) {
    use chrono::Datelike;
    loop {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(3600))).await.ok();
        let os = app.state::<OsState>();
        let cfg = os.snapshot();
        let prev = previous_month();
        if !cfg.memory.auto_monthly || chrono::Local::now().day() != 1 || cfg.memory.last_auto_month == prev {
            continue;
        }
        let state = app.state::<DispatchState>();
        let bridge = app.state::<BridgeState>();
        let ok = harvest(&state, &os, &bridge, &prev, Some(app.clone())).await.is_ok();
        if ok && cfg.memory.auto_flush {
            let _ = flush(&state, &os, &bridge, &prev, false, true).await;
        }
        let _ = os.update(|c| {
            c.memory.last_auto_month = prev.clone();
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip() {
        let ct = seal(b"secret memory", "correct horse battery").unwrap();
        assert_eq!(open(&ct, "correct horse battery").unwrap(), b"secret memory");
        assert!(open(&ct, "wrong").is_err());
    }

    #[test]
    fn months() {
        assert!(valid_month("2026-11"));
        assert!(!valid_month("2026-13"));
        let (a, b) = month_bounds("2026-02");
        assert!(b - a >= 28 * 86400 && b - a <= 29 * 86400 + 3600);
    }

    #[test]
    fn dataset_dedupes_and_filters() {
        let cfg = OsConfig::default();
        let prs = vec![
            ("booking".into(), "When is the shoot?".into(), "Thursday at 9am at the studio on King.".into()),
            ("booking".into(), "When is the shoot?".into(), "Thursday at 9am at the studio on King.".into()),
            ("general".into(), "weather?".into(), "I am unable to access real-time data.".into()),
        ];
        let (s, n) = dataset(&cfg, &prs);
        assert_eq!(n, 1, "{s}");
        assert!(s.contains("\"messages\""));
    }
}
