"""
Command Center gateway API (mounted by server.py under /api/cc).

Everything here is local-first and standard-library only:

  * Shared store      SQLite collections (notes, reminders, finance, …). The
                      phone (PWA over NetBird / Wi-Fi) and the desktop read and
                      write the same rows, which is how they stay in sync.
  * Files             Scanned receipts / invoices / checks / scripts on disk.
  * Local LLM         OpenAI-compatible endpoint (LM Studio by default) for
                      OCR via a vision model, brainstorm organizing, JSON gen.
  * Vector vault      Local embeddings (LM Studio /embeddings) + lexical
                      fallback, so search works even with no embedding model.
  * Market proxy      Candles for the Day Trading companion chart (no broker).
  * Backups           Scheduled + on-demand zip of the db, files and configs.

No bank / Plaid / broker connections exist or should be added here.
"""
from __future__ import annotations

import array
import base64
import json
import math
import mimetypes
import queue
import re
import shutil
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent.resolve()
CC_DIR = BASE_DIR / "data" / "command-center"
FILES_DIR = CC_DIR / "files"
DB_PATH = CC_DIR / "cc.db"
CONFIG_PATH = CC_DIR / "config.json"

DEFAULT_CONFIG: dict[str, Any] = {
    # Zero-cost local LLM for OCR, organizing, widget generation and embeddings.
    "llm": {
        "baseUrl": "http://127.0.0.1:1234/v1",
        "model": "",  # empty = first model the server lists
        "visionModel": "",  # e.g. a Qwen2.5-VL / LLaVA build loaded in LM Studio
        "embeddingModel": "text-embedding-nomic-embed-text-v1.5",
        "timeoutSecs": 120,
    },
    "backup": {
        "enabled": True,
        "intervalHours": 24,
        "keep": 14,
        "dir": str(BASE_DIR / "backups" / "command-center"),
    },
}

COLLECTIONS = {
    "notes",  # brainstorm sessions
    "reminders",  # alarms, countdowns, reminders (+ Google Calendar mirror)
    "pipeline",  # auditions, self-tapes, callbacks, bookings
    "projects",  # contracting: estimates, bids, follow-ups
    "income",  # revenue entries
    "goals",  # savings goals / structures
    "invoices",
    "checks",
    "receipts",  # scanned receipts with HST/GST breakdown
    "documents",  # misc scanned docs / scripts
    "widgets",  # generated custom widget definitions
    "ideas",  # Ideas & Tasks ledger (Tony → Prompter → Librarian)
    "playplace",  # staged prototypes from the Designer / Coder pipeline
    "cues",  # Voice & Triggers widgets (Gabagool Mode, startup welcome, timed cues)
}

# Which fields get embedded into the vault, per collection.
VAULT_FIELDS: dict[str, list[str]] = {
    "notes": ["title", "rawText", "organized"],
    "receipts": ["vendor", "date", "category", "total", "hst", "gst", "notes", "ocrText"],
    "invoices": ["number", "client", "items", "notes", "total"],
    "checks": ["payer", "amount", "memo", "notes"],
    "pipeline": ["title", "role", "kind", "status", "casting", "notes", "script"],
    "projects": ["client", "job", "status", "notes", "estimate"],
    "documents": ["title", "notes", "ocrText"],
    "ideas": ["title", "idea", "summary", "tasks", "spec", "status"],
    "playplace": ["title", "idea", "brief", "blueprint", "buildPlan", "notes", "status"],
}

MAX_UPLOAD = 15 * 1024 * 1024
ALLOWED_UPLOAD = ("image/", "application/pdf", "audio/", "text/plain")

router = APIRouter(prefix="/api/cc", tags=["command-center"])
_db_lock = threading.Lock()


# ── config ───────────────────────────────────────────────────────────────────

def _why(e: BaseException, limit: int = 160) -> str:
    """Human-readable reason, never empty (some network errors stringify to '')."""
    msg = str(getattr(e, "reason", "") or e) or repr(e)
    return f"{type(e).__name__}: {msg}"[:limit]


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return _deep_merge(DEFAULT_CONFIG, json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    return json.loads(json.dumps(DEFAULT_CONFIG))


def save_config(cfg: dict) -> None:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def _valid_http_url(u: str) -> bool:
    p = urllib.parse.urlparse(u or "")
    return p.scheme in ("http", "https") and bool(p.netloc)


# ── database ─────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """Commit on success, roll back on error, and always close (sqlite3's own
    context manager never closes, which leaks handles and locks files on Windows)."""
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with _db_lock, db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS items(
              id TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL,
              created REAL NOT NULL, updated REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS items_coll_upd ON items(collection, updated);
            CREATE TABLE IF NOT EXISTS files(
              id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, path TEXT, created REAL);
            CREATE TABLE IF NOT EXISTS vault(
              item_id TEXT PRIMARY KEY, collection TEXT, text TEXT, vector BLOB, model TEXT, updated REAL);
            CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT, updated REAL);
            """
        )


