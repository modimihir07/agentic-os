"""Transactional Agent Studio for existing Hermes profiles."""
from __future__ import annotations

import hashlib
import hmac
import ctypes
import json
import re
import difflib
import os
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from playground import (
    _SECRET_ASSIGNMENT,
    _SECRET_LITERAL,
    _catalog_map,
    _copy_skill,
    _metadata_path,
    _read_metadata,
    _skill_catalog,
)
from capability_catalog import enrich_catalog, load_curated_catalog
from power_map import PowerMapError, composition_templates, empty_power_map, validate_power_map
from profile_lock import profile_process_lock as _profile_process_lock
from profile_backup import profile_manifest, read_regular_file, read_regular_file_snapshot, verify_profile_backup
from profile_hub import LOCK, PROTECTED, _audit, _home, _inventory, _require_admin, _root, _run, _yaml_scalar

router = APIRouter(prefix="/api/hermes/profiles", dependencies=[Depends(_require_admin)])
_SKILL_PART_RE = re.compile(r"[A-Za-z0-9._-]+")
_MAX_SOUL_BYTES = 100_000
_MAX_SKILL_MD_BYTES = 1_000_000
_MAX_METADATA_BYTES = 200_000
_CURATED_CAPABILITIES = Path(__file__).parent / "dashboard" / "data" / "skill-capabilities.json"


class _OwnershipConflict(OSError):
    pass


def _tree_signature(root: Path) -> str:
    digest = hashlib.sha256()
    for entry in sorted(root.rglob("*")):
        relative = entry.relative_to(root).as_posix()
        info = entry.lstat()
        if entry.is_symlink() or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise OSError("Unsafe entry in skill tree")
        digest.update(relative.encode("utf-8"))
        digest.update(f"\0{info.st_mode}:{info.st_size}:{info.st_mtime_ns}\0".encode("ascii"))
        if stat.S_ISREG(info.st_mode):
            payload = read_regular_file(entry, root)
            if payload is None:
                raise OSError("Skill file disappeared during signature")
            digest.update(hashlib.sha256(payload).digest())
    return digest.hexdigest()


def _tree_owner(path: Path) -> tuple[int, int, str]:
    before = path.lstat()
    if path.is_symlink() or not path.is_dir():
        raise OSError("Unsafe owned skill tree")
    signature = _tree_signature(path)
    after = path.lstat()
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise OSError("Skill tree changed identity during signature")
    return after.st_dev, after.st_ino, signature


def _file_owner_bounded(path: Path, maximum: int) -> tuple[int, int, str]:
    snapshot = read_regular_file_snapshot(path, path.parent, maximum)
    if snapshot is None:
        raise OSError("Unsafe owned file")
    info, payload = snapshot
    return info.st_dev, info.st_ino, hashlib.sha256(payload).hexdigest()


def _file_owner(path: Path) -> tuple[int, int, str]:
    return _file_owner_bounded(path, _MAX_SOUL_BYTES)


def _read_soul_state(home: Path) -> tuple[str, bool, int, tuple[int, int, str] | None]:
    path = home / "SOUL.md"
    try:
        snapshot = read_regular_file_snapshot(path, home, _MAX_SOUL_BYTES)
    except OSError as exc:
        raise HTTPException(409, "SOUL.md is unsafe or too large") from exc
    if snapshot is None:
        return "", False, 0, None
    info, payload = snapshot
    owner = (info.st_dev, info.st_ino, hashlib.sha256(payload).hexdigest())
    return payload.decode("utf-8", errors="replace"), True, stat.S_IMODE(info.st_mode), owner


def _read_soul(home: Path) -> str:
    return _read_soul_state(home)[0]


def _frontmatter_from_payload(payload: bytes, key: str) -> str | None:
    text = payload.decode("utf-8", errors="replace")
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    match = re.search(rf"(?m)^{re.escape(key)}:\s*[\"']?([^\n\"']+)", text[4:end])
    return match.group(1).strip() if match else None


def _installed_skills(home: Path) -> dict[str, dict[str, Any]]:
    root = home / "skills"
    if not root.exists():
        return {}
    if root.is_symlink() or not root.is_dir():
        raise HTTPException(409, "Skills directory is unsafe")
    result: dict[str, dict[str, Any]] = {}
    for skill_md in sorted(root.rglob("SKILL.md")):
        try:
            payload = read_regular_file(skill_md, root, _MAX_SKILL_MD_BYTES)
        except OSError:
            continue
        if payload is None:
            continue
        try:
            relative = skill_md.parent.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        if not relative.parts or any(not _SKILL_PART_RE.fullmatch(part) for part in relative.parts):
            continue
        skill_id = relative.as_posix()
        result[skill_id] = {
            "id": skill_id,
            "name": _frontmatter_from_payload(payload, "name") or relative.name,
            "description": _frontmatter_from_payload(payload, "description") or "Installed Hermes skill.",
            "category": relative.parts[0] if len(relative.parts) > 1 else "general",
            "status": "installed",
            "size": len(payload),
            "path": skill_md,
        }
    return result


