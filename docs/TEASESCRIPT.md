# TeaseScript

## Syntax authority

The complete accepted syntax baseline is `specifications/accepted-syntaxes-v30.md`. Do not duplicate or reinterpret it here.
[`TEASESCRIPT-REFERENCE.md`](TEASESCRIPT-REFERENCE.md) summarizes each accepted construct with its status and an
example, and links to its V30 section; start there to learn the language.

Accepted post-V30 additions:

- ADR 0013 defines `set[...]`, `type set`, insertion order, uniqueness, methods/properties, and non-indexability.
- ADR 0014 defines recursive value-copy behavior, set members and their copies, empty collection errors, and speaker display-name fallback.
- ADR 0015 defines the serializable instruction-plan/runtime/checkpoint architecture used to execute the implemented syntax.
- ADR 0016 defines the shared resumable pending-action contract and selects blocking `wait` as its first implementation slice.
- ADR 0017 defines the accepted boundary between official syntax, the public Standard Library, package libraries, privileged platform adapters, and deterministic engine primitives.
- ADR 0018 defines the accepted first Standard Library POC contract for `showButton`, `askText`, `askNumber`, `askChoice`, and `say` smart autoplay.
- ADR 0021 defines static types: enforcement, implicit conversions, union types, type tests, and narrowing.
- ADR 0022 defines multi-file scripts: `goto` and `call` across files, globs, `script(...)` references, globals, and
  explicit endings with `end` and `exit`.
- ADR 0024 lets timer, media, and button blocks share the function and block variables of the code that creates them.
- `specifications/message-markup.md` defines the accepted constrained presentation markup for authored Standard-chat
  `say` output and the `escapeMarkup()` literal-insertion helper.

Rejected forms remain rejected, including `set score = 20`, `procedure`, and `call` for ordinary function calls. Historical research may still contain those forms and is non-authoritative.

## Language design intent

TeaseScript serves the [creator audience](PRODUCT.md), including people who have
never programmed. The common authoring path should be readable and require as little boilerplate as practical. Creators
should be able to use compact official syntax and documented platform defaults without first understanding the engine,
imports, pending-action state, or UI implementation details. Ordinary authoring should not require repeated settings
where a suitable default can express the intended behavior.

The same language must still permit advanced authors to opt into explicit parameters, ordinary function calls,
TypeScript libraries, custom UI, and lower-level capabilities where supported. Advanced control should extend the simple
path rather than making every basic script spell out the advanced machinery.

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

Ordinary Standard Library and package-library exports use normal function-call
syntax when linkage is implemented. Future consumer-driven signatures and
metadata may provide autocomplete, parameter hints, hover documentation,
navigation, and type-aware diagnostics without requiring a new grammar
production. Official syntax support remains parser/compiler-owned.

Libraries may not add keywords, command syntax, block syntax, token forms, or parser hooks. New special syntax remains an explicit TeaseScript/compiler decision. Official syntax may call into a library internally, but a library export does not automatically become syntax.

Examples of the distinction:

```tease
say "Hello"              // official accepted command syntax
say(text: "Hello")       // possible ordinary library/API call; not accepted by ADR 0017 alone
customGreeting("Hello")  // ordinary package-library call
```

A formatter formats ordinary calls according to the existing call grammar. It does not invent command syntax for a library function.

The accepted boundary does not itself change accepted V30 forms such as `wait 2 s` or `timer 10 s`. ADR 0018 supersedes only the V30 points it names; unrelated V30 syntax remains authoritative.

## Colour and regex engines

Concrete colour parsing/conversion uses exact `colorjs.io@0.7.1` (MIT, no runtime dependencies) through `src/color.ts`.
It supplies colour-space conversion behind the shared supported-notation grammar and CSS input-channel validation.
The compiler validates constants; runtime output preparation converts authored colours without recompiling converted values. Hand-written
conversion would duplicate specialised parsing/math; separate per-layer parsers would risk different accepted values.
The unbundled playground uses an import map and one explicit local module route; the Vue builds bundle the dependency.
The dependency adds browser bundle weight and requires reviewing upstream parser/conversion changes on upgrades. Its
input is restricted to concrete colour forms; it does not execute CSS, fetch resources or access the DOM. Dependency
updates remain explicit and the accepted colour contract stays repository-owned.

