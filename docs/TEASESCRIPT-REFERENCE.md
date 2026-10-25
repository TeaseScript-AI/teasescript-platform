# TeaseScript syntax reference

A compact summary of all accepted TeaseScript syntax, one construct at a time: how to write it, what it takes and
gives, how it fails, whether it is built yet, an example, and a link to the full rule. New to TeaseScript? Read
[A first script](#a-first-script), then the topics you need.

**Not authoritative.** The [accepted syntax specification V30](specifications/accepted-syntaxes-v30.md) (links marked
§) and the accepted [decisions](decisions/) define TeaseScript; where this page disagrees with them, they win and this
page needs fixing. **Maintenance:** a pull request that accepts, changes or removes syntax, or builds an accepted
construct, updates the affected entries here in the same pull request.

## How to read an entry

- **Syntax** shows the forms; lowercase words such as `value`, `text`, `list`, `D` (a duration) and `T` (a type) are
  placeholders. **Takes** is what goes in, **Gives** what comes out or happens, **Fails** what the compiler rejects
  or, when it cannot know the value, what fails at runtime. A field with nothing to add is left out.
- **Status:** **Implemented** works on `main`. **Partly built** names the part that does not work yet. **Not built**
  is accepted but rejected by the compiler today. **Type rule ahead** marks a rule V30 already states for the new type
  checker; until the compiler switches to it, the compiler behaves as described.
- Examples are fragments: they assume a speaker `mistress` and the files they name, and a script needs a reachable
  `exit`. A line such as `// rooms/hall.tease` starts another file.

## Contents

[A first script](#a-first-script) · [Basics](#basics) · [Numbers and math](#numbers-and-math) · [Text](#text) ·
[Variables and types](#variables-and-types) · [Collections](#collections) · [Control flow](#control-flow) ·
[Functions and globals](#functions-and-globals) · [Messages and speakers](#messages-and-speakers) ·
[Asking the player](#asking-the-player) · [Media and camera](#media-and-camera) · [Time](#time) ·
[Storage and data](#storage-and-data) · [Popups and links](#popups-and-links) ·
[Files, endings and tags](#files-endings-and-tags) · [Debugging](#debugging) · [Not TeaseScript](#not-teasescript)

## A first script

A project starts at `main.tease` and must reach `exit`.

```tease
speaker mistress {
    title: "Mistress"
    firstName: "Vera"
}
speaker mistress

let name = askText "What is your name?"
say "Welcome, ${name}."
say "How many rounds?"
let rounds = askChoice 3, 5, 10
for round in 1..=rounds {
    say "Round ${round}.", 2 s
    wait 1 s
}
save rounds as "lastRounds"
exit
```

## Basics

### Lines, blocks and delimiters

**Syntax:** one statement per line · `{ }` blocks · `( )` grouping and calls · `[ ]` lists and indexing

- **Takes:** an unfinished expression continues on the next line: after `=`, a comma, an operator or `:`, and inside
  `()`, `[]` or an object literal. Indentation has no meaning.
- **Gives:** statements run in order; a short block may stay on one line.
- **Fails:** a semicolon; two statements on one line.
- **Status:** Implemented · [§1](specifications/accepted-syntaxes-v30.md#1-statement-termination)

```tease
let total = 2 +
    3
if total > 4 { say "Five" }
```

### Comments: `//`, `/* */`

- **Gives:** `//` comments to the end of the line, `/* … */` across lines; inside a string they are text.
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
  `finish`, `calendar` are special only in their own construct; a keyword may label a named argument or property.
- **Status:** Implemented; `const` and `noInterrupts` are not reserved yet ·
  [§38](specifications/accepted-syntaxes-v30.md#grammar-keywords)

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

### Arithmetic: `+ - * / %`, `+=`

- **Takes:** numbers; text, numbers and booleans never convert into each other.
- **Gives:** `%` keeps the dividend's sign (`-7 % 3` is `-1`); `mod` uses the divisor's sign.
- **Fails:** other operand kinds; a known zero divisor or overflow (otherwise at runtime).
- **Status:** Implemented · [§4](specifications/accepted-syntaxes-v30.md#4-arithmetic-operators)

```tease
let score = 10 * 2
score += 5
say [score / 2, -7 % 3]
```

### Joining text and lists: `+`

- **Takes:** two texts or two lists.
- **Gives:** a new text or list; `+=` appends.
- **Fails:** mixed kinds: `"Score: " + 5`; write `"Score: ${5}"`.
- **Status:** Implemented · [§4](specifications/accepted-syntaxes-v30.md#4-arithmetic-operators)

```tease
let menu = ["Back"] + ["Next"]
menu += ["Exit"]
```

### Comparison and logic

**Syntax:** `==` `!=` `<` `<=` `>` `>=` · `and` `or` `not`

- **Takes:** booleans for `and`, `or`, `not`; one comparable kind for `<`. Collections and objects compare by contents.
- **Gives:** a `boolean`; `and`/`or` skip the right side when the left decides. Precedence, strongest first: `()`;
  `.member`, `[i]`, calls; unary `+ -`; `* / %`; `+ -`; ranges; `otherwise`; comparisons, `is`; `not`; `and`; `or`.
- **Fails:** `&&`, `||`, `!`, `??`; chains such as `1 < x < 5`.
- **Status:** Implemented · [§5](specifications/accepted-syntaxes-v30.md#5-logical-and-comparison-operators)

```tease
say not 5 == 3 and (true or false)
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
  `number`. `min`/`max` take numbers, durations, angles or one date kind, and keep `integer` when all are.
- **Fails:** mixed kinds; `null`; an empty list (runtime).
- **Status:** Implemented · [§13](specifications/accepted-syntaxes-v30.md#type-conversion)

```tease
say [round(-2.5), floor(-2.5), ceil(-2.5)]
say round(2.675, decimals: 2)
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

**Syntax:** `90 deg` `pi rad` (also `degree(s)`, `radian(s)`) · `sin` `cos` `tan` · `asin` `acos` `atan` `atan2(y, x)` ·
`toDeg` `toRad`

- **Takes:** `sin`, `cos`, `tan`, `toDeg`, `toRad` take an `angle`; the inverse functions take numbers.
- **Gives:** angles add, scale, compare and show in degrees; the inverse functions give angles, the others numbers.
- **Fails:** `sin(30)` without a unit; `90deg` without a space; angle plus number.
- **Status:** Implemented · [§13](specifications/accepted-syntaxes-v30.md#exponentials-logarithms-and-angles)

```tease
let heading = 90 deg
heading += 0.5 rad
say sin(30 deg)
```

### Randomness

**Syntax:** `random()` · `chance(percent)` · `randomInteger(range)` · `randomWeighted(dict)` ·
`randomWeighted(list, weight: "property")` · `randomNormal(mean, spread)` `randomBeta(a, b)`
`randomPert(low, likely, high)`

- **Takes:** a percentage 0–100; a whole-number range; weights of at least 0, one above 0.
- **Gives:** `random` a `number` in [0, 1); `chance` a `boolean`; `randomWeighted` a key or a copy of an element. All
  draws, also `list.random`, `shuffle()` and `"${list}"`, come from the session's deterministic random source.
- **Fails:** invalid percentages, ranges or weights; an empty source.
- **Status:** Implemented · [randomness](specifications/accepted-syntaxes-v30.md#randomness)

```tease
let die = randomInteger(1..=6)
if chance(25) { say die }
let exercise = randomWeighted(dict{ "squats": 3, "plank": 1 })
```

### Measurement units: `4 cm`

**Syntax:** a number and a unit of length (`mm cm m km inch ft yard mile`), mass (`g kg oz lb`), volume (`ml l`,
`US cup`, …) or temperature (`Celsius`, `Fahrenheit`) · `value.format(unit: "km", decimals: 1)`

- **Gives:** a measurement in SI units, shown in the player's unit system.
- **Status:** Not built · [§3](specifications/accepted-syntaxes-v30.md#unit-values)

## Text

### Strings: `"…"`, `"""…"""`

- **Takes:** `"…"` for one line, `"""…"""` for several. Backticks are ordinary characters.
- **Gives:** a `string`. A block string drops its first and last line breaks and the indentation its lines share.
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
- **Fails:** objects, sets and dicts; an empty list (runtime).
- **Status:** Implemented · [§8](specifications/accepted-syntaxes-v30.md#8-strings-and-interpolation)

```tease
let names = ["Ada", "Bo"]
say "Hello ${names}, all: ${names.join()}"
say "Quote: \"hi\"\nNext line"
```

### Text length and search

**Syntax:** `.length` · `.contains(part)` `.startsWith(part)` `.endsWith(part)` · `.indexOf(part)` `.lastIndexOf(part)`
· `.count(part)`

- **Takes:** text, positionally; positions count code points from 0; case-sensitive.
- **Gives:** `indexOf` and `lastIndexOf` give an `integer?`: `null` when not found, never -1.
- **Status:** Implemented · [text operations](specifications/accepted-syntaxes-v30.md#text-operations)

```tease
let text = "banana"
say [text.length, text.count("ana")]
say text.indexOf("x") otherwise -1
```

### Changing text

**Syntax:** `.substring(start, end)` · `.split(separator)` · `.replace(search, replacement)` · `.trim()` `.trimStart()`
`.trimEnd()` · `.uppercase()` `.lowercase()` `.uppercaseFirst()` · `.reverse()` · `.repeat(n)` ·
`.padStart(length, fill)` `.padEnd(length, fill)`

- **Gives:** a new `string`; text never changes in place. `end` is optional and excluded. `split` gives a `string[]`
  that keeps empty parts; `replace` replaces every occurrence.
- **Fails:** positions out of range; an empty search text or fill.
- **Status:** Implemented · [text operations](specifications/accepted-syntaxes-v30.md#text-operations)

```tease
say " ada ".trim().uppercaseFirst()
say "red,green".split(",")
say "7".padStart(3, "0")
```

### Regexes: `/pattern/flags`

**Syntax:** `/\d+/` · `/a/i` (flags `i`, `m`, `s`) · type `regex` · `toRegex(text, default: value)`

- **Takes:** RE2 patterns: no back references or lookaround; `\d`, `\w`, `\s` are ASCII (use `\p{Nd}`, `\p{L}`).
  `toRegex` takes pattern text and a `default:` for an invalid one.
- **Gives:** a `regex` value that can be saved and shown, not put in JSON.
- **Fails:** an invalid pattern; the `g` or `u` flag.
- **Status:** Implemented. Type rule ahead: a `toRegex` default of another type when the result lands in a written
  union; today it must be a regex or `null` · [regexes](specifications/accepted-syntaxes-v30.md#regexes)

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
`[size=large]…[/size]` (small, normal, large, x-large) · `[label](https://…)`, bare `https://…` · at a line start: `# `
to `### `, `> `, `- `, `1. `

- **Takes:** the text after interpolation; a span stays on one line.
- **Gives:** formatted chat text; markers do not count toward reading time.
- **Fails:** malformed markup stays plain text; a written invalid colour is a compile error.
- **Status:** Implemented · [message markup](specifications/message-markup.md#inline-forms)

```tease
say "# Rules\n- **Kneel**\n- [color=red]Do not move[/color]"
```

### Literal text in markup: `escapeMarkup`

**Syntax:** `escapeMarkup(text)` · a markup backslash, written `\\` in source

- **Gives:** text shown exactly as typed; interpolated text is otherwise read as markup.
- **Status:** Implemented · [markup helper](specifications/message-markup.md#shared-helper-contracts)

```tease
let typed = "**literal**"
say "You wrote ${escapeMarkup(typed)} and \\*this\\*"
```

## Variables and types

### `let` and assignment

**Syntax:** `let name = value` · `let name: T = value` · `name = value` · `+=` · `-=`

- **Gives:** a variable. Collections and objects are copied on assignment; speakers and handles stay references.
  Without a written type, the first non-null value decides it (`null`, `[]`, `set[]` decide nothing); an `integer`
  that also gets a fraction becomes a `number`.
- **Fails:** a missing start value; redeclaring a visible name; assigning an undeclared name or another type.
- **Status:** Implemented. Type rule ahead: storing `null` later makes an inferred variable optional; today that needs
  a declared `T?` · [§12](specifications/accepted-syntaxes-v30.md#12-variable-declarations)

```tease
let speed = 1
speed = speed * 1.5
```

### `const`

**Syntax:** `const name = value` · `global const name = value`

- **Gives:** a value that cannot change at any depth; a `let` copy can.
- **Status:** Not built · [constants](specifications/accepted-syntaxes-v30.md#constants)

### Types

**Syntax:** `string` `boolean` `integer` `number` `date` `time` `datetime` `absoluteDateTime` `duration`
`calendarDuration` `angle` `regex` `list` `set` `dict` `object` `range` `speaker` `timer` `media` `messageHandle`
`script` · `T[]` `T set` `T dict` `T?` `A | B` `(A | B)[]`

- **Gives:** a checked variable, parameter or result. `T?` is `T | null`. Unknown values (loaded, JSON) are checked
  when stored.
- **Fails:** unknown names (`timestamp` is now `absoluteDateTime`); another type; an operation one union member lacks.
- **Status:** Implemented. Type rule ahead: no whole list, set or dict beside another non-null type in a union
  (`integer[] | string`); today it is accepted · [§13](specifications/accepted-syntaxes-v30.md#13-explicit-types)

```tease
let values: (integer | string)[] = [1, "two"]
let lookup: integer dict = dict{ "a": 1 }
let maybe: integer[]? = null
```

### Null, `T?`, `otherwise`

**Syntax:** `if value != null { … }` · `value otherwise fallback`

- **Gives:** inside the check the value is non-null; `otherwise` gives the value, or the fallback (run only then)
  when it is `null`.
- **Fails:** a possibly null value where one is required; `otherwise` beside arithmetic without parentheses:
  `(a otherwise b) + c`. It does not catch errors.
- **Status:** Implemented. Type rule ahead: a fallback of another type needs a written union target; today the union is
  inferred · [§18](specifications/accepted-syntaxes-v30.md#18-null-and-optional-values)

```tease
let score: integer? = load("score", default: null)
if score != null { say score + 1 }
say score otherwise 0
```

### Type tests: `is`, `is not`

- **Gives:** a `boolean`; after `if x is T`, `!= null`, `while`, a `switch` case or an early `return`, `x` is narrowed.
- **Fails:** a value instead of a type (`is "happy"`; use `==`); a test that is always true or false warns.
- **Status:** Implemented. Type rule ahead: paths such as `box.door` narrow too; today only variables do ·
  [narrowing](specifications/accepted-syntaxes-v30.md#type-tests-and-narrowing)

```tease
let reward: integer | string = load("reward", default: 0)
if reward is integer { say reward + 1 }
```

### Conversions: `toString`, `toNumber`, `toInteger`, `toBoolean`

**Syntax:** `toNumber(value)` · `toNumber(value, default: value)`, the same for the others

- **Gives:** a `string`, `number`, `integer` (cut toward zero) or `boolean` (from `"true"`/`"false"`); the default,
  run only then, when conversion fails.
- **Fails:** a conversion known to be invalid, even with a default; without a default, at runtime.
- **Status:** Implemented. Type rule ahead: `default: null`, or a default landing in a written union; today it must
  have the result type · [conversion](specifications/accepted-syntaxes-v30.md#type-conversion)

```tease
let amount = toNumber(askText("How many?"), default: 0)
say toInteger(-2.7)
```

### Scope

- **Gives:** a variable lives in its block and inner blocks. Top-level names belong to their file; globals, global
  functions and speakers to the project. A function sees its file, not its caller. Timer, media and button blocks
  share the variables visible where they are created.
- **Fails:** names out of scope; redeclaring a visible name.
- **Status:** Implemented · [§14](specifications/accepted-syntaxes-v30.md#14-scope)

```tease
let total = 0
if true { total += 1 }
```

## Collections

### Objects: `{ name: value }`

**Syntax:** `{ name: value }` · `object.name` · `object.name = value`

- **Gives:** an object; `==` compares names and values in any order.
- **Fails:** duplicate names; indexing; a property no object there can have.
- **Status:** Implemented. Type rule ahead: an object keeps exactly its literal's properties; today new ones can be
  assigned · [§15](specifications/accepted-syntaxes-v30.md#15-objects)

```tease
let door = { name: "front", locked: true }
door.locked = false
```

### Copies

- **Gives:** assigning, passing, returning or storing a list, set, dict or object makes a deep copy; speakers and
  handles stay shared.
- **Fails:** changing a value no variable holds, such as `[1, 2][0] = 3`.
- **Status:** Implemented · [ADR 0014](decisions/0014-core-runtime-value-semantics.md)

```tease
let original = { items: [1, 2] }
let copied = original
copied.items.add(3)
```

### Lists: `[a, b]`

**Syntax:** `[a, b]` · `T[]` · `items[i]` · `items[i] = value` · `.length` `.first` `.last` `.random`

- **Takes:** one element type or a written union; a zero-based `integer` index.
- **Gives:** an ordered list (at most 1,000,000 elements). Write `items.last`, not `items[items.length - 1]`.
- **Fails:** mixed types without a union; at runtime, an index past the end or `first` of an empty list.
- **Status:** Implemented · [§16](specifications/accepted-syntaxes-v30.md#16-lists)

```tease
let items = ["key", "map", "rope"]
items[0] = "torch"
say items.last
```

### Changing a list

**Syntax:** `.add(v)` `.addAll(list)` · `.remove(v)` · `.removeAt(i)` `.removeFirst()` `.removeLast()` · `.clear()` ·
`.sort()` `.shuffle()` `.reverse()`

- **Takes:** `remove` removes the first element `==` to its argument; `sort` needs one kind: numbers, text, durations,
  angles or one date kind.
- **Gives:** changes the list; `removeAt`, `removeFirst` and `removeLast` return the element, the others `null`.
- **Fails:** a bad index or empty list; `remove` of a missing value only warns.
- **Status:** Implemented · [§16](specifications/accepted-syntaxes-v30.md#16-lists)

```tease
let tasks = ["wash", "feed", "walk"]
tasks.add("rest")
say tasks.removeFirst()
tasks.sort()
```

### Reading a list

**Syntax:** `.contains(v)` · `.indexOf(v)` `.lastIndexOf(v)` · `.count(v)` · `.get(i, default: v)` · `.take(n)`
`.takeLast(n)` · `.join()` `.join(separator)` · `.toSet()`

- **Gives:** `indexOf` an `integer?`, `null` when absent; `get` the element, or the default for a missing index;
  `take` a new list; `join` one text, `", "` between by default.
- **Fails:** `join` of values that cannot be shown.
- **Status:** Implemented. Type rule ahead: `get`'s default no longer decides an empty list's type, and one of
  another type needs a written union · [§16](specifications/accepted-syntaxes-v30.md#reading-an-element-with-a-default)

```tease
let deck = ["ace", "king", "ace"]
say deck.get(5, default: "none")
say deck.count("ace")
say deck.take(2).join(" / ")
```

### Sets: `set[a, b]`

**Syntax:** `set[a, b]` · `T set` · `.length` `.first` `.last` `.random` · `.add(v)` `.remove(v)` `.clear()`
`.contains(v)` `.toList()` · `.union(c)` `.intersection(c)` `.difference(c)`

- **Gives:** a set in insertion order without duplicates (`==`); equality ignores order. The set operations take a
  list or set and give a new collection of the receiver's kind.
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

- **Takes:** text keys; one value type or a written union.
- **Gives:** a table in insertion order. `remove` returns the value; loops visit a snapshot.
- **Fails:** duplicate or non-text keys; at runtime, reading or removing a missing key.
- **Status:** Implemented. Type rule ahead: as for lists, `get`'s default no longer decides the value type ·
  [§40](specifications/accepted-syntaxes-v30.md#40-dictionaries)

```tease
let toys = dict{ collar: "leather", "soft cuffs": "wrist" }
toys["collar"] = "steel"
for name, toy in toys { say "${name}: ${toy}" }
say toys.get("gag", default: "none")
```

### Statistics and trends

**Syntax:** `sum` `average` `median` `stddev` `(list)` · `percentile(list, p)` · each with optional
`by: "property"` · `linearRegression(list)` · `linearRegression(list, x: "p", y: "p")` · `predict(line, x)`

- **Takes:** numbers or exact durations (`sum` also angles), or objects with `by:`; `p` from 0 to 100.
- **Gives:** an `integer` sum of integers, else a `number`; durations stay durations. `linearRegression` gives
  `{ slope, intercept, r2, start }`; `predict` the value at `x`.
- **Fails:** too few values; mixed kinds.
- **Status:** Implemented · [statistics](specifications/accepted-syntaxes-v30.md#statistics)

```tease
let scores = [12, 15, 11, 18]
say [sum(scores), average(scores), percentile(scores, 25)]
let laps = linearRegression([62 s, 60 s, 59 s])
say predict(laps, 3)
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

- **Takes:** written cases: text, numbers, durations, angles, `true`, `false`, `null`, a speaker, a numeric range, or
  one `is` / `is not` test. `default` is optional and last.
- **Gives:** the first matching case runs; no fall-through. Type cases narrow the value.
- **Fails:** computed, duplicate or overlapping cases.
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

- **Gives:** a jump within the file, abandoning running functions, loops and blocks.
- **Fails:** unknown, duplicate or nested labels; a label `goto` in a global function.
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

- **Takes:** parameters, optionally typed; defaults last, using earlier parameters. No `()` without parameters.
- **Gives:** a function of its file that may wait, ask and recurse. `return` alone, or the end, gives `null`.
- **Fails:** `()` without parameters; a result that does not fit `R`; today, a function inside another.
- **Status:** Implemented. Type rule ahead: an untyped parameter takes each call's argument type; today its default
  fixes it · [§11](specifications/accepted-syntaxes-v30.md#11-function-definitions)

```tease
function add(left: number, right: number = 1): number {
    return left + right
}
say add(2)
```

### Calls

**Syntax:** `name()` · `name(a, b)` · `name(x: a)` · `name(a, y: b)`

- **Takes:** positional arguments, then named ones; name a later parameter to skip a default.
- **Fails:** missing, extra or duplicate arguments; positional after named. `call` is for files, not functions.
- **Status:** Implemented · [§10](specifications/accepted-syntaxes-v30.md#10-function-calls-and-arguments)

```tease
function show(a: integer = 1, b: integer = 2): integer { return a + b }
say show(b: 5)
```

### `global function`

- **Gives:** a function for every file; it may use globals, speakers and built-ins, not a file's names.
- **Fails:** a file's names; `goto` to a label.
- **Status:** Implemented · [global functions](specifications/accepted-syntaxes-v30.md#global-functions)

```tease
global function announce(count) { say "Count: ${count}" }
```

### `global` values

**Syntax:** `global name = value` · `global name: T = value` · `global name = value, default: start`

- **Takes:** a start value of literals, earlier globals, simple operators and `load` with a default. With `default:`,
  the value may be anything and the default starts it.
- **Gives:** a project-wide variable, set before the script starts; with `default:`, the line assigns each time it runs.
- **Fails:** a used name; calls, asks, randomness or locals in a start value.
- **Status:** Implemented · [global variables](specifications/accepted-syntaxes-v30.md#global-variables)

```tease
global level = load("level", default: 1)
function record(count: integer) { global attempts = count, default: 0 }
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

- **Gives:** no pacing: a time from the player's settings; `D`: exactly that; `instant` or `0 s`: none. Every later
  statement waits, `wait` and timers too. Skippable messages can be clicked away; the default is the speaker's
  `defaultSaySkippable`, else skippable.
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
  no speaker, the narrator speaks. In a message, `speaker` is its speaker.
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
  `shortTitle` stand in for each other. A custom field's first assignment fixes its type. A speaker is a reference.
- **Fails:** reading a field no path gave the speaker.
- **Status:** Partly built: reading an unset `displayName` fails instead of giving the derived name ·
  [names](specifications/accepted-syntaxes-v30.md#names-titles-and-presentation)

```tease
mistress.shortTitle = "Miss"
mistress.punishmentPoints = 0
mistress.punishmentPoints += 1
```

### Presentation: `bubble`, `prose`

**Syntax:** `say bubble(color: c, background: c, font: f) text` · `say prose(position: p, align: a, …) text` ·
speaker fields `presentation`, `bubble`, `prose`

- **Takes:** `align` and `position` (`"left"`, `"center"`, `"right"`) for prose only; `null` inherits.
- **Gives:** the message's options, then the speaker's, then the Player's.
- **Status:** Implemented ·
  [presentation](specifications/accepted-syntaxes-v30.md#message-presentation-defaults-and-overrides)

```tease
say prose(align: "center") "A letter."
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

### Authored colours

- **Takes:** CSS colour names, `#rgb`, `#rrggbb`, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`.
- **Fails:** `transparent`, alpha below 1, `var()`: an error when written; a computed bad colour falls back.
- **Status:** Implemented · [colours](specifications/accepted-syntaxes-v30.md#authored-colours)

```tease
say bubble(background: "oklch(.5 .1 30)") "Notice."
```

### The player: `player`, `playerProfile`

**Syntax:** `say as player text` · `player.field = value` · `playerProfile.field` · `player.copyFrom(playerProfile)`

- **Gives:** `player` is a built-in speaker without person fields; `playerProfile` the player's read-only person
  fields, terms and name lists; `copyFrom` copies them into `player`.
- **Fails:** writing `playerProfile`; reading a field the player left empty (runtime).
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

- **Gives:** a term's own value, else for `"male"` or `"female"` the matching half of its name. Name lists are
  `string[]`; `"${s.petNames}"` picks one at random.
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
`ask… as speaker mode(options) "question", prefill: value, hint: text` or with arguments in parentheses

- **Takes:** all optional. The speaker says the question; `hint:` helps in the field; `prefill:` starts it with an
  answer (not `askPassword`); `bubble`/`prose` style the question.
- **Gives:** `string` (not blank), `number`, `integer`, `date`, `time`, `datetime`; `askPassword` a SHA-256.
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

**Syntax:** `askChoice a, b` · `askChoice as speaker …` · `key: "Text"` · `5: "Five"` · a list or set ·
`{ text: t, value: v, background: c }` · last `prefill: value`

- **Takes:** options in one statement. Unkeyed options return themselves; `name: "Text"` returns `"name"`. A list or
  set gives one button per element. No question: `say` it first.
- **Gives:** the chosen value with its type; mixed types need a written union. `prefill:` marks a button; it never
  answers by itself.
- **Fails:** no buttons; nested lists; `choose`; parentheses (not built).
- **Status:** Implemented · [§19](specifications/accepted-syntaxes-v30.md#19-choices)

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
- **Gives:** a fresh object (or dict) of answers; with `cancel:` or `onTimeout: "cancel"` optional, `null` if cancelled.
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

- **Gives:** waits for a click, the typed label or Space; as a value, the time waited. A timeout ends it silently.
- **Fails:** a timeout without a unit or not above 0.
- **Status:** Partly built: `showButton(…)` with parentheses is not built ·
  [§21](specifications/accepted-syntaxes-v30.md#21-blocking-button)

```tease
let waited = showButton "Continue", timeout: 30 s
```

### Permanent buttons

**Syntax:** `showPermanentButton "Text" { }` · `…, persist: true { }` · `let button = showPermanentButton …` ·
`button.remove()`

- **Gives:** a button while the script runs; a click interrupts at the next safe point, runs the block, then resumes.
  `persist: true` keeps it across files.
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

| Syntax | Gives |
| --- | --- |
| `askTyping(question, prefill:, allowPaste:, …, scope:)` | text typed under editing limits |
| `askFile`, `askFiles`, `askFolder`, `askVideo`, `askAudio` | file, folder or media references |
| `chooseFile()`, `chooseFolder()` | a reference, or `null` |
| `invalidMessage:`, `invalidLlmInstruction:` | own feedback for an invalid answer |

**Status:** Not built · [§20](specifications/accepted-syntaxes-v30.md#file-input)

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

**Syntax:** `playAudio "file"` · `playAudio async repeat "file"` · `playAudio(file: f, async: b, repeat: 3 times,
startAt: D, endAt: D, volume: v) { }`, the same for `playVideo`

- **Gives:** waits for the end, or with `async` gives a [media handle](#media-handles) at once. A file that fails to
  load warns and the script goes on.
- **Fails:** invalid ranges or volume (0–1); endless repeat without `async`.
- **Status:** Partly built: video does not play in the Player yet ·
  [audio and video](specifications/accepted-syntaxes-v30.md#audio-and-video)

```tease
playAudio "sounds/bell.mp3"
let music = playAudio(file: "music/track.mp3", async: true, repeat: 3 times, volume: 0.5)
```

### Media handles

**Syntax:** `.pause()` `.resume()` `.stop()` · `.position` `.remaining` `.duration` `.elapsed` `.volume` `.state`

-  **Gives:** control of async media; `position`, `remaining` and `volume` can be set; `state` is `"running"`,
  `"paused"`, `"finished"` or `"stopped"`.
- **Fails:** writing read-only fields; most operations on finished media warn and do nothing.
- **Status:** Implemented · [media handles](specifications/accepted-syntaxes-v30.md#media-handles)

```tease
let music = playAudio async "music.mp3"
music.position += 5 s
music.volume = 0.5
```

### Media cues: `at`, `beforeEnd`, `finish`

**Syntax:** `play… { at D { } beforeEnd D { } finish { } }` · `play… { statements }`

- **Gives:** cue blocks run at those positions in each pass, `finish` once at the end, a plain block at each pass's
  end. They share surrounding variables and may use the play's own handle.
- **Status:** Implemented · [cues](specifications/accepted-syntaxes-v30.md#cues)

```tease
let music = playAudio async "music.mp3" {
    at 30 s { music.volume = 0.2 }
    finish { say "Finished" }
}
```

### `stopAudio`

- **Gives:** stops every sound; video, images and timers go on.
- **Status:** Implemented · [stopping audio](specifications/accepted-syntaxes-v30.md#stopping-all-audio)

```tease
stopAudio
```

### Camera: `showCamera`, `takePhoto`

**Syntax:** `showCamera` · `showCamera stage` · `view.placement = "window"` · `hideCamera` · `takePhoto()` ·
`takePhoto(tags: list)`

- **Gives:** a live camera view; `takePhoto` silently gives a stored image reference, or `null` without a camera.
- **Status:** Implemented · [camera view](specifications/accepted-syntaxes-v30.md#camera-view)

```tease
let view = showCamera stage
let photo = takePhoto(tags: ["bedroom"])
hideCamera
```

### Layered scene

**Syntax:** `showBackgroundImage` `showBackgroundColor` `showOverlayImage` `showOverlayVideo` `moveOverlay`
`animateOverlay` `hideOverlay` `showBlur` `hideBlur` `drawRectangle` `drawEllipse` `drawLine` `drawText`
`removeDrawing` `imageSize`

- **Gives:** backgrounds, moving overlays, blur and drawings; several signatures are still open.
- **Status:** Not built · [future scene](specifications/accepted-syntaxes-v30.md#future-layered-scene)

## Time

### Durations: `5 s`, `1 h + 30 min`

**Syntax:** a number and `ms` `s` `min` `h` `d` `w` (or `millisecond(s)` `second(s)` `minute(s)` `hour(s)` `day(s)`
`week(s)`)

- **Takes:** a number, name, call or `(expression)` before the unit. Every time needs a unit: `wait 1 s`.
- **Gives:** an exact `duration` (a day is 24 hours); dividing two gives a `number`.
- **Fails:** `m` (use `min`); `90s` (needs a space); `1 h 30 min` (write `1 h + 30 min`); a bare number.
- **Status:** Implemented · [durations](specifications/accepted-syntaxes-v30.md#durations)

```tease
let budget = 1 h + 30 min
let count = 4
let rest = (count / 2) min
say budget / 1 min
```

### Calendar durations: `1 calendar month`

**Syntax:** a number, `calendar` and `d` `w` `mo` `y` (or `day(s)` `week(s)` `month(s)` `year(s)`) · `.months`
`.days` `.exactOffset`

- **Gives:** a `calendarDuration` for moving dates; a missing day becomes the month's last day.
- **Fails:** `month` without `calendar`; parts of a day or month (`1.5 calendar days`); use as elapsed time (`wait`).
- **Status:** Implemented · [durations](specifications/accepted-syntaxes-v30.md#durations)

```tease
let next = toDate("2026-01-31") + 1 calendar month
```

### Dates and times

**Syntax:** `getDate()` `getTime()` `getDateTime()` `getAbsoluteDateTime()` · `toDate(text)` `toTime(text)`
`toDateTime(text)` `toDateTime(date, time)` `toAbsoluteDateTime(text)`, with optional `default:` ·
`.toAbsoluteDateTime()` `.toDateTime()`

- **Takes:** strict ISO text: `"2026-10-04"`, `"14:30"`, `"2026-10-04T14:30"`, `"2026-10-04T12:30:00Z"`.
- **Gives:** a `date`, `time`, local `datetime`, or `absoluteDateTime` (a moment); getters use the player's clock and
  zone.
- **Fails:** other formats; an offset in local text or none in absolute text.
- **Status:** Implemented · [conversion](specifications/accepted-syntaxes-v30.md#construction-and-conversion)

```tease
let today = getDate()
let dinner = toDateTime(today, toTime("18:30"))
let deadline = getAbsoluteDateTime() + 2 h
```

### Date arithmetic and fields

**Syntax:** `date ± calendarDuration` · `absoluteDateTime ± duration` · `date - date` · comparisons · `.year`
`.month` `.day` `.weekday` `.weekdayNumber` `.weekNumber` `.weekYear` `.hour` `.minute` `.second` `.millisecond`

- **Gives:** `date - date` a `calendarDuration`; moment minus moment a `duration`; integer fields, but `weekday` is a
  name; Monday is 1.
- **Fails:** `datetime + 2 h` (convert to absolute first); `time` arithmetic; comparing kinds.
- **Status:** Implemented · [arithmetic](specifications/accepted-syntaxes-v30.md#arithmetic-and-comparison)

```tease
let tomorrow = getDate() + 1 calendar day
say tomorrow.weekday
```

### Showing dates and times

**Syntax:** `"${value}"` · `.formatDate()` `.formatTime()` `.formatDateTime()` · `.toISO()` · `.toSeconds()`
`.toMilliseconds()`

- **Gives:** text in the player's local format; ISO text; Unix seconds or milliseconds of a moment.
- **Status:** Implemented · [display](specifications/accepted-syntaxes-v30.md#display-and-technical-conversion)

```tease
let dinner = toDateTime("2026-10-04T18:30")
say dinner.formatTime()
```

### `wait`

**Syntax:** `wait D` · `wait (1..3) s`

- **Gives:** a hidden pause in scene time (time while the Player is closed does not count); a range draws whole units.
- **Fails:** a negative or calendar duration; a written day or week warns.
- **Status:** Implemented · [§27](specifications/accepted-syntaxes-v30.md#short-form)

```tease
wait (1..3) s
```

### Timers: `timer`

**Syntax:** `timer D` · `timer async hidden D "label" { }` (`visible`, `mystery`, `hidden`) ·
`timer(duration: D, async: b, display: d, label: t, repeat: b, persist: b) { }`

- **Gives:** a blocking countdown, or with `async` a handle while the script goes on; the block runs at expiry, each
  round with `repeat`. Without `persist` it ends when its file is left.
- **Fails:** a block or `repeat` without `async`.
- **Status:** Implemented · [§27](specifications/accepted-syntaxes-v30.md#named-form)

```tease
timer 30 s "Hold still"
let beat = timer(duration: (1..=3) s, async: true, display: "mystery", repeat: true)
```

### Timer handles

**Syntax:** `.pause()` `.resume()` `.stop()` · `.remaining` `.elapsed` `.display` `.label` `.state` `.repeatDuration`

- **Gives:** control of an async timer; `remaining`, `display` and `repeatDuration` can be set.
- **Status:** Implemented · [handles](specifications/accepted-syntaxes-v30.md#handles)

```tease
let t = timer async 60 s
t.remaining += 30 s
t.pause()
```

### Timer, media and button blocks

- **Gives:** a block interrupts at a safe point and runs to its end, then the interrupted work resumes with its
  remaining time. Blocks never interrupt each other; they share the variables visible where they were created.
- **Fails:** a repeating block that outlasts its period holds the script back (warning).
- **Status:** Implemented · [expiry blocks](specifications/accepted-syntaxes-v30.md#expiry-blocks)

```tease
let done = false
timer async hidden 1 s { done = true }
wait 2 s
say done
```

### Time features that are not built

`noInterrupts { }` holds blocks back until its code ends; timer cues (`at`, `beforeEnd`, `finish`) work as for media.
Wall-clock scheduling has no accepted syntax.

**Status:** Not built · [noInterrupts](specifications/accepted-syntaxes-v30.md#nointerrupts-blocks),
[scheduling](specifications/accepted-syntaxes-v30.md#36-scheduling)

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

**Syntax:** `load(key, default: value)` · `load key, default: value`

- **Gives:** the stored value, or the default (run only then) when the key is missing or holds another type.
- **Fails:** no default; `default: null` without a declared type.
- **Status:** Implemented. Type rule ahead: an object default fixes wrong fields one by one; today the whole default is
  used · [§25](specifications/accepted-syntaxes-v30.md#25-persistent-storage-and-keys)

```tease
let score = load("score", default: 0)
let nickname: string? = load("nickname", default: null)
```

### JSON and Base64

**Syntax:** `toJson(value)` · `toJson(value, files: false)` · `fromJson(text, default: value)` · `toBase64(text)` ·
`fromBase64(text, default: value)`

- **Gives:** JSON or Base64 text; decoding gives the value, or the default for bad input. Stored files become `data:`
  URLs unless `files: false`.
- **Fails:** calendar durations, ranges, scripts, regexes and handles in JSON.
- **Status:** Implemented. Type rule ahead: with a written target type, `fromJson` gives objects (today dicts), and a
  default of another type needs a written union · [JSON](specifications/accepted-syntaxes-v30.md#json-and-base64)

```tease
let text = toJson({ rounds: 3 })
let tasks: string[] = fromJson("[\"stand\"]", default: [])
```

### Hashes and locks

**Syntax:** `hashText(text)` · `hashFile(file)` · `encryptText(text, password: p, publicKey: k, timeLock: t)` ·
`encryptFile(…)` · `decryptText(text, password: p, default: v)` · `decryptFile(…)`

- **Takes:** encryption takes none or all three openers, each also `true` (the player chooses) or `false` (none).
- **Gives:** a SHA-256 as 64 hex digits; locked text or a locked file; decrypting gives the original, or the default
  when it does not open.
- **Fails:** only some openers; a missing default.
- **Status:** Implemented. Type rule ahead: a default of another type needs a written union ·
  [encryption](specifications/accepted-syntaxes-v30.md#encryption)

```tease
let locked = encryptText("ready", password: "corner", publicKey: false, timeLock: false)
say decryptText(locked, password: "corner", default: "")
```

### Stored files

**Syntax:** `fileFromBase64(text, default: value)` · `fileToBase64(file)`

- **Gives:** a stored file reference (only images are shown), or the default for bad input; the file as Base64.
- **Status:** Implemented. Type rule ahead: a default of another type needs a written union ·
  [stored files](specifications/accepted-syntaxes-v30.md#stored-files)

```tease
let file = fileFromBase64("SGVsbG8=", default: null)
```

### Data across players and teases

`publishToPlayers(key:, value:)` · `loadFromPlayers(key:, order:, limit:, excludeCurrentPlayer:)` ·
`loadFromTease(tease:, key:, default:)` · `getTeaseMetadata(teaseId)` with `sessions` · `askProfileChange(…)` ·
`getPlayerHistory(type:, order:, limit:)` · `playerProfile.settings`, `.toys`, `.hardcore`

**Status:** Not built ·
[shared data](specifications/accepted-syntaxes-v30.md#script-global-and-cross-script-data),
[profile changes](specifications/accepted-syntaxes-v30.md#profile-changes)

## Popups and links

### `showPopup`

**Syntax:** `showPopup message` · `showPopup(message, buttonText: text)`

- **Gives:** waits until a dialog outside the chat is closed; gives the time waited.
- **Status:** Implemented · [popup](specifications/accepted-syntaxes-v30.md#popup)

```tease
showPopup "Task completed"
```

### `openUrl`

**Syntax:** `openUrl(url)` · `openUrl(url, buttonText: t, alwaysButton: b)`

- **Gives:** waits until the page is open in a new tab; shows a button when the browser needs a click.
- **Fails:** a URL that is not `http` or `https`.
- **Status:** Implemented ·
  [§33](specifications/accepted-syntaxes-v30.md#33-browser-api-file-folder-camera-and-url-references)

```tease
openUrl("https://example.com", buttonText: "Claim your reward")
```

### `exportText`

**Syntax:** `exportText(text, title: t, fileName: n)`

- **Gives:** a dialog to copy or download the text; waits until closed.
- **Status:** Implemented · [export text](specifications/accepted-syntaxes-v30.md#export-text)

```tease
exportText(toJson({ rounds: 3 }), title: "Your preset", fileName: "preset.txt")
```

### `notify`

`notify "message"` shows a system notification. **Status:** Not built ·
[notification](specifications/accepted-syntaxes-v30.md#system-notification)

## Files, endings and tags

### Files: `goto "file"`, `call "file"`

**Syntax:** `goto "folder/file.tease"` · `call "folder/file.tease"` · `"folder/*.tease"` · `script(path)` ·
`goto (expression)`

- **Takes:** a path from the project root; all files compile together. `*` matches within one folder. `script(path)`
  is a value that can be stored and compared.
- **Gives:** `goto` continues at the top of the file; `call` returns after its `end`; a glob picks one file at random.
- **Fails:** a missing or declaration-only target; a label after the path; `call` of the running file.
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

- **Gives:** metadata; nothing runs. Only plain strings, no interpolation.
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

**Syntax:** `goto tagged q` · `call tagged q, from: "folder/*.tease"` · `findScripts(where: q)` ·
`findImages(where: q, all: list, none: list, any: list)` · `showImage tagged q` · `takePhoto(tags: ["name: 3"])`;
a query `q` is `"name"` or `"name" >= value`, joined with `and`, `or`, `not`

- **Gives:** a random matching file or image; `findScripts` a `script[]` and `findImages` a `string[]`, maybe empty.
  Image tags come from XMP keywords and tagged photos.
- **Fails:** invalid tag names; a pick provably empty at compile time, otherwise at runtime.
- **Status:** Implemented · [tagged selection](specifications/accepted-syntaxes-v30.md#tagged-selection)

```tease
let pool: script[] = findScripts(where: "punishment" > 3)
let photos = findImages(where: "bedroom", none: ["outdoor"])
```

## Debugging

### `debugMode`, warnings

- **Gives:** `debugMode` is a read-only `boolean`, true in a Debug session. A few problems, such as `showImage null`
  or a media file that fails to load, continue with a developer warning; other runtime errors stop at their line.
- **Status:** Partly built: replacing a bad value at runtime and continuing is not built ·
  [§34](specifications/accepted-syntaxes-v30.md#34-runtime-warnings-and-recoverable-values)

```tease
if debugMode { say "Debug session" }
```

## Not TeaseScript

Rejected or reserved forms ([§39](specifications/accepted-syntaxes-v30.md#39-rejected-and-reserved-syntax)); most
errors name the replacement.

| Do not write | Write |
| --- | --- |
| `;` | nothing: one statement per line |
| `` `text ${x}` `` | `"text ${x}"` |
| `&&`, `\|\|`, `!`, `??` | `and`, `or`, `not`, `otherwise` |
| `set x = 1`, `procedure`, `record` | `x = 1`, `function`, an object literal |
| `call doSomething()` | `doSomething()` |
| `wait 5`, `5 m` | `wait 5 s`, `5 min` |
| `getDate() + 1 day` | `getDate() + 1 calendar day` |
| `timestamp`, `getTimestamp()` | `absoluteDateTime`, `getAbsoluteDateTime()` |
| `choose`, `removePermanentButton(b)` | `askChoice`, `b.remove()` |
| `default:` on an ask; `load "k"` | `prefill:`; `load("k", default: v)` |
| `fallback`, a label after a file path | ordinary control flow; files start at the top |
| `items[items.length - 1]`; `indexOf(x) == -1` | `items.last`; `indexOf(x) == null` |
| standalone `pause`, `resume`, `stop` | `handle.pause()` and the like |
