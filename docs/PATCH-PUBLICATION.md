# Verified patch publication

## Purpose

The verified patch-publication workflow is a narrow fallback for a network-restricted agent that can edit, commit, and test a repository locally but cannot reliably publish its Git commit through a normal `git push`.

Use the normal branch-and-pull-request workflow whenever it is available. Patch publication does not replace local development, review, CI, or merge approval. It only publishes one already prepared local change to the existing head branch of a same-repository pull request.

The protocol accepts one raw Git patch as format-version-2 ordered UTF-8 text parts. A small patch may use one part. The format does not use Base64. Parts keep each connector upload small, token-efficient, independently verifiable, and replaceable without changing the intended complete patch. The local preparation helper emits ordinary raw diff text and exposes only one pending upload at a time; agents must not pre-open every part into model context.

## Security boundary

The workflow separates untrusted candidate execution from repository write permission:

1. A request job accepts one exact command from a repository writer and binds it to the pull-request head branch and the exact current transfer-branch commit.
2. A read-only prepare job verifies that exact transfer revision, validates the payload, and creates one deterministic candidate commit.
3. A separate read-only test job runs repository checks on that exact candidate.
4. A write-capable publish job re-verifies the tested candidate without executing candidate-controlled code and performs a normal non-force push.
5. A `contents: write` cleanup job checks out only the exact trusted workflow revision and runs the trusted cleanup script without executing candidate-controlled code. It preserves the unchanged exact format-version-2 transfer ref after a failed publication for targeted repair; otherwise it deletes only the exact authorized transfer-ref revision with SHA-bound `--force-with-lease`. A ref that changed after authorization is always preserved.
6. A separate cleanup job with `contents: read` and `pull-requests: write` checks out only the exact trusted workflow revision, revalidates the original event identity, and then reads the current comment by exact ID, pull request, and unchanged body immediately before deletion. It treats an already-absent comment as a successful no-op, requires any completed delete call to return HTTP 204, and records explicit transfer- and command-cleanup statuses in the Actions summary.

The command must be placed in the pull request's **Conversation** tab. Commands on ordinary issues are rejected. Normal pull-request comments, review summaries, inline review comments, malformed commands, and unauthorized commands remain unaffected. An accepted technical command is removed after the workflow no longer needs it; the Actions run summary remains the audit trail.

## Transfer payload

Create a unique branch whose name starts with:

```text
agent-patch-publication/
```

The complete branch name must match the workflow contract exactly: 1 to 240
ASCII characters using only letters, digits, `.`, `_`, `/`, or `-`; it must not
be only the prefix, contain `..`, contain `//`, or end with `/`.

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
- `targetBranch` must be the same-repository pull-request head branch and must not be the default branch or use the transfer namespace;
- `expectedBaseSha` is the exact current target-branch commit;
- `expectedResultTreeSha` is the exact tree produced by the locally tested result;
- `patchSha256` is the lowercase SHA-256 of the complete reconstructed patch;
- `commitMessage` is one non-empty line of at most 240 UTF-8 bytes;
- missing, duplicate, unknown, or incorrectly typed fields are rejected.

## Preparing a request

Start from a clean local worktree whose current `HEAD` is the fully tested result. Supply the exact current target-branch commit as `--expected-base-sha`. That base may be an earlier ancestor of the tested `HEAD`; the helper publishes the complete tree difference across one or more local commits. It never merges, rebases, squashes, commits, or pushes.

### Prepare the payload

Use the repository helper. Keep the OpenAI vocabulary and the optional `tiktoken` Python package in the local offline toolchain, not in this repository:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --repository . \
  --repository-full-name TeaseScript-AI/teasescript-platform \
  --target-branch feat/example \
  --transfer-branch agent-patch-publication/example-attempt-1 \
  --expected-base-sha <exact-current-target-head> \
  --tested-commit "$(git rev-parse HEAD)" \
  --tokenizer /path/to/o200k_base.tiktoken \
  --target-part-tokens 3000 \
  --part-size-kib 12 \
  --output-directory /tmp/patch-publication-payload
