# Expression evaluation and math.js

**Status:** Proposed; not an accepted dependency or runtime decision.

TeaseScript already has an accepted expression grammar in V30 and its own lexer/parser. Math.js must not replace or define TeaseScript syntax.

A future restricted math.js integration may be considered for compatible numeric/unit evaluation behind a strict adapter and allowlist. Before adoption, an ADR must define the exact responsibility, supported operations, serialization behavior, maintenance impact, security restrictions, and alternatives. Until then, implement the accepted TeaseScript expression grammar directly and do not add math.js.
