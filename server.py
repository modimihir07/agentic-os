#!/usr/bin/env python3
"""
Agentic OS — FastAPI Backend
Multi-agent orchestration server for opencode, Hermes, Gemini CLI
"""
import argparse
import asyncio
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent.resolve()

# Agents supported across chat, routing, health, and kanban dispatch.
AGENTS = ["opencode", "hermes", "gemini"]

app = FastAPI(title="Agentic OS", version="1.1.0")

# Load OpenRouter API key from Hermes .env
HERMES_ENV = Path.home() / ".hermes" / ".env"
if HERMES_ENV.exists():
    for line in HERMES_ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if k == "OPENROUTER_API_KEY":
                os.environ[k] = v  # last value wins (matches shell sourcing)

def get_cors_origins() -> list[str]:
    """Return local dashboard origins allowed to call the API."""
    port = 8080
    settings_file = BASE_DIR / "data" / "settings.json"

    if settings_file.exists():
        try:
            settings = json.loads(settings_file.read_text(encoding="utf-8"))
            port = int(settings.get("dashboard", {}).get("port", port))
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            port = 8080

    origins = {
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
    }

    extra_origins = os.environ.get("AGENTIC_OS_CORS_ORIGINS", "")
    origins.update(
        origin.strip()
        for origin in extra_origins.split(",")
        if origin.strip()
    )

    return sorted(origins)


# CORS for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Models ───────────────────────────────────────────────────────

class BrainUpdate(BaseModel):
    content: str

class SkillRunRequest(BaseModel):
    input: Optional[str] = ""
    agent: Optional[str] = "auto"

class OrchestrateRequest(BaseModel):
    goal: str
    angles: Optional[dict] = None          # {agent: custom_angle_prompt}
    agents: Optional[list] = None          # override default [opencode, gemini, hermes]
    converge_agent: Optional[str] = "hermes"
    converge_prompt: Optional[str] = None  # custom synthesis instruction

class SkillCreate(BaseModel):
    name: str
    skill_md: str = ""

class SkillUpdate(BaseModel):
    skill_md: str

class SkillContextFileWrite(BaseModel):
    content: str = ""

class ScheduleJobRequest(BaseModel):
    name: str
    skill: str
    cron: str
    enabled: bool = True

class SettingsUpdate(BaseModel):
    settings: dict

class BackupRestoreRequest(BaseModel):
    file: str

class ChatRequest(BaseModel):
    agent: str
    message: str

# ─── Helper Functions ─────────────────────────────────────────────

def read_file(path: Path):
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")

def write_file(path: Path, content: str):
    path.write_text(content, encoding="utf-8")
    return True

def list_dir(path: Path):
    if not path.exists():
        return []
    return sorted([p.name for p in path.iterdir() if not p.name.startswith(".")])

def read_json(path: Path, default=None, best_effort=False):
    """Load JSON from path, returning ``default`` when the file is missing.

    On corrupt or unreadable content a descriptive ``HTTPException(500)`` is
    raised so the error is propagated to the client instead of surfacing as an
    opaque 500. Aggregate/listing callers can set ``best_effort=True`` to
    tolerate one bad file: the corruption is logged and ``default`` is returned
    instead of aborting the whole view.
    """
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
        if best_effort:
            print(f"[load] skipping corrupt {path.name}: {e}")
            return default
        raise HTTPException(500, f"Failed to read {path.name}: {e}")

def write_json(path: Path, data, indent: int = 2):
    """Serialize data as pretty JSON to path."""
    path.write_text(json.dumps(data, indent=indent), encoding="utf-8")

def iter_skill_dirs():
    """Yield skill directories, skipping hidden and underscore-prefixed ones."""
    skills_dir = BASE_DIR / "skills"
    if not skills_dir.exists():
        return
    for d in sorted(skills_dir.iterdir()):
        if d.is_dir() and not d.name.startswith("_"):
            yield d

def new_id():
    return str(uuid.uuid4())[:8]

def get_timestamp():
    return datetime.now(timezone.utc).isoformat()

def append_audit(entry: dict):
    audit_dir = BASE_DIR / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    audit_file = audit_dir / "audit.log"
    entry["timestamp"] = get_timestamp()
    entry["id"] = new_id()
    try:
        audit_file.parent.mkdir(parents=True, exist_ok=True)
        with open(audit_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        # Auditing is best-effort: never let a logging failure abort the
        # underlying operation, but surface it on the server console.
        print(f"[audit] failed to write entry {entry.get('action')!r}: {e}")


def record_brain_learning(source: str, source_path: str, title: str,
                           content: str, agent: str | None = None,
                           updated_at: str | None = None) -> bool:
    """Push a single document into the centralized brain index.

    Best-effort: a brain-index failure must never break the calling
    operation (e.g. a skill run). Calls the same engine the CLI/HTTP
    endpoints use, synchronously — no HTTP round-trip.
    """
    try:
        mod = _brain_index_module()
        conn = mod.get_conn()
        try:
            mod.upsert_doc(
                conn, source=source, source_path=source_path, title=title,
                content=content, agent=agent, updated_at=updated_at,
            )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        print(f"[brain-index] learning upsert failed ({source}/{source_path}): {e}")
        return False



# ─── Agent Stats (real, persisted) ──────────────────────────────
AGENT_STATS_FILE = BASE_DIR / "data" / "agent-stats.json"

def load_agent_stats() -> dict:
    if AGENT_STATS_FILE.exists():
        try:
            return json.loads(AGENT_STATS_FILE.read_text())
        except (json.JSONDecodeError, KeyError):
            return {}
    return {}

def save_agent_stats(stats: dict):
    AGENT_STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    AGENT_STATS_FILE.write_text(json.dumps(stats, indent=2))

def record_agent_run(agent: str, success: bool, duration: float):
    """Persist real invocation stats for an agent (consumed by /api/agents/health)."""
    stats = load_agent_stats()
    now = get_timestamp()
    s = stats.get(agent, {
        "total_runs": 0, "successful_runs": 0, "failed_runs": 0,
        "first_seen": now, "last_seen": now, "total_time": 0.0,
    })
    s["total_runs"] += 1
    if success:
        s["successful_runs"] += 1
    else:
        s["failed_runs"] += 1
    s["last_seen"] = now
    s["total_time"] = s.get("total_time", 0.0) + duration
    s["avg_response_time"] = round(s["total_time"] / s["total_runs"], 3)
    stats[agent] = s
    save_agent_stats(stats)

def is_error_response(text: str) -> bool:
    """Detect the error/refusal/busy sentinels this server emits on agent failures.

    Must match COMPLETE sentinel phrases, never bare glyphs — the warning
    sign (⚠) and clock (⏱) can appear inside legitimate agent prose,
    so matching them alone would false-positive real successes.
    """
    t = (text or "").strip()
    if not t:
        return True
    # Full-phrase sentinels only (start-anchored where appropriate).
    hard = (
        "timed out",                       # '...timed out.' / 'timed out after'
        "CLI not installed",               # '⚠ Agent X CLI not installed'
        "Error communicating",              # '⚠ Error communicating with X'
        "did not return",                 # 'Gemini CLI did not return a response'
        "needs setup",                    # '**Hermes needs setup**'
        "needs re-auth",                  # '**Gemini needs re-auth**'
        "Error executing skill",           # '⚠ Error executing skill'
        "not configured",                 # hermes setup markers
        "no api key", "api_key not",
        "config file not found", "command not found",
    )
    if any(p in t for p in hard):
        return True
    # Whole-line / start-of-response sentinels.
    if t.startswith("Unknown agent"):
        return True
    if t.startswith("**Hermes") and "error" in t.lower():
        return True
    if t.startswith("**Gemini needs"):
        return True
    return False

# ─── Skill Eval Scoring (heuristic self-improvement metric) ───────
def compute_skill_score(name: str, response_text: str) -> int:
    """Weighted 0-100 quality score from eval.json criteria + response features."""
    skill_dir = BASE_DIR / "skills" / name
    criteria = []
    eval_path = skill_dir / "eval.json"
    if eval_path.exists():
        try:
            criteria = json.loads(eval_path.read_text()).get("criteria", [])
        except Exception:
            criteria = []
    if not criteria:
        criteria = [{"name": "completeness", "weight": 0.4},
                    {"name": "accuracy", "weight": 0.3},
                    {"name": "clarity", "weight": 0.3}]
    total_w = sum(c.get("weight", 0) for c in criteria) or 1.0

    text = response_text or ""
    low = text.lower()
    is_err = is_error_response(text)

    completeness = 0 if is_err else min(100, int(len(text) / 8))
    accuracy = 0 if is_err else 60
    if not is_err:
        if "```" in text: accuracy += 15
        if any(m in low for m in ["step", "1.", "first", "example", "because"]): accuracy += 15
        accuracy = min(100, accuracy)
    clarity = 10 if is_err else 30
    if not is_err:
        if "\n#" in text or "##" in text: clarity += 25
        if "- " in text or "* " in text: clarity += 20
        if "```" in text: clarity += 15
        clarity = min(100, clarity)

    score_map = {"completeness": completeness, "accuracy": accuracy, "clarity": clarity}
    overall = sum(score_map.get(c["name"], 50) * c.get("weight", 0) for c in criteria) / total_w
    return max(0, min(100, int(round(overall))))

def record_skill_score(name: str, score: int, agent: str):
    """Append a run's score to skills/<name>/score-history.json."""
    skill_dir = BASE_DIR / "skills" / name
    if not skill_dir.exists():
        return
    hist_path = skill_dir / "score-history.json"
    hist = json.loads(hist_path.read_text()) if hist_path.exists() else []
    hist.append({
        "date": get_timestamp()[:10],
        "timestamp": get_timestamp(),
        "score": score,
        "agent": agent,
    })
    hist_path.write_text(json.dumps(hist, indent=2))

# ─── Agent Registry (dynamic, user-extensible) ─────────────────────

AGENT_REGISTRY_FILE = BASE_DIR / "data" / "agent-registry.json"

# Built-in agents (always present)
BUILTIN_AGENTS = {
    "opencode": {
        "name": "opencode",
        "display_name": "OpenCode",
        "description": "Code generation, DevOps, file operations",
        "binary": "opencode",
        "type": "cli",
        "run_args": ["opencode", "run", "--format", "json", "{message}"],
        "check_type": "binary",
        "builtin": True,
    },
    "hermes": {
        "name": "hermes",
        "display_name": "Hermes Agent",
        "description": "Memory, scheduling, multi-agent coordination",
        "binary": "hermes",
        "type": "cli",
        "run_args": ["hermes", "chat", "-q", "{message}"],
        "check_type": "binary",
        "builtin": True,
    },
    "gemini": {
        "name": "gemini",
        "display_name": "Gemini CLI",
        "description": "Research, analysis, multi-modal understanding",
        "binary": "gemini",
        "type": "cli",
        "run_args": ["gemini", "-y", "-m", "gemini-2.5-flash", "{message}"],
        "check_type": "oauth_file",
        "oauth_file": ".gemini/gemini-credentials.json",
        "builtin": True,
    },
}


def load_agent_registry() -> dict:
    """Load agent registry from disk, merging with builtins."""
    registry = dict(BUILTIN_AGENTS)
    if AGENT_REGISTRY_FILE.exists():
        try:
            custom = json.loads(AGENT_REGISTRY_FILE.read_text())
            for name, agent in custom.items():
                if name not in BUILTIN_AGENTS:
                    agent["builtin"] = False
                    registry[name] = agent
        except (json.JSONDecodeError, KeyError):
            pass
    return registry


def save_agent_registry(agents: dict):
    """Save custom agents to disk (excluding builtins)."""
    AGENT_REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    custom = {k: v for k, v in agents.items() if not v.get("builtin", False)}
    AGENT_REGISTRY_FILE.write_text(json.dumps(custom, indent=2))


def _cli_has_subcommand(base_args: list, subcommand: str) -> bool:
    try:
        r = subprocess.run([*base_args, "--help"], capture_output=True, text=True, timeout=10)
        return subcommand in ((r.stdout or "") + (r.stderr or ""))
    except Exception:
        return False


def hermes_cli_args(*args: str) -> list:
    """Build the command to invoke Hermes, bridging through WSL if the real agent only lives there.

    The dashboard commonly runs as a native Windows process while Hermes (whose official
    installer is Bash-only) lives inside WSL - a plain PATH lookup on Windows will never find it
    there. Windows machines can also have an unrelated tool also named 'hermes' on PATH (e.g. the
    academic softwarepub/HERMES metadata-publishing project, which coincidentally shares the name),
    so don't just trust that a native 'hermes' is the right one - confirm it exposes the
    NousResearch agent's `chat` subcommand before using it, falling back to WSL otherwise.
    """
    if shutil.which("hermes") is not None and _cli_has_subcommand(["hermes"], "chat"):
        return ["hermes", *args]
    if shutil.which("wsl") is not None:
        quoted = " ".join(shlex.quote(a) for a in args)
        return ["wsl", "-e", "bash", "-lc", f"hermes {quoted}"]
    return ["hermes", *args]

_hermes_available_cache = {"checked_at": 0.0, "result": False}
HERMES_AVAILABLE_CACHE_TTL = 60

def hermes_available() -> bool:
    """Cached: this spawns a subprocess (possibly via WSL), and /api/status is polled every 15s."""
    now = time.time()
    if now - _hermes_available_cache["checked_at"] < HERMES_AVAILABLE_CACHE_TTL:
        return _hermes_available_cache["result"]
    try:
        r = subprocess.run(hermes_cli_args("--version"), capture_output=True, text=True, timeout=10)
        result = r.returncode == 0
    except Exception:
        result = False
    _hermes_available_cache["checked_at"] = now
    _hermes_available_cache["result"] = result
    return result

def check_agent(name: str) -> dict:
    """Dynamic agent check based on registry configuration."""
    registry = load_agent_registry()
    agent = registry.get(name)
    if not agent:
        return {"name": name, "status": "unknown", "display_name": name}

    try:
        check_type = agent.get("check_type", "binary")
        binary = agent.get("binary", name)
        exists = shutil.which(binary) is not None

        if check_type == "binary":
            status = "online" if exists else "offline"
        elif check_type == "oauth_file":
            oauth_path = Path.home() / agent.get("oauth_file", "")
            logged_in = oauth_path.exists()
            status = "online" if exists and logged_in else "offline" if not exists else "warning"
        elif check_type == "http":
            # HTTP health check endpoint
            import urllib.request
            try:
                url = agent.get("health_url", "")
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    status = "online" if resp.status == 200 else "warning"
            except Exception:
                status = "offline" if not exists else "warning"
        elif check_type == "custom":
            # Run a custom check command. IMPORTANT: never use shell=True —
            # check_command comes from agent-registry config and a malicious
            # value ("; rm -rf ~") would otherwise execute arbitrary shell.
            check_cmd = agent.get("check_command", "")
            if check_cmd:
                import shlex
                try:
                    cmd = shlex.split(check_cmd)
                    result = subprocess.run(
                        cmd, shell=False, capture_output=True, timeout=10
                    )
                    status = "online" if result.returncode == 0 else "offline"
                except (ValueError, OSError):
                    status = "offline"
            else:
                status = "online" if exists else "offline"
        else:
            status = "online" if exists else "offline"
    except Exception:
        status = "offline"

    return {
        "name": name,
        "display_name": agent.get("display_name", name),
        "status": status,
        "description": agent.get("description", ""),
        "type": agent.get("type", "cli"),
        "builtin": agent.get("builtin", False),
    }


def execute_agent_dynamic(agent_name: str, message: str) -> str:
    """Execute a message on any registered agent."""
    registry = load_agent_registry()
    agent = registry.get(agent_name)

    if not agent:
        return f"Unknown agent: '{agent_name}'"

    agent_type = agent.get("type", "cli")

    if agent_type == "cli":
        return execute_agent_cli(agent, message)
    elif agent_type == "http":
        return execute_agent_http(agent, message)
    elif agent_type == "mcp":
        return execute_agent_mcp(agent, message)
    else:
        return f"Unsupported agent type: '{agent_type}'"


def execute_agent_cli(agent: dict, message: str) -> str:
    """Execute via CLI binary."""
    binary = agent.get("binary", agent["name"])
    run_args_template = agent.get("run_args", [binary, "{message}"])

    # Build command with message substituted
    cmd = []
    for arg in run_args_template:
        if "{message}" in arg:
            cmd.append(arg.replace("{message}", message))
        else:
            cmd.append(arg)

    timeout = agent.get("timeout", 60)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0:
            output = (result.stdout or "").strip()
            if output:
                return output
            return f"**{agent.get('display_name', binary)}**\n\nProcessed your message.\n\n**Message:** {message[:100]}"
        err = (result.stderr or "").strip()
        return err or f"{binary} returned exit code {result.returncode}"
    except subprocess.TimeoutExpired:
        return f"⏱ Agent '{agent.get('display_name', binary)}' timed out after {timeout}s.\n\n**Message:** {message[:100]}"
    except FileNotFoundError:
        return f"⚠ Agent '{agent.get('display_name', binary)}' CLI not installed. Install it and try again."
    except Exception as e:
        return f"⚠ Error communicating with {binary}: {str(e)}"


def execute_agent_http(agent: dict, message: str) -> str:
    """Execute via HTTP API endpoint."""
    import urllib.request

    url = agent.get("api_url", "")
    method = agent.get("api_method", "POST")
    headers = agent.get("api_headers", {"Content-Type": "application/json"})
    timeout = agent.get("timeout", 60)

    body = json.dumps({"message": message}).encode()

    try:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read())
            return result.get("response", result.get("output", str(result)))
    except Exception as e:
        return f"⚠ HTTP agent error: {str(e)}"


