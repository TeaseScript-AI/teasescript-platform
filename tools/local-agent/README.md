# Local Agent Exact-Editing Helper

Requires Python 3.10 or newer. Uses only the Python standard library.

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
