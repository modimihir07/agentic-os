//! Persistent stdio MCP sessions: one long-lived child per server, shared by
//! `tools/list` and `tools/call`, so a chat tool call never cold-spawns a server
//! that is already running.
//!
//! - One registry entry per server id, keyed by the server's fingerprint: editing
//!   the command line / env / cwd / timeout starts a fresh session.
//! - Requests carry their own JSON-RPC id; a reader thread routes each reply to the
//!   waiting request (`Pending`). Server→client requests (`ping`, `roots/list`) are
//!   answered so a server never stalls waiting on us.
//! - `initialize` runs in the background with the server's startup timeout; callers
//!   wait only as long as they choose (`wait_ready`) and otherwise get a
//!   "is still starting" error while the start finishes on its own.
//! - stderr is drained into a 4 KB ring (a full pipe would block a chatty server);
//!   its tail goes into error text, which callers scrub before showing or logging.
//! - The child is created suspended, put in a kill-on-close Job Object (`proc::Job`)
//!   and only then resumed, so nothing it starts escapes: retiring a session, the idle
//!   reaper (5 min) and an app crash all end the whole process tree.
//! - stdin is written by a dedicated writer thread fed through a bounded queue: no async
//!   worker, Drop or the reader thread ever blocks on a pipe a hung server stopped
//!   reading. A full queue, or two timeouts in a row, retires the session.
//! - A session whose process exits fails its pending requests with "exited before
//!   replying" and is dropped from the registry; the next request respawns it.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, watch};

pub(crate) const PROTOCOL: &str = "2025-06-18";
/// A session nobody used for this long is stopped (its listing stays cached).
pub(crate) const IDLE_TTL: Duration = Duration::from_secs(300);
const REAP_EVERY: Duration = Duration::from_secs(30);
const STDERR_MAX: usize = 4096;
/// How much of the stderr tail goes into an error message.
const TAIL_CHARS: usize = 400;
/// Marker in every "still starting" error (`mcp::status_of` maps it to "starting").
pub(crate) const STARTING: &str = "is still starting";
/// Bytes queued for a server's stdin beyond which it counts as not reading its input.
const STDIN_QUEUE_MAX: usize = 256 * 1024;
/// Consecutive request timeouts after which a session is treated as hung and retired.
const MAX_TIMEOUTS: u32 = 2;
/// Marker in the error for a server whose stdin queue is full.
pub(crate) const NOT_READING: &str = "is not reading its input";

// ── Pure parts ──────────────────────────────────────────────────────────────

/// The last `max` bytes a stream produced.
pub(crate) struct Ring {
    buf: VecDeque<u8>,
    max: usize,
    /// Older output was dropped, so the buffer may start mid-word.
    cut: bool,
}

impl Ring {
    pub(crate) fn new(max: usize) -> Self {
        Ring { buf: VecDeque::with_capacity(max.min(8192)), max, cut: false }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) {
        if bytes.len() > self.max {
            self.cut = true;
        }
        let bytes = if bytes.len() > self.max { &bytes[bytes.len() - self.max..] } else { bytes };
        let over = (self.buf.len() + bytes.len()).saturating_sub(self.max);
        if over > 0 {
            self.cut = true;
        }
        self.buf.drain(..over);
        self.buf.extend(bytes);
    }

    /// The last `chars` characters (lossy UTF-8), whitespace collapsed to single spaces.
    /// Whenever text was cut off in front, the partial first word is dropped too: a
    /// secret that straddled the cut must not leave a fragment the scrubber can't
    /// recognise (it only knows whole values).
    pub(crate) fn tail(&self, chars: usize) -> String {
        let (a, b) = self.buf.as_slices();
        let mut v = Vec::with_capacity(a.len() + b.len());
        v.extend_from_slice(a);
        v.extend_from_slice(b);
        let text = String::from_utf8_lossy(&v);
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let n = flat.chars().count();
        let start = n.saturating_sub(chars);
        if start == 0 && !self.cut {
            return flat;
        }
        let kept: String = flat.chars().skip(start).collect();
        // Whole words only: the kept text starts clean if the char before it is a space
        // (or, at the buffer's front, if nothing was dropped there).
        let clean = if start > 0 { flat.chars().nth(start - 1) == Some(' ') } else { !self.cut };
        let rest = if clean { kept.as_str() } else { kept.find(' ').map_or("", |i| &kept[i + 1..]) };
        format!("…{rest}")
    }
}