```

`TEASESCRIPT_O200K_TOKENIZER` may provide the tokenizer path instead of `--tokenizer`. The helper verifies the official vocabulary SHA-256 before use. Token-aware mode also requires the local `tiktoken` Python package; it is an optional offline-toolchain dependency and is not added to the project runtime or repository dependencies.

The helper:

1. verifies a clean worktree and that the tested commit is current `HEAD`;
2. verifies that the exact supplied base is an ancestor of the tested result;
3. generates `git diff --binary --full-index --no-renames <base> <tested>`;
4. keeps normal source and documentation changes as ordinary readable unified diff text; `--binary` adds Git binary-patch text only for genuinely binary file changes that otherwise could not be reconstructed;
5. calculates the complete patch SHA-256 before splitting;
6. when the local tokenizer is available, limits each part to a default target of 3,000 `o200k_base` tokens measured over the JSON-serialized connector content string;
7. always enforces the independent byte ceiling, using 12 KiB as the default fallback when token measurement is unavailable;
8. prefers readable Git diff, hunk, or newline boundaries only when that preference does not increase the minimum feasible part count under the active ceilings;
9. applies every active operational byte and token budget to every planned connector upload, including the unsplittable manifest, and fails before exposing an unusable plan;
10. writes canonical ordinary UTF-8 part files and their sizes and SHA-256 values;
11. writes the strict format-version-2 manifest;
12. reconstructs the parts and proves byte identity;
13. writes local-only `upload-plan.json`, `upload-state.json`, and `UPLOAD-INSTRUCTIONS.md` with expected Git blob SHAs, the expected payload-only transfer-tree SHA, and the exact publication command.

The 3,000-token target and 12 KiB byte ceiling are conservative operational starting points for every connector upload, including `manifest.json`, not connector guarantees or protocol limits. Because the manifest is not itself multipart, preparation fails when its generated byte size or measured token count exceeds an active operational budget. During the first real sequential connector trial for this pull request, an ordinary UTF-8 blob of 14,317 bytes remained retrievable while a 16,204-byte call returned the expected blob SHA but the blob was subsequently unavailable to both `fetch_blob` and `create_tree`. That single observation does not establish a universal hard limit; it justifies leaving margin below the observed failure. Token-aware sizing also splits tokenizer-hostile Base85 sections for genuinely binary files earlier than ordinary source diffs. The independent protocol maximum remains 256 KiB per part. Without the local tokenizer, the helper clearly reports byte-fallback mode rather than pretending it measured tokens.

Do not transform the complete normal patch into Git binary-patch/Base85 or Base64 merely to reduce bytes. For source changes that often costs substantially more model tokens. Use the raw Git diff produced by the helper; `git diff --binary` does not binary-encode ordinary text files.

### Sequential connector upload

Do not print every part or use a command that emits all escaped chunks. Ask the helper for exactly one pending upload:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory /tmp/patch-publication-payload \
  --show-next-upload
```

The command verifies the local file again and prints one connector-ready argument object for the GitHub action that creates a UTF-8 Git blob from text, currently `GitHub.create_blob`. Call that connector immediately. Compare its returned Git blob SHA with `expectedGitBlobSha`, then record the result:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory /tmp/patch-publication-payload \
  --record-upload-sha <returned-git-blob-sha>
```

A mismatch fails without advancing the local state. A match records that file and identifies the next path, but does not open it. Repeat `--show-next-upload` only when ready to send the next file. Parts are listed first and the manifest last. Previously transmitted content remains in the conversation and tool history; sequential exposure avoids preloading future parts and avoids a separate all-parts dump.

If a later connector step reports that one recorded blob is unavailable or invalid, reset only that upload index and resend the exact same local file:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory /tmp/patch-publication-payload \
  --reset-upload-index <index>
```

The reset removes only the verified local progress record. It does not regenerate, edit, or open the part. The next `--show-next-upload` exposes the earliest missing upload again.

Only files below `.agent-patch-publication/` belong in the transfer tree. The upload plan, state, and instruction file remain local. After recording all blobs, continue running `--show-next-upload`. It exposes only the next action and never prints later write actions early.

First create the payload-only transfer tree with the exact printed arguments and no base tree. Record its returned SHA:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory /tmp/patch-publication-payload \
  --record-tree-sha <returned-tree-sha>
```

The helper compares that SHA with the locally computed expected transfer-tree SHA. A mismatch fails without advancing. On success, the next `--show-next-upload` prints complete commit arguments containing the recorded tree SHA and the exact target-branch head as parent. Record the returned commit SHA:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory /tmp/patch-publication-payload \
  --record-commit-sha <returned-commit-sha>
```

The next action creates the planned transfer branch at that recorded commit. Resolve the created branch target and record it:

```shell
python3 -B tools/local-agent/prepare-patch-publication.py \
  --output-directory /tmp/patch-publication-payload \
  --record-branch-sha <resolved-transfer-branch-sha>
```

The branch target must equal the recorded commit. Only then does `--show-next-upload` reveal the exact `/publish-patch` command, the target branch, expected base, expected final project tree, and the post-publication verification checklist. Resetting any recorded blob clears the dependent tree, commit, and branch state. Prepared upload plans from the older local state format must be regenerated rather than migrated.

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

