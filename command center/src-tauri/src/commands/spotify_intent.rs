//! Spotify utterance grammar: text -> SpotifyIntent (WP-B, see spotify-overhaul-contract.md).
//!
//! One grammar for both paths (D10): the TS fast path calls it over IPC (`spotify_parse`), and the
//! Rust deterministic plan (agents.rs, WP-E) calls `parse` directly. Pure: no network, no state.
// WP-E consumes most of this surface (spotify.rs / mcp.rs / agents.rs); until then it is test-only.
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::spotify_resolve::is_current;

/// Canonical Spotify tool names. Order = order listed to the model.
pub const ALL_TOOLS: [&str; 23] = [
    "spotify.now_playing", "spotify.get_queue", "spotify.recently_played", "spotify.top_items",
    "spotify.list_playlists", "spotify.get_playlist_tracks",
    "spotify.play", "spotify.pause", "spotify.resume", "spotify.next", "spotify.previous",
    "spotify.seek", "spotify.restart_track", "spotify.volume", "spotify.shuffle", "spotify.repeat",
    "spotify.transfer_device", "spotify.queue_add",
    "spotify.create_playlist", "spotify.add_to_playlist", "spotify.remove_from_playlist",
    "spotify.like_track", "spotify.unlike_track",
];
/// Reads (sub-agents may see these; `may_read` gate on the fast path).
pub const READ_TOOLS: [&str; 6] = [
    "spotify.now_playing", "spotify.get_queue", "spotify.recently_played", "spotify.top_items",
    "spotify.list_playlists", "spotify.get_playlist_tracks",
];
/// Backward-compatible names accepted by `spotify::tool` (never listed): old → new.
pub const ALIASES: [(&str, &str); 2] = [("spotify.recent", "spotify.recently_played"), ("spotify.playlists", "spotify.list_playlists")];
/// Grammar-only intent executed by TS (`connectSpotify`), never an MCP tool.
pub const RECONNECT: &str = "spotify.reconnect";

/// Maps ALIASES, else returns `name`.
pub fn canonical(name: &str) -> &str {
    ALIASES.iter().find(|(old, _)| *old == name).map(|(_, new)| *new).unwrap_or(name)
}

/// canonical(name) in READ_TOOLS.
pub fn is_read_tool(name: &str) -> bool {
    READ_TOOLS.contains(&canonical(name))
}

/// canonical(name) in ALL_TOOLS && !is_read_tool.
pub fn is_write_tool(name: &str) -> bool {
    ALL_TOOLS.contains(&canonical(name)) && !is_read_tool(name)
}

/// create_playlist, add_to_playlist, remove_from_playlist, like_track, unlike_track.
pub fn is_library_write(name: &str) -> bool {
    matches!(canonical(name), "spotify.create_playlist" | "spotify.add_to_playlist" | "spotify.remove_from_playlist" | "spotify.like_track" | "spotify.unlike_track")
}

/// remove_from_playlist, unlike_track (also pass privacy.destructive_gate, D25).
pub fn is_destructive(name: &str) -> bool {
    matches!(canonical(name), "spotify.remove_from_playlist" | "spotify.unlike_track")
}

const PLAYBACK_SCOPES: &[&str] = &["user-modify-playback-state", "user-read-playback-state"];