/// Requests awaiting a reply, by JSON-RPC id. Ids start at 1 and never repeat.
pub(crate) struct Pending<T> {
    next: u64,
    map: HashMap<u64, T>,
}

impl<T> Pending<T> {
    pub(crate) fn new() -> Self {
        Pending { next: 1, map: HashMap::new() }
    }

    pub(crate) fn alloc(&mut self, v: T) -> u64 {
        let id = self.next;
        self.next += 1;
        self.map.insert(id, v);
        id
    }

    pub(crate) fn take(&mut self, id: u64) -> Option<T> {
        self.map.remove(&id)
    }

    pub(crate) fn drain(&mut self) -> Vec<T> {
        self.map.drain().map(|(_, v)| v).collect()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }
}

/// One line from a server's stdout.
#[derive(Debug, PartialEq)]
pub(crate) enum Incoming {
    /// A reply to one of our requests.
    Response { id: u64, result: Result<Value, String> },
    /// The server asks us something (`ping`, `roots/list`, …) and waits for an answer.
    ServerRequest { id: Value, method: String },
    /// A notification, a log line or anything else: ignored.
    Other,
}

pub(crate) fn classify(line: &str) -> Incoming {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return Incoming::Other };
    let id = v.get("id").filter(|i| !i.is_null());
    if let (Some(id), Some(method)) = (id, v.get("method").and_then(|m| m.as_str())) {
        return Incoming::ServerRequest { id: id.clone(), method: method.to_string() };
    }
    let Some(id) = id.and_then(|i| i.as_u64().or_else(|| i.as_str().and_then(|s| s.parse().ok()))) else { return Incoming::Other };
    if let Some(e) = v.get("error") {
        let msg = e["message"].as_str().unwrap_or("MCP error").to_string();
        return Incoming::Response { id, result: Err(msg) };
    }
    if v.get("result").is_some() {
        return Incoming::Response { id, result: Ok(v["result"].clone()) };
    }
    Incoming::Other
}

/// Our answer to a server→client request: `ping` and `roots/list` succeed, anything
/// else (sampling, elicitation…) is refused as unsupported.
pub(crate) fn server_request_reply(id: &Value, method: &str) -> Value {
    match method {
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
        _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported by this client" } }),
    }
}

/// The idle reaper's decision: nothing in flight and unused for `ttl`.
pub(crate) fn should_reap(idle_for: Duration, busy: usize, ttl: Duration) -> bool {
    busy == 0 && idle_for >= ttl
}

fn with_tail(msg: String, tail: &str) -> String {
    if tail.is_empty() {
        msg
    } else {
        format!("{msg} — stderr: {tail}")
    }
}

pub(crate) fn timeout_msg(name: &str, method: &str, secs: u64, tail: &str) -> String {
    with_tail(format!("{name}: no reply to {method} within {secs}s"), tail)
}

pub(crate) fn exited_msg(name: &str, method: &str, code: Option<i32>, tail: &str) -> String {
    let code = code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
    with_tail(format!("{name}: exited before replying to {method}{code}"), tail)
}

pub(crate) fn starting_msg(name: &str, so_far: Duration, startup: Duration) -> String {
    format!("{name} {STARTING} ({}s so far, allowing up to {}s for a cold start) — its tools will be ready shortly", so_far.as_secs(), startup.as_secs())
}

/// A spawn error in plain words (Rust refuses some arguments to .cmd/.bat files).
pub(crate) fn spawn_err(display: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::InvalidInput => format!("could not start {display}: an argument contains characters that can't be passed safely to a .cmd/.bat script — point the command at the real .exe or simplify the arguments"),
        std::io::ErrorKind::NotFound => format!("could not start {display}: not found"),
        std::io::ErrorKind::PermissionDenied => format!("could not start {display}: access denied"),
        _ => format!("could not start {display}: {e}"),
    }
}

// ── Sessions ────────────────────────────────────────────────────────────────

/// Everything needed to start one server.
#[derive(Clone, Debug)]
pub(crate) struct Launch {
    pub id: String,
    pub name: String,
    /// `mcp::server_fingerprint` of the config this session runs.
    pub fp: u64,
    pub program: PathBuf,
    /// The command as the user typed it (for messages).
    pub display: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub path_env: OsString,
    pub cwd: Option<PathBuf>,
    pub startup: Duration,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Phase {
    Starting,
    Ready,
    Failed(String),
}

type Reply = oneshot::Sender<Result<Value, String>>;

/// Why the last session of a server (for one config fingerprint) ended.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum End {
    /// Stopped by the idle reaper: its cached listing is still good.
    Reaped,
    /// Exited on its own, failed `initialize`, or hung: its listing proves nothing.
    Crashed(String),
}

