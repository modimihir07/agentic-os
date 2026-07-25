#!/usr/bin/env python3
"""
Agentic OS — FastAPI Backend
Multi-agent orchestration server for opencode, Hermes, Gemini CLI
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
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

# CORS — allow all origins for local dev (WSL + Windows browser)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent.resolve()

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
    audit_dir = BASE_DIR / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    audit_file = audit_dir / "audit.log"
    entry["timestamp"] = get_timestamp()
    entry["id"] = str(uuid.uuid4())[:8]
    with open(audit_file, "a") as f:
        f.write(json.dumps(entry) + "\n")

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
            # Run a custom check command
            check_cmd = agent.get("check_command", "")
            if check_cmd:
                result = subprocess.run(check_cmd, shell=True, capture_output=True, timeout=10)
                status = "online" if result.returncode == 0 else "offline"
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
        if path.is_dir():
            continue
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

    run_id = str(uuid.uuid4())[:8]

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
    repo_url = data.get("repo_url", "").strip()
    if not name and not repo_url:
        raise HTTPException(400, "Plugin name or repo_url required")

    # Derive name from repo_url if not given
    if not name and repo_url:
        name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")

    reg_file = BASE_DIR / "registry" / "plugins.json"
    reg = json.loads(reg_file.read_text()) if reg_file.exists() else {"plugins": []}
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
    reg_file.write_text(json.dumps(reg, indent=2))
    append_audit({"action": "plugin_installed", "plugin": name, "source": repo_url or "local"})
    return {"status": "installed", "plugin": name, "path": str(plugin_dir)}

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
        "id": str(uuid.uuid4())[:8],
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

def save_kanban_task(task: dict):
    ensure_dir(KANBAN_DIR)
    (KANBAN_DIR / f"{task['id']}.json").write_text(json.dumps(task, indent=2))

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
    path = KANBAN_DIR / f"{task_id}.json"
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
        return task
    except Exception as e:
        raise HTTPException(500, str(e))

@app.patch("/api/kanban/tasks/{task_id}")
def kanban_update_task(task_id: str, data: KanbanTaskUpdate):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    for field in ["title", "body", "status", "priority", "assignee"]:
        val = getattr(data, field, None)
        if val is not None:
            task[field] = val
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_updated", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/complete")
def kanban_complete_task(task_id: str, data: KanbanComplete):
    path = KANBAN_DIR / f"{task_id}.json"
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
    path = KANBAN_DIR / f"{task_id}.json"
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
    path = KANBAN_DIR / f"{task_id}.json"
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
    path = KANBAN_DIR / f"{task_id}.json"
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
        path = KANBAN_DIR / f"{tid}.json"
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
        path = KANBAN_DIR / f"{tid}.json"
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
    append_audit({"action": "kanban_dispatch_triggered"})
    return {"status": "dispatch_triggered", "message": "Dispatcher notified"}

@app.post("/api/kanban/tasks/{task_id}/specify")
def kanban_specify_task(task_id: str):
    path = KANBAN_DIR / f"{task_id}.json"
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
    path = KANBAN_DIR / f"{task_id}.json"
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

# ─── WebSocket Terminal ───────────────────────────────────────────

import asyncio
import websockets
import pty
import os
import select
import struct
import fcntl
import signal

# Store active terminal sessions
terminal_sessions: dict = {}


async def terminal_handler(websocket, path=None):
    """Handle WebSocket terminal connections with a real PTY shell."""
    session_id = str(uuid.uuid4())[:8]
    pid = None
    fd = None

    try:
        # Fork a PTY
        pid, fd = pty.fork()

        if pid == 0:
            # Child process — exec shell
            env = os.environ.copy()
            env["TERM"] = "xterm"
            env["COLORTERM"] = "truecolor"
            os.execvpe(os.environ.get("SHELL", "/bin/bash"), ["bash"], env)
        else:
            # Parent process — relay between websocket and PTY
            terminal_sessions[session_id] = {"pid": pid, "fd": fd, "ws": websocket}

            async def read_from_pty():
                """Read output from PTY and send to websocket."""
                try:
                    while True:
                        try:
                            r, _, _ = select.select([fd], [], [], 0.1)
                            if r:
                                data = os.read(fd, 65536)
                                if data:
                                    try:
                                        await websocket.send(data.decode("utf-8", errors="replace"))
                                    except websockets.exceptions.ConnectionClosed:
                                        break
                                else:
                                    break
                        except OSError:
                            break
                        await asyncio.sleep(0.01)
                except Exception:
                    pass

            async def read_from_ws():
                """Read input from websocket and write to PTY."""
                try:
                    async for message in websocket:
                        try:
                            if isinstance(message, str):
                                data = json.loads(message)
                                action = data.get("action", "input")

                                if action == "input":
                                    os.write(fd, data.get("data", "").encode("utf-8"))
                                elif action == "resize":
                                    # Resize the PTY
                                    cols = data.get("cols", 80)
                                    rows = data.get("rows", 24)
                                    winsize = struct.pack("HHHH", rows, cols, 0, 0)
                                    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
                                    os.kill(pid, signal.SIGWINCH)
                            else:
                                os.write(fd, message)
                        except json.JSONDecodeError:
                            os.write(fd, message.encode("utf-8") if isinstance(message, str) else message)
                        except OSError:
                            break
                except websockets.exceptions.ConnectionClosed:
                    pass

            # Run both directions concurrently
            read_pty_task = asyncio.create_task(read_from_pty())
            read_ws_task = asyncio.create_task(read_from_ws())

            done, pending = await asyncio.wait(
                [read_pty_task, read_ws_task],
                return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()

    except Exception as e:
        try:
            await websocket.send(f"\r\n[Terminal Error: {str(e)}]\r\n")
        except Exception:
            pass
    finally:
        terminal_sessions.pop(session_id, None)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if pid is not None:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


# Try to import terminal resize constant
try:
    import termios
except ImportError:
    termios = None  # Windows — won't work there


def start_terminal_server(host="0.0.0.0", port=8082):
    """Start the WebSocket terminal server on a separate port."""
    async def serve():
        server = await websockets.serve(
            terminal_handler,
            host,
            port,
            max_size=10 * 1024 * 1024,
        )
        return server

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    server = loop.run_until_complete(serve())
    loop.run_forever()


# Start terminal server in a daemon thread
import threading
_terminal_thread = threading.Thread(target=start_terminal_server, daemon=True)
_terminal_thread.start()


# ─── Routes: Dashboard Static Files ──────────────────────────────

dashboard_dir = BASE_DIR / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir)), name="dashboard")

# graphify knowledge-graph output (built by `graphify . --code-only`).
# Served so dashboard pages can link/open the interactive graph.
graphify_dir = BASE_DIR / "graphify-out"
if graphify_dir.exists():
    app.mount("/graphify-out", StaticFiles(directory=str(graphify_dir)), name="graphify-out")

@app.get("/", response_class=HTMLResponse)
def index():
    html_file = BASE_DIR / "dashboard" / "index.html"
    if html_file.exists():
        content = html_file.read_text()
        content = content.replace('href="styles.css"', 'href="/dashboard/styles.css"')
        content = content.replace('src="utils.js"', 'src="/dashboard/utils.js"')
        content = content.replace('src="api.js"', 'src="/dashboard/api.js"')
        content = content.replace('src="app.js"', 'src="/dashboard/app.js"')
        content = content.replace('pages/', '/dashboard/pages/')
        return HTMLResponse(content=content)
    return HTMLResponse("<h1>Agentic OS</h1><p>Dashboard not built yet.</p>")

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
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
