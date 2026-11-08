# Repository checks

Checks over the repository's own files that are not lint rules (oxlint's are in `tools/oxlint/`). Each is one module
here, with its test beside it in `test:verification`; it runs as an `npm run check:…` script in `check:pretest`, and in
`tools/check-changed.mjs`. Its header says what it checks and what it does not.
