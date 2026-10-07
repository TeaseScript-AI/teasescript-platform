# TeaseScript

## Syntax authority

The complete accepted syntax baseline is `specifications/accepted-syntaxes-v30.md`. Do not duplicate or reinterpret it here.

Accepted post-V30 additions:

- ADR 0013 defines `set[...]`, `type set`, insertion order, uniqueness, methods/properties, and non-indexability.
- ADR 0014 defines recursive value-copy behavior, set members and their copies, empty collection errors, and speaker display-name fallback.
- ADR 0015 defines the serializable instruction-plan/runtime/checkpoint architecture used to execute the implemented syntax.
- ADR 0016 defines the shared resumable pending-action contract and selects blocking `wait` as its first implementation slice.
- ADR 0017 defines the accepted boundary between official syntax, the public Standard Library, package libraries, privileged platform adapters, and deterministic engine primitives.
- ADR 0018 defines the accepted first Standard Library POC contract for `showButton`, `askText`, `askNumber`, `choose`, and `say` smart autoplay.
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

The accepted boundary does not itself change accepted V30 forms such as `wait 2` or `timer 10`. ADR 0018 specifically supersedes the V30 points listed below; unrelated V30 syntax remains authoritative.

## Accepted first Standard Library POC syntax

ADR 0018 selects direct Standard Library names with no import and no first-POC opt-out or shadowing.

