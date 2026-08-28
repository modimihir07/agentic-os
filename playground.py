"""Safe, game-inspired agent creation playground."""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import stat
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from profile_hub import (
    LOCK,
    NAME_RE,
    PROTECTED,
    _audit,
    _home,
    _inventory,
    _names,
    _require_admin,
    _root,
    _run,
    _yaml_scalar,
)

ARCHETYPES = [
    {"id": "explorer", "name": "Explorador", "icon": "🧭", "description": "Investiga, compara fuentes y descubre patrones.", "suggested_categories": ["research"]},
    {"id": "builder", "name": "Constructor", "icon": "🛠️", "description": "Crea software, sistemas y automatizaciones verificables.", "suggested_categories": ["software-development", "devops", "github"]},
    {"id": "analyst", "name": "Analista", "icon": "📊", "description": "Estructura información, calcula y evalúa decisiones.", "suggested_categories": ["productivity", "mlops"]},
    {"id": "creator", "name": "Creador", "icon": "🎨", "description": "Convierte ideas en contenido y artefactos claros.", "suggested_categories": ["creative", "media"]},
    {"id": "operator", "name": "Operador", "icon": "⚙️", "description": "Coordina tareas repetibles y mantiene procesos.", "suggested_categories": ["productivity", "autonomous-ai-agents", "email"]},
]
APPEARANCE = {
    "base": ["orb", "bot", "sprite"],
    "primary_color": ["violet", "cyan", "coral", "emerald", "gold"],
    "face": ["curious", "focused", "friendly"],
    "accessory": ["none", "visor", "antenna", "headphones", "crown"],
    "biome": ["library", "workshop", "studio", "observatory", "garden"],
}
COMMUNICATION = {
    "detail": ["concise", "balanced", "detailed"],
    "tone": ["formal", "balanced", "warm"],
    "initiative": ["reactive", "ask-first", "proactive-with-approval"],
}
DRAFT_KEYS = {
    "name", "display_name", "archetype", "appearance", "communication",
    "mission", "boundaries", "equipped_skills",
}


def _catalog_root() -> Path:
    root = Path(os.getenv(
        "AGENTIC_OS_SKILL_CATALOG",
        str(_root() / "profiles" / os.getenv("AGENTIC_OS_HERMES_PROFILE", "agentic-os") / "skills"),
    ))
    if root.is_symlink() or not root.is_dir():
        raise HTTPException(503, "Approved skill catalog is unavailable")
    return root.resolve()


def _frontmatter_value(path: Path, key: str) -> str | None:
    if path.is_symlink() or path.stat().st_size > 1_000_000:
        return None
    text = path.read_text(errors="replace")
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    for line in text[4:end].splitlines():
        label, separator, value = line.partition(":")
        if separator and label.strip() == key:
            value = value.strip().strip("\"'")
            return value[:300] or None
    return None


def _skill_catalog() -> list[dict[str, Any]]:
    root = _catalog_root()
    skills = []
    for skill_md in sorted(root.rglob("SKILL.md")):
        if skill_md.is_symlink() or any(parent.is_symlink() for parent in skill_md.parents if parent != root.parent):
            continue
        try:
            relative = skill_md.parent.resolve().relative_to(root)
        except ValueError:
            continue
        if not relative.parts or any(not re.fullmatch(r"[A-Za-z0-9._-]+", part) for part in relative.parts):
            continue
        skill_id = relative.as_posix()
        skills.append({
            "id": skill_id,
            "name": _frontmatter_value(skill_md, "name") or relative.name,
            "description": _yaml_scalar(skill_md, "description") or _frontmatter_value(skill_md, "description") or "Skill aprobada del catálogo local.",
            "category": relative.parts[0] if len(relative.parts) > 1 else "general",
            "source": "approved-local",
            "status": "available",
        })
    return skills


def _catalog_map() -> dict[str, Path]:
    root = _catalog_root()
    return {item["id"]: root / item["id"] for item in _skill_catalog()}


def _clean_text(value: Any, field: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str):
        raise HTTPException(400, f"Invalid {field}")
    text = " ".join(value.split()).strip()
    if not minimum <= len(text) <= maximum or any(ord(char) < 32 for char in text):
        raise HTTPException(400, f"Invalid {field}")
    return text


