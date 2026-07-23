# ADR 0004 — TeaseScript owns expression syntax

**Status:** Proposed

The TeaseScript parser should parse the complete accepted V30 expression grammar. A mathematics library may be used internally for units, conversions, and selected pure functions, but must not define accepted TeaseScript syntax.

Do not use JavaScript `eval` or `new Function`.
