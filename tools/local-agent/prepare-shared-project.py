#!/usr/bin/env python3
"""Validate and stage the stable shared-project bootstrap replacement set."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SHARED_SOURCE_DIRECTORY = REPOSITORY_ROOT / "tools/local-agent/shared-project"
BOOTSTRAP_GUIDE = REPOSITORY_ROOT / "docs/LOCAL-AGENT-BOOTSTRAP.md"

STABLE_ARCHIVE_NAME = "teasescript-agent-bootstrap-linux-x64.tar.zst"
STABLE_DIRECTORY_NAME = "teasescript-agent-bootstrap-linux-x64"
NORMAL_ENTRY_POINT = "bin/prepare-agent-workspace.sh"
EXPECTED_BOOTSTRAP_MANIFEST = {
    "formatVersion": 5,
    "platform": "linux-x64",
    "layout": "single-extract-preexpanded-runtime-and-cache",
    "normalEntryPoint": NORMAL_ENTRY_POINT,
}
EXPECTED_ENTRY_POINT_OPTIONS = {
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

SHARED_FILES = {
    "README-FIRST.md": SHARED_SOURCE_DIRECTORY / "README-FIRST.md",
    "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md": (
        SHARED_SOURCE_DIRECTORY / "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md"
    ),
    "LOCAL-AGENT-BOOTSTRAP.md": BOOTSTRAP_GUIDE,
}

FORBIDDEN_SHARED_TEXT = (
    "tools/work-packages/",
    "bin/self-test.sh",
    "teasescript-agent-bootstrap-linux-x64-v",
    "README-FIRST(",
    "LOCAL-AGENT-BOOTSTRAP(",
    "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT(",
)


class PreparationError(RuntimeError):
    """Raised when the replacement set cannot be prepared safely."""


def fail(message: str) -> None:
    raise PreparationError(message)


def run(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "no output"
        fail(f"command failed ({' '.join(command)}): {detail}")
    return completed


def safe_archive_members(archive: Path) -> tuple[list[str], str]:
    listed = run(["tar", "--zstd", "-tf", str(archive)]).stdout.splitlines()
    if not listed:
        fail("bootstrap archive is empty")

    roots: set[str] = set()
    members: list[str] = []
    for raw_name in listed:
        name = raw_name.rstrip("/")
        if not name:
            fail("bootstrap archive contains an empty member name")
        if raw_name.startswith("/") or "\\" in raw_name or "//" in raw_name:
            fail(f"unsafe bootstrap archive member: {raw_name}")
        path = PurePosixPath(name)
        if any(part in {"", ".", ".."} for part in path.parts):
            fail(f"unsafe bootstrap archive member: {raw_name}")
        roots.add(path.parts[0])
        members.append(raw_name)

    if len(roots) != 1:
        fail("bootstrap archive must contain exactly one top-level directory")
    return members, next(iter(roots))


def validate_shared_sources(
    shared_files: dict[str, Path] = SHARED_FILES,
) -> dict[str, str]:
    expected_names = set(SHARED_FILES)
    if set(shared_files) != expected_names:
        fail("shared source inventory does not match the stable replacement inventory")

    values: dict[str, str] = {}
    for destination_name, source in shared_files.items():
        if not source.is_file():
            fail(f"missing canonical shared source: {source}")
        text = source.read_text(encoding="utf-8")
        for forbidden in FORBIDDEN_SHARED_TEXT:
            if forbidden in text:
                fail(f"{source} contains retired or unstable routing text: {forbidden}")
        values[destination_name] = text

    guide = values["LOCAL-AGENT-BOOTSTRAP.md"]
    required_guide_text = (
        STABLE_ARCHIVE_NAME,
        STABLE_DIRECTORY_NAME,
        NORMAL_ENTRY_POINT,
        "sole normal bootstrap entry point",
    )
    for required in required_guide_text:
        if required not in guide:
            fail(f"bootstrap guide does not state required contract: {required}")

    router = values["README-FIRST.md"]
    workflow = values["TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md"]
    for required in SHARED_FILES:
        if required not in router:
            fail(f"shared router does not name stable file: {required}")
    if STABLE_ARCHIVE_NAME not in router or STABLE_ARCHIVE_NAME not in workflow:
        fail("shared routing does not name the stable bootstrap archive")
    if NORMAL_ENTRY_POINT not in workflow:
        fail("shared workflow does not name the sole normal bootstrap entry point")

    return values


def validate_extracted_bootstrap(root: Path) -> dict[str, object]:
    manifest_path = root / "MANIFEST.json"
    if not manifest_path.is_file():
        fail("bootstrap archive lacks MANIFEST.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"bootstrap MANIFEST.json is invalid: {exc}")
    if not isinstance(manifest, dict):
        fail("bootstrap MANIFEST.json must be an object")
    for field, expected in EXPECTED_BOOTSTRAP_MANIFEST.items():
        actual = manifest.get(field)
        if actual != expected:
            fail(
                f"bootstrap manifest {field} must be {expected!r}, "
                f"found {actual!r}"
            )

    entry_point = root / NORMAL_ENTRY_POINT
    if not entry_point.is_file() or not os.access(entry_point, os.X_OK):
        fail(f"bootstrap normal entry point is absent or not executable: {NORMAL_ENTRY_POINT}")
    help_result = run([str(entry_point), "--help"])
    if "Normal agent entry point" not in help_result.stdout:
        fail("bootstrap entry-point help does not identify the normal agent route")
    documented_options = set(
        re.findall(r"(?<![A-Za-z0-9_-])--[a-z0-9][a-z0-9-]*", help_result.stdout)
    )
    missing_options = sorted(EXPECTED_ENTRY_POINT_OPTIONS - documented_options)
    if missing_options:
        fail(
            "bootstrap entry-point help omits required options: "
            + ", ".join(missing_options)
        )

    readme_path = root / "README.md"
    if not readme_path.is_file():
        fail("bootstrap archive lacks README.md")
    readme = readme_path.read_text(encoding="utf-8")
    if NORMAL_ENTRY_POINT not in readme:
        fail("bootstrap README does not document the manifest normal entry point")
    if "self-test.sh" in readme:
        fail("bootstrap README reintroduces a separate self-test route")

    checksums = root / "SHA256SUMS"
    if not checksums.is_file():
        fail("bootstrap archive lacks SHA256SUMS")
    run(["sha256sum", "--check", "--quiet", "SHA256SUMS"], cwd=root)
    return manifest


def create_stable_archive(source_root: Path, destination: Path) -> None:
    stable_root = source_root.parent / STABLE_DIRECTORY_NAME
    if source_root != stable_root:
        if stable_root.exists():
            fail(f"temporary stable bootstrap directory already exists: {stable_root}")
        source_root.rename(stable_root)
    run(
        [
            "tar",
            "--zstd",
            "--sort=name",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "--mtime=@0",
            "-cf",
            str(destination),
            "-C",
            str(stable_root.parent),
            STABLE_DIRECTORY_NAME,
        ]
    )


def prepare_replacement(
    *,
    bootstrap_archive: Path,
    output_directory: Path,
    shared_files: dict[str, Path] = SHARED_FILES,
) -> dict[str, object]:
    bootstrap_archive = bootstrap_archive.resolve()
    output_directory = output_directory.resolve()
    if not bootstrap_archive.is_file():
        fail(f"bootstrap archive does not exist: {bootstrap_archive}")
    if output_directory.exists():
        fail(f"output directory already exists: {output_directory}")

    shared_text = validate_shared_sources(shared_files)
    members, archive_root_name = safe_archive_members(bootstrap_archive)
    required_members = {
        f"{archive_root_name}/MANIFEST.json",
        f"{archive_root_name}/README.md",
        f"{archive_root_name}/SHA256SUMS",
        f"{archive_root_name}/{NORMAL_ENTRY_POINT}",
    }
    normalized_members = {value.rstrip("/") for value in members}
    missing = sorted(required_members - normalized_members)
    if missing:
        fail(f"bootstrap archive lacks required members: {', '.join(missing)}")

    output_parent = output_directory.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_directory.name}.prepare-", dir=output_parent
    ) as temporary_name:
        temporary = Path(temporary_name)
        extracted = temporary / "extracted"
        staged = temporary / "staged"
        extracted.mkdir()
        staged.mkdir()

        run(["tar", "--zstd", "-xf", str(bootstrap_archive), "-C", str(extracted)])
        source_root = extracted / archive_root_name
        if not source_root.is_dir():
            fail("bootstrap archive did not extract its declared top-level directory")
        manifest = validate_extracted_bootstrap(source_root)

        for destination_name, text in shared_text.items():
            (staged / destination_name).write_text(
                text, encoding="utf-8", newline="\n"
            )

        stable_archive = staged / STABLE_ARCHIVE_NAME
        create_stable_archive(source_root, stable_archive)

        staged_members, staged_root = safe_archive_members(stable_archive)
        if staged_root != STABLE_DIRECTORY_NAME:
            fail("staged bootstrap archive does not use the stable extracted directory")
        staged_normalized = {value.rstrip("/") for value in staged_members}
        if f"{STABLE_DIRECTORY_NAME}/{NORMAL_ENTRY_POINT}" not in staged_normalized:
            fail("staged bootstrap archive lost its normal entry point")

        actual_inventory = {path.name for path in staged.iterdir()}
        expected_inventory = set(SHARED_FILES) | {STABLE_ARCHIVE_NAME}
        if actual_inventory != expected_inventory:
            fail("staged replacement inventory is incomplete or contains extra files")

        os.replace(staged, output_directory)

    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Validate canonical shared-project routing and stage the exact stable "
            "bootstrap replacement set."
        )
    )
    result.add_argument("--bootstrap-archive", required=True, type=Path)
    result.add_argument("--output-directory", required=True, type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        manifest = prepare_replacement(
            bootstrap_archive=args.bootstrap_archive,
            output_directory=args.output_directory,
        )
    except PreparationError as exc:
        print(f"prepare-shared-project: FAIL: {exc}", file=os.sys.stderr)
        return 1

    print(f"prepare-shared-project: PASS output={args.output_directory.resolve()}")
    print(
        "files="
        + ",".join(sorted(set(SHARED_FILES) | {STABLE_ARCHIVE_NAME}))
    )
    print(f"bootstrapFormatVersion={manifest.get('formatVersion')}")
    print(f"bootstrapNormalEntryPoint={manifest.get('normalEntryPoint')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