def _validate_choice_map(value: Any, allowed: dict[str, list[str]], field: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != set(allowed):
        raise HTTPException(400, f"Invalid {field}")
    result = {}
    for key, choices in allowed.items():
        selected = value.get(key)
        if selected not in choices:
            raise HTTPException(400, f"Invalid {field}.{key}")
        result[key] = selected
    return result


def _validate_draft(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict) or set(body) != DRAFT_KEYS:
        raise HTTPException(400, "Invalid agent draft")
    name = body.get("name")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name) or name in PROTECTED:
        raise HTTPException(400, "Invalid profile name")
    display_name = _clean_text(body.get("display_name"), "display name", 2, 60)
    archetype = body.get("archetype")
    if archetype not in {item["id"] for item in ARCHETYPES}:
        raise HTTPException(400, "Invalid archetype")
    appearance = _validate_choice_map(body.get("appearance"), APPEARANCE, "appearance")
    communication = _validate_choice_map(body.get("communication"), COMMUNICATION, "communication")
    mission = _clean_text(body.get("mission"), "mission", 10, 2000)
    boundaries_raw = body.get("boundaries")
    if not isinstance(boundaries_raw, list) or len(boundaries_raw) > 5:
        raise HTTPException(400, "Invalid boundaries")
    boundaries = [_clean_text(item, "boundary", 3, 300) for item in boundaries_raw]
    skills_raw = body.get("equipped_skills")
    if not isinstance(skills_raw, list) or len(skills_raw) > 3:
        raise HTTPException(400, "Select up to three unique skills")
    if any(not isinstance(item, str) for item in skills_raw):
        raise HTTPException(400, "Unknown or unavailable skill")
    if len(set(skills_raw)) != len(skills_raw):
        raise HTTPException(400, "Select up to three unique skills")
    available = _catalog_map()
    if any(item not in available for item in skills_raw):
        raise HTTPException(400, "Unknown or unavailable skill")
    return {
        "name": name, "display_name": display_name, "archetype": archetype,
        "appearance": appearance, "communication": communication,
        "mission": mission, "boundaries": boundaries,
        "equipped_skills": list(skills_raw),
    }


def _soul(draft: dict[str, Any]) -> str:
    archetype = next(item for item in ARCHETYPES if item["id"] == draft["archetype"])
    boundaries = "\n".join(f"- {item}" for item in draft["boundaries"]) or "- Pedir aprobación antes de cualquier efecto externo."
    skills = "\n".join(f"- {item}" for item in draft["equipped_skills"]) or "- Ninguna skill inicial equipada."
    communication = draft["communication"]
    return f"""# Identidad\n\nEres {draft['display_name']}, un agente white-label de arquetipo {archetype['name']}.\n\n## Misión\n\n{draft['mission']}\n\n## Límites\n\n{boundaries}\n\n## Comunicación\n\n- Nivel de detalle: {communication['detail']}\n- Tono: {communication['tone']}\n- Iniciativa: {communication['initiative']}\n- Nunca presentes intención como resultado; usa evidencia real.\n\n## Skills iniciales\n\n{skills}\n\n## Evolución\n\nAprende mediante evidencia, evaluaciones y aprobación humana. No modifiques identidad, permisos, canales ni automatizaciones sin confirmación explícita.\n"""


def _preview(draft: dict[str, Any]) -> dict[str, Any]:
    archetype = next(item for item in ARCHETYPES if item["id"] == draft["archetype"])
    return {
        "agent_card": {**draft, "archetype_name": archetype["name"], "archetype_icon": archetype["icon"]},
        "routing_description": f"{archetype['name']} white-label: {draft['mission']}"[:500],
        "soul_preview": _soul(draft),
        "writes_state": False,
    }


def _atomic_write(path: Path, content: str) -> None:
    if path.is_symlink():
        raise OSError("Unsafe target")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise OSError("Unsafe target directory")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _metadata_path(name: str) -> Path:
    return _home(name) / ".agent-playground" / "avatar.json"


def _read_metadata(name: str) -> dict[str, Any] | None:
    path = _metadata_path(name)
    home = _home(name)
    try:
        if path.parent.is_symlink() or path.resolve().parent != (home / ".agent-playground").resolve():
            return None
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 200_000:
            return None
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _room(name: str) -> dict[str, Any]:
    return {"agent": _inventory(name), "metadata": _read_metadata(name)}


_SKILL_ROOT_ALLOWLIST = {"SKILL.md", "references", "templates", "scripts", "assets"}
_SENSITIVE_FILENAMES = {"auth.json", "credentials.json", "secrets.json", "cookies.json", "id_rsa", "id_ed25519"}
_SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".sqlite", ".db"}
_SECRET_ASSIGNMENT = re.compile(
    rb"(?im)(?:^|[,{])\s*(?:export\s+)?[\"']?(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY(?:[_-]?ID)?|CREDENTIALS?)[A-Z0-9_]*"
    rb"|api[_-]?key|access[_-]?token|secret|password)[\"']?\s*[:=]\s*[\"']?"
    rb"(?!\$\{|\$[A-Z_]|\{\{|<|YOUR_|CHANGE_ME|EXAMPLE|TEST|os\.environ|process\.env|None\b|null\b)"
    rb"[^\s\"']{8,}"
)
_SECRET_LITERAL = re.compile(
    rb"(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|"
    rb"AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
)