static ENDED: Mutex<Option<HashMap<String, (u64, End)>>> = Mutex::new(None);

fn mark_end(id: &str, fp: u64, end: Option<End>) {
    let mut g = ENDED.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    match end {
        Some(e) => {
            m.insert(id.to_string(), (fp, e));
        }
        None => {
            m.remove(id);
        }
    }
}

/// How server `id`'s last session for config `fp` ended, if one did since it was last ready.
pub(crate) fn last_end(id: &str, fp: u64) -> Option<End> {
    let g = ENDED.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref()?.get(id).filter(|(f, _)| *f == fp).map(|(_, e)| e.clone())
}

pub(crate) struct Session {
    pub launch: Launch,
    /// Lines for the writer thread (which owns the child's stdin). `None` = stdin closed.
    tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    /// Bytes handed to the writer thread and not yet written.
    queued: Arc<AtomicUsize>,
    /// Requests that timed out in a row (reset by any reply).
    timeouts: AtomicU32,
    child: Mutex<Option<Child>>,
    job: Mutex<Option<crate::proc::Job>>,
    pid: u32,
    pending: Mutex<Pending<(String, Reply)>>,
    stderr: Arc<Mutex<Ring>>,
    phase: watch::Sender<Phase>,
    busy: AtomicUsize,
    last_used: Mutex<Instant>,
    dead: AtomicBool,
    started: Instant,
}

static SESSIONS: Mutex<Option<HashMap<String, Arc<Session>>>> = Mutex::new(None);

fn sessions() -> std::sync::MutexGuard<'static, Option<HashMap<String, Arc<Session>>>> {
    SESSIONS.lock().unwrap_or_else(|p| p.into_inner())
}

