//! `KEY=value` lookups for credentials that live outside the keychain: the
//! process environment first, then the repo-root `.env` (the gateway's
//! working directory). Values are never logged or sent to the webview.
//!
//! Also the single resolver for OS-level secrets (`os_key`: env → `.env` →
//! keychain) and the Settings status command (`os_secret_sources`), so the
//! badge a key row shows and the key runtime actually uses cannot drift apart.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

use super::dispatch::DispatchState;
use super::os_core;

/// Where a credential was found. Serialized kebab-case (`"env"`, `"env-file"`,
/// `"keychain"`, `"missing"`) — the webview's `keySource` types depend on it.
#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    Env,
    EnvFile,
    Keychain,
    Missing,
}

/// `key`'s value in dotenv-style `text` (`export ` prefix, quotes, CRLF and a
/// leading UTF-8 BOM allowed). Empty values count as absent.
pub(crate) fn parse_env_text(text: &str, key: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix("export ").unwrap_or(line);
        let (k, v) = rest.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim().trim_matches('"').trim_matches('\'').trim();
        (!v.is_empty()).then(|| v.to_string())
    })
}

/// `key`'s value from a dotenv-style file.
pub(crate) fn from_env_file(path: &Path, key: &str) -> Option<String> {
    parse_env_text(&std::fs::read_to_string(path).ok()?, key)
}

/// `<gateway.workdir>/.env` — the repo-root `.env`.
pub(crate) fn env_file_path(state: &DispatchState) -> PathBuf {
    Path::new(&state.snapshot().gateway.workdir).join(".env")
}

/// Non-empty process environment variable `key` (trimmed).
fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Environment variable `key` (`Env`), else `key=` in the repo-root `.env` (`EnvFile`).
pub(crate) fn env_or_file_src(state: &DispatchState, key: &str) -> Option<(String, KeySource)> {
    if let Some(v) = process_env(key) {
        return Some((v, KeySource::Env));
    }
    from_env_file(&env_file_path(state), key).map(|v| (v, KeySource::EnvFile))
}

/// Environment variable `key`, else `key=` in `<gateway.workdir>/.env`.
pub(crate) fn env_or_file(state: &DispatchState, key: &str) -> Option<String> {
    env_or_file_src(state, key).map(|v| v.0)
}

/// OS secret name → the env var that overrides it. Names absent here are keychain-only.
/// Every key here goes only to a host hard-coded in Rust (env values are not host-bound
/// the way provider keychain entries are), so never route one to an editable URL.
pub(crate) const ENV_FOR: &[(&str, &str)] = &[
    ("brave", "BRAVE_API_KEY"),
    ("gmail-script-id", "GMAIL_SCRIPT_ID"),
    ("gmail-script-key", "GMAIL_SCRIPT_KEY"),
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("twelvedata", "TWELVEDATA_API_KEY"),
    ("github-pat", "GITHUB_PAT"),
    ("sentry-token", "SENTRY_AUTH_TOKEN"),
    ("agentmail-key", "AGENTMAIL_API_KEY"),
];