Regexes ([§8](specifications/accepted-syntaxes-v30.md#regexes)) use exact `re2js@2.8.6` (MIT, no runtime dependencies)
through `src/regex-engine.ts`, its only importer, with RE2's own syntax. A script instruction cannot be interrupted, so
a search must take time proportional to its text, which native backtracking `RegExp` does not guarantee; a WebAssembly
RE2 would load asynchronously and weigh more, and a hand-written engine would duplicate a specialised one. re2js adds
about 49 KB gzip to the Player. Upgrades need a review of its parser, which the size estimate in `src/regex.ts` mirrors;
of its case folding, which `src/regex-case-pairs.ts` pins: re2js folds characters outside its own table through the
host's `toLowerCase` and `toUpperCase`, so while it compiles or searches, the engine answers those two methods for one
character from Unicode 17.0 pairs, generated by `tools/generate-regex-case-pairs.mjs`, and restores the methods the host
had afterwards; and of the NFA internals that count the work of each search against the [regex work
limit](RESOURCE-LIMITS.md#retained-poc-policies-and-defaults): `doExecuteNFA`, its machine's `step`, its queues'
`contains`, and its input's `step`, `context`, and `canCheckPrefix`, which are not public API. Even repeated searches
for every match, which take quadratic time in the worst case, then end at the limit. Patterns are data compiled within the [regex
limits](RESOURCE-LIMITS.md#retained-poc-policies-and-defaults), never JavaScript. The engine is imported eagerly;
loading it on demand needs only `src/regex-engine.ts` to load re2js before the host compiles source or validates or runs
data that may hold a regex. The unbundled playground maps it like `colorjs.io`. The lexer tells a regex from division by
the token before a `/`, also after `say as speaker`; where a parse with errors expected a value at a `/` that the lexer
took for division, as after a message mode or a skip word, the parser lexes and parses the source again with a regex
there, and tooling that lexes part of the source again reads those places the same way.

The RE2 dialect differs from JavaScript in ways authors meet: `\d`, `\w`, and `\s` match ASCII characters only, so
`\p{Nd}` matches every decimal digit and `\p{L}` every letter; `i` folds single characters, so `ß` does not match `ss`;
back references such as `\1`, lookahead, and lookbehind are not supported; a pattern cannot hold half of a character, a
surrogate such as `\x{D83D}`; in a regex replacement, `$0` inserts the whole match, which JavaScript writes `$&`, and
`$&` stays text.

## Diagnostics

Parser and semantic diagnostics are deterministic source-associated data. Ordinary syntax failures use this model.
[`DIAGNOSTICS.md`](DIAGNOSTICS.md) lists their codes with owner and severity.
TeaseScript defines no authored-syntax nesting maximum; host JavaScript stack exhaustion is an environment-specific
implementation constraint, not language capacity. Historical diagnostic measurements live in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md).

## Protected names

Grammar keywords, type names, engine names, and implemented core built-ins are centrally protected from user
declarations, in `src/language-facts.ts` with the lexer's keywords, the words the parser reads by name, and the units.
The protected type names come from the kinds of values in `src/value-kinds.ts`.
Protecting a name reserves it; it does not make that name callable.

A Standard Library export does not automatically become a protected grammar keyword. ADR 0018 explicitly protects its
selected first-POC direct names, and the message-markup specification explicitly protects `escapeMarkup`, as part of
the automatic prelude. Broader import qualification, conflicts, replacement, and compatibility policy remain later
library-linkage decisions.

The V30-to-V31 gap review is not a V31 syntax document. A future `accepted-syntaxes-v31.md` should consolidate V30 with accepted post-V30 decisions, including ADR 0018, rather than treating this topic document as the consolidated syntax specification.