def _revision(
    home: Path,
    soul_state: tuple[str, bool, int, tuple[int, int, str] | None],
    skills: dict[str, dict[str, Any]],
) -> str:
    digest = hashlib.sha256()
    soul, soul_exists, soul_mode, _ = soul_state
    digest.update(b"\1" if soul_exists else b"\0")
    if soul_exists:
        digest.update(str(soul_mode).encode("ascii"))
    digest.update(soul.encode("utf-8"))
    for skill_id, item in sorted(skills.items()):
        digest.update(b"\0skill\0")
        digest.update(skill_id.encode("utf-8"))
        skill_root = item["path"].parent
        digest.update(_tree_signature(skill_root).encode("ascii"))
    metadata = _read_metadata(_inventory_name(home))
    if metadata is not None:
        digest.update(json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def _inventory_name(home: Path) -> str:
    return "default" if home == _home("default") else home.name


def _public_skill(item: dict[str, Any], *, studio_mutable: bool = True) -> dict[str, Any]:
    return {**{key: value for key, value in item.items() if key != "path"}, "studio_mutable": studio_mutable}


def _capability_payload(name: str) -> dict[str, Any]:
    home = _home(name)
    installed = _installed_skills(home)
    technical: dict[str, dict[str, Any]] = {
        item["id"]: {**item, "status": "available"}
        for item in _skill_catalog()
    }
    for skill_id, item in installed.items():
        technical[skill_id] = _public_skill(
            {**item, "status": "installed"},
            studio_mutable=not any(
                other_id != skill_id and _skill_ids_overlap(skill_id, other_id)
                for other_id in installed
            ),
        )
    curated = load_curated_catalog(_CURATED_CAPABILITIES)
    capabilities = enrich_catalog(list(technical.values()), curated)
    capabilities.sort(key=lambda item: (item["intent_category"], item["name"].casefold(), item["id"]))
    return {
        "capabilities": capabilities,
        "templates": composition_templates(),
        "intent_categories": ["Descubrir", "Pensar", "Crear", "Comunicar", "Organizar", "Proteger"],
        "executable": False,
        "execution_reason": "Catálogo de superpoderes: una skill procedural no es una función automática.",
    }


def _capability_map(name: str) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in _capability_payload(name)["capabilities"]}


def _skill_ids_overlap(left: str, right: str) -> bool:
    left_parts = Path(left).parts
    right_parts = Path(right).parts
    shortest = min(len(left_parts), len(right_parts))
    return left_parts[:shortest] == right_parts[:shortest]


def _preview_token(name: str, evolution: dict[str, Any]) -> str:
    secret = os.getenv("AGENTIC_OS_ADMIN_TOKEN", "")
    if len(secret) < 16:
        raise HTTPException(503, "Studio preview signing is unavailable")
    payload = {
        "profile": name,
        "expected_revision": evolution["expected_revision"],
        "soul": evolution["soul"],
        "add_skills": evolution["add_skills"],
        "remove_skills": evolution["remove_skills"],
        "loadout": evolution["loadout"],
        "power_map": evolution["power_map"],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).hexdigest()


