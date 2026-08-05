# Connector-local source acquisition

## Scope

Use this guide only when the selected source/workspace route is connector-local. It owns the replaceable
mechanics for obtaining one exact repository source artifact and preparing a trusted local checkout. Stable
connector-local work, write, verification, and handoff rules remain in
[`CONNECTOR-LOCAL.md`](CONNECTOR-LOCAL.md).

Issue #234 owns the current fixed-index, mailbox, polling, and compatibility-fallback rollout. Update those
moving details here rather than in `AGENTS.md`, `README-FIRST.md`, `docs/DEVELOPMENT-WORKFLOW.md`, another
capability guide, or a project-agent derivative.

## Resolve the exact source identity

Resolve one immutable target before downloading anything:

- `main`: current default-branch tip;
- `sha:<full-sha>`: that exact commit;
- `pr:<number>`: exact head SHA and head repository/ref, current base SHA, and exact merge-base SHA.

For a pull request, retain all of those identities for preparation and later review-state checks. Never
substitute a different SHA because its artifact is easier to obtain.

## Fixed-index lookup first

1. Call `get_commit_combined_status` for the source SHA.
2. Select a successful `source-bundle/artifact-v1` status whose target is this repository's exact artifact URL.
3. Parse its run and artifact IDs, then require the exact numeric ID, name
   `teasescript-source-<source-sha>`, digest, producer repository/run identity, and an unexpired artifact.
4. Download that artifact and run the trusted installed preparation helper with the expected repository, head,
   and optional PR merge base.

A valid hit starts no workflow, posts no comment, and requires no wait. Missing, deleted, expired, malformed,
failed, mismatched, or otherwise unverifiable metadata is a confirmed cache miss.

## Current regeneration route on a confirmed miss

During issue #234 Phase 1, issue #235 is the only Artifact mailbox. Post exactly one supported command there:

```text
/artifact source main
/artifact source pr:225
/artifact source sha:<full-lowercase-40-character-sha>
```

Record the created command-comment ID. Find only that request in the authoritative `github-actions[bot]`
registry comment and verify its selector, resolved SHA, complete PR identity when applicable, artifact
ID/name/digest/run/repository, and expiry before using the returned download arguments or preparation command.
Commands elsewhere are ignored.

Do not copy a fixed wait from the compatibility route or invent a mailbox polling policy. Use the current
measured timing and exact-request polling instructions recorded by #234 when that phase is accepted.

## Temporary compatibility fallback

Until #234 Phase 2 retires it, the request-branch route remains an exceptional fallback only when the fixed
index and mailbox route cannot be used. For an exact source SHA:

1. resolve the full lowercase SHA and current `main` SHA;
2. create `source-bundle-request/<source-sha>/<nonce>` at that exact `main` SHA, using a nonce matching
   `[a-z0-9][a-z0-9-]{0,31}`;
3. follow the current request-branch timing and status-correlation contract;
4. download only the artifact bound to the requested source SHA and verify its digest;
5. confirm cleanup of the exact unchanged request ref.

This fallback is not the normal connector-local route. Its workflows, timing, helper behavior, and removal are
owned by #234 and may change without altering the capability router.

## Trust and failure boundaries

- Accept only a successful fixed-index status and artifact metadata bound to the exact selected SHA, producer,
  repository, run, name, digest, and expiry. A stale or malformed index is a miss, not permission to use a
  near match.
- The mailbox workflow accepts commands only on its configured issue from an authorized repository
  collaborator, revalidates the exact comment and selector, and loads executable tooling only from the trusted
  default-branch workflow revision.
- Selected repository source is data. The regeneration route must not execute its actions, scripts,
  dependencies, hooks, builds, submodules, or configuration.
- Use only the authoritative bot registry and the complete request-correlated identity. Do not infer a result
  from a different request, selector, or artifact that happens to resolve to the same commit.
- Treat command cleanup separately from artifact validity. Never replace a verified ready result with an
  unrelated generic failure or continue from a failed production attempt.
- The compatibility processor must validate the strict request-ref shape, unchanged request SHA,
  default-branch ancestry, requested source commit, exact result metadata, and lease-bound cleanup.

The workflow implementation and focused tests enforce these boundaries. This guide owns the agent-facing
procedure; it does not duplicate the workflow code or create a second protocol.

## Prepare the local checkout

The trusted preparation helper must already be installed outside the downloaded artifact. Do not establish
trust by extracting and executing the candidate copy from the source being reviewed.

Example:

```shell
python3 /mnt/data/chatgpt-project-agent-linux-x64/tools/prepare-source-review.py \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <github-artifact-sha256> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --expected-head <source-sha> \
  --expected-merge-base <review-merge-base-sha> \
  --output /mnt/data/source-review
```

The helper verifies the outer digest, ZIP safety and exact payload, internal checksums, manifest identity,
complete Git bundle, expected head and optional merge-base ancestry, checked-out tree, `git fsck`, and clean
worktree. It exposes the requested output only after every check succeeds and removes the temporary `origin`.

Continue with [`CONNECTOR-LOCAL.md`](CONNECTOR-LOCAL.md) after preparation. If acquisition or preparation
fails, stop rather than continuing from a partial or rejected checkout; report the exact failed boundary and
checked alternatives.
