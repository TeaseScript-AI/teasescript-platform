# Verified patch publication

## Purpose

The verified patch-publication workflow is a narrow fallback for a network-restricted agent that can edit, commit, and test a repository locally but cannot reliably publish its Git commit through a normal `git push`.

Use the normal branch-and-pull-request workflow whenever it is available. Patch publication does not replace local development, review, CI, or merge approval. It only publishes one already prepared local change to the existing head branch of a same-repository pull request.

The protocol accepts one raw Git patch in either of two transport formats:

- format version 1 stores the complete patch in one `change.patch` file;
- format version 2 stores the same patch as ordered UTF-8 text parts.

Neither format uses Base64. Format version 2 exists to keep each connector upload small, readable, independently verifiable, and replaceable without changing the intended complete patch.

## Security boundary

The workflow separates untrusted candidate execution from repository write permission:

1. A request job accepts one exact command from a repository writer and binds it to the pull-request head branch and the exact current transfer-branch commit.
2. A read-only prepare job verifies that exact transfer revision, validates the payload, and creates one deterministic candidate commit.
3. A separate read-only test job runs repository checks on that exact candidate.
4. A write-capable publish job re-verifies the tested candidate without executing candidate-controlled code and performs a normal non-force push.
5. A cleanup job conditionally deletes only the exact authorized transfer-ref revision after success or a format-version-1 failure. After a format-version-2 failure, it preserves the exact ref for targeted repair; a ref that changed after authorization is always preserved.

The command must be placed in the pull request's **Conversation** tab. Commands on ordinary issues are rejected. Normal pull-request comments, review summaries, and inline review comments remain unaffected because only a comment matching the exact command syntax starts publication.

## Transfer payload

Create a unique branch whose name starts with:

```text
agent-patch-publication/
```

### Format version 1

The transfer directory contains exactly:

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

Format version 1 rules:

- `formatVersion` is the integer `1`.
- `targetBranch` must be the same-repository pull request head branch.
- `targetBranch` must not be the default branch or use the transfer-branch namespace.
- `expectedBaseSha` is the exact current target-branch commit.
- `expectedResultTreeSha` is the exact tree produced by the local tested commit.
- `patchSha256` is the lowercase SHA-256 of the exact `change.patch` bytes.
- `commitMessage` is one non-empty line of at most 240 UTF-8 bytes.
- Missing, duplicate, unknown, or incorrectly typed fields are rejected.

### Format version 2

The transfer directory contains exactly one manifest and the parts declared by that manifest:

```text
.agent-patch-publication/manifest.json
.agent-patch-publication/parts/change.patch.part-0001-of-0002
.agent-patch-publication/parts/change.patch.part-0002-of-0002
```

Each part contains ordinary raw UTF-8 patch text, not Base64. The complete patch SHA-256 is calculated before splitting. The manifest records that complete digest plus the exact size and SHA-256 of every part:

```json
{
  "formatVersion": 2,
  "targetBranch": "feat/example",
  "expectedBaseSha": "0123456789abcdef0123456789abcdef01234567",
  "expectedResultTreeSha": "89abcdef0123456789abcdef0123456789abcdef",
  "patchSizeBytes": 131072,
  "patchSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "parts": [
    {
      "path": ".agent-patch-publication/parts/change.patch.part-0001-of-0002",
      "sizeBytes": 65536,
      "sha256": "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"
    },
    {
      "path": ".agent-patch-publication/parts/change.patch.part-0002-of-0002",
      "sizeBytes": 65536,
      "sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    }
  ],
  "commitMessage": "Apply tested local change"
}
```

Format version 2 rules:

- part paths are canonical and ordered: `change.patch.part-NNNN-of-MMMM`;
- every declared part must exist as a regular non-executable file;
- undeclared files inside `.agent-patch-publication/` are rejected;
- every part must be valid UTF-8 and at most 256 KiB;
- each declared byte size and SHA-256 must match the exact part bytes;
- the declared part sizes must sum to `patchSizeBytes`;
- concatenating the parts in manifest order must reproduce `patchSizeBytes` and `patchSha256` exactly;
- the transport accepts at most 1,024 parts and a 64 MiB reconstructed patch;
- all target, base, result-tree, message, and strict-field rules from format version 1 still apply.

## Preparing a request

Start from a clean local tested commit whose only parent is the exact current head of the target pull-request branch. Use the repository helper for format version 2:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --repository . \
  --target-branch feat/example \
  --expected-base-sha "$(git rev-parse HEAD^)" \
  --tested-commit "$(git rev-parse HEAD)" \
  --part-size-kib 64 \
  --output-directory /tmp/patch-publication-payload
