//! Agent routing resolver (Part 1): turns free text into a `Route` using the
//! user's trigger matrix (`OsConfig.routing`). Pure and deterministic — no
//! LLM call here (that's a separate, optional step the caller may add when
//! the result is `Default`/low-confidence — see `agents::run_os_turn`).
//!
//! Mirrored exactly in TS at `src/features/dispatcher/router.ts`. Both sides
//! are checked against the same fixtures (`src/features/dispatcher/router.fixtures.json`)
//! so the two implementations can't quietly drift apart.

use super::os_core::{AgentTriggers, OsConfig};
use serde::{Deserialize, Serialize};

/// Tie-break order for domain scoring (longer/explicit matches win regardless;
/// this only breaks exact score ties). `general`'s own domain triggers are
/// mostly intercepted earlier by the OS-control intent layer (Part 4), so it
/// sits last here as a catch-all, never stealing a tie from a sub-agent.
pub const DOMAIN_TIEBREAK: [&str; 7] = ["booking", "ops", "coder", "designer", "librarian", "prompter", "general"];

/// "(hey tony,? )?(tell|ask|have|get|let|send|route|hand|pass) (it )?(to )?(my|the|our)? NAME…"
const VERBS_A: [&str; 9] = ["tell", "ask", "have", "get", "let", "send", "route", "hand", "pass"];
/// "NAME,? (please )?(check|draft|find|…)" — a direct address followed by a command verb.
const VERBS_B: [&str; 20] = [
    "check", "draft", "find", "look", "search", "tell", "send", "book", "schedule", "fetch", "get", "read", "email", "call", "write", "create", "cancel", "update", "confirm", "fix",
];
const NUMBER_WORDS: [&str; 10] = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    Named,
    Domain,
    Tab,
    Llm,
    Default,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub role: Option<String>,
    pub reason: String,
    /// "high" | "medium" | "low".
    pub confidence: String,
    pub kind: RouteKind,
    /// The request, with any resolved delegation phrase ("tell my booking
    /// agent to…") stripped. Falls back to the original text when stripping
    /// would leave nothing, or for every other kind.
    pub task: String,
}

/// lowercase; strip punctuation except `&`; collapse whitespace; fix the
/// three Whisper mangles the spec calls out ("whats up/app", "what sapp" →
/// "whatsapp"); spell out number words 1..10 so "last five messages" matches
/// the trigger phrase "last 5 messages".
///
/// NOTE: this is a normalization for MATCHING only — `Route::task` is built
/// from this normalized text (lower-case, punctuation-stripped), not the
/// original casing/punctuation, to keep the two-language implementation
/// simple and identical. That's a deliberate, documented simplification.
pub fn normalize(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '&' {
            cleaned.extend(ch.to_lowercase());
        } else if ch.is_whitespace() {
            cleaned.push(' ');
        }
        // any other punctuation is dropped entirely (not replaced by a space),
        // so "what's" normalizes to "whats", not "what s".
    }
    let mut s = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [(" whats up ", " whatsapp "), (" whats app ", " whatsapp "), (" what sapp ", " whatsapp ")] {
        let padded = format!(" {s} ");
        if padded.contains(from) {
            s = padded.replace(from, to).trim().to_string();
        }
    }
    s.split(' ')
        .map(|w| match NUMBER_WORDS.iter().position(|n| *n == w) {
            Some(i) => (i + 1).to_string(),
            None => w.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Leading interjections a spoken request may open with ("aye tony, …", "yo jarvis …").
/// An explicit list only: guessing "one unknown word before the name" would turn
/// "play tony bennett" into "bennett". No bare "a" / "i" (Whisper's "aye"): real words.
const INTERJECTIONS: [&str; 15] = ["hey", "hi", "aye", "ay", "ayy", "ayo", "yo", "oi", "ok", "okay", "alright", "so", "um", "uh", "yeah"];
const POLITE_LEADS: [&str; 8] = ["please", "can you", "could you", "would you", "will you", "go ahead and", "i want you to", "i need you to"];

/// `s` starts with the word(s) `lead` (case-insensitive) followed by a space,
/// `, : ; ! .` or the end → the rest, with separators trimmed. (Not `-`: "so-called".)
fn strip_lead<'a>(s: &'a str, lead: &str) -> Option<&'a str> {
    let head = s.get(..lead.len())?;
    if !head.eq_ignore_ascii_case(lead) {
        return None;
    }
    let rest = &s[lead.len()..];
    if !(rest.is_empty() || rest.starts_with([' ', ',', ':', ';', '!', '.'])) {
        return None;
    }
    Some(rest.trim_start_matches([' ', ',', '.', '!', ':', ';', '-']))
}

