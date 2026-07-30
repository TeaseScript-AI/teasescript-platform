#!/usr/bin/env python3
"""Build local upload plans for prepared patch-publication payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from patch_publication_support import (
    TRANSFER_DIRECTORY,
    UPLOAD_INSTRUCTIONS_NAME,
    UPLOAD_PLAN_NAME,
    UPLOAD_STATE_NAME,
    TokenEstimator,
    git_blob_sha,
    sha256_bytes,
    write_json_atomic,
)

def upload_files_for_plan(
    *,
    temp_root: Path,
    manifest_path: Path,
    manifest_parts: list[dict[str, object]],
    token_counts: list[int | None],
    count_tokens: Callable[[bytes], int] | None,
) -> list[dict[str, object]]:
    files: list[dict[str, object]] = []
    for index, (entry, token_count) in enumerate(
        zip(manifest_parts, token_counts, strict=True), start=1
    ):
        relative_path = str(entry["path"])
        value = (temp_root / relative_path).read_bytes()
        files.append(
            {
                "index": index,
                "path": relative_path,
                "localPath": relative_path,
                "kind": "part",
                "sizeBytes": len(value),
                "sha256": sha256_bytes(value),
                "expectedGitBlobSha": git_blob_sha(value),
                "estimatedConnectorTokens": token_count,
            }
        )
    manifest_value = manifest_path.read_bytes()
    manifest_token_count = (
        count_tokens(manifest_value) if count_tokens is not None else None
    )
    files.append(
        {
            "index": len(files) + 1,
            "path": f"{TRANSFER_DIRECTORY}/manifest.json",
            "localPath": f"{TRANSFER_DIRECTORY}/manifest.json",
            "kind": "manifest",
            "sizeBytes": len(manifest_value),
            "sha256": sha256_bytes(manifest_value),
            "expectedGitBlobSha": git_blob_sha(manifest_value),
            "estimatedConnectorTokens": manifest_token_count,
        }
    )
    return files


def render_upload_instructions(
    *,
    output: Path,
    repository_full_name: str | None,
    transfer_branch: str,
    manifest_sha256: str,
    expected_base_sha: str,
    target_tokens: int | None,
    fallback_bytes: int,
) -> str:
    token_text = (
        f"o200k_base target: at most {target_tokens:,} estimated tokens per part's "
        "JSON string content"
        if target_tokens is not None
        else f"tokenizer unavailable: byte fallback of at most {fallback_bytes:,} bytes per part"
    )
    return f"""# Sequential connector upload

The payload is ready. Do not open or print all parts at once.

- Repository: `{repository_full_name or "<owner/name required before upload>"}`
- Transfer branch: `{transfer_branch}`
- Sizing mode: {token_text}
- Connector direction: use the GitHub connector action that creates one UTF-8
  Git blob from text (currently `GitHub.create_blob`). Do not Base64-encode the
  patch.

For every upload, run this command first:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \\
  --output-directory {output} \\
  --show-next-upload
```

It prints exactly one pending file and connector-ready arguments. Immediately
call the connector, compare its returned blob SHA with `expectedGitBlobSha`,
then record it:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \\
  --output-directory {output} \\
  --record-upload-sha <returned-git-blob-sha>
```

Only after a successful recorded SHA should the next part be opened. Already
transmitted content still remains in the conversation/tool history; this
sequence avoids preloading later parts and avoids a separate all-parts dump.

If a later connector step reports that one recorded blob is unavailable or
invalid, reset only that upload index and resend the exact same local file:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory {output} \
  --reset-upload-index <index>