def _row(r: sqlite3.Row) -> dict:
    d = json.loads(r["data"])
    d.update(id=r["id"], _created=r["created"], _updated=r["updated"], _deleted=bool(r["deleted"]))
    return d


def _coll(name: str) -> str:
    if name not in COLLECTIONS:
        raise HTTPException(404, f"Unknown collection '{name}'")
    return name


def _clean(data: dict) -> dict:
    return {k: v for k, v in data.items() if not k.startswith("_") and k != "id"}


def kv_get(key: str, default: Any = None) -> Any:
    with db() as c:
        r = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(r["value"]) if r else default


def kv_set(key: str, value: Any) -> None:
    with _db_lock, db() as c:
        c.execute(
            "INSERT INTO kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated",
            (key, json.dumps(value), time.time()),
        )


# ── local LLM (OpenAI-compatible) ────────────────────────────────────────────

_models_cache: dict[str, tuple[float, list[str]]] = {}


def _http_json(url: str, payload: Optional[dict] = None, timeout: float = 30, headers: Optional[dict] = None) -> Any:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def llm_models() -> list[str]:
    base = load_config()["llm"]["baseUrl"].rstrip("/")
    hit = _models_cache.get(base)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    ids = [m.get("id", "") for m in _http_json(f"{base}/models", timeout=4).get("data", [])]
    _models_cache[base] = (time.time(), ids)
    return ids


def _pick_model(preferred: str, want: str = "chat") -> str:
    if preferred:
        return preferred
    models = llm_models()
    if want == "embed":
        emb = [m for m in models if "embed" in m.lower()]
        if emb:
            return emb[0]
    chat = [m for m in models if "embed" not in m.lower()]
    if not chat:
        raise RuntimeError("No model loaded in the local LLM server")
    return chat[0]


def llm_chat(messages: list[dict], *, model: str = "", max_tokens: int = 1200, temperature: float = 0.2) -> str:
    cfg = load_config()["llm"]
    body = {
        "model": _pick_model(model or cfg["model"]),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    out = _http_json(f"{cfg['baseUrl'].rstrip('/')}/chat/completions", body, timeout=cfg.get("timeoutSecs", 120))
    return out["choices"][0]["message"]["content"] or ""


_SMART_QUOTES = {"“": '"', "”": '"', "‘": "'", "’": "'"}
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
_FENCED_JSON_RE = re.compile(r"```json\s*(.*?)```", re.S | re.I)
_TOOL_CALL_TAG_RE = re.compile(r"</?tool_call>", re.I)


def _strip_think_loose(text: str) -> str:
    """Remove every closed <think>...</think>; drop an unclosed one (and
    everything after it) — a never-finished scratchpad has no usable JSON
    trailing it."""
    text = text or ""
    while True:
        a, b = text.find("<think>"), text.find("</think>")
        if a >= 0 and b > a:
            text = text[:a] + text[b + len("</think>") :]
            continue
        if a >= 0 and b < 0:
            text = text[:a]
        break
    return text.strip()


def _balanced_spans(text: str) -> list[tuple[int, int]]:
    """Every outermost `{...}` span, skipping braces inside quoted strings."""
    spans: list[tuple[int, int]] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] == "{":
            depth, in_str, escape, j, end = 0, False, False, i, None
            while j < n:
                c = text[j]
                if in_str:
                    if escape:
                        escape = False
                    elif c == "\\":
                        escape = True
                    elif c == '"':
                        in_str = False
                else:
                    if c == '"':
                        in_str = True
                    elif c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                        if depth == 0:
                            end = j
                            break
                j += 1
            if end is not None:
                spans.append((i, end))
                i = end + 1
                continue
        i += 1
    return spans


def _light_repair(s: str) -> str:
    for bad, good in _SMART_QUOTES.items():
        s = s.replace(bad, good)
    return _TRAILING_COMMA_RE.sub(r"\1", s)


def _normalize_tool_shape(v: dict) -> dict:
    if "tool" not in v and isinstance(v.get("name"), str) and "arguments" in v:
        v = {**v, "tool": v["name"], "args": v["arguments"]}
    return v