/// "Aye, Tony, can you play some Bilmuri?" → "play some Bilmuri": drops a leading
/// interjection, the OS's name (`os_name`, "tony", "jarvis") and politeness leads,
/// keeping the original casing. Only explicit leading words are removed, so
/// "play tony bennett" stays intact.
pub(crate) fn strip_address(text: &str, os_name: &str) -> String {
    const EDGE: [char; 8] = [',', '.', '!', '?', ':', ';', '-', ' '];
    let name = os_name.trim().to_ascii_lowercase();
    let mut names: Vec<&str> = vec!["tony", "jarvis"];
    if !name.is_empty() && !names.contains(&name.as_str()) {
        names.insert(0, &name);
    }
    let mut s = text.trim().trim_matches(EDGE);
    for _ in 0..4 {
        let before = s;
        if let Some(r) = INTERJECTIONS.iter().find_map(|w| strip_lead(s, w)) {
            s = r;
        }
        if let Some(r) = names.iter().find_map(|w| strip_lead(s, w)) {
            s = r;
        }
        if let Some(r) = POLITE_LEADS.iter().find_map(|w| strip_lead(s, w)) {
            s = r;
        }
        s = s.trim_matches(EDGE);
        if s == before {
            break;
        }
    }
    s.to_string()
}

fn tokenize(s: &str) -> Vec<&str> {
    s.split(' ').filter(|w| !w.is_empty()).collect()
}

fn tok_at<'a>(toks: &[&'a str], i: usize) -> Option<&'a str> {
    toks.get(i).copied()
}

fn role_rank(role: &str) -> usize {
    DOMAIN_TIEBREAK.iter().position(|r| *r == role).unwrap_or(DOMAIN_TIEBREAK.len())
}

/// All (role, normalized trigger phrase) pairs for every role's `names`.
fn name_pairs(cfg: &OsConfig) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (role, t) in &cfg.routing.agents {
        for n in &t.names {
            let norm = normalize(n);
            if !norm.is_empty() {
                out.push((role.clone(), norm));
            }
        }
    }
    out
}

/// Does one of `names` match starting exactly at `toks[pos..]`? The longest
/// phrase wins on overlap; ties broken by `DOMAIN_TIEBREAK` order.
fn match_name_at(toks: &[&str], pos: usize, names: &[(String, String)]) -> Option<(String, usize)> {
    let mut best: Option<(String, usize)> = None;
    for (role, phrase) in names {
        let p = tokenize(phrase);
        if p.is_empty() || pos + p.len() > toks.len() {
            continue;
        }
        if &toks[pos..pos + p.len()] == p.as_slice() {
            let better = match &best {
                None => true,
                Some((br, bl)) => p.len() > *bl || (p.len() == *bl && role_rank(role) < role_rank(br)),
            };
            if better {
                best = Some((role.clone(), p.len()));
            }
        }
    }
    best
}

fn match_name_anywhere(toks: &[&str], names: &[(String, String)]) -> Option<String> {
    let mut best: Option<(String, usize)> = None;
    for pos in 0..toks.len() {
        if let Some((role, len)) = match_name_at(toks, pos, names) {
            let better = match &best {
                None => true,
                Some((br, bl)) => len > *bl || (len == *bl && role_rank(&role) < role_rank(br)),
            };
            if better {
                best = Some((role, len));
            }
        }
    }
    best.map(|(r, _)| r)
}

/// Does `phrase` occur as a contiguous run of whole tokens anywhere in `toks`?
fn contains_phrase(toks: &[&str], phrase: &str) -> bool {
    let p = tokenize(phrase);
    if p.is_empty() || p.len() > toks.len() {
        return false;
    }
    toks.windows(p.len()).any(|w| w == p.as_slice())
}

