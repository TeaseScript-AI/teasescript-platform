# Local Agent Tools

Requires Python 3.10 or newer.

The compact-test and patch-publication helpers use the Python standard library
and ordinary shell/Git tools. The installed ChatGPT project-agent environment
owns the source-review helper and mandatory TikToken dependency payload.

## Rule

For ordinary localized edits, use the environment-provided `apply_patch`
command, including coherent changes across multiple hunks or files in one
invocation. It is the default for small and medium source and documentation
edits.

A failed patch should normally be corrected with a smaller reread and better
context, not by rewriting the entire file. Use a bounded temporary task-specific
codemod, such as `ts-morph`, only when repeated structural or symbol-aware
TypeScript edits would make an ordinary patch unclear or error-prone. Such
scripts should normally remain uncommitted and be discarded after their
verified use. Rewrite a complete existing file only when complete replacement
is intentional or most of the file genuinely changes.

Do not add a repository-wide fallback for environments that lack `apply_patch`;
that requires separate concrete evidence and review. Rare binary or
byte-sensitive work should use a task-specific method appropriate to that
concrete file, not justify a permanent general helper.

## Task-specific TypeScript codemods

The repository includes `ts-morph` as development-only agent tooling. Use it
when one concrete change requires repeated AST- or symbol-aware edits across
enough TypeScript locations that ordinary checked patches become less clear or
more error-prone.

Do not create a permanent generic runner, rename command, transaction layer,
or codemod framework by default. Write the smallest task-specific script,
normally keep it uncommitted, and run it only from a clean Git checkout with an
explicit expected scope. Then inspect the complete diff and run the normal
build, typecheck, and relevant tests. If the result is wrong, discard or reset
the checkout and correct the task script.

Use ordinary patches for small edits. Commit a codemod only when demonstrated
future reuse justifies its own maintenance, tests, and documentation.

## Compact test and shell output

`compact_unittest.py` suppresses per-test success chatter and prints one suite result. On failure it emits the normal verbose unittest identity, traceback, assertion details, and nonzero exit status.

`run-compact.sh` captures routine shell command output. On success it deletes the temporary log and prints one PASS line. On failure it prints the command and exit status, emits the complete diagnostic when it is small, or prints a bounded first/last excerpt while retaining the complete log for CI artifact upload.

The canonical complete local-agent validation entry point is:

```bash
bash tools/local-agent/check-local-agent.sh
```

It runs every repository-owned Python and shell suite exactly once, keeps routine
success output compact, and preserves complete failure logs for CI artifact
upload. Run an individual test file only while developing or diagnosing that
specific boundary.

Do not redirect failures to `/dev/null` merely to reduce output. Compact successful output and retain actionable failures.

## Prepare a verified source review checkout

The canonical helper source now lives at
`tools/chatgpt-project-agent/tools/prepare-source-review.py` so its relative path
can match the future installed project-agent layout. Its fail-closed tests remain
in `tools/local-agent/` because they validate repository tooling rather than
distributed bundle content.

The helper converts one downloaded source-bundle ZIP into an exact clean local
checkout. It verifies the external digest, ZIP safety and payload shape, internal
checksums, manifest identities, complete Git history, optional merge-base
ancestry, `git fsck`, and a clean worktree.

Until issue #210 supplies and synchronizes the new setup distribution, use the
currently trusted preinstalled copy for real connector-local review; do not run
the candidate helper from the artifact under review. The repository source path
is used for maintenance and focused tests:

```bash
python3 -B tools/local-agent/test-prepare-source-review.py
```

## Prepare multipart patch publication

`prepare-patch-publication.py` creates a verified raw Git patch between an exact base commit and the tested current `HEAD`, splits it into UTF-8 parts, writes the V2 manifest, proves reconstruction, and creates a local sequential upload plan. It never merges, rebases, squashes, commits, or pushes.

The two Python tools deliberately live on opposite sides of the publication
boundary:

- `prepare-patch-publication.py` is the agent-side producer. It reads the tested
  local Git history, prepares the patch and manifest, and guides exact connector
  uploads. It never receives repository write credentials.
- `patch-publication.py` is the trusted runner-side consumer. The workflow uses
  it to materialize the authorized payload, create the deterministic candidate
  bundle, and later verify that tested bundle without executing candidate code
  before the write token is created.

Their tests cover different contracts:

- `test-prepare-source-review.py` prevents unsafe or identity-mismatched source
  artifact extraction, including path traversal, checksum, tree, and ancestry
  failures;
- `test-prepare-patch-publication.py` prevents malformed patch splitting,
  manifests, connector upload plans, and broken resumable handoff state;
- `test-patch-publication.py` prevents transfer reconstruction, candidate commit,
  result-tree, metadata, and bundle identity mismatches;
- `test-patch-publication-validate-candidate.sh` proves documentation, source,
  and full profiles select the intended commands, preserve fail-fast ordering,
  and treat every required suite failure as fatal;
- `test-patch-publication-workflow.sh` prevents weakened workflow permissions,
  mutable action pins, unsafe job ordering, cleanup regressions, and broken local
  Git integration.

These are complementary tests, not alternative implementations. The canonical
`check-local-agent.sh` entry point runs each one once.

Patch publication requires the installed TikToken environment and verified `o200k_base.tiktoken` vocabulary. Run the preparation command through `.git/teasescript-agent/run-python313`; pass the vocabulary with `--tokenizer` or `TEASESCRIPT_O200K_TOKENIZER`. The conservative default target is 3,000 estimated `o200k_base` tokens per JSON-serialized connector content string, with an independent 12 KiB byte ceiling. Byte-only splitting is available only through an explicit hidden test option.

After preparation, use the canonical `--show-next-action` to expose exactly one connector action at a time; `--show-next-upload` remains an exact compatibility alias. Record blob, tree, and commit SHAs, then record the returned transfer-branch name before the helper exposes one read-only exact branch comparison. Record its `identical` status before publishing. The helper verifies every blob, the payload-only transfer tree, and the final branch target; an interruption after branch creation resumes at the comparison read rather than repeating the write. Use `--reset-upload-index` when a blob must be resent, or `--reset-publication-stage tree|commit|branch` to correct only a post-upload stage while preserving verified blobs. Never print all parts in advance. See `docs/PATCH-PUBLICATION.md` for the complete protocol and examples.