impl Session {
    fn spawn(launch: Launch) -> Result<Arc<Session>, String> {
        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args).envs(&launch.env).env("PATH", &launch.path_env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = &launch.cwd {
            // Never fall back to this app's own folder: relative args would resolve elsewhere.
            if !dir.is_dir() {
                return Err(format!("could not start {}: working folder {} does not exist", launch.display, dir.display()));
            }
            cmd.current_dir(dir);
        }
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let (mut child, job) = crate::proc::spawn_in_job(&mut cmd, CREATE_NO_WINDOW).map_err(|e| spawn_err(&launch.display, &e))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();
        let (phase, _) = watch::channel(Phase::Starting);
        let queued = Arc::new(AtomicUsize::new(0));
        let tx = stdin.map(|mut w| {
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let q = queued.clone();
            // The only code that touches the pipe. It exits (dropping stdin = EOF for the
            // server) when every sender is gone and the queue is drained, or when a write
            // fails (the process was killed).
            std::thread::spawn(move || {
                while let Ok(buf) = rx.recv() {
                    q.fetch_sub(buf.len(), Ordering::SeqCst);
                    if w.write_all(&buf).and_then(|_| w.flush()).is_err() {
                        break;
                    }
                }
            });
            tx
        });
        let s = Arc::new(Session {
            pid: child.id(),
            launch,
            tx: Mutex::new(tx),
            queued,
            timeouts: AtomicU32::new(0),
            child: Mutex::new(Some(child)),
            job: Mutex::new(job),
            pending: Mutex::new(Pending::new()),
            stderr: Arc::new(Mutex::new(Ring::new(STDERR_MAX))),
            phase,
            busy: AtomicUsize::new(0),
            last_used: Mutex::new(Instant::now()),
            dead: AtomicBool::new(false),
            started: Instant::now(),
        });
        if let Some(mut err) = stderr {
            let ring = s.stderr.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                loop {
                    match err.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => ring.lock().unwrap_or_else(|p| p.into_inner()).push(&buf[..n]),
                    }
                }
            });
        }
        let reader = s.clone();
        std::thread::spawn(move || reader.read_loop(stdout));
        Ok(s)
    }

    fn read_loop(self: Arc<Self>, stdout: std::process::ChildStdout) {
        let mut r = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf);
            match classify(&line) {
                Incoming::Response { id, result } => {
                    let waiter = self.pending.lock().unwrap_or_else(|p| p.into_inner()).take(id);
                    if let Some((_, tx)) = waiter {
                        let _ = tx.send(result);
                    }
                }
                Incoming::ServerRequest { id, method } => {
                    let _ = self.write(&server_request_reply(&id, &method));
                }
                Incoming::Other => {}
            }
        }
        self.on_exit();
    }

    pub(crate) fn tail(&self) -> String {
        self.stderr.lock().unwrap_or_else(|p| p.into_inner()).tail(TAIL_CHARS)
    }

    fn exit_code(&self, grace: Duration) -> Option<i32> {
        let t0 = Instant::now();
        loop {
            if let Some(c) = self.child.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
                if let Ok(Some(st)) = c.try_wait() {
                    return st.code();
                }
            } else {
                return None;
            }
            if t0.elapsed() >= grace {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// stdout closed: the process exited (or was stopped). Fails everything waiting.
    fn on_exit(self: &Arc<Self>) {
        let was_dead = self.dead.swap(true, Ordering::SeqCst);
        let code = self.exit_code(Duration::from_millis(300));
        let tail = self.tail();
        let waiters = self.pending.lock().unwrap_or_else(|p| p.into_inner()).drain();
        for (method, tx) in waiters {
            let _ = tx.send(Err(exited_msg(&self.launch.name, &method, code, &tail)));
        }
        if *self.phase.borrow() == Phase::Starting {
            self.phase.send_replace(Phase::Failed(exited_msg(&self.launch.name, "initialize", code, &tail)));
        }
        if !was_dead {
            eprintln!("[mcp] {}: session ended{}", self.launch.id, code.map(|c| format!(" (exit code {c})")).unwrap_or_default());
            // Nobody stopped it on purpose: a crash, not an idle stop.
            mark_end(&self.launch.id, self.launch.fp, Some(End::Crashed(exited_msg(&self.launch.name, "a request", code, ""))));
        }
        unregister(self);
        // Make sure grandchildren holding other handles go too.
        self.shutdown_now();
    }

    /// Queue one JSON-RPC line for the writer thread. Never blocks on the pipe.
    pub(crate) fn write(&self, v: &Value) -> Result<(), String> {
        let mut buf = v.to_string().into_bytes();
        buf.push(b'\n');
        let g = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        let tx = g.as_ref().ok_or("stdin closed")?;
        if self.queued.load(Ordering::SeqCst) + buf.len() > STDIN_QUEUE_MAX {
            return Err(format!("{} {NOT_READING}", self.launch.name));
        }
        self.queued.fetch_add(buf.len(), Ordering::SeqCst);
        let len = buf.len();
        tx.send(buf).map_err(|_| {
            self.queued.fetch_sub(len, Ordering::SeqCst);
            "stdin closed".to_string()
        })
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_used.lock().unwrap_or_else(|p| p.into_inner()).elapsed()
    }

    pub(crate) fn phase(&self) -> Phase {
        self.phase.borrow().clone()
    }

    /// Kill the tree right away (no grace). Idempotent.
    fn shutdown_now(&self) {
        // Kill first: a writer stuck on a full pipe then fails and exits. No lock here is
        // ever held across a pipe write.
        let job = self.job.lock().unwrap_or_else(|p| p.into_inner()).take();
        match job {
            Some(j) => j.kill(),
            None => {
                if self.child.lock().unwrap_or_else(|p| p.into_inner()).as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None))) {
                    crate::proc::kill_tree(self.pid);
                }
            }
        }
        self.tx.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut c) = self.child.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// Polite stop: close stdin (servers exit on EOF), wait up to 500 ms, then kill
    /// the tree. Blocking — run it off the async runtime.
    fn shutdown(&self) {
        self.dead.store(true, Ordering::SeqCst);
        // Drop our sender: the writer drains what is queued, then closes stdin (EOF).
        self.tx.lock().unwrap_or_else(|p| p.into_inner()).take();
        let _ = self.exit_code(Duration::from_millis(500));
        self.shutdown_now();
    }
}

/// Remove `s` from the registry if it is still the registered session for its id.
fn unregister(s: &Arc<Session>) {
    let mut g = sessions();
    if let Some(m) = g.as_mut() {
        if m.get(&s.launch.id).is_some_and(|cur| Arc::ptr_eq(cur, s)) {
            m.remove(&s.launch.id);
        }
    }
}

/// Retire a session: unregister it and stop it on a background thread.
fn retire(s: Arc<Session>) {
    s.dead.store(true, Ordering::SeqCst);
    unregister(&s);
    std::thread::spawn(move || s.shutdown());
}

/// Retire a session that failed or hung, remembering it as a crash (so its cached
/// listing isn't trusted as if it had merely gone idle).
fn retire_failed(s: Arc<Session>, why: String) {
    mark_end(&s.launch.id, s.launch.fp, Some(End::Crashed(why)));
    retire(s);
}

