#!/usr/bin/env python3
"""Prepare one verified multipart raw Git patch and its local upload handoff."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from patch_publication_plan import write_upload_handoff
from patch_publication_support import (
    DEFAULT_PART_SIZE_KIB,
    MAX_PART_COUNT,
    MAX_PART_SIZE_KIB,
    MAX_PATCH_SIZE_BYTES,
    PART_DIRECTORY,
    REPOSITORY_RE,
    TRANSFER_DIRECTORY,
    TRANSFER_PREFIX,
    UPLOAD_INSTRUCTIONS_NAME,
    UPLOAD_PLAN_NAME,
    fail,
    git_text,
    infer_repository_full_name,
    load_token_estimator,
    require_sha1,
    run,
    sanitize_branch_component,
    sha256_bytes,
    split_utf8_patch,
    validate_branch,
    validate_commit_message,
    validate_transfer_branch,
)

def prepare(args: argparse.Namespace) -> None:
    repository = args.repository.resolve()
    if not repository.is_dir():
        fail(f"repository does not exist: {repository}")
    if git_text(repository, "rev-parse", "--is-inside-work-tree") != "true":
        fail("repository must be a Git worktree")
    status = git_text(repository, "status", "--porcelain=v1", "--untracked-files=all")
    if status:
        fail("repository must be clean before preparing a publication payload")
    if args.target_branch is None:
        fail("--target-branch is required when preparing a payload")

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

    if args.expected_base_sha is None:
        parents = git_text(repository, "show", "-s", "--format=%P", tested_commit).split()
        if len(parents) != 1:
            fail(
                "--expected-base-sha is required when the tested commit does not have "
                "exactly one parent"
            )
        expected_base_sha = require_sha1(parents[0], label="tested commit parent")
    else:
        expected_base_sha = require_sha1(
            git_text(
                repository,
                "rev-parse",
                "--verify",
                f"{args.expected_base_sha}^{{commit}}",
            ),
            label="expected base SHA",
        )
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", expected_base_sha, tested_commit],
        cwd=repository,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if ancestor.returncode != 0:
        fail("expected base SHA must be an ancestor of the tested commit")

    expected_result_tree_sha = require_sha1(
        git_text(repository, "show", "-s", "--format=%T", tested_commit),
        label="tested result tree",
    )
    expected_base_tree_sha = require_sha1(
        git_text(repository, "show", "-s", "--format=%T", expected_base_sha),
        label="expected base tree",
    )
    commit_message = validate_commit_message(
        git_text(repository, "show", "-s", "--format=%s", tested_commit)
    )

    part_size_kib = args.part_size_kib
    if not 1 <= part_size_kib <= MAX_PART_SIZE_KIB:
        fail(
            f"part size must be between 1 and {MAX_PART_SIZE_KIB} KiB "
            f"(byte fallback: {DEFAULT_PART_SIZE_KIB} KiB)"
        )
    part_size_bytes = part_size_kib * 1024
    if args.target_part_tokens < 1:
        fail("target part tokens must be positive")

    tokenizer_path = args.tokenizer
    if tokenizer_path is None:
        configured = os.environ.get("TEASESCRIPT_O200K_TOKENIZER")
        tokenizer_path = Path(configured) if configured else None
    estimator = load_token_estimator(tokenizer_path) if tokenizer_path else None

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
        fail("tested commit range produces an empty patch")
    if len(patch) > MAX_PATCH_SIZE_BYTES:
        fail(
            f"patch is larger than the {MAX_PATCH_SIZE_BYTES}-byte "
            "publication transport ceiling"
        )
    patch_sha256 = sha256_bytes(patch)
    parts, token_counts = split_utf8_patch(
        patch,
        maximum_bytes=part_size_bytes,
        target_tokens=args.target_part_tokens if estimator else None,
        count_tokens=estimator.count_bytes if estimator else None,
    )
    part_count = len(parts)

    repository_full_name = args.repository_full_name or infer_repository_full_name(repository)
    if repository_full_name is not None and not REPOSITORY_RE.fullmatch(repository_full_name):
        fail("repository full name must use owner/name form")

    transfer_branch = args.transfer_branch or (
        f"{TRANSFER_PREFIX}{sanitize_branch_component(target_branch)}-"
        f"{tested_commit[:12]}"
    )
    transfer_branch = validate_transfer_branch(transfer_branch, repository=repository)

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

        manifest_sha256 = write_upload_handoff(
            repository=repository,
            temp_root=temp_root,
            output=output,
            manifest_path=manifest_path,
            manifest_parts=manifest_parts,
            token_counts=token_counts,
            estimator=estimator,
            repository_full_name=repository_full_name,
            target_branch=target_branch,
            transfer_branch=transfer_branch,
            expected_base_sha=expected_base_sha,
            expected_base_tree_sha=expected_base_tree_sha,
            tested_commit=tested_commit,
            expected_result_tree_sha=expected_result_tree_sha,
            target_part_tokens=args.target_part_tokens,
            part_size_bytes=part_size_bytes,
        )

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
    if estimator:
        print("sizingMode=o200k_base")
        print(f"targetPartTokens={args.target_part_tokens}")
        maximum_observed = max(
            value for value in token_counts if value is not None
        )
        print(f"maximumObservedPartTokens={maximum_observed}")
    else:
        print("sizingMode=byteFallback")
        print("tokenizer=not configured")
    print(f"uploadPlan={output / UPLOAD_PLAN_NAME}")
    print(f"instructions={output / UPLOAD_INSTRUCTIONS_NAME}")
    print("next=run this command; it opens only one pending upload:")
    print(
        f"python3 -B {Path(__file__).with_name('prepare-patch-publication.py').as_posix()} --output-directory "
        f"{output.as_posix()} --show-next-upload"
    )
