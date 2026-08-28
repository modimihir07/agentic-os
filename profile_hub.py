"""Protected Hermes profile CRUD for Agentic OS."""
from __future__ import annotations

import ast
import json
import os
import re
import secrets
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Header, HTTPException

NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}[a-z0-9]")
LOCK = threading.RLock()
PROTECTED = {"default", os.getenv("AGENTIC_OS_HERMES_PROFILE", "agentic-os")}


def _root() -> Path:
    root = Path(os.environ.get("AGENTIC_OS_HERMES_HOME", str(Path.home() / ".hermes"))).resolve()
    if not root.is_dir():
        raise HTTPException(503, "Hermes home is unavailable")
    return root


def _home(name: str, must_exist: bool = True) -> Path:
    if name != "default" and not NAME_RE.fullmatch(name):
        raise HTTPException(400, "Invalid profile name")
    root = _root()
    candidate = root if name == "default" else root / "profiles" / name
    expected_parent = root if name == "default" else (root / "profiles").resolve()
    if candidate.is_symlink():
        raise HTTPException(400, "Unsafe profile path")
    resolved = candidate.resolve(strict=False)
    if name != "default" and resolved.parent != expected_parent:
        raise HTTPException(400, "Unsafe profile path")
    if must_exist and (not resolved.is_dir() or candidate.is_symlink()):
        raise HTTPException(404, "Profile not found")
    return resolved


def _require_admin(x_agentic_os_admin: str | None = Header(default=None)) -> None:
    expected = os.getenv("AGENTIC_OS_ADMIN_TOKEN")
    if not expected:
        raise HTTPException(503, "Profile Hub is not configured")
    if not x_agentic_os_admin or not secrets.compare_digest(x_agentic_os_admin, expected):
        raise HTTPException(401, "Invalid admin token")


def _run(args: list[str], timeout: int = 45) -> str:
    env = {**os.environ, "HERMES_HOME": str(_root())}
    try:
        result = subprocess.run(
            [os.getenv("AGENTIC_OS_HERMES_BIN", "hermes"), *args],
            capture_output=True, text=True, timeout=timeout, check=False, env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "Hermes operation timed out") from exc
    except OSError as exc:
        raise HTTPException(503, "Hermes CLI is unavailable") from exc
    if result.returncode:
        raise HTTPException(502, "Hermes CLI operation failed")
    return result.stdout


def _yaml_scalar(path: Path, key: str) -> str | None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1_000_000:
        return None
    lines = path.read_text(errors="replace").splitlines()
    for index, line in enumerate(lines):
        match = re.match(rf"^{re.escape(key)}:\s*(.*?)\s*$", line)
        if not match:
            continue
        first = match.group(1).strip()
        parts = [first] if first else []
        for continuation in lines[index + 1:]:
            if continuation and not continuation[0].isspace():
                break
            stripped = continuation.strip()
            if stripped:
                parts.append(stripped)
        if not parts:
            return None
        if parts[0] in (">", ">-", ">+", "|", "|-", "|+"):
            value = " ".join(parts[1:])
        elif parts[0].startswith('"'):
            value = parts[0]
            for part in parts[1:]:
                if value.endswith("\\"):
                    value = value[:-1] + (part[1:] if part.startswith("\\ ") else part)
                else:
                    value += " " + part
            try:
                value = ast.literal_eval(value)
            except (SyntaxError, ValueError):
                return None
        elif parts[0].startswith("'"):
            value = " ".join(parts)
            if not value.endswith("'"):
                return None
            value = value[1:-1].replace("''", "'")
        else:
            value = " ".join(parts).split(" #", 1)[0].strip()
        return value[:2000] or None
    return None


def _inventory(name: str) -> dict[str, Any]:
    home = _home(name)
    values: dict[str, Any] = {
        "model": None, "provider": None, "gateway": "unknown",
        "skills_count": 0, "alias": None, "health": "unavailable",
    }
    try:
        output = _run(["profile", "show", name], timeout=12)
        for line in output.splitlines():
            label, sep, raw = line.partition(":")
            if not sep:
                continue
            value = raw.strip()
            if label == "Model":
                match = re.fullmatch(r"(.+?)\s+\(([^()]+)\)", value)
                if match:
                    values["model"], values["provider"] = match.groups()
                elif "/" in value:
                    values["provider"], values["model"] = value.split("/", 1)
                elif value and value != "—":
                    values["model"] = value
            elif label == "Gateway":
                values["gateway"] = value or "unknown"
            elif label == "Skills":
                match = re.match(r"(\d+)", value)
                if match:
                    values["skills_count"] = int(match.group(1))
            elif label == "Alias":
                alias = Path(value).name if value and value != "—" else ""
                values["alias"] = alias if re.fullmatch(r"[A-Za-z0-9._-]{1,128}", alias) else None
        values["health"] = "ok"
    except HTTPException:
        pass
    return {
        "name": name,
        "description": _yaml_scalar(home / "profile.yaml", "description"),
        "soul_exists": (home / "SOUL.md").is_file() and not (home / "SOUL.md").is_symlink(),
        "protected": name in PROTECTED,
        **values,
    }