/// Take every idle session out of the registry in one lock hold, so `get_or_start`
/// (which checks and touches under the same lock) can never hand out one being reaped.
fn take_idle(m: &mut HashMap<String, Arc<Session>>) -> Vec<Arc<Session>> {
    let ids: Vec<String> = m.iter().filter(|(_, s)| s.phase() != Phase::Starting && should_reap(s.idle_for(), s.busy.load(Ordering::SeqCst), IDLE_TTL)).map(|(k, _)| k.clone()).collect();
    ids.iter()
        .filter_map(|k| m.remove(k))
        .inspect(|s| {
            s.dead.store(true, Ordering::SeqCst);
            mark_end(&s.launch.id, s.launch.fp, Some(End::Reaped));
        })
        .collect()
}

fn ensure_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(REAP_EVERY);
            let idle = sessions().as_mut().map(take_idle).unwrap_or_default();
            for s in idle {
                eprintln!("[mcp] {}: idle for {} min — stopping it", s.launch.id, IDLE_TTL.as_secs() / 60);
                std::thread::spawn(move || s.shutdown());
            }
        });
    });
}

/// The registered live session for `launch` (same config), touched; or None after
/// stopping a registered one that runs another config (or died).
fn live_or_evict(m: &mut HashMap<String, Arc<Session>>, launch: &Launch) -> Option<Arc<Session>> {
    let cur = m.get(&launch.id)?;
    if cur.launch.fp == launch.fp && !cur.dead.load(Ordering::SeqCst) {
        cur.touch();
        return Some(cur.clone());
    }
    if let Some(old) = m.remove(&launch.id) {
        old.dead.store(true, Ordering::SeqCst);
        std::thread::spawn(move || old.shutdown());
    }
    None
}

/// The running session for `launch.id` if it runs the same config, else a fresh one
/// (its `initialize` runs in the background). Blocking (spawns a process) — call it
/// from `spawn_blocking`. The registry lock is never held while the process starts.
pub(crate) fn get_or_start(launch: Launch) -> Result<Arc<Session>, String> {
    ensure_reaper();
    if let Some(s) = live_or_evict(sessions().get_or_insert_with(HashMap::new), &launch) {
        return Ok(s);
    }
    let s = Session::spawn(launch)?;
    let mut g = sessions();
    let m = g.get_or_insert_with(HashMap::new);
    if let Some(winner) = live_or_evict(m, &s.launch) {
        // Lost a race with a concurrent start of the same config: keep the winner.
        drop(g);
        s.dead.store(true, Ordering::SeqCst);
        std::thread::spawn(move || s.shutdown());
        return Ok(winner);
    }
    m.insert(s.launch.id.clone(), s.clone());
    drop(g);
    if s.dead.load(Ordering::SeqCst) {
        // It exited before it was registered (its on_exit found nothing to remove).
        unregister(&s);
    } else {
        tauri::async_runtime::spawn(handshake(s.clone()));
    }
    Ok(s)
}

async fn handshake(s: Arc<Session>) {
    let params = json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "agentic-os", "version": "1.0" } });
    match request(&s, "initialize", params, s.launch.startup).await {
        Ok(_) => {
            let _ = s.write(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
            s.phase.send_replace(Phase::Ready);
            mark_end(&s.launch.id, s.launch.fp, None);
            eprintln!("[mcp] {}: ready in {} ms", s.launch.id, s.started.elapsed().as_millis());
        }
        Err(e) => {
            // on_exit may already have set a (more precise) failure.
            if s.phase() == Phase::Starting {
                s.phase.send_replace(Phase::Failed(e.clone()));
            }
            retire_failed(s, e);
        }
    }
}

/// Wait up to `wait` for the session's `initialize` to finish.
pub(crate) async fn wait_ready(s: &Arc<Session>, wait: Duration) -> Result<(), String> {
    let mut rx = s.phase.subscribe();
    let res = tokio::time::timeout(wait, async {
        match rx.wait_for(|p| *p != Phase::Starting).await {
            Ok(p) => p.clone(),
            Err(_) => Phase::Failed(format!("{}: session closed", s.launch.name)),
        }
    })
    .await;
    match res {
        Ok(Phase::Ready) => Ok(()),
        Ok(Phase::Failed(e)) => Err(e),
        Ok(Phase::Starting) | Err(_) => Err(starting_msg(&s.launch.name, s.started.elapsed(), s.launch.startup)),
    }
}

