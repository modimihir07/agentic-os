"""Manifest and archive verification for destructive Hermes profile operations."""
from __future__ import annotations

import hashlib
import os
import stat
import tarfile
from pathlib import Path

_MAX_FILE_BYTES = 100_000_000
_MAX_TOTAL_BYTES = 1_000_000_000


def read_regular_file_snapshot(
    path: Path, root: Path, maximum: int = _MAX_FILE_BYTES,
) -> tuple[os.stat_result, bytes] | None:
    """Read one file and metadata through the same O_NOFOLLOW descriptor."""
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise OSError("File escapes profile root") from exc
    if not relative.parts:
        raise OSError("Expected a file below profile root")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in relative.parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        try:
            file_fd = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
                raise OSError("Unsafe or oversized regular file")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(file_fd, min(1_048_576, maximum + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > maximum:
                    raise OSError("Regular file exceeds size limit")
            return info, b"".join(chunks)
        finally:
            os.close(file_fd)
    finally:
        os.close(fd)


def read_regular_file(path: Path, root: Path, maximum: int = _MAX_FILE_BYTES) -> bytes | None:
    snapshot = read_regular_file_snapshot(path, root, maximum)
    return None if snapshot is None else snapshot[1]


def profile_manifest(home: Path, *, managed_only: bool) -> dict[str, str]:
    """Record types, modes and hashes for every entry whose loss must be covered."""
    if home.is_symlink() or not home.is_dir():
        raise OSError("Unsafe profile home")
    candidates: list[Path] = [home / "profile.yaml"]
    if managed_only:
        if (home / "SOUL.md").exists() or (home / "SOUL.md").is_symlink():
            candidates.append(home / "SOUL.md")
        skills = home / "skills"
        if skills.exists() or skills.is_symlink():
            if skills.is_symlink() or not skills.is_dir():
                raise OSError("Unsafe skills tree")
            candidates.append(skills)
            for path in skills.rglob("*"):
                if path.is_symlink():
                    raise OSError("Profile manifest contains a symlink")
                candidates.append(path)
        visual = home / ".agent-playground"
        if visual.exists() or visual.is_symlink():
            if visual.is_symlink() or not visual.is_dir():
                raise OSError("Unsafe Agent Studio metadata tree")
            candidates.append(visual)
            for path in visual.rglob("*"):
                if path.is_symlink():
                    raise OSError("Agent Studio metadata contains a symlink")
                candidates.append(path)
    else:
        for path in home.rglob("*"):
            if path.is_symlink():
                raise OSError("Profile manifest contains a symlink")
            if path != home / "profile.yaml":
                candidates.append(path)

    manifest: dict[str, str] = {}
    total = 0
    for path in sorted(set(candidates)):
        info = path.lstat()
        relative = path.relative_to(home).as_posix()
        if stat.S_ISDIR(info.st_mode):
            manifest[relative] = f"d:{stat.S_IMODE(info.st_mode):o}"
            continue
        snapshot = read_regular_file_snapshot(path, home)
        if snapshot is None:
            raise OSError(f"Required profile file disappeared: {path.name}")
        file_info, payload = snapshot
        total += len(payload)
        if total > _MAX_TOTAL_BYTES:
            raise OSError("Profile manifest is too large")
        manifest[relative] = f"f:{stat.S_IMODE(file_info.st_mode):o}:{hashlib.sha256(payload).hexdigest()}"
    if "profile.yaml" not in manifest:
        raise OSError("Profile manifest lacks profile.yaml")
    return manifest


def verify_profile_backup(path: Path, expected_profile: str, expected_manifest: dict[str, str]) -> None:
    """Validate archive safety and prove all expected file contents are present."""
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > 500_000_000:
        raise OSError("Hermes backup was not created safely")
    archive_manifest: dict[str, str] = {}
    total = 0
    try:
        with tarfile.open(path, "r:*") as archive:
            members = archive.getmembers()
            if not members:
                raise OSError("Hermes backup archive is empty")
            for member in members:
                parts = Path(member.name).parts
                if (
                    not parts or parts[0] != expected_profile or Path(member.name).is_absolute()
                    or ".." in parts or not (member.isfile() or member.isdir())
                ):
                    raise OSError("Hermes backup archive contains unsafe members")
                relative = Path(*parts[1:]).as_posix()
                if relative == ".":
                    continue
                if relative in archive_manifest:
                    raise OSError("Hermes backup contains duplicate members")
                if member.isdir():
                    archive_manifest[relative] = f"d:{member.mode:o}"
                    continue
                total += member.size
                if total > _MAX_TOTAL_BYTES or member.size > _MAX_FILE_BYTES:
                    raise OSError("Hermes backup archive is too large")
                handle = archive.extractfile(member)
                if handle is None:
                    raise OSError("Hermes backup member cannot be read")
                payload = handle.read(_MAX_FILE_BYTES + 1)
                if len(payload) != member.size or len(payload) > _MAX_FILE_BYTES:
                    raise OSError("Hermes backup member size is invalid")
                archive_manifest[relative] = f"f:{member.mode:o}:{hashlib.sha256(payload).hexdigest()}"
    except (tarfile.TarError, OSError):
        raise
    missing_or_changed = {
        relative for relative, digest in expected_manifest.items()
        if archive_manifest.get(relative) != digest
    }
    if missing_or_changed:
        raise OSError("Hermes backup does not match the required profile manifest")
