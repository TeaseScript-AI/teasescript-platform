#!/usr/bin/env python3
"""Create a verified multipart patch-publication payload.

The tool generates one exact raw Git patch from a tested commit, hashes the
complete patch before splitting, writes deterministic UTF-8 text parts, hashes
each part, writes a strict format-version-2 manifest, and reconstructs the
parts to prove byte identity before publishing the output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn


TRANSFER_PREFIX = "agent-patch-publication/"
TRANSFER_DIRECTORY = ".agent-patch-publication"
PART_DIRECTORY = f"{TRANSFER_DIRECTORY}/parts"
DEFAULT_PART_SIZE_KIB = 64
MAX_PART_SIZE_KIB = 256
MAX_PART_COUNT = 1024
MAX_PATCH_SIZE_BYTES = 64 * 1024 * 1024
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")


class PreparationError(RuntimeError):
    """Expected local preparation failure."""


def fail(message: str) -> NoReturn:
    raise PreparationError(message)


def run(
    args: list[str],
    *,
    cwd: Path,
    text: bool = True,
) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        args,
        cwd=cwd,
        text=text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr
        stdout = completed.stdout
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", "replace")
        detail = stderr.strip() or stdout.strip() or "no output"
        fail(f"command failed ({' '.join(args)}): {detail}")
    return completed


def git_text(repository: Path, *args: str) -> str:
    completed = run(["git", *args], cwd=repository)
    assert isinstance(completed.stdout, str)
    return completed.stdout.strip()


def require_sha1(value: str, *, label: str) -> str:
    if not SHA1_RE.fullmatch(value):
        fail(f"{label} must be a lowercase 40-character Git SHA-1")
    return value


def validate_branch(branch: str, *, repository: Path, default_branch: str) -> str:
    if not branch or len(branch.encode("utf-8")) > 240:
        fail("target branch must be between 1 and 240 UTF-8 bytes")
    completed = subprocess.run(
        ["git", "check-ref-format", "--branch", branch],
        cwd=repository,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        fail("target branch is not a valid Git branch name")
    if branch == default_branch:
        fail("target branch must not be the default branch")
    if branch.startswith(TRANSFER_PREFIX):
        fail("target branch must not use the transfer-branch namespace")
    return branch


def validate_commit_message(message: str) -> str:
    if not message or len(message.encode("utf-8")) > 240:
        fail("commit message must be between 1 and 240 UTF-8 bytes")
    if "\n" in message or "\r" in message or "\0" in message:
        fail("commit message must be a single line without NUL bytes")
    return message


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def split_utf8_patch(patch: bytes, *, maximum_bytes: int) -> list[bytes]:
    try:
        patch.decode("utf-8")
    except UnicodeDecodeError as exc:
        fail(
            "multipart transport requires a UTF-8 Git patch; "
            f"invalid byte sequence at offset {exc.start}"
        )

    parts: list[bytes] = []
    offset = 0
    while offset < len(patch):
        end = min(offset + maximum_bytes, len(patch))
        if end < len(patch):
            preferred_start = offset + maximum_bytes // 2
            boundary = -1
            for marker in (b"\ndiff --git ", b"\n@@ "):
                marker_at = patch.rfind(marker, preferred_start, end)
                if marker_at >= offset:
                    boundary = marker_at + 1
                    break
            if boundary < 0:
                newline = patch.rfind(b"\n", offset, end)
                if newline >= offset:
                    boundary = newline + 1
            if boundary >= 0:
                end = boundary
            else:
                while end > offset and (patch[end] & 0xC0) == 0x80:
                    end -= 1
                if end == offset:
                    fail("part size is too small to preserve a UTF-8 code point")
        part = patch[offset:end]
        try:
            part.decode("utf-8")
        except UnicodeDecodeError as exc:
            fail(f"generated part is not UTF-8 at local offset {exc.start}")
        parts.append(part)
        if len(parts) > MAX_PART_COUNT:
            fail(f"patch requires more than {MAX_PART_COUNT} parts")
        offset = end
    return parts


def prepare(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    if not repository.is_dir():
        fail(f"repository does not exist: {repository}")
    if git_text(repository, "rev-parse", "--is-inside-work-tree") != "true":
        fail("repository must be a Git worktree")
    status = git_text(repository, "status", "--porcelain=v1", "--untracked-files=all")
    if status:
        fail("repository must be clean before preparing a publication payload")

    target_branch = validate_branch(
        args.target_branch,
        repository=repository,
        default_branch=args.default_branch,
    )
    tested_commit = require_sha1(
        git_text(repository, "rev-parse", "--verify", f"{args.tested_commit}^{{commit}}"),
        label="tested commit",
    )
    head_sha = require_sha1(
        git_text(repository, "rev-parse", "--verify", "HEAD^{commit}"),
        label="current HEAD",
    )
    if tested_commit != head_sha:
        fail(
            "tested commit must be the current HEAD: "
            f"expected {head_sha}, found {tested_commit}"
        )
    parents = git_text(repository, "show", "-s", "--format=%P", tested_commit).split()
    if len(parents) != 1:
        fail("tested commit must have exactly one parent")
    expected_base_sha = require_sha1(parents[0], label="tested commit parent")
    if args.expected_base_sha is not None:
        expected = require_sha1(args.expected_base_sha, label="expected base SHA")
        if expected != expected_base_sha:
            fail(
                "tested commit parent mismatch: "
                f"expected {expected}, found {expected_base_sha}"
            )

    expected_result_tree_sha = require_sha1(
        git_text(repository, "show", "-s", "--format=%T", tested_commit),
        label="tested result tree",
    )
    commit_message = validate_commit_message(
        git_text(repository, "show", "-s", "--format=%s", tested_commit)
    )

    part_size_kib = args.part_size_kib
    if not 1 <= part_size_kib <= MAX_PART_SIZE_KIB:
        fail(
            f"part size must be between 1 and {MAX_PART_SIZE_KIB} KiB "
            f"(recommended: {DEFAULT_PART_SIZE_KIB} KiB)"
        )
    part_size_bytes = part_size_kib * 1024

    completed = run(
        [
            "git",
            "diff",
            "--binary",
            "--full-index",
            "--no-renames",
            expected_base_sha,
            tested_commit,
        ],
        cwd=repository,
        text=False,
    )
    assert isinstance(completed.stdout, bytes)
    patch = completed.stdout
    if not patch:
        fail("tested commit produces an empty patch")
    if len(patch) > MAX_PATCH_SIZE_BYTES:
        fail(
            f"patch is larger than the {MAX_PATCH_SIZE_BYTES}-byte "
            "publication transport ceiling"
        )
    patch_sha256 = sha256_bytes(patch)
    parts = split_utf8_patch(patch, maximum_bytes=part_size_bytes)
    part_count = len(parts)

    output = args.output_directory.resolve()
    if output.exists():
        fail(f"output path already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_root = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=str(output.parent))
    )
    published = False
    try:
        transfer_root = temp_root / TRANSFER_DIRECTORY
        parts_root = transfer_root / "parts"
        parts_root.mkdir(parents=True)
        manifest_parts: list[dict[str, object]] = []
        for index, part in enumerate(parts, start=1):
            relative_path = (
                f"{PART_DIRECTORY}/change.patch.part-"
                f"{index:04d}-of-{part_count:04d}"
            )
            part_path = temp_root / relative_path
            part_path.write_bytes(part)
            manifest_parts.append(
                {
                    "path": relative_path,
                    "sizeBytes": len(part),
                    "sha256": sha256_bytes(part),
                }
            )

        manifest = {
            "formatVersion": 2,
            "targetBranch": target_branch,
            "expectedBaseSha": expected_base_sha,
            "expectedResultTreeSha": expected_result_tree_sha,
            "patchSizeBytes": len(patch),
            "patchSha256": patch_sha256,
            "parts": manifest_parts,
            "commitMessage": commit_message,
        }
        manifest_path = transfer_root / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

        reconstructed = bytearray()
        for entry in manifest_parts:
            part_path = temp_root / str(entry["path"])
            part = part_path.read_bytes()
            if len(part) != entry["sizeBytes"]:
                fail(f"generated part size changed: {entry['path']}")
            if sha256_bytes(part) != entry["sha256"]:
                fail(f"generated part digest changed: {entry['path']}")
            reconstructed.extend(part)
        if bytes(reconstructed) != patch:
            fail("reconstructed patch is not byte-identical to the original patch")
        if sha256_bytes(bytes(reconstructed)) != patch_sha256:
            fail("reconstructed patch SHA-256 differs from the original patch")

        manifest_sha256 = sha256_bytes(manifest_path.read_bytes())
        os.replace(temp_root, output)
        published = True
    finally:
        if not published:
            shutil.rmtree(temp_root, ignore_errors=True)

    print("prepared multipart patch publication")
    print(f"output={output}")
    print(f"manifestSha256={manifest_sha256}")
    print(f"patchSha256={patch_sha256}")
    print(f"patchSizeBytes={len(patch)}")
    print(f"partCount={part_count}")
    print(f"maximumPartSizeBytes={part_size_bytes}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path("."))
    parser.add_argument("--target-branch", required=True)
    parser.add_argument("--default-branch", default="main")
    parser.add_argument("--tested-commit", default="HEAD")
    parser.add_argument("--expected-base-sha")
    parser.add_argument("--part-size-kib", type=int, default=DEFAULT_PART_SIZE_KIB)
    parser.add_argument("--output-directory", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        prepare(args)
    except PreparationError as exc:
        print(f"prepare-patch-publication: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
