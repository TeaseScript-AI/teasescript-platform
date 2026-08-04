# ChatGPT GitHub connector workflow

## Scope

This guide applies to ChatGPT agents working through the installed GitHub connector. It does not replace `AGENTS.md`, the normal Git workflow, or the repository's review and CI requirements.

The connector is the GitHub control plane: use it for exact repository metadata, short-lived artifact download, live pull-request state, and writes that must happen on GitHub. It is not the preferred environment for reading an entire repository or running a substantial review.

## Default: download once, work locally

For substantial implementation, review, debugging, or verification:

1. use `get_pr_info` for a pull request, or another narrow metadata/status action when an exact commit SHA is already known, to resolve the current head and base;
2. locate an unexpired source-bundle artifact bound to that exact head;
3. download the artifact once;
4. run `tools/local-agent/prepare-source-review.py` against the downloaded ZIP;
5. inspect and test the resulting checkout with local Git, shell, search, editor, and test tools;
6. return to the connector only for live GitHub state or GitHub writes.

Do not try `git clone`, `git fetch`, or another network Git workaround from a connector-based restricted agent environment. Network Git is not the supported repository acquisition route there. Use the verified source-bundle artifact and the preparation script.

The preparation helper must already be available from a trusted shared project folder or separately distributed local tool bundle, outside the downloaded artifact and `repository.bundle`. The repository copy is the canonical maintained source, but do not bootstrap trust by manually extracting and executing the candidate copy from the artifact under review.

After local preparation, code reading should normally use local commands such as:

```shell
git diff <base>...HEAD
git show --stat --oneline HEAD
git log --oneline --decorate <base>..HEAD
git grep '<pattern>'
find . -type f
```

This is both simpler and more context-efficient than requesting complete files or patches one by one through the connector.

## Obtain the exact source artifact

### Current pull-request head

1. Call `get_pr_info` and record the exact head SHA and exact current base-tip SHA.
2. Call `compare_commits` with those two exact SHAs and record `merge_base_commit.sha`. This merge base is stable in the head history even when the base branch later advances.
3. Call `fetch_commit_workflow_runs` for the exact head.
4. Select a successful `Source bundle` run for that head.
5. Call `fetch_workflow_run_artifacts` and require an unexpired artifact named `teasescript-source-<head-sha>` whose workflow metadata has the same head SHA.
6. Call `download_workflow_artifact` once.
7. Pass the returned local ZIP path, GitHub artifact digest, and expected merge base to the trusted preparation helper.

### Implementation from `main`, older source, or missing/expired artifact

For new implementation work, obtain an exact artifact for the selected `main` commit rather than trying to network-clone the repository. The current connector may not expose push-triggered source-bundle runs through commit-run discovery, so use the connector-native request branch when the automatic artifact cannot be located. The same route regenerates older or expired source. It is defined in `DEVELOPMENT-WORKFLOW.md`:

1. resolve the exact requested source SHA and exact current `main` SHA;
2. create `source-bundle-request/<source-sha>/<nonce>` at current `main`;
3. wait 90 seconds before the first status lookup;
4. if absent, wait 30 seconds before each later lookup;
5. read status `source-bundle/request/<nonce>` from the requested source commit;
6. download the reported artifact ID and verify its digest;
7. confirm the temporary request branch was removed.

The connector cannot start `workflow_dispatch`; do not spend calls looking for a dispatch route that is not exposed.

## Prepare the local checkout

Example:

```shell
python3 tools/local-agent/prepare-source-review.py \
  --artifact /mnt/data/pr-144-source-bundle.zip \
  --artifact-sha256 6ad5e5af7fd2f9858dd10473fc8ce092a7dc4723e428daba2f2d302b2e1a1bf0 \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --expected-head 1eef336ff0acdfae9913295890ef92828b9ba95b \
  --expected-merge-base 371bbaaba6d4773c292b69598c521591afcf4330 \
  --output /mnt/data/review-pr-144
```

The script verifies the outer digest, ZIP safety and exact payload, internal checksums, manifest identities, complete Git bundle, expected head and merge-base ancestry, checked-out tree, `git fsck`, and clean worktree. It exposes the requested output path only after every check succeeds.

The resulting checkout deliberately has no `origin` remote. It is a verified local review snapshot, not a network Git clone.

## Connector use after local preparation

Use the connector for information that can change independently of the downloaded source:

- current PR head, base, draft/merge state, and description;
- submitted reviews and unresolved inline threads;
- current workflow run, job, and step conclusions;
- issue or PR comments when the conversation itself is relevant;
- posting a review, comment, label, branch, commit, or other requested GitHub write.

Before publishing a review or commit derived from a local checkout, call `get_pr_info` again and stop if the head moved.

For implementation, make and test changes locally. Publish only the final reviewed result through the repository's supported GitHub write route. Use the patch-publication bridge for workflow-file changes or coherent multi-file patches that cannot be safely written through ordinary connector file actions.

## Context-efficient connector fallback

Use this fallback only when no usable exact-head artifact can be obtained, the preparation script rejects the artifact, or the requested task is specifically about GitHub conversation/state rather than repository contents. Never continue from a rejected or partially prepared checkout.

Prefer the smallest operation that answers the question:

1. `get_pr_info` for known PR metadata;
2. `compare_commits` and `list_pr_changed_filenames` to bound a change;
3. `fetch_pr_file_patch` for one known changed file;
4. bounded `fetch_file(start_line, end_line)` for necessary surrounding context;
5. `fetch_pr_patch` or `get_pr_diff` only when the complete patch is genuinely required.

For review and CI state:

1. `list_pull_request_review_threads` for inline threads;
2. `list_pull_request_reviews` for submitted review state;
3. `fetch_commit_workflow_runs` for exact-head runs;
4. `fetch_workflow_run_jobs` for job and step conclusions;
5. `fetch_workflow_job_logs` only for a concrete failed or ambiguous job.

## High-context operations

These operations are valid, but can return large amounts of text and should not be discovery defaults:

- `fetch_commit`: commit metadata together with the complete commit diff; do not use it merely to confirm a known SHA or read a commit message;
- `fetch_pr`: pull-request data together with its diff; prefer `get_pr_info` when metadata is sufficient;
- `fetch_pr_patch` and `get_pr_diff`: complete patch;
- `fetch_pr_comments`: combined issue comments, reviews, and inline comments;
- `fetch_workflow_job_logs`: complete decoded job log;
- broad recent-issue or recent-PR listings: many full bodies and optionally diffs/comments;
- repeated `fetch_file` calls across most of a repository.

Do not prohibit these operations. Use them when their complete result is required, and otherwise use exact metadata plus the local artifact route.

## Output discipline while working locally

Successful tests and shell integrations should emit only their concise result. Capture routine Git/helper output and reveal it only on failure. Preserve the failing command, exit status, test identity, traceback or assertion, and useful diagnostic output. For very large shell failures, print a bounded excerpt and retain the complete short-lived CI log artifact.

Do not hide failures merely to save context. The objective is to remove successful and irrelevant output while retaining actionable evidence.

## Distributed local bootstrap

For substantial connector-local work, use the trusted shared
`teasescript-agent-bootstrap-linux-x64.tar.zst` only through
`bin/prepare-agent-workspace.sh`. It is the sole normal bootstrap entry point:
do not require a separate self-test, execute the candidate helper from the
downloaded artifact, or revive the removed work-package route. Stable names,
options, and shared-project staging are defined in
`docs/LOCAL-AGENT-BOOTSTRAP.md`.
