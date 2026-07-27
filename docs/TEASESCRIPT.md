# TeaseScript

## Syntax authority

The complete accepted syntax baseline is `specifications/accepted-syntaxes-v30.md`. Do not duplicate or reinterpret it here.

Accepted post-V30 additions:

- ADR 0013 defines `set[...]`, `type set`, insertion order, uniqueness, methods/properties, and non-indexability.
- ADR 0014 defines recursive value-copy behavior, scalar-only sets, empty collection errors, and speaker display-name fallback.
- ADR 0015 defines the serializable instruction-plan/runtime/checkpoint architecture used to execute the implemented syntax.
- ADR 0016 defines the shared resumable pending-action contract and selects blocking `wait` as its first implementation slice.
- ADR 0017 defines the accepted boundary between official syntax, the public Standard Library, package libraries, privileged platform adapters, and deterministic engine primitives.

Rejected forms remain rejected, including `set score = 20`, `procedure`, and `call` for ordinary function calls. Historical research may still contain those forms and is non-authoritative.

## Language design intent

TeaseScript should make the common authoring path readable and require as little boilerplate as practical. A script author who is not a professional developer should be able to use compact official syntax and deterministic platform defaults without first understanding the engine, imports, pending-action state, or UI implementation details.

The same language must still permit advanced authors to opt into explicit parameters, ordinary function calls, TypeScript libraries, custom UI, and lower-level capabilities where supported. Advanced control should extend the simple path rather than making every basic script spell out the advanced machinery.

When syntax is designed or reviewed, prefer:

- compact, readable forms for common actions;
- deterministic and documented defaults that handle the ordinary case;
- explicit overrides for authors who need different behavior;
- minimal mandatory imports and configuration;
- no hidden nondeterminism or uncheckpointed execution state;
- special syntax only where it materially improves ordinary authoring and remains unambiguous.

Keeping compact syntax does not require its implementation to remain hard-coded as a separate engine system. The compiler may lower an easy source form through the Standard Library or into small engine primitives while preserving source spans, diagnostics, determinism, and resume behavior.

## Accepted syntax-to-library boundary

ADR 0017 separates source syntax from internal implementation placement.

An official TeaseScript construct may lower to:

- a core engine primitive;
- a platform Standard Library function;
- or a fixed compiler-owned composition of both.

Ordinary Standard Library and package-library exports use normal function-call syntax. Generated signatures and metadata provide the intended path for autocomplete, parameter hints, hover documentation, navigation, and type-aware diagnostics without requiring a new grammar production.

Libraries may not add keywords, command syntax, block syntax, token forms, or parser hooks. New special syntax remains an explicit TeaseScript/compiler decision. Official syntax may call into a library internally, but a library export does not automatically become syntax.

Examples of the distinction:

```tease
say "Hello"              // official accepted command syntax
say(text: "Hello")       // possible ordinary library/API call; not accepted by ADR 0017 alone
customGreeting("Hello")  // ordinary package-library call
```

A formatter formats ordinary calls according to the existing call grammar. It does not invent command syntax for a library function.

The accepted boundary does not itself change accepted V30 forms such as `say "..."`, `wait 2`, `timer 10`, or `startTimer ...`. Timer names, chat pacing, and whether particular accepted forms later lower through the Standard Library require separate accepted decisions.

## Currently implemented language subset

The repository includes core values, variables, assignments, speakers, output, collections, expressions, comments, ranges, deterministic random built-ins, conditionals, loops, and loop control.

The current function subset includes:

- top-level function declarations;
- required and trailing-default parameters;
- positional and named calls;
- earlier-parameter references in defaults, while later-parameter references are rejected;
- value, bare, and implicit `return`;
- forward calls, nested calls, direct recursion, and mutual recursion;
- lexical function scope with package-global access;
- deep-copy ordinary arguments/returns and speaker-reference identity preservation.

Complete static typing and the wider V30 Standard Library/runtime APIs are not implemented. Typed signatures may be parsed for diagnostics while unsupported execution/type semantics remain rejected.

The current implemented `say` and `say as` paths remain unchanged by ADR 0017. A later migration may lower those forms through a tested Standard Library path while preserving source spans, diagnostics, visible output, speaker identity, deterministic RNG use, and checkpoint behavior.

## Diagnostics

Parser and semantic diagnostics are deterministic source-associated data. Resource-bound failures must be returned through this diagnostic model rather than exposed as native host exceptions.

The source parser enforces a maximum recursive nesting depth of `64`. Inputs that exceed it return one `TSP027` error diagnostic rather than exposing a native JavaScript stack failure.

## Protected names

Grammar keywords, type names, engine names, and implemented core built-ins are centrally protected from user declarations even when a protected future engine API is not yet callable. Protection does not make a deferred API implemented.

A Standard Library export does not automatically become a protected grammar keyword. Name reservation, import qualification, conflicts, shadowing, and compatibility policy require the later library-linkage decision.

The V30-to-V31 gap review is not a V31 syntax document. A future `accepted-syntaxes-v31.md` should be created only by consolidating V30 with decisions that have actually been accepted.
