#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-chatgpt-project-agent.sh [OPTIONS]

Validate and atomically combine the ChatGPT project-agent tools and Linux x64
runtime archives into one usable local installation.

Options:
  --tools-archive FILE    Small tools archive. Default: adjacent stable filename.
  --runtime-archive FILE  Large runtime archive. Default: adjacent stable filename.
  --output DIRECTORY      Installation directory. Default under /mnt/data.
  --verify-only           Validate and assemble temporarily without replacing output.
  -h, --help              Show this help.
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tools_archive="$script_dir/chatgpt-project-agent-tools-linux-x64.tar.zst"
runtime_archive="$script_dir/chatgpt-project-agent-runtime-linux-x64.tar.zst"
output=/mnt/data/chatgpt-project-agent-linux-x64
verify_only=0

while (($#)); do
  case "$1" in
    --tools-archive) tools_archive=${2-}; shift 2 ;;
    --runtime-archive) runtime_archive=${2-}; shift 2 ;;
    --output) output=${2-}; shift 2 ;;
    --verify-only) verify_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'setup-chatgpt-project-agent: FAIL: unknown or incomplete argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || {
  printf 'setup-chatgpt-project-agent: FAIL: python3 is required\n' >&2
  exit 1
}
command -v zstd >/dev/null 2>&1 || {
  printf 'setup-chatgpt-project-agent: FAIL: zstd is required\n' >&2
  exit 1
}
[[ -f "$tools_archive" ]] || {
  printf 'setup-chatgpt-project-agent: FAIL: tools archive is missing: %s\n' "$tools_archive" >&2
  exit 1
}
[[ -f "$runtime_archive" ]] || {
  printf 'setup-chatgpt-project-agent: FAIL: runtime archive is missing: %s\n' "$runtime_archive" >&2
  exit 1
}

python3 - "$tools_archive" "$runtime_archive" "$output" "$verify_only" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any