fn domain_score(toks: &[&str], t: &AgentTriggers) -> usize {
    t.domains.iter().map(|d| normalize(d)).filter(|dn| !dn.is_empty() && contains_phrase(toks, dn)).map(|dn| dn.len()).sum()
}

/// Resolve one utterance against the routing matrix. Priority:
///  (a) explicit delegation pattern → Named, high
///  (b) any name trigger mentioned anywhere → Named, medium
///  (c) domain trigger score (longest phrases win; ties → `DOMAIN_TIEBREAK`) → Domain
///  (d) nothing → Default (the caller decides: keep the current tab, or `general`)
pub fn resolve(text: &str, cfg: &OsConfig) -> Route {
    let original = text.trim().to_string();
    let norm = normalize(&original);
    let toks = tokenize(&norm);
    let names = name_pairs(cfg);

    // (a) "tell/ask/have/get/let/send/route/hand/pass (it)? (to)? (my/the/our)? NAME (agent/desk)? (to/about/for)? …"
    for i in 0..toks.len() {
        if !VERBS_A.contains(&toks[i]) {
            continue;
        }
        let mut j = i + 1;
        if tok_at(&toks, j) == Some("it") {
            j += 1;
        }
        if tok_at(&toks, j) == Some("to") {
            j += 1;
        }
        if matches!(tok_at(&toks, j), Some("my") | Some("the") | Some("our")) {
            j += 1;
        }
        if let Some((role, nlen)) = match_name_at(&toks, j, &names) {
            let mut k = j + nlen;
            if matches!(tok_at(&toks, k), Some("agent") | Some("desk")) {
                k += 1;
            }
            if matches!(tok_at(&toks, k), Some("to") | Some("about") | Some("for")) {
                k += 1;
            }
            let task = toks[k..].join(" ");
            return Route {
                role: Some(role),
                reason: "you named this agent directly".into(),
                confidence: "high".into(),
                kind: RouteKind::Named,
                task: if task.is_empty() { original } else { task },
            };
        }
    }
    // (a) "NAME,? (please)? VERB…" — direct address at the start of the utterance.
    if let Some((role, nlen)) = match_name_at(&toks, 0, &names) {
        let mut k = nlen;
        if tok_at(&toks, k) == Some("please") {
            k += 1;
        }
        if matches!(tok_at(&toks, k), Some(v) if VERBS_B.contains(&v)) {
            let task = toks[k..].join(" ");
            return Route {
                role: Some(role),
                reason: "you named this agent directly".into(),
                confidence: "high".into(),
                kind: RouteKind::Named,
                task: if task.is_empty() { original } else { task },
            };
        }
    }
    // (b) any name trigger mentioned anywhere.
    if let Some(role) = match_name_anywhere(&toks, &names) {
        return Route { role: Some(role), reason: "this agent was named in the request".into(), confidence: "medium".into(), kind: RouteKind::Named, task: original };
    }
    // (c) domain triggers.
    let mut best: Option<(&str, usize)> = None;
    for role in DOMAIN_TIEBREAK.iter().copied() {
        let Some(t) = cfg.routing.agents.get(role) else { continue };
        let score = domain_score(&toks, t);
        if score > 0 && best.map(|(_, bs)| score > bs).unwrap_or(true) {
            best = Some((role, score));
        }
    }
    if let Some((role, score)) = best {
        return Route {
            role: Some(role.to_string()),
            reason: "matched this agent's trigger words".into(),
            confidence: if score >= 6 { "medium".into() } else { "low".into() },
            kind: RouteKind::Domain,
            task: original,
        };
    }
    // (d) nothing matched.
    Route { role: None, reason: "no name or trigger matched".into(), confidence: "low".into(), kind: RouteKind::Default, task: original }
}

// ── Direct live-tool questions ──────────────────────────────────────────────
//
// "Any WhatsApp updates?", "check my inbox", "will it rain tomorrow", "what's playing":
// read questions Tony answers from his own live tools, whichever tab is open. A
// Named delegation still wins (the caller checks that); a write aimed at the
// service ("reply to Sam on WhatsApp", "draft an email") never matches.

