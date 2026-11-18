//! Spotify through its Web API, called from Rust only.
//!
//! Auth is Authorization Code + PKCE against the redirect URI registered with
//! Spotify (`SPOTIFY_REDIRECT_URI`, normally `http://127.0.0.1:1420/callback`).
//! The callback is caught by a one-shot listener on that address; in `tauri dev`
//! Vite already owns :1420, so Vite proxies `/callback` to the gateway
//! (`/api/spotify/callback`) and Rust polls `/api/spotify/pending` instead.
//!
//! Client id / secret come from the env or the repo `.env`; the refresh token
//! lives in the keychain (`spotify-refresh`); the access token only in memory.
//! None of them reach the webview, logs or error strings.

use serde::Serialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::bridge::{BridgeState, Tier};
use super::dispatch::{short, DispatchState};
use super::envfile::env_or_file;
use super::os_core::{self, OsState};

const API: &str = "https://api.spotify.com/v1";
const ACCOUNTS: &str = "https://accounts.spotify.com";
const SCOPES: &str = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played playlist-read-private playlist-read-collaborative";
const SECRET_REFRESH: &str = "spotify-refresh";
const DEFAULT_REDIRECT: &str = "http://127.0.0.1:1420/callback";
const AUTH_WAIT: Duration = Duration::from_secs(180);

pub(crate) const NOT_CONFIGURED: &str = "Spotify isn't set up — add SPOTIFY_CLIENT_ID (and SPOTIFY_CLIENT_SECRET) to the repo .env";
pub(crate) const NOT_CONNECTED: &str = "Spotify isn't connected — connect it in Settings → Integrations";
const NO_DEVICE: &str = "Open Spotify on this PC or your phone first";
const PREMIUM: &str = "Spotify playback control needs Premium";
const OWNER_PREMIUM: &str = "Spotify is blocking this app: the Spotify account that owns it in the Developer Dashboard needs an active Premium subscription (Spotify's rule for development-mode apps; it can take a few hours to clear after subscribing). Reconnecting won't help";
const KILL_SWITCH: &str = "kill switch is on — Spotify is a cloud service";

struct Access {
    token: String,
    expires: Instant,
}

static ACCESS: tokio::sync::Mutex<Option<Access>> = tokio::sync::Mutex::const_new(None);
static ACCOUNT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static FLOW: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = std::sync::Mutex::new(None);

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

/// Why the `spotify` builtin can't serve tools right now, if so.
pub(crate) fn readiness(state: &DispatchState) -> Result<(), String> {
    config(state)?;
    os_core::os_secret(SECRET_REFRESH).map(|_| ()).ok_or_else(|| NOT_CONNECTED.into())
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

fn authorize_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> String {
    url::Url::parse_with_params(
        &format!("{ACCOUNTS}/authorize"),
        &[("client_id", client_id), ("response_type", "code"), ("redirect_uri", redirect), ("code_challenge_method", "S256"), ("code_challenge", challenge), ("state", state), ("scope", SCOPES)],
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

/// Serve the redirect on `listener` until the request carrying `expected` state arrives.
async fn listen_once(listener: tokio::net::TcpListener, path: &str, expected: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| format!("Spotify callback listener failed: {e}"))?;
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
            Callback::Denied { error, state } if state == expected => (html_reply("200 OK", "Spotify wasn't connected — you can close this tab."), Some(Err(denied_message(&error)))),
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
async fn poll_gateway(state: &DispatchState, os: &OsState, expected: &str) -> Result<String, String> {
    let url = format!("{}/api/spotify/pending", state.snapshot().gateway.url.trim_end_matches('/'));
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
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
            return Err(denied_message(e));
        }
    }
}

// ── Tokens ──────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
struct TokenReply {
    access: String,
    expires_in: u64,
    refresh: Option<String>,
}

fn parse_token_reply(status: u16, body: &str) -> Result<TokenReply, String> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let code = v["error"].as_str().unwrap_or("");
        return Err(match code {
            "invalid_grant" => "Spotify access was revoked or expired — connect it again in Settings → Integrations".into(),
            "invalid_client" => "Spotify rejected the app credentials — check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in the repo .env".into(),
            _ => {
                let d = v["error_description"].as_str().unwrap_or(code);
                format!("Spotify sign-in failed (HTTP {status}){}", if d.is_empty() { String::new() } else { format!(": {}", d.chars().take(200).collect::<String>()) })
            }
        });
    }
    let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("Spotify returned no access token")?.to_string();
    Ok(TokenReply { access, expires_in: v["expires_in"].as_u64().unwrap_or(3600), refresh: v["refresh_token"].as_str().filter(|s| !s.is_empty()).map(String::from) })
}