TOOLS_MANIFEST = "TOOLS-MANIFEST.json"
TOOLS_INVENTORY = "TOOLS-INVENTORY.json"
TOOLS_CHECKSUMS = "TOOLS-SHA256SUMS"
RUNTIME_MANIFEST = "RUNTIME-MANIFEST.json"
RUNTIME_INVENTORY = "RUNTIME-INVENTORY.json"
RUNTIME_CHECKSUMS = "RUNTIME-SHA256SUMS"
EXPECTED_ROOT = "chatgpt-project-agent-linux-x64"
EXPECTED_PLATFORM = "linux-x64"
REQUIRED_OPTIONS = {
    "--artifact",
    "--artifact-sha256",
    "--expected-head",
    "--expected-merge-base",
    "--expected-repository",
    "--output",
    "--check",
    "--node",
    "--with-ts-morph",
    "--with-tiktoken",
}


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_member_path(name: str) -> PurePosixPath:
    if not name or "\\" in name:
        fail(f"unsafe archive path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"unsafe archive path: {name!r}")
    return path


def safe_link_target(member_path: PurePosixPath, target: str, hardlink: bool) -> PurePosixPath:
    if not target or "\\" in target:
        fail(f"unsafe archive link target: {target!r}")
    target_path = PurePosixPath(target)
    if target_path.is_absolute():
        fail(f"absolute archive link target: {target!r}")
    combined = target_path if hardlink else member_path.parent / target_path
    parts: list[str] = []
    for part in combined.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                fail(f"archive link escapes root: {member_path} -> {target}")
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        fail(f"empty archive link target: {member_path} -> {target}")
    return PurePosixPath(*parts)


def safe_extract(archive_path: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(["zstd", "-q", "-d", "-c", str(archive_path)], stdout=subprocess.PIPE)
    if process.stdout is None:
        fail("cannot open zstd output")
    seen: set[PurePosixPath] = set()
    roots: set[str] = set()
    deferred_links: list[tuple[PurePosixPath, str, bool, int]] = []
    directory_modes: list[tuple[Path, int]] = []
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                path = safe_member_path(member.name.rstrip("/"))
                roots.add(path.parts[0])
                if path in seen:
                    fail(f"duplicate archive entry: {path}")
                seen.add(path)
                target_path = destination.joinpath(*path.parts)
                if member.isdir():
                    target_path.mkdir(parents=True, exist_ok=True)
                    directory_modes.append((target_path, member.mode & 0o777))
                elif member.isreg():
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    source = archive.extractfile(member)
                    if source is None:
                        fail(f"cannot read archive file: {path}")
                    with target_path.open("wb") as handle:
                        shutil.copyfileobj(source, handle)
                    os.chmod(target_path, member.mode & 0o777)
                elif member.issym() or member.islnk():
                    resolved = safe_link_target(path, member.linkname, member.islnk())
                    if resolved.parts[0] != path.parts[0]:
                        fail(f"archive link escapes root: {path} -> {member.linkname}")
                    deferred_links.append((path, member.linkname, member.islnk(), member.mode & 0o777))
                else:
                    fail(f"unsupported archive entry type: {path}")
        process.stdout.close()
        return_code = process.wait()
        if return_code != 0:
            fail(f"zstd decompression failed with exit status {return_code}")
    except Exception:
        process.kill()
        process.wait()
        raise
    if roots != {EXPECTED_ROOT}:
        fail(f"archive root mismatch: {sorted(roots)}")

    pending = [item for item in deferred_links if item[2]]
    while pending:
        next_pending: list[tuple[PurePosixPath, str, bool, int]] = []
        progressed = False
        for path, target, hardlink, mode in pending:
            resolved = safe_link_target(path, target, hardlink)
            source_path = destination.joinpath(*resolved.parts)
            target_path = destination.joinpath(*path.parts)
            if not source_path.exists() or source_path.is_symlink():
                next_pending.append((path, target, hardlink, mode))
                continue
            target_path.parent.mkdir(parents=True, exist_ok=True)
            os.link(source_path, target_path)
            os.chmod(target_path, mode)
            progressed = True
        if not progressed and next_pending:
            fail("unresolved archive hardlinks: " + ", ".join(str(item[0]) for item in next_pending))
        pending = next_pending

    for path, target, hardlink, _mode in deferred_links:
        if hardlink:
            continue
        target_path = destination.joinpath(*path.parts)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, target_path)
    for directory, mode in reversed(directory_modes):
        os.chmod(directory, mode)
    return destination / EXPECTED_ROOT


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read JSON {path.name}: {exc}")
    if not isinstance(data, dict):
        fail(f"JSON root must be an object: {path.name}")
    return data


def validate_relative_path(value: str) -> Path:
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"invalid inventory path: {value!r}")
    return Path(*path.parts)


def verify_checksums(root: Path, filename: str) -> None:
    checksum_path = root / filename
    expected: dict[str, str] = {}
    for line in checksum_path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        if len(line) < 67 or line[64:66] != "  ":
            fail(f"invalid checksum line in {filename}: {line!r}")
        digest = line[:64]
        relative = line[66:]
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            fail(f"invalid checksum digest in {filename}: {digest!r}")
        validate_relative_path(relative)
        if relative in expected:
            fail(f"duplicate checksum path in {filename}: {relative}")
        expected[relative] = digest
    actual_paths = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != filename
    }
    if set(expected) != actual_paths:
        missing = sorted(actual_paths - set(expected))
        extra = sorted(set(expected) - actual_paths)
        fail(f"checksum inventory mismatch in {filename}: missing={missing} extra={extra}")
    for relative, expected_digest in expected.items():
        actual = sha256_file(root / validate_relative_path(relative))
        if actual != expected_digest:
            fail(f"checksum mismatch: {relative}")


