#!/usr/bin/env python3
"""Apply a versioned batch of exact replacements in one Python process.

Requires Python 3.10 or newer. Uses replace-exact.py as the write primitive.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CORE_PATH = Path(__file__).with_name("replace-exact.py")
CORE_SPEC = importlib.util.spec_from_file_location("replace_exact_core", CORE_PATH)
if CORE_SPEC is None or CORE_SPEC.loader is None:
    raise RuntimeError(f"Unable to load {CORE_PATH}")
CORE = importlib.util.module_from_spec(CORE_SPEC)
sys.modules[CORE_SPEC.name] = CORE
CORE_SPEC.loader.exec_module(CORE)

FORMAT_VERSION = 1
MAX_OPERATIONS = 1_000


class BatchPartiallyAppliedError(CORE.ReplaceExactError):
    """A write failed after an earlier target was already replaced."""


@dataclass(frozen=True)
class Operation:
    index: int
    target: Path
    old: bytes
    new: bytes
    expected_count: int


@dataclass
class PreparedTarget:
    path: Path
    original: bytes
    updated: bytes
    mode: int
    fingerprint: CORE.FileFingerprint
    matches: int = 0


@dataclass(frozen=True)
class BatchResult:
    operations: int
    files: int
    changed_files: int
    matches: int
    old_size: int
    new_size: int


def absolute_path(value: str) -> Path:
    """Normalize relative aliases without following a target symlink."""
    return Path(os.path.abspath(value))


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise CORE.ReplaceExactError(f"{label} must be a JSON object")
    return value


def require_nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CORE.ReplaceExactError(f"{label} must be a non-empty string")
    return value


def operation_bytes(
    operation: dict[str, Any],
    *,
    text_key: str,
    file_key: str,
    index: int,
    allow_empty: bool,
) -> bytes:
    present = [key for key in (text_key, file_key) if key in operation]
    if len(present) != 1:
        raise CORE.ReplaceExactError(
            f"operations[{index}] must contain exactly one of {text_key} or {file_key}"
        )

    if text_key in operation:
        value = operation[text_key]
        if not isinstance(value, str):
            raise CORE.ReplaceExactError(
                f"operations[{index}].{text_key} must be a string"
            )
        data = value.encode("utf-8")
    else:
        file_value = require_nonempty_string(
            operation[file_key],
            f"operations[{index}].{file_key}",
        )
        data = CORE.read_bytes(
            Path(file_value),
            f"operations[{index}] {file_key} input",
        )

    if not allow_empty and not data:
        raise CORE.ReplaceExactError(
            f"operations[{index}] old content must not be empty"
        )
    return data


def load_plan(path: Path) -> list[Operation]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise CORE.ReplaceExactError(f"Plan must be UTF-8 text: {path}") from exc
    except OSError as exc:
        raise CORE.ReplaceExactError(f"Unable to read plan {path}: {exc}") from exc

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CORE.ReplaceExactError(
            f"Invalid JSON in {path} at {exc.lineno}:{exc.colno}: {exc.msg}"
        ) from exc

    plan = require_object(raw, "Plan")
    expected_plan_keys = {"formatVersion", "operations"}
    unknown = sorted(set(plan) - expected_plan_keys)
    if unknown:
        raise CORE.ReplaceExactError(f"Unknown plan field(s): {', '.join(unknown)}")
    missing = sorted(expected_plan_keys - set(plan))
    if missing:
        raise CORE.ReplaceExactError(f"Missing plan field(s): {', '.join(missing)}")
    if type(plan["formatVersion"]) is not int or plan["formatVersion"] != FORMAT_VERSION:
        raise CORE.ReplaceExactError(f"formatVersion must be the integer {FORMAT_VERSION}")

    raw_operations = plan["operations"]
    if not isinstance(raw_operations, list) or not raw_operations:
        raise CORE.ReplaceExactError("operations must be a non-empty JSON array")
    if len(raw_operations) > MAX_OPERATIONS:
        raise CORE.ReplaceExactError(f"operations exceeds the limit of {MAX_OPERATIONS}")

    allowed_keys = {
        "file",
        "oldText",
        "oldFile",
        "newText",
        "newFile",
        "expectedCount",
    }
    operations: list[Operation] = []
    for index, raw_operation in enumerate(raw_operations):
        operation = require_object(raw_operation, f"operations[{index}]")
        unknown = sorted(set(operation) - allowed_keys)
        if unknown:
            raise CORE.ReplaceExactError(
                f"Unknown field(s) in operations[{index}]: {', '.join(unknown)}"
            )
        if "file" not in operation:
            raise CORE.ReplaceExactError(f"operations[{index}] is missing file")

        target = absolute_path(
            require_nonempty_string(operation["file"], f"operations[{index}].file")
        )
        expected_count = operation.get("expectedCount", 1)
        if type(expected_count) is not int or expected_count < 1:
            raise CORE.ReplaceExactError(
                f"operations[{index}].expectedCount must be a positive integer"
            )

        operations.append(
            Operation(
                index=index,
                target=target,
                old=operation_bytes(
                    operation,
                    text_key="oldText",
                    file_key="oldFile",
                    index=index,
                    allow_empty=False,
                ),
                new=operation_bytes(
                    operation,
                    text_key="newText",
                    file_key="newFile",
                    index=index,
                    allow_empty=True,
                ),
                expected_count=expected_count,
            )
        )
    return operations


def prepare(operations: list[Operation]) -> list[PreparedTarget]:
    """Read each target once and simulate operations in listed order."""
    targets: dict[Path, PreparedTarget] = {}
    for operation in operations:
        target = targets.get(operation.target)
        if target is None:
            original, target_stat, fingerprint = CORE.read_stable_target(operation.target)
            target = PreparedTarget(
                path=operation.target,
                original=original,
                updated=original,
                mode=target_stat.st_mode,
                fingerprint=fingerprint,
            )
            targets[operation.target] = target

        count = target.updated.count(operation.old)
        if count != operation.expected_count:
            raise CORE.ReplaceExactError(
                f"operations[{operation.index}] expected {operation.expected_count} "
                f"match(es) in {operation.target}, found {count}; "
                "no batch target was modified"
            )
        target.updated = target.updated.replace(operation.old, operation.new)
        target.matches += count
    return list(targets.values())


def apply(targets: list[PreparedTarget]) -> int:
    """Write each changed target once after all validation has succeeded."""
    applied: list[Path] = []
    for target in targets:
        if target.updated == target.original:
            continue
        try:
            CORE.atomic_write(
                target.path,
                target.updated,
                target.mode,
                target.fingerprint,
            )
        except CORE.ReplaceExactError as exc:
            if applied:
                applied_text = ", ".join(str(path) for path in applied)
                raise BatchPartiallyAppliedError(
                    f"Batch failed at {target.path} after replacing "
                    f"{len(applied)} file(s): {applied_text}; "
                    "inspect all targets before retrying"
                ) from exc
            raise
        applied.append(target.path)
    return len(applied)


def run_plan(path: Path, dry_run: bool) -> BatchResult:
    operations = load_plan(path)
    targets = prepare(operations)
    changed = sum(target.updated != target.original for target in targets)
    if not dry_run:
        apply(targets)
    return BatchResult(
        operations=len(operations),
        files=len(targets),
        changed_files=changed,
        matches=sum(target.matches for target in targets),
        old_size=sum(len(target.original) for target in targets),
        new_size=sum(len(target.updated) for target in targets),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply a version-1 exact-replacement batch plan."
    )
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        result = run_plan(args.plan, args.dry_run)
    except (CORE.ReplacementAppliedButUnsyncedError, BatchPartiallyAppliedError) as exc:
        print(f"replace-exact-batch: warning: {exc}", file=sys.stderr)
        return 2
    except CORE.ReplaceExactError as exc:
        print(f"replace-exact-batch: error: {exc}", file=sys.stderr)
        return 1

    action = "validated" if args.dry_run else "replaced"
    if result.changed_files == 0:
        action = "unchanged"
    print(
        f"replace-exact-batch: {action} {result.operations} operation(s) "
        f"with {result.matches} match(es) in {result.files} file(s); "
        f"changed {result.changed_files} file(s) "
        f"({result.old_size} -> {result.new_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