def _sensitive_name(name: str) -> bool:
    lowered = name.casefold()
    return (
        lowered.startswith(".env")
        or lowered in _SENSITIVE_FILENAMES
        or Path(lowered).suffix in _SENSITIVE_SUFFIXES
    )


def _purge_generated_credentials(target: Path) -> None:
    """Remove any credential-bearing bootstrap artifacts made by Hermes create."""
    for entry in list(target.rglob("*")):
        if entry.is_symlink():
            raise OSError("Fresh profile contains an unsafe symlink")
        if entry.is_file() and _sensitive_name(entry.name):
            entry.unlink()
    for entry in target.rglob("*"):
        if entry.is_file() and not entry.is_symlink() and entry.stat().st_size <= 1_000_000:
            payload = entry.read_bytes()
            if b"-----BEGIN " in payload and b"PRIVATE KEY-----" in payload:
                raise OSError("Fresh profile contains private key material")
            if _SECRET_ASSIGNMENT.search(payload) or _SECRET_LITERAL.search(payload):
                raise OSError("Fresh profile contains credential-like content")


def _open_catalog_skill(skill_id: str) -> int:
    """Open a catalog directory component-by-component without following symlinks."""
    root_fd = os.open(_catalog_root(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current = root_fd
    try:
        for part in Path(skill_id).parts:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            if current != root_fd:
                os.close(current)
            current = next_fd
        if current == root_fd:
            raise OSError("Invalid skill source")
        os.close(root_fd)
        return current
    except Exception:
        if current != root_fd:
            os.close(current)
        os.close(root_fd)
        raise


def _copy_catalog_tree(source_fd: int, destination: Path | None, *, depth: int = 0, budget: dict[str, int]) -> None:
    for name in sorted(os.listdir(source_fd)):
        if name in {".", ".."} or _sensitive_name(name):
            raise OSError("Sensitive or unsafe skill file")
        info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        should_copy = destination is not None and (depth > 0 or name in _SKILL_ROOT_ALLOWLIST)
        destination_entry = destination / name if destination is not None and should_copy else None
        if stat.S_ISDIR(info.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd)
            try:
                if destination_entry is not None:
                    destination_entry.mkdir(mode=0o700)
                _copy_catalog_tree(child_fd, destination_entry, depth=depth + 1, budget=budget)
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(info.st_mode):
            raise OSError("Special files are not allowed in skills")
        source_file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_fd)
        try:
            opened = os.fstat(source_file)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise OSError("Skill source changed during copy")
            budget["files"] += 1
            if budget["files"] > 500 or opened.st_size > 5_000_000:
                raise OSError("Skill package exceeds safe limits")
            chunks = []
            total = 0
            while True:
                chunk = os.read(source_file, 65_536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                budget["bytes"] += len(chunk)
                if total > 5_000_000 or budget["bytes"] > 25_000_000:
                    raise OSError("Skill package exceeds safe limits")
            payload = b"".join(chunks)
            if b"-----BEGIN " in payload and b"PRIVATE KEY-----" in payload:
                raise OSError("Private key material is not allowed in skills")
            if _SECRET_ASSIGNMENT.search(payload) or _SECRET_LITERAL.search(payload):
                raise OSError("Credential-like content is not allowed in skills")
            if destination_entry is not None:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                mode = 0o700 if opened.st_mode & stat.S_IXUSR else 0o600
                output_fd = os.open(destination_entry, flags, mode)
                try:
                    remaining = memoryview(payload)
                    while remaining:
                        written = os.write(output_fd, remaining)
                        if written <= 0:
                            raise OSError("Incomplete skill copy")
                        remaining = remaining[written:]
                    os.fsync(output_fd)
                finally:
                    os.close(output_fd)
        finally:
            os.close(source_file)


def _safe_destination_parent(target_home: Path, skill_id: str) -> Path:
    current = target_home
    for part in ("skills", *Path(skill_id).parts[:-1]):
        current = current / part
        if current.exists():
            if current.is_symlink() or not current.is_dir():
                raise OSError("Unsafe skill destination")
        else:
            current.mkdir(mode=0o700)
    return current


def _copy_skill(skill_id: str, target_home: Path) -> None:
    if skill_id not in _catalog_map():
        raise OSError("Unknown skill")
    destination_parent = _safe_destination_parent(target_home, skill_id)
    destination = destination_parent / Path(skill_id).name
    if destination.exists() or destination.is_symlink():
        raise OSError("Skill destination already exists")
    stage = Path(tempfile.mkdtemp(prefix=".skill-stage-", dir=target_home))
    os.chmod(stage, 0o700)
    source_fd = _open_catalog_skill(skill_id)
    try:
        _copy_catalog_tree(source_fd, stage, budget={"files": 0, "bytes": 0})
        if not (stage / "SKILL.md").is_file():
            raise OSError("Skill package has no SKILL.md")
        os.replace(stage, destination)
    finally:
        os.close(source_fd)
        if stage.exists():
            shutil.rmtree(stage)


@contextmanager
def _profile_process_lock():
    """Serialize Playground profile mutations across server workers."""
    lock_path = _root() / ".agent-playground.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _rollback_profile(name: str, target: Path) -> bool:
    try:
        if target.exists() or target.is_symlink():
            _run(["profile", "delete", name, "--yes"], timeout=120)
    except Exception:
        pass
    try:
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            target.unlink()
        elif target.exists():
            shutil.rmtree(target)
    except OSError:
        return False
    return not target.exists() and not target.is_symlink()


router = APIRouter(prefix="/api/playground", dependencies=[Depends(_require_admin)])


@router.get("/catalog")
def get_catalog() -> dict[str, Any]:
    return {"archetypes": ARCHETYPES, "appearance": APPEARANCE, "communication": COMMUNICATION, "skills": _skill_catalog()}


@router.post("/preview")
def preview_agent(body: Any = Body(...)) -> dict[str, Any]:
    return _preview(_validate_draft(body))


@router.get("/agents")
def list_agents() -> list[dict[str, Any]]:
    return [_room(name) for name in _names()]


@router.get("/agents/{name}")
def get_agent(name: str) -> dict[str, Any]:
    return _room(name)


@router.post("/spawn")
def spawn_agent(body: Any = Body(...)) -> dict[str, Any]:
    draft = _validate_draft(body)
    name = draft["name"]
    with LOCK, _profile_process_lock():
        target = _home(name, must_exist=False)
        if target.exists() or target.is_symlink():
            raise HTTPException(409, "Profile already exists")
        _audit("playground_spawn", name, "started")
        created_by_us = False
        try:
            preview = _preview(draft)
            _run(["profile", "create", name, "--no-skills", "--description", preview["routing_description"]], timeout=120)
            created_by_us = True
            target = _home(name)
            _purge_generated_credentials(target)
            # New agents never inherit or auto-start messaging. Fail closed if Hermes cannot stop it.
            _run(["-p", name, "gateway", "stop"], timeout=60)
            _atomic_write(target / "SOUL.md", preview["soul_preview"])
            for skill_id in draft["equipped_skills"]:
                _copy_skill(skill_id, target)
            timestamp = datetime.now(timezone.utc).isoformat()
            metadata = {"schema_version": 1, **draft, "created_at": timestamp, "updated_at": timestamp}
            metadata_dir = target / ".agent-playground"
            metadata_dir.mkdir(mode=0o700, exist_ok=True)
            if metadata_dir.is_symlink() or not metadata_dir.is_dir():
                raise OSError("Unsafe metadata directory")
            os.chmod(metadata_dir, 0o700)
            _atomic_write(metadata_dir / "avatar.json", json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
            room = _room(name)
            if room["agent"]["health"] != "ok" or room["agent"]["gateway"] != "stopped" or room["metadata"] is None:
                raise OSError("Spawn verification failed")
            # Auditing is part of the transaction: an unaudited profile is not committed.
            _audit("playground_spawn", name, "success")
        except Exception as exc:
            if not created_by_us:
                try:
                    _audit("playground_spawn", name, "failed")
                except Exception:
                    pass
                if target.exists() or target.is_symlink():
                    raise HTTPException(409, "A concurrent profile appeared and was not modified") from exc
                if isinstance(exc, HTTPException):
                    raise
                raise HTTPException(502, "Agent spawn failed before profile ownership was established") from exc
            rolled_back = _rollback_profile(name, target)
            try:
                _audit("playground_spawn", name, "failed" if rolled_back else "rollback_failed")
            except Exception:
                pass
            if not rolled_back:
                raise HTTPException(500, "Agent spawn failed; rollback is incomplete and requires manual intervention") from exc
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(502, "Agent spawn failed and was rolled back") from exc
        return room


@router.patch("/agents/{name}/appearance")
def update_appearance(name: str, body: Any = Body(...)) -> dict[str, Any]:
    if name in PROTECTED:
        raise HTTPException(409, "Protected profile appearance cannot be changed here")
    appearance = _validate_choice_map(body, APPEARANCE, "appearance")
    with LOCK:
        metadata = _read_metadata(name)
        if metadata is None:
            raise HTTPException(404, "Playground metadata not found")
        metadata["appearance"] = appearance
        metadata["updated_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write(_metadata_path(name), json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    return _room(name)
