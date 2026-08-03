#!/usr/bin/env python3
"""Validate, prepare, and verify patch-publication requests.

This tool is intentionally standard-library only. The trusted workflow invokes it
from the default branch. It never fetches from GitHub and never pushes a ref.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, NoReturn


TRANSFER_PREFIX = "agent-patch-publication/"
TRANSFER_DIRECTORY = ".agent-patch-publication"
PART_DIRECTORY = f"{TRANSFER_DIRECTORY}/parts"
CANDIDATE_REF = "refs/heads/patch-publication-candidate"
MAX_PART_SIZE_BYTES = 256 * 1024
MAX_PART_COUNT = 1024
MAX_PATCH_SIZE_BYTES = 64 * 1024 * 1024
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
VALIDATION_PROFILES = frozenset({"docs", "source", "full"})
ROOT_DOCUMENTATION_PATHS = frozenset(
    {
        "AGENTS.md",
        "CURRENT-DESIGN.md",
        "PHASE-STATUS.md",
        "README-FIRST.md",
        "README.md",
        "WISHES.xml",
    }
)
SOURCE_PATH_PREFIXES = ("examples/", "playground/", "src/", "tests/")
SOURCE_EXACT_PATHS = frozenset(
    {
        ".nvmrc",
        "package-lock.json",
        "package.json",
        "tools/test-output-filter.mjs",
        "tsconfig.json",
    }
)
FULL_VALIDATION_PREFIXES = (".github/", "tools/local-agent/")


class PublicationError(RuntimeError):
    """Expected validation or Git-operation failure."""


@dataclass(frozen=True)
class PatchPart:
    path: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class Manifest:
    target_branch: str
    expected_base_sha: str
    expected_result_tree_sha: str
    patch_size_bytes: int
    patch_sha256: str
    parts: tuple[PatchPart, ...]
    commit_message: str


@dataclass(frozen=True)
class PublicationMetadata:
    target_branch: str
    transfer_branch: str
    expected_base_sha: str
    expected_result_tree_sha: str
    patch_sha256: str
    candidate_commit_sha: str
    commit_message: str
    validation_profile: str


def fail(message: str) -> NoReturn:
    raise PublicationError(message)


def require_validation_profile(value: str, *, label: str) -> str:
    if value not in VALIDATION_PROFILES:
        fail(f"{label} must be one of: docs, source, full")
    return value


def validation_profile_for_paths(paths: Iterable[str]) -> str:
    """Return the narrowest safe validation profile for exact changed paths."""

    changed_paths = tuple(paths)
    if not changed_paths:
        fail("cannot classify an empty candidate change")

    def is_documentation(path: str) -> bool:
        return path in ROOT_DOCUMENTATION_PATHS or (
            path.startswith("docs/") and path.endswith(".md")
        )

    def is_source(path: str) -> bool:
        return path in SOURCE_EXACT_PATHS or path.startswith(SOURCE_PATH_PREFIXES)

    if any(path.startswith(FULL_VALIDATION_PREFIXES) for path in changed_paths):
        return "full"
    if all(is_documentation(path) for path in changed_paths):
        return "docs"
    if all(is_documentation(path) or is_source(path) for path in changed_paths):
        return "source"
    return "full"


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def load_json_object(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        fail(f"cannot read UTF-8 JSON file {path}: {exc}")
    try:
        value = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, PublicationError) as exc:
        fail(f"invalid JSON in {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"JSON root in {path} must be an object")
    return value


def require_exact_fields(
    value: Mapping[str, Any], expected: Iterable[str], *, label: str
) -> None:
    expected_set = set(expected)
    actual_set = set(value)
    missing = sorted(expected_set - actual_set)
    unknown = sorted(actual_set - expected_set)
    if missing:
        fail(f"{label} is missing field(s): {', '.join(missing)}")
    if unknown:
        fail(f"{label} contains unknown field(s): {', '.join(unknown)}")


def require_string(value: Mapping[str, Any], key: str, *, label: str) -> str:
    item = value[key]
    if not isinstance(item, str):
        fail(f"{label}.{key} must be a string")
    return item


def require_int(value: Mapping[str, Any], key: str, *, label: str) -> int:
    item = value[key]
    if type(item) is not int:
        fail(f"{label}.{key} must be an integer")
    return item


def require_list(value: Mapping[str, Any], key: str, *, label: str) -> list[Any]:
    item = value[key]
    if not isinstance(item, list):
        fail(f"{label}.{key} must be an array")
    return item


def require_sha1(value: str, *, label: str) -> str:
    if not SHA1_RE.fullmatch(value):
        fail(f"{label} must be a lowercase 40-character Git SHA-1")
    return value


def require_sha256(value: str, *, label: str) -> str:
    if not SHA256_RE.fullmatch(value):
        fail(f"{label} must be a lowercase 64-character SHA-256")
    return value


def run(
    args: list[str],
    *,
    cwd: Path,
    input_text: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        args,
        cwd=cwd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "no output"
        fail(f"command failed ({' '.join(args)}): {detail}")
    return completed


def validate_branch(branch: str, *, label: str, repository: Path) -> str:
    if not branch or len(branch.encode("utf-8")) > 240:
        fail(f"{label} must be between 1 and 240 UTF-8 bytes")
    completed = run(
        ["git", "check-ref-format", "--branch", branch],
        cwd=repository,
        check=False,
    )
    if completed.returncode != 0:
        fail(f"{label} is not a valid Git branch name")
    return branch


def validate_transfer_branch(branch: str, *, repository: Path) -> str:
    validate_branch(branch, label="transfer branch", repository=repository)
    if not branch.startswith(TRANSFER_PREFIX) or branch == TRANSFER_PREFIX:
        fail(f"transfer branch must start with {TRANSFER_PREFIX}")
    return branch


def validate_local_ref(ref: str, *, repository: Path) -> str:
    if not ref.startswith("refs/"):
        fail("transfer ref must be a fully qualified Git ref")
    completed = run(
        ["git", "check-ref-format", ref],
        cwd=repository,
        check=False,
    )
    if completed.returncode != 0:
        fail("transfer ref is not a valid Git ref")
    return ref


def validate_commit_message(message: str) -> str:
    if not message or len(message.encode("utf-8")) > 240:
        fail("manifest.commitMessage must be between 1 and 240 UTF-8 bytes")
    if "\n" in message or "\r" in message or "\0" in message:
        fail("manifest.commitMessage must be a single line without NUL bytes")
    return message


def parse_manifest(
    path: Path,
    *,
    repository: Path,
    default_branch: str,
    expected_target_branch: str | None,
) -> Manifest:
    value = load_json_object(path)
    if require_int(value, "formatVersion", label="manifest") != 2:
        fail("manifest.formatVersion must be the integer 2")
    require_exact_fields(
        value,
        (
            "formatVersion",
            "targetBranch",
            "expectedBaseSha",
            "expectedResultTreeSha",
            "patchSizeBytes",
            "patchSha256",
            "parts",
            "commitMessage",
        ),
        label="manifest",
    )

    target_branch = validate_branch(
        require_string(value, "targetBranch", label="manifest"),
        label="target branch",
        repository=repository,
    )
    if target_branch == default_branch:
        fail("target branch must not be the default branch")
    if target_branch.startswith(TRANSFER_PREFIX):
        fail("target branch must not use the transfer-branch namespace")
    if expected_target_branch is not None and target_branch != expected_target_branch:
        fail("manifest target branch does not match the commented pull request")

    patch_size_bytes = require_int(value, "patchSizeBytes", label="manifest")
    if not 1 <= patch_size_bytes <= MAX_PATCH_SIZE_BYTES:
        fail(
            "manifest.patchSizeBytes must be between 1 and "
            f"{MAX_PATCH_SIZE_BYTES}"
        )
    raw_parts = require_list(value, "parts", label="manifest")
    if not 1 <= len(raw_parts) <= MAX_PART_COUNT:
        fail(f"manifest.parts must contain between 1 and {MAX_PART_COUNT} entries")
    parsed_parts: list[PatchPart] = []
    for offset, raw_part in enumerate(raw_parts, start=1):
        label = f"manifest.parts[{offset - 1}]"
        if not isinstance(raw_part, dict):
            fail(f"{label} must be an object")
        require_exact_fields(
            raw_part,
            ("path", "sizeBytes", "sha256"),
            label=label,
        )
        expected_path = (
            f"{PART_DIRECTORY}/change.patch.part-"
            f"{offset:04d}-of-{len(raw_parts):04d}"
        )
        part_path = require_string(raw_part, "path", label=label)
        if part_path != expected_path:
            fail(f"{label}.path must be exactly {expected_path}")
        size_bytes = require_int(raw_part, "sizeBytes", label=label)
        if not 1 <= size_bytes <= MAX_PART_SIZE_BYTES:
            fail(
                f"{label}.sizeBytes must be between 1 and "
                f"{MAX_PART_SIZE_BYTES}"
            )
        parsed_parts.append(
            PatchPart(
                path=part_path,
                size_bytes=size_bytes,
                sha256=require_sha256(
                    require_string(raw_part, "sha256", label=label),
                    label=f"{label}.sha256",
                ),
            )
        )
    if sum(part.size_bytes for part in parsed_parts) != patch_size_bytes:
        fail("manifest patch size does not equal the sum of part sizes")
    parts = tuple(parsed_parts)

    return Manifest(
        target_branch=target_branch,
        expected_base_sha=require_sha1(
            require_string(value, "expectedBaseSha", label="manifest"),
            label="manifest.expectedBaseSha",
        ),
        expected_result_tree_sha=require_sha1(
            require_string(value, "expectedResultTreeSha", label="manifest"),
            label="manifest.expectedResultTreeSha",
        ),
        patch_sha256=require_sha256(
            require_string(value, "patchSha256", label="manifest"),
            label="manifest.patchSha256",
        ),
        commit_message=validate_commit_message(
            require_string(value, "commitMessage", label="manifest")
        ),
        patch_size_bytes=patch_size_bytes,
        parts=parts,
    )


def parse_metadata(path: Path, *, repository: Path) -> PublicationMetadata:
    value = load_json_object(path)
    require_exact_fields(
        value,
        (
            "formatVersion",
            "targetBranch",
            "transferBranch",
            "expectedBaseSha",
            "expectedResultTreeSha",
            "patchSha256",
            "candidateCommitSha",
            "commitMessage",
            "validationProfile",
        ),
        label="publication metadata",
    )
    if type(value["formatVersion"]) is not int or value["formatVersion"] != 2:
        fail("publication metadata formatVersion must be the integer 2")
    return PublicationMetadata(
        target_branch=validate_branch(
            require_string(value, "targetBranch", label="publication metadata"),
            label="target branch",
            repository=repository,
        ),
        transfer_branch=validate_transfer_branch(
            require_string(value, "transferBranch", label="publication metadata"),
            repository=repository,
        ),
        expected_base_sha=require_sha1(
            require_string(value, "expectedBaseSha", label="publication metadata"),
            label="publication metadata.expectedBaseSha",
        ),
        expected_result_tree_sha=require_sha1(
            require_string(
                value, "expectedResultTreeSha", label="publication metadata"
            ),
            label="publication metadata.expectedResultTreeSha",
        ),
        patch_sha256=require_sha256(
            require_string(value, "patchSha256", label="publication metadata"),
            label="publication metadata.patchSha256",
        ),
        candidate_commit_sha=require_sha1(
            require_string(value, "candidateCommitSha", label="publication metadata"),
            label="publication metadata.candidateCommitSha",
        ),
        commit_message=validate_commit_message(
            require_string(value, "commitMessage", label="publication metadata")
        ),
        validation_profile=require_validation_profile(
            require_string(
                value, "validationProfile", label="publication metadata"
            ),
            label="publication metadata.validationProfile",
        ),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        fail(f"cannot read patch {path}: {exc}")
    return digest.hexdigest()


def verify_patch_digest(path: Path, expected: str) -> None:
    actual = sha256_file(path)
    if actual != expected:
        fail(f"patch SHA-256 mismatch: expected {expected}, found {actual}")


def file_size(path: Path, *, label: str) -> int:
    try:
        return path.stat().st_size
    except OSError as exc:
        fail(f"cannot inspect {label} {path}: {exc}")


def git_bytes(args: list[str], *, cwd: Path, label: str) -> bytes:
    completed = subprocess.run(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        if not detail:
            detail = completed.stdout.decode("utf-8", "replace").strip()
        fail(f"cannot read {label}: {detail or 'no output'}")
    return completed.stdout


def read_transfer_tree(repository: Path, transfer_ref: str) -> dict[str, str]:
    raw = git_bytes(
        [
            "git",
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            transfer_ref,
            "--",
            TRANSFER_DIRECTORY,
        ],
        cwd=repository,
        label="transfer payload tree",
    )
    entries: dict[str, str] = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, object_type, _object_sha = metadata.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
        except (ValueError, UnicodeError):
            fail("transfer payload tree contains an invalid entry")
        if path in entries:
            fail(f"transfer payload tree contains duplicate path: {path}")
        if mode != "100644" or object_type != "blob":
            fail(f"transfer payload path must be a regular non-executable file: {path}")
        entries[path] = mode
    return entries


def read_transfer_file(repository: Path, transfer_ref: str, path: str) -> bytes:
    return git_bytes(
        ["git", "show", f"{transfer_ref}:{path}"],
        cwd=repository,
        label=f"transfer payload file {path}",
    )


def require_utf8_part(part: bytes, *, path: str) -> None:
    try:
        part.decode("utf-8")
    except UnicodeDecodeError as exc:
        fail(f"patch part is not UTF-8: {path} (byte offset {exc.start})")


def materialize_patch(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    transfer_ref = validate_local_ref(args.transfer_ref, repository=repository)
    resolved_ref = run(
        ["git", "rev-parse", "--verify", f"{transfer_ref}^{{commit}}"],
        cwd=repository,
    ).stdout.strip()
    require_sha1(resolved_ref, label="transfer ref commit")

    manifest = parse_manifest(
        args.manifest,
        repository=repository,
        default_branch=args.default_branch,
        expected_target_branch=args.expected_target_branch,
    )
    manifest_path = f"{TRANSFER_DIRECTORY}/manifest.json"
    payload_paths = [part.path for part in manifest.parts]
    expected_paths = {manifest_path, *payload_paths}
    actual_paths = set(read_transfer_tree(repository, transfer_ref))
    missing = sorted(expected_paths - actual_paths)
    unexpected = sorted(actual_paths - expected_paths)
    if missing:
        fail(f"transfer payload is missing file(s): {', '.join(missing)}")
    if unexpected:
        fail(f"transfer payload contains unexpected file(s): {', '.join(unexpected)}")

    try:
        local_manifest = args.manifest.read_bytes()
    except OSError as exc:
        fail(f"cannot read manifest {args.manifest}: {exc}")
    transfer_manifest = read_transfer_file(repository, transfer_ref, manifest_path)
    if transfer_manifest != local_manifest:
        fail("transfer manifest bytes differ from the verified local manifest")

    output_patch = args.output_patch.resolve()
    if output_patch.exists():
        fail(f"output patch already exists: {output_patch}")
    output_patch.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_patch.name}.", dir=str(output_patch.parent)
    )
    temporary_path = Path(temporary_name)
    complete_digest = hashlib.sha256()
    complete_size = 0
    published = False
    try:
        with os.fdopen(descriptor, "wb") as handle:
            for part in manifest.parts:
                value = read_transfer_file(repository, transfer_ref, part.path)
                actual_size = len(value)
                if actual_size != part.size_bytes:
                    fail(
                        f"patch part size mismatch for {part.path}: "
                        f"expected {part.size_bytes}, found {actual_size}"
                    )
                actual_digest = hashlib.sha256(value).hexdigest()
                if actual_digest != part.sha256:
                    fail(
                        f"patch part SHA-256 mismatch for {part.path}: "
                        f"expected {part.sha256}, found {actual_digest}"
                    )
                require_utf8_part(value, path=part.path)
                handle.write(value)
                complete_digest.update(value)
                complete_size += actual_size
            handle.flush()
            os.fsync(handle.fileno())

        if complete_size != manifest.patch_size_bytes:
            fail(
                "reconstructed patch size mismatch: "
                f"expected {manifest.patch_size_bytes}, found {complete_size}"
            )
        actual_patch_digest = complete_digest.hexdigest()
        if actual_patch_digest != manifest.patch_sha256:
            fail(
                "reconstructed patch SHA-256 mismatch: "
                f"expected {manifest.patch_sha256}, found {actual_patch_digest}"
            )
        os.replace(temporary_path, output_patch)
        published = True
    finally:
        if not published:
            temporary_path.unlink(missing_ok=True)

    write_github_outputs(
        args.github_output,
        {"patch_sha256": manifest.patch_sha256},
    )
    print(
        "materialized patch publication payload "
        f"format=2 size={complete_size} "
        f"sha256={manifest.patch_sha256}"
    )


def write_github_outputs(path: Path | None, values: Mapping[str, str]) -> None:
    if path is None:
        return
    for key, value in values.items():
        if "\n" in value or "\r" in value:
            fail(f"GitHub output {key} contains a line break")
    try:
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            for key, value in values.items():
                handle.write(f"{key}={value}\n")
    except OSError as exc:
        fail(f"cannot write GitHub outputs to {path}: {exc}")


def inspect_request(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    transfer_branch = validate_transfer_branch(
        args.transfer_branch, repository=repository
    )
    manifest = parse_manifest(
        args.manifest,
        repository=repository,
        default_branch=args.default_branch,
        expected_target_branch=args.expected_target_branch,
    )
    if transfer_branch == manifest.target_branch:
        fail("transfer branch and target branch must differ")
    if manifest.patch_size_bytes is not None:
        actual_patch_size = file_size(args.patch, label="patch")
        if actual_patch_size != manifest.patch_size_bytes:
            fail(
                "patch size mismatch: "
                f"expected {manifest.patch_size_bytes}, found {actual_patch_size}"
            )
    verify_patch_digest(args.patch, manifest.patch_sha256)
    write_github_outputs(
        args.github_output,
        {
            "target_branch": manifest.target_branch,
            "expected_base_sha": manifest.expected_base_sha,
            "expected_result_tree_sha": manifest.expected_result_tree_sha,
            "patch_sha256": manifest.patch_sha256,
        },
    )
    print(
        "validated patch request "
        f"target={manifest.target_branch} base={manifest.expected_base_sha} "
        f"tree={manifest.expected_result_tree_sha}"
    )


def ensure_clean_repository(repository: Path) -> None:
    status = run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=repository,
    ).stdout
    if status:
        fail("repository must be clean before preparing a publication")


def current_head(repository: Path) -> str:
    return run(["git", "rev-parse", "HEAD"], cwd=repository).stdout.strip()


def staged_paths(repository: Path) -> list[str]:
    completed = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "-z", "--no-renames"],
        cwd=repository,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        fail(
            "cannot list staged paths: "
            + completed.stderr.decode("utf-8", "replace").strip()
        )
    return [
        item.decode("utf-8", "surrogateescape")
        for item in completed.stdout.split(b"\0")
        if item
    ]


def create_candidate_bundle(
    *,
    repository: Path,
    manifest: Manifest,
    transfer_branch: str,
    patch: Path,
    output_directory: Path,
) -> PublicationMetadata:
    ensure_clean_repository(repository)
    head = current_head(repository)
    if head != manifest.expected_base_sha:
        fail(
            "checked-out base mismatch: "
            f"expected {manifest.expected_base_sha}, found {head}"
        )
    if manifest.patch_size_bytes is not None:
        actual_patch_size = file_size(patch, label="patch")
        if actual_patch_size != manifest.patch_size_bytes:
            fail(
                "patch size mismatch: "
                f"expected {manifest.patch_size_bytes}, found {actual_patch_size}"
            )
    verify_patch_digest(patch, manifest.patch_sha256)

    run(
        ["git", "apply", "--check", "--index", "--binary", str(patch)],
        cwd=repository,
    )
    run(
        ["git", "apply", "--index", "--binary", str(patch)],
        cwd=repository,
    )

    if run(["git", "diff", "--cached", "--quiet"], cwd=repository, check=False).returncode == 0:
        fail("patch produces no staged change")

    forbidden_prefix = f"{TRANSFER_DIRECTORY}/"
    candidate_paths = staged_paths(repository)
    forbidden = [
        path
        for path in candidate_paths
        if path == TRANSFER_DIRECTORY or path.startswith(forbidden_prefix)
    ]
    if forbidden:
        fail("patch must not modify the transfer directory")

    run(["git", "diff", "--cached", "--check"], cwd=repository)
    tree_sha = run(["git", "write-tree"], cwd=repository).stdout.strip()
    if tree_sha != manifest.expected_result_tree_sha:
        fail(
            "result tree mismatch: "
            f"expected {manifest.expected_result_tree_sha}, found {tree_sha}"
        )

    commit_environment = os.environ.copy()
    commit_environment.setdefault("GIT_AUTHOR_NAME", "Patch Publication")
    commit_environment.setdefault(
        "GIT_AUTHOR_EMAIL", "patch-publication@users.noreply.github.com"
    )
    commit_environment.setdefault("GIT_COMMITTER_NAME", "Patch Publication")
    commit_environment.setdefault(
        "GIT_COMMITTER_EMAIL", "patch-publication@users.noreply.github.com"
    )
    completed = subprocess.run(
        [
            "git",
            "commit-tree",
            tree_sha,
            "-p",
            manifest.expected_base_sha,
        ],
        cwd=repository,
        input=manifest.commit_message + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=commit_environment,
        check=False,
    )
    if completed.returncode != 0:
        fail(f"cannot create candidate commit: {completed.stderr.strip()}")
    candidate_commit_sha = completed.stdout.strip()
    require_sha1(candidate_commit_sha, label="candidate commit SHA")

    run(
        ["git", "update-ref", CANDIDATE_REF, candidate_commit_sha],
        cwd=repository,
    )
    output_directory.mkdir(parents=True, exist_ok=False)
    bundle_path = output_directory / "publication.bundle"
    run(
        [
            "git",
            "bundle",
            "create",
            str(bundle_path),
            CANDIDATE_REF,
            f"^{manifest.expected_base_sha}",
        ],
        cwd=repository,
    )

    metadata = PublicationMetadata(
        target_branch=manifest.target_branch,
        transfer_branch=transfer_branch,
        expected_base_sha=manifest.expected_base_sha,
        expected_result_tree_sha=manifest.expected_result_tree_sha,
        patch_sha256=manifest.patch_sha256,
        candidate_commit_sha=candidate_commit_sha,
        commit_message=manifest.commit_message,
        validation_profile=validation_profile_for_paths(candidate_paths),
    )
    metadata_path = output_directory / "publication.json"
    metadata_path.write_text(
        json.dumps(
            {
                "formatVersion": 2,
                "targetBranch": metadata.target_branch,
                "transferBranch": metadata.transfer_branch,
                "expectedBaseSha": metadata.expected_base_sha,
                "expectedResultTreeSha": metadata.expected_result_tree_sha,
                "patchSha256": metadata.patch_sha256,
                "candidateCommitSha": metadata.candidate_commit_sha,
                "commitMessage": metadata.commit_message,
                "validationProfile": metadata.validation_profile,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return metadata


def prepare(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    transfer_branch = validate_transfer_branch(
        args.transfer_branch, repository=repository
    )
    manifest = parse_manifest(
        args.manifest,
        repository=repository,
        default_branch=args.default_branch,
        expected_target_branch=args.expected_target_branch,
    )
    if transfer_branch == manifest.target_branch:
        fail("transfer branch and target branch must differ")
    metadata = create_candidate_bundle(
        repository=repository,
        manifest=manifest,
        transfer_branch=transfer_branch,
        patch=args.patch.resolve(),
        output_directory=args.output_directory.resolve(),
    )
    write_github_outputs(
        args.github_output,
        {
            "target_branch": metadata.target_branch,
            "transfer_branch": metadata.transfer_branch,
            "expected_base_sha": metadata.expected_base_sha,
            "expected_result_tree_sha": metadata.expected_result_tree_sha,
            "candidate_commit_sha": metadata.candidate_commit_sha,
            "validation_profile": metadata.validation_profile,
        },
    )
    print(
        "prepared patch publication "
        f"target={metadata.target_branch} commit={metadata.candidate_commit_sha} "
        f"tree={metadata.expected_result_tree_sha} "
        f"validation={metadata.validation_profile}"
    )


def verify_bundle(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    metadata = parse_metadata(args.metadata, repository=repository)
    if (
        args.expected_validation_profile is not None
        and metadata.validation_profile != args.expected_validation_profile
    ):
        fail(
            "publication validation profile mismatch: "
            f"expected {args.expected_validation_profile}, "
            f"found {metadata.validation_profile}"
        )
    bundle = args.bundle.resolve()
    if not bundle.is_file():
        fail(f"publication bundle does not exist: {bundle}")

    run(["git", "bundle", "verify", str(bundle)], cwd=repository)
    local_ref = "refs/patch-publication/verified-candidate"
    run(
        [
            "git",
            "fetch",
            "--no-tags",
            str(bundle),
            f"{CANDIDATE_REF}:{local_ref}",
        ],
        cwd=repository,
    )
    candidate = run(["git", "rev-parse", local_ref], cwd=repository).stdout.strip()
    if candidate != metadata.candidate_commit_sha:
        fail(
            "bundle candidate mismatch: "
            f"expected {metadata.candidate_commit_sha}, found {candidate}"
        )
    parents = run(
        ["git", "show", "-s", "--format=%P", candidate], cwd=repository
    ).stdout.strip().split()
    if parents != [metadata.expected_base_sha]:
        fail("candidate commit must have exactly the expected base as its parent")
    tree = run(
        ["git", "show", "-s", "--format=%T", candidate], cwd=repository
    ).stdout.strip()
    if tree != metadata.expected_result_tree_sha:
        fail(
            "candidate tree mismatch: "
            f"expected {metadata.expected_result_tree_sha}, found {tree}"
        )
    message = run(
        ["git", "show", "-s", "--format=%B", candidate], cwd=repository
    ).stdout.rstrip("\n")
    if message != metadata.commit_message:
        fail("candidate commit message does not match publication metadata")

    write_github_outputs(
        args.github_output,
        {
            "target_branch": metadata.target_branch,
            "transfer_branch": metadata.transfer_branch,
            "expected_base_sha": metadata.expected_base_sha,
            "expected_result_tree_sha": metadata.expected_result_tree_sha,
            "candidate_commit_sha": metadata.candidate_commit_sha,
            "validation_profile": metadata.validation_profile,
        },
    )
    print(
        "verified publication bundle "
        f"target={metadata.target_branch} commit={metadata.candidate_commit_sha}"
    )


def add_common_request_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--transfer-branch", required=True)
    parser.add_argument("--default-branch", default="main")
    parser.add_argument("--expected-target-branch")
    parser.add_argument("--github-output", type=Path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser(
        "inspect-request", help="validate a manifest and patch without applying it"
    )
    add_common_request_arguments(inspect_parser)
    inspect_parser.set_defaults(handler=inspect_request)

    materialize_parser = subparsers.add_parser(
        "materialize-patch",
        help="read and verify one exact transfer payload into a raw patch",
    )
    materialize_parser.add_argument("--repository", type=Path, required=True)
    materialize_parser.add_argument("--manifest", type=Path, required=True)
    materialize_parser.add_argument("--transfer-ref", required=True)
    materialize_parser.add_argument("--output-patch", type=Path, required=True)
    materialize_parser.add_argument("--default-branch", default="main")
    materialize_parser.add_argument("--expected-target-branch")
    materialize_parser.add_argument("--github-output", type=Path)
    materialize_parser.set_defaults(handler=materialize_patch)

    prepare_parser = subparsers.add_parser(
        "prepare", help="apply an exact patch and create a candidate Git bundle"
    )
    add_common_request_arguments(prepare_parser)
    prepare_parser.add_argument("--output-directory", type=Path, required=True)
    prepare_parser.set_defaults(handler=prepare)

    verify_parser = subparsers.add_parser(
        "verify-bundle", help="verify a prepared candidate bundle without executing it"
    )
    verify_parser.add_argument("--repository", type=Path, required=True)
    verify_parser.add_argument("--metadata", type=Path, required=True)
    verify_parser.add_argument("--bundle", type=Path, required=True)
    verify_parser.add_argument(
        "--expected-validation-profile",
        choices=sorted(VALIDATION_PROFILES),
    )
    verify_parser.add_argument("--github-output", type=Path)
    verify_parser.set_defaults(handler=verify_bundle)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.handler(args)
    except PublicationError as exc:
        print(f"patch-publication: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