/// Credential env vars read elsewhere (not OS secrets) that `devqueue::known_secrets`
/// must also scrub when they come from the process environment.
pub(crate) const OTHER_SECRET_ENV: &[&str] = &["ELEVENLABS_API_KEY", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN"];

pub(crate) fn env_var_for(name: &str) -> Option<&'static str> {
    ENV_FOR.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

/// The single resolver for an OS secret: its env var (process env, then the repo-root
/// `.env`), else the keychain entry Settings saves. Read fresh on every call, so a change
/// works without a restart. Gmail is pair-level — use `gmail::creds`, not this, for it.
pub(crate) fn os_key(state: &DispatchState, name: &str) -> Option<String> {
    env_var_for(name).and_then(|v| env_or_file(state, v)).or_else(|| os_core::os_secret(name))
}

/// Presence and source of one OS secret. Never a value or a length.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub source: KeySource,
    pub env_var: Option<&'static str>,
    /// A keychain entry exists (Settings can delete it).
    pub keychain: bool,
    /// Gmail only: some of the ID/key pair is set, but not both from one place.
    pub pair_incomplete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySources {
    pub keys: BTreeMap<String, KeyStatus>,
    pub env_file: String,
    pub env_file_found: bool,
}

/// One secret's status, same order as `os_key`. `env` reports where an env var is set;
/// `keychain` whether a keychain entry exists. Pure, so it's testable without the
/// Credential Manager.
fn key_status(name: &str, env: &impl Fn(&str) -> Option<KeySource>, keychain: &impl Fn(&str) -> bool) -> KeyStatus {
    let env_var = env_var_for(name);
    let kc = keychain(name);
    let source = match env_var.and_then(|v| env(v)) {
        Some(s) => s,
        None if kc => KeySource::Keychain,
        None => KeySource::Missing,
    };
    KeyStatus { source, env_var, keychain: kc, pair_incomplete: false }
}

const GMAIL_ID: &str = "gmail-script-id";
const GMAIL_KEY: &str = "gmail-script-key";

/// Status of every name, with Gmail's pair rule (matches `gmail::creds`): the env pair is
/// used only when BOTH vars are set, else the keychain pair only when BOTH entries exist.
fn key_statuses(names: &[&str], env: impl Fn(&str) -> Option<KeySource>, keychain: impl Fn(&str) -> bool) -> BTreeMap<String, KeyStatus> {
    let mut out: BTreeMap<String, KeyStatus> = names.iter().map(|n| (n.to_string(), key_status(n, &env, &keychain))).collect();
    if let (Some(id), Some(key)) = (out.get(GMAIL_ID).cloned(), out.get(GMAIL_KEY).cloned()) {
        let is_env = |s: KeySource| matches!(s, KeySource::Env | KeySource::EnvFile);
        let env_pair = is_env(id.source) && is_env(key.source);
        if !env_pair {
            let kc_pair = id.keychain && key.keychain;
            let any = is_env(id.source) || is_env(key.source) || id.keychain || key.keychain;
            for n in [GMAIL_ID, GMAIL_KEY] {
                if let Some(s) = out.get_mut(n) {
                    s.source = if kc_pair { KeySource::Keychain } else { KeySource::Missing };
                    s.pair_incomplete = !kc_pair && any;
                }
            }
        }
    }
    out
}

/// One secret's source, for status labels elsewhere (System Map). Not for Gmail.
pub(crate) fn key_source(state: &DispatchState, name: &str) -> KeySource {
    let env = |k: &str| env_or_file_src(state, k).map(|v| v.1);
    key_status(name, &env, &|n: &str| os_core::os_secret(n).is_some()).source
}

/// Where each Settings-manageable OS secret comes from: presence and source names only,
/// never values or lengths. One `.env` read plus one keychain read per name.
#[tauri::command]
pub async fn os_secret_sources(state: State<'_, DispatchState>) -> Result<KeySources, String> {
    let path = env_file_path(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let text = std::fs::read_to_string(&path).ok();
        let env = |k: &str| {
            if process_env(k).is_some() {
                Some(KeySource::Env)
            } else {
                text.as_deref().and_then(|t| parse_env_text(t, k)).map(|_| KeySource::EnvFile)
            }
        };
        let keys = key_statuses(&os_core::OS_SECRETS, env, |n| os_core::os_secret(n).is_some());
        KeySources { keys, env_file: path.display().to_string(), env_file_found: path.is_file() }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_file_parsing() {
        let dir = std::env::temp_dir().join(format!("envfile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(".env");
        std::fs::write(&f, "# comment\nOTHER=1\nexport ELEVENLABS_API_KEY=\"sk_test_123\"\nSPOTIFY_CLIENT_ID='abc'\n").unwrap();
        assert_eq!(from_env_file(&f, "ELEVENLABS_API_KEY").as_deref(), Some("sk_test_123"));
        assert_eq!(from_env_file(&f, "SPOTIFY_CLIENT_ID").as_deref(), Some("abc"));
        assert_eq!(from_env_file(&f, "OTHER").as_deref(), Some("1"));
        assert_eq!(from_env_file(&f, "MISSING"), None);
        std::fs::write(&f, "ELEVENLABS_API_KEY=\n").unwrap();
        assert_eq!(from_env_file(&f, "ELEVENLABS_API_KEY"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bom_and_crlf_are_ignored() {
        let t = "\u{feff}BRAVE_API_KEY=bk_test\r\nGMAIL_SCRIPT_ID=abc\r\n";
        assert_eq!(parse_env_text(t, "BRAVE_API_KEY").as_deref(), Some("bk_test"));
        assert_eq!(parse_env_text(t, "GMAIL_SCRIPT_ID").as_deref(), Some("abc"));
        assert_eq!(parse_env_text("\u{feff}X=1", "Y"), None);
    }

    #[test]
    fn env_or_file_src_reports_env_file() {
        let dir = std::env::temp_dir().join(format!("envfile-src-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "\u{feff}CC_TEST_ONLY_ENVFILE_KEY_7f3a=from_file\n").unwrap();
        let state = DispatchState::default();
        // A default state has no providers.json path, so `update` doesn't persist.
        state
            .update(|c| {
                c.gateway.workdir = dir.display().to_string();
                Ok(())
            })
            .unwrap();
        assert_eq!(env_or_file_src(&state, "CC_TEST_ONLY_ENVFILE_KEY_7f3a"), Some(("from_file".to_string(), KeySource::EnvFile)));
        assert_eq!(env_or_file_src(&state, "CC_TEST_ONLY_ENVFILE_MISSING_7f3a"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn statuses(env: &[(&str, KeySource)], kc: &[&str]) -> BTreeMap<String, KeyStatus> {
        let env: Vec<(String, KeySource)> = env.iter().map(|(k, s)| (k.to_string(), *s)).collect();
        let kc: Vec<String> = kc.iter().map(|s| s.to_string()).collect();
        key_statuses(&os_core::OS_SECRETS, move |k| env.iter().find(|(n, _)| n == k).map(|(_, s)| *s), move |n| kc.iter().any(|x| x == n))
    }

    #[test]
    fn brave_in_env_file() {
        let s = statuses(&[("BRAVE_API_KEY", KeySource::EnvFile)], &[]);
        assert_eq!(s["brave"], KeyStatus { source: KeySource::EnvFile, env_var: Some("BRAVE_API_KEY"), keychain: false, pair_incomplete: false });
        // Env beats a keychain fallback, which is still reported.
        let s = statuses(&[("BRAVE_API_KEY", KeySource::Env)], &["brave"]);
        assert_eq!((s["brave"].source, s["brave"].keychain), (KeySource::Env, true));
        // Keychain only.
        let s = statuses(&[], &["brave"]);
        assert_eq!(s["brave"].source, KeySource::Keychain);
    }

    #[test]
    fn anthropic_absent_names_its_env_var() {
        let s = statuses(&[], &[]);
        assert_eq!(s["anthropic"], KeyStatus { source: KeySource::Missing, env_var: Some("ANTHROPIC_API_KEY"), keychain: false, pair_incomplete: false });
        assert_eq!(s["gemini"].env_var, Some("GEMINI_API_KEY"));
        // Keychain-only names have no env var.
        assert_eq!(s["vault"].env_var, None);
        assert_eq!(s["gateway-token"].env_var, None);
    }

    #[test]
    fn gmail_pair_rule() {
        // Both vars → env-file for both.
        let s = statuses(&[("GMAIL_SCRIPT_ID", KeySource::EnvFile), ("GMAIL_SCRIPT_KEY", KeySource::EnvFile)], &[]);
        assert_eq!((s[GMAIL_ID].source, s[GMAIL_KEY].source), (KeySource::EnvFile, KeySource::EnvFile));
        assert!(!s[GMAIL_ID].pair_incomplete);
        // Only the ID in env, no keychain → both missing, pair incomplete.
        let s = statuses(&[("GMAIL_SCRIPT_ID", KeySource::Env)], &[]);
        assert_eq!((s[GMAIL_ID].source, s[GMAIL_KEY].source), (KeySource::Missing, KeySource::Missing));
        assert!(s[GMAIL_ID].pair_incomplete && s[GMAIL_KEY].pair_incomplete);
        // One env var + one keychain entry: runtime uses neither.
        let s = statuses(&[("GMAIL_SCRIPT_ID", KeySource::Env)], &[GMAIL_KEY]);
        assert_eq!(s[GMAIL_KEY].source, KeySource::Missing);
        assert!(s[GMAIL_KEY].keychain && s[GMAIL_KEY].pair_incomplete);
        // Half an env pair + the full keychain pair → keychain for both.
        let s = statuses(&[("GMAIL_SCRIPT_KEY", KeySource::EnvFile)], &[GMAIL_ID, GMAIL_KEY]);
        assert_eq!((s[GMAIL_ID].source, s[GMAIL_KEY].source), (KeySource::Keychain, KeySource::Keychain));
        assert!(!s[GMAIL_ID].pair_incomplete);
        // Nothing anywhere → missing, not "incomplete".
        let s = statuses(&[], &[]);
        assert_eq!(s[GMAIL_ID].source, KeySource::Missing);
        assert!(!s[GMAIL_ID].pair_incomplete);
    }

    #[test]
    fn env_for_names_are_os_secrets_and_unique() {
        for (n, v) in ENV_FOR {
            assert!(os_core::OS_SECRETS.contains(n), "{n} is not an OS secret");
            assert_eq!(ENV_FOR.iter().filter(|(_, x)| x == v).count(), 1, "{v} mapped twice");
        }
        // GOOGLE_API_KEY is deliberately not accepted (could be an unrelated shell key).
        assert!(ENV_FOR.iter().all(|(_, v)| *v != "GOOGLE_API_KEY"));
    }

    #[test]
    fn key_sources_serialize_names_only() {
        let s = statuses(&[("BRAVE_API_KEY", KeySource::EnvFile)], &["vault"]);
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["brave"], serde_json::json!({ "source": "env-file", "envVar": "BRAVE_API_KEY", "keychain": false, "pairIncomplete": false }));
        assert_eq!(j["vault"]["source"], "keychain");
        assert_eq!(serde_json::to_value(KeySource::Missing).unwrap(), "missing");
    }
}