/// Write verbs: the line asks to change something, not to read it.
const DIRECT_WRITE: &str = r"\b(?:send|sending|reply|replying|respond|draft|delete|write|compose|forward|archive|trash|unsubscribe)\b|\b(?:text|message|tell|email|ping|call) (?:him|her|them|back)\b|\blet (?:him|her|them) know\b";
const DIRECT_WHATSAPP_READ: &str = r"\b(?:check|read|any|anything|new|latest|last|recent|unread|updates?|messages?|texts?|chats?|today|whats new|who)\b";
/// Whisper's "what's up" also normalizes to "whatsapp": that form needs a messaging noun.
const DIRECT_WHATSAPP_NOUN: &str = r"\b(?:messages?|texts?|chats?|updates?|unread)\b";
const DIRECT_GMAIL: &str = r"\b(?:gmail|inbox|emails?|mail)\b";
const DIRECT_GMAIL_READ: &str = r"\b(?:check|read|any|anything|new|latest|last|recent|unread|updates?|whats in|from|today|got)\b";
const DIRECT_WEATHER: &str = r"\b(?:weather|forecast|umbrella)\b|\bhow (?:hot|cold|warm) is it\b|\b(?:is it|will it|gonna|going to) (?:rain|snow)\b|\btemperature (?:outside|today|tonight|tomorrow|in|out)\b|\bwhats the temperature\b";
const DIRECT_SPOTIFY: &str = r"\b(?:whats playing|what is playing|now playing|what song is this|whats this song|what song is playing|which song is this)\b";

