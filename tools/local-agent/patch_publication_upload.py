#!/usr/bin/env python3
"""Sequential connector guidance for prepared patch-publication payloads."""

from __future__ import annotations

import json
from pathlib import Path

from patch_publication_support import (
    SHA1_RE,
    TRANSFER_DIRECTORY,
    UPLOAD_PLAN_NAME,
    UPLOAD_STATE_NAME,
    ensure_utf8,
    fail,
    git_blob_sha,
    load_json_object,
    require_sha1,
    sha256_bytes,
    write_json_atomic,
)

CLI_PATH = Path(__file__).with_name("prepare-patch-publication.py")
PUBLICATION_STATE_FIELDS = (
    "transferTreeSha",
    "transferCommitSha",
    "transferBranchSha",
)


def load_plan_and_state(output: Path) -> tuple[dict[str, object], dict[str, object]]:
    resolved = output.resolve()
    plan = load_json_object(resolved / UPLOAD_PLAN_NAME, label="upload plan")
    state = load_json_object(resolved / UPLOAD_STATE_NAME, label="upload state")
    if plan.get("planVersion") != 2:
        fail("upload plan version is incompatible; prepare a new publication payload")
    if state.get("stateVersion") != 2:
        fail("upload state version is incompatible; prepare a new publication payload")

    allowed_state_fields = {
        "stateVersion",
        "completedUploads",
        *PUBLICATION_STATE_FIELDS,
    }
    unknown_state_fields = sorted(set(state) - allowed_state_fields)
    if unknown_state_fields:
        fail(f"upload state contains unknown fields: {', '.join(unknown_state_fields)}")

    files = plan.get("files")
    completed = state.get("completedUploads")
    if not isinstance(files, list) or not all(isinstance(item, dict) for item in files):
        fail("upload plan files must be an array of objects")
    if not isinstance(completed, list) or not all(
        isinstance(item, dict) for item in completed
    ):
        fail("upload state completedUploads must be an array of objects")
    validated_publication_state(plan, state)
    return plan, state


def validated_completed_uploads(
    plan: dict[str, object], state: dict[str, object]
) -> dict[int, dict[str, object]]:
    files = plan["files"]
    completed = state["completedUploads"]
    assert isinstance(files, list)
    assert isinstance(completed, list)
    planned_by_index: dict[int, dict[str, object]] = {}
    for planned in files:
        assert isinstance(planned, dict)
        index = planned.get("index")
        if not isinstance(index, int) or index < 1 or index in planned_by_index:
            fail("upload plan contains an invalid or duplicate index")
        planned_by_index[index] = planned

    validated: dict[int, dict[str, object]] = {}
    for item in completed:
        assert isinstance(item, dict)
        index = item.get("index")
        if (
            not isinstance(index, int)
            or index not in planned_by_index
            or index in validated
        ):
            fail("upload state contains an invalid or duplicate index")
        planned = planned_by_index[index]
        path = item.get("path")
        blob_sha = item.get("gitBlobSha")
        if path != planned.get("path"):
            fail(f"upload state path does not match plan for index {index}")
        if not isinstance(blob_sha, str) or not SHA1_RE.fullmatch(blob_sha):
            fail(f"upload state Git blob SHA is invalid for index {index}")
        if blob_sha != planned.get("expectedGitBlobSha"):
            fail(f"upload state Git blob SHA does not match plan for index {index}")
        validated[index] = item
    return validated


