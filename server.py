#!/usr/bin/env python3
"""
Agentic OS — FastAPI Backend
Multi-agent orchestration server for opencode, Hermes, Gemini CLI
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import tarfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent.resolve()

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

class TerminalRunRequest(BaseModel):
    command: str

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

def get_timestamp():
    return datetime.now(timezone.utc).isoformat()

def append_audit(entry: dict):
    audit_file = BASE_DIR / "audit" / "audit.log"
    entry["timestamp"] = get_timestamp()
    entry["id"] = str(uuid.uuid4())[:8]
    with open(audit_file, "a") as f:
        f.write(json.dumps(entry) + "\n")

# ─── Agent Discovery (instant filesystem checks) ────────────────────

def check_agent(name: str) -> dict:
    """Instant filesystem-based check. No subprocess needed."""
    try:
        if name == "opencode":
            exists = shutil.which("opencode") is not None
            status = "online" if exists else "offline"
        elif name == "hermes":
            exists = shutil.which("hermes") is not None
            status = "online" if exists else "offline"
        elif name == "gemini":
            # Gemini has valid OAuth tokens logged in
            oauth = Path.home() / ".gemini" / "oauth_creds.json"
            exists = shutil.which("gemini") is not None
            logged_in = oauth.exists() and "ya29" in oauth.read_text()
            status = "online" if exists and logged_in else "offline" if not exists else "warning"
        else:
            status = "offline"
    except Exception:
        status = "offline"
    return {"name": name, "status": status}

# ─── Routes: Status ───────────────────────────────────────────────

@app.get("/api/status")
def get_status():
    agents = [check_agent(a) for a in ["opencode", "hermes", "gemini"]]
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

# ─── Routes: Skills ───────────────────────────────────────────────

@app.get("/api/skills")
def list_skills():
    skills = []
    for d in sorted((BASE_DIR / "skills").iterdir()):
        if d.is_dir() and not d.name.startswith("_"):
            skill_md = read_file(d / "SKILL.md")
            learnings = read_file(d / "learnings.md")
            eval_data = {}
            eval_path = d / "eval.json"
            if eval_path.exists():
                eval_data = json.loads(eval_path.read_text())
            score_history = []
            score_path = d / "score-history.json"
            if score_path.exists():
                score_history = json.loads(score_path.read_text())
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
    path = BASE_DIR / "skills" / name
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    return {
        "name": name,
        "skill": read_file(path / "SKILL.md"),
        "learnings": read_file(path / "learnings.md"),
        "eval": json.loads((path / "eval.json").read_text()) if (path / "eval.json").exists() else {},
        "score_history": json.loads((path / "score-history.json").read_text()) if (path / "score-history.json").exists() else [],
        "context": [f.name for f in (path / "context").iterdir()] if (path / "context").exists() else [],
    }

@app.post("/api/skills/{name}/run")
def run_skill(name: str, req: Optional[SkillRunRequest] = None):
    path = BASE_DIR / "skills" / name
    if not path.exists():
        raise HTTPException(404, "Skill not found")

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
                    if candidate in ("opencode", "hermes", "gemini"):
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

    run_id = str(uuid.uuid4())[:8]

    # Execute via agent
    try:
        response_text = execute_agent(agent_choice, prompt)
    except subprocess.TimeoutExpired:
        response_text = f"⏱ Skill '{name}' timed out on agent '{agent_choice}'."
    except FileNotFoundError:
        response_text = f"⚠ Agent '{agent_choice}' CLI not installed. Install it and try again."
    except Exception as e:
        response_text = f"⚠ Error executing skill: {str(e)}"

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

@app.get("/api/skills/{name}/eval")
def get_skill_eval(name: str):
    path = BASE_DIR / "skills" / name / "score-history.json"
    if not path.exists():
        return {"scores": []}
    return {"scores": json.loads(path.read_text())}

# ─── Routes: Scheduler ────────────────────────────────────────────

@app.get("/api/scheduler/jobs")
def list_jobs():
    jobs_dir = BASE_DIR / "scheduler" / "jobs"
    jobs = []
    for f in sorted(jobs_dir.glob("*.json")):
        jobs.append(json.loads(f.read_text()))
    return jobs

@app.post("/api/scheduler/jobs")
def create_job(job: ScheduleJobRequest):
    jobs_dir = BASE_DIR / "scheduler" / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    job_data = {
        "id": str(uuid.uuid4())[:8],
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
        data = json.loads(f.read_text())
        if data.get("id") == job_id:
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
    entries = [json.loads(l) for l in lines if l.strip()]
    return {"entries": entries[-limit:]}

# ─── Routes: Cost Analytics ───────────────────────────────────────

@app.get("/api/cost")
def get_cost():
    cost_file = BASE_DIR / "data" / "cost-history.json"
    if not cost_file.exists():
        return {"entries": [], "daily_totals": {}, "monthly_projection": 0, "free_tier_alerts": []}
    return json.loads(cost_file.read_text())

@app.post("/api/cost/record")
def record_cost(data: dict):
    cost_file = BASE_DIR / "data" / "cost-history.json"
    cost_data = json.loads(cost_file.read_text()) if cost_file.exists() else \
        {"entries": [], "daily_totals": {}, "monthly_projection": 0, "free_tier_alerts": []}
    cost_data["entries"].append({
        "timestamp": get_timestamp(),
        "agent": data.get("agent", "unknown"),
        "tokens": data.get("tokens", 0),
        "cost": data.get("cost", 0.0),
        "model": data.get("model", "unknown"),
    })
    cost_file.write_text(json.dumps(cost_data, indent=2))
    return {"status": "recorded"}

# ─── Routes: Registry/Plugins ─────────────────────────────────────

@app.get("/api/plugins")
def list_plugins():
    reg_file = BASE_DIR / "registry" / "plugins.json"
    if not reg_file.exists():
        return {"plugins": []}
    return json.loads(reg_file.read_text())

@app.post("/api/plugins/install")
def install_plugin(data: dict):
    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Plugin name required")
    reg_file = BASE_DIR / "registry" / "plugins.json"
    reg = json.loads(reg_file.read_text()) if reg_file.exists() else {"plugins": []}
    if any(p["name"] == name for p in reg["plugins"]):
        return {"status": "already_installed"}
    reg["plugins"].append({
        "name": name,
        "installed": get_timestamp(),
        "version": "1.0.0",
    })
    reg_file.write_text(json.dumps(reg, indent=2))
    append_audit({"action": "plugin_installed", "plugin": name})
    return {"status": "installed", "plugin": name}

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

@app.post("/api/backup/restore")
def restore_backup(data: BackupRestoreRequest):
    backup_file = BASE_DIR / "backups" / data.file
    if not backup_file.exists():
        raise HTTPException(404, "Backup file not found")
    with tarfile.open(backup_file, "r:gz") as tar:
        tar.extractall(path=BASE_DIR)
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
    if not sf.exists():
        return {}
    return json.loads(sf.read_text())

@app.put("/api/settings")
def update_settings(data: SettingsUpdate):
    sf = BASE_DIR / "data" / "settings.json"
    # Merge with existing
    existing = json.loads(sf.read_text()) if sf.exists() else {}
    existing.update(data.settings)
    sf.write_text(json.dumps(existing, indent=2))
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
    if CHAT_HISTORY_FILE.exists():
        return json.loads(CHAT_HISTORY_FILE.read_text())
    return {"messages": []}

def save_chat_message(msg: dict):
    history = load_chat_history()
    history["messages"].append(msg)
    if len(history["messages"]) > 200:
        history["messages"] = history["messages"][-200:]
    CHAT_HISTORY_FILE.write_text(json.dumps(history, indent=2))

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
                code, out, err = run_cli(["hermes", "chat", "-q", message], timeout=180)
            except subprocess.TimeoutExpired:
                return f"⏱ Hermes timed out.\n\nThe model took too long to respond. Try a shorter query or check your OpenRouter rate limits.\n\n**Message:** {message[:100]}"
            if code == 0:
                cleaned = clean_hermes_output(out or "")
                if cleaned:
                    return cleaned
                # Empty response from model - return useful fallback
                return f"**Hermes**\n\nReceived your message but the model returned an empty response. Try rephrasing your query.\n\n**Message:** {message}"
            err_msg = (err or "").strip()
            if "invalid choice" in err_msg or "usage:" in err_msg:
                return f"**Hermes needs setup**\n\nRun `hermes setup` or check your config.\n\n**Details:** {err_msg[:200]}"
            return err_msg or f"hermes returned exit code {code}"

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
    if agent not in ["opencode", "hermes", "gemini"]:
        raise HTTPException(400, "Agent must be one of: opencode, hermes, gemini")

    user_msg = {
        "id": str(uuid.uuid4())[:8],
        "role": "user",
        "agent": agent,
        "content": req.message,
        "timestamp": get_timestamp(),
    }
    save_chat_message(user_msg)

    response_text = execute_agent(agent, req.message)

    agent_msg = {
        "id": str(uuid.uuid4())[:8],
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

# ─── Routes: Terminal ─────────────────────────────────────────────

_terminal_cwd = str(BASE_DIR)

@app.get("/api/terminal/session")
def get_terminal_session():
    return {"cwd": _terminal_cwd}

@app.post("/api/terminal/run")
def run_terminal_command(req: TerminalRunRequest):
    global _terminal_cwd
    command = req.command.strip()
    if not command:
        return {"cwd": _terminal_cwd, "stdout": "", "stderr": "", "returncode": 0, "timed_out": False}

    if command == "cd" or command.startswith("cd "):
        target = command[2:].strip() or str(Path.home())
        new_dir = (Path(_terminal_cwd) / target).resolve() if not Path(target).is_absolute() else Path(target).resolve()
        if not new_dir.is_dir():
            return {"cwd": _terminal_cwd, "stdout": "", "stderr": f"cd: no such directory: {target}", "returncode": 1, "timed_out": False}
        _terminal_cwd = str(new_dir)
        append_audit({"action": "terminal_command", "command": "cd", "cwd": _terminal_cwd})
        return {"cwd": _terminal_cwd, "stdout": "", "stderr": "", "returncode": 0, "timed_out": False}

    try:
        r = subprocess.run(
            command, shell=True, cwd=_terminal_cwd,
            capture_output=True, text=True, timeout=60,
        )
        append_audit({"action": "terminal_command", "command": command[:200], "cwd": _terminal_cwd})
        return {"cwd": _terminal_cwd, "stdout": r.stdout, "stderr": r.stderr, "returncode": r.returncode, "timed_out": False}
    except subprocess.TimeoutExpired:
        return {"cwd": _terminal_cwd, "stdout": "", "stderr": "Command timed out after 60s.", "returncode": -1, "timed_out": True}

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
        tasks.append(json.loads(f.read_text()))
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

KANBAN_AGENTS = {"opencode", "hermes", "gemini"}

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
        "id": str(uuid.uuid4())[:8],
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

def load_goals():
    if GOALS_FILE.exists():
        return json.loads(GOALS_FILE.read_text())
    return []

def save_goals(goals: list):
    GOALS_FILE.write_text(json.dumps(goals, indent=2))

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

@app.post("/api/kanban/tasks")
def kanban_create_task(data: KanbanTaskCreate):
    try:
        task = {
            "id": str(uuid.uuid4())[:8],
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
        "id": str(uuid.uuid4())[:8],
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
                "id": str(uuid.uuid4())[:8],
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
            "id": str(uuid.uuid4())[:8],
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
        agents = []
        for name in ["opencode", "hermes", "gemini"]:
            info = check_agent(name)
            info["uptime"] = 0
            info["success_rate"] = 100
            info["last_seen"] = get_timestamp()
            agents.append(info)
        return {"agents": agents, "updated": get_timestamp()}
    except Exception as e:
        return {"agents": [], "error": str(e), "updated": get_timestamp()}

@app.get("/api/agents/{name}/stats")
def get_agent_stats(name: str):
    try:
        if name not in ["opencode", "hermes", "gemini"]:
            raise HTTPException(400, "Invalid agent")
        info = check_agent(name)
        return {
            "name": name,
            "status": info["status"],
            "total_runs": 0,
            "successful_runs": 0,
            "failed_runs": 0,
            "avg_response_time": 0,
            "last_seen": get_timestamp(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/agents/health/refresh")
def refresh_agent_health():
    try:
        agents = []
        for name in ["opencode", "hermes", "gemini"]:
            info = check_agent(name)
            agents.append(info)
        append_audit({"action": "agent_health_refreshed"})
        return {"agents": agents, "updated": get_timestamp()}
    except Exception as e:
        return {"agents": [], "error": str(e)}

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
        if agent not in ["opencode", "hermes", "gemini"]:
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
        skills_dir = BASE_DIR / "skills"
        analytics = []
        for d in sorted(skills_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("_"):
                eval_path = d / "eval.json"
                score_path = d / "score-history.json"
                scores = json.loads(score_path.read_text()) if score_path.exists() else []
                eval_data = json.loads(eval_path.read_text()) if eval_path.exists() else {}
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
        skills_dir = BASE_DIR / "skills"
        trends = []
        for d in sorted(skills_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("_"):
                score_path = d / "score-history.json"
                scores = json.loads(score_path.read_text()) if score_path.exists() else []
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

# ─── Routes: Dashboard Static Files ──────────────────────────────

dashboard_dir = BASE_DIR / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir)), name="dashboard")

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
    return HTMLResponse("<h1>Agentic OS</h1><p>Dashboard not built yet. Run <code>./install.sh</code> first.</p>")

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
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
