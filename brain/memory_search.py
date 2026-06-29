"""Agentic OS — Persistent Memory with SQLite FTS5

Full-text search across brain files, skills, journal, and prompts.
Auto-indexes text content on startup and provides search + entity extraction.
"""
import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent.resolve()
DB_PATH = BASE_DIR.parent / "data" / "memory.db"

_local = threading.local()

def _get_db():
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(str(DB_PATH))
        _local.conn.row_factory = sqlite3.Row
    return _local.conn

def init_db():
    conn = _get_db()
    conn.executescript("""
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            id, source, path, title, content, category,
            tokenize='porter unicode61'
        );
        CREATE TABLE IF NOT EXISTS memory_meta (
            id TEXT PRIMARY KEY,
            source TEXT,
            path TEXT,
            title TEXT,
            category TEXT,
            created TEXT,
            updated TEXT
        );
        CREATE TABLE IF NOT EXISTS entities (
            id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            context TEXT,
            source TEXT,
            created TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_meta_source ON memory_meta(source);
        CREATE INDEX IF NOT EXISTS idx_meta_category ON memory_meta(category);
        CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    """)
    conn.commit()

def index_text(source: str, path: str, title: str, content: str, category: str = "general"):
    conn = _get_db()
    doc_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO memory_meta (id, source, path, title, category, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (doc_id, source, path, title, category, now, now)
    )
    conn.execute(
        "INSERT INTO memory_fts (id, source, path, title, content, category) VALUES (?, ?, ?, ?, ?, ?)",
        (doc_id, source, path, title, content, category)
    )
    conn.commit()
    return doc_id

def search(query: str, limit: int = 20) -> list:
    conn = _get_db()
    if not query.strip():
        return []
    try:
        rows = conn.execute(
            "SELECT m.id, m.source, m.path, m.title, m.category, m.created, "
            "snippet(memory_fts, 4, '<mark>', '</mark>', '...', 32) as snippet "
            "FROM memory_fts JOIN memory_meta m ON memory_fts.id = m.id "
            "WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
            (query, limit)
        ).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.OperationalError:
        return []

def index_brain_files():
    brain_dir = BASE_DIR
    for f in brain_dir.glob("*.md"):
        content = f.read_text(encoding="utf-8")
        title = f.stem.replace("-", " ").replace("_", " ").title()
        index_text("brain", str(f.relative_to(BASE_DIR.parent)), title, content, "brain")

def index_skills():
    skills_dir = BASE_DIR.parent / "skills"
    for d in sorted(skills_dir.iterdir()):
        if d.is_dir() and not d.name.startswith("_"):
            for f in d.glob("*.md"):
                content = f.read_text(encoding="utf-8")
                index_text("skill", str(f.relative_to(BASE_DIR.parent)), f"{d.name}/{f.stem}", content, "skill")

def index_journal():
    journal_dir = BASE_DIR / "journal"
    if journal_dir.exists():
        for f in sorted(journal_dir.glob("*.md")):
            content = f.read_text(encoding="utf-8")
            index_text("journal", str(f.relative_to(BASE_DIR.parent)), f"Journal {f.stem}", content, "journal")

def reindex_all():
    conn = _get_db()
    conn.executescript("DELETE FROM memory_fts; DELETE FROM memory_meta;")
    conn.commit()
    index_brain_files()
    index_skills()
    index_journal()

def extract_entities(text: str) -> list:
    entities = []
    patterns = [
        (r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', 'person'),
        (r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b', 'email'),
        (r'\bhttps?://[^\s<>"]+\b', 'url'),
        (r'\b[A-Z]{2,}\b', 'acronym'),
        (r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b', 'ip'),
    ]
    seen = set()
    for pattern, etype in patterns:
        for match in re.finditer(pattern, text):
            value = match.group()
            if value not in seen:
                seen.add(value)
                entities.append({"value": value, "type": etype})
    return entities

def save_entities(entities: list, source: str = "auto"):
    conn = _get_db()
    now = datetime.now(timezone.utc).isoformat()
    for ent in entities:
        eid = str(uuid.uuid4())[:8]
        conn.execute(
            "INSERT OR IGNORE INTO entities (id, name, type, context, source, created) VALUES (?, ?, ?, ?, ?, ?)",
            (eid, ent["value"], ent["type"], ent.get("context", ""), source, now)
        )
    conn.commit()

def get_entities(entity_type: str = "", limit: int = 50) -> list:
    conn = _get_db()
    if entity_type:
        rows = conn.execute(
            "SELECT DISTINCT name, type, COUNT(*) as count FROM entities WHERE type = ? GROUP BY name ORDER BY count DESC LIMIT ?",
            (entity_type, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT DISTINCT name, type, COUNT(*) as count FROM entities GROUP BY name ORDER BY count DESC LIMIT ?",
            (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


# Initialize on import
init_db()
