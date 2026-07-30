# Local Agent Exact-Editing Helper

Requires Python 3.10 or newer. The exact-editing helpers use only the Python standard library. Token-aware patch preparation optionally uses a local `tiktoken` Python installation and a separately stored `o200k_base.tiktoken` vocabulary; neither is a project runtime dependency.

## Choose an edit method

- Localized text change: checked unified diff.
- One exact or byte-sensitive replacement: `replace-exact.py`.
- Symbol-aware TypeScript rename across declarations, imports, re-exports, or references: the repository ts-morph codemod.
- Other repeated mechanical changes: a bounded purpose-built codemod.
- Whole-file rewrite: only when intentional and fully reviewed.

Never regenerate an entire existing file for a localized change. Review the resulting diff and run the relevant checks after every write. For the TypeScript codemod, see [`../ts-morph/README.md`](../ts-morph/README.md).

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

## Prepare multipart patch publication

`prepare-patch-publication.py` creates a verified raw Git patch between an exact base commit and the tested current `HEAD`, splits it into UTF-8 parts, writes the V2 manifest, proves reconstruction, and creates a local sequential upload plan. It never merges, rebases, squashes, commits, or pushes.

For the token-efficient route, keep `tiktoken` and `o200k_base.tiktoken` in the reusable offline toolchain and pass the vocabulary with `--tokenizer` or `TEASESCRIPT_O200K_TOKENIZER`. The conservative default target is 3,000 estimated `o200k_base` tokens per JSON-serialized connector content string, with an independent 12 KiB byte ceiling and fallback.

After preparation, use `--show-next-upload` and `--record-upload-sha` alternately. The first command exposes only one pending file and ready arguments for the GitHub UTF-8 blob action; the second verifies the returned Git blob SHA before allowing the next file. Use `--reset-upload-index` only when a later connector step proves that one recorded blob must be resent. Never print all parts in advance. See `docs/PATCH-PUBLICATION.md` for the complete protocol and examples.