def extract_json(text: str) -> Optional[dict]:
    """Model-agnostic JSON / tool-call extraction (Part 6 §3) — mirrors
    `extract_json` in the Tauri app's `dispatch.rs` and TS `extract-json.ts`.
    Survives a reasoning scratchpad next to the JSON, a ```json fence, more
    than one `{...}` span, trailing commas / smart quotes, and either
    `{"tool","args"}` or the OpenAI-style `{"name","arguments"}` shape."""
    cleaned = _strip_think_loose(text)
    candidates: list[str] = []
    fenced = _FENCED_JSON_RE.search(cleaned)
    if fenced:
        candidates.append(fenced.group(1).strip())
    without_tool_tags = _TOOL_CALL_TAG_RE.sub("", cleaned)
    for a, b in _balanced_spans(without_tool_tags):
        candidates.append(without_tool_tags[a : b + 1])
    for c in candidates:
        for attempt in (c, _light_repair(c)):
            try:
                v = json.loads(attempt)
            except json.JSONDecodeError:
                continue
            if isinstance(v, dict):
                return _normalize_tool_shape(v)
    return None


def embed(texts: list[str]) -> tuple[list[list[float]], str]:
    cfg = load_config()["llm"]
    model = _pick_model(cfg.get("embeddingModel", ""), "embed")
    out = _http_json(f"{cfg['baseUrl'].rstrip('/')}/embeddings", {"model": model, "input": texts}, timeout=60)
    vecs = [d["embedding"] for d in sorted(out["data"], key=lambda d: d.get("index", 0))]
    return vecs, model


# ── vector vault ─────────────────────────────────────────────────────────────

_index_q: "queue.Queue[str]" = queue.Queue()
_TOKEN = re.compile(r"[a-z0-9$#.\-]{2,}")


def _vault_text(collection: str, data: dict) -> str:
    parts = []
    for f in VAULT_FIELDS.get(collection, []):
        v = data.get(f)
        if v in (None, "", [], {}):
            continue
        parts.append(f"{f}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}")
    return "\n".join(parts)[:6000]


def _upsert_vault_text(item_id: str, collection: str, data: dict, deleted: bool) -> None:
    if collection not in VAULT_FIELDS:
        return
    with _db_lock, db() as c:
        if deleted:
            c.execute("DELETE FROM vault WHERE item_id=?", (item_id,))
            return
        text = _vault_text(collection, data)
        c.execute(
            "INSERT INTO vault(item_id,collection,text,vector,model,updated) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(item_id) DO UPDATE SET text=excluded.text, vector=NULL, model=NULL, updated=excluded.updated",
            (item_id, collection, text, None, None, time.time()),
        )
    _index_q.put(item_id)


def _index_worker() -> None:
    """Embeds vault rows in the background; a missing embedding model just leaves lexical search."""
    while True:
        item_id = _index_q.get()
        try:
            with db() as c:
                r = c.execute("SELECT text FROM vault WHERE item_id=?", (item_id,)).fetchone()
            if not r or not r["text"]:
                continue
            (vec,), model = embed([r["text"]])
            blob = array.array("f", vec).tobytes()
            with _db_lock, db() as c:
                c.execute("UPDATE vault SET vector=?, model=? WHERE item_id=?", (blob, model, item_id))
        except Exception:
            time.sleep(2)  # embedding server down; stays lexical-only until reindex


