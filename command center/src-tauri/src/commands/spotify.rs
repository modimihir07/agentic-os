//! Spotify through its Web API, called from Rust only.
//!
//! Auth is Authorization Code + PKCE against the redirect URI registered with
//! Spotify (`SPOTIFY_REDIRECT_URI`, normally `http://127.0.0.1:1420/callback`).
//! The callback is caught by a one-shot listener on that address; in `tauri dev`
//! Vite already owns :1420, so Vite proxies `/callback` to the gateway
//! (`/api/spotify/callback`) and Rust polls `/api/spotify/pending` instead.
//!
//! Client id / secret come from the env or the repo `.env`. The refresh token
//! lives in the keychain (`spotify-refresh`); the current access token, its
//! expiry and granted scope in a second Rust-only entry (`spotify-session`), so
//! a relaunch inside the token's hour needs no refresh grant at all. A third entry
//! (`spotify-grant`, no token) records the granted scopes, the consent time (Spotify's
//! 6-month refresh window), automatic re-auth prompt state and a rejected `.env` seed. If the
//! keychain has no refresh token, `SPOTIFY_REFRESH_TOKEN` in the repo `.env` is
//! used as a read-only seed (a rotated result goes to the keychain; nothing is
//! ever written to `.env`). None of them reach the webview, logs or error strings.
//!
//! Refresh grants run in a detached task (`refresh_owned`) that owns the
//! `ACCESS` lock, so a caller that times out (status check, tool timeout) only
//! stops waiting: the HTTP call and the keychain write of a rotated refresh
//! token always finish. Rotation is compare-and-store, so a refresh that ends
//! after Disconnect / a fresh Connect can't resurrect or overwrite that state.
//! A process killed mid-refresh can still lose a rotated token; that is accepted.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::bridge::{BridgeState, Tier};
use super::dispatch::{short, DispatchState};
use super::envfile::env_or_file;
use super::os_core::{self, OsConfig, OsState};
use super::spotify_device::{self as device, Device, DeviceStep, Purpose};
use super::spotify_intent as intent;
use super::spotify_resolve::{self as resolve, PlayArgs, PlayRequest, PlaylistMatch, PlaylistRef, SearchKind, SearchPlan, Target, TrackRef};

const API: &str = "https://api.spotify.com/v1";
const ACCOUNTS: &str = "https://accounts.spotify.com";
/// Every scope this app asks for (18). Only the core ones (all but `OPTIONAL_SCOPES`)
/// are needed by Web API calls; a missing optional scope never triggers re-auth.
pub(crate) const SCOPES: &str = "user-read-playback-state user-modify-playback-state user-read-currently-playing streaming app-remote-control playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-library-modify user-follow-read user-follow-modify user-top-read user-read-recently-played user-read-playback-position user-read-email user-read-private";
/// Requested, but Spotify may leave them out of the granted set (logged only).
const OPTIONAL_SCOPES: [&str; 4] = ["streaming", "app-remote-control", "user-read-email", "user-read-private"];
const SECRET_REFRESH: &str = "spotify-refresh";
const SECRET_SESSION: &str = "spotify-session";
/// Rust-only grant bookkeeping (scopes, consent time, prompt state). No token inside.
const SECRET_GRANT: &str = "spotify-grant";
/// Read-only `.env` seed used when the keychain holds no refresh token.
const ENV_REFRESH: &str = "SPOTIFY_REFRESH_TOKEN";
/// Windows Credential Manager blob limit (keyring `windows.rs`): UTF-16 bytes.
const SESSION_MAX_UTF16_BYTES: usize = 2560;
/// Refresh this long before the access token expires (lazily, at the next use).
const EXPIRY_MARGIN_SECS: u64 = 300;
/// Spotify caps a refresh token at 6 months from authorization.
const REFRESH_LIFETIME_SECS: u64 = 182 * 86_400;
/// Proactive renewal once this few days remain in the 6-month window.
const RENEW_DAYS: u32 = 7;
const DEFAULT_REDIRECT: &str = "http://127.0.0.1:1420/callback";
/// Manual Connect.
const AUTH_WAIT: Duration = Duration::from_secs(180);
/// Automatic re-auth prompts: the user may answer the tab much later.
const AUTO_AUTH_WAIT: Duration = Duration::from_secs(30 * 60);

pub(crate) const NOT_CONFIGURED: &str = "Spotify isn't set up — add SPOTIFY_CLIENT_ID (and SPOTIFY_CLIENT_SECRET) to the repo .env";
pub(crate) const NOT_CONNECTED: &str = "Spotify isn't connected — connect it in Settings → Integrations";
const NO_DEVICE: &str = "I couldn't find a Spotify device — open Spotify on this PC or your phone and try again";
const PREMIUM: &str = "Spotify playback control needs Premium";
const OWNER_PREMIUM: &str = "Spotify is blocking this app: the Spotify account that owns it in the Developer Dashboard needs an active Premium subscription (Spotify's rule for development-mode apps; it can take a few hours to clear after subscribing). Reconnecting won't help";
const NOT_REGISTERED: &str = "This Spotify account isn't on the app's user list — add it under Users Management in the Spotify Developer Dashboard (development mode allows 5 users)";
const KILL_SWITCH: &str = "kill switch is on — Spotify is a cloud service";
const REVOKED: &str = "Spotify access was revoked or expired — connect it again in Settings → Integrations";
pub(crate) const SCOPES_CHANGED: &str = "Spotify needs new permissions for this app — say \"reconnect Spotify\" or press Reconnect in Settings → Integrations";
pub(crate) const SCOPE_PROMPTED: &str = "Spotify needs one more permission for that — I opened the Spotify sign-in page. Approve it, then ask again.";
const QUOTA: &str = "Spotify's developer quota for this app is used up for now — try again later";

struct Access {
    token: String,
    /// Unix seconds.
    expires_at: u64,
    /// Unix seconds the token was obtained (or loaded), for the 401 policy.
    obtained_at: u64,
    scope: Option<String>,
}

static ACCESS: tokio::sync::Mutex<Option<Access>> = tokio::sync::Mutex::const_new(None);
/// Account cache from `GET /me`: display name + user id (playlist ownership).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AccountInfo {
    pub display: String,
    pub id: String,
}
static ACCOUNT: std::sync::Mutex<Option<AccountInfo>> = std::sync::Mutex::new(None);
/// Memory copy of the `spotify-grant` keychain entry (loaded lazily).
static GRANT: std::sync::Mutex<Option<Grant>> = std::sync::Mutex::new(None);
/// An automatic consent page was already opened in this run (any reason).
static PROMPTED_THIS_RUN: AtomicBool = AtomicBool::new(false);
static FLOW: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = std::sync::Mutex::new(None);
/// A rotated refresh token whose keychain write failed: preferred on the next refresh,
/// which retries the store; `access` also retries it on a short timer. Memory only.
static PENDING_REFRESH: std::sync::Mutex<Option<Pending>> = std::sync::Mutex::new(None);
/// Bumped by Disconnect, a fresh Connect and a wipe. A refresh that started under an
/// older epoch never writes credentials (keychain, session, `ACCESS`).
static AUTH_EPOCH: AtomicU64 = AtomicU64::new(0);
/// After a transient token-endpoint failure (network, 429, 5xx): no new refresh grant
/// before this unix time; callers get the last error instead. (until, error)
static REFRESH_BACKOFF: std::sync::Mutex<Option<(u64, String)>> = std::sync::Mutex::new(None);
/// Last time `retry_pending` tried the keychain (unix secs).
static PENDING_RETRY_AT: AtomicU64 = AtomicU64::new(0);
/// Minimum gap between eager retries of a pending keychain write.
const PENDING_RETRY_SECS: u64 = 30;
const SIGNIN_CHANGED: &str = "Spotify's sign-in changed while refreshing — try again";
/// SHA-256 of a `.env` seed Spotify rejected (invalid_grant), so it stops counting as "connected".
static ENV_SEED_REJECTED: std::sync::Mutex<Option<[u8; 32]>> = std::sync::Mutex::new(None);
/// Set by `warm` at startup: lets the detached refresh log and emit events.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

#[derive(Clone)]
struct Config {
    client_id: String,
    secret: Option<String>,
    redirect: String,
}

fn config(state: &DispatchState) -> Result<Config, String> {
    let client_id = env_or_file(state, "SPOTIFY_CLIENT_ID").ok_or(NOT_CONFIGURED)?;
    Ok(Config {
        client_id,
        secret: env_or_file(state, "SPOTIFY_CLIENT_SECRET"),
        redirect: env_or_file(state, "SPOTIFY_REDIRECT_URI").unwrap_or_else(|| DEFAULT_REDIRECT.into()),
    })
}

fn seed_hash(seed: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(seed.as_bytes()).into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Pure (D21): a seed is rejected when its hash matches the in-memory rejection or the
/// one persisted in the grant (so a rejected / disconnected seed never resurrects).
fn seed_rejected(seed: &str, mem: Option<[u8; 32]>, grant: &Grant) -> bool {
    let h = seed_hash(seed);
    mem == Some(h) || grant.rejected_seed.as_deref() == Some(hex(&h).as_str())
}

fn seed_is_rejected(seed: &str) -> bool {
    let mem = *ENV_SEED_REJECTED.lock().unwrap();
    seed_rejected(seed, mem, &load_grant())
}

/// The `.env` refresh-token seed, unless Spotify already rejected that exact value.
fn env_seed(state: &DispatchState) -> Option<String> {
    let seed = env_or_file(state, ENV_REFRESH)?;
    (!seed_is_rejected(&seed)).then_some(seed)
}

// ── Grant (scopes, consent time, prompt state; no token) ────────────────────

/// Keychain entry `spotify-grant` (Rust only; no token inside). Must fit SESSION_MAX_UTF16_BYTES.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Default)]
struct Grant {
    /// Space-separated scopes Spotify granted (code reply; updated from a refresh reply only when present).
    #[serde(default)]
    scope: Option<String>,
    /// hex SHA-256 of the sorted, space-joined SCOPES at authorization time.
    #[serde(default)]
    requested: Option<String>,
    /// Unix secs of the authorization_code exchange (6-month clock).
    #[serde(default)]
    at: Option<u64>,
    /// FINAL prompt key: never auto-prompts again for this key.
    #[serde(default)]
    prompted: Option<String>,
    /// (key, tries) of the last unanswered automatic prompt; a second try makes the key final.
    #[serde(default)]
    prompt_tries: Option<(String, u8)>,
    /// hex SHA-256 of a `.env` seed Spotify rejected or Disconnect dropped.
    #[serde(default)]
    rejected_seed: Option<String>,
}

/// sha256 hex of the sorted, space-joined SCOPES.
fn requested_hash() -> String {
    use sha2::Digest;
    let mut s: Vec<&str> = SCOPES.split_whitespace().collect();
    s.sort_unstable();
    hex(&sha2::Sha256::digest(s.join(" ").as_bytes()))
}

fn grant_blob(g: &Grant) -> Option<String> {
    let json = serde_json::to_string(g).ok()?;
    (json.encode_utf16().count() * 2 <= SESSION_MAX_UTF16_BYTES).then_some(json)
}

fn parse_grant(blob: &str) -> Grant {
    serde_json::from_str(blob).unwrap_or_default()
}

/// The grant for reading only (seed check, scope verdicts): a failed keychain read reads
/// as an empty grant. Anything that writes a modified grant back uses `try_load_grant`.
fn load_grant() -> Grant {
    try_load_grant().unwrap_or_default()
}

/// The grant from memory, else the keychain; Err when the keychain read failed. A failure
/// is not cached, and callers must not write anything back (a defaulted copy would erase
/// the persisted seed rejection, consent time and prompt state).
fn try_load_grant() -> Result<Grant, ()> {
    let mut cache = GRANT.lock().unwrap();
    if let Some(g) = cache.as_ref() {
        return Ok(g.clone());
    }
    let blob = os_core::os_secret_lookup(SECRET_GRANT).map_err(|_| ())?;
    let g = blob.as_deref().map(parse_grant).unwrap_or_default();
    let merged = merge_rejection(g.clone(), *ENV_SEED_REJECTED.lock().unwrap());
    *cache = Some(merged.clone());
    drop(cache);
    if merged != g {
        // A seed rejection this run couldn't persist earlier (the read had failed): store it now.
        store_grant(&merged);
    }
    Ok(merged)
}

/// Pure: a seed rejected in this run (memory) always reaches the persisted grant, so a
/// write built from a stale or failed read never drops it (D21).
fn merge_rejection(mut g: Grant, mem: Option<[u8; 32]>) -> Grant {
    if let Some(h) = mem {
        g.rejected_seed = Some(hex(&h));
    }
    g
}

/// Best effort, size-checked; the memory copy is always updated.
fn store_grant(g: &Grant) {
    let merged = merge_rejection(g.clone(), *ENV_SEED_REJECTED.lock().unwrap());
    let g = &merged;
    *GRANT.lock().unwrap() = Some(g.clone());
    let res = if *g == Grant::default() {
        os_core::os_secret_clear(SECRET_GRANT)
    } else {
        match grant_blob(g) {
            Some(blob) => os_core::os_secret_store(SECRET_GRANT, &blob),
            None => Err("too large for the keychain".into()),
        }
    };
    if let Err(e) = res {
        eprintln!("[spotify] couldn't save the grant to the keychain: {e}");
    }
}

/// Core scopes (used by Web API calls), in SCOPES order.
fn core_scopes() -> impl Iterator<Item = &'static str> {
    SCOPES.split_whitespace().filter(|s| !OPTIONAL_SCOPES.contains(s))
}

/// Core scopes this app asks for that `granted` lacks.
fn missing_scopes(granted: &str) -> Vec<&'static str> {
    let have: Vec<&str> = granted.split_whitespace().collect();
    core_scopes().filter(|s| !have.contains(s)).collect()
}

/// Which of `needed` (core only) `granted` lacks; scope unknown (None) ⇒ none.
fn missing_core<'a>(needed: &[&'a str], granted: Option<&str>) -> Vec<&'a str> {
    let Some(g) = granted else { return Vec::new() };
    let have: Vec<&str> = g.split_whitespace().collect();
    needed.iter().copied().filter(|s| !OPTIONAL_SCOPES.contains(s) && !have.contains(s)).collect()
}

/// `granted` is known and holds every core scope.
fn covers_core(granted: Option<&str>) -> bool {
    granted.is_some_and(|g| missing_scopes(g).is_empty())
}

#[derive(Debug, PartialEq)]
enum ScopeVerdict {
    Ok,
    Missing(Vec<&'static str>),
    /// Consent predates the current SCOPES.
    Stale,
}

/// Pure. `requested` != requested_hash() (incl. None) ⇒ Stale, except when `granted` covers
/// every core scope (then Ok; the caller writes `requested` silently). Missing lists core scopes only.
fn scope_verdict(granted: Option<&str>, requested: Option<&str>) -> ScopeVerdict {
    if requested != Some(requested_hash().as_str()) {
        return if covers_core(granted) { ScopeVerdict::Ok } else { ScopeVerdict::Stale };
    }
    match granted.map(missing_scopes) {
        Some(m) if !m.is_empty() => ScopeVerdict::Missing(m),
        _ => ScopeVerdict::Ok,
    }
}

/// Pure: the grant's scope wins; the session's is the fallback.
fn pick_scope(grant: Option<String>, session: impl FnOnce() -> Option<String>) -> Option<String> {
    grant.or_else(session)
}

/// Single source of truth for the granted scope: `grant.scope`, else the stored session's.
fn effective_scope() -> Option<String> {
    pick_scope(load_grant().scope, || os_core::os_secret(SECRET_SESSION).and_then(|b| parse_session(&b)).and_then(|s| s.scope))
}

/// Pure: the scope a refresh carries forward — `effective_scope()` (grant, else the stored
/// session blob, expired or not), else the in-memory token's.
fn previous_scope(effective: Option<String>, in_memory: Option<String>) -> Option<String> {
    effective.or(in_memory)
}

/// Pure (refresh): the reply's scope when present, else the previous one.
fn next_scope(reply: Option<&str>, prev: Option<&str>) -> Option<String> {
    reply.or(prev).map(String::from)
}

/// Days left in the 6-month window, if `at` is known and the window hasn't passed.
fn expires_in_days(at: Option<u64>, now: u64) -> Option<u32> {
    let end = at?.saturating_add(REFRESH_LIFETIME_SECS);
    (end > now).then(|| ((end - now) / 86_400).min(u64::from(u32::MAX)) as u32)
}

/// Proactive renewal is due (≤ RENEW_DAYS left).
fn renew_due(at: Option<u64>, now: u64) -> bool {
    expires_in_days(at, now).is_some_and(|d| d <= RENEW_DAYS)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ReauthReason {
    /// Consent predates the current SCOPES, or the grant misses a core scope.
    Scopes,
    /// A real 403 insufficient-scope from the API.
    Refused,
    /// Token endpoint said invalid_grant (6-month limit or revoked).
    Expired,
    /// Proactive renewal: ≤ 7 days left in the 6-month window.
    Renew,
}

impl ReauthReason {
    fn as_str(self) -> &'static str {
        match self {
            ReauthReason::Scopes => "scopes",
            ReauthReason::Refused => "refused",
            ReauthReason::Expired => "expired",
            ReauthReason::Renew => "renew",
        }
    }
}

/// "scopes:<hash16>" | "refused:<hash16>" | "expired:<at or 0>" | "renew:<at or 0>".
fn prompt_key(r: ReauthReason, hash: &str, at: Option<u64>) -> String {
    let h16: String = hash.chars().take(16).collect();
    let at = at.unwrap_or(0);
    match r {
        ReauthReason::Scopes => format!("scopes:{h16}"),
        ReauthReason::Refused => format!("refused:{h16}"),
        ReauthReason::Expired => format!("expired:{at}"),
        ReauthReason::Renew => format!("renew:{at}"),
    }
}

/// Pure: whether an automatic consent prompt may open now.
fn should_prompt(grant: &Grant, key: &str, kill: bool, server_enabled: bool, flow_running: bool, prompted_this_run: bool) -> bool {
    !kill && server_enabled && !flow_running && grant.prompted.as_deref() != Some(key) && !prompted_this_run
}

/// Pure: the grant after deciding to prompt for `key`. A second unanswered try is final.
fn record_prompt(g: &Grant, key: &str) -> Grant {
    let mut n = g.clone();
    match &g.prompt_tries {
        Some((k, _)) if k == key => {
            n.prompted = Some(key.to_string());
            n.prompt_tries = None;
        }
        _ => n.prompt_tries = Some((key.to_string(), 1)),
    }
    n
}

/// Pure (D4/D17): a real consent page when scopes change; click-free renewal when the
/// stored grant already covers every core scope.
fn show_dialog_for(reason: ReauthReason, granted: Option<&str>) -> bool {
    match reason {
        ReauthReason::Scopes | ReauthReason::Refused => true,
        ReauthReason::Expired | ReauthReason::Renew => !covers_core(granted),
    }
}

fn flow_running() -> bool {
    FLOW.lock().unwrap().as_ref().is_some_and(|h| !h.inner().is_finished())
}

/// Open Spotify's consent page automatically (at most once per run, twice per key).
/// Returns whether a prompt was started. No APP ⇒ false.
pub(crate) fn request_reauth(reason: ReauthReason) -> bool {
    request_reauth_with(reason, effective_scope())
}

/// `granted`: the scope `show_dialog_for` judges (Expired passes the scope it had before the wipe).
fn request_reauth_with(reason: ReauthReason, granted: Option<String>) -> bool {
    let Some(app) = APP.get().cloned() else { return false };
    let cfg = app.state::<OsState>().snapshot();
    let server_enabled = cfg.mcps.iter().any(|m| m.id == "spotify" && m.enabled);
    if config(&app.state::<DispatchState>()).is_err() {
        return false;
    }
    // A failed grant read decides nothing: recording the prompt would overwrite the real grant.
    let Ok(grant) = try_load_grant() else { return false };
    let key = prompt_key(reason, &requested_hash(), grant.at);
    if !should_prompt(&grant, &key, cfg.privacy.kill_switch, server_enabled, flow_running(), PROMPTED_THIS_RUN.load(Ordering::SeqCst)) {
        return false;
    }
    store_grant(&record_prompt(&grant, &key));
    PROMPTED_THIS_RUN.store(true, Ordering::SeqCst);
    let dialog = show_dialog_for(reason, granted.as_deref());
    eprintln!("[spotify] opening the Spotify sign-in page ({})", reason.as_str());
    tauri::async_runtime::spawn(async move {
        match begin_auth(app, dialog, AUTO_AUTH_WAIT, Origin::Auto(reason)).await {
            Ok(AuthStart { url }) => emit("spotify-reauth", json!({ "reason": reason.as_str(), "url": url, "silent": !dialog })),
            Err(e) => eprintln!("[spotify] couldn't start the automatic sign-in ({})", problem_kind(&e)),
        }
    });
    true
}

/// Before-a-call scope check: a missing core scope prompts (or not) and never calls the API.
pub(crate) fn scopes_cover(needed: &[&str]) -> Result<(), String> {
    if missing_core(needed, effective_scope().as_deref()).is_empty() {
        return Ok(());
    }
    Err(if request_reauth(ReauthReason::Scopes) { SCOPE_PROMPTED } else { SCOPES_CHANGED }.into())
}

/// The connected account's Spotify user id (from the last `GET /me`).
pub(crate) fn account_id() -> Option<String> {
    ACCOUNT.lock().unwrap().as_ref().map(|a| a.id.clone()).filter(|s| !s.is_empty())
}

/// A refresh credential exists (keychain, pending rotation or `.env` seed). A keychain
/// read failure counts as present: a Credential Manager hiccup is not "logged out".
fn has_refresh(state: &DispatchState) -> bool {
    match os_core::os_secret_lookup(SECRET_REFRESH) {
        Ok(Some(_)) | Err(_) => true,
        Ok(None) => PENDING_REFRESH.lock().unwrap().is_some() || env_seed(state).is_some(),
    }
}

/// Why the `spotify` builtin can't serve tools right now, if so.
pub(crate) fn readiness(state: &DispatchState) -> Result<(), String> {
    config(state)?;
    if has_refresh(state) {
        Ok(())
    } else {
        Err(NOT_CONNECTED.into())
    }
}

/// Classify a Spotify error for the UI: "reauth" (only a new sign-in helps),
/// "owner_premium" / "premium" (account rules), else "transient". Matches the
/// error constants, never free text.
pub(crate) fn problem_kind(err: &str) -> &'static str {
    if err == NOT_CONNECTED || err == REVOKED || err == SCOPES_CHANGED || err == SCOPE_PROMPTED {
        "reauth"
    } else if err == OWNER_PREMIUM {
        "owner_premium"
    } else if err == PREMIUM {
        "premium"
    } else if err == NOT_REGISTERED {
        "allowlist"
    } else {
        "transient"
    }
}

fn emit(event: &str, payload: Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

// ── PKCE / authorize URL ────────────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; N];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::Digest;
    b64url(&sha2::Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(client_id: &str, redirect: &str, challenge: &str, state: &str, show_dialog: bool) -> String {
    let dialog = if show_dialog { "true" } else { "false" };
    url::Url::parse_with_params(
        &format!("{ACCOUNTS}/authorize"),
        &[
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
            ("state", state),
            ("scope", SCOPES),
            ("show_dialog", dialog),
        ],
    )
    .map(String::from)
    .unwrap_or_default()
}

/// The loopback address and path the redirect URI points at.
fn redirect_target(uri: &str) -> Result<(SocketAddr, String), String> {
    let bad = || format!("SPOTIFY_REDIRECT_URI must be a loopback http URL like {DEFAULT_REDIRECT}");
    let u = url::Url::parse(uri).map_err(|_| bad())?;
    let ip: std::net::IpAddr = match u.host() {
        Some(url::Host::Ipv4(v)) => v.into(),
        Some(url::Host::Ipv6(v)) => v.into(),
        _ => return Err(bad()),
    };
    if u.scheme() != "http" || !ip.is_loopback() {
        return Err(bad());
    }
    Ok((SocketAddr::new(ip, u.port_or_known_default().unwrap_or(80)), u.path().to_string()))
}

// ── Callback ────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Callback {
    Code { code: String, state: String },
    Denied { error: String, state: String },
    /// Not the callback path (favicon…), or no code/error.
    Other,
}

/// First line of an HTTP request (`GET /callback?code=…&state=… HTTP/1.1`).
fn parse_callback(head: &str, path: &str) -> Callback {
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else { return Callback::Other };
    let Ok(u) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Other };
    if u.path() != path {
        return Callback::Other;
    }
    let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty());
    let state = get("state").unwrap_or_default();
    match (get("code"), get("error")) {
        (Some(code), _) => Callback::Code { code, state },
        (None, Some(error)) => Callback::Denied { error, state },
        _ => Callback::Other,
    }
}

fn denied_message(error: &str) -> String {
    if error == "access_denied" {
        "Spotify sign-in was cancelled".into()
    } else {
        format!("Spotify sign-in failed ({})", error.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect::<String>())
    }
}

fn html_reply(status: &str, message: &str) -> String {
    let body = format!("<!doctype html><meta charset=\"utf-8\"><title>Spotify</title><body style=\"font-family:system-ui;background:#0b0d11;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0\"><p>{message}</p></body>");
    format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}", body.len())
}

/// Why no authorization code arrived.
#[derive(Debug, PartialEq)]
enum CodeError {
    /// Spotify redirected with `error=…` (the user answered the consent page).
    Denied(String),
    /// The listener / gateway failed.
    Failed(String),
}

