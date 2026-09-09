# ADR 0011 — `say` and string literals

**Status:** Accepted

## Decision

TeaseScript has one quote-based string family. `"..."` is single-line and `"""..."""` is a multiline block string.
Both forms support `${expression}` interpolation and the shared escapes `\\`, `\"`, `\n`, `\r`, `\t`, and `\${`.
Backticks are ordinary string content and do not delimit strings.

A physical LF or CRLF anywhere inside a single-line string's source extent is invalid. Block-string physical LF and
CRLF endings normalize to `\n`. The accepted syntax specification defines the complete dedent rule and edge cases.

`say` accepts strings through the general expression model. It uses the current default speaker;
`say as <speakerIdentifier>` overrides the speaker for one message.

## Rationale and consequences

One delimiter family removes the plain-string/template distinction while keeping interpolation available in ordinary
text. The explicit block form makes source newlines visible and predictable, and deterministic dedent lets blocks
follow surrounding TeaseScript indentation. The change intentionally removes backtick templates and implicit
physical-newline-to-space folding during the language/runtime POC.

Strings without interpolation still lower to the existing literal plan expression. Interpolated strings still lower
to the existing `template` plan expression, so this source and AST change does not alter the versioned instruction-plan,
snapshot, or checkpoint formats. Player message text preserves resulting newlines when rendered.

This decision replaces ADR 0011's 2026-07-21 selection of double-quoted plain strings and backtick interpolation
templates. Existing source must migrate to the quote-based forms; no compatibility alias is retained.
