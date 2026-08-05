#!/usr/bin/env python3
"""Prepare and validate ChatGPT project-agent release derivatives."""

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
from typing import Any, NoReturn

REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ROOT = REPO_ROOT / "tools" / "chatgpt-project-agent"
CONTRACT_PATH = BUNDLE_ROOT / "contract.json"
PROJECT_README = REPO_ROOT / "docs" / "chatgpt-project" / "README-FIRST.md"
SETUP_SCRIPT = REPO_ROOT / "tools" / "setup-chatgpt-project-agent.sh"

COMBINED_README_SOURCES = (
    BUNDLE_ROOT / "docs" / "README-FIRST.md",
    BUNDLE_ROOT / "docs" / "PROJECT-INSTRUCTIONS.txt",
    BUNDLE_ROOT / "docs" / "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md",
    BUNDLE_ROOT / "docs" / "LOCAL-AGENT-BOOTSTRAP.md",
    BUNDLE_ROOT / "docs" / "CODEX-MODEL-SELECTION.md",
)

TOOLS_MANIFEST = "TOOLS-MANIFEST.json"
TOOLS_INVENTORY = "TOOLS-INVENTORY.json"
TOOLS_CHECKSUMS = "TOOLS-SHA256SUMS"
RUNTIME_MANIFEST = "RUNTIME-MANIFEST.json"
RUNTIME_INVENTORY = "RUNTIME-INVENTORY.json"
RUNTIME_CHECKSUMS = "RUNTIME-SHA256SUMS"

EXPECTED_BUNDLE_FILES = {
    "README.md",
    "TOOLS-INVENTORY.json",
    "TOOLS-MANIFEST.json",
    "TOOLS-SHA256SUMS",
    "bin/install-tiktoken-offline.sh",
    "bin/install-ts-morph-offline.sh",
    "bin/prepare-agent-workspace.sh",
    "bin/setup-workspace.sh",
    "contract.json",
    "docs/CODEX-MODEL-SELECTION.md",
    "docs/LOCAL-AGENT-BOOTSTRAP.md",
    "docs/PROJECT-INSTRUCTIONS.txt",
    "docs/README-FIRST.md",
    "docs/TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md",
    "tools/prepare-source-review.py",
}


class PreparationError(RuntimeError):
    """Expected release preparation or validation failure."""