def validated_publication_state(
    plan: dict[str, object], state: dict[str, object]
) -> tuple[str | None, str | None, str | None]:
    completed = validated_completed_uploads(plan, state)
    files = plan["files"]
    assert isinstance(files, list)
    all_uploads_recorded = len(completed) == len(files)

    values: list[str | None] = []
    for field in PUBLICATION_STATE_FIELDS:
        value = state.get(field)
        if value is not None:
            if not isinstance(value, str) or not SHA1_RE.fullmatch(value):
                fail(
                    f"upload state {field} must be a lowercase "
                    "40-character Git SHA-1"
                )
        values.append(value)
    tree_sha, commit_sha, branch_sha = values

    if any(value is not None for value in values) and not all_uploads_recorded:
        fail(
            "upload state cannot contain publication SHAs before every blob "
            "is recorded"
        )
    if commit_sha is not None and tree_sha is None:
        fail("upload state cannot contain a commit SHA before the tree SHA")
    if branch_sha is not None and commit_sha is None:
        fail("upload state cannot contain a branch SHA before the commit SHA")

    expected_tree_sha = plan.get("expectedTransferTreeSha")
    if not isinstance(expected_tree_sha, str) or not SHA1_RE.fullmatch(
        expected_tree_sha
    ):
        fail("upload plan expectedTransferTreeSha must be a Git SHA-1")
    if tree_sha is not None and tree_sha != expected_tree_sha:
        fail("upload state transfer tree SHA does not match the upload plan")
    if branch_sha is not None and branch_sha != commit_sha:
        fail("upload state transfer branch SHA does not match the recorded commit SHA")
    return tree_sha, commit_sha, branch_sha


def next_pending_file(
    plan: dict[str, object], state: dict[str, object]
) -> dict[str, object] | None:
    files = plan["files"]
    assert isinstance(files, list)
    done = set(validated_completed_uploads(plan, state))
    for item in files:
        assert isinstance(item, dict)
        index = item.get("index")
        if not isinstance(index, int):
            fail("upload plan file index must be an integer")
        if index not in done:
            return item
    return None


def verify_planned_file(output: Path, item: dict[str, object]) -> bytes:
    relative = item.get("localPath")
    if not isinstance(relative, str) or not relative.startswith(
        f"{TRANSFER_DIRECTORY}/"
    ):
        fail("upload plan contains an invalid local path")
    path = output.resolve() / relative
    value = path.read_bytes()
    if len(value) != item.get("sizeBytes"):
        fail(f"planned upload size changed: {relative}")
    if sha256_bytes(value) != item.get("sha256"):
        fail(f"planned upload SHA-256 changed: {relative}")
    if git_blob_sha(value) != item.get("expectedGitBlobSha"):
        fail(f"planned Git blob SHA changed: {relative}")
    ensure_utf8(value, label=f"planned upload {relative}")
    return value


def required_plan_string(plan: dict[str, object], field: str) -> str:
    value = plan.get(field)
    if not isinstance(value, str) or not value:
        fail(f"upload plan {field} must be a non-empty string")
    return value


def command_for(output: Path, option: str, placeholder: str) -> str:
    return (
        f"python3 -B {CLI_PATH.as_posix()} --output-directory "
        f"{output.resolve().as_posix()} {option} {placeholder}"
    )