```

The reset removes only the local progress record. It does not regenerate,
modify, or open the part.

When all files are recorded, `--show-next-upload` prints the exact
`tree_elements` argument for the GitHub action that creates a tree. Use no base
tree. Then:

1. create a commit for the returned tree using parent `{expected_base_sha}`;
2. create `{transfer_branch}` at the returned commit;
3. place this exact pull-request Conversation command:

```text
/publish-patch {transfer_branch} {manifest_sha256}
```

The current connector action names may change; follow the printed action
direction and argument shape rather than relying only on a hard-coded name.
`upload-plan.json`, `upload-state.json`, and this instruction file are local
guidance only. Never upload them. Upload only files below
`{TRANSFER_DIRECTORY}/`.
"""




def write_upload_handoff(
    *,
    temp_root: Path,
    output: Path,
    manifest_path: Path,
    manifest_parts: list[dict[str, object]],
    token_counts: list[int | None],
    estimator: TokenEstimator | None,
    repository_full_name: str | None,
    target_branch: str,
    transfer_branch: str,
    expected_base_sha: str,
    expected_base_tree_sha: str,
    tested_commit: str,
    expected_result_tree_sha: str,
    target_part_tokens: int,
    part_size_bytes: int,
) -> str:
    manifest_sha256 = sha256_bytes(manifest_path.read_bytes())
    upload_files = upload_files_for_plan(
        temp_root=temp_root,
        manifest_path=manifest_path,
        manifest_parts=manifest_parts,
        token_counts=token_counts,
        count_tokens=estimator.count_bytes if estimator else None,
    )
    tree_elements = [
        {
            "path": str(item["path"]),
            "mode": "100644",
            "type": "blob",
            "sha": str(item["expectedGitBlobSha"]),
        }
        for item in upload_files
    ]
    publication_command = f"/publish-patch {transfer_branch} {manifest_sha256}"
    plan = {
        "planVersion": 1,
        "repositoryFullName": repository_full_name,
        "targetBranch": target_branch,
        "transferBranch": transfer_branch,
        "expectedBaseSha": expected_base_sha,
        "expectedBaseTreeSha": expected_base_tree_sha,
        "testedCommitSha": tested_commit,
        "expectedResultTreeSha": expected_result_tree_sha,
        "manifestSha256": manifest_sha256,
        "publicationCommand": publication_command,
        "connector": {
            "provider": "GitHub",
            "blobActionHint": "create one UTF-8 Git blob from text (currently create_blob)",
            "treeActionHint": "create a Git tree from blob entries (currently create_tree)",
            "commitActionHint": "create a commit for a returned tree (currently create_commit)",
            "branchActionHint": "create the transfer branch at a commit (currently create_branch)",
            "encoding": "utf-8",
        },
        "transferTreeElements": tree_elements,
        "transferCommit": {
            "message": f"Prepare patch publication for {target_branch}",
            "parentSha": expected_base_sha,
        },
        "sizing": {
            "mode": "o200k_base" if estimator else "byteFallback",
            "targetPartTokens": target_part_tokens if estimator else None,
            "tokenMeasurement": (
                "o200k_base tokens for the JSON-serialized content string"
                if estimator else None
            ),
            "tokenizerVocabularyPath": (
                str(estimator.vocabulary_path) if estimator else None
            ),
            "tokenizerVocabularySha256": (
                estimator.vocabulary_sha256 if estimator else None
            ),
            "maximumPartSizeBytes": part_size_bytes,
        },
        "files": upload_files,
    }
    write_json_atomic(temp_root / UPLOAD_PLAN_NAME, plan)
    write_json_atomic(
        temp_root / UPLOAD_STATE_NAME,
        {"stateVersion": 1, "completedUploads": []},
    )
    (temp_root / UPLOAD_INSTRUCTIONS_NAME).write_text(
        render_upload_instructions(
            output=output,
            repository_full_name=repository_full_name,
            transfer_branch=transfer_branch,
            manifest_sha256=manifest_sha256,
            expected_base_sha=expected_base_sha,
            target_tokens=target_part_tokens if estimator else None,
            fallback_bytes=part_size_bytes,
        ),
        encoding="utf-8",
        newline="\n",
    )
    return manifest_sha256