def execute_agent_mcp(agent: dict, message: str) -> str:
    """Execute via MCP server."""
    return f"⚠ MCP agent type not yet implemented for '{agent.get('display_name', agent['name'])}'"

# ─── Routes: Status ───────────────────────────────────────────────

@app.get("/api/status")
def get_status():
    registry = load_agent_registry()
    agents = [check_agent(name) for name in registry]
    skills = list_dir(BASE_DIR / "skills")
    return {
        "status": "healthy",
        "agents": agents,
        "skills_count": len(skills),
        "uptime": time.time(),
    }

# ─── Routes: Brain ────────────────────────────────────────────────

@app.get("/api/brain")
def list_brain():
    files = list_dir(BASE_DIR / "brain")
    brain_data = {}
    for f in files:
        path = BASE_DIR / "brain" / f
        if path.is_file():
            brain_data[f] = read_file(path)
    return brain_data

@app.get("/api/brain/{file_name}")
def get_brain_file(file_name: str):
    path = BASE_DIR / "brain" / file_name
    if not path.exists() or path.is_dir():
        raise HTTPException(404, "File not found")
    return {"name": file_name, "content": read_file(path)}

@app.put("/api/brain/{file_name}")
def update_brain_file(file_name: str, data: BrainUpdate):
    path = BASE_DIR / "brain" / file_name
    write_file(path, data.content)
    append_audit({"action": "brain_update", "file": file_name})
    return {"status": "ok", "file": file_name}

# ─── Routes: Centralized Brain Index (unified information pipeline) ─
# Aggregates brain/** notes, skills/*/learnings.md, and chat history into
# one SQLite+FTS5 index. Agents can write to it (ingest/upsert); you can
# query it (search/stats).