def _evolution(body: Any, home: Path, *, require_confirm: bool = False, require_preview: bool = False) -> dict[str, Any]:
    required = {"expected_revision", "soul", "add_skills", "remove_skills"}
    allowed = required | {"loadout", "power_map"}
    if require_confirm:
        allowed.add("confirm")
    if require_preview:
        allowed.add("preview_token")
    if not isinstance(body, dict) or not required.issubset(body) or not set(body).issubset(allowed):
        raise HTTPException(400, "Invalid Studio evolution")
    if require_confirm and body.get("confirm") != _inventory_name(home):
        raise HTTPException(400, "Exact profile confirmation required")
    if require_preview and not isinstance(body.get("preview_token"), str):
        raise HTTPException(400, "Valid Studio preview required")
    expected = body.get("expected_revision")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise HTTPException(400, "Invalid expected revision")
    soul = body.get("soul")
    if not isinstance(soul, str) or len(soul.encode("utf-8")) > _MAX_SOUL_BYTES or "\x00" in soul:
        raise HTTPException(400, "Invalid SOUL content")
    changes: dict[str, list[str]] = {}
    for field in ("add_skills", "remove_skills"):
        value = body.get(field)
        if (
            not isinstance(value, list) or len(value) > 20
            or any(not isinstance(item, str) for item in value)
            or len(set(value)) != len(value)
        ):
            raise HTTPException(400, f"Invalid {field}")
        changes[field] = list(value)
    if set(changes["add_skills"]) & set(changes["remove_skills"]):
        raise HTTPException(400, "A skill cannot be added and removed together")
    changed = changes["add_skills"] + changes["remove_skills"]
    if any(_skill_ids_overlap(left, right) for index, left in enumerate(changed) for right in changed[index + 1:]):
        raise HTTPException(400, "Overlapping skill namespaces are not allowed")
    installed = _installed_skills(home)
    catalog = _catalog_map()
    if any(item not in catalog or item in installed for item in changes["add_skills"]):
        raise HTTPException(400, "Unknown or already installed skill")
    if any(item not in installed for item in changes["remove_skills"]):
        raise HTTPException(400, "Unknown installed skill")
    if any(
        _skill_ids_overlap(candidate, present)
        for candidate in changes["add_skills"] for present in installed
    ):
        raise HTTPException(400, "Skill namespace overlaps an installed skill")
    for candidate in changes["remove_skills"]:
        if any(other != candidate and _skill_ids_overlap(candidate, other) for other in installed):
            raise HTTPException(400, f"Nested skill namespace cannot be removed safely in Studio: {candidate}")

    name = _inventory_name(home)
    capabilities = _capability_map(name)
    metadata = _read_metadata(name) or {}
    default_loadout = metadata.get("loadout", metadata.get("equipped_skills", []))
    if not isinstance(default_loadout, list):
        default_loadout = []
    default_loadout = [item for item in default_loadout if isinstance(item, str) and item in capabilities][:5]
    loadout = body.get("loadout", default_loadout)
    power_map = body.get("power_map", metadata.get("power_map", empty_power_map()))
    if isinstance(loadout, list) and set(loadout) & set(changes["remove_skills"]):
        raise HTTPException(400, "A removed skill cannot remain in the loadout")
    try:
        validated = validate_power_map(power_map, capabilities, loadout)
    except PowerMapError as exc:
        raise HTTPException(400, str(exc)) from exc
    mapped = {node["capability_id"] for node in validated["map"]["nodes"]}
    effective_skills = (set(installed) - set(changes["remove_skills"])) | set(changes["add_skills"])
    if not set(validated["loadout"]).issubset(effective_skills):
        raise HTTPException(400, "Loadout capabilities must be installed or included in add_skills")
    if not mapped.issubset(set(validated["loadout"])):
        raise HTTPException(400, "Every Power Map block must also be equipped in the loadout")
    if mapped & set(changes["remove_skills"]):
        raise HTTPException(400, "A removed skill cannot remain in the Power Map")
    result = {
        "expected_revision": expected, "soul": soul, **changes,
        "loadout": validated["loadout"], "power_map": validated["map"],
        "power_validation": validated,
    }
    if require_preview:
        result["preview_token"] = body["preview_token"]
    return result


def _soul_diff(before: str, after: str) -> str:
    return "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile="SOUL.md (actual)", tofile="SOUL.md (propuesto)",
    ))


def _backup_dir() -> Path:
    path = Path(os.getenv("AGENTIC_OS_HERMES_BACKUP_DIR", "/var/lib/agentic-os/backups"))
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise OSError("Unsafe backup directory")
    return path


def _verify_backup(path: Path, expected_profile: str, expected_manifest: dict[str, str]) -> None:
    verify_profile_backup(path, expected_profile, expected_manifest)


def _backup(name: str, expected_manifest: dict[str, str]) -> str:
    backup_dir = _backup_dir()
    filename = f"{name}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')}.tar.gz"
    destination = backup_dir / filename
    _run(["profile", "export", name, "--output", str(destination)], timeout=120)
    try:
        _verify_backup(destination, name, expected_manifest)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    os.chmod(destination, 0o600)
    return filename


def _skill_destination(home: Path, skill_id: str) -> Path:
    parts = Path(skill_id).parts
    if (
        not parts or any(part in {".", ".."} or not _SKILL_PART_RE.fullmatch(part) for part in parts)
    ):
        raise OSError("Unsafe skill identifier")
    root = home / "skills"
    if root.is_symlink():
        raise OSError("Unsafe skills root")
    destination = root.joinpath(*parts)
    try:
        destination.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError as exc:
        raise OSError("Unsafe skill destination") from exc
    return destination