/// Serve the redirect on `listener` until the request carrying `expected` state arrives.
async fn listen_once(listener: tokio::net::TcpListener, path: &str, expected: &str) -> Result<String, CodeError> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| CodeError::Failed(format!("Spotify callback listener failed: {e}")))?;
        let mut buf = Vec::with_capacity(2048);
        let read = tokio::time::timeout(Duration::from_secs(5), async {
            let mut chunk = [0u8; 2048];
            while buf.len() < 8192 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
        })
        .await;
        if read.is_err() {
            continue;
        }
        let (reply, outcome) = match parse_callback(&String::from_utf8_lossy(&buf), path) {
            Callback::Code { code, state } if state == expected => (html_reply("200 OK", "Spotify connected — you can close this tab."), Some(Ok(code))),
            Callback::Denied { error, state } if state == expected => (html_reply("200 OK", "Spotify wasn't connected — you can close this tab."), Some(Err(CodeError::Denied(denied_message(&error))))),
            Callback::Code { .. } | Callback::Denied { .. } => (html_reply("400 Bad Request", "This Spotify sign-in link is stale — press Connect again in Settings."), None),
            Callback::Other => (html_reply("404 Not Found", "Not found."), None),
        };
        let _ = sock.write_all(reply.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(o) = outcome {
            return o;
        }
    }
}

/// Dev path: Vite proxies the redirect to the gateway, which holds it for us.
async fn poll_gateway(state: &DispatchState, os: &OsState, expected: &str) -> Result<String, CodeError> {
    let url = format!("{}/api/spotify/pending", state.snapshot().gateway.url.trim_end_matches('/'));
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if os.snapshot().privacy.kill_switch {
            return Err(CodeError::Failed(KILL_SWITCH.into()));
        }
        let mut rb = state.http.get(&url).query(&[("state", expected)]).timeout(Duration::from_secs(4));
        if let Some(t) = os_core::mesh_bearer(&os.snapshot()) {
            rb = rb.bearer_auth(t);
        }
        let Ok(r) = rb.send().await else { continue };
        let Ok(v) = r.json::<Value>().await else { continue };
        if let Some(code) = v["code"].as_str() {
            return Ok(code.to_string());
        }
        if let Some(e) = v["error"].as_str() {
            return Err(CodeError::Denied(denied_message(e)));
        }
    }
}

// ── Tokens ──────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
struct TokenReply {
    access: String,
    expires_in: u64,
    refresh: Option<String>,
    /// Space-separated scopes Spotify granted (None when the reply omits it).
    scope: Option<String>,
}

fn parse_token_reply(status: u16, body: &str) -> Result<TokenReply, String> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let code = v["error"].as_str().unwrap_or("");
        return Err(match code {
            "invalid_grant" => REVOKED.into(),
            "invalid_client" => "Spotify rejected the app credentials — check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in the repo .env".into(),
            _ => {
                let d = v["error_description"].as_str().unwrap_or(code);
                format!("Spotify sign-in failed (HTTP {status}){}", if d.is_empty() { String::new() } else { format!(": {}", d.chars().take(200).collect::<String>()) })
            }
        });
    }
    let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("Spotify returned no access token")?.to_string();
    Ok(TokenReply {
        access,
        expires_in: v["expires_in"].as_u64().unwrap_or(3600),
        refresh: v["refresh_token"].as_str().filter(|s| !s.is_empty()).map(String::from),
        scope: v["scope"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from),
    })
}

/// The OAuth error code of a token reply (`invalid_grant`, …), `[a-z_]` only: safe to log.
fn token_error_code(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    v["error"].as_str().unwrap_or("").chars().filter(|c| c.is_ascii_lowercase() || *c == '_').take(40).collect()
}

/// One token-endpoint call. `status` is 0 when no response arrived; `code` is the
/// OAuth error code ("network" without a response, "" on success).
struct TokenOutcome {
    status: u16,
    code: String,
    /// `Retry-After` seconds, when the reply carried one.
    retry_after: Option<u64>,
    result: Result<TokenReply, String>,
}

/// After a token-endpoint failure: the unix time before which no new refresh grant is
/// sent. Only transient failures back off (no reply, 429, 5xx); `Retry-After` wins,
/// clamped to 5..=300 s. Other 4xx (invalid_client…) retry at once, so a fixed config works.
fn backoff_until(status: u16, retry_after: Option<u64>, now: u64) -> Option<u64> {
    (status == 0 || status == 429 || status >= 500).then(|| now.saturating_add(retry_after.unwrap_or(30).clamp(5, 300)))
}

async fn token_request(http: &reqwest::Client, cfg: &Config, params: &[(&str, &str)]) -> TokenOutcome {
    let mut form: Vec<(&str, &str)> = params.to_vec();
    form.push(("client_id", &cfg.client_id));
    let mut rb = http.post(format!("{ACCOUNTS}/api/token")).form(&form).timeout(Duration::from_secs(8));
    if let Some(secret) = &cfg.secret {
        rb = rb.basic_auth(&cfg.client_id, Some(secret));
    }
    match rb.send().await {
        Err(e) => TokenOutcome { status: 0, code: "network".into(), retry_after: None, result: Err(format!("Spotify sign-in {}", short(e))) },
        Ok(r) => {
            let status = r.status().as_u16();
            let retry_after = r.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
            let body = r.text().await.unwrap_or_default();
            let code = if (200..300).contains(&status) { String::new() } else { token_error_code(&body) };
            TokenOutcome { status, code, retry_after, result: parse_token_reply(status, &body) }
        }
    }
}

/// The `spotify-session` keychain entry (Rust only, never the webview).
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct StoredSession {
    access_token: String,
    expires_at_unix: u64,
    #[serde(default)]
    scope: Option<String>,
}

/// The session as stored JSON, or None when it would overflow the keychain blob limit.
fn session_blob(s: &StoredSession) -> Option<String> {
    let json = serde_json::to_string(s).ok()?;
    (json.encode_utf16().count() * 2 <= SESSION_MAX_UTF16_BYTES).then_some(json)
}

fn parse_session(blob: &str) -> Option<StoredSession> {
    serde_json::from_str::<StoredSession>(blob).ok().filter(|s| !s.access_token.is_empty())
}

fn access_from(t: &TokenReply, now: u64) -> Access {
    Access { token: t.access.clone(), expires_at: now.saturating_add(t.expires_in), obtained_at: now, scope: t.scope.clone() }
}

/// Best effort: a failed write only costs one refresh grant on the next launch.
fn store_session(a: &Access) {
    let s = StoredSession { access_token: a.token.clone(), expires_at_unix: a.expires_at, scope: a.scope.clone() };
    match session_blob(&s) {
        Some(blob) => {
            if let Err(e) = os_core::os_secret_store(SECRET_SESSION, &blob) {
                eprintln!("[spotify] couldn't save the session to the keychain: {e}");
            }
        }
        None => {
            let _ = os_core::os_secret_clear(SECRET_SESSION);
            eprintln!("[spotify] session too large for the keychain; not saved");
        }
    }
}

/// A saved access token that is still valid at `now`. Its age is unknown, so it
/// counts as older than the 401 grace period.
fn load_session(now: u64) -> Option<Access> {
    let s = parse_session(&os_core::os_secret(SECRET_SESSION)?)?;
    (s.expires_at_unix > now).then(|| Access { token: s.access_token, expires_at: s.expires_at_unix, obtained_at: now.saturating_sub(60), scope: s.scope })
}

/// Whether a token expiring at `expires_at` (unix secs) must be refreshed at `now`.
fn needs_refresh(expires_at: u64, now: u64, force: bool) -> bool {
    force || expires_at <= now.saturating_add(EXPIRY_MARGIN_SECS)
}

/// Compare-and-store: write `new` only if nobody changed the keychain since it held
/// `was` (Disconnect, a fresh Connect, another app instance), and only if it differs.
fn should_store(stored_now: Option<&str>, was: Option<&str>, new: &str) -> bool {
    stored_now == was && stored_now != Some(new)
}

#[derive(Debug, PartialEq)]
enum OnInvalidGrant {
    /// Someone else rotated the token meanwhile: try theirs once.
    RetryWith(String),
    /// The token we used is still the stored one: it really is dead.
    Clear,
}

#[cfg(test)]
fn on_invalid_grant(used: &str, stored: Option<&str>, pending: Option<&str>) -> OnInvalidGrant {
    grant_verdict(stored, pending, &[used.to_string()])
}

/// After invalid_grant: retry with a token this call hasn't sent yet (pending first,
/// then the keychain). When every candidate was already refused, the credentials are dead.
fn grant_verdict(stored: Option<&str>, pending: Option<&str>, tried: &[String]) -> OnInvalidGrant {
    let fresh = |t: &&str| !tried.iter().any(|x| x == t);
    match pending.filter(fresh).or(stored.filter(fresh)) {
        Some(other) => OnInvalidGrant::RetryWith(other.to_string()),
        None => OnInvalidGrant::Clear,
    }
}

/// Whether a Web API 401 is worth one forced refresh: the token isn't brand new,
/// or Spotify says it expired / is invalid. Otherwise a persistent 401 would run
/// a refresh grant (and maybe a rotation) on every widget poll.
fn retry_401(age_secs: u64, body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    age_secs > 5 || b.contains("expired") || b.contains("invalid access token") || b.contains("invalid token")
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Source {
    Keychain,
    Pending,
    EnvSeed,
}

/// The refresh credential to use: a pending rotation, then the keychain, then the
/// `.env` seed → (token, source, what the keychain held when read).
fn current_refresh(seed: Option<&str>) -> Result<(String, Source, Was), String> {
    let lookup = os_core::os_secret_lookup(SECRET_REFRESH);
    let pending = PENDING_REFRESH.lock().unwrap().clone();
    pick_refresh(lookup, pending, seed)
}

/// A rotated refresh token not yet in the keychain.
#[derive(Clone, Debug, PartialEq)]
struct Pending {
    token: String,
    /// What the keychain held when this rotation was made (None: unknown, the keychain
    /// couldn't be read). Storing is only safe while the keychain still holds it.
    base: Option<Option<String>>,
}

/// What the keychain held when the refresh credential was picked. `Unknown` (the read
/// failed) is not "empty": it never takes the "sign-in changed" exit nor compare-and-stores.
#[derive(Clone, Debug, PartialEq)]
enum Was {
    Known(Option<String>),
    Unknown,
}

/// `current_refresh` without the I/O. A pending token stays usable while keychain reads
/// fail (the usual reason its write failed).
fn pick_refresh(lookup: Result<Option<String>, String>, pending: Option<Pending>, seed: Option<&str>) -> Result<(String, Source, Was), String> {
    if let Some(p) = pending {
        let was = match lookup {
            Ok(s) => Was::Known(s),
            Err(_) => p.base.map_or(Was::Unknown, Was::Known),
        };
        return Ok((p.token, Source::Pending, was));
    }
    let stored = lookup?;
    if let Some(s) = stored.clone() {
        return Ok((s, Source::Keychain, Was::Known(stored)));
    }
    seed.map(|s| (s.to_string(), Source::EnvSeed, Was::Known(None))).ok_or_else(|| NOT_CONNECTED.into())
}

#[derive(Debug, PartialEq)]
enum PendingAction {
    /// The keychain already holds it: just forget the pending copy.
    AlreadySaved,
    Store,
    /// Unknown base, or someone else changed the keychain: leave it to the next grant.
    Leave,
}

fn pending_action(stored: Option<&str>, p: &Pending) -> PendingAction {
    if stored == Some(p.token.as_str()) {
        return PendingAction::AlreadySaved;
    }
    match &p.base {
        Some(base) if should_store(stored, base.as_deref(), &p.token) => PendingAction::Store,
        _ => PendingAction::Leave,
    }
}

/// Retry saving a pending rotated token (rate-limited). Call with `ACCESS` held so it
/// can't interleave with a refresh, Connect or Disconnect.
fn retry_pending(now: u64) {
    let Some(p) = PENDING_REFRESH.lock().unwrap().clone() else { return };
    if now.saturating_sub(PENDING_RETRY_AT.load(Ordering::SeqCst)) < PENDING_RETRY_SECS {
        return;
    }
    PENDING_RETRY_AT.store(now, Ordering::SeqCst);
    let Ok(stored) = os_core::os_secret_lookup(SECRET_REFRESH) else { return };
    let saved = match pending_action(stored.as_deref(), &p) {
        PendingAction::AlreadySaved => true,
        PendingAction::Store => os_core::os_secret_store(SECRET_REFRESH, &p.token).is_ok(),
        PendingAction::Leave => false,
    };
    if saved {
        let mut g = PENDING_REFRESH.lock().unwrap();
        if g.as_ref().is_some_and(|q| q.token == p.token) {
            *g = None;
        }
    }
}

/// Codes and booleans only — never a token.
fn log_refresh(ok: bool, status: u16, code: &str, rotated: bool) {
    eprintln!("[spotify] refresh ok={ok} status={status} error={code} rotated={rotated}");
    if let Some(app) = APP.get() {
        app.state::<BridgeState>().log(json!({ "type": "spotify-refresh", "ok": ok, "status": status, "error_code": code, "rotated": rotated }));
    }
}

/// `base`: what the keychain holds now (the compare-and-store just passed against it).
fn persist_refresh(new: &str, base: Option<String>) {
    match os_core::os_secret_store(SECRET_REFRESH, new) {
        Ok(()) => *PENDING_REFRESH.lock().unwrap() = None,
        Err(e) => {
            eprintln!("[spotify] couldn't save the rotated refresh token ({e}); keeping it in memory and retrying");
            *PENDING_REFRESH.lock().unwrap() = Some(Pending { token: new.to_string(), base: Some(base) });
        }
    }
}

/// Spotify rejected the stored refresh token for good: forget every credential
/// (never the `.env` file — a rejected seed is only ignored). Call with `ACCESS` held.
fn wipe_credentials(source: Source, used: &str) {
    AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
    // The grant keeps `at` / `requested` / prompt state (the Expired key uses `at`); only
    // the granted scope is gone. A rejected seed is persisted so it never resurrects.
    if source == Source::EnvSeed {
        *ENV_SEED_REJECTED.lock().unwrap() = Some(seed_hash(used));
    } else {
        let _ = os_core::os_secret_clear(SECRET_REFRESH);
    }
    // Merge into the stored grant only when it could be read; otherwise the memory rejection
    // is persisted by the next successful grant read or write (`merge_rejection`).
    match try_load_grant() {
        Ok(mut g) => {
            g.scope = None;
            store_grant(&g);
        }
        Err(()) => eprintln!("[spotify] couldn't read the grant; it will be updated later"),
    }
    let _ = os_core::os_secret_clear(SECRET_SESSION);
    *PENDING_REFRESH.lock().unwrap() = None;
    *REFRESH_BACKOFF.lock().unwrap() = None;
    *ACCOUNT.lock().unwrap() = None;
}

/// Tell the UI the sign-in is gone (after `wipe_credentials`, with `ACCESS` released).
fn announce_wipe() {
    // Not `spotify-auth`: that would resolve an interactive Connect in flight.
    emit("spotify-session", json!({ "connected": false, "kind": "reauth" }));
    if let Some(app) = APP.get() {
        super::mcp::emit_tools_changed(app, "spotify-revoked");
    }
}

/// The refresh grant, run detached: it owns the `ACCESS` lock and finishes (HTTP
/// call, keychain writes) even when the caller that spawned it has gone away.
/// `seed`: the raw `.env` value; Disconnect's rejection is applied under the lock.
/// `reject`: a token the caller just saw refused, never handed back.
async fn refresh_owned(http: reqwest::Client, cfg: Config, seed: Option<String>, reject: Option<String>) -> Result<(String, u64), String> {
    let epoch = AUTH_EPOCH.load(Ordering::SeqCst);
    let mut slot = ACCESS.lock().await;
    // Disconnect marks the seed rejected before it takes ACCESS, so a refresh that gets
    // the lock after it can never fall back to that seed and silently reconnect.
    let seed = seed.filter(|s| !seed_is_rejected(s));
    let now = os_core::now_secs();
    if slot.is_none() {
        *slot = load_session(now);
    }
    // A refresh that finished while this one queued already did the work.
    if let Some(a) = slot.as_ref().filter(|a| !needs_refresh(a.expires_at, now, false) && reject.as_deref() != Some(a.token.as_str())) {
        return Ok((a.token.clone(), now.saturating_sub(a.obtained_at)));
    }
    // The token endpoint just failed transiently: don't hammer it (the widget polls every 4 s).
    if let Some((until, err)) = REFRESH_BACKOFF.lock().unwrap().clone() {
        if now < until {
            return Err(err);
        }
    }
    let (mut used, mut source, mut was) = current_refresh(seed.as_deref())?;
    let mut tried = vec![used.clone()];
    let mut retried = false;
    loop {
        let out = token_request(&http, &cfg, &[("grant_type", "refresh_token"), ("refresh_token", &used)]).await;
        let rotated = matches!(&out.result, Ok(t) if t.refresh.as_deref().is_some_and(|r| r != used));
        log_refresh(out.result.is_ok(), out.status, &out.code, rotated);
        match out.result {
            Ok(t) => {
                // Disconnected / reconnected while this ran: write nothing at all.
                if AUTH_EPOCH.load(Ordering::SeqCst) != epoch {
                    return Err(SIGNIN_CHANGED.into());
                }
                *REFRESH_BACKOFF.lock().unwrap() = None;
                let new = t.refresh.clone().unwrap_or_else(|| used.clone());
                match (&was, os_core::os_secret_lookup(SECRET_REFRESH)) {
                    // Changed by someone else (another instance) while this ran: leave it alone.
                    (Was::Known(w), Ok(now_stored)) if now_stored != *w => return Err(SIGNIN_CHANGED.into()),
                    (Was::Known(w), Ok(now_stored)) => {
                        // A `.env` seed stays read-only unless Spotify rotated it.
                        if should_store(now_stored.as_deref(), w.as_deref(), &new) && (source != Source::EnvSeed || rotated) {
                            persist_refresh(&new, now_stored);
                        } else if now_stored.as_deref() == Some(new.as_str()) {
                            *PENDING_REFRESH.lock().unwrap() = None;
                        }
                    }
                    // Can't compare right now: keep a rotation in memory, store it later.
                    (w, _) if rotated || source == Source::Pending => {
                        let base = match w {
                            Was::Known(b) => Some(b.clone()),
                            Was::Unknown => None,
                        };
                        *PENDING_REFRESH.lock().unwrap() = Some(Pending { token: new, base });
                    }
                    _ => {}
                }
                // A refresh reply may omit `scope`: carry the previous one forward. The
                // stored session counts even when its token has expired (`slot` is None then).
                let prev = previous_scope(effective_scope(), slot.as_ref().and_then(|a| a.scope.clone()));
                let mut a = access_from(&t, os_core::now_secs());
                a.scope = next_scope(t.scope.as_deref(), prev.as_deref());
                // Disconnect / Connect while the keychain work above ran: write nothing.
                if AUTH_EPOCH.load(Ordering::SeqCst) != epoch {
                    return Err(SIGNIN_CHANGED.into());
                }
                if t.scope.is_some() {
                    // Never write back a grant whose read failed.
                    if let Ok(mut g) = try_load_grant() {
                        if g.scope != t.scope {
                            g.scope = t.scope.clone();
                            store_grant(&g);
                        }
                    }
                }
                store_session(&a);
                *slot = Some(a);
                return Ok((t.access, 0));
            }
            Err(e) if out.code == "invalid_grant" => {
                // Re-read before clearing: another instance may have rotated it.
                let stored = os_core::os_secret_lookup(SECRET_REFRESH)?;
                let pending = PENDING_REFRESH.lock().unwrap().clone().map(|p| p.token);
                match grant_verdict(stored.as_deref(), pending.as_deref(), &tried) {
                    OnInvalidGrant::RetryWith(other) if !retried => {
                        retried = true;
                        source = if pending.as_deref() == Some(other.as_str()) { Source::Pending } else { Source::Keychain };
                        was = Was::Known(stored);
                        tried.push(other.clone());
                        used = other;
                    }
                    // Yet another untried token appeared (another instance): keep everything.
                    OnInvalidGrant::RetryWith(_) => return Err(e),
                    OnInvalidGrant::Clear => {
                        if AUTH_EPOCH.load(Ordering::SeqCst) != epoch {
                            return Err(e); // Disconnect / Connect already settled the credentials
                        }
                        // The scope it had, so a full prior grant renews without a click.
                        let previous_scope = previous_scope(effective_scope(), slot.as_ref().and_then(|a| a.scope.clone()));
                        // Clear under ACCESS: a Connect can't land between the re-read and the clear.
                        *slot = None;
                        wipe_credentials(source, &used);
                        drop(slot); // never hold ACCESS across the events
                        announce_wipe();
                        request_reauth_with(ReauthReason::Expired, previous_scope);
                        return Err(e);
                    }
                }
            }
            // Network, timeout, 5xx, 429, invalid_client…: keep every credential.
            Err(e) => {
                if let Some(until) = backoff_until(out.status, out.retry_after, os_core::now_secs()) {
                    *REFRESH_BACKOFF.lock().unwrap() = Some((until, e.clone()));
                }
                return Err(e);
            }
        }
    }
}

/// A usable access token and its age in seconds. Refreshes (detached) when it
/// expires within a minute or equals `reject`.
async fn access(state: &DispatchState, reject: Option<&str>) -> Result<(String, u64), String> {
    {
        let mut slot = ACCESS.lock().await;
        let now = os_core::now_secs();
        retry_pending(now);
        if slot.is_none() {
            *slot = load_session(now);
        }
        if let Some(a) = slot.as_ref().filter(|a| !needs_refresh(a.expires_at, now, false) && Some(a.token.as_str()) != reject) {
            return Ok((a.token.clone(), now.saturating_sub(a.obtained_at)));
        }
    }
    let cfg = config(state)?;
    // The raw seed: refresh_owned applies Disconnect's rejection under ACCESS.
    let task = tauri::async_runtime::spawn(refresh_owned(state.http.clone(), cfg, env_or_file(state, ENV_REFRESH), reject.map(String::from)));
    task.await.map_err(|_| "Spotify token refresh was interrupted — try again".to_string())?
}

async fn exchange(state: &DispatchState, code: &str, verifier: &str) -> Result<(), String> {
    let cfg = config(state)?;
    let t = token_request(&state.http, &cfg, &[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", &cfg.redirect), ("code_verifier", verifier)]).await.result?;
    let refresh = t.refresh.as_deref().ok_or("Spotify returned no refresh token")?;
    // Hold ACCESS across the keychain writes (never across the HTTP call): a refresh in
    // flight can't overwrite or wipe this sign-in, and one queued behind it sees it fresh.
    let mut slot = ACCESS.lock().await;
    AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
    // Clean replacement: old refresh, session and grant go (only a seed rejection stays).
    // A failed read still keeps this run's rejection: `store_grant` merges the memory copy.
    let rejected_seed = try_load_grant().ok().and_then(|g| g.rejected_seed);
    let _ = os_core::os_secret_clear(SECRET_REFRESH);
    let _ = os_core::os_secret_clear(SECRET_SESSION);
    store_grant(&Grant { rejected_seed: rejected_seed.clone(), ..Grant::default() });
    let now = os_core::now_secs();
    let stored = os_core::os_secret_store(SECRET_REFRESH, refresh);
    *PENDING_REFRESH.lock().unwrap() = None;
    *REFRESH_BACKOFF.lock().unwrap() = None;
    PROMPTED_THIS_RUN.store(false, Ordering::SeqCst);
    stored?;
    let a = access_from(&t, now);
    store_session(&a);
    // If this store fails, the next boot sees `requested: None` with a full session scope:
    // scope_verdict says Ok and `warm` rewrites the grant silently (only `at` is lost).
    store_grant(&Grant { scope: t.scope.clone(), requested: Some(requested_hash()), at: Some(now), prompted: None, prompt_tries: None, rejected_seed });
    *slot = Some(a);
    clear_playlist_cache();
    Ok(())
}

// ── Web API ─────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub(crate) enum ApiError {
    NoDevice,
    Premium,
    OwnerPremium,
    /// Development-mode app and this account isn't on its user list.
    NotRegistered,
    /// Insufficient scope; `prompted`: an automatic consent page was opened.
    Scope { prompted: bool },
    /// Retry-After seconds, when given.
    RateLimited(Option<u64>),
    Quota,
    NotFound(String),
    Forbidden(String),
    Msg(String),
}

impl From<String> for ApiError {
    fn from(s: String) -> Self {
        ApiError::Msg(s)
    }
}

fn with_msg(msg: &str) -> String {
    if msg.is_empty() {
        String::new()
    } else {
        format!(": {msg}")
    }
}

impl ApiError {
    pub(crate) fn text(self) -> String {
        match self {
            ApiError::NoDevice => NO_DEVICE.into(),
            ApiError::Premium => PREMIUM.into(),
            ApiError::OwnerPremium => OWNER_PREMIUM.into(),
            ApiError::NotRegistered => NOT_REGISTERED.into(),
            ApiError::Scope { prompted: true } => SCOPE_PROMPTED.into(),
            ApiError::Scope { prompted: false } => SCOPES_CHANGED.into(),
            ApiError::RateLimited(Some(n)) => format!("Spotify is rate-limiting requests — try again in {n} seconds"),
            ApiError::RateLimited(None) => "Spotify is rate-limiting requests — try again in a minute".into(),
            ApiError::Quota => QUOTA.into(),
            ApiError::NotFound(m) => format!("Spotify couldn't find that{}", with_msg(&m)),
            ApiError::Forbidden(m) => format!("Spotify refused that (HTTP 403){}. If it keeps happening, disconnect and reconnect Spotify in Settings → Integrations", with_msg(&m)),
            ApiError::Msg(m) => m,
        }
    }
}

/// Pure classifier (path-free). An empty-body 403 is `Forbidden("")`; `send` upgrades it to
/// `Scope` off `/me/player` while the grant is known-incomplete. "Restriction violated"
/// (pausing a paused player) stays `Msg` with that text — `is_restriction` relies on it.
fn api_error(status: u16, body: &str, retry_after: Option<u64>) -> ApiError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let reason = v["error"]["reason"].as_str().unwrap_or("");
    let msg: String = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).unwrap_or("").chars().take(200).collect();
    let lc = msg.to_ascii_lowercase();
    let raw = body.to_ascii_lowercase();
    match status {
        404 if reason == "NO_ACTIVE_DEVICE" || lc.contains("no active device") => ApiError::NoDevice,
        404 => ApiError::NotFound(msg),
        403 if lc.contains("restriction violated") => ApiError::Msg(format!("Spotify error (HTTP 403): {msg}")),
        // Development-mode apps: Spotify refuses EVERY call (even /me) unless the account that
        // owns the app in the Developer Dashboard has Premium. Not fixable by reconnecting.
        403 if lc.contains("owner of the app") => ApiError::OwnerPremium,
        403 if raw.contains("not registered") || raw.contains("developer dashboard") => ApiError::NotRegistered,
        403 if reason == "PREMIUM_REQUIRED" || lc.contains("premium") => ApiError::Premium,
        403 if lc.contains("scope") => ApiError::Scope { prompted: false },
        403 => ApiError::Forbidden(msg),
        // Not "connect it again": a 401 the forced refresh couldn't fix is rarely a dead sign-in
        // (that surfaces as invalid_grant → REVOKED), so the UI must not demand re-auth for it.
        401 if msg.is_empty() => ApiError::Msg("Spotify refused the request (HTTP 401)".into()),
        401 => ApiError::Msg(format!("Spotify refused the request (HTTP 401): {msg}")),
        429 if reason == "QUOTA_EXCEEDED" => ApiError::Quota,
        429 => ApiError::RateLimited(retry_after),
        500..=599 => ApiError::Msg(format!("Spotify had a server problem (HTTP {status}) — try again in a moment")),
        _ if msg.is_empty() => ApiError::Msg(format!("Spotify error (HTTP {status})")),
        _ => ApiError::Msg(format!("Spotify error (HTTP {status}): {msg}")),
    }
}