def _brain_index_module():
    """Lazy import of brain-core so a missing dir never breaks server boot."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "brain_index", BASE_DIR / "brain-core" / "brain_index.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@app.post("/api/brain-index/ingest")
def ingest_brain_index():
    mod = _brain_index_module()
    conn = mod.get_conn()
    try:
        summary = mod.ingest_all(conn)
        conn.commit()
        return {"status": "ok", "ingested": summary, "stats": mod.stats(conn)}
    finally:
        conn.close()


@app.post("/api/brain-index/upsert")
def upsert_brain_doc(data: dict):
    """Agents push a single document into the brain. Fields: source,
    source_path, title, content, agent (optional)."""
    for field in ("source", "source_path", "title", "content"):
        if not data.get(field):
            raise HTTPException(400, f"missing required field: {field}")
    mod = _brain_index_module()
    conn = mod.get_conn()
    try:
        doc_id = mod.upsert_doc(
            conn,
            source=data["source"],
            source_path=data["source_path"],
            title=data["title"],
            content=data["content"],
            agent=data.get("agent"),
            updated_at=data.get("updated_at"),
        )
        conn.commit()
        return {"status": "ok", "doc_id": doc_id}
    finally:
        conn.close()


@app.get("/api/brain-index/search")
def search_brain_index(q: str = "", limit: int = 20, source: str = None):
    if not q or not q.strip():
        raise HTTPException(400, "query parameter 'q' is required")
    mod = _brain_index_module()
    conn = mod.get_conn()
    try:
        hits = mod.search(conn, q, limit=limit, source=source)
        return {"query": q, "count": len(hits), "results": hits}
    finally:
        conn.close()


@app.get("/api/brain-index/stats")
def stats_brain_index():
    mod = _brain_index_module()
    conn = mod.get_conn()
    try:
        return mod.stats(conn)
    finally:
        conn.close()


# ─── Routes: Skills ───────────────────────────────────────────────

SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
SKILL_CONTEXT_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$")

def skill_dir_path(name: str) -> Path:
    if not SKILL_NAME_RE.fullmatch(name or ""):
        raise HTTPException(400, "Invalid skill name")
    base = (BASE_DIR / "skills").resolve()
    candidate = (base / name).resolve()
    if candidate.parent != base:
        raise HTTPException(400, "Invalid skill name")
    return candidate

def resolve_skill_dir(name: str) -> Path:
    """Return the directory of an existing skill by matching ``name`` against the
    actual directory entries.

    Using the entry from ``iterdir()`` (rather than a path built from ``name``)
    means traversal input can never escape the skills directory. Raises 404 if no
    skill matches.
    """
    base = BASE_DIR / "skills"
    if base.exists():
        for entry in base.iterdir():
            if entry.is_dir() and entry.name == name:
                return entry
    raise HTTPException(404, "Skill not found")

def skill_context_file_path(name: str, filename: str) -> Path:
    if not SKILL_CONTEXT_FILENAME_RE.fullmatch(filename or ""):
        raise HTTPException(400, "Invalid file name")
    context_dir = (skill_dir_path(name) / "context").resolve()
    candidate = (context_dir / filename).resolve()
    if candidate.parent != context_dir:
        raise HTTPException(400, "Invalid file name")
    return candidate

@app.get("/api/skills")
def list_skills():
    skills = []
    for d in iter_skill_dirs():
        skill_md = read_file(d / "SKILL.md")
        learnings = read_file(d / "learnings.md")
        eval_data = read_json(d / "eval.json", {}, best_effort=True)
        score_history = read_json(d / "score-history.json", [], best_effort=True)
        skills.append({
            "name": d.name,
            "description": skill_md[:200] if skill_md else "",
            "has_learnings": bool(learnings),
            "eval_criteria": eval_data.get("criteria", []),
            "scores": score_history,
        })
    return skills

@app.get("/api/skills/{name}")
def get_skill(name: str):
    path = resolve_skill_dir(name)
    return {
        "name": name,
        "skill": read_file(path / "SKILL.md"),
        "learnings": read_file(path / "learnings.md"),
        "eval": read_json(path / "eval.json", default={}),
        "score_history": read_json(path / "score-history.json", default=[]),
        "context": [f.name for f in (path / "context").iterdir()] if (path / "context").exists() else [],
    }

@app.post("/api/skills")
def create_skill(data: SkillCreate):
    path = skill_dir_path(data.name)
    if path.exists():
        raise HTTPException(409, "Skill already exists")
    path.mkdir(parents=True)
    (path / "context").mkdir()
    (path / "SKILL.md").write_text(data.skill_md, encoding="utf-8")
    (path / "learnings.md").write_text("", encoding="utf-8")
    append_audit({"action": "skill_created", "skill": data.name})
    return {"name": data.name}

@app.put("/api/skills/{name}")
def update_skill(name: str, data: SkillUpdate):
    path = skill_dir_path(name)
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    (path / "SKILL.md").write_text(data.skill_md, encoding="utf-8")
    append_audit({"action": "skill_updated", "skill": name})
    return {"status": "ok"}

@app.get("/api/skills/{name}/context/{filename}")
def get_skill_context_file(name: str, filename: str):
    path = skill_context_file_path(name, filename)
    if not path.exists():
        raise HTTPException(404, "File not found")
    return {"filename": filename, "content": read_file(path)}

@app.put("/api/skills/{name}/context/{filename}")
def put_skill_context_file(name: str, filename: str, data: SkillContextFileWrite):
    skill_path = skill_dir_path(name)
    if not skill_path.exists():
        raise HTTPException(404, "Skill not found")
    path = skill_context_file_path(name, filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data.content, encoding="utf-8")
    append_audit({"action": "skill_context_updated", "skill": name, "file": filename})
    return {"status": "ok"}

@app.delete("/api/skills/{name}/context/{filename}")
def delete_skill_context_file(name: str, filename: str):
    path = skill_context_file_path(name, filename)
    if not path.exists():
        raise HTTPException(404, "File not found")
    path.unlink()
    append_audit({"action": "skill_context_deleted", "skill": name, "file": filename})
    return {"status": "deleted"}

@app.post("/api/skills/{name}/run")
def run_skill(name: str, req: Optional[SkillRunRequest] = None):
    path = resolve_skill_dir(name)

    agent_choice = req.agent if req else "auto"
    skill_input = req.input if req else ""

    # Read skill files
    skill_md = read_file(path / "SKILL.md")
    learnings = read_file(path / "learnings.md")

    # Determine which agent based on skill type
    if agent_choice == "auto":
        devops_keywords = ["devops", "audit", "deploy", "k8s", "gcp", "infra", "terraform"]
        research_keywords = ["research", "synthesis", "analyze", "search", "compare"]
        if any(k in name for k in devops_keywords):
            agent_choice = "opencode"
        elif any(k in name for k in research_keywords):
            agent_choice = "gemini"
        else:
            # Check SKILL.md for explicit agent assignment
            for line in skill_md.split('\n'):
                line = line.strip()
                if "Primary:" in line:
                    candidate = line.split(":")[-1].strip().lower()
                    if candidate in load_agent_registry():
                        agent_choice = candidate
                        break
            if agent_choice == "auto":
                agent_choice = "opencode"

    # Build prompt from skill instructions + learnings + user input
    prompt = f"Execute the '{name}' skill.\n\n"
    if skill_md:
        prompt += f"## Skill Instructions\n{skill_md}\n\n"
    if learnings and learnings.strip():
        prompt += f"## Past Learnings\n{learnings}\n\n"
    if skill_input:
        prompt += f"## User Input\n{skill_input}"

    run_id = new_id()

    # Execute via agent (track real duration for agent-stats)
    import time as _t
    _t0 = _t.time()
    try:
        response_text = execute_agent(agent_choice, prompt)
    except Exception as e:  # last-resort guard (execute_agent usually returns an error string)
        response_text = f"⚠ Error executing skill: {str(e)}"
    _elapsed = _t.time() - _t0

    _agent_used = agent_choice or "auto"
    # Record REAL agent stats (consumed by /api/agents/health)
    success = not is_error_response(response_text)
    record_agent_run(_agent_used, success, _elapsed)

    # Record REAL skill eval score (consumed by /api/analytics/skills)
    score = compute_skill_score(name, response_text)
    record_skill_score(name, score, _agent_used)
    append_audit({
        "action": "skill_scored",
        "skill": name,
        "agent": agent_choice,
        "score": score,
        "duration_s": round(_elapsed, 2),
        "success": success,
    })

    # Save output to learnings.md
    timestamp = get_timestamp()[:10]
    existing = read_file(path / "learnings.md")
    new_entry = (
        f"\n## {timestamp} (Run {run_id})\n"
        f"- Agent: {agent_choice}\n"
        f"- Input: {skill_input or '(none)'}\n"
        f"- Output: {response_text[:500]}\n"
    )
    write_file(path / "learnings.md", existing + new_entry)

    # Also push this learning into the centralized brain index so it is
    # immediately searchable alongside brain/ notes and chat history.
    record_brain_learning(
        source="skill-learning",
        source_path=str(path.relative_to(BASE_DIR) / "learnings.md") + f"#{run_id}",
        title=f"{name} — learning {run_id}",
        content=f"## {timestamp} (Run {run_id})\n- Agent: {agent_choice}\n- Input: {skill_input or '(none)'}\n- Output: {response_text[:500]}",
        agent=agent_choice,
        updated_at=get_timestamp(),
    )

    # Log execution
    append_audit({
        "action": "skill_run",
        "skill": name,
        "agent": agent_choice,
        "run_id": run_id,
        "output_preview": response_text[:100],
    })

    return {
        "status": "completed",
        "run_id": run_id,
        "skill": name,
        "agent": agent_choice,
        "output": response_text,
        "message": f"Skill '{name}' completed via {agent_choice}",
    }


# ─── Routes: Multi-Agent Orchestration (fan-out + converge) ─────────
ORCHESTRATION_DIR = BASE_DIR / "data" / "orchestration-runs"

def _run_angle(agent: str, angle_prompt: str):
    """Run a single agent on its angle. Returns (agent, output, error)."""
    try:
        out = execute_agent(agent, angle_prompt)
        return agent, out, None
    except Exception as e:
        return agent, f"⚠ Error from {agent}: {e}", str(e)

@app.post("/api/orchestrate")
def orchestrate_multi_agent(req: OrchestrateRequest):
    """Spin up multiple agents on the same project goal from different angles,
    then converge their outputs into a single synthesis.

    Default angles (one per built-in agent):
      - opencode  -> implementation plan / code for the goal
      - gemini    -> research, analysis, risk/feasibility
      - hermes    -> coordination, memory, integration plan
    A convergence step feeds all angle outputs to `converge_agent`
    (default hermes) to produce the unified result.
    """
    if not req.goal or not req.goal.strip():
        raise HTTPException(422, "goal is required")

    agents = req.agents or ["opencode", "gemini", "hermes"]
    # Validate agents exist in the registry
    registry = load_agent_registry()
    unknown = [a for a in agents if a not in registry]
    if unknown:
        raise HTTPException(400, f"unknown agent(s): {unknown}")

    # Default angle prompts per role
    default_angles = {
        "opencode": (
            f"PROJECT GOAL: {req.goal}\n\n"
            "You are the IMPLEMENTATION agent. Produce a concrete implementation "
            "approach: architecture, files to create/modify, key functions, and a "
            "step-by-step build plan. Be specific and actionable. Do not do the "
            "other agents' jobs — focus on engineering."
        ),
        "gemini": (
            f"PROJECT GOAL: {req.goal}\n\n"
            "You are the RESEARCH / ANALYSIS agent. Investigate the problem space: "
            "relevant approaches, trade-offs, risks, feasibility, and any external "
            "facts or references. Do not write implementation code — focus on "
            "analysis and evidence."
        ),
        "hermes": (
            f"PROJECT GOAL: {req.goal}\n\n"
            "You are the COORDINATION / MEMORY agent. Define how the work should be "
            "sequenced, what shared state/memory is needed, how the implementation "
            "and research results integrate, and any scheduling/coordination plan. "
            "Focus on orchestration, not on coding or research yourself."
        ),
    }
    angle_prompts = {}
    for a in agents:
        if req.angles and a in req.angles and req.angles[a]:
            angle_prompts[a] = req.angles[a]
        else:
            angle_prompts[a] = default_angles.get(a, f"PROJECT GOAL: {req.goal}\n\nAddress this goal from your perspective as {a}.")

    # Fan-out: run all angles in parallel
    outputs = {}
    with ThreadPoolExecutor(max_workers=len(agents)) as ex:
        futures = {ex.submit(_run_angle, a, angle_prompts[a]): a for a in agents}
        for fut in futures:
            a = futures[fut]
            _ag, out, _err = fut.result()
            outputs[a] = out

    # Converge
    converge = req.converge_agent or "hermes"
    if converge not in registry:
        converge = agents[0]
    angle_block = "\n\n".join(
        f"### {a.upper()} ANGLE OUTPUT:\n{outputs[a]}" for a in agents
    )
    synthesis_prompt = req.converge_prompt or (
        f"PROJECT GOAL: {req.goal}\n\n"
        "You are the CONVERGENCE agent. Below are the outputs of multiple agents "
        "who each tackled the same project goal from a different angle. Synthesize "
        "them into ONE coherent plan/result:\n"
        "- Resolve contradictions between angles.\n"
        "- Produce a unified, prioritized action plan (or final answer).\n"
        "- Call out open risks and the single next step.\n\n"
        f"{angle_block}"
    )
    synthesis, conv_err = _run_angle(converge, synthesis_prompt)

    # Persist the run
    run_id = uuid.uuid4().hex[:12]
    timestamp = get_timestamp()
    run_record = {
        "run_id": run_id,
        "timestamp": timestamp,
        "goal": req.goal,
        "agents": agents,
        "angles": angle_prompts,
        "outputs": outputs,
        "converge_agent": converge,
        "synthesis": synthesis,
        "converge_error": conv_err,
    }
    ORCHESTRATION_DIR.mkdir(parents=True, exist_ok=True)
    run_file = ORCHESTRATION_DIR / f"{run_id}.json"
    write_json(run_file, run_record)

    # Make the run searchable in the brain
    try:
        bi = _brain_index_module()
        conn = bi.get_conn()
        bi.upsert_doc(
            conn, source="agent-note",
            source_path=f"data/orchestration-runs/{run_id}.json",
            title=f"Multi-agent run: {req.goal[:80]}",
            content=f"GOAL: {req.goal}\n\nSYNTHESIS:\n{synthesis[:2000]}",
            agent=f"orchestrate/{converge}", updated_at=timestamp,
        )
        conn.commit(); conn.close()
    except Exception as e:
        print(f"[orchestrate] brain upsert failed: {e}")

    return {
        "status": "completed",
        "run_id": run_id,
        "goal": req.goal,
        "agents": agents,
        "outputs": outputs,
        "converge_agent": converge,
        "synthesis": synthesis,
        "converge_error": conv_err,
        "run_file": str(run_file.relative_to(BASE_DIR)),
    }


@app.get("/api/orchestrate/runs")
def list_orchestration_runs(limit: int = 50):
    ORCHESTRATION_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(ORCHESTRATION_DIR.glob("*.json"), reverse=True)[:limit]
    runs = []
    for f in files:
        try:
            d = read_json(f, default={})
            runs.append({
                "run_id": d.get("run_id"),
                "timestamp": d.get("timestamp"),
                "goal": d.get("goal"),
                "agents": d.get("agents"),
                "converge_agent": d.get("converge_agent"),
            })
        except Exception:
            continue
    return {"runs": runs}

@app.get("/api/skills/{name}/eval")
def get_skill_eval(name: str):
    path = resolve_skill_dir(name) / "score-history.json"
    return {"scores": read_json(path, default=[])}

# ─── Routes: Scheduler ────────────────────────────────────────────

@app.get("/api/scheduler/jobs")
def list_jobs():
    jobs_dir = BASE_DIR / "scheduler" / "jobs"
    jobs = []
    for f in sorted(jobs_dir.glob("*.json")):
        job = read_json(f, default=None, best_effort=True)
        if job is not None:
            jobs.append(job)
    return jobs

@app.post("/api/scheduler/jobs")
def create_job(job: ScheduleJobRequest):
    jobs_dir = BASE_DIR / "scheduler" / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    job_data = {
        "id": new_id(),
        "name": job.name,
        "skill": job.skill,
        "cron": job.cron,
        "enabled": job.enabled,
        "created": get_timestamp(),
        "last_run": None,
        "next_run": None,
    }
    (jobs_dir / f"{job.name.replace(' ', '_')}.json").write_text(
        json.dumps(job_data, indent=2)
    )
    append_audit({"action": "job_created", "job": job.name})
    return job_data

@app.delete("/api/scheduler/jobs/{job_id}")
def delete_job(job_id: str):
    jobs_dir = BASE_DIR / "scheduler" / "jobs"
    for f in jobs_dir.glob("*.json"):
        data = read_json(f, default=None, best_effort=True)
        if data and data.get("id") == job_id:
            f.unlink()
            append_audit({"action": "job_deleted", "job_id": job_id})
            return {"status": "deleted"}
    raise HTTPException(404, "Job not found")

# ─── Routes: Audit ────────────────────────────────────────────────

@app.get("/api/audit")
def get_audit(limit: int = Query(100, le=500)):
    audit_file = BASE_DIR / "audit" / "audit.log"
    if not audit_file.exists():
        return {"entries": []}
    lines = audit_file.read_text().strip().split("\n")
    entries = []
    for l in lines:
        if not l.strip():
            continue
        try:
            entries.append(json.loads(l))
        except (json.JSONDecodeError, ValueError):
            # Skip malformed lines in the audit log
            continue
    return {"entries": entries[-limit:]}

# ─── Routes: Cost Analytics ───────────────────────────────────────

@app.get("/api/cost")
def get_cost():
    cost_file = BASE_DIR / "data" / "cost-history.json"
    return read_json(cost_file, {"entries": [], "daily_totals": {}, "monthly_projection": 0, "free_tier_alerts": []})

@app.post("/api/cost/record")
def record_cost(data: dict):
    cost_file = BASE_DIR / "data" / "cost-history.json"
    cost_data = read_json(cost_file, {"entries": [], "daily_totals": {}, "monthly_projection": 0, "free_tier_alerts": []})
    cost_data["entries"].append({
        "timestamp": get_timestamp(),
        "agent": data.get("agent", "unknown"),
        "tokens": data.get("tokens", 0),
        "cost": data.get("cost", 0.0),
        "model": data.get("model", "unknown"),
    })
    write_json(cost_file, cost_data)
    return {"status": "recorded"}

# ─── Routes: Registry/Plugins ─────────────────────────────────────

@app.get("/api/plugins")
def list_plugins():
    reg_file = BASE_DIR / "registry" / "plugins.json"
    return read_json(reg_file, {"plugins": []})

@app.post("/api/plugins/install")
def install_plugin(data: dict):
    name = data.get("name", "").strip()
    repo_url = data.get("repo_url", "").strip()
    if not name and not repo_url:
        raise HTTPException(400, "Plugin name or repo_url required")

    # Derive name from repo_url if not given
    if not name and repo_url:
        name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")

    reg_file = BASE_DIR / "registry" / "plugins.json"
    reg = read_json(reg_file, {"plugins": []})
    if any(p["name"] == name for p in reg["plugins"]):
        return {"status": "already_installed", "plugin": name}

    plugin_dir = BASE_DIR / "skills" / name

    # If repo_url provided, clone it
    if repo_url:
        import subprocess
        if plugin_dir.exists():
            # Pull latest if already cloned
            subprocess.run(["git", "pull"], cwd=str(plugin_dir), capture_output=True)
        else:
            subprocess.run(["git", "clone", "--depth=1", repo_url, str(plugin_dir)], capture_output=True)

    # If no repo_url, create from template
    elif not plugin_dir.exists():
        import shutil
        template_dir = BASE_DIR / "skills" / "_template"
        shutil.copytree(template_dir, plugin_dir)

    # Detect metadata from SKILL.md frontmatter
    skill_md = plugin_dir / "SKILL.md"
    version = "1.0.0"
    description = ""
    plugin_type = "skill"
    if skill_md.exists():
        content = skill_md.read_text()
        import re
        ver_match = re.search(r'^version:\s*(.+)$', content, re.MULTILINE)
        desc_match = re.search(r'^description:\s*(.+)$', content, re.MULTILINE)
        type_match = re.search(r'^type:\s*(.+)$', content, re.MULTILINE)
        if ver_match:
            version = ver_match.group(1).strip().strip('"').strip("'")
        if desc_match:
            description = desc_match.group(1).strip().strip('"').strip("'")
        if type_match:
            plugin_type = type_match.group(1).strip()

    reg["plugins"].append({
        "name": name,
        "version": version,
        "description": description,
        "installed": get_timestamp(),
        "type": plugin_type,
        "source": repo_url or "local",
    })
    write_json(reg_file, reg)
    append_audit({"action": "plugin_installed", "plugin": name})
    return {"status": "installed", "plugin": name}

@app.delete("/api/plugins/{plugin_name}")
def uninstall_plugin(plugin_name: str):
    reg_file = BASE_DIR / "registry" / "plugins.json"
    reg = json.loads(reg_file.read_text()) if reg_file.exists() else {"plugins": []}
    reg["plugins"] = [p for p in reg["plugins"] if p["name"] != plugin_name]
    reg_file.write_text(json.dumps(reg, indent=2))
    append_audit({"action": "plugin_uninstalled", "plugin": plugin_name})
    return {"status": "uninstalled", "plugin": plugin_name}

# ─── Routes: Connected Apps ────────────────────────────────────────

@app.get("/api/integrations")
def list_integrations():
    """List connected external apps/integrations."""
    int_file = BASE_DIR / "data" / "integrations.json"
    if not int_file.exists():
        return {"integrations": []}
    return json.loads(int_file.read_text())

@app.post("/api/integrations")
def add_integration(data: dict):
    """Connect an external app via URL/webhook."""
    name = data.get("name", "").strip()
    url = data.get("url", "").strip()
    int_type = data.get("type", "webhook")
    if not name or not url:
        raise HTTPException(400, "name and url required")

    int_file = BASE_DIR / "data" / "integrations.json"
    integrations = []
    if int_file.exists():
        integrations = json.loads(int_file.read_text()).get("integrations", [])
    if any(i["name"] == name for i in integrations):
        raise HTTPException(409, f"Integration '{name}' already exists")

    integrations.append({
        "name": name,
        "url": url,
        "type": int_type,
        "added": get_timestamp(),
        "status": "active",
    })
    int_file.write_text(json.dumps({"integrations": integrations}, indent=2))
    append_audit({"action": "integration_added", "name": name, "url": url})
    return {"status": "connected", "name": name}

# ─── Routes: Backup ───────────────────────────────────────────────

@app.get("/api/backups")
def list_backups():
    backup_dir = BASE_DIR / "backups"
    backups = []
    for f in sorted(backup_dir.glob("*.tar.gz"), reverse=True):
        backups.append({
            "name": f.name,
            "size": f.stat().st_size,
            "created": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
        })
    return backups

@app.post("/api/backup")
def create_backup():
    backup_dir = BASE_DIR / "backups"
    backup_dir.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = backup_dir / f"agentic-os-{ts}.tar.gz"
    with tarfile.open(backup_file, "w:gz") as tar:
        for dir_name in ["brain", "skills", "agents", "registry", "standards", "prompts"]:
            d = BASE_DIR / dir_name
            if d.exists():
                tar.add(d, arcname=dir_name)
    append_audit({"action": "backup_created", "file": backup_file.name})
    return {"status": "ok", "file": backup_file.name, "size": backup_file.stat().st_size}

def _resolve_backup_file(name: str) -> Path:
    """Resolve a restore request to a real .tar.gz inside backups/, rejecting traversal.

    The returned path is taken from the directory listing (never built from the raw
    request value), so a caller can only ever select an existing backup file.
    """
    if not name or name != Path(name).name or not name.endswith(".tar.gz"):
        raise HTTPException(400, "Invalid backup file name")
    backup_dir = (BASE_DIR / "backups").resolve()
    for candidate in backup_dir.glob("*.tar.gz"):
        if candidate.name == name:
            return candidate
    raise HTTPException(404, "Backup file not found")


def _safe_extractall(tar: tarfile.TarFile, dest: Path):
    """Extract a tar archive, refusing members that would escape dest (CVE-2007-4559)."""
    dest = dest.resolve()
    for member in tar.getmembers():
        target = (dest / member.name).resolve()
        if target != dest and dest not in target.parents:
            raise HTTPException(400, f"Unsafe path in archive: {member.name}")
        if member.issym() or member.islnk():
            link_target = (target.parent / member.linkname).resolve()
            if link_target != dest and dest not in link_target.parents:
                raise HTTPException(400, f"Unsafe link in archive: {member.name}")
    tar.extractall(path=dest, filter="data")


@app.post("/api/backup/restore")
def restore_backup(data: BackupRestoreRequest):
    backup_file = _resolve_backup_file(data.file)
    if not backup_file.exists():
        raise HTTPException(404, "Backup file not found")
    with tarfile.open(backup_file, "r:gz") as tar:
        _safe_extractall(tar, BASE_DIR)
    append_audit({"action": "backup_restored", "file": data.file})
    return {"status": "restored"}

# ─── Routes: Prompts ──────────────────────────────────────────────

@app.get("/api/prompts")
def list_prompts():
    prompts_dir = BASE_DIR / "prompts"
    prompts = {}
    for f in sorted(prompts_dir.glob("*.md")):
        prompts[f.stem] = read_file(f)
    return prompts

# ─── Routes: Settings ─────────────────────────────────────────────

@app.get("/api/settings")
def get_settings():
    sf = BASE_DIR / "data" / "settings.json"
    return read_json(sf, {})

@app.put("/api/settings")
def update_settings(data: SettingsUpdate):
    sf = BASE_DIR / "data" / "settings.json"
    # Merge with existing
    existing = read_json(sf, {})
    existing.update(data.settings)
    write_json(sf, existing)
    append_audit({"action": "settings_updated"})
    return {"status": "ok"}

# ─── Routes: Standards ────────────────────────────────────────────

@app.get("/api/standards")
def list_standards():
    std_dir = BASE_DIR / "standards"
    if not std_dir.exists():
        return {"standards": []}
    standards = []
    index_file = std_dir / "index.yml"
    index_content = read_file(index_file)
    for f in std_dir.glob("*.md"):
        standards.append({
            "name": f.stem,
            "content": read_file(f),
        })
    return {"standards": standards, "index": index_content}

@app.post("/api/standards/discover")
def discover_standards():
    # Stub: scans codebase for patterns
    append_audit({"action": "standards_discovery_run"})
    return {"status": "discovery_started", "message": "Scanning codebase for patterns..."}

# ─── Routes: Chat ─────────────────────────────────────────────────

CHAT_HISTORY_FILE = BASE_DIR / "data" / "chat-history.json"

def load_chat_history():
    return read_json(CHAT_HISTORY_FILE, {"messages": []})

def save_chat_message(msg: dict):
    history = load_chat_history()
    history["messages"].append(msg)
    if len(history["messages"]) > 200:
        history["messages"] = history["messages"][-200:]
    write_json(CHAT_HISTORY_FILE, history)

def run_cli(args: list, timeout: int = 30) -> tuple:
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr

def clean_hermes_output(raw: str) -> str:
    """Strip CLI metadata from Hermes output, returning only the AI response."""
    if not raw:
        return ""
    lines = raw.split('\n')
    in_box = False
    content_lines = []
    for line in lines:
        if '╭─' in line:
            in_box = True
            continue
        if '╰─' in line:
            in_box = False
            continue
        if in_box:
            # Remove ANSI escape codes and leading whitespace
            cleaned = line.strip()
            if cleaned:
                content_lines.append(cleaned)
    if content_lines:
        return '\n'.join(content_lines)
    # Fallback: if no box found, return last non-metadata line
    non_meta = [l.strip() for l in lines if l.strip() and not l.startswith(('Query:', 'Initializing', '──', 'Resume', 'Session:', 'Duration:', 'Messages:'))]
    return '\n'.join(non_meta[-5:]) or raw

def execute_agent(agent: str, message: str) -> str:
    import time as _t
    _t0 = _t.time()
    _ok = True
    try:
        if agent == "opencode":
            try:
                code, out, err = run_cli(["opencode", "run", "--format", "json", message], timeout=30)
            except subprocess.TimeoutExpired:
                return f"⏱ Agent 'opencode' timed out.\n\nOpenCode's model is taking too long. Try running `opencode run \"{message[:60]}\"` directly in your terminal.\n\n**Message:** {message[:100]}"
            if code == 0:
                response_text = ""
                for line in (out or "").split('\n'):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        if event.get("type") == "text":
                            text = event.get("part", {}).get("text", "")
                            if text:
                                response_text += text + "\n"
                    except (json.JSONDecodeError, KeyError):
                        continue
                if response_text:
                    return response_text.strip()
                return f"**opencode**\n\nProcessed your message.\n\n**Message:** {message[:100]}"
            err_msg = (err or "").strip()
            return err_msg or f"opencode returned exit code {code}"

        elif agent == "hermes":
            try:
                code, out, err = run_cli(hermes_cli_args("chat", "-q", message), timeout=180)
            except subprocess.TimeoutExpired:
                return f"⏱ Hermes timed out.\n\nThe model took too long to respond. Try a shorter query or check your OpenRouter rate limits.\n\n**Message:** {message[:100]}"
            if code == 0:
                cleaned = clean_hermes_output(out or "")
                if cleaned:
                    return cleaned
                # Empty response from model - return useful fallback
                return f"**Hermes**\n\nReceived your message but the model returned an empty response. Try rephrasing your query.\n\n**Message:** {message}"
            err_msg = (err or "").strip()
            # Only flag as "needs setup" when the error clearly indicates Hermes
            # is genuinely unconfigured (missing key/config). Transient failures
            # (rate limits, timeouts, empty model output, API hiccups) must NOT
            # be mislabeled as a setup problem.
            setup_markers = ("not configured", "no api key", "api_key not", "missing config", "config file not found", "command not found")
            if code != 0 and any(m in err_msg.lower() for m in setup_markers):
                return f"**Hermes needs setup**\n\nRun `hermes setup` or check your config.\n\n**Details:** {err_msg[:200]}"
            # Otherwise surface the real error so failures are diagnosable.
            if err_msg:
                return f"**Hermes error (exit {code})**\n\n{err_msg[:400]}\n\nIf this looks like a config problem, run `hermes setup`."
            return f"hermes returned exit code {code}"

        elif agent == "gemini":
            for attempt, (args, to) in enumerate([
                (["-y", "-m", "gemini-2.5-flash"], 60),
                (["-y"], 40),
            ]):
                try:
                    code, out, err = run_cli(["gemini", *args, message], timeout=to)
                except subprocess.TimeoutExpired:
                    if attempt == 0:
                        continue
                    return f"⏱ Gemini timed out.\n\nTry running `gemini \"{message[:60]}\"` directly.\n\n**Message:** {message[:100]}"
                if code == 0:
                    return (out or "").strip() or f"**Gemini CLI**\n\nProcessed your query.\n\n**Message:** {message}"
                err_msg = (err or "").strip()
                if attempt == 0 and ("model" in err_msg.lower() or "not found" in err_msg.lower()):
                    continue
                if "auth" in err_msg.lower() or "login" in err_msg.lower():
                    return f"**Gemini needs re-auth**\n\nRun `gemini auth login` to re-authenticate.\n\n**Details:** {err_msg[:200]}"
                return err_msg or f"gemini returned exit code {code}"
            return "Gemini CLI did not return a response."

        else:
            return f"Unknown agent: {agent}"
    except subprocess.TimeoutExpired:
        return f"⏱ Agent '{agent}' timed out.\n\nRun `{agent} --help` in your terminal for CLI usage.\n\n**Message:** {message[:100]}"
    except FileNotFoundError:
        return f"⚠ Agent '{agent}' CLI not installed. Install it and try again."
    except Exception as e:
        return f"⚠ Error communicating with {agent}: {str(e)}"

@app.post("/api/chat")
def chat(req: ChatRequest):
    agent = req.agent.lower().strip()
    registry = load_agent_registry()
    if agent not in registry:
        raise HTTPException(400, f"Agent must be one of: {', '.join(registry.keys())}")

    user_msg = {
        "id": new_id(),
        "role": "user",
        "agent": agent,
        "content": req.message,
        "timestamp": get_timestamp(),
    }
    save_chat_message(user_msg)

    response_text = execute_agent(agent, req.message)
    # Record REAL agent stats (consumed by /api/agents/health)
    record_agent_run(agent, not is_error_response(response_text), 0.0)

    agent_msg = {
        "id": new_id(),
        "role": "assistant",
        "agent": agent,
        "content": response_text,
        "timestamp": get_timestamp(),
    }
    save_chat_message(agent_msg)

    append_audit({"action": "chat_message", "agent": agent, "msg_preview": req.message[:50]})

    return {"status": "ok", "response": agent_msg}

@app.get("/api/chat/history")
def get_chat_history():
    return load_chat_history()

# ─── Routes: Terminal (real interactive PTY over WebSocket) ──────

class PtySession:
    """Wraps a real pseudo-terminal shell process, POSIX (stdlib pty) or Windows (pywinpty)."""

    def __init__(self):
        self.master_fd = None
        self.pid = None
        self.winpty_process = None

    def start(self, cwd: str):
        if os.name == "nt":
            import winpty
            shell = shutil.which("powershell.exe") or "powershell.exe"
            self.winpty_process = winpty.PtyProcess.spawn([shell, "-NoLogo"], cwd=cwd)
        else:
            import pty
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(cwd)
                shell = os.environ.get("SHELL", "/bin/bash")
                os.execvp(shell, [shell])
            else:
                self.master_fd = fd
                self.pid = pid

    def read(self, size: int = 4096):
        if self.winpty_process is not None:
            return self.winpty_process.read(size)
        return os.read(self.master_fd, size)

    def write(self, data: str):
        if self.winpty_process is not None:
            self.winpty_process.write(data)
        else:
            os.write(self.master_fd, data.encode())

    def resize(self, cols: int, rows: int):
        if self.winpty_process is not None:
            self.winpty_process.setwinsize(rows, cols)
        else:
            import fcntl
            import struct
            import termios
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self):
        if self.winpty_process is not None:
            try:
                self.winpty_process.close(force=True)
            except Exception:
                pass
        else:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            if self.pid:
                # Interactive shells commonly ignore SIGTERM; SIGKILL can't be blocked/ignored.
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    os.waitpid(self.pid, 0)  # reap the killed child so it doesn't stay a zombie
                except ChildProcessError:
                    pass

@app.websocket("/ws/terminal")
async def ws_terminal(websocket: WebSocket):
    # CORSMiddleware does not protect WebSocket handshakes, so this endpoint - which spawns a
    # full interactive shell - must check the Origin header itself, or any webpage could open
    # this socket and get command execution on the machine running the dashboard.
    origin = websocket.headers.get("origin")
    if origin not in get_cors_origins():
        await websocket.close(code=1008)
        return
    await websocket.accept()
    session = PtySession()
    try:
        session.start(str(BASE_DIR))
    except Exception as e:
        await websocket.send_json({"type": "output", "data": f"Failed to start terminal: {e}\r\n"})
        await websocket.close()
        return

    append_audit({"action": "terminal_session_started"})
    loop = asyncio.get_event_loop()
    stop = False

    def reader():
        while not stop:
            try:
                data = session.read(4096)
            except (OSError, EOFError):
                break
            if not data:
                break
            text = data.decode(errors="replace") if isinstance(data, bytes) else data
            fut = asyncio.run_coroutine_threadsafe(websocket.send_json({"type": "output", "data": text}), loop)
            try:
                fut.result(timeout=5)
            except Exception:
                break
        asyncio.run_coroutine_threadsafe(websocket.close(), loop)

    threading.Thread(target=reader, daemon=True).start()

    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "input":
                session.write(msg.get("data", ""))
            elif msg.get("type") == "resize":
                session.resize(int(msg.get("cols", 80)), int(msg.get("rows", 24)))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        stop = True
        session.close()
        append_audit({"action": "terminal_session_ended"})

# ═══════════════════════════════════════════════════════════════════
# v0.2.0 — New Feature Endpoints
# ═══════════════════════════════════════════════════════════════════

# ─── Models ─────────────────────────────────────────────────────

class KanbanTaskCreate(BaseModel):
    title: str
    body: str = ""
    status: str = "triage"
    priority: str = "medium"
    assignee: str = ""

class KanbanTaskUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assignee: Optional[str] = None

class KanbanComplete(BaseModel):
    summary: str = ""

class KanbanBlock(BaseModel):
    reason: str = ""

class KanbanCommentCreate(BaseModel):
    message: str

class KanbanLinkCreate(BaseModel):
    parent_id: str
    child_id: str

class GoalCreate(BaseModel):
    title: str
    description: str = ""
    category: str = "general"
    target_date: str = ""

class GoalUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    target_date: Optional[str] = None
    progress: Optional[int] = None
    status: Optional[str] = None

class JournalSave(BaseModel):
    content: str

class RouterSuggest(BaseModel):
    task: str

class RouterRoute(BaseModel):
    task: str
    agent: str

# ─── Data Helpers ───────────────────────────────────────────────

KANBAN_DIR = BASE_DIR / "data" / "kanban"
GOALS_FILE = BASE_DIR / "data" / "goals.json"
JOURNAL_DIR = BASE_DIR / "brain" / "journal"

def ensure_dir(d: Path):
    d.mkdir(parents=True, exist_ok=True)

def load_kanban_tasks():
    ensure_dir(KANBAN_DIR)
    tasks = []
    for f in sorted(KANBAN_DIR.glob("*.json")):
        task = read_json(f, default=None, best_effort=True)
        if task is not None:
            tasks.append(task)
    return tasks

KANBAN_ID_RE = re.compile(r"^[0-9a-f]{6,16}$")

def kanban_task_path(task_id: str) -> Path:
    """Resolve a task id to its file path, rejecting anything that isn't a plain generated id."""
    if not KANBAN_ID_RE.fullmatch(task_id or ""):
        raise HTTPException(400, "Invalid task id")
    base = KANBAN_DIR.resolve()
    candidate = (base / f"{task_id}.json").resolve()
    if candidate.parent != base:
        raise HTTPException(400, "Invalid task id")
    return candidate

