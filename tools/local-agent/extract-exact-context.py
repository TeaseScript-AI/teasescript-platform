#!/usr/bin/env python3
"""Extract one exact bounded byte region from a stable regular file.

Requires Python 3.10 or newer.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path


MAX_TARGET_BYTES = 16 * 1024 * 1024
MAX_SELECTED_BYTES = 16 * 1024
MAX_SELECTED_LINES = 200
MAX_ANCHOR_BYTES = MAX_SELECTED_BYTES
MAX_REPORTED_MATCHES = 3
MAX_DIAGNOSTIC_BYTES = 768

FileFingerprint = tuple[int, int, int, int, int]


@dataclass(frozen=True)
class MatchScan:
    """Bounded exact-match scan result."""

    offsets: tuple[int, ...]
    has_more: bool

    @property
    def is_unique(self) -> bool:
        return len(self.offsets) == 1 and not self.has_more

    def count_text(self) -> str:
        if self.has_more:
            return f"at least {len(self.offsets)}"
        return str(len(self.offsets))


class ExtractExactContextError(Exception):
    """Expected user-facing extraction error with optional detail lines."""

    def __init__(self, message: str, details: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.details = details


def fingerprint(stat_result: os.stat_result) -> FileFingerprint:
    """Return metadata used to detect a concurrent target change."""
    return (
        stat_result.st_dev,
        stat_result.st_ino,
        stat_result.st_size,
        stat_result.st_mtime_ns,
        stat_result.st_ctime_ns,
    )


def display_path(path: Path) -> str:
    """Render a path without allowing control characters to add diagnostics."""
    return (
        str(path)
        .replace("\\", "\\\\")
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
        .replace("\0", "\\0")
    )


def read_stable_target(path: Path) -> tuple[bytes, FileFingerprint]:
    """Read one bounded regular non-symlink target and prove read stability."""
    try:
        initial = path.lstat()
    except OSError as exc:
        raise ExtractExactContextError(
            f"unable to inspect target {display_path(path)}: {exc}"
        ) from exc

    if stat.S_ISLNK(initial.st_mode):
        raise ExtractExactContextError(
            f"target must not be a symbolic link: {display_path(path)}"
        )
    if not stat.S_ISREG(initial.st_mode):
        raise ExtractExactContextError(
            f"target must be a regular file: {display_path(path)}"
        )
    if initial.st_size > MAX_TARGET_BYTES:
        raise ExtractExactContextError(
            f"target is {initial.st_size} bytes; limit is {MAX_TARGET_BYTES}"
        )

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        file_descriptor = os.open(path, flags)
    except OSError as exc:
        raise ExtractExactContextError(
            f"unable to open target {display_path(path)}: {exc}"
        ) from exc

    try:
        before = os.fstat(file_descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ExtractExactContextError(
                f"target must be a regular file: {display_path(path)}"
            )
        if fingerprint(before) != fingerprint(initial):
            raise ExtractExactContextError(
                f"target changed while being opened: {display_path(path)}"
            )
        if before.st_size > MAX_TARGET_BYTES:
            raise ExtractExactContextError(
                f"target is {before.st_size} bytes; limit is {MAX_TARGET_BYTES}"
            )

        with os.fdopen(file_descriptor, "rb") as target_file:
            file_descriptor = -1
            content = target_file.read(MAX_TARGET_BYTES + 1)
            after = os.fstat(target_file.fileno())
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)

    if len(content) > MAX_TARGET_BYTES:
        raise ExtractExactContextError(
            f"target exceeds {MAX_TARGET_BYTES} bytes; no context was read"
        )

    expected = fingerprint(before)
    if fingerprint(after) != expected:
        raise ExtractExactContextError(
            f"target changed while being read: {display_path(path)}"
        )

    return content, expected


def require_unchanged_target(path: Path, expected: FileFingerprint) -> None:
    """Fail when the target path changed after the bounded read."""
    try:
        current = path.lstat()
    except OSError as exc:
        raise ExtractExactContextError(
            f"target changed after it was read: {display_path(path)}"
        ) from exc

    if not stat.S_ISREG(current.st_mode) or fingerprint(current) != expected:
        raise ExtractExactContextError(
            f"target changed after it was read: {display_path(path)}"
        )


def read_anchor_file(path: Path, label: str) -> bytes:
    """Read one byte-exact anchor file with a strict size bound."""
    try:
        anchor_stat = path.stat()
    except OSError as exc:
        raise ExtractExactContextError(
            f"unable to inspect {label} anchor file {display_path(path)}: {exc}"
        ) from exc
    if not stat.S_ISREG(anchor_stat.st_mode):
        raise ExtractExactContextError(
            f"{label} anchor must be a regular file: {display_path(path)}"
        )
    if anchor_stat.st_size > MAX_ANCHOR_BYTES:
        raise ExtractExactContextError(
            f"{label} anchor exceeds {MAX_ANCHOR_BYTES} bytes"
        )

    try:
        with path.open("rb") as anchor_file:
            anchor = anchor_file.read(MAX_ANCHOR_BYTES + 1)
    except OSError as exc:
        raise ExtractExactContextError(
            f"unable to read {label} anchor file {display_path(path)}: {exc}"
        ) from exc

    if len(anchor) > MAX_ANCHOR_BYTES:
        raise ExtractExactContextError(
            f"{label} anchor exceeds {MAX_ANCHOR_BYTES} bytes"
        )
    return anchor


def input_bytes(file_path: Path | None, text: str | None, label: str) -> bytes:
    """Resolve one byte-exact file or direct UTF-8 anchor."""
    if file_path is not None:
        anchor = read_anchor_file(file_path, label)
    elif text is not None:
        anchor = text.encode("utf-8")
    else:
        raise ExtractExactContextError(f"missing {label} anchor")

    if not anchor:
        raise ExtractExactContextError(f"{label} anchor must not be empty")
    if len(anchor) > MAX_ANCHOR_BYTES:
        raise ExtractExactContextError(
            f"{label} anchor is {len(anchor)} bytes; limit is {MAX_ANCHOR_BYTES}"
        )
    return anchor


def scan_matches(content: bytes, anchor: bytes) -> MatchScan:
    """Find enough overlapping exact occurrences to prove uniqueness or ambiguity."""
    offsets: list[int] = []
    position = 0
    scan_limit = MAX_REPORTED_MATCHES + 1

    while len(offsets) < scan_limit:
        offset = content.find(anchor, position)
        if offset < 0:
            return MatchScan(tuple(offsets), False)
        offsets.append(offset)
        position = offset + 1

    return MatchScan(tuple(offsets), True)


def line_number(content: bytes, offset: int) -> int:
    """Return the 1-based LF-delimited line containing offset."""
    return content.count(b"\n", 0, offset) + 1


def match_location(path: Path, content: bytes, offset: int, anchor: bytes) -> str:
    """Render one compact 1-based line location for an anchor match."""
    start_line = line_number(content, offset)
    end_line = line_number(content, offset + len(anchor) - 1)
    line_range = str(start_line) if start_line == end_line else f"{start_line}-{end_line}"
    return f"- {display_path(path)}:{line_range}"


def ambiguity_details(
    label: str,
    path: Path,
    content: bytes,
    anchor: bytes,
    scan: MatchScan,
) -> tuple[str, ...]:
    """Return bounded exact locations and one corrective instruction."""
    locations = tuple(
        match_location(path, content, offset, anchor)
        for offset in scan.offsets[:MAX_REPORTED_MATCHES]
    )
    return (
        f"{label} matches:",
        *locations,
        f"add more exact text to the {label} anchor",
    )


def validate_unique_anchor(
    label: str,
    path: Path,
    content: bytes,
    anchor: bytes,
) -> int:
    """Require exactly one exact anchor occurrence and return its byte offset."""
    scan = scan_matches(content, anchor)
    if scan.is_unique:
        return scan.offsets[0]

    details: tuple[str, ...] = ()
    if scan.offsets:
        details = ambiguity_details(label, path, content, anchor, scan)
    raise ExtractExactContextError(
        f"{label} anchor expected 1 match, found {scan.count_text()}",
        details,
    )


def selected_line_count(content: bytes) -> int:
    """Count non-empty LF-delimited logical lines in a selected byte region."""
    if not content:
        return 0
    return content.count(b"\n") + (0 if content.endswith(b"\n") else 1)


def extract_exact_context(target: Path, start: bytes, end: bytes) -> bytes:
    """Extract one inclusive exact region after fail-closed bounded validation."""
    if not start:
        raise ExtractExactContextError("start anchor must not be empty")
    if not end:
        raise ExtractExactContextError("end anchor must not be empty")
    if len(start) > MAX_ANCHOR_BYTES:
        raise ExtractExactContextError(
            f"start anchor is {len(start)} bytes; limit is {MAX_ANCHOR_BYTES}"
        )
    if len(end) > MAX_ANCHOR_BYTES:
        raise ExtractExactContextError(
            f"end anchor is {len(end)} bytes; limit is {MAX_ANCHOR_BYTES}"
        )

    content, target_fingerprint = read_stable_target(target)
    start_offset = validate_unique_anchor("start", target, content, start)
    end_offset = validate_unique_anchor("end", target, content, end)

    if end_offset < start_offset:
        raise ExtractExactContextError(
            "end anchor occurs before start anchor",
            (
                match_location(target, content, start_offset, start),
                match_location(target, content, end_offset, end),
            ),
        )

    if end_offset < start_offset + len(start):
        raise ExtractExactContextError(
            "start and end anchors overlap; use non-overlapping exact boundaries",
            (
                match_location(target, content, start_offset, start),
                match_location(target, content, end_offset, end),
            ),
        )

    selected = content[start_offset : end_offset + len(end)]
    if len(selected) > MAX_SELECTED_BYTES:
        raise ExtractExactContextError(
            f"selected region is {len(selected)} bytes; limit is {MAX_SELECTED_BYTES}"
        )

    lines = selected_line_count(selected)
    if lines > MAX_SELECTED_LINES:
        raise ExtractExactContextError(
            f"selected region is {lines} lines; limit is {MAX_SELECTED_LINES}"
        )

    require_unchanged_target(target, target_fingerprint)
    return selected


def bounded_diagnostic(error: ExtractExactContextError) -> bytes:
    """Render one useful diagnostic under the strict stderr byte cap."""
    lines = [f"extract-exact-context: error: {error}", *error.details]
    lines.append("no context was emitted")
    output = ("\n".join(lines) + "\n").encode("utf-8", "backslashreplace")
    if len(output) <= MAX_DIAGNOSTIC_BYTES:
        return output

    suffix = b"\n... diagnostic truncated ...\nno context was emitted\n"
    prefix_limit = MAX_DIAGNOSTIC_BYTES - len(suffix)
    prefix = output[:prefix_limit].decode("utf-8", "ignore").encode("utf-8")
    return prefix.rstrip(b"\n") + suffix


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Extract one inclusive exact byte region from a stable regular file. "
            "Success writes only the selected bytes to stdout."
        )
    )
    parser.add_argument("--file", required=True, type=Path, help="Target file")

    start_group = parser.add_mutually_exclusive_group(required=True)
    start_group.add_argument(
        "--start-file",
        type=Path,
        help="File containing the exact non-empty start anchor bytes",
    )
    start_group.add_argument(
        "--start-text",
        help="Direct UTF-8 start anchor; must not be empty",
    )

    end_group = parser.add_mutually_exclusive_group(required=True)
    end_group.add_argument(
        "--end-file",
        type=Path,
        help="File containing the exact non-empty end anchor bytes",
    )
    end_group.add_argument(
        "--end-text",
        help="Direct UTF-8 end anchor; must not be empty",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        selected = extract_exact_context(
            target=args.file,
            start=input_bytes(args.start_file, args.start_text, "start"),
            end=input_bytes(args.end_file, args.end_text, "end"),
        )
    except ExtractExactContextError as exc:
        sys.stderr.buffer.write(bounded_diagnostic(exc))
        return 1

    try:
        sys.stdout.buffer.write(selected)
        sys.stdout.buffer.flush()
    except OSError as exc:
        print(f"extract-exact-context: output error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
