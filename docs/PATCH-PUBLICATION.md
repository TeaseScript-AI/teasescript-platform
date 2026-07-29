# Verified patch publication

## Purpose

The verified patch-publication workflow is a narrow fallback for a network-restricted agent that can edit, commit, and test a repository locally but cannot reliably publish its Git commit through a normal `git push`.

Use the normal branch-and-pull-request workflow whenever it is available. Patch publication does not replace local development, review, CI, or merge approval. It only publishes one already prepared local change to the existing head branch of a same-repository pull request.

The current protocol accepts one raw Git patch. Base64 transport and multipart payloads are not part of format version 1.

## Security boundary

The workflow separates untrusted candidate execution from repository write permission:

1. A request job accepts one exact command from a repository writer and binds it to the pull-request head branch and the exact current transfer-branch commit.
2. A read-only prepare job verifies that exact transfer revision, validates the payload, and creates one deterministic candidate commit.
3. A separate read-only test job runs repository checks on that exact candidate.
4. A write-capable publish job re-verifies the tested candidate without executing candidate-controlled code and performs a normal non-force push.
5. A cleanup job atomically deletes only the exact authorized transfer-ref revision and reports whether it was removed, already absent, or preserved because it changed.

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

The `issue_comment` event loads workflows from the default branch. This protocol becomes available only after `.github/workflows/patch-publication.yml` has been merged into the repository's default branch.

Place exactly this command in the Conversation tab of the target pull request:

```text
/publish-patch agent-patch-publication/<unique-id> <manifest-sha256>
```

For example:

```text
/publish-patch agent-patch-publication/issue-123-attempt-1 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The request job resolves the transfer branch to one exact commit SHA. The prepare job must fetch that same SHA. The SHA in the comment binds the authorization to the exact `manifest.json` bytes, and the manifest binds the exact `change.patch` bytes through `patchSha256`.

The workflow rejects the request before publication when, among other checks:

- the actor lacks `write`, `maintain`, or `admin` repository permission;
- the comment is not attached to a pull request;
- the pull-request head belongs to another repository;
- the transfer branch does not resolve to a commit or moves before prepare reads it;
- the manifest digest differs from the command;
- the patch digest differs from the manifest;
- the manifest target differs from the pull-request head branch;
- the target branch moved from `expectedBaseSha`;
- the patch does not apply exactly, produces no change, or modifies `.agent-patch-publication/`;
- the resulting tree differs from `expectedResultTreeSha`;
- candidate metadata or the candidate bundle changes between preparation, test, and publication;
- repository checks fail;
- the final target update is not a normal fast-forward.

Target-branch publication never force-pushes, rebases, or merges. Cleanup uses an exact-SHA `--force-with-lease` only to delete the temporary transfer ref; it cannot update or delete a changed transfer ref.

## Failure, cleanup, and retry

After an accepted command, cleanup attempts to remove the transfer branch only when it still points to the exact commit authorized by the request job. A branch that was already removed is reported as absent. A branch that was updated or recreated is preserved so an older run cannot destroy a newer upload.

Format version 1 treats a transfer branch as immutable after the command is placed. For a retry, start from the current target head, regenerate the patch, manifest, and both SHA-256 values, upload them on a new unique transfer branch, and place a new exact command. Never reuse an old authorization comment.

A malformed or unauthorized command fails before accepting a transfer ref; remove that unused branch manually. Automatic expiry for abandoned or never-authorized transfer branches is not part of format version 1.

## Reproducible local verification

```shell
python3 -B tools/local-agent/test-patch-publication.py
bash tools/local-agent/test-patch-publication-workflow.sh
```

The first suite covers strict manifests, patch and tree validation, forbidden paths, and bundle tampering. The second uses a real bare remote to prove that a moved target rejects publication, an exact-base candidate fast-forwards, stale cleanup preserves a changed transfer ref, exact-SHA cleanup deletes the intended transfer ref, the command is PR-bound, and external Actions are immutable-SHA pinned. GitHub event identity, permissions, artifact transport, and token behavior remain canonical-CI concerns.

## Current limits and follow-ups

Format version 1 supports exactly one raw `change.patch`. It does not accept a Base64 payload or `part-N-of-M` files. Multipart transport requires a separately reviewed protocol with ordered parts, per-part size and digest validation, final reconstructed-patch validation, and focused failure tests. A future multipart retry policy may preserve a failed payload for replacement of only the invalid part; that policy must retain the exact transfer-SHA race protection introduced here.

The publish job currently uses the repository `GITHUB_TOKEN`. GitHub may require manual approval before a subsequent pull-request workflow runs after that token updates the PR branch. Replacing only the isolated publish credential with a repository-scoped GitHub App installation token is a separate operational follow-up; prepare and test jobs must remain read-only and must not receive the App private key.

All external Actions used by the write-capable workflow are pinned to reviewed immutable commit SHAs. Updating a pin requires a normal dependency review and CI run.