def _cosine(a: array.array, b: array.array) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def vault_search(q: str, collections: Optional[list[str]] = None, k: int = 8) -> dict:
    with db() as c:
        rows = c.execute("SELECT item_id, collection, text, vector FROM vault").fetchall()
    if collections:
        rows = [r for r in rows if r["collection"] in collections]
    if not rows:
        return {"results": [], "mode": "empty"}

    # Lexical (BM25-lite) — always available.
    q_terms = _TOKEN.findall(q.lower())
    docs = [(r, _TOKEN.findall((r["text"] or "").lower())) for r in rows]
    df: dict[str, int] = {}
    for _, toks in docs:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    n = len(docs)
    lex = {}
    for r, toks in docs:
        s = 0.0
        for t in q_terms:
            tf = toks.count(t)
            if tf:
                s += (math.log(1 + n / df[t])) * (tf / (tf + 1.2))
        lex[r["item_id"]] = s
    lmax = max(lex.values()) or 1.0

    # Semantic, if the embedding model is reachable.
    sem: dict[str, float] = {}
    mode = "lexical"
    try:
        (qv,), _ = embed([q])
        qa = array.array("f", qv)
        for r in rows:
            if r["vector"]:
                v = array.array("f")
                v.frombytes(r["vector"])
                sem[r["item_id"]] = _cosine(qa, v)
        if sem:
            mode = "hybrid"
    except Exception:
        pass

    scored = []
    for r in rows:
        s = 0.3 * (lex[r["item_id"]] / lmax) + (0.7 * sem.get(r["item_id"], 0.0) if sem else 0.7 * (lex[r["item_id"]] / lmax))
        if s > 0.05:
            scored.append((s, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    ids = [r["item_id"] for _, r in scored[:k]]
    items: dict[str, dict] = {}
    if ids:
        with db() as c:
            for row in c.execute(f"SELECT * FROM items WHERE id IN ({','.join('?' * len(ids))})", ids):
                items[row["id"]] = _row(row)
    return {
        "mode": mode,
        "results": [
            {"score": round(s, 3), "collection": r["collection"], "id": r["item_id"], "snippet": (r["text"] or "")[:280], "item": items.get(r["item_id"])}
            for s, r in scored[:k]
            if r["item_id"] in items
        ],
    }


# ── collections API ──────────────────────────────────────────────────────────

@router.get("/health")
def cc_health():
    llm = {"ok": False}
    try:
        llm = {"ok": True, "models": llm_models()[:20]}
    except Exception as e:
        llm = {"ok": False, "error": _why(e)}
    with db() as c:
        counts = {r["collection"]: r["n"] for r in c.execute("SELECT collection, COUNT(*) n FROM items WHERE deleted=0 GROUP BY collection")}
        vault = c.execute("SELECT COUNT(*) n, SUM(vector IS NOT NULL) e FROM vault").fetchone()
    return {
        "ok": True,
        "version": 1,
        "now": time.time(),
        "llm": llm,
        "counts": counts,
        "vault": {"items": vault["n"] or 0, "embedded": vault["e"] or 0},
        "lastBackup": kv_get("backup.last"),
    }


@router.get("/c/{collection}")
def list_items(collection: str, since: float = 0, include_deleted: bool = False):
    _coll(collection)
    with db() as c:
        rows = c.execute(
            "SELECT * FROM items WHERE collection=? AND updated>? ORDER BY created DESC LIMIT 5000",
            (collection, since),
        ).fetchall()
    items = [_row(r) for r in rows if include_deleted or since or not r["deleted"]]
    return {"items": items, "now": time.time()}


@router.post("/c/{collection}")
def create_item(collection: str, data: dict):
    _coll(collection)
    body = _clean(data)
    if len(json.dumps(body)) > 512 * 1024:
        raise HTTPException(413, "Item too large")
    item_id = str(data.get("id") or uuid.uuid4())
    now = time.time()
    with _db_lock, db() as c:
        c.execute(
            "INSERT INTO items(id,collection,data,created,updated,deleted) VALUES(?,?,?,?,?,0)",
            (item_id, collection, json.dumps(body), now, now),
        )
    _upsert_vault_text(item_id, collection, body, False)
    return {**body, "id": item_id, "_created": now, "_updated": now, "_deleted": False}


@router.patch("/c/{collection}/{item_id}")
def update_item(collection: str, item_id: str, patch: dict):
    _coll(collection)
    with _db_lock, db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection=?", (item_id, collection)).fetchone()
        if not r:
            raise HTTPException(404, "Not found")
        merged = {**json.loads(r["data"]), **_clean(patch)}
        now = time.time()
        c.execute("UPDATE items SET data=?, updated=?, deleted=0 WHERE id=?", (json.dumps(merged), now, item_id))
    _upsert_vault_text(item_id, collection, merged, False)
    return {**merged, "id": item_id, "_created": r["created"], "_updated": now, "_deleted": False}


@router.delete("/c/{collection}/{item_id}")
def delete_item(collection: str, item_id: str):
    """Soft delete so other devices see the removal on their next sync."""
    _coll(collection)
    with _db_lock, db() as c:
        n = c.execute("UPDATE items SET deleted=1, updated=? WHERE id=? AND collection=?", (time.time(), item_id, collection)).rowcount
    if not n:
        raise HTTPException(404, "Not found")
    _upsert_vault_text(item_id, collection, {}, True)
    return {"ok": True}


# ── key/value (device UI config snapshots, sync cursors) ─────────────────────

_KV_KEY = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


@router.get("/kv/{key}")
def get_kv(key: str):
    if not _KV_KEY.match(key):
        raise HTTPException(400, "Bad key")
    return {"key": key, "value": kv_get(key)}


@router.put("/kv/{key}")
def put_kv(key: str, body: dict):
    if not _KV_KEY.match(key) or key.startswith("backup."):
        raise HTTPException(400, "Bad key")
    if len(json.dumps(body)) > 256 * 1024:
        raise HTTPException(413, "Too large")
    kv_set(key, body.get("value"))
    return {"ok": True}


# ── n8n status pings (workflows report their own start/finish) ───────────────
#
# Add an HTTP Request node at the start and end of a workflow:
#   POST http://host.docker.internal:8080/api/cc/n8n/ping
#   {"workflowId": "{{$workflow.id}}", "status": "running" | "success" | "error",
#    "executionId": "{{$execution.id}}", "durationMs": 1234}
# The desktop's pipeline monitor merges these with the n8n REST API so a
# workflow shows "running" the moment it starts, not on the next execution poll.

_PING_STATUS = {"running", "success", "error", "idle", "waiting", "crashed"}
_ping_lock = threading.Lock()


class N8nPing(BaseModel):
    workflowId: str
    status: str
    executionId: Optional[str] = None
    durationMs: Optional[int] = None
    name: Optional[str] = None


@router.post("/n8n/ping")
def n8n_ping(p: N8nPing):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", p.workflowId) or p.status not in _PING_STATUS:
        raise HTTPException(400, "workflowId [A-Za-z0-9_-] and a known status required")
    now = time.time()
    with _ping_lock:
        pings = kv_get("n8n.pings", {}) or {}
        pings[p.workflowId] = {
            "status": p.status,
            "at": now,
            "iso": datetime.utcfromtimestamp(now).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "executionId": p.executionId,
            "durationMs": p.durationMs,
            "name": (p.name or "")[:120] or None,
        }
        if len(pings) > 200:  # keep the most recent 200 workflows
            pings = dict(sorted(pings.items(), key=lambda kv: kv[1]["at"], reverse=True)[:200])
        kv_set("n8n.pings", pings)
    return {"ok": True}


@router.get("/n8n/pings")
def n8n_pings():
    return {"pings": kv_get("n8n.pings", {}) or {}}


# ── config ───────────────────────────────────────────────────────────────────

@router.get("/config")
def get_config():
    return load_config()


@router.put("/config")
def put_config(patch: dict):
    cfg = _deep_merge(load_config(), {k: v for k, v in patch.items() if k in DEFAULT_CONFIG})
    if not _valid_http_url(cfg["llm"]["baseUrl"]):
        raise HTTPException(400, "llm.baseUrl must be an http(s) URL")
    b = cfg["backup"]
    b["intervalHours"] = max(1, min(24 * 30, float(b.get("intervalHours", 24))))
    b["keep"] = max(1, min(365, int(b.get("keep", 14))))
    save_config(cfg)
    _models_cache.clear()
    return cfg


# ── files ────────────────────────────────────────────────────────────────────

@router.post("/files")
async def upload_file(file: UploadFile = File(...)):
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    if not mime.startswith(ALLOWED_UPLOAD):
        raise HTTPException(415, f"Unsupported type {mime}")
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File larger than 15 MB")
    fid = uuid.uuid4().hex
    ext = (mimetypes.guess_extension(mime) or Path(file.filename or "").suffix or ".bin")[:8]
    sub = FILES_DIR / datetime.now().strftime("%Y-%m")
    sub.mkdir(parents=True, exist_ok=True)
    path = sub / f"{fid}{ext}"
    path.write_bytes(data)
    name = Path(file.filename or f"capture{ext}").name[:120]
    with _db_lock, db() as c:
        c.execute(
            "INSERT INTO files(id,name,mime,size,path,created) VALUES(?,?,?,?,?,?)",
            (fid, name, mime, len(data), str(path.relative_to(CC_DIR)), time.time()),
        )
    return {"id": fid, "name": name, "mime": mime, "size": len(data)}


def _file_row(fid: str) -> sqlite3.Row:
    if not re.fullmatch(r"[0-9a-f]{32}", fid):
        raise HTTPException(400, "Bad file id")
    with db() as c:
        r = c.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
    if not r:
        raise HTTPException(404, "File not found")
    return r


@router.get("/files/{fid}")
def get_file(fid: str):
    r = _file_row(fid)
    path = (CC_DIR / r["path"]).resolve()
    if CC_DIR.resolve() not in path.parents:
        raise HTTPException(400, "Bad path")
    return FileResponse(path, media_type=r["mime"], filename=r["name"])


# ── OCR: receipts / invoices / checks via local vision LLM ───────────────────

OCR_PROMPT = """You read Canadian receipts, invoices and cheques. Return ONLY JSON:
{"vendor": str|null, "date": "YYYY-MM-DD"|null, "subtotal": number|null,
 "gst": number|null, "hst": number|null, "pst": number|null, "qst": number|null,
 "tip": number|null, "total": number|null, "currency": "CAD"|"USD"|null,
 "invoiceNumber": str|null, "payer": str|null, "chequeNumber": str|null, "memo": str|null,
 "category": one of ["meals","fuel","vehicle","office","equipment","software","travel","wardrobe","training","subcontract","materials","utilities","other"]|null,
 "items": [{"desc": str, "amount": number}], "confidence": number between 0 and 1}
Copy numbers exactly as printed. Never guess a value you cannot read; use null."""


class OcrRequest(BaseModel):
    fileId: str
    kind: str = "receipt"  # receipt | invoice | check


def _tax_check(f: dict) -> dict:
    """Validate the arithmetic and infer the tax regime (ON HST 13 %, Atlantic HST 15 %, GST 5 %)."""
    num = lambda k: float(f[k]) if isinstance(f.get(k), (int, float)) else 0.0
    sub, total = num("subtotal"), num("total")
    taxes = num("gst") + num("hst") + num("pst") + num("qst")
    flags = []
    regime = None
    if sub > 0:
        hst_rate = num("hst") / sub
        gst_rate = num("gst") / sub
        if abs(hst_rate - 0.13) < 0.006:
            regime = "HST 13% (ON)"
        elif abs(hst_rate - 0.15) < 0.006:
            regime = "HST 15%"
        elif abs(gst_rate - 0.05) < 0.004:
            regime = "GST 5%" + (" + PST" if num("pst") else "") + (" + QST" if num("qst") else "")
        elif taxes:
            flags.append(f"Unusual tax rate {round(taxes / sub * 100, 2)}%")
        if total and abs(sub + taxes + num("tip") - total) > 0.05:
            flags.append("Subtotal + tax + tip doesn't equal total")
    elif total and not taxes:
        flags.append("No tax breakdown found")
    return {"regime": regime, "flags": flags, "taxTotal": round(taxes, 2)}


@router.post("/ocr")
def ocr(req: OcrRequest):
    r = _file_row(req.fileId)
    if not r["mime"].startswith("image/"):
        raise HTTPException(415, "OCR needs an image")
    img = (CC_DIR / r["path"]).read_bytes()
    cfg = load_config()["llm"]
    engine = "vision-llm"
    try:
        content = [
            {"type": "text", "text": f"Document type: {req.kind}. Extract the fields."},
            {"type": "image_url", "image_url": {"url": f"data:{r['mime']};base64,{base64.b64encode(img).decode()}"}},
        ]
        raw = llm_chat(
            [{"role": "system", "content": OCR_PROMPT}, {"role": "user", "content": content}],
            model=cfg.get("visionModel") or "",
            max_tokens=900,
            temperature=0,
        )
    except Exception as vision_err:
        # Fallback: Tesseract (if installed) → text LLM.
        try:
            import pytesseract  # type: ignore
            from PIL import Image  # type: ignore
            import io

            text = pytesseract.image_to_string(Image.open(io.BytesIO(img)))
            raw = llm_chat([{"role": "system", "content": OCR_PROMPT}, {"role": "user", "content": f"Document type: {req.kind}.\nOCR text:\n{text}"}], temperature=0)
            engine = "tesseract+llm"
        except ImportError:
            raise HTTPException(503, f"No local vision model reachable ({_why(vision_err)}). Load a vision model in LM Studio or install pytesseract.")
        except Exception as e:
            raise HTTPException(503, f"OCR failed: {_why(e)}")
    fields = extract_json(raw) or {}
    return {"fields": fields, "check": _tax_check(fields), "engine": engine, "raw": raw[:4000]}


# ── LLM helpers: brainstorm organizing + structured JSON generation ──────────

ORGANIZE_PROMPT = """You organize raw spoken brain-dumps. Keep the speaker's meaning; never invent facts.
Return ONLY JSON: {"title": str (<= 8 words), "summary": str (2-3 sentences),
"categories": [{"name": str, "bullets": [str]}], "actions": [{"text": str, "due": str|null}],
"tags": [str (lowercase, 1-2 words)]}"""


class OrganizeRequest(BaseModel):
    id: str


@router.post("/brainstorm/organize")
def organize(req: OrganizeRequest):
    with db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection='notes'", (req.id,)).fetchone()
    if not r:
        raise HTTPException(404, "Note not found")
    note = json.loads(r["data"])
    raw = note.get("rawText") or "\n".join(s.get("text", "") for s in note.get("segments", []))
    if not raw.strip():
        raise HTTPException(400, "Nothing to organize yet")
    try:
        out = llm_chat([{"role": "system", "content": ORGANIZE_PROMPT}, {"role": "user", "content": raw[-24000:]}], max_tokens=1600)
    except Exception as e:
        raise HTTPException(503, f"Local LLM unavailable: {_why(e)}")
    organized = extract_json(out)
    if not organized:
        # One retry with a blunt nudge before giving up on clean JSON.
        try:
            out = llm_chat(
                [{"role": "system", "content": ORGANIZE_PROMPT}, {"role": "user", "content": raw[-24000:]}, {"role": "user", "content": "Return ONLY JSON, nothing else."}],
                max_tokens=1600,
            )
            organized = extract_json(out)
        except Exception:
            organized = None
    if not organized:
        # Still no clean JSON: don't fail the whole note over formatting —
        # fall back to a plain summary from whatever text came back.
        organized = {"title": note.get("title") or "Untitled", "summary": out.strip()[:600], "categories": [], "actions": [], "tags": []}
    patch = {"organized": organized, "organizedAt": time.time()}
    if not note.get("titleLocked") and organized.get("title"):
        patch["title"] = organized["title"]
    return update_item("notes", req.id, patch)


class JsonGenRequest(BaseModel):
    system: str
    prompt: str


@router.post("/llm/json")
def llm_json(req: JsonGenRequest):
    if len(req.system) > 8000 or len(req.prompt) > 8000:
        raise HTTPException(413, "Too long")
    try:
        out = llm_chat([{"role": "system", "content": req.system}, {"role": "user", "content": req.prompt}], max_tokens=1200)
    except Exception as e:
        raise HTTPException(503, f"Local LLM unavailable: {_why(e)}")
    j = extract_json(out)
    if j is None:
        # One retry with a blunt nudge before giving up.
        try:
            out = llm_chat(
                [{"role": "system", "content": req.system}, {"role": "user", "content": req.prompt}, {"role": "user", "content": "Return ONLY JSON, nothing else."}],
                max_tokens=1200,
            )
            j = extract_json(out)
        except Exception:
            j = None
    if j is None:
        raise HTTPException(502, "Model returned no JSON")
    return j


# ── vault endpoints ──────────────────────────────────────────────────────────

@router.get("/vault/search")
def search(q: str = Query(..., min_length=1, max_length=500), collections: str = "", k: int = Query(8, ge=1, le=50)):
    cols = [c for c in collections.split(",") if c in VAULT_FIELDS] or None
    return vault_search(q, cols, k)


@router.post("/vault/reindex")
def reindex():
    with db() as c:
        rows = c.execute("SELECT id, collection, data, deleted FROM items").fetchall()
    n = 0
    for r in rows:
        if r["collection"] in VAULT_FIELDS:
            _upsert_vault_text(r["id"], r["collection"], json.loads(r["data"]), bool(r["deleted"]))
            n += 1
    return {"queued": n}


# ── market data proxy (no broker, read-only) ─────────────────────────────────

_SYMBOL = re.compile(r"^[A-Za-z0-9.^=\-]{1,24}$")
_INTERVALS = {"1m": "5d", "2m": "5d", "5m": "1mo", "15m": "1mo", "30m": "1mo", "60m": "3mo", "1d": "1y"}
_RANGES = {"1d", "5d", "1mo", "3mo", "6mo", "1y"}
_market_cache: dict[str, tuple[float, dict]] = {}


@router.get("/market/candles")
def candles(symbol: str, interval: str = "5m", range: str = "5d"):
    if not _SYMBOL.match(symbol) or interval not in _INTERVALS or range not in _RANGES:
        raise HTTPException(400, "Bad symbol / interval / range")
    key = f"{symbol}|{interval}|{range}"
    hit = _market_cache.get(key)
    if hit and time.time() - hit[0] < 15:
        return hit[1]
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?interval={interval}&range={range}&includePrePost=false"
    )
    try:
        data = _http_json(url, timeout=10, headers={"User-Agent": "Mozilla/5.0 (CommandCenter)"})
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code if e.code in (404, 429) else 502, f"Market data: HTTP {e.code}")
    except Exception as e:
        raise HTTPException(502, f"Market data unavailable: {_why(e)}")
    res = (data.get("chart", {}).get("result") or [None])[0]
    if not res:
        raise HTTPException(404, "Unknown symbol")
    q = res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(res.get("timestamp") or []):
        o, h, l, cl, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None not in (o, h, l, cl):
            out.append({"t": t, "o": o, "h": h, "l": l, "c": cl, "v": v or 0})
    meta = res.get("meta", {})
    payload = {
        "symbol": meta.get("symbol", symbol),
        "currency": meta.get("currency"),
        "exchange": meta.get("exchangeName"),
        "price": meta.get("regularMarketPrice"),
        "candles": out,
        "fetchedAt": time.time(),
        "source": "Yahoo Finance (unofficial, may be delayed)",
    }
    _market_cache[key] = (time.time(), payload)
    return payload