The current compiler implements the compact interaction forms in this section, and the parenthesized form of the basic
asks as the same interactions, through explicit versioned interaction instructions and the canonical resumable runtime.
The broader parenthesized V30 APIs and their advanced parameters remain deferred, except `askImage(...)`, which is
implemented in its V30 call form (`let picture = askImage("Add an image")`; see [Image input](RUNTIME.md#image-input)),
and `askForm`, which is an ask in both forms, with `askBooleans(...)` on the same form
([V30 §20](specifications/accepted-syntaxes-v30.md#forms));
this slice does not treat compact syntax as a runtime library call. Another parenthesized interaction-call spelling,
such as `showButton(...)` or `choose(...)`, is never interpreted as compact syntax; until those APIs are implemented,
the parser reports it with focused diagnostic `TSP032`. An `as speaker` clause placed after the payload receives the
same diagnostic.

### Basic interactions

```tease
showButton "Continue"
showButton as mistress "Ready"
let elapsed = showButton "Continue", timeout: 30 s

let text = askText
let text = askText as mistress "What do you say?"
let name = askText "Your name?", default: "Ada", hint: "Type your name"

let amount = askNumber
let amount = askNumber as mistress "How many?"
let minutes = askNumber default: 10
let count = askInteger "How many?", default: 3

let day = askDate "Which day?"
let start = askTime as mistress "What time?", default: toTime("20:00")
let moment = askDateTime "When are you free?"

let name = askText("Your name?", default: "Ada")
let more = askInteger as mistress ("How many?", default: 3) + 1
```

The basic asks also take their arguments in parentheses, with the same meaning; the `)` ends the ask inside a larger
expression, and `as speaker` comes before the parentheses
([ADR 0018](decisions/0018-first-standard-library-poc-contract.md#parenthesized-basic-asks)).

For `askText`, `askNumber`, `askInteger`, and the date and time asks, the optional text is the question: the asking
speaker says it in the chat, as by `say`, once, right before the field opens. `hint:` is help text shown in the field
only; in a text or number field it shows only while the field is empty, so a default usually hides it
([questions and hints](decisions/0018-first-standard-library-poc-contract.md#ask-questions-and-hints)). An
optional `default:` answer prefills the field; the player still submits it, and a cleared field does not fall back to
it. See [default answers](specifications/accepted-syntaxes-v30.md#default-answers).

All basic interactions are mandatory and blocking, with no cancellation result. `askText` returns `string`;
`askNumber` returns `number`; `askInteger` returns `integer` and accepts only whole numbers; `askDate`, `askTime`, and
`askDateTime` return `date`, `time`, and `datetime` from the Player's date and time controls. `showButton` used as a value returns the elapsed waiting time as a `duration`, and an
optional `timeout:` ends the wait without a chat message; see
[blocking button](specifications/accepted-syntaxes-v30.md#21-blocking-button).
Timer interrupts may suspend an interaction; handler `exit` discards its instruction without producing a result
or binding. See [timer semantics](specifications/accepted-syntaxes-v30.md#27-timers).

`askText` normalizes line endings to `LF`, otherwise preserves submitted text, and rejects whitespace-only input. It does not automatically trim, change case, or apply Unicode normalization.

`askNumber` trims surrounding whitespace, accepts the ordinary TeaseScript decimal and scientific-number forms on one line, returns a finite number, and records the trimmed submitted text in the transcript rather than reformatting it. Locale decimal commas, thousands separators, units, and natural-language phrases are not accepted by the deterministic first POC.

### Compact choices

`choose` returns the value of the selected button. A value may be written before an option's `:`; an option without
one returns itself, with its own type. A list or set option gives one button per element:

```tease
let result = choose "Bratty", "Very submissive"
let result = choose as mistress first: "Mystery", second: "Mystery"
let result = choose 1: "Open the door", 2: "Walk away"
let rounds = choose 5, 10, 15
let offenses = [{ value: "spank", text: "Spanking" }, { text: "Corner" }]
let answer = choose back: "Back", offenses
```

The compact form keeps every option in one statement and separates options with commas. Options with and without a written value may be mixed; until union types arrive (#504), one `choose` may not mix identifier and numeric values before `:`. Buttons may repeat values and visible text. [V30 §19](specifications/accepted-syntaxes-v30.md#19-choices) defines the complete option rules.

`choose` is the author-facing construct. `choice` is the internal interaction/action noun.

Existing downstream interaction and validation guards remain boundary-local technical constraints; compact `choose` does not promote them into a TeaseScript source-capacity promise.

Selecting a button or dropdown entry supplies its position to the engine. The engine validates the selection and derives the returned value and the canonical visible player-transcript text from the active choice. Manually typed input uses exact, unambiguous visible-text matching.

This compact form supersedes the V30 split between `{...}` bodies with values and `[...]` bodies without. The question itself is normally emitted with `say`.

### Dynamic choice presentation

Choice presentation is a Player application decision, not TeaseScript syntax or canonical runtime state. Buttons may occupy one or two rows. The Player application may render the same active choice as a dropdown when viewport, font, zoom, accessibility, or text-length constraints make buttons impractical. Exact breakpoints remain deferred.

### `say` pacing and skip modifiers

The [message presentation contract](specifications/accepted-syntaxes-v30.md#message-presentation-defaults-and-overrides)
defines optional mode/style overrides and speaker inheritance. Parentheses may be omitted when no options are needed.
The accepted compact order is:

```text
say [as speaker] [bubble(options) | prose(options)] [skippable | unskippable] text [, pacing]
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

Used as a value, `say` gives a `messageHandle` whose `text` changes the message in place, without a new message or
pacing ([Updatable messages](specifications/accepted-syntaxes-v30.md#updatable-messages)). Inside a list or call, write
it in parentheses, `say("text", pacing)`:

```tease
let waiting = say "Waiting.", instant
repeat 2 {
    wait 1 s
    waiting.text += "."
}

let count: integer = 0
let strokes = say "Strokes: 0", instant
repeat 50 {
    wait 1 s
    count += 1
    strokes.text = "Strokes: ${count}"
}
```

### Authored `say` message markup

After the final `say` string is evaluated and interpolated, the runtime parses it once using the constrained grammar in
[`specifications/message-markup.md`](specifications/message-markup.md). The grammar provides selected Markdown-like
formatting, controlled bracket extensions, HTTP(S) links, and block presentation without accepting raw HTML or
arbitrary CSS. Smart pacing counts the resulting visible text rather than markup delimiters.

Ordinary interpolation participates in that final parse. Use the protected Platform Standard Library helper
`escapeMarkup(text)` when inserted string content must remain literal:

```tease
let name = "**Mistress**"
say "**Warning:** ${escapeMarkup(name)}, no touching."
```

A message handle's `text` is that evaluated string before parsing, and a new `text` is parsed whole again; interpolation
is not repeated. Player-authored transcript entries remain plain text. The canonical specification owns the complete
grammar, escaping, nesting, recovery, and link rules.

### Bounded-data boundary

ADR 0018 does not assign separate author-facing character limits to text answers, hints, buttons, or choice texts. Interaction definitions and completions remain subject to justified current platform constraints for strings, collections, messages, plans, snapshots, checkpoints, nesting, and validation work.

Over-limit data is rejected deterministically without truncation or partial state mutation. The editor may warn earlier about impractically long labels or large choice sets.

### First-POC source compatibility boundary

The broader parenthesized V30 input functions and `showButton` forms are not rejected merely because compact forms are implemented first. Their advanced options require a later compatibility and API decision.

The exact syntax for detailed result objects, advanced accessibility overrides, a speaker-aware typing indicator, custom `choose` field hints, any justified platform guards that later prove necessary, and constrained LLM answer interpretation remains deferred.

## Currently implemented language subset

The repository includes core values, variables, assignments including `+=`/`-=`, speakers, output, collections
including dicts ([§40](specifications/accepted-syntaxes-v30.md#40-dictionaries)), expressions, comments, ranges,
deterministic random built-ins, the `round`, `floor`, and `ceil` built-ins, conditionals including `switch`, loops, and
loop control.

Implemented script storage includes `save`, `load` with an optional lazy default, and `delete`, with a checkpointed
session view and host-acknowledged atomic writes. Accepted semantics and current type-checking limits are defined in
specification [§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys); the host boundary is defined
in [Runtime](RUNTIME.md#script-storage). The Player keeps script storage in browser local storage
([data boundary](DATA-AND-API.md#script-storage-in-the-browser)).

Implemented timing includes exact and calendar duration literals/values, cross-unit comparisons, date, time, datetime,
and timestamp values with strict ISO conversion and the player's numeric presentation, blocking `wait`/`timer`, and
asynchronous timers with display, labels, handles, lifecycle control, repetition, expiry interrupts, and checkpoint
restore, and permanent buttons whose clicks run their blocks like expiry interrupts. Timer, media, and button blocks
share the variables of the code that creates them
([§14](specifications/accepted-syntaxes-v30.md#variables-in-timer-media-and-button-blocks)). Accepted forms and current
limits are defined in specification [§27](specifications/accepted-syntaxes-v30.md#27-timers),
[§28](specifications/accepted-syntaxes-v30.md#28-permanent-buttons), and
[§35](specifications/accepted-syntaxes-v30.md#35-date-time-durations-and-timestamps).

Implemented media includes the persistent Stage image (`showImage`, `hideImage`), blocking and asynchronous
`playAudio`/`playVideo` with playback ranges, repetition, volume, handles, seeks, timeline cues, the self-handle binding,
and checkpoint restore. Player load and progress reports drive playback state; browser integration is tracked in #446
and browser video playback is not implemented. Accepted forms are defined in specification
[§22](specifications/accepted-syntaxes-v30.md#22-stage-image-audio-and-video).

The current function subset includes:

- top-level function declarations;
- required and trailing-default parameters;
- positional and named calls, including positional arguments followed by named ones;
- earlier-parameter references in defaults, while later-parameter references are rejected;
- value, bare, and implicit `return`;
- forward calls, nested calls, direct recursion, and mutual recursion;
- lexical function scope with package-global access;
- deep-copy ordinary arguments/returns and speaker-reference identity preservation.

Implemented value operations include the V30 §8 text operations, joining two texts or two lists with `+` (§4), list
`join`, `addAll`, `sort`, `shuffle`, `take`, and `takeLast`, the `intersection`, `union`, and `difference` of lists and
sets, the §13 conversions `toString`, `toNumber`, `toInteger`, and `toBoolean` with `default:`, the numeric functions
`round` (also with `decimals:`), `floor`, `ceil`, `abs`, `sign`, `sqrt`, `pow`, `mod`, and `clamp` and the constant
`pi`, `min` and `max`, the §16 statistics and trends `sum`, `average`, `median`, `percentile`, `stddev`,
`linearRegression`, and `predict`, and the §4 weighted choice `randomWeighted`. When the receiver or argument type is
known, misuse is compile error `TSV043`, or `TSV020`/`TSV022` for argument counts and names; other values are checked
when the operation runs.

A separate type check (`src/type-checker.ts`) runs once names and structure are valid and enforces ADR 0021: variables,
list and set elements, dict values, object properties, parameters, and function results keep one type, including types
decided by a first non-null value, a first element, a parameter default, or a function's returns; an inferred `integer`
variable, element, or property is a `number` when one of its assignments can store a non-whole number; `integer` to
`number` is the only implicit conversion; operators, conditions, indexes, members, and command operands get values of
types they support, and on a union every member must support them; union types, type names, and `is` type tests are
available, and tests, `!= null`, and assignments narrow plain variables; using a possibly null value where its non-null
type is required is a compile error that names the check. A mismatch is `TSV041`, an unsupported operand `TSV043`,
returns of different types, list elements of different types, or a `choose` of different value types outside a declared
union `TSV044`, and a provably constant type test or comparison warning `TSV046`. When a value the compiler cannot know,
such as untyped storage, host data, or an unknown parameter, is stored in a place whose type is at least partly known,
the plan carries that type and the runtime checks the value before storing it (`TSR058`).

The wider V30 Standard Library/runtime APIs are not implemented yet.

The current source/compiler implements authored presentation options and the ADR 0018 `say` pacing and skip forms while
preserving existing `say`/
`say as` spans, diagnostics, visible output, speaker identity, deterministic RNG use, and checkpoint behavior.
`skippable` and `unskippable` act as modifiers only where the existing value grammar cannot consume them as the complete
`say` value. Bare `instant` is the zero-duration alias only when it fills the complete pacing slot; larger pacing
expressions beginning with an identifier named `instant` remain ordinary expressions.

Concrete colour parsing/conversion uses exact `colorjs.io@0.7.1` (MIT, no runtime dependencies) through `src/color.ts`.
It supplies colour-space conversion behind the shared supported-notation grammar and CSS input-channel validation.
The compiler validates constants; runtime output preparation converts authored colours without recompiling converted values. Hand-written
conversion would duplicate specialised parsing/math; separate per-layer parsers would risk different accepted values.
The unbundled playground uses an import map and one explicit local module route; the Vue builds bundle the dependency.
The dependency adds browser bundle weight and requires reviewing upstream parser/conversion changes on upgrades. Its
input is restricted to concrete colour forms; it does not execute CSS, fetch resources or access the DOM. Dependency
updates remain explicit and the accepted colour contract stays repository-owned.

## Diagnostics

Parser and semantic diagnostics are deterministic source-associated data. Ordinary syntax failures use this model.
TeaseScript defines no authored-syntax nesting maximum; host JavaScript stack exhaustion is an environment-specific
implementation constraint, not language capacity. Historical diagnostic measurements live in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md).

## Protected names

Grammar keywords, type names, engine names, and implemented core built-ins are centrally protected from user
declarations. Protecting a name reserves it; it does not make that name callable.

A Standard Library export does not automatically become a protected grammar keyword. ADR 0018 explicitly protects its
selected first-POC direct names, and the message-markup specification explicitly protects `escapeMarkup`, as part of
the automatic prelude. Broader import qualification, conflicts, replacement, and compatibility policy remain later
library-linkage decisions.

The V30-to-V31 gap review is not a V31 syntax document. A future `accepted-syntaxes-v31.md` should consolidate V30 with accepted post-V30 decisions, including ADR 0018, rather than treating this topic document as the consolidated syntax specification.
