//! Spotify device resolver and local client launch (WP-C, see spotify-overhaul-contract.md).
//!
//! Pure device parsing / picking / name matching / planning, plus the one side effect
//! (`launch_local_spotify`) and an injected-fetcher poll loop (`wait_for_device`).
//! No global state and no device cache (D22): every caller fetches `/me/player/devices` fresh.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub is_active: bool,
    pub is_restricted: bool,
    pub is_private_session: bool,
    pub supports_volume: bool,
    pub volume_percent: Option<u8>,
}

/// `GET /me/player/devices` body → devices with a non-null id (restricted ones kept, flagged).
pub fn parse_devices(v: &Value) -> Vec<Device> {
    let Some(list) = v.get("devices").and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .filter_map(|d| {
            let id = d.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
            let flag = |k: &str| d.get(k).and_then(Value::as_bool).unwrap_or(false);
            let text = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            Some(Device {
                id: id.to_string(),
                name: text("name"),
                kind: text("type"),
                is_active: flag("is_active"),
                is_restricted: flag("is_restricted"),
                is_private_session: flag("is_private_session"),
                supports_volume: flag("supports_volume"),
                volume_percent: d.get("volume_percent").and_then(Value::as_u64).map(|n| n.min(100) as u8),
            })
        })
        .collect()
}

