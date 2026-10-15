# TeaseScript

## Syntax authority

The complete accepted syntax baseline is `specifications/accepted-syntaxes-v30.md`. Do not duplicate or reinterpret it here.

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

The accepted boundary does not itself change accepted V30 forms such as `wait 2 s` or `timer 10 s`. ADR 0018 specifically supersedes the V30 points listed below; unrelated V30 syntax remains authoritative.

## Accepted first Standard Library POC syntax

ADR 0018 selects direct Standard Library names with no import and no first-POC opt-out or shadowing.

The current compiler implements the compact interaction forms in this section, and the parenthesized form of the basic
asks as the same interactions, through explicit versioned interaction instructions and the canonical resumable runtime.
The broader parenthesized V30 APIs and their advanced parameters remain deferred, except `askImage(...)`, which is
implemented in its V30 call form (`let picture = askImage("Add an image")`, and with `allowSkip: true` a `string?`
that is `null` when the player skips it; see [Image input](RUNTIME.md#image-input) and
[V30 §20](specifications/accepted-syntaxes-v30.md#skipping-a-file-input)),
`askForm` and `askBooleans`, which are asks in both forms ([V30 §20](specifications/accepted-syntaxes-v30.md#forms)),
`showPopup`, `openUrl`, and `exportText` ([Popups, web addresses, and exported text](#popups-web-addresses-and-exported-text));
this slice does not treat compact syntax as a runtime library call. Another parenthesized interaction-call spelling,
such as `showButton(...)` or `askChoice(...)`, is never interpreted as compact syntax; until those APIs are implemented,
the parser reports it with focused diagnostic `TSP032`. An `as speaker` clause placed after the payload receives the
same diagnostic.

### Basic interactions

```tease
showButton "Continue"
showButton as mistress "Ready"
let elapsed = showButton "Continue", timeout: 30 s

let text = askText
let text = askText as mistress "What do you say?"
let name = askText "Your name?", prefill: "Ada", hint: "Type your name"

let amount = askNumber
let amount = askNumber as mistress "How many?"
let minutes = askNumber prefill: 10
let count = askInteger "How many?", prefill: 3

let day = askDate "Which day?"
let start = askTime as mistress "What time?", prefill: toTime("20:00")
let moment = askDateTime "When are you free?"

let name = askText("Your name?", prefill: "Ada")
let more = askInteger as mistress ("How many?", prefill: 3) + 1

let name = askText prose "Your name?"
let count = askInteger as mistress prose(align: "center") "How many?"
let name = askText prose() ("Your name?", prefill: "Ada")
let picture = askImage prose ("Show me your setup")

let ok = askBoolean as mistress "Ready?", yesText: "Sure!", noText: "No, thanks"
```

The basic asks also take their arguments in parentheses, with the same meaning; the `)` ends the ask inside a larger
expression, and `as speaker` comes before the parentheses
([ADR 0018](decisions/0018-first-standard-library-poc-contract.md#parenthesized-basic-asks)).

Every ask that takes a question shows it as `say` shows a message: `bubble(options)` or `prose(options)` after
`as speaker` and before the question chooses the mode, with the options of `say`, and without one the speaker's mode
applies, a bubble by default. As for `say`, a mode before parentheses is written with its own, `askText prose() (...)`,
since `askText prose("Name?")` asks the value of a call to `prose`; `askImage`, which always takes parentheses, also
takes `askImage prose (...)`. `askChoice` has no question, so a question shown as prose is a `say prose` before it
([V30 §20](specifications/accepted-syntaxes-v30.md#20-input-functions)).

For `askText`, `askNumber`, `askInteger`, and the date and time asks, the optional text is the question: the asking
speaker says it in the chat, as by `say` but with no reading time of its own, once, and the field opens with it. `hint:` is help text shown in the field
only; in a text or number field it shows only while the field is empty, so a prefill usually hides it
([questions and hints](decisions/0018-first-standard-library-poc-contract.md#ask-questions-and-hints)). An
optional `prefill:` answer starts in the field; the player still submits it, and a cleared field does not fall back to
it. See [prefilled answers](specifications/accepted-syntaxes-v30.md#prefilled-answers). `askBoolean` says its question the
same way, then shows two buttons: `yesText:` (default "Yes") returns `true` and `noText:` (default "No") returns
`false`, and `prefill: true` or `prefill: false` preselects one of them
([boolean input](specifications/accepted-syntaxes-v30.md#boolean-input)).

All basic interactions are mandatory and blocking, with no cancellation result. `askText` returns `string`;
`askNumber` returns `number`; `askInteger` returns `integer` and accepts only whole numbers; `askBoolean` returns
`boolean`; `askDate`, `askTime`, and
`askDateTime` return `date`, `time`, and `datetime` from the Player's date and time controls. `showButton` used as a value returns the elapsed waiting time as a `duration`, and an
optional `timeout:` ends the wait without a chat message; see
[blocking button](specifications/accepted-syntaxes-v30.md#21-blocking-button).
Timer interrupts may suspend an interaction, whose timeout stands still meanwhile; handler `exit` discards its
instruction without producing a result or binding. See [timer semantics](specifications/accepted-syntaxes-v30.md#27-timers).

`askText` normalizes line endings to `LF`, otherwise preserves submitted text, and rejects whitespace-only input. It does not automatically trim, change case, or apply Unicode normalization.

`askNumber` trims surrounding whitespace, accepts the ordinary TeaseScript decimal and scientific-number forms on one line, returns a finite number, and records the trimmed submitted text in the transcript rather than reformatting it. Locale decimal commas, thousands separators, units, and natural-language phrases are not accepted by the deterministic first POC.

### Popups, web addresses, and exported text

```tease
showPopup "Task completed"
showPopup(message: "Well done, ${name}", buttonText: "Continue")
openUrl("https://example.com")
openUrl("https://example.com", buttonText: "Claim your reward")
openUrl("https://example.com", alwaysButton: true, buttonText: "Claim your reward")
```

`showPopup` shows its message in a dialog outside the chat with one button, `OK` unless `buttonText:` renames it, and
waits until the player closes it; neither enters the transcript, and like `showButton` it returns its elapsed time
([§31](specifications/accepted-syntaxes-v30.md#31-popups-and-system-notifications)). The call form also takes the
message without its name, first. A block may interrupt it like any interaction ([Runtime](RUNTIME.md#generic-foreground-interactions)).

`openUrl` takes one web address first, without a name: text that is an `http` or `https` URL, never a list (compile
error `TSV043` for a written one, runtime error `TSR050` otherwise). It waits until the address is open in a new tab:
usually at once, and when the browser needs a click from the player first, the Player shows a button for it, which
never shows the address. `buttonText:` is the button's text, "Open link" by default, with the rules of `showPopup`'s,
and `alwaysButton: true` shows the button also right after a click, so the player opens the tab with it; either way the
script goes on once the tab is open ([§33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references)).

```tease
exportText(toBase64(toJson(preset)), title: "Your preset", fileName: "preset.txt")
```

`exportText` takes its text first, without a name, and the optional `title:`, shown text, "Copy or download" by
default, and `fileName:`, text, "text.txt" by default. It shows the title and the text in a dialog outside the chat
with Copy, Download, and Close, and waits until the player closes it; nothing enters the transcript, and it gives no
value ([§31](specifications/accepted-syntaxes-v30.md#export-text)). The text may be as long as any text. A text or file
name that is not text is compile error `TSV043` for a known type and runtime error `TSR050` otherwise.

```tease
let shared = toJson({ name: name, photo: takePhoto() })
let preset = fromJson(text, default: null)
let picture = fileFromBase64(base64, default: null)
```

`toJson` writes every stored file a value holds, a photo or a file from `fileFromBase64`, as a `data:` URL with the
type its first bytes give, and `fromJson` stores each data URL of an image, audio, or video type as a file again and
gives its reference; `files: false` keeps both as text. `fileFromBase64(text, default:)` stores the bytes of Base64
text or of a `data:…;base64,` URL as a file and gives its reference, or the default for text that is not Base64, and
`fileToBase64(file)` gives a stored file's bytes as Base64. A stored file is shown only when it is an image; other files
can be kept, passed along, and turned back into Base64 ([§33](specifications/accepted-syntaxes-v30.md#stored-files),
[stored files](RUNTIME.md#stored-files)).

```tease
let correct = hashText(answer) == "45d227c4b297a0ba4ce42738ad3d448e19628a5ecfd509ea861b24a23009d08e"
let same = hashFile(image) == load("imageHash", default: "")
```

`hashText(text)` gives the SHA-256 of a text's UTF-8 bytes at once, and `hashFile(file)` that of a stored file's bytes
after a short wait, both as the 64 lowercase hexadecimal digits that other programs, such as `sha256sum`, give. Any
other value goes through `toJson` first. A hash hides only a secret with many possible values
([§13](specifications/accepted-syntaxes-v30.md#hashes)).

### Compact choices

`askChoice` returns the value of the selected button. A value may be written before an option's `:`; an option without
one returns itself, with its own type. A list or set option gives one button per element:

```tease
let result = askChoice "Bratty", "Very submissive"
let result = askChoice as mistress first: "Mystery", second: "Mystery"
let result = askChoice 1: "Open the door", 2: "Walk away"
let rounds = askChoice 5, 10, 15
let offenses = [{ value: "spank", text: "Spanking" }, { text: "Corner" }]
let answer = askChoice back: "Back", offenses
let rounds = askChoice 5, 10, 15, prefill: 10
```

A trailing `prefill:` preselects the first button with that value: it is marked, and Space in the empty composer
activates it, but it is never chosen by itself ([preselected button](specifications/accepted-syntaxes-v30.md#preselected-button)).
The compact form keeps every option in one statement and separates options with commas. Options with and without a
written value may be mixed; values of different types, such as text and numbers, are kept only by a place declared with
a union type. Buttons may repeat values and visible text. [V30 §19](specifications/accepted-syntaxes-v30.md#19-choices)
defines the complete option rules.

`askChoice` is the author-facing construct. `choice` is the internal interaction/action noun.

Existing downstream interaction and validation guards remain boundary-local technical constraints; compact `askChoice` does not promote them into a TeaseScript source-capacity promise.

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
say "Exactly five seconds", 5 s
say "Immediate", 0 s
say "Immediate", instant
```

Pacing meanings:

- omitted: smart autoplay from captured account settings;
- positive exact duration: exact reading time, including fractional seconds such as `1.5 s`;
- `0 s` or `instant`: no reading time;
- a number without a unit: compile error that names the fix, such as `5 s` ([ADR 0026](decisions/0026-unified-time-semantics.md#8-explicit-units-for-time-quantities));
- negative, non-finite, calendar, unsupported-magnitude, or deadline-overflow value: structured error.

With no explicit skip modifier, `say` uses the effective speaker's `defaultSaySkippable` setting and otherwise the platform default `true`.

A paced `say` lasts its reading time, and the next statement runs after it, unless the player skips it (owner decision
on #829, 2026-10-11). Nothing after the `say` runs during its reading time: no other message, question, button, form,
media or camera change, message or permanent-button change, `wait`, timer, or code the player cannot see. A question
appears together with its controls, and a timeout counts from when it is visible. Permanent buttons already shown stay
usable. A timer, media, or permanent-button block interrupts a reading time as it interrupts a `wait`, and the reading
time continues with the time it had left once the block returns. For exact timing, write `instant`:
`say "Hold the position.", instant` followed by `wait 30 s` takes exactly 30 seconds, and without `instant` the reading
time comes first. `wait` remains separate and does not become a `say` option.

Used as a value, `say` gives a `messageHandle` whose `text` changes the message in place, without a new message or
pacing, and whose `remove()` takes the message out of the chat
([Updatable messages](specifications/accepted-syntaxes-v30.md#updatable-messages)). Inside a list or call, write it in
parentheses, `say("text", pacing)`:

```tease
let waiting = say "Waiting.", instant
repeat 2 {
    wait 1 s
    waiting.text += "."
}
waiting.remove()

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

The exact syntax for detailed result objects, advanced accessibility overrides, a speaker-aware typing indicator, custom `askChoice` field hints, any justified platform guards that later prove necessary, and constrained LLM answer interpretation remains deferred.

## Currently implemented language subset

The repository includes core values, variables, assignments including `+=`/`-=`, speakers with the V30 §37 terms, the
built-in speaker `player`, and the read-only person fields of `account` ([player and account](RUNTIME.md#the-player-and-the-account)), output, collections
including dicts ([§40](specifications/accepted-syntaxes-v30.md#40-dictionaries)), expressions, comments, ranges,
deterministic random built-ins, the `round`, `floor`, and `ceil` built-ins, conditionals including `switch`, loops, and
loop control.

Implemented script storage includes `save`, `load` with an optional lazy default, and `delete`, with a checkpointed
session view and host-acknowledged atomic writes. Every `load` has a default and reads the stored value as the type a
load of the key declares, or its default's type; it ignores a stored value of another type with developer warning
`TSW016`, and the loads and saves of a key written as a string literal must agree. Accepted semantics are defined in
specification [§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys); the host boundary is
defined in [Runtime](RUNTIME.md#script-storage). The Player keeps script storage in browser local storage ([data
boundary](DATA-AND-API.md#script-storage-in-the-browser)).

Implemented timing includes exact and calendar duration literals/values, cross-unit comparisons, date, time, datetime,
and `absoluteDateTime` values with strict ISO conversion and the player's numeric presentation, blocking `wait`/`timer`,
and asynchronous timers with display, labels, handles, lifecycle control, repetition, expiry interrupts, and checkpoint
restore, and permanent buttons whose clicks run their blocks like expiry interrupts. Blocks never interrupt each other,
so a repeating timer whose block takes at least as long as its period holds the script after the timer for as long as
it repeats. Debug reports this once as developer warning `TSW018`, when a whole round runs out inside the block. Timer,
media, and button blocks share the variables of the code that creates them
([§14](specifications/accepted-syntaxes-v30.md#variables-in-timer-media-and-button-blocks)). Accepted forms and current
limits are defined in specification [§27](specifications/accepted-syntaxes-v30.md#27-timers),
[§28](specifications/accepted-syntaxes-v30.md#28-permanent-buttons), and
[§35](specifications/accepted-syntaxes-v30.md#35-date-time-and-durations).

Implemented media includes the persistent Stage image (`showImage`, `hideImage`), blocking and asynchronous
`playAudio`/`playVideo` with playback ranges, repetition, volume, handles, seeks, timeline cues, the self-handle binding,
`stopAudio` for every sound at once, and checkpoint restore. Player load and progress reports drive playback state;
the Player shows images and plays audio (#446), and browser video playback is not implemented. Accepted forms are
defined in specification [§22](specifications/accepted-syntaxes-v30.md#22-stage-image-audio-and-video).

The current function subset includes:

- top-level function declarations;
- required and trailing-default parameters;
- positional and named calls, including positional arguments followed by named ones;
- earlier-parameter references in defaults, while later-parameter references are rejected;
- value, bare, and implicit `return`;
- forward calls, nested calls, direct recursion, and mutual recursion;
- lexical function scope with package-global access;
- deep-copy ordinary arguments/returns and speaker-reference identity preservation.

Implemented value operations include the V30 §8 text operations and regexes, joining two texts or two lists with `+`
(§4), list `join`, `addAll`, `sort`, `shuffle`, `reverse`, `take`, `takeLast`, `indexOf`, `lastIndexOf`, `count`, and
`get` with `default:`, the `intersection`, `union`, and `difference` of lists and sets, a range's §6 `toList()`, the
§13 conversions `toString`,
`toNumber`, `toInteger`, and `toBoolean` with `default:`, the §13 JSON and Base64 functions `toJson`, `fromJson`,
`toBase64`, and `fromBase64`, with stored files as data URLs unless `files: false`, the §13 hashes `hashText` and
`hashFile`, the §33 file functions `fileFromBase64` and `fileToBase64` ([stored files](RUNTIME.md#stored-files)), the
numeric functions `round` (also with
`decimals:`), `floor`, `ceil`, `abs`, `sign`, `sqrt`, `pow`, `mod`, and `clamp`, the constant `pi`, the exponentials,
logarithms, and angles in degrees `exp`, `ln`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, and `atan2`, `min`
and `max`, the §16 statistics and trends `sum`, `average`, `median`, `percentile`, `stddev`, `linearRegression`, and
`predict`, the §4 weighted choice `randomWeighted` and distributions `randomNormal`, `randomBeta`, and `randomPert`, and
the read-only §38 `debugMode`. When the receiver or argument type is known, misuse is compile error `TSV043`, or
`TSV020`/`TSV022` for argument counts and names, which are also checked on a receiver of unknown type where no receiver
with that method takes them; a method that no value has is `TSV043` also on a receiver of unknown type, as is any method
of a speaker other than the statement `player.copyFrom(account)`; other values are checked when the operation runs.

A separate type check (`src/type-checker.ts`) runs once names and structure are valid and enforces ADR 0021: variables,
list and set elements, dict values, object properties, the custom properties of a speaker that only stores through its
name reach (V30 §37), parameters, and function results keep one type, including types
decided by a first non-null value, a first element, a parameter default, or a function's returns; an inferred `integer`
variable, element, or property is a `number` when one of its assignments can store a non-whole number; `integer` to
`number` is the only implicit conversion; operators, conditions, indexes, members, and command operands get values of
types they support, and on a union every member must support them; reading an object property that no object at its
place can have, or a custom property, built-in field, term, or name list that no declaration or assignment gives any
speaker the read may reach (V30 §37), is a compile error, decided at the end of the check from code anywhere in the
project; union types, type
names, and `is` type tests are available, and tests, `!= null`, and assignments narrow plain variables; using a possibly
null value where its non-null type is required is a compile error that names the check and a fallback with
`otherwise` ([§18](specifications/accepted-syntaxes-v30.md#fallback-with-otherwise)). A mismatch is `TSV041`, an
unsupported operand or such a property read `TSV043`, returns of different types, list elements of different types, or
an `askChoice` of different value types outside a declared union `TSV044`, a provably constant type test or comparison
warning `TSV046`, and a fallback after a value that is never null warning `TSV062`. When a value the compiler cannot
know, such as storage under a computed key, host data, or an unknown parameter, is stored in a place whose type is at
least partly known, the plan carries that type and the runtime checks the value before storing it (`TSR058`).

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
