# Verified patch publication

## Purpose

The verified patch-publication workflow is a narrow fallback for a network-restricted agent that can edit, commit, and test a repository locally but cannot reliably publish its Git commit through a normal `git push`.

Use the normal branch-and-pull-request workflow whenever it is available. Patch publication does not replace local development, review, CI, or merge approval. It only publishes one already prepared local change to the existing head branch of a same-repository pull request.

The current protocol accepts one raw Git patch. Base64 transport and multipart payloads are not part of format version 1.

## Security boundary

The workflow separates untrusted candidate execution from repository write permission:

1. A request job accepts one exact command from a repository writer and binds it to the head branch of the pull request containing the command.
2. A read-only prepare job verifies the transfer payload and creates one deterministic candidate commit.
3. A separate read-only test job runs repository checks on that exact candidate.
4. A write-capable publish job re-verifies the tested candidate without executing candidate-controlled code and performs a normal non-force push.
5. A cleanup job deletes the transfer branch and reports the result on the pull request.

The command must be placed in the pull request's **Conversation** tab. Commands on ordinary issues are rejected. Normal pull-request comments, review summaries, and inline review comments remain unaffected because only a comment matching the exact command syntax starts publication.

## Transfer payload

Create a unique branch whose name starts with:

```text
agent-patch-publication/
```

The transfer branch must contain these two files:

```text
.agent-patch-publication/manifest.json
.agent-patch-publication/change.patch
```

`change.patch` is the exact binary-capable Git patch to apply. `manifest.json` uses this schema:

```json
{
  "formatVersion": 1,
  "targetBranch": "feat/example",
  "expectedBaseSha": "0123456789abcdef0123456789abcdef01234567",
  "expectedResultTreeSha": "89abcdef0123456789abcdef0123456789abcdef",
  "patchSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "commitMessage": "Apply tested local change"
}
```

Rules:

- `formatVersion` is the integer `1`.
- `targetBranch` must be the same-repository pull request head branch.
- `targetBranch` must not be the default branch or use the transfer-branch namespace.
- `expectedBaseSha` is the exact current target-branch commit.
- `expectedResultTreeSha` is the exact tree produced by the local tested commit.
- `patchSha256` is the lowercase SHA-256 of the exact `change.patch` bytes.
- `commitMessage` is one non-empty line of at most 240 UTF-8 bytes.
- Missing, duplicate, unknown, or incorrectly typed fields are rejected.

## Preparing a request

Start from a clean local commit whose only parent is the exact current head of the target pull-request branch.

```shell
TARGET_BRANCH=feat/example
EXPECTED_BASE_SHA="$(git rev-parse HEAD^)"
LOCAL_COMMIT="$(git rev-parse HEAD)"
EXPECTED_RESULT_TREE_SHA="$(git show -s --format=%T "$LOCAL_COMMIT")"
COMMIT_MESSAGE="$(git show -s --format=%s "$LOCAL_COMMIT")"

git diff --binary --full-index --no-renames \
  "$EXPECTED_BASE_SHA" "$LOCAL_COMMIT" > change.patch

PATCH_SHA256="$(python3 -c 'import hashlib, pathlib; print(hashlib.sha256(pathlib.Path("change.patch").read_bytes()).hexdigest())')"
```

Write the final manifest only after all values are known. The following example avoids shell-escaping JSON values manually:

```shell
python3 - \
  "$TARGET_BRANCH" \
  "$EXPECTED_BASE_SHA" \
  "$EXPECTED_RESULT_TREE_SHA" \
  "$PATCH_SHA256" \
  "$COMMIT_MESSAGE" \
  > manifest.json <<'PY'
import json
import sys

branch, base, tree, patch_sha256, message = sys.argv[1:]
json.dump(
    {
        "formatVersion": 1,
        "targetBranch": branch,
        "expectedBaseSha": base,
        "expectedResultTreeSha": tree,
        "patchSha256": patch_sha256,
        "commitMessage": message,
    },
    sys.stdout,
    indent=2,
)
sys.stdout.write("\n")
PY

MANIFEST_SHA256="$(python3 -c 'import hashlib, pathlib; print(hashlib.sha256(pathlib.Path("manifest.json").read_bytes()).hexdigest())')"
```

Upload the final, unchanged `manifest.json` and `change.patch` to the two required paths on one new transfer branch. Do not edit either file after calculating `MANIFEST_SHA256`.

## Starting publication

Place exactly this command in the Conversation tab of the target pull request:

```text
/publish-patch agent-patch-publication/<unique-id> <manifest-sha256>
```

For example:

```text
/publish-patch agent-patch-publication/issue-123-attempt-1 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The SHA in the comment binds the authorization to the exact `manifest.json` bytes. The manifest then binds the request to the exact `change.patch` bytes through `patchSha256`.

The workflow rejects the request before publication when, among other checks:

- the actor lacks `write`, `maintain`, or `admin` repository permission;
- the comment is not attached to a pull request;
- the pull-request head belongs to another repository;
- the manifest digest differs from the command;
- the patch digest differs from the manifest;
- the manifest target differs from the pull-request head branch;
- the target branch moved from `expectedBaseSha`;
- the patch does not apply exactly, produces no change, or modifies `.agent-patch-publication/`;
- the resulting tree differs from `expectedResultTreeSha`;
- candidate metadata or the candidate bundle changes between preparation, test, and publication;
- repository checks fail;
- the final update is not a normal fast-forward.

There is no force push, three-way patch fallback, automatic rebase, direct default-branch publication, or automatic merge.

## Failure, cleanup, and retry

After an accepted command, cleanup removes the validated transfer branch and reports success or failure on the pull request. A malformed or unauthorized command fails before accepting a branch; remove that unused branch manually.

For a retry, start from the current target head, regenerate the patch, manifest, and both SHA-256 values, upload them on a new transfer branch, and place a new exact command. Never reuse an old branch or authorization comment.

## Reproducible local verification

```shell
python3 -B tools/local-agent/test-patch-publication.py
bash tools/local-agent/test-patch-publication-workflow.sh
```

The first suite covers strict manifests, patch and tree validation, forbidden paths, and bundle tampering. The second uses a real bare remote to prove that a moved target rejects publication, an exact-base candidate fast-forwards, the transfer ref is deleted, the command is PR-bound, and external Actions are immutable-SHA pinned. GitHub event identity, permissions, artifact transport, and token behavior remain canonical-CI concerns.

## Current limits and follow-ups

Format version 1 supports exactly one raw `change.patch`. It does not accept a Base64 payload or `part-N-of-M` files. Multipart transport requires a separately reviewed protocol with ordered parts, per-part size and digest validation, final reconstructed-patch validation, and focused failure tests.

The publish job currently uses the repository `GITHUB_TOKEN`. GitHub may require manual approval before a subsequent pull-request workflow runs after that token updates the PR branch. Replacing only the isolated publish credential with a repository-scoped GitHub App installation token is a separate operational follow-up; prepare and test jobs must remain read-only and must not receive the App private key.

All external Actions used by the write-capable workflow are pinned to reviewed immutable commit SHAs. Updating a pin requires a normal dependency review and CI run.