async fn token_request(state: &DispatchState, cfg: &Config, params: &[(&str, &str)]) -> Result<TokenReply, String> {
    let mut form: Vec<(&str, &str)> = params.to_vec();
    form.push(("client_id", &cfg.client_id));
    let mut rb = state.http.post(format!("{ACCOUNTS}/api/token")).form(&form).timeout(Duration::from_secs(8));
    if let Some(secret) = &cfg.secret {
        rb = rb.basic_auth(&cfg.client_id, Some(secret));
    }
    let r = rb.send().await.map_err(|e| format!("Spotify sign-in {}", short(e)))?;
    let status = r.status().as_u16();
    parse_token_reply(status, &r.text().await.unwrap_or_default())
}

fn remember(slot: &mut Option<Access>, t: &TokenReply) {
    *slot = Some(Access { token: t.access.clone(), expires: Instant::now() + Duration::from_secs(t.expires_in) });
}

async fn access_token(state: &DispatchState, force_refresh: bool) -> Result<String, String> {
    let mut slot = ACCESS.lock().await;
    if let Some(a) = slot.as_ref().filter(|a| !force_refresh && a.expires > Instant::now() + Duration::from_secs(60)) {
        return Ok(a.token.clone());
    }
    let cfg = config(state)?;
    let refresh = os_core::os_secret(SECRET_REFRESH).ok_or(NOT_CONNECTED)?;
    let t = match token_request(state, &cfg, &[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await {
        Ok(t) => t,
        Err(e) => {
            if e.starts_with("Spotify access was revoked") {
                let _ = os_core::os_secret_clear(SECRET_REFRESH);
                *ACCOUNT.lock().unwrap() = None;
            }
            *slot = None;
            return Err(e);
        }
    };
    if let Some(r) = t.refresh.as_deref().filter(|r| *r != refresh) {
        os_core::os_secret_store(SECRET_REFRESH, r)?;
    }
    remember(&mut slot, &t);
    Ok(t.access)
}

async fn exchange(state: &DispatchState, code: &str, verifier: &str) -> Result<(), String> {
    let cfg = config(state)?;
    let t = token_request(state, &cfg, &[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", &cfg.redirect), ("code_verifier", verifier)]).await?;
    let refresh = t.refresh.as_deref().ok_or("Spotify returned no refresh token")?;
    os_core::os_secret_store(SECRET_REFRESH, refresh)?;
    remember(&mut *ACCESS.lock().await, &t);
    Ok(())
}

// ── Web API ─────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum ApiError {
    NoDevice,
    Msg(String),
}

impl From<String> for ApiError {
    fn from(s: String) -> Self {
        ApiError::Msg(s)
    }
}

impl ApiError {
    fn text(self) -> String {
        match self {
            ApiError::NoDevice => NO_DEVICE.into(),
            ApiError::Msg(m) => m,
        }
    }
}

fn api_error(status: u16, body: &str) -> ApiError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let reason = v["error"]["reason"].as_str().unwrap_or("");
    let msg: String = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).unwrap_or("").chars().take(200).collect();
    match status {
        404 if reason == "NO_ACTIVE_DEVICE" || msg.to_ascii_lowercase().contains("no active device") => ApiError::NoDevice,
        // Development-mode apps: Spotify refuses EVERY call (even /me) unless the account that
        // owns the app in the Developer Dashboard has Premium. Not fixable by reconnecting.
        403 if msg.to_ascii_lowercase().contains("owner of the app") => ApiError::Msg(OWNER_PREMIUM.into()),
        403 if reason == "PREMIUM_REQUIRED" || msg.contains("Premium") => ApiError::Msg(PREMIUM.into()),
        401 => ApiError::Msg("Spotify session expired — connect it again in Settings → Integrations".into()),
        429 => ApiError::Msg("Spotify is rate-limiting requests — try again in a minute".into()),
        _ if msg.is_empty() => ApiError::Msg(format!("Spotify error (HTTP {status})")),
        _ => ApiError::Msg(format!("Spotify error (HTTP {status}): {msg}")),
    }
}

/// One Web API call; 2xx → its JSON (Null for 204/empty). Retries once on 401 with a fresh token.
async fn send(state: &DispatchState, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, ApiError> {
    for attempt in 0..2 {
        let token = access_token(state, attempt == 1).await?;
        let mut rb = state.http.request(method.clone(), format!("{API}{path}")).bearer_auth(token).timeout(Duration::from_secs(8));
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
        if status == 401 && attempt == 0 {
            continue;
        }
        let text = r.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(api_error(status, &text));
        }
        return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
    }
    Err(api_error(401, ""))
}

async fn get(state: &DispatchState, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    send(state, reqwest::Method::GET, path, query, None).await.map_err(ApiError::text)
}

/// Device to wake when nothing is active: the active one, else the first unrestricted one.
fn pick_device(devices: &Value) -> Option<String> {
    let list: Vec<&Value> = devices["devices"].as_array().into_iter().flatten().filter(|d| d["is_restricted"].as_bool() != Some(true) && d["id"].is_string()).collect();
    list.iter().find(|d| d["is_active"].as_bool() == Some(true)).or_else(|| list.first()).and_then(|d| d["id"].as_str()).map(String::from)
}

/// A player command; with no active device, transfer playback to one and retry once.
async fn player(state: &DispatchState, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<(), String> {
    match send(state, method.clone(), path, query, body).await {
        Ok(_) => Ok(()),
        Err(ApiError::NoDevice) => {
            let id = pick_device(&get(state, "/me/player/devices", &[]).await?).ok_or(NO_DEVICE)?;
            send(state, reqwest::Method::PUT, "/me/player", &[], Some(&json!({ "device_ids": [id], "play": false }))).await.map_err(ApiError::text)?;
            let mut q = query.to_vec();
            q.push(("device_id", id));
            send(state, method, path, &q, body).await.map(|_| ()).map_err(ApiError::text)
        }
        Err(e) => Err(e.text()),
    }
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

fn describe(n: &NowPlaying) -> String {
    let Some(track) = &n.track else {
        return "Nothing is playing on Spotify right now.".into();
    };
    let mut s = format!("{}: \"{track}\"", if n.is_playing { "Now playing" } else { "Paused" });
    if !n.artists.is_empty() {
        s.push_str(&format!(" by {}", n.artists.join(", ")));
    }
    if let Some(album) = &n.album {
        s.push_str(&format!(" (album \"{album}\")"));
    }
    s.push_str(&format!(" — {} / {}", mmss(n.progress_ms), mmss(n.duration_ms)));
    if let Some(d) = &n.device {
        s.push_str(&format!(", on {d}"));
    }
    if let Some(v) = n.volume {
        s.push_str(&format!(", volume {v}%"));
    }
    s.push('.');
    s
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

fn list_text(heading: &str, items: &[QuickItem]) -> String {
    if items.is_empty() {
        return format!("{heading}: none.");
    }
    let lines: Vec<String> = items.iter().enumerate().map(|(i, q)| if q.subtitle.is_empty() { format!("{}. {}", i + 1, q.title) } else { format!("{}. {} — {}", i + 1, q.title, q.subtitle) }).collect();
    format!("{heading}:\n{}", lines.join("\n"))
}

const KINDS: [&str; 4] = ["track", "artist", "album", "playlist"];

/// First search hit of `kind` → (uri, spoken label).
fn pick_search(kind: &str, v: &Value) -> Option<(String, String)> {
    let item = v[format!("{kind}s")]["items"].as_array()?.iter().find(|i| i["uri"].is_string())?;
    let uri = item["uri"].as_str()?.to_string();
    let name = item["name"].as_str().unwrap_or("?");
    let label = match kind {
        "track" | "album" => {
            let by = names(&item["artists"]);
            if by.is_empty() {
                format!("\"{name}\"")
            } else {
                format!("\"{name}\" by {}", by.join(", "))
            }
        }
        "playlist" => format!("the playlist \"{name}\""),
        _ => name.to_string(),
    };
    Some((uri, label))
}

fn play_body(uri: &str) -> Value {
    if uri.starts_with("spotify:track:") || uri.starts_with("spotify:episode:") {
        json!({ "uris": [uri] })
    } else {
        json!({ "context_uri": uri })
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

async fn play_query(state: &DispatchState, query: &str, kind: Option<&str>) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("tell me what to play".into());
    }
    let kind = kind.map(str::trim).filter(|k| !k.is_empty()).unwrap_or("track");
    if !KINDS.contains(&kind) {
        return Err("kind must be track, artist, album or playlist".into());
    }
    let found = get(state, "/search", &[("q", query.into()), ("type", kind.into()), ("limit", "1".into()), ("market", "from_token".into())]).await?;
    let (uri, label) = pick_search(kind, &found).ok_or_else(|| format!("Spotify found no {kind} for \"{query}\""))?;
    player(state, reqwest::Method::PUT, "/me/player/play", &[], Some(&play_body(&uri))).await?;
    Ok(format!("Playing {label} on Spotify."))
}

async fn play_uri(state: &DispatchState, uri: &str) -> Result<String, String> {
    let uri = uri.trim();
    if !valid_uri(uri) {
        return Err("that isn't a Spotify URI".into());
    }
    player(state, reqwest::Method::PUT, "/me/player/play", &[], Some(&play_body(uri))).await?;
    Ok("Playing on Spotify.".into())
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

async fn control(state: &DispatchState, action: &str, value: Option<&Value>) -> Result<String, String> {
    use reqwest::Method;
    match action {
        // Spotify answers 403 "Restriction violated" to pausing a paused player (or resuming a
        // playing one) — a no-op request, not an error worth reading out.
        "play" | "resume" => match player(state, Method::PUT, "/me/player/play", &[], None).await {
            Ok(()) => Ok("Resumed Spotify.".into()),
            Err(e) if is_restriction(&e) => Ok("Spotify is already playing.".into()),
            Err(e) => Err(e),
        },
        "pause" => match send(state, Method::PUT, "/me/player/pause", &[], None).await {
            Ok(_) => Ok("Paused Spotify.".into()),
            Err(ApiError::NoDevice) => Ok("Nothing is playing on Spotify.".into()),
            Err(ApiError::Msg(m)) if is_restriction(&m) => Ok("Spotify is already paused.".into()),
            Err(e) => Err(e.text()),
        },
        "next" => player(state, Method::POST, "/me/player/next", &[], None).await.map(|_| "Skipped to the next track.".into()),
        "previous" => player(state, Method::POST, "/me/player/previous", &[], None).await.map(|_| "Back to the previous track.".into()),
        "volume" => {
            let relative = matches!(value, Some(Value::String(s)) if s.trim().starts_with(['+', '-']));
            let current = if relative { now_playing(state).await?.volume } else { None };
            let pct = volume_target(current, value)?;
            player(state, Method::PUT, "/me/player/volume", &[("volume_percent", pct.to_string())], None).await?;
            Ok(format!("Spotify volume {pct}%."))
        }
        "shuffle" => {
            let current = if matches!(value, None | Some(Value::Null) | Some(Value::String(_))) { now_playing(state).await?.shuffle } else { false };
            let on = shuffle_target(current, value)?;
            player(state, Method::PUT, "/me/player/shuffle", &[("state", on.to_string())], None).await?;
            Ok(format!("Shuffle {}.", if on { "on" } else { "off" }))
        }
        other => Err(format!("unknown Spotify action \"{other}\"")),
    }
}

async fn fetch_account(state: &DispatchState) -> Result<String, String> {
    let me = get(state, "/me", &[]).await?;
    let name = me["display_name"].as_str().filter(|s| !s.is_empty()).or_else(|| me["id"].as_str()).unwrap_or("Spotify user").to_string();
    *ACCOUNT.lock().unwrap() = Some(name.clone());
    Ok(name)
}

/// `name` is a `spotify.*` builtin tool (MCP gate already applied by `call_tool`).
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value) -> Result<String, String> {
    if os.snapshot().privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    let arg = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
    match name {
        "spotify.now_playing" => now_playing(state).await.map(|n| describe(&n)),
        "spotify.recent" => get(state, "/me/player/recently-played", &[("limit", "20".into())]).await.map(|v| list_text("Recently played on Spotify", &parse_recent(&v))),
        "spotify.playlists" => get(state, "/me/playlists", &[("limit", "20".into())]).await.map(|v| list_text("Your Spotify playlists", &parse_playlists(&v))),
        "spotify.play" => play_query(state, arg("query"), Some(arg("kind"))).await,
        "spotify.volume" => control(state, "volume", args.get("percent")).await,
        _ => match name.strip_prefix("spotify.") {
            Some(a @ ("pause" | "resume" | "next" | "previous")) => control(state, a, None).await,
            _ => Err(format!("unknown Spotify tool {name}")),
        },
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Reads (the widget polls): the kill switch and a Deny tier refuse; no per-poll log.
fn may_read(os: &OsState) -> Result<(), String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    if cfg.permissions.mcp == Tier::Deny {
        return Err("PERMISSION_DENIED:mcp".into());
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

/// Open Spotify's consent page; the outcome arrives as a `spotify-auth` event
/// `{ok, error?, account?}`. The URL is returned for a clickable fallback link.
#[tauri::command]
pub async fn spotify_auth_start(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<AuthStart, String> {
    if os.snapshot().privacy.kill_switch {
        return Err(KILL_SWITCH.into());
    }
    let cfg = config(&state)?;
    let (addr, path) = redirect_target(&cfg.redirect)?;
    let verifier = b64url(&random_bytes::<64>());
    let expected = b64url(&random_bytes::<24>());
    let url = authorize_url(&cfg.client_id, &cfg.redirect, &pkce_challenge(&verifier), &expected);

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
        let res = async {
            let code = tokio::time::timeout(AUTH_WAIT, async {
                match listener {
                    Some(l) => listen_once(l, &path, &expected).await,
                    None => poll_gateway(&state, &os, &expected).await,
                }
            })
            .await
            .map_err(|_| "Timed out waiting for Spotify sign-in — press Connect to try again".to_string())??;
            exchange(&state, &code, &verifier).await?;
            Ok::<_, String>(fetch_account(&state).await.ok())
        }
        .await;
        let payload = match res {
            Ok(account) => json!({ "ok": true, "account": account }),
            Err(e) => json!({ "ok": false, "error": e }),
        };
        let _ = handle.emit("spotify-auth", payload);
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
}

#[tauri::command]
pub async fn spotify_status(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<SpotifyStatus, String> {
    let configured = config(&state).is_ok();
    let mut account = ACCOUNT.lock().unwrap().clone();
    let mut problem = None;
    // Validate a stored token on every status check (the card asks on mount and on window
    // focus, not on a timer): a token that Spotify revoked, or one minted for a different
    // Client ID, must read "Not connected" with a Connect button, not a stale "Connected".
    if configured && os_core::os_secret(SECRET_REFRESH).is_some() && !os.snapshot().privacy.kill_switch {
        match tokio::time::timeout(Duration::from_secs(5), fetch_account(&state)).await {
            Ok(Ok(name)) => account = Some(name),
            Ok(Err(e)) => problem = Some(e),
            Err(_) => {} // slow network: keep the cached name, don't call it broken
        }
    }
    // The account lookup drops a revoked refresh token, so check it afterwards.
    let connected = os_core::os_secret(SECRET_REFRESH).is_some();
    Ok(SpotifyStatus { configured, connected, account: account.filter(|_| connected), problem: problem.filter(|_| connected) })
}

#[tauri::command]
pub async fn spotify_disconnect() -> Result<(), String> {
    let flow = FLOW.lock().unwrap().take();
    if let Some(h) = flow {
        h.abort();
    }
    *ACCESS.lock().await = None;
    *ACCOUNT.lock().unwrap() = None;
    os_core::os_secret_clear(SECRET_REFRESH)
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

/// `action`: play | pause | resume | next | previous | volume | shuffle.
/// `value`: volume → number (absolute %) or "+N"/"-N"; shuffle → bool / "on" / "off" (omitted = toggle).
#[tauri::command]
pub async fn spotify_control(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, action: String, value: Option<Value>, approved: Option<bool>) -> Result<String, String> {
    let what = format!("spotify.{action}");
    may_control(&os, &bridge, approved.unwrap_or(false), &what)?;
    logged(&bridge, &what, control(&state, &action, value.as_ref()).await)
}

#[tauri::command]
pub async fn spotify_play(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, query: String, kind: Option<String>, approved: Option<bool>) -> Result<String, String> {
    may_control(&os, &bridge, approved.unwrap_or(false), "spotify.play")?;
    logged(&bridge, "spotify.play", play_query(&state, &query, kind.as_deref()).await)
}

#[tauri::command]
pub async fn spotify_play_uri(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, uri: String, approved: Option<bool>) -> Result<String, String> {
    may_control(&os, &bridge, approved.unwrap_or(false), "spotify.play_uri")?;
    logged(&bridge, "spotify.play_uri", play_uri(&state, &uri).await)
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
        let u = url::Url::parse(&authorize_url("cid123", DEFAULT_REDIRECT, "chal", "st4te")).unwrap();
        assert_eq!(u.as_str().split('?').next(), Some("https://accounts.spotify.com/authorize"));
        let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid123");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:1420/callback");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["state"], "st4te");
        assert!(q["scope"].contains("user-modify-playback-state") && q["scope"].contains("playlist-read-collaborative"));
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
        let t = parse_token_reply(200, r#"{"access_token":"a1","token_type":"Bearer","expires_in":3600,"refresh_token":"r1"}"#).unwrap();
        assert_eq!(t, TokenReply { access: "a1".into(), expires_in: 3600, refresh: Some("r1".into()) });
        assert_eq!(parse_token_reply(200, r#"{"access_token":"a2","expires_in":10}"#).unwrap().refresh, None);
        assert!(parse_token_reply(400, r#"{"error":"invalid_grant","error_description":"Refresh token revoked"}"#).unwrap_err().starts_with("Spotify access was revoked"));
        assert!(parse_token_reply(401, r#"{"error":"invalid_client"}"#).unwrap_err().contains("SPOTIFY_CLIENT_ID"));
        assert!(parse_token_reply(200, "{}").is_err());
    }

    #[test]
    fn api_errors_are_friendly() {
        assert_eq!(api_error(404, r#"{"error":{"status":404,"message":"Player command failed: No active device found","reason":"NO_ACTIVE_DEVICE"}}"#), ApiError::NoDevice);
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Premium required","reason":"PREMIUM_REQUIRED"}}"#), ApiError::Msg(PREMIUM.into()));
        assert_eq!(api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Restriction violated"}}"#), ApiError::Msg("Spotify error (HTTP 403): Player command failed: Restriction violated".into()));
        assert_eq!(api_error(500, ""), ApiError::Msg("Spotify error (HTTP 500)".into()));
        // The exact body Spotify returns for a dev-mode app whose owner has no Premium.
        assert_eq!(
            api_error(403, r#"{"error":{"status":403,"message":"Active premium subscription required for the owner of the app. When the subscription status changes, it can take a few hours before requests are allowed again."}}"#),
            ApiError::Msg(OWNER_PREMIUM.into())
        );
        assert_eq!(ApiError::NoDevice.text(), NO_DEVICE);
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
        assert_eq!(describe(&n), "Now playing: \"Woke Up This Morning\" by Alabama 3 (album \"Exile on Coldharbour Lane\") — 1:01 / 4:05, on DESKTOP, volume 64%.");
        let json = serde_json::to_value(&n).unwrap();
        assert!(json.get("artUrl").is_some() && json.get("progressMs").is_some() && json.get("isPlaying").is_some());
        assert_eq!(parse_now_playing(&Value::Null), NowPlaying::default());
        assert_eq!(describe(&NowPlaying::default()), "Nothing is playing on Spotify right now.");
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
        assert_eq!(list_text("Your Spotify playlists", &pls), "Your Spotify playlists:\n1. Gym — Nick");
        assert_eq!(list_text("Recent", &[]), "Recent: none.");
    }

    #[test]
    fn search_hits_and_play_bodies() {
        let v = json!({ "tracks": { "items": [{ "uri": "spotify:track:t", "name": "Song", "artists": [{ "name": "Band" }] }] }, "playlists": { "items": [null, { "uri": "spotify:playlist:p", "name": "Jazz Vibes" }] } });
        assert_eq!(pick_search("track", &v), Some(("spotify:track:t".into(), "\"Song\" by Band".into())));
        assert_eq!(pick_search("playlist", &v), Some(("spotify:playlist:p".into(), "the playlist \"Jazz Vibes\"".into())));
        assert_eq!(pick_search("album", &v), None);
        assert_eq!(play_body("spotify:track:t"), json!({ "uris": ["spotify:track:t"] }));
        assert_eq!(play_body("spotify:playlist:p"), json!({ "context_uri": "spotify:playlist:p" }));
        assert!(valid_uri("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"));
        assert!(valid_uri("spotify:user:nick:playlist:37i9dQZF1DXcBWIGoYBM5M"));
        assert!(!valid_uri("spotify:track:../../x"));
        assert!(!valid_uri("https://open.spotify.com/track/x"));
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
    fn device_fallback_prefers_active_then_first_unrestricted() {
        let d = json!({ "devices": [{ "id": "r", "is_restricted": true }, { "id": "a" }, { "id": "b", "is_active": true }] });
        assert_eq!(pick_device(&d).as_deref(), Some("b"));
        assert_eq!(pick_device(&json!({ "devices": [{ "id": "r", "is_restricted": true }, { "id": "a" }] })).as_deref(), Some("a"));
        assert_eq!(pick_device(&json!({ "devices": [] })), None);
    }

    #[test]
    fn already_paused_restriction_is_recognised() {
        let ApiError::Msg(m) = api_error(403, r#"{"error":{"status":403,"message":"Player command failed: Restriction violated"}}"#) else { panic!("expected Msg") };
        assert!(is_restriction(&m));
        assert!(!is_restriction("Spotify playback control needs Premium"));
    }
}
