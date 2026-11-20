//! Spotify query resolution, aliases and fuzzy matching (WP-B, see spotify-overhaul-contract.md).
//!
//! Pure: no network, no global state. WP-E feeds `/search`, `/me/playlists` and
//! currently-playing replies in and gets play targets, bodies and labels out.
// WP-E consumes most of this surface (spotify.rs); until then much of it is test-only.
#![cfg_attr(not(test), allow(dead_code))]

use serde_json::{json, Value};

/// Phonetic STT fixes, keys compared on `norm()`; whole query (or whole artist part of "X by Y") only.
pub const PHONETIC: &[(&str, &str)] = &[
    ("bill murray", "Bilmuri"),
    ("bill murry", "Bilmuri"),
    ("bil murray", "Bilmuri"),
    ("bilmurry", "Bilmuri"),
    ("bill muri", "Bilmuri"),
    ("bilmuri", "Bilmuri"),
    ("era", "Erra"),
    ("erra", "Erra"),
];

/// Whole-query alias ("Bill Murray" → "Bilmuri", "Era" → "Erra"). Never matches inside a longer query.
pub fn alias(q: &str) -> Option<&'static str> {
    let n = norm(q);
    PHONETIC.iter().find(|(k, _)| *k == n).map(|(_, v)| *v)
}

/// Latin-1 letters → ASCII (lowercase input). `None` = keep the char as is.
fn fold(c: char) -> Option<&'static str> {
    Some(match c {
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
        'ß' => "ss",
        'þ' => "th",
        _ => return None,
    })
}

/// lowercase; Latin-1 diacritics stripped; "&" → "and"; every char that isn't alphanumeric or
/// space removed ("what's" → "whats"); spaces collapsed; a leading "the " dropped.
pub fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        for c in ch.to_lowercase() {
            if let Some(f) = fold(c) {
                out.push_str(f);
            } else if c == '&' {
                out.push_str(" and ");
            } else if c.is_alphanumeric() {
                out.push(c);
            } else if c.is_whitespace() {
                out.push(' ');
            }
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    match joined.strip_prefix("the ") {
        Some(rest) => rest.to_string(),
        None => joined,
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
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

/// 0.0..=1.0. 1.0 if norm equal. 0.9 if one norm is a whole-word prefix/substring of the other and the
/// shorter has ≥ 4 chars. Else 1 - levenshtein / max(len) (chars).
pub fn similarity(a: &str, b: &str) -> f32 {
    let (a, b) = (norm(a), norm(b));
    if a == b {
        return 1.0;
    }
    let (la, lb) = (a.chars().count(), b.chars().count());
    let (short, long, ls) = if la <= lb { (&a, &b, la) } else { (&b, &a, lb) };
    if ls >= 4 && format!(" {long} ").contains(&format!(" {short} ")) {
        return 0.9;
    }
    let max = la.max(lb);
    if max == 0 {
        return 1.0;
    }
    1.0 - levenshtein(&a, &b) as f32 / max as f32
}

/// Split on the LAST " by " (case-insensitive) when both sides are non-empty: "Tell Me by Groove Theory" →
/// ("Tell Me", Some("Groove Theory")). Applies `alias` to the artist part.
pub fn split_by(q: &str) -> (String, Option<String>) {
    let q = q.trim();
    // ASCII lowercasing keeps byte offsets, so indices found in `lower` are valid in `q`.
    let lower = q.to_ascii_lowercase();
    if let Some(i) = lower.rfind(" by ") {
        let (title, artist) = (q[..i].trim(), q[i + 4..].trim());
        if !title.is_empty() && !artist.is_empty() {
            let artist = alias(artist).map(str::to_string).unwrap_or_else(|| artist.to_string());
            return (title.to_string(), Some(artist));
        }
    }
    (q.to_string(), None)
}

/// "", "current", "this", "it", "that", "this song|track|one", "that song|track|one", "the current song|track",
/// "current song|track", "the song thats playing", "the song playing", "whats playing", "what im listening to"
/// — compared on `norm` (which drops a leading "the " and apostrophes).
pub fn is_current(q: &str) -> bool {
    const CUR: [&str; 21] = [
        "",
        "current",
        "this",
        "it",
        "that",
        "this song",
        "this track",
        "this one",
        "that song",
        "that track",
        "that one",
        "current song",
        "current track",
        "song thats playing",
        "track thats playing",
        "song playing",
        "whats playing",
        "what im listening to",
        "song im listening to",
        "this tune",
        "current one",
    ];
    CUR.contains(&norm(q).as_str())
}

fn re(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).unwrap()
}

/// Strip " - Remastered…", " - 2011 Remaster", " (Remastered …)", " - Radio Edit", " (feat. …)", " [feat. …]"
/// from a track title for speech. Never returns empty (falls back to the input).
pub fn spoken_title(name: &str) -> String {
    static RES: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            r"(?i)\s+-\s+(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?\b.*$",
            r"(?i)\s+-\s+radio\s+edit\b.*$",
            r"(?i)\s*\([^)]*\bremaster(?:ed)?\b[^)]*\)",
            r"(?i)\s*\[[^\]]*\bremaster(?:ed)?\b[^\]]*\]",
            r"(?i)\s*\((?:feat\.?|ft\.?|featuring|with)\s[^)]*\)",
            r"(?i)\s*\[(?:feat\.?|ft\.?|featuring|with)\s[^\]]*\]",
        ]
        .into_iter()
        .map(re)
        .collect()
    });
    let mut s = name.to_string();
    for r in res {
        s = r.replace_all(&s, "").into_owned();
    }
    let s = s.trim();
    if s.is_empty() {
        name.to_string()
    } else {
        s.to_string()
    }
}

/// "A", "A and B", "A, B and C" (max 3 names, then "and others").
pub fn join_names(names: &[String]) -> String {
    let names: Vec<&str> = names.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].to_string(),
        2 => format!("{} and {}", names[0], names[1]),
        3 => format!("{}, {} and {}", names[0], names[1], names[2]),
        _ => format!("{}, {}, {} and others", names[0], names[1], names[2]),
    }
}

/// A playlist-context label: own ⇒ "your X playlist", other ⇒ "the playlist X".
pub fn playlist_label(name: &str, own: bool) -> String {
    if own {
        format!("your {name} playlist")
    } else {
        format!("the playlist {name}")
    }
}

