# Connector-local source acquisition

## Scope

Use this guide only when the selected source/workspace route is connector-local. It is the canonical source for the
replaceable mechanics for obtaining one exact repository source artifact and preparing a trusted local checkout. Stable
connector-local work, write, verification, and handoff rules remain in
[`CONNECTOR-LOCAL.md`](CONNECTOR-LOCAL.md).

This guide is canonical for the current fixed-index, Artifact mailbox, and polling mechanics. The compact project-folder
`README-FIRST.md` intentionally carries the concrete pre-checkout copy needed to obtain the first exact source before
this guide is locally available. After checkout, update and use the moving acquisition details here for later source
refreshes rather than copying them into universal documents, another capability guide, or other project-agent
derivatives.

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

## Regeneration on a confirmed miss

Issue #235 is the only Artifact mailbox. Post exactly one supported command there:

```text
/artifact source main
/artifact source pr:225
/artifact source sha:<full-lowercase-40-character-sha>
```

Record the created command-comment ID. Wait 10 seconds, then inspect only that request in the single
authoritative `github-actions[bot]` registry comment from bot user ID `41898282`. Poll only that exact request ID
every 10 seconds and stop when it is ready or failed, or when 2 minutes have elapsed since command creation.
Before using the returned download arguments or preparation command, verify the selector, resolved SHA,
complete PR identity when applicable, artifact ID/name/digest/run/repository, and expiry. Commands elsewhere
are ignored.

The registry keeps newest entries first, retains at most ten request correlations, removes expired entries, and
merges entries only for the same complete resolved identity and artifact. The workflow must persist the terminal
registry entry before it deletes the exact command comment. Cleanup failure remains a warning and must not
invalidate a ready result; for a newly produced artifact, fixed-index publication occurs last.

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

The workflow implementation and focused tests enforce these boundaries. This guide is canonical for the agent-facing
procedure; it does not duplicate the workflow code or create a second protocol.

## Prepare the local checkout

The trusted preparation helper must already be installed outside the downloaded artifact. Do not establish
trust by extracting and executing the candidate copy from the source being reviewed.

Example:

```shell
python3 /mnt/data/chatgpt-project-agent/tools/prepare-source-review.py \
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
