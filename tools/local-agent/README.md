# Local Agent Tools

Requires Python 3.10 or newer. The source-review, exact-editing, and compact-test helpers use only the Python standard library and ordinary shell/Git tools. Token-aware patch preparation optionally uses a local `tiktoken` Python installation and a separately stored `o200k_base.tiktoken` vocabulary; neither is a project runtime dependency.

## Rule

Never regenerate or replace an entire existing file for a localized change.
Use a targeted unified diff or an exact replacement. Replace a complete file
only when a complete rewrite is intentional and the entire result will be
reviewed.

Preferred order:

1. checked unified diff;
2. `replace-exact.py` for one exact replacement;
3. bounded codemod for repeated mechanical edits;
4. complete rewrite only when intentional.

## Replace an exact block

For a short, simple UTF-8 edit, pass text directly:

```bash
python3 tools/local-agent/replace-exact.py \
  --file src/config.ts \
  --old-text 'const limit = 10;' \
  --new-text 'const limit = 20;' \
  --expected-count 1 \
  --dry-run
```

Remove `--dry-run` to apply the edit.

For multiline content, exact final newlines, complex shell characters, CRLF,
or arbitrary bytes, use snippet files:

```bash
python3 tools/local-agent/replace-exact.py \
  --file src/large-file.ts \
  --old /tmp/old-snippet.txt \
  --new /tmp/new-snippet.txt \
  --expected-count 1
```

Provide exactly one of `--old` or `--old-text`, and exactly one of `--new` or
`--new-text`.

Direct text is encoded as UTF-8. File inputs remain byte-exact. A here-document
includes its final newline; use `printf '%s'` when a snippet file must not end
with a newline.

When direct text begins with `-`, use the equals form, for example
`--old-text=--example` or `--new-text=-value`. Direct text is intended for
small snippets and is subject to the operating system's command-line size
limit; use snippet files for larger content.

`--dry-run` validates the target, snippets, and match count without writing.
It does not prove that the later atomic write will succeed.

## Delete an exact block

For a short UTF-8 deletion, provide an explicitly empty `--new-text` value:

```bash
python3 tools/local-agent/replace-exact.py \
  --file src/config.ts \
  --old-text 'obsolete text' \
  --new-text '' \
  --expected-count 1
```

For multiline or byte-level deletion, use `--old` with the exact block and
`--new tools/local-agent/empty-replacement.txt`. The new input is always
required, so omission cannot silently become deletion.

## Output and failures

- `validated`: dry-run succeeded.
- `replaced`: the target was changed.
- `unchanged`: old and new content were identical.
- exit code `1`: nothing was intentionally replaced.
- exit code `2`: replacement was applied, but parent-directory synchronization
  failed. Inspect the file before retrying.

The helper preserves untouched bytes and Unix permission bits. It refuses the
replacement if the target changes after validation. It does not preserve every
filesystem metadata type or hard-link identity.

The helper is not streaming and may need roughly two to three times the target
file size in available memory.

## Tests

```bash
python3 tools/local-agent/test-replace-exact.py
```

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