def save_kanban_task(task: dict):
    ensure_dir(KANBAN_DIR)
    kanban_task_path(task["id"]).write_text(json.dumps(task, indent=2))

KANBAN_AGENTS = set(AGENTS)

def dispatch_kanban_task(task_id: str):
    """Move a task to in_progress and hand it to its assignee agent in the background."""
    path = kanban_task_path(task_id)
    if not path.exists():
        return
    task = json.loads(path.read_text())
    if task.get("status") in ("in_progress", "done"):
        return
    if task.get("assignee") not in KANBAN_AGENTS:
        return
    task["status"] = "in_progress"
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_dispatched", "task_id": task_id, "agent": task["assignee"]})
    threading.Thread(target=_run_kanban_agent, args=(task_id,), daemon=True).start()

def _run_kanban_agent(task_id: str):
    # Runs in a daemon thread: any unhandled exception would be lost and leave
    # the task stuck in "in_progress" forever, so catch failures and surface
    # them by marking the task blocked with the error.
    try:
        path = kanban_task_path(task_id)
        if not path.exists():
            return
        task = json.loads(path.read_text())
        agent = task.get("assignee")
        prompt = task["title"] if not task.get("body") else f"{task['title']}\n\n{task['body']}"

        response = execute_agent(agent, prompt)
        failed = response.startswith(("⏱", "⚠", "Unknown agent"))

        task = json.loads(path.read_text())  # reload in case it changed while the agent ran
        task.setdefault("comments", []).append({
            "id": new_id(),
            "message": f"🤖 **{agent}**\n\n{response}",
            "timestamp": get_timestamp(),
        })
        if failed:
            task["status"] = "blocked"
            task["block_reason"] = response[:300]
            append_audit({"action": "kanban_task_dispatch_failed", "task_id": task_id, "agent": agent})
        else:
            task["status"] = "done"
            task["summary"] = response[:300]
            task["completed_at"] = get_timestamp()
            append_audit({"action": "kanban_task_dispatch_completed", "task_id": task_id, "agent": agent})
        task["updated"] = get_timestamp()
        save_kanban_task(task)
    except Exception as e:
        print(f"[kanban] dispatch for task {task_id} crashed: {e}")
        try:
            path = kanban_task_path(task_id)
            task = json.loads(path.read_text())
            task["status"] = "blocked"
            task["block_reason"] = f"Dispatch crashed: {e}"[:300]
            task["updated"] = get_timestamp()
            save_kanban_task(task)
            append_audit({"action": "kanban_task_dispatch_error", "task_id": task_id, "error": str(e)[:200]})
        except Exception as inner:
            print(f"[kanban] could not mark task {task_id} as blocked: {inner}")

