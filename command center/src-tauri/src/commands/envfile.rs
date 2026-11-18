//! `KEY=value` lookups for credentials that live outside the keychain: the
//! process environment first, then the repo-root `.env` (the gateway's
//! working directory). Values are never logged or sent to the webview.

use std::path::Path;

use super::dispatch::DispatchState;

/// `key`'s value from a dotenv-style file (`export ` prefix and quotes allowed).
pub(crate) fn from_env_file(path: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
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

/// Environment variable `key`, else `key=` in `<gateway.workdir>/.env`.
pub(crate) fn env_or_file(state: &DispatchState, key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    from_env_file(&Path::new(&state.snapshot().gateway.workdir).join(".env"), key)
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
}
