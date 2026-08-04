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

### Fixed-index lookup first

1. Resolve one identity: `main` to the current tip; `sha:<full-sha>` to that
   commit; or `pr:<number>` to its head SHA, head repository/ref, current base
   SHA, and `compare_commits.merge_base_commit.sha`.
2. Call `get_commit_combined_status` for the source SHA and select a successful
   `source-bundle/artifact-v1` status whose `target_url` is this repository's
   exact artifact URL.
3. Parse its run and artifact IDs, call `fetch_workflow_run_artifacts`, and
   require the exact ID, name `teasescript-source-<source-sha>`, digest,
   producer run/repository identity, and an unexpired artifact.
4. Download that numeric ID and run the trusted preparation helper with the
   exact source SHA and optional PR merge base.

A valid hit starts no workflow, posts no comment, and requires no wait. Missing
status, failed download, expiry, malformed URL, or any ID, name, digest, or
producer mismatch is a confirmed cache miss; never substitute another SHA's
artifact.

### Phase 1 mailbox route on a confirmed miss

Issue [#235](https://github.com/TeaseScript-AI/teasescript-platform/issues/235)
is the only Artifact mailbox. Post exactly one supported command there:

```text
/artifact source main
/artifact source pr:225
/artifact source sha:<full-lowercase-40-character-sha>
```

Record the created command-comment ID. Commands elsewhere are ignored. The
serialized default-branch workflow revalidates the exact comment, collaborator
permission, selector identity, and fixed index. It either reuses a valid artifact
or creates one without executing selected source.

The mailbox keeps one authoritative `github-actions[bot]` registry comment,
user ID `41898282`. Locate the compact entry containing the exact request ID,
then use its connector JSON and preparation command. Equivalent requests can
share one artifact entry while retaining every correlated request ID. A request
comment is deleted only after its ready or failed registry entry is safely
written; a cleanup failure does not invalidate a ready entry.

Phase 1 is additive while issue #234 gathers default-branch timing and
concurrency evidence. Do not copy the compatibility route's 90-second wait or
invent a replacement. The measured initial wait, 10-second request-ID polling,
and overall timeout become mandatory only in Phase 2 after the evidence is
recorded. Until then, the request-branch route in `DEVELOPMENT-WORKFLOW.md`
remains a supported fallback when the mailbox route itself is unavailable.

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