/// Pure: whether an empty-body 403 on `path` should count as a scope refusal.
fn forbidden_is_scope(path: &str, verdict: &ScopeVerdict) -> bool {
    !path.starts_with("/me/player") && *verdict != ScopeVerdict::Ok
}

/// One Web API call; 2xx → its JSON (Null for 204/201/empty). Retries once on a 401
/// with a fresh token when `retry_401` says a refresh can help, and once on a 429 whose
/// Retry-After is ≤ 2 s. A scope refusal opens the consent page (`Refused`) once.
pub(crate) async fn send(state: &DispatchState, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, ApiError> {
    let mut reject: Option<String> = None;
    let mut retried_429 = false;
    for attempt in 0..3 {
        let (token, age) = access(state, reject.as_deref()).await?;
        let mut rb = state.http.request(method.clone(), format!("{API}{path}")).bearer_auth(&token).timeout(Duration::from_secs(8));
        if !query.is_empty() {
            rb = rb.query(query);
        }
        rb = match body {
            Some(b) => rb.json(b),
            // Spotify answers 411 to a body-less PUT/POST without Content-Length. An empty
            // `body("")` doesn't help: hyper sees an empty body as "no body" and writes no
            // Content-Length at all, but it does keep one the caller set explicitly.
            None if method != reqwest::Method::GET => rb.header(reqwest::header::CONTENT_LENGTH, "0"),
            None => rb,
        };
        let r = rb.send().await.map_err(|e| ApiError::Msg(format!("Spotify {}", short(e))))?;
        let status = r.status().as_u16();
        let retry_after = r.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
        let text = r.text().await.unwrap_or_default();
        if status == 401 && reject.is_none() && attempt < 2 && retry_401(age, &text) {
            reject = Some(token);
            continue;
        }
        if (200..300).contains(&status) {
            return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
        }
        let err = api_error(status, &text, retry_after);
        if let (ApiError::RateLimited(Some(secs)), false) = (&err, retried_429) {
            if *secs <= 2 && attempt < 2 {
                retried_429 = true;
                tokio::time::sleep(Duration::from_secs(*secs)).await;
                continue;
            }
        }
        let err = match err {
            ApiError::Forbidden(m) if m.is_empty() && forbidden_is_scope(path, &scope_verdict(effective_scope().as_deref(), load_grant().requested.as_deref())) => ApiError::Scope { prompted: false },
            other => other,
        };
        return Err(match err {
            ApiError::Scope { .. } => ApiError::Scope { prompted: request_reauth(ReauthReason::Refused) },
            other => other,
        });
    }
    Err(api_error(401, "", None))
}

pub(crate) async fn get(state: &DispatchState, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    send(state, reqwest::Method::GET, path, query, None).await.map_err(ApiError::text)
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    is_playing: bool,
    track: Option<String>,
    artists: Vec<String>,
    album: Option<String>,
    art_url: Option<String>,
    progress_ms: u64,
    duration_ms: u64,
    device: Option<String>,
    volume: Option<u8>,
    shuffle: bool,
    uri: Option<String>,
}

fn first_image(images: &Value) -> Option<String> {
    images.as_array()?.iter().find_map(|i| i["url"].as_str()).map(String::from)
}

fn names(list: &Value) -> Vec<String> {
    list.as_array().into_iter().flatten().filter_map(|a| a["name"].as_str().map(String::from)).collect()
}

/// `GET /me/player` JSON (Null when Spotify answered 204 — nothing playing).
fn parse_now_playing(v: &Value) -> NowPlaying {
    let item = &v["item"];
    let episode = item["type"] == "episode";
    NowPlaying {
        is_playing: v["is_playing"].as_bool().unwrap_or(false),
        track: item["name"].as_str().map(String::from),
        artists: if episode { item["show"]["name"].as_str().map(String::from).into_iter().collect() } else { names(&item["artists"]) },
        album: if episode { None } else { item["album"]["name"].as_str().map(String::from) },
        art_url: first_image(if episode { &item["images"] } else { &item["album"]["images"] }),
        progress_ms: v["progress_ms"].as_u64().unwrap_or(0),
        duration_ms: item["duration_ms"].as_u64().unwrap_or(0),
        device: v["device"]["name"].as_str().map(String::from),
        volume: v["device"]["volume_percent"].as_u64().map(|p| p.min(100) as u8),
        shuffle: v["shuffle_state"].as_bool().unwrap_or(false),
        uri: item["uri"].as_str().map(String::from),
    }
}

async fn now_playing(state: &DispatchState) -> Result<NowPlaying, String> {
    get(state, "/me/player", &[("additional_types", "episode".into())]).await.map(|v| parse_now_playing(&v))
}

fn mmss(ms: u64) -> String {
    format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickItem {
    uri: String,
    title: String,
    subtitle: String,
    art_url: Option<String>,
}

/// `recently-played` → newest first, one row per track.
fn parse_recent(v: &Value) -> Vec<QuickItem> {
    let mut out: Vec<QuickItem> = Vec::new();
    for t in v["items"].as_array().into_iter().flatten().map(|i| &i["track"]) {
        let (Some(uri), Some(title)) = (t["uri"].as_str(), t["name"].as_str()) else { continue };
        if out.iter().any(|q| q.uri == uri) {
            continue;
        }
        out.push(QuickItem { uri: uri.into(), title: title.into(), subtitle: names(&t["artists"]).join(", "), art_url: first_image(&t["album"]["images"]) });
        if out.len() == 10 {
            break;
        }
    }
    out
}

fn parse_playlists(v: &Value) -> Vec<QuickItem> {
    v["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(QuickItem { uri: p["uri"].as_str()?.into(), title: p["name"].as_str()?.into(), subtitle: p["owner"]["display_name"].as_str().unwrap_or("").into(), art_url: first_image(&p["images"]) })
        })
        .collect()
}

/// Body for a raw URI from the widget: tracks / episodes as `uris`, anything else as a context.
fn uri_body(uri: &str) -> Value {
    if uri.starts_with("spotify:track:") || uri.starts_with("spotify:episode:") {
        json!({ "uris": [uri] })
    } else {
        json!({ "context_uri": uri })
    }
}

/// A launch target for a raw URI (the label is never spoken: the widget reply is fixed).
fn uri_target(uri: &str) -> Target {
    if uri.starts_with("spotify:track:") || uri.starts_with("spotify:episode:") {
        Target::Track { uri: uri.to_string(), label: String::new() }
    } else {
        let kind = if uri.starts_with("spotify:artist:") {
            SearchKind::Artist
        } else if uri.starts_with("spotify:album:") {
            SearchKind::Album
        } else {
            SearchKind::Playlist
        };
        Target::Context { uri: uri.to_string(), label: String::new(), kind }
    }
}

fn valid_uri(uri: &str) -> bool {
    let parts: Vec<&str> = uri.split(':').collect();
    let id_ok = |id: &str| (16..=40).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric());
    match parts.as_slice() {
        ["spotify", kind, id] => ["track", "album", "playlist", "artist", "episode", "show"].contains(kind) && id_ok(id),
        ["spotify", "user", user, "playlist", id] => !user.is_empty() && user.len() <= 64 && id_ok(id),
        _ => false,
    }
}

async fn play_uri(state: &DispatchState, uri: &str) -> Result<String, String> {
    let uri = uri.trim();
    if !valid_uri(uri) {
        return Err("that isn't a Spotify URI".into());
    }
    scopes_cover(intent::tool_scopes("spotify.play"))?;
    let target = uri_target(uri);
    let o = start(state, Some(&target), Some(&uri_body(uri)), None, None).await?;
    Ok(if o.launched { "Opened Spotify. Playing on Spotify." } else { "Playing on Spotify." }.into())
}

/// Volume `value`: a number (absolute %), or a string — "40", "40%", or a relative "+15" / "-15".
fn volume_target(current: Option<u8>, value: Option<&Value>) -> Result<u8, String> {
    let bad = || "volume needs a number from 0 to 100 (or +N / -N)".to_string();
    let v = value.ok_or_else(bad)?;
    let target = match v {
        Value::Number(n) => n.as_f64().ok_or_else(bad)?,
        Value::String(s) => {
            let s = s.trim().trim_end_matches('%').trim();
            let n: f64 = s.trim_start_matches('+').parse().map_err(|_| bad())?;
            if s.starts_with('+') || s.starts_with('-') {
                f64::from(current.unwrap_or(50)) + n
            } else {
                n
            }
        }
        _ => return Err(bad()),
    };
    if !target.is_finite() {
        return Err(bad());
    }
    Ok(target.round().clamp(0.0, 100.0) as u8)
}

fn shuffle_target(current: bool, value: Option<&Value>) -> Result<bool, String> {
    match value {
        None | Some(Value::Null) => Ok(!current),
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "on" | "true" | "1" => Ok(true),
            "off" | "false" | "0" => Ok(false),
            "toggle" | "" => Ok(!current),
            _ => Err("shuffle needs on, off or toggle".into()),
        },
        _ => Err("shuffle needs on, off or toggle".into()),
    }
}

fn is_restriction(err: &str) -> bool {
    err.contains("Restriction violated")
}

async fn fetch_account(state: &DispatchState) -> Result<String, String> {
    let me = get(state, "/me", &[]).await?;
    let name = me["display_name"].as_str().filter(|s| !s.is_empty()).or_else(|| me["id"].as_str()).unwrap_or("Spotify user").to_string();
    let id = me["id"].as_str().unwrap_or("").to_string();
    *ACCOUNT.lock().unwrap() = Some(AccountInfo { display: name.clone(), id });
    Ok(name)
}

// ── Tool suite (23 tools) ───────────────────────────────────────────────────
//
// Every reply below is a speakable template (contract §6): no URI, id, JSON or HTTP code.
// Soft outcomes the user should simply hear ("Nothing is playing on Spotify.", "I couldn't
// find …", a question) are `Ok`; account / network / device failures are `Err` text.

pub(crate) const NOTHING_PLAYING: &str = "Nothing is playing on Spotify.";
const NOTHING_PLAYING_NOW: &str = "Nothing is playing on Spotify right now.";
const NOTHING_PLAYING_FOR_TRACK: &str = "Nothing is playing on Spotify, so I'm not sure which song you mean.";
const LAUNCH_NOT_READY: &str = "Spotify is opening but isn't ready yet — give it a few seconds and ask again.";
const LAUNCH_FAILED: &str = "I couldn't open Spotify on this PC — open it yourself and ask again";
const ONLY_RESTRICTED: &str = "Your Spotify device doesn't accept remote control — open Spotify on this PC or your phone";
const LIKED_REFUSED: &str = "Spotify won't let me start Liked Songs from here.";
const NOT_EDITABLE: &str = "I can only add songs to playlists you own or collaborate on.";
const NOT_EDITABLE_REMOVE: &str = "I can only remove songs from playlists you own or collaborate on.";
const PLAYLIST_UNREADABLE: &str = "I can't read that playlist — Spotify only lets this app read playlists you own or collaborate on.";
const NO_DEVICES: &str = "No Spotify devices are available right now.";
const NO_VOLUME: &str = "That device doesn't let me change its volume.";
/// Reconnect asked on the Rust path (phone / inbox): never opens a browser (the user may be away).
pub(crate) const RUST_RECONNECT: &str = "To sign in to Spotify again, open Settings → Integrations on the PC and press Reconnect.";
pub(crate) const SERVER_OFF: &str = "Spotify is turned off in Settings → Integrations.";
pub(crate) const SERVER_READ_ONLY: &str = "Spotify is set to read-only in Settings → Integrations.";
/// Spotify-made playlists Dev Mode apps can't open (matched on whole words of `norm`).
const SPOTIFY_MADE: [&str; 6] = ["discover weekly", "daily mix", "release radar", "on repeat", "repeat rewind", "dj"];

// ── Pure helpers / reply builders ──

/// "A", "A and B", "A, B and C" (no cap; callers slice).
fn join_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn title_of(t: &TrackRef) -> String {
    resolve::spoken_title(&t.name)
}

/// "{spoken_title} by {join_names}".
fn track_label(t: &TrackRef) -> String {
    if t.artists.is_empty() {
        title_of(t)
    } else {
        format!("{} by {}", title_of(t), resolve::join_names(&t.artists))
    }
}

fn not_found(query: &str) -> String {
    format!("I couldn't find \"{}\" on Spotify.", query.trim())
}

fn spotify_made(query: &str) -> bool {
    let n = format!(" {} ", resolve::norm(query));
    SPOTIFY_MADE.iter().any(|m| n.contains(&format!(" {m} ")))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum TargetKind {
    Artist,
    Album,
    Track,
    OwnPlaylist,
    Playlist,
    Liked,
}

/// The spoken label of a playable target and its kind.
fn target_label(t: &Target) -> Option<(String, TargetKind)> {
    match t {
        Target::Context { label, kind, .. } => {
            let k = match kind {
                SearchKind::Artist => TargetKind::Artist,
                SearchKind::Album => TargetKind::Album,
                SearchKind::Track => TargetKind::Track,
                SearchKind::Playlist if label.starts_with("your ") => TargetKind::OwnPlaylist,
                SearchKind::Playlist => TargetKind::Playlist,
            };
            Some((label.clone(), k))
        }
        Target::AlbumAt { label, .. } | Target::Track { label, .. } => Some((label.clone(), TargetKind::Track)),
        Target::Liked { .. } => Some(("your Liked Songs".into(), TargetKind::Liked)),
        Target::Ask(_) | Target::Refuse(_) | Target::NotFound => None,
    }
}

/// `{Opened Spotify. }{Playing|Shuffling} {label} on {Device|Spotify}.` — device only when the user named one.
fn play_reply(label: &str, kind: TargetKind, device: Option<&str>, shuffle: bool, launched: bool) -> String {
    let phrase = if kind == TargetKind::Liked { "your Liked Songs" } else { label };
    format!("{}{} {phrase} on {}.", if launched { "Opened Spotify. " } else { "" }, if shuffle { "Shuffling" } else { "Playing" }, device.unwrap_or("Spotify"))
}

fn not_ready_reply(label: Option<&str>) -> String {
    match label.filter(|l| !l.is_empty()) {
        Some(l) => format!("Opened {l} in Spotify — press play if it doesn't start."),
        None => LAUNCH_NOT_READY.into(),
    }
}

/// Resolve before any device call or launch (critic #10): Ask / Refuse / NotFound are spoken as-is.
#[derive(Debug, PartialEq)]
enum PlayDecision {
    Reply(String),
    NeedDevice,
}

fn play_decision(target: &Target, query: &str) -> PlayDecision {
    match target {
        Target::Ask(s) | Target::Refuse(s) => PlayDecision::Reply(s.clone()),
        Target::NotFound => PlayDecision::Reply(not_found(query)),
        _ => PlayDecision::NeedDevice,
    }
}

fn now_playing_text(t: &TrackRef, is_playing: bool, progress_ms: u64, playlist: Option<(&str, bool)>, liked: Option<bool>) -> String {
    let lead = if is_playing { "Now playing" } else { "Paused on" };
    let time = match t.duration_ms {
        Some(d) if d > 0 => format!(" — {} of {}", mmss(progress_ms.min(d)), mmss(d)),
        _ => String::new(),
    };
    if t.is_episode {
        let from = t.album_name.as_deref().or(t.artists.first().map(String::as_str)).map(|s| format!(" from {s}")).unwrap_or_default();
        return format!("{lead} the episode {}{from}{time}.", title_of(t));
    }
    let mut s = format!("{lead} {}", track_label(t));
    if let Some(album) = t.album_name.as_deref().filter(|a| !a.trim().is_empty()) {
        s.push_str(&format!(", from {}", resolve::spoken_title(album)));
        if let Some(y) = &t.release_year {
            s.push_str(&format!(" ({y})"));
        }
    }
    s.push_str(&time);
    match playlist {
        Some((name, true)) => s.push_str(&format!(", from your {name} playlist")),
        Some((name, false)) => s.push_str(&format!(", from the playlist {name}")),
        None => {}
    }
    s.push('.');
    match liked {
        Some(true) => s.push_str(" It's in your Liked Songs."),
        Some(false) => s.push_str(" It's not in your Liked Songs."),
        None => {}
    }
    s
}

/// De-duplicates by URI, drops the current track (Spotify pads short queues), ≤ 5.
fn queue_text(current: Option<&TrackRef>, queue: &[TrackRef]) -> String {
    let Some(cur) = current else { return NOTHING_PLAYING_NOW.into() };
    let mut seen: Vec<&str> = vec![cur.uri.as_str()];
    let mut next: Vec<String> = Vec::new();
    for t in queue {
        if seen.contains(&t.uri.as_str()) {
            continue;
        }
        seen.push(&t.uri);
        next.push(track_label(t));
        if next.len() == 5 {
            break;
        }
    }
    if next.is_empty() {
        format!("Nothing is queued after {}.", title_of(cur))
    } else {
        format!("Now playing {}. Up next: {}.", track_label(cur), join_list(&next))
    }
}

fn playlist_list_text(lists: &[PlaylistRef]) -> String {
    if lists.is_empty() {
        return "You don't have any playlists yet.".into();
    }
    let shown: Vec<String> = lists
        .iter()
        .take(8)
        .map(|p| match p.total {
            Some(n) => format!("{} ({})", p.name, resolve::plural(n as usize, "song")),
            None => p.name.clone(),
        })
        .collect();
    let head = format!("You have {}", resolve::plural(lists.len(), "playlist"));
    if lists.len() > 8 {
        format!("{head}: {} and {} more.", shown.join(", "), lists.len() - 8)
    } else {
        format!("{head}: {}.", join_list(&shown))
    }
}

fn playlist_tracks_text(name: &str, total: Option<u32>, tracks: &[TrackRef]) -> String {
    let n = total.map(|t| t as usize).unwrap_or(tracks.len()).max(tracks.len());
    if tracks.is_empty() {
        return format!("{name} is empty.");
    }
    let shown: Vec<String> = tracks.iter().take(10).map(track_label).collect();
    if n > shown.len() {
        format!("{name} has {}. First {}: {}.", resolve::plural(n, "song"), shown.len(), join_list(&shown))
    } else {
        format!("{name} has {}: {}.", resolve::plural(n, "song"), join_list(&shown))
    }
}

fn top_text(kind: &str, range: &str, items: &[String]) -> String {
    if items.is_empty() {
        return "Spotify doesn't have enough listening history for that yet.".into();
    }
    let what = if kind == "artists" { "artists" } else { "songs" };
    let when = match range {
        "short_term" => "lately",
        "long_term" => "over the past year",
        _ => "over the last six months",
    };
    format!("Your top {what} {when}: {}.", join_list(items))
}

/// Consecutive duplicates dropped.
fn recent_text(tracks: &[TrackRef]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut last: Option<&str> = None;
    for t in tracks {
        if last == Some(t.uri.as_str()) {
            continue;
        }
        last = Some(&t.uri);
        out.push(track_label(t));
    }
    if out.is_empty() {
        "You haven't played anything on Spotify lately.".into()
    } else {
        format!("You recently played: {}.", join_list(&out))
    }
}

/// What Spotify says about a new playlist's visibility (it may ignore `public: false`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Visibility {
    Private,
    Public,
    /// Asked for private; Spotify still reports it public after a retry.
    ForcedPublic,
    /// Couldn't confirm either way: claim nothing.
    Unknown,
}

const FORCED_PUBLIC: &str = "Spotify made it public even though I asked for private — you can switch it to private in the Spotify app.";

/// Pure: the requested visibility vs what Spotify reports afterwards.
fn visibility_from(asked_public: bool, reported_public: Option<bool>) -> Visibility {
    match (asked_public, reported_public) {
        (true, _) => Visibility::Public,
        (false, Some(false)) => Visibility::Private,
        (false, Some(true)) => Visibility::ForcedPublic,
        (false, None) => Visibility::Unknown,
    }
}

fn vis_word(vis: Visibility) -> &'static str {
    match vis {
        Visibility::Private => "private ",
        Visibility::Public => "public ",
        Visibility::ForcedPublic | Visibility::Unknown => "",
    }
}

fn create_reply(name: &str, vis: Visibility, added: usize, misses: &[String]) -> String {
    let w = vis_word(vis);
    let mut s = if added == 0 { format!("Created your {w}playlist {name}.") } else { format!("Created your {w}playlist {name} with {}.", resolve::plural(added, "song")) };
    for q in misses.iter().take(2) {
        s.push_str(&format!(" I couldn't find \"{q}\"."));
    }
    if vis == Visibility::ForcedPublic {
        s.push(' ');
        s.push_str(FORCED_PUBLIC);
    }
    s
}

fn transfer_reply(step: &DeviceStep, device_name: &str) -> String {
    match step {
        DeviceStep::Use(d) | DeviceStep::Wake(d) => format!("Moved Spotify to {}.", d.name),
        DeviceStep::NotFound { available, .. } if available.is_empty() => NO_DEVICES.into(),
        DeviceStep::NotFound { wanted, available } => {
            let wanted = if wanted.trim().is_empty() { device_name } else { wanted.as_str() };
            format!("I can't see a Spotify device called \"{wanted}\". Available: {}.", join_list(available))
        }
        DeviceStep::Ambiguous(a, b) => format!("Which one — {} or {}?", a.name, b.name),
        DeviceStep::OnlyRestricted => format!("{ONLY_RESTRICTED}."),
        DeviceStep::Launch | DeviceStep::Empty => NO_DEVICES.into(),
    }
}

fn seek_reply(position_sec: Option<u32>, offset_sec: Option<i32>) -> String {
    match (position_sec, offset_sec) {
        (Some(p), _) => format!("Jumped to {}.", mmss(u64::from(p) * 1000)),
        (None, Some(o)) if o < 0 => format!("Went back {} seconds.", o.unsigned_abs()),
        (None, Some(o)) => format!("Skipped ahead {o} seconds."),
        (None, None) => "Jumped.".into(),
    }
}

/// Seek target in ms, clamped so a jump never runs past the track (which would skip it).
fn seek_target(progress_ms: u64, duration_ms: Option<u64>, position_sec: Option<u32>, offset_sec: Option<i32>) -> u64 {
    let raw = match (position_sec, offset_sec) {
        (Some(p), _) => i64::from(p) * 1000,
        (None, Some(o)) => progress_ms as i64 + i64::from(o) * 1000,
        (None, None) => progress_ms as i64,
    }
    .max(0) as u64;
    match duration_ms {
        Some(d) if d > 1000 => raw.min(d - 1000),
        _ => raw,
    }
}

/// A playlist entry's URI: `item.uri`, else the legacy `track.uri` (null-safe).
fn entry_uri(e: &Value) -> Option<&str> {
    e.get("item").and_then(|i| i.get("uri")).and_then(Value::as_str).or_else(|| e.get("track").and_then(|t| t.get("uri")).and_then(Value::as_str))
}

/// Dup check over `GET /playlists/{id}/items` pages.
fn contains_uri(pages: &[Value], uri: &str) -> bool {
    pages.iter().flat_map(|p| p.get("items").and_then(Value::as_array).into_iter().flatten()).any(|e| entry_uri(e) == Some(uri))
}

/// Playlist ids go into URL paths: base62 only.
fn playlist_path(id: &str, suffix: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Spotify returned a playlist I can't use".into());
    }
    Ok(format!("/playlists/{id}{suffix}"))
}

// ── Pure planners ──

#[derive(Clone, Debug, PartialEq)]
enum Call {
    /// PUT /me/player/play[?device_id]
    Play { device_id: Option<String>, body: Option<Value> },
    /// PUT /me/player
    Transfer { device_id: String, play: bool },
    /// PUT /me/player/shuffle
    Shuffle { state: bool, device_id: Option<String> },
    /// ms
    Sleep(u64),
}

