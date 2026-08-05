#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-chatgpt-project-agent.sh [OPTIONS]

Validate and atomically combine the ChatGPT project-agent tools tar.gz and Linux
x64 runtime tar.zst into one usable local installation.

Options:
  --tools-archive FILE    Small tools archive. Default: adjacent stable filename.
  --runtime-archive FILE  Large runtime archive. Default: adjacent stable filename.
  --output DIRECTORY      Installation directory. Default under /mnt/data.
  --verify-only           Validate and assemble temporarily without replacing output.
  -h, --help              Show this help.
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tools_archive="$script_dir/chatgpt-project-agent-tools-linux-x64.tar.gz"
runtime_archive="$script_dir/chatgpt-project-agent-runtime-linux-x64.tar.zst"
output=/mnt/data/chatgpt-project-agent-linux-x64
verify_only=0

while (($#)); do
  case "$1" in
    --tools-archive) (($# >= 2)) || { usage >&2; exit 2; }; tools_archive=$2; shift 2 ;;
    --runtime-archive) (($# >= 2)) || { usage >&2; exit 2; }; runtime_archive=$2; shift 2 ;;
    --output) (($# >= 2)) || { usage >&2; exit 2; }; output=$2; shift 2 ;;
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

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, Iterator, NoReturn

TOOLS_ROOT = "chatgpt-project-agent"
RUNTIME_ROOT = "chatgpt-project-agent-runtime-linux-x64"
INSTALLATION_ROOT = "chatgpt-project-agent-linux-x64"
TOOLS_MANIFEST = "TOOLS-MANIFEST.json"
TOOLS_INVENTORY = "TOOLS-INVENTORY.json"
TOOLS_CHECKSUMS = "TOOLS-SHA256SUMS"
RUNTIME_MANIFEST = "RUNTIME-MANIFEST.json"
RUNTIME_INVENTORY = "RUNTIME-INVENTORY.json"
RUNTIME_CHECKSUMS = "RUNTIME-SHA256SUMS"
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


def fail(message: str) -> NoReturn:
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


@contextmanager
def open_archive(path: Path, kind: str) -> Iterator[tarfile.TarFile]:
    if kind == "tools":
        with tarfile.open(path, mode="r:gz") as archive:
            yield archive
        return
    process = subprocess.Popen(["zstd", "-q", "-d", "-c", str(path)], stdout=subprocess.PIPE)
    if process.stdout is None:
        fail("cannot open zstd output")
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            yield archive
        process.stdout.close()
        status = process.wait()
        if status != 0:
            fail(f"zstd decompression failed with exit status {status}")
    except Exception:
        process.kill()
        process.wait()
        raise


def safe_extract(archive_path: Path, destination: Path, kind: str, expected_root: str) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    seen: set[PurePosixPath] = set()
    roots: set[str] = set()
    deferred_links: list[tuple[PurePosixPath, str, bool, int]] = []
    directory_modes: list[tuple[Path, int]] = []
    with open_archive(archive_path, kind) as archive:
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
    if roots != {expected_root}:
        fail(f"{kind} archive root mismatch: {sorted(roots)}")
    pending = [item for item in deferred_links if item[2]]
    while pending:
        remaining: list[tuple[PurePosixPath, str, bool, int]] = []
        progress = False
        for path, target, hardlink, mode in pending:
            resolved = safe_link_target(path, target, hardlink)
            source_path = destination.joinpath(*resolved.parts)
            target_path = destination.joinpath(*path.parts)
            if not source_path.exists() or source_path.is_symlink():
                remaining.append((path, target, hardlink, mode))
                continue
            target_path.parent.mkdir(parents=True, exist_ok=True)
            os.link(source_path, target_path)
            os.chmod(target_path, mode)
            progress = True
        if remaining and not progress:
            fail("unresolved archive hardlinks")
        pending = remaining
    for path, target, hardlink, _mode in deferred_links:
        if hardlink:
            continue
        target_path = destination.joinpath(*path.parts)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, target_path)
    for directory, mode in reversed(directory_modes):
        os.chmod(directory, mode)
    return destination / expected_root


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read JSON {path.name}: {exc}")
    if not isinstance(value, dict):
        fail(f"JSON root must be an object: {path.name}")
    return value


def validate_relative_path(value: str) -> Path:
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"invalid inventory path: {value!r}")
    return Path(*path.parts)


def verify_checksums(root: Path, filename: str) -> None:
    expected: dict[str, str] = {}
    for line in (root / filename).read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        digest, separator, relative = line.partition("  ")
        if not separator or not re.fullmatch(r"[0-9a-f]{64}", digest):
            fail(f"invalid checksum line in {filename}: {line!r}")
        validate_relative_path(relative)
        if relative in expected:
            fail(f"duplicate checksum path in {filename}: {relative}")
        expected[relative] = digest
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != filename
    }
    if set(expected) != actual:
        fail(
            f"checksum inventory mismatch in {filename}: "
            f"missing={sorted(actual - set(expected))} extra={sorted(set(expected) - actual)}"
        )
    for relative, digest in expected.items():
        if sha256_file(root / validate_relative_path(relative)) != digest:
            fail(f"checksum mismatch: {relative}")


def verify_inventory(root: Path, filename: str, excluded: set[str]) -> dict[str, str]:
    payload = load_json(root / filename)
    if payload.get("formatVersion") != 1 or not isinstance(payload.get("entries"), list):
        fail(f"unsupported inventory: {filename}")
    expected: dict[str, dict[str, Any]] = {}
    for raw in payload["entries"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("path"), str):
            fail(f"invalid inventory entry in {filename}")
        relative = raw["path"]
        validate_relative_path(relative)
        if relative in expected:
            fail(f"duplicate inventory entry: {relative}")
        expected[relative] = raw
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.relative_to(root).as_posix() not in excluded
    }
    if set(expected) != actual:
        fail(
            f"filesystem inventory mismatch in {filename}: "
            f"missing={sorted(actual - set(expected))} extra={sorted(set(expected) - actual)}"
        )
    kinds: dict[str, str] = {}
    for relative, entry in expected.items():
        path = root / validate_relative_path(relative)
        kind = entry.get("type")
        mode = int(entry.get("mode", -1))
        if stat.S_IMODE(path.lstat().st_mode) & 0o777 != mode:
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


def verify_tools(root: Path) -> tuple[dict[str, Any], dict[str, str], dict[str, Any]]:
    manifest = load_json(root / TOOLS_MANIFEST)
    contract = load_json(root / "contract.json")
    if manifest.get("formatVersion") != 2 or manifest.get("kind") != "tools":
        fail("unsupported tools manifest")
    expected_contract = {
        "formatVersion": 2,
        "platform": "linux-x64",
        "toolsRoot": TOOLS_ROOT,
        "runtimeRoot": RUNTIME_ROOT,
        "installationRoot": INSTALLATION_ROOT,
        "toolsArchiveName": "chatgpt-project-agent-tools-linux-x64.tar.gz",
        "runtimeArchiveName": "chatgpt-project-agent-runtime-linux-x64.tar.zst",
        "setupScriptName": "setup-chatgpt-project-agent.sh",
        "projectReadmeName": "README-FIRST.md",
        "normalEntryPoint": "bin/prepare-agent-workspace.sh",
        "tiktokenRequired": True,
    }
    for key, wanted in expected_contract.items():
        if contract.get(key) != wanted:
            fail(f"tools contract {key} mismatch")
    if (
        manifest.get("platform") != contract["platform"]
        or manifest.get("bundleRoot") != contract["toolsRoot"]
        or manifest.get("installationRoot") != contract["installationRoot"]
        or manifest.get("normalEntryPoint") != contract["normalEntryPoint"]
        or manifest.get("tiktokenRequired") is not True
        or manifest.get("runtimeContract") != contract.get("runtimeContract")
    ):
        fail("tools manifest does not match contract")
    kinds = verify_inventory(root, TOOLS_INVENTORY, {TOOLS_INVENTORY, TOOLS_CHECKSUMS})
    verify_checksums(root, TOOLS_CHECKSUMS)
    python_files = sorted(path.relative_to(root).as_posix() for path in root.rglob("*.py"))
    if python_files != ["tools/prepare-source-review.py"]:
        fail("installed tools archive must contain exactly one Python tool")
    return manifest, kinds, contract


def verify_runtime(root: Path, contract: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    manifest = load_json(root / RUNTIME_MANIFEST)
    if (
        manifest.get("formatVersion") != 2
        or manifest.get("kind") != "runtime"
        or manifest.get("platform") != contract["platform"]
        or manifest.get("runtimeRoot") != contract["runtimeRoot"]
        or manifest.get("installationRoot") != contract["installationRoot"]
        or manifest.get("tiktokenRequired") is not True
        or manifest.get("runtimeContract") != contract.get("runtimeContract")
    ):
        fail("runtime manifest does not match tools contract")
    kinds = verify_inventory(root, RUNTIME_INVENTORY, {RUNTIME_INVENTORY, RUNTIME_CHECKSUMS})
    verify_checksums(root, RUNTIME_CHECKSUMS)
    return manifest, kinds


def merge_conflicts(tools_kinds: dict[str, str], runtime_kinds: dict[str, str]) -> None:
    conflicts = [
        path
        for path in sorted(set(tools_kinds) & set(runtime_kinds))
        if tools_kinds[path] != "directory" or runtime_kinds[path] != "directory"
    ]
    if conflicts:
        fail("tools/runtime path conflicts: " + ", ".join(conflicts))


def copy_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", "-a", "--reflink=auto", f"{source}/.", str(destination)], check=True)


def validate_entrypoint(root: Path, contract: dict[str, Any]) -> None:
    entrypoint = contract.get("normalEntryPoint")
    if not isinstance(entrypoint, str):
        fail("tools contract lacks normal entry point")
    path = root / validate_relative_path(entrypoint)
    if not path.is_file() or not os.access(path, os.X_OK):
        fail(f"normal entry point is missing or not executable: {entrypoint}")
    result = subprocess.run([str(path), "--help"], text=True, capture_output=True, check=True)
    missing = sorted(REQUIRED_OPTIONS - set(re.findall(r"--[a-z0-9-]+", result.stdout)))
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
        tools_root = safe_extract(tools_archive, temp / "tools", "tools", TOOLS_ROOT)
        runtime_root = safe_extract(runtime_archive, temp / "runtime", "runtime", RUNTIME_ROOT)
        _tools_manifest, tools_kinds, contract = verify_tools(tools_root)
        _runtime_manifest, runtime_kinds = verify_runtime(runtime_root, contract)
        merge_conflicts(tools_kinds, runtime_kinds)
        candidate = temp / "candidate" / INSTALLATION_ROOT
        copy_tree(tools_root, candidate)
        copy_tree(runtime_root, candidate)
        for relative in contract["runtimeContract"]["requiredPaths"]:
            if not (candidate / validate_relative_path(relative)).exists():
                fail(f"combined installation lacks required path: {relative}")
        validate_entrypoint(candidate, contract)
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