/// Core scopes each canonical tool needs (pure table, contract §4.1). Unknown name ⇒ &[].
pub fn tool_scopes(name: &str) -> &'static [&'static str] {
    match canonical(name) {
        "spotify.now_playing" => &["user-read-currently-playing", "user-library-read"],
        "spotify.get_queue" => &["user-read-currently-playing", "user-read-playback-state"],
        "spotify.recently_played" => &["user-read-recently-played"],
        "spotify.top_items" => &["user-top-read"],
        "spotify.list_playlists" | "spotify.get_playlist_tracks" => &["playlist-read-private", "playlist-read-collaborative"],
        "spotify.play" => &["user-modify-playback-state", "user-read-playback-state", "playlist-read-private", "playlist-read-collaborative"],
        "spotify.pause" | "spotify.resume" | "spotify.next" | "spotify.previous" | "spotify.seek" | "spotify.restart_track" | "spotify.volume" | "spotify.shuffle"
        | "spotify.repeat" | "spotify.transfer_device" | "spotify.queue_add" => PLAYBACK_SCOPES,
        "spotify.create_playlist" => &["playlist-modify-private", "playlist-modify-public"],
        "spotify.add_to_playlist" | "spotify.remove_from_playlist" => {
            &["playlist-modify-private", "playlist-modify-public", "playlist-read-private", "playlist-read-collaborative", "user-read-currently-playing"]
        }
        "spotify.like_track" | "spotify.unlike_track" => &["user-library-modify", "user-library-read", "user-read-currently-playing"],
        _ => &[],
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyIntent {
    /// A name from ALL_TOOLS, or RECONNECT.
    pub tool: String,
    /// JSON object; keys exactly as in §4.4. Already passed through `normalize_args`.
    pub args: Value,
    /// Card / read-back text, no IDs: "Play Bilmuri on Spotify", "Add this song to your Late Night playlist".
    pub summary: String,
    /// == is_write_tool(tool). RECONNECT ⇒ false.
    pub mutating: bool,
    /// The line named Spotify ("… on spotify", "spotify …"). Used by TS cue precedence.
    pub explicit: bool,
}

/// Compile-once regex at the call site.
macro_rules! re {
    ($p:expr) => {{
        static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        R.get_or_init(|| regex::Regex::new($p).expect("spotify grammar regex"))
    }};
}

/// A number as said ("40", "forty", "fifty five"); validated by `words_to_number`.
macro_rules! num {
    () => {
        r"(\d{1,3}|[a-z]+(?:[ -][a-z]+)?)"
    };
}

// ── Numbers and timestamps ──────────────────────────────────────────────────

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 8] = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/// 0..=100 from digits or words ("forty", "fifty five", "a hundred", "one hundred").
pub fn words_to_number(s: &str) -> Option<u32> {
    let t = s.trim().to_lowercase().replace('-', " ");
    let toks: Vec<&str> = t.split_whitespace().filter(|w| *w != "and").collect();
    let n = match toks.as_slice() {
        [d] if d.chars().all(|c| c.is_ascii_digit()) => d.parse::<u32>().ok()?,
        ["hundred"] | ["a" | "one", "hundred"] => 100,
        [w] => match ONES.iter().position(|o| o == w) {
            Some(i) => i as u32,
            None => (TENS.iter().position(|x| x == w)? as u32 + 2) * 10,
        },
        [tens, ones] => {
            let t = (TENS.iter().position(|x| x == tens)? as u32 + 2) * 10;
            let o = ONES.iter().position(|x| x == ones).filter(|i| (1..=9).contains(i))? as u32;
            t + o
        }
        _ => return None,
    };
    (n <= 100).then_some(n)
}

fn unit_secs(w: &str) -> Option<u32> {
    match w {
        "second" | "seconds" | "sec" | "secs" | "s" => Some(1),
        "minute" | "minutes" | "min" | "mins" => Some(60),
        "hour" | "hours" | "hr" | "hrs" => Some(3600),
        _ => None,
    }
}

/// A number starting at toks[i] → (value, tokens used). Digits (any size), "a"/"an" before a unit, words.
fn number_at(toks: &[&str], i: usize) -> Option<(u32, usize)> {
    let w = toks.get(i)?;
    if w.chars().all(|c| c.is_ascii_digit()) {
        return Some((w.parse().ok()?, 1));
    }
    if matches!(*w, "a" | "an") && toks.get(i + 1).and_then(|u| unit_secs(u)).is_some() {
        return Some((1, 1));
    }
    if let Some(next) = toks.get(i + 1) {
        if let Some(n) = words_to_number(&format!("{w} {next}")) {
            return Some((n, 2));
        }
    }
    words_to_number(w).map(|n| (n, 1))
}

/// Seconds from "1:30", "90 seconds", "2 minutes", "1 minute 30", "a minute and a half", "two minutes thirty seconds".
/// A bare number without a unit ("90") is not a timestamp.
pub fn parse_timestamp(s: &str) -> Option<u32> {
    let t = s.trim().to_lowercase();
    if let Some(c) = re!(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$").captures(&t) {
        let a: u32 = c[1].parse().ok()?;
        let b: u32 = c[2].parse().ok()?;
        return match c.get(3) {
            Some(sec) => {
                let sec: u32 = sec.as_str().parse().ok()?;
                (b < 60 && sec < 60).then_some(a * 3600 + b * 60 + sec)
            }
            None => (b < 60).then_some(a * 60 + b),
        };
    }
    let t = t.replace('-', " ");
    let toks: Vec<&str> = t.split_whitespace().filter(|w| !matches!(*w, "and" | "the" | "mark")).collect();
    let (mut total, mut i, mut last_unit, mut any) = (0u32, 0usize, None::<u32>, false);
    while i < toks.len() {
        if toks[i] == "half" {
            // "half a minute" / "a minute and a half".
            if matches!(toks.get(i + 1), Some(&"a" | &"an")) {
                let u = unit_secs(toks.get(i + 2)?)?;
                total += u / 2;
                last_unit = Some(u);
                i += 3;
            } else {
                let u = last_unit.filter(|u| *u > 1)?;
                total += u / 2;
                i += 1;
            }
            any = true;
            continue;
        }
        if matches!(toks[i], "a" | "an") && toks.get(i + 1) == Some(&"half") {
            i += 1;
            continue;
        }
        let (n, used) = number_at(&toks, i)?;
        i += used;
        if let Some(u) = toks.get(i).and_then(|w| unit_secs(w)) {
            total += n * u;
            last_unit = Some(u);
            i += 1;
        } else {
            // "1 minute 30": a trailing number counts in the next smaller unit.
            let u = last_unit.filter(|u| *u > 1)?;
            total += n * (u / 60);
            last_unit = Some(u / 60);
        }
        any = true;
    }
    any.then_some(total)
}

// ── Preprocessing ───────────────────────────────────────────────────────────

/// §4.1 step 2: edge punctuation trimmed; internal `.!?"` removed; `,`/`;` kept; `:` kept between digits;
/// apostrophes removed; whitespace collapsed; casing kept.
fn lite(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '\'' | '\u{2018}' | '\u{2019}' | '`' | '\u{00B4}' => {}
            '.' | '!' | '?' | '"' | '\u{201C}' | '\u{201D}' | '\u{2026}' => {}
            ':' => {
                let digits = i > 0 && chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
                out.push(if digits { ':' } else { ' ' });
            }
            ',' | ';' => {
                out.push(c);
                out.push(' ');
            }
            c if c.is_whitespace() => out.push(' '),
            c => out.push(c),
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ").replace(" ,", ",").replace(" ;", ";");
    collapsed
        .trim_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-' | '\u{2013}' | '\u{2014}' | '(' | ')' | '[' | ']' | '*' | '~'))
        .to_string()
}

/// `,`/`;` → spaces (every row treats them as optional whitespace).
fn flatten(s: &str) -> String {
    s.replace([',', ';'], " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

const S_PREPS: [&str; 6] = ["on", "in", "from", "with", "using", "via"];

/// §4.1 step 3 on the lite form: trailing addressed name (unless a credit: "by Tony"), please/thanks,
/// and "now"/"for me" only after a comma or an explicit "on spotify" suffix.
fn strip_tail(s: &str, os_name: &str) -> String {
    let name = os_name.trim().to_lowercase();
    let mut names = vec!["tony".to_string(), "jarvis".to_string()];
    if !name.is_empty() && !names.contains(&name) {
        names.insert(0, name);
    }
    let mut toks: Vec<String> = s.split(' ').filter(|t| !t.is_empty()).map(str::to_string).collect();
    let bare = |t: &str| t.trim_end_matches([',', ';']).to_lowercase();
    let comma = |t: &str| t.ends_with(',') || t.ends_with(';');
    loop {
        let n = toks.len();
        if n == 0 {
            break;
        }
        let last = bare(&toks[n - 1]);
        let prev = (n >= 2).then(|| toks[n - 2].clone());
        // "… on spotify" right before index `end`?
        let s_suffix_before = |end: usize| end >= 2 && bare(&toks[end - 1]) == "spotify" && S_PREPS.contains(&bare(&toks[end - 2]).as_str());
        let pop = if names.contains(&last) {
            match &prev {
                Some(p) if comma(p) => 1,
                Some(p) if matches!(bare(p).as_str(), "by" | "from") => 0,
                _ => 1,
            }
        } else if matches!(last.as_str(), "please" | "thanks") {
            1
        } else if last == "you" && prev.as_deref().map(bare).as_deref() == Some("thank") {
            2
        } else if last == "now" {
            match &prev {
                Some(p) if comma(p) => 1,
                Some(p) if bare(p) == "right" && n >= 3 && (comma(&toks[n - 3]) || s_suffix_before(n - 2)) => 2,
                Some(_) if s_suffix_before(n - 1) => 1,
                _ => 0,
            }
        } else if last == "me" && prev.as_deref().map(bare).as_deref() == Some("for") && n >= 3 && (comma(&toks[n - 3]) || s_suffix_before(n - 2)) {
            2
        } else {
            0
        };
        if pop == 0 {
            break;
        }
        toks.truncate(n - pop);
        if let Some(l) = toks.last_mut() {
            *l = l.trim_end_matches([',', ';']).to_string();
        }
    }
    toks.join(" ")
}

/// Leading "spotify[,]" and trailing "[,] on|in|from|with|using|via spotify" removed (once each).
fn strip_affixes(lite: &str) -> String {
    let s = re!(r"(?i)^spotify[,;]?\s+").replace(lite, "");
    let s = re!(r"(?i)[,;]?\s+(?:on|in|from|with|using|via) spotify$").replace(&s, "");
    s.trim().to_string()
}

struct Line {
    /// Flat lowercase whole line (after tail strip), for the volume bare-word rule.
    lower: String,
    /// Affixes stripped, commas kept (create_playlist lists).
    core_lite: String,
    /// Affixes stripped, flat, original casing.
    core: String,
    explicit: bool,
    words: usize,
}

// ── Row helpers ─────────────────────────────────────────────────────────────

type Hit = (&'static str, Value);

/// "current" for anything `is_current` accepts, else the trimmed text.
fn cur(q: &str) -> String {
    if is_current(q) {
        "current".into()
    } else {
        q.trim().to_string()
    }
}

/// "this song", "the current track" … (a song is clearly meant, unlike a bare "it").
fn song_phrase(q: &str) -> bool {
    re!(r"(?i)^(?:this|that|the|current|the current) (?:song|track|tune)$").is_match(q.trim())
}

/// Names that are Liked Songs / the queue, not a playlist (G14 exclusion → G17/G19).
fn not_a_playlist(name: &str) -> bool {
    let n = super::spotify_resolve::norm(name);
    let n = n.strip_prefix("my ").unwrap_or(&n);
    matches!(
        n,
        "queue" | "up next" | "liked songs" | "likes" | "liked" | "library" | "favorites" | "favourites" | "saved songs" | "liked songs playlist" | "spotify"
    )
}

fn cap(c: &regex::Captures, i: usize) -> String {
    c.get(i).map(|m| m.as_str().trim().to_string()).unwrap_or_default()
}

/// Device suffix (G44): `on (my|this|the) <device word>`, `on the <w{1,2}> (speaker|tv|echo)`, `on device <name>`.
fn device_suffix(s: &str) -> Option<(String, String)> {
    let c = re!(r"(?i)^(.+?) on (?:(my|this|the) (phone|iphone|android|mobile|computer|pc|desktop|laptop|tv|speaker)|the ([a-z0-9]+(?: [a-z0-9]+)?) (speaker|tv|echo)|device (.+))$").captures(s)?;
    let device = if let Some(word) = c.get(3) {
        let det = c[2].to_lowercase();
        if det == "the" {
            word.as_str().to_string()
        } else {
            format!("{} {}", &c[2], word.as_str())
        }
    } else if let Some(w) = c.get(4) {
        format!("{} {}", w.as_str(), &c[5])
    } else {
        cap(&c, 6)
    };
    Some((cap(&c, 1), device))
}

/// "the kitchen speaker" → "kitchen speaker"; settings words are never devices ("switch spotify to dark mode").
fn device_name(raw: &str) -> Option<String> {
    let d = raw.trim();
    let d = re!(r"(?i)^the\s+").replace(d, "").trim().to_string();
    let d = re!(r"(?i)\s+device$").replace(&d, "").trim().to_string();
    if d.is_empty() || re!(r"(?i)\b(?:mode|theme|setting|settings|repeat|shuffle|loop)\b").is_match(&d) {
        return None;
    }
    Some(d)
}

// ── Rows (contract §5, table order) ─────────────────────────────────────────

fn g1_reconnect(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let named = re!(r"(?i)^(?:re ?connect|connect|re ?link|link|sign (?:back )?in(?: to)?|log (?:back )?in(?: to)?)(?: to)? spotify(?: again)?$").is_match(c);
    let bare = l.explicit && re!(r"(?i)^(?:re ?connect|connect|sign (?:back )?in(?: again)?|log (?:back )?in(?: again)?)$").is_match(c);
    (named || bare).then(|| (RECONNECT, json!({})))
}

fn g2_now_playing(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let hit = re!(
        r"(?i)^(?:(?:whats|what is) playing(?: right now| now)?|what (?:song|track|music|album|artist)(?: is|s)? (?:this|that|playing|on)(?: right now| now)?|whats this (?:song|track|album)|what (?:song|track) am i listening to|what (?:am i|are we) listening to(?: right now| now)?|who (?:sings|is singing|sang)(?: this| that)?(?: song| track)?|who is this by|now playing|is (?:this|it)(?: song| track)? (?:liked|saved|in (?:my )?(?:liked songs|library|favou?rites))|what album is (?:this|that)(?: from| on)?)$"
    )
    .is_match(c)
        || (l.explicit && re!(r"(?i)^(?:whats|what is)(?: on)?$").is_match(c));
    hit.then(|| ("spotify.now_playing", json!({})))
}

fn g3_queue(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let hit = re!(
        r"(?i)^(?:(?:what|which) (?:song|track) is (?:next|up next|coming up|coming next)|(?:whats|what is) (?:the )?next (?:song|track)|(?:whats|what is) (?:in|on) (?:the |my )?queue|(?:show|read|tell)(?: me)? (?:the |my )?queue|(?:whats|what is) (?:next|up next|coming up|coming next) (?:in|on) (?:the |my )?queue|(?:whats|what is) (?:the|my) queue)$"
    )
    .is_match(c)
        // Bare "what's next" is an agenda question (G47); it needs "spotify".
        || (l.explicit && re!(r"(?i)^(?:whats|what is) (?:next|up next|coming up|coming next)$").is_match(c));
    hit.then(|| ("spotify.get_queue", json!({})))
}

fn g4_recent(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if re!(r"(?i)^(?:what have i been (?:listening to|playing)(?: recently| lately)?|what did i (?:just )?(?:listen to|play)(?: recently| lately| today| earlier)?|(?:show(?: me)? |list )?(?:my )?recently played(?: songs| tracks)?)$").is_match(c) {
        return Some(("spotify.recently_played", json!({ "limit": 10 })));
    }
    let m = re!(r"(?i)^(?:(?:what were|show(?: me)?|list) )?(?:the |my )?last (\S+(?: \S+)?) (?:songs|tracks)(?: i (?:played|listened to|heard))?$").captures(c)?;
    let n = words_to_number(&m[1])?;
    Some(("spotify.recently_played", json!({ "limit": n })))
}

fn time_range(p: &str) -> Option<&'static str> {
    Some(match p.trim().to_lowercase().as_str() {
        "" => "medium_term",
        "this month" | "lately" | "recently" | "past few weeks" | "last few weeks" | "the past few weeks" | "this week" | "past month" | "the past month" | "last month"
        | "right now" | "these days" => "short_term",
        "this year" | "all time" | "of all time" | "ever" | "past year" | "the past year" | "last year" | "this past year" => "long_term",
        "last six months" | "past six months" | "the last six months" | "the past six months" | "last 6 months" | "past 6 months" => "medium_term",
        _ => return None,
    })
}

fn g5_top(l: &Line) -> Option<Hit> {
    let m = re!(r"(?i)^(?:(?:who|what) (?:are|were|is) |show(?: me)? |tell me |list |read(?: me)? )?my (?:top|most played|most listened(?: to)?|most streamed) (artists?|bands?|songs?|tracks?)(?: (.+))?$").captures(&l.core)?;
    let kind = if m[1].to_lowercase().starts_with("artist") || m[1].to_lowercase().starts_with("band") { "artists" } else { "tracks" };
    let range = time_range(&cap(&m, 2))?;
    Some(("spotify.top_items", json!({ "type": kind, "time_range": range })))
}

fn g7_playlists(l: &Line) -> Option<Hit> {
    re!(r"(?i)^(?:(?:(?:list|show|read|tell)(?: me)? (?:all )?|what are )?(?:all )?my (?:spotify )?playlists|(?:what|which) (?:spotify )?playlists do i have|do i have any playlists)$")
        .is_match(&l.core)
        .then(|| ("spotify.list_playlists", json!({})))
}

fn g8_playlist_tracks(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let m = re!(r"(?i)^(?:whats|what is|what songs are|what tracks are|which songs are) (?:in|on) (?:my |the )?playlist (?:called |named )?(.+)$")
        .captures(c)
        .or_else(|| re!(r"(?i)^(?:whats|what is|what songs are|what tracks are|which songs are) (?:in|on) (?:my |the )?(.+?) playlist$").captures(c))
        .or_else(|| re!(r"(?i)^(?:list|read|show|tell)(?: me)? (?:the |all the |all of the )?(?:songs|tracks) (?:in|on|from) (?:my |the )?(.+?)(?: playlist)?$").captures(c))
        .or_else(|| re!(r"(?i)^(?:read|show)(?: me)? (?:the|my) (.+?) playlist$").captures(c))?;
    let name = cap(&m, 1);
    if name.is_empty() || not_a_playlist(&name) {
        return None;
    }
    Some(("spotify.get_playlist_tracks", json!({ "playlist_name": name })))
}

/// G11 list: split on `,`/`;`; the last item also split on a leading/inner "and"; no comma ⇒ one query.
fn split_list(list: &str) -> Vec<String> {
    let list = list.trim();
    let mut items: Vec<String> = if list.contains([',', ';']) {
        let mut parts: Vec<String> = list.split([',', ';']).map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
        if let Some(last) = parts.pop() {
            if let Some(rest) = re!(r"(?i)^and\s+(.+)$").captures(&last) {
                parts.push(rest[1].trim().to_string());
            } else if let Some(i) = last.to_ascii_lowercase().rfind(" and ") {
                parts.push(last[..i].trim().to_string());
                parts.push(last[i + 5..].trim().to_string());
            } else {
                parts.push(last);
            }
        }
        parts
    } else {
        vec![list.to_string()]
    };
    items.retain(|s| !s.is_empty());
    items.iter().map(|s| cur(s)).collect()
}

/// G9–G12. Returns the hit and whether it carries an initial list (word cap 30 instead of 12).
fn g9_create(l: &Line) -> Option<(Hit, bool)> {
    let m = re!(r"(?i)^(?:create|make|start|build)(?: me| us)?(?: a| an)?(?: new)?(?: (public|private))?(?: spotify)? playlist(?: (called|named|titled))?[,:]? (.+)$").captures(&l.core_lite)?;
    // "make a playlist of tasks" is not Spotify: the name must be introduced or the line must say Spotify.
    if m.get(2).is_none() && !l.explicit {
        return None;
    }
    let public = m.get(1).is_some_and(|p| p.as_str().eq_ignore_ascii_case("public"));
    let rest = cap(&m, 3);
    let (name, items) = if let Some(a) = re!(r"(?i)^(.+?),? and (?:add|put|include|throw) (.+?)(?: (?:to|in|into|on) it)?$").captures(&rest) {
        (cap(&a, 1), split_list(&a[2]))
    } else if let Some(w) = re!(r"(?i)^(.+?),? with (.+)$").captures(&rest) {
        (cap(&w, 1), split_list(&w[2]))
    } else {
        (rest.clone(), Vec::new())
    };
    let name = flatten(name.trim_end_matches([',', ';']));
    if name.is_empty() {
        return None;
    }
    let has_list = !items.is_empty();
    Some((("spotify.create_playlist", json!({ "name": name, "public": public, "initial_queries": items })), has_list))
}

fn g9_create_hit(l: &Line) -> Option<Hit> {
    g9_create(l).map(|(hit, _)| hit)
}

fn g13_add_new(l: &Line) -> Option<Hit> {
    let m = re!(r"(?i)^(?:add|put|save|throw|stick) (.+) (?:to|in|into|on|onto) (?:a )?(?:brand )?new playlist(?: (?:called|named|titled))? (.+)$").captures(&l.core)?;
    Some(("spotify.add_to_playlist", json!({ "playlist_name": cap(&m, 2), "track_query": cur(&m[1]), "create": true })))
}

fn g14_add(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let with_playlist = re!(r"(?i)^(?:add|put|save|throw|stick) (.+?) (?:to|in|into|on|onto) (?:my|the|our) (.+?) playlist$")
        .captures(c)
        .or_else(|| re!(r"(?i)^(?:add|put|save|throw|stick) (.+?) (?:to|in|into|on|onto) (?:my |the |our )?playlist (?:called |named )?(.+)$").captures(c))
        .or_else(|| re!(r"(?i)^(?:add|put|save|throw|stick) (.+) (?:to|in|into|on|onto) (.+?) playlist$").captures(c));
    let (track, name) = match with_playlist {
        Some(m) => (cap(&m, 1), cap(&m, 2)),
        None => {
            // No "playlist" word: only for a clearly-meant song ("add this song to Late Night") or a Spotify line.
            let m = re!(r"(?i)^(?:add|put|save|throw|stick) (.+?) (?:to|in|into|onto) (?:my |the |our )?(.+)$").captures(c)?;
            let track = cap(&m, 1);
            if !(song_phrase(&track) || l.explicit) {
                return None;
            }
            (track, cap(&m, 2))
        }
    };
    if name.is_empty() || track.is_empty() || not_a_playlist(&name) {
        return None;
    }
    Some(("spotify.add_to_playlist", json!({ "playlist_name": name, "track_query": cur(&track), "create": false })))
}

fn g16_remove(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let m = re!(r"(?i)^(?:remove|delete|take|drop|pull|get rid of) (.+?) (?:off|from|out of)(?: of)? (?:my|the|our) (.+?) playlist$")
        .captures(c)
        .or_else(|| re!(r"(?i)^(?:remove|delete|take|drop|pull|get rid of) (.+?) (?:off|from|out of)(?: of)? (?:my |the |our )?playlist (?:called |named )?(.+)$").captures(c))
        .or_else(|| re!(r"(?i)^(?:remove|delete|take|drop|pull|get rid of) (.+) (?:off|from|out of)(?: of)? (.+?) playlist$").captures(c))?;
    let (track, name) = (cap(&m, 1), cap(&m, 2));
    if name.is_empty() || not_a_playlist(&name) {
        return None;
    }
    Some(("spotify.remove_from_playlist", json!({ "playlist_name": name, "track_query": cur(&track) })))
}

const LIKED_TARGET: &str = r"(?:my |the |our )?(?:liked songs|liked|likes|library|favou?rites|saved songs)(?: playlist)?";

fn g17_like(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if let Some(m) = re!(&format!(r"(?i)^(?:add|save|put|stick) (.+) (?:to|in|into|onto) {LIKED_TARGET}$")).captures(c) {
        return Some(("spotify.like_track", json!({ "track_query": cur(&m[1]) })));
    }
    if let Some(m) = re!(r"(?i)^(?:like|heart) (.+)$").captures(c) {
        let q = cap(&m, 1);
        // Only "this (song|track|one)", a song phrase, or a named song ("X by Y") — or any object
        // on a line that names Spotify. "like that one", "like the idea", "like a boss" ⇒ None.
        let this = re!(r"(?i)^this(?: song| track| one| tune)?$").is_match(&q);
        let named = re!(r"(?i)^\S.* by \S").is_match(&q);
        let stop = re!(r"(?i)^(?:a|an|i|you|we|they|he|she|its|what|how|when|where|why|thats|so|really|totally|me|him|her|them|us|to|if|my|your)\b").is_match(&q);
        if this || song_phrase(&q) || ((named || l.explicit) && !stop) {
            return Some(("spotify.like_track", json!({ "track_query": cur(&q) })));
        }
        return None;
    }
    // Bare "save it / save that / save this" usually means an idea or a file, not a song.
    let m = re!(r"(?i)^save (.+)$").captures(c)?;
    let q = cap(&m, 1);
    (song_phrase(&q) || l.explicit).then(|| ("spotify.like_track", json!({ "track_query": cur(&q) })))
}

fn g18_unlike(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let m = re!(r"(?i)^(?:unlike|unsave|unheart|un like|un save) (.+)$")
        .captures(c)
        .or_else(|| re!(&format!(r"(?i)^(?:remove|delete|take|drop) (.+) (?:from|off|out of) {LIKED_TARGET}$")).captures(c))?;
    Some(("spotify.unlike_track", json!({ "track_query": cur(&m[1]) })))
}

fn g19_queue(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let m = re!(r"(?i)^(?:add|put|throw|stick|slide) (.+) (?:to|in|into|on|onto) (?:the |my )?(?:queue|up next)$")
        .captures(c)
        .or_else(|| re!(r"(?i)^queue(?: up)? (.+)$").captures(c))
        .or_else(|| re!(r"(?i)^play (.+?) (?:up )?next$").captures(c))?;
    let q = cap(&m, 1);
    if q.is_empty() || matches!(q.to_lowercase().as_str(), "up" | "the" | "the next") {
        return None;
    }
    Some(("spotify.queue_add", json!({ "query": cur(&q) })))
}

fn g20_volume_to(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let m = re!(concat!(
        r"(?i)^(?:(?:set|turn|put|change|bring)(?: the)? )?(?:spotifys |spotify s |spotify |music |the music )?volume(?: on spotify)?(?: up| down)?(?: to| at)? ",
        num!(),
        r"(?: ?%| percent)?$"
    ))
    .captures(c)
    .or_else(|| re!(concat!(r"(?i)^(?:set|turn|put|bring)(?: the)? (?:spotify|music)(?: volume)?(?: up| down)? (?:to|at) ", num!(), r"(?: ?%| percent)?$")).captures(c))?;
    // Digits above 100 clamp ("volume 140" ⇒ 100); words are 0..=100 already.
    let n = m[1].parse::<u32>().ok().or_else(|| words_to_number(&m[1]))?;
    Some(("spotify.volume", json!({ "percent": n.min(100) })))
}

/// Words allowed between "turn" and "up"/"down" (ported from TS `GAP`).
macro_rules! gap {
    () => {
        r"(?:(?:it|that|this|the|my|gabagool|music|theme|song|track|volume|sound|audio|mode|spotify|a|bit|little|lot|tad|notch|way|all) ){0,4}"
    };
}

const VOLUME_WORDS: &str = "a an the it that this its s bit little tad touch notch notches couple lot lots more way much some so too just even slightly quite again \
make turn turned crank cranked pump bring jack kick tone raise lower increase decrease reduce boost louder quieter softer up down \
volume music song track sound audio tune tunes background of can you could would will get";
const TARGET_WORDS: [&str; 8] = ["gabagool", "theme", "spotify", "mode", "on", "in", "my", "please"];

/// G21/G22: TS `volume()` "bare line" rule, ported exactly (a cue owns gabagool/theme lines).
fn g21_volume_step(l: &Line) -> Option<Hit> {
    let t = l.lower.as_str();
    let up = re!(concat!(
        r"^(?:the )?gabagool (?:music |theme |mode )?up\b|\b(?:louder|crank\w*|boost|raise|increase|volume up|up the volume|more volume|(?:turn|pump|bring|jack|kick)\w* ",
        gap!(),
        r"up)\b"
    ))
    .is_match(t);
    let down = re!(concat!(
        r"^(?:the )?gabagool (?:music |theme |mode )?down\b|\b(?:quieter|softer|lower|decrease|reduce|volume down|less volume|(?:turn|bring|tone)\w* ",
        gap!(),
        r"down)\b"
    ))
    .is_match(t);
    if up == down {
        return None;
    }
    let steps: i32 = if up {
        if re!(r"\b(?:crank\w*|a lot|lots|way (?:up|louder|more)|much louder)\b").is_match(t) {
            2
        } else {
            1
        }
    } else {
        -1
    };
    let words: Vec<&str> = VOLUME_WORDS.split_whitespace().collect();
    let bare = t.split(' ').all(|w| words.contains(&w) || TARGET_WORDS.contains(&w));
    if re!(r"\bgabagool\b").is_match(t) || (bare && re!(r"\btheme\b").is_match(t)) || !bare {
        return None;
    }
    Some(("spotify.volume", json!({ "percent": format!("{:+}", 15 * steps) })))
}

fn g23_pause(l: &Line) -> Option<Hit> {
    // STOP_LEAD is removed before the pause rows only.
    let s = re!(r"(?i)^(?:(?:hold on|hang on|wait|no|nope|ok|okay|dude|yo|bro|man|whoa|woah|hey)[ ,]+)+").replace(&l.core, "");
    let s = s.trim();
    let hit = re!(
        r"(?i)^(?:(?:pause|stop|mute)(?: the)? spotify(?: music)?|(?:pause|stop)(?: the)? (?:music|song|track) on spotify|pause(?: it| that| this| playback| playing)?|(?:turn|switch|shut) (?:off(?: the)? spotify|(?:the )?spotify off)|(?:stop|quit) playing(?: the| my)? (?:music|songs?|spotify))$"
    )
    .is_match(s)
        || re!(
            r"(?i)^(?:(?:stop(?: playing)?|quit playing|kill|end|cut|turn off|turn of|shut off|switch off|mute|pause|silence)(?: the| that| this| my)? (?:music|theme|song|track|cue|soundtrack|audio|sound)|(?:turn|switch|shut)(?: the| that| this| my)? (?:music|theme|song|track|cue|soundtrack|audio|sound) off)$"
        )
        .is_match(s)
        // "spotify stop" / "stop on spotify": bare stops only when Spotify is named.
        || (l.explicit && re!(r"(?i)^(?:stop|mute|stop it|stop playing)$").is_match(s));
    hit.then(|| ("spotify.pause", json!({})))
}

const RESUME: &str = r"(?i)^(?:(?:resume|unpause|un pause)(?: the)?(?: music| song| track| spotify| playback| playing)?|(?:continue|keep) (?:playing|the music|the song|the track)|continue playing(?: the music| music| spotify)?|(?:start|turn)(?: the)? (?:music|spotify)(?: back)?(?: on)?|unmute(?: the)? (?:music|spotify|song|track|playback)|play(?: me)?(?: (?:the |some |my |more )?(?:music|spotify|songs?|tunes?|something|anything|stuff))?(?: again| back)?)$";

fn g24_resume(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if re!(RESUME).is_match(c) || (l.explicit && re!(r"(?i)^unmute$").is_match(c)) {
        return Some(("spotify.resume", json!({})));
    }
    let (rest, dev) = device_suffix(c)?;
    if re!(r"(?i)^(?:resume|unpause|continue|continue playing|keep playing)(?: the music| music| playback| spotify)?$").is_match(&rest) {
        return Some(("spotify.resume", json!({ "device_name": device_name(&dev)? })));
    }
    None
}

/// Returns `Some(("", Null))` to reject the whole line (count > 5).
fn g25_next(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if re!(r"(?i)^(?:(?:skip|next)(?: (?:it|this|that|the))?(?: (?:song|track|one|tune))?|(?:play|go to|skip to|jump to)(?: the)? next (?:song|track|one|tune))$").is_match(c) {
        return Some(("spotify.next", json!({})));
    }
    let m = re!(r"(?i)^(?:skip|next)(?: ahead)? (\S+(?: \S+)?) (?:songs|tracks|tunes)$").captures(c)?;
    let n = words_to_number(&m[1])?;
    if !(1..=5).contains(&n) {
        return Some(("", Value::Null));
    }
    Some(("spotify.next", json!({ "count": n })))
}

fn g26_previous(l: &Line) -> Option<Hit> {
    re!(
        r"(?i)^(?:(?:previous|prior)(?: (?:song|track|tune|one))?|last (?:song|track|tune)|(?:play|go to|skip to|go back to|jump to|back to)(?: the)? (?:previous|last|prior) (?:song|track|one|tune)|(?:go |skip |jump )?back (?:a|one|1) (?:song|track|tune))$"
    )
    .is_match(&l.core)
    .then(|| ("spotify.previous", json!({})))
}

fn g27_restart(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let hit = re!(
        r"(?i)^(?:restart (?:the |this |that )?(?:song|track|tune)|(?:start|play) (?:the|this|that) (?:song|track|tune) (?:over|again|from the (?:top|beginning|start))|(?:start|play) (?:this|it|that) (?:over|from the (?:top|beginning|start))|(?:go back to|back to|skip to|jump to) the (?:beginning|start) of (?:the|this) (?:song|track))$"
    )
    .is_match(c)
        || (l.explicit && re!(r"(?i)^(?:restart|start over)$").is_match(c));
    hit.then(|| ("spotify.restart_track", json!({})))
}

fn g28_seek_to(l: &Line) -> Option<Hit> {
    let m = re!(r"(?i)^(?:skip|go|jump|seek|fast ?forward|move|scrub|rewind|go back)(?: ahead| forward| back)? to (?:the )?(.+?)(?: mark| point)?$").captures(&l.core)?;
    let secs = parse_timestamp(&m[1])?;
    Some(("spotify.seek", json!({ "position_sec": secs })))
}

fn g29_seek_by(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if let Some(m) = re!(r"(?i)^(?:(?:skip|jump|seek|scrub|move) (?:ahead|forward)|go forward|fast ?forward)(?: by)?(?: (.+))?$").captures(c) {
        let secs = match m.get(1) {
            Some(t) => parse_timestamp(t.as_str())?,
            None => 30,
        };
        return Some(("spotify.seek", json!({ "offset_sec": secs })));
    }
    if let Some(m) = re!(r"(?i)^skip (.+ (?:seconds?|secs?|minutes?|mins?))$").captures(c) {
        return Some(("spotify.seek", json!({ "offset_sec": parse_timestamp(&m[1])? })));
    }
    if let Some(m) = re!(r"(?i)^(?:go|skip|jump|move|seek|scrub) back(?:wards)?(?: by)? (.+)$").captures(c) {
        return Some(("spotify.seek", json!({ "offset_sec": -(parse_timestamp(&m[1])? as i64) })));
    }
    let m = re!(r"(?i)^rewind(?: by)?(?: (.+))?$").captures(c)?;
    let secs = match m.get(1) {
        Some(t) => parse_timestamp(t.as_str())?,
        None => 15,
    };
    Some(("spotify.seek", json!({ "offset_sec": -(secs as i64) })))
}

fn g30_shuffle(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if re!(
        r"(?i)^(?:shuffle(?: on| mode on| it| this| the music| my music| my songs| my library| spotify)?|(?:turn|switch|put|flip) on (?:the )?shuffle(?: mode)?|(?:turn|switch|put|flip|set) (?:the )?shuffle(?: mode)? on|(?:enable|activate|start) (?:the )?shuffl(?:e|ing)(?: mode)?)$"
    )
    .is_match(c)
    {
        return Some(("spotify.shuffle", json!({ "state": true })));
    }
    re!(
        r"(?i)^(?:(?:shuffle|shuffling)(?: mode)? off|(?:turn|switch|put|flip) off (?:the )?shuffle(?: mode)?|(?:turn|switch|set) (?:the )?shuffle(?: mode)? off|(?:stop|quit) shuffling|unshuffle|un shuffle|disable shuffle|no (?:more )?shuffle)$"
    )
    .is_match(c)
    .then(|| ("spotify.shuffle", json!({ "state": false })))
}

fn g32_repeat(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if re!(r"(?i)^(?:(?:repeat|loop) (?:this|the|that)(?: current)? (?:song|track|tune|one)|(?:put|set|keep) (?:this|the|that|it)(?: song| track)? on (?:repeat|loop)|(?:repeat|loop) (?:song|track|one))$").is_match(c) {
        return Some(("spotify.repeat", json!({ "mode": "track" })));
    }
    if re!(
        r"(?i)^(?:(?:repeat|loop) (?:this|the|my) (?:playlist|album|queue)|repeat(?: mode)? on|(?:turn|switch|put|flip) on (?:the )?repeat(?: mode)?|(?:turn|switch|put|set) (?:the )?repeat(?: mode)? on|(?:enable|activate) (?:the )?repeat(?: mode)?|repeat all)$"
    )
    .is_match(c)
    {
        return Some(("spotify.repeat", json!({ "mode": "context" })));
    }
    re!(
        r"(?i)^(?:(?:repeat|loop)(?: mode)? off|(?:stop|quit) (?:repeating|looping)|(?:turn|switch|put|flip) off (?:the )?(?:repeat|loop)(?: mode)?|(?:turn|switch|set) (?:the )?(?:repeat|loop)(?: mode)? off|(?:disable|no) (?:repeat|repeating))$"
    )
    .is_match(c)
    .then(|| ("spotify.repeat", json!({ "mode": "off" })))
}

fn g35_transfer(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if let Some((rest, dev)) = device_suffix(c) {
        if re!(r"(?i)^(?:play|continue|keep playing|put|move)(?: (?:it|this|that|the music|music|spotify|playback))?$").is_match(&rest) {
            return Some(("spotify.transfer_device", json!({ "device_name": device_name(&dev)? })));
        }
    }
    // A music object lets any spoken name through ("transfer playback to Living Room").
    if let Some(m) = re!(r"(?i)^(?:move|switch|transfer|cast|shift|put)(?: the)? (?:music|playback|spotify|audio|song|sound)(?: playback)? (?:to|over to|onto|on) (.+)$").captures(c) {
        return Some(("spotify.transfer_device", json!({ "device_name": device_name(&m[1])? })));
    }
    // "switch it to my laptop": only with a device-shaped name.
    let m = re!(r"(?i)^(?:move|switch|transfer|shift) (?:it|this|that) (?:to|over to|onto) (.+)$").captures(c)?;
    let (_, dev) = device_suffix(&format!("x on {}", &m[1]))?;
    Some(("spotify.transfer_device", json!({ "device_name": device_name(&dev)? })))
}

fn g36_shuffle_playlist(l: &Line) -> Option<Hit> {
    let c = &l.core;
    let m = re!(r"(?i)^shuffle (?:my |the |all my )?(liked songs|likes|favou?rites|saved songs)$")
        .captures(c)
        .or_else(|| re!(r"(?i)^shuffle (?:my |the )?playlist (?:called |named )?(.+)$").captures(c))
        .or_else(|| re!(r"(?i)^shuffle (?:my |the )?(.+?) playlist$").captures(c))?;
    let name = cap(&m, 1);
    (!name.is_empty()).then(|| ("spotify.play", json!({ "playlist_name": name, "shuffle": true })))
}

/// "play …" that isn't music (TS NOT_MUSIC ∪ agents.rs NOT_MUSIC).
const NOT_MUSIC: &str = r"(?i)^(?:it|that|this|along|back|again|a game|games?|the game|chess|cards|pretend|nice|dead|dumb|catch|fair|ball|tag|hard to get|(?:the )?devils? advocate|devil|(?:a |the )?role|with|around|by ear|a trick|tricks)\b|\b(?:youtube|netflix|video|movie|film|twitch|game)\b";

/// G37–G45: the object of play / put on / throw on / listen to.
fn play_object(obj: &str, l: &Line) -> Option<Hit> {
    let (obj, device) = match device_suffix(&format!("x {obj}")) {
        Some((rest, dev)) => (rest.get(2..).unwrap_or("").to_string(), Some(device_name(&dev)?)),
        None => (obj.to_string(), None),
    };
    let obj = re!(r"(?i)^me\s+").replace(obj.trim(), "").trim().to_string();
    if obj.is_empty() {
        return None;
    }
    if !l.explicit && (re!(NOT_MUSIC).is_match(&obj) || l.words > 8) {
        return None;
    }
    let mut args = Map::new();
    if re!(r"(?i)^(?:the |some |my |more )?(?:music|spotify|songs?|tunes?|something|anything|stuff)(?: again| back)?$").is_match(&obj) {
        if let Some(d) = device {
            args.insert("device_name".into(), json!(d));
        }
        return Some(("spotify.resume", Value::Object(args)));
    }
    let pick = |r: &regex::Regex| r.captures(&obj).map(|c| cap(&c, 1)).filter(|s| !s.is_empty());
    if let Some(name) = pick(re!(r"(?i)^(?:my |the |all my )?(liked songs|likes|favou?rites|saved songs)$"))
        .or_else(|| pick(re!(r"(?i)^(?:my |the )?playlist (?:called |named |titled )?(.+)$")))
        .or_else(|| pick(re!(r"(?i)^(?:my |the )?(.+?) playlist$")))
    {
        args.insert("playlist_name".into(), json!(name));
    } else if let Some(q) = pick(re!(r"(?i)^(?:the )?album (?:called |named |titled )?(.+)$")).or_else(|| pick(re!(r"(?i)^(?:the )?(.+?) album$"))) {
        args.insert("query".into(), json!(q));
        args.insert("type".into(), json!("album"));
    } else if let Some(q) =
        pick(re!(r"(?i)^(?:the )?(?:artist|band|singer|rapper) (.+)$")).or_else(|| pick(re!(r"(?i)^(?:some )?(?:songs|music|something|stuff|tracks|anything|more) (?:by|from) (.+)$")))
    {
        args.insert("query".into(), json!(q));
        args.insert("type".into(), json!("artist"));
    } else if let Some(q) = pick(re!(r"(?i)^(?:the )?(?:song|track) (?:called |named |titled )?(.+)$")) {
        args.insert("query".into(), json!(q));
        args.insert("type".into(), json!("track"));
    } else if let Some(q) = pick(re!(r"(?i)^some (.+)$")) {
        args.insert("query".into(), json!(q));
        args.insert("prefer_playlist".into(), json!(true));
    } else {
        args.insert("query".into(), json!(obj));
    }
    if let Some(d) = device {
        args.insert("device_name".into(), json!(d));
    }
    Some(("spotify.play", Value::Object(args)))
}

fn g37_play(l: &Line) -> Option<Hit> {
    let c = &l.core;
    if let Some(m) = re!(r"(?i)^play (.+)$").captures(c) {
        return play_object(&m[1], l);
    }
    // "put on / throw on / listen to" only when the line names Spotify ("put on a jacket").
    if !l.explicit {
        return None;
    }
    let m = re!(r"(?i)^(?:put on|throw on|listen to|put|throw) (.+)$").captures(c)?;
    play_object(&m[1], l)
}

/// Every row in table order; first match wins.
fn rows(l: &Line) -> Option<Hit> {
    const ROWS: [fn(&Line) -> Option<Hit>; 28] = [
        g1_reconnect,
        g2_now_playing,
        g3_queue,
        g4_recent,
        g5_top,
        g7_playlists,
        g8_playlist_tracks,
        g9_create_hit,
        g13_add_new,
        g14_add,
        g16_remove,
        g17_like,
        g18_unlike,
        g19_queue,
        g20_volume_to,
        g21_volume_step,
        g23_pause,
        g24_resume,
        g25_next,
        g26_previous,
        g27_restart,
        g28_seek_to,
        g29_seek_by,
        g30_shuffle,
        g32_repeat,
        g35_transfer,
        g36_shuffle_playlist,
        g37_play,
    ];
    ROWS.iter().find_map(|row| row(l))
}

/// Utterance → intent (contract §4.1 preprocessing, §5 rows). None for anything not in §5.
pub fn parse(text: &str, os_name: &str) -> Option<SpotifyIntent> {
    let addressed = super::routing::strip_address(text, os_name);
    let lite_line = strip_tail(&lite(&addressed), os_name);
    if lite_line.is_empty() {
        return None;
    }
    let flat = flatten(&lite_line);
    let lower = flat.to_lowercase();
    let explicit = re!(r"\bspotify\b").is_match(&lower);
    let core_lite = strip_affixes(&lite_line);
    let line = Line { core: flatten(&core_lite), core_lite, lower, explicit, words: flat.split_whitespace().count() };
    if line.core.is_empty() {
        return None;
    }
    let (tool, args) = if !explicit && line.words > 12 {
        // Long lines only for create_playlist with an initial list (cap 30).
        match g9_create(&line) {
            Some((hit, true)) if line.words <= 30 => hit,
            _ => return None,
        }
    } else {
        rows(&line)?
    };
    if tool.is_empty() {
        return None;
    }
    let args = normalize_args(tool, &args).ok()?;
    Some(SpotifyIntent { tool: tool.to_string(), summary: summary_for(tool, &args), mutating: is_write_tool(tool), explicit, args })
}

/// Cue precedence on the Rust path (mirror of TS `cueOwnsVolume`, critic #24): while a Gabagool
/// cue plays, a volume line that names neither Spotify nor music belongs to the cue / Tony, so
/// `os_turn` must not offer `spotify.volume` (grammar or router) for it.
pub fn cue_owns_volume(text: &str, os_name: &str, cue_playing: bool) -> bool {
    if !cue_playing {
        return false;
    }
    let lower = text.to_lowercase();
    if re!(r"\b(?:spotify|music)\b").is_match(&lower) {
        return false;
    }
    parse(text, os_name).is_some_and(|i| i.tool == "spotify.volume") || re!(r"\b(?:volume|louder|quieter|softer)\b").is_match(&lower)
}

// ── Argument normalisation (§4.4) ───────────────────────────────────────────

fn text(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match args.get(*k)? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn boolean(args: &Value, key: &str) -> Option<bool> {
    match args.get(key)? {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_f64().map(|f| f != 0.0),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" | "yes" | "on" | "1" | "enabled" => Some(true),
            "false" | "no" | "off" | "0" | "disabled" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn integer(args: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| match args.get(*k)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.round() as i64)),
        Value::String(s) => {
            let s = s.trim();
            s.strip_prefix('+').unwrap_or(s).parse::<i64>().ok().or_else(|| words_to_number(s).map(i64::from))
        }
        _ => None,
    })
}

fn spotify_uri(args: &Value, kinds: &[&str]) -> Option<String> {
    let u = text(args, &["uri"])?;
    let kind = u.strip_prefix("spotify:")?.split(':').next()?;
    (super::spotify_resolve::valid_play_uri(&u) && kinds.contains(&kind)).then_some(u)
}

const NEED_PLAYLIST: &str = "I need a playlist name for that.";

/// Validate/coerce tool args from any caller (grammar, LLM router, TS). Err = a speakable sentence.
pub fn normalize_args(tool: &str, args: &Value) -> Result<Value, String> {
    let tool = canonical(tool);
    let mut out = Map::new();
    let mut put = |k: &str, v: Value| {
        out.insert(k.to_string(), v);
    };
    match tool {
        RECONNECT => {}
        "spotify.pause" | "spotify.previous" | "spotify.restart_track" | "spotify.get_queue" | "spotify.now_playing" | "spotify.list_playlists" => {}
        "spotify.play" => {
            if let Some(q) = text(args, &["query"]) {
                put("query", json!(q));
            }
            if let Some(k) = text(args, &["type", "kind"]).and_then(|k| super::spotify_resolve::SearchKind::parse(&k)) {
                put("type", json!(k.as_str()));
            }
            if let Some(p) = text(args, &["playlist_name"]) {
                put("playlist_name", json!(p));
            }
            if let Some(u) = spotify_uri(args, &["track", "album", "artist", "playlist", "episode"]) {
                put("uri", json!(u));
            }
            if let Some(d) = text(args, &["device_name"]) {
                put("device_name", json!(d));
            }
            for key in ["shuffle", "prefer_playlist"] {
                if let Some(b) = boolean(args, key) {
                    put(key, json!(b));
                }
            }
        }
        "spotify.next" => put("count", json!(integer(args, &["count"]).unwrap_or(1).clamp(1, 5))),
        "spotify.resume" => {
            if let Some(d) = text(args, &["device_name"]) {
                put("device_name", json!(d));
            }
        }
        "spotify.seek" => {
            let position = match args.get("position_sec") {
                Some(Value::String(s)) => parse_timestamp(s).map(i64::from).or_else(|| integer(args, &["position_sec"])),
                _ => integer(args, &["position_sec"]),
            }
            .filter(|n| *n >= 0);
            let offset = match args.get("offset_sec") {
                Some(Value::String(s)) => {
                    let s = s.trim();
                    let (sign, body) = match s.strip_prefix('-') {
                        Some(b) => (-1, b),
                        None => (1, s.strip_prefix('+').unwrap_or(s)),
                    };
                    parse_timestamp(body).map(|n| sign * i64::from(n)).or_else(|| integer(args, &["offset_sec"]))
                }
                _ => integer(args, &["offset_sec"]),
            };
            match (position, offset) {
                (Some(p), None) => put("position_sec", json!(p.min(u32::MAX as i64))),
                (None, Some(o)) if o != 0 => put("offset_sec", json!(o.clamp(i32::MIN as i64, i32::MAX as i64))),
                _ => return Err("Tell me where to jump, like \"skip to 1:30\".".into()),
            }
        }
        "spotify.volume" => {
            const NEED: &str = "Tell me a volume level, like \"volume 40\".";
            let raw = ["percent", "volume", "level"].iter().find_map(|k| args.get(*k)).ok_or(NEED)?;
            match raw {
                Value::Number(n) => put("percent", json!(n.as_f64().ok_or(NEED)?.round().clamp(0.0, 100.0) as u8)),
                Value::String(s) => {
                    let s = s.trim().trim_end_matches('%').trim();
                    let s = s.strip_suffix("percent").unwrap_or(s).trim();
                    if let Some(sign) = s.chars().next().filter(|c| *c == '+' || *c == '-') {
                        let n = words_to_number(s[1..].trim()).or_else(|| s[1..].trim().parse::<u32>().ok()).filter(|n| *n > 0).ok_or(NEED)?;
                        put("percent", json!(format!("{sign}{}", n.min(100))));
                    } else {
                        let n = words_to_number(s).or_else(|| s.parse::<u32>().ok()).ok_or(NEED)?;
                        put("percent", json!(n.min(100)));
                    }
                }
                _ => return Err(NEED.into()),
            }
        }
        "spotify.shuffle" => put("state", json!(boolean(args, "state").unwrap_or(true))),
        "spotify.repeat" => {
            let mode = match text(args, &["mode", "state"]).map(|m| m.to_lowercase()).as_deref() {
                None | Some("context" | "on" | "playlist" | "album" | "all" | "true") => "context",
                Some("track" | "song" | "one" | "this song") => "track",
                Some("off" | "false" | "none" | "no") => "off",
                Some(_) => return Err("Say \"repeat on\", \"repeat this song\" or \"repeat off\".".into()),
            };
            put("mode", json!(mode));
        }
        "spotify.transfer_device" => put("device_name", json!(text(args, &["device_name", "device"]).ok_or("Which device should I move Spotify to?")?)),
        "spotify.queue_add" => {
            let uri = spotify_uri(args, &["track", "episode"]);
            let query = text(args, &["query", "track_query"]);
            if uri.is_none() && query.is_none() {
                return Err("What should I add to the queue?".into());
            }
            if let Some(q) = query {
                put("query", json!(q));
            }
            if let Some(u) = uri {
                put("uri", json!(u));
            }
        }
        "spotify.get_playlist_tracks" => put("playlist_name", json!(text(args, &["playlist_name", "playlist", "name"]).ok_or(NEED_PLAYLIST)?)),
        "spotify.create_playlist" => {
            let name: String = text(args, &["name", "playlist_name"]).ok_or("I need a name for the new playlist.")?.chars().take(100).collect();
            put("name", json!(name.trim()));
            if let Some(d) = text(args, &["description"]) {
                put("description", json!(d));
            }
            put("public", json!(boolean(args, "public").unwrap_or(false)));
            let queries: Vec<String> = match args.get("initial_queries") {
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
                Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
                _ => Vec::new(),
            };
            put("initial_queries", json!(queries.into_iter().take(20).collect::<Vec<_>>()));
        }
        "spotify.add_to_playlist" | "spotify.remove_from_playlist" => {
            put("playlist_name", json!(text(args, &["playlist_name", "playlist"]).ok_or(NEED_PLAYLIST)?));
            put("track_query", json!(text(args, &["track_query", "query"]).unwrap_or_else(|| "current".into())));
            if tool == "spotify.add_to_playlist" {
                put("create", json!(boolean(args, "create").unwrap_or(false)));
            }
        }
        "spotify.like_track" | "spotify.unlike_track" => put("track_query", json!(text(args, &["track_query", "query"]).unwrap_or_else(|| "current".into()))),
        "spotify.top_items" => {
            let kind = match text(args, &["type", "kind"]).map(|t| t.to_lowercase()).as_deref() {
                Some("artists" | "artist" | "bands" | "band") => "artists",
                _ => "tracks",
            };
            let range = match text(args, &["time_range", "range"]).map(|t| t.to_lowercase()).as_deref() {
                Some("short_term" | "short" | "month" | "this month" | "recent" | "lately" | "4 weeks") => "short_term",
                Some("long_term" | "long" | "year" | "all time" | "ever" | "this year") => "long_term",
                _ => "medium_term",
            };
            put("type", json!(kind));
            put("time_range", json!(range));
            put("limit", json!(integer(args, &["limit"]).unwrap_or(5).clamp(1, 10)));
        }
        "spotify.recently_played" => put("limit", json!(integer(args, &["limit"]).unwrap_or(10).clamp(1, 50))),
        _ => return Err("unknown Spotify tool".into()),
    }
    Ok(Value::Object(out))
}

// ── Summaries (§5 end) ──────────────────────────────────────────────────────

/// No URIs or 22-char IDs in card text, whatever a router put in the args.
fn scrub(s: &str) -> String {
    let s = re!(r"spotify:\S+").replace_all(s, "this");
    re!(r"\b[0-9A-Za-z]{22}\b").replace_all(&s, "this").trim().to_string()
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn track_words(args: &Value) -> String {
    match arg(args, "track_query").or_else(|| arg(args, "query")) {
        Some(q) if !is_current(q) => scrub(q),
        _ => "this song".into(),
    }
}

fn mmss(secs: u64) -> String {
    format!("{}:{:02}", secs / 60, secs % 60)
}

/// Card/read-back text for any (canonical name, normalized args); same templates as `SpotifyIntent.summary`.
pub fn summary_for(name: &str, args: &Value) -> String {
    let device = arg(args, "device_name").map(scrub);
    let s = match canonical(name) {
        RECONNECT => "Reconnect Spotify".to_string(),
        "spotify.play" => {
            let what = arg(args, "playlist_name").or_else(|| arg(args, "query")).map(scrub).filter(|s| !s.is_empty());
            let verb = if args.get("shuffle").and_then(Value::as_bool) == Some(true) { "Shuffle" } else { "Play" };
            match (what, args.get("uri").is_some()) {
                (Some(w), _) => format!("{verb} {w} on {}", device.as_deref().unwrap_or("Spotify")),
                (None, true) => format!("{verb} this on Spotify"),
                (None, false) => "Resume Spotify".into(),
            }
        }
        "spotify.pause" => "Pause Spotify".into(),
        "spotify.resume" => match device {
            Some(d) => format!("Resume Spotify on {d}"),
            None => "Resume Spotify".into(),
        },
        "spotify.next" => match args.get("count").and_then(Value::as_u64) {
            Some(n) if n > 1 => format!("Skip {n} tracks"),
            _ => "Skip to the next track".into(),
        },
        "spotify.previous" => "Go back to the previous track".into(),
        "spotify.restart_track" => "Restart the song".into(),
        "spotify.seek" => match (args.get("position_sec").and_then(Value::as_u64), args.get("offset_sec").and_then(Value::as_i64)) {
            (Some(p), _) => format!("Jump to {}", mmss(p)),
            (None, Some(o)) if o < 0 => format!("Go back {} seconds", -o),
            (None, Some(o)) => format!("Skip ahead {o} seconds"),
            _ => "Jump in the song".into(),
        },
        "spotify.volume" => match args.get("percent") {
            Some(Value::String(r)) if r.starts_with('+') => format!("Turn Spotify up {}%", &r[1..]),
            Some(Value::String(r)) if r.starts_with('-') => format!("Turn Spotify down {}%", &r[1..]),
            Some(v) => format!("Set Spotify volume to {}%", v.as_u64().unwrap_or(0)),
            None => "Change Spotify volume".into(),
        },
        "spotify.shuffle" => (if args.get("state").and_then(Value::as_bool) == Some(false) { "Turn shuffle off" } else { "Turn shuffle on" }).to_string(),
        "spotify.repeat" => match arg(args, "mode") {
            Some("track") => "Repeat this song".into(),
            Some("off") => "Turn repeat off".into(),
            _ => "Turn repeat on".into(),
        },
        "spotify.transfer_device" => format!("Move Spotify to {}", device.as_deref().unwrap_or("another device")),
        "spotify.queue_add" => match arg(args, "query") {
            Some(q) if !is_current(q) => format!("Queue {}", scrub(q)),
            Some(_) => "Queue this song".into(),
            None => "Queue this track".into(),
        },
        "spotify.create_playlist" => format!("Create the playlist {}", arg(args, "name").map(scrub).unwrap_or_default()),
        "spotify.add_to_playlist" => format!("Add {} to your {} playlist", track_words(args), arg(args, "playlist_name").map(scrub).unwrap_or_default()),
        "spotify.remove_from_playlist" => format!("Remove {} from your {} playlist", track_words(args), arg(args, "playlist_name").map(scrub).unwrap_or_default()),
        "spotify.like_track" => format!("Like {}", track_words(args)),
        "spotify.unlike_track" => format!("Unlike {}", track_words(args)),
        "spotify.now_playing" => "Check what's playing on Spotify".into(),
        "spotify.get_queue" => "Read the Spotify queue".into(),
        "spotify.recently_played" => "List your recently played songs".into(),
        "spotify.top_items" => format!("List your top {}", if arg(args, "type") == Some("artists") { "artists" } else { "songs" }),
        "spotify.list_playlists" => "List your playlists".into(),
        "spotify.get_playlist_tracks" => format!("List the songs in your {} playlist", arg(args, "playlist_name").map(scrub).unwrap_or_default()),
        other => format!("Run {other}"),
    };
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// IPC (pure, no gate, no network): `spotify_parse { text, osName? } -> SpotifyIntent | null`.
/// Async: Tauri 2 runs sync commands on the main thread, and this runs on every non-OS line.
#[tauri::command(async)]
pub async fn spotify_parse(text: String, os_name: Option<String>) -> Option<SpotifyIntent> {
    parse(&text, os_name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("Tony"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Option<SpotifyIntent> {
        parse(text, "Tony")
    }

    /// (input, tool, args) — args after normalize_args (defaults filled).
    fn expect(rows: &[(&str, &str, Value)]) {
        for (input, tool, args) in rows {
            let got = p(input).unwrap_or_else(|| panic!("{input:?} ⇒ None, wanted {tool}"));
            assert_eq!(got.tool, *tool, "{input:?}");
            assert_eq!(got.args, *args, "{input:?}");
            assert_eq!(got.mutating, is_write_tool(tool), "{input:?}");
            assert_eq!(got.explicit, input.to_lowercase().contains("spotify"), "{input:?} explicit");
        }
    }

    fn none(rows: &[&str]) {
        for input in rows {
            assert_eq!(p(input), None, "{input:?} should not parse");
        }
    }

    #[test]
    fn g01_reconnect() {
        expect(&[("reconnect spotify", RECONNECT, json!({})), ("sign in to spotify again", RECONNECT, json!({})), ("connect spotify", RECONNECT, json!({}))]);
        assert!(!p("reconnect spotify").unwrap().mutating);
        assert_eq!(p("reconnect spotify").unwrap().summary, "Reconnect Spotify");
    }

    #[test]
    fn g02_now_playing() {
        let e = json!({});
        expect(&[
            ("what's playing", "spotify.now_playing", e.clone()),
            ("what song is this", "spotify.now_playing", e.clone()),
            ("who sings this", "spotify.now_playing", e.clone()),
            ("what am I listening to", "spotify.now_playing", e.clone()),
            ("now playing", "spotify.now_playing", e.clone()),
            ("what's on spotify", "spotify.now_playing", e.clone()),
            ("is this song liked", "spotify.now_playing", e.clone()),
            ("is this in my liked songs", "spotify.now_playing", e.clone()),
            ("what album is this", "spotify.now_playing", e),
        ]);
    }

    #[test]
    fn g03_queue() {
        let e = json!({});
        expect(&[
            ("what song is next", "spotify.get_queue", e.clone()),
            ("what's the next song", "spotify.get_queue", e.clone()),
            ("what's next on spotify", "spotify.get_queue", e.clone()),
            ("what's up next on spotify", "spotify.get_queue", e.clone()),
            ("what's in the queue", "spotify.get_queue", e.clone()),
            ("what's in my queue", "spotify.get_queue", e.clone()),
            ("show my queue", "spotify.get_queue", e.clone()),
            ("what's coming up on spotify", "spotify.get_queue", e),
        ]);
        none(&["what's next", "what's up next"]);
    }

    #[test]
    fn g04_recently_played() {
        expect(&[
            ("what have I been listening to", "spotify.recently_played", json!({"limit": 10})),
            ("recently played", "spotify.recently_played", json!({"limit": 10})),
            ("what did I listen to recently", "spotify.recently_played", json!({"limit": 10})),
            ("last 5 songs I played", "spotify.recently_played", json!({"limit": 5})),
        ]);
    }

    #[test]
    fn g05_g06_top_items() {
        expect(&[
            ("my top artists", "spotify.top_items", json!({"type": "artists", "time_range": "medium_term", "limit": 5})),
            ("who are my top artists this month", "spotify.top_items", json!({"type": "artists", "time_range": "short_term", "limit": 5})),
            ("what are my top songs", "spotify.top_items", json!({"type": "tracks", "time_range": "medium_term", "limit": 5})),
            ("my most played tracks of all time", "spotify.top_items", json!({"type": "tracks", "time_range": "long_term", "limit": 5})),
            ("my top songs this year", "spotify.top_items", json!({"type": "tracks", "time_range": "long_term", "limit": 5})),
            ("my top artists lately", "spotify.top_items", json!({"type": "artists", "time_range": "short_term", "limit": 5})),
        ]);
    }

    #[test]
    fn g07_list_playlists() {
        let e = json!({});
        expect(&[
            ("my playlists", "spotify.list_playlists", e.clone()),
            ("list my playlists", "spotify.list_playlists", e.clone()),
            ("what playlists do I have", "spotify.list_playlists", e.clone()),
            ("show my spotify playlists", "spotify.list_playlists", e),
        ]);
    }

    #[test]
    fn g08_playlist_tracks() {
        let a = json!({"playlist_name": "Late Night"});
        expect(&[
            ("what's in my Late Night playlist", "spotify.get_playlist_tracks", a.clone()),
            ("what songs are on my Late Night playlist", "spotify.get_playlist_tracks", a.clone()),
            ("read me the Late Night playlist", "spotify.get_playlist_tracks", a.clone()),
            ("list the songs in Late Night playlist", "spotify.get_playlist_tracks", a),
        ]);
    }

    #[test]
    fn g09_to_g12_create_playlist() {
        let road = json!({"name": "Road Trip", "public": false, "initial_queries": []});
        expect(&[
            ("create a playlist called Road Trip", "spotify.create_playlist", road.clone()),
            ("make a new playlist named Road Trip", "spotify.create_playlist", road.clone()),
            ("create a playlist titled Road Trip", "spotify.create_playlist", road.clone()),
            ("create a new spotify playlist Road Trip", "spotify.create_playlist", road),
            ("make a public playlist called Road Trip", "spotify.create_playlist", json!({"name": "Road Trip", "public": true, "initial_queries": []})),
            (
                "create a playlist called Road Trip with Tell Me by Groove Theory, Erra and Bilmuri",
                "spotify.create_playlist",
                json!({"name": "Road Trip", "public": false, "initial_queries": ["Tell Me by Groove Theory", "Erra", "Bilmuri"]}),
            ),
            (
                "create a playlist called Road Trip with Tell Me, Erra, and Bilmuri",
                "spotify.create_playlist",
                json!({"name": "Road Trip", "public": false, "initial_queries": ["Tell Me", "Erra", "Bilmuri"]}),
            ),
            ("create a playlist called Road Trip with Simon and Garfunkel", "spotify.create_playlist", json!({"name": "Road Trip", "public": false, "initial_queries": ["Simon and Garfunkel"]})),
            ("create a playlist called Road Trip and add this song", "spotify.create_playlist", json!({"name": "Road Trip", "public": false, "initial_queries": ["current"]})),
            ("make a playlist called Road Trip with this song", "spotify.create_playlist", json!({"name": "Road Trip", "public": false, "initial_queries": ["current"]})),
        ]);
        none(&["make a playlist of tasks"]);
        assert_eq!(p("create a playlist called Road Trip").unwrap().summary, "Create the playlist Road Trip");
    }

    #[test]
    fn g13_add_to_new_playlist() {
        let a = json!({"playlist_name": "Road Trip", "track_query": "current", "create": true});
        expect(&[("add this song to a new playlist called Road Trip", "spotify.add_to_playlist", a.clone()), ("put this in a new playlist Road Trip", "spotify.add_to_playlist", a)]);
    }

    #[test]
    fn g14_g15_add_to_playlist() {
        let a = json!({"playlist_name": "Late Night", "track_query": "current", "create": false});
        expect(&[
            ("add this song to my Late Night playlist", "spotify.add_to_playlist", a.clone()),
            ("add this to Late Night playlist", "spotify.add_to_playlist", a.clone()),
            ("save this track to my Late Night playlist", "spotify.add_to_playlist", a.clone()),
            ("put this in my Late Night playlist", "spotify.add_to_playlist", a.clone()),
            ("add it to the Late Night playlist on spotify", "spotify.add_to_playlist", a.clone()),
            ("add this song to Late Night", "spotify.add_to_playlist", a),
            ("add Tell Me by Groove Theory to my Late Night playlist", "spotify.add_to_playlist", json!({"playlist_name": "Late Night", "track_query": "Tell Me by Groove Theory", "create": false})),
            ("add Back to Black to my Late Night playlist", "spotify.add_to_playlist", json!({"playlist_name": "Late Night", "track_query": "Back to Black", "create": false})),
        ]);
        assert_eq!(p("add this song to my Late Night playlist").unwrap().summary, "Add this song to your Late Night playlist");
        assert_eq!(p("add Tell Me to my Late Night playlist").unwrap().summary, "Add Tell Me to your Late Night playlist");
        // Without "playlist" a non-song object never becomes a playlist add.
        none(&["add milk to my shopping list", "add it to my calendar"]);
    }

    #[test]
    fn g16_remove_from_playlist() {
        expect(&[
            ("remove this song from my Late Night playlist", "spotify.remove_from_playlist", json!({"playlist_name": "Late Night", "track_query": "current"})),
            ("take this off my Late Night playlist", "spotify.remove_from_playlist", json!({"playlist_name": "Late Night", "track_query": "current"})),
            ("delete Tell Me from the Late Night playlist", "spotify.remove_from_playlist", json!({"playlist_name": "Late Night", "track_query": "Tell Me"})),
        ]);
        assert_eq!(p("delete Tell Me from the Late Night playlist").unwrap().summary, "Remove Tell Me from your Late Night playlist");
    }

    #[test]
    fn g17_like() {
        let c = json!({"track_query": "current"});
        expect(&[
            ("add this to my liked songs", "spotify.like_track", c.clone()),
            ("add this to my favorites", "spotify.like_track", c.clone()),
            ("save this to my library", "spotify.like_track", c.clone()),
            ("like this song", "spotify.like_track", c.clone()),
            ("like this", "spotify.like_track", c.clone()),
            ("save this song", "spotify.like_track", c.clone()),
            ("heart this track", "spotify.like_track", c),
            ("like Tell Me by Groove Theory", "spotify.like_track", json!({"track_query": "Tell Me by Groove Theory"})),
        ]);
        assert_eq!(p("like this song").unwrap().summary, "Like this song");
        none(&["I like this", "I love this song", "do it like this", "like a boss", "save the file"]);
        // Bare pronouns / free text are ideas, files or opinions — never a silent like.
        none(&["save that", "save it", "save this", "like that one", "like the idea", "like it", "heart that", "save my work"]);
        expect(&[
            ("like this one", "spotify.like_track", json!({"track_query": "current"})),
            ("save that song", "spotify.like_track", json!({"track_query": "current"})),
            ("like the Middle by Jimmy Eat World", "spotify.like_track", json!({"track_query": "the Middle by Jimmy Eat World"})),
            ("save this on spotify", "spotify.like_track", json!({"track_query": "current"})),
        ]);
    }

    #[test]
    fn cue_owns_bare_volume_lines() {
        for t in ["volume 30", "set the volume to 30", "volume up", "hey tony, volume 40"] {
            assert!(cue_owns_volume(t, "Tony", true), "{t}");
            assert!(!cue_owns_volume(t, "Tony", false), "{t} (no cue)");
        }
        for t in ["spotify volume 30", "music volume 30", "turn the music to 40", "pause the music", "what's playing"] {
            assert!(!cue_owns_volume(t, "Tony", true), "{t}");
        }
    }

    #[test]
    fn g18_unlike() {
        let c = json!({"track_query": "current"});
        expect(&[
            ("unlike this song", "spotify.unlike_track", c.clone()),
            ("remove this from my liked songs", "spotify.unlike_track", c.clone()),
            ("unsave this track", "spotify.unlike_track", c),
        ]);
    }

    #[test]
    fn g19_queue_add() {
        expect(&[
            ("add Tell Me to the queue", "spotify.queue_add", json!({"query": "Tell Me"})),
            ("queue Tell Me by Groove Theory", "spotify.queue_add", json!({"query": "Tell Me by Groove Theory"})),
            ("queue up Bill Murray", "spotify.queue_add", json!({"query": "Bill Murray"})),
            ("play Tell Me next", "spotify.queue_add", json!({"query": "Tell Me"})),
            ("add this to the queue", "spotify.queue_add", json!({"query": "current"})),
            ("queue this song", "spotify.queue_add", json!({"query": "current"})),
        ]);
        assert_eq!(p("queue up Bill Murray").unwrap().summary, "Queue Bill Murray");
        assert_eq!(p("queue this song").unwrap().summary, "Queue this song");
        none(&["queue up"]);
    }

    #[test]
    fn g20_volume_absolute() {
        let a = json!({"percent": 40});
        expect(&[
            ("volume 40", "spotify.volume", a.clone()),
            ("set the volume to forty", "spotify.volume", a.clone()),
            ("spotify volume 40 percent", "spotify.volume", a.clone()),
            ("turn the music to 40", "spotify.volume", a),
            ("volume 140", "spotify.volume", json!({"percent": 100})),
            ("volume fifty five", "spotify.volume", json!({"percent": 55})),
        ]);
        assert_eq!(p("volume 40").unwrap().summary, "Set Spotify volume to 40%");
    }

    #[test]
    fn g21_g22_volume_relative() {
        let up = json!({"percent": "+15"});
        let big = json!({"percent": "+30"});
        let down = json!({"percent": "-15"});
        expect(&[
            ("turn it up", "spotify.volume", up.clone()),
            ("louder", "spotify.volume", up.clone()),
            ("turn spotify up", "spotify.volume", up.clone()),
            ("make it a little louder", "spotify.volume", up.clone()),
            ("volume up", "spotify.volume", up),
            ("crank it", "spotify.volume", big.clone()),
            ("way louder", "spotify.volume", big),
            ("turn it down", "spotify.volume", down.clone()),
            ("quieter", "spotify.volume", down.clone()),
            ("volume down", "spotify.volume", down.clone()),
            ("turn spotify down a bit", "spotify.volume", down),
        ]);
        // The bare-line rule: anything else in the line ⇒ not a volume command; gabagool/theme ⇒ the cue's.
        none(&["lower the price", "reduce spotify api calls", "turn the gabagool theme up", "turn the theme down", "raise the bar for the team"]);
    }

    #[test]
    fn g23_pause() {
        let e = json!({});
        expect(&[
            ("pause", "spotify.pause", e.clone()),
            ("pause it", "spotify.pause", e.clone()),
            ("pause the music", "spotify.pause", e.clone()),
            ("stop the music", "spotify.pause", e.clone()),
            ("hold on, stop the music", "spotify.pause", e.clone()),
            ("pause spotify", "spotify.pause", e.clone()),
            ("mute spotify", "spotify.pause", e.clone()),
            ("stop playing music", "spotify.pause", e.clone()),
            ("turn off spotify", "spotify.pause", e.clone()),
            ("turn the music off", "spotify.pause", e),
        ]);
        none(&["stop", "stop it", "turn it off", "mute", "be quiet", "how do I turn off spotify autoplay"]);
    }

    #[test]
    fn g24_resume() {
        let e = json!({});
        expect(&[
            ("resume", "spotify.resume", e.clone()),
            ("unpause", "spotify.resume", e.clone()),
            ("unmute spotify", "spotify.resume", e.clone()),
            ("unmute the music", "spotify.resume", e.clone()),
            ("continue the music", "spotify.resume", e.clone()),
            ("keep playing", "spotify.resume", e.clone()),
            ("play music", "spotify.resume", e.clone()),
            ("play spotify", "spotify.resume", e.clone()),
            ("play", "spotify.resume", e.clone()),
            ("start the music", "spotify.resume", e),
            ("resume on my phone", "spotify.resume", json!({"device_name": "my phone"})),
        ]);
        none(&["unmute"]);
    }

    #[test]
    fn g25_next() {
        let one = json!({"count": 1});
        expect(&[
            ("skip", "spotify.next", one.clone()),
            ("next", "spotify.next", one.clone()),
            ("next song", "spotify.next", one.clone()),
            ("skip this track", "spotify.next", one.clone()),
            ("play the next song", "spotify.next", one),
            ("skip 2 songs", "spotify.next", json!({"count": 2})),
            ("skip two tracks", "spotify.next", json!({"count": 2})),
        ]);
        assert_eq!(p("skip 2 songs").unwrap().summary, "Skip 2 tracks");
        none(&["skip 6 songs"]);
    }

    #[test]
    fn g26_previous() {
        let e = json!({});
        expect(&[
            ("previous", "spotify.previous", e.clone()),
            ("previous song", "spotify.previous", e.clone()),
            ("back a song", "spotify.previous", e.clone()),
            ("go back a song", "spotify.previous", e.clone()),
            ("last track", "spotify.previous", e.clone()),
            ("play the previous track", "spotify.previous", e),
        ]);
        none(&["back", "go back"]);
    }

    #[test]
    fn g27_restart() {
        let e = json!({});
        expect(&[
            ("restart the song", "spotify.restart_track", e.clone()),
            ("start this song over", "spotify.restart_track", e.clone()),
            ("play this from the top", "spotify.restart_track", e.clone()),
            ("restart this track", "spotify.restart_track", e),
        ]);
    }

    #[test]
    fn g28_seek_absolute() {
        expect(&[
            ("skip to 1:30", "spotify.seek", json!({"position_sec": 90})),
            ("go to 2 minutes", "spotify.seek", json!({"position_sec": 120})),
            ("jump to one minute thirty", "spotify.seek", json!({"position_sec": 90})),
            ("seek to 90 seconds", "spotify.seek", json!({"position_sec": 90})),
        ]);
        assert_eq!(p("skip to 1:30").unwrap().summary, "Jump to 1:30");
        none(&["go to bed"]);
    }

    #[test]
    fn g29_seek_relative() {
        expect(&[
            ("skip ahead 30 seconds", "spotify.seek", json!({"offset_sec": 30})),
            ("fast forward 30 seconds", "spotify.seek", json!({"offset_sec": 30})),
            ("go back 10 seconds", "spotify.seek", json!({"offset_sec": -10})),
            ("rewind 15 seconds", "spotify.seek", json!({"offset_sec": -15})),
            ("skip ahead", "spotify.seek", json!({"offset_sec": 30})),
            ("fast forward", "spotify.seek", json!({"offset_sec": 30})),
            ("rewind", "spotify.seek", json!({"offset_sec": -15})),
        ]);
        assert_eq!(p("go back 10 seconds").unwrap().summary, "Go back 10 seconds");
        none(&["go ahead"]);
    }

    #[test]
    fn g30_g31_shuffle() {
        let on = json!({"state": true});
        let off = json!({"state": false});
        expect(&[
            ("shuffle on", "spotify.shuffle", on.clone()),
            ("turn on shuffle", "spotify.shuffle", on.clone()),
            ("turn shuffle on", "spotify.shuffle", on.clone()),
            ("shuffle", "spotify.shuffle", on.clone()),
            ("shuffle my music", "spotify.shuffle", on),
            ("shuffle off", "spotify.shuffle", off.clone()),
            ("turn off shuffle", "spotify.shuffle", off.clone()),
            ("turn shuffle off", "spotify.shuffle", off.clone()),
            ("stop shuffling", "spotify.shuffle", off.clone()),
            ("unshuffle", "spotify.shuffle", off),
        ]);
    }

    #[test]
    fn g32_to_g34_repeat() {
        let track = json!({"mode": "track"});
        let ctx = json!({"mode": "context"});
        let off = json!({"mode": "off"});
        expect(&[
            ("repeat this song", "spotify.repeat", track.clone()),
            ("put this song on repeat", "spotify.repeat", track.clone()),
            ("loop this track", "spotify.repeat", track),
            ("repeat this playlist", "spotify.repeat", ctx.clone()),
            ("repeat the album", "spotify.repeat", ctx.clone()),
            ("repeat on", "spotify.repeat", ctx.clone()),
            ("turn on repeat", "spotify.repeat", ctx.clone()),
            ("turn repeat on", "spotify.repeat", ctx),
            ("repeat off", "spotify.repeat", off.clone()),
            ("stop repeating", "spotify.repeat", off.clone()),
            ("turn off repeat", "spotify.repeat", off),
        ]);
        none(&["repeat", "repeat that", "can you repeat that", "repeat what you said"]);
    }

    #[test]
    fn g35_transfer() {
        expect(&[
            ("play on my phone", "spotify.transfer_device", json!({"device_name": "my phone"})),
            ("move the music to the kitchen speaker", "spotify.transfer_device", json!({"device_name": "kitchen speaker"})),
            ("switch spotify to my laptop", "spotify.transfer_device", json!({"device_name": "my laptop"})),
            ("transfer playback to Living Room", "spotify.transfer_device", json!({"device_name": "Living Room"})),
            ("play it on this computer", "spotify.transfer_device", json!({"device_name": "this computer"})),
        ]);
        assert_eq!(p("switch spotify to my laptop").unwrap().summary, "Move Spotify to my laptop");
        none(&["switch to the coder tab", "switch spotify to dark mode"]);
    }

    #[test]
    fn g36_shuffle_playlist() {
        expect(&[
            ("shuffle my Late Night playlist", "spotify.play", json!({"playlist_name": "Late Night", "shuffle": true})),
            ("shuffle my liked songs", "spotify.play", json!({"playlist_name": "liked songs", "shuffle": true})),
        ]);
    }

    #[test]
    fn g37_play_playlist() {
        let a = json!({"playlist_name": "Late Night"});
        expect(&[
            ("play my Late Night playlist", "spotify.play", a.clone()),
            ("play the playlist Late Night", "spotify.play", a.clone()),
            ("play Late Night playlist", "spotify.play", a.clone()),
            ("play the Late Night playlist on spotify", "spotify.play", a),
            ("play my liked songs", "spotify.play", json!({"playlist_name": "liked songs"})),
        ]);
    }

    #[test]
    fn g38_to_g40_typed_play() {
        expect(&[
            ("play the album Hybrid Theory", "spotify.play", json!({"query": "Hybrid Theory", "type": "album"})),
            ("play Hybrid Theory album", "spotify.play", json!({"query": "Hybrid Theory", "type": "album"})),
            ("play the artist Erra", "spotify.play", json!({"query": "Erra", "type": "artist"})),
            ("play songs by Erra", "spotify.play", json!({"query": "Erra", "type": "artist"})),
            ("play music by Bilmuri", "spotify.play", json!({"query": "Bilmuri", "type": "artist"})),
            ("play something by Erra", "spotify.play", json!({"query": "Erra", "type": "artist"})),
            ("play the song Era", "spotify.play", json!({"query": "Era", "type": "track"})),
            ("play the track Tell Me", "spotify.play", json!({"query": "Tell Me", "type": "track"})),
        ]);
    }

    #[test]
    fn g41_g42_play_query() {
        expect(&[
            ("play Tell Me by Groove Theory", "spotify.play", json!({"query": "Tell Me by Groove Theory"})),
            ("Play Tell Me by Groove Theory on Spotify", "spotify.play", json!({"query": "Tell Me by Groove Theory"})),
            ("play Stand by Me", "spotify.play", json!({"query": "Stand by Me"})),
            ("play Don't Stop Me Now", "spotify.play", json!({"query": "Dont Stop Me Now"})),
            ("play Dance for Me", "spotify.play", json!({"query": "Dance for Me"})),
            ("play Bilmuri", "spotify.play", json!({"query": "Bilmuri"})),
            ("play Bill Murray on spotify", "spotify.play", json!({"query": "Bill Murray"})),
            ("play Era", "spotify.play", json!({"query": "Era"})),
            ("play me Bilmuri", "spotify.play", json!({"query": "Bilmuri"})),
        ]);
        assert_eq!(p("play Bilmuri").unwrap().summary, "Play Bilmuri on Spotify");
        // Tail "now"/"for me" are stripped only after a comma or "on spotify".
        expect(&[
            ("play Bilmuri, now", "spotify.play", json!({"query": "Bilmuri"})),
            ("play Bilmuri on spotify for me", "spotify.play", json!({"query": "Bilmuri"})),
            ("play Bilmuri on spotify now", "spotify.play", json!({"query": "Bilmuri"})),
        ]);
    }

    #[test]
    fn g43_some_x_prefers_playlists() {
        expect(&[
            ("play some jazz", "spotify.play", json!({"query": "jazz", "prefer_playlist": true})),
            ("aye Tony can you play some Bill Murray", "spotify.play", json!({"query": "Bill Murray", "prefer_playlist": true})),
        ]);
    }

    #[test]
    fn g44_play_on_device() {
        expect(&[
            ("play Bilmuri on my phone", "spotify.play", json!({"query": "Bilmuri", "device_name": "my phone"})),
            ("play Erra on the kitchen speaker", "spotify.play", json!({"query": "Erra", "device_name": "kitchen speaker"})),
            ("play Erra on the tv", "spotify.play", json!({"query": "Erra", "device_name": "tv"})),
            ("play Erra on device Den Echo", "spotify.play", json!({"query": "Erra", "device_name": "Den Echo"})),
        ]);
        assert_eq!(p("play Bilmuri on my phone").unwrap().summary, "Play Bilmuri on my phone");
    }

    #[test]
    fn g45_explicit_play_verbs() {
        expect(&[
            ("spotify play Bilmuri", "spotify.play", json!({"query": "Bilmuri"})),
            ("put on Bilmuri on spotify", "spotify.play", json!({"query": "Bilmuri"})),
            ("throw on some Erra on spotify", "spotify.play", json!({"query": "Erra", "prefer_playlist": true})),
            ("listen to Bilmuri on spotify", "spotify.play", json!({"query": "Bilmuri"})),
        ]);
    }

    #[test]
    fn g46_not_music_and_caps() {
        none(&[
            "play devil's advocate",
            "play a game",
            "play it again",
            "play Tell Me Something Good by Rufus and Chaka Khan",
            "one two three four five six seven eight nine ten eleven twelve thirteen",
            "put on a jacket",
            "listen to me",
        ]);
        // 8 words still parses, 9 don't (boundary).
        let eight = "play Tell Me Something Good by Chaka Khan";
        let nine = "play Tell Me Something Good by Rufus and Chaka";
        assert_eq!((eight.split_whitespace().count(), nine.split_whitespace().count()), (8, 9));
        expect(&[(eight, "spotify.play", json!({"query": "Tell Me Something Good by Chaka Khan"}))]);
        none(&[nine]);
        // With "spotify" the play cap doesn't apply.
        assert!(p("play Tell Me Something Good by Rufus and Chaka Khan on spotify").is_some());
    }

    #[test]
    fn g47_nothing_else() {
        none(&[
            "how do I turn off spotify autoplay",
            "remind me to stop the music at 11",
            "what role does Redis play",
            "trading volume today",
            "stop",
            "stop it",
            "turn it off",
            "mute",
            "I like this",
            "I love this song",
            "do it like this",
            "repeat",
            "repeat that",
            "can you repeat that",
            "repeat what you said",
            "what's next",
            "what's next today",
            "what's up next",
            "unmute",
            "back",
            "go back",
            "make a playlist of tasks",
            "",
            "Tony",
        ]);
    }

    #[test]
    fn word_caps() {
        // 12 words without "spotify" parse; 13 don't.
        let twelve = "create a playlist called My Very Long Road Trip Songs For Summer";
        assert_eq!(twelve.split_whitespace().count(), 12);
        assert_eq!(p(twelve).unwrap().args["name"], "My Very Long Road Trip Songs For Summer");
        assert_eq!(p(&format!("{twelve} Nights")), None);
        // create_playlist with an initial list: cap 30 (commas not counted).
        let long = "create a playlist called Road Trip with Tell Me by Groove Theory, Erra, Bilmuri, Snowblood by Erra and Wet Paint by Bilmuri";
        assert!(long.split_whitespace().count() > 12);
        let i = p(long).unwrap();
        assert_eq!(i.args["initial_queries"], json!(["Tell Me by Groove Theory", "Erra", "Bilmuri", "Snowblood by Erra", "Wet Paint by Bilmuri"]));
        let too_long = format!("create a playlist called Road Trip with {}", vec!["Erra"; 25].join(", "));
        assert_eq!(p(&too_long), None);
    }

    #[test]
    fn wake_and_politeness_variants() {
        let add = json!({"playlist_name": "Late Night", "track_query": "current", "create": false});
        expect(&[
            ("aye Tony, add this song to my Late Night playlist", "spotify.add_to_playlist", add.clone()),
            ("Hey Jarvis add this song to my Late Night playlist please", "spotify.add_to_playlist", add.clone()),
            ("add this song to my Late Night playlist, Tony.", "spotify.add_to_playlist", add),
            ("aye Tony, pause the music", "spotify.pause", json!({})),
            ("Hey Jarvis pause the music", "spotify.pause", json!({})),
            ("pause the music, Tony.", "spotify.pause", json!({})),
            ("pause the music please", "spotify.pause", json!({})),
            ("aye Tony, play Tell Me by Groove Theory", "spotify.play", json!({"query": "Tell Me by Groove Theory"})),
            ("Hey Jarvis play Tell Me by Groove Theory", "spotify.play", json!({"query": "Tell Me by Groove Theory"})),
            ("play Tell Me by Groove Theory, Tony.", "spotify.play", json!({"query": "Tell Me by Groove Theory"})),
            ("play Tell Me by Groove Theory please", "spotify.play", json!({"query": "Tell Me by Groove Theory"})),
            ("aye Tony, play Bilmuri", "spotify.play", json!({"query": "Bilmuri"})),
            ("Hey Jarvis play Bilmuri", "spotify.play", json!({"query": "Bilmuri"})),
            ("play Bilmuri, Tony.", "spotify.play", json!({"query": "Bilmuri"})),
            ("play Bilmuri please", "spotify.play", json!({"query": "Bilmuri"})),
            ("Play Bilmuri on Spotify, Tony", "spotify.play", json!({"query": "Bilmuri"})),
            ("play Bilmuri thank you", "spotify.play", json!({"query": "Bilmuri"})),
        ]);
        // Credit kept: "by Tony" names an artist.
        expect(&[("play something by Tony", "spotify.play", json!({"query": "Tony", "type": "artist"}))]);
        // A custom OS name is stripped like Tony.
        let f = parse("pause the music, Friday", "Friday").unwrap();
        assert_eq!(f.tool, "spotify.pause");
    }

    #[test]
    fn intent_serializes_camel_case() {
        let v = serde_json::to_value(p("play Bilmuri on spotify").unwrap()).unwrap();
        assert_eq!(v, json!({"tool": "spotify.play", "args": {"query": "Bilmuri"}, "summary": "Play Bilmuri on Spotify", "mutating": true, "explicit": true}));
        let r = tauri::async_runtime::block_on(spotify_parse("what's playing".into(), None)).unwrap();
        assert_eq!((r.tool.as_str(), r.mutating, r.explicit), ("spotify.now_playing", false, false));
    }

    #[test]
    fn tool_lists() {
        let mut all = ALL_TOOLS.to_vec();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 23);
        assert!(READ_TOOLS.iter().all(|t| ALL_TOOLS.contains(t)));
        assert_eq!(ALL_TOOLS.iter().filter(|t| is_write_tool(t)).count(), 17);
        assert!(ALL_TOOLS.iter().all(|t| is_read_tool(t) != is_write_tool(t)));
        assert_eq!(canonical("spotify.recent"), "spotify.recently_played");
        assert_eq!(canonical("spotify.playlists"), "spotify.list_playlists");
        assert_eq!(canonical("spotify.play"), "spotify.play");
        assert!(is_read_tool("spotify.recent"));
        assert!(!is_write_tool(RECONNECT) && !is_read_tool(RECONNECT));
        assert!(!is_write_tool("gmail.send"));
        let lib: Vec<&str> = ALL_TOOLS.iter().copied().filter(|t| is_library_write(t)).collect();
        assert_eq!(lib, ["spotify.create_playlist", "spotify.add_to_playlist", "spotify.remove_from_playlist", "spotify.like_track", "spotify.unlike_track"]);
        let destructive: Vec<&str> = ALL_TOOLS.iter().copied().filter(|t| is_destructive(t)).collect();
        assert_eq!(destructive, ["spotify.remove_from_playlist", "spotify.unlike_track"]);
    }

    #[test]
    fn tool_scopes_table() {
        assert!(ALL_TOOLS.iter().all(|t| !tool_scopes(t).is_empty()));
        assert_eq!(tool_scopes("spotify.now_playing"), ["user-read-currently-playing", "user-library-read"]);
        assert_eq!(tool_scopes("spotify.get_queue"), ["user-read-currently-playing", "user-read-playback-state"]);
        assert_eq!(tool_scopes("spotify.recently_played"), ["user-read-recently-played"]);
        assert_eq!(tool_scopes("spotify.recent"), ["user-read-recently-played"]);
        assert_eq!(tool_scopes("spotify.top_items"), ["user-top-read"]);
        for t in ["spotify.list_playlists", "spotify.get_playlist_tracks"] {
            assert_eq!(tool_scopes(t), ["playlist-read-private", "playlist-read-collaborative"]);
        }
        for t in ["pause", "resume", "next", "previous", "seek", "restart_track", "volume", "shuffle", "repeat", "transfer_device", "queue_add"] {
            assert_eq!(tool_scopes(&format!("spotify.{t}")), ["user-modify-playback-state", "user-read-playback-state"], "{t}");
        }
        assert_eq!(tool_scopes("spotify.play"), ["user-modify-playback-state", "user-read-playback-state", "playlist-read-private", "playlist-read-collaborative"]);
        assert_eq!(tool_scopes("spotify.create_playlist"), ["playlist-modify-private", "playlist-modify-public"]);
        for t in ["spotify.add_to_playlist", "spotify.remove_from_playlist"] {
            assert_eq!(tool_scopes(t), ["playlist-modify-private", "playlist-modify-public", "playlist-read-private", "playlist-read-collaborative", "user-read-currently-playing"]);
        }
        for t in ["spotify.like_track", "spotify.unlike_track"] {
            assert_eq!(tool_scopes(t), ["user-library-modify", "user-library-read", "user-read-currently-playing"]);
        }
        assert!(tool_scopes("spotify.nope").is_empty());
        assert!(tool_scopes(RECONNECT).is_empty());
    }

    #[test]
    fn summaries_never_leak_ids() {
        let id = regex::Regex::new(r"\b[0-9A-Za-z]{22}\b").unwrap();
        let uri = "spotify:track:0123456789abcdefghijkl";
        let cases = [
            ("spotify.play", json!({"uri": uri})),
            ("spotify.play", json!({"query": uri})),
            ("spotify.play", json!({"query": "0123456789abcdefghijkl"})),
            ("spotify.queue_add", json!({"uri": uri})),
            ("spotify.add_to_playlist", json!({"playlist_name": "spotify:playlist:0123456789abcdefghijkl", "track_query": uri})),
            ("spotify.like_track", json!({"track_query": uri})),
            ("spotify.transfer_device", json!({"device_name": "0123456789abcdefghijkl"})),
        ];
        for (name, args) in &cases {
            let s = summary_for(name, args);
            assert!(!s.contains("spotify:") && !id.is_match(&s), "{name}: {s}");
        }
        for name in ALL_TOOLS {
            let args = normalize_args(name, &json!({"playlist_name": "Late Night", "name": "Road Trip", "device_name": "my phone", "query": "Erra", "percent": 40, "position_sec": 90})).unwrap();
            let s = summary_for(name, &args);
            assert!(!s.is_empty() && !s.contains("spotify:") && !id.is_match(&s), "{name}: {s}");
        }
        assert_eq!(summary_for("spotify.play", &json!({"uri": uri})), "Play this on Spotify");
        assert_eq!(summary_for("spotify.play", &json!({})), "Resume Spotify");
        assert_eq!(summary_for("spotify.play", &json!({"playlist_name": "Late Night", "shuffle": true})), "Shuffle Late Night on Spotify");
        assert_eq!(summary_for("spotify.volume", &json!({"percent": "+15"})), "Turn Spotify up 15%");
        assert_eq!(summary_for("spotify.volume", &json!({"percent": "-15"})), "Turn Spotify down 15%");
        assert_eq!(summary_for("spotify.pause", &json!({})), "Pause Spotify");
        assert_eq!(summary_for("spotify.next", &json!({"count": 1})), "Skip to the next track");
        assert_eq!(summary_for("spotify.shuffle", &json!({"state": true})), "Turn shuffle on");
        assert_eq!(summary_for("spotify.seek", &json!({"offset_sec": 30})), "Skip ahead 30 seconds");
    }

    #[test]
    fn normalize_args_coercions_and_defaults() {
        let n = |t: &str, a: Value| normalize_args(t, &a);
        // play: kind alias, invalid uri dropped, unknown keys dropped, bool strings.
        assert_eq!(
            n("spotify.play", json!({"query": " Erra ", "kind": "Artist", "uri": "spotify:track:bad", "junk": 1, "shuffle": "true"})).unwrap(),
            json!({"query": "Erra", "type": "artist", "shuffle": true})
        );
        assert_eq!(n("spotify.play", json!({"uri": "spotify:album:0123456789abcdefghijkl"})).unwrap(), json!({"uri": "spotify:album:0123456789abcdefghijkl"}));
        assert_eq!(n("spotify.play", json!({"type": "podcast"})).unwrap(), json!({}));
        assert_eq!(n("spotify.play", Value::Null).unwrap(), json!({}));
        // next: default and clamp.
        assert_eq!(n("spotify.next", json!({})).unwrap(), json!({"count": 1}));
        assert_eq!(n("spotify.next", json!({"count": "9"})).unwrap(), json!({"count": 5}));
        assert_eq!(n("spotify.next", json!({"count": 0})).unwrap(), json!({"count": 1}));
        // seek: exactly one.
        assert_eq!(n("spotify.seek", json!({"position_sec": "1:30"})).unwrap(), json!({"position_sec": 90}));
        assert_eq!(n("spotify.seek", json!({"position_sec": "90"})).unwrap(), json!({"position_sec": 90}));
        assert_eq!(n("spotify.seek", json!({"offset_sec": "+10"})).unwrap(), json!({"offset_sec": 10}));
        assert_eq!(n("spotify.seek", json!({"offset_sec": "-10"})).unwrap(), json!({"offset_sec": -10}));
        assert_eq!(n("spotify.seek", json!({"offset_sec": -15})).unwrap(), json!({"offset_sec": -15}));
        let seek_err = "Tell me where to jump, like \"skip to 1:30\".";
        assert_eq!(n("spotify.seek", json!({})).unwrap_err(), seek_err);
        assert_eq!(n("spotify.seek", json!({"position_sec": 10, "offset_sec": 10})).unwrap_err(), seek_err);
        // volume.
        assert_eq!(n("spotify.volume", json!({"percent": 140})).unwrap(), json!({"percent": 100}));
        assert_eq!(n("spotify.volume", json!({"percent": -5})).unwrap(), json!({"percent": 0}));
        assert_eq!(n("spotify.volume", json!({"percent": "30"})).unwrap(), json!({"percent": 30}));
        assert_eq!(n("spotify.volume", json!({"percent": "40%"})).unwrap(), json!({"percent": 40}));
        assert_eq!(n("spotify.volume", json!({"percent": "forty"})).unwrap(), json!({"percent": 40}));
        assert_eq!(n("spotify.volume", json!({"percent": "+10"})).unwrap(), json!({"percent": "+10"}));
        assert_eq!(n("spotify.volume", json!({"percent": "-150"})).unwrap(), json!({"percent": "-100"}));
        assert_eq!(n("spotify.volume", json!({"volume": 20})).unwrap(), json!({"percent": 20}));
        assert!(n("spotify.volume", json!({})).is_err());
        assert!(n("spotify.volume", json!({"percent": "+0"})).is_err());
        assert!(n("spotify.volume", json!({"percent": "loud"})).is_err());
        // shuffle / repeat.
        assert_eq!(n("spotify.shuffle", json!({})).unwrap(), json!({"state": true}));
        assert_eq!(n("spotify.shuffle", json!({"state": "off"})).unwrap(), json!({"state": false}));
        assert_eq!(n("spotify.repeat", json!({})).unwrap(), json!({"mode": "context"}));
        assert_eq!(n("spotify.repeat", json!({"mode": "on"})).unwrap(), json!({"mode": "context"}));
        assert_eq!(n("spotify.repeat", json!({"mode": "song"})).unwrap(), json!({"mode": "track"}));
        assert_eq!(n("spotify.repeat", json!({"mode": "one"})).unwrap(), json!({"mode": "track"}));
        assert_eq!(n("spotify.repeat", json!({"mode": "off"})).unwrap(), json!({"mode": "off"}));
        assert!(n("spotify.repeat", json!({"mode": "sideways"})).is_err());
        // required fields.
        assert_eq!(n("spotify.transfer_device", json!({})).unwrap_err(), "Which device should I move Spotify to?");
        assert_eq!(n("spotify.transfer_device", json!({"device_name": "my phone"})).unwrap(), json!({"device_name": "my phone"}));
        assert_eq!(n("spotify.queue_add", json!({})).unwrap_err(), "What should I add to the queue?");
        assert_eq!(n("spotify.queue_add", json!({"uri": "spotify:track:0123456789abcdefghijkl"})).unwrap(), json!({"uri": "spotify:track:0123456789abcdefghijkl"}));
        assert!(n("spotify.queue_add", json!({"uri": "spotify:album:0123456789abcdefghijkl"})).is_err());
        assert_eq!(n("spotify.get_playlist_tracks", json!({})).unwrap_err(), NEED_PLAYLIST);
        assert_eq!(n("spotify.add_to_playlist", json!({})).unwrap_err(), NEED_PLAYLIST);
        assert_eq!(n("spotify.remove_from_playlist", json!({"track_query": "x"})).unwrap_err(), NEED_PLAYLIST);
        assert!(n("spotify.create_playlist", json!({})).is_err());
        // defaults.
        assert_eq!(n("spotify.add_to_playlist", json!({"playlist_name": "Late Night"})).unwrap(), json!({"playlist_name": "Late Night", "track_query": "current", "create": false}));
        assert_eq!(n("spotify.remove_from_playlist", json!({"playlist_name": "Late Night"})).unwrap(), json!({"playlist_name": "Late Night", "track_query": "current"}));
        assert_eq!(n("spotify.like_track", json!({})).unwrap(), json!({"track_query": "current"}));
        assert_eq!(n("spotify.unlike_track", json!({"query": "Tell Me"})).unwrap(), json!({"track_query": "Tell Me"}));
        let long_name = "x".repeat(150);
        let created = n("spotify.create_playlist", json!({"name": long_name, "initial_queries": (0..30).map(|i| format!("q{i}")).collect::<Vec<_>>(), "public": "yes", "description": "d"})).unwrap();
        assert_eq!(created["name"].as_str().unwrap().len(), 100);
        assert_eq!(created["initial_queries"].as_array().unwrap().len(), 20);
        assert_eq!(created["public"], true);
        assert_eq!(created["description"], "d");
        assert_eq!(n("spotify.create_playlist", json!({"name": "Road Trip"})).unwrap(), json!({"name": "Road Trip", "public": false, "initial_queries": []}));
        assert_eq!(n("spotify.top_items", json!({})).unwrap(), json!({"type": "tracks", "time_range": "medium_term", "limit": 5}));
        assert_eq!(n("spotify.top_items", json!({"type": "artist", "time_range": "long", "limit": 50})).unwrap(), json!({"type": "artists", "time_range": "long_term", "limit": 10}));
        assert_eq!(n("spotify.recently_played", json!({})).unwrap(), json!({"limit": 10}));
        assert_eq!(n("spotify.recently_played", json!({"limit": 99})).unwrap(), json!({"limit": 50}));
        assert_eq!(n("spotify.recently_played", json!({"limit": 0})).unwrap(), json!({"limit": 1}));
        // aliases, reconnect, read tools, unknown.
        assert_eq!(n("spotify.recent", json!({})).unwrap(), json!({"limit": 10}));
        assert_eq!(n(RECONNECT, json!({"x": 1})).unwrap(), json!({}));
        assert_eq!(n("spotify.pause", json!({"x": 1})).unwrap(), json!({}));
        assert_eq!(n("spotify.resume", json!({"device_name": "my phone", "x": 1})).unwrap(), json!({"device_name": "my phone"}));
        assert!(n("spotify.nope", json!({})).is_err());
    }

    #[test]
    fn words_to_number_table() {
        for (s, n) in [("40", Some(40)), ("0", Some(0)), ("100", Some(100)), ("101", None), ("forty", Some(40)), ("fifty five", Some(55)), ("fifty-five", Some(55)), ("a hundred", Some(100)), ("one hundred", Some(100)), ("hundred", Some(100)), ("ten", Some(10)), ("nineteen", Some(19)), ("zero", Some(0)), ("ninety nine", Some(99)), ("twenty zero", None), ("loud", None), ("", None), ("a", None)] {
            assert_eq!(words_to_number(s), n, "{s:?}");
        }
    }

    #[test]
    fn parse_timestamp_table() {
        for (s, n) in [
            ("1:30", Some(90)),
            ("0:05", Some(5)),
            ("1:02:03", Some(3723)),
            ("1:75", None),
            ("90 seconds", Some(90)),
            ("150 seconds", Some(150)),
            ("2 minutes", Some(120)),
            ("1 minute 30", Some(90)),
            ("one minute thirty", Some(90)),
            ("a minute and a half", Some(90)),
            ("half a minute", Some(30)),
            ("two minutes thirty seconds", Some(150)),
            ("twenty five seconds", Some(25)),
            ("a minute", Some(60)),
            ("the 2 minute mark", Some(120)),
            ("90", None),
            ("2 songs", None),
            ("a song", None),
            ("bed", None),
            ("", None),
        ] {
            assert_eq!(parse_timestamp(s), n, "{s:?}");
        }
    }

    #[test]
    fn preprocessing_helpers() {
        assert_eq!(lite("  Play \"Tell Me\", now!  "), "Play Tell Me, now");
        assert_eq!(lite("what's playing?"), "whats playing");
        assert_eq!(lite("skip to 1:30."), "skip to 1:30");
        assert_eq!(lite("note: play x"), "note play x");
        assert_eq!(lite("volume 40%"), "volume 40%");
        assert_eq!(strip_tail("play X, now", "Tony"), "play X");
        assert_eq!(strip_tail("play Dont Stop Me Now", "Tony"), "play Dont Stop Me Now");
        assert_eq!(strip_tail("play Dance for Me", "Tony"), "play Dance for Me");
        assert_eq!(strip_tail("play X on spotify for me", "Tony"), "play X on spotify");
        assert_eq!(strip_tail("play X please, Tony", "Tony"), "play X");
        assert_eq!(strip_tail("play something by Tony", "Tony"), "play something by Tony");
        assert_eq!(strip_tail("pause, Jarvis", "Friday"), "pause");
        assert_eq!(strip_affixes("spotify, pause"), "pause");
        assert_eq!(strip_affixes("play X on Spotify"), "play X");
    }
}