/// From a DeviceStep (Use | Wake only) and an optional play body (contract §4.10).
fn play_steps(step: &DeviceStep, body: Option<&Value>, shuffle: Option<bool>) -> Vec<Call> {
    let (d, wake) = match step {
        DeviceStep::Use(d) => (d, false),
        DeviceStep::Wake(d) => (d, true),
        _ => return Vec::new(),
    };
    let mut v = match (wake, body) {
        (true, None) => vec![Call::Transfer { device_id: d.id.clone(), play: true }],
        (_, b) => vec![Call::Play { device_id: Some(d.id.clone()), body: b.cloned() }],
    };
    if let Some(s) = shuffle {
        v.push(Call::Sleep(400));
        v.push(Call::Shuffle { state: s, device_id: Some(d.id.clone()) });
    }
    v
}

/// After a Play that returned NoDevice: wake the device, wait, play again (once).
fn retry_steps(device_id: &str, body: Option<&Value>) -> Vec<Call> {
    vec![Call::Transfer { device_id: device_id.to_string(), play: false }, Call::Sleep(400), Call::Play { device_id: Some(device_id.to_string()), body: body.cloned() }]
}

/// Shuffled playlist / album starts at a random position (critic #12). `r` from the caller.
fn with_shuffle_offset(mut body: Value, total: Option<u32>, r: u32) -> Value {
    let ctx = body.get("context_uri").and_then(Value::as_str).unwrap_or("");
    let shuffleable = ctx.starts_with("spotify:playlist:") || ctx.starts_with("spotify:album:");
    if let (true, Some(t), None) = (shuffleable, total.filter(|t| *t > 1), body.get("offset")) {
        body["offset"] = json!({ "position": r % t });
    }
    body
}

fn random_u32() -> u32 {
    u32::from_le_bytes(random_bytes::<4>())
}

// ── Network glue ──

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// A soft outcome the handler speaks as its reply, or a real failure.
enum Fail {
    Reply(String),
    Err(String),
}

impl Fail {
    fn into_result(self) -> Result<String, String> {
        match self {
            Fail::Reply(r) => Ok(r),
            Fail::Err(e) => Err(e),
        }
    }
}

async fn fetch_devices(state: &DispatchState) -> Result<Vec<Device>, String> {
    get(state, "/me/player/devices", &[]).await.map(|v| device::parse_devices(&v))
}

async fn run_call(state: &DispatchState, call: &Call) -> Result<(), ApiError> {
    use reqwest::Method;
    match call {
        Call::Play { device_id, body } => {
            let q: Vec<(&str, String)> = device_id.iter().map(|d| ("device_id", d.clone())).collect();
            send(state, Method::PUT, "/me/player/play", &q, body.as_ref()).await.map(|_| ())
        }
        Call::Transfer { device_id, play } => send(state, Method::PUT, "/me/player", &[], Some(&json!({ "device_ids": [device_id], "play": play }))).await.map(|_| ()),
        Call::Shuffle { state: on, device_id } => {
            let mut q = vec![("state", on.to_string())];
            if let Some(d) = device_id {
                q.push(("device_id", d.clone()));
            }
            send(state, Method::PUT, "/me/player/shuffle", &q, None).await.map(|_| ())
        }
        Call::Sleep(ms) => {
            tokio::time::sleep(Duration::from_millis(*ms)).await;
            Ok(())
        }
    }
}

struct StartOutcome {
    device: Device,
    launched: bool,
    /// The user named the device.
    named: bool,
    /// Resume/transfer onto the device that was already playing (Spotify answered 403
    /// "Restriction violated" to the body-less play): nothing changed.
    already: bool,
}

/// Pure: a body-less Play (resume / transfer) on the device that is already active, refused
/// with "Restriction violated", means it was already playing there — not a failure.
fn already_playing(step: &DeviceStep, call: &Call, err: &ApiError) -> bool {
    matches!(step, DeviceStep::Use(_)) && matches!(call, Call::Play { body: None, .. }) && matches!(err, ApiError::Msg(m) if is_restriction(m))
}

fn step_error(step: &DeviceStep, wanted: Option<&str>) -> String {
    match step {
        DeviceStep::NotFound { .. } | DeviceStep::Ambiguous(..) => transfer_reply(step, wanted.unwrap_or("")),
        DeviceStep::OnlyRestricted => ONLY_RESTRICTED.into(),
        _ => NO_DEVICE.into(),
    }
}

fn start_error(e: ApiError, target: Option<&Target>) -> String {
    let liked = matches!(target, Some(Target::Liked { .. }));
    match e {
        ApiError::NotFound(_) | ApiError::Forbidden(_) if liked => LIKED_REFUSED.into(),
        ApiError::Msg(m) if liked && m.contains("HTTP 4") => LIKED_REFUSED.into(),
        e => e.text(),
    }
}

/// Start purpose (D22/D23). The target is resolved by the caller BEFORE this runs.
async fn start(state: &DispatchState, target: Option<&Target>, body: Option<&Value>, wanted: Option<&str>, shuffle: Option<bool>) -> Result<StartOutcome, String> {
    let host = device::this_pc_name();
    let mut step = device::device_plan(&fetch_devices(state).await?, wanted, Purpose::Start, &host, false);
    let mut launched = false;
    if step == DeviceStep::Launch {
        let uri = target.and_then(resolve::launch_uri);
        let spawned = device::launch_local_spotify(uri.as_deref()).map_err(device::DeviceError::LaunchFailed);
        let waited = match spawned {
            Ok(()) => {
                launched = true;
                // A named device ("this computer") waits for THAT device, not any listed one.
                device::wait_for_device(|| fetch_devices(state), tokio::time::sleep, &host, wanted, device::LAUNCH_WAIT).await
            }
            Err(e) => Err(e),
        };
        match waited {
            Ok(_) => step = device::device_plan(&fetch_devices(state).await?, wanted, Purpose::Start, &host, true),
            Err(device::DeviceError::NotReady) => {
                let label = uri.as_ref().and(target).and_then(target_label).map(|(l, _)| l);
                return Err(not_ready_reply(label.as_deref()));
            }
            Err(device::DeviceError::Fetch(e)) => return Err(e),
            Err(device::DeviceError::LaunchFailed(e)) => {
                eprintln!("[spotify] {e}");
                return Err(LAUNCH_FAILED.into());
            }
        }
    }
    let d = match &step {
        DeviceStep::Use(d) | DeviceStep::Wake(d) => d.clone(),
        other => return Err(step_error(other, wanted)),
    };
    let mut retried = false;
    let mut already = false;
    for call in &play_steps(&step, body, shuffle) {
        match run_call(state, call).await {
            Ok(()) => {}
            Err(e) if already_playing(&step, call, &e) => already = true,
            Err(ApiError::NoDevice) if matches!(call, Call::Play { .. }) && !retried => {
                retried = true;
                for r in retry_steps(&d.id, body) {
                    run_call(state, &r).await.map_err(|e| start_error(e, target))?;
                }
            }
            // Playback already started: a failed shuffle toggle isn't worth failing the request.
            Err(e) if matches!(call, Call::Shuffle { .. }) => eprintln!("[spotify] shuffle after play failed ({})", problem_kind(&e.text())),
            Err(e) => return Err(start_error(e, target)),
        }
    }
    if !already {
        mark_started();
    }
    Ok(StartOutcome { device: d, launched, named: wanted.is_some(), already })
}

/// Control purpose: no device_id; only after NO_ACTIVE_DEVICE ask the device list. Never launches.
async fn control_call(state: &DispatchState, method: reqwest::Method, path: &str, query: &[(&str, String)]) -> Result<(), String> {
    match send(state, method.clone(), path, query, None).await {
        Ok(_) => Ok(()),
        Err(ApiError::NoDevice) => match device::device_plan(&fetch_devices(state).await?, None, Purpose::Control, &device::this_pc_name(), false) {
            DeviceStep::Use(d) => {
                let mut q = query.to_vec();
                q.push(("device_id", d.id));
                send(state, method, path, &q, None).await.map(|_| ()).map_err(|e| if e == ApiError::NoDevice { NOTHING_PLAYING.to_string() } else { e.text() })
            }
            _ => Err(NOTHING_PLAYING.into()),
        },
        Err(e) => Err(e.text()),
    }
}

/// `Err(NOTHING_PLAYING)` from a control call is the reply itself.
fn soft(r: Result<(), String>, ok: impl Into<String>) -> Result<String, String> {
    match r {
        Ok(()) => Ok(ok.into()),
        Err(e) if e == NOTHING_PLAYING => Ok(e),
        Err(e) => Err(e),
    }
}

// ── Playlist cache ──

struct PlaylistCache {
    at: u64,
    lists: Vec<PlaylistRef>,
}
static PLAYLISTS: std::sync::Mutex<Option<PlaylistCache>> = std::sync::Mutex::new(None);
/// Created in this run: kept in front of a refetch for a while (`/me/playlists` can lag).
static CREATED: std::sync::Mutex<Vec<(u64, PlaylistRef)>> = std::sync::Mutex::new(Vec::new());
const PLAYLIST_TTL_SECS: u64 = 120;
const CREATED_KEEP_SECS: u64 = 600;

fn merge_created(mut lists: Vec<PlaylistRef>, created: &[(u64, PlaylistRef)], now: u64) -> Vec<PlaylistRef> {
    for (at, p) in created.iter() {
        if now.saturating_sub(*at) < CREATED_KEEP_SECS && !lists.iter().any(|l| l.id == p.id) {
            lists.insert(0, p.clone());
        }
    }
    lists
}

/// (lists, fetched now).
async fn playlists_load(state: &DispatchState, fresh: bool) -> Result<(Vec<PlaylistRef>, bool), String> {
    let now = os_core::now_secs();
    if !fresh {
        if let Some(c) = PLAYLISTS.lock().unwrap().as_ref().filter(|c| now.saturating_sub(c.at) < PLAYLIST_TTL_SECS) {
            return Ok((c.lists.clone(), false));
        }
    }
    let mut lists = Vec::new();
    for page in 0..4u32 {
        let v = get(state, "/me/playlists", &[("limit", "50".into()), ("offset", (page * 50).to_string())]).await?;
        lists.extend(resolve::parse_playlists_page(&v));
        let n = v["items"].as_array().map_or(0, Vec::len);
        if n < 50 || v["next"].is_null() {
            break;
        }
    }
    let lists = merge_created(lists, &CREATED.lock().unwrap(), now);
    *PLAYLISTS.lock().unwrap() = Some(PlaylistCache { at: now, lists: lists.clone() });
    Ok((lists, true))
}

/// Own + followed playlists, cached 120 s, up to 200.
async fn playlists_cached(state: &DispatchState, fresh: bool) -> Result<Vec<PlaylistRef>, String> {
    playlists_load(state, fresh).await.map(|(l, _)| l)
}

fn cache_insert(p: PlaylistRef) {
    let now = os_core::now_secs();
    {
        let mut created = CREATED.lock().unwrap();
        created.retain(|(at, c)| now.saturating_sub(*at) < CREATED_KEEP_SECS && c.id != p.id);
        created.push((now, p.clone()));
    }
    if let Some(c) = PLAYLISTS.lock().unwrap().as_mut() {
        c.lists.retain(|l| l.id != p.id);
        c.lists.insert(0, p);
    }
}

fn cache_adjust(id: &str, delta: i64) {
    let bump = |p: &mut PlaylistRef| {
        if p.id == id {
            p.total = Some((i64::from(p.total.unwrap_or(0)) + delta).max(0) as u32);
        }
    };
    if let Some(c) = PLAYLISTS.lock().unwrap().as_mut() {
        c.lists.iter_mut().for_each(bump);
    }
    CREATED.lock().unwrap().iter_mut().for_each(|(_, p)| bump(p));
}

fn cached_total(uri: &str) -> Option<u32> {
    PLAYLISTS.lock().unwrap().as_ref().and_then(|c| c.lists.iter().find(|p| p.uri == uri).and_then(|p| p.total))
}

/// Disconnect / a fresh sign-in: another account's playlists must not linger.
fn clear_playlist_cache() {
    *PLAYLISTS.lock().unwrap() = None;
    CREATED.lock().unwrap().clear();
}

/// The account id (ownership), fetching `/me` once if it isn't cached yet.
async fn ensure_account(state: &DispatchState) -> Option<String> {
    if let Some(id) = account_id() {
        return Some(id);
    }
    fetch_account(state).await.ok()?;
    account_id()
}

fn own_context(p: &PlaylistRef, me: Option<&str>) -> Target {
    Target::Context { uri: p.uri.clone(), label: resolve::playlist_label(&p.name, me == Some(p.owner_id.as_str())), kind: SearchKind::Playlist }
}

enum Found {
    One(PlaylistRef),
    Ambiguous(PlaylistRef, PlaylistRef),
    /// Only a playlist the account can't edit matched.
    NotEditable,
    None,
}

/// add / remove / get_playlist_tracks: the editable subset first; a cached miss retries fresh once.
async fn find_editable(state: &DispatchState, name: &str) -> Result<Found, String> {
    let me = ensure_account(state).await;
    let mut fresh = false;
    loop {
        let (lists, fetched) = playlists_load(state, fresh).await?;
        let (editable, other): (Vec<PlaylistRef>, Vec<PlaylistRef>) = lists.into_iter().partition(|p| me.as_deref() == Some(p.owner_id.as_str()) || p.collaborative);
        match resolve::match_playlist(name, &editable, resolve::OWN_MATCH_MIN) {
            PlaylistMatch::One(p) => return Ok(Found::One(p)),
            PlaylistMatch::Ambiguous(a, b) => return Ok(Found::Ambiguous(a, b)),
            PlaylistMatch::None => {}
        }
        if !matches!(resolve::match_playlist(name, &other, resolve::OWN_MATCH_MIN), PlaylistMatch::None) {
            return Ok(Found::NotEditable);
        }
        if fetched || fresh {
            return Ok(Found::None);
        }
        fresh = true;
    }
}

fn two_playlists(a: &PlaylistRef, b: &PlaylistRef) -> String {
    format!("You have two playlists like that: {} and {}. Which one?", a.name, b.name)
}

async fn search(state: &DispatchState, plan: &SearchPlan) -> Result<Value, String> {
    get(state, "/search", &[("q", plan.q.clone()), ("type", plan.types.to_string()), ("limit", plan.limit.min(10).to_string()), ("market", "from_token".into())]).await
}

/// GET /me/player/currently-playing (tracks and episodes). 204 ⇒ None.
async fn current_track(state: &DispatchState) -> Result<Option<(TrackRef, Value)>, String> {
    let v = get(state, "/me/player/currently-playing", &[("additional_types", "track,episode".into())]).await?;
    Ok(resolve::parse_track(&v["item"]).map(|t| (t, v)))
}

/// When this app last started playback (a woken/launched device can take a few seconds
/// before `currently-playing` reports anything).
static LAST_START: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
/// How long after a start an empty player still counts as "starting up".
const START_SETTLE: Duration = Duration::from_secs(10);
/// Longest extra wait a single now-playing question may add.
const SETTLE_MAX_WAIT: Duration = Duration::from_secs(5);

fn mark_started() {
    *LAST_START.lock().unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());
}

/// Pure: how much longer to poll an empty player, given the time since the last start.
fn settle_wait(since_start: Option<Duration>) -> Duration {
    match since_start {
        Some(d) if d < START_SETTLE => (START_SETTLE - d).min(SETTLE_MAX_WAIT),
        _ => Duration::ZERO,
    }
}