/// "1 song", "2 songs" (`plural(n, "song")`); used by every count in §6.
pub fn plural(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

// ── Playlists ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct PlaylistRef {
    pub id: String,
    pub uri: String,
    pub name: String,
    pub owner_id: String,
    pub collaborative: bool,
    pub total: Option<u32>,
    pub snapshot_id: Option<String>,
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_str()
}

fn u32_at(v: &Value, path: &[&str]) -> Option<u32> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_u64().map(|n| n.min(u32::MAX as u64) as u32)
}

/// One `/me/playlists` page → refs (skips null items / items without id). `total` = items.total ?? tracks.total.
pub fn parse_playlists_page(v: &Value) -> Vec<PlaylistRef> {
    let Some(items) = v.get("items").and_then(Value::as_array) else { return Vec::new() };
    items
        .iter()
        .filter_map(|p| {
            let id = p.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            Some(PlaylistRef {
                id: id.to_string(),
                uri: str_at(p, &["uri"]).map(str::to_string).unwrap_or_else(|| format!("spotify:playlist:{id}")),
                name: str_at(p, &["name"]).unwrap_or("").to_string(),
                owner_id: str_at(p, &["owner", "id"]).unwrap_or("").to_string(),
                collaborative: p.get("collaborative").and_then(Value::as_bool).unwrap_or(false),
                total: u32_at(p, &["items", "total"]).or_else(|| u32_at(p, &["tracks", "total"])),
                snapshot_id: str_at(p, &["snapshot_id"]).map(str::to_string),
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlaylistMatch {
    One(PlaylistRef),
    Ambiguous(PlaylistRef, PlaylistRef),
    None,
}

/// Best by `similarity(name, p.name)` ≥ `min`. Ambiguous when the top two differ by < 0.05 and neither is
/// an exact norm match (an exact match always wins outright). Order of `lists` breaks exact ties (first).
pub fn match_playlist(name: &str, lists: &[PlaylistRef], min: f32) -> PlaylistMatch {
    let wanted = norm(name);
    if let Some(p) = lists.iter().find(|p| norm(&p.name) == wanted) {
        return PlaylistMatch::One(p.clone());
    }
    let mut scored: Vec<(f32, &PlaylistRef)> = lists.iter().map(|p| (similarity(name, &p.name), p)).filter(|(s, _)| *s >= min).collect();
    // Stable sort: equal scores keep `lists` order.
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    match scored.as_slice() {
        [] => PlaylistMatch::None,
        [(_, p)] => PlaylistMatch::One((*p).clone()),
        [(s1, p1), (s2, p2), ..] => {
            if s1 - s2 < 0.05 {
                PlaylistMatch::Ambiguous((*p1).clone(), (*p2).clone())
            } else {
                PlaylistMatch::One((*p1).clone())
            }
        }
    }
}

pub const OWN_MATCH_MIN: f32 = 0.75; // type=playlist, "my … playlist", add/remove/get_playlist_tracks
/// Untyped play: own playlist only if nearly exact. Above the 0.9 whole-word substring score on
/// purpose, so an own "Bilmuri Mix" never takes over "play Bilmuri" (nor "Tell Me" over
/// "play Tell Me by Groove Theory"); only an exact norm or a ≤ 5 % edit distance passes.
pub const OWN_EXACTISH_MIN: f32 = 0.95;

// ── Tracks ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct TrackRef {
    pub uri: String,
    pub name: String,
    /// Track: artist names. Episode: `[show.name]` (so replies read "Episode X by Show Y").
    pub artists: Vec<String>,
    pub album_uri: Option<String>,    // episode ⇒ None
    pub album_name: Option<String>,   // episode ⇒ Some(show name)
    pub release_year: Option<String>, // album.release_date[:4] / episode release_date[:4]
    pub duration_ms: Option<u64>,
    pub is_episode: bool,
}

fn year(date: Option<&str>) -> Option<String> {
    let d = date?.trim();
    let y: String = d.chars().take(4).collect();
    (y.len() == 4 && y.chars().all(|c| c.is_ascii_digit())).then_some(y)
}

/// From a track or episode object (`type` field, or `uri` prefix `spotify:episode:`); also the `item` of a
/// currently-playing reply and the `item`/`track` of a playlist entry (wrappers are unwrapped). None if no uri.
pub fn parse_track(v: &Value) -> Option<TrackRef> {
    let uri = match v.get("uri").and_then(Value::as_str) {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            // Wrapper: currently-playing `{item}` or playlist entry `{item}` / legacy `{track}`.
            return ["item", "track"].iter().find_map(|k| v.get(*k).filter(|x| x.is_object()).and_then(parse_track));
        }
    };
    let is_episode = v.get("type").and_then(Value::as_str) == Some("episode") || uri.starts_with("spotify:episode:");
    let name = str_at(v, &["name"]).unwrap_or("").to_string();
    let duration_ms = v.get("duration_ms").and_then(Value::as_u64);
    if is_episode {
        let show = str_at(v, &["show", "name"]).map(str::to_string);
        return Some(TrackRef {
            uri,
            name,
            artists: show.iter().cloned().collect(),
            album_uri: None,
            album_name: show,
            release_year: year(str_at(v, &["release_date"])),
            duration_ms,
            is_episode: true,
        });
    }
    let artists = v
        .get("artists")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default();
    Some(TrackRef {
        uri,
        name,
        artists,
        album_uri: str_at(v, &["album", "uri"]).filter(|s| !s.is_empty()).map(str::to_string),
        album_name: str_at(v, &["album", "name"]).map(str::to_string),
        release_year: year(str_at(v, &["album", "release_date"])),
        duration_ms,
        is_episode: false,
    })
}

// ── Search planning and target choice ───────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SearchKind {
    Track,
    Artist,
    Album,
    Playlist,
}

impl SearchKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "track" | "tracks" | "song" | "songs" => Some(Self::Track),
            "artist" | "artists" | "band" => Some(Self::Artist),
            "album" | "albums" => Some(Self::Album),
            "playlist" | "playlists" => Some(Self::Playlist),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Artist => "artist",
            Self::Album => "album",
            Self::Playlist => "playlist",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlayRequest {
    pub query: String,
    pub kind: Option<SearchKind>,
    /// User said "my … playlist" or passed `playlist_name`: own-library playlists only, never public search.
    pub my: bool,
    /// "some X": untyped mixed search, but a playlist hit is preferred over fuzzy track/artist hits.
    pub prefer_playlist: bool,
    /// "my liked songs" / "liked songs" / "my favorites" as a play target (D28).
    pub liked: bool,
}

/// Normalised `spotify.play` args → what to do. Precedence: `uri` > `playlist_name` > `query`.
#[derive(Clone, Debug, PartialEq)]
pub enum PlayArgs {
    Uri(String),
    Request(PlayRequest),
    /// No uri / playlist_name / query ⇒ resume.
    Resume,
}

/// `spotify:(track|album|artist|playlist|episode):<22 base62>`.
pub(crate) fn valid_play_uri(uri: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| re(r"^spotify:(?:track|album|artist|playlist|episode):[A-Za-z0-9]{22}$")).is_match(uri)
}

fn is_liked_name(s: &str) -> bool {
    const LIKED: [&str; 11] = [
        "liked songs",
        "my liked songs",
        "liked",
        "favorites",
        "my favorites",
        "favourites",
        "my favourites",
        "saved songs",
        "my saved songs",
        "likes",
        "my likes",
    ];
    LIKED.contains(&norm(s).as_str())
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// `playlist_name` ⇒ PlayRequest{query: name, kind: Playlist, my: true, ..}; a playlist_name or query whose
/// norm is "liked songs" | "my liked songs" | "liked" | "favorites" | "my favorites" | "saved songs" ⇒ liked:true.
/// `type`/`prefer_playlist` copied from args.
pub fn play_args(args: &Value) -> PlayArgs {
    if let Some(uri) = arg_str(args, "uri").filter(|u| valid_play_uri(u)) {
        return PlayArgs::Uri(uri.to_string());
    }
    let prefer_playlist = args.get("prefer_playlist").and_then(Value::as_bool).unwrap_or(false);
    if let Some(name) = arg_str(args, "playlist_name") {
        return PlayArgs::Request(PlayRequest { query: name.to_string(), kind: Some(SearchKind::Playlist), my: true, prefer_playlist, liked: is_liked_name(name) });
    }
    if let Some(q) = arg_str(args, "query") {
        let kind = arg_str(args, "type").or_else(|| arg_str(args, "kind")).and_then(SearchKind::parse);
        return PlayArgs::Request(PlayRequest { query: q.to_string(), kind, my: false, prefer_playlist, liked: is_liked_name(q) });
    }
    PlayArgs::Resume
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchPlan {
    /// The q= sent to /search.
    pub q: String,
    pub types: &'static str,
    pub limit: u8,
    /// Text `choose` compares names against: the ALIASED query ("Erra", not "Era"); for field-filter
    /// plans the title part T.
    pub match_query: String,
    /// (title, aliased artist) when this plan came from split_by; None on the whole-query plan.
    pub split: Option<(String, String)>,
    pub kind: Option<SearchKind>,
    pub prefer_playlist: bool,
}

const SEARCH_LIMIT: u8 = 5;
const MIXED: &str = "track,artist,album,playlist";

fn unquote(s: &str) -> String {
    s.replace(['"', '“', '”'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The three split-aware plans (field filter, "T A", whole query) or the single whole-query plan.
fn split_plans(query: &str, whole_q: &str, whole_types: &'static str, split_types: &'static str, kind: Option<SearchKind>, prefer_playlist: bool) -> Vec<SearchPlan> {
    let whole = SearchPlan { q: whole_q.to_string(), types: whole_types, limit: SEARCH_LIMIT, match_query: whole_q.to_string(), split: None, kind, prefer_playlist };
    match split_by(query) {
        (t, Some(a)) => {
            let (t, a) = (unquote(&t), unquote(&a));
            let split = Some((t.clone(), a.clone()));
            vec![
                SearchPlan { q: format!("track:\"{t}\" artist:\"{a}\""), types: split_types, limit: SEARCH_LIMIT, match_query: t.clone(), split: split.clone(), kind, prefer_playlist },
                SearchPlan { q: format!("{t} {a}"), types: split_types, limit: SEARCH_LIMIT, match_query: t, split, kind, prefer_playlist },
                whole,
            ]
        }
        (_, None) => vec![whole],
    }
}

/// Searches to try in order (caller stops at the first non-NotFound `choose`). See contract §4.2.
pub fn plan_searches(req: &PlayRequest) -> Vec<SearchPlan> {
    let query = req.query.trim();
    let aliased = match req.kind {
        Some(SearchKind::Artist | SearchKind::Track) => query.to_string(),
        _ => alias(query).map(str::to_string).unwrap_or_else(|| query.to_string()),
    };
    match req.kind {
        Some(k) => vec![SearchPlan { q: aliased.clone(), types: k.as_str(), limit: SEARCH_LIMIT, match_query: aliased, split: None, kind: Some(k), prefer_playlist: req.prefer_playlist }],
        None => split_plans(query, &aliased, MIXED, "track", None, req.prefer_playlist),
    }
}

/// Track-only plans for queue_add / add / remove / like / unlike / create initial_queries: alias + split_by
/// exactly as `plan_searches` but `types:"track"` on every plan (the whole-query plan too).
pub fn track_plans(query: &str) -> Vec<SearchPlan> {
    let query = query.trim();
    let aliased = alias(query).map(str::to_string).unwrap_or_else(|| query.to_string());
    split_plans(query, &aliased, "track", "track", Some(SearchKind::Track), false)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// artist / album / playlist context. `label` per §6 ("Bilmuri", "the album X by Y", "the playlist X").
    Context { uri: String, label: String, kind: SearchKind },
    /// Track inside its album (continuous). Body: {context_uri: album_uri, offset:{uri: track_uri}}.
    AlbumAt { album_uri: String, track_uri: String, label: String },
    /// Track with no album uri. Body: {uris:[uri]}.
    Track { uri: String, label: String },
    /// Liked Songs (D28). Body: {context_uri: "spotify:user:<user_id>:collection"}.
    Liked { user_id: String },
    /// Speakable question phrased as commands the grammar understands.
    Ask(String),
    /// Speakable refusal that must not fall through to public search.
    Refuse(String),
    NotFound,
}

/// Non-null objects of `search[<key>].items`.
fn items<'a>(search: &'a Value, key: &str) -> Vec<&'a Value> {
    search.get(key).and_then(|v| v.get("items")).and_then(Value::as_array).map(|a| a.iter().filter(|x| x.is_object()).collect()).unwrap_or_default()
}

fn name_of(v: &Value) -> &str {
    v.get("name").and_then(Value::as_str).unwrap_or("")
}

fn uri_of(v: &Value) -> Option<String> {
    v.get("uri").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn artist_names(v: &Value) -> Vec<String> {
    v.get("artists").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).map(str::to_string).collect()).unwrap_or_default()
}

/// "{Title} by {Artists}" (spoken title, joined names).
fn track_text(t: &TrackRef) -> String {
    let artists = join_names(&t.artists);
    if artists.is_empty() {
        spoken_title(&t.name)
    } else {
        format!("{} by {artists}", spoken_title(&t.name))
    }
}

fn track_target(v: &Value) -> Target {
    let Some(t) = parse_track(v) else { return Target::NotFound };
    let label = track_text(&t);
    match t.album_uri {
        Some(album_uri) if !t.is_episode => Target::AlbumAt { album_uri, track_uri: t.uri, label },
        _ => Target::Track { uri: t.uri, label },
    }
}

fn artist_target(v: &Value) -> Target {
    match uri_of(v) {
        Some(uri) => Target::Context { uri, label: name_of(v).to_string(), kind: SearchKind::Artist },
        None => Target::NotFound,
    }
}

fn album_target(v: &Value) -> Target {
    let Some(uri) = uri_of(v) else { return Target::NotFound };
    let artists = join_names(&artist_names(v));
    let label = if artists.is_empty() { format!("the album {}", name_of(v)) } else { format!("the album {} by {artists}", name_of(v)) };
    Target::Context { uri, label, kind: SearchKind::Album }
}

fn playlist_target(v: &Value) -> Target {
    match uri_of(v) {
        Some(uri) => Target::Context { uri, label: playlist_label(name_of(v), false), kind: SearchKind::Playlist },
        None => Target::NotFound,
    }
}

fn first_or_notfound(v: Option<&&Value>, f: fn(&Value) -> Target) -> Target {
    v.map_or(Target::NotFound, |x| f(x))
}

/// Rule 1 (split plans): first track whose name sim ≥ 0.8 to T and any artist sim ≥ 0.7 to A.
fn split_track<'a>(tracks: &[&'a Value], t: &str, a: &str) -> Option<&'a Value> {
    tracks.iter().copied().find(|x| similarity(name_of(x), t) >= 0.8 && artist_names(x).iter().any(|n| similarity(n, a) >= 0.7))
}