# ── backups ──────────────────────────────────────────────────────────────────

def run_backup(reason: str = "manual") -> dict:
    cfg = load_config()["backup"]
    out_dir = Path(cfg["dir"]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    zpath = out_dir / f"cc-{stamp}.zip"
    tmp_db = CC_DIR / f".backup-{stamp}.db"
    try:
        # Consistent online copy of the live database.
        dst = sqlite3.connect(tmp_db)
        try:
            with db() as src:
                src.backup(dst)
        finally:
            dst.close()
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tmp_db, "cc.db")
            if CONFIG_PATH.exists():
                z.write(CONFIG_PATH, "config.json")
            for extra in ("settings.json", "agent-routes.json", "goals.json"):
                p = BASE_DIR / "data" / extra
                if p.exists():
                    z.write(p, f"agentic-os-data/{extra}")
            if FILES_DIR.exists():
                for f in FILES_DIR.rglob("*"):
                    if f.is_file():
                        z.write(f, f"files/{f.relative_to(FILES_DIR).as_posix()}")
    finally:
        tmp_db.unlink(missing_ok=True)
    # Retention.
    zips = sorted(out_dir.glob("cc-*.zip"))
    for old in zips[: max(0, len(zips) - int(cfg.get("keep", 14)))]:
        old.unlink(missing_ok=True)
    info = {"file": str(zpath), "size": zpath.stat().st_size, "at": time.time(), "reason": reason}
    kv_set("backup.last", info)
    return info


def _backup_scheduler() -> None:
    while True:
        try:
            cfg = load_config()["backup"]
            last = (kv_get("backup.last") or {}).get("at", 0)
            if cfg.get("enabled") and time.time() - last >= float(cfg.get("intervalHours", 24)) * 3600:
                run_backup("scheduled")
        except Exception as e:
            print(f"[command-center] backup failed: {e}")
        time.sleep(300)


@router.post("/backup")
def backup_now():
    try:
        return run_backup("manual")
    except Exception as e:
        raise HTTPException(500, f"Backup failed: {e}")


@router.get("/backups")
def list_backups():
    cfg = load_config()["backup"]
    d = Path(cfg["dir"]).expanduser()
    files = sorted(d.glob("cc-*.zip"), reverse=True) if d.exists() else []
    return {
        "dir": str(d),
        "last": kv_get("backup.last"),
        "backups": [{"name": f.name, "size": f.stat().st_size, "at": f.stat().st_mtime} for f in files[:100]],
    }


# ── startup ──────────────────────────────────────────────────────────────────

_started = False


def start() -> None:
    """Called once by server.py after mounting the router."""
    global _started
    if _started:
        return
    _started = True
    init_db()
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_index_worker, name="cc-vault-indexer", daemon=True).start()
    threading.Thread(target=_backup_scheduler, name="cc-backup", daemon=True).start()


# ── Agentic OS state for the phone (osName, compute mode, isolated threads) ──
#
# The desktop app mirrors its non-secret OS settings to os-state.json and pushes
# its per-agent conversation threads here, so the mobile companion shows the
# same Tony, the same compute mode and the same Booking / Coder / … tabs.

from fastapi import Body  # noqa: E402

os_router = APIRouter(prefix="/api/os", tags=["agentic-os"])
_THREADS_FILE = CC_DIR / "os-threads.json"
_THREADS_MAX = 2 * 1024 * 1024


@os_router.get("/state")
def os_state():
    p = CC_DIR / "os-state.json"
    if not p.exists():
        return {"osName": "Tony", "computeMode": "hybrid", "available": False}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"os-state.json unreadable: {_why(e)}")
    data["available"] = True
    return data


@os_router.get("/threads")
def os_threads():
    if not _THREADS_FILE.exists():
        return {"threads": {}, "updatedAt": 0}
    return json.loads(_THREADS_FILE.read_text(encoding="utf-8"))


@os_router.put("/threads")
def os_threads_put(body: dict = Body(...)):
    threads = body.get("threads")
    if not isinstance(threads, dict):
        raise HTTPException(400, "threads must be an object")
    # Merge by turn id (desktop and phone both push), newest 60 per thread.
    current = {}
    if _THREADS_FILE.exists():
        try:
            current = json.loads(_THREADS_FILE.read_text(encoding="utf-8")).get("threads", {})
        except Exception:
            current = {}
    if body.get("replace"):
        current = {}
    for name, turns in threads.items():
        if not isinstance(turns, list):
            continue
        merged = {t.get("id"): t for t in current.get(name, []) if isinstance(t, dict)}
        merged.update({t.get("id"): t for t in turns if isinstance(t, dict) and t.get("id")})
        current[name] = sorted(merged.values(), key=lambda t: t.get("at", 0))[-60:]
    threads = current
    raw = json.dumps({"threads": threads, "updatedAt": time.time()}, ensure_ascii=False)
    if len(raw.encode("utf-8")) > _THREADS_MAX:
        raise HTTPException(413, "threads too large")
    CC_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _THREADS_FILE.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(_THREADS_FILE)
    return {"ok": True}