/// `current_track`, but right after this app started playback an empty answer is re-checked
/// every 500 ms (bounded by `settle_wait`) so "what's playing?" doesn't say "nothing".
async fn current_track_settled(state: &DispatchState) -> Result<Option<(TrackRef, Value)>, String> {
    let first = current_track(state).await?;
    if first.is_some() {
        return Ok(first);
    }
    let since = LAST_START.lock().unwrap_or_else(|p| p.into_inner()).map(|t| t.elapsed());
    let deadline = std::time::Instant::now() + settle_wait(since);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(found) = current_track(state).await? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// "current" ⇒ the playing track; else the first track plan that picks a track.
async fn resolve_track(state: &DispatchState, query: &str) -> Result<TrackRef, Fail> {
    if resolve::is_current(query) {
        return match current_track_settled(state).await {
            Ok(Some((t, _))) => Ok(t),
            Ok(None) => Err(Fail::Reply(NOTHING_PLAYING_FOR_TRACK.into())),
            Err(e) => Err(Fail::Err(e)),
        };
    }
    for plan in resolve::track_plans(query) {
        let v = search(state, &plan).await.map_err(Fail::Err)?;
        if let Some(t) = resolve::pick_track(&plan, &v) {
            return Ok(t);
        }
    }
    Err(Fail::Reply(not_found(query)))
}

/// Contract §4.10 `resolve_play`.
async fn resolve_play(state: &DispatchState, req: &PlayRequest) -> Result<Target, String> {
    if req.liked {
        return Ok(ensure_account(state).await.map_or(Target::NotFound, |user_id| Target::Liked { user_id }));
    }
    if req.my || req.kind == Some(SearchKind::Playlist) {
        let me = ensure_account(state).await;
        let mut fresh = false;
        loop {
            let (lists, fetched) = match playlists_load(state, fresh).await {
                Ok(l) => l,
                Err(e) if req.my => return Err(e),
                Err(_) => (Vec::new(), true),
            };
            match resolve::match_playlist(&req.query, &lists, resolve::OWN_MATCH_MIN) {
                PlaylistMatch::One(p) => return Ok(own_context(&p, me.as_deref())),
                PlaylistMatch::Ambiguous(a, b) => {
                    return Ok(Target::Ask(format!("You have two playlists like that: {} and {}. Say \"play my {} playlist\" or \"play my {} playlist\".", a.name, b.name, a.name, b.name)))
                }
                PlaylistMatch::None if !fetched && !fresh => fresh = true,
                PlaylistMatch::None => break,
            }
        }
        if spotify_made(&req.query) {
            return Ok(Target::Refuse(format!("Spotify doesn't let this app open its own playlists like {} — open it in the Spotify app instead.", req.query)));
        }
        if req.my {
            return Ok(Target::Refuse(format!("I couldn't find a playlist called {} in your library.", req.query)));
        }
    } else if req.kind.is_none() {
        if let Ok(lists) = playlists_cached(state, false).await {
            if let PlaylistMatch::One(p) = resolve::match_playlist(&req.query, &lists, resolve::OWN_EXACTISH_MIN) {
                return Ok(own_context(&p, ensure_account(state).await.as_deref()));
            }
        }
    }
    for plan in resolve::plan_searches(req) {
        let v = search(state, &plan).await?;
        match resolve::choose(&plan, &v) {
            Target::NotFound => continue,
            t => return Ok(t),
        }
    }
    Ok(Target::NotFound)
}

/// Name of a context playlist (cache, else `?fields=name`); any error ⇒ None.
async fn playlist_name_for(state: &DispatchState, uri: &str) -> Option<(String, bool)> {
    let me = account_id();
    if let Some(p) = PLAYLISTS.lock().unwrap().as_ref().and_then(|c| c.lists.iter().find(|p| p.uri == uri).cloned()) {
        return Some((p.name.clone(), me.as_deref() == Some(p.owner_id.as_str())));
    }
    let id = uri.strip_prefix("spotify:playlist:")?;
    // `owner(id)` (still a field in 2026) so a cold cache still says "your X playlist".
    let v = get(state, &playlist_path(id, "").ok()?, &[("fields", "name,owner(id)".into())]).await.ok()?;
    playlist_name_from(&v, me.as_deref())
}

/// Pure: (name, own) from a `GET /playlists/{id}?fields=name,owner(id)` reply.
fn playlist_name_from(v: &Value, me: Option<&str>) -> Option<(String, bool)> {
    let name = v["name"].as_str().filter(|n| !n.is_empty())?;
    let own = me.is_some_and(|m| !m.is_empty() && v["owner"]["id"].as_str() == Some(m));
    Some((name.to_string(), own))
}

/// (contains, scanned every entry). Up to 10 pages of 50; no `fields=` (critic #19).
async fn playlist_has(state: &DispatchState, id: &str, uri: &str) -> (bool, bool) {
    let Ok(path) = playlist_path(id, "/items") else { return (false, false) };
    let mut pages = Vec::new();
    let mut complete = false;
    for page in 0..10u32 {
        match get(state, &path, &[("limit", "50".into()), ("offset", (page * 50).to_string())]).await {
            Ok(v) => {
                let n = v["items"].as_array().map_or(0, Vec::len);
                let last = n < 50 || v["next"].is_null();
                pages.push(v);
                if last {
                    complete = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    (contains_uri(&pages, uri), complete)
}

async fn add_items(state: &DispatchState, id: &str, uris: &[String]) -> Result<(), String> {
    send(state, reqwest::Method::POST, &playlist_path(id, "/items")?, &[], Some(&json!({ "uris": uris }))).await.map(|_| ()).map_err(ApiError::text)
}

async fn create_private(state: &DispatchState, name: &str, public: bool, description: Option<&str>) -> Result<PlaylistRef, String> {
    let mut body = json!({ "name": name, "public": public });
    if let Some(d) = description {
        body["description"] = json!(d);
    }
    let v = send(state, reqwest::Method::POST, "/me/playlists", &[], Some(&body)).await.map_err(ApiError::text)?;
    let mut p = resolve::parse_playlists_page(&json!({ "items": [v] })).into_iter().next().ok_or("Spotify didn't return the new playlist")?;
    if p.owner_id.is_empty() {
        p.owner_id = account_id().unwrap_or_default();
    }
    p.total = Some(p.total.unwrap_or(0));
    cache_insert(p.clone());
    Ok(p)
}

/// `GET /playlists/{id}?fields=public` → the reported flag (None when unreadable).
async fn reported_public(state: &DispatchState, id: &str) -> Option<bool> {
    let path = playlist_path(id, "").ok()?;
    get(state, &path, &[("fields", "public".into())]).await.ok()?["public"].as_bool()
}

/// Spotify's Web API can create a playlist public despite `public: false` (seen live, 2026),
/// so a private request is checked, retried once with PUT, and reported honestly.
async fn confirm_visibility(state: &DispatchState, id: &str, asked_public: bool) -> Visibility {
    if asked_public {
        return Visibility::Public;
    }
    let first = reported_public(state, id).await;
    if first != Some(true) {
        return visibility_from(false, first);
    }
    let fixed = match playlist_path(id, "") {
        Ok(path) => send(state, reqwest::Method::PUT, &path, &[], Some(&json!({ "public": false }))).await.is_ok(),
        Err(_) => false,
    };
    if !fixed {
        return Visibility::ForcedPublic;
    }
    visibility_from(false, reported_public(state, id).await)
}

async fn liked(state: &DispatchState, uri: &str) -> Result<bool, String> {
    let v = get(state, "/me/library/contains", &[("uris", uri.to_string())]).await?;
    v.get(0).and_then(Value::as_bool).ok_or_else(|| "Spotify didn't say".to_string())
}

/// `GET /me/player`, Null on 204 (nothing playing).
async fn player_state(state: &DispatchState) -> Result<Value, String> {
    get(state, "/me/player", &[("additional_types", "episode".into())]).await
}

// ── Handlers ──

async fn h_now_playing(state: &DispatchState) -> Result<String, String> {
    let Some((t, v)) = current_track_settled(state).await? else { return Ok(NOTHING_PLAYING_NOW.into()) };
    let is_playing = v["is_playing"].as_bool().unwrap_or(false);
    let progress = v["progress_ms"].as_u64().unwrap_or(0);
    let playlist = match (v["context"]["type"].as_str(), v["context"]["uri"].as_str()) {
        (Some("playlist"), Some(uri)) => playlist_name_for(state, uri).await,
        _ => None,
    };
    let saved = if t.is_episode { None } else { liked(state, &t.uri).await.ok() };
    Ok(now_playing_text(&t, is_playing, progress, playlist.as_ref().map(|(n, o)| (n.as_str(), *o)), saved))
}

async fn h_get_queue(state: &DispatchState) -> Result<String, String> {
    let v = get(state, "/me/player/queue", &[]).await?;
    let cur = resolve::parse_track(&v["currently_playing"]);
    let queue: Vec<TrackRef> = v["queue"].as_array().into_iter().flatten().filter_map(resolve::parse_track).collect();
    Ok(queue_text(cur.as_ref(), &queue))
}

async fn h_recently_played(state: &DispatchState, args: &Value) -> Result<String, String> {
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50);
    let v = get(state, "/me/player/recently-played", &[("limit", limit.to_string())]).await?;
    let tracks: Vec<TrackRef> = v["items"].as_array().into_iter().flatten().filter_map(|i| resolve::parse_track(&i["track"])).collect();
    Ok(recent_text(&tracks))
}

async fn h_top_items(state: &DispatchState, args: &Value) -> Result<String, String> {
    let kind = if arg(args, "type") == Some("artists") { "artists" } else { "tracks" };
    let range = arg(args, "time_range").unwrap_or("medium_term");
    let limit = args["limit"].as_u64().unwrap_or(5).clamp(1, 10);
    let v = get(state, &format!("/me/top/{kind}"), &[("time_range", range.to_string()), ("limit", limit.to_string())]).await?;
    let list = v["items"].as_array().into_iter().flatten();
    let items: Vec<String> = if kind == "artists" { list.filter_map(|a| a["name"].as_str().map(String::from)).collect() } else { list.filter_map(resolve::parse_track).map(|t| track_label(&t)).collect() };
    Ok(top_text(kind, range, &items))
}

async fn h_get_playlist_tracks(state: &DispatchState, args: &Value) -> Result<String, String> {
    let name = arg(args, "playlist_name").unwrap_or("");
    let p = match find_editable(state, name).await? {
        Found::One(p) => p,
        Found::Ambiguous(a, b) => return Ok(two_playlists(&a, &b)),
        Found::NotEditable => return Ok(PLAYLIST_UNREADABLE.into()),
        Found::None => return Ok(format!("I couldn't find a playlist called {name} in your library.")),
    };
    match send(state, reqwest::Method::GET, &playlist_path(&p.id, "/items")?, &[("limit", "50".into())], None).await {
        Ok(v) => {
            let tracks: Vec<TrackRef> = v["items"].as_array().into_iter().flatten().filter_map(resolve::parse_track).collect();
            let total = v["total"].as_u64().map(|t| t.min(u32::MAX as u64) as u32).or(p.total);
            Ok(playlist_tracks_text(&p.name, total, &tracks))
        }
        Err(ApiError::Forbidden(_)) => Ok(PLAYLIST_UNREADABLE.into()),
        Err(e) => Err(e.text()),
    }
}

async fn h_play(state: &DispatchState, args: &Value) -> Result<String, String> {
    let shuffle = args.get("shuffle").and_then(Value::as_bool);
    let wanted = arg(args, "device_name");
    match resolve::play_args(args) {
        PlayArgs::Resume => h_resume(state, wanted).await,
        PlayArgs::Uri(uri) => {
            let t = uri_target(&uri);
            let o = start(state, Some(&t), Some(&uri_body(&uri)), wanted, shuffle).await?;
            let device = o.named.then_some(o.device.name.as_str());
            Ok(format!("{}{} on {}.", if o.launched { "Opened Spotify. " } else { "" }, if shuffle == Some(true) { "Shuffling" } else { "Playing" }, device.unwrap_or("Spotify")))
        }
        PlayArgs::Request(req) => {
            let target = resolve_play(state, &req).await?;
            if let PlayDecision::Reply(r) = play_decision(&target, &req.query) {
                return Ok(r);
            }
            let mut body = resolve::play_body(&target).ok_or_else(|| not_found(&req.query))?;
            if shuffle == Some(true) {
                if let Target::Context { uri, .. } = &target {
                    body = with_shuffle_offset(body, cached_total(uri), random_u32());
                }
            }
            let o = start(state, Some(&target), Some(&body), wanted, shuffle).await?;
            let (label, kind) = target_label(&target).unwrap_or((req.query.clone(), TargetKind::Track));
            Ok(play_reply(&label, kind, o.named.then_some(o.device.name.as_str()), shuffle == Some(true), o.launched))
        }
    }
}

async fn h_resume(state: &DispatchState, wanted: Option<&str>) -> Result<String, String> {
    if wanted.is_none() {
        let p = player_state(state).await?;
        if p["is_playing"].as_bool() == Some(true) {
            return Ok("Spotify is already playing.".into());
        }
        if p["device"]["id"].is_string() {
            match control_call(state, reqwest::Method::PUT, "/me/player/play", &[]).await {
                Ok(()) => return Ok("Resumed Spotify.".into()),
                Err(e) if is_restriction(&e) => return Ok("Spotify is already playing.".into()),
                Err(e) if e == NOTHING_PLAYING => {} // the device went away: wake one below
                Err(e) => return Err(e),
            }
        }
    }
    let o = start(state, None, None, wanted, None).await?;
    if o.already {
        return Ok(format!("Spotify is already playing on {}.", o.device.name));
    }
    let prefix = if o.launched { "Opened Spotify. " } else { "" };
    Ok(if o.named { format!("{prefix}Resumed Spotify on {}.", o.device.name) } else { format!("{prefix}Resumed Spotify.") })
}

async fn h_pause(state: &DispatchState) -> Result<String, String> {
    match control_call(state, reqwest::Method::PUT, "/me/player/pause", &[]).await {
        Ok(()) => Ok("Paused Spotify.".into()),
        // Spotify answers 403 "Restriction violated" to pausing a paused player.
        Err(e) if is_restriction(&e) => Ok("Spotify is already paused.".into()),
        Err(e) if e == NOTHING_PLAYING => Ok(e),
        Err(e) => Err(e),
    }
}

async fn h_next(state: &DispatchState, args: &Value) -> Result<String, String> {
    let n = args["count"].as_u64().unwrap_or(1).clamp(1, 5);
    for i in 0..n {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        if let Err(e) = control_call(state, reqwest::Method::POST, "/me/player/next", &[]).await {
            return soft(Err(e), "");
        }
    }
    Ok(if n == 1 { "Skipped to the next track.".into() } else { format!("Skipped {n} tracks.") })
}

async fn h_seek(state: &DispatchState, args: &Value) -> Result<String, String> {
    let pos = args["position_sec"].as_u64().map(|p| p.min(u32::MAX as u64) as u32);
    let off = args["offset_sec"].as_i64().map(|o| o.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
    let p = player_state(state).await?;
    if p.is_null() || p["item"].is_null() {
        return Ok(NOTHING_PLAYING.into());
    }
    let ms = seek_target(p["progress_ms"].as_u64().unwrap_or(0), p["item"]["duration_ms"].as_u64(), pos, off);
    soft(control_call(state, reqwest::Method::PUT, "/me/player/seek", &[("position_ms", ms.to_string())]).await, seek_reply(pos, off))
}

async fn h_volume(state: &DispatchState, args: &Value) -> Result<String, String> {
    let p = player_state(state).await?;
    if p.is_null() || !p["device"].is_object() {
        return Ok(NOTHING_PLAYING.into());
    }
    if p["device"]["supports_volume"].as_bool() == Some(false) {
        return Ok(NO_VOLUME.into());
    }
    let current = p["device"]["volume_percent"].as_u64().map(|v| v.min(100) as u8);
    let pct = volume_target(current, args.get("percent"))?;
    soft(control_call(state, reqwest::Method::PUT, "/me/player/volume", &[("volume_percent", pct.to_string())]).await, format!("Spotify volume {pct}%."))
}

async fn h_shuffle(state: &DispatchState, args: &Value) -> Result<String, String> {
    let on = args["state"].as_bool().unwrap_or(true);
    soft(control_call(state, reqwest::Method::PUT, "/me/player/shuffle", &[("state", on.to_string())]).await, if on { "Shuffle on." } else { "Shuffle off." })
}

async fn h_repeat(state: &DispatchState, args: &Value) -> Result<String, String> {
    let mode = match arg(args, "mode") {
        Some("track") => "track",
        Some("off") => "off",
        _ => "context",
    };
    let reply = match mode {
        "track" => "Repeating this song.",
        "off" => "Repeat off.",
        _ => "Repeat on.",
    };
    soft(control_call(state, reqwest::Method::PUT, "/me/player/repeat", &[("state", mode.to_string())]).await, reply)
}

async fn h_transfer(state: &DispatchState, args: &Value) -> Result<String, String> {
    let name = arg(args, "device_name").ok_or("Which device should I move Spotify to?")?;
    let o = start(state, None, None, Some(name), None).await?;
    if o.already {
        return Ok(format!("Spotify is already on {}.", o.device.name));
    }
    Ok(transfer_reply(&DeviceStep::Use(o.device), name))
}

async fn h_queue_add(state: &DispatchState, args: &Value) -> Result<String, String> {
    let (uri, label) = match arg(args, "uri") {
        Some(u) => (u.to_string(), "that track".to_string()),
        None => match resolve_track(state, arg(args, "query").unwrap_or("current")).await {
            Ok(t) => (t.uri.clone(), track_label(&t)),
            Err(f) => return f.into_result(),
        },
    };
    soft(control_call(state, reqwest::Method::POST, "/me/player/queue", &[("uri", uri)]).await, format!("Queued {label}."))
}

async fn h_create_playlist(state: &DispatchState, args: &Value) -> Result<String, String> {
    let name = arg(args, "name").ok_or("I need a name for the new playlist.")?;
    let public = args["public"].as_bool().unwrap_or(false);
    ensure_account(state).await;
    let p = create_private(state, name, public, arg(args, "description")).await?;
    let vis = confirm_visibility(state, &p.id, public).await;
    let mut uris: Vec<String> = Vec::new();
    let mut misses: Vec<String> = Vec::new();
    // A real API failure (rate limit, quota, 5xx, network) stops the lookups and is reported
    // as such — only a genuine no-match counts as "I couldn't find".
    let mut search_error: Option<String> = None;
    for q in args["initial_queries"].as_array().into_iter().flatten().filter_map(Value::as_str).take(20) {
        match resolve_track(state, q).await {
            Ok(t) if !uris.contains(&t.uri) => uris.push(t.uri),
            Ok(_) => {}
            Err(Fail::Reply(_)) => misses.push(if resolve::is_current(q) { "the current song".to_string() } else { q.trim().to_string() }),
            Err(Fail::Err(e)) => {
                search_error = Some(e);
                break;
            }
        }
    }
    if !uris.is_empty() {
        if let Err(e) = add_items(state, &p.id, &uris).await {
            let mut r = format!("Created your {}playlist {}, but I couldn't add the songs: {e}.", vis_word(vis), p.name);
            if vis == Visibility::ForcedPublic {
                r.push(' ');
                r.push_str(FORCED_PUBLIC);
            }
            return Ok(r);
        }
        cache_adjust(&p.id, uris.len() as i64);
    }
    Ok(with_search_error(create_reply(&p.name, vis, uris.len(), &misses), search_error.as_deref()))
}

/// Pure: append the real reason the song lookups stopped (never "couldn't find" for it).
fn with_search_error(reply: String, err: Option<&str>) -> String {
    match err {
        Some(e) => format!("{reply} I couldn't look up the other songs: {}.", e.trim_end_matches('.')),
        None => reply,
    }
}

async fn h_add_to_playlist(state: &DispatchState, args: &Value) -> Result<String, String> {
    let name = arg(args, "playlist_name").ok_or("I need a playlist name for that.")?;
    let create = args["create"].as_bool().unwrap_or(false);
    let query = arg(args, "track_query").unwrap_or("current");
    let found = find_editable(state, name).await?;
    let target = match found {
        Found::One(p) => Some(p),
        Found::Ambiguous(a, b) => return Ok(two_playlists(&a, &b)),
        Found::NotEditable | Found::None if create => None,
        Found::NotEditable => return Ok(NOT_EDITABLE.into()),
        Found::None => return Ok(format!("I couldn't find a playlist called \"{name}\". Say \"add this to a new playlist called {name}\" to make it.")),
    };
    let t = match resolve_track(state, query).await {
        Ok(t) => t,
        Err(f) => return f.into_result(),
    };
    let title = title_of(&t);
    let Some(p) = target else {
        let p = create_private(state, name, false, None).await?;
        let vis = confirm_visibility(state, &p.id, false).await;
        add_items(state, &p.id, std::slice::from_ref(&t.uri)).await?;
        cache_adjust(&p.id, 1);
        let mut r = format!("Created your {} playlist and added {title}.", p.name);
        if vis == Visibility::ForcedPublic {
            r.push(' ');
            r.push_str(FORCED_PUBLIC);
        }
        return Ok(r);
    };
    if playlist_has(state, &p.id, &t.uri).await.0 {
        return Ok(format!("{title} is already in your {} playlist.", p.name));
    }
    add_items(state, &p.id, std::slice::from_ref(&t.uri)).await?;
    cache_adjust(&p.id, 1);
    Ok(format!("Added {title} to your {} playlist.", p.name))
}

async fn h_remove_from_playlist(state: &DispatchState, args: &Value) -> Result<String, String> {
    let name = arg(args, "playlist_name").ok_or("I need a playlist name for that.")?;
    let p = match find_editable(state, name).await? {
        Found::One(p) => p,
        Found::Ambiguous(a, b) => return Ok(two_playlists(&a, &b)),
        Found::NotEditable => return Ok(NOT_EDITABLE_REMOVE.into()),
        Found::None => return Ok(format!("I couldn't find a playlist called \"{name}\".")),
    };
    let t = match resolve_track(state, arg(args, "track_query").unwrap_or("current")).await {
        Ok(t) => t,
        Err(f) => return f.into_result(),
    };
    let title = title_of(&t);
    let (has, complete) = playlist_has(state, &p.id, &t.uri).await;
    if !has && complete {
        return Ok(format!("{title} isn't in your {} playlist.", p.name));
    }
    send(state, reqwest::Method::DELETE, &playlist_path(&p.id, "/items")?, &[], Some(&json!({ "items": [{ "uri": t.uri }] }))).await.map_err(ApiError::text)?;
    cache_adjust(&p.id, -1);
    Ok(format!("Removed {title} from your {} playlist.", p.name))
}

async fn h_like(state: &DispatchState, args: &Value, like: bool) -> Result<String, String> {
    let t = match resolve_track(state, arg(args, "track_query").unwrap_or("current")).await {
        Ok(t) => t,
        Err(f) => return f.into_result(),
    };
    let title = title_of(&t);
    let saved = liked(state, &t.uri).await.ok();
    match (like, saved) {
        (true, Some(true)) => return Ok(format!("{title} is already in your Liked Songs.")),
        (false, Some(false)) => return Ok(format!("{title} isn't in your Liked Songs.")),
        _ => {}
    }
    let method = if like { reqwest::Method::PUT } else { reqwest::Method::DELETE };
    send(state, method, "/me/library", &[("uris", t.uri.clone())], None).await.map_err(ApiError::text)?;
    Ok(if like { format!("Added {title} to your Liked Songs.") } else { format!("Removed {title} from your Liked Songs.") })
}

/// One canonical tool with normalised args.
async fn run(state: &DispatchState, name: &str, args: &Value) -> Result<String, String> {
    use reqwest::Method;
    match name {
        "spotify.now_playing" => h_now_playing(state).await,
        "spotify.get_queue" => h_get_queue(state).await,
        "spotify.recently_played" => h_recently_played(state, args).await,
        "spotify.top_items" => h_top_items(state, args).await,
        "spotify.list_playlists" => playlists_cached(state, false).await.map(|l| playlist_list_text(&l)),
        "spotify.get_playlist_tracks" => h_get_playlist_tracks(state, args).await,
        "spotify.play" => h_play(state, args).await,
        "spotify.pause" => h_pause(state).await,
        "spotify.resume" => h_resume(state, arg(args, "device_name")).await,
        "spotify.next" => h_next(state, args).await,
        "spotify.previous" => soft(control_call(state, Method::POST, "/me/player/previous", &[]).await, "Back to the previous track."),
        "spotify.seek" => h_seek(state, args).await,
        "spotify.restart_track" => soft(control_call(state, Method::PUT, "/me/player/seek", &[("position_ms", "0".into())]).await, "Restarted the song."),
        "spotify.volume" => h_volume(state, args).await,
        "spotify.shuffle" => h_shuffle(state, args).await,
        "spotify.repeat" => h_repeat(state, args).await,
        "spotify.transfer_device" => h_transfer(state, args).await,
        "spotify.queue_add" => h_queue_add(state, args).await,
        "spotify.create_playlist" => h_create_playlist(state, args).await,
        "spotify.add_to_playlist" => h_add_to_playlist(state, args).await,
        "spotify.remove_from_playlist" => h_remove_from_playlist(state, args).await,
        "spotify.like_track" => h_like(state, args, true).await,
        "spotify.unlike_track" => h_like(state, args, false).await,
        other => Err(format!("unknown Spotify tool {other}")),
    }
}

/// A `spotify.*` tool (aliases accepted). Kill switch here; the MCP / destructive gates are the
/// callers' (`spotify_tool`, `mcp::call_tool`). A missing core scope prompts (or not) and returns
/// SCOPE_PROMPTED | SCOPES_CHANGED without calling the API.
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value) -> Result<String, String> {
    if os.snapshot().privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    let name = intent::canonical(name.trim());
    if !intent::ALL_TOOLS.contains(&name) {
        return Err(format!("unknown Spotify tool {name}"));
    }
    scopes_cover(intent::tool_scopes(name))?;
    let args = intent::normalize_args(name, args)?;
    run(state, name, &args).await
}

/// Widget `spotify_control` actions → the matching handler. `shuffle` with no value toggles.
async fn control(state: &DispatchState, os: &OsState, action: &str, value: Option<&Value>) -> Result<String, String> {
    let v = value.cloned().unwrap_or(Value::Null);
    match action {
        "play" | "resume" => tool(state, os, "spotify.resume", &json!({})).await,
        "pause" | "next" | "previous" => tool(state, os, &format!("spotify.{action}"), &json!({})).await,
        "volume" => tool(state, os, "spotify.volume", &json!({ "percent": v })).await,
        "seek" => tool(state, os, "spotify.seek", &json!({ "position_sec": v })).await,
        "repeat" => tool(state, os, "spotify.repeat", &json!({ "mode": v })).await,
        "shuffle" => {
            let toggle = matches!(value, None | Some(Value::Null)) || matches!(value, Some(Value::String(s)) if s.trim().is_empty() || s.trim().eq_ignore_ascii_case("toggle"));
            let current = if toggle { now_playing(state).await?.shuffle } else { false };
            let on = shuffle_target(current, value)?;
            tool(state, os, "spotify.shuffle", &json!({ "state": on })).await
        }
        other => Err(format!("unknown Spotify action \"{other}\"")),
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Spotify reads (the widget polls, `spotify.*` read tools): the kill switch and a Deny tier
/// refuse; never an Ask card (D27). No per-poll log.
pub(crate) fn read_gate(cfg: &OsConfig) -> Result<(), String> {
    if cfg.privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    if cfg.permissions.mcp == Tier::Deny {
        return Err("PERMISSION_DENIED:mcp".into());
    }
    Ok(())
}

fn may_read(os: &OsState) -> Result<(), String> {
    read_gate(&os.snapshot())
}

/// The permission rule for one `spotify.*` tool, shared by `spotify_tool` and `mcp::call_tool`:
/// reads ⇒ `read_gate`; writes ⇒ kill switch + MCP tier, then (remove / unlike) the destructive
/// gate unless approved (D25).
pub(crate) fn tool_gate(cfg: &OsConfig, bridge: &BridgeState, name: &str, approved: bool) -> Result<(), String> {
    if intent::is_read_tool(name) {
        return read_gate(cfg);
    }
    if cfg.privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", approved, json!({ "tool": name }))?;
    if intent::is_destructive(name) && cfg.privacy.destructive_gate && !approved {
        return Err("PERMISSION_REQUIRED:destructive".into());
    }
    Ok(())
}

/// Pure part of `spotify_tool` before the permission gate (contract §4.6, in order).
fn tool_precheck(cfg: &OsConfig, name: &str) -> Result<(), String> {
    if !intent::ALL_TOOLS.contains(&name) {
        return Err("unknown Spotify tool".into());
    }
    if cfg.privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    let server = cfg.mcps.iter().find(|m| m.id == "spotify");
    if !server.is_some_and(|m| m.enabled) {
        return Err(SERVER_OFF.into());
    }
    if intent::is_write_tool(name) && server.is_some_and(|m| m.read_only) {
        return Err(SERVER_READ_ONLY.into());
    }
    Ok(())
}

/// Playback control: the kill switch, then the MCP permission tier.
fn may_control(os: &OsState, bridge: &BridgeState, approved: bool, what: &str) -> Result<(), String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", approved, json!({ "tool": what }))
}

fn logged(bridge: &BridgeState, what: &str, out: Result<String, String>) -> Result<String, String> {
    bridge.log(json!({ "type": "os-tool", "tool": what, "ok": out.is_ok() }));
    out
}

fn open_browser(url: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut c = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    let mut child = c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[derive(Serialize)]
pub struct AuthStart {
    url: String,
}

/// Who started a sign-in flow.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Origin {
    /// Settings → Connect / Reconnect.
    Manual,
    /// An automatic consent prompt (`request_reauth`).
    Auto(ReauthReason),
}

/// How a sign-in flow ended.
#[derive(Debug, PartialEq)]
enum AuthOutcome {
    Connected(Option<String>),
    Timeout,
    /// Spotify redirected with an error (the user answered the page).
    Denied(String),
    Failed(String),
}

const AUTH_TIMEOUT: &str = "Timed out waiting for Spotify sign-in — press Connect to try again";

/// Pure: the `spotify-auth` payload for an outcome, if any. An unanswered automatic
/// prompt is silent (the user may never have looked at the tab).
fn auth_outcome_event(origin: Origin, outcome: &AuthOutcome) -> Option<Value> {
    match (origin, outcome) {
        (_, AuthOutcome::Connected(account)) => Some(json!({ "ok": true, "account": account })),
        (Origin::Auto(_), AuthOutcome::Timeout) => None,
        (Origin::Manual, AuthOutcome::Timeout) => Some(json!({ "ok": false, "error": AUTH_TIMEOUT })),
        (_, AuthOutcome::Denied(e) | AuthOutcome::Failed(e)) => Some(json!({ "ok": false, "error": e })),
    }
}

/// Pure: a sign-in code that arrives while the kill switch is on is never exchanged.
fn blocked_by_kill_switch(kill: bool) -> Option<AuthOutcome> {
    kill.then(|| AuthOutcome::Failed(KILL_SWITCH.into()))
}

/// Open Spotify's consent page; the outcome arrives as a `spotify-auth` event
/// `{ok, error?, account?}`. The URL is returned for a clickable fallback link.
#[tauri::command]
pub async fn spotify_auth_start(app: AppHandle, os: State<'_, OsState>) -> Result<AuthStart, String> {
    if os.snapshot().privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    begin_auth(app, true, AUTH_WAIT, Origin::Manual).await
}

/// One sign-in flow (manual Connect or an automatic prompt). A new flow aborts a pending one.
async fn begin_auth(app: AppHandle, show_dialog: bool, wait: Duration, origin: Origin) -> Result<AuthStart, String> {
    let _ = APP.set(app.clone());
    let cfg = config(&app.state::<DispatchState>())?;
    let (addr, path) = redirect_target(&cfg.redirect)?;
    let verifier = b64url(&random_bytes::<64>());
    let expected = b64url(&random_bytes::<24>());
    let url = authorize_url(&cfg.client_id, &cfg.redirect, &pkce_challenge(&verifier), &expected, show_dialog);

    // A second Connect replaces the first, freeing its listener before we bind.
    let previous = FLOW.lock().unwrap().take();
    if let Some(h) = previous {
        h.abort();
        let _ = h.await;
    }
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => Some(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => None,
        Err(e) => return Err(format!("couldn't listen on {addr} for the Spotify callback: {e}")),
    };
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let state = handle.state::<DispatchState>();
        let os = handle.state::<OsState>();
        // The kill switch may be turned on while the flow waits (up to 30 min for an
        // automatic prompt): stop listening / polling at once.
        let wait_code = std::pin::pin!(tokio::time::timeout(wait, async {
            match listener {
                Some(l) => listen_once(l, &path, &expected).await,
                None => poll_gateway(&state, &os, &expected).await,
            }
        }));
        let kill_watch = std::pin::pin!(async {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if os.snapshot().privacy.kill_switch {
                    break;
                }
            }
        });
        let code = match futures_util::future::select(wait_code, kill_watch).await {
            futures_util::future::Either::Left((c, _)) => c,
            futures_util::future::Either::Right(_) => Ok(Err(CodeError::Failed(KILL_SWITCH.into()))),
        };
        let outcome = match code {
            Err(_) => AuthOutcome::Timeout,
            Ok(Err(CodeError::Denied(e))) => AuthOutcome::Denied(e),
            Ok(Err(CodeError::Failed(e))) => AuthOutcome::Failed(e),
            // Re-check right before any network call: the code may arrive after the switch flipped.
            Ok(Ok(code)) => match blocked_by_kill_switch(os.snapshot().privacy.kill_switch) {
                Some(blocked) => blocked,
                None => match exchange(&state, &code, &verifier).await {
                    Ok(()) => AuthOutcome::Connected(fetch_account(&state).await.ok()),
                    Err(e) => AuthOutcome::Failed(e),
                },
            },
        };
        if let Origin::Auto(reason) = origin {
            match &outcome {
                AuthOutcome::Timeout => eprintln!("[spotify] automatic sign-in prompt not answered"),
                // An explicit answer: never auto-prompt for this key again (only when the
                // grant could be read — a defaulted copy would erase it).
                AuthOutcome::Denied(_) => {
                    if let Ok(g) = try_load_grant() {
                        let key = prompt_key(reason, &requested_hash(), g.at);
                        store_grant(&Grant { prompted: Some(key), prompt_tries: None, ..g });
                    }
                }
                _ => {}
            }
        }
        if let Some(payload) = auth_outcome_event(origin, &outcome) {
            let _ = handle.emit("spotify-auth", payload);
        }
        if matches!(outcome, AuthOutcome::Connected(_)) {
            super::mcp::emit_tools_changed(&handle, "spotify-connected");
        }
    });
    *FLOW.lock().unwrap() = Some(task);
    if let Err(e) = open_browser(&url) {
        eprintln!("[spotify] couldn't open the browser: {e}");
    }
    Ok(AuthStart { url })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    configured: bool,
    connected: bool,
    account: Option<String>,
    /// A stored token exists but Spotify refuses it (owner needs Premium, rate limit, …):
    /// shown on the card so "Connected" never hides a failing integration.
    problem: Option<String>,
    /// `problem_kind(problem)`: "reauth" | "owner_premium" | "premium" | "allowlist" | "transient".
    problem_kind: Option<&'static str>,
    /// Core scope names missing from the grant ([] if unknown).
    missing_scopes: Vec<String>,
    /// The grant is stale or misses a core scope (consent page offered or needed).
    reauth_pending: bool,
    /// Days left in Spotify's 6-month sign-in window, when known.
    expires_in_days: Option<u32>,
}

/// Pure: the scope part of the status → (missing core scopes, reauth pending).
fn scope_status(granted: Option<&str>, requested: Option<&str>) -> (Vec<String>, bool) {
    let verdict = scope_verdict(granted, requested);
    let missing = granted.map(missing_scopes).unwrap_or_default().into_iter().map(String::from).collect();
    (missing, verdict != ScopeVerdict::Ok)
}

#[tauri::command]
pub async fn spotify_status(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<SpotifyStatus, String> {
    let configured = config(&state).is_ok();
    let mut account = ACCOUNT.lock().unwrap().as_ref().map(|a| a.display.clone());
    let mut problem = None;
    // Validate a stored token on every status check (the card asks on mount and on window
    // focus, not on a timer): a token that Spotify revoked, or one minted for a different
    // Client ID, must read "Not connected" with a Connect button, not a stale "Connected".
    // A timeout here no longer cancels a refresh grant (it runs detached).
    if let Err(e) = os_core::os_secret_lookup(SECRET_REFRESH) {
        problem = Some(e); // a Credential Manager hiccup: transient, still connected
    } else if configured && has_refresh(&state) && !os.snapshot().privacy.kill_switch {
        match tokio::time::timeout(Duration::from_secs(5), fetch_account(&state)).await {
            Ok(Ok(name)) => account = Some(name),
            Ok(Err(e)) => problem = Some(e),
            Err(_) => {} // slow network: keep the cached name, don't call it broken
        }
    }
    // The account lookup drops a revoked refresh token, so check it afterwards.
    let connected = has_refresh(&state);
    let grant = load_grant();
    let (missing_scopes, reauth_pending) = if connected { scope_status(effective_scope().as_deref(), grant.requested.as_deref()) } else { (Vec::new(), false) };
    // A grant from before SCOPES grew can't do everything: only a new sign-in fixes it.
    if reauth_pending && problem.is_none() {
        problem = Some(SCOPES_CHANGED.into());
    }
    let problem = problem.filter(|_| connected);
    let problem_kind = problem.as_deref().map(problem_kind);
    let expires_in_days = if connected { expires_in_days(grant.at, os_core::now_secs()) } else { None };
    Ok(SpotifyStatus { configured, connected, account: account.filter(|_| connected), problem, problem_kind, missing_scopes, reauth_pending, expires_in_days })
}

/// Pure: the grant Disconnect leaves behind — only the seed rejection (this seed's hash,
/// else the previously persisted one).
fn disconnect_grant(seed: Option<&str>, persisted: Option<String>) -> Grant {
    Grant { rejected_seed: seed.map(|s| hex(&seed_hash(s))).or(persisted), ..Grant::default() }
}

/// Forget every Spotify credential. A `.env` seed is never edited; its hash is persisted
/// in the grant so it stays ignored across restarts (a different seed value is honoured).
/// Never auto-prompts afterwards.
#[tauri::command]
pub async fn spotify_disconnect(app: AppHandle, state: State<'_, DispatchState>) -> Result<(), String> {
    let flow = FLOW.lock().unwrap().take();
    if let Some(h) = flow {
        h.abort();
    }
    // A refresh in flight sees the new epoch and writes nothing.
    AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
    *PENDING_REFRESH.lock().unwrap() = None;
    *REFRESH_BACKOFF.lock().unwrap() = None;
    let first = os_core::os_secret_clear(SECRET_REFRESH);
    let _ = os_core::os_secret_clear(SECRET_SESSION);
    let seed = env_or_file(&state, ENV_REFRESH);
    if let Some(seed) = &seed {
        *ENV_SEED_REJECTED.lock().unwrap() = Some(seed_hash(seed));
    }
    let reset = disconnect_grant(seed.as_deref(), load_grant().rejected_seed);
    store_grant(&reset);
    // Waits out an in-flight refresh (it holds ACCESS). Its compare-and-store sees the
    // cleared entry and stores nothing; clear again in case it stored just before.
    *ACCESS.lock().await = None;
    *PENDING_REFRESH.lock().unwrap() = None;
    let second = os_core::os_secret_clear(SECRET_REFRESH);
    let _ = os_core::os_secret_clear(SECRET_SESSION);
    // An exchange / refresh that held ACCESS may have stored a grant after the reset above.
    store_grant(&reset);
    *ACCOUNT.lock().unwrap() = None;
    clear_playlist_cache();
    super::mcp::emit_tools_changed(&app, "spotify-disconnected");
    first.and(second)
}

/// What `warm` does about the grant once the account lookup worked.
#[derive(Debug, PartialEq)]
enum WarmAction {
    Nothing,
    /// Verdict Ok but `requested` (or `scope`) is old/missing: rewrite the grant silently.
    Rewrite,
    Reauth(ReauthReason),
}

/// Pure decision for `warm`.
fn warm_action(grant: &Grant, granted: Option<&str>, now: u64) -> WarmAction {
    match scope_verdict(granted, grant.requested.as_deref()) {
        ScopeVerdict::Stale | ScopeVerdict::Missing(_) => WarmAction::Reauth(ReauthReason::Scopes),
        ScopeVerdict::Ok if renew_due(grant.at, now) => WarmAction::Reauth(ReauthReason::Renew),
        ScopeVerdict::Ok if grant.requested.as_deref() != Some(requested_hash().as_str()) || (grant.scope.is_none() && granted.is_some()) => WarmAction::Rewrite,
        ScopeVerdict::Ok => WarmAction::Nothing,
    }
}

/// Startup (lib.rs setup): load the saved session into memory, refresh silently if it
/// is stale, and fetch the account name. Then checks the grant: a consent that predates
/// SCOPES or misses a core scope, or a 6-month window ending within 7 days, opens the
/// consent page automatically (at most twice per key, D18).
pub async fn warm(app: AppHandle) {
    let _ = APP.set(app.clone());
    let state = app.state::<DispatchState>();
    let os = app.state::<OsState>();
    if os.snapshot().privacy.kill_switch || config(&state).is_err() || !has_refresh(&state) {
        return;
    }
    if let Err(e) = fetch_account(&state).await {
        eprintln!("[spotify] warm-up failed ({})", problem_kind(&e));
        return;
    }
    // A failed grant read decides nothing (a rewrite or prompt would overwrite the real grant).
    let Ok(grant) = try_load_grant() else {
        eprintln!("[spotify] couldn't read the grant; skipping the scope check this run");
        return;
    };
    let granted = effective_scope();
    let now = os_core::now_secs();
    match warm_action(&grant, granted.as_deref(), now) {
        WarmAction::Nothing => {}
        WarmAction::Rewrite => store_grant(&Grant { scope: grant.scope.clone().or(granted), requested: Some(requested_hash()), ..grant }),
        WarmAction::Reauth(reason) => {
            match scope_verdict(granted.as_deref(), grant.requested.as_deref()) {
                ScopeVerdict::Missing(m) => eprintln!("[spotify] scopes missing: {}", m.join(", ")),
                ScopeVerdict::Stale => eprintln!("[spotify] consent predates the current scope set"),
                ScopeVerdict::Ok => eprintln!("[spotify] sign-in renews in {} days", expires_in_days(grant.at, now).unwrap_or(0)),
            }
            if reason == ReauthReason::Renew && grant.requested.as_deref() != Some(requested_hash().as_str()) {
                // Keep the grant consistent while the renewal page is open.
                store_grant(&Grant { scope: grant.scope.clone().or(granted.clone()), requested: Some(requested_hash()), ..grant.clone() });
            }
            request_reauth_with(reason, granted);
        }
    }
}

#[tauri::command]
pub async fn spotify_now_playing(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<NowPlaying, String> {
    may_read(&os)?;
    now_playing(&state).await
}

#[tauri::command]
pub async fn spotify_recent(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<Vec<QuickItem>, String> {
    may_read(&os)?;
    get(&state, "/me/player/recently-played", &[("limit", "20".into())]).await.map(|v| parse_recent(&v))
}

#[tauri::command]
pub async fn spotify_playlists(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<Vec<QuickItem>, String> {
    may_read(&os)?;
    get(&state, "/me/playlists", &[("limit", "20".into())]).await.map(|v| parse_playlists(&v))
}

/// `action`: play | pause | resume | next | previous | volume | shuffle | seek | repeat.
/// `value`: volume → number (absolute %) or "+N"/"-N"; shuffle → bool / "on" / "off" (omitted = toggle);
/// seek → seconds; repeat → "off" | "track" | "context".
#[tauri::command]
pub async fn spotify_control(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, action: String, value: Option<Value>, approved: Option<bool>) -> Result<String, String> {
    let what = format!("spotify.{action}");
    may_control(&os, &bridge, approved.unwrap_or(false), &what)?;
    logged(&bridge, &what, control(&state, &os, &action, value.as_ref()).await)
}

#[tauri::command]
pub async fn spotify_play(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, query: String, kind: Option<String>, approved: Option<bool>) -> Result<String, String> {
    may_control(&os, &bridge, approved.unwrap_or(false), "spotify.play")?;
    if query.trim().is_empty() || query.len() > 200 {
        return Err("tell me what to play".into());
    }
    logged(&bridge, "spotify.play", tool(&state, &os, "spotify.play", &json!({ "query": query, "type": kind })).await)
}

#[tauri::command]
pub async fn spotify_play_uri(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, uri: String, approved: Option<bool>) -> Result<String, String> {
    may_control(&os, &bridge, approved.unwrap_or(false), "spotify.play_uri")?;
    if os.snapshot().privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    logged(&bridge, "spotify.play_uri", play_uri(&state, &uri).await)
}

/// Any of the 23 Spotify tools by name (TS fast path, approval cards). Returns the speakable reply.
/// Gate order (contract §4.6): unknown name; kill switch; server off; read-only server + write;
/// read ⇒ `read_gate`; write ⇒ MCP tier, then the destructive gate; writes are logged.
#[tauri::command]
pub async fn spotify_tool(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, name: String, args: Option<Value>, approved: Option<bool>) -> Result<String, String> {
    let name = intent::canonical(name.trim()).to_string();
    let cfg = os.snapshot();
    tool_precheck(&cfg, &name)?;
    tool_gate(&cfg, &bridge, &name, approved.unwrap_or(false))?;
    let args = args.filter(Value::is_object).unwrap_or_else(|| json!({}));
    let out = tool(&state, &os, &name, &args).await;
    if intent::is_write_tool(&name) {
        logged(&bridge, &name, out)
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let v = b64url(&random_bytes::<64>());
        assert_eq!(v.len(), 86);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn authorize_url_carries_every_param() {
        let u = url::Url::parse(&authorize_url("cid123", DEFAULT_REDIRECT, "chal", "st4te", true)).unwrap();
        assert_eq!(u.as_str().split('?').next(), Some("https://accounts.spotify.com/authorize"));
        let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid123");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:1420/callback");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["state"], "st4te");
        assert!(q["scope"].contains("user-modify-playback-state") && q["scope"].contains("playlist-read-collaborative"));
        let got: std::collections::BTreeSet<&str> = q["scope"].split(' ').collect();
        let want: std::collections::BTreeSet<&str> = SCOPES.split_whitespace().collect();
        assert_eq!(got, want);
        assert_eq!(got.len(), 18);
        assert_eq!(q["show_dialog"], "true");
        let silent = url::Url::parse(&authorize_url("cid123", DEFAULT_REDIRECT, "chal", "st4te", false)).unwrap();
        assert!(silent.query_pairs().any(|(k, v)| k == "show_dialog" && v == "false"));
    }

    #[test]
    fn scopes_constant_is_the_18_requested() {
        let list: Vec<&str> = SCOPES.split_whitespace().collect();
        let set: std::collections::BTreeSet<&str> = list.iter().copied().collect();
        assert_eq!(list.len(), 18);
        assert_eq!(set.len(), 18, "no duplicates");
        let want = [
            "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "streaming", "app-remote-control",
            "playlist-read-private", "playlist-read-collaborative", "playlist-modify-public", "playlist-modify-private", "user-library-read",
            "user-library-modify", "user-follow-read", "user-follow-modify", "user-top-read", "user-read-recently-played",
            "user-read-playback-position", "user-read-email", "user-read-private",
        ];
        assert_eq!(set, want.into_iter().collect());
        assert_eq!(core_scopes().count(), 14);
        assert!(OPTIONAL_SCOPES.iter().all(|o| set.contains(o)));
    }

    const LEGACY: &str = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played playlist-read-private playlist-read-collaborative";

    #[test]
    fn scope_verdict_cases() {
        let h = requested_hash();
        let ScopeVerdict::Missing(m) = scope_verdict(Some(LEGACY), Some(&h)) else { panic!("expected Missing") };
        assert_eq!(
            m,
            ["playlist-modify-public", "playlist-modify-private", "user-library-read", "user-library-modify", "user-follow-read", "user-follow-modify", "user-top-read", "user-read-playback-position"]
        );
        assert_eq!(scope_verdict(Some(SCOPES), Some(&h)), ScopeVerdict::Ok);
        let no_streaming = SCOPES.split_whitespace().filter(|s| *s != "streaming").collect::<Vec<_>>().join(" ");
        assert_eq!(scope_verdict(Some(&no_streaming), Some(&h)), ScopeVerdict::Ok, "optional scopes never matter");
        assert_eq!(scope_verdict(None, None), ScopeVerdict::Stale);
        assert_eq!(scope_verdict(Some(SCOPES), None), ScopeVerdict::Ok);
        assert_eq!(scope_verdict(None, Some(&h)), ScopeVerdict::Ok, "scope unknown, current consent");
        assert_eq!(scope_verdict(Some(LEGACY), Some("0123old")), ScopeVerdict::Stale);
        assert_eq!(scope_verdict(None, Some("0123old")), ScopeVerdict::Stale);
        // The hash is order-independent and hex.
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn grant_store_failure_recovers_without_prompt() {
        // exchange stored the session (full scope) but not the grant: no Stale, no prompt.
        assert_eq!(scope_verdict(Some(SCOPES), None), ScopeVerdict::Ok);
        let g = Grant::default();
        assert_eq!(warm_action(&g, Some(SCOPES), 1_000), WarmAction::Rewrite);
        assert_eq!(warm_action(&g, Some(LEGACY), 1_000), WarmAction::Reauth(ReauthReason::Scopes));
        let current = Grant { scope: Some(SCOPES.into()), requested: Some(requested_hash()), at: Some(1_000), ..Grant::default() };
        assert_eq!(warm_action(&current, Some(SCOPES), 2_000), WarmAction::Nothing);
    }

    #[test]
    fn effective_scope_prefers_grant() {
        assert_eq!(pick_scope(Some("a b".into()), || Some("c".into())), Some("a b".into()));
        assert_eq!(pick_scope(None, || Some("c".into())), Some("c".into()));
        assert_eq!(pick_scope(None, || None), None);
    }

    #[test]
    fn missing_core_for_tool() {
        assert_eq!(missing_core(&["user-library-modify"], Some(LEGACY)), ["user-library-modify"]);
        assert!(missing_core(&["user-library-modify"], None).is_empty(), "scope unknown ⇒ never blocks");
        assert!(missing_core(&["user-read-playback-state", "user-modify-playback-state"], Some(LEGACY)).is_empty());
        assert!(missing_core(&["streaming"], Some(LEGACY)).is_empty(), "optional scopes are never required");
    }

    #[test]
    fn prompt_once_per_key() {
        let key = prompt_key(ReauthReason::Scopes, &requested_hash(), None);
        let g = Grant::default();
        assert!(should_prompt(&g, &key, false, true, false, false));
        let done = Grant { prompted: Some(key.clone()), ..Grant::default() };
        assert!(!should_prompt(&done, &key, false, true, false, false), "final key");
        assert!(should_prompt(&done, "renew:5", false, true, false, false), "another key still may");
        assert!(!should_prompt(&g, &key, true, true, false, false), "kill switch");
        assert!(!should_prompt(&g, &key, false, false, false, false), "server disabled");
        assert!(!should_prompt(&g, &key, false, true, true, false), "flow running");
        assert!(!should_prompt(&g, &key, false, true, false, true), "already prompted this run");
        let h = "abcdef0123456789ffff";
        assert_eq!(prompt_key(ReauthReason::Scopes, h, Some(9)), "scopes:abcdef0123456789");
        assert_eq!(prompt_key(ReauthReason::Refused, h, Some(9)), "refused:abcdef0123456789");
        assert_eq!(prompt_key(ReauthReason::Expired, h, Some(9)), "expired:9");
        assert_eq!(prompt_key(ReauthReason::Expired, h, None), "expired:0");
        assert_eq!(prompt_key(ReauthReason::Renew, h, Some(9)), "renew:9");
        assert_ne!(prompt_key(ReauthReason::Scopes, "1111111111111111", None), prompt_key(ReauthReason::Scopes, "2222222222222222", None));
        assert_ne!(prompt_key(ReauthReason::Renew, h, Some(1)), prompt_key(ReauthReason::Renew, h, Some(2)));
    }

    #[test]
    fn record_prompt_two_tries() {
        let g = Grant::default();
        let once = record_prompt(&g, "scopes:k");
        assert_eq!((once.prompt_tries.clone(), once.prompted.clone()), (Some(("scopes:k".to_string(), 1)), None));
        let twice = record_prompt(&once, "scopes:k");
        assert_eq!((twice.prompt_tries.clone(), twice.prompted.as_deref()), (None, Some("scopes:k")));
        assert!(!should_prompt(&twice, "scopes:k", false, true, false, false));
        let other = record_prompt(&once, "renew:7");
        assert_eq!((other.prompt_tries, other.prompted), (Some(("renew:7".to_string(), 1)), None), "a different key resets the tries");
    }

    #[test]
    fn show_dialog_policy() {
        assert!(show_dialog_for(ReauthReason::Scopes, Some(SCOPES)));
        assert!(show_dialog_for(ReauthReason::Refused, Some(SCOPES)));
        assert!(!show_dialog_for(ReauthReason::Expired, Some(SCOPES)));
        assert!(!show_dialog_for(ReauthReason::Renew, Some(SCOPES)));
        assert!(show_dialog_for(ReauthReason::Expired, Some(LEGACY)));
        assert!(show_dialog_for(ReauthReason::Renew, Some(LEGACY)));
        assert!(show_dialog_for(ReauthReason::Expired, None));
        assert!(show_dialog_for(ReauthReason::Renew, None));
    }

    #[test]
    fn expires_in_days_math() {
        let at = 1_000_000;
        assert_eq!(expires_in_days(None, at), None);
        assert_eq!(expires_in_days(Some(at), at), Some(182));
        assert_eq!(expires_in_days(Some(at), at + 86_400), Some(181));
        assert_eq!(expires_in_days(Some(at), at + 86_400 + 1), Some(180), "partial days round down");
        assert_eq!(expires_in_days(Some(at), at + REFRESH_LIFETIME_SECS - 1), Some(0));
        assert_eq!(expires_in_days(Some(at), at + REFRESH_LIFETIME_SECS), None, "window over");
        assert!(expires_in_days(Some(u64::MAX), 0).is_some(), "no overflow panic");
    }

    #[test]
    fn renew_key_and_window() {
        let at = 1_000_000;
        let seven = at + REFRESH_LIFETIME_SECS - 7 * 86_400;
        let eight = at + REFRESH_LIFETIME_SECS - 8 * 86_400;
        assert!(renew_due(Some(at), seven));
        assert!(!renew_due(Some(at), eight));
        assert!(!renew_due(None, seven));
        let g = Grant { scope: Some(SCOPES.into()), requested: Some(requested_hash()), at: Some(at), ..Grant::default() };
        assert_eq!(warm_action(&g, Some(SCOPES), seven), WarmAction::Reauth(ReauthReason::Renew));
        assert_eq!(warm_action(&g, Some(SCOPES), eight), WarmAction::Nothing);
        let h = requested_hash();
        assert_ne!(prompt_key(ReauthReason::Renew, &h, Some(at)), prompt_key(ReauthReason::Renew, &h, Some(at + 1)), "a new sign-in gets a new key");
    }

    #[test]
    fn grant_blob_fits_keychain() {
        let k = format!("scopes:{}", &requested_hash()[..16]);
        let g = Grant {
            scope: Some(SCOPES.into()),
            requested: Some(requested_hash()),
            at: Some(1_800_000_000),
            prompted: Some(k.clone()),
            prompt_tries: Some((k, 1)),
            rejected_seed: Some(hex(&seed_hash("AQDrawSeedValue"))),
        };
        let blob = grant_blob(&g).expect("fits");
        assert!(blob.encode_utf16().count() * 2 < SESSION_MAX_UTF16_BYTES);
        assert_eq!(parse_grant(&blob), g);
        assert_eq!(parse_grant("{}"), Grant::default());
        assert_eq!(parse_grant(r#"{"scope":"a"}"#), Grant { scope: Some("a".into()), ..Grant::default() });
        assert_eq!(parse_grant("garbage"), Grant::default());
        assert!(!blob.contains("AQDrawSeedValue"), "only the seed's hash is stored");
    }

    #[test]
    fn refresh_carries_scope_forward() {
        assert_eq!(next_scope(Some("a b"), Some("c")), Some("a b".into()));
        assert_eq!(next_scope(None, Some("c")), Some("c".into()));
        assert_eq!(next_scope(None, None), None);
    }

    #[test]
    fn seed_rejection_persists() {
        let seed = "AQDseed";
        let none = Grant::default();
        assert!(!seed_rejected(seed, None, &none));
        assert!(seed_rejected(seed, Some(seed_hash(seed)), &none), "memory rejection");
        let persisted = Grant { rejected_seed: Some(hex(&seed_hash(seed))), ..Grant::default() };
        assert!(seed_rejected(seed, None, &persisted), "survives a restart");
        assert!(!seed_rejected("AQDnewseed", None, &persisted), "an edited .env seed is honoured");
    }

    #[test]
    fn grant_writes_never_drop_a_rejection_from_this_run() {
        let seed = "AQDseed";
        let rich = Grant { scope: Some("a".into()), at: Some(5), prompted: Some("k".into()), ..Grant::default() };
        // A write built before/without the rejection (stale exchange read, failed read) keeps it.
        let merged = merge_rejection(rich.clone(), Some(seed_hash(seed)));
        assert_eq!(merged.rejected_seed, Some(hex(&seed_hash(seed))));
        assert_eq!((merged.scope.as_deref(), merged.at, merged.prompted.as_deref()), (Some("a"), Some(5), Some("k")));
        // Nothing rejected this run ⇒ the grant is untouched (incl. an older persisted rejection).
        let old = Grant { rejected_seed: Some("old".into()), ..rich.clone() };
        assert_eq!(merge_rejection(old.clone(), None), old);
        assert_eq!(merge_rejection(rich.clone(), None), rich);
    }

    #[test]
    fn disconnect_grant_keeps_only_the_rejection() {
        let g = disconnect_grant(Some("AQDseed"), Some("older".into()));
        assert_eq!(g, Grant { rejected_seed: Some(hex(&seed_hash("AQDseed"))), ..Grant::default() });
        assert_eq!(disconnect_grant(None, Some("older".into())), Grant { rejected_seed: Some("older".into()), ..Grant::default() });
        assert_eq!(disconnect_grant(None, None), Grant::default());
    }

    #[test]
    fn refresh_scope_survives_an_expired_session() {
        // Grant store failed at exchange (scope None) and the session token has expired, so the
        // in-memory slot is empty: the stored session's scope (via effective_scope) carries forward.
        let full = SCOPES.to_string();
        let prev = previous_scope(Some(full.clone()), None);
        assert_eq!(next_scope(None, prev.as_deref()), Some(full.clone()));
        assert_eq!(scope_verdict(prev.as_deref(), None), ScopeVerdict::Ok, "no consent page");
        // Effective scope wins over a stale in-memory copy; memory is only the last resort.
        assert_eq!(previous_scope(Some("a".into()), Some("b".into())), Some("a".into()));
        assert_eq!(previous_scope(None, Some("b".into())), Some("b".into()));
        // Click-free renewal for Expired needs the prior full grant to reach show_dialog_for.
        assert!(!show_dialog_for(ReauthReason::Expired, previous_scope(Some(full), None).as_deref()));
    }

    #[test]
    fn kill_switch_blocks_a_late_sign_in_code() {
        assert_eq!(blocked_by_kill_switch(true), Some(AuthOutcome::Failed(KILL_SWITCH.into())));
        assert_eq!(blocked_by_kill_switch(false), None);
        // The automatic flow reports it (never a silent token exchange).
        let auto = Origin::Auto(ReauthReason::Scopes);
        assert_eq!(auth_outcome_event(auto, &blocked_by_kill_switch(true).unwrap()), Some(json!({ "ok": false, "error": KILL_SWITCH })));
    }

    #[test]
    fn auto_prompt_timeout_is_silent() {
        let auto = Origin::Auto(ReauthReason::Scopes);
        assert_eq!(auth_outcome_event(auto, &AuthOutcome::Timeout), None);
        assert_eq!(auth_outcome_event(Origin::Manual, &AuthOutcome::Timeout), Some(json!({ "ok": false, "error": AUTH_TIMEOUT })));
        assert_eq!(auth_outcome_event(auto, &AuthOutcome::Denied("Spotify sign-in was cancelled".into())), Some(json!({ "ok": false, "error": "Spotify sign-in was cancelled" })));
        assert_eq!(auth_outcome_event(auto, &AuthOutcome::Connected(Some("Nick".into()))), Some(json!({ "ok": true, "account": "Nick" })));
        assert_eq!(auth_outcome_event(Origin::Manual, &AuthOutcome::Failed("x".into())), Some(json!({ "ok": false, "error": "x" })));
    }

    #[test]
    fn status_scope_fields() {
        let h = requested_hash();
        let (m, pending) = scope_status(Some(LEGACY), Some(&h));
        assert_eq!(m.len(), 8);
        assert!(pending);
        assert_eq!(scope_status(Some(SCOPES), Some(&h)), (vec![], false));
        assert_eq!(scope_status(None, Some(&h)), (vec![], false));
        assert_eq!(scope_status(None, None), (vec![], true), "stale consent, scope unknown");
    }

    #[test]
    fn redirect_must_be_loopback_http() {
        assert_eq!(redirect_target(DEFAULT_REDIRECT).unwrap(), ("127.0.0.1:1420".parse().unwrap(), "/callback".to_string()));
        assert_eq!(redirect_target("http://[::1]:9000/cb").unwrap().0, "[::1]:9000".parse().unwrap());
        assert!(redirect_target("http://localhost:1420/callback").is_err());
        assert!(redirect_target("https://127.0.0.1:1420/callback").is_err());
        assert!(redirect_target("http://10.0.0.2:1420/callback").is_err());
    }

    #[test]
    fn callback_request_parsed() {
        assert_eq!(
            parse_callback("GET /callback?code=AQB%2Fx&state=abc HTTP/1.1\r\nHost: 127.0.0.1:1420\r\n\r\n", "/callback"),
            Callback::Code { code: "AQB/x".into(), state: "abc".into() }
        );
        assert_eq!(parse_callback("GET /callback?error=access_denied&state=abc HTTP/1.1\r\n", "/callback"), Callback::Denied { error: "access_denied".into(), state: "abc".into() });
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n", "/callback"), Callback::Other);
        assert_eq!(parse_callback("GET /callback HTTP/1.1\r\n", "/callback"), Callback::Other);
        assert_eq!(parse_callback("POST /callback?code=x&state=y HTTP/1.1\r\n", "/callback"), Callback::Other);
        assert_eq!(parse_callback("", "/callback"), Callback::Other);
        assert_eq!(denied_message("access_denied"), "Spotify sign-in was cancelled");
        assert!(html_reply("200 OK", "hi").starts_with("HTTP/1.1 200 OK\r\n"));
    }

    #[test]
    fn token_reply_mapping() {
        let t = parse_token_reply(200, r#"{"access_token":"a1","token_type":"Bearer","expires_in":3600,"refresh_token":"r1","scope":"user-read-playback-state streaming"}"#).unwrap();
        assert_eq!(t, TokenReply { access: "a1".into(), expires_in: 3600, refresh: Some("r1".into()), scope: Some("user-read-playback-state streaming".into()) });
        let bare = parse_token_reply(200, r#"{"access_token":"a2","expires_in":10,"scope":"  "}"#).unwrap();
        assert_eq!((bare.refresh, bare.scope), (None, None));
        assert_eq!(parse_token_reply(200, r#"{"access_token":"a3"}"#).unwrap().expires_in, 3600);
        assert_eq!(parse_token_reply(400, r#"{"error":"invalid_grant","error_description":"Refresh token revoked"}"#).unwrap_err(), REVOKED);
        assert!(parse_token_reply(401, r#"{"error":"invalid_client"}"#).unwrap_err().contains("SPOTIFY_CLIENT_ID"));
        assert!(parse_token_reply(200, "{}").is_err());
        assert_eq!(token_error_code(r#"{"error":"invalid_grant","error_description":"Refresh token revoked"}"#), "invalid_grant");
        assert_eq!(token_error_code(r#"{"error":"Bad<script>Stuff"}"#), "adscripttuff");
        assert_eq!(token_error_code("not json"), "");
    }

    #[test]
    fn refresh_timing() {
        assert!(!needs_refresh(1_000, 699, false), "301 s left");
        assert!(needs_refresh(1_000, 700, false), "exactly the 300 s margin");
        assert!(needs_refresh(1_000, 900, false), "100 s left");
        assert!(needs_refresh(1_000, 2_000, false), "expired");
        assert!(needs_refresh(5_000, 900, true), "forced");
        assert!(!needs_refresh(u64::MAX, u64::MAX - 301, false), "no overflow");
    }

    #[test]
    fn rotation_is_compare_and_store() {
        // Normal rotation: keychain still holds what we used.
        assert!(should_store(Some("old"), Some("old"), "new"));
        // No rotation: nothing to write.
        assert!(!should_store(Some("old"), Some("old"), "old"));
        // Disconnected (cleared) or reconnected (replaced) while the refresh ran.
        assert!(!should_store(None, Some("old"), "new"));
        assert!(!should_store(Some("fresh-connect"), Some("old"), "new"));
        // `.env` seed with an empty keychain: the rotated token goes to the keychain.
        assert!(should_store(None, None, "rotated"));
        // A pending (unsaved) rotation finally reaches the keychain.
        assert!(should_store(Some("older"), Some("older"), "pending"));
    }

    #[test]
    fn invalid_grant_wipes_only_the_token_it_used() {
        assert_eq!(on_invalid_grant("t1", Some("t1"), None), OnInvalidGrant::Clear);
        assert_eq!(on_invalid_grant("t1", None, None), OnInvalidGrant::Clear);
        assert_eq!(on_invalid_grant("t1", Some("t2"), None), OnInvalidGrant::RetryWith("t2".into()));
        assert_eq!(on_invalid_grant("t1", Some("t1"), Some("p1")), OnInvalidGrant::RetryWith("p1".into()));
        assert_eq!(on_invalid_grant("p1", Some("t1"), Some("p1")), OnInvalidGrant::RetryWith("t1".into()));
        assert_eq!(on_invalid_grant("p1", None, Some("p1")), OnInvalidGrant::Clear);
    }

    #[test]
    fn pending_and_keychain_both_dead_clears_instead_of_looping() {
        // Pending P refused → retry with keychain K0.
        let mut tried = vec!["P".to_string()];
        assert_eq!(grant_verdict(Some("K0"), Some("P"), &tried), OnInvalidGrant::RetryWith("K0".into()));
        tried.push("K0".into());
        // K0 refused too: both candidates were tried, so the sign-in is dead (wipe + event).
        assert_eq!(grant_verdict(Some("K0"), Some("P"), &tried), OnInvalidGrant::Clear);
        // A third token another instance just stored is still worth a try.
        assert_eq!(grant_verdict(Some("K2"), Some("P"), &tried), OnInvalidGrant::RetryWith("K2".into()));
    }

    #[test]
    fn pending_token_usable_while_keychain_reads_fail() {
        let p = Pending { token: "P".into(), base: None };
        let (t, src, was) = pick_refresh(Err("keychain read failed".into()), Some(p), Some("seed")).unwrap();
        assert_eq!((t.as_str(), src, was), ("P", Source::Pending, Was::Unknown));
        // A known base stands in for the failed read.
        let p = Pending { token: "P".into(), base: Some(Some("K0".into())) };
        assert_eq!(pick_refresh(Err("x".into()), Some(p), None).unwrap().2, Was::Known(Some("K0".into())));
        // No pending token: a read failure is still an error, never "empty".
        assert!(pick_refresh(Err("x".into()), None, Some("seed")).is_err());
        assert_eq!(pick_refresh(Ok(None), None, Some("seed")).unwrap(), ("seed".into(), Source::EnvSeed, Was::Known(None)));
        assert_eq!(pick_refresh(Ok(Some("K".into())), None, Some("seed")).unwrap(), ("K".into(), Source::Keychain, Was::Known(Some("K".into()))));
    }

    #[test]
    fn pending_retry_is_compare_and_store() {
        let p = Pending { token: "P".into(), base: Some(Some("K0".into())) };
        assert_eq!(pending_action(Some("K0"), &p), PendingAction::Store);
        assert_eq!(pending_action(Some("P"), &p), PendingAction::AlreadySaved);
        assert_eq!(pending_action(Some("K9"), &p), PendingAction::Leave, "a Connect elsewhere wins");
        assert_eq!(pending_action(None, &p), PendingAction::Leave, "disconnected meanwhile");
        let seeded = Pending { token: "P".into(), base: Some(None) };
        assert_eq!(pending_action(None, &seeded), PendingAction::Store);
        let unknown = Pending { token: "P".into(), base: None };
        assert_eq!(pending_action(Some("K0"), &unknown), PendingAction::Leave);
    }

    #[test]
    fn transient_token_failures_back_off() {
        assert_eq!(backoff_until(429, Some(12), 1000), Some(1012));
        assert_eq!(backoff_until(503, None, 1000), Some(1030));
        assert_eq!(backoff_until(0, None, 1000), Some(1030));
        assert_eq!(backoff_until(429, Some(99_999), 1000), Some(1300));
        assert_eq!(backoff_until(429, Some(0), 1000), Some(1005));
        assert_eq!(backoff_until(400, None, 1000), None, "invalid_client etc. retry at once");
        assert_eq!(backoff_until(401, Some(10), 1000), None);
    }

    #[test]
    fn session_blob_round_trips_and_respects_the_keychain_limit() {
        let s = StoredSession { access_token: "BQ".repeat(150), expires_at_unix: 1_800_000_000, scope: Some(SCOPES.into()) };
        let blob = session_blob(&s).expect("a real-size session fits");
        assert_eq!(parse_session(&blob), Some(s));
        let huge = StoredSession { access_token: "x".repeat(1300), expires_at_unix: 1, scope: None };
        assert_eq!(session_blob(&huge), None, "over 2560 UTF-16 bytes");
        assert_eq!(parse_session(r#"{"access_token":"","expires_at_unix":5}"#), None);
        assert_eq!(parse_session(r#"{"access_token":"a","expires_at_unix":5}"#).unwrap().scope, None);
        assert_eq!(parse_session("garbage"), None);
        let a = access_from(&TokenReply { access: "a".into(), expires_in: 3600, refresh: None, scope: None }, 100);
        assert_eq!((a.expires_at, a.obtained_at), (3700, 100));
    }

    #[test]
    fn scopes_and_401_policy() {
        assert!(missing_scopes(SCOPES).is_empty());
        assert_eq!(missing_scopes(LEGACY).len(), 8);
        assert!(!missing_scopes(LEGACY).contains(&"streaming"), "optional scopes are never 'missing'");
        assert!(retry_401(30, ""), "an older token may simply have expired early");
        assert!(retry_401(0, r#"{"error":{"status":401,"message":"The access token expired"}}"#));
        assert!(retry_401(1, r#"{"error":{"status":401,"message":"Invalid access token"}}"#));
        assert!(!retry_401(2, r#"{"error":{"status":401,"message":"Permissions missing"}}"#), "a brand-new token: no refresh churn");
    }

    #[test]
    fn problem_kinds_follow_the_error_constants() {
        assert_eq!(problem_kind(NOT_CONNECTED), "reauth");
        assert_eq!(problem_kind(REVOKED), "reauth");
        assert_eq!(problem_kind(SCOPES_CHANGED), "reauth");
        assert_eq!(problem_kind(OWNER_PREMIUM), "owner_premium");
        assert_eq!(problem_kind(PREMIUM), "premium");
        assert_eq!(problem_kind(SCOPE_PROMPTED), "reauth");
        assert_eq!(problem_kind(NOT_REGISTERED), "allowlist");
        assert_eq!(problem_kind(QUOTA), "transient");
        assert_eq!(problem_kind(&ApiError::Scope { prompted: true }.text()), "reauth");
        assert_eq!(problem_kind(&ApiError::Scope { prompted: false }.text()), "reauth");
        assert_eq!(problem_kind(&ApiError::NotRegistered.text()), "allowlist");
        assert_eq!(problem_kind(&ApiError::OwnerPremium.text()), "owner_premium");
        assert_eq!(problem_kind(&ApiError::Premium.text()), "premium");
        assert_eq!(problem_kind("Spotify refused the request (HTTP 401)"), "transient");
        assert_eq!(problem_kind("keychain read failed (platform failure)"), "transient");
        assert_eq!(problem_kind("Spotify is rate-limiting requests — try again in a minute"), "transient");
    }

    #[test]
    fn api_errors_are_friendly() {
        assert_eq!(api_error(404, r#"{"error":{"status":404,"message":"Player command failed: No active device found","reason":"NO_ACTIVE_DEVICE"}}"#, None), ApiError::NoDevice);
        assert_eq!(api_error(404, r#"{"error":{"status":404,"message":"no active device"}}"#, None), ApiError::NoDevice);
        assert_eq!(api_error(404, r#"{"error":{"status":404,"message":"Resource not found"}}"#, None), ApiError::NotFound("Resource not found".into()));
        assert_eq!(ApiError::NotFound("Resource not found".into()).text(), "Spotify couldn't find that: Resource not found");
        assert_eq!(ApiError::NotFound(String::new()).text(), "Spotify couldn't find that");
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Premium required","reason":"PREMIUM_REQUIRED"}}"#, None), ApiError::Premium);
        assert_eq!(ApiError::Premium.text(), PREMIUM);
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Restriction violated"}}"#, None), ApiError::Msg("Spotify error (HTTP 403): Player command failed: Restriction violated".into()));
        // 5xx.
        assert_eq!(api_error(500, "", None), ApiError::Msg("Spotify had a server problem (HTTP 500) — try again in a moment".into()));
        assert_eq!(api_error(503, "upstream down", None).text(), "Spotify had a server problem (HTTP 503) — try again in a moment");
        // A 401 the refresh couldn't fix: reported as refused, never "connect it again".
        assert_eq!(api_error(401, "", None), ApiError::Msg("Spotify refused the request (HTTP 401)".into()));
        let ApiError::Msg(m) = api_error(401, r#"{"error":{"status":401,"message":"Permissions missing"}}"#, None) else { panic!("expected Msg") };
        assert_eq!(m, "Spotify refused the request (HTTP 401): Permissions missing");
        assert!(!m.contains("connect it again") && problem_kind(&m) == "transient");
        // The exact body Spotify returns for a dev-mode app whose owner has no Premium.
        assert_eq!(
            api_error(403, r#"{"error":{"status":403,"message":"Active premium subscription required for the owner of the app. When the subscription status changes, it can take a few hours before requests are allowed again."}}"#, None),
            ApiError::OwnerPremium
        );
        assert_eq!(ApiError::OwnerPremium.text(), OWNER_PREMIUM);
        // Insufficient scope.
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"Insufficient client scope"}}"#, None), ApiError::Scope { prompted: false });
        assert_eq!(ApiError::Scope { prompted: true }.text(), SCOPE_PROMPTED);
        assert_eq!(ApiError::Scope { prompted: false }.text(), SCOPES_CHANGED);
        // Empty 403: Forbidden (send may upgrade it to Scope).
        assert_eq!(api_error(403, "", None), ApiError::Forbidden(String::new()));
        assert_eq!(ApiError::Forbidden(String::new()).text(), "Spotify refused that (HTTP 403). If it keeps happening, disconnect and reconnect Spotify in Settings → Integrations");
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"Forbidden"}}"#, None).text(), "Spotify refused that (HTTP 403): Forbidden. If it keeps happening, disconnect and reconnect Spotify in Settings → Integrations");
        assert!(forbidden_is_scope("/me/library", &ScopeVerdict::Stale));
        assert!(forbidden_is_scope("/playlists/x/items", &ScopeVerdict::Missing(vec!["user-library-read"])));
        assert!(!forbidden_is_scope("/me/player/play", &ScopeVerdict::Stale), "player 403s are device/premium issues");
        assert!(!forbidden_is_scope("/me/library", &ScopeVerdict::Ok));
        // Dev-mode allowlist: plain-text and JSON bodies.
        assert_eq!(api_error(403, "User not registered in the Developer Dashboard", None), ApiError::NotRegistered);
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"User not registered in the Developer Dashboard"}}"#, None), ApiError::NotRegistered);
        assert_eq!(ApiError::NotRegistered.text(), NOT_REGISTERED);
        // Rate limits and quota.
        assert_eq!(api_error(429, "", Some(7)), ApiError::RateLimited(Some(7)));
        assert_eq!(ApiError::RateLimited(Some(7)).text(), "Spotify is rate-limiting requests — try again in 7 seconds");
        assert_eq!(api_error(429, "", None).text(), "Spotify is rate-limiting requests — try again in a minute");
        assert_eq!(api_error(429, r#"{"error":{"status":429,"message":"Quota exceeded","reason":"QUOTA_EXCEEDED"}}"#, Some(3)), ApiError::Quota);
        assert_eq!(ApiError::Quota.text(), QUOTA);
        assert_eq!(ApiError::NoDevice.text(), NO_DEVICE);
    }

    #[test]
    fn restriction_stays_msg() {
        let e = api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Restriction violated","reason":"UNKNOWN"}}"#, None);
        let ApiError::Msg(m) = e else { panic!("expected Msg, got {e:?}") };
        assert!(m.contains("Restriction violated") && is_restriction(&m));
    }

    #[test]
    fn now_playing_mapped() {
        let v = json!({
            "is_playing": true, "progress_ms": 61000, "shuffle_state": true,
            "device": { "name": "DESKTOP", "volume_percent": 64 },
            "item": { "type": "track", "name": "Woke Up This Morning", "uri": "spotify:track:abc", "duration_ms": 245000,
                      "artists": [{ "name": "Alabama 3" }], "album": { "name": "Exile on Coldharbour Lane", "images": [{ "url": "https://i.scdn.co/image/x" }] } }
        });
        let n = parse_now_playing(&v);
        assert_eq!(n.track.as_deref(), Some("Woke Up This Morning"));
        assert_eq!(n.artists, ["Alabama 3"]);
        assert_eq!(n.art_url.as_deref(), Some("https://i.scdn.co/image/x"));
        assert_eq!((n.volume, n.shuffle, n.is_playing), (Some(64), true, true));
        let json = serde_json::to_value(&n).unwrap();
        assert!(json.get("artUrl").is_some() && json.get("progressMs").is_some() && json.get("isPlaying").is_some());
        assert_eq!(parse_now_playing(&Value::Null), NowPlaying::default());
        let ep = parse_now_playing(&json!({ "item": { "type": "episode", "name": "Ep 1", "show": { "name": "Talking Sopranos" }, "images": [{ "url": "u" }] } }));
        assert_eq!((ep.artists, ep.album, ep.art_url.as_deref()), (vec!["Talking Sopranos".to_string()], None, Some("u")));
    }

    #[test]
    fn lists_mapped() {
        let t = |uri: &str, name: &str| json!({ "track": { "uri": uri, "name": name, "artists": [{ "name": "A" }, { "name": "B" }], "album": { "images": [] } } });
        let recent = parse_recent(&json!({ "items": [t("spotify:track:1", "One"), t("spotify:track:1", "One"), t("spotify:track:2", "Two")] }));
        assert_eq!(recent.iter().map(|q| q.title.as_str()).collect::<Vec<_>>(), ["One", "Two"]);
        assert_eq!(recent[0].subtitle, "A, B");
        let pls = parse_playlists(&json!({ "items": [{ "uri": "spotify:playlist:p", "name": "Gym", "owner": { "display_name": "Nick" }, "images": [{ "url": "i" }] }, null] }));
        assert_eq!(pls, vec![QuickItem { uri: "spotify:playlist:p".into(), title: "Gym".into(), subtitle: "Nick".into(), art_url: Some("i".into()) }]);
    }

    #[test]
    fn widget_uris_and_bodies() {
        assert_eq!(uri_body("spotify:track:t"), json!({ "uris": ["spotify:track:t"] }));
        assert_eq!(uri_body("spotify:playlist:p"), json!({ "context_uri": "spotify:playlist:p" }));
        assert!(valid_uri("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"));
        assert!(valid_uri("spotify:user:nick:playlist:37i9dQZF1DXcBWIGoYBM5M"));
        assert!(!valid_uri("spotify:track:../../x"));
        assert!(!valid_uri("https://open.spotify.com/track/x"));
        assert!(matches!(uri_target("spotify:episode:0MondayHeadlinesAbcdef"), Target::Track { .. }));
        assert!(matches!(uri_target("spotify:artist:0GrooveTheoryArtistAbc"), Target::Context { kind: SearchKind::Artist, .. }));
    }

    #[test]
    fn volume_and_shuffle_targets() {
        assert_eq!(volume_target(None, Some(&json!(40))), Ok(40));
        assert_eq!(volume_target(None, Some(&json!(140))), Ok(100));
        assert_eq!(volume_target(None, Some(&json!("35%"))), Ok(35));
        assert_eq!(volume_target(Some(50), Some(&json!("+15"))), Ok(65));
        assert_eq!(volume_target(Some(10), Some(&json!("-15"))), Ok(0));
        assert_eq!(volume_target(None, Some(&json!("+10"))), Ok(60));
        assert!(volume_target(None, Some(&json!("loud"))).is_err());
        assert!(volume_target(None, None).is_err());
        assert_eq!(shuffle_target(true, None), Ok(false));
        assert_eq!(shuffle_target(false, Some(&json!("on"))), Ok(true));
        assert_eq!(shuffle_target(true, Some(&json!(false))), Ok(false));
    }

    #[test]
    fn already_paused_restriction_is_recognised() {
        let ApiError::Msg(m) = api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Restriction violated"}}"#, None) else { panic!("expected Msg") };
        assert!(is_restriction(&m));
        assert!(!is_restriction("Spotify playback control needs Premium"));
    }
}

/// WP-E: reply builders, planners and gates (pure, fixtures, no network).
#[cfg(test)]
mod suite_tests {
    use super::*;

    macro_rules! fixture {
        ($name:literal) => {
            serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/spotify/", $name))).expect($name)
        };
    }

    fn dev(id: &str, name: &str, active: bool) -> Device {
        Device { id: id.into(), name: name.into(), kind: "Computer".into(), is_active: active, is_restricted: false, is_private_session: false, supports_volume: true, volume_percent: Some(50) }
    }

    fn track(uri: &str, name: &str, artist: &str) -> TrackRef {
        TrackRef { uri: uri.into(), name: name.into(), artists: vec![artist.into()], album_uri: None, album_name: None, release_year: None, duration_ms: None, is_episode: false }
    }

    #[test]
    fn resume_on_the_active_device_is_already_playing() {
        let phone = dev("p1", "Pixel", true);
        let restriction = ApiError::Msg("Spotify error (HTTP 403): Player command failed: Restriction violated".into());
        let bodyless = Call::Play { device_id: Some("p1".into()), body: None };
        assert!(already_playing(&DeviceStep::Use(phone.clone()), &bodyless, &restriction));
        // New content, a woken device or another error stay failures.
        let with_body = Call::Play { device_id: Some("p1".into()), body: Some(json!({ "uris": [] })) };
        assert!(!already_playing(&DeviceStep::Use(phone.clone()), &with_body, &restriction));
        assert!(!already_playing(&DeviceStep::Wake(phone.clone()), &bodyless, &restriction));
        assert!(!already_playing(&DeviceStep::Use(phone), &bodyless, &ApiError::Premium));
    }

    #[test]
    fn search_failure_is_not_a_miss() {
        let base = create_reply("Road Trip", Visibility::Private, 1, &[]);
        assert_eq!(with_search_error(base.clone(), None), base);
        let r = with_search_error(base, Some("Spotify is rate-limiting requests — try again in 30 seconds"));
        assert_eq!(r, "Created your private playlist Road Trip with 1 song. I couldn't look up the other songs: Spotify is rate-limiting requests — try again in 30 seconds.");
        assert!(!r.contains("couldn't find"));
    }

    #[test]
    fn playlist_name_fallback_knows_ownership() {
        let v = json!({ "name": "Late Night", "owner": { "id": "nick" } });
        assert_eq!(playlist_name_from(&v, Some("nick")), Some(("Late Night".into(), true)));
        assert_eq!(playlist_name_from(&v, Some("someone")), Some(("Late Night".into(), false)));
        assert_eq!(playlist_name_from(&v, None), Some(("Late Night".into(), false)));
        assert_eq!(playlist_name_from(&json!({ "name": "X" }), Some("nick")), Some(("X".into(), false)));
        assert_eq!(playlist_name_from(&json!({ "name": "" }), Some("nick")), None);
    }

    #[test]
    fn play_reply_combinations() {
        let cases = [
            (None, false, false, "Playing your Late Night playlist on Spotify."),
            (None, false, true, "Opened Spotify. Playing your Late Night playlist on Spotify."),
            (None, true, false, "Shuffling your Late Night playlist on Spotify."),
            (None, true, true, "Opened Spotify. Shuffling your Late Night playlist on Spotify."),
            (Some("Kitchen Speaker"), false, false, "Playing your Late Night playlist on Kitchen Speaker."),
            (Some("Kitchen Speaker"), false, true, "Opened Spotify. Playing your Late Night playlist on Kitchen Speaker."),
            (Some("Kitchen Speaker"), true, false, "Shuffling your Late Night playlist on Kitchen Speaker."),
            (Some("Kitchen Speaker"), true, true, "Opened Spotify. Shuffling your Late Night playlist on Kitchen Speaker."),
        ];
        for (device, shuffle, launched, want) in cases {
            assert_eq!(play_reply("your Late Night playlist", TargetKind::OwnPlaylist, device, shuffle, launched), want);
        }
        assert_eq!(play_reply("Bilmuri", TargetKind::Artist, None, false, false), "Playing Bilmuri on Spotify.");
        assert_eq!(play_reply("Tell Me by Groove Theory", TargetKind::Track, None, false, false), "Playing Tell Me by Groove Theory on Spotify.");
        assert_eq!(play_reply("the album Hybrid Theory by Linkin Park", TargetKind::Album, None, false, false), "Playing the album Hybrid Theory by Linkin Park on Spotify.");
        assert_eq!(play_reply("the playlist Jazz Classics", TargetKind::Playlist, None, false, false), "Playing the playlist Jazz Classics on Spotify.");
        assert_eq!(play_reply("", TargetKind::Liked, None, false, false), "Playing your Liked Songs on Spotify.");
        // Labels come from the resolver's targets.
        let own = Target::Context { uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M".into(), label: "your Late Night playlist".into(), kind: SearchKind::Playlist };
        assert_eq!(target_label(&own), Some(("your Late Night playlist".into(), TargetKind::OwnPlaylist)));
        assert_eq!(target_label(&Target::Liked { user_id: "me".into() }).map(|l| l.1), Some(TargetKind::Liked));
        assert_eq!(target_label(&Target::NotFound), None);
    }

    #[test]
    fn not_ready_and_decisions() {
        assert_eq!(not_ready_reply(Some("Bilmuri")), "Opened Bilmuri in Spotify — press play if it doesn't start.");
        assert_eq!(not_ready_reply(None), "Spotify is opening but isn't ready yet — give it a few seconds and ask again.");
        assert_eq!(not_ready_reply(Some("")), LAUNCH_NOT_READY);
        // resolve_before_launch: Ask / Refuse / NotFound reply without any device call or launch.
        assert_eq!(play_decision(&Target::NotFound, "Zzz"), PlayDecision::Reply("I couldn't find \"Zzz\" on Spotify.".into()));
        assert_eq!(play_decision(&Target::Ask("Which?".into()), "x"), PlayDecision::Reply("Which?".into()));
        assert_eq!(play_decision(&Target::Refuse("No.".into()), "x"), PlayDecision::Reply("No.".into()));
        assert_eq!(play_decision(&Target::Track { uri: "spotify:track:x".into(), label: "x".into() }, "x"), PlayDecision::NeedDevice);
        assert_eq!(play_decision(&Target::Liked { user_id: "u".into() }, "x"), PlayDecision::NeedDevice);
        assert!(spotify_made("Discover Weekly") && spotify_made("my daily mix 2") && spotify_made("DJ"));
        assert!(!spotify_made("Late Night") && !spotify_made("djent classics"));
    }

    #[test]
    fn now_playing_text_on_fixtures() {
        let v = fixture!("currently_playing.json");
        let t = resolve::parse_track(&v["item"]).unwrap();
        assert_eq!(
            now_playing_text(&t, true, 95_000, Some(("Late Night", true)), Some(true)),
            "Now playing Tell Me by Groove Theory, from Groove Theory (1995) — 1:35 of 4:47, from your Late Night playlist. It's in your Liked Songs."
        );
        assert_eq!(
            now_playing_text(&t, false, 95_000, Some(("Jazz Classics", false)), Some(false)),
            "Paused on Tell Me by Groove Theory, from Groove Theory (1995) — 1:35 of 4:47, from the playlist Jazz Classics. It's not in your Liked Songs."
        );
        assert_eq!(now_playing_text(&t, true, 0, None, None), "Now playing Tell Me by Groove Theory, from Groove Theory (1995) — 0:00 of 4:47.");
        let e = fixture!("currently_playing_episode.json");
        let ep = resolve::parse_track(&e["item"]).unwrap();
        assert_eq!(now_playing_text(&ep, true, 600_000, None, Some(true)), "Now playing the episode Monday Headlines from The Daily Show Podcast — 10:00 of 30:00.");
    }

    #[test]
    fn queue_text_dedups_and_drops_current() {
        let v = fixture!("queue_padded.json");
        let cur = resolve::parse_track(&v["currently_playing"]);
        let q: Vec<TrackRef> = v["queue"].as_array().unwrap().iter().filter_map(resolve::parse_track).collect();
        assert_eq!(queue_text(cur.as_ref(), &q), "Now playing Tell Me by Groove Theory. Up next: Wet Paint by Bilmuri and Snowblood by Erra.");
        assert_eq!(queue_text(cur.as_ref(), &[]), "Nothing is queued after Tell Me.");
        assert_eq!(queue_text(None, &q), "Nothing is playing on Spotify right now.");
        let many: Vec<TrackRef> = (0..8).map(|i| track(&format!("spotify:track:{i}"), &format!("T{i}"), "A")).collect();
        assert_eq!(queue_text(cur.as_ref(), &many).matches(" by A").count(), 5, "five at most");
    }

    #[test]
    fn playlist_texts_on_fixtures() {
        let lists = resolve::parse_playlists_page(&fixture!("me_playlists_page.json"));
        assert_eq!(playlist_list_text(&lists), "You have 4 playlists: Late Night (12 songs), Late Night Drive (30 songs), Road Trip and Late Nite (3 songs).");
        assert_eq!(playlist_list_text(&[]), "You don't have any playlists yet.");
        let mut ten = lists.clone();
        ten.extend(lists.clone());
        ten.extend(lists[..2].to_vec());
        assert!(playlist_list_text(&ten).starts_with("You have 10 playlists: ") && playlist_list_text(&ten).ends_with(" and 2 more."), "{}", playlist_list_text(&ten));
        let mut one = lists[..1].to_vec();
        one[0].total = Some(1);
        assert_eq!(playlist_list_text(&one), "You have 1 playlist: Late Night (1 song).");

        let page = fixture!("playlist_items_page.json");
        let tracks: Vec<TrackRef> = page["items"].as_array().unwrap().iter().filter_map(resolve::parse_track).collect();
        assert_eq!(
            playlist_tracks_text("Late Night", Some(5), &tracks),
            "Late Night has 5 songs. First 3: Tell Me by Groove Theory, Smoke Signals by Phoebe Bridgers and A Podcast Episode by Some Show."
        );
        assert_eq!(playlist_tracks_text("Late Night", Some(3), &tracks), "Late Night has 3 songs: Tell Me by Groove Theory, Smoke Signals by Phoebe Bridgers and A Podcast Episode by Some Show.");
        assert_eq!(playlist_tracks_text("Empty", Some(0), &[]), "Empty is empty.");
        // Dup check reads `item`, then the legacy `track`, null-safely.
        assert!(contains_uri(std::slice::from_ref(&page), "spotify:track:1TellMeGrooveTheoryAbc"));
        assert!(contains_uri(std::slice::from_ref(&page), "spotify:track:0SmokeSignalsAbcdefghi"));
        assert!(!contains_uri(std::slice::from_ref(&page), "spotify:track:0WetPaintBilmuriAbcdefg"));
        assert!(!contains_uri(&[Value::Null, json!({ "items": null })], "spotify:track:x"));
    }

    #[test]
    fn top_recent_create_transfer_seek() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(top_text("artists", "short_term", &names(&["Bilmuri", "Erra", "Groove Theory"])), "Your top artists lately: Bilmuri, Erra and Groove Theory.");
        assert_eq!(top_text("tracks", "medium_term", &names(&["Tell Me by Groove Theory"])), "Your top songs over the last six months: Tell Me by Groove Theory.");
        assert_eq!(top_text("tracks", "long_term", &names(&["A", "B"])), "Your top songs over the past year: A and B.");
        assert_eq!(top_text("artists", "short_term", &[]), "Spotify doesn't have enough listening history for that yet.");

        let a = track("spotify:track:a", "One", "X");
        let b = track("spotify:track:b", "Two", "Y");
        assert_eq!(recent_text(&[a.clone(), a.clone(), b.clone(), a.clone()]), "You recently played: One by X, Two by Y and One by X.");
        assert_eq!(recent_text(&[]), "You haven't played anything on Spotify lately.");

        assert_eq!(create_reply("Road Trip", Visibility::Private, 0, &[]), "Created your private playlist Road Trip.");
        assert_eq!(create_reply("Road Trip", Visibility::Public, 0, &[]), "Created your public playlist Road Trip.");
        assert_eq!(create_reply("Tony test (delete me)", Visibility::Private, 1, &[]), "Created your private playlist Tony test (delete me) with 1 song.");
        assert_eq!(create_reply("Road Trip", Visibility::Private, 2, &names(&["Zzz"])), "Created your private playlist Road Trip with 2 songs. I couldn't find \"Zzz\".");
        assert_eq!(create_reply("R", Visibility::Private, 0, &names(&["a", "b", "c"])).matches("I couldn't find").count(), 2, "max 2 misses listed");
        // Spotify may ignore `public: false`: never claim "private" unless it says so.
        assert_eq!(create_reply("Road Trip", Visibility::Unknown, 1, &[]), "Created your playlist Road Trip with 1 song.");
        assert_eq!(
            create_reply("Road Trip", Visibility::ForcedPublic, 1, &names(&["Zzz"])),
            format!("Created your playlist Road Trip with 1 song. I couldn't find \"Zzz\". {FORCED_PUBLIC}")
        );
        assert_eq!(visibility_from(false, Some(false)), Visibility::Private);
        assert_eq!(visibility_from(false, Some(true)), Visibility::ForcedPublic);
        assert_eq!(visibility_from(false, None), Visibility::Unknown);
        assert_eq!(visibility_from(true, Some(false)), Visibility::Public);

        // A just-started device may report nothing for a few seconds.
        assert_eq!(settle_wait(None), Duration::ZERO);
        assert_eq!(settle_wait(Some(Duration::from_secs(1))), SETTLE_MAX_WAIT);
        assert_eq!(settle_wait(Some(Duration::from_secs(8))), Duration::from_secs(2));
        assert_eq!(settle_wait(Some(Duration::from_secs(10))), Duration::ZERO);
        assert_eq!(settle_wait(Some(Duration::from_secs(60))), Duration::ZERO);

        assert_eq!(transfer_reply(&DeviceStep::Wake(dev("1", "Kitchen Speaker", false)), "kitchen"), "Moved Spotify to Kitchen Speaker.");
        assert_eq!(transfer_reply(&DeviceStep::NotFound { wanted: "my tv".into(), available: names(&["DESKTOP", "Pixel", "Echo"]) }, "my tv"), "I can't see a Spotify device called \"my tv\". Available: DESKTOP, Pixel and Echo.");
        assert_eq!(transfer_reply(&DeviceStep::NotFound { wanted: "my tv".into(), available: vec![] }, "my tv"), "No Spotify devices are available right now.");
        assert_eq!(transfer_reply(&DeviceStep::Ambiguous(dev("1", "Pixel", false), dev("2", "iPhone", false)), "my phone"), "Which one — Pixel or iPhone?");
        assert_eq!(step_error(&DeviceStep::OnlyRestricted, None), ONLY_RESTRICTED);
        assert_eq!(step_error(&DeviceStep::Empty, None), NO_DEVICE);

        assert_eq!(seek_reply(Some(90), None), "Jumped to 1:30.");
        assert_eq!(seek_reply(None, Some(30)), "Skipped ahead 30 seconds.");
        assert_eq!(seek_reply(None, Some(-15)), "Went back 15 seconds.");
        assert_eq!(seek_target(60_000, Some(200_000), Some(90), None), 90_000);
        assert_eq!(seek_target(60_000, Some(200_000), None, Some(-90)), 0);
        assert_eq!(seek_target(195_000, Some(200_000), None, Some(30)), 199_000, "never past the end");
        assert_eq!(seek_target(10_000, None, None, Some(30)), 40_000);
        assert_eq!(track_label(&track("spotify:track:a", "Song - 2011 Remaster", "Band")), "Song by Band");
    }

    #[test]
    fn no_reply_leaks_ids() {
        let id = regex::Regex::new(r"\b[0-9A-Za-z]{22}\b").unwrap();
        let cp = fixture!("currently_playing.json");
        let ep = fixture!("currently_playing_episode.json");
        let q = fixture!("queue_padded.json");
        let lists = resolve::parse_playlists_page(&fixture!("me_playlists_page.json"));
        let page = fixture!("playlist_items_page.json");
        let tracks: Vec<TrackRef> = page["items"].as_array().unwrap().iter().filter_map(resolve::parse_track).collect();
        let qt: Vec<TrackRef> = q["queue"].as_array().unwrap().iter().filter_map(resolve::parse_track).collect();
        let t = resolve::parse_track(&cp["item"]).unwrap();
        let outs = [
            now_playing_text(&t, true, 1000, Some(("Late Night", true)), Some(true)),
            now_playing_text(&resolve::parse_track(&ep["item"]).unwrap(), false, 0, None, None),
            queue_text(resolve::parse_track(&q["currently_playing"]).as_ref(), &qt),
            playlist_list_text(&lists),
            playlist_tracks_text("Late Night", Some(5), &tracks),
            recent_text(&tracks),
            top_text("tracks", "short_term", &tracks.iter().map(track_label).collect::<Vec<_>>()),
            create_reply("Road Trip", Visibility::Private, 3, &["Zzz".to_string()]),
            transfer_reply(&DeviceStep::Use(dev("5ABHKGoOzxkaa28ttQV9sE", "DESKTOP", true)), "this pc"),
            play_reply(&target_label(&resolve::choose(&resolve::plan_searches(&PlayRequest { query: "Bilmuri".into(), kind: None, my: false, prefer_playlist: false, liked: false })[0], &fixture!("search_bilmuri.json"))).unwrap().0, TargetKind::Artist, None, false, false),
            not_ready_reply(Some("Bilmuri")),
            seek_reply(Some(90), None),
            NOTHING_PLAYING_FOR_TRACK.to_string(),
            RUST_RECONNECT.to_string(),
        ];
        for o in outs {
            assert!(!o.contains("spotify:") && !id.is_match(&o) && !o.contains('{'), "{o}");
        }
    }

    #[test]
    fn play_steps_per_device_step() {
        let body = json!({ "context_uri": "spotify:artist:0GrooveTheoryArtistAbc" });
        let d = dev("dev1", "DESKTOP", true);
        // Use: play on it (with or without a body).
        assert_eq!(play_steps(&DeviceStep::Use(d.clone()), Some(&body), None), vec![Call::Play { device_id: Some("dev1".into()), body: Some(body.clone()) }]);
        assert_eq!(play_steps(&DeviceStep::Use(d.clone()), None, None), vec![Call::Play { device_id: Some("dev1".into()), body: None }]);
        // Wake: new content plays there; resume / transfer moves playback.
        assert_eq!(play_steps(&DeviceStep::Wake(d.clone()), Some(&body), None), vec![Call::Play { device_id: Some("dev1".into()), body: Some(body.clone()) }]);
        assert_eq!(play_steps(&DeviceStep::Wake(d.clone()), None, None), vec![Call::Transfer { device_id: "dev1".into(), play: true }]);
        // Shuffle: play, 400 ms, shuffle on that device.
        assert_eq!(
            play_steps(&DeviceStep::Use(d.clone()), Some(&body), Some(true)),
            vec![Call::Play { device_id: Some("dev1".into()), body: Some(body.clone()) }, Call::Sleep(400), Call::Shuffle { state: true, device_id: Some("dev1".into()) }]
        );
        assert_eq!(play_steps(&DeviceStep::Wake(d.clone()), None, Some(false)).len(), 3);
        for other in [DeviceStep::Launch, DeviceStep::Empty, DeviceStep::OnlyRestricted, DeviceStep::Ambiguous(d.clone(), d.clone()), DeviceStep::NotFound { wanted: "x".into(), available: vec![] }] {
            assert!(play_steps(&other, Some(&body), Some(true)).is_empty(), "{other:?}");
        }
        assert_eq!(retry_steps("dev1", Some(&body)), vec![Call::Transfer { device_id: "dev1".into(), play: false }, Call::Sleep(400), Call::Play { device_id: Some("dev1".into()), body: Some(body.clone()) }]);
    }

    #[test]
    fn shuffle_offset_only_for_playlists_and_albums() {
        let pl = json!({ "context_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M" });
        for r in [0, 7, 11, 12, 1000] {
            let pos = with_shuffle_offset(pl.clone(), Some(12), r)["offset"]["position"].as_u64().unwrap();
            assert!(pos < 12, "{pos}");
        }
        let album = json!({ "context_uri": "spotify:album:2AbCdEfGhIjKlMnOpQrStU" });
        assert!(with_shuffle_offset(album, Some(9), 4)["offset"]["position"] == 4);
        // Untouched: artist contexts, tracks, unknown / tiny totals, an existing offset.
        let artist = json!({ "context_uri": "spotify:artist:0GrooveTheoryArtistAbc" });
        assert_eq!(with_shuffle_offset(artist.clone(), Some(50), 3), artist);
        let tr = json!({ "uris": ["spotify:track:1TellMeGrooveTheoryAbc"] });
        assert_eq!(with_shuffle_offset(tr.clone(), Some(50), 3), tr);
        assert_eq!(with_shuffle_offset(pl.clone(), None, 3), pl);
        assert_eq!(with_shuffle_offset(pl.clone(), Some(1), 3), pl);
        let at = json!({ "context_uri": "spotify:album:2AbCdEfGhIjKlMnOpQrStU", "offset": { "uri": "spotify:track:1TellMeGrooveTheoryAbc" } });
        assert_eq!(with_shuffle_offset(at.clone(), Some(10), 3), at);
    }

    #[test]
    fn spotify_tool_gate_order() {
        use super::super::os_core::McpServer;
        let mut cfg = OsConfig::default();
        assert_eq!(tool_precheck(&cfg, "spotify.nope"), Err("unknown Spotify tool".into()));
        assert_eq!(tool_precheck(&cfg, "spotify.pause"), Err(SERVER_OFF.into()), "no spotify server configured");
        cfg.mcps = vec![McpServer { id: "spotify".into(), name: "Spotify".into(), transport: "builtin".into(), enabled: false, ..Default::default() }];
        assert_eq!(tool_precheck(&cfg, "spotify.now_playing"), Err(SERVER_OFF.into()));
        cfg.mcps[0].enabled = true;
        assert_eq!(tool_precheck(&cfg, "spotify.pause"), Ok(()));
        cfg.mcps[0].read_only = true;
        assert_eq!(tool_precheck(&cfg, "spotify.like_track"), Err(SERVER_READ_ONLY.into()));
        assert_eq!(tool_precheck(&cfg, "spotify.now_playing"), Ok(()), "reads still work");
        cfg.privacy.kill_switch = true;
        assert!(tool_precheck(&cfg, "spotify.now_playing").unwrap_err().contains("kill switch"));
        assert_eq!(tool_precheck(&cfg, "spotify.nope"), Err("unknown Spotify tool".into()), "unknown name is checked first");
    }

    #[test]
    fn created_playlists_survive_a_lagging_refetch() {
        let lists = resolve::parse_playlists_page(&fixture!("me_playlists_page.json"));
        let new = PlaylistRef { id: "0NewPlaylistAbcdefghij".into(), uri: "spotify:playlist:0NewPlaylistAbcdefghij".into(), name: "Tony test (delete me)".into(), owner_id: "me_user".into(), collaborative: false, total: Some(0), snapshot_id: None };
        let merged = merge_created(lists.clone(), &[(1000, new.clone())], 1100);
        assert_eq!(merged[0], new);
        assert_eq!(merged.len(), lists.len() + 1);
        assert_eq!(merge_created(lists.clone(), &[(1000, new.clone())], 1000 + CREATED_KEEP_SECS).len(), lists.len(), "expired");
        let mut listed = lists.clone();
        listed.push(new.clone());
        assert_eq!(merge_created(listed.clone(), &[(1000, new)], 1100).len(), listed.len(), "no duplicate once Spotify lists it");
        assert!(playlist_path("37i9dQZF1DXcBWIGoYBM5M", "/items").is_ok());
        assert!(playlist_path("../me", "/items").is_err() && playlist_path("", "").is_err());
    }

    #[test]
    fn join_list_shapes() {
        let s = |v: &[&str]| join_list(&v.iter().map(|x| x.to_string()).collect::<Vec<_>>());
        assert_eq!(s(&[]), "");
        assert_eq!(s(&["A"]), "A");
        assert_eq!(s(&["A", "B"]), "A and B");
        assert_eq!(s(&["A", "B", "C", "D"]), "A, B, C and D");
    }
}

/// Live checks against the real Spotify account. Never run by default; they never print tokens.
/// Reconnect first (consent with the 18 scopes). All at once, in order (numbered so libtest sorts them):
///   cargo test --lib live_spotify_ -- --ignored --nocapture --test-threads=1
/// or one at a time:
///   cargo test --lib live_spotify_1_scopes -- --ignored --nocapture
///   cargo test --lib live_spotify_2_play -- --ignored --nocapture
///   cargo test --lib live_spotify_3_now_playing -- --ignored --nocapture
///   cargo test --lib live_spotify_4_create_playlist -- --ignored --nocapture
///   cargo test --lib live_spotify_5_add_to_playlist -- --ignored --nocapture
///   cargo test --lib live_spotify_6_cleanup_test_playlist -- --ignored --nocapture
/// (`live_spotify_5_add_to_playlist` passes `create: true`, so it also works on its own.) They call
/// `tool()` directly (no MCP gate). Spotify has no delete-playlist endpoint: cleanup unfollows.
#[cfg(test)]
mod live {
    use super::*;

    const TEST_PLAYLIST: &str = "Tony test (delete me)";

    fn env() -> (DispatchState, OsState) {
        let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let state = DispatchState::default();
        state.load_or_init(&dir);
        let os = OsState::default();
        os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
        (state, os)
    }

    /// No URI, no 22-char id, no JSON in anything spoken.
    fn clean(reply: &str) {
        let id = regex::Regex::new(r"\b[0-9A-Za-z]{22}\b").unwrap();
        assert!(!reply.contains("spotify:") && !id.is_match(reply) && !reply.contains('{'), "reply leaks an id: {reply}");
    }

    fn call(state: &DispatchState, os: &OsState, name: &str, args: Value) -> String {
        let out = tauri::async_runtime::block_on(tool(state, os, name, &args));
        let reply = match out {
            Ok(r) => r,
            Err(e) => {
                clean(&e);
                panic!("{name} failed: {e}");
            }
        };
        println!("{name}: {reply}");
        clean(&reply);
        reply
    }

    #[test]
    #[ignore]
    fn live_spotify_1_scopes() {
        let _ = env();
        let granted = effective_scope();
        let grant = load_grant();
        let all_core: Vec<&str> = core_scopes().collect();
        let missing = missing_core(&all_core, granted.as_deref());
        println!("granted scopes known: {}", granted.is_some());
        println!("missing core scopes: {missing:?}");
        println!("verdict: {:?}", scope_verdict(granted.as_deref(), grant.requested.as_deref()));
        assert!(granted.is_some(), "no granted scope recorded — reconnect Spotify first");
        assert!(missing.is_empty() && covers_core(granted.as_deref()), "missing core scopes: {missing:?}");
        assert_eq!(scope_verdict(granted.as_deref(), grant.requested.as_deref()), ScopeVerdict::Ok);
    }

    #[test]
    #[ignore]
    fn live_spotify_2_play() {
        let (state, os) = env();
        let q = std::env::var("SPOTIFY_LIVE_QUERY").unwrap_or_else(|_| "Bilmuri".into());
        let r = call(&state, &os, "spotify.play", json!({ "query": q }));
        assert!(r.starts_with("Playing") || r.starts_with("Opened Spotify"), "{r}");
        std::thread::sleep(Duration::from_secs(3));
        let np = call(&state, &os, "spotify.now_playing", json!({}));
        assert!(np.contains(" by ") || np.contains("the episode"), "{np}");
    }

    #[test]
    #[ignore]
    fn live_spotify_3_now_playing() {
        let (state, os) = env();
        let r = call(&state, &os, "spotify.now_playing", json!({}));
        assert!(r.starts_with("Now playing") || r.starts_with("Paused on") || r.starts_with("Nothing is playing"), "{r}");
    }

    #[test]
    #[ignore]
    fn live_spotify_4_create_playlist() {
        let (state, os) = env();
        let r = call(&state, &os, "spotify.create_playlist", json!({ "name": TEST_PLAYLIST, "public": false, "initial_queries": ["Tell Me by Groove Theory"] }));
        let claims_private = r == format!("Created your private playlist {TEST_PLAYLIST} with {}.", resolve::plural(1, "song"));
        let says_forced = r == format!("Created your playlist {TEST_PLAYLIST} with {}. {FORCED_PUBLIC}", resolve::plural(1, "song"));
        assert!(claims_private || says_forced || r == format!("Created your playlist {TEST_PLAYLIST} with {}.", resolve::plural(1, "song")), "{r}");
        // Spotify's own view must match what Tony said (Spotify may ignore `public: false`).
        tauri::async_runtime::block_on(async {
            let me = ensure_account(&state).await.expect("account id");
            let v = get(&state, "/me/playlists", &[("limit", "50".into())]).await.expect("list playlists");
            let found: Vec<&Value> = v["items"].as_array().into_iter().flatten().filter(|p| p["name"] == TEST_PLAYLIST && p["owner"]["id"] == me.as_str()).collect();
            println!("listed by /me/playlists: {} (it can lag a few seconds)", found.len());
            for p in &found {
                println!("listed public={}", p["public"]);
                if claims_private {
                    assert_eq!(p["public"].as_bool(), Some(false), "Tony said private but Spotify lists it public");
                }
            }
        });
    }

    #[test]
    #[ignore]
    fn live_spotify_5_add_to_playlist() {
        let (state, os) = env();
        let args = json!({ "playlist_name": TEST_PLAYLIST, "track_query": "Bill Murray", "create": true });
        let first = call(&state, &os, "spotify.add_to_playlist", args.clone());
        assert!(
            (first.starts_with("Added ") && first.ends_with(&format!(" to your {TEST_PLAYLIST} playlist."))) || first.starts_with(&format!("Created your {TEST_PLAYLIST} playlist and added ")),
            "{first}"
        );
        let second = call(&state, &os, "spotify.add_to_playlist", args);
        assert!(second.ends_with(&format!(" is already in your {TEST_PLAYLIST} playlist.")), "{second}");
    }

    #[test]
    #[ignore]
    fn live_spotify_6_cleanup_test_playlist() {
        let (state, _os) = env();
        tauri::async_runtime::block_on(async {
            let me = ensure_account(&state).await.expect("account id");
            let lists = playlists_cached(&state, true).await.expect("list playlists");
            let mine: Vec<PlaylistRef> = lists.into_iter().filter(|p| p.name == TEST_PLAYLIST && p.owner_id == me).collect();
            println!("test playlists found: {}", mine.len());
            for (n, p) in mine.iter().enumerate() {
                let library = send(&state, reqwest::Method::DELETE, "/me/library", &[("uris", p.uri.clone())], None).await;
                if library.is_ok() {
                    println!("#{}: unfollowed via DELETE /me/library", n + 1);
                    continue;
                }
                let followers = match playlist_path(&p.id, "/followers") {
                    Ok(path) => send(&state, reqwest::Method::DELETE, &path, &[], None).await.map(|_| ()).map_err(ApiError::text),
                    Err(e) => Err(e),
                };
                match followers {
                    Ok(()) => println!("#{}: unfollowed via DELETE /playlists/{{id}}/followers", n + 1),
                    Err(e) => println!("#{}: both unfollow calls failed ({}) — remove it by hand in the Spotify app", n + 1, problem_kind(&e)),
                }
            }
            println!("Spotify has no delete-playlist endpoint: unfollowing only removes it from your library.");
            clear_playlist_cache();
        });
    }
}
