# ADR 0011 — `say` and string literals

**Status:** Accepted

Double-quoted strings are ordinary text. Backtick template strings support `${expression}` interpolation. `say` uses the current default speaker; `say as <speakerIdentifier>` overrides the speaker for one message.
