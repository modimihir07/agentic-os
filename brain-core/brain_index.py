"""
Agentic OS — Centralized Brain: unified information pipeline.

Ingests three knowledge sources into a single SQLite+FTS5 index so agents
can write to it and you can query it from a CLI or via HTTP.

Sources:
  - brain/**                -> markdown notes (source="brain")
  - skills/*/learnings.md   -> per-skill learnings (source="skill-learning")
  - data/chat-history.json  -> per-turn chat log (source="chat")

No external dependencies: uses Python's stdlib sqlite3 (FTS5).

Design notes:
  - doc_id is a stable hash of (source, source_path, [agent]) so re-ingest
    is idempotent (upsert, not duplicate).
  - FTS5 external-content is NOT used; we keep the text in the same row for
    simplicity and so the CLI/HTTP can return snippets directly.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Iterable

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "brain-core" / "brain_index.db"


def _doc_id(source: str, source_path: str, agent: str | None = None) -> str:
    raw = f"{source}|{source_path}|{agent or ''}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def get_conn(db_path: Path | None = None) -> sqlite3.Connection:
    db_path = db_path or DB_PATH
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS brain_index (
            doc_id      TEXT PRIMARY KEY,
            source     TEXT NOT NULL,
            source_path TEXT NOT NULL,
            title      TEXT NOT NULL,
            agent      TEXT,
            content    TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    # FTS5 virtual table mirroring the content column (with doc_id for joins).
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
            doc_id UNINDEXED,
            title,
            content,
            tokenize='unicode61 remove_diacritics 2'
        );
        """
    )
    conn.commit()
    return conn


def upsert_doc(conn: sqlite3.Connection, *, source: str, source_path: str,
               title: str, content: str, agent: str | None = None,
               updated_at: str | None = None) -> str:
    doc_id = _doc_id(source, source_path, agent)
    ts = updated_at or _now_iso()
    conn.execute(
        """
        INSERT INTO brain_index (doc_id, source, source_path, title, agent, content, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
            title=excluded.title,
            content=excluded.content,
            agent=excluded.agent,
            updated_at=excluded.updated_at
        """,
        (doc_id, source, source_path, title, agent, content, ts),
    )
    # Keep FTS in sync.
    conn.execute("DELETE FROM brain_fts WHERE doc_id = ?", (doc_id,))
    conn.execute(
        "INSERT INTO brain_fts (doc_id, title, content) VALUES (?, ?, ?)",
        (doc_id, title, content),
    )
    return doc_id


# --- Ingestors ---------------------------------------------------------

def _walk_markdown(root: Path, skip_dirs: set[str] | None = None) -> Iterable[Path]:
    skip = skip_dirs or {".git", "node_modules", "__pycache__", ".agents", "graphify-out"}
    for p in sorted(root.rglob("*.md")):
        if any(part in skip for part in p.relative_to(root).parts):
            continue
        yield p


def ingest_brain(conn: sqlite3.Connection, root: Path | None = None) -> int:
    root = root or (BASE_DIR / "brain")
    if not root.exists():
        return 0
    count = 0
    for p in _walk_markdown(root):
        text = p.read_text(encoding="utf-8", errors="replace")
        rel = str(p.relative_to(BASE_DIR))
        upsert_doc(conn, source="brain", source_path=rel,
                   title=p.stem, content=text)
        count += 1
    return count


def ingest_skill_learnings(conn: sqlite3.Connection, root: Path | None = None) -> int:
    root = root or (BASE_DIR / "skills")
    if not root.exists():
        return 0
    count = 0
    for learn in sorted(root.rglob("learnings.md")):
        text = learn.read_text(encoding="utf-8", errors="replace")
        skill_name = learn.parent.name
        rel = str(learn.relative_to(BASE_DIR))
        upsert_doc(conn, source="skill-learning", source_path=rel,
                   title=f"{skill_name} — learnings", content=text,
                   agent=skill_name)
        count += 1
    return count