def verify_inventory(root: Path, inventory_name: str, metadata_names: set[str]) -> dict[str, str]:
    payload = load_json(root / inventory_name)
    if payload.get("formatVersion") != 1 or not isinstance(payload.get("entries"), list):
        fail(f"unsupported inventory: {inventory_name}")
    expected: dict[str, dict[str, Any]] = {}
    for raw in payload["entries"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("path"), str):
            fail(f"invalid inventory entry in {inventory_name}")
        relative = raw["path"]
        validate_relative_path(relative)
        if relative in expected:
            fail(f"duplicate inventory entry: {relative}")
        expected[relative] = raw
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.relative_to(root).as_posix() not in metadata_names
    }
    if set(expected) != actual:
        missing = sorted(actual - set(expected))
        extra = sorted(set(expected) - actual)
        fail(f"filesystem inventory mismatch in {inventory_name}: missing={missing} extra={extra}")

    kinds: dict[str, str] = {}
    for relative, entry in expected.items():
        path = root / validate_relative_path(relative)
        kind = entry.get("type")
        mode = int(entry.get("mode", -1))
        actual_mode = stat.S_IMODE(path.lstat().st_mode) & 0o777
        if actual_mode != mode:
            fail(f"mode mismatch: {relative}")
        if kind == "directory":
            if not path.is_dir() or path.is_symlink():
                fail(f"expected directory: {relative}")
        elif kind == "symlink":
            if not path.is_symlink() or os.readlink(path) != entry.get("target"):
                fail(f"symlink mismatch: {relative}")
        elif kind == "file":
            if not path.is_file() or path.is_symlink():
                fail(f"expected regular file: {relative}")
            if path.stat().st_size != entry.get("size") or sha256_file(path) != entry.get("sha256"):
                fail(f"file content mismatch: {relative}")
        elif kind == "hardlink":
            target_value = entry.get("target")
            if not isinstance(target_value, str):
                fail(f"hardlink target missing: {relative}")
            target = root / validate_relative_path(target_value)
            if not path.is_file() or path.is_symlink() or not target.is_file() or target.is_symlink():
                fail(f"hardlink target invalid: {relative}")
            if not os.path.samefile(path, target):
                fail(f"hardlink identity mismatch: {relative}")
        else:
            fail(f"unsupported inventory type for {relative}: {kind!r}")
        kinds[relative] = str(kind)
    return kinds


def verify_bundle(root: Path, kind: str) -> tuple[dict[str, Any], dict[str, str]]:
    if kind == "tools":
        manifest_name, inventory_name, checksums_name = TOOLS_MANIFEST, TOOLS_INVENTORY, TOOLS_CHECKSUMS
        forbidden_metadata = {RUNTIME_MANIFEST, RUNTIME_INVENTORY, RUNTIME_CHECKSUMS}
    else:
        manifest_name, inventory_name, checksums_name = RUNTIME_MANIFEST, RUNTIME_INVENTORY, RUNTIME_CHECKSUMS
        forbidden_metadata = {TOOLS_MANIFEST, TOOLS_INVENTORY, TOOLS_CHECKSUMS}
    present_forbidden = sorted(name for name in forbidden_metadata if (root / name).exists())
    if present_forbidden:
        fail(f"unexpected {kind} archive metadata: {', '.join(present_forbidden)}")
    metadata = {inventory_name, checksums_name}
    manifest = load_json(root / manifest_name)
    if manifest.get("formatVersion") != 1 or manifest.get("kind") != kind:
        fail(f"unsupported {kind} manifest")
    if manifest.get("platform") != EXPECTED_PLATFORM or manifest.get("installationRoot") != EXPECTED_ROOT:
        fail(f"{kind} manifest platform or root mismatch")
    kinds = verify_inventory(root, inventory_name, metadata)
    verify_checksums(root, checksums_name)
    return manifest, kinds


