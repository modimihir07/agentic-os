//! Live routing trace for the System Map (plan §2): the `os-trace` event.
//!
//! Every hop of a turn the Rust side can see (router decision, rules / identity
//! load, memory / Librarian reads, model calls, MCP tool calls) becomes one
//! `TraceStep`. The webview adds its own client-side hops (input, VAD, STT, TTS,
//! UI) under the same `traceId`, which it passes in on `os_turn`.
//!
//! A step carries labels, timings and error text only: never tool arguments,
//! tool results, prompts or replies, and every label / error goes through the
//! dev-queue secret scrubber before it is emitted.
//!
//! The current trace rides a tokio task-local (`scoped`), so code deep inside a
//! turn (`mcp::call_tool`) joins it without new parameters; outside a turn
//! (Settings → Test, a pipeline) each step gets a standalone trace id.

use serde::Serialize;
use std::future::Future;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

/// Tauri event name (webview: `onNativeEvent("os-trace", …)`).
pub const EVENT: &str = "os-trace";
const LABEL_MAX: usize = 160;
const ERROR_MAX: usize = 200;
const ID_MAX: usize = 64;

/// Which stage of a turn a step belongs to. Input / Vad / Stt / Tts / Ui are measured and
/// emitted by the webview; they are listed here so the enum is the whole vocabulary.
#[allow(dead_code)]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Hop {
    Input,
    Vad,
    Stt,
    Router,
    Rules,
    Memory,
    Model,
    Tool,
    Tts,
    Ui,
}

/// Where on the car a hop lights up.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Cockpit,
    Engine,
    Ecu,
    Cargo,
    Exhaust,
}

impl Hop {
    /// input/vad/stt/tts/ui → cockpit, router/model → engine, rules → ecu, memory → cargo, tool → exhaust.
    pub fn zone(self) -> Zone {
        match self {
            Hop::Input | Hop::Vad | Hop::Stt | Hop::Tts | Hop::Ui => Zone::Cockpit,
            Hop::Router | Hop::Model => Zone::Engine,
            Hop::Rules => Zone::Ecu,
            Hop::Memory => Zone::Cargo,
            Hop::Tool => Zone::Exhaust,
        }
    }
}

/// One hop of a turn. `at` = unix ms; `ms` = how long the hop took.
/// `tps` (model hops only, when the token stream allowed measuring it) = tokens per second.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TraceStep {
    pub trace_id: String,
    pub seq: u32,
    pub hop: Hop,
    pub zone: Zone,
    pub label: String,
    pub ok: bool,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps: Option<f64>,
}

struct TraceCtx {
    id: String,
    seq: AtomicU32,
}

tokio::task_local! {
    static CTX: Arc<TraceCtx>;
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called once from `lib.rs` setup; before that (and in unit tests) steps are built but not emitted.
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A fresh random trace id (uuid v4 shape).
pub fn new_id() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; 16];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// A caller-supplied trace id is used only if it is short and plain (`[A-Za-z0-9_:-]`).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= ID_MAX && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}

/// Run `fut` as trace `id`: every step emitted inside it (across awaits, same task) shares the id
/// and gets the next `seq`.
pub async fn scoped<F: Future>(id: String, fut: F) -> F::Output {
    CTX.scope(Arc::new(TraceCtx { id, seq: AtomicU32::new(0) }), fut).await
}

/// `(trace id, next seq)` of the trace this task is running in, if any.
fn current() -> Option<(String, u32)> {
    CTX.try_with(|c| (c.id.clone(), c.seq.fetch_add(1, Ordering::Relaxed))).ok()
}

fn cap(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

/// Pure step builder: scrubs and caps the label and error, drops a meaningless `tps`.
/// `trace` = `(id, seq)` of the current trace; `None` = a standalone step (new id, seq 0).
#[allow(clippy::too_many_arguments)]
pub fn build(trace: Option<(String, u32)>, hop: Hop, label: &str, ok: bool, ms: u64, error: Option<&str>, tps: Option<f64>, known: &[String], at: u64) -> TraceStep {
    let (trace_id, seq) = trace.unwrap_or_else(|| (new_id(), 0));
    let scrub = |s: &str| super::devqueue::scrub(s, known);
    TraceStep {
        trace_id,
        seq,
        hop,
        zone: hop.zone(),
        label: cap(&scrub(label), LABEL_MAX),
        ok,
        ms,
        error: error.map(str::trim).filter(|e| !e.is_empty()).map(|e| cap(&scrub(e), ERROR_MAX)),
        at,
        tps: tps.filter(|t| t.is_finite() && *t > 0.0).map(|t| (t * 10.0).round() / 10.0),
    }
}

/// Emit one step into the current trace. `known` = secret values to cut from the label / error
/// (pass `devqueue::known_secrets` whenever `error` may echo a backend's text).
pub fn emit_with(hop: Hop, label: &str, ok: bool, ms: u128, error: Option<&str>, tps: Option<f64>, known: &[String]) {
    let step = build(current(), hop, label, ok, ms.min(u64::MAX as u128) as u64, error, tps, known, now_ms());
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit(EVENT, &step);
    }
}