def ingest_chat(conn: sqlite3.Connection, path: Path | None = None) -> int:
    path = path or (BASE_DIR / "data" / "chat-history.json")
    if not path.exists():
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 0
    messages = data.get("messages", [])
    count = 0
    for i, m in enumerate(messages):
        agent = m.get("agent") or "unknown"
        role = m.get("role") or "unknown"
        content = (m.get("content") or "").strip()
        if not content:
            continue
        ts = m.get("timestamp", "")
        # Make the doc key unique per message so turns don't overwrite.
        # source_path encodes the message index + timestamp.
        unique_path = f"{path.relative_to(BASE_DIR)}#{i}"
        title = f"chat:{agent}:{role} @ {ts[:19]}" if ts else f"chat:{agent}:{role} #{i}"
        upsert_doc(conn, source="chat", source_path=unique_path,
                   title=title, content=content, agent=agent,
                   updated_at=ts or None)
        count += 1
    return count


def ingest_orchestration(conn: sqlite3.Connection, root: Path | None = None) -> int:
    """Index multi-agent orchestration runs (my delegate_task fan-outs) so
    past 'spin up N agents on a goal' runs are searchable in the brain."""
    root = root or (BASE_DIR / "data" / "orchestration-runs")
    if not root.exists():
        return 0
    count = 0
    for f in sorted(root.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8", errors="replace"))
        except (json.JSONDecodeError, OSError):
            continue
        goal = d.get("goal", "")
        synthesis = d.get("synthesis", "") or ""
        angles = d.get("angles", {}) or {}
        angle_blob = "\n".join(f"{a}: {p}" for a, p in angles.items())
        agents = ", ".join(d.get("agents", []) or [])
        content = f"GOAL: {goal}\n\nANGLES ({agents}):\n{angle_blob}\n\nSYNTHESIS:\n{synthesis}"
        rel = str(f.relative_to(BASE_DIR))
        upsert_doc(conn, source="orchestration", source_path=rel,
                   title=f"Orchestration: {goal[:80]}", content=content,
                   agent=d.get("converge_agent") or "orchestrate",
                   updated_at=d.get("timestamp"))
        count += 1
    return count


def ingest_all(conn: sqlite3.Connection) -> dict:
    return {
        "brain": ingest_brain(conn),
        "skill-learning": ingest_skill_learnings(conn),
        "chat": ingest_chat(conn),
        "orchestration": ingest_orchestration(conn),
    }


# --- Query -------------------------------------------------------------

def search(conn: sqlite3.Connection, query: str, limit: int = 20,
           source: str | None = None) -> list[dict]:
    """Full-text search across the unified index. Returns ranked hits with
    a short snippet around the first match."""
    where = "brain_fts MATCH ?"
    params: list = [query]
    if source:
        where += " AND brain_index.source = ?"
        params.append(source)
    sql = f"""
        SELECT brain_index.*, bm25(brain_fts) AS rank
        FROM brain_fts
        JOIN brain_index ON brain_index.doc_id = brain_fts.doc_id
        WHERE {where}
        ORDER BY rank
        LIMIT ?
    """
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_dict(r, query) for r in rows]


def _row_to_dict(r: sqlite3.Row, query: str) -> dict:
    d = dict(r)
    d["snippet"] = _snippet(d.get("content", ""), query)
    return d


def _snippet(text: str, query: str, width: int = 160) -> str:
    q = query.strip().split()[0] if query.strip() else ""
    if not q:
        return text[:width]
    low = text.lower()
    idx = low.find(q.lower())
    if idx < 0:
        return text[:width]
    start = max(0, idx - width // 3)
    end = min(len(text), start + width)
    return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")


def stats(conn: sqlite3.Connection) -> dict:
    by_source = conn.execute(
        "SELECT source, COUNT(*) AS n FROM brain_index GROUP BY source"
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) AS n FROM brain_index").fetchone()["n"]
    return {row["source"]: row["n"] for row in by_source} | {"total": total}


if __name__ == "__main__":
    # CLI: `python brain-core/brain_index.py ingest` / `search "query"`
    import sys
    c = get_conn()
    if len(sys.argv) > 1 and sys.argv[1] == "ingest":
        s = ingest_all(c)
        c.commit()
        print("Ingested:", s, "total docs:", stats(c)["total"])
    elif len(sys.argv) > 1 and sys.argv[1] == "stats":
        print(stats(c))
    elif len(sys.argv) > 2 and sys.argv[1] == "search":
        for hit in search(c, sys.argv[2]):
            print(f"[{hit['source']}] {hit['title']}  (agent={hit.get('agent')})")
            print("   ", hit["snippet"][:140])
    else:
        print("usage: brain_index.py [ingest|stats|search \"query\"]")
