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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, NoReturn


TRANSFER_PREFIX = "agent-patch-publication/"
TRANSFER_DIRECTORY = ".agent-patch-publication"
CANDIDATE_REF = "refs/heads/patch-publication-candidate"
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class PublicationError(RuntimeError):
    """Expected validation or Git-operation failure."""


@dataclass(frozen=True)
class Manifest:
    target_branch: str
    expected_base_sha: str
    expected_result_tree_sha: str
    patch_sha256: str
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


def fail(message: str) -> NoReturn:
    raise PublicationError(message)


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
    require_exact_fields(
        value,
        (
            "formatVersion",
            "targetBranch",
            "expectedBaseSha",
            "expectedResultTreeSha",
            "patchSha256",
            "commitMessage",
        ),
        label="manifest",
    )
    if type(value["formatVersion"]) is not int or value["formatVersion"] != 1:
        fail("manifest.formatVersion must be the integer 1")

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
        ),
        label="publication metadata",
    )
    if type(value["formatVersion"]) is not int or value["formatVersion"] != 1:
        fail("publication metadata formatVersion must be the integer 1")
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
        ["git", "diff", "--cached", "--name-only", "-z"],
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
    forbidden = [
        path
        for path in staged_paths(repository)
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
    )
    metadata_path = output_directory / "publication.json"
    metadata_path.write_text(
        json.dumps(
            {
                "formatVersion": 1,
                "targetBranch": metadata.target_branch,
                "transferBranch": metadata.transfer_branch,
                "expectedBaseSha": metadata.expected_base_sha,
                "expectedResultTreeSha": metadata.expected_result_tree_sha,
                "patchSha256": metadata.patch_sha256,
                "candidateCommitSha": metadata.candidate_commit_sha,
                "commitMessage": metadata.commit_message,
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
        },
    )
    print(
        "prepared patch publication "
        f"target={metadata.target_branch} commit={metadata.candidate_commit_sha} "
        f"tree={metadata.expected_result_tree_sha}"
    )


def verify_bundle(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    metadata = parse_metadata(args.metadata, repository=repository)
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
