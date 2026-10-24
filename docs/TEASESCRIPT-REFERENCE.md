# TeaseScript quick reference

A compact guide to TeaseScript syntax, by topic: a few lines per form, one example, its status, and a link to where it
is defined. It is **not authoritative**. The [accepted syntax specification](specifications/accepted-syntaxes-v30.md)
and the accepted ADRs in [decisions](decisions/) define the syntax; this page only summarizes them and links to them.
When they disagree, they win, and this page needs fixing.

Status labels, as checked against `main` on 2026-10-05:

- **Implemented on main**: usable in scripts today, through the language, compiler and runtime; Player exceptions are
  stated explicitly.
- **Accepted but not built**: accepted future syntax, not usable yet.
- **Superseded**: a historical form, shown with its current replacement.

Examples are fragments: named speakers, assets, variables and target files must exist. A complete project starts at
`main.tease` and needs a reachable `exit`.

## Contents

- [Text and say](#text-and-say)
- [Questions and buttons](#questions-and-buttons)
- [Variables and types](#variables-and-types)
- [Values, arithmetic and randomness](#values-arithmetic-and-randomness)
- [Objects, lists, sets and dicts](#objects-lists-sets-and-dicts)
- [Control flow](#control-flow)
- [Functions and globals](#functions-and-globals)
- [Files, labels and endings](#files-labels-and-endings)
- [Headers and tags](#headers-and-tags)
- [Images, audio and video](#images-audio-and-video)
- [Future layered scene](#future-layered-scene)
- [Camera and browser APIs](#camera-and-browser-apis)
- [Timers and pacing](#timers-and-pacing)
- [Dates, times and durations](#dates-times-and-durations)
- [Storage](#storage)
- [Speakers and presentation](#speakers-and-presentation)
- [Future player and account APIs](#future-player-and-account-apis)
- [Diagnostics and notifications](#diagnostics-and-notifications)

## Text and say

### Single-line and block strings

Double quotes and triple double quotes both support ${expression}. Block strings preserve newlines and remove common
source indentation; backticks are ordinary characters in a TeaseScript string.

```tease
say "Hello ${toString(3)}"
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#8-strings-and-interpolation), [ADR 0011](decisions/0011-say-string-literals.md).

### Escapes and interpolation

The accepted escapes are `\\`, `\"`, `\n`, `\r`, `\t` and `\${`. Interpolations evaluate from left to right;
interpolating a list picks one random element, while say on a whole list prints it.

```tease
say "Quote: \"hello\"\nNext line"
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#string-escape-sequences), [ADR 0011](decisions/0011-say-string-literals.md).

### say a value

say accepts an expression: text and scalar values display normally; lists, sets, dicts, objects, ranges and handles
display as diagnostic notation. ${names} chooses one list item; names.join() shows all.

```tease
let names = ["Ada", "Bo"]
say "Guests: ${names.join()}"
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#9-commands).

### Text methods

Immutable text supports length; contains, startsWith, endsWith, indexOf, lastIndexOf, substring, split, replace,
trim/trimStart/trimEnd, uppercase/lowercase/uppercaseFirst, repeat and padStart/padEnd. Indexes count Unicode code
points from zero; replace changes all literal occurrences.

```tease
say "  ada  ".trim().uppercaseFirst()
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#text-operations).

### Inline message markup

Authored `say` text supports *italic*, **bold**, ~~strike~~, `code`, HTTP(S) links and `[u]text[/u]`. Use
`[color=colour]`, `[bg=colour]`, `[weight=name]`, `[size=name]` with matching closers. Weights:
thin/light/normal/medium/semibold/bold/black; sizes: small/normal/large/x-large.

```tease
say "[color=red]Read[/color] [bg=gold]this[/bg] [weight=bold]carefully[/weight] [size=large]![/size]"
```

**Status:** implemented on main. [Message markup](specifications/message-markup.md#inline-forms).

### Block message markup

At the start of a message line, #/##/### make headings, > makes a quote, - makes a bullet, and positive n. makes a
numbered item. These blocks do not nest; malformed markup remains visible text.

```tease
say "# Instructions\n- Read carefully\n- Continue"
```

**Status:** implemented on main. [Message markup](specifications/message-markup.md#lines-and-block-forms).

### Literal markup insertion and escaping

`escapeMarkup(text)` keeps inserted text literal. Authored punctuation can be escaped manually with markup backslashes,
doubled in TeaseScript source. String escaping runs before markup parsing.

```tease
let text = "**literal**"
say "You entered ${escapeMarkup(text)}"
say "\\*literal\\* and **bold**"
```

**Status:** implemented on main. [Message markup](specifications/message-markup.md#shared-helper-contracts), [Markup escaping](specifications/message-markup.md#backslash-escaping).

## Questions and buttons

### Compact asks: `askText`, `askNumber`, `askInteger`, `askDate`, `askTime`, `askDateTime`

`askText`, `askNumber`, `askInteger`, `askDate`, `askTime`, `askDateTime` block for typed answers. Optional `as speaker`
precedes the field hint; speak the question with `say`. `default:` prefills without submitting. Text preserves content;
numeric asks reject locale commas/units, and integer asks require signed whole digits.

```tease
let name = askText "Your name?", default: "Ada"
let count = askInteger as guide "How many?", default: 10
let start = askTime default: toTime("20:00")
```

**Status:** implemented on main. [V30 §20](specifications/accepted-syntaxes-v30.md#20-input-functions), [ADR 0018 source forms](decisions/0018-first-standard-library-poc-contract.md#speaker-modifier), [V30 defaults](specifications/accepted-syntaxes-v30.md#default-answers).

### Parenthesized asks

The broader `askText(...)`, `askNumber(...)`, `askInteger(...)`, `askDate(...)`, `askTime(...)`, `askDateTime(...)` and
`showButton(...)` call families remain accepted but deferred. They are not aliases for executable compact forms
(open point OP-10).

```tease
let name = askText("Your name?", default: "Ada")
```

**Status:** accepted but not built. [V30 §20](specifications/accepted-syntaxes-v30.md#20-input-functions), [ADR 0018 compatibility boundary](decisions/0018-first-standard-library-poc-contract.md#relationship-to-accepted-v30-syntax), [V30 §21](specifications/accepted-syntaxes-v30.md#21-blocking-button).

### Controlled typing: `askTyping(...)`

`askTyping` returns text with configurable editing restrictions. Options are `allowBackspace`, `allowDelete`,
`allowCopy`, `allowPaste`, `allowCut`, `allowUndo`, `allowRedo`, `allowSelection`, `allowAutocomplete`,
`allowAutocorrect`, `allowSpellcheck`, plus `message`, `default`, `scope` (`input`/`teasePlayer`). Exact task validation
remains open.

```tease
let line = askTyping(message: "Type here", allowBackspace: true, scope: "input")
```

**Status:** accepted but not built. [V30 controlled typing](specifications/accepted-syntaxes-v30.md#controlled-typing).

### Boolean question: `askBoolean(...)`

Returns `boolean`; accepted options include `message`, `yesText`, `noText`, `default`. There is no accepted compact
Boolean spelling; yes/no questions use this API rather than a popup.

```tease
let answer = askBoolean(message: "Continue?", yesText: "Continue", noText: "Stop", default: true)
```

**Status:** accepted but not built. [V30 Boolean input](specifications/accepted-syntaxes-v30.md#boolean-input), [default answers](specifications/accepted-syntaxes-v30.md#default-answers).

### Multi-field questions: `askNumbers`, `askIntegers`, `askBooleans`

Use `message`, `texts: string[]`, and typed `defaults`; return `number[]`, `integer[]`, `boolean[]` respectively.
Numeric fields all require valid values; integer fields reject decimals. Boolean fields select all applicable choices.

```tease
let counts = askIntegers(message: "Counts", texts: ["Minimum", "Maximum"], defaults: [1, 10])
```

**Status:** accepted but not built. [Numbers](specifications/accepted-syntaxes-v30.md#multiple-number-inputs), [integers](specifications/accepted-syntaxes-v30.md#multiple-integer-inputs).

### File/folder questions: `askFile`, `askFiles`, `askFolder`

Return engine-managed `string`, `string[]`, `string` references respectively; picker cancellation does not complete the
ask. File APIs accept extension `types` and MIME `mime` lists together; `askFolder("Select a folder")` requests one
folder.

```tease
let file = askFile(message: "Upload a document", types: [".pdf"])
```

**Status:** accepted but not built. [V30 file](specifications/accepted-syntaxes-v30.md#file-input), [multiple files](specifications/accepted-syntaxes-v30.md#multiple-file-input).

### Media questions: `askImage`, `askVideo`, `askAudio`

Return one engine-managed `string` reference; cancellation keeps the request active. Image/video default
`allowCamera`/`allowFile` true; audio defaults `allowMicrophone`/`allowFile` true. Optional `types`/`mime` restrict
files.

```tease
let image = askImage(message: "Add an image", allowCamera: true, allowFile: true)
```

**Status:** accepted but not built. [Image](specifications/accepted-syntaxes-v30.md#image-input), [video](specifications/accepted-syntaxes-v30.md#video-input).

### Invalid answers: `invalidMessage`, `invalidLlmInstruction`

Invalid answers keep an ask active. Advanced `invalidMessage` requests a popup and `invalidLlmInstruction` an LLM reply;
empty text disables each response. These options are future APIs; compact asks already reject invalid input
deterministically.

```tease
let count = askInteger(message: "How many?", invalidMessage: "Use a whole number.")
```

**Status:** accepted but not built. [V30 invalid input](specifications/accepted-syntaxes-v30.md#invalid-input-handling).

### `choose`: values, lists, sets and choice objects

`choose [as speaker]` returns the selected value. Options accept values, `key: text`, lists/sets, or `{text, value?,
background?}` objects. Lists/sets expand to buttons; identifier keys return text, numeric keys return numbers (`choose
1: "Open", 2: "Leave"`). Mixed results need a declared union; duplicate labels/values are allowed
(open point OP-03).

```tease
let result: integer | string = choose as guide "None", [5, 10]
```

**Status:** implemented on main. [V30 §19](specifications/accepted-syntaxes-v30.md#19-choices), [ADR 0018 choose](decisions/0018-first-standard-library-poc-contract.md#choose), [ADR 0021](decisions/0021-static-types.md#decision).

### Blocking button: `showButton`

Optional `as speaker`, `background:`, `timeout:`; the two options may occur in either order and evaluate once. Returns
elapsed scene time as `duration` when used as a value; timeout is positive seconds/elapsed duration and removes it
without a player message. Without timeout, it waits for activation; exact visible text also activates it.

```tease
let elapsed = showButton "Continue", timeout: 30 s, background: "seagreen"
```

**Status:** implemented on main. [V30 §21](specifications/accepted-syntaxes-v30.md#21-blocking-button), [ADR 0018 showButton](decisions/0018-first-standard-library-poc-contract.md#showbutton).

### Permanent buttons: `showPermanentButton`, `removePermanentButton`

Execution continues; click hides the button while its block runs, then returns it unless removed. Handler `goto`
abandons the interrupted path. `persist: true` inside the block survives transfers; all buttons disappear on `exit`.

```tease
let buttonId = showPermanentButton "Retry" {
    persist: true
    goto retry
}
removePermanentButton(buttonId)
```

**Status:** accepted but not built. [V30 §28](specifications/accepted-syntaxes-v30.md#28-permanent-buttons), [future controls boundary](RUNTIME.md#long-lived-standard-controls).

### Earlier choice-body grammar

The split between value-bearing `{...}` bodies and unkeyed `[...]` bodies was replaced by compact options. A list
remains a valid compact option: not every `choose [...]` is obsolete.

```tease
let action = choose open: "Open the door", leave: "Walk away"
```

**Status:** superseded. [ADR 0018 choose](decisions/0018-first-standard-library-poc-contract.md#choose), [V30 §19](specifications/accepted-syntaxes-v30.md#19-choices).

## Variables and types

### Variables and assignments

let declares a name; =, += and -= change an existing variable. Types are inferred, and an unannotated integer can widen
to number when an assignment needs it; explicit integer annotations remain strict.

```tease
let score = 10
score += 5
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#12-variable-declarations), [ADR 0021](decisions/0021-static-types.md).

### Scope

let is visible in its block and nested blocks. A visible name cannot be redeclared; sibling blocks may reuse a local
name. File locals are separate; global variables, global functions and speakers are shared.

```tease
if true { let message = "Hello" }
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#14-scope).

### Explicit types and unions

Use : T, T[], T set, T dict, T?, A | B and grouping. Scalar names are string, boolean, integer, number, date, time,
datetime, timestamp and duration; broad/reference names are null, list, set, dict, object, range, speaker, timer, media
and script.

```tease
let reward: integer | string = 10
reward = "a break"
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#13-explicit-types), [ADR 0021](decisions/0021-static-types.md).

### Optional values

T? means T | null. Check for null before an operation that requires the value; media APIs explicitly accepting null
retain their own behavior.

```tease
let answer: integer? = load "answer"
if answer != null { say answer + 1 }
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#18-null-and-optional-values), [ADR 0021](decisions/0021-static-types.md).

### Type tests and narrowing

is T and is not T test types and narrow plain variables in supported branches and short-circuit conditions. integer fits
number; whole runtime numbers pass is integer. Open point
OP-01: V30 still says date/time tests are always false,
contrary to current code.

```tease
let value: integer | string = 5
if value is integer { say value + 1 }
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#type-tests-and-narrowing), [ADR 0021](decisions/0021-static-types.md).

## Values, arithmetic and randomness

### Literals and numbers

Use true, false, null, decimal numbers (including .5 and 5.), leading zeros, and scientific notation. Signs are unary
operators; no hexadecimal, binary, octal-prefix, NaN or infinity literals.

```tease
let amount = 1.5e3
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#3-numeric-types).

### Arithmetic and comparisons

+ - * / % operate on supported numeric/temporal values; == != < <= > >= compare values. Division returns number; text
concatenation uses interpolation, not +. Collections compare structurally; handles and speakers use identity.

```tease
let total = 10 + 5 * 2
say total >= 20
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#4-arithmetic-operators).

### Logical expressions

Use and, or and not with booleans; there is no truthiness. Comparisons bind before not, then and, then or; parentheses
can make order explicit.

```tease
if not (5 == 3) and true { say "Yes" }
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#5-logical-and-comparison-operators).

### Ranges

a..b excludes b; a..=b includes it. Ranges are used by loops, randomInteger and numeric switch cases; their exact
iteration/selection rules depend on the consumer.

```tease
let roll = randomInteger(1..=6)
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#6-range-semantics).

### Deterministic randomness

random() returns [0,1); chance(percent) tests 0–100%; randomInteger(range) draws a whole number. List/set .random, list
interpolation, shuffle and glob/tag selection share the session RNG.

```tease
if chance(25) { say "A quarter of the time" }
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#randomness).

### Conversions

toString, toNumber, toInteger and toBoolean convert explicitly; default: supplies a fallback for invalid runtime values.
toInteger truncates toward zero; statically provable invalid conversion remains a compile error even with a default.

```tease
let text = askText
let amount = toNumber(text, default: 0)
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#type-conversion).

### Rounding and bounds

round rounds ties away from zero; floor rounds down; ceil rounds up. min/max take two or more numbers or compatible
duration/temporal values of one kind.

```tease
say max(1, min(round(2.5), 10))
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#type-conversion).

### Measurement units

Accepted length/mass/volume/temperature suffixes need a space: mm/cm/m/km/inch/ft/yard/mile, g/kg/oz/lb, ml/l, US fluid
ounce/cup/pint/quart/gallon and Celsius/Fahrenheit, with documented full names/plurals. .format(unit:, decimals:)
changes display; toNumber yields an SI scalar.

```tease
let distance = 4 cm
say distance.format(unit: "inch", decimals: 1)
```

**Status:** accepted but not built. [V30](specifications/accepted-syntaxes-v30.md#unit-values).

## Objects, lists, sets and dicts

### Objects and copies

{name: value} creates an object; use .property to read or assign a fixed property name. New properties may be assigned.
Ordinary composite data uses recursive value copies, so changing a copied object does not change the original.

```tease
let door = { name: "front", locked: true }
door.locked = false
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#15-objects), [ADR 0014](decisions/0014-core-runtime-value-semantics.md).

### Lists

[a, b] is an ordered list with zero-based [index]. Methods: add, remove, removeAt, removeFirst, removeLast, clear,
contains, join, sort, shuffle and toSet; properties: length, first, last and random. Empty selection and invalid indexes
raise errors.

```tease
let items = ["map", "key"]
items.add("rope")
say items[0]
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#16-lists).

### Sets

set[...] removes equal duplicates and keeps insertion order; T set is its type. Methods:
add/remove/clear/contains/toList/intersection/union/difference; properties: length/first/last/random. Sets are not
indexable and can nest any supported member, including dicts
(open point OP-02).

```tease
let values = set[1, 2, 2]
say values.length
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#16-lists), [ADR 0013](decisions/0013-set-collection.md).

### Collection set operations

intersection, union and difference return a new collection of the receiver kind, leaving both operands unchanged. The
other operand may be a list or set; unique results keep the receiver order, then new union members.

```tease
say ["map", "key"].union(["key", "rope"])
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#16-lists).

### Dictionaries

dict{...} stores text keys in insertion order; T dict fixes value type. Literal keys are identifiers, strings or [expr];
access/assignment uses [key]. Methods: contains/remove/clear/get(key, default:); properties: length/keys/values; for
iterates keys.

```tease
let counts = dict{ visits: 1 }
counts["visits"] += 1
say counts.get("other", default: 0)
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#40-dictionaries).

## Control flow

### Statement endings and continuation

Newlines end complete statements; semicolons are rejected. A closing block brace can end its final statement. Continue
inside `()`, `[]`, objects, or after `=`, a comma, a binary operator, or `:`; leave the operator on the prior line. Keep
command/first argument, name/`(`, and number/unit together; only block strings span lines. Indentation is not syntax.

```tease
let total = 2 +
    3
if total > 0 { say "Positive" }
```

**Status:** implemented on main. [V30 §1](specifications/accepted-syntaxes-v30.md#1-statement-termination), [§7](specifications/accepted-syntaxes-v30.md#7-conditions-and-blocks).

### Comments: `//`, `/* … */`

Line and block comments annotate source without executing it. Markers inside strings remain text.

```tease
// A line comment.
/* A block comment. */
say "// This is text."
```

**Status:** implemented on main. [V30 §24](specifications/accepted-syntaxes-v30.md#24-comments).

### `if`, `else if`, `else`

Conditions require booleans, with no truthiness. Parentheses are optional; braces are required. Write `else if` as two
words.

```tease
if score > 5 { say "High" } else if score > 0 { say "Some" } else { say "None" }
```

**Status:** implemented on main. [V30 §7](specifications/accepted-syntaxes-v30.md#7-conditions-and-blocks), [ADR 0021 §1.8](decisions/0021-static-types.md#1-every-value-has-one-type-and-the-compiler-keeps-it).

### Loops: `repeat`, `while`

`repeat` uses a whole-number count. `while` tests a boolean before each iteration; parentheses are optional. Loops can
suspend and resume through checkpoints.

```tease
repeat 3 { say "Again" }
let count = 0
while (count < 2) { count += 1 }
```

**Status:** implemented on main. [V30 §23](specifications/accepted-syntaxes-v30.md#23-loops), [ADR 0021 §1.2](decisions/0021-static-types.md#1-every-value-has-one-type-and-the-compiler-keeps-it).

### Iteration: `for name in …`

Visit list/set elements, dict keys, or whole numbers of a range as they were when iteration started. Changing the
collection does not change the visits; `..` excludes its end and `..=` includes it.

```tease
for n in 1..=3 { say n }
```

**Status:** implemented on main. [V30 §23](specifications/accepted-syntaxes-v30.md#23-loops), [§6](specifications/accepted-syntaxes-v30.md#6-range-semantics).

### `break`, `continue`

Leave the current loop or advance to its next iteration. Inside a switch they still control the surrounding loop.

```tease
for item in 1..=5 {
    if item == 2 { continue }
    if item == 4 { break }
    say item
}
```

**Status:** implemented on main. [V30 §23](specifications/accepted-syntaxes-v30.md#23-loops), [§32](specifications/accepted-syntaxes-v30.md#32-switch-statements).

### `switch`, value/range `case`, `default`

`switch` evaluates once and runs the first matching required case block, without fallthrough. Cases accept
comma-separated literals/speakers, numeric-literal ranges, or `case is T`/`case is not T` with narrowing. Optional
`default` comes last; overlapping value cases are errors.

```tease
switch answer {
    case null { say "No answer" }
    case is integer { say answer + 1 }
    default { say answer }
}
```

**Status:** implemented on main. [V30 §32](specifications/accepted-syntaxes-v30.md#32-switch-statements), [§6](specifications/accepted-syntaxes-v30.md#6-range-semantics), [ADR 0021 §4–5](decisions/0021-static-types.md#4-type-tests).

## Functions and globals

### Declarations: `function`, parameters/types/defaults, result annotation

Declare `function name {body}` with no parameters, or `function name(parameters): resultType {body}`. Parameters may
have types and trailing defaults. `return value`, bare `return`, or falling out return a result/null; regular functions
are file-local and top-level on main.

```tease
function add(left: number, right: number = 1): number { return left + right }
```

**Status:** implemented on main. [V30 §11](specifications/accepted-syntaxes-v30.md#11-function-definitions), [§17](specifications/accepted-syntaxes-v30.md#17-return-statements), [ADR 0022 §3](decisions/0022-multi-file-scripts.md#3-labels-file-local-names-global-functions-and-speakers), [ADR 0021 §1.5](decisions/0021-static-types.md#1-every-value-has-one-type-and-the-compiler-keeps-it).

### Calls: positional, named, mixed, omitted defaults

Use parentheses, including `name()` for no arguments. Positional arguments precede named ones; each parameter gets one
value. Defaults can reference earlier parameters, not later ones. Forward calls, recursion, actionful/suspending calls
work; `call` is reserved for file transfers. Function values/nested declarations are outside the implemented subset.

```tease
let result = add(2, right: 3)
```

**Status:** implemented on main. [V30 §10](specifications/accepted-syntaxes-v30.md#10-function-calls-and-arguments), [§11](specifications/accepted-syntaxes-v30.md#11-function-definitions).

### `global function`

Callable from every file without imports; project-wide unique name. It uses only globals, parameters, and its own
locals, and calls only global functions/built-ins. A bare-label goto enters the function's defining file afresh.

```tease
global function announce(count) { say "Count: ${count}" }
```

**Status:** implemented on main. [V30 §11: Global functions](specifications/accepted-syntaxes-v30.md#global-functions), [ADR 0022 §3](decisions/0022-multi-file-scripts.md#3-labels-file-local-names-global-functions-and-speakers).

### `global name = value`, optional type

Visible in all files, unshadowable, and initialized once before the story even when declared in a block that never runs.
Order: main first, then other paths, each in source order. Start values use literals, earlier globals, pure operators,
`load`, or `script(...)`, never locals, interactions, other calls, or randomness. Later declaration execution does
nothing.

```tease
global strictness = 2
global level = load "level", default: 1
global answer: string? = null
```

**Status:** implemented on main. [V30 §12: Global variables](specifications/accepted-syntaxes-v30.md#global-variables), [ADR 0022 §6](decisions/0022-multi-file-scripts.md#6-globals).

### `global …, default: …`

The default supplies the startup value; each execution assigns the initializer, which may use local values. The default
follows startup restrictions and binds to the nearest eligible construct; grouping gives it to the global.

```tease
function record(count) { global attempts = count, default: 0 }
global name = (askText "Name?"), default: "unknown"
```

**Status:** implemented on main. [V30 §12: Global variables](specifications/accepted-syntaxes-v30.md#global-variables), [ADR 0022 §6.5](decisions/0022-multi-file-scripts.md#6-globals).

## Files, labels and endings

### A `.tease` project: `main.tease`, package-root paths

Compile every file together; start at `main.tease`. Paths use `/` from the package root, independent of the caller's
folder. One plan/snapshot/checkpoint covers the project; functions and labels are file-local.

```tease
// main.tease
call "rooms/hall.tease"
exit
// rooms/hall.tease
say "Hall"
end
```

**Status:** implemented on main. [V30 §29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths), [ADR 0022 §1](decisions/0022-multi-file-scripts.md#1-project).

### `label name`, `goto name`

Labels stand only at file outer scope, unique per file; goto may run anywhere and discards function/loop/block
continuations. Local goto keeps that entry's variables; jumping back reruns later lets. Every path to a variable use
must have run its let.

```tease
let count = 0
label again
count += 1
if count < 3 { goto again }
exit
```

**Status:** implemented on main. [V30 §26](specifications/accepted-syntaxes-v30.md#26-labels-and-goto), [§29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths), [ADR 0022 §3](decisions/0022-multi-file-scripts.md#3-labels-file-local-names-global-functions-and-speakers).

### File/label transfers: `goto`, `call`

File goto replaces the entry, discards its function/loop/block continuations, and keeps pending file-call returns. Call
preserves its caller and returns after the call on end. Named-file transfers and `call label` start fresh file
variables; functions/handlers retain their originating entry's variables, and a handler's local goto can reactivate that
entry.

```tease
call "rooms/hall.tease" start
goto "rooms/hall.tease" start
```

**Status:** implemented on main. [V30 §29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths), [ADR 0022 §2](decisions/0022-multi-file-scripts.md#2-targets).

### Glob targets: `"folder/*.tease"`, optional label

`*` matches within one folder/file name. Compile-time expansion skips declaration-only files and filters by a supplied
label. No eligible file is an error. Each execution draws once; a glob fallback draws when used, with no redraw on
restore.

```tease
call "rooms/*.tease" start
```

**Status:** implemented on main. [V30 §29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths), [ADR 0022 §2](decisions/0022-multi-file-scripts.md#2-targets).

### References: `script(path, label:)`, grouped computed targets

`script(path)`/`script(path, label:)` produce type `script` values, comparable by path/label and storable/savable. Use
grouped expressions for variable targets; plain text is not a computed target. References have no properties/methods.
Literal paths/labels are checked at compile time; computed transfers at use, computed fallbacks when set. References
forbid globs.

```tease
let target = script("rooms/hall.tease", label: "start")
goto (target)
```

**Status:** implemented on main. [V30 §29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths), [ADR 0022 §2.4](decisions/0022-multi-file-scripts.md#2-targets).

### `end`, `exit`

`end` ends a file and returns to its caller, or uses an explicitly set fallback; `exit` ends the whole session.
Executable files need an ending/transfer on reachable ends; every project needs a reachable exit. Declaration-only files
run nothing and need no ending.

```tease
// main.tease
call "scene.tease"
exit
// scene.tease
say "Scene"
end
```

**Status:** implemented on main. [V30 §30](specifications/accepted-syntaxes-v30.md#30-script-endings), [ADR 0022 §4](decisions/0022-multi-file-scripts.md#4-endings).

### `fallback target`, `fallback none`

Set the destination for end without a caller using any goto target; latest execution wins and none clears it.
Checkpointed session state, not metadata. It may run anywhere; a tagged fallback picks when set, a glob fallback when
used.

```tease
fallback "menu.tease" start
fallback none
```

**Status:** implemented on main. [V30 §30](specifications/accepted-syntaxes-v30.md#30-script-endings), [§41](specifications/accepted-syntaxes-v30.md#tagged-selection), [ADR 0022 §4.5](decisions/0022-multi-file-scripts.md#4-endings).

### Historical `run` and automatic rotation

ADR 0022 removes run/implicit next-file selection. Author explicit transfers or selection logic instead.

```tease
// Current replacement:
goto "next.tease"
```

**Status:** superseded. [ADR 0022 §2.5](decisions/0022-multi-file-scripts.md#2-targets), [V30 §29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths).

## Headers and tags

### Header: `---`, `title`, `author`, `description`, `tags`, `keywords`

An optional opening `---` header records title/author/description/tags/keywords. Tags and keywords are comma-separated,
without list brackets; tags are quoted plain names or unquoted `name: number` members. Header strings do not
interpolate. Unknown/repeated fields or malformed values fail compilation; metadata runs no code.

```tease
---
title: "A short scene"
author: "Ada"
tags: "chastity", punishment: 4
---
exit
```

**Status:** implemented on main. [V30 §41: File header](specifications/accepted-syntaxes-v30.md#file-header), [ADR 0023 §1](decisions/0023-tags-for-scripts-and-images.md#1-file-header), [V30 §41: Tags](specifications/accepted-syntaxes-v30.md#tags).

### Script picks: `goto tagged`, `call tagged`, `fallback tagged`, `from:`

Pick a runnable file by header tags, enter its top, and draw once; main/current file are candidates too. Quoted from
narrows to a package path/glob. Literal provably empty picks fail compilation; dynamic empty picks fail at runtime. From
itself must name a runnable file; comparisons/computed lists are not evaluated for static emptiness.

```tease
goto tagged "punishment", none: ["intense"]
call tagged "chastity", from: "modules/*.tease"
fallback tagged all: ["menu"], from: "menus/*.tease"
```

**Status:** implemented on main. [V30 §41: Tagged selection](specifications/accepted-syntaxes-v30.md#tagged-selection), [ADR 0023 §3](decisions/0023-tags-for-scripts-and-images.md#3-selection).

### Query built-ins: `findScripts`, `findImages`

`findScripts`/`findImages` list matches without drawing RNG. Queries use `where:` predicates (presence, comparisons,
and/or/not, parentheses), and `all:`/`none:`/`any:` name lists; findScripts also takes `from:`. Results are script
references or image strings and may be empty.

```tease
let pool = findScripts(from: "modules/*.tease", where: "punishment" > 3)
let images = findImages(all: ["bedroom"], none: ["outdoor"])
```

**Status:** implemented on main. [V30 §41: Tagged selection](specifications/accepted-syntaxes-v30.md#tagged-selection), [ADR 0023 §4](decisions/0023-tags-for-scripts-and-images.md#4-lists-for-counting-and-custom-logic).

### Image picks: `showImage tagged`

`showImage tagged` draws once using the same predicates/list options, with no redraw on restore. Package image tags come
from XMP keywords (whole-filename .xmp sidecars win); tag strings use `name` or `name: number`. Tagged captures join the
session catalog; static emptiness has qualified rules
(open point OP-07).

```tease
showImage tagged "bedroom", "punishment" >= 3
```

**Status:** implemented on main. [V30 §41](specifications/accepted-syntaxes-v30.md#tagged-selection), [ADR 0023 §3](decisions/0023-tags-for-scripts-and-images.md#3-selection), [V30 §41: Image tags](specifications/accepted-syntaxes-v30.md#image-tags).

## Images, audio and video

### Stage image: `showImage`, `hideImage`

`showImage reference` changes the persistent Stage image; `hideImage` clears it. `showImage null` clears with a
developer warning. Package image display works in the Player; tag selection is under headers/tags.

```tease
showImage "images/room.jpg"
hideImage
```

**Status:** implemented on main. [V30 Stage image](specifications/accepted-syntaxes-v30.md#stage-image), [cleanup](specifications/accepted-syntaxes-v30.md#failures-cleanup-and-restore).

### `playAudio`, `playVideo`: blocking, async, ranges and repetition

Playback blocks by default; `async` returns a handle. Named options: `file`, `async`, `repeat`, `startAt`, `endAt`,
`volume` (0–1). Repetition accepts Boolean, `n times`, or an exact duration; unplayable media warns and continues.
Engine support exists for both; Player audio works and browser video is unbuilt
(open point OP-08).

```tease
let music = playAudio(file: "music.mp3", async: true, repeat: 3 times, volume: 0.5)
```

**Status:** implemented on main in language/runtime; browser video accepted but not built. [V30 audio/video](specifications/accepted-syntaxes-v30.md#audio-and-video).

### Media handle controls and fields

Methods: `pause()`, `resume()`, `stop()`. Fields: `position`, `remaining`, `duration`, `elapsed`, `volume`, `state`.
Writable: position/remaining with `=`, `+=`, `-=` durations, and volume. Seeks clamp and do not fire jumped cues;
elapsed spans passes but excludes pauses/stalls. States: running, paused, finished, stopped.

```tease
music.pause()
music.position += 5 s
music.volume = 0.5
music.resume()
```

**Status:** implemented on main. [V30 media handles](specifications/accepted-syntaxes-v30.md#media-handles).

### Media cues and self-handle: `at`, `beforeEnd`, `finish`

`at` runs at a source position; `beforeEnd` counts back from each pass's end; `finish` runs once after natural
invocation completion. A plain playback block runs at each pass end. Named media blocks can see their own handle,
without capturing surrounding locals.

```tease
let music = playAudio async "music.mp3" {
    at 30 s { music.volume = 0.2 }
    beforeEnd 10 s { say "Almost done." }
    finish { say "Finished." }
}
```

**Status:** implemented on main in language/runtime; browser video accepted but not built. [V30 cues](specifications/accepted-syntaxes-v30.md#cues), [failures/cleanup/restore](specifications/accepted-syntaxes-v30.md#failures-cleanup-and-restore).

### Superseded media forms

Use Stage commands and explicit audio/video handles; old top-level positioned/timed images are not the current Stage
API. Standalone `pause`, `resume`, `stop` are reserved, not executable commands.

```tease
let music = playAudio async "music.mp3"
music.stop()
```

**Status:** superseded. [V30 old media](specifications/accepted-syntaxes-v30.md#superseded-v30-media-forms), [reserved controls](specifications/accepted-syntaxes-v30.md#reserved-generic-media-controls).

Old names/forms: `playSound`, `playBackgroundSound`, `stopBackgroundSound`, `stopVideo`,
`showBackgroundVideo(..., loop: true)`, and positioned/timed top-level `showImage`/`hideImage(ref)`.

## Future layered scene

### Future backgrounds, overlays, coordinates and transitions

Accepted direction: `showBackgroundImage`, `showBackgroundColor`, `showOverlayImage`, `showOverlayVideo`. Coordinates
are percentage-based, `relativeTo` selects background/viewport, and `fit` is contain/cover/stretch. Transitions are
none/fade/crossfade. Stage coexistence and complete anchors/signatures remain open
(open point OP-09).

```tease
showBackgroundImage(image: nextRoom, fit: "contain", transition: "crossfade", transitionDuration: 750 ms)
```

**Status:** accepted but not built. [V30 future scene](specifications/accepted-syntaxes-v30.md#future-layered-scene), [coordinate space](specifications/accepted-syntaxes-v30.md#scene-coordinate-space).

### Future overlay movement and hiding

`moveOverlay` and `animateOverlay` are async by default, with `blocking: true` available. Keyframes use `x`, `y`,
`duration`, optional `hold`. `hideOverlay()` hides the single active overlay; with multiple overlays supply its
reference.

```tease
moveOverlay(overlay, x: 25, y: 100, duration: 1 second)
hideOverlay(overlay)
```

**Status:** accepted but not built. [V30 movement/hiding](specifications/accepted-syntaxes-v30.md#multiple-overlays-and-movement).

### Future blur, drawings and edited copies

`showBlur`/`hideBlur` create a separate effect layer. `drawRectangle`, `drawEllipse`, `drawLine`, `drawText` create
removable drawings; `removeDrawing` removes one. Drawing style payloads and edited-image export signatures are
unresolved; no complete creation call is invented
(open point OP-09).

```tease
let blur = showBlur(target: overlay, shape: "ellipse", x: 50, y: 40, width: 30, height: 20, amount: 20)
hideBlur(blur)
removeDrawing(reference)
```

**Status:** accepted but not built. [V30 scene effects](specifications/accepted-syntaxes-v30.md#blur-drawings-edited-copies-and-transitions).

## Camera and browser APIs

### `takePhoto()` / `takePhoto(tags: ...)`

`takePhoto()` silently captures from the trusted Player session camera after Start; unavailable cameras return `null`
and warn. Optional `tags:` admits a photo to the image catalog. Saving its reference (also nested) retains the photo
across local runs; this does not implement `askImage`.

```tease
let photo = takePhoto(tags: ["bedroom"])
if photo != null { save photo as "lastPhoto" }
```

**Status:** implemented on main. [V30 §33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references), [image tags](specifications/accepted-syntaxes-v30.md#image-tags), [runtime camera](RUNTIME.md#camera-capture).

### Future browser pickers and URL navigation

`chooseFile()` and `chooseFolder()` return engine-managed `string?` references, including cancellation as null;
mandatory `askFile`/`askFolder` instead remain active. `openUrl(url)` performs navigation with no result. None of these
browser APIs is implemented on this snapshot.

```tease
let file: string? = chooseFile()
openUrl("https://example.com")
```

**Status:** accepted but not built. [V30 §33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references), [input rules](specifications/accepted-syntaxes-v30.md#general-input-rules).

## Timers and pacing

### Hidden blocking delay: `wait`

Bare numbers mean seconds; exact units are ms/s/min/h and accepted long spellings. Zero continues immediately;
invalid/negative values fail. Scene time continues with a minimized live Player but excludes restored downtime.

```tease
wait 2 min
```

**Status:** implemented on main. [V30 §27](specifications/accepted-syntaxes-v30.md#27-timers), [ADR 0016 wait](decisions/0016-resumable-pending-action-runtime-contract.md#wait-duration-semantics).

### `timer`: countdowns, async handles, repeats and persistence

Compact order: async, visible/mystery/hidden, duration, optional literal label, optional async expiry block. Named
options are duration/async/display/label/repeat/persist. Numeric seconds, exact durations and whole-second ranges work;
repeated rounds draw again, and persistent timers survive file transfers.

```tease
let beat = timer(duration: 1..=3, async: true, display: "mystery", repeat: true, persist: true)
```

**Status:** implemented on main. [V30 short form](specifications/accepted-syntaxes-v30.md#short-form), [blocking/async](specifications/accepted-syntaxes-v30.md#blocking-and-asynchronous-timers).

### Timer handle controls/fields

Methods: pause/resume/stop. Fields: `remaining`, `elapsed`, `display`, `label`, `state`, `repeatDuration`. Writable:
remaining (`=`, `+=`, `-=` durations), display, repeatDuration (later rounds only); zero remaining expires now. States:
running/paused/finished/stopped; settled reads remain valid, and invalid settled writes warn `TSW010`.

```tease
t.pause()
t.remaining += 10 s
t.display = "mystery"
t.resume()
```

**Status:** implemented on main. [V30 handles](specifications/accepted-syntaxes-v30.md#handles).

### Expiry blocks and scene time

Blocks run serially at deterministic boundaries, may wait, and interrupt an input/wait/timer after paced output. No
starter-local capture; normal completion restores the action, goto/exit discard it. Media keeps playing. Late
observations preserve due scene-time order; calls/transfers do not turn scene timers into wall-clock deadlines.

```tease
timer async 30 s "Deadline" { say "Time is up." }
let name = askText "Your name?"
```

**Status:** implemented on main. [V30 expiry blocks](specifications/accepted-syntaxes-v30.md#expiry-blocks), [time](specifications/accepted-syntaxes-v30.md#time).

### Future timer cues/self-handle

Accepted timer words are at/beforeEnd/finish, following media cues; plain blocks remain per-round expiry. A named
timer's block will see its own handle. Media already has these features; timer blocks do not.

```tease
let t = timer async 60 s {
    at 20 s { say "Twenty seconds." }
    beforeEnd 10 s { say "10" }
    finish { say "Done." }
}
```

**Status:** accepted but not built. [V30 planned timer cues](specifications/accepted-syntaxes-v30.md#timeline-cues-and-self-handle-planned).

### Future generalized elapsed-duration ranges

Elapsed-duration ranges such as `5..10 min` remain accepted but unbuilt. Calendar-duration `wait`/timer calls are
invalid under current V30 §35: this is not a promised future `wait 1 day` form.

```tease
timer 5..10 min
```

**Status:** accepted but not built. [V30 short form](specifications/accepted-syntaxes-v30.md#short-form), [duration rules](specifications/accepted-syntaxes-v30.md#durations).

### Message pacing: `say`, `skippable`, `unskippable`, `instant`

Omitted pacing uses smart autoplay; positive numbers are exact seconds; 0/instant bypass earlier pacing. Skip policy:
explicit modifier, then speaker `defaultSaySkippable`, then true. Wait/timer overlap pacing; ordinary Stage/media
commands wait for it. Empty-composer Space/unused-space click skip only skippable gates.

```tease
say as guide skippable "Read this.", 2.5
say unskippable "Wait five seconds.", 5
say "Immediate", instant
```

**Status:** implemented on main. [ADR 0018 say](decisions/0018-first-standard-library-poc-contract.md#say), [media barrier](specifications/accepted-syntaxes-v30.md#audio-and-video).

## Dates, times and durations

### Temporal construction and current values

getDate/getTime/getDateTime read the player's local values; getTimestamp reads a UTC moment.
toDate/toTime/toDateTime/toTimestamp accept strict ISO text; toDateTime(date,time) combines local parts. The Player
supplies captured zone/time data.

```tease
let dinner = toDateTime(toDate("2026-10-04"), toTime("18:00"))
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#construction-and-conversion).

### Duration literals

Exact units: ms/millisecond(s), s/second(s), min/minute(s), h/hour(s). Calendar units: d/day(s), w/week(s), mo/month(s),
y/year(s). Months, days and milliseconds stay distinct; timer/wait/media time takes exact durations only. `m` is never a
duration alias (open point OP-05).

```tease
let tomorrow = getDate() + 1 day
let pause = 500 ms
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#durations).

### Temporal arithmetic and comparison

date moves by calendar durations; datetime moves by calendar or exact durations; timestamp moves by exact durations.
Subtract two matching temporal kinds to get a duration; time has no arithmetic. Compare/sort/min/max only compatible
kinds/families.

```tease
let started = getTimestamp()
let deadline = started + 2 h
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#arithmetic-and-comparison).

### Fields and display

date/datetime expose year/month/day/weekday/weekdayNumber; time/datetime expose hour/minute/second/millisecond. Use
toISO, formatDate/formatTime/formatDateTime where the kind permits, datetime.toTimestamp(),
timestamp.toDateTime()/toSeconds()/toMilliseconds(), and duration.days/.months for the matching calendar family.

```tease
let day = toDate("2026-10-04")
say day.weekday
say day.toISO()
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#display-and-technical-conversion).

## Storage

### `save value as key`, `delete key`, `save null as key`

Save creates/overwrites one text key, evaluating value before key; top-level null deletes. Absent deletion is a no-op.
Dots/slashes do not navigate objects. Save/load copy data. Local writes are immediate; persistent writes await
acknowledgement, keeping the prior value and warning TSW014 on failure. Timer/media blocks wait for write settlement.

```tease
save { level: 4 } as "player/progress"
delete "player/progress"
```

**Status:** implemented on main. [V30 §25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys).

### `load key`, `load key, default: value`

Existing keys return stored types/values without evaluating defaults; absent keys return a lazy default or null.
Defaults never write storage and can suspend/resume. Stored/default/missing values must fit their receiving type
(TSR058).

```tease
let score: number = load "player.score", default: 0
```

**Status:** implemented on main. [V30 §25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys).

### Expression operands, grouping, nearest default

All storage operands are expressions. Group load before combining/comparing its result, or when nesting a load as a key.
Default binds to the nearest eligible construct; group inner interactions to give it to load, or to disambiguate save's
as. Ungrouped `load "k" == null` compares the key expression; historical `load "k" default 0` is rejected.

```tease
let next = (load "score", default: 0) + 1
```

**Status:** implemented on main. [V30 §25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys), [§1](specifications/accepted-syntaxes-v30.md#1-statement-termination).

### Stored types and media retention

Storable: text, finite numbers, booleans, lists/sets/dicts/objects, ranges, durations, date/time values, script
references, and nested null. Session timer/media handles and speaker references are not storable. Media strings alone do
not persist files; captured-photo references reachable from saved data retain photos in the local Player.

```tease
save script("rooms/hall.tease", label: "start") as "next"
```

**Status:** implemented on main. [V30 §25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys), [§29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths).

## Speakers and presentation

### Speakers, default voice and custom state

`speaker name {fields}` declares a package-global speaker; `speaker name` selects the default, and `say as name`
overrides one message. Fields include firstName/lastName/title/shortTitle/displayName/alias/gender/color/font/avatar and
custom typed state. `speaker` means the effective speaker; automatic player/account defaults remain future.

```tease
speaker guide {
    displayName: "Guide"
    points: 0
}
speaker guide
guide.points += 1
say as guide "Hello."
```

**Status:** implemented on main. [V30 speaker declarations](specifications/accepted-syntaxes-v30.md#speaker-declaration-and-say-as), [ADR 0022 §6](decisions/0022-multi-file-scripts.md), [V30 person fields](specifications/accepted-syntaxes-v30.md#names-titles-and-presentation), [ADR 0021](decisions/0021-static-types.md#decision).

### Bubble/prose modes and style inheritance

Order: `say [as speaker] [bubble|prose] [skippable|unskippable] text [, pacing]`; presentation options may follow in
parentheses. Both modes accept color/background/font; prose adds position/align (left/center/right); bubbles cannot
author placement. Speaker presentation/bubble/prose and color/font supply defaults; overrides/null inheritance stay
captured.

```tease
say prose "A letter."
say as guide prose(background: "ivory", color: "#302820", position: "center", align: "left") "Dear reader.", 0
```

**Status:** implemented on main. [V30 presentation](specifications/accepted-syntaxes-v30.md#message-presentation-defaults-and-overrides).

### Authored colours

Accept CSS names, 3/4/6/8-digit hex, rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch; all opaque. Reject transparent/alpha <1,
var/currentColor/relative colours/explicit linear RGB. Invalid dynamic message colours fall back; invalid dynamic button
backgrounds fail before opening; static invalid colours fail compilation.

```tease
say bubble(color: "#ff0000ff", background: "oklch(.5 .1 30)") "Notice."
```

**Status:** implemented on main. [V30 colours](specifications/accepted-syntaxes-v30.md#authored-colours), [button backgrounds](decisions/0018-first-standard-library-poc-contract.md#authored-button-backgrounds).

## Future player and account APIs

### Future player profile, name lists and gender-derived terms

The accepted built-in `player` profile supplies petNames/degradingNames/lovingNames and gender-derived pronoun,
anatomical and action terms, independently overridable by account/script. Main supports authored speaker fields and list
operations, but supplies no automatic profile/presets.

```tease
let chosenName = player.petNames.random
say "Come here, ${chosenName}."
```

**Status:** accepted but not built as built-in player/profile behavior. [V30 name lists](specifications/accepted-syntaxes-v30.md#name-lists), [V30 §37](specifications/accepted-syntaxes-v30.md#37-dynamic-speaker-terms).

Accepted derived names: `maleFemale`, `manWoman`, `boyGirl`, `heShe`, `himHer`, `hisHer`, `himselfHerself`,
`penisVagina`, `cockPussy`, `penisClitoris`, `cockClit`, `glansClitoris`, `ballsLabia`, `scrotumVulva`,
`foreskinClitoralHood`, `chestBreasts`, `nippleBreast`, `hardWet`, `strokeRub`, `strokingRubbing`, `strokedRubbed`,
`wankRub`, `wankingRubbing`, `wankedRubbed`, `strokerMasturbator`. Their default words remain in the linked spec.

### Future account data, preferences, modes and toys

`account` is a typed read-only server view. Accepted capabilities include frequency/intensity ratings (0–5),
permissive/cheat/hardcore modes, per-setting locks and configured toy schemas. Common toy fields include
toyId/type/name/description/enabled/color/material/referencePhoto/usagePhotos; exact open schemas remain flagged
(open point OP-11).

```tease
let toys = account.toys
```

**Status:** accepted but not built. [V30 account view](specifications/accepted-syntaxes-v30.md#read-only-account-access), [V30 ratings](specifications/accepted-syntaxes-v30.md#preference-ratings).

Accepted detailed toy kinds: `buttPlug`, `dildo`, `chastityDevice`, `ballGag`.
Ratings have `frequency` and `intensity`; published entries have `participantId`, `displayName`, `value`, `publishedAt`.
Character runtime changes do not silently save account changes; account requests are separate.

### Account changes: `askAccountChange(...)`

Blocking approval/rejection/expiry is followed by atomic server validation. Operations:
save/add/remove/removeAll/increase/decrease; list save replaces, add permits schema-allowed duplicates, remove removes
one each, removeAll removes all; numeric/duration/unit changes use newest server state. Scripts cannot delete toys.
Request/results/generated-ID details remain open.

```text
askAccountChange(...)
```

**Status:** accepted but not built. [V30 account changes](specifications/accepted-syntaxes-v30.md#account-changes), [persistence layers](specifications/accepted-syntaxes-v30.md#runtime-script-and-account-persistence).

### Shared data: `publishGlobal`, `getGlobal`

Share typed data across executions of the same script. Entries include participantId/displayName/value/publishedAt;
participantId is opaque/script-scoped, not account identity. Another player's other script is inaccessible.

```tease
publishGlobal(key: "monopoly", value: { score: 1500 })
let previous = getGlobal(key: "monopoly", order: "newest", limit: 1, excludeCurrentPlayer: true)
```

**Status:** accepted but not built. [V30 shared data](specifications/accepted-syntaxes-v30.md#script-global-and-cross-script-data).

### Other-script reads: `loadFromScript`, `getScriptMetadata`

Use immutable script IDs to read another script's saved values for the same player only. Metadata fields:
firstRunAt/lastRunAt/runCount. Ordinary load/save/delete address the current script and already work.

```tease
let previous = loadFromScript(script: "immutable-script-id", key: "chapterState", default: {})
let metadata = getScriptMetadata("immutable-script-id")
```

**Status:** accepted but not built. [V30 cross-script data](specifications/accepted-syntaxes-v30.md#script-global-and-cross-script-data), [current-script storage](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys).

### History: `getPlayerHistory`

Filter then order then limit, optionally by immutable script ID. OrgasmOutcome core fields are type/outcome/occurredAt;
outcomes are orgasm/ruined/denied (actual orgasms include first two). State/history/derived statistics stay separate;
edges group per session, duration history uses startedAt/endedAt/duration, debug events are excluded from normal
statistics.

```tease
let recent = getPlayerHistory(type: "orgasmOutcome", since: getDateTime() - 30 days, order: "newest", limit: 5)
```

**Status:** accepted but not built. [V30 history](specifications/accepted-syntaxes-v30.md#account-backed-toys-state-history-and-statistics).

## Diagnostics and notifications

### Runtime warnings and errors

Compilation reports source-located syntax/type problems; runtime checks cover external or unknown values. say can
inspect a whole value. Null Stage images recover with a warning; replacement-value recovery is an accepted capability
description, with no authored recovery syntax and no implemented general UI.

```tease
showImage null
```

**Status:** implemented on main for diagnostics; general replacement recovery accepted but not built. [V30](specifications/accepted-syntaxes-v30.md#34-runtime-warnings-and-recoverable-values).

### Identifiers and protected names

Identifiers are ASCII, case-sensitive [A-Za-z_][A-Za-z0-9_]*. Keywords, type names and protected built-ins cannot be
redeclared; being protected does not make an API implemented.

```tease
let playerName = "Ada"
```

**Status:** implemented on main. [V30](specifications/accepted-syntaxes-v30.md#38-keywords-and-protected-built-ins).

### Superseded string spelling

Backtick-delimited strings are superseded by the one double-quote family. Current replacements use `"..."` or
`"""..."""`, both with `${...}` interpolation.

```tease
say "Hello ${playerName}"
```

**Status:** superseded for the old backtick form. [V30](specifications/accepted-syntaxes-v30.md#39-rejected-and-reserved-syntax).

### Future popups and system notifications

`showPopup` blocks for one confirmation button; named options are `message`, `buttonText` (default OK). `notify`
requests a system notification; permission handling belongs to the host.

```tease
showPopup(message: "Task completed", buttonText: "Continue")
notify "Task completed"
```

**Status:** accepted but not built. [V30 popup](specifications/accepted-syntaxes-v30.md#popup), [V30 notification](specifications/accepted-syntaxes-v30.md#system-notification).

## Open boundaries and evidence

**Scheduling:** V30 §36 has no accepted final author syntax. Server scheduling and persistent personalities are accepted
capabilities but unbuilt; neither earlier scheduling sketches nor `wait 1 day` are current scheduling syntax.
[Canonical boundary](specifications/accepted-syntaxes-v30.md#36-scheduling); open point OP-12.

**Rejected or reserved:** semicolons, assignment-keyword `set`, `procedure`, `record` as a keyword, `MediaRef`,
`timeOfDay`, `&&`/`||`/`!`, and `call` for ordinary functions are rejected. Standalone `pause`/`resume`/`stop` and
`available when` are reserved, not executable.
[V30 §39](specifications/accepted-syntaxes-v30.md#39-rejected-and-reserved-syntax).

Availability cross-checks: [PHASE-STATUS](../PHASE-STATUS.md#implemented-capability-groups),
[implemented language subset](TEASESCRIPT.md#currently-implemented-language-subset),
[type tests](../tests/type-tests.test.ts), [temporal values](../tests/temporal-values.test.ts),
[sets](../tests/set-members.test.ts), [functions](../tests/functions-runtime.test.ts),
[multi-file transfers](../tests/file-transfers.test.ts), [script references](../tests/script-references.test.ts),
[tags](../tests/script-tags.test.ts), [compact interactions](../tests/compact-interactions.test.ts),
[media](../tests/media-runtime.test.ts), [timers](../tests/async-timer-runtime.test.ts),
[Player media device](../player/media-device.ts).

Open points (OP-01 to OP-16) mark places where the specification is stale, contradicts itself, or leaves details
open. They are listed in the pull request that added this page and are resolved in the specification itself.
