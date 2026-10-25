# TeaseScript syntax reference

TeaseScript is the language of interactive teases. A project is a set of `.tease` files that the Player (the app)
runs for the player (the person), starting at the top of `main.tease`. Statements run one at a time: `say` shows a
chat message and waits for its reading time, an ask waits for the answer, `wait` pauses. Timers, media and buttons can
run a block of code that briefly interrupts the script.

This page summarizes all accepted syntax, one construct per entry, with an example and a link to the full rule. New
to TeaseScript? Read [A first script](#a-first-script), then the topics you need.

**Not authoritative.** The [accepted syntax specification V30](specifications/accepted-syntaxes-v30.md) (links marked
§) and the accepted [decisions (ADRs)](decisions/) define TeaseScript; where this page disagrees with them, they win
and this page needs fixing. **Maintenance:** a pull request that accepts, changes or removes syntax, or builds an
accepted construct, updates the affected entries here in the same pull request.

## How to read an entry

- **Syntax** shows the forms, separated by `·`. Placeholders are lowercase words (`value`, `text`, `list`), single
  letters (`t` text, `b` boolean, `c` colour, `n` integer, `v` value) and capitals (`D` a duration, `T` and `R` types).
- **Takes** is what goes in, **Gives** what comes out or happens, **Fails** what the compiler rejects or, when it
  cannot know the value, what fails at runtime; "warns" means the script goes on. Empty fields are left out.
- **Status:** **Implemented** works today. **Partly built** names the part that does not work yet. **Not built** is
  part of the language but rejected by the compiler today. **Type rule ahead** states a rule for the coming type
  checker, then what the compiler does today.
- Examples are fragments: they assume a speaker `mistress` and the files they name, and a script needs a reachable
  `exit`. A line such as `// rooms/hall.tease` starts another file; a comment such as `// -1` shows a result.

**Terms.** A *handle* controls something that keeps running: a message, an async timer or media, a permanent button.
A *declared* type is written with `: T`; a *literal* is a value written in the source. *Narrowing*: inside
`if x is integer` or `if x != null`, the compiler treats `x` as that type. *Scene time*, the clock of `wait` and timers,
runs while the Player is open, also minimized, and skips the time it is closed. A timer, media or button block
interrupts at a *safe point*:
between steps, or while the script waits for a message, an ask, `wait`, a timer or media.

## Contents

- [A first script](#a-first-script)
- [Basics](#basics): lines, comments, names, `true`, `false`, `null`
- [Variables and types](#variables-and-types): `let`, `const`, scope, types, `null`, `otherwise`, `is`, conversions
- [Control flow](#control-flow): `if`, loops, `switch`, labels
- [Functions and globals](#functions-and-globals)
- [Files, endings and tags](#files-endings-and-tags): `goto` and `call` a file, `end`, `exit`, header, tags
- [Messages and speakers](#messages-and-speakers): `say`, reading time, speakers, the player, gender terms
- [Asking the player](#asking-the-player): asks, `askChoice`, `askForm`, buttons
- [Time](#time): durations, `wait`, timers, dates
- [Numbers and math](#numbers-and-math): operators, ranges, math, angles, randomness
- [Text](#text): strings, `${…}`, text methods, regexes, markup
- [Collections](#collections): objects, copies, lists, sets, dicts, statistics
- [Media and camera](#media-and-camera)
- [Storage and data](#storage-and-data): `save`, `load`, JSON, encryption, stored files
- [Popups and links](#popups-and-links): `showPopup`, `openUrl`, `exportText`, `notify`
- [Debugging](#debugging)
- [Not TeaseScript](#not-teasescript): habits from other languages, and what to write instead

## A first script

A project starts at `main.tease` and must reach `exit`. Try it in the
[playground](../README.md#standalone-development-playground).

```tease
speaker mistress {
    title: "Mistress"
    firstName: "Vera"
}
speaker mistress // the default speaker from here on

let name = askText "What is your name?" // waits for the answer
say "Welcome, ${name}." // waits for its reading time
say "How many rounds?"
let rounds = askChoice 3, 5, 10 // one button each
for round in 1..=rounds {
    say "Round ${round}.", 2 s
    wait 1 s
}
save rounds as "lastRounds" // kept for later sessions (the playground forgets it)
exit
```

## Basics

### Lines, blocks and delimiters

`{ }` holds blocks and objects, `( )` groups and calls, `[ ]` makes lists and indexes. A line ends a statement unless it
is unfinished: after `=`, a comma, an operator or `:`, or inside `()`, `[]` or an object literal. Indentation has no
meaning; a short block may stay on one line.

- **Fails:** a semicolon; two statements on one line.
- **Status:** Implemented · [§1](specifications/accepted-syntaxes-v30.md#1-statement-termination)

```tease
let total = 2 +
    3
if total > 4 { say "Five" }
```

### Comments: `//`, `/* */`

`//` starts a comment that runs to the end of the line; `/* … */` may span lines. Inside a string both are plain text.

- **Status:** Implemented · [§24](specifications/accepted-syntaxes-v30.md#24-comments)

```tease
// A line comment
/* A block
   comment */
```

### Names and keywords

**Syntax:** `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive (`player-score` is a subtraction)

- **Fails:** declaring a keyword, type name or built-in. Keywords: `let const function return if else switch case
  default repeat for in while break continue noInterrupts and or not set true false null speaker say as label goto
  call end exit global tagged save load delete is otherwise`. Words such as `async`, `hidden`, `times`, `at`,
  `finish` and `calendar` are special only in their own construct. A keyword can still name a property or a named
  argument (`options.default`).
- **Status:** Implemented; `const` and `noInterrupts` are not reserved yet ·
  [§38](specifications/accepted-syntaxes-v30.md#38-keywords-and-protected-built-ins)

```tease
let options = { default: 1, repeat: 2 }
say options.default
```

### `true`, `false`, `null`

- **Gives:** `boolean` values; `null` is "no value". There is no truthiness: a condition needs a `boolean`.
- **Status:** Implemented · [§2](specifications/accepted-syntaxes-v30.md#2-literal-values)

```tease
let ready = true
let missing = null
```

## Variables and types

### `let` and assignment

**Syntax:** `let name = value` · `let name: T = value` · `name = value` · `+=` · `-=`

- **Gives:** a variable (see [Copies](#copies)). Without a declared type, the first non-null value decides the type
  (`null`, `[]`, `set[]` leave it open); an `integer` variable later given a fraction becomes a `number`.
- **Fails:** a missing start value; redeclaring a visible name; assigning an undeclared name or another type.
- **Status:** Implemented. Type rule ahead: storing `null` later makes an inferred variable optional; today that needs
  a declared `T?` · [§12](specifications/accepted-syntaxes-v30.md#12-variable-declarations)

```tease
let speed = 1
speed = speed * 1.5
```

### `const` (not built)

**Syntax:** `const name = value` · `global const name = value`

- **Gives:** a binding whose ordinary data cannot change at any depth; a `let` copy can. Speakers and handles in it
  stay references to state that can change.
- **Status:** Not built · [constants](specifications/accepted-syntaxes-v30.md#constants)

### Scope

A variable lives in its block and the blocks inside it. Top-level names belong to their file; globals, global
functions and speakers to the whole project. A file's function sees that file's names, not its caller's variables.

- **Fails:** names out of scope; redeclaring a visible name.
- **Status:** Implemented · [§14](specifications/accepted-syntaxes-v30.md#14-scope)

```tease
let total = 0
repeat 2 {
    let step = 5
    total += step
}
say total // 10; step is not visible here
```

### Types

**Syntax:** `string` `boolean` `integer` `number` `date` `time` `datetime` `absoluteDateTime` `duration`
`calendarDuration` `angle` `regex` `list` `set` `dict` `object` `range` `speaker` `timer` `media` `messageHandle`
`script` · `T[]` `T set` `T dict` `T?` `A | B` `(A | B)[]`

- **Gives:** a checked variable, parameter or result; `T?` means `T | null`. Values the compiler cannot know, such as
  loaded data or JSON, are checked at runtime when stored.
- **Fails:** unknown type names; another type; an operation that not every type in a union supports (test with `is`
  first).
- **Status:** Implemented. Type rule ahead: a union may not combine a list, set or dict with another non-null type
  (`integer[] | string`); today it is accepted · [§13](specifications/accepted-syntaxes-v30.md#13-explicit-types)

```tease
let values: (integer | string)[] = [1, "two"]
let lookup: integer dict = dict{ "a": 1 }
let maybe: integer[]? = null
```

### Null, `T?`, `otherwise`

**Syntax:** `if value != null { }` · `value otherwise fallback`

- **Gives:** inside `if value != null` the value is not `null`. `a otherwise b` gives `a`, or `b` (only evaluated
  then) when `a` is `null`.
- **Fails:** a possibly null value where a value is required; `a otherwise b + c` (write `(a otherwise b) + c`).
  `otherwise` handles `null`, not errors.
- **Status:** Implemented. Type rule ahead: a fallback of another type needs a declared union, as in
  `let x: integer | string = a otherwise "none"`; today the union is inferred ·
  [§18](specifications/accepted-syntaxes-v30.md#18-null-and-optional-values)

```tease
let score: integer? = load("score", default: null)
if score != null { say score + 1 }
say score otherwise 0
```

### Type tests: `is`, `is not`

**Syntax:** `value is T` · `value is not T`

- **Gives:** a `boolean`. After `if x is T` (also `!= null`, `while`, a `switch` type case or an early `return`),
  `x` counts as that type: narrowing.
- **Fails:** a value instead of a type (`is "happy"`; use `==`); a test that is always true or false warns.
- **Status:** Implemented. Type rule ahead: paths such as `box.door` narrow too; today only variables do ·
  [narrowing](specifications/accepted-syntaxes-v30.md#type-tests-and-narrowing)

```tease
let reward: integer | string = load("reward", default: 0)
if reward is integer { say reward + 1 }
```

### Conversions: `toString`, `toNumber`, `toInteger`, `toBoolean`

- **Gives:** a `string`, `number`, `integer` (cut toward zero) or `boolean` (from `"true"` or `"false"`); with
  `default: v`, the default when the conversion fails.
- **Fails:** a conversion known to be invalid, even with a default (`toNumber("hello", default: 0)`); without a
  default, an invalid value at runtime.
- **Status:** Implemented. Type rule ahead: the default may also be `null`, or another type when the result goes into
  a declared union; today it must have the result type ·
  [conversion](specifications/accepted-syntaxes-v30.md#type-conversion)

```tease
let amount = toNumber(askText("How many?"), default: 0)
say toInteger(-2.7) // -2
```

## Control flow

### `if`, `else if`, `else`

- **Takes:** a `boolean` (write `count > 0`, not `count`); braces always; parentheses optional.
- **Status:** Implemented · [§7](specifications/accepted-syntaxes-v30.md#7-conditions-and-blocks)

```tease
let score = load("score", default: 0)
if score > 10 { say "High" } else if score > 5 { say "Medium" } else { say "Low" }
```

### Loops: `repeat`, `for`, `while`, `break`, `continue`

**Syntax:** `repeat n { }` · `for item in source { }` · `for key, value in dict { }` · `while condition { }`

- **Takes:** `repeat` a whole count of 0 or more; `for` a list, set, dict (its keys) or whole-number range; both
  evaluated once.
- **Gives:** `for` visits a snapshot. `break` leaves the innermost loop, `continue` starts its next round.
- **Fails:** a negative count; `break` outside a loop. A loop that provably never ends warns.
- **Status:** Implemented · [§23](specifications/accepted-syntaxes-v30.md#23-loops)

```tease
repeat 3 { say "Again" }
for n in 1..=4 {
    if n == 3 { break }
    say n
}
```

### `switch`

**Syntax:** `switch value { case a, b { } case 1..5 { } case is T { } default { } }`

- **Takes:** literal cases: text, numbers, durations, angles, `true`, `false`, `null`, a speaker, a numeric range;
  or one `is` / `is not` test. `default` is optional and last.
- **Gives:** the first matching case runs; no fall-through. Type cases narrow the value.
- **Fails:** computed case values; duplicate or overlapping literal values and ranges.
- **Status:** Implemented. Type rule ahead: type cases also narrow paths such as `box.answer` ·
  [§32](specifications/accepted-syntaxes-v30.md#32-switch-statements)

```tease
let amount = load("amount", default: 2.5)
switch amount {
    case 1..5 { say "Low" }
    case 5, 6 { say "Five or six" }
    default { say "Other" }
}
```

### Labels: `label`, `goto name`

**Syntax:** `label name` · `goto name` (for files, see [Files](#files-goto-file-call-file))

- **Gives:** a jump within the file, abandoning running functions, loops and blocks.
- **Fails:** unknown, duplicate or nested labels; `goto label` inside a global function.
- **Status:** Implemented · [§26](specifications/accepted-syntaxes-v30.md#26-labels-and-goto)

```tease
let count = 0
label again
count += 1
if count < 3 { goto again }
```

## Functions and globals

### `function`, `return`

**Syntax:** `function name { }` · `function name(a, b: T, c: T = default): R { }` · `return value` · `return`

- **Takes:** parameters, optionally typed; those with defaults last, which may use earlier parameters. No `()`
  without parameters.
- **Gives:** a function visible in its own file; it may wait, ask and call itself. `return` alone, or reaching the
  end, gives `null`.
- **Fails:** `()` without parameters; a result that does not fit `R`; today, a function inside another.
- **Status:** Implemented. Type rule ahead: an untyped parameter takes each call's argument type; today its default
  fixes the type · [§11](specifications/accepted-syntaxes-v30.md#11-function-definitions)

```tease
function add(left: number, right: number = 1): number {
    return left + right
}
say add(2) // 3
```

### Calls

**Syntax:** `name()` · `name(a, b)` · `name(x: a)` · `name(a, y: b)`

- **Takes:** positional arguments, then named ones; name a later parameter to skip a default.
- **Fails:** missing, extra or duplicate arguments; positional after named. `call` is for files, not functions.
- **Status:** Implemented · [§10](specifications/accepted-syntaxes-v30.md#10-function-calls-and-arguments)

```tease
function show(a: integer = 1, b: integer = 2): integer { return a + b }
say show(b: 5) // 6
```

### Globals: `global`, `global function`

**Syntax:** `global function name(…) { }` · `global name = value` · `global name: T = value` ·
`global name = value, default: start`

- **Takes:** for a variable, a start value of literals, earlier globals, simple operators and `load` with a default.
- **Gives:** a function or variable for every file; a global is set before the script starts. With `default: start`,
  `start` is the start value and the line assigns `value`, any expression, each time it runs.
- **Fails:** a name already in use; calls, asks, randomness or local names in a start value; a file's names or
  `goto label` in a global function.
- **Status:** Implemented · [global variables](specifications/accepted-syntaxes-v30.md#global-variables),
  [global functions](specifications/accepted-syntaxes-v30.md#global-functions)

```tease
global level = load("level", default: 1)
global function announce(count) { say "Count: ${count}" }
function record(count: integer) { global attempts = count, default: 0 }
```

## Files, endings and tags

### Files: `goto "file"`, `call "file"`

**Syntax:** `goto "folder/file.tease"` · `call "folder/file.tease"` · `"folder/*.tease"` · `script(path)` ·
`goto (expression)`

- **Takes:** a path from the project root; all files compile together. `*` matches within one folder. `script(path)`
  is a value that can be stored and compared.
- **Gives:** `goto` continues at the top of the file; `call` returns after its `end`; a glob picks one file at random.
- **Fails:** a missing target; `goto` to a file of declarations only; a label after the path; `call` of the running
  file.
- **Status:** Implemented · [§29](specifications/accepted-syntaxes-v30.md#29-script-files-and-paths)

```tease
// main.tease
call "rooms/hall.tease"
let next = script("rooms/end.tease")
goto (next)
// rooms/hall.tease
say "In the hall."
end
```

### Endings: `end`, `exit`

- **Gives:** `end` returns to the calling file; `exit` ends the session from anywhere.
- **Fails:** code that can run past a file's end; no reachable `exit`; `end` without a caller.
- **Status:** Implemented · [§30](specifications/accepted-syntaxes-v30.md#30-script-endings)

```tease
if askBoolean "Stop now?" { exit }
```

### File header: `---`

**Syntax:** `---` lines around `title:`, `author:`, `description:`, `tags:`, `keywords:`

- **Gives:** metadata; nothing runs. Text fields are literal strings without interpolation; tags may carry numbers.
- **Fails:** a header that is not first; unknown or repeated fields.
- **Status:** Implemented · [§41](specifications/accepted-syntaxes-v30.md#file-header)

```tease
---
title: "Strict punishment"
tags: "corner-time", punishment: 4
---
exit
```

### Tags and tagged picks

**Syntax:** `goto tagged q` · `call tagged q, from: "folder/*.tease"` ·
`findScripts(where: q, all: list, none: list, any: list, from: "folder/*.tease")` ·
`findImages(where: q, all: list, none: list, any: list)` · `showImage tagged q` · `takePhoto(tags: ["name: 3"])`; a
query `q` is `"name"` or `"name" >= value`, joined with `and`, `or`, `not`

- **Gives:** a random matching file or image; `findScripts` a `script[]` and `findImages` a `string[]`, maybe empty.
  Image tags come from XMP keywords and tagged photos.
- **Fails:** invalid tag names; a pick that is provably empty, otherwise one that finds nothing at runtime.
- **Status:** Implemented · [tagged selection](specifications/accepted-syntaxes-v30.md#tagged-selection)

```tease
let pool: script[] = findScripts(where: "punishment" > 3)
let photos = findImages(where: "bedroom", none: ["outdoor"])
```

## Messages and speakers

### `say`

**Syntax:** `say value` · `say as speaker value` · `say value, pacing` · full order:
`say as speaker mode(options) skippable value, pacing`

- **Takes:** any value; text gets [markup](#message-markup), collections show in code notation.
- **Gives:** a chat message; the next statement waits for its reading time.
- **Status:** Implemented · [§9](specifications/accepted-syntaxes-v30.md#9-commands)

```tease
say "Kneel."
say as mistress "Good."
say [1, 2]
```

### Reading time: `1.5 s`, `instant`, `skippable`

**Syntax:** `say text, D` · `say text, instant` · `say skippable text` · `say unskippable text`

- **Gives:** without pacing, a time from the player's settings; with `D`, exactly `D`; `instant` or `0 s`, none. The
  next statement, also a `wait` or timer, starts after it. A skippable message can be clicked away; the default is the
  speaker's `defaultSaySkippable`, else skippable.
- **Fails:** a number without a unit; a negative or calendar duration.
- **Status:** Implemented · [ADR 0018](decisions/0018-first-standard-library-poc-contract.md#say)

```tease
say "Read this.", 1.5 s
say unskippable "Every word.", 3 s
say "No pause.", instant
```

### Speakers: `speaker`, `say as`

**Syntax:** `speaker name { field: value }` · `speaker name` · `say as name text` · `speaker.field`

- **Takes:** one field per line (see [Speaker fields](#speaker-fields)); start values as for globals.
- **Gives:** a project-wide speaker. `speaker name` alone sets the default speaker in every file until changed; with
  no speaker, the narrator speaks. Inside a message's text, `speaker` is that message's speaker.
- **Fails:** reading `speaker` in a message without one.
- **Status:** Implemented · [§37](specifications/accepted-syntaxes-v30.md#speaker-declaration-and-say-as)

```tease
speaker mistress {
    title: "Mistress"
    color: "#9b59b6"
}
speaker mistress
say "I am your ${speaker.title}."
```

### Speaker fields

**Syntax:** `firstName` `lastName` `title` `shortTitle` `displayName` `alias` `gender` `color` `font` `avatar`
`presentation` `bubble` `prose` `defaultSaySkippable` · custom fields

- **Gives:** the chat name is `displayName`, else title, first and last name, else the identifier. `title` and
  `shortTitle` stand in for each other. A custom field's first assignment fixes its type.
- **Fails:** reading a custom field that some path to the read has not set, or a built-in field that no path has
  set. A built-in field set on only some paths is checked at runtime.
- **Status:** Partly built: reading an unset `displayName` fails instead of giving the derived name ·
  [names](specifications/accepted-syntaxes-v30.md#names-titles-and-presentation)

```tease
mistress.shortTitle = "Miss"
mistress.punishmentPoints = 0
mistress.punishmentPoints += 1
```

### Presentation: `bubble`, `prose`

**Syntax:** `say bubble(color: c, background: c, font: f) text` · `say prose(position: t, align: t, …) text` ·
speaker fields `presentation`, `bubble`, `prose`

- **Takes:** `position` and `align` (`"left"`, `"center"`, `"right"`) for prose only; `null` inherits.
- **Gives:** each option comes from the message, else the speaker's field, else the Player's default.
- **Status:** Implemented ·
  [presentation](specifications/accepted-syntaxes-v30.md#message-presentation-defaults-and-overrides)

```tease
say prose(align: "center") "A letter."
```

### Authored colours

- **Takes:** CSS colour names, `#rgb`, `#rrggbb` (also `#rgba` and `#rrggbbaa` when fully opaque), `rgb()`, `rgba()`,
  `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`.
- **Fails:** a literal `transparent`, alpha below 1 or `var()`. A computed invalid message colour falls back to the
  inherited one.
- **Status:** Implemented · [colours](specifications/accepted-syntaxes-v30.md#authored-colours)

```tease
say bubble(background: "oklch(.5 .1 30)") "Notice."
```

### Updatable messages

**Syntax:** `let line = say text` · `say(text, pacing)` in expressions · `line.text = text` · `line.text += text` ·
`line.remove()`

- **Gives:** a `messageHandle`; a new `text` changes the message in place without reading time; `remove()` deletes it.
- **Fails:** saving or interpolating a handle.
- **Status:** Implemented · [updatable messages](specifications/accepted-syntaxes-v30.md#updatable-messages)

```tease
let count = 0
let strokes = say "Strokes: 0", instant
repeat 3 {
    wait 1 s
    count += 1
    strokes.text = "Strokes: ${count}"
}
```

### The player: `player`, `playerProfile`

**Syntax:** `say as player text` · `player.field = value` · `playerProfile.field` · `player.copyFrom(playerProfile)`

- **Gives:** `player` is a built-in speaker without person fields; `playerProfile` the player's read-only person
  fields, terms and name lists; `copyFrom` copies them into `player`.
- **Fails:** writing `playerProfile`; reading a field the player left empty, at runtime.
- **Status:** Partly built: `playerProfile.settings`, `.toys`, `.hardcore` and account data are not built ·
  [profile](specifications/accepted-syntaxes-v30.md#reading-the-player-profile)

```tease
player.copyFrom(playerProfile)
say as player "Ready."
```

### Gender terms and name lists

**Syntax:** `gender` · `heShe` `himHer` `hisHer` `himselfHerself` `maleFemale` `manWoman` `boyGirl` · `penisVagina`
`cockPussy` `penisClitoris` `cockClit` `glansClitoris` `ballsLabia` `scrotumVulva` `foreskinClitoralHood`
`chestBreasts` `nippleBreast` `hardWet` · `strokeRub` `strokingRubbing` `wankRub` `wankingRubbing` `strokedRubbed`
`wankedRubbed` `strokerMasturbator` · `petNames` `lovingNames` `degradingNames`

- **Gives:** a term's own value; else, when `gender` is `"male"` or `"female"`, that half of its name (`heShe`:
  `"he"` or `"she"`). Name lists are `string[]`; `"${s.petNames}"` picks one at random.
- **Fails:** a term with no value and no gender default.
- **Status:** Implemented · [gender](specifications/accepted-syntaxes-v30.md#gender-defaults-and-overrides)

```tease
player.gender = "female"
player.heShe = "they"
player.petNames = ["puppy", "toy"]
say "${player.heShe}, my ${player.petNames}"
```

## Asking the player

### Text, number and date asks

**Syntax:** `askText` `askNumber` `askInteger` `askDate` `askTime` `askDateTime` `askPassword`, each as
`ask… as speaker mode(options) "question", prefill: v, hint: t` or with arguments in parentheses

- **Takes:** every part is optional, but a `bubble` or `prose` mode needs a question. The speaker says the question;
  `hint:` helps inside the field; `prefill:` starts it with an answer (not `askPassword`).
- **Gives:** `string` (not blank), `number`, `integer`, `date`, `time`, `datetime`; `askPassword` the answer's
  SHA-256 hash, never the password.
- **Fails:** `default:` (now `prefill:`). An invalid answer keeps the field open.
- **Status:** Implemented · [§20](specifications/accepted-syntaxes-v30.md#text-input)

```tease
let name = askText "Your name?", prefill: "Ada", hint: "First name"
let count = askInteger("How many?", prefill: 3) + 1
let start = askTime as mistress "When?", prefill: toTime("20:00")
```

### `askBoolean`, `askBooleans`

**Syntax:** `askBoolean "question", yesText: t, noText: t, prefill: b` ·
`askBooleans "question", texts: list, prefill: list, cancel: t`

- **Gives:** a `boolean`; `askBooleans` a `boolean[]`, or with `cancel:` a `boolean[]?`.
- **Fails:** lists of different lengths; `hint:` or `timeout:`.
- **Status:** Implemented · [boolean](specifications/accepted-syntaxes-v30.md#boolean-input)

```tease
let ready = askBoolean "Ready?", yesText: "Sure!", noText: "No"
let picked = askBooleans "Which?", texts: ["Crop", "Cane"], prefill: [true, false]
```

### `askChoice`

**Syntax:** `askChoice option, option, …` · `askChoice as speaker …` · last `prefill: value`; an option is a value,
`key: "Text"`, `5: "Five"`, `{ text: t, value: v, background: c }`, or a list or set

- **Takes:** options in one statement. An option without a key returns itself; `name: "Text"` returns `"name"`; a
  choice object returns its `value`, else its `text`. A list or set gives one button per element. It takes no
  question: `say` the question first.
- **Gives:** the chosen value with its type; mixed types need a declared union. `prefill:` marks a button; it never
  answers by itself.
- **Fails:** no buttons; nested lists; `choose` (now `askChoice`).
- **Status:** Partly built: `askChoice(…)` with parentheses is not built ·
  [§19](specifications/accepted-syntaxes-v30.md#19-choices)

```tease
say "How many rounds?"
let rounds = askChoice 5, 10, 15, prefill: 10
let answer = askChoice back: "Back", [{ value: "spank", text: "Spanking" }, { text: "Corner" }]
```

### `askForm`

**Syntax:** `askForm "question", fields: fields, hint: t, submit: t, cancel: t, outro: t, timeout: D,
onTimeout: "submit"`

- **Takes:** an object or dict of start values or descriptors `{ value, text, type, options, optional, min, max, hint,
  background, description }`: a `boolean` becomes a toggle, a list a cycle.
- **Gives:** the answers as a new object (or dict); with `cancel:` or `onTimeout: "cancel"` the result is optional and
  `null` when cancelled.
- **Fails:** invalid fields or options.
- **Status:** Implemented · [forms](specifications/accepted-syntaxes-v30.md#forms)

```tease
let settings = askForm "Settings?", fields: { enabled: false, level: ["Low", "High"] }, cancel: "Back"
```

### `askImage`

**Syntax:** `askImage("question", hint: t, allowCamera: b, allowFile: b, types: list, mime: list, allowSkip: b)`

- **Gives:** a stored image reference; a `string?` when skipping may be allowed.
- **Fails:** no parentheses; both sources off.
- **Status:** Implemented · [image input](specifications/accepted-syntaxes-v30.md#image-input)

```tease
let picture = askImage("Show me your setup", allowSkip: true) otherwise "images/none.png"
```

### `showButton`

**Syntax:** `showButton "Text"` · `showButton as speaker "Text", background: c, timeout: D` ·
`let waited = showButton …`

- **Gives:** waits until the player clicks, types the label or presses Space; as a value, the time waited. A timeout
  ends the wait without a message.
- **Fails:** a timeout without a unit or not above 0.
- **Status:** Partly built: `showButton(…)` with parentheses is not built ·
  [§21](specifications/accepted-syntaxes-v30.md#21-blocking-button)

```tease
let waited = showButton "Continue", timeout: 30 s
```

### Permanent buttons

**Syntax:** `showPermanentButton "Text" { }` · `…, persist: true { }` · `let button = showPermanentButton …` ·
`button.remove()`

- **Gives:** a button that stays; a click interrupts at the next safe point, runs the block, then resumes. Without
  `persist: true`, a `goto` (also to a local label) or `end` removes it; a `call` keeps it. `exit` removes all.
- **Fails:** no block; `removePermanentButton` (now `button.remove()`).
- **Status:** Implemented · [§28](specifications/accepted-syntaxes-v30.md#28-permanent-buttons)

```tease
let count = 0
let button = showPermanentButton "Add" {
    count += 1
}
wait 10 s
button.remove()
```

### Asks that are not built

[`askTyping`](specifications/accepted-syntaxes-v30.md#controlled-typing) (typing under editing limits) · [`askFile`,
`askFiles`, `askFolder`](specifications/accepted-syntaxes-v30.md#file-input) ·
[`askVideo`](specifications/accepted-syntaxes-v30.md#video-input) ·
[`askAudio`](specifications/accepted-syntaxes-v30.md#audio-input) · [`chooseFile()`,
`chooseFolder()`](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references) ·
[`invalidMessage:`, `invalidLlmInstruction:`](specifications/accepted-syntaxes-v30.md#invalid-input-handling) on asks.
**Status:** Not built

## Time

### Durations: `5 s`, `1 h + 30 min`

**Syntax:** a number and `ms` `s` `min` `h` `d` `w` (or `millisecond(s)` `second(s)` `minute(s)` `hour(s)` `day(s)`
`week(s)`)

- **Takes:** a number, name, call or `(expression)`, a space, then the unit. Every time needs a unit: `wait 1 s`.
- **Gives:** an exact `duration` (a day is 24 hours); dividing two gives a `number`.
- **Fails:** `m` (use `min`); `1 h 30 min` (write `1 h + 30 min`); a bare number. V30 requires the space before the
  unit; the compiler does not enforce it yet.
- **Status:** Implemented · [durations](specifications/accepted-syntaxes-v30.md#durations)

```tease
let budget = 1 h + 30 min
let count = 4
let rest = (count / 2) min
say budget / 1 min // 90
```

### `wait`

**Syntax:** `wait D` · `wait (1..3) s`

- **Gives:** a pause without a visible countdown, in scene time; a range draws a whole number of units.
- **Fails:** a negative or calendar duration; a literal `d` or `w` unit warns.
- **Status:** Implemented · [§27](specifications/accepted-syntaxes-v30.md#short-form)

```tease
wait (1..3) s
```

### Timers: `timer`

**Syntax:** `timer D` · `timer async hidden D "label" { }` (`visible`, `mystery`, `hidden`) ·
`timer(duration: D, async: true, display: t, label: t, repeat: true, persist: true) { }` · handle `.pause()`
`.resume()` `.stop()` `.remaining` `.elapsed` `.display` `.label` `.state` `.repeatDuration`

- **Takes:** `async:`, `repeat:` and `persist:` must be the literal `true` or `false`.
- **Gives:** a blocking countdown, or with `async` a handle while the script goes on; the block runs at expiry, each
  round with `repeat`. Without `persist`, a `goto` (also to a local label) or `end` cancels it; a `call` keeps it.
  On the handle, `remaining`, `display` and `repeatDuration` can be set.
- **Fails:** an expiry block, `repeat: true` or `persist: true` without `async: true`.
- **Status:** Implemented · [§27](specifications/accepted-syntaxes-v30.md#named-form),
  [handles](specifications/accepted-syntaxes-v30.md#handles)

```tease
timer 30 s "Hold still"
let beat = timer(duration: (1..=3) s, async: true, display: "mystery", repeat: true)
beat.remaining += 1 s
```

### Timer, media and button blocks

A block runs at a safe point and to its end; then the interrupted work resumes with its remaining time. Blocks never
interrupt each other. A block shares the variables visible where it was created: changes are seen both ways.

- **Fails:** a repeating block that outlasts its period holds the script back (warning).
- **Status:** Implemented · [expiry blocks](specifications/accepted-syntaxes-v30.md#expiry-blocks),
  [shared variables](specifications/accepted-syntaxes-v30.md#variables-in-timer-media-and-button-blocks)

```tease
let done = false
timer async hidden 1 s { done = true }
wait 2 s
say done // true
```

### Time features that are not built

`noInterrupts { }` holds blocks back until its code ends; timer cues (`at`, `beforeEnd`, `finish`) work as for media.
Wall-clock scheduling has no accepted syntax.

**Status:** Not built · [noInterrupts](specifications/accepted-syntaxes-v30.md#nointerrupts-blocks),
[scheduling](specifications/accepted-syntaxes-v30.md#36-scheduling)

### Calendar durations: `1 calendar month`

**Syntax:** a number, `calendar` and `d` `w` `mo` `y` (or `day(s)` `week(s)` `month(s)` `year(s)`) · `.months`
`.days` `.exactOffset`

- **Gives:** a `calendarDuration` for moving dates; a missing day becomes the month's last day.
- **Fails:** `month` without `calendar`; parts of a day or month (`1.5 calendar days`); use as elapsed time (`wait`).
- **Status:** Implemented · [durations](specifications/accepted-syntaxes-v30.md#durations)

```tease
let next = toDate("2026-01-31") + 1 calendar month // 2026-02-28
```

### Dates and times

**Syntax:** `getDate()` `getTime()` `getDateTime()` `getAbsoluteDateTime()` · `toDate(v)` `toTime(v)` `toDateTime(v)`
`toDateTime(date, time)` `toAbsoluteDateTime(v)`, with optional `default:` · `.toAbsoluteDateTime()` `.toDateTime()` ·
`.formatDate()` `.formatTime()` `.formatDateTime()` `.toISO()` `.toSeconds()` `.toMilliseconds()`

- **Takes:** strict ISO text such as `"2026-10-04"`, `"14:30"`, `"2026-10-04T14:30"`, `"2026-10-04T12:30:00Z"`, or a
  matching value (`toDate` of a `datetime`).
- **Gives:** a `date`, `time`, local `datetime`, or `absoluteDateTime` (a moment); getters use the player's clock and
  zone. Values show in the player's local format; `toISO` gives ISO text, `toSeconds` Unix time of a moment.
- **Fails:** other formats; an offset in local text or none in absolute text.
- **Status:** Implemented · [conversion](specifications/accepted-syntaxes-v30.md#construction-and-conversion),
  [display](specifications/accepted-syntaxes-v30.md#display-and-technical-conversion)

```tease
let today = getDate()
let dinner = toDateTime(today, toTime("18:30"))
let deadline = getAbsoluteDateTime() + 2 h
say dinner.formatTime()
```

### Date arithmetic and fields

**Syntax:** `date ± calendarDuration` · `absoluteDateTime ± duration` · `date - date` · comparisons · `.year`
`.month` `.day` `.weekday` `.weekdayNumber` `.weekNumber` `.weekYear` · `.hour` `.minute` `.second` `.millisecond`

- **Gives:** `date - date` a `calendarDuration`; moment minus moment a `duration`. A `date` has the calendar fields, a
  `time` the clock fields, a `datetime` both: integers, except `weekday`, the day's name.
- **Fails:** `datetime + 2 h` (convert to absolute first); `time` arithmetic; ordering different kinds (their `==` is
  false); fields of an `absoluteDateTime` (convert it first).
- **Status:** Implemented · [arithmetic](specifications/accepted-syntaxes-v30.md#arithmetic-and-comparison)

```tease
let tomorrow = getDate() + 1 calendar day
say tomorrow.weekday
```

## Numbers and math

### Numbers: `integer`, `number`

**Syntax:** `5` `05` `-3` (integer) · `2.5` `.5` `5.` `1e6` `2e-4` (number)

- **Gives:** a dot or exponent makes a `number`. An `integer` fits where a `number` is wanted, the only automatic
  conversion. Division always gives a `number`.
- **Fails:** hexadecimal, `NaN`, decimal commas; a `number` where an `integer` is required (round it first).
- **Status:** Implemented · [§3](specifications/accepted-syntaxes-v30.md#3-numeric-types)

```tease
let count: integer = 5
let shares: integer = floor(10 / 4)
```

### Arithmetic and joining: `+ - * / %`, `+=`

- **Takes:** numbers; `+` also joins two texts or two lists. Text, numbers and booleans never convert into each other.
- **Gives:** `%` keeps the dividend's sign; `mod` uses the divisor's sign.
- **Fails:** other operand kinds (`"Score: " + 5`; write `"Score: ${5}"`); a known zero divisor or overflow.
- **Status:** Implemented · [§4](specifications/accepted-syntaxes-v30.md#4-arithmetic-operators)

```tease
let score = 10 * 2
score += 5
say [score / 2, -7 % 3] // [12.5, -1]
let menu = ["Back"] + ["Next"]
```

### Comparison and logic

**Syntax:** `==` `!=` `<` `<=` `>` `>=` · `and` `or` `not`

- **Takes:** booleans for `and`, `or`, `not`; two values of one kind for `<`, `<=`, `>`, `>=`. Collections and objects
  compare by contents.
- **Gives:** a `boolean`; `and`/`or` skip the right side when the left decides. Precedence, strongest first: `()`;
  `.member`, `[i]`, calls; unary `+ -`; `* / %`; `+ -`; ranges; `otherwise`; comparisons, `is`; `not`; `and`; `or`.
- **Fails:** `&&`, `||`, `!`, `??`; chains such as `1 < x < 5`.
- **Status:** Implemented · [§5](specifications/accepted-syntaxes-v30.md#5-logical-and-comparison-operators),
  [precedence](specifications/accepted-syntaxes-v30.md#expression-precedence-and-associativity)

```tease
say not 5 == 3 and (true or false) // true
```

### Ranges: `a..b`, `a..=b`

- **Takes:** numbers; `for`, `randomInteger`, `toList` and waits need whole numbers.
- **Gives:** a `range`; `..=` includes the end. A reversed range is empty. `(range).toList()` gives an `integer[]`.
- **Fails:** chained ranges; fractions where whole numbers are needed.
- **Status:** Implemented · [§6](specifications/accepted-syntaxes-v30.md#6-range-semantics)

```tease
for i in 1..=3 { say i }
let values = (1..=3).toList()
```

### Rounding, `min`, `max`

**Syntax:** `round(x)` `floor(x)` `ceil(x)` · `round(x, decimals: n)` · `min(a, b, …)` `min(list)`
`min(list, by: "property")`, the same for `max`

- **Gives:** `round`, `floor`, `ceil` give an `integer` (`round` takes halves away from zero); with `decimals:` a
  `number`. `min`/`max` take numbers, durations, calendar durations of one family, angles or one date kind, and keep
  `integer` when all are.
- **Fails:** mixed kinds; `null`; an empty list.
- **Status:** Implemented · [rounding](specifications/accepted-syntaxes-v30.md#type-conversion),
  [decimals](specifications/accepted-syntaxes-v30.md#numeric-functions)

```tease
say [round(-2.5), floor(-2.5), ceil(-2.5)] // [-3, -3, -2]
say round(2.675, decimals: 2) // 2.68
say max(1 s, 500 ms)
```

### Math functions

**Syntax:** `abs(x)` `sign(x)` `sqrt(x)` `pow(x, y)` `mod(x, d)` `clamp(x, low, high)` · `pi` · `exp` `ln` `log10`

- **Gives:** `abs`, `mod`, `clamp` keep `integer` for integers; `sign` gives -1, 0 or 1; the rest give a `number`.
- **Fails:** `sqrt` of a negative, `mod` by 0, `ln` of 0 or less, `low > high`, named arguments.
- **Status:** Implemented. Type rule ahead: `pow` always gives a `number`; today `pow` of integers can give an
  `integer` · [§13](specifications/accepted-syntaxes-v30.md#numeric-functions)

```tease
say [abs(-2.5), sqrt(9), mod(-1, 3), clamp(12, 0, 10)]
let area: number = pow(3, 2)
```

### Angles: `90 deg`, `sin`

**Syntax:** `90 deg` `pi rad` (also `degree(s)`, `radian(s)`) · `sin` `cos` `tan` · `asin` `acos` `atan`
`atan2(y, x)` · `toDeg` `toRad`

- **Takes:** `sin`, `cos`, `tan`, `toDeg`, `toRad` take an `angle`; the inverse functions take numbers.
- **Gives:** angles add, scale, compare and show in degrees; the inverse functions give angles, the others numbers.
- **Fails:** `sin(30)` without a unit; `90deg` without a space; angle plus number.
- **Status:** Implemented · [§13](specifications/accepted-syntaxes-v30.md#exponentials-logarithms-and-angles)

```tease
let heading = 90 deg
heading += 0.5 rad
say sin(30 deg) // 0.5
```

### Randomness

**Syntax:** `random()` · `chance(percent)` · `randomInteger(range)` · `randomWeighted(dict)` ·
`randomWeighted(list, weight: "property")` · `randomNormal(mean, spread)` `randomBeta(a, b)`
`randomPert(low, likely, high)`

- **Takes:** a percentage 0–100; a whole-number range; weights of at least 0, one above 0.
- **Gives:** `random` a `number` from 0 up to 1; `chance` a `boolean`; `randomWeighted` a key or an element. All
  draws, also `list.random` and `"${list}"`, come from the session's deterministic random source.
- **Fails:** invalid percentages, ranges or weights; an empty source.
- **Status:** Implemented · [randomness](specifications/accepted-syntaxes-v30.md#randomness),
  [weighted](specifications/accepted-syntaxes-v30.md#weighted-choice),
  [distributions](specifications/accepted-syntaxes-v30.md#random-distributions)

```tease
let die = randomInteger(1..=6)
if chance(25) { say die }
let exercise = randomWeighted(dict{ "squats": 3, "plank": 1 })
```

### Measurement units: `4 cm` (not built)

**Syntax:** a number and a unit of length (`mm cm m km inch ft yard mile`), mass (`g kg oz lb`), volume (`ml l`,
`US cup`, …) or temperature (`Celsius`, `Fahrenheit`) · `value.format(unit: "km", decimals: 1)`

- **Gives:** a measurement in SI units, shown in the player's unit system.
- **Status:** Not built · [§3](specifications/accepted-syntaxes-v30.md#unit-values)

## Text

### Strings: `"…"`, `"""…"""`

- **Takes:** `"…"` for one line, `"""…"""` for several. Backticks are ordinary characters.
- **Gives:** a `string`. A block string removes a line break right after the opening `"""`, the line break and
  indentation before a closing `"""` on its own line, and the indentation its lines share.
- **Fails:** a line break inside `"…"`; an unknown escape.
- **Status:** Implemented · [§8](specifications/accepted-syntaxes-v30.md#physical-newlines-inside-strings)

```tease
say """
    First line.
    Second line.
    """
```

### Interpolation and escapes: `${…}`

**Syntax:** `"Hello ${expression}"` · escapes `\\` `\"` `\n` `\r` `\t` `\${`

- **Takes:** text, numbers, booleans, `null`, durations, angles, dates and times, scripts, regexes, or a list of them.
- **Gives:** text. A list picks **one random element** each time; `list.join()` shows all.
- **Fails:** objects, sets and dicts; an empty list.
- **Status:** Implemented · [§8](specifications/accepted-syntaxes-v30.md#8-strings-and-interpolation)

```tease
let names = ["Ada", "Bo"]
say "Hello ${names}, all: ${names.join()}"
say "Quote: \"hi\"\nNext line"
```

### Text length and search

**Syntax:** `.length` · `.contains(part)` `.startsWith(part)` `.endsWith(part)` · `.indexOf(part)`
`.lastIndexOf(part)` · `.count(part)`

- **Takes:** text; positions count Unicode code points (characters) from 0; search is case-sensitive.
- **Gives:** `indexOf` and `lastIndexOf` give an `integer?`: `null` when not found, never -1.
- **Status:** Implemented · [text operations](specifications/accepted-syntaxes-v30.md#text-operations)

```tease
let text = "banana"
say [text.length, text.count("ana")]
say text.indexOf("x") otherwise -1 // -1
```

### Changing text

**Syntax:** `.substring(start, end)` · `.split(separator)` · `.replace(search, replacement)` · `.trim()`
`.trimStart()` `.trimEnd()` · `.uppercase()` `.lowercase()` `.uppercaseFirst()` · `.reverse()` · `.repeat(n)` ·
`.padStart(length, fill)` `.padEnd(length, fill)`

- **Gives:** a new `string`; text never changes in place. `end` is optional and excluded. `split` gives a `string[]`
  that keeps empty parts; `replace` replaces every occurrence.
- **Fails:** positions out of range; an empty search text or fill.
- **Status:** Implemented · [text operations](specifications/accepted-syntaxes-v30.md#text-operations)

```tease
say " ada ".trim().uppercaseFirst()
say "red,green".split(",")
say "7".padStart(3, "0") // 007
```

### Regexes: `/pattern/flags`

**Syntax:** `/\d+/` · `/a/i` (flags `i`, `m`, `s`) · type `regex` · `toRegex(text, default: v)`

- **Takes:** RE2 patterns: no back references or lookaround; `\d`, `\w`, `\s` are ASCII (use `\p{Nd}`, `\p{L}`).
  `toRegex` takes pattern text and a `default:` for an invalid one.
- **Gives:** a `regex` value that can be saved and shown, not put in JSON.
- **Fails:** an invalid pattern; the `g` or `u` flag.
- **Status:** Implemented. Type rule ahead: a `toRegex` default may have another type when the result goes into a
  declared union; today it must be a regex or `null` · [regexes](specifications/accepted-syntaxes-v30.md#regexes)

```tease
let rule: regex = /\d+/i
let typed = toRegex("\\d+", default: null)
```

### Regex methods

**Syntax:** `.matches(re)` `.contains(re)` · `.find(re)` `.findAll(re)` `.capture(re)` · `.indexOf(re)`
`.lastIndexOf(re)` `.count(re)` · `.split(re)` · `.replace(re, replacement)`

- **Takes:** in a replacement, `$0` is the match, `$1` a group, `$<name>` a named group, `$$` a dollar.
- **Gives:** `matches` tests the whole text; `find` gives the first match or `null`; `findAll` a `string[]`;
  `capture` the match and its groups, or `null`.
- **Fails:** a missing group in a replacement; a search over the work limit (runtime).
- **Status:** Implemented · [regexes](specifications/accepted-syntaxes-v30.md#regexes)

```tease
say "1234".matches(/\d{4}/)
say "moved 3 times".capture(/moved (\d+) times/)
say "2026-10-14".replace(/(\d+)-(\d+)-(\d+)/, "$3.$2.$1")
```

### Message markup

**Syntax** in `say` text: `*italic*` `**bold**` `~~strike~~` `` `code` `` `[u]…[/u]` · `[color=red]…[/color]`
`[bg=gold]…[/bg]` · `[weight=bold]…[/weight]` (thin, light, normal, medium, semibold, bold, black) ·
`[size=large]…[/size]` (small, normal, large, x-large) · `[label](https://…)`, bare `https://…` · at a line start:
`# ` to `### `, `> `, `- `, `1. `

- **Takes:** the text after interpolation; a span stays on one line.
- **Gives:** formatted chat text; markers do not count toward reading time.
- **Fails:** malformed markup stays plain text; a literal invalid colour is a compile error.
- **Status:** Implemented · [message markup](specifications/message-markup.md)

```tease
say "# Rules\n- **Kneel**\n- [color=red]Do not move[/color]"
```

### Literal text in markup: `escapeMarkup`

**Syntax:** `escapeMarkup(text)` · or a backslash before a marker, written `\\` inside a string

- **Gives:** text shown exactly as typed; interpolated text is otherwise read as markup.
- **Status:** Implemented · [markup helper](specifications/message-markup.md#shared-helper-contracts)

```tease
let typed = "**literal**"
say "You wrote ${escapeMarkup(typed)} and \\*this\\*"
```

## Collections

### Objects: `{ name: value }`

**Syntax:** `{ name: value }` · `object.name` · `object.name = value`

- **Gives:** an object; `==` compares names and values in any order.
- **Fails:** duplicate names; indexing; a property the object does not have.
- **Status:** Implemented. Type rule ahead: an object keeps exactly its literal's properties; today new ones can be
  assigned · [§15](specifications/accepted-syntaxes-v30.md#15-objects)

```tease
let door = { name: "front", locked: true }
door.locked = false
```

### Copies

Assigning, passing, returning or storing a list, set, dict or object makes a deep copy; speakers and handles stay
shared references.

- **Fails:** changing a value no variable holds, such as `[1, 2][0] = 3`.
- **Status:** Implemented · [ADR 0014](decisions/0014-core-runtime-value-semantics.md)

```tease
let original = { items: [1, 2] }
let copied = original
copied.items.add(3)
say original.items // [1, 2]
```

### Lists: `[a, b]`

**Syntax:** `[a, b]` · `T[]` · `items[i]` · `items[i] = value` · `.length` `.first` `.last` `.random`

- **Takes:** one element type or a declared union; a zero-based `integer` index.
- **Gives:** an ordered list (at most 1,000,000 elements). Write `items.last`, not `items[items.length - 1]`.
- **Fails:** mixed types without a union; an index past the end; `first` of an empty list.
- **Status:** Implemented · [§16](specifications/accepted-syntaxes-v30.md#16-lists)

```tease
let items = ["key", "map", "rope"]
items[0] = "torch"
say items.last // rope
```

### Changing a list

**Syntax:** `.add(v)` `.addAll(list)` · `.remove(v)` · `.removeAt(i)` `.removeFirst()` `.removeLast()` · `.clear()` ·
`.sort()` `.shuffle()` `.reverse()`

- **Takes:** `sort` needs one kind: numbers, text, durations, calendar durations of one family, angles or one date
  kind.
- **Gives:** changes the list. `remove(v)` removes the first element `==` to `v`; `removeAt`, `removeFirst` and
  `removeLast` return the element, the others `null`.
- **Fails:** a bad index or empty list; `remove` of a missing value only warns.
- **Status:** Implemented · [§16](specifications/accepted-syntaxes-v30.md#16-lists)

```tease
let tasks = ["wash", "feed", "walk"]
tasks.add("rest")
say tasks.removeFirst() // wash
tasks.sort()
```

### Reading a list

**Syntax:** `.contains(v)` · `.indexOf(v)` `.lastIndexOf(v)` · `.count(v)` · `.get(i, default: v)` · `.take(n)`
`.takeLast(n)` · `.join()` `.join(separator)` · `.toSet()` · `.union(c)` `.intersection(c)` `.difference(c)`

- **Gives:** `indexOf` an `integer?`, `null` when absent; `get` the element, or the default for a missing index; `take`
  a new list; `join` one text, `", "` between by default; the set operations a new list (see [Sets](#sets-seta-b)).
- **Fails:** `join` of values that cannot be shown.
- **Status:** Implemented. Type rule ahead: the `get` default no longer decides the type of an empty list, and a
  default of another type needs a declared union; today it does, and the union is inferred ·
  [§16](specifications/accepted-syntaxes-v30.md#16-lists)

```tease
let deck = ["ace", "king", "ace"]
say deck.get(5, default: "none") // none
say deck.count("ace")
say deck.take(2).join(" / ")
```

### Sets: `set[a, b]`

**Syntax:** `set[a, b]` · `T set` · `.length` `.first` `.last` `.random` · `.add(v)` `.remove(v)` `.clear()`
`.contains(v)` `.toList()` · `.union(c)` `.intersection(c)` `.difference(c)`

- **Gives:** a set without duplicates (by `==`) in insertion order; `==` between sets ignores order. `union`,
  `intersection` and `difference` accept a list or set and return the kind they are called on, each element once.
- **Fails:** indexing; list-only methods such as `sort`, `get`, `join` and `+`.
- **Status:** Implemented · [ADR 0013](decisions/0013-set-collection.md)

```tease
let names = set["Ada", "Bo", "Ada"]
names.add("Cy")
say names.union(["Di"]).toList()
```

### Dicts: `dict{ key: value }`

**Syntax:** `dict{ name: v, "any key": v, [expression]: v }` · `T dict` · `d[key]` · `d[key] = v` · `.contains(k)`
`.remove(k)` `.clear()` `.get(k, default: v)` · `.length` `.keys` `.values` · `for key, value in d`

- **Takes:** text keys; one value type or a declared union.
- **Gives:** a table in insertion order. `remove` returns the value; loops visit a snapshot. Equal computed keys
  known only at runtime keep the later value.
- **Fails:** duplicate keys the compiler can see; non-text keys; reading or removing a missing key.
- **Status:** Implemented. Type rule ahead: as for lists, the `get` default no longer decides the value type; today
  it does · [§40](specifications/accepted-syntaxes-v30.md#40-dictionaries)

```tease
let toys = dict{ collar: "leather", "soft cuffs": "wrist" }
toys["collar"] = "steel"
for name, toy in toys { say "${name}: ${toy}" }
say toys.get("gag", default: "none")
```

### Statistics and trends

**Syntax:** `sum(list)` `average(list)` `median(list)` `stddev(list)` · `percentile(list, p)` · each with optional
`by: "property"` · `linearRegression(list)` · `linearRegression(list, x: "property", y: "property")` (or `y:` alone)
· `predict(line, x)`

- **Takes:** numbers or exact durations (`sum` also angles), or objects with `by:`; a percentile from 0 to 100.
  Without `x:`, x is the zero-based index.
- **Gives:** a sum of integers gives an `integer`, other numeric results a `number`; durations stay durations, an
  angle sum is an `angle`. `linearRegression` gives `{ slope, intercept, r2, start }`; `predict` the value at `x`.
- **Fails:** too few values; mixed kinds.
- **Status:** Implemented · [statistics](specifications/accepted-syntaxes-v30.md#statistics),
  [trends](specifications/accepted-syntaxes-v30.md#trends)

```tease
let scores = [12, 15, 11, 18]
say [sum(scores), average(scores), percentile(scores, 25)]
let laps = linearRegression([62 s, 60 s, 59 s])
say predict(laps, 3)
```

## Media and camera

### Stage image: `showImage`, `hideImage`

**Syntax:** `showImage "path"` · `showImage null` · `hideImage` · `showImage tagged …` ([tags](#tags-and-tagged-picks))

- **Gives:** an image until replaced or hidden; `null` clears it with a warning.
- **Status:** Implemented · [stage image](specifications/accepted-syntaxes-v30.md#stage-image)

```tease
showImage "images/room.jpg"
hideImage
```

### `playAudio`, `playVideo`

**Syntax:** `playAudio "file"` · `playAudio async repeat "file"` · `playAudio(file: f, async: true, repeat: 3 times,
startAt: D, endAt: D, volume: v) { }`, the same for `playVideo`

- **Takes:** `async:` must be the literal `true` or `false`; `repeat:` is `true` or `false`, a count (`3 times`) or a
  duration.
- **Gives:** waits for the end; with `async`, gives a [media handle](#media-handles-stopaudio) once the file has
  loaded, while playback continues. A file that fails to load warns and the script goes on.
- **Fails:** invalid ranges or volume (0–1); endless repeat without `async`.
- **Status:** Partly built: video does not play in the Player yet ·
  [audio and video](specifications/accepted-syntaxes-v30.md#audio-and-video)

```tease
playAudio "sounds/bell.mp3"
let music = playAudio(file: "music/track.mp3", async: true, repeat: 3 times, volume: 0.5)
```

### Media handles, `stopAudio`

**Syntax:** `.pause()` `.resume()` `.stop()` · `.position` `.remaining` `.duration` `.elapsed` `.volume` `.state` ·
`stopAudio`

- **Gives:** control of async media; `position`, `remaining` and `volume` can be set; `state` is `"running"`,
  `"paused"`, `"finished"` or `"stopped"`. `stopAudio` stops every sound.
- **Fails:** writing read-only fields; most operations on finished media warn and do nothing.
- **Status:** Implemented · [media handles](specifications/accepted-syntaxes-v30.md#media-handles),
  [stopAudio](specifications/accepted-syntaxes-v30.md#stopping-all-audio)

```tease
let music = playAudio async "music.mp3"
music.position += 5 s
music.volume = 0.5
```

### Media cues: `at`, `beforeEnd`, `finish`

**Syntax:** `play… { at D { } beforeEnd D { } finish { } }` · `play… { statements }`

- **Gives:** cue blocks run at those positions in each play-through; a plain block at the end of each play-through;
  `finish` once after natural completion, never after a stop, a replacement or a failed load. Blocks may use their
  media's handle.
- **Fails:** `finish` with endless repeat.
- **Status:** Implemented · [cues](specifications/accepted-syntaxes-v30.md#cues)

```tease
let music = playAudio async "music.mp3" {
    at 30 s { music.volume = 0.2 }
    finish { say "Finished" }
}
```

### Camera: `showCamera`, `takePhoto`

**Syntax:** `showCamera` · `showCamera stage` · `view.placement = "window"` · `hideCamera` · `takePhoto()` ·
`takePhoto(tags: list)`

- **Gives:** a live camera view; `takePhoto` captures without asking, from the camera the Player opened at the start,
  and gives a stored image reference, or `null` without a camera.
- **Status:** Implemented · [camera view](specifications/accepted-syntaxes-v30.md#camera-view),
  [takePhoto](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references)

```tease
let view = showCamera stage
let photo = takePhoto(tags: ["bedroom"])
hideCamera
```

### Layered scene (not built)

**Syntax:** `showBackgroundImage` `showBackgroundColor` `showOverlayImage` `showOverlayVideo` `moveOverlay`
`animateOverlay` `hideOverlay` `showBlur` `hideBlur` `drawRectangle` `drawEllipse` `drawLine` `drawText`
`removeDrawing` `imageSize`

- **Gives:** backgrounds, moving overlays, blur and drawings; several signatures are still open.
- **Status:** Not built · [future scene](specifications/accepted-syntaxes-v30.md#future-layered-scene)

## Storage and data

### `save`, `delete`

**Syntax:** `save value as key` · `delete key`

- **Takes:** a text key; plain data: text, numbers, booleans, collections, objects, ranges, durations, angles, dates,
  scripts, regexes, file references.
- **Gives:** a copy kept for this player and tease; `save null` or `delete` removes it.
- **Fails:** speakers and handles. A failed write keeps the old data and warns.
- **Status:** Implemented · [§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys)

```tease
save { level: 4 } as "progress"
delete "progress"
```

### `load`

**Syntax:** `load(key, default: v)` · `load key, default: v`

- **Gives:** the stored value, or the default (evaluated only then) when the key is missing. For a literal key, a
  stored value of the wrong type also takes the default. With a computed key the compiler cannot know the type; the
  receiving variable checks the value at runtime, which can fail.
- **Fails:** no default; `default: null` on a literal key without a declared type.
- **Status:** Implemented. Type rule ahead: an object default fixes wrong fields one by one; today the whole default is
  used · [§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys)

```tease
let score = load("score", default: 0)
let nickname: string? = load("nickname", default: null)
```

### JSON and Base64

**Syntax:** `toJson(value)` · `toJson(value, files: false)` · `fromJson(text, default: v)` ·
`fromJson(text, default: v, files: false)` · `toBase64(text)` · `fromBase64(text, default: v)`

- **Gives:** JSON or Base64 text; decoding gives the value, or the default for malformed input. Stored files become
  `data:` URLs unless `files: false`.
- **Fails:** calendar durations, ranges, scripts, regexes and handles in JSON.
- **Status:** Implemented. Type rule ahead: JSON of the wrong shape gives the default, JSON objects decode to objects,
  and a default of another type needs a declared union; today such JSON is returned unchanged, JSON objects decode to
  dicts, and a default of any type is accepted ·
  [JSON](specifications/accepted-syntaxes-v30.md#json-and-base64)

```tease
let text = toJson({ rounds: 3 })
let tasks: string[] = fromJson("[\"stand\"]", default: [])
```

### Hashes and encryption

**Syntax:** `hashText(text)` · `hashFile(file)` · `encryptText(text, password: t, publicKey: k, timeLock: moment)` ·
`encryptFile(…)` · `decryptText(text, password: t, key: k, default: v)` · `decryptFile(…)`

- **Takes:** `password:`, `publicKey:` and `timeLock:` are the ways to open the lock: give all three or none, each
  also `true` (the player sets it) or `false` (not used).
- **Gives:** a SHA-256 as 64 hex digits; locked text or a locked file; decrypting gives the original, or the default
  when it does not open.
- **Fails:** only one or two of the three; a missing default.
- **Status:** Implemented. Type rule ahead: a default of another type needs a declared union; today the union is
  inferred · [hashes](specifications/accepted-syntaxes-v30.md#hashes),
  [encryption](specifications/accepted-syntaxes-v30.md#encryption)

```tease
let locked = encryptText("ready", password: "corner", publicKey: false, timeLock: false)
say decryptText(locked, password: "corner", default: "")
```

### Stored files

**Syntax:** `fileFromBase64(text, default: v)` · `fileToBase64(file)`

- **Gives:** a stored file reference (only images are shown), or the default for bad input; the file as Base64.
- **Status:** Implemented. Type rule ahead: a default of another type needs a declared union; today the union is
  inferred · [stored files](specifications/accepted-syntaxes-v30.md#stored-files)

```tease
let file = fileFromBase64("SGVsbG8=", default: null)
```

### Data across players and teases (not built)

`publishToPlayers` · `loadFromPlayers` · `loadFromTease` · `getTeaseMetadata` (with `sessions`) · `askProfileChange` ·
`getPlayerHistory` · `playerProfile.settings`, `.toys`, `.hardcore`

**Status:** Not built ·
[shared data](specifications/accepted-syntaxes-v30.md#script-global-and-cross-script-data),
[profile changes](specifications/accepted-syntaxes-v30.md#profile-changes)

## Popups and links

### `showPopup`, `openUrl`, `exportText`

**Syntax:** `showPopup message` · `showPopup(message, buttonText: t)` · `openUrl(url, buttonText: t, alwaysButton: b)`
· `exportText(text, title: t, fileName: t)`

- **Gives:** each waits until its action completes. `showPopup` shows a dialog outside the chat and gives the time
  waited; `openUrl` opens the page in a new tab, with a button when the browser needs a click; `exportText` offers the
  text to copy or download.
- **Fails:** a URL that is not `http` or `https`.
- **Status:** Implemented; `notify "message"` (a system notification) is not built ·
  [§31](specifications/accepted-syntaxes-v30.md#31-popups-and-system-notifications),
  [§33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references)

```tease
showPopup "Task completed"
openUrl("https://example.com", buttonText: "Claim your reward")
exportText(toJson({ rounds: 3 }), title: "Your preset", fileName: "preset.txt")
```

## Debugging

### `debugMode`, warnings

`debugMode` is a read-only `boolean`, true in a Debug session. A few problems, such as `showImage null` or a media
file that fails to load, continue with a developer warning; other runtime errors stop at their line.

- **Status:** Partly built: replacing a bad value at runtime and continuing is not built ·
  [debug mode](specifications/accepted-syntaxes-v30.md#debug-mode),
  [§34](specifications/accepted-syntaxes-v30.md#34-runtime-warnings-and-recoverable-values)

```tease
if debugMode { say "Debug session" }
```

## Not TeaseScript

Rejected or reserved forms ([§39](specifications/accepted-syntaxes-v30.md#39-rejected-and-reserved-syntax)), and
mistakes from other languages; most errors name the replacement.

| Do not write | Write |
| --- | --- |
| `;` | nothing: one statement per line |
| `` `text ${x}` `` | `"text ${x}"` |
| `"Score: " + 5` | `"Score: ${5}"` |
| `if count { }` | `if count > 0 { }` |
| `&&`, `\|\|`, `!`, `??` | `and`, `or`, `not`, `otherwise` |
| `1 < x < 5` | `1 < x and x < 5` |
| `set x = 1`, `procedure`, `record` | `x = 1`, `function`, an object literal |
| `function name() { }`, `call name()` | `function name { }`, `name()` |
| `wait 5`, `5 m`, `1 h 30 min`, `sin(30)` | `wait 5 s`, `5 min`, `1 h + 30 min`, `sin(30 deg)` |
| `getDate() + 1 day` | `getDate() + 1 calendar day` |
| `timestamp`, `getTimestamp()` | `absoluteDateTime`, `getAbsoluteDateTime()` |
| `choose`, `removePermanentButton(b)` | `askChoice`, `b.remove()` |
| `default:` on an ask; `load "k"` | `prefill:`; `load("k", default: v)` |
| `fallback`, a label after a file path | ordinary control flow; files start at the top |
| `items[items.length - 1]`; `indexOf(x) == -1` | `items.last`; `indexOf(x) == null` |
| standalone `pause`, `resume`, `stop` | `handle.pause()` and the like |