def show_next_upload(output: Path) -> None:
    plan, state = load_plan_and_state(output)
    item = next_pending_file(plan, state)
    repository_full_name = required_plan_string(plan, "repositoryFullName")
    if item is not None:
        value = verify_planned_file(output, item)
        content = value.decode("utf-8")
        print("stage=upload-blob")
        print(f"uploadIndex={item['index']} of {len(plan['files'])}")
        print(f"path={item['path']}")
        print(f"sizeBytes={item['sizeBytes']}")
        print(f"sha256={item['sha256']}")
        print(f"expectedGitBlobSha={item['expectedGitBlobSha']}")
        if item.get("estimatedConnectorTokens") is not None:
            print(f"estimatedConnectorTokens={item['estimatedConnectorTokens']}")
        print(
            "required=use the exact UTF-8 arguments and record the returned "
            "SHA before another repository write"
        )
        print(
            "connector=GitHub action that creates one UTF-8 blob "
            "(currently create_blob)"
        )
        print("connectorArguments=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "content": content,
                    "encoding": "utf-8",
                },
                ensure_ascii=False,
            )
        )
        print("afterSuccess=")
        print(command_for(output, "--record-upload-sha", "<returned-git-blob-sha>"))
        return

    tree_sha, commit_sha, branch_sha = validated_publication_state(plan, state)
    transfer_branch = required_plan_string(plan, "transferBranch")
    if tree_sha is None:
        tree_elements = plan.get("transferTreeElements")
        if not isinstance(tree_elements, list):
            fail("upload plan transferTreeElements must be an array")
        print("stage=create-transfer-tree")
        print(
            "required=use the exact payload-only tree arguments, use no base "
            "tree, add no files, and record the returned SHA before another "
            "repository write"
        )
        print(f"expectedTransferTreeSha={plan['expectedTransferTreeSha']}")
        print("connector=GitHub action that creates a tree from Git blob entries")
        print("connectorArguments=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "tree_elements": tree_elements,
                },
                ensure_ascii=False,
            )
        )
        print("afterSuccess=")
        print(command_for(output, "--record-tree-sha", "<returned-tree-sha>"))
        return

    transfer_commit = plan.get("transferCommit")
    if not isinstance(transfer_commit, dict):
        fail("upload plan transferCommit must be an object")
    if commit_sha is None:
        message = transfer_commit.get("message")
        parent_sha = transfer_commit.get("parentSha")
        if not isinstance(message, str) or not isinstance(parent_sha, str):
            fail("upload plan transferCommit is malformed")
        print("stage=create-transfer-commit")
        print(
            "required=use the exact arguments, do not alter the parent SHA, "
            "and record the returned SHA before another repository write"
        )
        print("connector=GitHub action that creates a commit for a returned tree")
        print("connectorArguments=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "message": message,
                    "tree_sha": tree_sha,
                    "parent_sha": parent_sha,
                },
                ensure_ascii=False,
            )
        )
        print("afterSuccess=")
        print(command_for(output, "--record-commit-sha", "<returned-commit-sha>"))
        return

    if branch_sha is None:
        print("stage=create-transfer-branch")
        print(
            "required=create only the planned transfer branch at the exact "
            "recorded commit, resolve its target, and record that SHA before "
            "publishing"
        )
        print("connector=GitHub action that creates the transfer branch at a commit")
        print("connectorArguments=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "branch_name": transfer_branch,
                    "sha": commit_sha,
                },
                ensure_ascii=False,
            )
        )
        print("afterSuccess=")
        print(
            command_for(
                output,
                "--record-branch-sha",
                "<resolved-transfer-branch-sha>",
            )
        )
        return

    print("stage=ready-to-publish")
    print(f"publicationCommand={required_plan_string(plan, 'publicationCommand')}")
    print(f"targetBranch={required_plan_string(plan, 'targetBranch')}")
    print(f"expectedBaseSha={required_plan_string(plan, 'expectedBaseSha')}")
    print(
        f"expectedResultTreeSha={required_plan_string(plan, 'expectedResultTreeSha')}"
    )
    print("postPublicationChecklist=")
    print("1. verify that the pull-request head changed from expectedBaseSha")
    print("2. verify that the published commit tree equals expectedResultTreeSha")
    print("3. verify that the patch-publication workflow succeeded")
    print("4. verify that required CI succeeded on the new exact head")
    print("5. verify transfer-branch and command-comment cleanup or preserved retry state")


def record_upload_sha(output: Path, returned_sha: str) -> None:
    returned_sha = require_sha1(returned_sha, label="returned Git blob SHA")
    plan, state = load_plan_and_state(output)
    item = next_pending_file(plan, state)
    if item is None:
        fail("all planned uploads are already recorded")
    verify_planned_file(output, item)
    expected = item.get("expectedGitBlobSha")
    if returned_sha != expected:
        fail(
            f"Git blob SHA mismatch for {item['path']}: "
            f"expected {expected}, found {returned_sha}; do not advance"
        )
    completed = state["completedUploads"]
    assert isinstance(completed, list)
    completed.append(
        {
            "index": item["index"],
            "path": item["path"],
            "gitBlobSha": returned_sha,
        }
    )
    write_json_atomic(output.resolve() / UPLOAD_STATE_NAME, state)
    next_item = next_pending_file(plan, state)
    print(f"recordedUpload={item['index']}")
    print(f"path={item['path']}")
    print(f"gitBlobSha={returned_sha}")
    if next_item is None:
        print("allUploadsRecorded=true")
        print("next=run --show-next-upload for the exact transfer-tree action")
        print(f"transferBranch={plan['transferBranch']}")
    else:
        print(f"nextUploadIndex={next_item['index']}")
        print(f"nextPath={next_item['path']}")
        print("next=run --show-next-upload; no later part has been opened")


