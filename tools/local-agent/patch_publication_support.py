#!/usr/bin/env python3
"""Shared deterministic helpers for local patch-publication preparation."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, NoReturn


TRANSFER_PREFIX = "agent-patch-publication/"
TRANSFER_DIRECTORY = ".agent-patch-publication"
PART_DIRECTORY = f"{TRANSFER_DIRECTORY}/parts"
UPLOAD_PLAN_NAME = "upload-plan.json"
UPLOAD_STATE_NAME = "upload-state.json"
UPLOAD_INSTRUCTIONS_NAME = "UPLOAD-INSTRUCTIONS.md"
DEFAULT_PART_SIZE_KIB = 12
DEFAULT_TARGET_PART_TOKENS = 3_000
MAX_PART_SIZE_KIB = 256
MAX_PART_COUNT = 1024
MAX_PATCH_SIZE_BYTES = 64 * 1024 * 1024
O200K_BASE_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
O200K_PATTERN = "|".join(
    [
        r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
        r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
        r"""\p{N}{1,3}""",
        r""" ?[^\s\p{L}\p{N}]+[\r\n/]*""",
        r"""\s*[\r\n]+""",
        r"""\s+(?!\S)""",
        r"""\s+""",
    ]
)


class PreparationError(RuntimeError):
    """Expected local preparation or upload-guidance failure."""


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


def validate_transfer_branch(branch: str, *, repository: Path) -> str:
    if not branch.startswith(TRANSFER_PREFIX):
        fail(f"transfer branch must start with {TRANSFER_PREFIX}")
    completed = subprocess.run(
        ["git", "check-ref-format", "--branch", branch],
        cwd=repository,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        fail("transfer branch is not a valid Git branch name")
    return branch


def validate_commit_message(message: str) -> str:
    if not message or len(message.encode("utf-8")) > 240:
        fail("commit message must be between 1 and 240 UTF-8 bytes")
    if "\n" in message or "\r" in message or "\0" in message:
        fail("commit message must be a single line without NUL bytes")
    return message


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def git_blob_sha(value: bytes) -> str:
    header = f"blob {len(value)}\0".encode("ascii")
    return hashlib.sha1(header + value).hexdigest()


def ensure_utf8(value: bytes, *, label: str) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError as exc:
        fail(f"{label} is not UTF-8 at byte offset {exc.start}")


@dataclass(frozen=True)
class TokenEstimator:
    count_bytes: Callable[[bytes], int]
    vocabulary_path: Path
    vocabulary_sha256: str


def load_token_estimator(path: Path) -> TokenEstimator:
    resolved = path.resolve()
    if not resolved.is_file():
        fail(f"tokenizer vocabulary does not exist: {resolved}")
    vocabulary = resolved.read_bytes()
    digest = sha256_bytes(vocabulary)
    if digest != O200K_BASE_SHA256:
        fail(
            "o200k_base tokenizer SHA-256 mismatch: "
            f"expected {O200K_BASE_SHA256}, found {digest}"
        )
    try:
        import tiktoken  # type: ignore[import-not-found]
        from tiktoken.load import load_tiktoken_bpe  # type: ignore[import-not-found]
    except ImportError as exc:
        raise PreparationError(
            "token-aware splitting requires the local tiktoken Python package; "
            "omit --tokenizer for byte fallback or add tiktoken to the offline toolchain"
        ) from exc

    ranks = load_tiktoken_bpe(str(resolved), expected_hash=O200K_BASE_SHA256)
    encoding = tiktoken.Encoding(
        name="local_o200k_base",
        pat_str=O200K_PATTERN,
        mergeable_ranks=ranks,
        special_tokens={"<|endoftext|>": 199999, "<|endofprompt|>": 200018},
    )

    def count_connector_content(value: bytes) -> int:
        text = ensure_utf8(value, label="candidate part")
        serialized = json.dumps(text, ensure_ascii=False)
        return len(encoding.encode_ordinary(serialized))

    return TokenEstimator(
        count_bytes=count_connector_content,
        vocabulary_path=resolved,
        vocabulary_sha256=digest,
    )


def utf8_boundary_at_or_before(value: bytes, offset: int, *, floor: int) -> int:
    offset = min(offset, len(value))
    while offset > floor and offset < len(value) and (value[offset] & 0xC0) == 0x80:
        offset -= 1
    return offset


def preferred_boundary(value: bytes, *, start: int, end: int) -> int:
    preferred_start = start + (end - start) // 2
    for marker in (b"\ndiff --git ", b"\n@@ "):
        marker_at = value.rfind(marker, preferred_start, end)
        if marker_at >= start:
            return marker_at + 1
    newline = value.rfind(b"\n", preferred_start, end)
    if newline >= start:
        return newline + 1
    return end


def largest_token_bounded_end(
    patch: bytes,
    *,
    start: int,
    hard_end: int,
    target_tokens: int,
    count_tokens: Callable[[bytes], int],
) -> int:
    if count_tokens(patch[start:hard_end]) <= target_tokens:
        return hard_end

    low = start + 1
    high = hard_end
    best = start
    while low <= high:
        middle = utf8_boundary_at_or_before(
            patch, (low + high) // 2, floor=start
        )
        if middle <= start:
            low = max(low + 1, (low + high) // 2 + 1)
            continue
        count = count_tokens(patch[start:middle])
        if count <= target_tokens:
            best = middle
            low = middle + 1
        else:
            high = middle - 1
    if best == start:
        fail(
            "target token count is too small to hold one UTF-8 code point; "
            "increase --target-part-tokens"
        )
    return best


def split_utf8_patch(
    patch: bytes,
    *,
    maximum_bytes: int,
    target_tokens: int | None = None,
    count_tokens: Callable[[bytes], int] | None = None,
) -> tuple[list[bytes], list[int | None]]:
    ensure_utf8(patch, label="multipart Git patch")
    if target_tokens is None and count_tokens is not None:
        fail("internal error: token counter supplied without a token target")
    if target_tokens is not None and count_tokens is None:
        fail("internal error: token target supplied without a token counter")

    parts: list[bytes] = []
    token_counts: list[int | None] = []
    offset = 0
    while offset < len(patch):
        hard_end = utf8_boundary_at_or_before(
            patch, min(offset + maximum_bytes, len(patch)), floor=offset
        )
        if hard_end <= offset:
            fail("part byte ceiling is too small to preserve a UTF-8 code point")
        end = hard_end
        if target_tokens is not None and count_tokens is not None:
            end = largest_token_bounded_end(
                patch,
                start=offset,
                hard_end=hard_end,
                target_tokens=target_tokens,
                count_tokens=count_tokens,
            )
        if end < len(patch):
            end = preferred_boundary(patch, start=offset, end=end)
        part = patch[offset:end]
        ensure_utf8(part, label="generated part")
        token_count = count_tokens(part) if count_tokens is not None else None
        if token_count is not None and target_tokens is not None and token_count > target_tokens:
            fail("generated part exceeds the configured token target")
        parts.append(part)
        token_counts.append(token_count)
        if len(parts) > MAX_PART_COUNT:
            fail(f"patch requires more than {MAX_PART_COUNT} parts")
        offset = end
    return parts, token_counts


def sanitize_branch_component(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return sanitized[:100] or "patch"


def infer_repository_full_name(repository: Path) -> str | None:
    try:
        remote = git_text(repository, "remote", "get-url", "origin")
    except PreparationError:
        return None
    patterns = (
        r"^(?:https?://|ssh://git@)github\.com/(?P<name>[^/]+/[^/]+?)(?:\.git)?$",
        r"^git@github\.com:(?P<name>[^/]+/[^/]+?)(?:\.git)?$",
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, remote)
        if match:
            return match.group("name")
    return None


def write_json_atomic(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    os.replace(temporary, path)


def load_json_object(path: Path, *, label: str) -> dict[str, object]:
    if not path.is_file():
        fail(f"{label} does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreparationError(
            f"{label} is not valid UTF-8 JSON: {path}"
        ) from exc
    if not isinstance(value, dict):
        fail(f"{label} must contain one JSON object")
    return value
