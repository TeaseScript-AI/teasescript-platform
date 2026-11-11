# Repository checks

Checks over the repository's own files that are not lint rules (oxlint's are in `tools/oxlint/`). Each is one module
here, with its test beside it in `test:verification`. Its header says what it checks, what it does not, and where it
runs.
`markdown.mjs` is no check: it holds the Markdown configuration the doc-links check and the citation lint
(`tools/oxlint/check-comment-forecasts.mjs`) both read with.
