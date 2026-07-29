#!/usr/bin/env python3
"""Atomically replace an exact byte sequence in one regular file.

Requires Python 3.10 or newer.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
import tempfile
from pathlib import Path


FileFingerprint = tuple[int, int, int, int, int]


class ReplaceExactError(Exception):
    """Expected, user-facing replacement error."""


class ReplacementAppliedButUnsyncedError(ReplaceExactError):
    """The target was replaced, but the parent directory could not be synced."""


def positive_int(value: str) -> int:
    """Parse a strictly positive integer."""
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc

    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def read_bytes(path: Path, label: str) -> bytes:
    """Read a file as bytes and produce a clear error on failure."""
    try:
        return path.read_bytes()
    except OSError as exc:
        raise ReplaceExactError(f"Unable to read {label} {path}: {exc}") from exc


def fingerprint(stat_result: os.stat_result) -> FileFingerprint:
    """Return metadata used to detect a concurrent target change."""
    return (
        stat_result.st_dev,
        stat_result.st_ino,
        stat_result.st_size,
        stat_result.st_mtime_ns,
        stat_result.st_ctime_ns,
    )


def read_stable_target(path: Path) -> tuple[bytes, os.stat_result, FileFingerprint]:
    """Read one regular non-symlink target and ensure it stayed stable."""
    try:
        initial = path.lstat()
    except OSError as exc:
        raise ReplaceExactError(f"Unable to inspect target {path}: {exc}") from exc

    if stat.S_ISLNK(initial.st_mode):
        raise ReplaceExactError(f"Target must not be a symbolic link: {path}")
    if not stat.S_ISREG(initial.st_mode):
        raise ReplaceExactError(f"Target must be a regular file: {path}")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        file_descriptor = os.open(path, flags)
    except OSError as exc:
        raise ReplaceExactError(f"Unable to open target {path}: {exc}") from exc

    try:
        before = os.fstat(file_descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ReplaceExactError(f"Target must be a regular file: {path}")

        with os.fdopen(file_descriptor, "rb") as target_file:
            file_descriptor = -1
            content = target_file.read()
            after = os.fstat(target_file.fileno())
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)

    before_fingerprint = fingerprint(before)
    if fingerprint(after) != before_fingerprint:
        raise ReplaceExactError(
            f"Target changed during validation: {path}; replacement was not applied"
        )

    return content, before, before_fingerprint


def require_unchanged_target(path: Path, expected: FileFingerprint) -> None:
    """Stop when the target path changed after it was validated."""
    try:
        current = path.lstat()
    except OSError as exc:
        raise ReplaceExactError(
            f"Target changed after validation: {path}; replacement was not applied"
        ) from exc

    if not stat.S_ISREG(current.st_mode) or fingerprint(current) != expected:
        raise ReplaceExactError(
            f"Target changed after validation: {path}; replacement was not applied"
        )


def sync_parent_directory(path: Path) -> None:
    """Synchronize the directory entry after an atomic replacement."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_fd = os.open(path.parent, flags)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def atomic_write(
    path: Path,
    data: bytes,
    mode: int,
    expected_fingerprint: FileFingerprint,
) -> None:
    """Atomically replace path while preserving its Unix permission bits."""
    temp_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{path.name}.replace-exact.",
            dir=path.parent,
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            os.fchmod(temp_file.fileno(), stat.S_IMODE(mode))
            temp_file.write(data)
            temp_file.flush()
            os.fsync(temp_file.fileno())

        require_unchanged_target(path, expected_fingerprint)
        try:
            os.replace(temp_path, path)
        except OSError as exc:
            raise ReplaceExactError(
                f"Unable to replace {path}; target was not modified: {exc}"
            ) from exc

        temp_path = None

        try:
            sync_parent_directory(path)
        except OSError as exc:
            raise ReplacementAppliedButUnsyncedError(
                f"Replacement was applied to {path}, but directory "
                f"synchronization failed: {exc}"
            ) from exc
    except ReplaceExactError:
        raise
    except OSError as exc:
        raise ReplaceExactError(
            f"Unable to prepare atomic replacement for {path}; "
            f"target was not modified: {exc}"
        ) from exc
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def replace_exact_content(
    target: Path,
    old: bytes,
    new: bytes,
    expected_count: int,
    dry_run: bool,
) -> tuple[int, int, int, bool]:
    """Validate and optionally apply an exact byte replacement."""
    original, target_stat, target_fingerprint = read_stable_target(target)

    if not old:
        raise ReplaceExactError("Old content must not be empty")

    actual_count = original.count(old)
    if actual_count != expected_count:
        raise ReplaceExactError(
            f"Expected {expected_count} match(es) in {target}, found {actual_count}; "
            "target was not modified"
        )

    updated = original.replace(old, new)
    changed = updated != original

    if not dry_run and changed:
        atomic_write(
            target,
            updated,
            target_stat.st_mode,
            target_fingerprint,
        )

    return actual_count, len(original), len(updated), changed


def replace_exact(
    target: Path,
    old_file: Path,
    new_file: Path,
    expected_count: int,
    dry_run: bool,
) -> tuple[int, int, int, bool]:
    """Replace bytes loaded from two snippet files."""
    return replace_exact_content(
        target=target,
        old=read_bytes(old_file, "old-content file"),
        new=read_bytes(new_file, "new-content file"),
        expected_count=expected_count,
        dry_run=dry_run,
    )


def input_bytes(file_path: Path | None, text: str | None, label: str) -> bytes:
    """Resolve exactly one file or direct UTF-8 text input."""
    if file_path is not None:
        return read_bytes(file_path, f"{label}-content file")
    if text is not None:
        return text.encode("utf-8")
    raise ReplaceExactError(f"Missing {label} input")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Replace an exact byte sequence in one regular file only when the "
            "sequence occurs the expected number of times."
        )
    )
    parser.add_argument("--file", required=True, type=Path, help="Target file")
    old_group = parser.add_mutually_exclusive_group(required=True)
    old_group.add_argument(
        "--old",
        type=Path,
        help="File containing the exact non-empty byte sequence to replace",
    )
    old_group.add_argument(
        "--old-text",
        help="Direct UTF-8 text to replace; must not be empty",
    )

    new_group = parser.add_mutually_exclusive_group(required=True)
    new_group.add_argument(
        "--new",
        type=Path,
        help="File containing the replacement bytes; may be empty",
    )
    new_group.add_argument(
        "--new-text",
        help="Direct UTF-8 replacement text; may be empty for deletion",
    )
    parser.add_argument(
        "--expected-count",
        type=positive_int,
        default=1,
        help="Required number of non-overlapping matches (default: 1)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Validate target, snippets, and match count without writing; "
            "this does not prove a later atomic write will succeed"
        ),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    try:
        count, old_size, new_size, changed = replace_exact_content(
            target=args.file,
            old=input_bytes(args.old, args.old_text, "old"),
            new=input_bytes(args.new, args.new_text, "new"),
            expected_count=args.expected_count,
            dry_run=args.dry_run,
        )
    except ReplacementAppliedButUnsyncedError as exc:
        print(f"replace-exact: warning: {exc}", file=sys.stderr)
        return 2
    except ReplaceExactError as exc:
        print(f"replace-exact: error: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        action = "validated"
    elif changed:
        action = "replaced"
    else:
        action = "unchanged"

    print(
        f"replace-exact: {action} {count} match(es) in {args.file} "
        f"({old_size} -> {new_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
