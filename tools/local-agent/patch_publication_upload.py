#!/usr/bin/env python3
"""Sequential connector-upload guidance for prepared patch payloads."""

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


def load_plan_and_state(output: Path) -> tuple[dict[str, object], dict[str, object]]:
    resolved = output.resolve()
    plan = load_json_object(resolved / UPLOAD_PLAN_NAME, label="upload plan")
    state = load_json_object(resolved / UPLOAD_STATE_NAME, label="upload state")
    files = plan.get("files")
    completed = state.get("completedUploads")
    if not isinstance(files, list) or not all(isinstance(item, dict) for item in files):
        fail("upload plan files must be an array of objects")
    if not isinstance(completed, list) or not all(
        isinstance(item, dict) for item in completed
    ):
        fail("upload state completedUploads must be an array of objects")
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
        if not isinstance(index, int) or index not in planned_by_index or index in validated:
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
    if not isinstance(relative, str) or not relative.startswith(f"{TRANSFER_DIRECTORY}/"):
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


def show_next_upload(output: Path) -> None:
    plan, state = load_plan_and_state(output)
    item = next_pending_file(plan, state)
    if item is None:
        repository_full_name = plan.get("repositoryFullName")
        transfer_branch = plan.get("transferBranch")
        tree_elements = plan.get("transferTreeElements")
        transfer_commit = plan.get("transferCommit")
        if not isinstance(repository_full_name, str):
            fail("upload plan repositoryFullName must be a string")
        if not isinstance(transfer_branch, str):
            fail("upload plan transferBranch must be a string")
        if not isinstance(tree_elements, list):
            fail("upload plan transferTreeElements must be an array")
        if not isinstance(transfer_commit, dict):
            fail("upload plan transferCommit must be an object")
        print("all planned files have verified recorded Git blob SHAs")
        print("connector=GitHub action that creates a tree from Git blob entries")
        print("createTreeArguments=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "tree_elements": tree_elements,
                },
                ensure_ascii=False,
            )
        )
        print("afterTree=use the returned tree SHA with the GitHub commit action")
        print("createCommitArgumentsTemplate=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "message": transfer_commit.get("message"),
                    "tree_sha": "<returned-tree-sha>",
                    "parent_sha": transfer_commit.get("parentSha"),
                },
                ensure_ascii=False,
            )
        )
        print("afterCommit=create the transfer branch at the returned commit")
        print("createBranchArgumentsTemplate=")
        print(
            json.dumps(
                {
                    "repository_full_name": repository_full_name,
                    "branch_name": transfer_branch,
                    "sha": "<returned-commit-sha>",
                },
                ensure_ascii=False,
            )
        )
        print(f"publicationCommand={plan['publicationCommand']}")
        return
    value = verify_planned_file(output, item)
    repository_full_name = plan.get("repositoryFullName")
    if not isinstance(repository_full_name, str):
        fail("upload plan repositoryFullName must be a string")
    content = value.decode("utf-8")
    print(f"uploadIndex={item['index']} of {len(plan['files'])}")
    print(f"path={item['path']}")
    print(f"sizeBytes={item['sizeBytes']}")
    print(f"sha256={item['sha256']}")
    print(f"expectedGitBlobSha={item['expectedGitBlobSha']}")
    if item.get("estimatedConnectorTokens") is not None:
        print(f"estimatedConnectorTokens={item['estimatedConnectorTokens']}")
    print("connector=GitHub action that creates one UTF-8 blob (currently create_blob)")
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
    print(
        f"python3 -B {CLI_PATH.as_posix()} --output-directory "
        f"{output.resolve().as_posix()} --record-upload-sha <returned-git-blob-sha>"
    )


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
        print("next=run --show-next-upload for connector-ready tree, commit, and branch steps")
        print(f"transferBranch={plan['transferBranch']}")
        print(f"publicationCommand={plan['publicationCommand']}")
    else:
        print(f"nextUploadIndex={next_item['index']}")
        print(f"nextPath={next_item['path']}")
        print("next=run --show-next-upload; no later part has been opened")


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
    write_json_atomic(output.resolve() / UPLOAD_STATE_NAME, state)

    earliest = next_pending_file(plan, state)
    print(f"resetUpload={index}")
    print(f"path={planned['path']}")
    if earliest is not None:
        print(f"nextUploadIndex={earliest['index']}")
        print(f"nextPath={earliest['path']}")
    print("next=run --show-next-upload; the file has not been opened")