def load_goals():
    return read_json(GOALS_FILE, [])

def save_goals(goals: list):
    write_json(GOALS_FILE, goals)

# ─── Routes: Kanban Board (13 endpoints) ────────────────────────

@app.get("/api/kanban/board")
def kanban_board(status: Optional[str] = None):
    try:
        tasks = load_kanban_tasks()
        if status:
            tasks = [t for t in tasks if t.get("status") == status]
        columns = {"triage": [], "todo": [], "ready": [], "in_progress": [], "blocked": [], "done": []}
        for t in tasks:
            s = t.get("status", "triage")
            if s in columns:
                columns[s].append(t)
        return {"columns": columns, "total": len(tasks)}
    except Exception as e:
        return {"error": str(e), "columns": {}, "total": 0}

@app.get("/api/kanban/tasks/{task_id}")
def kanban_get_task(task_id: str):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    return json.loads(path.read_text())

@app.delete("/api/kanban/tasks/{task_id}")
def kanban_delete_task(task_id: str):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    path.unlink()
    append_audit({"action": "kanban_task_deleted", "task_id": task_id})
    return {"status": "deleted", "task_id": task_id}

@app.post("/api/kanban/tasks")
def kanban_create_task(data: KanbanTaskCreate):
    try:
        task = {
            "id": new_id(),
            "title": data.title,
            "body": data.body,
            "status": data.status,
            "priority": data.priority,
            "assignee": data.assignee,
            "comments": [],
            "links": [],
            "created": get_timestamp(),
            "updated": get_timestamp(),
        }
        save_kanban_task(task)
        append_audit({"action": "kanban_task_created", "title": data.title})
        if task["assignee"] in KANBAN_AGENTS:
            dispatch_kanban_task(task["id"])
            task = json.loads(kanban_task_path(task["id"]).read_text())
        return task
    except Exception as e:
        raise HTTPException(500, str(e))