/// Marks the session busy (so the reaper leaves it alone) for one request, and drops
/// the request's pending slot if the caller goes away before the reply.
struct InFlight<'a> {
    s: &'a Arc<Session>,
    id: u64,
    method: &'a str,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let abandoned = self.s.pending.lock().unwrap_or_else(|p| p.into_inner()).take(self.id).is_some();
        // The caller stopped waiting (timeout / dropped turn): tell the server, so a long
        // tool run can stop. `initialize` must never be cancelled (MCP spec).
        if abandoned && self.method != "initialize" && !self.s.dead.load(Ordering::SeqCst) {
            let _ = self.s.write(&json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": self.id, "reason": "client stopped waiting" } }));
        }
        self.s.busy.fetch_sub(1, Ordering::SeqCst);
        self.s.touch();
    }
}

/// One request over the session, bounded by `timeout`. Does not wait for readiness
/// (use `wait_ready` first, except for `initialize` itself).
pub(crate) async fn request(s: &Arc<Session>, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    s.busy.fetch_add(1, Ordering::SeqCst);
    s.touch();
    let (tx, rx) = oneshot::channel();
    let id = s.pending.lock().unwrap_or_else(|p| p.into_inner()).alloc((method.to_string(), tx));
    let _guard = InFlight { s, id, method };
    if s.dead.load(Ordering::SeqCst) {
        return Err(exited_msg(&s.launch.name, method, None, &s.tail()));
    }
    if let Err(e) = s.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
        if e.contains(NOT_READING) {
            // Hung (its input piled up): stop it; the next request starts a fresh one.
            let msg = with_tail(e, &s.tail());
            retire_failed(s.clone(), msg.clone());
            return Err(msg);
        }
        // A closed pipe means the process is gone.
        return Err(exited_msg(&s.launch.name, method, s.exit_code(Duration::from_millis(200)), &s.tail()));
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(r)) => {
            s.timeouts.store(0, Ordering::SeqCst);
            r
        }
        Ok(Err(_)) => Err(exited_msg(&s.launch.name, method, None, &s.tail())),
        Err(_) => {
            let msg = timeout_msg(&s.launch.name, method, timeout.as_secs(), &s.tail());
            if method != "initialize" && s.timeouts.fetch_add(1, Ordering::SeqCst) + 1 >= MAX_TIMEOUTS {
                eprintln!("[mcp] {}: {MAX_TIMEOUTS} requests in a row timed out — restarting it", s.launch.id);
                retire_failed(s.clone(), msg.clone());
            }
            Err(msg)
        }
    }
}

/// The current session for `id`, if any (for status display).
pub(crate) fn current(id: &str) -> Option<Arc<Session>> {
    sessions().as_ref()?.get(id).cloned()
}

/// A live (not exited / retired) session is registered for server `id`.
pub(crate) fn alive(id: &str) -> bool {
    current(id).is_some_and(|s| !s.dead.load(Ordering::SeqCst))
}

/// Requests in flight on server `id`'s session (0 when it has none).
pub(crate) fn busy(id: &str) -> usize {
    current(id).map_or(0, |s| s.busy.load(Ordering::SeqCst))
}

#[cfg(test)]
pub(crate) fn mark_end_for_test(id: &str, fp: u64, end: End) {
    mark_end(id, fp, Some(end));
}

