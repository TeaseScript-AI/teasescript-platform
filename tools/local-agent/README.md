# Local Agent Tools

The source-review and compact-test helpers use the Python standard library and
ordinary shell/Git tools. Token-aware patch preparation optionally uses a local
`tiktoken` Python installation and a separately stored `o200k_base.tiktoken`
vocabulary; neither is a project runtime dependency.

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

```bash
python3 -B tools/local-agent/test-compact-unittest.py
bash tools/local-agent/test-run-compact.sh

bash tools/local-agent/run-compact.sh \
  --label source-bundle-workflow \
  --log /tmp/source-bundle-workflow.log \
  -- bash tools/local-agent/test-create-source-bundle.sh
```

Do not redirect failures to `/dev/null` merely to reduce output. Compact successful output and retain actionable failures.

## Prepare a verified source review checkout

`prepare-source-review.py` converts one already downloaded source-bundle ZIP into an exact clean local checkout. It verifies the GitHub artifact digest, ZIP safety and payload shape, internal checksums, manifest repository/head/tree identities, complete bundle history, optional expected merge-base ancestry, `git fsck`, and clean worktree. The requested output is exposed atomically only after every check succeeds.

```bash
python3 tools/local-agent/prepare-source-review.py \
  --artifact /mnt/data/pr-144-source-bundle.zip \
  --artifact-sha256 6ad5e5af7fd2f9858dd10473fc8ce092a7dc4723e428daba2f2d302b2e1a1bf0 \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --expected-head 1eef336ff0acdfae9913295890ef92828b9ba95b \
  --expected-merge-base 371bbaaba6d4773c292b69598c521591afcf4330 \
  --output /mnt/data/review-pr-144
```

For pull-request review, pass the merge base reported by `compare_commits`, not the current base-branch tip. The helper requires that commit to exist in the bundle and be an ancestor of the exact head.

The resulting checkout has no `origin` remote. Connector-based agents should use this artifact route instead of trying network `git clone` or reading the repository file by file through the connector. The extractor rejects artifacts above 128 MiB uncompressed and metadata files above 1 MiB. See `docs/CHATGPT-GITHUB-WORKFLOW.md`.

Tests:

```bash
python3 -B tools/local-agent/test-prepare-source-review.py
```

## Prepare multipart patch publication

`prepare-patch-publication.py` creates a verified raw Git patch between an exact base commit and the tested current `HEAD`, splits it into UTF-8 parts, writes the V2 manifest, proves reconstruction, and creates a local sequential upload plan. It never merges, rebases, squashes, commits, or pushes.

For the token-efficient route, keep `tiktoken` and `o200k_base.tiktoken` in the reusable offline toolchain and pass the vocabulary with `--tokenizer` or `TEASESCRIPT_O200K_TOKENIZER`. The conservative default target is 3,000 estimated `o200k_base` tokens per JSON-serialized connector content string, with an independent 12 KiB byte ceiling and fallback.

After preparation, use `--show-next-upload` and `--record-upload-sha` alternately. The first command exposes only one pending file and ready arguments for the GitHub UTF-8 blob action; the second verifies the returned Git blob SHA before allowing the next file. Use `--reset-upload-index` only when a later connector step proves that one recorded blob must be resent. Never print all parts in advance. See `docs/PATCH-PUBLICATION.md` for the complete protocol and examples.
