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

fn account(state: &DispatchState, provider: &str) -> Result<String, String> {
    if !valid_id(provider) {
        return Err("invalid provider id".into());
    }
    let host = state.provider_host(provider).ok_or("unknown provider")?;
    Ok(format!("{provider}@{host}"))
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Rust-only accessor. Never expose through a command.
pub(crate) fn get(state: &DispatchState, provider: &str) -> Option<String> {
    let acct = account(state, provider).ok()?;
    entry(&acct).ok()?.get_password().ok()
}

#[tauri::command]
pub fn secret_set(state: State<'_, DispatchState>, provider: String, value: String) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return Err("key must be 1–4096 characters".into());
    }
    entry(&account(&state, &provider)?)?.set_password(value).map_err(|e| e.to_string())
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
pub fn secret_delete(state: State<'_, DispatchState>, provider: String) -> Result<(), String> {
    match entry(&account(&state, &provider)?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