def fail(message: str) -> NoReturn:
    raise PreparationError(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read JSON {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"JSON root must be an object: {path}")
    return value


def load_contract() -> dict[str, Any]:
    contract = load_json(CONTRACT_PATH)
    expected = {
        "formatVersion": 2,
        "platform": "linux-x64",
        "toolsRoot": "chatgpt-project-agent",
        "runtimeRoot": "chatgpt-project-agent-runtime-linux-x64",
        "installationRoot": "chatgpt-project-agent-linux-x64",
        "toolsArchiveName": "chatgpt-project-agent-tools-linux-x64.tar.gz",
        "runtimeArchiveName": "chatgpt-project-agent-runtime-linux-x64.tar.zst",
        "setupScriptName": "setup-chatgpt-project-agent.sh",
        "projectReadmeName": "README-FIRST.md",
        "normalEntryPoint": "bin/prepare-agent-workspace.sh",
        "tiktokenRequired": True,
    }
    for key, wanted in expected.items():
        if contract.get(key) != wanted:
            fail(f"unsupported contract {key}: {contract.get(key)!r}")
    expected_readme_sources = [
        path.relative_to(BUNDLE_ROOT).as_posix() for path in COMBINED_README_SOURCES
    ]
    if contract.get("combinedReadmeSources") != expected_readme_sources:
        fail("contract combinedReadmeSources does not match the fixed complete source order")
    runtime = contract.get("runtimeContract")
    if not isinstance(runtime, dict) or runtime.get("formatVersion") != 2:
        fail("unsupported runtime contract")
    required = runtime.get("requiredPaths")
    if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
        fail("runtime contract requiredPaths must be an array of strings")
    return contract


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_mode(path: Path) -> int:
    return 0o755 if stat.S_IMODE(path.lstat().st_mode) & 0o111 else 0o644


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(path, 0o644)


def inventory_entries(root: Path, excluded: set[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    inode_owner: dict[tuple[int, int], str] = {}
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if relative in excluded:
            continue
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode) & 0o777
        if stat.S_ISDIR(info.st_mode):
            entries.append({"path": relative, "type": "directory", "mode": mode})
        elif stat.S_ISLNK(info.st_mode):
            entries.append(
                {"path": relative, "type": "symlink", "mode": mode, "target": os.readlink(path)}
            )
        elif stat.S_ISREG(info.st_mode):
            inode = (info.st_dev, info.st_ino)
            owner = inode_owner.get(inode)
            if owner is not None and info.st_nlink > 1:
                entries.append({"path": relative, "type": "hardlink", "mode": mode, "target": owner})
            else:
                inode_owner[inode] = relative
                entries.append(
                    {
                        "path": relative,
                        "type": "file",
                        "mode": mode,
                        "size": info.st_size,
                        "sha256": sha256_file(path),
                    }
                )
        else:
            fail(f"unsupported filesystem entry: {relative}")
    return entries


def write_inventory(root: Path, filename: str) -> None:
    excluded = {filename, TOOLS_CHECKSUMS, RUNTIME_CHECKSUMS}
    write_json(root / filename, {"formatVersion": 1, "entries": inventory_entries(root, excluded)})


def write_checksums(root: Path, filename: str) -> None:
    lines: list[str] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.name == filename or path.is_symlink() or not path.is_file():
            continue
        lines.append(f"{sha256_file(path)}  {path.relative_to(root).as_posix()}")
    (root / filename).write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(root / filename, 0o644)


def validate_bundle_sources() -> None:
    actual_files = {
        path.relative_to(BUNDLE_ROOT).as_posix()
        for path in BUNDLE_ROOT.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    if actual_files != EXPECTED_BUNDLE_FILES:
        fail(
            "tools bundle file set mismatch: "
            f"missing={sorted(EXPECTED_BUNDLE_FILES - actual_files)} "
            f"extra={sorted(actual_files - EXPECTED_BUNDLE_FILES)}"
        )
    required = [
        BUNDLE_ROOT / "README.md",
        CONTRACT_PATH,
        BUNDLE_ROOT / "bin" / "prepare-agent-workspace.sh",
        BUNDLE_ROOT / "bin" / "setup-workspace.sh",
        BUNDLE_ROOT / "bin" / "install-tiktoken-offline.sh",
        BUNDLE_ROOT / "bin" / "install-ts-morph-offline.sh",
        BUNDLE_ROOT / "tools" / "prepare-source-review.py",
        *COMBINED_README_SOURCES,
    ]
    missing = [str(path.relative_to(REPO_ROOT)) for path in required if not path.is_file()]
    if missing:
        fail("missing canonical bundle sources: " + ", ".join(missing))
    python_files = sorted(BUNDLE_ROOT.rglob("*.py"))
    if python_files != [BUNDLE_ROOT / "tools" / "prepare-source-review.py"]:
        fail(
            "the installed tools bundle must contain exactly one Python tool: "
            + ", ".join(str(path.relative_to(BUNDLE_ROOT)) for path in python_files)
        )
    for script in (BUNDLE_ROOT / "bin").glob("*.sh"):
        if not os.access(script, os.X_OK):
            fail(f"bundle shell script is not executable: {script.relative_to(BUNDLE_ROOT)}")
    if not os.access(BUNDLE_ROOT / "tools" / "prepare-source-review.py", os.X_OK):
        fail("prepare-source-review.py is not executable")


def combined_readme_bytes() -> bytes:
    parts: list[bytes] = []
    for source in COMBINED_README_SOURCES:
        value = source.read_bytes()
        if not value:
            fail(f"combined README source is empty: {source}")
        if not value.endswith(b"\n"):
            fail(f"combined README source must end with a newline: {source}")
        parts.append(value)
    return b"".join(parts)


def write_combined_readme() -> None:
    expected = combined_readme_bytes()
    PROJECT_README.parent.mkdir(parents=True, exist_ok=True)
    PROJECT_README.write_bytes(expected)
    os.chmod(PROJECT_README, 0o644)
    if PROJECT_README.read_bytes() != expected:
        fail("combined README does not exactly match its complete ordered sources")


def refresh() -> None:
    contract = load_contract()
    validate_bundle_sources()
    manifest = {
        "formatVersion": 2,
        "kind": "tools",
        "platform": contract["platform"],
        "bundleRoot": contract["toolsRoot"],
        "installationRoot": contract["installationRoot"],
        "normalEntryPoint": contract["normalEntryPoint"],
        "tiktokenRequired": True,
        "combinedReadmeSources": contract["combinedReadmeSources"],
        "runtimeContract": contract["runtimeContract"],
    }
    write_json(BUNDLE_ROOT / TOOLS_MANIFEST, manifest)
    write_inventory(BUNDLE_ROOT, TOOLS_INVENTORY)
    write_checksums(BUNDLE_ROOT, TOOLS_CHECKSUMS)
    write_combined_readme()
    print(
        "prepare-chatgpt-project-agent: PASS "
        f"kind=refresh bundle={BUNDLE_ROOT} readme={PROJECT_README}"
    )


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
        status = process.wait()
        if status != 0:
            fail(f"zstd decompression failed with exit status {status}")
    except Exception:
        process.kill()
        process.wait()
        raise
    if len(roots) != 1:
        fail(f"archive must contain exactly one top-level directory: {sorted(roots)}")
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
    return destination / next(iter(roots))


def verify_checksum_file(root: Path, filename: str) -> None:
    completed = subprocess.run(
        ["sha256sum", "--check", "--quiet", filename],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "checksum verification failed"
        fail(f"{filename}: {detail}")


def copy_regular_tree(source: Path, destination: Path) -> None:
    if not source.is_dir() or source.is_symlink():
        fail(f"expected source directory: {source}")
    shutil.copytree(source, destination, symlinks=True)


def copy_runtime_payload(legacy_root: Path, runtime_root: Path) -> None:
    runtime_root.mkdir(parents=True)
    copy_regular_tree(legacy_root / "runtime", runtime_root / "runtime")
    copy_regular_tree(legacy_root / "npm-cache-seed", runtime_root / "npm-cache-seed")
    shutil.copy2(legacy_root / "CACHE-SEED-ID", runtime_root / "CACHE-SEED-ID")
    shutil.copy2(legacy_root / "PACKAGE-INVENTORY.json", runtime_root / "PACKAGE-INVENTORY.json")

    ts_source = legacy_root / "optional-tools" / "ts-morph"
    ts_target = runtime_root / "optional-tools" / "ts-morph"
    ts_target.mkdir(parents=True)
    copy_regular_tree(ts_source / "packages", ts_target / "packages")
    shutil.copy2(ts_source / "SHA256SUMS", ts_target / "SHA256SUMS")

    token_source = legacy_root / "optional-tools" / "tiktoken-cp313-linux-x86_64"
    token_target = runtime_root / "dependencies" / "tiktoken-cp313-linux-x86_64"
    token_target.mkdir(parents=True)
    copy_regular_tree(token_source / "wheels", token_target / "wheels")
    copy_regular_tree(token_source / "tokenizer", token_target / "tokenizer")
    shutil.copy2(token_source / "MANIFEST.json", token_target / "MANIFEST.json")
    write_checksums(token_target, "SHA256SUMS")


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
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-runtime-tar-") as temp_name:
        tar_path = Path(temp_name) / "payload.tar"
        with tarfile.open(tar_path, mode="w", format=tarfile.PAX_FORMAT, dereference=False) as archive:
            archive.add(root, arcname=root.name, recursive=True, filter=tar_filter)
        temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
        command = ["zstd", "-q", "-f", "-T1", "--stdout"]
        if level > 19:
            command.append("--ultra")
        command.extend([f"-{level}", str(tar_path)])
        try:
            with temporary.open("wb") as handle:
                subprocess.run(command, stdout=handle, check=True)
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)


def build_runtime(legacy_archive: Path, output: Path, compression_level: int | None) -> None:
    contract = load_contract()
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-runtime-") as temp_name:
        temp = Path(temp_name)
        legacy_root = safe_extract_tar_zst(legacy_archive, temp / "legacy")
        legacy_manifest = load_json(legacy_root / "MANIFEST.json")
        expected = {
            "formatVersion": 5,
            "platform": "linux-x64",
            "layout": "single-extract-preexpanded-runtime-and-cache",
        }
        for key, wanted in expected.items():
            if legacy_manifest.get(key) != wanted:
                fail(f"unsupported legacy bootstrap {key}: {legacy_manifest.get(key)!r}")
        verify_checksum_file(legacy_root, "SHA256SUMS")
        runtime_root = temp / str(contract["runtimeRoot"])
        copy_runtime_payload(legacy_root, runtime_root)
        for relative in contract["runtimeContract"]["requiredPaths"]:
            if not (runtime_root / relative).exists():
                fail(f"runtime payload lacks required path: {relative}")
        write_json(
            runtime_root / RUNTIME_MANIFEST,
            {
                "formatVersion": 2,
                "kind": "runtime",
                "platform": contract["platform"],
                "runtimeRoot": contract["runtimeRoot"],
                "installationRoot": contract["installationRoot"],
                "tiktokenRequired": True,
                "runtimeContract": contract["runtimeContract"],
                "cacheSeedId": (runtime_root / "CACHE-SEED-ID").read_text(encoding="utf-8").strip(),
                "sourceBootstrap": {key: legacy_manifest[key] for key in expected},
            },
        )
        write_inventory(runtime_root, RUNTIME_INVENTORY)
        write_checksums(runtime_root, RUNTIME_CHECKSUMS)
        create_tar_zst(
            runtime_root,
            output,
            compression_level or int(contract["runtimeCompressionLevel"]),
        )
    print(
        "prepare-chatgpt-project-agent: PASS "
        f"kind=runtime output={output} sha256={sha256_file(output)}"
    )


def replace_directory(source: Path, destination: Path) -> None:
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        fail(f"project output must be a real directory path: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.tmp-", dir=destination.parent))
    try:
        staged = temporary / "payload"
        shutil.copytree(source, staged, symlinks=True)
        backup = destination.with_name(f".{destination.name}.backup-{os.getpid()}")
        if backup.exists() or backup.is_symlink():
            fail(f"project backup path already exists: {backup}")
        if destination.exists():
            destination.rename(backup)
            try:
                staged.rename(destination)
            except Exception:
                backup.rename(destination)
                raise
            shutil.rmtree(backup)
        else:
            staged.rename(destination)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def stage_project(
    tools_archive: Path,
    runtime_archive: Path,
    output_directory: Path,
    research_archive: Path | None,
) -> None:
    contract = load_contract()
    required = [tools_archive, runtime_archive, SETUP_SCRIPT, PROJECT_README]
    if research_archive is not None:
        if research_archive.name != "TeaseScript-AI-Research-Archive.zip":
            fail(f"unexpected research archive name: {research_archive.name}")
        required.append(research_archive)
    for path in required:
        if not path.is_file():
            fail(f"project input is missing: {path}")
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-project-") as temp_name:
        stage = Path(temp_name) / "project"
        stage.mkdir()
        shutil.copy2(PROJECT_README, stage / contract["projectReadmeName"])
        shutil.copy2(tools_archive, stage / contract["toolsArchiveName"])
        shutil.copy2(runtime_archive, stage / contract["runtimeArchiveName"])
        shutil.copy2(SETUP_SCRIPT, stage / contract["setupScriptName"])
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
        f"kind=project output={output_directory} files={len(list(output_directory.iterdir()))}"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("refresh", help="refresh bundle metadata and combined README")
    runtime = commands.add_parser("runtime", help="split the legacy bootstrap into the runtime archive")
    runtime.add_argument("--legacy-bootstrap", type=Path, required=True)
    runtime.add_argument("--output", type=Path, required=True)
    runtime.add_argument("--compression-level", type=int)
    project = commands.add_parser("project", help="stage the compact ChatGPT project folder")
    project.add_argument("--tools-archive", type=Path, required=True)
    project.add_argument("--runtime-archive", type=Path, required=True)
    project.add_argument("--research-archive", type=Path)
    project.add_argument("--output-directory", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        if args.command == "refresh":
            refresh()
        elif args.command == "runtime":
            build_runtime(args.legacy_bootstrap.resolve(), args.output.resolve(), args.compression_level)
        else:
            stage_project(
                args.tools_archive.resolve(),
                args.runtime_archive.resolve(),
                args.output_directory.resolve(),
                args.research_archive.resolve() if args.research_archive else None,
            )
    except (PreparationError, OSError, subprocess.CalledProcessError, tarfile.TarError, ValueError) as exc:
        print(f"prepare-chatgpt-project-agent: FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
