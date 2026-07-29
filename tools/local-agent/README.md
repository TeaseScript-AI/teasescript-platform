# Local Agent Exact-Editing Helper

Requires Python 3.10 or newer. Uses only the Python standard library.

## Rule

For a localized change, do not rewrite a complete existing file merely for
convenience. A complete rewrite is appropriate when replacing all contents is
the intended change, or when a small file genuinely changes almost entirely.

Preferred order:

1. `replace-exact.py` for one exact replacement;
2. `replace-exact-batch.py` for several exact known replacements;
3. a targeted patch for a small structural change;
4. a bounded codemod for repeated mechanical changes;
5. a complete rewrite when it is genuinely intended.

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

## Apply several exact replacements

Use one JSON plan instead of starting Python once per edit:

```json
{
  "formatVersion": 1,
  "operations": [
    {
      "file": "src/config.ts",
      "oldText": "const limit = 10;",
      "newText": "const limit = 20;",
      "expectedCount": 1
    },
    {
      "file": "docs/example.md",
      "oldFile": "/tmp/old.txt",
      "newFile": "/tmp/new.txt"
    }
  ]
}
```

```bash
python3 tools/local-agent/replace-exact-batch.py \
  --plan /tmp/replacements.json \
  --dry-run
```

Remove `--dry-run` to apply it. Relative paths use the current working
directory. Operations run in listed order. The batch validates every operation
before writing and writes each changed file once. Multi-file writes are not one
filesystem transaction; exit code `2` means earlier files may have changed and
must be inspected.

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
- exit code `1`: validation or a pre-write operation failed.
- exit code `2`: one or more writes may have been applied; inspect the reported
  targets before retrying.

The helper preserves untouched bytes and Unix permission bits. It refuses the
replacement if the target changes after validation. It does not preserve every
filesystem metadata type or hard-link identity.

The helper is not streaming and may need roughly two to three times the target
file size in available memory.

## Tests

```bash
python3 tools/local-agent/test-replace-exact.py
python3 tools/local-agent/test-replace-exact-batch.py
```