/// True while server `id`'s session is between spawn and a finished `initialize`.
pub(crate) fn is_starting(id: &str) -> bool {
    current(id).is_some_and(|s| s.phase() == Phase::Starting && !s.dead.load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_only_the_tail() {
        let mut r = Ring::new(8);
        r.push(b"hello ");
        r.push(b"world\n");
        // "o world": the ring cut "hello" mid-word, so its fragment is dropped.
        assert_eq!(r.tail(100), "…world");
        r.push(&[b'x'; 20]);
        assert_eq!(r.tail(100), "…", "one cut word, nothing whole left");
        let mut r = Ring::new(64);
        r.push(b"alpha beta gamma");
        assert_eq!(r.tail(100), "alpha beta gamma");
        assert_eq!(r.tail(8), "…gamma", "the tail cut drops the partial word too");
        assert_eq!(r.tail(5), "…gamma", "a cut on a word boundary keeps the word");
        let mut r = Ring::new(16);
        r.push(&[0xff, 0xfe, b'o', b'k']);
        assert!(r.tail(10).ends_with("ok"), "lossy, never panics");
        assert_eq!(Ring::new(4).tail(10), "");
    }

    #[test]
    fn pending_routes_by_id_and_never_reuses_ids() {
        let mut p: Pending<&str> = Pending::new();
        let a = p.alloc("a");
        let b = p.alloc("b");
        assert_ne!(a, b);
        assert_eq!(p.take(b), Some("b"));
        assert_eq!(p.take(b), None, "a reply is delivered once");
        assert_eq!(p.take(999), None, "unknown ids are ignored");
        let c = p.alloc("c");
        assert!(c > b, "ids keep increasing after a take");
        assert_eq!(p.len(), 2);
        let mut rest = p.drain();
        rest.sort();
        assert_eq!(rest, vec!["a", "c"]);
        assert_eq!(p.len(), 0);
    }

    #[test]
    fn classify_lines() {
        assert_eq!(classify(r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}"#), Incoming::Response { id: 3, result: Ok(json!({ "tools": [] })) });
        assert_eq!(classify(r#"{"jsonrpc":"2.0","id":"4","error":{"code":-1,"message":"nope"}}"#), Incoming::Response { id: 4, result: Err("nope".into()) });
        assert_eq!(classify(r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#), Incoming::ServerRequest { id: json!(7), method: "ping".into() });
        assert_eq!(classify(r#"{"jsonrpc":"2.0","method":"notifications/message","params":{}}"#), Incoming::Other);
        assert_eq!(classify("Starting server on stdio..."), Incoming::Other);
        assert_eq!(classify(r#"{"jsonrpc":"2.0","id":null,"error":{"message":"parse error"}}"#), Incoming::Other);
        assert_eq!(classify("  {\"id\":1,\"result\":null}\r\n"), Incoming::Response { id: 1, result: Ok(Value::Null) });
    }

    #[test]
    fn server_requests_get_answers() {
        assert_eq!(server_request_reply(&json!(1), "ping"), json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
        assert_eq!(server_request_reply(&json!("r"), "roots/list")["result"]["roots"], json!([]));
        assert_eq!(server_request_reply(&json!(2), "sampling/createMessage")["error"]["code"], json!(-32601));
    }

    #[test]
    fn a_secret_straddling_either_cut_leaves_no_fragment() {
        let secret = "SECRETabcdefghij0123456789";
        let mut r = Ring::new(4096);
        r.push(&[b'f'; 50]);
        r.push(secret.as_bytes());
        r.push(" and then some ordinary words".repeat(13).as_bytes());
        let t = r.tail(TAIL_CHARS);
        for k in 4..secret.len() {
            assert!(!t.contains(&secret[secret.len() - k..]), "fragment {} in {t}", &secret[secret.len() - k..]);
        }
        // Ring overflow (head cut) too.
        let mut r = Ring::new(30);
        r.push(format!("{secret} tail words").as_bytes());
        r.push(b" more");
        assert!(!r.tail(400).contains("789"), "{}", r.tail(400));
    }

    #[test]
    fn reaper_takes_idle_sessions_atomically_and_remembers_why() {
        assert_eq!(last_end("never-ran", 1), None);
        mark_end("x-end", 7, Some(End::Reaped));
        assert_eq!(last_end("x-end", 7), Some(End::Reaped));
        assert_eq!(last_end("x-end", 8), None, "another config");
        mark_end("x-end", 7, Some(End::Crashed("boom".into())));
        assert!(matches!(last_end("x-end", 7), Some(End::Crashed(_))));
        mark_end("x-end", 7, None);
        assert_eq!(last_end("x-end", 7), None);
    }

    #[test]
    fn reaper_decision() {
        assert!(should_reap(IDLE_TTL, 0, IDLE_TTL));
        assert!(should_reap(IDLE_TTL + Duration::from_secs(1), 0, IDLE_TTL));
        assert!(!should_reap(IDLE_TTL - Duration::from_secs(1), 0, IDLE_TTL));
        assert!(!should_reap(IDLE_TTL * 10, 1, IDLE_TTL), "a call in flight is never reaped");
    }

    #[test]
    fn messages_name_the_phase_and_tail() {
        assert_eq!(timeout_msg("PAL", "initialize", 120, ""), "PAL: no reply to initialize within 120s");
        assert_eq!(exited_msg("SQLite", "tools/list", Some(1), "boom"), "SQLite: exited before replying to tools/list (exit code 1) — stderr: boom");
        let s = starting_msg("Serena", Duration::from_secs(4), Duration::from_secs(120));
        assert!(s.contains(STARTING) && s.contains("4s so far") && s.contains("120s"), "{s}");
        let e = spawn_err("npx", &std::io::Error::from(std::io::ErrorKind::InvalidInput));
        assert!(e.starts_with("could not start npx:") && e.contains(".cmd/.bat"), "{e}");
    }

    /// End to end against a tiny Python MCP server (skipped when Python isn't installed):
    /// concurrent requests are routed by id, a server ping is answered, the session is
    /// reused, and a crash fails waiters with "exited" and frees the slot for a respawn.
    #[test]
    fn session_round_trip_with_python_fake() {
        let Ok(py) = crate::exe_resolve::resolve_program("python", &BTreeMap::new(), None) else {
            eprintln!("python not found — skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("mcp-session-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake_mcp.py");
        std::fs::write(
            &script,
            r#"
import sys, json, time, os
def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
sys.stderr.write("fake server booting\n"); sys.stderr.flush()
for line in sys.stdin:
    m = json.loads(line)
    meth = m.get("method"); i = m.get("id")
    if meth == "initialize":
        out({"jsonrpc":"2.0","method":"notifications/message","params":{}})
        out({"jsonrpc":"2.0","id":99,"method":"ping"})
        out({"jsonrpc":"2.0","id":i,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}})
    elif meth == "tools/list":
        out({"jsonrpc":"2.0","id":i,"result":{"tools":[{"name":"echo","inputSchema":{"properties":{"x":{}}}}],"pid":os.getpid()}})
    elif meth == "tools/call":
        a = m["params"]["arguments"]
        if a.get("crash"):
            sys.stderr.write("fatal: crashing on purpose\n"); sys.stderr.flush(); os._exit(3)
        time.sleep(a.get("sleep", 0))
        out({"jsonrpc":"2.0","id":i,"result":{"content":[{"type":"text","text":str(a.get("x"))}]}})
"#,
        )
        .unwrap();
        let launch = Launch {
            id: "fake-session-test".into(),
            name: "Fake".into(),
            fp: 42,
            program: py.program.clone(),
            display: "python".into(),
            args: vec!["-u".into(), script.display().to_string()],
            env: BTreeMap::new(),
            path_env: py.path_env.clone(),
            cwd: Some(dir.clone()),
            startup: Duration::from_secs(30),
        };
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let s = get_or_start(launch.clone()).unwrap();
            wait_ready(&s, Duration::from_secs(30)).await.expect("ready");
            let list = request(&s, "tools/list", json!({}), Duration::from_secs(10)).await.unwrap();
            assert_eq!(list["tools"][0]["name"], "echo");
            // Two calls in flight at once: the slow one must not get the fast one's reply.
            let slow = request(&s, "tools/call", json!({ "name": "echo", "arguments": { "x": "slow", "sleep": 0.4 } }), Duration::from_secs(10));
            let fast = async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                request(&s, "tools/call", json!({ "name": "echo", "arguments": { "x": "fast" } }), Duration::from_secs(10)).await
            };
            let (a, b) = futures_util::future::join(slow, fast).await;
            // Python handles stdin in order, so "fast" waits behind "slow" — but each reply
            // still lands on its own request.
            assert_eq!(a.unwrap()["content"][0]["text"], "slow");
            assert_eq!(b.unwrap()["content"][0]["text"], "fast");
            // Same config → same process.
            let again = tokio::task::spawn_blocking({
                let l = launch.clone();
                move || get_or_start(l)
            })
            .await
            .unwrap()
            .unwrap();
            assert!(Arc::ptr_eq(&s, &again));
            // A request that times out leaves the session usable.
            let e = request(&s, "tools/call", json!({ "name": "echo", "arguments": { "x": 1, "sleep": 1.5 } }), Duration::from_millis(200)).await.unwrap_err();
            assert!(e.contains("no reply to tools/call within 0s"), "{e}");
            // A crash fails the waiter with "exited" (+ stderr tail) and frees the slot.
            let e = request(&s, "tools/call", json!({ "name": "echo", "arguments": { "crash": true } }), Duration::from_secs(10)).await.unwrap_err();
            assert!(e.contains("exited before replying to tools/call") && e.contains("crashing on purpose"), "{e}");
            for _ in 0..40 {
                if current("fake-session-test").is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(current("fake-session-test").is_none(), "a dead session is unregistered");
            // The next use respawns.
            let fresh = tokio::task::spawn_blocking(move || get_or_start(launch)).await.unwrap().unwrap();
            assert!(!Arc::ptr_eq(&s, &fresh));
            wait_ready(&fresh, Duration::from_secs(30)).await.expect("respawned");
            retire(fresh);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
