#!/usr/bin/env python3
"""Build and stage deterministic ChatGPT project-agent release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
CONTRACT_PATH = SCRIPT_DIR / "contract.json"
GENERATED_TOOLS_ARCHIVE = SCRIPT_DIR / "generated" / "chatgpt-project-agent-tools-linux-x64.tar.zst"

TOOLS_MANIFEST = "TOOLS-MANIFEST.json"
TOOLS_INVENTORY = "TOOLS-INVENTORY.json"
TOOLS_CHECKSUMS = "TOOLS-SHA256SUMS"
RUNTIME_MANIFEST = "RUNTIME-MANIFEST.json"
RUNTIME_INVENTORY = "RUNTIME-INVENTORY.json"
RUNTIME_CHECKSUMS = "RUNTIME-SHA256SUMS"

TOOLS_SOURCES = {
    SCRIPT_DIR / "bootstrap" / "README.md": Path("README.md"),
    SCRIPT_DIR / "bootstrap" / "bin" / "prepare-agent-workspace.sh": Path("bin/prepare-agent-workspace.sh"),
    SCRIPT_DIR / "bootstrap" / "bin" / "setup-workspace.sh": Path("bin/setup-workspace.sh"),
    SCRIPT_DIR / "bootstrap" / "bin" / "install-ts-morph-offline.sh": Path("bin/install-ts-morph-offline.sh"),
    SCRIPT_DIR / "bootstrap" / "bin" / "install-tiktoken-offline.sh": Path("bin/install-tiktoken-offline.sh"),
    REPO_ROOT / "tools" / "local-agent" / "prepare-source-review.py": Path("tools/prepare-source-review.py"),
    REPO_ROOT / "tools" / "local-agent" / "test-prepare-source-review.py": Path("tools/test-prepare-source-review.py"),
    REPO_ROOT / "tools" / "local-agent" / "compact_unittest.py": Path("tools/compact_unittest.py"),
    SCRIPT_DIR / "project" / "CODEX-MODEL-SELECTION.md": Path("docs/CODEX-MODEL-SELECTION.md"),
}

RUNTIME_SOURCE_PATHS = (
    "runtime",
    "npm-cache-seed",
    "optional-tools",
    "CACHE-SEED-ID",
    "PACKAGE-INVENTORY.json",
)


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read JSON {path}: {exc}")
    if not isinstance(data, dict):
        fail(f"JSON root must be an object: {path}")
    return data


def load_contract() -> dict[str, Any]:
    contract = load_json(CONTRACT_PATH)
    required = {
        "formatVersion": 1,
        "platform": "linux-x64",
        "installationRoot": "chatgpt-project-agent-linux-x64",
    }
    for key, expected in required.items():
        if contract.get(key) != expected:
            fail(f"unsupported contract {key}: {contract.get(key)!r}")
    runtime = contract.get("runtimeContract")
    if not isinstance(runtime, dict) or runtime.get("formatVersion") != 1:
        fail("unsupported runtime contract")
    return contract


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_mode(path: Path) -> int:
    mode = stat.S_IMODE(path.lstat().st_mode)
    return 0o755 if mode & 0o111 else 0o644


def copy_source(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        fail(f"canonical source is not a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    os.chmod(destination, normalized_mode(source))
    os.utime(destination, (0, 0), follow_symlinks=False)


def normalize_directories(root: Path) -> None:
    os.chmod(root, 0o755)
    for path in root.rglob("*"):
        if path.is_dir() and not path.is_symlink():
            os.chmod(path, 0o755)


def inventory_entries(root: Path, excluded: set[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    inode_owner: dict[tuple[int, int], str] = {}
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        rel = path.relative_to(root).as_posix()
        if rel in excluded:
            continue
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode) & 0o777
        if stat.S_ISDIR(info.st_mode):
            entries.append({"path": rel, "type": "directory", "mode": mode})
        elif stat.S_ISLNK(info.st_mode):
            entries.append({"path": rel, "type": "symlink", "mode": mode, "target": os.readlink(path)})
        elif stat.S_ISREG(info.st_mode):
            inode = (info.st_dev, info.st_ino)
            owner = inode_owner.get(inode)
            if owner is not None and info.st_nlink > 1:
                entries.append({"path": rel, "type": "hardlink", "mode": mode, "target": owner})
            else:
                inode_owner[inode] = rel
                entries.append(
                    {
                        "path": rel,
                        "type": "file",
                        "mode": mode,
                        "size": info.st_size,
                        "sha256": sha256_file(path),
                    }
                )
        else:
            fail(f"unsupported filesystem entry in release source: {rel}")
    return entries


def write_inventory(root: Path, filename: str) -> None:
    excluded = {filename, TOOLS_CHECKSUMS, RUNTIME_CHECKSUMS}
    payload = {"formatVersion": 1, "entries": inventory_entries(root, excluded)}
    path = root / filename
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(path, 0o644)
    os.utime(path, (0, 0))


def verify_checksum_file(root: Path, filename: str) -> None:
    checksum_path = root / filename
    if not checksum_path.is_file():
        fail(f"checksum file is missing: {filename}")
    subprocess.run(
        ["sha256sum", "--check", "--quiet", filename],
        cwd=root,
        check=True,
    )


def write_checksums(root: Path, filename: str) -> None:
    lines: list[str] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.name == filename or path.is_symlink() or not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        lines.append(f"{sha256_file(path)}  {rel}")
    checksum_path = root / filename
    checksum_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(checksum_path, 0o644)
    os.utime(checksum_path, (0, 0))


def tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.mode &= 0o777
    info.pax_headers = {}
    return info


def create_tar_zst(root: Path, output: Path, level: int) -> None:
    if not 1 <= level <= 22:
        fail(f"zstd level must be between 1 and 22: {level}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-tar-") as temp_name:
        tar_path = Path(temp_name) / "payload.tar"
        with tarfile.open(tar_path, mode="w", format=tarfile.PAX_FORMAT, dereference=False) as archive:
            archive.add(root, arcname=root.name, recursive=True, filter=tar_filter)
        temporary_output = output.with_name(f".{output.name}.tmp-{os.getpid()}")
        command = ["zstd", "-q", "-f", "-T1", "--stdout"]
        if level > 19:
            command.append("--ultra")
        command.append(f"-{level}")
        command.append(str(tar_path))
        try:
            with temporary_output.open("wb") as target:
                subprocess.run(command, check=True, stdout=target)
            os.replace(temporary_output, output)
        finally:
            temporary_output.unlink(missing_ok=True)


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


def safe_extract_tar_zst(archive_path: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(["zstd", "-q", "-d", "-c", str(archive_path)], stdout=subprocess.PIPE)
    if process.stdout is None:
        fail("cannot open zstd output")
    seen: dict[PurePosixPath, tarfile.TarInfo] = {}
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
                seen[path] = member
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
    if len(roots) != 1:
        fail(f"archive must contain exactly one root directory: {sorted(roots)}")
    root_name = next(iter(roots))
    pending_hardlinks = [item for item in deferred_links if item[2]]
    while pending_hardlinks:
        next_pending: list[tuple[PurePosixPath, str, bool, int]] = []
        progressed = False
        for path, target, hardlink, mode in pending_hardlinks:
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
            unresolved = ", ".join(str(item[0]) for item in next_pending)
            fail(f"unresolved archive hardlinks: {unresolved}")
        pending_hardlinks = next_pending
    for path, target, hardlink, _mode in deferred_links:
        if hardlink:
            continue
        target_path = destination.joinpath(*path.parts)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, target_path)
    for directory, mode in reversed(directory_modes):
        os.chmod(directory, mode)
    return destination / root_name


def write_manifest(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(path, 0o644)
    os.utime(path, (0, 0))


def build_tools(output: Path, compression_level: int | None = None) -> None:
    contract = load_contract()
    level = compression_level or int(contract["toolsCompressionLevel"])
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-tools-") as temp_name:
        root = Path(temp_name) / str(contract["installationRoot"])
        root.mkdir()
        for source, relative in TOOLS_SOURCES.items():
            copy_source(source, root / relative)
        normalize_directories(root)
        manifest = {
            "formatVersion": 1,
            "kind": "tools",
            "platform": contract["platform"],
            "installationRoot": contract["installationRoot"],
            "normalEntryPoint": contract["normalEntryPoint"],
            "runtimeContract": contract["runtimeContract"],
            "canonicalSources": [
                str(path.relative_to(REPO_ROOT)).replace(os.sep, "/") for path in TOOLS_SOURCES
            ],
        }
        write_manifest(root / TOOLS_MANIFEST, manifest)
        write_inventory(root, TOOLS_INVENTORY)
        write_checksums(root, TOOLS_CHECKSUMS)
        create_tar_zst(root, output, level)
    print(f"prepare-chatgpt-project-agent: PASS kind=tools output={output} sha256={sha256_file(output)}")


def copy_runtime_payload(source_root: Path, destination_root: Path) -> None:
    missing = [name for name in RUNTIME_SOURCE_PATHS if not (source_root / name).exists()]
    if missing:
        fail(f"legacy bootstrap runtime payload is incomplete: {', '.join(missing)}")
    destination_root.mkdir(parents=True, exist_ok=True)
    command = ["cp", "-a", "--reflink=auto"]
    command.extend(str(source_root / name) for name in RUNTIME_SOURCE_PATHS)
    command.append(str(destination_root))
    subprocess.run(command, check=True)


def validate_runtime_required_paths(root: Path, contract: dict[str, Any]) -> None:
    runtime_contract = contract["runtimeContract"]
    for relative in runtime_contract["requiredPaths"]:
        if not (root / relative).exists():
            fail(f"runtime payload lacks required path: {relative}")


def build_runtime(legacy_archive: Path, output: Path, compression_level: int | None = None) -> None:
    contract = load_contract()
    level = compression_level or int(contract["runtimeCompressionLevel"])
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-runtime-") as temp_name:
        temp = Path(temp_name)
        legacy_root = safe_extract_tar_zst(legacy_archive, temp / "legacy")
        legacy_manifest = load_json(legacy_root / "MANIFEST.json")
        expected_legacy = {
            "formatVersion": 5,
            "platform": "linux-x64",
            "layout": "single-extract-preexpanded-runtime-and-cache",
        }
        for key, expected in expected_legacy.items():
            if legacy_manifest.get(key) != expected:
                fail(f"unsupported legacy bootstrap {key}: {legacy_manifest.get(key)!r}")
        verify_checksum_file(legacy_root, "SHA256SUMS")
        root = temp / str(contract["installationRoot"])
        copy_runtime_payload(legacy_root, root)
        validate_runtime_required_paths(root, contract)
        manifest = {
            "formatVersion": 1,
            "kind": "runtime",
            "platform": contract["platform"],
            "installationRoot": contract["installationRoot"],
            "runtimeContract": contract["runtimeContract"],
            "cacheSeedId": (root / "CACHE-SEED-ID").read_text(encoding="utf-8").strip(),
            "sourceBootstrap": {key: legacy_manifest[key] for key in expected_legacy},
        }
        write_manifest(root / RUNTIME_MANIFEST, manifest)
        write_inventory(root, RUNTIME_INVENTORY)
        write_checksums(root, RUNTIME_CHECKSUMS)
        create_tar_zst(root, output, level)
    print(f"prepare-chatgpt-project-agent: PASS kind=runtime output={output} sha256={sha256_file(output)}")


def replace_directory(source: Path, destination: Path) -> None:
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        fail(f"project output must be a real directory path: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.tmp-", dir=destination.parent))
    try:
        shutil.copytree(source, temporary / "payload", dirs_exist_ok=True, symlinks=True)
        payload = temporary / "payload"
        backup = destination.with_name(f".{destination.name}.backup-{os.getpid()}")
        if backup.exists() or backup.is_symlink():
            fail(f"project backup path already exists: {backup}")
        if destination.exists():
            destination.rename(backup)
            try:
                payload.rename(destination)
            except Exception:
                backup.rename(destination)
                raise
            shutil.rmtree(backup)
        else:
            payload.rename(destination)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def stage_project(
    runtime_archive: Path,
    output_directory: Path,
    research_archive: Path | None,
    tools_archive: Path = GENERATED_TOOLS_ARCHIVE,
) -> None:
    contract = load_contract()
    setup_script = SCRIPT_DIR / contract["setupScriptName"]
    readme = SCRIPT_DIR / "project" / contract["projectReadmeName"]
    required_files = [tools_archive, runtime_archive, setup_script, readme]
    if research_archive is not None:
        if research_archive.name != "TeaseScript-AI-Research-Archive.zip":
            fail(f"unexpected research archive name: {research_archive.name}")
        required_files.append(research_archive)
    for path in required_files:
        if not path.is_file():
            fail(f"project input is missing: {path}")
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-project-") as temp_name:
        stage = Path(temp_name) / "project"
        stage.mkdir()
        shutil.copy2(readme, stage / contract["projectReadmeName"])
        shutil.copy2(tools_archive, stage / contract["toolsArchiveName"])
        shutil.copy2(runtime_archive, stage / contract["runtimeArchiveName"])
        shutil.copy2(setup_script, stage / contract["setupScriptName"])
        os.chmod(stage / contract["setupScriptName"], 0o755)
        if research_archive is not None:
            shutil.copy2(research_archive, stage / research_archive.name)
        if len(list(stage.iterdir())) > 5:
            fail("project folder would exceed five files")
        subprocess.run(
            [
                str(stage / contract["setupScriptName"]),
                "--tools-archive",
                str(stage / contract["toolsArchiveName"]),
                "--runtime-archive",
                str(stage / contract["runtimeArchiveName"]),
                "--verify-only",
            ],
            check=True,
        )
        replace_directory(stage, output_directory)
    print(
        "prepare-chatgpt-project-agent: PASS "
        f"kind=project output={output_directory} files={len(list(output_directory.iterdir()))} "
        f"system_prompt_source={SCRIPT_DIR / 'project' / 'SYSTEM-PROMPT.md'}"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    tools = subparsers.add_parser("tools", help="build the deterministic small tools archive")
    tools.add_argument("--output", type=Path, default=GENERATED_TOOLS_ARCHIVE)
    tools.add_argument("--compression-level", type=int)

    runtime = subparsers.add_parser("runtime", help="split a legacy bootstrap into the runtime archive")
    runtime.add_argument("--legacy-bootstrap", type=Path, required=True)
    runtime.add_argument("--output", type=Path, required=True)
    runtime.add_argument("--compression-level", type=int)

    project = subparsers.add_parser("project", help="stage the compact ChatGPT project folder")
    project.add_argument("--tools-archive", type=Path, default=GENERATED_TOOLS_ARCHIVE)
    project.add_argument("--runtime-archive", type=Path, required=True)
    project.add_argument("--research-archive", type=Path)
    project.add_argument("--output-directory", type=Path, required=True)

    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        if args.command == "tools":
            build_tools(args.output.resolve(), args.compression_level)
        elif args.command == "runtime":
            build_runtime(args.legacy_bootstrap.resolve(), args.output.resolve(), args.compression_level)
        else:
            stage_project(
                args.runtime_archive.resolve(),
                args.output_directory.resolve(),
                args.research_archive.resolve() if args.research_archive else None,
                args.tools_archive.resolve(),
            )
    except (RuntimeError, OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        print(f"prepare-chatgpt-project-agent: FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