After placing the command, wait 90 seconds before the first target pull request head lookup. If the head is still unchanged, wait 30 seconds before each retry. These delays reduce unnecessary connector calls; they are not completion guarantees because GitHub Actions queue time and the full repository test duration vary.

The request job resolves the transfer branch to one exact commit SHA, records the exact command-comment identity, and verifies the exact manifest digest before accepting the request. The prepare job must fetch that same transfer commit. The manifest binds every declared part plus the final reconstructed patch. After the workflow finishes, a separately permissioned cleanup job deletes only that unchanged accepted command comment.

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

After a successful publication, cleanup removes the transfer branch only when it still points to the exact commit authorized by the request job. A branch that was already removed is reported as absent. A branch that was updated or recreated is preserved so an older run cannot destroy a newer upload. The write-capable cleanup jobs check out only the exact trusted `github.workflow_sha`, do not persist checkout credentials, and execute the reviewed repository cleanup scripts from that revision. The exact accepted technical command is deleted after the workflow no longer needs it. The Actions summary records explicit command cleanup as `removed`, `already_absent`, `preserved_changed`, or `failed` so a publication result cannot be mistaken for successful comment cleanup.

The comment is re-read and compared immediately before deletion. GitHub's issue-comment endpoint does not provide a conditional compare-and-delete operation, so an edit that occurs after that read but before the delete request cannot be detected by the workflow. Comments already changed when the read occurs are preserved; this narrower platform race remains an explicit residual limitation.

A failed publication preserves the unchanged exact transfer branch for targeted repair. When the manifest already contains the intended size and SHA-256 for a part that was uploaded incorrectly, replace only that part, commit the corrected transfer branch, and place a new `/publish-patch` command. The manifest and its command digest remain unchanged. The new command binds the retry to the branch's new commit SHA, while any older run is unable to delete the changed ref. When the manifest itself is wrong, regenerate it and use its new digest in the new command.

A malformed or unauthorized command fails before accepting a transfer ref and is not deleted; remove that unused branch manually. Automatic expiry for abandoned or never-authorized transfer branches is not part of this protocol.

## Reproducible local verification

```shell
python3 -B tools/local-agent/test-patch-publication.py
bash tools/local-agent/test-patch-publication-workflow.sh
```

The first suite covers the multipart format, compact deterministic byte-fallback and UTF-8 boundary regressions, token-bounded splitting through an injected deterministic counter, the exact PR #174 splitter regression with the optional local tokenizer, minimum-part preservation while preferring readable boundaries, multi-commit ranges, sequential one-file exposure, exact Git blob SHA recording, strict part paths, missing and extra files, per-part size and digest failures, UTF-8 validation, exact reconstruction, targeted one-part repair, patch and tree validation, forbidden paths, and bundle tampering. The second combines static workflow-contract checks with a real bare remote for transfer cleanup and executes the exact trusted repository request, preparation, cleanup, and summary scripts against mocked GitHub API responses. It covers retry preservation, target-race rejection, exact-base publication, changed-ref preservation, exact-SHA deletion, PR binding, separated permissions, successful HTTP-204 deletion, already-absent comments before either the read or delete call, changed or mismatched identities, visible deletion failures, the 12-KiB workflow upload budget, and immutable Action pins. Live GitHub event permissions, actual comment deletion, artifact transport, and exact `tiktoken` integration with the separately stored vocabulary remain environment-specific verification concerns.

## Current limits and follow-ups

A small patch uses a single format-version-2 part; larger patches use multiple parts. Token-aware preparation targets 3,000 `o200k_base` tokens per connector content string and caps every planned connector upload, including the manifest, at 12 KiB by default. Both values are configurable local preparation settings, not accepted connector guarantees. When the tokenizer is unavailable, the helper falls back explicitly to the byte ceiling.

The format does not accept Base64. The protocol limits it to 1,024 parts, 256 KiB per part, and a 64 MiB reconstructed patch as bounded publication-tooling guards rather than TeaseScript content limits. The local tokenizer vocabulary and `tiktoken` installation belong in the reusable offline agent-toolchain archive, not in Git or source artifacts.

The publish job currently uses the repository `GITHUB_TOKEN`. GitHub may require manual approval before a subsequent pull-request workflow runs after that token updates the PR branch. Replacing only the isolated publish credential with a repository-scoped GitHub App installation token is a separate operational follow-up; prepare and test jobs must remain read-only and must not receive the App private key.

All external Actions used by the write-capable workflow are pinned to reviewed immutable commit SHAs. Updating a pin requires a normal dependency review and CI run.