/// Pick from one /search reply for one plan (skips null items). Rules in contract §4.2.
pub fn choose(plan: &SearchPlan, search: &Value) -> Target {
    let q = plan.match_query.as_str();
    let tracks = items(search, "tracks");
    let artists = items(search, "artists");
    let albums = items(search, "albums");
    let playlists = items(search, "playlists");
    // 1. split plans: title + artist, nothing else.
    if let Some((t, a)) = &plan.split {
        return split_track(&tracks, t, a).map_or(Target::NotFound, track_target);
    }
    match plan.kind {
        // 2.
        Some(SearchKind::Track) => match tracks.iter().find(|x| similarity(name_of(x), q) >= 0.8) {
            Some(x) => track_target(x),
            None => match tracks.first() {
                Some(x) if similarity(name_of(x), q) >= 0.5 => track_target(x),
                _ => Target::NotFound,
            },
        },
        // 3.
        Some(SearchKind::Artist) => match artists.iter().find(|x| similarity(name_of(x), q) >= 0.7) {
            Some(x) => artist_target(x),
            None => first_or_notfound(artists.first(), artist_target),
        },
        // 4.
        Some(SearchKind::Album) => match albums.iter().find(|x| similarity(name_of(x), q) >= 0.7) {
            Some(x) => album_target(x),
            None => first_or_notfound(albums.first(), album_target),
        },
        // 5.
        Some(SearchKind::Playlist) => match playlists.iter().find(|x| similarity(name_of(x), q) >= 0.5) {
            Some(x) => playlist_target(x),
            None => first_or_notfound(playlists.first(), playlist_target),
        },
        // 6.
        None => {
            let nq = norm(q);
            let a_idx = artists.iter().position(|x| norm(name_of(x)) == nq);
            let t_idx = tracks.iter().position(|x| norm(name_of(x)) == nq);
            // a. exact artist and exact track both first, by different artists ⇒ ask.
            if let (Some(0), Some(0)) = (a_idx, t_idx) {
                let artist = name_of(artists[0]);
                let track_artists = artist_names(tracks[0]);
                if !track_artists.iter().any(|n| norm(n) == norm(artist)) {
                    let title = spoken_title(name_of(tracks[0]));
                    return Target::Ask(format!(
                        "Did you mean the artist {artist} or the song {title} by {}? Say \"play the artist {artist}\" or \"play the song {title}\".",
                        join_names(&track_artists)
                    ));
                }
            }
            // b. / c.
            if let Some(i) = a_idx {
                return artist_target(artists[i]);
            }
            if let Some(i) = t_idx {
                return track_target(tracks[i]);
            }
            // d.
            if plan.prefer_playlist {
                if let Some(x) = playlists.iter().find(|x| similarity(name_of(x), q) >= 0.5) {
                    return playlist_target(x);
                }
            }
            // e. / f.
            if let Some(x) = albums.iter().find(|x| norm(name_of(x)) == nq) {
                return album_target(x);
            }
            if let Some(x) = playlists.iter().find(|x| norm(name_of(x)) == nq) {
                return playlist_target(x);
            }
            // g.
            if let Some(x) = tracks.first() {
                if similarity(name_of(x), q) >= 0.6 || artist_names(x).iter().any(|n| similarity(n, q) >= 0.6) {
                    return track_target(x);
                }
            }
            // h.
            if let Some(x) = artists.first() {
                if similarity(name_of(x), q) >= 0.6 {
                    return artist_target(x);
                }
            }
            Target::NotFound
        }
    }
}

