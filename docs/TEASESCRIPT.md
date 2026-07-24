# TeaseScript

## Syntax authority

The complete accepted syntax baseline is `specifications/accepted-syntaxes-v30.md`. Do not duplicate or reinterpret it here.

Accepted post-V30 additions:

- ADR 0013 defines `set[...]`, `type set`, insertion order, uniqueness, methods/properties, and non-indexability.
- ADR 0014 defines recursive value-copy behavior, scalar-only sets, empty collection errors, and speaker display-name fallback.
- ADR 0015 defines the serializable instruction-plan/runtime/checkpoint architecture used to execute the implemented syntax.

Rejected forms remain rejected, including `set score = 20`, `procedure`, and `call` for ordinary function calls. Historical research may still contain those forms and is non-authoritative.

## Currently implemented language subset

The repository includes core values, variables, assignments, speakers, output, collections, expressions, comments, ranges, deterministic random built-ins, conditionals, loops, and loop control.

The current function subset includes:

- top-level function declarations;
- required and trailing-default parameters;
- positional or named calls;
- earlier-parameter references in defaults, while later-parameter references are rejected;
- value, bare, and implicit `return`;
- forward calls, nested calls, direct recursion, and mutual recursion;
- lexical function scope with package-global access;
- deep-copy ordinary arguments/returns and speaker-reference identity preservation.

Complete static typing and the wider V30 Standard Library/runtime APIs are not implemented. Typed signatures may be parsed for diagnostics while unsupported execution/type semantics remain rejected.

## Protected names

Grammar keywords, type names, engine names, and implemented core built-ins are centrally protected from user declarations even when a protected future engine API is not yet callable. Protection does not make a deferred API implemented.

The V30-to-V31 gap review is not a V31 syntax document. A future `accepted-syntaxes-v31.md` should be created only by consolidating V30 with decisions that have actually been accepted.