/// `emit_with` without a `tps` or known-secret list (label / error still pattern-scrubbed).
pub fn emit(hop: Hop, label: &str, ok: bool, ms: u128, error: Option<&str>) {
    emit_with(hop, label, ok, ms, error, None, &[]);
}

/// Generation rate of a streamed reply. Prefers the backend's own `usage.completion_tokens`
/// over the time from first to last delta; otherwise counts SSE content deltas (one token each
/// on OpenAI-compatible local servers) over the same window. `None` when it can't be measured.
pub fn tokens_per_sec(deltas: u32, usage_tokens: Option<u64>, gen_ms: f64) -> Option<f64> {
    if !(gen_ms.is_finite() && gen_ms > 0.0) {
        return None;
    }
    let tokens = match usage_tokens {
        Some(u) if u >= 2 => (u - 1) as f64,
        _ if deltas >= 2 => (deltas - 1) as f64,
        _ => return None,
    };
    Some(tokens / (gen_ms / 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_mapping_matches_plan() {
        for h in [Hop::Input, Hop::Vad, Hop::Stt, Hop::Tts, Hop::Ui] {
            assert_eq!(h.zone(), Zone::Cockpit);
        }
        assert_eq!(Hop::Router.zone(), Zone::Engine);
        assert_eq!(Hop::Model.zone(), Zone::Engine);
        assert_eq!(Hop::Rules.zone(), Zone::Ecu);
        assert_eq!(Hop::Memory.zone(), Zone::Cargo);
        assert_eq!(Hop::Tool.zone(), Zone::Exhaust);
    }

    #[test]
    fn step_serializes_to_the_ts_shape() {
        let s = build(Some(("t1".into(), 3)), Hop::Tool, "whatsapp.send_message", false, 42, Some("HTTP 401"), None, &[], 1_700_000_000_000);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["traceId"], "t1");
        assert_eq!(v["seq"], 3);
        assert_eq!(v["hop"], "tool");
        assert_eq!(v["zone"], "exhaust");
        assert_eq!(v["ok"], false);
        assert_eq!(v["ms"], 42);
        assert_eq!(v["error"], "HTTP 401");
        assert_eq!(v["at"], 1_700_000_000_000u64);
        assert!(v.get("tps").is_none());
        let ok = build(Some(("t1".into(), 4)), Hop::Model, "lmstudio · qwen", true, 900, Some("  "), Some(41.26), &[], 1);
        let v = serde_json::to_value(&ok).unwrap();
        assert!(v.get("error").is_none());
        assert_eq!(v["tps"], 41.3);
    }

    #[test]
    fn labels_and_errors_are_scrubbed_and_capped() {
        let known = vec!["supersecretvalue123".to_string()];
        let s = build(None, Hop::Tool, "github.search", false, 1, Some("401: Bearer abcdefghijklmnop rejected (key supersecretvalue123)"), None, &known, 0);
        let e = s.error.unwrap();
        assert!(!e.contains("abcdefghijklmnop"), "{e}");
        assert!(!e.contains("supersecretvalue123"), "{e}");
        assert_eq!(s.seq, 0);
        assert!(valid_id(&s.trace_id));
        let long = "x".repeat(1000);
        let s = build(None, Hop::Model, &long, false, 1, Some(&long), None, &[], 0);
        assert_eq!(s.label.chars().count(), LABEL_MAX + 1);
        assert_eq!(s.error.unwrap().chars().count(), ERROR_MAX + 1);
    }

    #[test]
    fn bad_tps_is_dropped() {
        for t in [f64::NAN, f64::INFINITY, 0.0, -3.0] {
            assert!(build(None, Hop::Model, "m", true, 1, None, Some(t), &[], 0).tps.is_none());
        }
    }

    #[test]
    fn trace_ids_from_callers_are_validated() {
        assert!(valid_id("3f2a-01_b:c"));
        assert!(valid_id(&new_id()));
        assert!(!valid_id(""));
        assert!(!valid_id("has space"));
        assert!(!valid_id("<script>"));
        assert!(!valid_id(&"a".repeat(65)));
    }

    #[test]
    fn tokens_per_sec_prefers_usage_then_deltas() {
        assert_eq!(tokens_per_sec(11, None, 1000.0), Some(10.0));
        assert_eq!(tokens_per_sec(11, Some(21), 1000.0), Some(20.0));
        assert_eq!(tokens_per_sec(1, None, 1000.0), None);
        assert_eq!(tokens_per_sec(50, None, 0.0), None);
        assert_eq!(tokens_per_sec(50, None, f64::NAN), None);
        // A bogus usage count falls back to the delta count.
        assert_eq!(tokens_per_sec(6, Some(0), 500.0), Some(10.0));
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn scoped_steps_share_the_trace_and_count_up() {
        let got = block_on(scoped("turn-1".into(), async {
            let a = current();
            tokio::task::yield_now().await;
            let b = current();
            (a, b)
        }));
        assert_eq!(got, (Some(("turn-1".into(), 0)), Some(("turn-1".into(), 1))));
        // Outside a scope there is no current trace.
        assert_eq!(block_on(async { current() }), None);
    }
}