def _names() -> list[str]:
    root = _root()
    names = ["default"]
    profiles = root / "profiles"
    if profiles.is_dir() and not profiles.is_symlink():
        names.extend(sorted(
            p.name for p in profiles.iterdir()
            if p.is_dir() and not p.is_symlink() and NAME_RE.fullmatch(p.name)
        ))
    return names


def _audit(action: str, profile: str, result: str) -> None:
    path = Path(os.getenv("AGENTIC_OS_AUDIT_FILE", "/var/log/agentic-os-profile-audit.jsonl"))
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action, "profile": profile, "result": result,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    os.chmod(path, 0o600)


def _body(body: Any, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(body, dict) or set(body) - allowed:
        raise HTTPException(400, "Invalid request body")
    return body


router = APIRouter(prefix="/api/hermes", dependencies=[])


@router.get("/profiles", dependencies=[])
def list_profiles(x_agentic_os_admin: str | None = Header(default=None)) -> list[dict[str, Any]]:
    _require_admin(x_agentic_os_admin)
    return [_inventory(name) for name in _names()]


@router.get("/profiles/{name}")
def get_profile(name: str, x_agentic_os_admin: str | None = Header(default=None)) -> dict[str, Any]:
    _require_admin(x_agentic_os_admin)
    return _inventory(name)


@router.post("/profiles")
def create_profile(body: Any = Body(...), x_agentic_os_admin: str | None = Header(default=None)) -> dict[str, Any]:
    _require_admin(x_agentic_os_admin)
    data = _body(body, {"name", "description", "soul"})
    name = str(data.get("name", ""))
    if not NAME_RE.fullmatch(name) or name in PROTECTED:
        raise HTTPException(400, "Invalid profile name")
    description = str(data.get("description", ""))[:2000]
    soul = data.get("soul")
    if soul is not None and (not isinstance(soul, str) or len(soul) > 100_000):
        raise HTTPException(400, "Invalid SOUL content")
    with LOCK:
        _home(name, must_exist=False)
        if (_root() / "profiles" / name).exists():
            raise HTTPException(409, "Profile already exists")
        _audit("create", name, "started")
        try:
            _run(["profile", "create", name, "--description", description])
            home = _home(name)
            if soul is not None:
                (home / "SOUL.md").write_text(soul, encoding="utf-8")
                os.chmod(home / "SOUL.md", 0o600)
        except Exception:
            _audit("create", name, "failed")
            raise
        _audit("create", name, "success")
    return _inventory(name)


@router.patch("/profiles/{name}")
def update_profile(name: str, body: Any = Body(...), x_agentic_os_admin: str | None = Header(default=None)) -> dict[str, Any]:
    _require_admin(x_agentic_os_admin)
    data = _body(body, {"description", "soul", "name", "confirm"})
    home = _home(name)
    new_name = data.get("name")
    with LOCK:
        _audit("update", name, "started")
        if new_name is not None:
            new_name = str(new_name)
            if name in PROTECTED or not NAME_RE.fullmatch(new_name) or data.get("confirm") != name:
                raise HTTPException(400, "Rename confirmation or name is invalid")
            _home(new_name, must_exist=False)
            _run(["profile", "rename", name, new_name])
            name = new_name
            home = _home(name)
        if "description" in data:
            _run(["profile", "describe", name, "--text", str(data["description"])[:2000]])
        if "soul" in data:
            soul = data["soul"]
            if not isinstance(soul, str) or len(soul) > 100_000:
                raise HTTPException(400, "Invalid SOUL content")
            path = home / "SOUL.md"
            if path.is_symlink():
                raise HTTPException(400, "Unsafe SOUL path")
            path.write_text(soul, encoding="utf-8")
            os.chmod(path, 0o600)
        _audit("update", name, "success")
    return _inventory(name)


@router.post("/profiles/{name}/backup")
def backup_profile(name: str, x_agentic_os_admin: str | None = Header(default=None)) -> dict[str, str]:
    _require_admin(x_agentic_os_admin)
    _home(name)
    backup_dir = Path(os.getenv("AGENTIC_OS_HERMES_BACKUP_DIR", "/var/lib/agentic-os/backups"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{name}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.tar.gz"
    with LOCK:
        _run(["profile", "export", name, "--output", str(backup_dir / filename)], timeout=120)
        os.chmod(backup_dir / filename, 0o600)
        _audit("backup", name, "success")
    return {"status": "created", "filename": filename}


@router.delete("/profiles/{name}")
def delete_profile(name: str, confirm: str | None = None, x_agentic_os_admin: str | None = Header(default=None)) -> dict[str, str]:
    _require_admin(x_agentic_os_admin)
    profile = _inventory(name)
    if name in PROTECTED:
        raise HTTPException(409, "Protected profile cannot be deleted")
    if confirm != name:
        raise HTTPException(400, "Exact profile name confirmation is required")
    if str(profile.get("gateway", "")).lower() != "stopped":
        raise HTTPException(409, "Stop the profile gateway before deleting")
    with LOCK:
        backup_profile(name, x_agentic_os_admin)
        _audit("delete", name, "started")
        _run(["profile", "delete", name, "--yes"], timeout=120)
        _audit("delete", name, "success")
    return {"status": "deleted", "name": name}
