//! OS Permission Bridge + synaptic training log.
//!
//! Every privileged pipeline action declares the scopes it needs
//! (Read / Write / Execute / Network). Each scope has a tier:
//!
//!   allow → runs
//!   ask   → refused with `PERMISSION_REQUIRED:<scopes>` until the UI shows the
//!           confirmation card and re-sends with `approved: true`
//!   deny  → always refused, including by background jobs
//!
//! Honest limits: "ask" is a UX + audit gate, not a sandbox — a compromised
//! webview could send `approved: true` itself. "deny" is enforced here in Rust.
//!
//! Every decision and every dispatch outcome is appended as one JSON line to
//! `<repo>/training_logs/pipelines-YYYY-MM-DD.jsonl` (upstream → downstream →
//! verification), so automation behaviour is captured for later fine-tuning.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Read,
    Write,
    Execute,
    Network,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Allow,
    Ask,
    Deny,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BridgePolicy {
    pub read: Tier,
    pub write: Tier,
    pub execute: Tier,
    pub network: Tier,
}

impl Default for BridgePolicy {
    fn default() -> Self {
        Self { read: Tier::Allow, write: Tier::Ask, execute: Tier::Ask, network: Tier::Allow }
    }
}

impl BridgePolicy {
    fn tier(&self, s: Scope) -> Tier {
        match s {
            Scope::Read => self.read,
            Scope::Write => self.write,
            Scope::Execute => self.execute,
            Scope::Network => self.network,
        }
    }
}

/// Who asked: the human in the UI, or an unattended job.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Actor {
    User,
    Scheduler,
}

#[derive(Default)]
pub struct BridgeState {
    policy: RwLock<BridgePolicy>,
    policy_path: RwLock<Option<PathBuf>>,
    log_dir: RwLock<Option<PathBuf>>,
    write_lock: Mutex<()>,
}

impl BridgeState {
    pub fn init(&self, config_dir: &std::path::Path, log_dir: PathBuf) {
        let path = config_dir.join("permissions.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(p) = serde_json::from_str::<BridgePolicy>(&text) {
                *self.policy.write().unwrap() = p;
            }
        }
        *self.policy_path.write().unwrap() = Some(path);
        *self.log_dir.write().unwrap() = Some(log_dir);
        let _ = self.persist();
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = self.policy_path.read().unwrap().clone() else { return Ok(()) };
        let json = serde_json::to_string_pretty(&*self.policy.read().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn log_dir(&self) -> Option<PathBuf> {
        self.log_dir.read().unwrap().clone()
    }

    /// Gate an action. `pre_consented` covers background jobs the user switched on
    /// explicitly (e.g. auto-sync): it satisfies "ask", never "deny".
    pub fn check(&self, action: &str, scopes: &[Scope], approved: bool, actor: Actor, pre_consented: bool, detail: serde_json::Value) -> Result<(), String> {
        self.decide(action, scopes, approved, actor, pre_consented, detail, true)
    }

    /// Same gate, but only denials are logged (for high-frequency reads like polling).
    pub fn check_quiet(&self, action: &str, scopes: &[Scope], actor: Actor) -> Result<(), String> {
        self.decide(action, scopes, false, actor, true, serde_json::Value::Null, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn decide(&self, action: &str, scopes: &[Scope], approved: bool, actor: Actor, pre_consented: bool, detail: serde_json::Value, always_log: bool) -> Result<(), String> {
        let policy = self.policy.read().unwrap().clone();
        let denied: Vec<Scope> = scopes.iter().copied().filter(|s| policy.tier(*s) == Tier::Deny).collect();
        let needs_ask: Vec<Scope> = scopes.iter().copied().filter(|s| policy.tier(*s) == Tier::Ask).collect();
        let outcome = if !denied.is_empty() {
            Err(format!("PERMISSION_DENIED:{}", names(&denied)))
        } else if !needs_ask.is_empty() && !(approved || pre_consented) {
            Err(format!("PERMISSION_REQUIRED:{}", names(&needs_ask)))
        } else {
            Ok(())
        };
        if !always_log && outcome.is_ok() {
            return outcome;
        }
        self.log(serde_json::json!({
            "type": "permission",
            "action": action,
            "actor": actor,
            "scopes": scopes,
            "approved": approved,
            "preConsented": pre_consented,
            "decision": match &outcome { Ok(()) => "allow".to_string(), Err(e) => e.clone() },
            "detail": detail,
        }));
        outcome
    }

    /// Append one training record. Best-effort: logging must never break an action.
    pub fn log(&self, mut record: serde_json::Value) {
        let Some(dir) = self.log_dir() else { return };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        if let Some(obj) = record.as_object_mut() {
            obj.insert("ts".into(), serde_json::json!(now.as_millis() as u64));
            obj.insert("schema".into(), serde_json::json!("jarvis.synapse.v1"));
        }
        let _guard = self.write_lock.lock();
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let file = dir.join(format!("pipelines-{}.jsonl", utc_date(now.as_secs())));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(f, "{record}");
        }
    }
}

fn names(s: &[Scope]) -> String {
    s.iter().map(|x| serde_json::to_value(x).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()).collect::<Vec<_>>().join(",")
}

/// YYYY-MM-DD (UTC) from unix seconds, without a date crate.
fn utc_date(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeView {
    policy: BridgePolicy,
    log_dir: Option<String>,
}

#[tauri::command]
pub fn bridge_get(bridge: State<'_, BridgeState>) -> BridgeView {
    BridgeView { policy: bridge.policy.read().unwrap().clone(), log_dir: bridge.log_dir().map(|d| d.to_string_lossy().into_owned()) }
}

#[tauri::command]
pub fn bridge_set(bridge: State<'_, BridgeState>, scope: Scope, tier: Tier) -> Result<BridgeView, String> {
    {
        let mut p = bridge.policy.write().unwrap();
        match scope {
            Scope::Read => p.read = tier,
            Scope::Write => p.write = tier,
            Scope::Execute => p.execute = tier,
            Scope::Network => p.network = tier,
        }
    }
    bridge.persist()?;
    bridge.log(serde_json::json!({ "type": "policy-change", "scope": scope, "tier": tier }));
    Ok(bridge_get(bridge))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(951_782_400), "2000-02-29");
        assert_eq!(utc_date(1_794_873_600), "2026-11-17");
    }

    #[test]
    fn tiers() {
        let b = BridgeState::default();
        let none = serde_json::Value::Null;
        assert!(b.check("t", &[Scope::Read, Scope::Network], false, Actor::User, false, none.clone()).is_ok());
        assert_eq!(b.check("t", &[Scope::Execute], false, Actor::User, false, none.clone()).unwrap_err(), "PERMISSION_REQUIRED:execute");
        assert!(b.check("t", &[Scope::Execute], true, Actor::User, false, none.clone()).is_ok());
        b.policy.write().unwrap().network = Tier::Deny;
        assert_eq!(b.check("t", &[Scope::Network], true, Actor::Scheduler, true, none).unwrap_err(), "PERMISSION_DENIED:network");
    }
}