@app.patch("/api/kanban/tasks/{task_id}")
def kanban_update_task(task_id: str, data: KanbanTaskUpdate):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    assignee_changed = data.assignee is not None and data.assignee != task.get("assignee")
    for field in ["title", "body", "status", "priority", "assignee"]:
        val = getattr(data, field, None)
        if val is not None:
            task[field] = val
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_updated", "task_id": task_id})
    if assignee_changed and task["assignee"] in KANBAN_AGENTS:
        dispatch_kanban_task(task_id)
        task = json.loads(path.read_text())
    return task

@app.post("/api/kanban/tasks/{task_id}/dispatch")
def kanban_dispatch_task(task_id: str):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    if task.get("assignee") not in KANBAN_AGENTS:
        raise HTTPException(400, "Task must be assigned to opencode, hermes, or gemini to dispatch")
    dispatch_kanban_task(task_id)
    return {"status": "dispatched", "task_id": task_id}

@app.post("/api/kanban/tasks/{task_id}/complete")
def kanban_complete_task(task_id: str, data: KanbanComplete):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    task["status"] = "done"
    task["summary"] = data.summary
    task["completed_at"] = get_timestamp()
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_completed", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/block")
def kanban_block_task(task_id: str, data: KanbanBlock):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    task["status"] = "blocked"
    task["block_reason"] = data.reason
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_blocked", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/unblock")
def kanban_unblock_task(task_id: str):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    task["status"] = "ready"
    task["block_reason"] = ""
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_unblocked", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/comments")
def kanban_add_comment(task_id: str, data: KanbanCommentCreate):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    comment = {
        "id": new_id(),
        "message": data.message,
        "timestamp": get_timestamp(),
    }
    task.setdefault("comments", []).append(comment)
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    return task

@app.post("/api/kanban/links")
def kanban_add_link(data: KanbanLinkCreate):
    for tid in [data.parent_id, data.child_id]:
        path = kanban_task_path(tid)
        if not path.exists():
            raise HTTPException(404, f"Task {tid} not found")
        t = json.loads(path.read_text())
        t.setdefault("links", [])
        link = {"parent": data.parent_id, "child": data.child_id}
        if link not in t["links"]:
            t["links"].append(link)
        t["updated"] = get_timestamp()
        save_kanban_task(t)
    append_audit({"action": "kanban_link_added", "parent": data.parent_id, "child": data.child_id})
    return {"status": "linked"}

@app.delete("/api/kanban/links")
def kanban_remove_link(parent_id: str = Query(...), child_id: str = Query(...)):
    for tid in [parent_id, child_id]:
        path = kanban_task_path(tid)
        if path.exists():
            t = json.loads(path.read_text())
            t.setdefault("links", [])
            t["links"] = [l for l in t["links"] if not (l.get("parent") == parent_id and l.get("child") == child_id)]
            t["updated"] = get_timestamp()
            save_kanban_task(t)
    return {"status": "unlinked"}

@app.delete("/api/kanban/tasks/{task_id}")
def kanban_delete_task(task_id: str):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    path.unlink()
    append_audit({"action": "kanban_task_deleted", "task_id": task_id})
    return {"status": "deleted"}

@app.post("/api/kanban/dispatch")
def kanban_dispatch():
    dispatched = []
    for task in load_kanban_tasks():
        if task.get("status") in ("todo", "ready") and task.get("assignee") in KANBAN_AGENTS:
            dispatch_kanban_task(task["id"])
            dispatched.append(task["id"])
    append_audit({"action": "kanban_dispatch_triggered", "task_ids": dispatched})
    return {"status": "dispatch_triggered", "dispatched": dispatched, "message": f"Dispatched {len(dispatched)} task(s)"}

@app.post("/api/kanban/tasks/{task_id}/specify")
def kanban_specify_task(task_id: str):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    if task.get("status") == "triage":
        task["status"] = "todo"
        task["updated"] = get_timestamp()
        save_kanban_task(task)
    return task

@app.post("/api/kanban/tasks/{task_id}/decompose")
def kanban_decompose_task(task_id: str):
    path = kanban_task_path(task_id)
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    children = []
    for i, subtask in enumerate(task.get("body", "").split("\n")):
        subtask = subtask.strip().lstrip("-* ")
        if subtask:
            child = {
                "id": new_id(),
                "title": subtask[:80],
                "body": subtask,
                "status": "todo",
                "priority": task.get("priority", "medium"),
                "assignee": "",
                "comments": [],
                "links": [{"parent": task_id, "child": ""}],
                "created": get_timestamp(),
                "updated": get_timestamp(),
            }
            child["links"][0]["child"] = child["id"]
            save_kanban_task(child)
            children.append(child)
    return {"parent": task_id, "children": children}

# ─── Routes: Goals (4 endpoints) ─────────────────────────────────

@app.get("/api/goals")
def list_goals():
    try:
        return {"goals": load_goals()}
    except Exception as e:
        return {"goals": [], "error": str(e)}

@app.post("/api/goals")
def create_goal(data: GoalCreate):
    try:
        goals = load_goals()
        goal = {
            "id": new_id(),
            "title": data.title,
            "description": data.description,
            "category": data.category,
            "target_date": data.target_date,
            "status": "active",
            "progress": 0,
            "created": get_timestamp(),
            "updated": get_timestamp(),
        }
        goals.append(goal)
        save_goals(goals)
        # Auto-sync to brain/active-projects.md
        active_path = BASE_DIR / "brain" / "active-projects.md"
        if active_path.exists():
            existing = active_path.read_text()
            existing += f"\n- [{goal['title']}](goal:{goal['id']}) — {goal['description'][:80]}\n"
            active_path.write_text(existing)
        append_audit({"action": "goal_created", "title": data.title})
        return goal
    except Exception as e:
        raise HTTPException(500, str(e))

@app.put("/api/goals/{goal_id}")
def update_goal(goal_id: str, data: GoalUpdate):
    try:
        goals = load_goals()
        for g in goals:
            if g["id"] == goal_id:
                for field in ["title", "description", "category", "target_date", "progress", "status"]:
                    val = getattr(data, field, None)
                    if val is not None:
                        g[field] = val
                g["updated"] = get_timestamp()
                save_goals(goals)
                return g
        raise HTTPException(404, "Goal not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))

@app.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: str):
    try:
        goals = load_goals()
        goals = [g for g in goals if g["id"] != goal_id]
        save_goals(goals)
        append_audit({"action": "goal_deleted", "goal_id": goal_id})
        return {"status": "deleted"}
    except Exception as e:
        raise HTTPException(500, str(e))

# ─── Routes: Journal (4 endpoints) ───────────────────────────────