def merge_conflicts(tools_kinds: dict[str, str], runtime_kinds: dict[str, str]) -> None:
    conflicts = []
    for path in sorted(set(tools_kinds) & set(runtime_kinds)):
        if tools_kinds[path] != "directory" or runtime_kinds[path] != "directory":
            conflicts.append(path)
    if conflicts:
        fail("tools/runtime path conflicts: " + ", ".join(conflicts))


def copy_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", "-a", "--reflink=auto", f"{source}/.", str(destination)], check=True)


def validate_entrypoint(root: Path, tools_manifest: dict[str, Any]) -> None:
    entrypoint = tools_manifest.get("normalEntryPoint")
    if not isinstance(entrypoint, str):
        fail("tools manifest lacks normal entry point")
    path = root / validate_relative_path(entrypoint)
    if not path.is_file() or not os.access(path, os.X_OK):
        fail(f"normal entry point is missing or not executable: {entrypoint}")
    result = subprocess.run([str(path), "--help"], check=True, text=True, capture_output=True)
    tokens = set(re.findall(r"--[a-z0-9-]+", result.stdout))
    missing = sorted(REQUIRED_OPTIONS - tokens)
    if missing:
        fail("normal entry point help lacks options: " + ", ".join(missing))


def atomic_install(candidate: Path, output: Path) -> None:
    if output.is_symlink() or (output.exists() and not output.is_dir()):
        fail(f"refusing to replace non-directory output: {output}")
    backup = output.with_name(f".{output.name}.backup-{os.getpid()}")
    if backup.exists() or backup.is_symlink():
        fail(f"backup path already exists: {backup}")
    if output.exists():
        output.rename(backup)
        try:
            candidate.rename(output)
        except Exception:
            backup.rename(output)
            raise
        shutil.rmtree(backup)
    else:
        candidate.rename(output)


def main() -> None:
    tools_archive = Path(sys.argv[1]).resolve()
    runtime_archive = Path(sys.argv[2]).resolve()
    output = Path(sys.argv[3]).resolve()
    verify_only = sys.argv[4] == "1"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}.setup-", dir=output.parent) as temp_name:
        temp = Path(temp_name)
        tools_root = safe_extract(tools_archive, temp / "tools")
        runtime_root = safe_extract(runtime_archive, temp / "runtime")
        tools_manifest, tools_kinds = verify_bundle(tools_root, "tools")
        runtime_manifest, runtime_kinds = verify_bundle(runtime_root, "runtime")
        tools_contract = tools_manifest.get("runtimeContract")
        runtime_contract = runtime_manifest.get("runtimeContract")
        if not isinstance(tools_contract, dict) or not isinstance(runtime_contract, dict):
            fail("tools/runtime manifest lacks a runtime contract")
        if tools_contract != runtime_contract:
            fail("tools/runtime contract mismatch")
        required_paths = tools_contract.get("requiredPaths")
        if not isinstance(required_paths, list) or not all(isinstance(item, str) for item in required_paths):
            fail("runtime contract has invalid required paths")
        merge_conflicts(tools_kinds, runtime_kinds)
        candidate = temp / "candidate" / EXPECTED_ROOT
        copy_tree(tools_root, candidate)
        copy_tree(runtime_root, candidate)
        for relative in required_paths:
            if not (candidate / validate_relative_path(relative)).exists():
                fail(f"combined installation lacks required path: {relative}")
        validate_entrypoint(candidate, tools_manifest)
        if not verify_only:
            atomic_install(candidate, output)
    print(
        "setup-chatgpt-project-agent: PASS "
        f"tools_sha256={sha256_file(tools_archive)} "
        f"runtime_sha256={sha256_file(runtime_archive)} "
        f"verify_only={int(verify_only)} output={output}"
    )


try:
    main()
except (RuntimeError, OSError, subprocess.CalledProcessError, tarfile.TarError, ValueError) as exc:
    print(f"setup-chatgpt-project-agent: FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY
