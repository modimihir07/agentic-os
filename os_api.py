"""Agentic OS Phase 2 gateway routes.

  /api/play-place/*  staged prototypes (Designer / Coder) + sandboxed preview
  /api/pipeline/*    Ideas & Tasks ledger + live pipeline progress (for the phone HUD)
  /api/comms/*       calls & texts: phone-bridge sync, unified inbox, outbox, recall search, WS push
  /api/os/inbox      phone → desktop Tony turns; /api/os/commands phone → desktop (kill switch, mode)

Ideas and Play Place cards live in the shared Command Center store (collections
"ideas" and "playplace"), so they sync to every device and land in the vault.
Comms lives in its own tables (it can be large) and every message is also
indexed into the vault as collection "comms" for the Librarian.

Security: the gateway binds 127.0.0.1 (+ the NetBird address), ZeroTrustMiddleware
requires the bearer token from anything that isn't loopback, and sending a text
or placing a call needs an explicit `confirmed: true` (the UI's confirmation
card) unless the contact is marked trusted ("Instant Send").
"""
from __future__ import annotations

import asyncio
import os
import hmac
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

import command_center_api as cc

play_router = APIRouter(prefix="/api/play-place", tags=["play-place"])
pipeline_router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])
comms_router = APIRouter(prefix="/api/comms", tags=["comms"])
inbox_router = APIRouter(prefix="/api/os", tags=["agentic-os"])

TOKEN_FILE = cc.CC_DIR / "gateway.token"


def init() -> None:
    with cc._db_lock, cc.db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS comms_messages(
              id TEXT PRIMARY KEY, thread TEXT NOT NULL, contact TEXT, address TEXT, direction TEXT,
              body TEXT, ts REAL NOT NULL, channel TEXT, read INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS comms_msg_thread ON comms_messages(thread, ts);
            CREATE TABLE IF NOT EXISTS comms_calls(
              id TEXT PRIMARY KEY, contact TEXT, address TEXT, direction TEXT, ts REAL NOT NULL, duration INTEGER);
            CREATE TABLE IF NOT EXISTS comms_outbox(
              id TEXT PRIMARY KEY, kind TEXT, address TEXT, contact TEXT, body TEXT, channel TEXT,
              status TEXT, created REAL, updated REAL, detail TEXT);
            CREATE TABLE IF NOT EXISTS comms_contacts(address TEXT PRIMARY KEY, name TEXT, trusted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS os_queue(
              id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created REAL, updated REAL);
            """
        )


# ── helpers ─────────────────────────────────────────────────────────────────

def _thread_key(address: str, channel: str = "sms") -> str:
    a = (address or "").strip()
    if "@" in a:  # WhatsApp JID / email
        return a.lower()
    digits = re.sub(r"\D", "", a)
    return digits[-10:] if len(digits) >= 10 else (digits or a.lower() or "unknown")


def _ts(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return time.time()
    return f / 1000.0 if f > 1e11 else f  # accept ms or s


def _items(collection: str) -> list[dict]:
    with cc.db() as c:
        rows = c.execute("SELECT * FROM items WHERE collection=? AND deleted=0 ORDER BY updated DESC", (collection,)).fetchall()
    return [cc._row(r) for r in rows]


def _item(collection: str, item_id: str) -> dict:
    with cc.db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection=? AND deleted=0", (item_id, collection)).fetchone()
    if not r:
        raise HTTPException(404, "Not found")
    return cc._row(r)


# ── Play Place ──────────────────────────────────────────────────────────────

@play_router.get("")
def play_list():
    out = []
    for it in _items("playplace"):
        it = dict(it)
        it["hasHtml"] = bool(it.pop("html", ""))
        out.append(it)
    return {"items": out}


@play_router.get("/{item_id}")
def play_get(item_id: str):
    return _item("playplace", item_id)


@play_router.post("")
def play_create(data: dict = Body(...)):
    return cc.create_item("playplace", {**data, "status": data.get("status") or "staged"})


@play_router.delete("/{item_id}")
def play_delete(item_id: str):
    return cc.delete_item("playplace", item_id)


_PREVIEW_CSP = (
    # Isolation comes from <iframe sandbox="allow-scripts"> (opaque origin, no cookies,
    # no access to the OS or the gateway); this CSP only limits what the prototype loads.
    "default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; "
    "style-src 'unsafe-inline' https:; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com "
    "https://esm.sh https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; connect-src https:"
)


@play_router.get("/{item_id}/preview", response_class=HTMLResponse)
def play_preview(item_id: str):
    """The prototype itself. Shown in an <iframe sandbox="allow-scripts"> (opaque origin:
    it can't read the OS, cookies or the gateway), plus a strict CSP here."""
    it = _item("playplace", item_id)
    html = it.get("html") or "<p style='font:14px system-ui;color:#999;padding:2rem'>No prototype HTML yet.</p>"
    return HTMLResponse(html, headers={"Content-Security-Policy": _PREVIEW_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


# ── Pipeline: ideas ledger + progress ───────────────────────────────────────

@pipeline_router.get("/ideas")
def ideas():
    return {"items": _items("ideas")}


_progress: dict[str, dict] = {}


@pipeline_router.post("/progress")
def progress_put(data: dict = Body(...)):
    pid = str(data.get("ideaId") or data.get("pipelineId") or "")
    if not pid:
        raise HTTPException(400, "ideaId required")
    _progress[pid] = {**data, "at": time.time()}
    # Finished pipelines drop off after 10 minutes.
    for k in [k for k, v in _progress.items() if v.get("pct", 0) >= 100 and time.time() - v["at"] > 600]:
        _progress.pop(k, None)
    _broadcast({"type": "pipeline", **_progress[pid]})
    return {"ok": True}


@pipeline_router.get("/progress")
def progress_get():
    return {"items": list(_progress.values())}


# ── Comms ───────────────────────────────────────────────────────────────────

_ws_clients: set[WebSocket] = set()
_loop: Optional[asyncio.AbstractEventLoop] = None


def _broadcast(event: dict) -> None:
    if not _ws_clients or not _loop:
        return
    data = json.dumps(event, ensure_ascii=False)
    for ws in list(_ws_clients):
        asyncio.run_coroutine_threadsafe(ws.send_text(data), _loop)


def _contact_name(c, address: str) -> Optional[str]:
    r = c.execute("SELECT name FROM comms_contacts WHERE address=?", (_thread_key(address),)).fetchone()
    return r["name"] if r else None


@comms_router.post("/sms")
def comms_sms(data: Any = Body(...)):
    """Phone bridge → desktop. Accepts one message or {messages:[…]}.
    Fields: address, body, ts (s or ms), direction in|out, contact?, channel? (sms|rcs|whatsapp), id?"""
    msgs = data.get("messages") if isinstance(data, dict) and "messages" in data else (data if isinstance(data, list) else [data])
    added = 0
    to_index: list[tuple] = []
    with cc._db_lock, cc.db() as c:
        for m in msgs[:2000]:
            if not isinstance(m, dict) or not str(m.get("body") or "").strip():
                continue
            address = str(m.get("address") or m.get("from") or m.get("to") or "")
            channel = str(m.get("channel") or "sms").lower()
            ts = _ts(m.get("ts") or m.get("date"))
            body = str(m["body"])[:8000]
            direction = "out" if str(m.get("direction") or m.get("type") or "in").lower() in ("out", "sent", "outgoing", "2") else "in"
            mid = str(m.get("id") or f"{channel}:{_thread_key(address)}:{int(ts)}:{hash(body) & 0xFFFFFFFF:x}")
            contact = str(m.get("contact") or m.get("name") or "") or _contact_name(c, address) or address
            if m.get("contact"):
                c.execute("INSERT INTO comms_contacts(address,name) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET name=excluded.name", (_thread_key(address), contact))
            cur = c.execute(
                "INSERT OR IGNORE INTO comms_messages(id,thread,contact,address,direction,body,ts,channel,read) VALUES(?,?,?,?,?,?,?,?,?)",
                (mid, _thread_key(address, channel), contact, address, direction, body, ts, channel, 1 if direction == "out" else 0),
            )
            if cur.rowcount:
                added += 1
                to_index.append((mid, contact, address, direction, body, ts, channel))
                _broadcast({"type": "sms", "id": mid, "thread": _thread_key(address, channel), "contact": contact, "direction": direction, "body": body[:280], "ts": ts})
    for row in to_index:  # after the write transaction above has committed
        _vault_comms(*row)
    return {"ok": True, "added": added}


def _vault_comms(mid, contact, address, direction, body, ts, channel):
    """Index for the Librarian (semantic + lexical vault search, collection "comms")."""
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
    text = f"{channel} {'from' if direction == 'in' else 'to'} {contact} ({address}) at {when}: {body}"
    try:
        with cc._db_lock, cc.db() as c2:
            c2.execute(
                "INSERT INTO vault(item_id,collection,text,vector,model,updated) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(item_id) DO UPDATE SET text=excluded.text, vector=NULL, model=NULL, updated=excluded.updated",
                (f"comms:{mid}", "comms", text[:6000], None, None, time.time()),
            )
        cc._index_q.put(f"comms:{mid}")
    except Exception:
        pass


@comms_router.post("/call-log")
def comms_calls_post(data: Any = Body(...)):
    calls = data.get("calls") if isinstance(data, dict) and "calls" in data else (data if isinstance(data, list) else [data])
    added = 0
    with cc._db_lock, cc.db() as c:
        for k in calls[:2000]:
            if not isinstance(k, dict):
                continue
            address = str(k.get("address") or k.get("number") or "")
            ts = _ts(k.get("ts") or k.get("date"))
            d = str(k.get("direction") or k.get("type") or "in").lower()
            direction = "missed" if d in ("missed", "3", "rejected") else "out" if d in ("out", "outgoing", "2") else "in"
            cid = str(k.get("id") or f"call:{_thread_key(address)}:{int(ts)}")
            contact = str(k.get("contact") or k.get("name") or "") or _contact_name(c, address) or address
            cur = c.execute("INSERT OR IGNORE INTO comms_calls(id,contact,address,direction,ts,duration) VALUES(?,?,?,?,?,?)", (cid, contact, address, direction, ts, int(k.get("duration") or 0)))
            if cur.rowcount:
                added += 1
                _broadcast({"type": "call", "id": cid, "contact": contact, "direction": direction, "ts": ts})
    return {"ok": True, "added": added}


@comms_router.get("/threads")
def comms_threads(limit: int = Query(100, le=500)):
    with cc.db() as c:
        rows = c.execute(
            """SELECT m.thread, m.contact, m.address, m.body, m.ts, m.direction, m.channel,
                      (SELECT COUNT(*) FROM comms_messages u WHERE u.thread=m.thread AND u.read=0) AS unread
               FROM comms_messages m
               WHERE m.ts = (SELECT MAX(ts) FROM comms_messages x WHERE x.thread = m.thread)
               GROUP BY m.thread ORDER BY m.ts DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        trusted = {r["address"] for r in c.execute("SELECT address FROM comms_contacts WHERE trusted=1")}
    return {"threads": [{**dict(r), "trusted": r["thread"] in trusted} for r in rows]}


@comms_router.get("/threads/{thread}/messages")
def comms_messages(thread: str, limit: int = Query(200, le=2000)):
    with cc.db() as c:
        rows = c.execute("SELECT * FROM comms_messages WHERE thread=? ORDER BY ts DESC LIMIT ?", (thread, limit)).fetchall()
    return {"messages": [dict(r) for r in reversed(rows)]}


@comms_router.post("/threads/{thread}/read")
def comms_read(thread: str):
    with cc._db_lock, cc.db() as c:
        c.execute("UPDATE comms_messages SET read=1 WHERE thread=?", (thread,))
    return {"ok": True}


@comms_router.get("/calls")
def comms_calls(limit: int = Query(100, le=1000)):
    with cc.db() as c:
        rows = c.execute("SELECT * FROM comms_calls ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return {"calls": [dict(r) for r in rows]}


@comms_router.get("/contacts")
def comms_contacts(q: str = ""):
    with cc.db() as c:
        rows = c.execute(
            "SELECT address, name, trusted FROM comms_contacts WHERE name LIKE ? OR address LIKE ? ORDER BY name LIMIT 200",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
    return {"contacts": [dict(r) for r in rows]}


@comms_router.post("/contacts")
def comms_contact_put(data: dict = Body(...)):
    address = _thread_key(str(data.get("address") or ""))
    if not address:
        raise HTTPException(400, "address required")
    with cc._db_lock, cc.db() as c:
        c.execute(
            "INSERT INTO comms_contacts(address,name,trusted) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET name=COALESCE(excluded.name,name), trusted=excluded.trusted",
            (address, data.get("name"), 1 if data.get("trusted") else 0),
        )
    return {"ok": True}


def _trusted(address: str) -> bool:
    with cc.db() as c:
        r = c.execute("SELECT trusted FROM comms_contacts WHERE address=?", (_thread_key(address),)).fetchone()
    return bool(r and r["trusted"])


def _queue_out(kind: str, data: dict) -> dict:
    address = str(data.get("address") or "").strip()
    if not address:
        raise HTTPException(400, "address required")
    if kind == "sms" and not str(data.get("body") or "").strip():
        raise HTTPException(400, "body required")
    if not data.get("confirmed") and not (kind == "sms" and _trusted(address)):
        # The 30-second confirmation card in the UI sets confirmed:true. Never auto-send.
        raise HTTPException(428, "Confirmation required (or mark the contact trusted for Instant Send)")
    oid = uuid.uuid4().hex
    now = time.time()
    row = {"id": oid, "kind": kind, "address": address, "contact": data.get("contact") or address, "body": str(data.get("body") or "")[:2000], "channel": data.get("channel") or "sms", "status": "pending", "created": now, "updated": now, "detail": ""}
    with cc._db_lock, cc.db() as c:
        c.execute("INSERT INTO comms_outbox(id,kind,address,contact,body,channel,status,created,updated,detail) VALUES(:id,:kind,:address,:contact,:body,:channel,:status,:created,:updated,:detail)", row)
    _broadcast({"type": "outbox", **row})
    return row


@comms_router.post("/send")
def comms_send(data: dict = Body(...)):
    """Queue an SMS for the phone bridge to send (it polls /outbox or listens on /ws)."""
    row = _queue_out("sms", data)
    # Record it in the thread right away (marked as queued) so the inbox shows it.
    comms_sms({"messages": [{"id": f"out:{row['id']}", "address": row["address"], "contact": row["contact"], "body": row["body"], "ts": row["created"], "direction": "out", "channel": row["channel"]}]})
    return row


@comms_router.post("/call")
def comms_call(data: dict = Body(...)):
    """Ask the phone bridge to dial a number."""
    return _queue_out("call", data)


@comms_router.get("/outbox")
def comms_outbox(status: str = "pending"):
    with cc.db() as c:
        rows = c.execute("SELECT * FROM comms_outbox WHERE status=? ORDER BY created", (status,)).fetchall()
    return {"items": [dict(r) for r in rows]}


@comms_router.post("/outbox/{oid}/ack")
def comms_ack(oid: str, data: dict = Body(...)):
    status = str(data.get("status") or "sent")
    if status not in ("sent", "failed", "dialed", "delivered"):
        raise HTTPException(400, "bad status")
    with cc._db_lock, cc.db() as c:
        c.execute("UPDATE comms_outbox SET status=?, detail=?, updated=? WHERE id=?", (status, str(data.get("detail") or "")[:300], time.time(), oid))
    _broadcast({"type": "outbox-ack", "id": oid, "status": status})
    return {"ok": True}


@comms_router.get("/search")
def comms_search(q: str = "", contact: str = "", limit: int = Query(12, le=50)):
    """Librarian recall: exact quotes + timestamps. Contact matches name or number."""
    terms = [t for t in re.findall(r"[\w']+", q.lower()) if len(t) > 2]
    with cc.db() as c:
        sql = "SELECT * FROM comms_messages"
        args: list = []
        if contact.strip():
            digits = re.sub(r"\D", "", contact)
            sql += " WHERE (contact LIKE ? OR address LIKE ?" + (" OR thread LIKE ?" if digits else "") + ")"
            args += [f"%{contact.strip()}%", f"%{contact.strip()}%"] + ([f"%{digits[-10:]}%"] if digits else [])
        sql += " ORDER BY ts DESC LIMIT 3000"
        rows = [dict(r) for r in c.execute(sql, args).fetchall()]
    scored = []
    for r in rows:
        low = (r["body"] or "").lower()
        s = sum(low.count(t) for t in terms) if terms else 1
        if s:
            scored.append((s, r))
    scored.sort(key=lambda x: (-x[0], -x[1]["ts"]))
    hits = [r for _, r in scored[:limit]]
    hits.sort(key=lambda r: r["ts"])
    return {
        "query": q,
        "contact": contact,
        "scanned": len(rows),
        "results": [{**h, "when": time.strftime("%Y-%m-%d %H:%M", time.localtime(h["ts"]))} for h in hits],
    }


def _ws_authorized(ws: WebSocket) -> bool:
    host = ws.client.host if ws.client else ""
    if host in ("127.0.0.1", "::1", "localhost") or host.startswith("127."):
        return True
    if not TOKEN_FILE.exists():
        return True
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    sent = ws.headers.get("authorization", "")
    sent = sent[7:].strip() if sent.lower().startswith("bearer ") else ws.query_params.get("token", "")
    return bool(token) and hmac.compare_digest(sent.encode(), token.encode())


@comms_router.websocket("/ws")
async def comms_ws(ws: WebSocket):
    """Live push: new texts, calls, outbox items, pipeline progress. The phone bridge
    can listen here instead of polling /outbox."""
    global _loop
    if not _ws_authorized(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    _loop = asyncio.get_running_loop()
    _ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive / ignore
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)


# ── Phone → desktop queue (Tony turns, kill switch, compute mode) ──────────

_QUEUE_KINDS = {"turn", "command", "pipeline", "playplace"}


@inbox_router.post("/inbox")
def inbox_post(data: dict = Body(...)):
    kind = str(data.get("kind") or "turn")
    if kind not in _QUEUE_KINDS:
        raise HTTPException(400, "kind must be turn, command, pipeline or playplace")
    payload = data.get("payload") or {}
    if kind == "command":
        allowed = {"killSwitch", "computeMode"}
        if not set(payload) <= allowed:
            raise HTTPException(400, f"commands: {sorted(allowed)}")
    qid = uuid.uuid4().hex
    now = time.time()
    with cc._db_lock, cc.db() as c:
        c.execute("INSERT INTO os_queue(id,kind,payload,status,result,created,updated) VALUES(?,?,?,?,?,?,?)", (qid, kind, json.dumps(payload)[:20000], "pending", None, now, now))
    return {"id": qid, "status": "pending"}


@inbox_router.get("/inbox")
def inbox_pending():
    """The desktop app polls this and answers with POST /inbox/{id}/result."""
    with cc.db() as c:
        rows = c.execute("SELECT * FROM os_queue WHERE status='pending' AND created > ? ORDER BY created LIMIT 10", (time.time() - 600,)).fetchall()
    return {"items": [{**dict(r), "payload": json.loads(r["payload"] or "{}")} for r in rows]}


@inbox_router.get("/inbox/{qid}")
def inbox_get(qid: str):
    with cc.db() as c:
        r = c.execute("SELECT * FROM os_queue WHERE id=?", (qid,)).fetchone()
    if not r:
        raise HTTPException(404, "Not found")
    return {**dict(r), "payload": json.loads(r["payload"] or "{}"), "result": json.loads(r["result"]) if r["result"] else None}


@inbox_router.post("/inbox/{qid}/result")
def inbox_result(qid: str, data: dict = Body(...)):
    status = "done" if data.get("ok", True) else "failed"
    with cc._db_lock, cc.db() as c:
        c.execute("UPDATE os_queue SET status=?, result=?, updated=? WHERE id=?", (status, json.dumps(data)[:200000], time.time(), qid))
    return {"ok": True}


# ── Local model library (D:\ drive scan → LM Studio / Bionic) ───────────────

models_router = APIRouter(prefix="/api/models", tags=["models"])

MODEL_DIRS = [r"D:\AI Models Productivity", r"D:\AI Models Media and Vision", r"D:\ai model voices"]
LMSTUDIO_DIR = Path(r"D:\LM Studio")  # Bionic's downloadsFolder
LINK_PUBLISHER = "local-d"
_WEIGHT_EXT = {".gguf": "gguf", ".safetensors": "safetensors", ".bin": "pytorch-bin", ".pth": "pytorch", ".pt": "pytorch", ".onnx": "onnx", ".ckpt": "checkpoint", ".msgpack": "flax", ".h5": "tensorflow", ".npz": "numpy", ".tflite": "tflite"}


def _category(name: str) -> str:
    n = name.lower()
    if any(k in n for k in ("embed", "bge-", "minilm", "e5-", "gte-")):
        return "Embedding Models"
    if any(k in n for k in ("whisper", "kokoro", "xtts", "parler", "tts", "wav2vec", "pyannote", "vits", "distil-large", "speech")):
        return "Voice STT / TTS Models"
    if any(k in n for k in ("-vl", "vl-", "pixtral", "florence", "moondream", "ocr", "docling", "yolo", "sdxl", "stable-audio", "musicgen", "vision", "llava")):
        return "Vision & Media Models"
    return "Productivity & Coding LLMs"


def _scan_folder(d: Path) -> dict:
    files, size, formats, ggufs, partial = 0, 0, set(), [], False
    for root, _dirs, names in os.walk(d):
        for n in names:
            p = Path(root) / n
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            files += 1
            size += sz
            ext = p.suffix.lower()
            if ext in (".part", ".incomplete", ".tmp") or (len(p.name) >= 64 and all(c in "0123456789abcdef" for c in p.name[:64]) and sz > 5_000_000):
                partial = True
            if ext in _WEIGHT_EXT and sz > 5_000_000:
                formats.add(_WEIGHT_EXT[ext])
                if ext == ".gguf" and not n.lower().startswith("mmproj"):
                    ggufs.append({"file": str(p.relative_to(d)), "gb": round(sz / 1e9, 2)})
    linked = (LMSTUDIO_DIR / LINK_PUBLISHER / d.name).exists()
    in_lms = str(d).lower().startswith(str(LMSTUDIO_DIR).lower())
    status = "gguf" if ggufs else ("partial-download" if partial else ("needs-conversion" if formats else ("unknown-format" if size > 500_000_000 else "incomplete")))
    return {
        "name": d.name, "path": str(d), "category": _category(d.name), "sizeGb": round(size / 1e9, 2), "files": files,
        "formats": sorted(formats), "ggufs": ggufs, "status": status,
        "lmstudioLoadable": bool(ggufs), "registered": linked or in_lms,
        "note": {"gguf": "Loadable in LM Studio / Bionic", "needs-conversion": "Hugging Face weights — convert to GGUF (or use with a Python runtime) to load in Bionic", "incomplete": "No weight files — download looks unfinished", "unknown-format": "Large files in a format the scanner doesn't recognize", "partial-download": "Interrupted Hugging Face download (.part / cache blobs) — resume it with `hf download`"}[status],
    }


@models_router.get("/local-scan")
def local_scan():
    import os as _os  # noqa: F401  (os.walk via module-level import below)
    out = []
    for base in MODEL_DIRS:
        b = Path(base)
        if not b.is_dir():
            continue
        for d in sorted(b.iterdir()):
            if d.is_dir():
                out.append({**_scan_folder(d), "root": base})
    # Bionic's own library too (already loadable).
    if LMSTUDIO_DIR.is_dir():
        for pub in LMSTUDIO_DIR.iterdir():
            if pub.is_dir() and pub.name != LINK_PUBLISHER:
                for d in pub.iterdir():
                    if d.is_dir():
                        out.append({**_scan_folder(d), "root": str(LMSTUDIO_DIR), "registered": True})
    groups: dict[str, list] = {}
    for m in out:
        groups.setdefault(m["category"], []).append(m)
    return {"dirs": MODEL_DIRS, "lmstudioDir": str(LMSTUDIO_DIR), "count": len(out), "groups": groups, "scannedAt": time.time()}


@models_router.post("/sync-lmstudio")
def sync_lmstudio():
    """Link every GGUF folder from the D:\ model dirs into Bionic's library
    (D:\LM Studio\local-d\<folder>) with a directory junction — no copying."""
    import subprocess
    linked, skipped, errors = [], [], []
    target_root = LMSTUDIO_DIR / LINK_PUBLISHER
    target_root.mkdir(parents=True, exist_ok=True)
    for base in MODEL_DIRS:
        b = Path(base)
        if not b.is_dir():
            continue
        for d in sorted(b.iterdir()):
            if not d.is_dir() or not any(p.suffix.lower() == ".gguf" for p in d.rglob("*.gguf")):
                continue
            link = target_root / d.name
            if link.exists():
                skipped.append(d.name)
                continue
            r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(d)], capture_output=True, text=True)
            (linked if r.returncode == 0 else errors).append(d.name if r.returncode == 0 else f"{d.name}: {(r.stderr or r.stdout).strip()[:120]}")
    return {"linked": linked, "alreadyLinked": skipped, "errors": errors, "folder": str(target_root),
            "next": "Bionic picks new folders up on its next model-list refresh (or restart Bionic)."}
