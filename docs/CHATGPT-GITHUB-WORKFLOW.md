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

Issue #228 adds a fixed exact-SHA artifact index and a collaborator-gated
regeneration command. The rollout is additive until its default-branch live
proof is complete; the request-branch procedure remains a compatibility path in
`DEVELOPMENT-WORKFLOW.md` during that period.

### Preferred fixed-index lookup

Resolve one immutable identity first:

- `main`: the current default-branch tip;
- `pr:<number>`: the current PR head SHA plus head repository/ref, current base
  SHA, and `compare_commits.merge_base_commit.sha`;
- `sha:<full-sha>`: that exact existing commit.

Then call `get_commit_combined_status` for the exact source SHA and inspect only
a successful status with context `source-bundle/artifact-v1`. Its `target_url`
must be the exact artifact URL for this repository. Use the run and artifact IDs
from that URL to call `fetch_workflow_run_artifacts`; require one unexpired
artifact whose ID and name `teasescript-source-<source-sha>` match, whose digest
is present, and whose workflow-run repository and run identity match. Download
that numeric artifact ID once, verify the reported digest locally, and run the
trusted preparation helper with the exact head and optional PR merge base.

A valid lookup starts no workflow and posts no comment. Treat a missing fixed
status, failed download, expired artifact, malformed URL, wrong ID/name/digest,
wrong producer identity, or other metadata mismatch as a cache miss. Never use
an artifact from another pull request or another SHA merely because it contains
similar files.

### Regenerate only after a confirmed miss

Post exactly one of these commands on an issue or pull request:

```text
/artifact source main
/artifact source pr:225
/artifact source sha:<full-lowercase-40-character-sha>
```

Only Write, Maintain, or Admin collaborators may allocate regeneration compute.
The workflow serializes requests, resolves and pins the selected identity,
rechecks the index after entering the queue, and either returns the now-existing
artifact or creates one seven-day Source bundle. Consume only the bot-authored
result bound to the exact request-comment ID. The result contains the complete
resolved identity, artifact metadata, exact `download_workflow_artifact`
arguments, and local preparation command.

The returned identity is authoritative for that request. When `main` or a PR
moves while the request waits, do not combine the result with a head, base, or
merge base resolved earlier; either use the complete returned identity or
request the already-resolved exact SHA.

Normal agent guidance after live rollout is:

> Acquire exact repository source through the fixed
> `source-bundle/artifact-v1` index, and use `/artifact source <selector>` only
> on a confirmed miss. Do not use network Git, workflow run numbers, manually
> constructed request branches, or artifacts from unrelated pull requests.

Until the issue #228 live-proof gate is complete and `AGENTS.md` is switched,
the documented request-branch fallback remains supported. Do not search for a
`workflow_dispatch` route; the connector does not expose one.

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
