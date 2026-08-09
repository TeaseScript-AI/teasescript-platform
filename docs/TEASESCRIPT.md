# TeaseScript

## Syntax authority

The complete accepted syntax baseline is `specifications/accepted-syntaxes-v30.md`. Do not duplicate or reinterpret it here.

Accepted post-V30 additions:

- ADR 0013 defines `set[...]`, `type set`, insertion order, uniqueness, methods/properties, and non-indexability.
- ADR 0014 defines recursive value-copy behavior, scalar-only sets, empty collection errors, and speaker display-name fallback.
- ADR 0015 defines the serializable instruction-plan/runtime/checkpoint architecture used to execute the implemented syntax.
- ADR 0016 defines the shared resumable pending-action contract and selects blocking `wait` as its first implementation slice.
- ADR 0017 defines the accepted boundary between official syntax, the public Standard Library, package libraries, privileged platform adapters, and deterministic engine primitives.
- ADR 0018 defines the accepted first Standard Library POC contract for `showButton`, `askText`, `askNumber`, `choose`, and `say` smart autoplay.

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

The accepted boundary does not itself change accepted V30 forms such as `wait 2`, `timer 10`, or `startTimer ...`. ADR 0018 specifically supersedes the V30 points listed below; unrelated V30 syntax remains authoritative.

## Accepted first Standard Library POC syntax

ADR 0018 selects direct Standard Library names with no import and no first-POC opt-out or shadowing.

The current compiler implements the four compact interaction forms in this section through explicit versioned interaction instructions and the canonical resumable runtime. The broader parenthesized V30 APIs and their advanced parameters remain deferred; this slice does not treat compact syntax as a runtime library call. Parenthesized interaction-call spellings and an `as speaker` clause placed after the payload are rejected with focused parser diagnostic `TSP032` rather than being interpreted as compact syntax.

### Basic interactions

```tease
showButton "Continue"
showButton as mistress "Ready"

let text = askText
let text = askText as mistress "Type your answer"

let amount = askNumber
let amount = askNumber as mistress "Enter a number"
```

For `askText` and `askNumber`, the optional string is Standard UI field text or a hint. It is not automatically spoken into the transcript. The normal question is a preceding `say`.

All four basic interactions are mandatory and blocking. They do not return `null` and cannot be cancelled. `askText` returns `string`; `askNumber` returns `number`; the first `showButton` slice has no useful script return value and no timeout.

`askText` normalizes line endings to `LF`, otherwise preserves submitted text, and rejects whitespace-only input. It does not automatically trim, change case, or apply Unicode normalization.

`askNumber` trims surrounding whitespace, accepts the ordinary TeaseScript decimal and scientific-number forms on one line, returns a finite number, and records the trimmed submitted text in the transcript rather than reformatting it. Locale decimal commas, thousands separators, units, and natural-language phrases are not accepted by the deterministic first POC.

### Compact choices

Unlabelled choices return visible text:

```tease
let result = choose "Bratty", "Very submissive"
let result = choose as mistress "Bratty", "Very submissive"
```

Labelled choices return the authored label:

```tease
let result = choose bratty: "Bratty", submissive: "Very submissive"
let result = choose as mistress first: "Mystery", second: "Mystery"
let result = choose 1: "Open the door", 2: "Walk away"
```

The compact form keeps every option in one statement and separates options with commas. Labelled and unlabelled options may not be mixed. Identifier labels and finite numeric-literal labels are accepted, but one `choose` may not mix the two label types. Identifier labels return `string`; numeric labels return `number`. Labels must be unique. Repeated visible text is allowed only for labelled choices; an unlabelled duplicate is a compile error.

`choose` is the author-facing construct. `choice` is the internal interaction/action noun.

Existing downstream interaction and validation guards remain boundary-local technical constraints; compact `choose` does not promote them into a TeaseScript source-capacity promise.

Selecting a labelled button or dropdown entry supplies its label to the engine; selecting an unlabelled entry supplies its visible text. The engine validates the selection and derives the canonical visible player-transcript text from the active choice. Manually typed input uses exact, unambiguous visible-text matching.

This compact form supersedes the V30 split between `{...}` labelled bodies and `[...]` unlabelled bodies. The question itself is normally emitted with `say`.

### Dynamic choice presentation

Choice presentation is a Player application decision, not TeaseScript syntax or canonical runtime state. Buttons may occupy one or two rows. The Player application may render the same active choice as a dropdown when viewport, font, zoom, accessibility, or text-length constraints make buttons impractical. Exact breakpoints remain deferred.

### `say` pacing and skip modifiers

The accepted compact order is:

```text
say [as speaker] [skippable | unskippable] text [, pacing]
```

Examples:

```tease
say "Smart autoplay"
say as mistress "Smart autoplay"
say unskippable "Read every word."
say as mistress skippable "You have seen this before."
say "Exactly five seconds", 5
say "Immediate", 0
say "Immediate", instant
```

Pacing meanings:

- omitted: smart autoplay from captured account settings;
- positive finite number: exact pacing gate in seconds, including fractional seconds;
- `0` or `instant`: settle any earlier background gate, emit immediately, and create no new gate;
- negative, non-finite, unsupported-magnitude, or deadline-overflow value: structured error.

With no explicit skip modifier, `say` uses the effective speaker's `defaultSaySkippable` setting and otherwise the platform default `true`.

`wait` remains separate. It does not become a `say` option and does not consume the pacing gate.

### Bounded-data boundary

ADR 0018 does not assign separate author-facing character limits to text answers, hints, buttons, or choice labels. Interaction definitions and completions remain subject to justified current platform constraints for strings, collections, messages, plans, snapshots, checkpoints, nesting, and validation work.

Over-limit data is rejected deterministically without truncation or partial state mutation. The editor may warn earlier about impractically long labels or large choice sets.

### First-POC source compatibility boundary

The broader parenthesized V30 input functions are not rejected merely because compact forms are implemented first. Their advanced options require a later compatibility and API decision.

V30 `showButton` timeout and elapsed-time return remain accepted future capability but are not included in the first POC slice.

The exact syntax for detailed result objects, advanced accessibility overrides, a speaker-aware typing indicator, custom `choose` field hints, any justified platform guards that later prove necessary, and constrained LLM answer interpretation remains deferred.

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

The current implemented `say` and `say as` paths remain unchanged until a tested ADR 0018 implementation preserves source spans, diagnostics, visible output, speaker identity, deterministic RNG use, and checkpoint behavior while adding the accepted pacing contract.

## Diagnostics

Parser and semantic diagnostics are deterministic source-associated data. Ordinary syntax failures use this model.
TeaseScript defines no authored-syntax nesting maximum; host JavaScript stack exhaustion is an environment-specific
implementation constraint, not language capacity. Historical diagnostic measurements live in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md).

## Protected names

Grammar keywords, type names, engine names, and implemented core built-ins are centrally protected from user declarations even when a protected future engine API is not yet callable. Protection does not make a deferred API implemented.

A Standard Library export does not automatically become a protected grammar keyword. ADR 0018 explicitly protects the selected first-POC direct names as part of the automatic prelude. Broader import qualification, conflicts, replacement, and compatibility policy remain later library-linkage decisions.

The V30-to-V31 gap review is not a V31 syntax document. A future `accepted-syntaxes-v31.md` should consolidate V30 with accepted post-V30 decisions, including ADR 0018, rather than treating this topic document as the consolidated syntax specification.