def _open_skill_parent_fd(home: Path, skill_id: str) -> tuple[int, str]:
    parts = Path(skill_id).parts
    _skill_destination(home, skill_id)
    fd = os.open(home / "skills", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, parts[-1]
    except Exception:
        os.close(fd)
        raise


def _move_skill_to_snapshot(home: Path, skill_id: str, snapshot_root: Path, snapshot_name: str) -> Path:
    parent_fd, leaf = _open_skill_parent_fd(home, skill_id)
    snapshot_fd = os.open(snapshot_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise OSError("Unsafe skill source")
        os.rename(leaf, snapshot_name, src_dir_fd=parent_fd, dst_dir_fd=snapshot_fd)
    finally:
        os.close(snapshot_fd)
        os.close(parent_fd)
    return snapshot_root / snapshot_name


def _rename_noreplace(source_fd: int, source: str, destination_fd: int, destination: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise OSError("Atomic no-replace rename is unavailable")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(source_fd, os.fsencode(source), destination_fd, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), destination)


def _restore_skill_snapshot(home: Path, skill_id: str, snapshot: Path) -> None:
    parent_fd, leaf = _open_skill_parent_fd(home, skill_id)
    snapshot_fd = os.open(snapshot.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("Concurrent skill destination exists")
        _rename_noreplace(snapshot_fd, snapshot.name, parent_fd, leaf)
    finally:
        os.close(snapshot_fd)
        os.close(parent_fd)


def _move_soul_to_snapshot(home: Path, snapshot_root: Path, snapshot_name: str) -> Path | None:
    home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    snapshot_fd = os.open(snapshot_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.rename("SOUL.md", snapshot_name, src_dir_fd=home_fd, dst_dir_fd=snapshot_fd)
        except FileNotFoundError:
            return None
    finally:
        os.close(snapshot_fd)
        os.close(home_fd)
    return snapshot_root / snapshot_name


def _restore_soul_snapshot(home: Path, snapshot: Path) -> None:
    home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    snapshot_fd = os.open(snapshot.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _rename_noreplace(snapshot_fd, snapshot.name, home_fd, "SOUL.md")
    finally:
        os.close(snapshot_fd)
        os.close(home_fd)


def _write_private_snapshot(path: Path, content: str, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        payload = content.encode("utf-8")
        written = 0
        while written < len(payload):
            written += os.write(fd, payload[written:])
        os.fsync(fd)
    finally:
        os.close(fd)


def _install_soul_transaction(
    home: Path,
    snapshot_root: Path,
    content: str,
    existed_before: bool,
    owner_before: tuple[int, int, str] | None,
) -> tuple[tuple[int, int, str], Path | None]:
    original = _move_soul_to_snapshot(home, snapshot_root, "soul-before")
    if existed_before:
        if original is None or owner_before is None or _file_owner(original) != owner_before:
            if original is not None:
                try:
                    _restore_soul_snapshot(home, original)
                except OSError as exc:
                    raise _OwnershipConflict("Concurrent SOUL could not be restored") from exc
            raise OSError("SOUL changed immediately before mutation")
    elif original is not None:
        try:
            _restore_soul_snapshot(home, original)
        except OSError as exc:
            raise _OwnershipConflict("Concurrent SOUL could not be restored") from exc
        raise OSError("SOUL appeared immediately before mutation")
    proposed = snapshot_root / "soul-proposed"
    try:
        _write_private_snapshot(proposed, content, 0o600)
        proposed_owner = _file_owner(proposed)
        _restore_soul_snapshot(home, proposed)
    except Exception as exc:
        proposed.unlink(missing_ok=True)
        restored_original = False
        if original is not None and not (home / "SOUL.md").exists():
            try:
                _restore_soul_snapshot(home, original)
                restored_original = True
            except Exception as restore_exc:
                raise _OwnershipConflict("Original SOUL snapshot could not be restored") from restore_exc
        if restored_original:
            raise
        if (home / "SOUL.md").exists() or original is not None and original.exists():
            raise _OwnershipConflict("Concurrent SOUL publication was preserved") from exc
        raise
    return proposed_owner, original


def _restore_soul_transaction(
    home: Path,
    snapshot_root: Path,
    original_existed: bool,
    original_snapshot: Path | None,
    owner: tuple[int, int, str],
) -> None:
    quarantine = _move_soul_to_snapshot(home, snapshot_root, "soul-current")
    if quarantine is not None and _file_owner(quarantine) != owner:
        try:
            _restore_soul_snapshot(home, quarantine)
        finally:
            raise OSError("Concurrent SOUL replacement was preserved")
    if original_existed:
        if original_snapshot is None or not original_snapshot.exists():
            raise OSError("Original SOUL snapshot is unavailable")
        try:
            _restore_soul_snapshot(home, original_snapshot)
        except Exception:
            if quarantine is not None and quarantine.exists():
                try:
                    _restore_soul_snapshot(home, quarantine)
                except Exception:
                    pass
            raise
    # Never unlink rollback quarantine: a non-cooperating writer may still hold
    # the inode open and mutate it after our final ownership check.


def _metadata_state(home: Path) -> tuple[dict[str, Any], bool, int, tuple[int, int, str] | None]:
    parent = home / ".agent-playground"
    path = parent / "avatar.json"
    if parent.exists():
        if parent.is_symlink() or not parent.is_dir():
            raise HTTPException(409, "Agent Studio metadata directory is unsafe")
    else:
        return {}, False, 0, None
    try:
        snapshot = read_regular_file_snapshot(path, parent, _MAX_METADATA_BYTES)
    except OSError as exc:
        raise HTTPException(409, "Agent Studio metadata is unsafe or too large") from exc
    if snapshot is None:
        return {}, False, 0, None
    info, payload = snapshot
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(409, "Agent Studio metadata is invalid") from exc
    if not isinstance(value, dict):
        raise HTTPException(409, "Agent Studio metadata is invalid")
    owner = (info.st_dev, info.st_ino, hashlib.sha256(payload).hexdigest())
    return value, True, stat.S_IMODE(info.st_mode), owner


def _evolved_metadata(before: dict[str, Any], evolution: dict[str, Any]) -> dict[str, Any]:
    result = dict(before)
    result.update({
        "schema_version": 2,
        "loadout": evolution["loadout"],
        "power_map": evolution["power_map"],
    })
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > _MAX_METADATA_BYTES:
        raise HTTPException(400, "Agent Studio metadata is too large")
    return result


def _metadata_parent(home: Path, *, create: bool) -> tuple[Path, bool]:
    parent = home / ".agent-playground"
    created = False
    if parent.exists() or parent.is_symlink():
        if parent.is_symlink() or not parent.is_dir():
            raise OSError("Unsafe Agent Studio metadata directory")
    elif create:
        parent.mkdir(mode=0o700)
        created = True
    return parent, created


def _move_metadata_to_snapshot(home: Path, snapshot_root: Path, snapshot_name: str) -> Path | None:
    parent, _ = _metadata_parent(home, create=False)
    if not parent.exists():
        return None
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    snapshot_fd = os.open(snapshot_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.rename("avatar.json", snapshot_name, src_dir_fd=parent_fd, dst_dir_fd=snapshot_fd)
        except FileNotFoundError:
            return None
    finally:
        os.close(snapshot_fd)
        os.close(parent_fd)
    return snapshot_root / snapshot_name


def _restore_metadata_snapshot(home: Path, snapshot: Path) -> None:
    parent, _ = _metadata_parent(home, create=True)
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    snapshot_fd = os.open(snapshot.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _rename_noreplace(snapshot_fd, snapshot.name, parent_fd, "avatar.json")
    finally:
        os.close(snapshot_fd)
        os.close(parent_fd)


def _install_metadata_transaction(
    home: Path,
    snapshot_root: Path,
    value: dict[str, Any],
    existed_before: bool,
    mode_before: int,
    owner_before: tuple[int, int, str] | None,
) -> tuple[tuple[int, int, str], Path | None, bool]:
    _, created_parent = _metadata_parent(home, create=True)
    original = _move_metadata_to_snapshot(home, snapshot_root, "metadata-before")
    if existed_before:
        if original is None or owner_before is None or _file_owner_bounded(original, _MAX_METADATA_BYTES) != owner_before:
            if original is not None:
                try:
                    _restore_metadata_snapshot(home, original)
                except OSError as exc:
                    raise _OwnershipConflict("Concurrent Agent Studio metadata could not be restored") from exc
            raise OSError("Agent Studio metadata changed immediately before mutation")
    elif original is not None:
        try:
            _restore_metadata_snapshot(home, original)
        except OSError as exc:
            raise _OwnershipConflict("Concurrent Agent Studio metadata could not be restored") from exc
        raise OSError("Agent Studio metadata appeared immediately before mutation")
    proposed = snapshot_root / "metadata-proposed"
    content = json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    try:
        _write_private_snapshot(proposed, content, mode_before or 0o600)
        owner = _file_owner_bounded(proposed, _MAX_METADATA_BYTES)
        _restore_metadata_snapshot(home, proposed)
    except Exception as exc:
        proposed.unlink(missing_ok=True)
        restored_original = False
        if original is not None and not _metadata_path(_inventory_name(home)).exists():
            try:
                _restore_metadata_snapshot(home, original)
                restored_original = True
            except Exception as restore_exc:
                raise _OwnershipConflict("Original Agent Studio metadata could not be restored") from restore_exc
        if restored_original:
            raise
        if _metadata_path(_inventory_name(home)).exists() or original is not None and original.exists():
            raise _OwnershipConflict("Concurrent Agent Studio metadata publication was preserved") from exc
        raise
    return owner, original, created_parent


def _restore_metadata_transaction(
    home: Path,
    snapshot_root: Path,
    original_existed: bool,
    original_snapshot: Path | None,
    owner: tuple[int, int, str],
    created_parent: bool,
) -> None:
    quarantine = _move_metadata_to_snapshot(home, snapshot_root, "metadata-current")
    if quarantine is not None and _file_owner_bounded(quarantine, _MAX_METADATA_BYTES) != owner:
        try:
            _restore_metadata_snapshot(home, quarantine)
        finally:
            raise OSError("Concurrent Agent Studio metadata replacement was preserved")
    if original_existed:
        if original_snapshot is None or not original_snapshot.exists():
            raise OSError("Original Agent Studio metadata snapshot is unavailable")
        _restore_metadata_snapshot(home, original_snapshot)
    elif created_parent:
        parent = home / ".agent-playground"
        try:
            parent.rmdir()
        except OSError:
            pass


def _restore_transaction(
    home: Path,
    soul_existed_before: bool,
    soul_owner: tuple[int, int, str] | None,
    soul_original_snapshot: Path | None,
    added: dict[str, tuple[int, int, str]],
    removed_snapshots: dict[str, Path],
    snapshot_root: Path,
    metadata_existed_before: bool,
    metadata_owner: tuple[int, int, str] | None,
    metadata_original_snapshot: Path | None,
    metadata_parent_created: bool,
) -> None:
    conflicts: list[str] = []
    for index, (skill_id, owner) in enumerate(reversed(list(added.items()))):
        destination = _skill_destination(home, skill_id)
        if not destination.exists() and not destination.is_symlink():
            continue
        try:
            quarantine = _move_skill_to_snapshot(home, skill_id, snapshot_root, f"added-rollback-{index}")
            if _tree_owner(quarantine) != owner:
                try:
                    _restore_skill_snapshot(home, skill_id, quarantine)
                finally:
                    conflicts.append(f"added:{skill_id}")
                continue
            # Keep transaction-owned quarantine for the same open-descriptor
            # race as SOUL.md; deleting it could destroy a late external write.
        except OSError:
            conflicts.append(f"added:{skill_id}")
    for skill_id, snapshot in removed_snapshots.items():
        if not snapshot.exists():
            continue
        try:
            _restore_skill_snapshot(home, skill_id, snapshot)
        except OSError:
            conflicts.append(f"removed:{skill_id}")
    if soul_owner is not None:
        try:
            _restore_soul_transaction(
                home, snapshot_root, soul_existed_before,
                soul_original_snapshot, soul_owner,
            )
        except OSError:
            conflicts.append("soul")
    if metadata_owner is not None:
        try:
            _restore_metadata_transaction(
                home, snapshot_root, metadata_existed_before,
                metadata_original_snapshot, metadata_owner, metadata_parent_created,
            )
        except OSError:
            conflicts.append("metadata")
    if conflicts:
        raise OSError("Concurrent changes prevented complete rollback")


def _apply(name: str, evolution: dict[str, Any]) -> dict[str, Any]:
    home = _home(name)
    soul_state_before = _read_soul_state(home)
    soul_before, soul_existed_before, _, soul_owner_before = soul_state_before
    metadata_before, metadata_existed_before, metadata_mode_before, metadata_owner_before = _metadata_state(home)
    metadata_after = _evolved_metadata(metadata_before, evolution)
    installed_before = _installed_skills(home)
    skills_before = set(installed_before)
    untouched_owners = {
        skill_id: _tree_owner(item["path"].parent)
        for skill_id, item in installed_before.items()
        if skill_id not in evolution["remove_skills"]
    }
    removed_owners = {
        skill_id: _tree_owner(installed_before[skill_id]["path"].parent)
        for skill_id in evolution["remove_skills"]
    }
    managed_manifest_before = profile_manifest(home, managed_only=True)
    snapshot_root: Path | None = None
    added: dict[str, tuple[int, int, str]] = {}
    removed_snapshots: dict[str, Path] = {}
    soul_owner: tuple[int, int, str] | None = None
    soul_original_snapshot: Path | None = None
    metadata_owner: tuple[int, int, str] | None = None
    metadata_original_snapshot: Path | None = None
    metadata_parent_created = False
    mutation_started = False
    ownership_conflict = False
    preserve_snapshot = False
    try:
        _backup(name, managed_manifest_before)
        if (
            profile_manifest(home, managed_only=True) != managed_manifest_before
            or _studio_payload(name)["revision"] != evolution["expected_revision"]
        ):
            raise HTTPException(409, "Profile changed during backup; reload Studio before continuing")
        snapshot_root = Path(tempfile.mkdtemp(prefix=".agent-studio-txn-", dir=home))
        os.chmod(snapshot_root, 0o700)
        _audit("studio_apply", name, "started")
        for index, skill_id in enumerate(evolution["remove_skills"]):
            snapshot = snapshot_root / f"removed-{index}"
            removed_snapshots[skill_id] = snapshot
            mutation_started = True
            _move_skill_to_snapshot(home, skill_id, snapshot_root, snapshot.name)
            if _tree_owner(snapshot) != removed_owners[skill_id]:
                try:
                    _restore_skill_snapshot(home, skill_id, snapshot)
                except OSError:
                    ownership_conflict = True
                raise OSError("Skill changed immediately before removal")
        for skill_id in evolution["add_skills"]:
            destination = _skill_destination(home, skill_id)
            if destination.exists() or destination.is_symlink():
                raise OSError("Skill destination already exists")
            try:
                _copy_skill(skill_id, home)
                owner = _tree_owner(destination)
            except Exception:
                if destination.exists() or destination.is_symlink():
                    ownership_conflict = True
                raise
            added[skill_id] = owner
            mutation_started = True
        if evolution["soul"] != soul_before:
            mutation_started = True
            try:
                soul_owner, soul_original_snapshot = _install_soul_transaction(
                    home, snapshot_root, evolution["soul"],
                    soul_existed_before, soul_owner_before,
                )
            except Exception as exc:
                if isinstance(exc, _OwnershipConflict):
                    ownership_conflict = True
                raise
        if metadata_after != metadata_before:
            mutation_started = True
            try:
                metadata_owner, metadata_original_snapshot, metadata_parent_created = _install_metadata_transaction(
                    home, snapshot_root, metadata_after, metadata_existed_before,
                    metadata_mode_before, metadata_owner_before,
                )
            except Exception as exc:
                if isinstance(exc, _OwnershipConflict):
                    ownership_conflict = True
                raise
        installed_after = _installed_skills(home)
        for skill_id, owner in {**untouched_owners, **added}.items():
            item = installed_after.get(skill_id)
            if item is None or _tree_owner(item["path"].parent) != owner:
                raise OSError("Concurrent skill modification detected")
        result = _studio_payload(name)
        expected_skills = (skills_before - set(evolution["remove_skills"])) | set(evolution["add_skills"])
        if (
            result["soul"] != evolution["soul"]
            or {item["id"] for item in result["skills"]} != expected_skills
            or result["metadata"] != metadata_after
        ):
            raise OSError("Studio verification failed")
        _audit("studio_apply", name, "success")
        return {**result, "backup": "created"}
    except Exception as exc:
        if isinstance(exc, HTTPException) and not mutation_started:
            raise
        rollback_error: Exception | None = None
        if mutation_started:
            try:
                if snapshot_root is None:
                    raise OSError("Studio transaction snapshot is unavailable")
                _restore_transaction(
                    home, soul_existed_before,
                    soul_owner, soul_original_snapshot, added, removed_snapshots, snapshot_root,
                    metadata_existed_before, metadata_owner, metadata_original_snapshot,
                    metadata_parent_created,
                )
            except Exception as restore_exc:
                rollback_error = restore_exc
        if ownership_conflict and rollback_error is None:
            rollback_error = OSError("Unowned concurrent destination was preserved")
        preserve_snapshot = bool(
            snapshot_root is not None and snapshot_root.exists()
            and any(snapshot_root.iterdir())
        )
        try:
            _audit("studio_apply", name, "rollback_failed" if rollback_error else "failed")
        except Exception:
            pass
        if rollback_error:
            raise HTTPException(500, "Studio rollback incomplete; manual intervention required") from exc
        raise HTTPException(502, "Studio evolution failed and was rolled back") from exc
    finally:
        if snapshot_root is not None and not preserve_snapshot:
            shutil.rmtree(snapshot_root, ignore_errors=True)


def _studio_payload(name: str) -> dict[str, Any]:
    home = _home(name)
    soul_state = _read_soul_state(home)
    soul = soul_state[0]
    skills = _installed_skills(home)
    return {
        "profile": _inventory(name),
        "soul": soul,
        "skills": [
            _public_skill(
                item,
                studio_mutable=not any(
                    other_id != skill_id and _skill_ids_overlap(skill_id, other_id)
                    for other_id in skills
                ),
            )
            for skill_id, item in skills.items()
        ],
        "metadata": _read_metadata(name),
        "revision": _revision(home, soul_state, skills),
        "read_only": bool(_inventory(name)["protected"]),
    }


@router.get("/{name}/studio")
def get_studio(name: str) -> dict[str, Any]:
    return _studio_payload(name)


@router.get("/{name}/studio/capabilities")
def get_studio_capabilities(name: str) -> dict[str, Any]:
    _home(name)
    return _capability_payload(name)


@router.post("/{name}/studio/evolution/validate")
def validate_studio_evolution(name: str, body: Any = Body(...)) -> dict[str, Any]:
    _home(name)
    if not isinstance(body, dict) or set(body) != {"loadout", "power_map"}:
        raise HTTPException(400, "Invalid evolution blueprint")
    try:
        result = validate_power_map(body["power_map"], _capability_map(name), body["loadout"])
    except PowerMapError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, "writes_state": False}


@router.post("/{name}/studio/preview")
def preview_studio(name: str, body: Any = Body(...)) -> dict[str, Any]:
    home = _home(name)
    before = _studio_payload(name)
    if not isinstance(body, dict) or body.get("expected_revision") != before["revision"]:
        raise HTTPException(409, "Profile changed; reload Studio before continuing")
    evolution = _evolution(body, home)
    return {
        "profile": name,
        "expected_revision": before["revision"],
        "soul_diff": _soul_diff(before["soul"], evolution["soul"]),
        "add_skills": evolution["add_skills"],
        "remove_skills": evolution["remove_skills"],
        "loadout_before": (before.get("metadata") or {}).get("loadout", []),
        "loadout": evolution["loadout"],
        "power_map_before": (before.get("metadata") or {}).get("power_map", empty_power_map()),
        "power_map": evolution["power_map"],
        "readiness_percent": evolution["power_validation"]["readiness_percent"],
        "warnings": evolution["power_validation"]["warnings"],
        "preview_token": _preview_token(name, evolution),
        "writes_state": False,
    }


@router.post("/{name}/studio/apply")
def apply_studio(name: str, body: Any = Body(...)) -> dict[str, Any]:
    if name in PROTECTED:
        raise HTTPException(409, "Protected profiles are read-only in Agent Studio")
    with LOCK, _profile_process_lock():
        home = _home(name)
        before = _studio_payload(name)
        if not isinstance(body, dict) or body.get("expected_revision") != before["revision"]:
            raise HTTPException(409, "Profile changed; reload Studio before continuing")
        evolution = _evolution(body, home, require_confirm=True, require_preview=True)
        if not hmac.compare_digest(evolution["preview_token"], _preview_token(name, evolution)):
            raise HTTPException(400, "Valid Studio preview required")
        return _apply(name, evolution)


@router.get("/{name}/studio/skills/{skill_id:path}")
def get_studio_skill(name: str, skill_id: str) -> dict[str, Any]:
    home = _home(name)
    skills = _installed_skills(home)
    item = skills.get(skill_id)
    if item is None:
        raise HTTPException(404, "Installed skill not found")
    try:
        payload = read_regular_file(item["path"], home / "skills", _MAX_SKILL_MD_BYTES)
    except OSError as exc:
        raise HTTPException(409, "Skill content changed or became unsafe") from exc
    if payload is None:
        raise HTTPException(409, "Skill content changed or disappeared")
    if _SECRET_ASSIGNMENT.search(payload) or _SECRET_LITERAL.search(payload):
        raise HTTPException(409, "Skill content contains credential-like material")
    mutable = not any(
        other_id != skill_id and _skill_ids_overlap(skill_id, other_id)
        for other_id in skills
    )
    return {**_public_skill(item, studio_mutable=mutable), "content": payload.decode("utf-8", errors="replace")}