fn direct_re(slot: &'static std::sync::OnceLock<regex::Regex>, pat: &str) -> &'static regex::Regex {
    slot.get_or_init(|| regex::Regex::new(pat).unwrap())
}

/// The live tool a read question is for: "whatsapp" | "gmail" | "weather" | "spotify".
/// Mirrored exactly by `directTool()` in router.ts (shared fixtures, `direct` field).
pub fn direct_tool(text: &str) -> Option<&'static str> {
    static WRITE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WA: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WA_READ: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WA_NOUN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static GMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static GMAIL_READ: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WEATHER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SPOTIFY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let n = normalize(text);
    if n.is_empty() || direct_re(&WRITE, DIRECT_WRITE).is_match(&n) {
        return None;
    }
    if direct_re(&WA, r"\bwhatsapp\b").is_match(&n) {
        let lower = text.to_lowercase();
        let says_app = lower.contains("sapp") || lower.contains("s app");
        let read = if says_app { n == "whatsapp" || direct_re(&WA_READ, DIRECT_WHATSAPP_READ).is_match(&n) } else { direct_re(&WA_NOUN, DIRECT_WHATSAPP_NOUN).is_match(&n) };
        if read {
            return Some("whatsapp");
        }
    }
    if direct_re(&GMAIL, DIRECT_GMAIL).is_match(&n) && direct_re(&GMAIL_READ, DIRECT_GMAIL_READ).is_match(&n) {
        return Some("gmail");
    }
    if direct_re(&WEATHER, DIRECT_WEATHER).is_match(&n) {
        return Some("weather");
    }
    if direct_re(&SPOTIFY, DIRECT_SPOTIFY).is_match(&n) {
        return Some("spotify");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        #[allow(dead_code)]
        desc: String,
        text: String,
        role: Option<String>,
        kind: String,
        #[serde(default)]
        task_contains: Option<String>,
        /// `direct_tool`'s answer; missing = None.
        #[serde(default)]
        direct: Option<String>,
    }

    fn kind_str(k: RouteKind) -> &'static str {
        match k {
            RouteKind::Named => "Named",
            RouteKind::Domain => "Domain",
            RouteKind::Tab => "Tab",
            RouteKind::Llm => "Llm",
            RouteKind::Default => "Default",
        }
    }

    #[test]
    fn shared_fixtures() {
        let raw = include_str!("../../../src/features/dispatcher/router.fixtures.json");
        let fixtures: Vec<Fixture> = serde_json::from_str(raw).expect("fixtures parse");
        let cfg = OsConfig::default();
        assert!(fixtures.len() >= 10, "expected a decent fixture set");
        for f in &fixtures {
            let r = resolve(&f.text, &cfg);
            assert_eq!(r.role, f.role, "role mismatch for {:?}", f.text);
            assert_eq!(kind_str(r.kind), f.kind, "kind mismatch for {:?}", f.text);
            if let Some(needle) = &f.task_contains {
                assert!(r.task.contains(needle.as_str()), "task {:?} should contain {:?} (text: {:?})", r.task, needle, f.text);
            }
            assert_eq!(direct_tool(&f.text), f.direct.as_deref(), "direct tool mismatch for {:?}", f.text);
        }
    }

    #[test]
    fn direct_tool_reads_match_and_writes_never_do() {
        for (text, tool) in [
            ("any WhatsApp updates?", "whatsapp"),
            ("Hey Tony, anything new on WhatsApp", "whatsapp"),
            ("read my last 3 whatsapp messages", "whatsapp"),
            ("what's in my inbox", "gmail"),
            ("did I get any mail today", "gmail"),
            ("is it going to snow tonight", "weather"),
            ("how cold is it outside", "weather"),
            ("what song is this", "spotify"),
        ] {
            assert_eq!(direct_tool(text), Some(tool), "{text}");
        }
        for text in ["send a whatsapp to Sam", "delete my last email", "tell him on whatsapp I'm late", "play purple rain", "what's the CPU temperature", "hey what's up", ""] {
            assert_eq!(direct_tool(text), None, "{text}");
        }
    }

    #[test]
    fn normalize_handles_mangles_and_numbers() {
        assert_eq!(normalize("what's up"), "whatsapp");
        assert_eq!(normalize("whats app"), "whatsapp");
        assert_eq!(normalize("what sapp"), "whatsapp");
        assert_eq!(normalize("last five messages"), "last 5 messages");
        assert_eq!(normalize("B&Co"), "b&co");
    }

    #[test]
    fn strip_address_drops_interjection_name_and_politeness() {
        assert_eq!(strip_address("aye tony can you play some bilmuri", "Tony"), "play some bilmuri");
        assert_eq!(strip_address("Aye, Tony, play Bilmuri on Spotify.", "Tony"), "play Bilmuri on Spotify");
        assert_eq!(strip_address("ayy tony pause the music", "Tony"), "pause the music");
        assert_eq!(strip_address("yo jarvis what's playing?", "Tony"), "what's playing");
        assert_eq!(strip_address("Hey, Friday, please could you skip this", "Friday"), "skip this");
        assert_eq!(strip_address("ok so um play jazz", "Tony"), "play jazz");
        assert_eq!(strip_address("oi Tony: I need you to pause", "Tony"), "pause");
        // The name as the object / an artist stays.
        assert_eq!(strip_address("play tony bennett", "Tony"), "play tony bennett");
        assert_eq!(strip_address("play something by tony", "Tony"), "play something by tony");
        // Interjections are whole words only.
        assert_eq!(strip_address("hiking trails near me", "Tony"), "hiking trails near me");
        assert_eq!(strip_address("sometimes I wonder", "Tony"), "sometimes I wonder");
        assert_eq!(strip_address("  ", "Tony"), "");
        assert_eq!(strip_address("Tony?", "Tony"), "");
        // Non-ASCII text never panics on a char boundary.
        assert_eq!(strip_address("éé hey", "Tony"), "éé hey");
    }

    #[test]
    fn whole_word_boundaries_only() {
        let cfg = OsConfig::default();
        // "book" must not match "booking"'s name triggers via substring.
        let r = resolve("please book a table for two", &cfg);
        assert_eq!(r.kind, RouteKind::Default);
        // "ui" must not match inside "quick".
        let r = resolve("give me a quick summary", &cfg);
        assert_eq!(r.kind, RouteKind::Default);
    }

    #[test]
    fn domain_tie_break_prefers_booking_over_ops() {
        let cfg = OsConfig::default();
        let r = resolve("schedule a reminder about my messages", &cfg);
        assert_eq!(r.role, Some("booking".to_string()));
        assert_eq!(r.kind, RouteKind::Domain);
    }
}