/// Body for PUT /me/player/play; None for Ask/Refuse/NotFound.
pub fn play_body(t: &Target) -> Option<Value> {
    match t {
        Target::Context { uri, .. } => Some(json!({ "context_uri": uri })),
        Target::AlbumAt { album_uri, track_uri, .. } => Some(json!({ "context_uri": album_uri, "offset": { "uri": track_uri } })),
        Target::Track { uri, .. } => Some(json!({ "uris": [uri] })),
        Target::Liked { user_id } => Some(json!({ "context_uri": format!("spotify:user:{user_id}:collection") })),
        Target::Ask(_) | Target::Refuse(_) | Target::NotFound => None,
    }
}

/// URI to hand to a launched client (D24): Context uri, AlbumAt track_uri, Track uri,
/// Liked ⇒ "spotify:collection"; None for Ask/Refuse/NotFound.
pub fn launch_uri(t: &Target) -> Option<String> {
    match t {
        Target::Context { uri, .. } | Target::Track { uri, .. } => Some(uri.clone()),
        Target::AlbumAt { track_uri, .. } => Some(track_uri.clone()),
        Target::Liked { .. } => Some("spotify:collection".to_string()),
        Target::Ask(_) | Target::Refuse(_) | Target::NotFound => None,
    }
}

/// Track-only choose for a `track_plans` plan: rule 1 on split plans, rule 2 otherwise; tracks only.
/// Rule 2's fallback also accepts `tracks[0]` when one of its artists is ≥ 0.6 similar to the query, so
/// "queue up Bill Murray" (query aliased to "Bilmuri") picks a Bilmuri track (contract §6g wording).
pub fn pick_track(plan: &SearchPlan, search: &Value) -> Option<TrackRef> {
    let tracks = items(search, "tracks");
    let q = plan.match_query.as_str();
    let hit = match &plan.split {
        Some((t, a)) => split_track(&tracks, t, a),
        None => tracks.iter().copied().find(|x| similarity(name_of(x), q) >= 0.8).or_else(|| {
            tracks.first().copied().filter(|x| similarity(name_of(x), q) >= 0.5 || artist_names(x).iter().any(|n| similarity(n, q) >= 0.6))
        }),
    };
    hit.and_then(parse_track)
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! fixture {
        ($name:literal) => {
            serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/spotify/", $name))).expect($name)
        };
    }

    fn req(q: &str, kind: Option<SearchKind>, prefer_playlist: bool) -> PlayRequest {
        PlayRequest { query: q.into(), kind, my: false, prefer_playlist, liked: false }
    }

    fn first_target(r: &PlayRequest, replies: &[Value]) -> Target {
        let plans = plan_searches(r);
        assert_eq!(plans.len(), replies.len(), "one reply per plan");
        plans.iter().zip(replies).map(|(p, v)| choose(p, v)).find(|t| *t != Target::NotFound).unwrap_or(Target::NotFound)
    }

    #[test]
    fn norm_folds_case_accents_punctuation_and_the() {
        assert_eq!(norm("The Beatles"), "beatles");
        assert_eq!(norm("  Beyoncé  "), "beyonce");
        assert_eq!(norm("Simon & Garfunkel"), "simon and garfunkel");
        assert_eq!(norm("What's Playing?"), "whats playing");
        assert_eq!(norm("Mötley Crüe"), "motley crue");
        assert_eq!(norm("Theory of Everything"), "theory of everything");
        assert_eq!(norm(""), "");
    }

    #[test]
    fn similarity_rules() {
        assert_eq!(similarity("Late Night", "late night!"), 1.0);
        assert_eq!(similarity("Late Night", "Late Night Drive"), 0.9);
        assert_eq!(similarity("jazz", "Jazz Classics"), 0.9);
        // Shorter than 4 chars: no substring bonus.
        assert!(similarity("me", "stand by me") < 0.9);
        assert!((similarity("Era", "Erra") - 0.75).abs() < 1e-6);
        assert!((similarity("Late Nite", "Late Night") - 0.7).abs() < 1e-6);
        assert_eq!(similarity("abc", "xyz"), 0.0);
        assert_eq!(levenshtein("kitten", "sitting"), 3);
    }

    #[test]
    fn alias_is_whole_query_only() {
        assert_eq!(alias("Bill Murray"), Some("Bilmuri"));
        assert_eq!(alias("bill murray"), Some("Bilmuri"));
        assert_eq!(alias("Bilmuri"), Some("Bilmuri"));
        assert_eq!(alias("Era"), Some("Erra"));
        assert_eq!(alias("The Era of Peace"), None);
        assert_eq!(alias("Tell Me"), None);
        assert_eq!(split_by("Song by Bill Murray"), ("Song".to_string(), Some("Bilmuri".to_string())));
    }

    #[test]
    fn split_by_uses_the_last_by() {
        assert_eq!(split_by("Tell Me by Groove Theory"), ("Tell Me".to_string(), Some("Groove Theory".to_string())));
        assert_eq!(split_by("Stand by Me by Ben E. King"), ("Stand by Me".to_string(), Some("Ben E. King".to_string())));
        assert_eq!(split_by("Stand BY Me"), ("Stand".to_string(), Some("Me".to_string())));
        assert_eq!(split_by("by Me"), ("by Me".to_string(), None));
        assert_eq!(split_by("Bilmuri"), ("Bilmuri".to_string(), None));
    }

    #[test]
    fn is_current_table() {
        for q in [
            "",
            "current",
            "this",
            "it",
            "that",
            "this song",
            "This Track",
            "this one",
            "that song",
            "that track",
            "that one",
            "the current song",
            "current track",
            "the song that's playing",
            "the song playing",
            "what's playing",
            "what I'm listening to",
        ] {
            assert!(is_current(q), "{q:?}");
        }
        for q in ["Tell Me", "this is america", "the song", "it girl", "current joys"] {
            assert!(!is_current(q), "{q:?}");
        }
    }

    #[test]
    fn spoken_title_table() {
        for (input, want) in [
            ("Here Comes the Sun - Remastered 2009", "Here Comes the Sun"),
            ("Bohemian Rhapsody - 2011 Remaster", "Bohemian Rhapsody"),
            ("Heroes (Remastered 2017)", "Heroes"),
            ("Song 2 - Radio Edit", "Song 2"),
            ("Tell Me (feat. Someone)", "Tell Me"),
            ("Tell Me [feat. Someone & Other]", "Tell Me"),
            ("Tell Me (ft. Someone)", "Tell Me"),
            ("Plain Title", "Plain Title"),
            ("(feat. X)", "(feat. X)"),
        ] {
            assert_eq!(spoken_title(input), want, "{input:?}");
        }
    }

    #[test]
    fn join_names_and_plural() {
        let n = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(join_names(&n(&[])), "");
        assert_eq!(join_names(&n(&["A"])), "A");
        assert_eq!(join_names(&n(&["A", "B"])), "A and B");
        assert_eq!(join_names(&n(&["A", "B", "C"])), "A, B and C");
        assert_eq!(join_names(&n(&["A", "B", "C", "D"])), "A, B, C and others");
        assert_eq!(plural(1, "song"), "1 song");
        assert_eq!(plural(0, "song"), "0 songs");
        assert_eq!(plural(3, "song"), "3 songs");
        assert_eq!(playlist_label("Late Night", true), "your Late Night playlist");
        assert_eq!(playlist_label("Jazz Classics", false), "the playlist Jazz Classics");
    }

    #[test]
    fn playlists_page_parses_null_safely() {
        let lists = parse_playlists_page(&fixture!("me_playlists_page.json"));
        let names: Vec<&str> = lists.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Late Night", "Late Night Drive", "Road Trip", "Late Nite"]);
        assert_eq!(lists[0].total, Some(12)); // items.total
        assert_eq!(lists[1].total, Some(30)); // legacy tracks.total
        assert_eq!(lists[2].total, None);
        assert!(lists[1].collaborative);
        assert_eq!(lists[0].owner_id, "me_user");
        assert_eq!(lists[0].uri, "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
        assert_eq!(lists[2].uri, "spotify:playlist:5ABHKGoOzxkaa28ttQV9sE"); // built from id
        assert_eq!(lists[0].snapshot_id.as_deref(), Some("snap1"));
        assert!(parse_playlists_page(&json!({})).is_empty());
    }

    #[test]
    fn match_playlist_rules() {
        let lists = parse_playlists_page(&fixture!("me_playlists_page.json"));
        let by = |names: &[&str]| lists.iter().filter(|p| names.contains(&p.name.as_str())).cloned().collect::<Vec<_>>();
        // Exact wins over the prefix match.
        let two = by(&["Late Night", "Late Night Drive"]);
        assert!(matches!(match_playlist("late night", &two, OWN_MATCH_MIN), PlaylistMatch::One(p) if p.name == "Late Night"));
        // "Late Nite" is 0.7 (< 0.75); "Late Night Drive" is a whole-word superstring (0.9) ⇒ One(Drive).
        let fuzzy = by(&["Late Nite", "Late Night Drive"]);
        assert!(matches!(match_playlist("late night", &fuzzy, OWN_MATCH_MIN), PlaylistMatch::One(p) if p.name == "Late Night Drive"));
        // Two equally good fuzzy candidates ⇒ Ambiguous.
        let amb = by(&["Late Night Drive", "Road Trip"]);
        let amb = [amb[0].clone(), PlaylistRef { name: "Late Night Mix".into(), ..amb[1].clone() }];
        assert!(matches!(match_playlist("late night", &amb, OWN_MATCH_MIN), PlaylistMatch::Ambiguous(a, b) if a.name == "Late Night Drive" && b.name == "Late Night Mix"));
        // Below threshold ⇒ None.
        assert_eq!(match_playlist("workout", &lists, OWN_MATCH_MIN), PlaylistMatch::None);
        let nite = fuzzy.iter().find(|p| p.name == "Late Nite").unwrap().clone();
        assert_eq!(match_playlist("late nite", &fuzzy, OWN_EXACTISH_MIN), PlaylistMatch::One(nite));
    }

    #[test]
    fn untyped_own_playlist_needs_more_than_containment() {
        let base = parse_playlists_page(&fixture!("me_playlists_page.json"))[0].clone();
        let named = |n: &str| PlaylistRef { name: n.into(), ..base.clone() };
        // Substring hits (0.9) never pass the untyped threshold, in either direction.
        assert_eq!(match_playlist("Bilmuri", &[named("Bilmuri Mix")], OWN_EXACTISH_MIN), PlaylistMatch::None);
        assert_eq!(match_playlist("Tell Me by Groove Theory", &[named("Tell Me")], OWN_EXACTISH_MIN), PlaylistMatch::None);
        // An exact (norm) name still wins.
        assert!(matches!(match_playlist("bilmuri mix", &[named("Bilmuri Mix")], OWN_EXACTISH_MIN), PlaylistMatch::One(_)));
        // The typed / "my … playlist" threshold keeps accepting containment.
        assert!(matches!(match_playlist("Bilmuri", &[named("Bilmuri Mix")], OWN_MATCH_MIN), PlaylistMatch::One(_)));
    }

    #[test]
    fn parse_track_shapes() {
        let cur = parse_track(&fixture!("currently_playing.json")).unwrap();
        assert_eq!(cur.name, "Tell Me");
        assert_eq!(cur.artists, ["Groove Theory"]);
        assert_eq!(cur.album_uri.as_deref(), Some("spotify:album:2AbCdEfGhIjKlMnOpQrStU"));
        assert_eq!(cur.album_name.as_deref(), Some("Groove Theory"));
        assert_eq!(cur.release_year.as_deref(), Some("1995"));
        assert_eq!(cur.duration_ms, Some(287_000));
        assert!(!cur.is_episode);

        let ep = parse_track(&fixture!("currently_playing_episode.json")).unwrap();
        assert!(ep.is_episode);
        assert_eq!(ep.artists, ["The Daily Show Podcast"]);
        assert_eq!(ep.album_name.as_deref(), Some("The Daily Show Podcast"));
        assert_eq!(ep.album_uri, None);
        assert_eq!(ep.release_year.as_deref(), Some("2026"));

        // Episode detected by uri prefix alone.
        let bare = parse_track(&json!({"uri": "spotify:episode:0123456789abcdefghijkl", "name": "E"})).unwrap();
        assert!(bare.is_episode);
        assert_eq!(parse_track(&json!({"name": "no uri"})), None);
        assert_eq!(parse_track(&Value::Null), None);
    }

    #[test]
    fn playlist_items_read_item_then_track() {
        let page = fixture!("playlist_items_page.json");
        let tracks: Vec<TrackRef> = page["items"].as_array().unwrap().iter().filter_map(parse_track).collect();
        let names: Vec<&str> = tracks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["Tell Me", "Smoke Signals", "A Podcast Episode"]);
        assert!(tracks[2].is_episode);
    }

    #[test]
    fn queue_items_parse() {
        let q = fixture!("queue_padded.json");
        let cur = parse_track(&q["currently_playing"]).unwrap();
        assert_eq!(cur.name, "Tell Me");
        let queue: Vec<TrackRef> = q["queue"].as_array().unwrap().iter().filter_map(parse_track).collect();
        assert_eq!(queue.len(), 7); // one null skipped; repeats kept here (WP-E dedups)
        assert!(queue.iter().any(|t| t.uri == cur.uri));
    }

    #[test]
    fn play_args_precedence() {
        let uri = "spotify:artist:0123456789abcdefghijkl";
        assert_eq!(play_args(&json!({"uri": uri, "playlist_name": "Late Night", "query": "x"})), PlayArgs::Uri(uri.into()));
        // Invalid uri falls through.
        assert!(matches!(play_args(&json!({"uri": "spotify:artist:short", "query": "x"})), PlayArgs::Request(r) if r.query == "x"));
        assert_eq!(
            play_args(&json!({"playlist_name": "Late Night", "query": "x", "prefer_playlist": true})),
            PlayArgs::Request(PlayRequest { query: "Late Night".into(), kind: Some(SearchKind::Playlist), my: true, prefer_playlist: true, liked: false })
        );
        assert!(matches!(play_args(&json!({"playlist_name": "liked songs"})), PlayArgs::Request(r) if r.liked && r.my));
        assert!(matches!(play_args(&json!({"query": "my favorites"})), PlayArgs::Request(r) if r.liked && !r.my));
        assert!(matches!(play_args(&json!({"query": "Erra", "type": "artist"})), PlayArgs::Request(r) if r.kind == Some(SearchKind::Artist)));
        assert!(matches!(play_args(&json!({"query": "Erra", "kind": "album"})), PlayArgs::Request(r) if r.kind == Some(SearchKind::Album)));
        assert_eq!(play_args(&json!({})), PlayArgs::Resume);
        assert_eq!(play_args(&json!({"query": "  "})), PlayArgs::Resume);
        assert_eq!(play_args(&Value::Null), PlayArgs::Resume);
    }

    #[test]
    fn plan_searches_branches() {
        // Typed: one plan, no whole-query alias for artist/track (Risk 8).
        let p = plan_searches(&req("Era", Some(SearchKind::Artist), false));
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].q.as_str(), p[0].types, p[0].match_query.as_str()), ("Era", "artist", "Era"));
        let p = plan_searches(&req("Era", Some(SearchKind::Track), false));
        assert_eq!((p[0].q.as_str(), p[0].types), ("Era", "track"));
        // Album / playlist kinds still alias.
        let p = plan_searches(&req("Era", Some(SearchKind::Album), false));
        assert_eq!((p[0].q.as_str(), p[0].types), ("Erra", "album"));
        // Untyped, no "by": single mixed plan, aliased.
        let p = plan_searches(&req("Bill Murray", None, true));
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].q.as_str(), p[0].types, p[0].match_query.as_str(), p[0].prefer_playlist), ("Bilmuri", MIXED, "Bilmuri", true));
        assert_eq!(p[0].split, None);
        // Untyped with "by": field filter, "T A", whole query.
        let p = plan_searches(&req("Tell Me by Groove Theory", None, false));
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].q, "track:\"Tell Me\" artist:\"Groove Theory\"");
        assert_eq!((p[0].types, p[0].match_query.as_str()), ("track", "Tell Me"));
        assert_eq!(p[0].split, Some(("Tell Me".into(), "Groove Theory".into())));
        assert_eq!((p[1].q.as_str(), p[1].types), ("Tell Me Groove Theory", "track"));
        assert_eq!((p[2].q.as_str(), p[2].types, p[2].split.clone()), ("Tell Me by Groove Theory", MIXED, None));
        // Quotes stripped from filters; aliased artist part.
        let p = plan_searches(&req("\"Ameno\" by Era", None, false));
        assert_eq!(p[0].q, "track:\"Ameno\" artist:\"Erra\"");
        for plans in [plan_searches(&req("a by b", None, false)), plan_searches(&req("x", Some(SearchKind::Playlist), false))] {
            assert!(plans.iter().all(|p| p.limit <= 10 && p.limit == 5));
        }
    }

    #[test]
    fn track_plans_are_track_only() {
        let p = track_plans("Bill Murray");
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].q.as_str(), p[0].types, p[0].match_query.as_str()), ("Bilmuri", "track", "Bilmuri"));
        let p = track_plans("Tell Me by Groove Theory");
        assert_eq!(p.len(), 3);
        assert!(p.iter().all(|p| p.types == "track" && p.limit == 5));
        assert_eq!(p[2].q, "Tell Me by Groove Theory");
    }

    #[test]
    fn choose_bilmuri_artist() {
        let t = first_target(&req("Bill Murray", None, true), &[fixture!("search_bilmuri.json")]);
        assert_eq!(t, Target::Context { uri: "spotify:artist:3BilmuriArtistIdAbcdeF".into(), label: "Bilmuri".into(), kind: SearchKind::Artist });
    }

    #[test]
    fn choose_era_resolves_to_erra() {
        let plans = plan_searches(&req("Era", None, false));
        assert_eq!(plans[0].match_query, "Erra");
        let t = choose(&plans[0], &fixture!("search_erra.json"));
        assert!(matches!(t, Target::Context { ref label, kind: SearchKind::Artist, .. } if label == "Erra"), "{t:?}");
    }

    #[test]
    fn choose_tell_me_field_filter_plays_inside_album() {
        let r = req("Tell Me by Groove Theory", None, false);
        let plans = plan_searches(&r);
        let t = choose(&plans[0], &fixture!("search_tell_me_groove_theory.json"));
        assert_eq!(
            t,
            Target::AlbumAt { album_uri: "spotify:album:2AbCdEfGhIjKlMnOpQrStU".into(), track_uri: "spotify:track:1TellMeGrooveTheoryAbc".into(), label: "Tell Me by Groove Theory".into() }
        );
        let body = play_body(&t).unwrap();
        assert_eq!(body, json!({"context_uri": "spotify:album:2AbCdEfGhIjKlMnOpQrStU", "offset": {"uri": "spotify:track:1TellMeGrooveTheoryAbc"}}));
        assert_eq!(launch_uri(&t).as_deref(), Some("spotify:track:1TellMeGrooveTheoryAbc"));
    }

    #[test]
    fn choose_stand_by_me_falls_back_to_whole_query() {
        let split = fixture!("search_stand_by_me_split.json");
        let t = first_target(&req("Stand by Me", None, false), &[split.clone(), split, fixture!("search_stand_by_me_whole.json")]);
        assert!(matches!(t, Target::AlbumAt { ref label, .. } if label == "Stand by Me by Ben E. King"), "{t:?}");
    }

    #[test]
    fn choose_ameno_by_era_uses_aliased_artist() {
        let plans = plan_searches(&req("Ameno by Era", None, false));
        assert_eq!(plans[0].split, Some(("Ameno".into(), "Erra".into())));
        let reply = fixture!("search_ameno_by_erra.json");
        // Contract deviation (reported): with the pinned similarity formula, sim("Era", "Erra") = 0.75 ≥ 0.7,
        // so the split plan already accepts Era's "Ameno" — the song the user most likely meant.
        let t = choose(&plans[0], &reply);
        assert!(matches!(t, Target::AlbumAt { ref label, .. } if label == "Ameno by Era"), "{t:?}");
        // The whole-query plan (q "Ameno by Era", no alias) finds the same track.
        assert_eq!(plans[2].q, "Ameno by Era");
        let whole = choose(&plans[2], &json!({"tracks": {"items": [reply["tracks"]["items"][1].clone()]}}));
        assert!(matches!(whole, Target::AlbumAt { ref label, .. } if label == "Ameno by Era"), "{whole:?}");
        // An artist below 0.7 is rejected by rule 1.
        let other = SearchPlan { split: Some(("Ameno".into(), "Erra".into())), ..plans[0].clone() };
        let wrong = json!({"tracks": {"items": [{"name": "Ameno", "uri": "spotify:track:0123456789abcdefghijkl", "artists": [{"name": "Enya"}]}]}});
        assert_eq!(choose(&other, &wrong), Target::NotFound);
    }

    #[test]
    fn choose_era_mixed_typed_and_untyped() {
        let reply = fixture!("search_era_mixed.json");
        // Typed artist: no alias, exact "Era".
        let plans = plan_searches(&req("Era", Some(SearchKind::Artist), false));
        assert!(matches!(choose(&plans[0], &reply), Target::Context { ref label, kind: SearchKind::Artist, .. } if label == "Era"));
        // Typed track: "Era" by someone else.
        let plans = plan_searches(&req("Era", Some(SearchKind::Track), false));
        assert!(matches!(choose(&plans[0], &reply), Target::AlbumAt { ref label, .. } if label == "Era by Kaleidoscope Drift"));
        // Untyped plan built by hand on the non-aliased name: artist [0] and track [0] by another artist ⇒ Ask.
        let untyped = SearchPlan { q: "Era".into(), types: MIXED, limit: 5, match_query: "Era".into(), split: None, kind: None, prefer_playlist: false };
        assert!(matches!(choose(&untyped, &reply), Target::Ask(_)));
    }

    #[test]
    fn choose_ambiguous_yellow_asks() {
        let t = first_target(&req("Yellow", None, false), &[fixture!("search_ambiguous_yellow.json")]);
        assert_eq!(
            t,
            Target::Ask("Did you mean the artist Yellow or the song Yellow by Coldplay? Say \"play the artist Yellow\" or \"play the song Yellow\".".into())
        );
        assert_eq!(play_body(&t), None);
        assert_eq!(launch_uri(&t), None);
    }

    #[test]
    fn choose_jazz_prefers_playlist() {
        let reply = fixture!("search_jazz_mixed.json");
        let t = first_target(&req("jazz", None, true), &[reply.clone()]);
        assert_eq!(t, Target::Context { uri: "spotify:playlist:4JazzClassicsPlaylistA".into(), label: "the playlist Jazz Classics".into(), kind: SearchKind::Playlist });
        // Without prefer_playlist the fuzzy first track wins (rule 6g).
        let t = first_target(&req("jazz", None, false), &[reply.clone()]);
        assert!(matches!(t, Target::AlbumAt { ref label, .. } if label == "Smooth Jazz Vibes by Late Lounge"), "{t:?}");
        // Typed playlist: rule 5.
        let plans = plan_searches(&req("jazz", Some(SearchKind::Playlist), false));
        assert!(matches!(choose(&plans[0], &reply), Target::Context { kind: SearchKind::Playlist, .. }));
        // Typed album: no album above 0.7 ⇒ albums[0].
        let plans = plan_searches(&req("jazz", Some(SearchKind::Album), false));
        assert!(matches!(choose(&plans[0], &reply), Target::Context { ref label, kind: SearchKind::Album, .. } if label == "the album Kind of Blue by Miles Davis"));
    }

    #[test]
    fn choose_empty_is_not_found() {
        let empty = fixture!("search_empty.json");
        for r in [req("anything", None, true), req("x", Some(SearchKind::Track), false), req("x", Some(SearchKind::Artist), false), req("x", Some(SearchKind::Album), false), req("x", Some(SearchKind::Playlist), false)] {
            for p in plan_searches(&r) {
                assert_eq!(choose(&p, &empty), Target::NotFound);
            }
        }
        assert_eq!(choose(&plan_searches(&req("x", None, false))[0], &json!({})), Target::NotFound);
    }

    #[test]
    fn play_body_shapes() {
        let artist = Target::Context { uri: "spotify:artist:a".into(), label: "A".into(), kind: SearchKind::Artist };
        assert_eq!(play_body(&artist), Some(json!({"context_uri": "spotify:artist:a"})));
        assert!(play_body(&artist).unwrap().get("offset").is_none());
        assert_eq!(play_body(&Target::Track { uri: "spotify:track:t".into(), label: "T".into() }), Some(json!({"uris": ["spotify:track:t"]})));
        assert_eq!(play_body(&Target::Liked { user_id: "me".into() }), Some(json!({"context_uri": "spotify:user:me:collection"})));
        assert_eq!(launch_uri(&Target::Liked { user_id: "me".into() }).as_deref(), Some("spotify:collection"));
        assert_eq!(play_body(&Target::Refuse("no".into())), None);
        assert_eq!(play_body(&Target::NotFound), None);
        assert_eq!(launch_uri(&artist).as_deref(), Some("spotify:artist:a"));
    }

    #[test]
    fn pick_track_rules() {
        // Split plan: rule 1.
        let plans = track_plans("Tell Me by Groove Theory");
        let t = pick_track(&plans[0], &fixture!("search_tell_me_groove_theory.json")).unwrap();
        assert_eq!(t.uri, "spotify:track:1TellMeGrooveTheoryAbc");
        assert_eq!(pick_track(&plans[0], &fixture!("search_empty.json")), None);
        // Aliased artist query on a track search: a Bilmuri track via the artist fallback.
        let plans = track_plans("Bill Murray");
        let t = pick_track(&plans[0], &fixture!("search_bilmuri.json")).unwrap();
        assert_eq!(t.artists, ["Bilmuri"]);
        // Nothing similar ⇒ None.
        let unrelated = json!({"tracks": {"items": [null, {"name": "Zzz", "uri": "spotify:track:0123456789abcdefghijkl", "artists": [{"name": "Qqq"}]}]}});
        assert_eq!(pick_track(&track_plans("Tell Me")[0], &unrelated), None);
    }

    #[test]
    fn search_kind_round_trip() {
        for k in [SearchKind::Track, SearchKind::Artist, SearchKind::Album, SearchKind::Playlist] {
            assert_eq!(SearchKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(SearchKind::parse("Song"), Some(SearchKind::Track));
        assert_eq!(SearchKind::parse("podcast"), None);
    }
}
