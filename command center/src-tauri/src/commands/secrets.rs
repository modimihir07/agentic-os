//! API keys live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux). The webview can set, check and
//! delete a key but can NEVER read one back — `get` is crate-private and only
//! used when Rust itself makes the outbound request.
//!
//! Each key is bound to its provider's host (`<id>@<host>`), so if the webview
//! were compromised and re-pointed a provider at another server, the stored
//! key would simply not be found rather than being sent there.

use std::collections::HashMap;
use tauri::State;

use super::dispatch::DispatchState;

const SERVICE: &str = "agentic-os-command-center";

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Optional second slot per provider, e.g. n8n keeps its webhook token in the
/// default slot and its REST API key in "api". Still bound to the host.
const SLOTS: [&str; 1] = ["api"];

fn account_slot(state: &DispatchState, provider: &str, slot: Option<&str>) -> Result<String, String> {
    if !valid_id(provider) {
        return Err("invalid provider id".into());
    }
    let host = state.provider_host(provider).ok_or("unknown provider")?;
    match slot {
        None => Ok(format!("{provider}@{host}")),
        Some(s) if SLOTS.contains(&s) => Ok(format!("{provider}#{s}@{host}")),
        Some(_) => Err("invalid key slot".into()),
    }
}

fn account(state: &DispatchState, provider: &str) -> Result<String, String> {
    account_slot(state, provider, None)
}

/// Rust-only accessor for a named slot. Never expose through a command.
pub(crate) fn get_slot(state: &DispatchState, provider: &str, slot: &str) -> Option<String> {
    let acct = account_slot(state, provider, Some(slot)).ok()?;
    entry(&acct).ok()?.get_password().ok()
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Rust-only accessor. Never expose through a command.
pub(crate) fn get(state: &DispatchState, provider: &str) -> Option<String> {
    let acct = account(state, provider).ok()?;
    entry(&acct).ok()?.get_password().ok()
}

/// Longest value Settings accepts. Windows Credential Manager holds at most 2560 bytes
/// of UTF-16 (about 1280 characters); every real key / token / ID is far shorter.
pub(crate) const MAX_SECRET_CHARS: usize = 1024;

/// A pasted secret (already trimmed) is non-empty and fits the OS keychain. The message
/// names the limit only, never the value or its length.
pub(crate) fn check_secret_value(v: &str) -> Result<(), String> {
    if v.is_empty() {
        return Err("paste a value first".into());
    }
    if v.chars().count() > MAX_SECRET_CHARS || v.encode_utf16().count() * 2 > 2560 {
        return Err(format!("too long for the OS keychain (max {MAX_SECRET_CHARS} characters) — check you pasted only the key"));
    }
    Ok(())
}

#[tauri::command]
pub fn secret_set(state: State<'_, DispatchState>, provider: String, value: String, slot: Option<String>) -> Result<(), String> {
    let value = value.trim();
    check_secret_value(value)?;
    entry(&account_slot(&state, &provider, slot.as_deref())?)?.set_password(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_status(state: State<'_, DispatchState>, providers: Vec<String>) -> HashMap<String, bool> {
    providers
        .into_iter()
        .map(|p| {
            let has = get(&state, &p).is_some();
            (p, has)
        })
        .collect()
}

#[tauri::command]
pub fn secret_delete(state: State<'_, DispatchState>, provider: String, slot: Option<String>) -> Result<(), String> {
    match entry(&account_slot(&state, &provider, slot.as_deref())?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_value_limits() {
        assert!(check_secret_value("").is_err());
        assert!(check_secret_value("sk-test-123").is_ok());
        assert!(check_secret_value(&"a".repeat(MAX_SECRET_CHARS)).is_ok());
        let e = check_secret_value(&"a".repeat(MAX_SECRET_CHARS + 1)).unwrap_err();
        assert!(e.contains("1024") && !e.contains("aaaa"));
        // 700 non-BMP chars = 1400 UTF-16 units = 2800 bytes: over the Credential Manager limit.
        assert!(check_secret_value(&"\u{1F600}".repeat(700)).is_err());
    }
}

/// One-off setup helper: store a provider key from the environment without it
/// ever being printed. `PROVIDER_ID=droplet PROVIDER_KEY=… cargo test --lib live_store_key -- --ignored`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_store_key() {
        let id = std::env::var("PROVIDER_ID").expect("PROVIDER_ID");
        let key = std::env::var("PROVIDER_KEY").expect("PROVIDER_KEY");
        let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let state = DispatchState::default();
        state.load_or_init(&dir);
        let acct = account(&state, &id).expect("account");
        entry(&acct).unwrap().set_password(key.trim()).unwrap();
        assert!(get(&state, &id).is_some());
        println!("STORED key for {acct} ({} chars)", key.trim().len());
    }
}