```

The helper uses the tested commit's parent, result tree, and subject directly. It then:

1. generates the exact `git diff --binary --full-index --no-renames` patch;
2. calculates the complete patch SHA-256 before splitting;
3. splits only at valid UTF-8 boundaries, preferring diff, hunk, or newline boundaries;
4. writes canonical ordinary-text part files and their sizes and SHA-256 values;
5. writes the strict format-version-2 manifest;
6. reconstructs the parts and proves byte identity before publishing the output directory.

The default and recommended part size is 64 KiB. The helper also accepts 128 or 256 KiB for controlled transport tests. It refuses a dirty worktree, a tested commit other than current `HEAD`, a wrong expected parent, an empty patch, or an existing output path.

Upload the generated `.agent-patch-publication/manifest.json` and every generated part without editing them. Calculate the command digest from the final manifest bytes:

```shell
MANIFEST_SHA256="$(python3 -c 'import hashlib, pathlib; print(hashlib.sha256(pathlib.Path("/tmp/patch-publication-payload/.agent-patch-publication/manifest.json").read_bytes()).hexdigest())')"
```

Format version 1 remains supported for a small single-file transfer. Its `change.patch` and manifest may still be generated using the original exact Git diff and SHA-256 procedure. Do not combine format-version-1 and format-version-2 payload files on one transfer branch.

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

The request job resolves the transfer branch to one exact commit SHA and verifies the exact manifest digest before accepting the request. The prepare job must fetch that same transfer commit. The manifest then binds either the complete format-version-1 patch or every format-version-2 part plus the final reconstructed patch.

The workflow rejects the request before publication when, among other checks:

- the actor lacks `write`, `maintain`, or `admin` repository permission;
- the comment is not attached to a pull request;
- the pull-request head belongs to another repository;
- the transfer branch does not resolve to a commit or moves before prepare reads it;
- the manifest digest differs from the command;
- a required payload file is missing, undeclared, not a regular file, or has the wrong canonical path;
- a part's size, SHA-256, or UTF-8 validity differs from the manifest;
- the reconstructed patch size or SHA-256 differs from the manifest;
- the manifest target differs from the pull-request head branch;
- the target branch moved from `expectedBaseSha`;
- the patch does not apply exactly, produces no change, or modifies `.agent-patch-publication/`;
- the resulting tree differs from `expectedResultTreeSha`;
- candidate metadata or the candidate bundle changes between preparation, test, and publication;
- repository checks fail;
- the final target update is not a normal fast-forward.

Target-branch publication never force-pushes, rebases, or merges. Cleanup uses an exact-SHA `--force-with-lease` only to delete the temporary transfer ref; it cannot update or delete a changed transfer ref.

## Failure, cleanup, and retry

After a successful publication, cleanup removes the transfer branch only when it still points to the exact commit authorized by the request job. A branch that was already removed is reported as absent. A branch that was updated or recreated is preserved so an older run cannot destroy a newer upload.

Format version 1 treats a transfer branch as immutable after the command is placed. For a retry, start from the current target head, regenerate the patch, manifest, and both SHA-256 values, upload them on a new unique transfer branch, and place a new exact command. Never reuse an old authorization comment.

Format version 2 preserves the exact transfer branch when publication fails. When the manifest already contains the intended size and SHA-256 for a part that was uploaded incorrectly, replace only that part, commit the corrected transfer branch, and place a new `/publish-patch` command. The manifest and its command digest remain unchanged. The new command binds the retry to the branch's new commit SHA, while any older run is unable to delete the changed ref. When the manifest itself is wrong, regenerate it and use its new digest in the new command.

A malformed or unauthorized command fails before accepting a transfer ref; remove that unused branch manually. Automatic expiry for abandoned or never-authorized transfer branches is not part of this protocol.

## Reproducible local verification

```shell
python3 -B tools/local-agent/test-patch-publication.py
bash tools/local-agent/test-patch-publication-workflow.sh
```

The first suite covers both formats, deterministic generation at 64, 128, and 256 KiB, strict part paths, missing and extra files, per-part size and digest failures, UTF-8 validation, exact reconstruction, targeted one-part repair, patch and tree validation, forbidden paths, and bundle tampering. The second combines static workflow-contract checks with a real bare remote to cover retry-preserving cleanup, target-race rejection, exact-base publication, changed-ref preservation, exact-SHA deletion, PR binding, and immutable Action pins. GitHub event identity, permissions, artifact transport, and token behavior remain canonical-CI concerns.

## Current limits and follow-ups

Format version 1 remains the smallest transport for one manageable raw `change.patch`. Format version 2 is the normal multipart transport. Its recommended part size is 64 KiB. The 128 and 256 KiB settings are supported for controlled connector trials; 256 KiB is the current protocol ceiling, not the recommended default. Lower that ceiling in a follow-up when real connector evidence shows it is unreliable.

Neither format accepts Base64. The protocol limits format version 2 to 1,024 parts, 256 KiB per part, and a 64 MiB reconstructed patch as bounded publication-tooling guards rather than TeaseScript content limits.

The publish job currently uses the repository `GITHUB_TOKEN`. GitHub may require manual approval before a subsequent pull-request workflow runs after that token updates the PR branch. Replacing only the isolated publish credential with a repository-scoped GitHub App installation token is a separate operational follow-up; prepare and test jobs must remain read-only and must not receive the App private key.

All external Actions used by the write-capable workflow are pinned to reviewed immutable commit SHAs. Updating a pin requires a normal dependency review and CI run.