/// `COMPUTERNAME` env (Windows), else `sysinfo::System::host_name()`, else "".
pub fn this_pc_name() -> String {
    if let Ok(n) = std::env::var("COMPUTERNAME") {
        if !n.trim().is_empty() {
            return n.trim().to_string();
        }
    }
    sysinfo::System::host_name().map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Lowercase, alphanumeric-only folding used for host / device-name comparison.
fn fold_host(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// kind eq_ignore_ascii_case "computer" AND name (lowercase, alnum only) == host (same folding).
pub fn is_this_pc(d: &Device, host: &str) -> bool {
    let h = fold_host(host);
    !h.is_empty() && d.kind.eq_ignore_ascii_case("computer") && fold_host(&d.name) == h
}

fn is_computer(d: &Device) -> bool {
    d.kind.eq_ignore_ascii_case("computer")
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Purpose {
    Start,
    Control,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    Active(Device),
    Wake(Device),
    OnlyRestricted,
    Empty,
}

/// Unrestricted only. Active → Active. Else Wake(this PC) → else Wake(first kind "computer") → else Wake(first).
/// All restricted → OnlyRestricted. No devices → Empty.
pub fn pick(devices: &[Device], host: &str) -> Pick {
    if devices.is_empty() {
        return Pick::Empty;
    }
    let usable: Vec<&Device> = devices.iter().filter(|d| !d.is_restricted).collect();
    if usable.is_empty() {
        return Pick::OnlyRestricted;
    }
    if let Some(d) = usable.iter().find(|d| d.is_active) {
        return Pick::Active((*d).clone());
    }
    let d = usable
        .iter()
        .find(|d| is_this_pc(d, host))
        .or_else(|| usable.iter().find(|d| is_computer(d)))
        .unwrap_or(&usable[0]);
    Pick::Wake((*d).clone())
}

#[derive(Clone, Debug, PartialEq)]
pub enum NameMatch {
    One(Device),
    Ambiguous(Device, Device),
    None,
}

/// The contract's this-PC list plus the bare kind words the grammar actually emits (it strips a
/// leading "the": "on the computer" ⇒ "computer") and "my/the laptop". All resolve to this PC
/// first, else the sole "computer" device — never to a differently named machine by fuzzy match.
const THIS_PC_WORDS: [&str; 18] = [
    "this pc", "this computer", "my computer", "my pc", "my desktop", "the desktop", "here", "this laptop",
    "computer", "the computer", "pc", "the pc", "desktop", "laptop", "my laptop", "the laptop", "my machine", "this machine",
];
const PHONE_WORDS: [&str; 5] = ["my phone", "phone", "my iphone", "my android", "my mobile"];
const TV_WORDS: [&str; 3] = ["tv", "the tv", "my tv"];
const SPEAKER_WORDS: [&str; 3] = ["speaker", "the speaker", "my speaker"];
const NAME_MIN: f32 = 0.7;

/// Phrase folding for the fixed word lists: lowercase, punctuation → space, spaces collapsed.
fn fold_phrase(s: &str) -> String {
    let lowered: String = s
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    lowered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when `spoken` denotes this PC (same word list as `match_device`).
pub fn means_this_pc(spoken: &str) -> bool {
    THIS_PC_WORDS.contains(&fold_phrase(spoken).as_str())
}

/// Zero matches ⇒ None, one ⇒ One, two or more ⇒ Ambiguous(first two).
fn by_count(found: Vec<&Device>) -> NameMatch {
    match found.as_slice() {
        [] => NameMatch::None,
        [d] => NameMatch::One((*d).clone()),
        [a, b, ..] => NameMatch::Ambiguous((*a).clone(), (*b).clone()),
    }
}

fn of_kind<'a>(usable: &[&'a Device], kind: &str) -> Vec<&'a Device> {
    usable.iter().copied().filter(|d| d.kind.eq_ignore_ascii_case(kind)).collect()
}

/// Spoken device name → device (unrestricted only). See contract §4.3.
pub fn match_device(devices: &[Device], spoken: &str, host: &str) -> NameMatch {
    let usable: Vec<&Device> = devices.iter().filter(|d| !d.is_restricted).collect();
    let phrase = fold_phrase(spoken);
    if phrase.is_empty() || usable.is_empty() {
        return NameMatch::None;
    }
    if THIS_PC_WORDS.contains(&phrase.as_str()) {
        // "my laptop" when a computer is literally named "… Laptop": that one.
        if matches!(phrase.as_str(), "laptop" | "my laptop" | "the laptop") {
            let named: Vec<&Device> = of_kind(&usable, "computer").into_iter().filter(|d| fold_phrase(&d.name).split(' ').any(|w| w == "laptop")).collect();
            if !named.is_empty() {
                return by_count(named);
            }
        }
        let mine: Vec<&Device> = usable.iter().copied().filter(|d| is_this_pc(d, host)).collect();
        if !mine.is_empty() {
            // Same machine listed twice (e.g. reinstall) — not a real choice for the user.
            let d = mine.iter().find(|d| d.is_active).unwrap_or(&mine[0]);
            return NameMatch::One((*d).clone());
        }
        return by_count(of_kind(&usable, "computer"));
    }
    if PHONE_WORDS.contains(&phrase.as_str()) {
        return by_count(of_kind(&usable, "smartphone"));
    }
    if TV_WORDS.contains(&phrase.as_str()) {
        return by_count(of_kind(&usable, "tv"));
    }
    if SPEAKER_WORDS.contains(&phrase.as_str()) {
        return by_count(of_kind(&usable, "speaker"));
    }
    // Fuzzy name match; "my kitchen speaker" also tried as "kitchen speaker".
    let bare = phrase.strip_prefix("my ").unwrap_or(&phrase).to_string();
    let score = |d: &Device| similarity(&phrase, &d.name).max(similarity(&bare, &d.name));
    let mut best: Option<(&Device, f32)> = None;
    let mut tie: Option<&Device> = None;
    for d in &usable {
        let s = score(d);
        if s < NAME_MIN {
            continue;
        }
        match best {
            None => best = Some((d, s)),
            Some((_, b)) if s > b + f32::EPSILON => {
                best = Some((d, s));
                tie = None;
            }
            Some((_, b)) if (s - b).abs() <= f32::EPSILON && tie.is_none() => tie = Some(d),
            _ => {}
        }
    }
    match (best, tie) {
        (None, _) => NameMatch::None,
        // An exact name always wins outright (first in list order).
        (Some((d, s)), _) if s >= 1.0 => NameMatch::One(d.clone()),
        (Some((d, _)), Some(t)) => NameMatch::Ambiguous(d.clone(), t.clone()),
        (Some((d, _)), None) => NameMatch::One(d.clone()),
    }
}

// ── Local copy of spotify_resolve::norm / similarity (no cross-module dependency, §4.3) ──

fn fold_latin1(c: char) -> &'static str {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => "a",
        'æ' => "ae",
        'ç' => "c",
        'è' | 'é' | 'ê' | 'ë' => "e",
        'ì' | 'í' | 'î' | 'ï' => "i",
        'ð' => "d",
        'ñ' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => "o",
        'ù' | 'ú' | 'û' | 'ü' => "u",
        'ý' | 'ÿ' => "y",
        'þ' => "th",
        'ß' => "ss",
        _ => "",
    }
}