def record_tree_sha(output: Path, returned_sha: str) -> None:
    returned_sha = require_sha1(returned_sha, label="returned transfer tree SHA")
    plan, state = load_plan_and_state(output)
    if next_pending_file(plan, state) is not None:
        fail("cannot record the transfer tree before every blob is recorded")
    tree_sha, commit_sha, branch_sha = validated_publication_state(plan, state)
    if tree_sha is not None or commit_sha is not None or branch_sha is not None:
        fail("transfer tree SHA is already recorded")
    expected = required_plan_string(plan, "expectedTransferTreeSha")
    if returned_sha != expected:
        fail(
            "transfer tree SHA mismatch: "
            f"expected {expected}, found {returned_sha}; do not advance"
        )
    state["transferTreeSha"] = returned_sha
    write_json_atomic(output.resolve() / UPLOAD_STATE_NAME, state)
    print(f"recordedTransferTreeSha={returned_sha}")
    print("next=run --show-next-upload for exact commit arguments")


def record_commit_sha(output: Path, returned_sha: str) -> None:
    returned_sha = require_sha1(returned_sha, label="returned transfer commit SHA")
    plan, state = load_plan_and_state(output)
    tree_sha, commit_sha, branch_sha = validated_publication_state(plan, state)
    if tree_sha is None:
        fail("cannot record the transfer commit before the tree SHA")
    if commit_sha is not None or branch_sha is not None:
        fail("transfer commit SHA is already recorded")
    state["transferCommitSha"] = returned_sha
    write_json_atomic(output.resolve() / UPLOAD_STATE_NAME, state)
    print(f"recordedTransferCommitSha={returned_sha}")
    print("next=run --show-next-upload for exact branch arguments")


def record_branch_sha(output: Path, returned_sha: str) -> None:
    returned_sha = require_sha1(returned_sha, label="resolved transfer branch SHA")
    plan, state = load_plan_and_state(output)
    tree_sha, commit_sha, branch_sha = validated_publication_state(plan, state)
    if tree_sha is None or commit_sha is None:
        fail("cannot record the transfer branch before the commit SHA")
    if branch_sha is not None:
        fail("transfer branch SHA is already recorded")
    if returned_sha != commit_sha:
        fail(
            "transfer branch target mismatch: "
            f"expected {commit_sha}, found {returned_sha}; do not publish"
        )
    state["transferBranchSha"] = returned_sha
    write_json_atomic(output.resolve() / UPLOAD_STATE_NAME, state)
    print(f"recordedTransferBranchSha={returned_sha}")
    print("readyToPublish=true")
    print("next=run --show-next-upload for the exact publication command")


def reset_upload_index(output: Path, index: int) -> None:
    if index < 1:
        fail("reset upload index must be positive")
    plan, state = load_plan_and_state(output)
    files = plan["files"]
    completed = state["completedUploads"]
    assert isinstance(files, list)
    assert isinstance(completed, list)
    validated_completed_uploads(plan, state)

    planned = next(
        (
            item
            for item in files
            if isinstance(item, dict) and item.get("index") == index
        ),
        None,
    )
    if planned is None:
        fail(f"upload plan does not contain index {index}")

    retained = [item for item in completed if item.get("index") != index]
    if len(retained) == len(completed):
        fail(f"upload index {index} is not currently recorded")
    state["completedUploads"] = retained
    cleared_publication_state = False
    for field in PUBLICATION_STATE_FIELDS:
        if field in state:
            cleared_publication_state = True
            state.pop(field)
    write_json_atomic(output.resolve() / UPLOAD_STATE_NAME, state)

    earliest = next_pending_file(plan, state)
    print(f"resetUpload={index}")
    print(f"path={planned['path']}")
    if cleared_publication_state:
        print("clearedPublicationState=true")
    if earliest is not None:
        print(f"nextUploadIndex={earliest['index']}")
        print(f"nextPath={earliest['path']}")
    print("next=run --show-next-upload; the file has not been opened")