@app.get("/api/journal/entries")
def list_journal_entries():
    try:
        ensure_dir(JOURNAL_DIR)
        entries = []
        for f in sorted(JOURNAL_DIR.glob("*.md"), reverse=True):
            entries.append({
                "date": f.stem,
                "preview": f.read_text()[:200],
                "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            })
        return {"entries": entries}
    except Exception as e:
        return {"entries": [], "error": str(e)}

@app.get("/api/journal/entries/{entry_date}")
def get_journal_entry(entry_date: str):
    try:
        path = JOURNAL_DIR / f"{entry_date}.md"
        ensure_dir(JOURNAL_DIR)
        content = path.read_text() if path.exists() else ""
        return {"date": entry_date, "content": content}
    except Exception as e:
        return {"date": entry_date, "content": "", "error": str(e)}

@app.put("/api/journal/entries/{entry_date}")
def save_journal_entry(entry_date: str, data: JournalSave):
    try:
        ensure_dir(JOURNAL_DIR)
        path = JOURNAL_DIR / f"{entry_date}.md"
        path.write_text(data.content)
        append_audit({"action": "journal_saved", "date": entry_date})
        return {"status": "saved", "date": entry_date}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/journal/search")
def search_journal(q: str = Query("")):
    try:
        ensure_dir(JOURNAL_DIR)
        if not q:
            return {"results": []}
        results = []
        for f in JOURNAL_DIR.glob("*.md"):
            content = f.read_text()
            if q.lower() in content.lower():
                results.append({"date": f.stem, "preview": content[:200]})
        return {"results": results, "query": q}
    except Exception as e:
        return {"results": [], "error": str(e)}

# ─── Routes: Agent Health (3 endpoints) ──────────────────────────

@app.get("/api/agents/health")
def get_agent_health():
    try:
        stats = load_agent_stats()
        agents = []
        for name in load_agent_registry():
            info = check_agent(name)
            s = stats.get(name, {})
            total = s.get("total_runs", 0)
            info["total_runs"] = total
            info["successful_runs"] = s.get("successful_runs", 0)
            info["failed_runs"] = s.get("failed_runs", 0)
            info["success_rate"] = round(100.0 * s.get("successful_runs", 0) / total, 1) if total else 0.0
            info["avg_response_time"] = s.get("avg_response_time", 0.0)
            info["uptime"] = 0  # process-level uptime not tracked per-agent
            info["last_seen"] = s.get("last_seen", "")
            agents.append(info)
        return {"agents": agents, "updated": get_timestamp()}
    except Exception as e:
        return {"agents": [], "error": str(e), "updated": get_timestamp()}

@app.get("/api/agents/{name}/stats")
def get_agent_stats(name: str):
    try:
        if name not in load_agent_registry():
            raise HTTPException(400, "Invalid agent")
        info = check_agent(name)
        stats = load_agent_stats().get(name, {})
        total = stats.get("total_runs", 0)
        return {
            "name": name,
            "status": info["status"],
            "total_runs": total,
            "successful_runs": stats.get("successful_runs", 0),
            "failed_runs": stats.get("failed_runs", 0),
            "success_rate": round(100.0 * stats.get("successful_runs", 0) / total, 1) if total else 0.0,
            "avg_response_time": stats.get("avg_response_time", 0.0),
            "first_seen": stats.get("first_seen", ""),
            "last_seen": stats.get("last_seen", ""),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/agents/health/refresh")
def refresh_agent_health():
    try:
        agents = []
        for name in load_agent_registry():
            info = check_agent(name)
            agents.append(info)
        append_audit({"action": "agent_health_refreshed"})
        return {"agents": agents, "updated": get_timestamp()}
    except Exception as e:
        return {"agents": [], "error": str(e)}

# ─── Routes: Agent Registry Management ───────────────────────────

class AgentRegisterRequest(BaseModel):
    name: str
    display_name: str = ""
    description: str = ""
    binary: str = ""
    type: str = "cli"  # cli, http, mcp
    run_args: list = []
    check_type: str = "binary"  # binary, oauth_file, http, custom
    oauth_file: str = ""
    health_url: str = ""
    api_url: str = ""
    api_method: str = "POST"
    check_command: str = ""
    timeout: int = 60
    router_keywords: list = []


@app.get("/api/agents")
def list_agents():
    """List all registered agents (built-in + custom)."""
    registry = load_agent_registry()
    agents = []
    for name, agent in registry.items():
        info = check_agent(name)
        agents.append(info)
    return {"agents": agents}


@app.post("/api/agents/register")
def register_agent(req: AgentRegisterRequest):
    """Register a new custom agent."""
    name = req.name.lower().strip().replace(" ", "_").replace("-", "_")
    if not name:
        raise HTTPException(400, "Agent name required")
    if name in BUILTIN_AGENTS:
        raise HTTPException(409, f"'{name}' is a built-in agent")

    registry = load_agent_registry()
    if name in registry:
        raise HTTPException(409, f"Agent '{name}' already exists")

    if not req.display_name:
        req.display_name = req.name.replace("_", " ").replace("-", " ").title()
    if not req.binary:
        req.binary = req.name
    if not req.run_args:
        req.run_args = [req.binary, "{message}"]

    agent_config = {
        "name": name,
        "display_name": req.display_name,
        "description": req.description,
        "binary": req.binary,
        "type": req.type,
        "run_args": req.run_args,
        "check_type": req.check_type,
        "timeout": req.timeout,
        "builtin": False,
    }
    if req.oauth_file:
        agent_config["oauth_file"] = req.oauth_file
    if req.health_url:
        agent_config["health_url"] = req.health_url
    if req.api_url:
        agent_config["api_url"] = req.api_url
    if req.api_method:
        agent_config["api_method"] = req.api_method
    if req.check_command:
        agent_config["check_command"] = req.check_command

    registry[name] = agent_config
    save_agent_registry(registry)

    if req.router_keywords:
        rkf = BASE_DIR / "data" / "router-keywords.json"
        kw = json.loads(rkf.read_text()) if rkf.exists() else {}
        kw[name] = req.router_keywords
        rkf.write_text(json.dumps(kw, indent=2))

    append_audit({"action": "agent_registered", "agent": name})
    return {"status": "registered", "agent": check_agent(name)}


@app.delete("/api/agents/{agent_name}")
def unregister_agent(agent_name: str):
    """Remove a custom agent (built-ins cannot be removed)."""
    if agent_name in BUILTIN_AGENTS:
        raise HTTPException(403, "Cannot remove built-in agents")

    registry = load_agent_registry()
    if agent_name not in registry:
        raise HTTPException(404, "Agent not found")

    del registry[agent_name]
    save_agent_registry(registry)

    rkf = BASE_DIR / "data" / "router-keywords.json"
    if rkf.exists():
        kw = json.loads(rkf.read_text())
        kw.pop(agent_name, None)
        rkf.write_text(json.dumps(kw, indent=2))

    append_audit({"action": "agent_unregistered", "agent": agent_name})
    return {"status": "unregistered", "agent": agent_name}


# ─── Routes: Smart Router (2 endpoints) ─────────────────────────

ROUTER_RULES = {
    "opencode": ["code", "devops", "deploy", "git", "file", "terraform", "docker", "test", "build", "infra", "script"],
    "hermes": ["memory", "schedule", "channel", "skill", "cron", "reminder", "brain", "plugin", "backup"],
    "gemini": ["research", "analyze", "search", "compare", "explain", "study", "learn", "document", "report", "review"],
}

@app.post("/api/router/suggest")
def router_suggest(data: RouterSuggest):
    try:
        task_lower = data.task.lower()
        # Include custom agent router keywords
        rkf = BASE_DIR / "data" / "router-keywords.json"
        if rkf.exists():
            custom_kw = json.loads(rkf.read_text())
            for agent, kw in custom_kw.items():
                if agent not in ROUTER_RULES:
                    ROUTER_RULES[agent] = kw

        scores = {}
        for agent, keywords in ROUTER_RULES.items():
            scores[agent] = sum(1 for k in keywords if k in task_lower)
        best = max(scores, key=scores.get)
        confidence = "high" if scores[best] >= 2 else "medium" if scores[best] == 1 else "low"
        return {
            "suggested_agent": best,
            "confidence": confidence,
            "scores": scores,
            "task": data.task,
        }
    except Exception as e:
        return {"suggested_agent": "opencode", "confidence": "low", "error": str(e)}

@app.post("/api/router/route")
def router_route(data: RouterRoute):
    try:
        agent = data.agent.lower()
        if agent not in load_agent_registry():
            return {"status": "error", "message": f"Invalid agent: {agent}"}
        append_audit({"action": "task_routed", "agent": agent, "task_preview": data.task[:50]})
        return {
            "status": "routed",
            "agent": agent,
            "task": data.task,
            "message": f"Task routed to {agent}",
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ─── Routes: Learning Analytics (2 endpoints) ───────────────────

@app.get("/api/analytics/skills")
def get_skill_analytics():
    try:
        analytics = []
        for d in iter_skill_dirs():
            scores = read_json(d / "score-history.json", [])
            avg_score = sum(s.get("score", 0) for s in scores) / len(scores) if scores else 0
            analytics.append({
                "name": d.name,
                "total_runs": len(scores),
                "avg_score": round(avg_score, 1),
                "last_score": scores[-1].get("score", 0) if scores else 0,
                "trend": "up" if len(scores) >= 2 and scores[-1].get("score", 0) > scores[-2].get("score", 0) else "down" if len(scores) >= 2 else "stable",
            })
        return {"skills": sorted(analytics, key=lambda x: x["total_runs"], reverse=True)}
    except Exception as e:
        return {"skills": [], "error": str(e)}

@app.get("/api/analytics/trends")
def get_trend_analytics():
    try:
        trends = []
        for d in iter_skill_dirs():
            scores = read_json(d / "score-history.json", [])
            if scores:
                trends.append({
                    "name": d.name,
                    "scores": [s.get("score", 0) for s in scores[-10:]],
                    "labels": [s.get("date", "") for s in scores[-10:]],
                })
        return {"trends": trends}
    except Exception as e:
        return {"trends": [], "error": str(e)}

# ─── Routes: Session Replay (2 endpoints) ───────────────────────

@app.get("/api/sessions/list")
def list_sessions():
    try:
        sessions = []
        sessions_dir = Path.home() / ".local" / "share" / "opencode"
        log_dir = sessions_dir / "log"
        if log_dir.exists():
            for f in sorted(log_dir.glob("*.log"), reverse=True)[:20]:
                sessions.append({
                    "id": f.stem,
                    "name": f.stem,
                    "size": f.stat().st_size,
                    "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                    "source": "opencode",
                })
        hermes_sessions = Path.home() / ".hermes" / "sessions.json"
        if hermes_sessions.exists():
            sessions.append({
                "id": "hermes-sessions",
                "name": "Hermes Session Archive",
                "size": hermes_sessions.stat().st_size,
                "modified": datetime.fromtimestamp(hermes_sessions.stat().st_mtime).isoformat(),
                "source": "hermes",
            })
        return {"sessions": sessions}
    except Exception as e:
        return {"sessions": [], "error": str(e)}

@app.get("/api/sessions/{session_id}/replay")
def get_session_replay(session_id: str):
    try:
        sessions_dir = Path.home() / ".local" / "share" / "opencode"
        log_file = sessions_dir / "log" / f"{session_id}.log"
        if log_file.exists():
            content = log_file.read_text()
            lines = content.split("\n")
            messages = []
            for line in lines:
                if "user:" in line.lower() or "assistant:" in line.lower():
                    messages.append(line)
            return {
                "session_id": session_id,
                "lines": len(lines),
                "messages": messages[:100],
                "content": content[:5000],
            }
        return {"session_id": session_id, "messages": [], "content": "Session log not found"}
    except Exception as e:
        return {"session_id": session_id, "messages": [], "error": str(e)}

# ─── WebSocket Terminal ───────────────────────────────────────────

import asyncio
import websockets
import pty
import os
import select
import struct
import fcntl
import signal

# NOTE: The interactive terminal is provided by the in-app WebSocket
# endpoint `/ws/terminal` (see PtySession above). The previous standalone
# WebSocket terminal server on port 8082 was removed to avoid two
# redundant terminal implementations.




# ─── Routes: Dashboard Static Files ──────────────────────────────

dashboard_dir = BASE_DIR / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir), html=True), name="dashboard")

# graphify knowledge-graph output (built by `graphify . --code-only`).
# Served so dashboard pages can link/open the interactive graph.
graphify_dir = BASE_DIR / "graphify-out"
if graphify_dir.exists():
    app.mount("/graphify-out", StaticFiles(directory=str(graphify_dir)), name="graphify-out")

@app.get("/", response_class=HTMLResponse)
def index():
    html_file = BASE_DIR / "dashboard" / "index.html"
    if html_file.exists():
        content = html_file.read_text(encoding="utf-8")
        content = content.replace('href="styles.css"', 'href="/dashboard/styles.css"')
        content = content.replace('src="utils.js"', 'src="/dashboard/utils.js"')
        content = content.replace('src="api.js"', 'src="/dashboard/api.js"')
        content = content.replace('src="app.js"', 'src="/dashboard/app.js"')
        content = content.replace('pages/', '/dashboard/pages/')
        return HTMLResponse(content=content)
    return HTMLResponse("<h1>Agentic OS</h1><p>Dashboard not built yet. Run the installer for your platform first (<code>./install.sh</code> on Linux/macOS or <code>.\\install.ps1</code> on Windows).</p>")

@app.get("/test", response_class=HTMLResponse)
def test_page():
    html_file = BASE_DIR / "dashboard" / "test.html"
    if html_file.exists():
        return HTMLResponse(html_file.read_text())
    return HTMLResponse("<h1>Test page not found</h1>")

# ─── Routes: Agent Time Monitor ───────────────────────────────
# Tracks total time AI agents spent on the project. Time is DERIVED from
# event logs (audit.log, chat-history.json, cost-history.json) via a
# session-gap estimator — see scripts/analyze_agent_time.py.
# NOTE: no recompute happens at startup or import; the report is only
# regenerated on explicit /api/agent-time/recompute (or if the cache
# file is missing). This keeps app boot fast and side-effect free.

AGENT_TIME_REPORT = BASE_DIR / "data" / "agent-time.json"
AGENT_TIME_ANALYZER = BASE_DIR / "scripts" / "analyze_agent_time.py"

def _recompute_agent_time() -> dict:
    """Run the analyzer to (re)generate data/agent-time.json. Returns report."""
    import subprocess
    try:
        subprocess.run(
            [sys.executable, str(AGENT_TIME_ANALYZER)],
            cwd=str(BASE_DIR), capture_output=True, text=True, timeout=120,
        )
    except Exception:
        pass
    # The analyzer always writes the file (even with 0 events), but guard
    # in case the script is missing.
    if AGENT_TIME_REPORT.exists():
        return json.loads(AGENT_TIME_REPORT.read_text(encoding="utf-8"))
    return {"project": "agentic-os", "total_seconds": 0, "total_human": "0h 0m 0s",
            "agents": {}, "event_count": 0, "method": "unavailable"}

@app.get("/api/agent-time")
def get_agent_time(recompute: bool = False):
    if recompute or not AGENT_TIME_REPORT.exists():
        return _recompute_agent_time()
    try:
        return json.loads(AGENT_TIME_REPORT.read_text(encoding="utf-8"))
    except Exception:
        return _recompute_agent_time()

@app.post("/api/agent-time/recompute")
def recompute_agent_time():
    report = _recompute_agent_time()
    return {"ok": True, "total_human": report.get("total_human"),
            "agents": len(report.get("agents", {})),
            "event_count": report.get("event_count", 0)}

# Skin-friendly view for Rainmeter (WebParser). Returns plain text:
#   Line 1: human total, e.g. "5h 34m 45s"
#   Line 2: total_seconds + fixed-order per-agent seconds (0 if absent)
#            system hermes opencode gemini codex jarvis kilocode test_claude test
# This fixed-width layout lets a single RegExp grab every value reliably.
_AGENT_ORDER = ["system", "hermes", "opencode", "gemini", "codex",
                "jarvis", "kilocode", "test_claude", "test"]

@app.get("/api/agent-time/skin")
def agent_time_skin():
    if not AGENT_TIME_REPORT.exists():
        report = _recompute_agent_time()
    else:
        try:
            report = json.loads(AGENT_TIME_REPORT.read_text(encoding="utf-8"))
        except Exception:
            report = _recompute_agent_time()
    agents = report.get("agents", {})
    total = report.get("total_seconds", 0)
    per = " ".join(str(agents.get(a, {}).get("total_seconds", 0)) for a in _AGENT_ORDER)
    body = f"{report.get('total_human', '0h 0m 0s')}\n{total} {per}"
    return Response(content=body, media_type="text/plain; charset=utf-8")


# ─── Routes: Agent Insights (AI usage analytics) ──────────────────
# Aggregates real usage data across chat history, cost history, derived
# agent-time, the agent registry, and router keywords to answer:
#   - which agent do I chat with most
#   - which agent spends the most time completing tasks
#   - which agent seems best suited for what
#   - which models I use most with each agent
# All source data is read-only; no writes happen on this endpoint.

ROUTER_KEYWORDS_FILE = BASE_DIR / "data" / "router-keywords.json"

# Human-readable role hints keyed by agent name (falls back to registry
# description / router keywords when unknown).
AGENT_ROLE_HINTS = {
    "opencode": "Code generation, file ops, DevOps/infra, git, software engineering",
    "hermes": "Persistent memory, cron scheduling, messaging channels, skill hub, coordination",
    "gemini": "Web research, multi-modal/image/PDF analysis, reasoning, data analysis",
    "jarvis": "Local-first personal AI: deep research, knowledge, memory, general reasoning",
    "kilocode": "AI coding assistant: implement, refactor, programming tasks",
    "codex": "OpenAI Codex: coding, debugging, tests, builds",
}


@app.get("/api/agent-insights")
def get_agent_insights(recompute: bool = False):
    # Pull the four required datasets from disk.
    chat = load_chat_history().get("messages", [])
    cost = read_json(
        BASE_DIR / "data" / "cost-history.json",
        {"entries": []},
    ).get("entries", [])
    registry = load_agent_registry()
    router_kw = read_json(ROUTER_KEYWORDS_FILE, {})

    if recompute or not AGENT_TIME_REPORT.exists():
        time_report = _recompute_agent_time()
    else:
        try:
            time_report = json.loads(AGENT_TIME_REPORT.read_text(encoding="utf-8"))
        except Exception:
            time_report = _recompute_agent_time()
    time_agents = time_report.get("agents", {})

    # 1) Chat volume per agent (count user+assistant messages; pair count
    #    = number of user turns, which is the most meaningful "chat" metric).
    chat_counts = {}
    user_turns = {}
    first_chat = {}
    last_chat = {}
    for m in chat:
        a = m.get("agent") or "unknown"
        chat_counts[a] = chat_counts.get(a, 0) + 1
        if m.get("role") == "user":
            user_turns[a] = user_turns.get(a, 0) + 1
        ts = m.get("timestamp")
        if ts:
            if a not in first_chat or ts < first_chat[a]:
                first_chat[a] = ts
            if a not in last_chat or ts > last_chat[a]:
                last_chat[a] = ts

    # 2) Time per agent (from derived agent-time report).
    time_per_agent = {
        a: {
            "total_seconds": d.get("total_seconds", 0),
            "sessions": d.get("sessions", 0),
            "touches": d.get("touches", 0),
        }
        for a, d in time_agents.items()
    }

    # 3) Models used per agent (from cost history).
    models_per_agent = {}
    tokens_per_agent = {}
    cost_per_agent = {}
    for e in cost:
        a = e.get("agent") or "unknown"
        model = e.get("model") or "unknown"
        models_per_agent.setdefault(a, {})
        models_per_agent[a][model] = models_per_agent[a].get(model, 0) + 1
        tokens_per_agent[a] = tokens_per_agent.get(a, 0) + (e.get("tokens", 0) or 0)
        cost_per_agent[a] = cost_per_agent.get(a, 0) + (e.get("cost", 0) or 0)

    # 4) Best-suited-for: combine registry description, router keywords,
    #    and AGENTS.md role hints into a per-agent "suite" summary.
    suite = {}
    for name in set(list(registry.keys()) + list(router_kw.keys()) +
                     list(chat_counts.keys()) + list(time_per_agent.keys())):
        desc = (registry.get(name, {}) or {}).get("description", "")
        role = AGENT_ROLE_HINTS.get(name, "")
        kws = router_kw.get(name, [])
        suite[name] = {
            "description": desc or role,
            "role_hint": role,
            "keywords": kws,
        }

    # Build a per-agent consolidated view.
    all_agents = set(
        list(chat_counts.keys()) + list(time_per_agent.keys())
        + list(models_per_agent.keys()) + list(suite.keys())
    )
    per_agent = {}
    for a in all_agents:
        per_agent[a] = {
            "agent": a,
            "display_name": (registry.get(a, {}) or {}).get("display_name", a),
            "chat_messages": chat_counts.get(a, 0),
            "user_turns": user_turns.get(a, 0),
            "time_seconds": time_per_agent.get(a, {}).get("total_seconds", 0),
            "sessions": time_per_agent.get(a, {}).get("sessions", 0),
            "touches": time_per_agent.get(a, {}).get("touches", 0),
            "tokens": tokens_per_agent.get(a, 0),
            "cost": round(cost_per_agent.get(a, 0), 6),
            "top_models": sorted(
                models_per_agent.get(a, {}).items(),
                key=lambda kv: kv[1], reverse=True,
            ),
            "suite": suite.get(a, {}),
            "first_seen": first_chat.get(a),
            "last_seen": last_chat.get(a),
        }

    # Rankings
    by_chats = sorted(
        per_agent.values(), key=lambda x: x["user_turns"], reverse=True
    )
    by_time = sorted(
        per_agent.values(), key=lambda x: x["time_seconds"], reverse=True
    )

    # Most-used model overall per agent already in top_models; also a global
    # model popularity map.
    global_models = {}
    for a, models in models_per_agent.items():
        for m, c in models.items():
            global_models[m] = global_models.get(m, 0) + c

    return {
        "generated_at": get_timestamp(),
        "totals": {
            "total_chat_messages": sum(chat_counts.values()),
            "total_user_turns": sum(user_turns.values()),
            "total_time_seconds": time_report.get("total_seconds", 0),
            "total_time_human": time_report.get("total_human", "0h 0m 0s"),
            "total_tokens": sum(tokens_per_agent.values()),
            "total_cost": round(sum(cost_per_agent.values()), 6),
            "agents_observed": len(per_agent),
        },
        "most_chatted": [
            {"agent": x["agent"], "display_name": x["display_name"],
             "user_turns": x["user_turns"], "chat_messages": x["chat_messages"]}
            for x in by_chats if x["user_turns"] > 0
        ],
        "most_time": [
            {"agent": x["agent"], "display_name": x["display_name"],
             "time_seconds": x["time_seconds"], "sessions": x["sessions"],
             "touches": x["touches"]}
            for x in by_time if x["time_seconds"] > 0
        ],
        "global_models": sorted(
            global_models.items(), key=lambda kv: kv[1], reverse=True
        ),
        "per_agent": per_agent,
    }


# ─── Favicon ──────────────────────────────────────────────────────

FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6c5ce7"/><stop offset="100%" stop-color="#fd79a8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><polygon points="16,6 24,11 24,21 16,26 8,21 8,11" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="16" cy="16" r="3" fill="white"/></svg>'

@app.get("/favicon.ico")
def favicon():
    return Response(content=FAVICON_SVG, media_type="image/svg+xml")

@app.get("/favicon.svg")
def favicon_svg():
    return Response(content=FAVICON_SVG, media_type="image/svg+xml")

# ─── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import socket

    import uvicorn

    # Single source of truth: the dashboard port lives in data/settings.json.
    # Read it here so `--port` defaults to it (launchers, scheduler, docs all agree).
    _settings_port = 8080
    try:
        _sf = BASE_DIR / "data" / "settings.json"
        if _sf.exists():
            _settings_port = int(json.loads(_sf.read_text(encoding="utf-8")).get("dashboard", {}).get("port", 8080))
    except Exception:
        _settings_port = 8080

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=_settings_port)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()

    # ── Double-launch guard ───────────────────────────────────────────
    # Refuse to start if the API port is already bound by another process.
    # Without this, two server.py instances collide on the API port (default 8080),
    # producing phantom "register doesn't persist" bugs and bind crashes.
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((args.host, args.port))
        probe.close()
    except OSError:
        print(
            f"ERROR: port {args.port} on {args.host} is already in use. "
            f"Agentic OS appears to be running already — stop it first "
            f"(./start.sh --stop) before launching another instance."
        )
        raise SystemExit(1)

    uvicorn.run(app, host=args.host, port=args.port)