/// lowercase; Latin-1 diacritics stripped; "&"→"and"; non-alphanumeric removed (apostrophes vanish,
/// other punctuation becomes a space); spaces collapsed; leading "the " dropped.
fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        let folded = fold_latin1(c);
        if !folded.is_empty() {
            out.push_str(folded);
        } else if c == '&' {
            out.push_str(" and ");
        } else if c.is_alphanumeric() {
            out.push(c);
        } else if c == '\'' || c == '\u{2019}' {
            // "Nick's iPhone" → "nicks iphone"
        } else {
            out.push(' ');
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.strip_prefix("the ").map(str::to_string).unwrap_or(collapsed)
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 0.0..=1.0: 1.0 if norms equal; 0.9 if the shorter norm (≥ 4 chars) is a whole-word prefix/substring of
/// the longer; else 1 − levenshtein / max(len).
fn similarity(a: &str, b: &str) -> f32 {
    let (na, nb) = (norm(a), norm(b));
    if na == nb {
        return if na.is_empty() { 0.0 } else { 1.0 };
    }
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    let (short, long) = if na.chars().count() <= nb.chars().count() { (&na, &nb) } else { (&nb, &na) };
    if short.chars().count() >= 4 && format!(" {long} ").contains(&format!(" {short} ")) {
        return 0.9;
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (na.chars().collect(), nb.chars().collect());
    let max = ca.len().max(cb.len()) as f32;
    1.0 - levenshtein(&ca, &cb) as f32 / max
}

/// Pure device decision (WP-E calls it; every branch unit-tested here).
#[derive(Clone, Debug, PartialEq)]
pub enum DeviceStep {
    /// Device is already active: send calls with ?device_id=id.
    Use(Device),
    /// Listed but inactive: Start with play?device_id (new content) or transfer {play:true} (resume/transfer).
    Wake(Device),
    /// Nothing usable here: launch local Spotify, `wait_for_device`, then call `device_plan` again with launched=true.
    Launch,
    /// `wanted` named a device that isn't listed. `available` = names of unrestricted devices (may be empty).
    NotFound { wanted: String, available: Vec<String> },
    Ambiguous(Device, Device),
    OnlyRestricted,
    /// Nothing to act on (Control purpose, or after a launch already happened).
    Empty,
}

/// Exhaustive rules, contract §4.3.
pub fn device_plan(devices: &[Device], wanted: Option<&str>, purpose: Purpose, host: &str, launched: bool) -> DeviceStep {
    if let Some(w) = wanted {
        return match match_device(devices, w, host) {
            NameMatch::One(d) if d.is_active => DeviceStep::Use(d),
            NameMatch::One(d) => DeviceStep::Wake(d),
            NameMatch::Ambiguous(a, b) => DeviceStep::Ambiguous(a, b),
            NameMatch::None if means_this_pc(w) && purpose == Purpose::Start && !launched => DeviceStep::Launch,
            NameMatch::None => DeviceStep::NotFound {
                wanted: w.to_string(),
                available: devices.iter().filter(|d| !d.is_restricted).map(|d| d.name.clone()).collect(),
            },
        };
    }
    match (purpose, pick(devices, host)) {
        (_, Pick::Active(d)) => DeviceStep::Use(d),
        (Purpose::Control, _) => DeviceStep::Empty,
        (Purpose::Start, Pick::Wake(d)) => DeviceStep::Wake(d),
        (Purpose::Start, Pick::OnlyRestricted) if launched => DeviceStep::OnlyRestricted,
        (Purpose::Start, Pick::Empty) if launched => DeviceStep::Empty,
        (Purpose::Start, Pick::OnlyRestricted | Pick::Empty) => DeviceStep::Launch,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WaitOpts {
    pub interval: Duration,
    pub timeout: Duration,
}
pub const LAUNCH_WAIT: WaitOpts = WaitOpts { interval: Duration::from_millis(500), timeout: Duration::from_secs(10) };

#[derive(Debug, PartialEq)]
pub enum DeviceError {
    NotReady,
    LaunchFailed(String),
    Fetch(String),
}

/// Poll until `pick` yields Active/Wake. Virtual clock: elapsed += interval after each `sleep(interval)`
/// (so tests with an instant fake sleep are deterministic). Loop: sleep → fetch → pick; Active|Wake ⇒ Ok;
/// elapsed ≥ timeout ⇒ Err(NotReady). A fetch Err ⇒ Err(Fetch(e)) immediately.
/// A zero interval polls exactly once (the virtual clock could never advance).
/// `wanted` (a named device, e.g. "this computer"): ready only once that device is listed
/// (`device_plan(.., Start, launched=true)` is Use/Wake) — another device being listed is not enough.
pub async fn wait_for_device<F, Fut, S, SFut>(mut fetch: F, mut sleep: S, host: &str, wanted: Option<&str>, opts: WaitOpts) -> Result<Device, DeviceError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<Device>, String>>,
    S: FnMut(Duration) -> SFut,
    SFut: std::future::Future<Output = ()>,
{
    let mut elapsed = Duration::ZERO;
    loop {
        sleep(opts.interval).await;
        elapsed += opts.interval;
        let devices = fetch().await.map_err(DeviceError::Fetch)?;
        let ready = match wanted {
            Some(w) => match device_plan(&devices, Some(w), Purpose::Start, host, true) {
                DeviceStep::Use(d) | DeviceStep::Wake(d) => Some(d),
                _ => None,
            },
            None => match pick(&devices, host) {
                Pick::Active(d) | Pick::Wake(d) => Some(d),
                _ => None,
            },
        };
        if let Some(d) = ready {
            return Ok(d);
        }
        if elapsed >= opts.timeout || opts.interval.is_zero() {
            return Err(DeviceError::NotReady);
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum LaunchCmd {
    /// `<APPDATA>\Spotify\Spotify.exe` with args `["--uri=<uri>"]` (or no args when uri None).
    Exe { path: PathBuf, args: Vec<String> },
    /// `rundll32.exe url.dll,FileProtocolHandler <uri or "spotify:">` — Store installs register the protocol.
    Protocol { target: String },
}

/// `spotify:(track|album|artist|playlist|episode):[A-Za-z0-9]{22}` or exactly `spotify:collection`.
fn launchable_uri(uri: &str) -> bool {
    if uri == "spotify:collection" {
        return true;
    }
    let mut parts = uri.splitn(3, ':');
    let (Some("spotify"), Some(kind), Some(id)) = (parts.next(), parts.next(), parts.next()) else { return false };
    matches!(kind, "track" | "album" | "artist" | "playlist" | "episode")
        && id.len() == 22
        && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn under_windows_apps(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("WindowsApps"))
}

/// Pure: `exe_exists` = `%APPDATA%\Spotify\Spotify.exe` is a file. Exe when it exists, else Protocol.
/// A uri that isn't launchable is ignored (bare "spotify:" / no args). Never a path under WindowsApps.
pub fn launch_cmd(appdata: &Path, exe_exists: bool, uri: Option<&str>) -> LaunchCmd {
    let uri = uri.filter(|u| launchable_uri(u));
    let path = appdata.join("Spotify").join("Spotify.exe");
    if exe_exists && !appdata.as_os_str().is_empty() && !under_windows_apps(&path) {
        let args = uri.map(|u| vec![format!("--uri={u}")]).unwrap_or_default();
        return LaunchCmd::Exe { path, args };
    }
    LaunchCmd::Protocol { target: uri.unwrap_or("spotify:").to_string() }
}

/// Windows: spawns `launch_cmd(...)` with CREATE_NO_WINDOW, stdio null, child reaped on a thread.
/// Spawn error ⇒ Err(text without paths). Non-Windows: Err("Opening Spotify automatically only works on Windows").
pub fn launch_local_spotify(uri: Option<&str>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
        let exe = appdata.join("Spotify").join("Spotify.exe");
        // A file that resolves (symlink / alias) into WindowsApps is treated as absent.
        let exe_exists = !appdata.as_os_str().is_empty()
            && exe.is_file()
            && !std::fs::canonicalize(&exe).map(|p| under_windows_apps(&p)).unwrap_or(true);
        let mut cmd = match launch_cmd(&appdata, exe_exists, uri) {
            LaunchCmd::Exe { path, args } => {
                let mut c = Command::new(path);
                c.args(args);
                c
            }
            LaunchCmd::Protocol { target } => {
                let rundll = std::env::var_os("SystemRoot")
                    .map(|r| PathBuf::from(r).join("System32").join("rundll32.exe"))
                    .filter(|p| p.is_file())
                    .unwrap_or_else(|| PathBuf::from("rundll32"));
                let mut c = Command::new(rundll);
                c.args(["url.dll,FileProtocolHandler", target.as_str()]);
                c
            }
        };
        cmd.creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Spotify ({})", e.kind()))?;
        std::thread::spawn(move || child.wait());
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = uri;
        Err("Opening Spotify automatically only works on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    const HOST: &str = "DESKTOP-TEST01";

    fn fixture(name: &str) -> Vec<Device> {
        let raw = match name {
            "active_phone" => include_str!("../../tests/fixtures/spotify/devices_active_phone.json"),
            "idle_pc" => include_str!("../../tests/fixtures/spotify/devices_idle_pc.json"),
            "restricted" => include_str!("../../tests/fixtures/spotify/devices_restricted.json"),
            "empty" => include_str!("../../tests/fixtures/spotify/devices_empty.json"),
            "two_phones" => include_str!("../../tests/fixtures/spotify/devices_two_phones.json"),
            other => panic!("unknown fixture {other}"),
        };
        parse_devices(&serde_json::from_str(raw).unwrap())
    }

    fn dev(name: &str, kind: &str, active: bool, restricted: bool) -> Device {
        Device {
            id: format!("id-{name}"),
            name: name.into(),
            kind: kind.into(),
            is_active: active,
            is_restricted: restricted,
            is_private_session: false,
            supports_volume: true,
            volume_percent: Some(50),
        }
    }

    fn name_of(step: &DeviceStep) -> &str {
        match step {
            DeviceStep::Use(d) | DeviceStep::Wake(d) => &d.name,
            other => panic!("expected Use/Wake, got {other:?}"),
        }
    }

    #[test]
    fn parse_devices_skips_null_id_and_keeps_restricted() {
        let d = fixture("active_phone");
        assert_eq!(d.len(), 2, "null-id device dropped");
        assert!(d.iter().all(|x| x.name != "Ghost Device"));
        assert_eq!(d[0].kind, "Computer");
        assert_eq!(d[0].volume_percent, Some(64));
        assert!(d[1].is_active && d[1].kind == "Smartphone" && !d[1].supports_volume);

        let r = fixture("restricted");
        assert_eq!(r.len(), 2);
        assert!(r.iter().all(|x| x.is_restricted));
        assert_eq!(r[0].kind, "TV", "type case preserved");
        assert_eq!(r[0].volume_percent, None, "missing volume ⇒ None");
        assert_eq!(r[1].volume_percent, Some(100), "volume clamped to 100");

        let idle = fixture("idle_pc");
        assert_eq!(idle[1].kind, "computer", "lowercase type preserved");
        assert!(idle[2].is_private_session);

        assert!(fixture("empty").is_empty());
        assert!(parse_devices(&serde_json::json!({})).is_empty());
        assert!(parse_devices(&serde_json::json!({"devices": [null, {"id": ""}]})).is_empty());
    }

    #[test]
    fn this_pc_detection_folds_names() {
        let pc = dev("DESKTOP-TEST01", "computer", false, false);
        assert!(is_this_pc(&pc, "desktop-test01"));
        assert!(is_this_pc(&pc, "Desktop Test01"));
        assert!(!is_this_pc(&pc, ""));
        assert!(!is_this_pc(&dev("DESKTOP-TEST01", "Smartphone", false, false), HOST));
        assert!(!is_this_pc(&dev("Other PC", "Computer", false, false), HOST));
        // Never panics; may be empty on exotic hosts.
        let _ = this_pc_name();
    }

    #[test]
    fn pick_rules() {
        // Active wins (phone active, PC idle).
        assert_eq!(pick(&fixture("active_phone"), HOST), Pick::Active(fixture("active_phone")[1].clone()));
        // Restricted active ignored.
        let mixed = vec![dev("TV", "TV", true, true), dev("Pixel", "Smartphone", false, false)];
        assert!(matches!(pick(&mixed, HOST), Pick::Wake(d) if d.name == "Pixel"));
        // This PC preferred over phone and other computers when none active.
        assert!(matches!(pick(&fixture("idle_pc"), HOST), Pick::Wake(d) if d.name == "DESKTOP-TEST01"));
        // Unknown host ⇒ first computer.
        assert!(matches!(pick(&fixture("idle_pc"), "elsewhere"), Pick::Wake(d) if d.name == "Work Laptop"));
        // No computer ⇒ first unrestricted.
        let phones = vec![dev("A", "Smartphone", false, false), dev("B", "Speaker", false, false)];
        assert!(matches!(pick(&phones, HOST), Pick::Wake(d) if d.name == "A"));
        assert_eq!(pick(&fixture("restricted"), HOST), Pick::OnlyRestricted);
        assert_eq!(pick(&fixture("empty"), HOST), Pick::Empty);
    }

    #[test]
    fn match_device_cases() {
        let idle = fixture("idle_pc");
        assert!(matches!(match_device(&idle, "this computer", HOST), NameMatch::One(d) if d.name == "DESKTOP-TEST01"));
        assert!(matches!(match_device(&idle, "My PC.", HOST), NameMatch::One(d) if d.name == "DESKTOP-TEST01"));
        // Host unknown: two computers ⇒ Ambiguous; one computer ⇒ sole computer.
        assert!(matches!(match_device(&idle, "this pc", "elsewhere"), NameMatch::Ambiguous(..)));
        let one_pc = fixture("active_phone");
        assert!(matches!(match_device(&one_pc, "here", "elsewhere"), NameMatch::One(d) if d.kind == "Computer"));
        assert!(matches!(match_device(&idle, "my phone", HOST), NameMatch::One(d) if d.name == "Pixel 8"));

        let many = fixture("two_phones");
        assert!(matches!(match_device(&many, "my phone", HOST), NameMatch::Ambiguous(a, b) if a.name == "Pixel 8" && b.name == "Work iPhone"));
        assert!(matches!(match_device(&many, "the tv", HOST), NameMatch::One(d) if d.name == "Bedroom TV"));
        assert!(matches!(match_device(&many, "speaker", HOST), NameMatch::One(d) if d.name == "Kitchen Speaker"));
        assert!(matches!(match_device(&many, "kitchen speaker", HOST), NameMatch::One(d) if d.name == "Kitchen Speaker"));
        assert!(matches!(match_device(&many, "the kitchen speakers", HOST), NameMatch::One(d) if d.name == "Kitchen Speaker"));
        assert!(matches!(match_device(&many, "my work iphone", HOST), NameMatch::One(d) if d.name == "Work iPhone"));
        assert!(matches!(match_device(&many, "pixel", HOST), NameMatch::One(d) if d.name == "Pixel 8"));
        assert_eq!(match_device(&many, "garage radio", HOST), NameMatch::None);
        assert_eq!(match_device(&many, "", HOST), NameMatch::None);
        // Restricted devices never match.
        assert_eq!(match_device(&fixture("restricted"), "living room tv", HOST), NameMatch::None);
        assert_eq!(match_device(&fixture("restricted"), "tv", HOST), NameMatch::None);
        // Identical non-exact scores ⇒ Ambiguous; an exact name wins outright.
        let twins = vec![dev("Echo Dot A", "Speaker", false, false), dev("Echo Dot B", "Speaker", false, false)];
        assert!(matches!(match_device(&twins, "echo dot", HOST), NameMatch::Ambiguous(..)));
        assert!(matches!(match_device(&twins, "echo dot b", HOST), NameMatch::One(d) if d.name == "Echo Dot B"));
    }

    #[test]
    fn means_this_pc_word_list() {
        for w in THIS_PC_WORDS {
            assert!(means_this_pc(w), "{w}");
        }
        assert!(means_this_pc("This Computer!"));
        assert!(!means_this_pc("my phone"));
        assert!(!means_this_pc("kitchen"));
    }

    #[test]
    fn bare_kind_words_find_this_pc_with_any_hostname() {
        // A renamed PC whose hostname shares no word with what the user said.
        let devs = vec![dev("STUDIO-PC", "Computer", false, false), dev("Pixel", "Smartphone", true, false), dev("Den", "TV", false, false), dev("Den Speaker", "Speaker", false, false)];
        for w in ["laptop", "my laptop", "the laptop", "computer", "desktop", "pc"] {
            assert!(matches!(match_device(&devs, w, "studio-pc"), NameMatch::One(d) if d.name == "STUDIO-PC"), "{w}");
            // Host unknown: still the sole computer.
            assert!(matches!(match_device(&devs, w, "elsewhere"), NameMatch::One(d) if d.name == "STUDIO-PC"), "{w} (sole computer)");
        }
        // A computer literally named "… Laptop" wins "my laptop"; "computer" still means this PC.
        let idle = fixture("idle_pc");
        assert!(matches!(match_device(&idle, "my laptop", HOST), NameMatch::One(d) if d.name == "Work Laptop"));
        assert!(matches!(match_device(&idle, "computer", HOST), NameMatch::One(d) if d.name == "DESKTOP-TEST01"));
        assert!(matches!(match_device(&devs, "my tv", HOST), NameMatch::One(d) if d.name == "Den"));
        assert!(matches!(match_device(&devs, "my speaker", HOST), NameMatch::One(d) if d.name == "Den Speaker"));
        // Not listed at all + Start ⇒ launch local Spotify, never a not-found.
        let phone_only = vec![dev("Pixel", "Smartphone", true, false)];
        assert_eq!(device_plan(&phone_only, Some("laptop"), Purpose::Start, HOST, false), DeviceStep::Launch);
    }

    #[test]
    fn similarity_local_copy() {
        assert_eq!(similarity("The Kitchen", "kitchen"), 1.0);
        assert_eq!(similarity("Café", "cafe"), 1.0);
        assert_eq!(similarity("Nick's iPhone", "nicks iphone"), 1.0);
        assert_eq!(similarity("kitchen", "Kitchen Speaker"), 0.9);
        assert!(similarity("tv", "tvx") < 0.9, "short strings skip the substring rule");
        assert_eq!(similarity("", ""), 0.0);
    }

    // ── device_plan: one test per rule ──

    #[test]
    fn plan_wanted_matches_active_is_use() {
        let s = device_plan(&fixture("two_phones"), Some("work iphone"), Purpose::Control, HOST, false);
        assert!(matches!(s, DeviceStep::Use(_)));
        assert_eq!(name_of(&s), "Work iPhone");
    }

    #[test]
    fn plan_wanted_matches_inactive_is_wake_even_for_control() {
        let s = device_plan(&fixture("two_phones"), Some("kitchen speaker"), Purpose::Control, HOST, false);
        assert!(matches!(s, DeviceStep::Wake(_)));
        assert_eq!(name_of(&s), "Kitchen Speaker");
    }

    #[test]
    fn plan_wanted_ambiguous() {
        let s = device_plan(&fixture("two_phones"), Some("my phone"), Purpose::Start, HOST, false);
        assert!(matches!(s, DeviceStep::Ambiguous(a, b) if a.name == "Pixel 8" && b.name == "Work iPhone"));
    }

    #[test]
    fn plan_wanted_missing_is_not_found_with_names() {
        let s = device_plan(&fixture("two_phones"), Some("garage radio"), Purpose::Start, HOST, false);
        assert_eq!(
            s,
            DeviceStep::NotFound {
                wanted: "garage radio".into(),
                available: vec!["Pixel 8".into(), "Work iPhone".into(), "Kitchen Speaker".into(), "Bedroom TV".into()],
            }
        );
        // Restricted names are not offered.
        let r = device_plan(&fixture("restricted"), Some("garage radio"), Purpose::Start, HOST, false);
        assert_eq!(r, DeviceStep::NotFound { wanted: "garage radio".into(), available: vec![] });
    }

    #[test]
    fn plan_wanted_this_pc_missing_launches_once() {
        let phones = fixture("two_phones");
        assert_eq!(device_plan(&phones, Some("this computer"), Purpose::Start, HOST, false), DeviceStep::Launch);
        assert!(matches!(
            device_plan(&phones, Some("this computer"), Purpose::Start, HOST, true),
            DeviceStep::NotFound { .. }
        ));
        // Control never launches, even for "this computer".
        assert!(matches!(
            device_plan(&phones, Some("this computer"), Purpose::Control, HOST, false),
            DeviceStep::NotFound { .. }
        ));
    }

    #[test]
    fn plan_control_without_active_is_empty_never_launch() {
        for f in ["idle_pc", "restricted", "empty"] {
            assert_eq!(device_plan(&fixture(f), None, Purpose::Control, HOST, false), DeviceStep::Empty, "{f}");
        }
        let s = device_plan(&fixture("active_phone"), None, Purpose::Control, HOST, false);
        assert!(matches!(s, DeviceStep::Use(d) if d.name == "Pixel 8"));
    }

    #[test]
    fn plan_start_inactive_phone_only_wakes_phone() {
        let phone = vec![dev("Pixel 8", "Smartphone", false, false)];
        let s = device_plan(&phone, None, Purpose::Start, HOST, false);
        assert!(matches!(s, DeviceStep::Wake(d) if d.name == "Pixel 8"));
    }

    #[test]
    fn plan_start_only_restricted_launches_then_gives_up() {
        let r = fixture("restricted");
        assert_eq!(device_plan(&r, None, Purpose::Start, HOST, false), DeviceStep::Launch);
        assert_eq!(device_plan(&r, None, Purpose::Start, HOST, true), DeviceStep::OnlyRestricted);
    }

    #[test]
    fn plan_start_empty_launches_then_gives_up() {
        let e = fixture("empty");
        assert_eq!(device_plan(&e, None, Purpose::Start, HOST, false), DeviceStep::Launch);
        assert_eq!(device_plan(&e, None, Purpose::Start, HOST, true), DeviceStep::Empty);
    }

    #[test]
    fn plan_start_prefers_this_pc_over_phone() {
        let s = device_plan(&fixture("idle_pc"), None, Purpose::Start, HOST, false);
        assert!(matches!(s, DeviceStep::Wake(d) if d.name == "DESKTOP-TEST01"));
        // An active device always wins over waking this PC.
        let s = device_plan(&fixture("active_phone"), None, Purpose::Start, HOST, false);
        assert!(matches!(s, DeviceStep::Use(d) if d.name == "Pixel 8"));
    }

    // ── wait_for_device with a scripted fetcher and an instant fake sleep ──

    fn run_wait(replies: Vec<Result<Vec<Device>, String>>) -> (Result<Device, DeviceError>, usize, usize) {
        run_wait_for(None, replies)
    }

    fn run_wait_for(wanted: Option<&str>, replies: Vec<Result<Vec<Device>, String>>) -> (Result<Device, DeviceError>, usize, usize) {
        let queue = RefCell::new(VecDeque::from(replies));
        let fetches = RefCell::new(0usize);
        let sleeps = RefCell::new(Vec::<Duration>::new());
        let out = tauri::async_runtime::block_on(wait_for_device(
            || {
                *fetches.borrow_mut() += 1;
                let next = queue.borrow_mut().pop_front().unwrap_or_else(|| Ok(Vec::new()));
                std::future::ready(next)
            },
            |d| {
                sleeps.borrow_mut().push(d);
                std::future::ready(())
            },
            HOST,
            wanted,
            LAUNCH_WAIT,
        ));
        assert!(sleeps.borrow().iter().all(|d| *d == LAUNCH_WAIT.interval));
        let (s, f) = (sleeps.borrow().len(), *fetches.borrow());
        (out, s, f)
    }

    #[test]
    fn wait_finds_device_on_third_poll() {
        let pc = fixture("idle_pc");
        let (out, sleeps, fetches) = run_wait(vec![Ok(vec![]), Ok(fixture("restricted")), Ok(pc.clone())]);
        assert_eq!(out.unwrap().name, "DESKTOP-TEST01");
        assert_eq!((sleeps, fetches), (3, 3));
    }

    #[test]
    fn wait_never_ready_after_exact_timeout() {
        let (out, sleeps, fetches) = run_wait(vec![]);
        assert_eq!(out, Err(DeviceError::NotReady));
        let expected = (LAUNCH_WAIT.timeout.as_millis() / LAUNCH_WAIT.interval.as_millis()) as usize;
        assert_eq!(expected, 20);
        assert_eq!((sleeps, fetches), (20, 20));
    }

    #[test]
    fn wait_fetch_error_is_immediate() {
        let (out, sleeps, fetches) = run_wait(vec![Ok(vec![]), Err("HTTP 500".into()), Ok(fixture("idle_pc"))]);
        assert_eq!(out, Err(DeviceError::Fetch("HTTP 500".into())));
        assert_eq!((sleeps, fetches), (2, 2));
    }

    #[test]
    fn wait_zero_interval_polls_once() {
        let opts = WaitOpts { interval: Duration::ZERO, timeout: Duration::from_secs(10) };
        let out = tauri::async_runtime::block_on(wait_for_device(
            || std::future::ready(Ok(Vec::new())),
            |_| std::future::ready(()),
            HOST,
            None,
            opts,
        ));
        assert_eq!(out, Err(DeviceError::NotReady));
    }

    #[test]
    fn wait_for_named_this_pc_ignores_other_devices() {
        // A phone is listed from the start; this PC registers on the 3rd poll.
        let phone = vec![dev("Pixel", "Smartphone", true, false)];
        let mut with_pc = phone.clone();
        with_pc.push(dev(HOST, "Computer", false, false));
        let (out, sleeps, fetches) = run_wait_for(Some("this computer"), vec![Ok(phone.clone()), Ok(phone.clone()), Ok(with_pc)]);
        assert_eq!(out.unwrap().name, HOST);
        assert_eq!((sleeps, fetches), (3, 3));
        // The PC never shows up ⇒ NotReady, never the phone.
        let (out, _, _) = run_wait_for(Some("this computer"), vec![Ok(phone.clone()); 25]);
        assert_eq!(out, Err(DeviceError::NotReady));
        // Unnamed waits still take any usable device.
        let (out, sleeps, _) = run_wait_for(None, vec![Ok(phone)]);
        assert_eq!((out.unwrap().name.as_str(), sleeps), ("Pixel", 1));
    }

    // ── launch_cmd ──

    #[test]
    fn launch_cmd_exe_with_uri() {
        let appdata = Path::new(r"C:\Users\someone\AppData\Roaming");
        let uri = "spotify:artist:0123456789abcdefABCDEF";
        assert_eq!(
            launch_cmd(appdata, true, Some(uri)),
            LaunchCmd::Exe { path: appdata.join("Spotify").join("Spotify.exe"), args: vec![format!("--uri={uri}")] }
        );
        assert_eq!(
            launch_cmd(appdata, true, Some("spotify:collection")),
            LaunchCmd::Exe { path: appdata.join("Spotify").join("Spotify.exe"), args: vec!["--uri=spotify:collection".into()] }
        );
        assert_eq!(
            launch_cmd(appdata, true, None),
            LaunchCmd::Exe { path: appdata.join("Spotify").join("Spotify.exe"), args: vec![] }
        );
    }

    #[test]
    fn launch_cmd_protocol_when_exe_missing() {
        let appdata = Path::new(r"C:\Users\someone\AppData\Roaming");
        let uri = "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M";
        assert_eq!(launch_cmd(appdata, false, Some(uri)), LaunchCmd::Protocol { target: uri.into() });
        assert_eq!(launch_cmd(appdata, false, None), LaunchCmd::Protocol { target: "spotify:".into() });
        assert_eq!(launch_cmd(Path::new(""), true, None), LaunchCmd::Protocol { target: "spotify:".into() });
    }

    #[test]
    fn launch_cmd_ignores_invalid_uris() {
        let appdata = Path::new(r"C:\Users\someone\AppData\Roaming");
        for bad in [
            "spotify:artist:short",
            "spotify:show:0123456789abcdefABCDEF",
            "spotify:artist:0123456789abcdefABCDE!",
            "spotify:artist:0123456789abcdefABCDEF --other",
            "https://open.spotify.com/artist/0123456789abcdefABCDEF",
            "spotify:user:someone:collection",
            "",
        ] {
            assert_eq!(launch_cmd(appdata, false, Some(bad)), LaunchCmd::Protocol { target: "spotify:".into() }, "{bad}");
            assert!(matches!(launch_cmd(appdata, true, Some(bad)), LaunchCmd::Exe { args, .. } if args.is_empty()), "{bad}");
        }
    }

    #[test]
    fn launch_cmd_never_under_windows_apps() {
        let store = Path::new(r"C:\Program Files\WindowsApps\SpotifyAB.SpotifyMusic_1.0_x64__zpdnekdrzrea0");
        assert_eq!(launch_cmd(store, true, None), LaunchCmd::Protocol { target: "spotify:".into() });
        let lower = Path::new(r"C:\program files\windowsapps\x");
        assert!(matches!(launch_cmd(lower, true, None), LaunchCmd::Protocol { .. }));
        for appdata in [Path::new(r"C:\Users\someone\AppData\Roaming"), store] {
            for exists in [true, false] {
                if let LaunchCmd::Exe { path, .. } = launch_cmd(appdata, exists, None) {
                    assert!(!under_windows_apps(&path));
                }
            }
        }
    }

    #[test]
    #[ignore]
    fn live_launch_spotify() {
        println!("this_pc_name = {:?}", this_pc_name());
        println!("launch_local_spotify = {:?}", launch_local_spotify(None));
    }
}
