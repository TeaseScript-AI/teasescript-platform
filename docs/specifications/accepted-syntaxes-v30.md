# Script Language Syntax Decisions

## Table of contents
This table is generated from the current section order.

- [Status legend](#status-legend)
- [Delimiter roles](#delimiter-roles)
- [1. Statement termination](#1-statement-termination)
- [2. Literal values](#2-literal-values)
- [3. Numeric types](#3-numeric-types)
- [4. Arithmetic operators](#4-arithmetic-operators)
- [5. Logical and comparison operators](#5-logical-and-comparison-operators)
- [6. Range semantics](#6-range-semantics)
- [7. Conditions and blocks](#7-conditions-and-blocks)
- [8. Strings and interpolation](#8-strings-and-interpolation)
- [9. Commands](#9-commands)
- [10. Function calls and arguments](#10-function-calls-and-arguments)
- [11. Function definitions](#11-function-definitions)
- [12. Variable declarations](#12-variable-declarations)
- [13. Explicit types](#13-explicit-types)
- [14. Scope](#14-scope)
- [15. Objects](#15-objects)
- [16. Lists](#16-lists)
- [17. Return statements](#17-return-statements)
- [18. Null and optional values](#18-null-and-optional-values)
- [19. Choices](#19-choices)
- [20. Input functions](#20-input-functions)
- [21. Blocking button](#21-blocking-button)
- [22. Stage image, audio, and video](#22-stage-image-audio-and-video)
- [23. Loops](#23-loops)
- [24. Comments](#24-comments)
- [25. Persistent storage and keys](#25-persistent-storage-and-keys)
- [26. Labels and goto](#26-labels-and-goto)
- [27. Timers](#27-timers)
- [28. Permanent buttons](#28-permanent-buttons)
- [29. Script files and paths](#29-script-files-and-paths)
- [30. Script endings](#30-script-endings)
- [31. Popups and system notifications](#31-popups-and-system-notifications)
- [32. Switch statements](#32-switch-statements)
- [33. Browser API: file, folder, camera, and URL references](#33-browser-api-file-folder-camera-and-url-references)
- [34. Runtime warnings and recoverable values](#34-runtime-warnings-and-recoverable-values)
- [35. Date, time, and durations](#35-date-time-and-durations)
- [36. Scheduling](#36-scheduling)
- [37. Dynamic speaker terms](#37-dynamic-speaker-terms)
- [38. Keywords and protected built-ins](#38-keywords-and-protected-built-ins)
- [39. Rejected and reserved syntax](#39-rejected-and-reserved-syntax)
- [40. Dictionaries](#40-dictionaries)
- [41. Headers and tags](#41-headers-and-tags)
- [Remaining open decisions](#remaining-open-decisions)

## Status legend
- **Accepted**: approved
- **Provisional**: direction chosen, details still open
- **Rejected**: not part of the language

**Type rules ahead of the compiler (owner decision, 2026-10-19):** the type rules decided for the new type checker (O4)
are written in this document: [§8](#regexes), [§11](#11-function-definitions), [§12](#12-variable-declarations),
[§13](#13-explicit-types), [§15](#15-objects), [§16](#16-lists), [§17](#17-return-statements),
[§18](#18-null-and-optional-values), [§19](#19-choices), [§25](#25-persistent-storage-and-keys),
[§32](#32-switch-statements), [§33](#stored-files), [§34](#34-runtime-warnings-and-recoverable-values), and
[§40](#40-dictionaries). The current compiler and runtime still apply the earlier rules until the compiler switches to
that checker.

## Delimiter roles
**Status:** Accepted

The existing accepted forms use these delimiter pairs consistently. This section records that convention; it does not
add a new grammar form.

- `()` — expression grouping and call/parameter lists: grouped expressions, function-call arguments, and function
  parameter lists.
- `[]` — list syntax and positional access: list literals, list type suffixes such as `string[]`, and indexing.
- `{}` — structured bodies and records: executable blocks, structured declaration bodies such as
  `speaker mistressVera { ... }`, and object literals.
- `${...}` — the reserved string-interpolation form. It is distinct from an ordinary `{}` structured body; normal
  TeaseScript expression parsing applies inside.

When named properties or fields appear inside a structured declaration or record, `{}` delimit the containing
structure, not the individual property or field.

Future syntax should reuse these established roles rather than assign a delimiter a materially unrelated meaning. A
materially unrelated delimiter role requires its own explicit accepted syntax decision.

## 1. Statement termination
**Status:** Accepted

TeaseScript does not use semicolons. A newline ends a complete statement:

```text
let score = 10
let bonus = 5
say score + bonus
```

Rejected:

```text
let score = 10;
let bonus = 5;
```

A closing block brace may also end the final statement in that block. This permits compact one-line blocks:

```text
if score >= 10 { say "You passed." }

if score >= 10 { say "You passed." } else { say "You failed." }
```

Multiple statements may not otherwise be placed on the same source line:

```text
let score = 10 let bonus = 5 // compile error

if score >= 10 {
    say "First" say "Second" // compile error
}
```

A statement continues across a newline when the parser can see that it is not complete. Newlines are therefore allowed:

- inside `()` and `[]`;
- inside object literals;
- after `=`, a comma, or a binary operator;
- after the `:` of a named argument, option, property, or choice key, before its value;
- before the closing delimiter of a multiline call, list, or object.

Examples:

```text
let result = calculateDamage(
    player,
    weapon
)

let music = playAudio(
    file: "music/track.mp3",
    async: true,
    volume: 0.5
)

let toy = {
    type: "buttPlug",
    name: "Black plug",
    diameter: 4 cm
}

let total = score +
    bonus +
    punishmentPoints

let result =
    calculateDamage(player, weapon)

let answer = askChoice stay:
    "Stay", leave: "Leave"
```

The same calls and objects may remain on one line:

```text
let result = calculateDamage(player, weapon)
let music = playAudio(file: "music/track.mp3", async: true, volume: 0.5)
let toy = { type: "buttPlug", name: "Black plug", diameter: 4 cm }
```

Outside brackets, an operator must remain at the end of the continued line. It may not begin a new statement line:

```text
let total = score
    + bonus // compile error
```

Correct:

```text
let total = score +
    bonus
```

Inside `()`, `[]`, and object literals, where a line break does not end the expression, a binary operator may also
start the next line, as a comma may; the expression means the same as on one line:

```text
let total = (score
    + bonus)
```

A command and its first argument remain on the same line:

```text
say
    "Hello" // compile error
```

A function name and its opening `(` remain on the same line:

```text
calculateDamage
(
    player,
    weapon
) // compile error
```

A number and its unit also remain on the same line:

```text
let distance = 4
km // compile error
```

Physical newlines are valid only in block strings. They do not terminate the surrounding statement, and their text
behavior is defined under [Strings and interpolation](#8-strings-and-interpolation).

## 2. Literal values
**Status:** Accepted

```text
true
false
null
```

## 3. Numeric types
**Status:** Accepted

```text
let count: integer = 5
let ratio: number = 2.5
```

- `integer` is for whole numbers.
- `number` is for general numeric values, including decimals.

### Numeric literal forms

User-written numeric literals use decimal digits and a dot as the decimal separator.

Accepted integer forms:

```text
0
5
05
0005
```

Leading zeros do not indicate octal notation. `05` has the integer value `5`.

Accepted decimal forms:

```text
2.5
0.5
.5
5.
```

`.5` is normalized to `0.5`, and `5.` is normalized to `5.0`. A comma is not a decimal separator in source code:

```text
0,5 // not one numeric literal
```

Scientific notation is part of the accepted numeric syntax:

```text
1e6
1E6
1.5e3
2e-4
.5e2
5.e1
```

The exponent marker may be `e` or `E` and may be followed by `+` or `-`. The first parser POC may implement scientific notation after the simpler decimal forms, but its final lexical form is already fixed by this section.

A leading `+` or `-` is parsed as a unary operator rather than as part of the numeric token:

```text
-2.5
+5
```

Hexadecimal, binary, octal-prefix, `NaN`, and infinity literals are not part of v1 source syntax.

### Unit values

Numeric literals may include a recognized measurement unit:

```text
let diameter = 4 cm
let alternativeDiameter = 1.5 inch
let weight = 2 kg
```

Rules:

- The engine parses unit literals and performs compatible conversions through the configured mathematics library.
- Compatible measurements are normalized internally to one canonical SI representation for storage, arithmetic, comparison, and server exchange.
- The original author unit is retained as presentation metadata, but it is not the comparison basis.
- Both documented abbreviations and documented full unit names are accepted. A space between the number and unit is required.

```text
4 cm            // valid
4 centimeters   // valid
4cm             // compile error
```

- Visible text uses the player's preferred measurement system and automatically selects a readable scale within that system. For example, a long distance may display in kilometers or miles instead of thousands of meters or feet.
- The account supplies the default maximum number of decimal places, initially `2`. A script may override both the output unit and decimal count for a particular presentation.

```text
say distance.format(unit: "km", decimals: 1)
say distance.format(decimals: 2)
```

- When `unit` is omitted, `format(...)` keeps automatic account-based unit selection. Formatting returns a `string` and does not change the underlying measurement.
- Converting a unit value with `toNumber(...)` returns the scalar in the canonical SI representation. For example, `toNumber(4 cm)` returns `0.04` because length is normalized to meters. The author is then responsible for any later manual unit interpretation.
- Unit names are unit suffixes, not ordinary variables and not general grammar keywords.

The initial unit catalog and exact accepted suffixes are:

```text
Length
mm: millimeter, millimeters
cm: centimeter, centimeters
m:  meter, meters
km: kilometer, kilometers
inch: inch, inches
ft: foot, feet
yard: yard, yards
mile: mile, miles

Mass
g:  gram, grams
kg: kilogram, kilograms
oz: ounce, ounces
lb: pound, pounds

Volume
ml: milliliter, milliliters
l:  liter, liters
US fluid ounce: US fluid ounce, US fluid ounces
US cup: US cup, US cups
US pint: US pint, US pints
US quart: US quart, US quarts
US gallon: US gallon, US gallons

Temperature
Celsius: Celsius
Fahrenheit: Fahrenheit
```

The listed spellings are case-sensitive. Abbreviations use the exact capitalization shown, including uppercase `US`. For multi-word units, the lexer takes the longest matching documented unit suffix after the numeric literal.

The engine uses canonical SI values internally: meters for length, kilograms for mass, cubic meters or an equivalent exact SI volume representation for volume, and kelvin for absolute temperature calculations. The documented aliases and plural forms map to the same unit definitions. Automatic display scaling and rounding affect presentation only.

## 4. Arithmetic operators
**Status:** Accepted

```text
+
-
*
/
%
```

Examples:

```text
let total = score + bonus
let remaining = total - used
let doubled = amount * 2
let perRound = total / count
let remainder = amount % 2
```

`%` gives the remainder of a division with the sign of the dividend: `-7 % 3` is `-1` and `7 % -3` is `1`.
[`mod`](#numeric-functions) gives it the sign of the divisor instead.

Dividing numbers always returns a `number`, also when the result is whole. Storing it where an `integer` is required needs
explicit rounding ([§13](#13-explicit-types)):

```text
5 / 2                                 // 2.5
let shares: integer = 10 / 5          // compile error: a quotient is a number
let shares: integer = floor(10 / 5)   // valid
```

Arithmetic applies to numbers, to durations as described in [§35](#35-date-time-and-durations), and to angles as
described in [Exponentials, logarithms, and angles](#exponentials-logarithms-and-angles). `+` also joins two values of
the same kind: two texts give one text, and two lists give a new list ([§16](#16-lists)); `+=` joins the same way.
Nothing converts: text and another value, or a list and a single value, is a compile error that points to
interpolation or to `add`, and a runtime error when the compiler cannot see the kinds:

```text
let name = "Mistress " + title     // text + text
let menu = ["Back"] + options      // a new list, the left elements first
name += "!"
let line = "Score: " + 5           // compile error: write "Score: ${5}"
let more = menu + "Exit"           // compile error: use menu.add("Exit"), or menu + ["Exit"]
```

A calculation whose result is too large to represent, or that divides by zero, has no result. When the compiler can
see every operand of that step, as in `1e308 * 10` or `1e300 s * 1e10`, it is a compile error that names the step,
anywhere in an expression. A division or remainder by a zero the compiler can see, such as `x / 0` or `x % (2 - 2)`,
fails for every `x`, so it is a compile error even when `x` is known only when the script runs. Any other step with an
operand that is known only then is checked when it runs, and fails with a runtime error.

### Randomness

All random operations use one deterministic session RNG. This includes list `.random`, list selection in `${...}` interpolation, random ranges, script globs, and the built-in random functions.

```text
let value = random()
```

`random()` returns a `number` from `0` inclusive up to `1` exclusive.

```text
if chance(25) {
    say "This happens with a 25 percent chance"
}
```

`chance(percent)` returns `boolean`. Values are expressed as a percentage from `0` through `100`.

Random whole numbers use the existing range syntax as the single argument:

```text
let dieRoll = randomInteger(1..=6)
let index = randomInteger(0..items.length)
```

The range itself defines whether the upper bound is inclusive or exclusive. `randomInteger(...)` therefore needs no separate minimum/maximum boundary convention. Its bounds are whole numbers ([§6](#6-range-semantics)).

### Weighted choice
**Status:** Accepted (Owner decision, 2026-10-07)

`randomWeighted` chooses with a chance in proportion to a weight. Given a dict, it returns one of its keys, weighted by
the values; given a list of objects and `weight:`, it returns a copy of one element, like `.random`, weighted by that
property:

```text
let exercise = randomWeighted(dict{ "10 squats": 3, "5 min plank": 1 })   // squats three times as often
let task = randomWeighted(tasks, weight: "chance")
```

Weights are numbers of at least 0, and at least one is above 0; an element of weight 0 is never chosen. Each call makes
one draw of the session RNG. An empty dict or list is runtime error `TSR018`, a negative weight or no weight above 0
`TSR039`, and a weight that is not a number `TSR060`; a weight of another type, a missing property, a negative weight,
or no weight above 0 is a compile error when the compiler can see it.

### Random distributions
**Status:** Accepted (Owner decision, 2026-10-07)

```text
let pause = randomNormal(30, 5)            // around 30, mostly between 20 and 40
let share = randomBeta(2, 5)               // from 0 through 1, mostly low
let reps = round(randomPert(5, 10, 20))    // from 5 through 20, most likely near 10
```

- `randomNormal(mean, spread)` draws from the normal distribution with that mean and standard deviation; `spread` is
  at least 0. Each call makes two draws of the session RNG.
- `randomBeta(alpha, beta)` draws a number from 0 through 1 from the beta distribution, for `alpha` and `beta` above 0.
- `randomPert(min, mostLikely, max)` draws from `min` through `max`, most often near `mostLikely`, from the PERT
  distribution: `min + (max - min) × randomBeta(1 + 4 × (mostLikely - min) / (max - min), 1 + 4 × (max - mostLikely) /
  (max - min))`, for `min <= mostLikely <= max`. With `min` equal to `max` it returns `min`.
- `randomBeta` and `randomPert` sample by rejection: a call makes at least 6 draws, about 6 to 8 on average, and at
  most 386. The number depends only on the parameters and the draws, so replay and checkpoint resume repeat it.
- Each returns a `number`. Invalid parameters are a compile error when the compiler can see them, and runtime error
  `TSR039` otherwise; a `randomNormal` result too large to represent is `TSR036`.

## 5. Logical and comparison operators
**Status:** Accepted

Use readable word operators:

```text
if hasKey and door.locked {
    say "The locked door can be opened"
}
```

```text
if isTired or energy < 20 {
    rest()
}
```

```text
if not hasPermission {
    say "Access denied"
}
```

Rules:

- Use `and`, `or`, and `not`.
- `&&`, `||`, and `!` are not part of the language; each is a compile error that names the word to write
  ([§39](#no-symbolic-logical-operators)). `!=` is the comparison.
- Parentheses may be used to make precedence explicit.

```text
if (hasKey and door.locked) or isAdmin {
    openDoor()
}
```

### Expression precedence and associativity

Expression precedence from strongest to weakest:

1. Parenthesized expressions
2. Property access, indexing, and function calls
3. Unary `+` and unary `-`
4. `*`, `/`, `%`
5. `+`, `-`
6. Ranges `..` and `..=`
7. `otherwise` ([§18](#fallback-with-otherwise))
8. Comparisons `==`, `!=`, `<`, `<=`, `>`, `>=`, and type tests `is`, `is not` ([§13](#13-explicit-types))
9. `not`
10. `and`
11. `or`

Postfix operations such as property access, indexing, and function calls associate from left to right:

```text
items[0].name
```

Arithmetic operators and `otherwise` associate from left to right within the same precedence level:

```text
20 / 5 * 2 // (20 / 5) * 2
10 - 3 - 2 // (10 - 3) - 2
```

Unary operators apply from right to left:

```text
--value // -(-value)
```

Ranges and comparisons do not chain. Parentheses or logical operators must be used instead:

```text
1..10..20   // compile error
minimum < value and value < maximum // valid
minimum < value < maximum           // compile error
```

An operand of `otherwise` that is arithmetic or a range needs parentheses ([§18](#fallback-with-otherwise)):

```text
count otherwise 0 + 1   // compile error
(count otherwise 0) + 1 // valid
count otherwise (0 + 1) // valid
```

Because comparisons bind more strongly than `not`, this:

```text
not score == 5
```

means:

```text
not (score == 5)
```

Parentheses may always override the normal precedence.

## 6. Range semantics
**Status:** Accepted (whole-number bounds of `for` and `randomInteger`: Owner decision, 2026-10-07)

Ranges use Rust-style bounds:

- `a..b` includes `a` and excludes `b`.
- `a..=b` includes both `a` and `b`.

```text
5..10
```

may produce `5`, `6`, `7`, `8`, or `9`.

```text
5..=10
```

may also produce `10`.

`5..5` and a reversed range such as `5..1` contain no numbers: a range never counts down. A `for` loop over such a range
runs zero times, and `toList()` returns `[]`. When both bounds are written as numbers, the compiler warns.

`for` ([§23](#23-loops)), `randomInteger` ([Randomness](#randomness)), and `toList()` give the whole numbers of a range,
and `wait` and `timer` ([§27](#27-timers)) pick a whole number of units from one, so a range written in any of them
needs whole-number bounds: a bound of type `number`, such as `count / 2`, is a compile error. Round it with
`floor(...)`, `round(...)`, or `ceil(...)`, as in `for i in 1..=floor(count / 2)`. A bound that the compiler cannot
check, such as one whose type it cannot know, is checked when the range is used. A `switch` case range matches any
number within its bounds ([§32](#32-switch-statements)).

Ranges may also be used in `switch` cases:

```text
switch score {
    case 0..4 {
        say "Low"
    }

    case 4..8 {
        say "Medium"
    }

    case 8..=10 {
        say "High"
    }
}
```

Overlapping cases are a compile error. Adjacent exclusive ranges such as `0..4` and `4..8` do not overlap.

`toList()` returns the whole numbers of a range as a new list, in order: `(1..=5).toList()` is `[1, 2, 3, 4, 5]`, and
`(1..1).toList()` is `[]` (owner decision, 2026-10-15). Write the range in parentheses, or call it on a range kept in a
variable. A range is not a list: to add its numbers to a list, write `list += (1..=3).toList()`. `toList()` makes at
most 1,000,000 numbers; a larger range is a compile error where the compiler can see its bounds, and runtime error
`TSR045` otherwise.

## 7. Conditions and blocks
**Status:** Accepted

Curly braces delimit blocks. Parentheses around conditions are optional.

```text
if hasKey {
    say "The door opens"
} else if doorIsLocked {
    say "The door is locked"
} else {
    say "Nothing happens"
}
```

```text
if (hasKey) {
    say "The door opens"
}
```

Rules:

- Use `else if` as two words.
- `{}` are required for blocks.
- Indentation is recommended but not syntactically significant.
- A condition, like an operand of `and`, `or`, and `not`, is `true` or `false`. There is no truthiness: `if count` is
  a compile error that suggests a comparison such as `count > 0`.

## 8. Strings and interpolation
**Status:** Accepted

Strings use double quotes. The single-line form supports interpolation:

```text
say "The door opens"
say "The ${doorName} opens"
```

The block form uses triple double quotes, supports interpolation, and preserves physical newlines as `\n` in the
resulting value:

```text
say """
    Hello ${playerName}.

    The door opens.
"""
```

Backticks have no delimiter role. A raw backtick inside either quoted form is ordinary text.

When a list is interpolated into a string, the engine selects one random element for that evaluation:

```text
let greetings = ["Hello", "Hi", "Welcome"]
say "${greetings}, ${playerName}"
```

Only `${...}` interpolation selects from a list; it is not a general list-to-string conversion. The complete rules are
defined under [Lists](#16-lists).

### String escape sequences

Both string forms support exactly these escapes:

```text
\\   // one literal backslash
\"   // one literal double quote
\n    // newline
\r    // carriage return
\t    // tab
\${   // the literal characters ${ without starting interpolation
```

Example:

```text
let message = "Quote: \"hello\"\nNext line"
```

For example:

```text
say "The source text is \${player.name}"
```

This displays the literal text:

```text
The source text is ${player.name}
```

The backslash is an escape marker and is not included in the displayed result. To display an actual backslash, use
`\\`.

Unknown escape sequences are compile errors. Inside `${...}`, normal TeaseScript expression parsing applies, including
nested quoted strings. Interpolations evaluate in source order.

### Physical newlines inside strings

A single-line string cannot contain a physical LF or CRLF anywhere before its closing quote. This includes physical
newlines inside an interpolation, a nested block string, or a multiline comment within that string's source extent.
Use `\n` for an explicit newline in a compact string:

```text
let message = "First displayed line\nSecond displayed line"
```

Block strings accept physical newlines. LF and CRLF spellings normalize to `\n` in the value; an explicit `\r` escape
remains a carriage return. Source indentation is removed deterministically:

1. A physical newline immediately after the opening `"""` is omitted. Spaces or tabs before it prevent this
   omission.
2. When the closing `"""` is on its own line, its preceding spaces or tabs and the immediately preceding newline are
   omitted.
3. From the remaining content, the longest exact spaces-and-tabs prefix shared by every nonblank physical content line
   is removed from those lines. An interpolation makes its line nonblank; source lines inside its expression are not
   block content.
4. Spaces and tabs are removed from blank lines. Deeper indentation and all other whitespace remain.

Tabs have no implied width: mixed indentation shares a prefix only where its characters match exactly. Dedent applies
to physical block text before escape decoding and never changes newlines created by escapes or interpolated values.

For example:

```text
if condition {
    say """
        First line.

            Intentionally indented.
        Third line.
    """
}
```

The value is:

```text
First line.

    Intentionally indented.
Third line.
```

`""""""`, `"""\n"""`, and a block with one whitespace-only content line have the empty value. A same-line closing
delimiter trims nothing. Additional blank lines remain after the two structural edge omissions, so
`"""\n\n\n"""` has the value `"\n"`. Inside block content, one or two unescaped `"` characters are text; the first
unescaped `"""` closes the block. Escaping one quote can break a would-be delimiter.

### Text operations

Strings are immutable: every operation returns a new value and leaves the original unchanged. `length` is a property;
the other operations are methods:

```text
let name = "  ada lovelace  "
let clean = name.trim()            // "ada lovelace"
say clean.uppercaseFirst()         // Ada lovelace
say clean.length                   // 12
if clean.startsWith("ada") {
    say clean.uppercase()          // ADA LOVELACE
}
let parts = "red,green,blue".split(",")   // ["red", "green", "blue"]
say toString(7).padStart(3, "0")          // 007
```

| Operation | Result |
| --- | --- |
| `text.length` | the number of characters, counted as Unicode code points |
| `text.contains(part)` | `true` when `part` occurs in `text` |
| `text.startsWith(part)`, `text.endsWith(part)` | `true` when `text` starts or ends with `part` |
| `text.indexOf(part)`, `text.lastIndexOf(part)` | the position of the first or last occurrence of `part`, or `null` when `part` does not occur |
| `text.count(part)` | how many times `part` occurs, counted from the start without overlap: `"banana".count("ana")` is `1` (owner decision, 2026-10-15) |
| `text.substring(start)`, `text.substring(start, end)` | the characters from `start` up to, but not including, `end`; without `end`, up to the end of the text |
| `text.split(separator)` | a `string[]` of the parts between separators, keeping empty parts; `split("")` returns the single characters |
| `text.replace(search, replacement)` | the text with every occurrence of `search` replaced |
| `text.trim()`, `text.trimStart()`, `text.trimEnd()` | the text without whitespace at both ends, at the start, or at the end |
| `text.uppercase()`, `text.lowercase()` | the text in upper or lower case |
| `text.uppercaseFirst()` | the text with its first character in upper case and the rest unchanged |
| `text.reverse()` | the text with its characters in reverse order, counted as Unicode code points (owner decision, 2026-10-13) |
| `text.repeat(count)` | the text repeated `count` times |
| `text.padStart(length, fill)`, `text.padEnd(length, fill)` | the text with `fill` repeated before or after it up to `length` characters; a text that is already long enough is unchanged |

Rules:

- Positions and lengths count code points from `0`, like list indexes. A position is an integer from `0` through the
  length, and `end` may not be before `start`. A `count` or padding `length` is an integer of `0` or more.
- `indexOf` and `lastIndexOf` give an `integer?` (owner decision, 2026-10-12), so a position is checked before it is
  used as a number ([§18](#18-null-and-optional-values)):

  ```text
  let slash = path.lastIndexOf("/")
  if slash != null {
      say path.substring(slash + 1)
  }
  ```
- Searching and replacing compare text literally and case-sensitively. A `replace` search text, a `count` part, and a
  padding `fill` must be non-empty.
- Case conversion uses the locale-independent full Unicode mapping: `"Straße".uppercase()` is `"STRASSE"`. It is not
  case folding and is not reversible: `"ß".uppercase().lowercase()` is `"ss"`. Composed and decomposed forms of the same
  visible text are different text, and `split("")` returns code points, so a flag emoji gives two parts.
- Arguments are positional. Misuse the compiler can see is a compile error: an unknown member, a member of a value
  that has none (`count.uppercase()` on a number), a wrong number of arguments, an argument of the wrong known type, a
  visibly negative, out-of-range, or empty argument, or an assignment such as `text.length = 0`. A value the compiler
  cannot know is checked when the operation runs, and an invalid one raises a runtime error.
- A text holds at most 536,870,888 UTF-16 code units, what V8 holds, in every host. An operation that would make a
  longer text, such as `repeat`, `padStart`, `replace`, `uppercase`, `escapeMarkup`, joining with `+`, `"${...}"`,
  `join`, the notation of a script reference, the descriptions of `askForm`, or `say` of a value, raises runtime error
  `TSR084` instead. Its message names the operation and, where it is known before the text is built, how long the text
  would be: `Text too long: repeat(9007199254740991) would make about 9,007,199,254,740,991 characters, but a text can
  hold at most about 536 million.` An error message that quotes text from the script cuts it after 1,024 characters
  with `…`.

### Regexes
**Status:** Accepted (Owner decision, 2026-10-13)

A regex is a pattern that text can match. Regexes use the RE2 dialect, which matches in time proportional to the text,
so it leaves out features that cannot, such as a back reference `\1` and lookahead or lookbehind.

```text
if code.matches(/\d{4}/) {
    say "Four digits"
}
let count = report.find(/\d+/)                   // the first number in the text, or null
let numbers = report.findAll(/\d+/)              // every number in the text, such as ["3", "12"]
let parts = report.capture(/moved (\d+) times/)  // ["moved 3 times", "3"], or null
let tidy = report.replace(/\s+/, " ")            // every run of spaces and line breaks as one space
let rule = toRegex(ruleText, default: null)      // a regex? from text that arrives while the script runs
```

A regex literal is the pattern between two slashes, followed by its flags:

- `/` starts a regex where the grammar expects a value, such as after `=`, `(`, `,`, an operator, `return`, `say`, or
  `save`; after a value it divides, as in `a / b`. `//` and `/*` start comments, so there is no empty literal: write
  `/(?:)/`.
- The pattern is used as written, without `${...}` interpolation or string escapes: `/\d/` is the pattern `\d`. `\/`
  and a `/` inside a character class, as in `/[/]/`, do not end it, and a literal ends on its line.
- The flags are `i`, which ignores case, `m`, with which `^` and `$` match at the start and end of each line, and `s`,
  with which `.` also matches a line break. A pattern can also turn them on inside itself, as in `(?i)`. An unknown or
  repeated flag is a compile error, and so is `g`: `findAll`, `replace`, and `split` handle every match without it. So
  is `u`, since a regex always matches Unicode characters.
- The compiler checks every literal: a pattern that is not valid, uses a feature RE2 leaves out, or is over the
  [regex limits](../RESOURCE-LIMITS.md#retained-poc-policies-and-defaults) is a compile error that says why.

These text operations take a regex:

| Operation | Result |
| --- | --- |
| `text.matches(regex)` | `true` when the regex matches the whole text |
| `text.contains(regex)` | `true` when the regex matches somewhere in the text |
| `text.find(regex)` | the text of the first match, or `null` |
| `text.capture(regex)` | a `string?[]?`: `null` without a match, otherwise the whole match at index 0 followed by each group in the order of its opening parenthesis; a group that did not take part is `null`, and an empty one is `""` |
| `text.indexOf(regex)` | the position of the first match, or `null` |
| `text.findAll(regex)` | a `string[]` of every match, or `[]` |
| `text.count(regex)` | the number of matches, as `text.findAll(regex).length` (owner decision, 2026-10-15) |
| `text.lastIndexOf(regex)` | the position of the last match, or `null` |
| `text.split(regex)` | a `string[]` of the parts between matches |
| `text.replace(regex, replacement)` | the text with every match replaced |

- The first match is the leftmost one, and of alternatives the first that matches there: `"ab".find(/a|ab/)` is
  `"a"`. `matches` tests the whole text, also with `m`: `"a\nb".matches(/^a$/m)` is `false`.
- Positions count code points, as for the other text operations. A named group, `(?<name>...)`, keeps its number in
  `capture`.
- `findAll`, `count`, `lastIndexOf`, `split`, and `replace` take every match in turn, each the leftmost one from where
  the previous one ended, so matches do not overlap. An empty match counts, also right after another match, and the next
  search starts one character later: `"ab".findAll(/x*/)` is `["", "", ""]`, `"a".findAll(/a*/)` is `["a", ""]`, and
  `"ab".replace(/x*/, "-")` is `"-a-b-"`.
- `lastIndexOf` gives the start of the last match: `"2026-10-14".lastIndexOf(/\d+/)` is `8`. Since matches do not
  overlap, it can differ from the text form for overlapping text: `"ababa".lastIndexOf(/aba/)` is `0`, while
  `"ababa".lastIndexOf("aba")` is `2`.
- `split` keeps empty parts and never inserts groups: `"a,b,".split(/(,)/)` is `["a", "b", ""]`. A match of no text
  separates nothing at either end of the text or right after another separator, so `"ab".split(/x*/)` and
  `"a  b".split(/ */)` are both `["a", "b"]`. Empty text gives `[]` when the regex matches it, and `[""]` otherwise.
- In the replacement of a regex search, `$0` inserts the whole match, `$1`, `$2`, and on a group, `$<name>` a named
  group, and `$$` one `$`; any other `$` is text. All the digits after `$` form the group's number. A group that did
  not take part inserts nothing. A group the regex does not have is a compile error when the regex and the replacement
  are known, and otherwise a runtime error. `${...}` is interpolated before replacing. A text search replaces
  literally, so `part.replace("$", "$$")` makes text from elsewhere a literal replacement:

  ```text
  "2026-10-14".replace(/(\d+)-(\d+)-(\d+)/, "$3.$2.$1")                // "14.10.2026"
  "Ann Lee".replace(/(?<first>\w+) (?<last>\w+)/, "$<last>, $<first>")  // "Lee, Ann"
  "5 USD".replace(/(\d+) USD/, "$$$1")                                 // "$5"
  "ab".replace(/(a)/, "$2")                                            // compile error: the regex has 1 group
  ```
- Every operation with a regex may do a fixed amount of work, the [regex work
  limit](../RESOURCE-LIMITS.md#retained-poc-policies-and-defaults). The work counts what RE2 does and what the
  operation builds, not time, so an operation ends the same way on every device. One that needs more fails with
  runtime error `TSR087`: `This regex needed too much work for this text. Use a simpler pattern or a shorter text.`

A regex is a value of type `regex` ([§13](#13-explicit-types)), which holds its pattern and its flags in the order `i`,
`m`, `s`. Two regexes are equal (`==`) when their patterns and flags are, so `/a/si == /a/is`, while `/a/i` and
`/(?i)a/` are not equal. Checkpoints, `save`, and `load` keep a regex. Shown as text, in `${...}`, `say`, or
`toString`, a regex reads as its literal: `"${/\d+/i}"` is `/\d+/i`. `toJson` cannot write it
([JSON and Base64](#json-and-base64)).

`toRegex(text, default: value)` makes a regex of pattern text. The text has no slashes, its flags go inside it, as in
`"(?i)yes|no"`, and in a string a backslash is written twice, as in `"\\d+"`. The `default:` is required and is a
regex or `null`, or of another type only where a written union holds both ([§18](#defaults-follow-the-same-rule)); the
result is a `regex`, or a `regex?` with `default: null`. Text that is not a valid pattern, or that
is over the regex limits, gives the default. The default is evaluated only when it is used (owner decision,
2026-10-16).

## 9. Commands
**Status:** Accepted

Engine-provided commands may omit parentheses and receive one expression:

```text
say "Fixed text"
say "Text with ${playerName}"
say message
say greetings
wait 2 s
playAudio "door.mp3"
```

`say` shows a list, set, dict, or object in code-like notation; only `${...}` interpolation selects one random element
from a list ([§16](#16-lists)). Used as a value, `say` gives a handle whose text can change in place, and also has a form
in parentheses, `say("Strokes: 0", instant)` ([Updatable messages](#updatable-messages)).

Only engine-provided built-ins use command syntax. User-defined behavior uses normal functions.

## 10. Function calls and arguments
**Status:** Accepted

Normal and user-defined functions are called directly with parentheses:

```text
openDoor()
openDoor("main door")
```

A returned value may be stored directly:

```text
let damage = calculateDamage(
    attacker: player,
    weapon: weapon
)
```

The keyword `call` is not used for normal functions. It is reserved for calling another `.tease` script.

Both positional and named calls are allowed:

```text
moveTo(10, 20)
```

```text
moveTo(
    x: 10,
    y: 20
)
```

Positional arguments may be followed by named arguments:

```text
moveTo(10, y: 20)
let amount = toNumber(text, default: 0)
```

Rules:

- Positional arguments fill parameters from left to right.
- Required positional parameters may not be skipped.
- Trailing parameters with defaults may be omitted.
- To skip an earlier parameter while setting a later one, use named arguments.
- Named arguments use `name: value`.
- Positional arguments come first; named arguments may follow them. A positional argument after a named one is an
  error: `moveTo(x: 10, 20)`.
- A parameter receives at most one value: naming a parameter that a positional argument already fills is an error.
- A grammar keyword may still be used as an API field label when it appears in the unambiguous `name:` position of a named argument, object property, or engine configuration block. This permits accepted labels such as `default:`, `repeat:`, and profile-change operation labels such as `save:` without permitting those words as variable or function identifiers.

## 11. Function definitions
**Status:** Accepted

Without parameters:

```text
function openDoor {
    say "The door opens"
}
```

With parameters:

```text
function openDoor(doorName) {
    say "The ${doorName} opens"
}
```

With explicit parameter types and defaults:

```text
function playClip(file: string, volume: number = 1) {
    playAudio(file: file, volume: volume)
}
```

A function may contain all normal actions, including `say`, `wait`, media, input, timers, and other function calls. A separate `procedure` concept is not used.

Rules:

- Use `function`.
- Parentheses are omitted when there are no parameters.
- Parentheses are required when parameters exist.
- Parameters are comma-separated.
- Default values use `name = value`.
- Required parameters must come before parameters with defaults.
- An annotated parameter keeps its type; every argument and default must fit it.
- A parameter without an annotation needs no type, also when it has a default. A default is only the value used when
  the argument is omitted: an omitted argument counts as the default, and the default is checked once, at the
  function, against what the body needs, so `function shout(name = null) { say name.length }` is a compile error in the
  function, not at each `shout()`.
- The compiler works out once, from the body, what the function requires of each parameter without an annotation, what
  it returns, and what it changes, and checks every call against that. Each call types such a parameter from its
  argument, a `null` argument included, and the calls are never combined into one parameter type: inside each call's
  use of the body, the parameter and the variables that depend on it follow [§12](#12-variable-declarations) for that
  call's arguments. With `function shake(times = 1)`, `shake(0.5)` is valid, and `times` is a `number` in that call.
  Where the compiler cannot show that a call fits, the call compiles and the value is checked when the script runs:

  ```text
  function dec(x) {
      return x - 1
  }
  function id(x) {
      return x
  }
  dec("a")    // compile error that names the call and the 'x - 1' line
  id(1)       // valid: an integer
  id("a")     // valid: text
  ```

### Global functions

A function belongs to its file ([§29](#29-script-files-and-paths)); `global function` declares one that every file of a
package can call, without an import ([ADR 0022](../decisions/0022-multi-file-scripts.md)):

```text
// helpers.tease
global function punish(count) {
    say "That is ${count} more."
}

// chapter1.tease
punish(3)
```

- A global function may use only globals, its parameters, and its own locals, not the top-level `let` variables of its
  file, and may call only other global functions and built-ins. Using a name of its file is a compile error whose fix is
  to make that name a global, or to pass it as a parameter.
- Interactions, timers, media, `goto`, `call`, `end`, `exit`, and recursion work in it as in any function. It may run
  in any file, so a bare `goto label` in it, also in a block it creates, is a compile error: put the part after the
  label in a file of its own and `goto` that file, or in a function that does the work and returns. A `goto` to a file
  starts that file at its top ([§29](#29-script-files-and-paths)).
- Its name is unique in the package, like that of a global ([§12](#global-variables)).

## 12. Variable declarations
**Status:** Accepted

Declare with `let`:

```text
let score = 10
let hasKey = true
let doorName = "main door"
```

Modify an existing variable without another keyword:

```text
score = 20
hasKey = false
score += 5
score -= 2
```

`+=` and `-=` are general assignment operators using the corresponding arithmetic operation and the target's
existing type rules. Timer-property assignment is defined in [§27](#27-timers).

Rules:

- `let` declares a new variable.
- `set` is not used.
- Redeclaring a visible variable is an error.
- Assigning to an unknown variable is an error.
- Types may be inferred.
- A variable keeps its declared or inferred type.

Invalid:

```text
let score = 10
score = "high"
```

The first value decides an inferred type:

```text
let best = null       // best takes the type of its first non-null value
best = "Ada"          // best is now string?
best = 5              // compile error: best holds text (string) since line 2

let picks = []        // picks takes its element type from its first element
picks.add(3)          // picks is now integer[]
picks.add("three")    // compile error
```

- A variable that starts as `null` takes the type of its first non-null value and may still hold `null`, and storing
  `null` later makes a variable optional too: after `let count = 1`, `count = null` makes `count` an `integer?`. A known
  `default: null` also makes a place optional when the value's other types are unknown:
  `[fromJson(t, default: null), 1]` is a list of `integer?`, so using an element where an integer is required needs a
  check or `otherwise`. The compiler infers no other combination of types.
- A variable without a type whose type is `integer` is a `number` when any of its assignments can store a non-whole
  number, wherever that assignment is. The elements and properties inside such a variable widen by the same rule. A
  declared type, such as `integer`, `integer[]`, or `integer set`, stays strict. A read sees what the variable holds at
  that point: where it can have received only whole numbers so far, it is an `integer` there. A value that may not be
  whole at an integer-only use, such as a list index, a `removeAt` position, or a repeat count, is a compile error where
  the compiler can prove that such a value reaches the use, as `items[j]` after `let j = 0` and `j = j / 2`; `floor`,
  `round`, or `toInteger` makes it whole. Where the compiler cannot tell whether such a value reaches the use, the use
  gives a warning, and the value is checked to be whole when the script runs
  ([§13](#compile-errors-warnings-and-checks-when-the-script-runs)):

  ```text
  let speed = 1
  speed = speed * 1.5   // speed is a number from here on
  let count = 0
  count += 1            // count stays an integer
  let i = 0
  say items[i]          // valid: i holds only whole numbers here
  i = i / 2             // i may not be whole from here on, so a later items[i] is a compile error
  let prices = [1, 2]
  prices.add(2.5)       // prices is a number[]
  ```

- An empty list or set takes its element type from the first element added or assigned. In a list or set literal,
  integers and numbers together are numbers, and `null` elements make the element type optional. Elements of different
  types are a compile error that names the union to declare ([§13](#union-types)), and the earliest element's type
  counts for the later uses, as with a store of another type (below).
- A place without a written type takes its type from its declaration's start value when that value settles it, and
  otherwise from the earliest value stored into it in source order: the files in project order, `main.tease` first and
  then the others by path, each from top to bottom, wherever the store is, also in a function body or in a timer,
  media, or button block. `null`, a value whose type the compiler cannot know, and the elements of an empty list, set,
  or dict settle nothing. A written type settles the type from the start and is strict.
- A store of another type is a compile error at that store. It names the line and the type that decided the place, for
  a variable that started without a type also its declaration, and it suggests a written union. The place keeps its
  type: the compiler ignores the rejected value, and later uses are checked against the decided type.
- The decided type holds wherever the place is used, also before the value that decided it, such as in a function body
  or in another file. A read inside an expression sees the value at that point of evaluation, as the runtime does. A
  copy is a new value: `let b = a`, `a.toSet()`, or a property read into a variable starts with what the source holds
  at that moment and then takes its type from its own stores, so after `let a = []` and `let b = a`, both `b.add(1)`
  and `a.add("s")` are valid. A copy of a source with contents carries them: after `let a = [1]` and `let b = a`,
  `b.add("s")` is a compile error, as after `let b = [1]`. A copy of a variable with a written type keeps that type:
  after `let a: integer | string = 1` and `let b = a`, `b = "text"` is valid.
- A value whose type the compiler cannot know, such as untyped storage or host data, decides nothing and is not
  rejected at compile time. Where a place of known type takes it, also through a place that no other value decided,
  such as `let box = { t: null }` set only from such a value, it is checked when it runs.
  An arithmetic operator on such a value may also give a value of unknown type. A place with a written type, or one
  that a value decided earlier in the source, still rejects it at compile time when no result of that operator could
  fit, as in `let y: string = x / 4` or `y += x / 4` after `let y = "a"`, because `/` never gives text. Where only a
  later value decides the place, as in `ys.add(x / 4)` after `let ys = []` and before `ys.add("a")`, a compile error
  needs a check of the store against that later value. Where the compiler does not make it, the store is accepted, the
  compiler warns that no result of the operator could fit, and the value is checked when it runs. With `x` from a
  `load` on line 1 and `ys.add("a")` on line 4, the warning reads:

  ```text
  'x / 4' cannot be text, but 'ys' holds text since line 4. 'x' has no known type (it comes from 'load' on line 1),
  so this is checked when the script runs. Give 'x' a type, for example with 'default: 0' in its 'load', or give 'ys' a written type.
  ```

  The warning names the source of the unknown value. When that source is not such a `load`, as for host data,
  `fromJson(…, default: null)`, or a computed key, it names that source instead and advises only a written type for
  the place.
- A value stored into a place may read a part of that place, and the read sees the part as it is before the store:
  after `let state = { n: "s", divisor: null }`, `state = { n: hostValue / state.divisor, divisor: 4 }` divides by the
  `null` that `divisor` still holds, which is a compile error. Where the value comes from a function that reads a part
  of the place that no earlier value decided, as in `state = rebuild()` when `rebuild` reads `state.divisor`, the
  compiler must follow that read into the function to settle the part before the store. Where it does not settle it,
  the store is accepted, the compiler warns, and the value is checked when it runs. The warning advises writing a type
  on the place, one type or a union, such as `let score: number? = null`, so that the compiler has more to go on.

### Global variables

`global` declares a variable that all files of a package share
([ADR 0022](../decisions/0022-multi-file-scripts.md)):

```text
global strictness = 2
global level = load("level", default: 1)
global answer: string? = null
```

Rules:

- A global may be declared anywhere in any file, including inside `if`, loops, functions, and timer and media blocks.
- It is visible in all files. Its name is unique in the project, also among global functions and speakers, and no other
  name may shadow it: a `let`, parameter, regular function, or host-provided global of the same name anywhere is a
  compile error.
- Declarations are collected at compile time. Globals and speakers ([§37](#37-dynamic-speaker-terms)) are initialized
  once at session start, before the story runs, whether or not the surrounding block ever runs: `main.tease` first, then
  the other files in path order, each in source order. Reaching the declaration later does nothing.
- An initializer may use literals, earlier globals, side-effect-free operators, and `load … , default:`. A
  `script(...)` reference ([§29](#29-script-files-and-paths)) counts as a literal, with arguments under the same rules.
  It may not use local values, interactions, other calls, or random numbers, including the element that `.random` or a
  list in `${...}` selects, or read a global initialized after it. These rules also hold inside a `load` default.
- Types follow the `let` rules above, across all files. Values are checkpointed and live for the session; `save` and
  `load` keep a value beyond it.

A value that exists only later, such as a local variable, needs a start value with `default:`:

```text
function practice {
    let localCount = askInteger "How many did you do?"
    global attempts = localCount, default: 0
}
```

`attempts` holds `0` from the start of the session, in every file. Each time the declaration runs, it assigns
`localCount`. The `default:` value follows the initializer rules. Like every `, default:`, it belongs to the nearest
construct before it that takes one ([§25](#25-persistent-storage-and-keys)), so
`global level = load "level", default: 1` gives the default to `load`. Without `default:`, an initializer that uses a
local value is a compile error that names the global, explains that it needs a value from the start of the session,
and shows both fixes: `, default: 0`, or `global attempts = 0` and a later `attempts = localCount`.

### Constants
**Status:** Accepted (Owner decisions, 2026-10-19 and 2026-10-20); not yet implemented, planned after the O4
type-checker switch.

`const` declares a constant. It cannot be replaced, and, unlike JavaScript's `const`, no part of its ordinary value can
change either. Copy it into a `let` variable for a version that can change:

```text
const rounds = 3
rounds += 1                       // compile error

const settings = { rounds: 3, locked: false }
settings.locked = true            // compile error

const groups = [[1, 2], [3, 4]]
groups[0][1] = 9                  // compile error
groups.add([5, 6])                // compile error

let workingSettings = settings
workingSettings.locked = true     // valid: changes an independent copy
```

- `const` is a grammar keyword ([§38](#grammar-keywords)). It follows the declaration, type, and scope rules of `let`,
  and like `let` it needs a start value. The value may be one known only during play, as in
  `const name = askText "Your name?"`.
- A constant cannot be assigned, also not with `+=` or `-=`. At any depth of its ordinary value, a property, element,
  or dict entry cannot be assigned or added, and a method that changes a list, set, or dict, such as `add`, `remove`,
  `sort`, or `clear`, is an error. This holds wherever the write stands, also in a function that sees the constant and
  in a timer, media, or button block that shares it ([§14](#variables-in-timer-media-and-button-blocks)).
- Copies are independent ([ADR 0014](../decisions/0014-core-runtime-value-semantics.md)) and can change: a `let` that
  takes a constant's value, a parameter that receives it, a loop variable that runs through it, and the result of a
  function that returns it.
- Storage copies as usual ([§25](#25-persistent-storage-and-keys)): a constant that `load` started keeps its value
  after a later `save` to that key, and loading the saved value into a `let` gives one that can change.
- Only its declaration gives a constant its value. A declaration that runs again, in another call, another run of a
  loop body, or after a `goto` back to an earlier label ([§26](#26-labels-and-goto)), sets its constant anew, as a
  `let` would.

Speakers and handles, such as those of timers, media, cameras, messages, and buttons, stay references: a constant
that holds one keeps naming the same speaker or the same thing behind the handle, which can still change, also
through the constant:

```text
const p = player
p.mood = "calm"                   // valid: changes the player
p = mistressVera                  // compile error

const scene = { lead: player, rounds: 3 }
scene.lead = mistressVera         // compile error: changes the constant's value
scene.lead.firstName = "Ada"      // valid: changes the player

const deadline = timer async hidden 30 s {
    say "Time is up", instant
}
deadline.pause()                  // valid: controls the timer
```

A write to a constant is a compile error that points at the write and at the constant's declaration and says what to
do. The write on line 5 of the first example reports:

```text
Cannot change 'settings.locked' because 'settings' was declared with 'const' on line 4. Copy it into a 'let' variable to make changes.
```

Where the compiler cannot tell whether a value is ordinary data or a reference, it warns, and the operation is checked
when it runs.

`global const` declares a global constant:

```text
global const maxRounds = 5
global const difficulty = load("difficulty", default: 2)
```

It follows the rules of [global variables](#global-variables), so it is set once at session start from a start value
that follows their initializer rules. It cannot take a value that exists only later, such as a local value or an
answer: the form `global attempts = localCount, default: 0` assigns its global again each time the declaration runs,
and a later assignment is not allowed. For a `global const`, such an initializer, with or without `default:`, is a
compile error that names both fixes: `global`, or a start value that exists at session start. A `default:` that
belongs to `load` is not affected.

## 13. Explicit types
**Status:** Accepted

Explicit types are allowed and encouraged for editor tooling:

```text
let score: number = 10
let hasKey: boolean = true
let doorName: string = "main door"
```

The built-in scalar type names are:

```text
string
boolean
integer
number
date
time
datetime
absoluteDateTime
duration
calendarDuration
angle
```

The other type names are `null`; `list`, `set`, `dict`, and `object` for any list, set, dict, or object; and the
program-control types `range`, `speaker`, `timer` (a timer handle), `media` (a media handle), `messageHandle` (a shown
message, [§37](#updatable-messages)), `script` (a script reference, [§29](#29-script-files-and-paths)), and `regex` (a
pattern, [§8](#regexes)). A type is a type name
or one of these forms ([ADR 0021](../decisions/0021-static-types.md)):

```text
integer[]            // a list of integers
integer set          // a set of integers
integer dict         // a dict of integers by text key (§40)
integer?             // an integer or null: integer | null
integer | string     // an integer or text
(integer | string)[] // a list whose elements are integers or text
integer?[]           // a list of integers or nulls
integer[]?           // a list of integers, or null
```

`[]`, `set`, `dict`, and `?` follow a type and bind tighter than `|`; parentheses group. A set may hold any value a list
may hold, so `integer[] set` is a set of lists of integers ([§16](#16-lists)).

A union never holds a whole list, set, or dict beside another type: write the union inside the collection instead. An
optional collection, such as `integer[]?`, is a collection or `null`, and stays allowed. The rule holds in every place
a type is written: variables, parameters, results, list and set elements, and dict values, also inside another type:

```text
let a: (integer | string)[] = [1, "two"]       // valid: a union inside a list
let b: (integer | string) set = set[1, "two"]  // valid
let c: (integer | string) dict = dict{}        // valid
let d: integer?[] = [1, null]                  // valid
let e: integer[]? = null                       // valid: a list of integers, or null
let f: integer[] | string[] = []               // compile error
let g: string[] | string = "a"                 // compile error
let h: integer | string[] = 1                  // compile error that suggests (integer | string)[]
let i: integer set | string set = set[]        // compile error
let j: integer dict | string dict = dict{}     // compile error
let k: integer[] | string set = []             // compile error
let l: list | integer = []                     // compile error
let m: (integer[] | string[])[] = []           // compile error: also inside another list
let n: (integer | string[]) dict = dict{}      // compile error: also as a dict's value type
function o(x: integer | string[]) { }          // compile error: also for a parameter
function p(): integer[] | string { return "a" } // compile error: also for a result
```

### Union types

A union `A | B` holds a value of either type. Unions may be used wherever a type is allowed: variables, list and set
elements, dict values, parameters, and return types, apart from unions of whole collections (above). The compiler
never infers a union; mixing types without a declared
union is an error whose message names the union form:

```text
let reward: integer | string = 10
reward = "a long break"                        // valid
let values: (string | number)[] = ["Level", 2]  // valid
let mixed = ["Level", 2]                       // compile error: declare (string | number)[]
```

An operation on a union is allowed when every member supports it with a compatible result. `==`, `!=`, and storing into
an equal or wider union always work; `${...}` and text fields need every member to be a value they can show
([§16](#16-lists)). Otherwise the error names the test the author needs:

```text
let points = reward + 1
// 'reward' may be text (string). Check it first: if reward is integer { ... }
```

### Type tests and narrowing

`value is T` tests a value against any type `T`; `value is not T` is its negation. `is` binds like the comparison
operators, so `x is integer and x > 3` needs no parentheses, and type tests do not chain.

```text
if reward is integer {
    say "You earned ${reward} points"
} else {
    say "You earned ${reward}"
}
```

- `x is T` is true exactly when the value may be stored in a place of type `T`. `is number` is also true for integers,
  and `is integer` is true for any whole number, including `2.0`. A collection test with an element type checks every
  element; `[] is integer[]` is true. `is date`, `is time`, and `is datetime` test the date and time values of
  [§35](#35-date-time-and-durations).
- A test works on every value, including untyped storage, host data, and parameters without a type. The operand is
  evaluated once, and the test has no side effects.
- `x is "happy"` is a compile error: `is` checks a type, and `==` compares values.
- The compiler warns about a test that is provably always true or always false, such as `5 is number`.

After a test, the compiler knows the narrower type:

- in the branches of `if`/`else`, in the right operand of `and` and `or`, and in the body of `while`;
- in the case blocks and the `default` of a `switch` ([§32](#32-switch-statements));
- after an `if` whose branch ends with `return`, `exit`, `break`, or `continue`;
- `x != null` and `x == null` narrow like `x is not null` and `x is null`.

```text
let saved: integer | string = load("level", default: 0)
if saved is not integer {
    exit
}
let level: integer = saved   // valid: saved is an integer here
```

- An assignment narrows the variable to the assigned value's type: directly after `let reward: integer | string = 10`,
  `reward` is an `integer`.
- Tests can overlap: an `else` branch keeps only what the test provably excludes, so a `number` that fails
  `is integer` is still a `number`.
- A check on a stable path narrows like a check on a variable. A path is a variable followed by properties
  (`shed.locked`, `door.lock.code`), fixed indexes (`items[0]`), fixed keys (`toys["collar"]`), or indexes and keys
  held in plain variables (`items[i]`, `toys[name]`), in any combination (`rooms[i].door.locked`). Each read must
  select the same stored value: an operation that selects anew, such as `.random`, is not a path.
- A check holds in the places listed above, and only where every route into the place establishes it, also at labels
  and in called files. A function, timer, media, or button body does not inherit the checks of the code around it.
- The compiler drops a check on:
  - an assignment or change to the value, to any part of its path, or to an index or key variable in it; an assignment
    gives a new fact from its value;
  - any change of a list or dict in the path: its order, length, entries, or stored values;
  - a write through any reference to the same speaker (in variables, arguments, results, collection elements, and loop
    variables), a replacement of a containing part, a bulk field update, a built-in derived field, and, for the
    contextual `speaker`, a change of the effective speaker;
  - code that may run and change the path: a call (also of another file), `say`, `wait`, an interaction, a storage
    write, a timer or media command, a method, or a timer or media property write such as `deadline.remaining = 0 s`,
    also through shared locals ([§14](#variables-in-timer-media-and-button-blocks)), calls inside calls, and blocks
    that outlive the code that created them. Where the compiler cannot tell what code changes, it assumes it may.
- Code that may run and a loop's start never drop a check on a constant or on a path inside one
  ([§12](#constants)), since nothing assigns a constant or changes its ordinary value. A path that goes through a
  speaker or a handle is the exception: after `const p = player`, a timer can still change `p.mood`.
- Inside a [`noInterrupts` block](#nointerrupts-blocks), a timer, media, or button block cannot drop a check, because
  it waits until the block ends; the other causes above still apply.
- At the start of a loop, the compiler accounts for both the values from before the loop and the values an earlier
  round left, and repeats this until what it knows no longer changes. A write in the loop body drops a check only when
  the written value can make the check false.
- A saved value keeps its facts: after `let item = items[i + 1]`, `if item != null { ... }` holds even when `items`
  changes later. Saving only an index still depends on the collection staying unchanged.
- A use that needs a check has three outcomes. Without a check on some route to it, it is a compile error that
  suggests `if x != null` or `otherwise`. A use that the compiler proves invalid, such as one that is `null` because of
  an assignment just before it, is a compile error. A use with a check on every route that the compiler cannot keep,
  because of a computed index such as `items[i + 1]`, a possible write by a timer, media, or button block or by a
  function in between, or an analysis limit, compiles with a compiler warning at that use, and the value is checked
  there when the script runs; a failed check reports that use. The check uses the value just read and does not
  evaluate the expression again. This holds for plain variables too: a check that a timer, media, or button block may
  undo during a `say`, `wait`, or interaction gives the warning and the check when the script runs. Once
  `noInterrupts` blocks are implemented, that warning also suggests putting the code in one.
- Narrowing never creates a property, widens a declared type, or proves that an index or key exists: the
  missing-property, missing-key, and bounds rules still apply. A null check is not a key check; use `contains` or
  `get` ([§40](#40-dictionaries)).

```text
let box = { n: 1 }
timer(duration: 10 s, async: true, repeat: true) { box.n = null }
if box.n != null {
    say "Hello"            // the timer may clear box.n during this say
    say box.n + 1          // warning, and checked when the script runs
}
```

### Compile errors, warnings, and checks when the script runs
**Status:** Accepted (owner decisions, 2026-10-19, 2026-10-21, and 2026-10-23)

Valid code always compiles. Valid code meets the language's syntax, type, and required-check rules, and a compile
error names a violation of one of them, such as a value that may be `null` used without any check. Where the compiler
cannot prove at reasonable cost that a written check still holds, or where checking at compile time is impractical,
the check moves to the runtime: the code compiles, the value is checked there when the script runs, and the compiler
gives a warning that names the place and says how to let the compiler check it now. The compiler catches as much as it
can at compile time; a check when the script runs is the exception.

The compiler gives an exact answer, a compile error or acceptance without a warning, only where it can prove that
answer. Everywhere else it gives the warning, and the value is checked when the script runs. It never reports a compile
error for valid code and never silently accepts code that may fail, so a compile error means that the code is certainly
wrong, and a warning that it may go wrong. Which uses the compiler can prove is a property of the compiler, not a rule
of the language, and the compiler catches more over time: as its proofs improve, a warning becomes a compile error
where the code is certainly wrong, or disappears where the code is certainly fine.

A value that a run makes unfit for a later use, through branches, calls, or buttons, is a compile error only where that
run can really happen, never for a path that exists only in the compiler's analysis, and only where the compiler can
prove the run. After an unconditional `backpack.add("key")` before `let copy = backpack`, `copy.add(3)` is a compile
error. In this script, a run that adds the key and then makes the copy exists only in the compiler's analysis, so it is
never a compile error:

```text
let hasKey = askBoolean "Do you have the key?"
let backpack = []
if hasKey {
    backpack.add("key")
}
if not hasKey {
    let copy = backpack
    copy.add(3)
}
```

To accept it without a warning, the compiler must follow that `not hasKey` excludes `hasKey`. Where it does not, it
warns instead of giving a false error, and the copy is checked when the script runs.

The required-check rules are not affected: a use that needs a check and has none on some route stays a compile error,
as `n + 1` does after `let n = 1` and `if askBoolean "Clear?" { n = null }` ([narrowing](#type-tests-and-narrowing)).

The compiler never hangs. It has a temporary work budget: where a place exceeds it, that place, and the checks that
need what it would have found, are checked when the script runs, with a compiler warning there. Every other use, also
of the same variable or function, is still checked at compile time, and a known violation of a rule stays a compile
error. A shape that is very unrealistic for a real script, now or in the future, stops with a compile error instead,
the one case in which code that meets the rules does not compile; the limit leaves generous room above realistic
scripts, also larger future ones.

### Implicit conversions

`integer` to `number` is the only implicit type conversion: an integer may be stored where a number is expected, and
arithmetic on an integer and a number gives a number. Literal spelling decides the numeric type: `2` is an `integer`,
while `2.0`, `.5`, and `1e3` are `number` values. A variable without a type that one of its assignments gives a
non-whole number is a `number`, and so are its elements and properties ([§12](#12-variable-declarations)); a declared
type is not widened.

```text
let ratio: number = 3                 // valid
let count: integer = 2.0              // compile error: 2.0 is a number
let count: integer = 10 / 4           // compile error: a quotient is a number
let count: integer = floor(10 / 4)    // valid
```

Every other change of type is explicit:

- Text and numbers never convert into each other. A number becomes text through interpolation, as in `"${count}"`.
- Booleans and numbers never convert into each other.
- A number never becomes an `integer` by itself; `round`, `floor`, or `ceil` makes it whole.
- A duration needs a unit: `let pause: duration = 5`, `pause = 10`, and `pause + 5` are compile errors that suggest
  `5 s`. So does a number where a command expects a time, as in `wait 5`, `timer 10`, `timeout: 30`, `say "x", 3`, or
  `startAt: 30`. A number never counts as seconds ([§27](#27-timers),
  [ADR 0026](../decisions/0026-unified-time-semantics.md#8-explicit-units-for-time-quantities)).

Values become visible text in `${...}` and `say` as described in [§8](#8-strings-and-interpolation).

### Type conversion

The protected conversion functions are:

```text
toString(value)
toNumber(value)
toInteger(value)
toBoolean(value)
toDate(value)
toTime(value)
toDateTime(value)
toAbsoluteDateTime(value)
```

The date and time conversions read strict ISO text; see [§35](#35-date-time-and-durations).

A conversion that cannot succeed raises a runtime error. A caller may provide an explicit fallback:

```text
let amount = toNumber(text, default: 0)
```

When the compiler can prove that a conversion is invalid, it reports a compile error instead, also when a `default:`
is given:

```text
toNumber("hello") // compile error
```

Values obtained from input, storage, files, network data, or another runtime expression are not known during
compilation and are validated at runtime. When such a value is stored in a variable, list or set element, dict value,
object property, parameter, or function result whose type is known, the runtime checks the value before storing it; a
value that does not fit is runtime error `TSR058`, which names the place and the value. An `integer` place takes any
whole number, including a stored `2.0`, because the runtime does not keep a number's spelling. A list, set, or dict
fits when every element or value fits, and an object fits when each known property that it has fits.

`toString`, `toNumber`, `toInteger`, and `toBoolean` convert these values:

| Conversion | Converts | Result |
| --- | --- | --- |
| `toString(value)` | text, numbers, `true` and `false`, `null`, durations, angles, date and time values, script references, and regexes | the same text as `"${value}"` |
| `toNumber(value)` | numbers, and number text | a `number` |
| `toInteger(value)` | numbers, and number text | an `integer` |
| `toBoolean(value)` | `true` and `false`, and the text `"true"` or `"false"` | a `boolean` |

- Number text is what `askNumber` accepts: an optional sign, digits with an optional decimal point, and an optional
  exponent, such as `2.5`, `-3`, `.5`, or `1e3`. Surrounding whitespace is ignored, also around `"true"` and `"false"`.
  Other text, such as `"2,5"`, `"ten"`, or a number too large to represent, cannot be converted.
- No other value can be converted: `toNumber(true)` and `toBoolean(1)` are errors, and a list is combined into text with
  [`join`](#16-lists).
- A `default:` value has the conversion's result type or is `null`, as every `default:`
  ([§18](#defaults-follow-the-same-rule)): an `integer` may be the default of `toNumber`, and `default: null` makes the
  result optional. The default is evaluated only when the value cannot be converted.

`toInteger` discards the fractional part toward zero:

```text
toInteger(2.7)    // 2
toInteger(-2.7)   // -2
toInteger("2.7")  // 2
```

Use `round`, `floor`, or `ceil` when that rounding intent is required explicitly. Each takes one number and returns an
`integer`. `round` returns the nearest whole number; a value exactly halfway between two whole numbers rounds away from
zero. `floor` rounds toward negative infinity and `ceil` toward positive infinity, so they have no tie case:

```text
round(2.4)   // 2
round(2.5)   // 3
round(-2.5)  // -3
round(0.5)   // 1
round(-0.5)  // -1
floor(-2.5)  // -3
ceil(-2.5)   // -2
```

`min(...)` and `max(...)` return the smallest or largest of two or more values, or of the values of one list
([§16](#statistics)), which are all numbers, all durations, all calendar durations of one family, all angles, or all
date and time values of one kind ([§35](#35-date-time-and-durations)). The result is an `integer` when every argument is
an `integer`, a `number` otherwise, and for durations, angles, and date and time values the chosen value itself. Mixing
numbers, durations, calendar durations or their families, angles, or temporal kinds, other values, `null`, and named
arguments are compile errors when the types show them, and runtime errors otherwise:

```text
let minutes = min(20, 5 + punishments)
let pause = max(1 minute, remaining)
let boundedLevel = max(1, min(level, 10))
```

### JSON and Base64
**Status:** Accepted (Owner decision, 2026-10-13; the expected type and defaults: owner decisions, 2026-10-19 and
2026-10-20)

These protected functions exchange data with other programs as text:

```text
toJson(value)
fromJson(text, default: value)
toBase64(text)
fromBase64(text, default: value)
```

`toJson` and `fromJson` also take `files:`, `true` or `false`, `true` by default.

`toJson` writes a value as compact JSON text:

| Value | JSON |
| --- | --- |
| text, `integer`, `number`, `true` and `false`, `null` | the same |
| list, set | an array, a set in its order |
| dict, object | an object, in key order |
| `date`, `time`, `datetime` | ISO text, as `.toISO()` gives it |
| `absoluteDateTime` | ISO text in UTC, ending in `Z` |
| `duration` | its number of milliseconds |
| `angle` | its number of degrees |
| `speaker` | an object with a copy of its properties |

A `calendarDuration`, `range`, `script`, `regex`, `timer`, `media`, `messageHandle`, or permanent button cannot be
written: that is a compile error where the types show it, and a runtime error otherwise.

`fromJson` reads JSON text. An object becomes a dict in the order of its keys, or an object when the expected type is
one (below), an array a list, and text, numbers, `true`, `false`, and `null` stay what they are; a whole number
becomes an `integer` and any other number a `number`. A key that appears more than once keeps its first position with
its last value, as in a dict ([§40](#40-dictionaries)). A date or time comes back as text, which `toDate`, `toTime`,
`toDateTime`, and `toAbsoluteDateTime` read.

The result has an expected type: the written type of the place the call's value lands in directly
([§18](#defaults-follow-the-same-rule)). Without a written target, it comes from the default: `default: []` gives a
list whose element type is not settled yet, and `default: null` leaves the value's type unknown, to be tested with
`is`. A default that does not fit a written target is a compile error. Text that is not JSON, and JSON of the wrong
shape for the expected type, give the default; in debug or test mode, a developer warning reports a fallback that JSON
of the wrong shape caused.

An object default, or an expected object type, reads the JSON as that object: the result is an object whose properties
have the default's types, so their uses are checked at compile time. The runtime checks the JSON once when it is read: a
missing key takes that property's value from the default, and so does a key whose value has the wrong type; in debug
or test mode, the developer warning names the key. Extra keys are ignored, and nested objects follow the same rules
inside. Malformed text, or JSON of another kind than the default, such as a list or text where the default is an
object, gives the whole default. A property that is `null` in the default and gets no type anywhere else in the script
stays unknown, to be tested with `is` before use, as with `default: null`; there is no warning. A dict
default, or a written dict type, gives a dict.

```text
let tasks: string[] = fromJson(saved, default: [])      // a string[]; JSON that is not a list of text gives []
let count = fromJson(text, default: 0)                  // an integer
let preset = fromJson(text, default: null)              // unknown: test it with is
if preset is dict {
    say "${preset.length} settings"
}
let settings = fromJson(text, default: { volume: 5, muted: false })
say settings.volume + 1                                 // valid: volume is an integer
let lookup = fromJson(text, default: dict{})            // a dict
let level: integer = fromJson(text, default: "none")    // compile error: the default does not fit integer
```

`toBase64` encodes text as UTF-8 in standard Base64, with padding and without line breaks. `fromBase64` decodes Base64
into UTF-8 text. It ignores spaces and line breaks, accepts the URL alphabet (`-` and `_` instead of `+` and `/`), and
does not need the padding.

`fromJson` and `fromBase64` need their `default:`; a call without one is a compile error. The default of `fromBase64`
is text or `null`, or of another type only where a written union holds both ([§18](#defaults-follow-the-same-rule)).
Text that is not Base64, or whose bytes are not UTF-8, gives the default, and neither call gives a runtime error for its
text. The default is evaluated last, and only when it is used (owner decision, 2026-10-16).

```text
let plain = fromBase64(text, default: "")                   // text
let maybeText = fromBase64(text, default: null)             // text or null
let wrong = fromBase64(text, default: 0)                    // compile error: no written union holds text and 0
let mixed: string | integer = fromBase64(text, default: 0)  // valid: the written union holds both
```

```text
let shared = "-----BEGIN CORNERTIME CUSTOM PUNISHMENT-----\n${toBase64(toJson(preset))}\n-----END CORNERTIME CUSTOM PUNISHMENT-----"
let decoded = fromJson(fromBase64(text, default: ""), default: null)
```

**Files (Owner decisions, 2026-10-13):** with files, `toJson` writes every stored file reference, of a photo or of a
file from `fileFromBase64` ([§33](#stored-files)), as a data URL, `data:<type>;base64,…`, with the type its bytes give.
`fromJson` turns data URLs back into stored files and gives their references; only a data URL whose bytes are of an
image, audio, or video type of [§33](#stored-files) becomes a file, and any other data URL stays text. `files: false` keeps references
in `toJson` and data URLs in `fromJson` as text. A package path such as `"images/a.jpg"` and any other text are never
embedded or converted: a text is a stored file reference only when the session knows it as one, never by its shape.
`toJson` and `fromJson` wait briefly for the Player's file store only when files are involved.

```text
let exported = toJson(preset)                     // its photos as data URLs
let imported = fromJson(exported, default: null)  // stored files again
let plain = toJson(preset, files: false)          // references stay text
```

### Hashes
**Status:** Accepted (Owner decisions, 2026-10-13)

```text
hashText(text)
hashFile(file)
```

`hashText` gives the SHA-256 of a text's UTF-8 bytes and `hashFile` the SHA-256 of a stored file's bytes
([§33](#stored-files)), as 64 lowercase hexadecimal characters, the usual notation, so that a hash can be compared with
the one another program, such as `sha256sum`, gives. They hash only text and files; any other value goes through
`toJson` first, as in `hashText(toJson(settings))`.

`hashText` gives its result at once. A lone surrogate counts as U+FFFD, as in `toBase64`. `hashFile` hashes the stored
files that `fileToBase64` reads, and fails where `fileToBase64` fails: for another value, also a package path such as
`"images/a.jpg"`, and for a file that the Player can no longer read. Reading the file takes a short wait, and the result
is recorded as that of `fileToBase64`: a restore or a replay can reuse a recorded result without asking the store again.

```text
// A secret answer or a keyholder's code: the script holds its hash, not the code itself.
let code = askText("The code from your keyholder")
if hashText(code) == "45d227c4b297a0ba4ce42738ad3d448e19628a5ecfd509ea861b24a23009d08e" {
    say "Released."
}

// Whether a file has changed: its hash against the one saved last time.
let image = askImage("Show me your corner")
let hash = hashFile(image)
if hash == load("cornerHash", default: "") {
    say "That is the same photo as last time."
}
save hash as "cornerHash"
```

A hash hides a secret only when the secret has many possible values. A number from 1 to 1000 can be found by hashing all
of them. A value that the script chooses itself with `random` can be recovered from the save, because the session's
random generator is deterministic.

### Encryption
**Status:** Accepted (Owner decisions, 2026-10-13 and 2026-10-14)

```text
encryptText(text, password: text, publicKey: keys, timeLock: moment)
encryptFile(file, password: text, publicKey: keys, timeLock: moment)
decryptText(text, password: text, key: text, default: value)
decryptFile(file, password: text, key: text, default: value)
```

`encryptText` locks text and gives the lock as Base64 text, and `decryptText` opens such text and gives the text it
locked. `encryptFile` locks a stored file ([§33](#stored-files)) and gives the locked file's reference, and
`decryptFile` opens a locked file and gives a stored file whose type its bytes give again. The content is encrypted once
with AES-256-GCM under a new random key, and each way to open the lock, an opener, holds its own copy of that key: any
one opener opens it ([`ENCRYPTION.md`](../ENCRYPTION.md)).

- `password:` opens with exactly the text it is given. Written directly as `password: askPassword(...)`, also in
  parentheses, it asks for the password in the Player's password field ([§20](#password-input)), and the typed password
  never becomes a script value: an encrypt call's field asks for it twice, the second time as "Repeat password", and
  locks only when both match; a decrypt call's asks once. The question is said where `password:` stands among the
  arguments, and the field opens when the call locks or opens.
- `publicKey:`, a public key or a list of them, each an age recipient (`age1…`) or an OpenSSH Ed25519 key
  (`ssh-ed25519 AAAA…`), locks the key in a standard age file that only the matching private key opens. The owner of
  the private key, a keyholder for example, opens it with the `age` tool and sends back the unlock key it holds, 44
  characters of Base64, which opens the lock as `key:` of a decrypt call or in the Player's dialog
  ([`ENCRYPTION.md`](../ENCRYPTION.md#for-the-owner-of-the-private-key)). A lock holds at most 594 public keys. Text
  that is no such key is an error, at compile time where it is written.
- `timeLock:`, a moment (`absoluteDateTime`), is a time lock, a lock that cannot open before a set time: from that
  moment anyone can open the lock with it, also long after, and before it the time lock opens nothing, while another
  opener may. The Player fetches the drand network's proof of that moment to open it. A moment in the past opens at
  once. When the Player can reach the drand network while it locks and the device's clock is behind drand's time, the
  moment moves later by as much.

Each of these options also takes `true` or `false`. A value is used as given, without asking; `true` lets the player
set that opener in the Player's lock dialog, and `false` leaves it out, so `timeLock: false` gives no time lock at all.
A call without any of them lets the player set each, as if each were `true`. A call that gives one of them must give
each, or it does not compile. A call whose options are all `false` has no way to open: an error at compile time where
they are written, or when the call runs. **Without a time lock, the content never opens once its password and every
private key that opens it are lost.**

```text
let locked = encryptFile(photo)                                                  // the player chooses
let locked = encryptFile(photo, password: "corner", publicKey: false, timeLock: false)       // only the password
let locked = encryptFile(photo, password: askPassword("Choose a password"), publicKey: false, timeLock: false)
let locked = encryptFile(photo, password: false, publicKey: veraPublicKey, timeLock: false)  // only Vera's key
let locked = encryptFile(photo, password: false, publicKey: false, timeLock: getAbsoluteDateTime() + 3 days)
let locked = encryptFile(photo, password: true, publicKey: true, timeLock: friday)  // the player may add openers
```

The lock dialog shows only the openers that are `true`. Its time lock is suggested 7 days ahead, and the player may move
it to another moment in the future or switch it off; its password is typed twice; and its public keys are pasted one per
line. It locks once the lock has an opener, also one the call gives, and while no time lock would open the lock, it
warns that the content never opens once the password and the private keys are lost.

`decryptText` and `decryptFile` need their `default:`, which is text or `null`, as every `default:` has the call's
result type or is `null`, or of another type only where a written union holds both
([§18](#defaults-follow-the-same-rule)); a call without one is a compile error. A wrong
password, a changed lock, text that is not a lock, a time lock whose moment has not come, and a cancelled dialog give
the default, never a runtime error. The default is evaluated last, and only when it is used (owner decision,
2026-10-16). With `password:` or `key:` a call tries only those. Without them, a lock whose time lock has passed opens
without asking; otherwise the Player asks the player with what opens this lock: a password; for a public key, the unlock
request to copy or download for the owner of the private key and a field for the unlock key they send back; and the
moment its time lock opens. A wrong password or key in that dialog lets the player try again, and Cancel gives the
default. When the time lock has passed but the Player cannot reach the drand network, the dialog offers to try again,
and without another opener the call gives the default.

```text
let photo = decryptFile(locked, password: "corner", default: null)
let photo = decryptFile(locked, password: askPassword("Password"), default: null)
let photo = decryptFile(locked, key: unlockKey, default: null)
let photo = decryptFile(locked, default: null)        // opens if its time has passed, otherwise the Player asks
```

`decryptText` reads the Base64 as `fromBase64` does ([§13](#json-and-base64)), so a lock survives being copied through a
chat, and gives the default for a lock whose content is not UTF-8 text. The file calls take the stored files that
`fileToBase64` reads and fail where it fails ([§33](#stored-files)), and every call fails with a runtime error where the
browser cannot encrypt at all, as on a Player page without https.

Each call waits for the Player, and its result is recorded: a restore or a replay reuses it without the network, the
file store, the password, or the key. The Player's dialogs and password fields are interactions, which a timer's expiry
block interrupts ([§27](#27-timers)): they ask again once it returns, without what was typed and not yet given. The
short step that locks or opens is not interrupted; a due block runs once it is done. What the player types in a dialog
or password field never becomes a script value.

### Numeric functions
**Status:** Accepted (Owner decision, 2026-10-07; `pow` always returns a `number`: Owner decision, 2026-10-22)

These functions take numbers and return a number:

| Function | Result |
| --- | --- |
| `abs(value)` | the distance from 0: `abs(-2.5)` is `2.5` |
| `sign(value)` | `-1`, `0`, or `1` |
| `sqrt(value)` | the square root |
| `pow(base, exponent)` | the base raised to the exponent |
| `mod(value, divisor)` | the remainder with the sign of the divisor: `mod(-1, 3)` is `2`, where `-1 % 3` is `-1` |
| `clamp(value, min, max)` | the value, raised to `min` or lowered to `max`: `clamp(15, 1, 10)` is `10` |
| `round(value, decimals: n)` | the value rounded to `n` decimal places |

`pi` is the number π, `3.141592653589793`. Like the functions, it is a protected name ([§38](#protected-engine-names)).

```text
pow(2, 10)                       // 1024
pow(10, -2)                      // 0.01
pow(8, 1 / 3)                    // 2
round(2.675, decimals: 2)        // 2.68
round(pi * 2 * 2, decimals: 2)   // 12.57
```

- `abs`, `mod`, and `clamp` return an `integer` when every argument is one, and `sign` always does. `sqrt`, `pow`, and
  `round(value, decimals: n)` return a `number`, also when the result is whole. `round`, `floor`, or `ceil` makes
  another result whole, as in `round(pow(side, 2))`.
- `round(value, decimals: n)` rounds the number as it is written, a half away from zero, to `n` decimal places, a whole
  number of at least 0: `round(2.675, decimals: 2)` is `2.68`, although the nearest binary number to 2.675 lies slightly
  below it. Without `decimals:`, `round` returns an `integer` as described above.
- A call without a result fails: `sqrt` of a negative number, `pow` of 0 to a negative exponent, `pow` of a negative
  base to an exponent that is not whole, a `pow` result too large to represent, `mod` by 0, `clamp` with `min` above
  `max`, and `decimals:` that is negative or not whole. It is a compile error when the compiler can see the arguments
  that cause it, also beside arguments it cannot see, as in `clamp(level, 10, 1)`, and otherwise runtime error `TSR036`
  for a result that is not a finite number and `TSR039` for an argument out of range. A `pow` result too small to
  represent is 0.
- Every argument is a number. Other values, `null`, another number of arguments, and other named arguments are compile
  errors when the types show them, and runtime errors otherwise.
- `sqrt` and `pow` give the same result on every device and browser.
- Considered and left out: the operators `**` and `^`, the constant `e`, `log(x, base)`, hyperbolic functions,
  factorial, `gcd`, bitwise operations, and general number formatting.

### Exponentials, logarithms, and angles
**Status:** Accepted (Owner decision, 2026-10-07; angles with a unit: Owner decision, 2026-10-16)

| Function | Result |
| --- | --- |
| `exp(value)` | e raised to the value |
| `ln(value)` | the natural logarithm, for a value above 0 |
| `log10(value)` | the logarithm to base 10, for a value above 0: `log10(1000)` is `3` |
| `sin(angle)`, `cos(angle)`, `tan(angle)` | the sine, cosine, or tangent of an angle |
| `asin(value)`, `acos(value)` | the angle of a sine or cosine from -1 through 1 |
| `atan(value)` | the angle of a tangent, above -90° and below 90° |
| `atan2(y, x)` | the angle of the direction from the origin to the point (x, y), above -180° and up to 180° |
| `toDeg(angle)`, `toRad(angle)` | the size of an angle as a number of degrees or of radians |

An angle is a value of type `angle`: a number with the unit `deg` (`degree`, `degrees`) or `rad` (`radian`,
`radians`), such as `90 deg`, `pi rad`, or `heading deg`. The unit may not touch the number: `90deg` is an error;
write `90 deg`. The unit follows a number, a name, a member, a call, or
parentheses and binds as a duration unit does ([§35](#durations)). `sin`, `cos`, and `tan` take an angle and return
a `number`, `asin`, `acos`, `atan`, and `atan2` return an angle, and `toDeg` and `toRad` return a `number`. `asin`
gives -90° through 90°, `acos` 0° through 180°, and `atan2(0, 0)` is 0°. A plain number where an angle is needed,
as in `sin(90)`, is a compile error that names both units, and a runtime error when the compiler cannot see the
type. `toDeg` and `toRad` take only an angle: give a number its unit first, as in `toRad(180 deg)` or
`toRad(input deg)`.

Angles add, subtract, and negate, multiply and divide by a number, and divide by an angle, which gives a `number`.
They compare by size, so `180 deg == pi rad`, and `min`, `max`, and `sort()` order them by size. `sum` adds angles;
the other statistics functions and the numeric functions such as `abs` and `mod` do not take them. Other
combinations, such as an angle plus a number, are errors. An angle shows in degrees with a degree sign: `say
asin(0.5)` shows `30°`, and `say pi rad` shows `180°`.

```text
sin(30 deg)          // 0.5
cos(pi rad)          // -1
tan(45 deg)          // 1
atan2(1, -1)         // 135°
toDeg(pi rad)        // 180
toRad(180 deg)       // 3.141592653589793
sin(asin(0.5))       // 0.5
log10(0.001)     // -3
round(exp(1), decimals: 5)   // 2.71828
```

- A call without a finite result fails like the other numeric functions: `ln` or `log10` of a number of at most 0,
  `asin` or `acos` of a number outside -1 through 1, `tan` of an odd multiple of 90°, and `exp` of a number too large.
  It is a compile error when the compiler can see the arguments, and runtime error `TSR036` otherwise.
- The results are the same on every device and browser, because the engine computes them with its own arithmetic
  instead of the browser's. They are the nearest number to the exact result in all but extremely rare cases. Exact
  angles give exact results, such as `sin(30 deg)` and `cos(90 deg)`, and `log10` of a power of ten as written, such as
  `0.001`, is exactly that power.

## 14. Scope
**Status:** Accepted

`let` uses lexical block scope.

```text
if hasKey {
    let message = "The door opens"
    say message
}

say message // error
```

Rules:

- A variable exists in its declaring block and nested blocks.
- A nested block may not redeclare a name visible from an outer scope.
- A nested block may modify a visible outer variable.
- Separate sibling blocks may declare the same local name.
- Top-level variables and functions belong to their file. A global ([§12](#global-variables)), a global function
  ([§11](#global-functions)), and a speaker ([§37](#37-dynamic-speaker-terms)) are visible in all files.

```text
if firstCondition {
    let message = "First"
}

if secondCondition {
    let message = "Second"
}
```

### Variables in timer, media, and button blocks
**Status:** Accepted (Owner decision on #627, 2026-10-05; [ADR 0024](../decisions/0024-shared-block-variables.md))

A timer expiry block, media block, or permanent button block uses the variables around it like any nested block: the
globals, the top-level variables of its file, and the parameters and local variables, including loop variables, of the
code that creates it. It shares them with that code: one variable, not a copy, so an assignment in either is seen by the
other at its next read.

```text
function challenge {
    let stop = false
    showPermanentButton "Stop" {
        stop = true
    }
    while not stop {
        wait 5 s
    }
}
```

- A block sees the variables visible where it is created, not one declared later. Its own `let` may not reuse the name
  of a variable it sees.
- Each function call, each loop iteration, and each run of a loop body has its own variables:
  `for name in names { showPermanentButton name { say name } }` gives each button its own `name`, and two calls of
  `function offer(n: integer) { showPermanentButton "Add" { n += 1 } }` count separately. A variable declared before a
  loop is one variable for every button the loop shows.
- A block inside a block shares the same variables. A block's own `let` is new each time the block runs.
- A variable lives while a timer, media, or button or a queued or running block uses it, also after its function
  returned or its file entry was left ([§29](#29-script-files-and-paths)). A block that already runs keeps its
  variables when its resource stops or is removed.
- Assigning a shared variable cancels nothing: a running `wait` or question completes first. A value read before it is
  stored as it was, so in `x += askInteger "Add?"` a click that sets `x` meanwhile is overwritten. Use `exit` to end at
  once.
- Assignment still copies values ([§12](#12-variable-declarations)): after `let b = a`, a block that changes `a` does
  not change `b`.
- A block that shares a constant cannot change it ([§12](#constants)).
- A function called from a block sees its own variables and those of its file, never those of the block.

## 15. Objects
**Status:** Accepted

Object literals use named properties:

```text
let door = {
    name: "main door",
    locked: true
}
```

Properties use dot access:

```text
say door.name
door.locked = false
```

Properties have fixed names, so an object is not indexed: `door[name]` is a compile error that points to a dict for
lookup by a name known only at runtime ([§40](#40-dictionaries)), and `door["name"]` to `door.name`.

A property behaves like a variable: the object literal declares it once, with a start value, and after that it can be
changed anywhere, also inside `if` and functions. It keeps the type of its literal's value
([§12](#12-variable-declarations)); an `integer` property becomes a `number` when one of its assignments can store a
non-whole number. Storing a property that the literal lacks is a compile error that points to the literal, or to a dict
for names known only when the script runs ([§40](#40-dictionaries)). `null` in the literal means "not known yet";
reading such a property then needs a check or `otherwise` ([§18](#18-null-and-optional-values)):

```text
door.locked = "yes"    // compile error: locked holds true or false (boolean)
door.color = "red"     // compile error: the literal of door has no color; add it there, or use a dict
let shed = { name: "shed", locked: false }
if windy { shed.locked = true }
say shed.locked
let box = { label: "spare", owner: null }
say box.owner otherwise "nobody"
```

Objects with different property names may share a place, such as the elements of one list, or a variable that gets
another object: `[{ value: "spank", text: "Spanking" }, { text: "Corner" }]` for `askChoice` ([§19](#19-choices)), or
`room = { name: "hall" }` after `let room = { name: "shed", locked: false }`. The properties they share must have the
same type. Storing a property never adds it to an object whose literal lacks it. Speakers keep their own rule: a custom
property is declared in the speaker block or by its first unconditional assignment
([§37](#extensible-character-state)).

Reading or storing a property, also with `+=` or `-=`, that no object in that place has is a compile error that names
the properties it can have. A read or a store that may reach an object without that property is checked when the
script runs, as is one on an object that may come from a value the compiler cannot know, such as stored data or an
`object`:

```text
say door.colour                    // compile error that names name and locked
let rooms = [{ name: "shed", locked: false }, { name: "hall" }]
say rooms[i].locked                // compiles, and fails when the script runs if rooms[i] is the hall
let hall = { name: "hall" }
hall.locked = true                 // compile error: the literal of hall has no locked
let values = [{ a: 1 }, { a: "x" }]  // compile error: a holds an integer and text
```

Two objects are equal (`==`) when they have the same property names with equal values, in any property order. A
property set to `null` differs from a missing property:

```text
{ name: "door", locked: true } == { locked: true, name: "door" }  // true
{ name: "door" } == { name: "door", locked: null }                // false
```

Custom structured type declarations are not required in the initial language. Advanced developers may extend the engine through TypeScript libraries.

## 16. Lists
**Status:** Accepted

List literals keep commas between elements:

```text
let items = ["key", "map", "potion"]
```

```text
let names = [
    "pet",
    "puppy",
    "toy"
]
```

Indexing starts at `0`:

```text
let firstItem = items[0]
```

List methods:

```text
items.add("sword")
items.addAll(other)
items.remove("key")
items.removeAt(1)
items.removeFirst()
items.removeLast()
items.clear()
items.sort()
items.shuffle()
items.reverse()
items.contains("map")
items.indexOf("map")
items.lastIndexOf("map")
items.count("map")
items.get(1, default: "none")
items.join(", ")
items.intersection(other)
items.union(other)
items.difference(other)
items.take(3)
items.takeLast(3)
```

`removeAt`, `removeFirst`, and `removeLast` return the removed element; the result may be ignored:

```text
let next = tasks.removeAt(0)
let newest = tasks.removeLast()
```

`items.join(separator)` returns the elements as text, separated by the text `separator`, which defaults to `", "`:
`["pet", "puppy"].join()` is `"pet, puppy"`. Use `${items.join()}` to show every element where `${items}` selects one.
Elements may be text, numbers, `true` or `false`, `null`, durations, angles, date and time values, script references,
and regexes, shown as `${...}` shows them; any other element raises an error.

List properties:

```text
items.length
items.first
items.last
items.random
```

`items.random` explicitly selects one element using the deterministic session RNG. It works for value lists and object lists:

```text
let chosenName = playerProfile.petNames.random
let stranger = speakers.random
```

A list holds at most 1,000,000 elements, a set 1,000,000 members, and a dict 1,000,000 keys; an operation that would
make one longer is runtime error `TSR088` (owner decision, 2026-10-17).

### Lists in text

Interpolation is the only place where a list turns into one random element. Each `${...}` evaluation selects one
element with the deterministic session RNG:

```text
say "Good ${playerProfile.petNames}"
say "Come closer, ${playerProfile.petNames}"
```

The two evaluations may choose different elements. Replay and debugging reproduce the same session sequence.

An interpolated list may contain any value that `${...}` shows on its own: text, numbers, `true` and `false`, `null`,
durations, angles, date and time values, script references ([§29](#29-script-files-and-paths)), and regexes. A list holds one element type ([§12](#12-variable-declarations)), and integers and
numbers together are numbers. The selected element is shown as that value would be:

```text
let waits = [30 seconds, 90 seconds]

say "Wait ${waits}"  // for example "Wait 1 minute 30 seconds"
```

A list that holds values of different types needs a declared union element type ([§13](#13-explicit-types)):

```text
let values: (string | number | duration)[] = ["Level", 2, 3.5, 90 seconds]

say "Current: ${values}"  // for example "Current: 1 minute 30 seconds"
```

The whole list is checked before the selection, so a list that also contains a list, a set, an object, or a media or
resource reference is rejected whichever element would have been selected. Object lists remain valid lists; select from
them explicitly:

```text
let stranger = speakers.random
```

`say` is also a debugging aid for whole values. Like Python's `print`, it shows text, numbers, `true` and `false`,
`null`, durations, angles, and date and time values as it does on their own, and every other value in a code-like
notation:

```text
let petNames = ["pet", "puppy", "toy"]
say petNames                   // ["pet", "puppy", "toy"]
say "Good ${petNames}"         // one random element
say [2.5, 3, null]             // [2.5, 3, null]
say [["a"], ["b"]]             // [["a"], ["b"]]
say [{ name: "Bo", age: 3 }]   // [{ name: "Bo", age: 3 }]
say { name: "Bo" }             // { name: "Bo" }
say dict{ collar: "leather" }  // dict{ "collar": "leather" }
say ["He said \"hi\""]         // ["He said \"hi\""]
say []                         // []
say [90 seconds]               // [1 minute 30 seconds]
say 1..=5                      // 1..=5
say mistress                   // <speaker mistress>
say music                      // <media "music.mp3", playing at 12 seconds>
say beat                       // <timer "Beat", 7 seconds left>
```

In this notation, text is quoted with the string escapes of [§8](#8-strings-and-interpolation), a duration or an angle
shows as it does on its own, a set shows like a list, an object shows its properties in order, a dict shows its quoted
keys and values in order, and a range shows as written. A speaker shows its identifier. A media handle shows its file
and state: `playing at` or `paused at` its position, `stopped`, or `finished`. A timer handle shows its label when it
has one and its state: the time left (after `paused,` when paused), `stopped`, or `finished`. A permanent button
identifier shows the button's text, `<permanent button "Stop">`, or `<permanent button, removed>`. Handles show the
state at the moment `say` runs. Message markup is not applied to the notation.

Other text fields, such as a button label, an ask question, an input hint, the `text` of a choice object, a timer label,
or a speaker's name or title, do not select from a list. A list there is a compile error when the compiler can see it,
such as a list literal or a variable that holds a list, and a runtime error otherwise; the message points to `"${list}"`
and `list.random`. Another value a text field cannot show, such as an object or a range, is likewise a compile error
when the compiler can see it. A list as a whole `askChoice` option instead gives one button per element
([§19](#19-choices)).

To choose a specific element, use its index:

```text
say playerProfile.petNames[0]
say "Today I will call you ${playerProfile.petNames[1]}"
```

To reuse one random choice, select it explicitly and store the resulting value:

```text
let chosenName = playerProfile.petNames.random

say "From now on, you are my ${chosenName}"
say "Come here, ${chosenName}"
```

Normal assignment does not perform random selection:

```text
let copiedNames = playerProfile.petNames
```

This assigns a list copy. List assignment uses copy semantics rather than a shared reference:

```text
let copiedNames = originalNames
copiedNames.add("new")
```

`originalNames` remains unchanged. Changing a value that no variable holds, such as `obj().n = 5` or `[1, 2][0] = 3`,
is a compile error, because the change would be lost with the copy; a speaker returned by a call is changed itself
(owner decision, 2026-10-16).

Interpolation is deliberately not a general list-to-string conversion. Paths, storage keys, URLs, media references,
resource references, ordinary type inference, and other program-control values never select from a list:

```text
goto (scriptTargets)
load storageKeys
openUrl(urls)
playVideo videos
```

Those examples require an explicit element or `.random` where the receiving API permits the selected element type.

Runtime behavior:

- An invalid index raises a runtime error rather than returning `null`; `get(index, default: value)` gives a default
  instead ([§16](#reading-an-element-with-a-default)). The compiler reports an index that it can see is negative or not
  a whole number, such as `items[-1]` or `items.removeAt(0.5)`.
- Interpolating an empty list raises a runtime error because no element can be selected.
- The empty-list error identifies the interpolated expression and explains that interpolation needs at least one
  element to select from.
- A value `${...}` cannot show, or a list literal inside it that is empty or holds such a value, is a compile error
  when the compiler can see it.
- Two lists are equal (`==`) when they have the same length and equal elements in the same order; two sets are equal
  when they have the same members in any order; two ranges are equal when they are written with the same bounds and
  the same inclusiveness, so `1..=2 != 1..3` although both produce `1` and `2`. Values of different kinds, such as a
  list and a set, are never equal. List `contains(value)`, `indexOf(value)`, `lastIndexOf(value)`, `count(value)`, and
  `remove(value)` use this equality, so they also find objects and nested lists; `remove(value)` removes the first
  equal element.
- A set may hold any value a list may hold: text, numbers, `true` and `false`, `null`, durations, angles, date and time
  values ([§35](#35-date-time-and-durations)), lists, objects, dicts, sets, ranges, speakers, timer and media
  handles, script references, and regexes. Collections nest in every direction, such as sets of lists, sets in dicts, and lists in lists. A set keeps
  the first of members that are equal (`==`), in insertion order, so `set[[1, 2], [1, 2]]` has one member, and its
  `contains(value)` and `remove(value)` use the same equality. A member is copied when it is added, and `.first`,
  `.last`, `.random`, and a `for` loop give copies, so changing one does not change the set.
- The operands of `==` and `!=` are read when they are evaluated, left to right, so a change made while evaluating the
  right operand does not affect the left one: `items == [items.removeAt(0)]` is `true` for `items = [1]`.
- `remove(value)` leaves the list unchanged when the value is absent and emits a warning to the developer log.
- `removeAt(index)` removes the element at a zero-based index and moves later elements forward. An invalid index
  raises the same runtime error as indexing.
- `removeFirst()` and `removeLast()` on an empty list raise a runtime error, like `.first` and `.last`. Reading an
  element of a list that the compiler can prove is empty at that read is a compile error
  ([§13](#compile-errors-warnings-and-checks-when-the-script-runs)); a list that may be empty keeps the runtime error.
- `add(value)`, `addAll(other)`, `remove(value)`, `clear()`, `sort()`, `shuffle()`, and `reverse()` return `null`.
  Set `remove(value)` of an absent value is a no-op: the set stays unchanged and execution continues without an error
  or warning.
- Mutating methods change the existing list.
- `sort()` orders a list in place, ascending and stable. Its elements must all be numbers (integers and numbers
  together), all text, all durations, all calendar durations of one family, all angles, or all dates, all times, all
  datetimes, or all absolute dates and times
  ([§35](#35-date-time-and-durations)); text is ordered by Unicode code point, independently of locale, so
  `"B"` sorts before `"a"`. Other or mixed elements are a compile error when the element type shows them, and a runtime
  error otherwise.
- `shuffle()` puts a list in a uniformly random order in place with the deterministic session RNG. The number of random
  draws depends only on the length, so replay and checkpoint resume reproduce the order; a list of fewer than two
  elements draws nothing.
- `reverse()` puts a list's elements in reverse order in place (owner decision, 2026-10-13).
- Sets keep their insertion order and have no `sort()`, `shuffle()`, or `reverse()`; copy a set into a list with
  `toList()` first.
- `intersection(other)`, `union(other)`, and `difference(other)` return a new collection of the receiver's kind and
  leave both operands unchanged. `other` may be a list or a set. The result holds each element once, in the receiver's
  order: `intersection` keeps the elements also in `other`, `difference` the elements not in `other`, and `union` all
  elements followed by the new elements of `other` in its order. Elements compare with `==`. `union` holds the element
  types of both, as a list literal of both would; `intersection` and `difference` keep the receiver's element type:

```text
let mine = ["collar", "gag", "cuffs"]
let yours = ["cuffs", "collar", "rope"]

mine.intersection(yours)  // ["collar", "cuffs"]
mine.union(yours)         // ["collar", "gag", "cuffs", "rope"]
mine.difference(yours)    // ["gag"]
```

- `a + b` on two lists returns a new list of copies of `a`'s elements followed by `b`'s, keeping duplicates (unlike
  `union`), and leaves both unchanged; its element types join as for `union`, and `items += more` stores it in `items`.
  `items.addAll(other)` appends copies of the elements of the list `other` to `items` itself, each as `add` would. To
  join a set, use `union`, or copy it into a list with `toList()` first:

```text
let menu = ["Back"] + options     // a new list; options is unchanged
queue.addAll(nextRound)           // queue itself grows
```

- Recoverable index and empty-selection errors follow the runtime recovery rules described later in this document.

### Parts of a list
**Status:** Accepted (Owner decision, 2026-10-07)

`take(count)` and `takeLast(count)` return a new list of the first or the last `count` elements, in order, and leave
the list unchanged. A count beyond the length gives the whole list. The count is a whole number of at least 0; another
count is a compile error when the compiler can see it, and runtime error `TSR057` otherwise. A rolling window keeps only
the newest values:

```text
let recent: integer[] = load("pushups", default: [])
recent.add(count)
save recent.takeLast(20) as "pushups"
```

### Finding a value in a list
**Status:** Accepted (Owner decision, 2026-10-12)

`indexOf(value)` and `lastIndexOf(value)` return the index of the first or the last element equal (`==`) to `value`,
or `null` when no element is. Their result is an `integer?`, so an index is checked before it is used as a number
([§18](#18-null-and-optional-values)). `count(value)` returns how many elements are equal to `value`, `0` when none
are. All three leave the list unchanged:

```text
let queue = ["wash", "feed", "walk", "wash"]
queue.indexOf("wash")       // 0
queue.lastIndexOf("wash")   // 3
queue.indexOf("sleep")      // null
queue.count("wash")         // 2

let at = queue.indexOf("feed")
if at != null {
    say queue[at + 1]       // walk
}
```

Sets have none of the three: a set has no indexes, and it holds each member once, so `contains(value)` says what
`count(value)` would.

### Reading an element with a default
**Status:** Accepted (Owner decision, 2026-10-12; the `default:`: owner decisions, 2026-10-19)

`get(index, default: value)` returns the element at `index`, or `value` when the list has no such position: an `index`
that is negative, past the end, or, when the script runs, not a whole number, such as `1.5`, text, or `null`.
`items[index]` still raises its runtime error there, so a mistake stays visible where no default is given. The
`default:` is required and has the element type or is `null`, as every `default:`
([§18](#defaults-follow-the-same-rule)): for a `string[]`, `default: "none"` gives a `string` and `default: null` a
`string?`, and for an `integer[][]`, `default: []` gives an `integer[]`; `default: 0` is a compile error unless the
value lands directly in a place with a written union that holds both. The default types only the result, never the list:
after `let ys = []`, `let v = ys.get(0, default: 0)` makes `v` an `integer` and leaves the element type of `ys` open.
The default is evaluated only when it is used, when the list has no such position (owner decision, 2026-10-16). The
compiler checks the index as for `items[index]`, except that a negative index gives the default: an index that it can
see is not a whole number, such as `0.5`, or may be `null`, is an error.

```text
let deck = ["ace", "king"]
deck.get(1, default: "none")             // "king"
deck.get(2, default: "none")             // "none"
deck.get(-1, default: "none")            // "none"
let card = deck.get(turn, default: null) // a string?, checked before it is used as text
```

Sets have no `get`: a set has no positions, and `contains(value)` says whether it holds a value.

### Statistics
**Status:** Accepted (Owner decision, 2026-10-07)

`sum`, `average`, `median`, `percentile`, and `stddev` describe the values of a list, and `min` and `max` also take one
list ([§13](#type-conversion)):

```text
let scores = [12, 15, 11, 18, 16]

sum(scores)             // 72
average(scores)         // 14.4
median(scores)          // 15
percentile(scores, 25)  // 12
stddev(scores)          // 2.8809720581775866
max(scores)             // 18
```

- The values are numbers or durations, for `sum`, `min`, and `max` also angles, and for `min` and `max` also date and
  time values of one kind
  ([§35](#35-date-time-and-durations)). With `by:`, the values are a property of a list of objects:
  `median(sessions, by: "count")`.
- `percentile(list, p)` is the value that `p` percent of the values lie at or below, for `p` from 0 through 100: in
  ascending order, the value at rank p/100 × (n − 1), between the two nearest values in proportion. `percentile(list,
  50)` is the median, the middle value or the average of the two middle values.
- `stddev` is the sample standard deviation: the square root of the summed squared distances to the average, divided by
  the number of values minus 1.
- `sum`, `min`, and `max` of integers are integers; `average`, `median`, `percentile`, and `stddev` of numbers are
  numbers. Durations give durations, the `sum` of angles is an angle, and `min` and `max` give the chosen value.
- The statistics are computed exactly and rounded once, to the number nearest the exact result, so they are the same
  on every device, also for values that cancel or are very large or very small.
- The statistics take durations, not calendar durations, because a calendar day or month has no fixed length.
- An empty list, and a list of one value for `stddev`, is runtime error `TSR018`. A percentage outside 0 through 100
  is a compile error when the compiler can see it, and runtime error `TSR039` otherwise. Values of other or mixed kinds,
  and a missing `by:` property, are compile errors when the types show them, and runtime error `TSR060` otherwise.

A fair target is one the player reaches in most attempts. `percentile(recent, 10)` is the value that 90% of the recent
attempts reached or beat, so a target there is met about nine times out of ten:

```text
let recent: integer[] = load("pushups", default: [])
if recent.length > 0 {
    let target = round(percentile(recent, 10))
    say "Today: at least ${target} push-ups. You managed that nine times out of ten."
}
```

### Trends
**Status:** Accepted (Owner decision, 2026-10-07)

`linearRegression` fits the straight line that comes closest to the points of a list, by least squares, and `predict`
reads the line at another point:

```text
let laps = linearRegression([62 s, 60 s, 59 s, 57 s])
say "You gain ${-laps.slope} per lap."              // 1.6 seconds
say "Next lap: ${predict(laps, 4)}"                 // 55.5 seconds

let trend = linearRegression(sessions, x: "day", y: "count")
say "About ${round(trend.slope, decimals: 1)} more each day."
let expected = predict(trend, toDate("2026-10-31"))
```

- `linearRegression(list)` takes the list's values as y, numbers or exact durations, at x = 0, 1, 2, and so on. With
  `y:`, the y values are a property of a list of objects, and `x:` names a property for x as well: numbers, or dates,
  datetimes, or absolute dates and times of one kind, measured in days, with a time of day as a fraction of a day. Without `x:`, x is
  the index.
- The result is an object `{ slope, intercept, r2, start }`. `slope` is the change of y per step of x, or per day, and
  is a duration when y is. `intercept` is the line's value at the first point of the list, not at x = 0. `r2`, from 0
  to 1, is the share of the variation of y that the line explains; it is 1 when every y is the same. `start` is the
  first point's x, 0 without `x:`.
- `predict(line, x)` is `intercept + slope × (x − start)`, for an x of the start's kind: a number, or a date and time
  value of the same kind, measured in days.
- Like the statistics, `linearRegression` and `predict` compute exactly and round each result once.
- Fewer than 2 points is runtime error `TSR018`, and points that all have the same x `TSR036`. Values of other kinds,
  `x:` without `y:`, and a `predict` x of another kind than the start are compile errors when the types show them and
  runtime errors otherwise (`TSR060`, and `TSR059` for `predict`).

## 17. Return statements
**Status:** Accepted

Functions may perform actions without returning a value:

```text
function openDoor {
    say "The door opens"
}
```

Return a value:

```text
function calculateDamage(attacker, weapon) {
    return attacker.strength + weapon.power
}
```

Exit without a value:

```text
return
```

Optional return-type annotation follows the parameters:

```text
function calculateDamage(
    attacker,
    weapon
): number {
    return attacker.strength + weapon.power
}
```

`void` is not required for functions without a returned value.

A function's result type comes from its `return` values, so callers keep it like any other value
([§12](#12-variable-declarations)). A recursive call has that result type too: with
`function countdown(n: integer) { if n == 0 { return 1 } return countdown(n - 1) }`, the result is an `integer`, so
`countdown(3).length` is a compile error. Integers and numbers together give a `number`. Returns of different types
are a compile error that names both. A function that can end without returning a value, by reaching its end or
through a bare `return`, returns `null` there, so its result may be `null`. A returned value that depends on a
parameter without a type follows each call ([§11](#11-function-definitions)): `id(1)` is an integer and `id("a")`
text. A returned value of unknown type, such as stored data, makes the result unknown; the other returned values must
still agree.

With a return-type annotation, every returned value must fit the annotation, and a function that can end without a
value needs an optional result type such as `number?`.

## 18. Null and optional values
**Status:** Accepted

`null` represents a missing or cancelled result:

```text
let file = chooseFile()
```

Explicit optional type syntax:

```text
let file: string? = chooseFile()
```

The `:` introduces the explicit type; `?` means the value may also be `null`: `string?` is the union
`string | null` ([§13](#13-explicit-types)).

Advanced authors may check explicitly; the check narrows `file` to `string` inside the block:

```text
if file != null {
    playVideo file
}
```

Using a possibly null value where its non-null type is required, such as `n + 1` with `n: integer?`, is a compile
error; a use with a check on every route that the compiler cannot keep compiles with a warning instead and is checked
when the script runs ([§13](#type-tests-and-narrowing)). The message names the check to write, inside which `n` is an
`integer`, and a fallback ([below](#fallback-with-otherwise)):

```text
'n' may be null. Check it first: if n != null { ... }, or give a fallback: n otherwise 0
```

The fallback is `0` for a number, `""` for text, `false` for a boolean, and `...` for another value. The message names
none for a value that an assignment or a method changes, such as `items` in `items.add(1)`, because a fallback gives a
copy, nor for a handle, such as a timer's. A loaded value can instead get a default, as in `load("level", default: 1)`.

### Fallback with `otherwise`
**Status:** Accepted (Owner decision on #850, 2026-10-12; the fallback's type: owner decisions, 2026-10-19)

`a otherwise b` evaluates `a` once and gives it unless it is `null`; then it evaluates and gives `b`. It does not assign
to `a`. `b` is evaluated only when `a` is `null`, so a fallback that calls a function or asks runs only then:

```text
let start = path.lastIndexOf("/") otherwise -1
say "Hello ${nickname otherwise "pet"}"
let name = nickname otherwise savedName otherwise "pet"
let answer = nickname otherwise askText "Name?"
```

- `b` has the type of `a` without `null`, or is `null`. The result is not `null` unless the fallback can be: with
  `count: integer?`, `count otherwise 0` is an `integer`, and `count otherwise null` stays an `integer?`. A fallback of
  another type is a compile error, also inside `say "${...}"`: `name otherwise 0` on a `string?` is an error, unless
  the value lands directly in a place with a written union that holds both ([below](#defaults-follow-the-same-rule)).
- A chain runs from left to right and gives the first value that is not `null`.
- An operand of `otherwise` that is arithmetic or a range needs parentheses, because the fallback could be meant for
  the value next to it or for the whole operand ([§5](#expression-precedence-and-associativity)). Arithmetic is `+`,
  `-`, `*`, `/`, `%`, a sign before the left operand, as in `-x otherwise 0`, and a range `..` or `..=`. The compile
  error names both readings, with the code as written:

  ```text
  Put parentheses around what 'otherwise' belongs to: '(count otherwise 0) + 1' or 'count otherwise (0 + 1)'.
  ```

- A sign before the fallback can be read only one way, as in `path.lastIndexOf("/") otherwise -1`. `otherwise` binds
  more strongly than comparisons, type tests, `not`, `and`, and `or`, so `nickname otherwise "pet" == "pet"` compares
  the result, and a chain or an interpolation needs no parentheses. A unit belongs to the number it follows: in
  `delay otherwise 5 s`, the fallback is `5 s`, so a number of seconds with a fallback is `(delay otherwise 5) s`.
- A value that the compiler knows can never be `null`, also one narrowed by a check, gets warning `TSV062`, because
  its fallback is never used. The message names what to remove, such as `'count' is never null here, so the fallback
  after 'otherwise' is never used. Remove 'otherwise 0'.` In a chain, the warning goes on the first `otherwise` whose
  left side can no longer be `null`, as `otherwise "x"` in `nickname otherwise "pet" otherwise "x"`, and names every
  fallback from there. A value of unknown type, such as loaded data, and a value that depends on a parameter without a
  type get no warning.
- A fallback does not catch an error: `items[5] otherwise 0` still fails when the list has no position 5, and
  `toys[key] otherwise 0` when the dict has no such key. When the element can never be `null`, the warning names the
  read that has a default instead, `items.get(5, default: 0)` ([§16](#reading-an-element-with-a-default),
  [§40](#40-dictionaries)).

### Defaults follow the same rule
**Status:** Accepted (owner decisions, 2026-10-19 and 2026-10-20)

Every `default:` follows the rule of `otherwise`: the default has the type of the value it stands in for, or is `null`,
and `default: null` makes the result optional. A `get` default replaces a missing entry; an existing entry is returned
unchanged, also when it is `null`. This holds for `get` on lists and dicts ([§16](#reading-an-element-with-a-default), [§40](#40-dictionaries)), the
conversions ([§13](#type-conversion)), `toRegex` ([§8](#regexes)), `fromJson` and `fromBase64`
([§13](#json-and-base64)), `fileFromBase64` ([§33](#stored-files)), `decryptText` and `decryptFile`
([§13](#encryption)), and `load` ([§25](#25-persistent-storage-and-keys)).

A default or a fallback of another type is a compile error. A mix is allowed only when the value lands directly in a
place whose written union holds both types: a typed `let`, an assignment to a variable with a written type, an argument
for a parameter with a written type, or a `return` in a function with a written result type. At these places the
written type also reaches the elements of list, set, and dict literals, nested ones included. It does not reach through
a function without types, an operator such as `+`, or `${...}`: a written type at a caller does not reach into the body
of a function without types.

```text
let names = ["Ada", "Bo"]
let n = names.get(5, default: "none")                       // text
let m = names.get(5, default: null)                         // text or null
let k = names.get(5, default: 0)                            // compile error: names holds text
let c: string | integer = names.get(5, default: 0)          // valid: the written union holds both
let r: (string | integer)[] = [names.get(5, default: 0)]    // valid: the written type reaches the literal's elements
say "${names.get(5, default: 0)}"                           // compile error: no written union here
function helper(i) {
    return names.get(i, default: 0)    // compile error; the message suggests helper(i): string | integer
}
let counts: integer dict = dict{}
let a = counts.get("x", default: 0)                         // an integer
let b = counts.get("x", default: "none")                    // compile error
let nickname: string? = null
let shown = nickname otherwise "pet"                        // text
let wrong = nickname otherwise 0                            // compile error
let amount = toNumber(text, default: 0)                     // a number: an integer fits a number
let flag = toBoolean(text, default: null)                   // a boolean or null
let day = toDate(text, default: "today")                    // compile error: the default of toDate is a date
let pattern = toRegex(text, default: null)                  // a regex or null
let plain = fromBase64(text, default: "")                   // text
let mixed: string | integer = fromBase64(text, default: 0)  // valid: the written union holds both
let file = fileFromBase64(text, default: null)              // a file reference or null
let secret = decryptText(locked, password: "x", default: "") // text
let photo = decryptFile(locked, default: 0)                 // compile error: no written union holds both
```

## 19. Choices
**Status:** Accepted

`askChoice` shows one button per option and returns the value of the selected button. A button shows its text; its
value is what `askChoice` returns. Options are comma-separated; the interaction itself (presentation, typed answers,
transcript) is defined in [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#askchoice). It was named
`choose` until the owner decision on #830 (2026-10-11), so that every request that waits for the player's answer starts
with `ask`; `choose` stays protected, and each use is a compile error that names `askChoice`.

```text
let action = askChoice open: "Open the door", leave: "Walk away"

if action == "open" {
    openDoor()
}
```

An option may have a value written before `:`. An identifier returns text and a numeric literal returns its number, an
`integer` or a `number` as written. An option without a written value returns itself, with its own type:

```text
let answer = askChoice back: "Back", "Spanking", "Lines"   // "back", "Spanking", or "Lines"
let rounds = askChoice 5, 10                               // 5 or 10, an integer
```

A list used as an option gives one button per element, in order; a set gives one button per member, in insertion order,
in the same way. An element is a value, or a choice object `{ value?, text, background? }`: the button shows `text`,
returns `value` (or the `text` value when `value` is omitted), and uses `background` as its colour
([§37](#authored-colours)). A choice object may also be a whole option. A value written before a list or set option is
the value of every button from it:

```text
let offenses = [{ value: "spank", text: "Spanking" }, { text: "Corner" }]
let answer = askChoice back: "Back", offenses   // "back", "spank", or "Corner"
let n = askChoice [5, 10, 15]                   // n is an integer
let door = askChoice win: "Open a door", lose: ["Open a door", "Open a door"]   // 3 buttons; the last two return "lose"
```

Rules:

- A button shows its option, or its choice object's `text`, as `${...}` shows it: text, a number, `true` or `false`,
  `null`, a duration, an angle, or a date or time value.
- Options with and without a written value may be mixed.
- When all values have the same type, the result has that type; integers and numbers together are numbers.
- Values of different types, such as text and numbers, give a union ([§13](#13-explicit-types)). Only a place declared
  with a union type keeps such a result; storing it where its type would be inferred, as in an unannotated `let`, is a
  compile error that names the union to declare:

  ```text
  let rounds: integer | string = askChoice "None", [5, 10]   // "None", 5, or 10
  let other = askChoice "None", [5, 10]                      // compile error: declare 'let other: string | integer'
  ```

- Comparing the answer of a compact `askChoice` whose button values are all written in it with a value that no button
  returns, also as a literal `case` value ([§32](#32-switch-statements)), is a compiler warning. This is a simple check
  apart from the types. It covers `switch askChoice ...` and a variable that only ever holds such answers. With several
  such `askChoice` assignments to one variable, the values are those of all their buttons, wherever the comparison
  stands; any other assignment to the variable ends the check for it:

  ```text
  let answer = askChoice "spank", "lines"
  if answer == "Open" { ... }   // warning: 'answer' is always "spank" or "lines"
  ```

- The elements of a list option are values or choice objects, not lists or sets.
- A choice object has `text`, and optionally `value` and `background`. It has no `value` property when a value is
  written before its option's `:`, also as an element of a list or set option.
- An empty list or set contributes no buttons. An `askChoice` without any button is an error: a compile error when the
  compiler can see it, such as `askChoice []`, and a runtime error otherwise.
- Buttons may repeat a value or a text: `askChoice win: "Open a door", lose: "Open a door", lose: "Open a door"` shows
  three buttons. A selected button is identified by its position, so each returns its own value.
- `askChoice` does not return a result object.

### Preselected button

**Status:** Accepted (Owner decision on #512, 2026-10-08).

A trailing `prefill:`, at most once and after the options, preselects the button whose value it gives:

```text
let action = askChoice stay: "Stay", leave: "Leave", prefill: "leave"
let rounds = askChoice 5, 10, 15, prefill: 10
let level = load("level", default: null)
let next = askChoice 6, 7, 8, 9, prefill: level
```

- The button is identified by the value it returns, compared as `==` compares values, not by its text: write
  `prefill: "leave"` for `leave: "Walk away"`. With several buttons of that value, the first is preselected.
- The prefill is evaluated once, after the options. `null` preselects no button. A value that no button has preselects
  none either, and reports developer warning `TSW017` in Debug; the script goes on, and the player notices nothing.
- A preselected button is marked, and Space in the empty message field activates it
  ([PLAYER-UI.md](../ui/PLAYER-UI.md#foreground-interaction-presentation)); it is never chosen by itself. Without
  `prefill:` no button is preselected.
- `prefill` is reserved after the options of a compact `askChoice`, so no option can be labelled `prefill:`; write such
  a button as `{ value: "prefill", text: "..." }`.

## 20. Input functions
**Status:** Accepted (parenthesized basic asks implemented, and their text is the question: Owner decisions on #627,
2026-10-05; an ask's starting answer is `prefill:`: Owner decision on #512, 2026-10-08)

`askText`, `askNumber`, `askInteger`, `askDate`, `askTime`, `askDateTime`, and `askPassword` are implemented in this
parenthesized form with the arguments of their compact form ([ADR
0018](../decisions/0018-first-standard-library-poc-contract.md#parenthesized-basic-asks)): an optional question, an
optional `prefill:`, which `askPassword` does not take, and an optional `hint:`. Both forms mean the same: `askText()`
is `askText`, and `askText as mistress ("Name?", prefill: "Ada")` is `askText as mistress "Name?", prefill: "Ada"`. The
speaker clause comes before the parentheses, and the `)` ends the ask, so `askInteger("How many?") + 1` adds to the
answer. Their other options in this section, such as `message:` and `invalidMessage:`, are not implemented yet.

The question is said in the chat by the asking speaker, as by `say` but with no reading time of its own, and the field
opens with it (owner decision, 2026-10-11); `hint:` is help text shown in the field only
([ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#ask-questions-and-hints)). In a text or number
field the hint shows only while the field is empty, so a prefill usually hides it; a date or time control shows the
hint beside it, also with a prefill:

```text
let name = askText "What is your name?", prefill: "Slave", hint: "Type your name"
```

The question, `prefill:`, and `hint:` are evaluated once, in the order they are written, before the question is said;
the two options may be written in either order.
The question is said once: a refused answer, an interrupting block, or a restored checkpoint does not say it again. It
accepts what a field text accepts, so a list is an error. Without a question nothing is said, and the ask only opens
its input, so a question said earlier, such as with `say prose`, is enough. In the head of `if`, `while`, `repeat`,
`for`, or `switch`, the `{` of the block ends a compact ask or `askChoice`, so `if askBoolean { ... }` asks without a
question.

An ask's question is shown as `say` shows a message (owner decision on #832, 2026-10-11): `bubble(options)` or
`prose(options)` after `as speaker` and before the question chooses its mode, with the options of `say`
([§37](#message-presentation-defaults-and-overrides)), which are evaluated once, before the question. Without a mode
the speaker's mode applies, a bubble by default. This holds for every ask that takes a question: the basic asks,
`askBoolean`, `askForm`, `askBooleans`, and `askImage`, also when the question is `message:`.

```text
let name = askText prose "What is your name?"
let count = askInteger as mistress prose(align: "center") "How many?", prefill: 3
let ok = askBoolean bubble(background: "gold") "Ready?"
let name = askText prose() ("What is your name?", hint: "Type your name")
let picture = askImage prose ("Show me your setup", hint: "Attach a photo")
```

The mode is read as for `say`. The word is a mode when the question follows it, or, written with parentheses, when the
parentheses of the ask follow them; otherwise it is part of the question, so `askText prose("Name?")` asks the value of
a call to a function `prose`, and a variable `prose` stays a question. `askImage`, which always takes parentheses, also
takes `askImage prose (...)`. A mode needs a question: `askText prose hint: "Help"` is a compile error. `askChoice` has
no question, so it takes no mode; say the question before it, as in `say prose "Which one?"`.

### Text input

```text
let name = askText("What is your name?")
```

`askText(...)` only completes when non-empty valid text has been entered and returns `string`.

### Password input
**Status:** Accepted (Owner decisions, 2026-10-13 and 2026-10-14)

```text
let code = askPassword("Keyholder, type your code", hint: "The code")
if code == hashText("corner") {
    say "That is the code."
}
```

`askPassword` is a basic ask without `prefill:`, as a password is typed by the person who knows it and never suggested.
Its field is masked, with an eye button that shows the text while the person typing chooses to, and a warning while Caps
Lock is on. It completes once a password is typed and returns `string`: the SHA-256 of the typed text as `hashText(...)`
gives it ([§13](#hashes)), 64 lowercase hexadecimal digits. The Player hashes, so the typed text never reaches the
script, and the answer adds no line to the chat. Comparing the answer with `hashText(...)` of a password, or two answers
with each other, tells whether the same password was typed. After a block interrupted it, the field asks again empty,
without what was typed and not yet given.

The hash is not the typed password. Passed to `password:` of an encrypt call, it locks with the hash text itself, which
is recorded like any answer, so anyone who can read a save or replay data that holds it can open such a lock. Written
directly as the `password:` of an encrypt or decrypt call, `askPassword(...)` asks for the password itself instead,
which never becomes a script value ([§13](#encryption)).

### Controlled typing

```text
let line = askTyping("Type the line exactly")
```

`askTyping(...)` returns `string`.

All interaction permissions default to `false`. Authors enable only the behaviors they want to allow:

```text
let line = askTyping(
    message: "Type the line exactly",
    allowBackspace: false,
    allowDelete: false,
    allowCopy: false,
    allowPaste: false,
    allowCut: false,
    allowUndo: false,
    allowRedo: false,
    allowSelection: false,
    allowAutocomplete: false,
    allowAutocorrect: false,
    allowSpellcheck: false,
    scope: "teasePlayer"
)
```

Supported options:

- `allowBackspace`: `boolean`
- `allowDelete`: `boolean`
- `allowCopy`: `boolean`
- `allowPaste`: `boolean`
- `allowCut`: `boolean`
- `allowUndo`: `boolean`
- `allowRedo`: `boolean`
- `allowSelection`: `boolean`
- `allowAutocomplete`: `boolean`
- `allowAutocorrect`: `boolean`
- `allowSpellcheck`: `boolean`
- `scope`: `"input"` or `"teasePlayer"`
- `prefill`: `string`; see [Prefilled answers](#prefilled-answers)

Rules:

- Every `allow...` option defaults to `false`.
- `scope` defaults to `"teasePlayer"`.
- With `scope: "teasePlayer"`, applicable restrictions such as selection, copy, cut, paste, undo, redo, autocomplete, autocorrect, and spellcheck apply to the entire script iframe.
- With `scope: "input"`, restrictions apply only to the typing field.
- `askTyping(...)` does not complete until valid non-empty text has been entered.
- `askTyping(...)` does not return `null`.

### Number input

```text
let amount = askNumber("Enter a number")
```

`askNumber(...)` only completes when a valid number has been entered and returns `number`.

### Multiple number inputs

```text
let values = askNumbers(
    message: "Enter the values",
    texts: ["Minimum", "Maximum", "Multiplier"],
    prefill: [1.5, 10, 2.5]
)
```

`askNumbers(...)` expects:

- `message`: `string`
- `texts`: `string[]`
- `prefill`: `number[]`

It only completes when every field contains a valid number and returns `number[]`.

### Integer input

```text
let count = askInteger("Enter a whole number")
```

`askInteger(...)` only completes when a valid whole number has been entered and returns `integer`. The compact form
`askInteger [as speaker] [bubble(options) | prose(options)] [question] [, prefill: integer] [, hint: text]` is
implemented as the whole-number counterpart of `askNumber`
([ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#askinteger)): an answer is an optional sign and
digits within the safe integer range.

### Multiple integer inputs

```text
let values = askIntegers(
    message: "Enter the values",
    texts: ["Minimum", "Maximum", "Repetitions"],
    prefill: [1, 10, 3]
)
```

`askIntegers(...)` expects:

- `message`: `string`
- `texts`: `string[]`
- `prefill`: `integer[]`

It only completes when every field contains a valid whole number and returns `integer[]`.

### Boolean input

**Status:** Accepted; implemented in both forms (compact form: Owner decision on #512, 2026-10-08).

```text
let answer = askBoolean("Continue?")
if askBoolean "Ready?" {
    say "Then we begin."
}
let ok = askBoolean as mistress "Ready?", yesText: "Sure!", noText: "No, thanks"
```

Custom boolean labels:

```text
let answer = askBoolean(
    message: "Continue?",
    yesText: "Continue",
    noText: "Stop"
)
```

`askBoolean(...)` returns `boolean`. It shows two buttons: `yesText:`, by default `"Yes"`, returns `true`, and
`noText:`, by default `"No"`, returns `false`; the player's answer is the chosen button's text. As for a basic ask, the
compact and parenthesized forms mean the same, `as speaker` comes before the arguments, and the question, which may
instead be named `message:`, is said once by the asking speaker before the buttons open. The question and the button
texts are evaluated once, in written order, and accept what a field text accepts. `prefill: true` or `prefill: false`
preselects the Yes or No button as `askChoice` preselects one ([§19](#preselected-button)): it is marked and Space
activates it, but it is never chosen by itself. Without `prefill:` neither button is preselected. As for another ask's
prefill, one that is `null` or blank text when the buttons open preselects none, and any other value that is not `true`
or `false` is a runtime error before they open.

### Multiple boolean choices

```text
let selected = askBooleans(
    message: "Choose all that apply",
    texts: ["A", "B", "C"],
    prefill: [true, false, false]
)
```

`askBooleans(...)` expects:

- `message`: `string`
- `texts`: `string[]`
- `prefill`: `boolean[]`

It returns `boolean[]`. It is a [form](#forms) of one toggle per text, in order, that returns the toggles' states in the
same order, so texts may repeat; the lists must have the same non-zero length. With `cancel:` it returns `boolean[]?`,
`null` only when cancelled. The message, as the form's question, may also come first without a name, and the form is
implemented with `cancel:` ([RUNTIME.md](../RUNTIME.md#forms)). Like `askForm`, it has a compact form that means the
same, and `as speaker` comes before the arguments:
`let toys = askBooleans as mistress "Which toys?", texts: names, prefill: saved`. `askBoolean(...)` stays a separate
two-button question that completes when either button is chosen.

### Forms

**Status:** Accepted (Owner decisions on #512, 2026-10-06). `askForm` is implemented for an object or a dict of fields of
every kind, with descriptions, `outro:`, `cancel:`, and `timeout:`, and `askBooleans` is implemented on it
([RUNTIME.md](../RUNTIME.md#forms)).

`askForm` asks for several values at once. Its buttons stay in place while the player changes them, and nothing is
returned until the player submits:

```text
let settings = askForm as mistress "Adjust your settings", hint: "Change values, then continue", fields: {
    enabled: false, intensity: ["Low", "Medium", "High"], impact: 5, restraint: 5,
    name: "Ada", day: toDate("2026-10-05"), start: toTime("20:00")
}, submit: "Continue"
say "${settings.name}: impact ${settings.impact}"
```

As for a basic ask, the compact and parenthesized forms mean the same, the optional question is said once by the asking
speaker before the form opens, and `hint:` is help shown in the composer only. `fields:` is an object or a dict of
fields. `submit:` (default `"OK"`) and `cancel:` take text or a button object `{ text, background? }`, and `outro:` takes
text. The arguments are evaluated once, in written order, before the question is said; an edit or a restore does not
evaluate them again.

A field is a starting value or a descriptor object. A start decides the field's kind:

| Start | Field |
|---|---|
| `true` or `false` | a toggle; returns `boolean` |
| a list | a cycle through the list's options, starting at the first; returns the option's value |
| an `integer` or a `number` | a number typed in the composer: `5` gives an `integer` field, `5.0` a `number` field |
| text | text typed in the composer; ISO-looking text stays text |
| a `date`, `time`, or `datetime` | the matching value typed in the composer |
| an object | a descriptor |

A descriptor has `value:` (the start), `text:` (the label, by default the field's name or key), `type:`, `options:`,
`optional:`, `min:`, `max:`, `hint:`, `background:`, and `description:`. `type:` is `"boolean"`, `"cycle"`, `"integer"`,
`"number"`, `"text"`, `"date"`, `"time"`, or `"datetime"`. It is needed when no start shows the kind, as in
`{ type: "date" }`; an unknown type is an error that suggests a likely one, such as `unknown type 'intger' (use 'integer')`.
The compiler types each answer from what the form can see: a descriptor written where the form is asked is read as
written, and a descriptor built earlier by the properties its type shows. When the form opens, every field must answer
within the type the compiler gave it; otherwise the form fails, and the error says to write `type:` where the field's
starting object is created.

```text
let access = askForm("Access?", fields: { enabled: { value: false, options: [{ value: false, text: "Off", background: "firebrick" }, { value: true, text: "On", background: "seagreen" }] } })
let level = askForm("Intensity?", fields: { intensity: [{ text: "Low", background: "seagreen" }, { text: "Medium", background: "orange" }, { text: "High", background: "red" }] })
let details = askForm("Details?", fields: { impact: { type: "integer", optional: true, min: 1, max: 10, hint: "1 to 10" }, name: "Ada", day: { type: "date" } }, submit: "Continue")
```

Rules:

- A toggle shows its label with a check mark. With `options:` it shows the option of its state instead: choice objects,
  exactly one with `value: false` and one with `value: true`, in either order. `{ type: "boolean" }` starts `false`.
- A cycle's `options:` are values or choice objects as for `askChoice` ([§19](#19-choices)), whose values are not `null`
  and share one type. A press shows the next option and wraps around; `value:` starts at the first option equal to it.
- Every field may set `background:`; the `background:` of a toggle's or cycle's shown option wins. Author colours keep
  their contrast rule ([§37](#authored-colours)).
- A typed field (`integer`, `number`, `text`, or a date or time) opens in the composer with its value, which Enter keeps
  and typing replaces, and its answer is read as the matching ask reads it. A typed field is required. With
  `optional: true` it may be submitted without a value and returns `null`; a toggle or cycle cannot be optional. A start
  that is `null` or blank text gives no value, as an ask's empty prefill prefills nothing.
- `min:` and `max:` bound an `integer` or `number` field inclusively. They only validate: an answer outside them is
  refused and stays in the composer; nothing is clamped. A start outside them, or `min:` above `max:`, is an error.
- A field's `hint:` is the composer's help while that field is edited.
- A `description:` is not shown on the buttons. When the form opens, the asking speaker says one prose block after the
  question: a line `<label> — <description>` for each field that has one, in field order, followed by `outro:`. Without
  descriptions and `outro:` nothing more is said.
- The composer edits one field at a time. Selecting another field first commits the text being edited; invalid text,
  also blank text for a required field, keeps it open. Back or Escape drops the text and keeps the field's value.
- Submitting commits the text being edited, as selecting another field does, and requires a value for every required
  field; otherwise the form stays open. The author's starting values are never changed.
- Edits add nothing to the transcript. Submitting adds one player answer that lists every field with its state, in field
  order and never as a count: a toggle as on or off, and any other field as `label: value`, as its button shows it, or
  `label: Not set` for an optional field without a value. The Player shows one field per line, a toggle behind a check
  or an empty box, and a cycle with the option it showed, also where several of its options share a value. The
  answer's plain text, for the transcript, exports, and screen readers, joins the fields with `, ` and
  marks a toggle `✓` or `✗`, such as `✓ crop / cane, ✗ paddle, ✓ whip` or `Intensity: High, Impact: 5`. Every answer is
  shown in full; answers too long for one transcript line are refused and the form stays open. (Owner decision,
  2026-10-07; it replaces the earlier `12 of 43 selected` and `5 of 6 fields set` counts.)
- With `cancel:` the player may cancel the whole form, which returns `null`, so the form's type is optional. A field's
  `null` is not a cancelled form. Without `cancel:` the player cannot cancel the form.
- A timer, media, or permanent-button block may interrupt a form; the form then resumes with its answers and the text
  being edited.

The result is a fresh object with a property per field, or for a dict of fields a dict with an entry per key, in field
order. Its types follow the fields: `settings.enabled` is a `boolean`, `settings.impact` an `integer`, `details.impact`
an `integer?`, and a cycle has the type of its options' values.

A dict of fields builds a form from data. A key identifies a field and its answer; `text:` is only the label, so a
translated label keeps its saved value:

```text
let toys = dict {}
for id in toyIds {
    let owned: boolean = load("toys.${id}", default: false)
    toys[id] = { value: owned, text: toyNames[id] }
}
let selected = askForm "Which toys do you own?", fields: toys   // a boolean dict
for id in selected { save selected[id] as "toys.${id}" }
```

A dict written where the form is asked combines the answer types its entries prove. For a computed dict, when its value
type proves one kind, from a `value:` known where its values are created, the result is a dict of that answer
type, such as an `integer dict`, or an `integer? dict` when a field may be `optional:`. Otherwise, as for an
`object dict` of descriptors of different kinds with explicit `type:`, the result is a
`(boolean | number | string | date | time | datetime | duration | calendarDuration | angle | absoluteDateTime | null) dict`
(a cycle may return any choice value); read an answer into a local and narrow it with `is` ([§13](#13-explicit-types)):

```text
let menu: object dict = dict {}
menu["impact"] = { type: "number", value: 2.5, min: 1, max: 10 }
menu["day"] = { type: "date", optional: true }
let answers = askForm "Adjust", fields: menu
let impact = answers["impact"]
if impact is number { say impact + 1 }
```

A dict of fields must not be empty, and each of its descriptors is checked when the form opens; an invalid one is an
error that names its key.

Remembered settings are loaded as the starts, and the result is saved:

```text
let saved = load("settings", default: { enabled: false, impact: 5 })
let settings = askForm "Settings", fields: { enabled: saved.enabled, impact: saved.impact }
save settings as "settings"
```

A response time needs no syntax: compare `getAbsoluteDateTime()` before and after the form
([§35](#35-date-time-and-durations)):

```text
let asked = getAbsoluteDateTime()
let answers = askForm "Ready?", fields: { ready: false }
let took = getAbsoluteDateTime() - asked
```

`timeout:`, an exact duration greater than zero as for `showButton` ([§21](#21-blocking-button)), with
`onTimeout: "submit"` or `onTimeout: "cancel"`, gives the form a time limit; each needs the other. When it is reached
the form closes without a transcript line: `"submit"` returns the answers as they stand, without the text still being
edited, and needs a value in every field from the start, which the compiler checks for fields written where the form
is asked and the form checks for other fields when it opens; `"cancel"` returns `null`, so the form's type is then
optional:

```text
let answers = askForm "Quick, choose", fields: { rope: false, gag: false }, timeout: 20 s, onTimeout: "submit"
```

### Date and time input

```text
let day = askDate("Which date?")
let start = askTime("What time?")
let moment = askDateTime("When are you available?")
```

Return types:

```text
askDate(...)      // date
askTime(...)      // time
askDateTime(...)  // datetime
```

These inputs use structured date and time controls and do not return unparsed free text. Like the other blocking `ask...` functions, they only complete with a valid value.

The compact forms `askDate`, `askTime`, and
`askDateTime [as speaker] [bubble(options) | prose(options)] [question] [, prefill: value] [, hint: text]` are
implemented ([ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#askdate-asktime-and-askdatetime)). The
control submits strict ISO text ([§35](#35-date-time-and-durations)); a local time that the player's zone
skips is a valid answer. The transcript shows the answer in the player's presentation. The Player's date and
date-and-time controls cover the years 0001 through 9999, as the browser's native controls do; a prefill in year 0000 is
shown and edited as ISO text instead. The value domain stays 0000 through 9999 for conversions, prefills, and text
answers.

### Prefilled answers

The single-field inputs listed below accept an optional named `prefill:` answer, a starting answer that the player
still confirms:

```text
let name = askText("What is your name?", prefill: "Ada")
let minutes = askNumber("Corner time?", prefill: cornerBase + playerLevel)
let count = askInteger("How many?", prefill: 10)
let answer = askBoolean("Continue?", prefill: true)
let day = askDate("Which date?", prefill: getDate())
```

| Function | `prefill:` value |
|---|---|
| `askText(...)`, `askTyping(...)` | `string` with a non-whitespace character |
| `askNumber(...)` | `number` or `integer` |
| `askInteger(...)` | `integer` |
| `askBoolean(...)` | `boolean` |
| `askDate(...)`, `askTime(...)`, `askDateTime(...)` | `date`, `time`, and `datetime` respectively |

Rules:

- The input opens with the prefill as its editable answer, and the player still submits explicitly. A submitted
  prefill is an ordinary answer: its result, validation, and transcript text are those of the same answer entered by
  hand.
- Clearing the field never falls back to the prefill; a blank answer is rejected and asked again.
- The prefill must be an answer the input accepts. There is no implicit conversion except `integer` to `number`: write
  `prefill: "${count}"` to offer a number as text. A non-whole `askInteger` prefill is an error, never rounded.
- A prefill that is `null` or blank text (empty or only whitespace) when the input opens prefills nothing: the field
  starts empty, as without `prefill:`. A prefill can therefore come from a value that may not exist yet, such as
  `askText "Your name?", prefill: load("name", default: "")` on a first play. A prefill known at compile time to be
  `null` or blank, such as `prefill: ""` or `prefill: null`, is a compile error; remove `prefill:` to start with an
  empty field.
- The compiler rejects a prefill that it knows is invalid, and its error names the fix. Any other prefill is checked
  when the input opens; an invalid one is a runtime error, and the input does not open.
- `askTyping` applies its `allow...` restrictions to the prefilled text as to typed text.
- Restoring a checkpoint shows the original prefill again; edits the player had not submitted are dropped.
- `askBoolean` preselects the button of its prefill, as `askChoice` does with `prefill:`
  ([§19](#preselected-button)); a preselected button is never chosen by itself. File, folder, image, video, and audio
  pickers have no prefill because a browser cannot preset a file input. Multi-field inputs take a `prefill:` list.
- An ask's earlier `default:`, or `defaults:` of a multi-field input, is a compile error that names the fix, such as
  `askText has no 'default:'. Use 'prefill:'.` (Owner decision on #512, 2026-10-08.) `default:` stays where its value
  becomes the result without the player: `load`, `dict.get`, the conversions such as `toNumber`, parameter defaults,
  and a `global`'s start value.

### File input

One file:

```text
let file = askFile("Upload a file")
```

Restrict by extension:

```text
let file = askFile(
    message: "Upload a document",
    types: [".pdf", ".txt"]
)
```

Restrict by MIME type:

```text
let file = askFile(
    message: "Upload a document",
    mime: ["application/pdf", "text/plain"]
)
```

Both forms may be combined:

```text
let file = askFile(
    message: "Upload a document",
    types: [".pdf", ".txt"],
    mime: ["application/pdf", "text/plain"]
)
```

`askFile(...)` returns one engine-managed file reference as `string`.

### Multiple file input

```text
let files = askFiles(
    message: "Upload the documents",
    types: [".pdf", ".txt"],
    mime: ["application/pdf", "text/plain"]
)
```

`askFiles(...)` returns engine-managed file references as `string[]`.

### Folder input

```text
let folder = askFolder("Select a folder")
```

`askFolder(...)` returns one engine-managed folder reference as `string`.

### Image input

By default, camera and file upload are both available. Like the basic asks, the message is the question, which the
asking speaker says in the chat before the request opens, and `hint:` is help shown in the composer only:

```text
let image = askImage("Show me your setup", hint: "Attach a photo")
```

Explicit source permissions:

```text
let image = askImage(
    message: "Add an image",
    allowCamera: true,
    allowFile: true
)
```

Optional file restrictions:

```text
let image = askImage(
    message: "Upload or take an image",
    allowCamera: true,
    allowFile: true,
    types: [".jpg", ".jpeg", ".png"],
    mime: ["image/jpeg", "image/png"]
)
```

`askImage(...)` returns one engine-managed image reference as `string`.

`askImage(...)` **status (Owner decisions, 2026-10-05 and 2026-10-13):** images only, for now. While the request
waits, the Player shows its controls under the question in the chat, where `showButton` shows its button, in two steps.
These are Player controls, not transcript messages.

- **First step.** It offers **Open camera** when the request allows the camera and the browser can capture, **Upload
  file** when it allows files, **Skip** when it is written with `allowSkip: true`, and **Use image**. Until the player
  has taken a photo or chosen a file, Use image is greyed out: pointing at it or tapping it shows "Take or choose an
  image first", and a screen reader announces it as unavailable with that reason. A photo taken or a file chosen then
  stands still on the Stage as the preview, and Use image is enabled in the accent colour; only Use image gives the
  script the image. A new photo or file replaces the preview.
- **Camera step.** Open camera shows the viewfinder on the Stage, or in the camera window a script shows, with neither
  the question nor a shutter on the picture. The chat then offers **Take photo**, which takes the photo at once,
  **Self-timer (5 s)**, which counts down five seconds as a large animated number from 5 to 1 over the viewfinder and
  then takes it, and **Back**. A photo taken returns to the first step with that photo as the preview; Back returns
  without a new photo. A camera that is denied or broken offers **Try again** and **Back**.

Upload file opens the browser's native file picker, as does a paperclip in the request's composer while the request
allows files, and an image file dropped onto the composer is taken too; outside such a request there is neither. A
chosen or dropped file becomes the preview, also during the camera step, and a cancelled picker changes nothing. A
chosen image stays in the browser and is session media with the lifecycle of a `takePhoto()` photo (§33): durable only
while saved script storage references it. The camera step uses the session camera when it is already open, as in a
script that uses `takePhoto()`; otherwise the request opens a camera of its own at Open camera, which turns off again
on the return to the first step and after the answer. Skip answers `null`, and the player's transcript shows `Skip`. After
a reload while the request waits, the Player starts again at the first step without a preview, and a photo is never
taken by itself. `invalidMessage` and `invalidLlmInstruction` are not implemented yet.

### Video input

By default, camera recording and file upload are both available:

```text
let video = askVideo("Add a video")
```

```text
let video = askVideo(
    message: "Record or upload a video",
    allowCamera: true,
    allowFile: true,
    types: [".mp4", ".webm"],
    mime: ["video/mp4", "video/webm"]
)
```

`askVideo(...)` returns one engine-managed video reference as `string`.

### Audio input

By default, microphone recording and file upload are both available:

```text
let audio = askAudio("Add audio")
```

```text
let audio = askAudio(
    message: "Record or upload audio",
    allowMicrophone: true,
    allowFile: true,
    types: [".mp3", ".wav", ".ogg"],
    mime: ["audio/mpeg", "audio/wav", "audio/ogg"]
)
```

`askAudio(...)` returns one engine-managed audio reference as `string`.

### Skipping a file input

**Status:** Accepted (Owner decisions on #857, 2026-10-12, and 2026-10-13). Implemented for `askImage`; `askFile`,
`askFiles`, `askVideo`, `askAudio`, and `askFolder` are not implemented yet.

`askFile`, `askImage`, `askVideo`, `askAudio`, and `askFolder` take `allowSkip:`, which is `false` by default. Without
it, or with `allowSkip: false`, the request waits until the player gives a file, and the result is a `string`. With
`allowSkip: true` the Player also offers a skip control, **Skip** in the first step of `askImage`
([Image input](#image-input)), and the request returns `null` when the player skips it, so its result is `string?` and
needs a check or a fallback before it is used as text:

```text
let pic = askImage("Show me your setup", allowSkip: true) otherwise "images/no-photo.png"

let doc = askFile("Upload your contract", allowSkip: true)
if doc == null {
    say "No contract, then."
}
```

Only `allowSkip: false` written as a literal keeps the result `string`; any other value, such as a variable, may be
`true`, so the result is `string?`. A value that is not `true` or `false` is a compile error where the compiler sees
it, and otherwise a runtime error when the request opens. An answer stays an engine-managed reference (`string`), not
a handle.

`askFiles` takes `allowSkip:` as well. A skip returns `null`, so its result is `string[]?`, as for `askFile` and
`askFolder`.

### Invalid input handling

Relevant input functions support:

```text
invalidMessage: string
invalidLlmInstruction: string
```

`invalidMessage` shows a normal popup outside the chat.

`invalidLlmInstruction` gives the LLM an instruction for a generated response that appears in the chat.

Examples:

```text
let count = askInteger(
    message: "How many repetitions?",
    invalidMessage: "That is wrong. I asked for a whole number.",
    invalidLlmInstruction: "Respond briefly and sternly."
)
```

```text
let amount = askNumber(
    message: "Enter an amount",
    invalidMessage: "That is wrong. I asked for a number."
)
```

Rules:

- An invalid value is not accepted.
- The input request remains active.
- A non-empty `invalidMessage` displays a popup.
- An empty `invalidMessage: ""` disables the popup.
- A non-empty `invalidLlmInstruction` asks the LLM to generate a chat response.
- An empty `invalidLlmInstruction: ""` disables the LLM response.
- Popup and LLM responses may be used together.

Default invalid messages:

| Function | Default `invalidMessage` |
|---|---|
| `askNumber(...)` | `"That is wrong. I asked for a number."` |
| `askNumbers(...)` | `"That is wrong. Every value must be a number."` |
| `askInteger(...)` | `"That is wrong. I asked for a whole number."` |
| `askIntegers(...)` | `"That is wrong. Every value must be a whole number."` |
| `askDate(...)` | `"That is wrong. I asked for a date."` |
| `askTime(...)` | `"That is wrong. I asked for a time."` |
| `askDateTime(...)` | `"That is wrong. I asked for a date and time."` |
| `askFile(...)` | `"That file is not valid."` |
| `askFiles(...)` | `"One or more files are not valid."` |
| `askFolder(...)` | `"That folder is not valid."` |
| `askImage(...)` | `"That image is not valid."` |
| `askVideo(...)` | `"That video is not valid."` |
| `askAudio(...)` | `"That audio is not valid."` |
| `askChoice(...)` or `askBoolean(...)`, typed text that matches no button | `"That is wrong. Type the exact text of one button, or use the buttons above."` |
| `askChoice(...)` or `askBoolean(...)`, typed text that matches more than one button | `"More than one button has this text. Use the buttons above."` |

`askText(...)` refuses a blank answer with `"That is wrong. I asked for some text."` (owner decision, 2026-10-16).

When `invalidLlmInstruction` is used, the runtime supplies the LLM with:

```text
originalMessage
expectedType
receivedValue
validationError
fieldName
recentChatHistory
```

`fieldName` is included for multi-field input such as `askNumbers(...)` and `askIntegers(...)`.

The developer instruction controls tone and wording. It does not need to repeat the validation details already supplied by the runtime.

### General input rules

- `askText(...)`, `askTyping(...)`, `askNumber(...)`, `askNumbers(...)`, `askInteger(...)`, `askIntegers(...)`, `askDate(...)`, `askTime(...)`, `askDateTime(...)`, `askPassword(...)`, `askBoolean(...)`, `askFile(...)`, `askFiles(...)`, `askFolder(...)`, `askImage(...)`, `askVideo(...)`, and `askAudio(...)` do not return `null`, except a file input the player skips ([Skipping a file input](#skipping-a-file-input)). A [form](#forms), `askForm(...)` or
  `askBooleans(...)`, returns `null` only when it is cancelled: by the player when written with `cancel:`, or by its
  timeout with `onTimeout: "cancel"`.
- Input functions complete only after valid input has been supplied, or a skip or cancellation the request allows.
- Cancelling a file, folder, camera, microphone, image, audio, or video picker does not complete the input request.
- `askInteger(...)` and `askIntegers(...)` reject decimal values.
- `types` accepts file extensions such as `".png"` and `".mp4"`.
- `mime` accepts MIME types such as `"image/png"` and `"video/mp4"`.
- `types` and `mime` may be used together.
- `askFile(...)`, `askImage(...)`, `askVideo(...)`, `askAudio(...)`, and `askFolder(...)` return one reference.
- `askFiles(...)` returns multiple references.
- All returned file and media references are engine-managed strings.
- `chooseFile()` and `askFile(...)` are different functions: `chooseFile()` is a general browser picker, while `askFile(...)` is a blocking user-input request.
- `askImage(...)` defaults to `allowCamera: true` and `allowFile: true`.
- `askVideo(...)` defaults to `allowCamera: true` and `allowFile: true`.
- `askAudio(...)` defaults to `allowMicrophone: true` and `allowFile: true`.
- `askFile(...)`, `askFiles(...)`, `askImage(...)`, `askVideo(...)`, `askAudio(...)`, and `askFolder(...)` default to `allowSkip: false`.

## 21. Blocking button
**Status:** Accepted (compact form: Owner decision on #531, 2026-10-04)

`showButton` displays a button and blocks normal script execution until the user clicks it or an optional timeout is
reached. It uses the compact form of [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#showbutton),
including `as speaker` and `background:`:

```text
showButton "Continue"
showButton "Continue", timeout: 5 s
let elapsed = showButton "Continue", timeout: 30 s
if elapsed < 2 s {
    say "That was quick."
}
```

Rules:

- `timeout` is optional and an exact duration such as `5 s`, `500 ms`, or `2 min`. A number without a unit is a compile
  error that names the fix, as for `wait` and `timer` ([§27](#27-timers)).
- Without a timeout, the command waits until the user clicks.
- With a timeout, execution continues after the click or when the timeout is reached. A reached timeout removes the
  button without a chat message.
- The command returns the elapsed waiting time as a `duration` ([§35](#35-date-time-and-durations)),
  measured in scene time like timers ([§27](#time)), without the time a block interrupted it
  ([§27](#expiry-blocks)). When the timeout is reached, the returned duration equals the timeout.
- If the caller does not need the elapsed time, the return value may be ignored.
- A zero or negative timeout, a value that is not a duration, or a calendar duration, is an error. The compiler rejects
  a timeout it can see is invalid; any other is checked when the button would appear, and an invalid one is a runtime
  error.
- The parenthesized forms `showButton("Continue", 5 s)` and `showButton(text: "Continue", timeout: 5 s)` are deferred
  until parenthesized interaction calls are needed.
- `showButton` belongs to the core language/runtime API, not specifically to the browser-picker API.

## 22. Stage image, audio, and video
**Status:** Accepted (Owner decisions on [#445](https://github.com/TeaseScript-AI/teasescript-platform/issues/445)). The
parser, compiler, deterministic runtime, and checkpoint foundation for image, audio, and video is implemented; the
Player shows images and plays audio (#446), and browser video playback is planned.

### Stage image

```text
showImage "images/room.jpg"
hideImage
showImage photo            // a file reference string, or null
showImage tagged "bedroom" // a random package image with these tags, see §41
```

`showImage` sets the persistent Stage image; it stays until the next `showImage` or `hideImage`. `hideImage` takes no
arguments and clears the Stage. `showImage null` also clears the Stage and reports developer warning `TSW011`
([§34](#34-runtime-warnings-and-recoverable-values)). Both use command syntax only.

### Audio and video

```text
playAudio "sounds/bell.mp3"                         // waits until the sound ends
playAudio async "sounds/door-creak.mp3"             // plays alongside; the script continues
let music = playAudio async repeat "music/beat.mp3" // keeps a handle
playVideo "videos/instructions.mp4"
let fire = playVideo async repeat "videos/fireplace.mp4"
```

`playAudio|playVideo [async] [repeat] <file> [{ block }]`: `async` and `repeat` are recognized only directly after the
command; write `playAudio (async)` to use a variable of that name.

- Plain media is blocking: the script continues when playback finishes, is stopped, or cannot play. Blocking media
  returns no value; using it as a value is a compile error.
- `async` media continues once the Player has reported the load result and evaluates to an opaque handle that may be
  ignored; after a successful load its duration is known.
- Several audio sources may play at once. The Stage shows one video at a time over the Stage image: a new `playVideo`,
  `showImage`, or `hideImage` stops an active video (`stopped`, without `finish`) and cancels its queued blocks, and
  the Stage image is visible again when the video ends.

The named form carries less common options:

```text
let music = playAudio(
    file: "music/track.mp3",
    async: true,
    repeat: true,
    startAt: 2 min,
    endAt: 8 min,
    volume: 0.5
)
```

`file` is required and evaluates to a reference string or `null`; `async` is the literal `true` or `false`. `startAt`,
`endAt`, `at`, and `beforeEnd` accept non-negative exact durations. `startAt` and `endAt` default
to the start and end of the file and define the active playback range; a supplied `endAt` must be later than
`startAt`, and the effective end is limited to the source duration. `volume` is a number from `0` through `1` and
defaults to `1`.
Arguments evaluate in source order, followed by the cue positions in block order.

Repeat:

- `repeat` (short form) and `repeat: true` repeat the active range until the media is stopped or replaced;
- `repeat: 3 times` plays three passes in total;
- `repeat: 60 s` repeats for 60 seconds of active playback and may end mid-pass;
- `repeat: false`, or no repeat, plays one pass.

A count is a whole number of at least one and a duration is exact and greater than zero. A plain number such as
`repeat: 3` is an error; write `3 times` or a duration. Blocking media may use a count or a duration but not
indefinite repetition.

Like every statement, media and camera statements run only once the reading time of a paced message before them has
ended or been skipped, also in timer and cue blocks ([message reading time](#message-presentation-defaults-and-overrides)).

### Camera view

**Status:** Accepted (Owner decisions on [#602](https://github.com/TeaseScript-AI/teasescript-platform/issues/602),
2026-10-05) and implemented.

```text
showCamera                     // the camera's live view in the Player's floating window
showCamera stage               // the camera's live view over the Stage image, which stays underneath
let view = showCamera          // keeps a handle
view.placement = "stage"       // moves the view, like a timer's t.display = "mystery"
if view.placement == "window" { ... }
hideCamera                     // hides every camera view
```

`showCamera [stage]` shows the camera's view: without a word in the Player's floating window, which the player may move
and resize, and with `stage` over the Stage image. `stage` is recognized only directly after `showCamera`. Used as a
value, `showCamera` evaluates to an opaque camera view handle, which may be ignored. The camera has one view:
`showCamera` while it is shown moves it instead of opening a second, and after `hideCamera` shows it again, so an
earlier handle refers to it again. `hideCamera` takes no arguments and hides every camera view; `exit` hides them too.
Both use command syntax only.

- The handle's one property is `placement`, `"window"` or `"stage"`, readable and assignable. Another value fails with
  `TSR050`, or with `TSV059` when the compiler knows it; other properties and methods are `TSV059`. Assigning the
  placement of a hidden view changes nothing and reports developer warning `TSW010`; reading it keeps working.
- The view over the Stage covers the Stage image without replacing it: `showImage` and `hideImage` change the image
  underneath, and the view stays until `hideCamera`. It also lies over a playing Stage video.
- A camera view only shows the camera; it never takes a photo. `takePhoto()`
  ([§33](#33-browser-api-file-folder-camera-and-url-references)) captures from the same camera and changes nothing on
  screen.
- Whether the Player has a camera is not part of the script: without one, `showCamera` shows nothing and the script
  continues. Whether a camera view is shown, and its placement, are part of the session state and come back after a
  checkpoint is restored.
- Camera views and their handles cannot be saved, used as a parameter default, or given to a global or speaker at the
  start of the session.
- Later camera roles may open more views, each with its own handle; `hideCamera` keeps hiding all of them.

### Media handles

```text
music.pause()
music.resume()
music.stop()
music.position = 2 min
music.position += 5 s
music.remaining = 10 s
music.volume = 0.5
if music.state == "running" { ... }
say "${music.elapsed} of ${music.duration}"
```

- `position` is the playhead in the source; `remaining` is the time to the effective end of the current pass;
  `duration` is the source duration; `elapsed` is the active playback time since the start across all passes, excluding
  pauses and Player stalls; `volume` is the script volume.
- Assignable properties are `position` and `remaining` (`=`, `+=`, `-=`, with exact durations) and `volume`. `duration`,
  `elapsed`, and `state` are read-only. Media that could not be loaded reads `null` for `duration` and `remaining`.
- `state` is `running`, `paused`, `finished`, or `stopped`. Idempotent calls, other operations on settled media, and
  developer warning `TSW010` follow the timer handle rules.
- An assignment to `position` or `remaining` is a seek. It is clamped to the active range and does not fire cues it
  jumps across; a cue exactly at a new position before the end fires once playback proceeds from it. A seek to the end
  of the range fires the cues there and completes the current pass at once, like a timer's `remaining = 0 s`, also while
  paused, where the next pass stays paused. Seeks do not change `elapsed`.
- After media finishes or stops, `position` and `elapsed` keep their final values; `remaining` is zero if the source
  loaded and `null` otherwise.

### Cues

```text
let music = playAudio async "music.mp3" {
    at 30 s {
        say "Thirty seconds."
    }
    beforeEnd 10 s {
        say "Ten seconds left."
    }
    finish {
        say "Finished."
    }
}

playAudio async repeat "music/beat.mp3" {
    say "Again."          // runs at the end of every pass
}
```

- A block after a play command holds either ordinary statements or cue declarations. An ordinary block runs at the end
  of every pass, like `beforeEnd 0 s`; it is not `finish`. `at`, `beforeEnd`, and `finish` are cue words only at the top
  level of such a block. A cue position is an ordinary expression and may continue across lines as described in
  [Statement termination](#1-statement-termination); its `{` follows the position on the same logical line.
- `at <position>` is an absolute position in the source; `beforeEnd <offset>` is measured back from the effective end.
  Both run on every natural passage through their point, including repeated passes. A cue outside the active range never
  runs and reports developer warning `TSW012`.
- `finish` runs once after the whole invocation finishes naturally, after the last pass or when a repeat duration ends.
  It never runs after `stop()`, replacement, or a load failure, so it is a compile error on media that repeats
  indefinitely. A queued `finish` block that has not started is also cancelled by `stop()` after the media finished.
  A block may declare `finish` at most once.
- Blocks are allowed for blocking and async media. They run one at a time through the timer interrupt queue with the
  same interruption and resumption rules as [timer expiry blocks](#expiry-blocks); cues due at the same point run in
  source order. Media keeps playing while a block runs unless the block controls it. `stop()` cancels queued blocks of
  that media that have not started, also after the media finished (owner decision, 2026-10-20).
- The blocks share the variables of the code that started the media
  ([§14](#variables-in-timer-media-and-button-blocks)), all blocks of one media the same ones, across its repeats. In
  `let NAME = playAudio async ... { ... }` every block also sees `NAME` as its own handle, including inside a function.

### Stopping all audio

**Status:** Accepted (Owner decision on [#512](https://github.com/TeaseScript-AI/teasescript-platform/issues/512),
2026-10-09) and implemented.

```text
playAudio async repeat "music/beat.mp3"
playAudio async "sounds/rain.mp3"
stopAudio                    // stops both
```

`stopAudio` takes no arguments. To stop one sound, keep its handle and call `stop()`. It stops every running or paused
sound of the session, including sounds started in another file, in the order they started, as `stop()` on each handle
would: their queued blocks are cancelled, `finish` does not run, and their handles stay readable with state `stopped`.
A blocking `playAudio` stopped this way from a timer or cue block continues once that block returns. Video, the Stage
image, the camera view, and timers are unaffected. Without a running or paused sound, `stopAudio` does nothing.

### Failures, cleanup, and restore

- When the Player cannot load a source, or the source leaves an empty playback range, the runtime reports developer
  warning `TSW013`, the media becomes `stopped` without cues or `finish`, and the script continues. A `null` file plays
  nothing, continues at once, and reports `TSW011`.
- `exit` and the end of the session stop all media; the last Stage image stays. `goto`, `call`, and `end` do not stop
  media.
- Checkpoint and restore preserve the Stage image and media state; playback resumes from the persisted position, and
  time without a running Player does not advance media. Restore does not imply cross-device handoff.

### Future layered scene
**Status:** Accepted V30 direction, extended with [pixels and image size](#pixels-and-image-size) (Owner decision on
[#617](https://github.com/TeaseScript-AI/teasescript-platform/issues/617)); not implemented. Background and overlay
layers, their coordinate space, movement, blur, drawings, edited copies, and transitions remain separate from the Stage
image and media foundation above. Points affected by the Stage image model must be reconciled before the layered scene
is implemented.

```text
showBackgroundImage backgroundFile
showOverlayImage characterFile
showBackgroundColor "#000000"
showOverlayVideo(characterVideo, loop: true)
```

- `showBackgroundImage` controls the environment or fixed backdrop.
- `showOverlayImage` places one or more characters or scene elements over the backdrop. Transparent source images are
  expected to be common here.

#### Scene coordinate space

When a background image or video is active, its intrinsic media canvas is the default scene coordinate space. The same fit, scale, crop, and viewport transform is applied to the background and every background-relative overlay, so a character remains attached to the intended place in the scene when the browser size or downloaded media resolution changes.

When no background image or video is active, the current visual viewport becomes the default scene coordinate space. An overlay may explicitly choose viewport-relative positioning even when a background exists through:

```text
relativeTo: "background"
relativeTo: "viewport"
```

With active background media, `"background"` is the default. Without background media, `"viewport"` is the default.

Positioning uses `x` and `y` percentages. `width` and `height` are also percentages of the selected reference space:

```text
let veraOverlay = showOverlayImage(
    image: characterFile,
    relativeTo: "background",
    x: 75,
    y: 100,
    height: 40,
    anchor: "bottomCenter"
)
```

Rules:

- Coordinates are not restricted to `0..100`; values such as `-10` or `110` may intentionally move part of an image outside the visible scene.
- Content outside the selected reference space is clipped.
- Image aspect ratio is preserved unless stretching is requested explicitly.
- Background fit accepts `"contain"`, `"cover"`, or `"stretch"`. The default is `"contain"`; cropping occurs only when `"cover"` is selected.

#### Pixels and image size

`unit: "px"` gives `x`, `y`, `width`, and `height` in pixels instead of the default percentages. A pixel is a pixel of
the reference space's intrinsic media canvas: with background media, the background's canvas, which is the default
scene coordinate space above. The author selects pixels explicitly, so pixels and percentages are never mixed up by
accident.

`imageSize(image)` returns the width and height of an image in pixels. The size of a package image comes from data
computed when the package is built, so the engine stays deterministic; the size of a photo from `takePhoto()` is
recorded when it is taken.

A scene composed in pixels, using an explicit card width:

```text
let cardWidth = 80
let x = 0
repeat 5 {
    showOverlayImage(
        image: cardFile,
        relativeTo: "background",
        unit: "px",
        x: x,
        y: 40,
        width: cardWidth
    )
    x += cardWidth
}
```

Like the rest of the layered scene, pixels and `imageSize` are not implemented. Their open points, such as pixels with
`relativeTo: "viewport"`, are listed under [Remaining open decisions](#remaining-open-decisions).

#### Multiple overlays and movement

`showOverlayImage(...)` and `showOverlayVideo(...)` return overlay references, and multiple overlays may exist simultaneously. A displayed overlay can be moved asynchronously while script execution continues:

```text
moveOverlay(
    veraOverlay,
    x: 25,
    y: 100,
    duration: 1 second
)
```

Set `blocking: true` when the script must wait for the movement to finish. Longer paths use timed keyframes. `hold` keeps the overlay at a keyframe before the next movement begins:

```text
animateOverlay(
    veraOverlay,
    keyframes: [
        { x: 10, y: 100, duration: 1 second, hold: 5 seconds },
        { x: 50, y: 80, duration: 2 seconds },
        { x: 110, y: 100, duration: 1 second }
    ]
)
```

`animateOverlay(...)` is asynchronous by default and also accepts `blocking: true`.

Hide overlays without destroying their references:

```text
hideOverlay()
hideOverlay(veraOverlay)
```

Rules:

- when exactly one overlay is active, `hideOverlay()` hides it;
- when multiple overlays are active, a specific overlay reference is required;
- when no overlay is active, the player sees no warning. A statically detectable mistake may produce a compiler warning, while a runtime occurrence may be written to debug logging.

#### Blur, drawings, edited copies, and transitions

Blur is a temporary, non-destructive visual layer. A blur may target:

- the background;
- a specific overlay reference;
- a rectangular or elliptical region of one of those targets.

```text
let blur = showBlur(
    target: veraOverlay,
    shape: "ellipse",
    x: 50,
    y: 40,
    width: 30,
    height: 20,
    amount: 20
)

hideBlur(blur)
```

A blur attached to an overlay follows that overlay when it moves. The effect does not alter the source image unless the script explicitly exports an edited copy.

Drawing operations target the same surfaces. The accepted v1 function family is:

```text
drawRectangle(...)
drawEllipse(...)
drawLine(...)
drawText(...)
removeDrawing(reference)
```

Rectangles and ellipses may be filled, stroked, or both; this supports solid black bars. Text drawings must support at least text, font, size, color, and alignment. Exact parameter names and coordinate units for drawing styles remain open. Drawings return references for later removal or modification.

A script may create and save an edited copy that includes blur or drawings while preserving access to the original local encrypted image. The edited/original reference relationship must be explicit; filename suffix conventions alone are not the normative identity mechanism. The export API remains open.

Replacing background or overlay media may use:

```text
"none"
"fade"
"crossfade"
```

Example:

```text
showBackgroundImage(
    image: nextRoom,
    fit: "contain",
    transition: "crossfade",
    transitionDuration: 750 ms
)
```

## 23. Loops
**Status:** Accepted (`for key, value`: Owner decision on #627, 2026-10-05)

```text
repeat 5 {
    say "Again"
}
```

```text
for item in items {
    say item
}
```

`for` goes through the elements of a list or set, the keys of a dict ([§40](#40-dictionaries)), or the whole numbers of
a range ([§6](#6-range-semantics)), as they were when the loop started: changing the source inside the loop does not
change what the loop visits. Each iteration has its own loop variable, which a block created in it keeps
([§14](#variables-in-timer-media-and-button-blocks)).

With two variables, `for` goes through the entries of a dict, giving each key and its value:

```text
for key, value in toys {
    say "${key}: ${value}"
}
```

The entries are taken when the loop starts, and each value is a copy: changing it, or adding, changing, or removing
entries of the dict inside the loop, changes neither the dict's other entries nor what the loop visits. The key is text
and the value has the dict's value type. The two names must differ. Another source is an error: a compile error when the
compiler can see it, and runtime error `TSR044` otherwise. A list has no two-variable `for`.

```text
while player.health > 0 {
    wait 1 s
}
```

Leave the current loop:

```text
break
```

Skip to the next iteration:

```text
continue
```

Example:

```text
for item in items {
    if item.disabled {
        continue
    }

    if item.stop {
        break
    }

    useItem(item)
}
```

## 24. Comments
**Status:** Accepted

```text
// This is a comment
```

```text
/*
    This is a multi-line comment
*/
```

## 25. Persistent storage and keys
**Status:** Accepted (bounded `load(...)`: Owner decision on #627, 2026-10-05; required default, load types, and wrong
stored values: Owner decision, 2026-10-07; an object default per field: owner decision, 2026-10-20)

Save or overwrite a value:

```text
save playerName as "player.name"
```

`save value as key` evaluates the value first, then the key. It creates the key when absent and replaces its value
when present. Saving `null` removes the key, like `delete`; stored top-level values are never `null`.

`load` reads a saved value. It names the key and, with `default:`, the value to use while the key holds none:

```text
let visits = load("visits", default: 0)
let playerName = load("player.name", default: "")
let level: integer | string = load("level", default: 1)
let nickname: string? = load("player.nickname", default: null)   // null while the key holds no value
let score = load "score", default: 0                              // compact form
```

`default:` is required: a `load` without it is a compile error that names the fix, also `default: null` for a value
that may be missing. `load` evaluates its key first. When the key holds a value that fits the load's type, `load`
returns a copy without evaluating the default. Otherwise it evaluates and returns the default. `load` never writes: the
default is not stored. Only `save` creates or changes a stored value, apart from the Player's Debug storage editor, a
debugging tool whose edits the next `load` reads like any stored value (see `RUNTIME.md`, Script storage).

A `load` of a key written as one string literal without `${...}`, also in parentheses, reads the stored value as the
declared type of the variable it starts or is assigned to, such as `integer | string` above, or else as the type that
another load of the key declares, in any file, or else as its default's type
([ADR 0021 §6](../decisions/0021-static-types.md)). A key is declared at most once: two loads that declare different
types are a compile error. `default: null` makes the result the key's declared type made optional, such as `string?`;
without a declared type for the key it is a compile error that names the fix. A default of a type the compiler cannot
know, without a declared type, gives a value of unknown type ([§13](#13-explicit-types)). Loads without a declared type
agree: of two load types, one accepts every value of the other, as `number` does `integer`, or the later load is a
compile error. A `save` under the key must fit the type of every load of it, or it is a compile error; saves never
decide the type, and a key that no load reads is not checked:

```text
let level = load("level", default: 1)
save "high" as "level"   // compile error: "level" is loaded as a whole number (integer) on line 1
```

A key computed at runtime, such as `"toys.${id}"`, `"toys." + id`, or a variable, has no type, and its `load` gives a
value of unknown type.

A stored value that does not fit the load's type, such as a value that an older version of the script saved, is not
returned. `load` reports developer warning `TSW016`, which names the key and both types, and evaluates and returns the
default. With an object default, `load` works per field, as `fromJson` reads JSON as an object
([§13](#json-and-base64)): a missing field, or one whose stored value has the wrong type, takes that field's value from
the default, and `TSW016` names the field, instead of the whole default being returned. The stored value stays as it
is, and each such `load` warns again until a `save` replaces it. A saved value
that the compiler cannot know, also under a computed key that equals a key a load reads, must fit the type every load
of that key accepts, or the `save` raises runtime error `TSR058`.

The bounded form takes the key and the named `default:` inside `()`, where line breaks follow the rules of other
arguments. Its `)` ends the `load`, also with a space before `(`, so the result combines directly with another
expression:

```text
load("k", default: null) == null
load("a", default: 0) + 1
```

The operands of `save` and of a compact `load` are full expressions. `as` ends the value of `save`. A `, default:`
belongs to the nearest construct before it that takes one, also inside a bounded `load`: a compact `load`, or a
labelled option of a compact `askChoice`; after a compact ask it is the ask's earlier name of `prefill:`, an error
([Prefilled answers](#prefilled-answers)). Group the inner construct, or use a parenthesized ask, to give the fallback
to `load`, as in `load(askText("Key?"), default: "none")` or
`load((askChoice a: "x", b: "y"), default: "z")`; without the inner parentheses, the choice gets a third option labelled
`default`. Inside `()`, `[]`, and object literals, where a line
break does not end an expression, the comma may also start the next line. Group a compact `load`, as in
`(load "k", default: null) == null`, before combining its result with another expression. Without parentheses,
`load "k" == null` uses `"k" == null` as the key, which is not a string. Group a nested compact `load` used as a key
too. A compact interaction inside a `save` value ends at the `as`, which belongs to `save`:
`save askText as "name"` asks and stores the answer, while an interaction with its own speaker clause is grouped, as in
`save (askText as mistress "Name?") as "name"`. A default may suspend, such as
`load "name", default: askText "Your name?"`; it starts only when the key is absent and can resume across checkpoint
restore. The earlier form without the comma and colon, `load "k" default 0`, is a compile error that names the fix.

Delete a value:

```text
delete "player.name"
```

Deleting an absent key is a no-op.

A write is atomic. Without persistent storage, such as in tests or a development preview, storage is session-local:
a later `load` in the session sees the saved value at once. When the host persists storage, `save` and `delete` wait
until the host acknowledges the write, and only a successful write changes what later `load` calls see. A failed write
keeps the previous value, or leaves the key absent, reports developer warning `TSW014`, and the script continues. A
timer or media block due while a write waits runs after the write settles, at its own due time.

Rules:

- The engine preserves the stored TeaseScript type; scripts do not serialize every value to plain text manually.
- The physical database representation is an implementation detail and may use typed columns, tagged JSON, or another typed serialization.
- A loaded value that the compiler cannot know, through a computed key or a default of unknown type, must fit the type
  of the place that receives it ([§13](#13-explicit-types)), or runtime error `TSR058` is raised; so does a default of
  unknown type that does not fit the declared type of the variable it starts.
- Persistent plain data is storable. Timer, media, and message handles and speaker references exist only in the
  current session and cannot be saved, including when nested inside lists or objects (`TSR055`); save a message's
  `text` instead. Because `load` gives its default in place of a saved value, a default whose type is known to hold a
  speaker, camera view, permanent button, or timer, media, or message handle is a compile error (`TSV043`). Nested
  `null` is allowed.
- Saving and loading copy data: later changes to the saved variable or a loaded value do not change storage.
- A string naming a camera, file, or media reference is stored only as a string; storage itself does not persist the
  media. A photo from `takePhoto()` or an image from `askImage(...)` is kept by the Player while saved storage
  references it (§33).
- Storage keys are plain strings.
- A key that the compiler can see is not a string, also inside parentheses, is a compile error (`TSV038`). Other keys
  are checked at runtime and raise `TSR054` if non-string. For `load`, the diagnostic explains:
  `Storage key must be a string. To compare the loaded value, write 'load("k", default: null) == null'.`
- Dots and slashes inside a key are naming conventions only.
- The complete string is treated as one key.

Storage currently supports strings, finite numbers, booleans, lists, objects, sets, dicts, ranges, durations, angles,
date and time values, `script` references ([§29](#29-script-files-and-paths)), and regexes ([§8](#regexes)), including
nested `null`. Wider persistent-data support is not yet implemented; this subset is not a permanent language limit. The
compiler rejects a default whose type is known and does not fit the declared type. Replacement-value recovery under
[§34](#34-runtime-warnings-and-recoverable-values) is not yet implemented.

Examples:

```text
"player.score"
"player/preferences/volume"
```

Structured object-path forms are not used:

```text
save score as player.score
save score in player.score
```

## 26. Labels and goto
**Status:** Accepted

```text
label tooLate

say "Too late"

goto tooLate
```

Rules:

- A label stands only in a file's outer scope, not inside `if`, loops, functions, or handlers. A `goto` may appear
  anywhere, but not a bare `goto label` in a global function ([§11](#global-functions)).
- Labels are local to their file; `goto label` moves within the current file. Another file is entered only at its top
  ([§29](#29-script-files-and-paths)).
- Unknown labels and duplicate labels in one file are compile errors.
- A `goto` discards the current function, loop, and block continuations.
- Top-level `let`s are not hoisted: a `let` sets its variable when it runs. A `goto` back to an earlier label runs the
  top-level `let`s after it again, which set their variables anew. A variable of the file may be used after a label only
  when every way to the label has run its `let`; otherwise it is a compile error.
- A `goto` triggered by an event aborts the current execution path and does not return.

## 27. Timers
**Status:** Accepted (Owner decisions on PR #443, 2026-09-30)

One `timer` concept covers blocking and asynchronous countdowns. `wait` is the shorthand for a hidden blocking
timer and shares its clock, checkpoint, and restore behavior.

### Short form

```text
wait 10 s                                 // hidden, blocking
timer 10 s                                // visible, blocking
timer mystery (5..10) s "Hold"            // mystery, blocking, labelled
timer async 30 s "Deadline" { ... }       // visible, asynchronous, with an expiry block
let t = timer async hidden 2 min { ... }  // keeps the handle
```

`timer [async] [visible|mystery|hidden] <duration> ["label"] [{ expiry block }]`: the execution modifier
comes first, then the presentation, the duration, an optional string-literal label, and the expiry block. Omitted
modifiers mean visible and blocking. `async`, `visible`, `mystery`, and `hidden` are recognized only directly after
`timer`; write `timer (hidden)` to use a variable of that name as the duration.

The duration is an exact duration with its unit ([§35](#durations)), such as `500 ms`, `2 min`, or `n s`. A number
without a unit is a compile error that names the fix, such as `wait 5 s` for `wait 5`, and a runtime error when the
compiler cannot see it ([ADR 0026](../decisions/0026-unified-time-semantics.md#8-explicit-units-for-time-quantities)).
A unit after a number belongs to that number alone, so `wait 15 + randomInteger(0..35) s` adds a number and a duration,
which is an error. Write `wait (15 + randomInteger(0..35)) s` instead.

A wait or timer also takes a range with an exact unit after it, `wait (1..3) s`, `timer (1..=4) h`, or
`wait (100..500) ms`, or a range in a variable, `timer r min`. It counts whole units, so `wait (1..3) min` waits 1 or 2
minutes like `wait randomInteger(1..3) min`. It is drawn from the session RNG after the operands are evaluated: once for
a wait, and once per round for a timer. A calendar unit after a range is an error, as for any calendar duration. The
range needs its parentheses: in `timer 5..10 s` the unit belongs to `10` alone, which is a compile error that suggests
them. A negative duration is an error, and `wait 0 s` and `timer 0 s` continue immediately.

### Named form

```text
let beat = timer(duration: (1..=3) s, async: true, display: "mystery", label: "Beat", repeat: true, persist: true) {
    say "Beat."
}
```

The named form carries the same fields plus `repeat` and `persist`. `async`, `repeat`, and `persist` are the
literals `true` or `false`; `duration`, `display`, and `label` are expressions evaluated in source order. `duration`
is a duration, or a range with its unit after it, such as `duration: (5..=10) s` or `duration: r s`, which is drawn for
each round as in the short form. `display` defaults to `visible`, and an expression must evaluate to `"visible"`,
`"mystery"`, or `"hidden"` for blocking and asynchronous timers alike.

### Blocking and asynchronous timers

A blocking timer returns no handle; using one as a value, or giving it an expiry block, `repeat: true`, or
`persist: true`, is a compile error. An asynchronous timer lets the script continue and evaluates to an opaque handle, which may be
ignored. Standalone `startTimer`, `stopTimer`, and `mysteryTimer` spellings are not TeaseScript syntax.

### Handles

```text
t.pause()
t.resume()
t.stop()
if t.remaining > 10 seconds { ... }
t.remaining += 10 s        // current round only
t.remaining -= 5 s
t.remaining = 20 s
t.repeatDuration = 50 s    // later repeat rounds only
t.display = "mystery"
```

Readable properties are `remaining` and `elapsed` (durations), `display`, `label`, `state`, and `repeatDuration`.
Assignable properties are `remaining` (`=`, `+=`, `-=`), `display`, and `repeatDuration`. Changing `repeatDuration`
affects future rounds, not the current round.

`elapsed` is active running time since the first start across all rounds, excluding explicit pauses; `remaining`
concerns the current round. `state` is `running`, `paused`, `finished`, or `stopped`:

- reads stay valid after the timer settles; `remaining` is then zero and `elapsed` is frozen;
- `pause()` while paused, `resume()` while running, and `stop()` on a finished or stopped timer do nothing, except
  that `stop()` on a finished timer cancels its expiry blocks that have not started yet (owner decision, 2026-10-20);
- other lifecycle methods or property assignments on a finished or stopped timer have no effect and report
  developer warning `TSW010` with the source location;
- adjusting `remaining` while paused changes the current round and the timer stays paused;
- setting or reducing `remaining` to zero expires the current round at once; remaining time never becomes negative;
- `stop()` on an active timer cancels it and any of its expiry blocks that have not started yet.

Unknown handle members are compile errors when the handle's variable is initialized from `timer async`; values
of the wrong type are rejected.

### Repeat, persistence, and cleanup

- `repeat: true` starts another round when a round expires. A repeating range draws a new duration for each round;
  every round must last longer than zero. Rounds that expire during one late time observation keep their original
  schedule and each run the expiry block once.
- Every timer stops on `exit` and when the session ends.
- A non-persistent timer belongs to the file entry that started it ([§29](#29-script-files-and-paths)). It is removed
  when that entry is left: by a `goto`, within the file or to another file, by its `end`, or when a block's `goto`
  abandons it. A `call` does not leave the caller, so the caller's timers keep running during the call. Persistent
  timers remain active until `exit`.

### Expiry blocks

The block runs when the timer expires. It does not need an `onFinish` wrapper and runs without pausing currently
playing audio or video. It may use top-level names, the variables of the code that started the timer, which it shares
([§14](#variables-in-timer-media-and-button-blocks)), its own locals, normal functions, and new timers.

A due block interrupts at the next deterministic runtime boundary, including while the main path waits on an
interaction, `wait`, blocking timer, media, or a message's reading time; inside a
[`noInterrupts` block](#nointerrupts-blocks), it waits until that block ends. The interrupted action is inert while
the block runs, so there are never two active story paths:

- if the block completes normally, the interrupted action is presented again and the script continues where it
  left off;
- if the block uses `exit`, the session halts and the interrupted action and source instruction are discarded:
  an interrupted `let answer = askText ...` completes nothing and binds no value.

A `goto` from the block, also from a function that the block calls, discards the interrupted action and instruction
in the same way.

While a block runs, what the main path waits on stands still, and after a normal return it continues with the time it
had left: a `wait`, a blocking timer and its visible countdown, a message's reading time, and the timeout of
`showButton` or `askForm`. The elapsed time a `showButton` returns leaves out the time the block ran. Asynchronous
timers and media keep running, and a wait for media to end ends with the media, also while a block runs (owner
decision, 2026-10-11).

Blocks run one at a time in due order. A block may itself wait; later expiries queue behind it.

### `noInterrupts` blocks
**Status:** Accepted (Owner decision, 2026-10-20); not yet implemented, planned after the O4 type-checker switch.

Timer, media, and permanent-button blocks do not interrupt the code inside a `noInterrupts` block; they wait until it
ends. `noInterrupts` is a grammar keyword ([§38](#grammar-keywords)) followed by a block in braces, as after `if`. The
code inside may itself wait, and its waiting works as usual: a message's reading time, `wait`, a question or blocking
button such as `askText`, `askChoice`, or `showButton`, and a function that waits.

```text
timer async hidden 3 s {
    say "Time is up.", instant
    wait 2 s
}
noInterrupts {
    say "Read this first.", instant
    wait 10 s
}
say "Go on.", instant        // "Time is up." at 10 s, then "Go on." at 12 s
```

- Timers keep counting and media keep playing: a timer expires at its own time and, if it repeats, starts its next
  round then. Only their blocks wait, queued in due order as usual, also the blocks of timers and media that start
  inside the block. Nothing is dropped, paused, or merged, and every round of a repeating timer runs its block once.
- Once execution leaves the outermost `noInterrupts` block, the queued blocks run one at a time, before the next
  ordinary statement. Each block starts then, so in the example the timer block's `wait 2 s` ends at 12 s. Inside a
  timer, media, or button block, the queued blocks still wait until that block finishes, since blocks run one at a
  time. The protection starts when execution enters the block; a block due before then interrupts as usual.
- A permanent button (`showPermanentButton`) can still be clicked, and its click is kept: the button's block joins the
  queue at the click and runs after the `noInterrupts` block. As after any click, the button is then inactive until its
  block finishes ([§28](#28-permanent-buttons)), so pressing it again adds nothing.
- A loop inside the block that waits for a variable that only a timer, media, or button block changes never ends,
  because those blocks wait until the block ends. The compiler warns when it can tell: when nothing in the loop,
  including the functions it calls, assigns that variable, and such a block does. Where it cannot tell, there is no
  warning. For a button block that changes `done`, the warning reads "This loop waits for 'done' to change, but the
  button block that changes it cannot run inside 'noInterrupts'. Move the loop outside the block." (not yet
  implemented; built with the block).
- The protection covers all code that runs inside the block, waits included: the functions it calls, and a file it
  runs with `call`, whose `end` returns into the block. The end of an inner `noInterrupts` block does not end the
  protection of an outer one.
- A label cannot stand inside the block, because a label stands only in a file's outer scope
  ([§26](#26-labels-and-goto)), so no jump enters the block halfway.
- A `goto`, `return`, `break`, `continue`, or `end` that leaves the block, also a `goto` or `end` in a function it
  calls, ends the protection of each `noInterrupts` block it leaves. A `return` to a protected caller keeps the caller
  protected.
- `exit` and a runtime error end the session; the queued blocks do not run.
- Stopping a timer or media or removing a button cancels its queued blocks, as outside the block
  ([§22](#22-stage-image-audio-and-video), [§27](#handles), [§28](#28-permanent-buttons)). For a timer or media that
  has already finished, `stop()` on its handle does so, but `stopAudio` and a new Stage video or image do not. Leaving
  the file entry of a non-persistent timer or button also cancels its queued blocks
  ([§27](#repeat-persistence-and-cleanup)).
- A checkpoint taken inside the block resumes inside it, with the queued blocks and kept clicks, and never runs them
  early or twice.

### Timeline cues and self-handle (planned)
**Status:** Accepted direction; not implemented. It follows the timer foundation separately.

```text
let t = timer async 60 s {
    at 20 s {
        say "Twenty seconds elapsed."
    }
    beforeEnd 10 s {
        say "10"
    }
    finish {
        say "Done."
    }
}
```

Timers will use the cue model of [§22](#22-stage-image-audio-and-video): a block holds either ordinary statements or
cue declarations; `at` is measured from the start of a round and `beforeEnd` back from its end; both fire on every
natural passage, including repeat rounds; `finish` runs once after the final round and never after `stop()`; an
assignment to `remaining` that jumps over a cue does not fire it; and cue blocks run one at a time like expiry blocks.
The existing compact block stays the per-round expiry block, like `beforeEnd 0 s`. A timer block of
`let NAME = timer async ...` will likewise see `NAME` as its own handle; until then `NAME` is not visible in its own
block, because it is declared only once the timer has started.

### Time

Timers and `wait` measure Player-executed scene time. Presentation and blocking do not change the clock. Time keeps
running while a live Player is minimized or in the background; when the Player is closed and later restored,
including on another device, the gap does not consume timer time and the timer continues with its saved remaining
time. A script plays the same however late or often the Player observes time: everything happens at its own moment
in scene time. See [`RUNTIME.md`](../RUNTIME.md#timers-and-scene-time) for the observation contract.

A `wait` or timer whose length is written in days or weeks gets warning `TSV061` on that length (owner decision,
2026-10-10), because such a length almost always means real time. This covers the units `d`, `day`, `days`, `w`, `week`
and `weeks`, also in a range or a sum, as in `timer (1..3) days` and `wait 1 day + 2 h`. A length held in a variable,
read from a list or object, or returned by a call is not checked:

```text
wait 2 days     // TSV061: 'wait 2 days' counts only time while the Player is open, so closing the Player pauses it.
```

Scene time is measured in milliseconds, including fractional milliseconds, up to 2^53 − 1, about 285,000 years. A `wait`, timer, or `showButton` timeout
longer than that can never end; the compiler rejects one it can see, such as `wait 1e15 s`, and any other is a runtime
error.

A `wait` after a paced message starts when the message's reading time ends, so it adds its whole duration; for exact
timing, say the message `instant` (owner decision, 2026-10-11).

## 28. Permanent buttons
**Status:** Accepted (inactive while the handler runs: Owner decision on #610; `persist:` on the command: Owner
decision on #627; both 2026-10-05)

A permanent button remains available while the script continues and returns an identifier, which may be ignored. Its
block is inherently the click action, so no `onClick` wrapper is used:

```text
let buttonId = showPermanentButton "Add one" {
    incrementCounter()
}
```

A button may jump to a label:

```text
let buttonId = showPermanentButton "Stop" {
    goto stopped
}
```

Persistent button; `persist:` configures the button, so it follows the text on the command and takes the literal `true`
or `false` (the default):

```text
let buttonId = showPermanentButton "Fail", persist: true {
    goto retry
}
```

Remove a button with the `remove()` method of its handle; removing a button that is already gone does nothing (owner
decision on #836, 2026-10-11):

```text
buttonId.remove()
```

`remove()` takes no arguments and gives `null`, and it is the button handle's only method. Removing a button also
cancels a click whose block has not started yet (owner decision, 2026-10-20). The earlier command
`removePermanentButton` stays protected: its call is a compile error that names `buttonId.remove()`.

The text follows the rules of other button labels ([§16](#lists-in-text)). Buttons appear in the order they were shown.

Click and handler behavior:

- A click runs the handler once, like a timer expiry block ([§27](#expiry-blocks)): it interrupts at the next
  deterministic runtime boundary, also while the main path waits on an interaction, `wait`, media, or a message's
  reading time, and waits while another block runs or until a [`noInterrupts` block](#nointerrupts-blocks) ends.
  The interrupted action returns when the handler finishes.
- From the click until its handler finishes, the button stays in place but is inactive and cannot be clicked. It
  becomes active again unless it was removed.
- The handler shares the variables of the code that showed the button
  ([§14](#variables-in-timer-media-and-button-blocks)).
- A `goto` handler abandons the interrupted execution path.
- Function handlers do not pause currently playing audio or video.

Duplicate labels:

- Multiple permanent buttons may use the same visible text.
- Buttons are tracked by their returned identifiers, not by visible text.

```text
let firstButton = showPermanentButton "Unknown" {
    goto optionA
}

let secondButton = showPermanentButton "Unknown" {
    goto optionB
}
```

Cleanup:

- A non-persistent button belongs to the file entry that showed it, as a non-persistent timer does
  ([§27](#27-timers)): it is removed when that entry is left by a `goto`, by its `end`, or by a block's `goto` that
  abandons it, and on `exit`. A `call` keeps it.
- A persistent button survives `goto`, `end`, and `call`.
- Every permanent button disappears on `exit`.

## 29. Script files and paths
**Status:** Accepted ([ADR 0022](../decisions/0022-multi-file-scripts.md))

A package consists of one or more `.tease` files. The fixed entry file is `main.tease`; a session starts at its top.
Paths are relative to the package root and separate folders with `/`. A file may start with a header that describes
and tags it, and `goto tagged`, `call tagged`, and `findScripts` pick files by those tags
([§41](#tagged-selection)).

Go to another file, which starts at its top:

```text
goto "punishments/strict.tease"
```

Call another file, which starts at its top; execution continues after the `call` when that file reaches `end`:

```text
call "corner-time/short.tease"
```

A glob pattern picks one matching file at random:

```text
goto "punishments/*.tease"
call "corner-time/*.tease"
```

A computed target needs the explicit conversion `script(path)`:

```text
goto script("rooms/${room}.tease")
let next = script("rooms/hall.tease")
goto (next)
```

Rules:

- `goto` to another file replaces the current file and does not return. Pending `call` returns remain; the current
  function, loop, and block continuations are discarded.
- `call` keeps the current position, including an enclosing function or loop, and resumes after the `call` when the
  called file reaches `end`.
- A file is entered only at its top. A label after a file target, a glob, or a tagged pick, and `label:` in
  `script(...)`, are compile errors: use a local `goto label` within a file, a function for a part that returns, or a
  separate file.
- A `call` starts another file, so a `call` that can start the running file is a compile error: `call label`, a `call`
  of the file it stands in, a glob or tagged pick that can choose that file, and in a global function a `call` that can
  start a file that calls the function. A timer, media, or button block runs later, while its file or a file it called
  runs, or after it, so for a `call` in a block the running file is the file running when the block runs. Where the
  compiler cannot prove whether a `call` can start the running file, the call is checked when it runs
  ([§13](#compile-errors-warnings-and-checks-when-the-script-runs)): starting the running file is a runtime error then.
- Each entry into a file, by a `goto` or `call` naming it, starts at its top with fresh top-level variables of that
  file. A `goto` to a label of the file continues with the variables of the entry it runs in.
- A function sees the top-level variables of the entry that called it, and a timer, media, or button block those of the
  entry that created it, also after the session has left that entry. A block also keeps the local variables it shares
  ([§14](#variables-in-timer-media-and-button-blocks)), although a transfer discards the function, loop, and block
  continuations that declared them.
- `end`, also in a function or block, ends the running file and returns after its `call`. A file called from a block
  returns into that block.
- A `goto label` in a block of an entry other than the running one continues that entry at the label, with its own
  variables. If that entry called the running file, the calls above it are abandoned and its own callers stay; if the
  session had left that entry, it takes the place of the running one.
- A path that leaves the package and a missing file are compile errors.
- In a glob, `*` stands for any characters within one folder or file name. Globs are expanded at compile time. A glob
  only picks files that do something: the matched files that do not hold declarations only. A glob with no such file
  is a compile error. A `goto` glob may pick the file it stands in.
- Each time a glob target runs, one draw from the session random generator picks the file. Restoring a checkpoint never
  draws again.
- `script(path)` returns a `script` reference to a file; the path is text. Plain text is not a jump target. A reference
  is a value: it can be stored in variables, lists, dicts, sets, and globals, saved with `save`, and compared with `==`
  by path. It shows as the call that makes it, such as `script("rooms/hall.tease")`, has no properties or methods, and
  is not an `askChoice` value. A computed target, a `script(...)` call or a grouped expression such as `goto (next)`,
  must be a reference.
- A `script(...)` whose path is literal, quoted text without `${...}`, is checked like a file target: a path that leaves
  the package, a missing file, a glob, and a `goto` to a file of declarations only are compile errors, also for another
  reference whose target the compiler can see. Any other reference is checked when a transfer uses it: a missing file,
  or a `goto` to a file of declarations only, is a runtime error.
- Reading or assigning a variable of the file whose `let` has not run in this entry into the file, as in a function
  called before the `let`, is a runtime error.
- Functions and labels are local to their file.
- There is no `run` and no automatic selection of a next file; the script states every transfer.

## 30. Script endings
**Status:** Accepted ([ADR 0022](../decisions/0022-multi-file-scripts.md))

End the current file and return to the file that called it:

```text
end
```

Finish the session:

```text
exit
```

Behavior:

- `exit` is the only normal way to finish the session, and it is always required, in `main.tease` too. It works
  anywhere, including in a called file or a function, and never returns. A project with no reachable `exit` does not
  compile.
- `end` ends the current file, also from inside a function or block, and returns to the file that `call`ed it.
- An `end` that a way the compiler can follow, through files written out, globs, and references whose target the
  compiler can see, reaches with no pending `call` is a compile error, also when another way reaches the same `end`
  through a `call`, as in `if pick { call "scene.tease" } else { goto "scene.tease" }`. The message points to `call`,
  `goto`, or `exit`. Where a computed target, such as a reference in a variable or a tagged pick, or a timer, media, or
  button block, which runs later, hides the way, it is a warning (`TSV071`), and reaching that `end` with no pending
  `call` is a runtime error.
- A reachable end of a file without `end`, `exit`, or a transfer is a compile error in every file. A file of
  declarations only (functions, global functions, speakers, and globals without `default:`) runs nothing on its own
  and needs no ending; a `goto` into such a file is a compile error. A call
  counts as returning, also of a function that always ends the session, so `exit` or `end` still follows it. Branches
  that all end or transfer need nothing after them:

```text
if passed {
    goto "rewards/praise.tease"
} else {
    exit
}
```

- A file may contain multiple reachable `end` or `exit` statements.
- `finish` is not used as an alternative to `end`.

Static analysis should warn, but not necessarily fail compilation, when:

- statements are unreachable (`TSV065`);
- an `exit` is declared but unreachable (`TSV066`);
- a `wait` or timer has a length written in days or weeks, which counts only time while the Player is open (`TSV061`,
  [§27](#time));
- a loop has no way out once it starts (`TSV058`, on its `while` or `goto`): `while true`, with or without parentheses,
  or an unconditional top-level `goto` back to an earlier label of its file, whose loop is the statements between them.
  A `break`, `return`, `end`, `exit`, any other `goto`, a file `call`, or a call of an author, host, or library function
  anywhere in the loop is a way out, also nested, but not in a branch that can never run, such as `if false { break }`
  or a branch its types rule out (owner decision, 2026-10-16). So is one in any timer, media, or button block of the
  project, which then silences the warning in every file. Recursion and cycles through several labels or files are not
  checked.

## 31. Popups and system notifications
**Status:** Accepted

### Popup

A popup blocks until the user closes it.

Default button text:

```text
showPopup "Task completed"
```

Custom button text:

```text
showPopup(
    message: "Task completed",
    buttonText: "Continue"
)
```

Rules:

- `message` is required.
- `buttonText` is optional and defaults to `"OK"`.
- `showPopup` has one confirmation button.
- Yes/no questions use `askBoolean(...)`, not `showPopup`.

**Status (Owner decision, 2026-10-13):** the popup is a dialog outside the chat with its message and one button, which
closes it. The player can only close it, and `buttonText` only renames the button.

**Status (Owner decision, 2026-10-13):** `showPopup`, in both forms, returns how long the popup was open until the
player closed it as a `duration`, exactly like the elapsed waiting time `showButton` returns
([§21](#21-blocking-button)). The return value may be ignored.

```text
let t = showPopup "Stand in the corner. Click when you're done."
if t < 5 min {
    say "Back already? Again."
}
```

### Export text
**Status:** Accepted (Owner decision, 2026-10-13)

```text
exportText(report)
exportText(report, title: "Your report", fileName: "report.json")
```

`exportText` shows a dialog with its title and the text in a read-only code field, which scrolls when the text is
long, and the buttons Copy, Download, and Close. The script waits until the player closes it, as for `showPopup`.

- `title` is optional and defaults to `"Copy or download"`. `fileName` is optional and defaults to `"text.txt"`.
- Copy copies the whole text. When the browser refuses or cannot copy it, the text is selected for copying, with a short
  hint to use Download.
- Download saves the text as the file `fileName`, of type `text/plain;charset=utf-8`.
- Nothing enters the transcript. A reload while it waits shows it again. Copying and downloading are the player's own
  actions, which a replay never does.
- `exportText` gives no value.

### System notification

```text
notify "Task completed"
```

Permission handling and unsupported environments are runtime implementation details.

## 32. Switch statements
**Status:** Accepted

```text
switch action {
    case "open", "unlock" {
        openDoor()
    }

    case "leave" {
        leaveRoom()
    }

    default {
        say "Nothing happens"
    }
}
```

Rules:

- Parentheses around the switched expression are optional.
- The switched expression is evaluated once. The cases are then tested in source order, and only the first matching
  case runs. Cases do not fall through, and `break` is not used to end a case.
- Every `case` uses a required block.
- A `case` lists one or more values separated by commas and matches when any of them matches.
- A case value is a literal (text without `${...}`, a number, duration, or angle with an optional sign, `true`, `false`,
  or `null`), a declared speaker, or a range with a number literal on each side. A literal or speaker matches when the
  switched value `==` it.
- A range matches a number within its bounds (§6): `1..5` matches `1 <= value < 5` and `1..=5` matches
  `1 <= value <= 5`, including numbers that are not whole, such as `4.5`. A value that is not a number, such as `null`,
  never matches a range.
- A type case, `case is T` or `case is not T`, tests the switched value like `value is T` ([§13](#13-explicit-types)).
  It tests one type; a union covers several, as in `case is integer | string`. A case has either values or a type test.
- When the switched value is a variable or a stable path ([§13](#type-tests-and-narrowing)), it narrows as in an
  `if`/`else if` chain: the block of `case is T` knows
  the type `T`, the block of `case is not T` what remains without `T`, and a `case null` block knows `null`. Every later
  case and `default` know only what the cases above did not take.

```text
function describe(answer: integer | string?) {
    switch answer {
        case null { say "No answer" }
        case is integer { say "Number ${answer + 1}" }
        default { say "Text of length ${answer.length}" }    // answer is a string here
    }
}
```

- `default` is optional. It comes after the last case, runs when no case matches, and appears at most once.
- `return`, `break`, and `continue` inside a case block behave as inside an `if` block; `break` and `continue` apply to
  the enclosing loop.
- Compile errors:
  - a case value that is not one of the forms above, such as a range with a computed bound (use `if` instead);
  - a range that contains no numbers: `5..5` excludes its end (write `case 5` or `5..=5`), and a reversed range such as
    `5..1` contains none either, since a range never counts down (write `1..5` or `1..=5`);
  - a case value that repeats or overlaps an earlier case value (§6), such as `2` after `2.0` or after `1..5`;
  - a case value whose type can never match the switched value's known type, such as `case "x"` on an `integer`, or a
    range on text.
- Compile warnings: a case that can never match because of what the switched value can hold, such as a type case that
  no value left by the cases above passes, `case 5` after `case is integer`, or `case "maybe"` on an `askChoice` that
  only returns `"yes"` or `"no"` ([§19](#19-choices)).

## 33. Browser API: file, folder, camera, and URL references
**Status:** Accepted

File, folder, and camera APIs return engine-managed string references or `null` when cancelled:

```text
let file: string? = chooseFile()
let folder: string? = chooseFolder()
let photo: string? = takePhoto()
let taggedPhoto: string? = takePhoto(tags: ["bedroom"])    // joins the image catalog, see §41
```

The returned string may be passed directly to compatible APIs:

```text
if photo != null {
    showImage photo
}
```

```text
if file != null {
    playVideo file
}
```

Open a URL:

```text
openUrl("https://example.com")
```

`openUrl(...)` performs navigation and returns no value.

Button text and a button that always shows:

```text
openUrl("https://example.com", buttonText: "Claim your reward")
openUrl("https://example.com", alwaysButton: true, buttonText: "Claim your reward")
```

**Status (Owner decisions, 2026-10-13):** `openUrl(...)` waits until the URL is open in a new tab. That is usually
immediate, and when the browser needs a click from the player first, the Player shows a button for it where
`showButton` shows its button, without the URL. After a reload, a restore, or a replay the Player never opens the URL
by itself: a restored waiting `openUrl(...)` shows the button. Only `http` and `https` URLs open: another URL is a
compile error where the compiler can see it, as for a written one, and fails at runtime otherwise.

Rules:

- `buttonText` is optional and is the text of the button, `"Open link"` by default, with the rules of `showPopup`'s
  `buttonText`.
- `alwaysButton` is optional, `true` or `false`, and defaults to `false`. With `true` the Player always shows the
  button, also right after a click, and the script waits for the click on it. With `false` the Player opens the URL at
  once after a recent click and shows the button only when the browser needs that click.
- Either way the script goes on once the tab is open.
- A wrong type or an unknown named argument is a compile error, as for other named arguments.

How the browser internally stores or resolves references, handles permissions, or opens the URL is an engine implementation detail, not part of the language syntax.

`takePhoto()` **status (Owner decisions, 2026-10-02):** `takePhoto()` captures silently from the camera stream the
Player opened at session start ([`SECURITY.md`](../SECURITY.md)) and returns the photo's engine-managed reference. When
no usable camera is available it returns `null`, emits a non-fatal developer warning, and the script continues. A new
photo is session media. It becomes durable only while its reference is reachable from saved script storage (§25),
including a reference nested inside a saved composite value; `load` in a later run then returns the same reference,
which resolves to the same photo. Several saved values may share one photo: removing or overwriting one of them keeps
the photo while another still references it, and once no saved value references it the photo may be reclaimed, lazily.
Clearing a script's saved data releases photos retained only by that data. If a saved photo cannot be stored durably,
the `save` fails like any failed persistent write (§25): the script continues with a non-fatal developer warning and the
previous value, the photo stays usable for the current session, and no reference is persisted that would look valid
after a reload without its photo. A string is a usable media reference only when the trusted Player media store resolves
it; a well-formed string, including one returned by `load`, grants no access by itself.

### Stored files
**Status:** Accepted (Owner decisions, 2026-10-13)

```text
fileFromBase64(text, default: value)
fileToBase64(file)
```

`fileFromBase64` stores the bytes that Base64 `text` holds as a file in the Player's file store and returns its
store-issued file reference, a `string` like a photo reference. It reads Base64 as `fromBase64` does, with spaces and
line breaks, the URL alphabet, and missing padding ([§13](#json-and-base64)), and also a `data:<type>;base64,…` URL.
`default:` is required and is text or `null`, or of another type only where a written union holds both
([§18](#defaults-follow-the-same-rule)); text that is not Base64 gives the
default, which is evaluated last, and only when it is used (owner decision, 2026-10-16). `fileToBase64` reads a stored
file's bytes and returns them as plain Base64 text, and `hashFile` gives their SHA-256 ([§13](#hashes)). Storing a file
and reading one each take a short wait, as a photo does. The result is recorded: a restore or a replay can reuse a
recorded result without asking the store again. The Base64 text may be as long as any text.

A file's type comes from its first bytes, never from a file name or the type in a data URL:

| Kind | Types |
| --- | --- |
| Image | JPEG, PNG, GIF, WebP |
| Audio | MP3, Ogg, WAV, M4A |
| Video | MP4, WebM |

Any other file is `application/octet-stream`. A stored file of any other type, such as SVG or HTML, is never shown or
played: a script can only store it, pass it along, or turn it back into Base64. This rule is about stored files, whose
bytes can come from outside the package; it does not apply to HTML or custom UI that the package's own code provides
([`LIBRARIES.md`](../LIBRARIES.md#package-libraries)). An image works where a photo reference works, such as
`showImage` and `save`/`load`. A stored file has the lifecycle of a photo (`takePhoto()` status above).

```text
let picture = fileFromBase64(base64, default: null)
if picture != null {
    showImage picture
    save picture as "picture"
}
```

## 34. Runtime warnings and recoverable values
**Status:** Accepted

Using a possibly null value without an explicit check, where its non-null type is required, is a compile error
([§18](#18-null-and-optional-values)); a check on every route that the compiler cannot keep gives a compiler warning
and a check when the script runs instead ([§13](#type-tests-and-narrowing)). Commands that accept `null` themselves,
such as media commands, still take it; see the fallback below.

Compatible built-ins may apply a safe fallback. For example, `showImage null` clears the Stage image, reports developer warning `TSW011` with the source location, and continues ([§22](#22-stage-image-audio-and-video)).

When one replacement value can safely continue execution, the runtime may allow a replacement value to be supplied.

Suitable examples:

### Missing media reference

```text
showImage photo
```

A valid string reference may replace the missing value.

### Invalid number from stored or external data

```text
let volume: number = load("settings.volume", default: 0)
```

A valid number may replace an invalid stored value. A `load` already uses its default for a stored value that does
not fit its type ([§25](#25-persistent-storage-and-keys)).

### Invalid list index

```text
let item = items[99]
```

A replacement value may be supplied for `item`.

### Empty list in interpolation

```text
say "${names}"
```

When `names` is empty, execution reports that no element can be selected. A replacement text value may be supplied when runtime recovery is enabled.

Recovered errors should record:

- script file and source line;
- technical error code;
- expected and received type;
- original value;
- replacement value, when supplied;
- enough execution information to produce an exportable log for the script developer or server.

Recovery is not offered for structural errors such as malformed syntax, unknown functions, invalid labels, or internal engine exceptions. The exact recovery interface and whether recovery is enabled are runtime implementation details, not syntax.

## 35. Date, time, and durations
**Status:** Accepted (#532). Implemented: `date`, `time`, `datetime`, and `absoluteDateTime` values, their conversions,
fields, comparison, arithmetic, presentation, collections, and storage, the current-time getters, exact and calendar
durations ([ADR 0026](../decisions/0026-unified-time-semantics.md)), and date and time input
([§20](#date-and-time-input)).

TeaseScript has two kinds of time:

| Type | Meaning |
| --- | --- |
| `date` | A local calendar date without a zone, such as `2026-10-04` |
| `time` | A local clock time without a zone, such as `14:30` |
| `datetime` | A local date and clock time without a zone. It follows the player: tomorrow 18:00 stays 18:00 wherever the player is, also after saving, loading, and travel |
| `absoluteDateTime` | A fixed moment in UTC, like Unix time |
| `duration` | Exact elapsed time in milliseconds; a day is 24 hours |
| `calendarDuration` | Whole calendar months, whole calendar days, and an exact offset |

Use local values for "what clock time" and "which day", and `absoluteDateTime` for "how long ago" and "how much time
passed".

### Current values

```text
let today = getDate()
let now = getTime()
let dinner = toDateTime(getDate() + 1 calendar day, toTime("18:00"))
let started = getAbsoluteDateTime()
```

`getDate()`, `getTime()`, and `getDateTime()` return the player's current local values; `getAbsoluteDateTime()` returns
the current moment. Within one start or continue, `getAbsoluteDateTime()` never goes backwards. Local values can: after
the autumn daylight-saving change, or after travelling west. The engine reads no clock and no host time-zone or locale
data: the Player records the player's zone and presentation as session data (see
[`RUNTIME.md`](../RUNTIME.md#date-and-time-context)).

### Construction and conversion

Temporal values are written as strict ISO text with a four-digit year; there are no date literals and no locale
parsing:

```text
toDate("2026-10-04")
toTime("14:30")                         // also "14:30:15" and "14:30:15.250"
toDateTime("2026-10-04T18:00")
toAbsoluteDateTime("2026-10-04T12:30:00Z")   // also an offset, such as "2026-10-04T14:30:00+02:00"
```

Local text has no offset; absolute text requires `Z` or an offset. Fractions have one to three digits. Text that is
known at compile time and is not a valid value is a compile error, also when a `default:` is given; other text follows
the [§13](#13-explicit-types) conversion rules.

| Conversion | Converts |
| --- | --- |
| `toDate(value)` | date text, a `date`, or the date of a `datetime` |
| `toTime(value)` | time text, a `time`, or the clock time of a `datetime` |
| `toDateTime(value)` | datetime text or a `datetime` |
| `toDateTime(date, time)` | a `date` and a `time` combined |
| `toAbsoluteDateTime(value)` | absolute text or an `absoluteDateTime` |

Local and absolute values convert through the player's current zone:

```text
let deadline = dinner.toAbsoluteDateTime()
let local = started.toDateTime()
```

A local time that the spring daylight-saving change skips moves forward by the gap; a local time that the autumn
change repeats takes the earlier moment. A `date` or `time` alone cannot become an `absoluteDateTime`.

### Fields

```text
today.year
today.month
today.day
today.weekday           // "Saturday"
today.weekdayNumber     // Monday is 1, Sunday is 7
today.weekNumber        // the ISO week, 1 to 53
today.weekYear          // the year that ISO week belongs to

now.hour
now.minute
now.second
now.millisecond
```

A `datetime` has all of these fields, and an `absoluteDateTime` none: convert it first, as in `started.toDateTime().hour`.
`weekday` is the English weekday name; comparing it with text that is not an English weekday name gives a compile
warning. `weekNumber` and `weekYear` follow ISO 8601, not the player's locale: a week starts on Monday, and week 1 holds
the year's first Thursday, so 2024-12-30 is week 1 of 2025 and 2021-01-01 is week 53 of 2020. The week year of
0000-01-01 is -1. Values hold whole milliseconds.

### Durations

| Kind | Units | Meaning |
| --- | --- | --- |
| Exact (`duration`) | `ms`/`millisecond`/`milliseconds`, `s`/`second`/`seconds`, `min`/`minute`/`minutes`, `h`/`hour`/`hours`, `d`/`day`/`days`, `w`/`week`/`weeks` | Elapsed time: `1 day` is always 24 hours and `1 week` 168 hours |
| Calendar (`calendarDuration`) | `calendar` before `d`/`day`/`days`, `w`/`week`/`weeks`, `mo`/`month`/`months`, `y`/`year`/`years` | The same clock time that many dates, weeks, months, or years later, never a fixed number of hours |

A unit follows a number literal, a name, a member such as `p.delay` or `list[i]`, a call, or parentheses, and gives the
number before it that unit: `count s`, `(count / 2) min`, `randomInteger(5..=10) s`, `count * 1 h`, and
`count calendar months` ([ADR 0026](../decisions/0026-unified-time-semantics.md#8-explicit-units-for-time-quantities)).
It binds tighter than `*` and `+`, so `a + b s` is `a + (b s)`, and `(a + b) s` gives the sum the unit. The value
before a unit must be a number: a known other value is a compile error and any other a runtime error. One duration has
one unit: `5 s ms` and `1 h 30 min` are errors, and parts are added with `+`, as in `1 h + 30 min`.

Both long forms are accepted for any number: `1 seconds` and `2 day`. `month` and `year` (and `mo` and `y`) without
`calendar` are compile errors that suggest it, and `m` is not a duration unit, because it would be ambiguous between
minutes and months. `calendar` is a unit word only where a unit can stand; elsewhere it is an ordinary name. A calendar
week is 7 calendar days and a calendar year 12 calendar months. Adding months or years to a day that the target month
lacks gives that month's last day: January 31 plus one calendar month is February 28, or 29 in a leap year, and February
29 plus one calendar year is February 28. Calendar months and days are whole after normalizing: `0.5 calendar years` is
6 months, while `1.5 calendar days`, `1.5 calendar weeks`, and `1 calendar month * 1.5` are errors, at compile time when
the values are known. Exact time keeps fractions: `1 day / 2` is `12 h`.

A calendar duration stays one in every sum with a duration, also when it cancels to zero, so `1 calendar month -
1 calendar month` is a zero calendar duration, and `1 calendar month + 1 day` equals `1 day + 1 calendar month`. Exact
durations compare and divide by length: `1 week == 7 days`, `1 day == 24 h`, and `(2 days + 6 h) / 1 h` is `54`.
Calendar durations compare as their months, days, and exact offset, and order and divide within one family: months,
days, or exact offset. `1 calendar week == 7 calendar days` and `18 calendar months / 1 calendar year` is `1.5`;
`1 calendar month >= 30 calendar days` is an error. A calendar duration never equals a duration, also not at zero, and
ordering or dividing one by the other is an error. Zero belongs to every family, and dividing by any zero is an error.
`min`, `max`, and `sort()` follow the same rules.

A calendar duration has the read-only parts `.months`, `.days`, and `.exactOffset` (a duration); `.days` counts calendar
days and is not a length. A duration has no parts: divide it by a unit, as in `elapsed / 1 day`.

`wait`, timers, `say` pacing, the `showButton` and `askForm` timeouts, media positions and repeat budgets, and
assignments to timer and media `remaining`, `position`, and `repeatDuration` take a duration; a calendar duration there
is a compile error when its type is known, and otherwise a runtime error.

### Arithmetic and comparison

No operator reads a time zone.

| Operation | Result |
| --- | --- |
| `date ± calendar duration` with a zero exact offset | Months, then days |
| `datetime ± calendar duration` with a zero exact offset | The same clock time on the date that many months, then days, later |
| `absoluteDateTime ± duration` | Elapsed time |
| `date - date` | A calendar duration of whole calendar days, such as `5 calendar days` |
| `absoluteDateTime - absoluteDateTime` | The elapsed duration |

Every other combination is an error that names a route that works: `date ± duration` uses calendar units, as in
`getDate() + 1 calendar day`; `datetime ± duration` and `datetime - datetime` convert to `absoluteDateTime` for elapsed
time, as in `(dinner.toAbsoluteDateTime() + 2 h).toDateTime()`, or use calendar units or `toDate(...)`;
`absoluteDateTime ± calendar duration` converts to a `datetime` first. Exact time added to an
`absoluteDateTime` is rounded to whole milliseconds, with ties away from zero; `wait` and timers keep fractional
milliseconds. Arithmetic on `time` is not available.

A `date` orders by calendar, a `time` by clock (without wrapping at midnight), a `datetime` by calendar and clock, and an
`absoluteDateTime` by moment. `sort()`, `min`, and `max` use the same order for values of one kind. Ordering or
arithmetic across temporal kinds is an error, and `==` between different kinds is `false`. Known invalid combinations are
compile errors; others are runtime errors.

Local comparisons can reverse after the autumn daylight-saving change or after travelling west, and a day counter counts
calendar-date boundaries. Measure elapsed time with `absoluteDateTime`: across the spring daylight-saving night,
`(dinner.toAbsoluteDateTime() + 24 h).toDateTime()` is 19:00 the next day while `dinner + 1 calendar day` is 18:00.

### Display and technical conversion

`say`, `${...}`, and `toString` show every temporal value, including an `absoluteDateTime`, in the player's numeric
local form: date field order, separators, and 12- or 24-hour clock follow the player's locale, such as `4-10-2026, 18:30`
in Dutch and `10/4/2026, 6:30 PM` in US English. The exact punctuation follows the engine's locale data. Seconds appear only when
they are not zero, milliseconds never (`toISO()` keeps them), and no month or weekday names appear. `formatDate()`,
`formatTime()`, and `formatDateTime()` return the same text for part or all of a value. A duration displays in days,
hours, minutes, and seconds, such as `2 days 6 hours` or `1 minute 3.5 seconds`, and in milliseconds below a second,
such as `500 milliseconds`. Unit words are written in full, singular only for an amount of exactly 1 or -1, so `1 day`
and `1.5 seconds`. A calendar duration names each calendar part, with 12 months as a year and weeks as days, before any
exact offset, such as `1 calendar month 16 calendar days` or `1 calendar day -2 hours`; a zero one is
`0 calendar days`.

Inside a list, set, or object, temporal values use a fixed notation: `<date 2026-10-04>`, `<time 14:30>`,
`<datetime 2026-10-04 14:30>`, and `<absoluteDateTime 2026-10-04T12:30:00Z>`.

```text
dinner.toISO()             // "2026-10-04T18:00", without an offset
started.toISO()            // "2026-10-04T12:30:00Z", in UTC
started.toSeconds()        // Unix seconds, rounded down
started.toMilliseconds()   // Unix milliseconds
```

There is no construction from a Unix number, because seconds and milliseconds would be ambiguous.

### Collections and storage

Temporal values and durations can be list and set elements; a set compares kind and value. Typed storage keeps each
kind distinct from the others and from text: local values without an offset, absolute values as moments in UTC.

## 36. Scheduling
**Status:** Wanted capability; final syntax, authority, and Player UI deferred

Scheduled events and deadlines target absolute wall-clock moments and may become due while no Player is running.
This differs from [timer and `wait` scene time](#27-timers), which excludes genuine Player unavailability.

Exact event syntax and handles, local/offline versus server-backed authority, recovery, and deadline presentation
require a separate design. The earlier `schedule datetime { ... }` and `cancelSchedule(...)` forms are not accepted
final author syntax. See [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

## 37. Dynamic speaker terms
**Status:** Accepted

Dynamic speaker terms are built-in and custom properties attached to a speaker. A character may represent a person, a fictional character, a robot, or another entity that can participate in the tease.

The same property model is used for:

```text
player
speaker
mistressVera
cashier
```

- `player` is the built-in speaker for the person playing the tease. It exists without a declaration, and its name is
  reserved: `speaker player { ... }` is a compile error, so a script assigns its fields instead. Use `player`, not
  `user`.
- `speaker` is the context-sensitive reference for the effective speaker.
- A declared speaker is referenced through its identifier, such as `mistressVera` or `cashier`.
- Other speakers remain directly addressable while one speaker is talking.

### Speaker declaration and `say as`

Declare a speaker with an identifier and a property block:

```text
speaker mistressVera {
    firstName: "Vera"
    lastName: "Black"
    title: "Mistress"
    shortTitle: "Miss"
    gender: "female"
    color: "#9b59b6"
    font: "Georgia"
    avatar: "avatars/vera.jpg"
}
```

Ordinary `say` uses the current default speaker:

```text
player.copyFrom(playerProfile)
say "Kneel."
say "Good morning, ${player.alias}."
```

Use one explicit speaker for one message:

```text
say as mistressVera "Kneel."
say as mistressVera "You will obey your ${speaker.title}."
```

During the second message, `speaker` resolves to `mistressVera`. `say as` does not change the default speaker after that message.

`say as player "..."` is the player's own message. It appears on the player's side, as a clicked button's answer does,
with no name and no avatar, and with the ordinary reading time. A clicked button and an answer to an ask are messages of
`player` too, so the player's presentation (`color`, `font`, and the bubble options) applies to all of them. Other
speakers name the player through its fields, as in `say as mistressVera "Hi ${player.firstName}"`.

A speaker can refer to another speaker explicitly:

```text
say as cashier "Please speak to ${mistressVera.shortTitle} ${mistressVera.lastName}."
```

Set the current default speaker with the same `speaker` keyword followed by an existing speaker reference:

```text
speaker mistressVera
```

This does not redeclare the speaker, and `speaker player` makes the player the default speaker. The parser distinguishes `speaker identifier { ... }` from `speaker identifier` through the following token. The default speaker is session state: it survives `goto`, `end`, and `call`, remains active until changed again, and is cleared by `exit`.

**Status (Owner decision, 2026-10-13):** a message that names no speaker with `as` while no default speaker is set
has no speaker, and `speaker` in it has no value. If no file of the package has a `speaker` statement that sets the
default speaker, `speaker` in a message without `as` is compile error `TSV063`. Otherwise reading it in a message that
has no speaker is runtime error `TSR071`.

A speaker is global ([ADR 0022](../decisions/0022-multi-file-scripts.md)): declared anywhere in any file of a package,
also inside a block or function, it is known in every file. Its name is unique in the package like that of a global
([§12](#global-variables)). The session sets it up at its start, together with the globals and in their order, so its
property values follow the initializer rules of globals: literals, earlier globals and speakers, side-effect-free
operators, and `load … , default:`. A property may also read the speaker's own earlier properties through `speaker`. To
use a value that exists only later, assign the property then, as in `mistressVera.alias = chosenName`.

### Names, titles, and presentation

Built-in person fields:

```text
firstName
lastName
title
shortTitle
displayName
alias
gender
color
font
avatar
```

Meanings:

- `firstName` is the given name.
- `lastName` is the family name or surname.
- `title` is a free title or role such as `"Mistress"`, `"Director"`, `"Doctor"`, or `"Submissive"`.
- `shortTitle` is an optional shorter form such as `"Miss"` or `"Dr."`.
- If only `title` is set, `shortTitle` returns `title`. If only `shortTitle` is set, `title` returns `shortTitle`. If both are set, each retains its own value.
- `displayName` is the explicit name shown with that character's chat messages.
- When `displayName` is absent, the engine joins the non-empty `title`, `firstName`, and `lastName` fields in that order, without adding spaces for missing fields.
- `alias` is an arbitrary string. It is not restricted to pet names.
- `gender` selects a default term set but does not permanently lock pronouns, anatomy, or terminology.
- `color` and `font` provide that character's general text-presentation defaults. Per-mode and per-message options below
  can override them.
- `avatar` is an optional image reference shown beside that character's chat messages.

### Message presentation defaults and overrides

**Status:** Accepted (Owner-approved extension for #422 and #426).

The compact `say` form extends the ADR 0018 pacing syntax; the bounded form holds the text and pacing in parentheses
([Updatable messages](#updatable-messages)):

```text
say [as speaker] [bubble(options) | prose(options)] [skippable | unskippable] text [, pacing]
say [as speaker] [bubble(options) | prose(options)] [skippable | unskippable] (text [, pacing])
```

Brackets denote optional parts. `bubble` and `prose` may appear without parentheses; parentheses contain ordinary
comma-separated named arguments. Both modes accept `color`, `background`, and `font`; only `prose` accepts
`position` and `align`. Bubble placement and text alignment belong to the Player: received messages appear on the left
and player-authored replies on the right. Bubble options cannot override them, including through speaker defaults or
explicit `null` values. Direct `say` options and literal speaker-declaration defaults are checked at compile time.
Speaker option objects supplied or reassigned at runtime are validated when used to prepare a message and fail with
`TSR050` if they contain unsupported options.
Each value is an ordinary expression, including variables and function calls. Unknown or repeated options are errors.
The mode words remain usable as ordinary identifiers when the complete `say` value parses without a modifier.

Speakers use `presentation: "bubble" | "prose"` for their preferred mode and separate `bubble` and `prose` option objects:

```text
speaker vera {
    displayName: "Vera"
    presentation: "bubble"
    color: "white"
    font: "Georgia"
    bubble: { background: "#334455" }
    prose: { align: "left" }
}
speaker vera
say "Uses Vera's defaults."
say prose(background: "ivory", color: "#302820") "A letter."
```

The compiler retains omitted message options as inheritance, not as frozen effective values. The runtime selects the
explicit mode, then the speaker's mode, then `bubble`. Each option resolves from the message, then the selected
speaker-mode object, then the platform default. `color` and `font` additionally fall back to the general speaker fields.
Overrides affect only that message. Explicit `null` behaves as omission.

For prose, after message and speaker inheritance, an unchosen `position` or `align` remains `null` in the emitted
presentation. The Player selects their defaults. Explicit choices remain distinguishable from omission. For bubbles,
both resolved fields are always `null` and only the Player determines placement. For prose, `position` places the whole
block; `align` sets the text within it. Both accept
`"left"`, `"center"`, or `"right"`. Bubble backgrounds and unspecified text/font use Player theme
roles; the runtime represents these theme selections with `null`. Prose has no background default: a prose message
whose background was never chosen reports `null`. Prose retains speaker provenance; avatar and visible name treatment
belong to the Player presentation design. These defaults do not introduce a new avatar/name visibility syntax.

Option expressions evaluate once in written order before the text and pacing expressions, under the selected speaker
context. Effective style defaults are resolved when the runtime prepares the output, using that speaker's current
properties. The resulting presentation is shown with the message.

A paced `say`, with smart pacing or a positive duration, lasts its reading time, and the next statement runs only when
the reading time ends or the player skips it (owner decision, 2026-10-11). Nothing after it runs meanwhile: no other
message, question, button, form, media or camera change, message or permanent-button change, `wait`, timer, or other
code. A timer, cue, or permanent-button block interrupts a reading time as it interrupts a `wait`
([§27](#expiry-blocks)); permanent buttons already shown stay usable. `instant` and `0 s` show a message with no
reading time, so `say "Hold.", instant` followed by `wait 30 s` takes exactly 30 seconds.

### Updatable messages

**Status:** Accepted (Owner decision on #512, 2026-10-07).

A `say` used as a value shows its message as usual and gives a `messageHandle` for it. Its one property, `text`, reads
the message's current text and changes it in place, and its one method, `remove()`, takes the message out of the
conversation (owner decision on #836, 2026-10-11):

```text
let line = say "Waiting.", instant
wait 1 s
line.text += "."
line.text = "Ready."
wait 2 s
line.remove()

let counter: messageHandle = say("Strokes: 0", instant)
let strokes = [say("First", instant), say("Second", instant)]
```

- **Forms.** A compact `say` value takes its text and pacing up to the end of its statement, so a comma after the text
  is its pacing. In a list, a call, or another expression, use the bounded form: its parentheses hold the text and
  pacing, and the `say` ends at its `)`, so `say("A").text` reads the new message's text. Before parentheses, a mode is
  written with its options, `say bubble() ("Plain", instant)`, since `say bubble("x")` shows the value of a call to a
  function `bubble`. As a value, `skippable` or `unskippable` before parentheses is the modifier:
  `let line = say unskippable ("Wait", instant)`. A `say` statement keeps the rule above: `say unskippable("Wait")`
  calls a function `unskippable`, so a statement writes `say unskippable "Wait"`.
- **Statements.** A bare `say` is unchanged and gives no handle. It also takes the bounded form, `say("Hi", instant)`,
  when a comma follows the first value in its parentheses; other parentheses group a value as before, as in
  `say ("A"), instant` and `say (a) + b`. A `say` at the start of a line outside brackets begins a statement.
- **Evaluation.** Speaker, options, text, and pacing evaluate once in source order, and pacing works as for any `say`.
  The handle exists once the message is shown: a value that waits behind an earlier message's pacing is shown first. A
  `say` that does not run, as in `false and say("x") == line`, shows nothing. Global and speaker start values and
  function parameter defaults cannot say.
- **`text`.** Reading it gives the text as written, with its markup and after `${...}`, such as `"**Ready**"`. Assigning
  text, or appending with `+=`, replaces the message's text and parses it whole; the message keeps its speaker,
  presentation, and place in the conversation, and the conversation shows only its current text. The same text again
  changes nothing, and `""` empties the message without removing it. A text write starts no reading time of its own;
  use `wait` between changes. `text` takes only text: write `"Strokes: ${count}"` for a number. A handle has no other
  property, no other method, and no operators besides `==` and `!=`.
- **`remove()`.** It takes no arguments and gives `null`. The message leaves the conversation, which shows the messages
  around it as if it had never been there, also after a restored checkpoint. Like a text write, it starts no reading
  time of its own and waits for the reading time of an earlier message, as any statement does. After it, the handle
  behaves as a stopped timer's does ([§27](#handles)): `text` still reads the text the message had, a text write
  changes nothing and reports developer warning `TSW010`, and `remove()` again does nothing. The handle keeps its
  identity, so `==` and `say line` work as before. To keep a message that you want to change later, empty it with
  `line.text = ""` instead.
- **Identity.** Every copy of a handle, in a variable, collection, argument, or the variables a block shares, names the
  same message, and `==` compares messages, not texts. Until removed, a message stays changeable while a handle to it
  remains, also an older or another speaker's message, and across `goto`, `call`, and `end` through a global, a caller,
  or a block.
  `say line` shows `<message N>`; `${line}` and `toString(line)` are errors, so use `line.text`. A handle belongs to its
  session: `save` refuses it ([§25](#25-persistent-storage-and-keys)), and saved data and host values cannot hold one.
- **Types.** `messageHandle` is a protected type name ([§38](#38-keywords-and-protected-built-ins)) that annotations
  and unions use like `timer`; `message` remains an ordinary name. A literal replacement text assigned with `=` to what
  can only be a message handle has its markup colours checked like the text of `say`.

### Authored colours

**Status:** Accepted (Owner-approved extension for #422).

Authored colours are always opaque. Concrete colour values accept CSS colour names, 3/4/6/8-digit hex,
`rgb()`/`rgba()`, `hsl()`/`hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, and `oklch()`. Hex and RGB use standard sRGB.
Host-dependent values such as `var()` and `currentColor`, relative colours, and explicit linear RGB are excluded.

`transparent` and alpha below full opacity are invalid; full-opacity forms such as `#ff0000ff` and
`rgb(255 0 0 / 1)` are accepted. This keeps authored colours independent of the Player's underlying theme surface.
The restriction covers static and dynamic text/background colours in speaker properties and message options,
not Player interface transparency.

The compiler validates constant speaker-declaration and message-option colours while retaining their authored values.
The runtime normalizes both constant and dynamic colours to OKLCH when preparing output. Converted values
are not parsed again as authored input: CSS input-channel clamping must not alter previously converted coordinates.
Message markup follows its existing complete-string parse after interpolation. Invalid statically known colours in these authored positions produce source-associated compiler
errors. Valid out-of-gamut coordinates are retained without a gamut warning or silent gamut mapping; display mapping
belongs to the browser. CSS colour parsing rules still govern the input notation's channels.

An invalid runtime colour falls back to the next applicable default without aborting the story. General warning,
logging, and recovery policy is separate work in #427. This fallback does not suppress failures evaluating the expression
itself or turn unrelated runtime errors into recoverable colour errors.

Examples:

```text
player.alias = "puppy"
player.title = "Submissive"
player.color = "#777777"
player.font = "Courier New"

mistressVera.title = "Director"
mistressVera.shortTitle = "Director"
```

These fields may be changed during execution. A script can therefore change a character's terminology or text presentation as part of the story.

### Name lists

The standard random name lists are:

```text
petNames
degradingNames
lovingNames
```

The player profile supplies the player's lists: `playerProfile.petNames` reads one, and `player.copyFrom(playerProfile)`
copies them into the player. The player's settings require at least one name in each list, and the engine checks this
where the host gives the profile; the Player has no profile input yet. There is no fallback text: a list that a script
empties follows the ordinary empty-list rules.

```text
player.petNames
player.degradingNames
player.lovingNames
```

Interpolation selects one random element according to the list rules:

```text
player.copyFrom(playerProfile)
say "Come here, ${player.petNames}."
say "Good ${player.lovingNames}."
say "You are such a ${player.degradingNames}."
```

Every evaluation may select a different element. Use an index for a specific value:

```text
say "Today I will call you ${player.petNames[0]}."
```

Use `.random` and store the result when the same selection must be reused:

```text
let chosenName = player.petNames.random

say "From now on, you are ${chosenName}."
say "Come here, ${chosenName}."
```

The lists are editable like ordinary lists:

```text
player.petNames.add("plaything")
player.lovingNames.remove("darling")
```

### Gender defaults and overrides

The initial engine presets use:

```text
"male"
"female"
```

Setting `gender` fills the default values of the derived terms below:

| Property | Male default | Female default |
|---|---|---|
| `maleFemale` | `"male"` | `"female"` |
| `manWoman` | `"man"` | `"woman"` |
| `boyGirl` | `"boy"` | `"girl"` |
| `heShe` | `"he"` | `"she"` |
| `himHer` | `"him"` | `"her"` |
| `hisHer` | `"his"` | `"her"` |
| `himselfHerself` | `"himself"` | `"herself"` |

Examples:

```text
player.copyFrom(playerProfile)
say "You are a good ${player.boyGirl}."
say "${mistressVera.heShe} is waiting for you."
```

Every derived term is independently editable:

```text
player.gender = "female"
player.heShe = "they"
player.himHer = "them"
player.hisHer = "their"
player.cockClit = "cock"
```

`gender` therefore provides convenient defaults. It does not make gender identity, pronouns, anatomy, and preferred words inseparable.

A term set explicitly wins over the default of `gender`, and changing `gender` changes only the terms that were not set
explicitly. Another gender value supplies no defaults. The player profile follows the same rules for its own `gender`
and terms. `player` starts with no gender and no terms, and `player.copyFrom(playerProfile)` copies the profile's gender
and the terms it sets explicitly. Script assignments then change the player without changing the profile.

### Anatomical and arousal terms

The confirmed anatomical and arousal terms are:

| Property | Male default | Female default | Intended use |
|---|---|---|---|
| `penisVagina` | `"penis"` | `"vagina"` | General or more formal genital wording. `vagina` follows common-language usage here. |
| `cockPussy` | `"cock"` | `"pussy"` | General informal genital wording. |
| `penisClitoris` | `"penis"` | `"clitoris"` | More formal reference to the primary organ being stimulated. |
| `cockClit` | `"cock"` | `"clit"` | Informal stimulation target, especially with dynamic action terms. |
| `glansClitoris` | `"glans"` | `"clitoris"` | More focused reference to a highly sensitive area; a practical text pair rather than perfectly symmetrical terminology. |
| `ballsLabia` | `"balls"` | `"labia"` | Contextual reference to a sensitive external area; not an anatomical-homology claim. |
| `scrotumVulva` | `"scrotum"` | `"vulva"` | Broad external-region wording; not a direct organ-to-organ equivalence. |
| `foreskinClitoralHood` | `"foreskin"` | `"clitoral hood"` | Covering tissue that can be referenced in similar instructions. |
| `chestBreasts` | `"chest"` | `"breasts"` | Broad profile-dependent chest or breast wording. |
| `nippleBreast` | `"nipple"` | `"breast"` | More focused arousal wording when the intended instruction contrasts a nipple-focused male phrase with a broader breast-focused female phrase. |
| `hardWet` | `"hard"` | `"wet"` | Contextual arousal wording for questions or warm-up instructions, not an exact physiological measurement. |

Examples:

```text
player.copyFrom(playerProfile)
say "Touch your ${player.cockPussy}."
say "${player.strokeRub} your ${player.cockClit}."
say "Focus on your ${player.glansClitoris}."
say "Gently tap your ${player.ballsLabia}."
say "Pull back your ${player.foreskinClitoralHood}."
say "Touch your ${player.nippleBreast}."
say "Keep going until you are ${player.hardWet}."
```

Terms that normally remain the same do not need artificial dynamic pairs. Examples include:

```text
frenulum
urethra
perineum
```

Scripts use those as ordinary text.

`cum`, `cumming`, and `came` can also apply without a gender-specific replacement. `cumSquirt` is deliberately not included because orgasm and squirting are not equivalent.

### Dynamic action terms

Actions and anatomical targets remain separate so the same terms can be recombined without creating complete phrase keywords for every tense and instruction.

| Property | Male default | Female default | Grammatical use |
|---|---|---|---|
| `strokeRub` | `"stroke"` | `"rub"` | Base or imperative form. |
| `strokingRubbing` | `"stroking"` | `"rubbing"` | Continuous or gerund form. |
| `wankRub` | `"wank"` | `"rub"` | Alternative informal base or imperative form. |
| `wankingRubbing` | `"wanking"` | `"rubbing"` | Alternative informal continuous form. |
| `strokedRubbed` | `"stroked"` | `"rubbed"` | Past-tense form. |
| `wankedRubbed` | `"wanked"` | `"rubbed"` | Alternative informal past-tense form. |
| `strokerMasturbator` | `"stroker"` | `"masturbator"` | Agent noun for the person performing the action. |

Examples:

```text
player.copyFrom(playerProfile)
say "${player.strokeRub} your ${player.cockClit}."
say "Keep ${player.strokingRubbing} your ${player.cockClit}."
say "${player.wankRub} your ${player.cockClit}."
say "You ${player.strokedRubbed} a lot today."
say "You ${player.wankedRubbed} earlier."
say "You are my ${player.strokerMasturbator}."
```

The generic words `masturbate`, `masturbating`, and `masturbated` need no dynamic replacement when the same wording is suitable for every player. `strokerMasturbator` follows the same gender-default and explicit-override rules as the other dynamic speaker terms.

### Extensible character state

Speakers are open to script-defined properties. A script may attach counters, scores, flags, collections, or other state to the player or any declared speaker:

```text
player.punishmentPoints = 0
player.monopolyScore = 1500

mistressVera.edgeInstructions = 0
mistressVera.edgeInstructions = mistressVera.edgeInstructions + 1
```

This allows state to remain attached to the character it describes instead of requiring unrelated global variables.

Built-in dynamic terms, name lists, presentation fields, and custom properties may all be changed by the running script,
also through a constant that holds the speaker ([§12](#constants)).

A speaker has a built-in field, term, or name list only once a declaration, an assignment, or for `player` a copy of
the player profile gives it one. Reading one where no way to the read has given it one is a compile error. `title` and
`shortTitle` count for each other, `gender` counts for every term, and `title`, `shortTitle`, `firstName`, or
`lastName` counts for `displayName`. A field that only some ways give, such as through a copy inside an `if`, is checked
when the script runs.

Custom-property rules:

- The first unconditional assignment declares the property and infers its type.
- A custom property may also be declared directly in a `speaker` property block.
- Reading a property before it has definitely been declared is a compile error.
- A conditionally assigned property is not considered definitely available after the condition unless every path assigns it.
- A read through the speaker's name, or through `speaker` under `as`, follows these rules at compile time. Where the
  compiler cannot tell which speaker a read reaches, or what the code before the read assigns, the read is checked when
  the script runs. A call, a timer, media, or button block, or a called file counts as assigning whatever it may
  assign, and as assigning every property where the compiler cannot tell what that is.
- The inferred or declared property type remains fixed.
- Speaker references compare by identity with `==` and `!=` and may be used as `switch` values.

### Reading the player profile

`playerProfile` is the built-in reference to the current player's server-backed profile, which a script reads directly
and changes only through `askProfileChange(...)` ([Profile changes](#profile-changes)):

```text
let maximum = playerProfile.settings.chastity.punishmentMaximum
let toys = playerProfile.toys
let hardcoreActive = playerProfile.hardcore.active
```

Its person fields are those of a speaker: `title`, `shortTitle`, `firstName`, `lastName`, `displayName`, `alias`,
`gender`, the terms, and the three name lists, as in `playerProfile.firstName`, `playerProfile.heShe`, and
`playerProfile.petNames`. They read like a speaker's, so a term follows the profile's `gender` unless the profile sets
it. The host gives them when the session starts, and the session keeps them, also across a checkpoint. Reading a field
that the profile lacks fails when the script runs.

`player.copyFrom(playerProfile)` replaces the player's person fields with the profile's: the name fields, `alias`,
`gender`, the terms the profile sets explicitly, and copies of the name lists, so `player.petNames.add(...)` never
changes the profile. A field the profile lacks is cleared on `player`. The presentation fields and script-defined
properties of `player` stay as they are. It is the only form of `copyFrom`: another receiver or argument is a compile
error.

Rules:

- profile fields are schema-defined, typed, and available to autocomplete;
- unknown profile fields are compile errors;
- direct assignment and changing a profile list are compile errors;
- cheat mode may substitute only unlocked values according to the account rules;
- locked values and hardcore state always expose the real server-confirmed state.

```text
playerProfile.gender = "female" // compile error
```

Large or filtered history collections use `getPlayerHistory(...)` rather than requiring the complete history to be loaded through one property.

### Profile changes

A running script requests a blocking, server-confirmed profile change with `askProfileChange(...)`. The player may accept, reject, or allow the request to expire. Supported operation groups are:

```text
save
add
remove
removeAll
increase
decrease
```

Meanings:

- `save` replaces a schema-defined value. Saving `[]` is the way to empty an entire list.
- `add` appends list values. Duplicate entries are allowed where the profile schema permits weighting, such as name lists.
- `remove` removes one occurrence for each supplied value.
- `removeAll` removes every occurrence of each supplied value.
- `increase` and `decrease` apply atomic numeric, duration, or unit-aware changes against the newest server value.
- scripts may not delete toy records; a script may propose changing a toy's availability, while permanent deletion remains an account-management action.

The request is atomic and the server validates the complete schema and all active locks again before confirming acceptance. The final result payload, including how server-generated IDs of newly added toys are returned, remains open.

### Script-global and cross-script data

A script may publish typed data shared by all executions of that same script:

```text
publishGlobal(
    key: "monopoly",
    value: { score: player.monopolyScore }
)
```

Read matching entries with `getGlobal(...)`:

```text
let previous = getGlobal(
    key: "monopoly",
    order: "newest",
    limit: 1,
    excludeCurrentPlayer: true
)[0]
```

Each returned entry contains at least:

```text
participantId
displayName
value
publishedAt
```

`participantId` is an opaque server-generated identifier scoped to the script and is not the account ID or username. `displayName` comes from the player's global account preference and may be empty. Receiving scripts may display `participantId` when no display name is available.

A script may read saved data from another script for the same player through an immutable script ID:

```text
let previousChapter = loadFromScript(
    script: "immutable-script-id",
    key: "chapterState",
    default: {}
)
```

This access is read-only. Script metadata is available separately:

```text
let metadata = getScriptMetadata("immutable-script-id")

metadata.firstRunAt
metadata.lastRunAt
metadata.runCount
```

Access boundaries:

- current player and current script: ordinary `load`;
- current player and another script: `loadFromScript`;
- other players and the same script: `getGlobal`;
- another player and another script: not allowed.

### Runtime, script, and account persistence

Player-directed defaults originate from the player's account so the same preferences, terms, toys, history, statistics (including record values), and current account state can be used by every script running for that player.

A script may:

- read the current player account data inside the player's own runtime session;
- change effective runtime values without changing the account;
- store script-specific values with normal persistent storage for later runs of that same script;
- ask the player to approve an account-level change through a blocking, host/server-confirmed request.

A script-specific assignment never silently changes the account. Every account-setting change or lock is an active player decision. The host website shows the consequences, the tease pauses, and the result becomes accepted only after the server has stored it. `askProfileChange(...)` and its accepted operation groups provide this blocking request; the exact result object and some nested account payload fields remain open.

The script author does not receive another player's account values outside that player's live runtime. Within a run, however, the script may access all account-backed information exposed by the engine for that current player; denial and chastity are not special exceptions.

### Preference ratings

Player preference entries use exactly two `0..=5` ratings:

```text
frequency
intensity
```

Frequency meaning:

```text
0 = hard limit / never
1 = accepted only rarely
2 = sometimes
3 = regularly
4 = often
5 = very often
```

`intensity` independently expresses the preferred strength. No separate `interest` or `limit` field is added. The player may still refuse an instruction during a tease.

The engine does not impose one universal conversion from `frequency` to probability. Scripts decide how the scale affects selection. Documentation may use this non-binding example:

```text
0 -> 0 percent
1 -> 0 percent in ordinary random selection
2 -> 20 percent
3 -> 40 percent
4 -> 60 percent
5 -> 80 percent
```

### Cheat mode, permissive mode, and hardcore mode

The account provides a player-controlled way to keep experimental or casual runs enjoyable even when account-wide history or restrictions would otherwise block content.

Confirmed behavior:

- cheat mode is available only while the player has enabled the permissive account mode currently using the working name `pussy mode`;
- cheat mode can present scripts with player-chosen substitute or relaxed values only for account data that is not protected by an applicable lock;
- locked values continue to expose and enforce their real server-confirmed state, so cheat mode cannot be used to evade a lock that the player has accepted;
- use of cheat mode may be visibly marked in the player's own account/history so that it does not feel like an invisible reset;
- changing into the permissive mode is allowed only when no active account-lock timer or hardcore period prevents that change;
- hardcore is a separate time-bounded account mode, not itself an individual setting-lock type;
- while hardcore is active, applicable settings cannot be reduced and cheat mode is unavailable;
- scripts may read whether hardcore mode is active and may adapt difficulty or intensity;
- enabling hardcore or any account lock always requires explicit blocking player approval;
- a safety override remains available for medical or urgent reasons and is distinct from ordinary cheat mode.

The final engine property names and user-facing label for the permissive mode remain open.

### Account locks and configured ranges

Locks are attached per account setting rather than being one global boolean. Confirmed requirements:

- ordinary unlocked settings remain directly adjustable;
- a setting may require an account-level counter-performance before it can be reduced;
- a timed one-way lock prevents reduction until its server-stored end time while still allowing stricter values;
- a lock may record the owning script so that the same script can offer an approved early release or counter-performance flow;
- if the owner script disappears, the server-stored lock still expires normally;
- the player configures the maximum duration a script may request for each applicable lock; `0` may represent no player-imposed duration ceiling;
- scripts can never bypass the player's configured maxima or the safety override;
- hardcore itself always has a finite end time even when some individual setting ceilings are otherwise unlimited.

For v1, these three duration guidance values apply to chastity settings only:

```text
target value
punishment / difficult maximum
absolute maximum
```

The same model may later be extended to individual toys or other duration-based settings, but that extension is not yet accepted. The exact chastity property names, lock-mode enum, standard counter-performance rules, and interaction between timed locks and counter-performance remain open.

### Account-backed toys, state, history, and statistics

All account-backed state, statistics, event history, and configured toys exposed by the engine are readable by every script running for that same player, subject to the player's active cheat/hardcore view. They are not restricted to the script that originally created them. Record values such as a longest duration or largest used size are statistical maxima or extrema, not a separate storage category.

Current state and history are stored separately:

- current state gives fast access to active denial, active chastity, planned end times, owners, modes, and other live restrictions;
- append-only history records completed or point-in-time facts;
- aggregate statistics, including record values, are derived from normal history and are not freely overwritten by scripts.

History is queried with `getPlayerHistory(...)`, which returns a filtered list of event objects. A query first filters, then orders, then applies `limit`. Thus `limit: 5` returns at most the five matching events selected by the requested order. Queries may filter by immutable script ID.

```text
let recent = getPlayerHistory(
    type: "orgasmOutcome",
    order: "newest",
    limit: 5
)
```

Confirmed event shapes:

- orgasm opportunity results use exactly `type`, `outcome`, and `occurredAt` as their required core fields;

```text
{
    type: "orgasmOutcome",
    outcome: "orgasm",
    occurredAt: getDateTime()
}
```

- allowed orgasm outcomes are `"orgasm"`, `"ruined"`, and `"denied"`; queries for all actual orgasms combine `"orgasm"` and `"ruined"`;
- repeated actions such as edges are grouped per reported session rather than creating one database row per edge;
- the standard engine/library maintains the active edge-session aggregate so ordinary scripts do not need to manually create one server event per edge;
- recoverable session checkpoints use a session identifier and increasing sequence number and include changed script state, current execution position, deterministic RNG state, and active timers or asynchronous operations needed for restoration;
- checkpoints are sent after user interactions that advance the tease, such as button clicks, choices, and completed input, and may also be sent when background state changes;
- the grouped edge event is finalized when the session completes or is closed normally; exact reconnect, abandoned-session, and conflict-resolution rules remain open;
- an edge event may contain total edge count, number of held edges, a list of individual hold durations, total hold duration, and maximum hold duration;
- duration activities maintain active state while running; when they end, a completed history event stores `startedAt`, `endedAt`, and `duration`;
- duration events can represent chastity and worn-toy sessions such as plugs, blindfolds, ball gags, and similar equipment;
- normal script-run events count as occurred without a second confirmation step;
- debug-run events remain visible for testing but are flagged and excluded from normal statistics and record calculations.

Chastity scheduling may include player-configured off-windows by weekday. A scheduled window only permits removal; it does not claim that removal actually happened. Actual on/off state is changed and recorded through the account or tease runtime. Whether permitted off-windows pause a sentence clock in every account mode remains open.

Routine hygiene pauses are primarily live system state rather than permanent history. The system tracks eligibility and maximum pause duration. Exceeding the allowed pause duration creates a log entry. When a script owns the active chastity lock, the owning script is notified of the overrun and the system may route the blocking hygiene-pause flow to that script; otherwise the standard system library handles it.

Every toy has a server-generated unique `toyId`. Visible names do not need to be unique, so two plugs may both be called `"Butt plug"` while remaining reliably distinguishable by ID.

Common toy fields include:

```text
toyId
type
name
description
enabled
color
material
referencePhoto
usagePhotos
```

- `referencePhoto` is an optional locally encrypted image reference;
- `usagePhotos` is a list of locally encrypted worn/in-use image references;
- `enabled: false` temporarily excludes a toy without deleting it from the account;
- completed use sessions belong in account history rather than an ever-growing embedded usage list.

The initial detailed toy schemas cover:

```text
"buttPlug"
"dildo"
"chastityDevice"
"ballGag"
```

Relevant type-specific fields include:

- butt plug: diameter, insertable length, and base shape such as `"T"` or `"round"`;
- dildo: diameter, insertable length, `hasBalls`, and `hasSuctionCup`;
- chastity device: cage type plus a string list of features such as `"spikes"` or `"urethralInsert"`;
- ball gag: diameter.

Other toys may use the common fields and their `type` without requiring an additional detailed v1 schema.

Locally encrypted image references identify files available to the player's runtime; they do not imply that the raw photos are uploaded to the central server.

The exact current-state API, chastity-window API, hygiene library, lock request payload, and detailed account result objects remain open.

## 38. Keywords and protected built-ins
**Status:** Accepted

TeaseScript distinguishes grammar keywords from protected engine names.

### User identifiers

User-defined identifiers use this lexical form:

```text
[A-Za-z_][A-Za-z0-9_]*
```

Rules:

- the first character is an ASCII letter or `_`;
- later characters may also be decimal digits;
- identifiers are case-sensitive;
- spaces, hyphens, punctuation, and non-ASCII letters are not accepted inside an identifier.

Accepted examples:

```text
mistressVera
player_score
chapter2
_privateValue
```

Rejected examples:

```text
2chapter
player-name
player name
```

A hyphen is the subtraction operator, so `player-name` is tokenized as `player - name`, not as one identifier. Authors should use `playerName` or `player_name` instead.

### Grammar keywords

These words are reserved by the language grammar and may not be used as variable, function, speaker, label, or parameter identifiers:

```text
let
const
function
return
if
else
switch
case
default
repeat
for
in
while
break
continue
noInterrupts
and
or
not
set
true
false
null
speaker
say
as
label
goto
call
end
exit
global
tagged
save
load
delete
is
otherwise
```

The same keyword may have more than one grammar form when the next token makes the form unambiguous. For example, `speaker identifier { ... }` declares a speaker, while `speaker identifier` sets the default speaker, and `global function` declares a global function, while `global identifier = ...` declares a global. A parser distinguishes these forms through normal lookahead; this is not an implementation problem.

Modifier and block words such as `async`, `visible`, `mystery`, `hidden`, `times`, and the media cue words `at`,
`beforeEnd`, and `finish` are contextual: they have their special meaning only in the positions documented in
[§22](#22-stage-image-audio-and-video) and [§27](#27-timers) and otherwise remain ordinary identifiers.

### Protected type names

```text
string
boolean
integer
number
date
time
datetime
absoluteDateTime
duration
calendarDuration
angle
list
dict
object
range
media
messageHandle
script
regex
```

The type names `null`, `set`, `speaker`, and `timer` are protected as grammar keywords or engine names. `dict` also
starts a dict literal when `{` follows it ([§40](#40-dictionaries)).

### Protected engine names

Every built-in command, function, and contextual engine reference documented by this specification is protected and may not be redeclared by a script. Examples include:

```text
player
random
randomInteger
chance
round
floor
ceil
min
max
abs
sign
sqrt
pow
mod
clamp
pi
debugMode
sum
average
median
percentile
stddev
linearRegression
predict
randomWeighted
randomNormal
randomBeta
randomPert
exp
ln
log10
sin
cos
tan
asin
acos
atan
atan2
toDeg
toRad
toString
toNumber
toInteger
toBoolean
toDate
toTime
toDateTime
toAbsoluteDateTime
getDate
getTime
getDateTime
getAbsoluteDateTime
schedule
cancelSchedule
askText
askNumber
askChoice
askInteger
askBoolean
askDate
askTime
askDateTime
askPassword
wait
timer
showPermanentButton
playAudio
playVideo
stopAudio
showBackgroundColor
showBackgroundImage
showOverlayImage
showOverlayVideo
showImage
moveOverlay
animateOverlay
hideOverlay
hideImage
showCamera
hideCamera
showBlur
hideBlur
drawRectangle
drawEllipse
drawLine
drawText
removeDrawing
playerProfile
askProfileChange
publishGlobal
getGlobal
loadFromScript
getScriptMetadata
getPlayerHistory
```

This protected list may grow when new engine APIs are added. Editor autocomplete should distinguish grammar keywords, protected built-ins, and user-declared identifiers.

The earlier names `timestamp`, `getTimestamp`, and `toTimestamp` stay protected: each use is a compile error that names
`absoluteDateTime`, `getAbsoluteDateTime`, or `toAbsoluteDateTime` ([ADR 0026](../decisions/0026-unified-time-semantics.md)).
So does `choose`, which names `askChoice` ([§19](#19-choices)), and `removePermanentButton`, whose call names the
button's `remove()` ([§28](#28-permanent-buttons)).

### Debug mode
**Status:** Accepted (Owner decision, 2026-10-07)

`debugMode` is a protected, read-only `boolean`: `true` while the host runs the session in Debug, otherwise `false`. A
script reads it like a variable, and a host cannot configure a global or builtin of that name. The host may change it
between two statements, so each read gives the current value.

```text
let answer = askText "Type the line exactly"
if answer == line or debugMode {
    completed = true
}
```

## 39. Rejected and reserved syntax
**Status:** Accepted

The following are not part of accepted TeaseScript syntax.

### No `set`

Rejected:

```text
set score = 20
```

Accepted:

```text
score = 20
```

### No `procedure`

Functions already support waiting, media, input, timers, and normal actions.

### No `call` for normal functions

Rejected:

```text
call calculateDamage(player, weapon)
```

Accepted:

```text
calculateDamage(player, weapon)
```

`call` is reserved for another `.tease` file.

### No `record` keyword

Object literals are used directly:

```text
let result = {
    points: 4,
    passed: true
}
```

### No `MediaRef` author type

Media references are exposed as engine-managed strings.

### No `timeOfDay` type

Use the accepted `time` type for a time without a date, or `datetime` for a complete moment.

### No symbolic logical operators

Rejected:

```text
&&
||
!
??
```

Accepted:

```text
and
or
not
otherwise
```

Each rejected symbol is one compile error that names the word, and the script is read on as if the word were
written, so no other error follows from it. `!=` stays the comparison, and `?` after a type stays optional
([§18](#18-null-and-optional-values)):

```text
TeaseScript writes 'and' instead of '&&': if a and b { ... }
TeaseScript writes 'or' instead of '||': if a or b { ... }
TeaseScript writes 'not' instead of '!': if not a { ... }
TeaseScript writes 'otherwise' instead of '??': let name = nickname otherwise "pet"
```

### Reserved generic media controls

The standalone keywords below are reserved for possible future beginner-friendly media control:

```text
pause
resume
stop
```

They are not currently executable syntax. Media and timers are controlled through handle methods such as `music.stop()` ([§22](#22-stage-image-audio-and-video), [§27](#27-timers)).

### Reserved for later design

`available when` is reserved for future requirements or suitability metadata and is not executable syntax.

## 40. Dictionaries
**Status:** Accepted (#536; the `default:` of `get`: owner decisions, 2026-10-19)

A dict is a lookup table from text keys to values of one type, for names known only when the script runs. An object
([§15](#15-objects)) is one thing with fixed properties, each with its own type.

```text
let spare = "spare"
let toys = dict{ collar: "leather collar", "soft cuffs": "wrist cuffs", [spare]: "spare gag" }
let counts: integer dict = dict{}

say toys[name]                          // a missing key is an error
toys[name] = "ball gag"                 // adds the key, or replaces its value in place
if toys.contains(name) { ... }          // whether the key exists
let old = toys.remove(name)             // the removed value; a missing key is an error
toys.clear()
let n = counts.get(name, default: 0)    // the value, or the default when the key is missing
toys.length                             // the number of entries
toys.keys                               // a new list of the keys, in entry order
toys.values                             // a new list of the values, in the same order
for name in toys { ... }                // the keys
for name, toy in toys { ... }           // the keys with a copy of each value
```

- **Keys** are text. In a literal, `collar:` is the key `"collar"`, quoted text is any key, and `[expr]:` computes one.
  Entries are evaluated in source order, each key before its value. A key that is not text, such as a number, is a
  compile error when the compiler can see it and runtime error `TSR062` otherwise; write a number key as text, as in
  `toys["${id}"]`.
- **Duplicate keys:** a key the literal shows twice, also through computed keys whose text is known, is a compile
  error. Equal keys known only at runtime let the later entry replace the earlier one in its position.
- **Order:** entries keep insertion order. Assigning to an existing key keeps its position; a new key comes last.
- **Value type:** values share one type by the rules for list elements ([§12](#12-variable-declarations)), so integers
  and numbers together are numbers, an empty dict takes the type of its first value, and an integer dict without a
  written type widens to numbers. Values of different types need a declared union, such as `(integer | string) dict`.
  `T dict` is written like `T[]` and `T set`, and `dict` alone holds any values ([§13](#13-explicit-types)).
- **Missing keys:** reading or removing a key that the dict does not have is runtime error `TSR061`, which names the
  check, such as `Dictionary has no key "collar". Check toys.contains(name) first.` A missing key that the compiler can
  prove is missing is a compile error ([§13](#compile-errors-warnings-and-checks-when-the-script-runs)), as in
  `dict{ a: 1 }["b"]`. Where a key may be missing, check `contains(key)` first or read with `get`.
  `get(key, default: value)` gives `value` for a missing key. As for a list
  ([§16](#reading-an-element-with-a-default)), its `default:` is required and has the value type or is `null`: on an
  `integer dict`, `default: 0` gives an `integer` and `default: null` an `integer?`, and on a `string[] dict`,
  `default: []` gives a `string[]`; `default: "none"` is a compile error unless the value lands directly in a place with
  a written union that holds both ([§18](#defaults-follow-the-same-rule)). The default types only the result, never the
  dict: after `let counts = dict{}`, `counts[name] = counts.get(name, default: 0) + 1` makes `counts` an
  `integer dict` through the store of the integer. The default is evaluated only when it is used, for a missing key.
- **Iteration:** `for key in toys` goes through the keys, and `for key, value in toys` through the keys with a copy of
  each value, as they were when the loop started ([§23](#23-loops)), so changing the dict inside the loop is safe.
- **Equality:** two dicts are equal (`==`) when they have the same keys with equal values, in any order. A dict and an
  object are never equal.
- **Text:** `say` shows a dict as `dict{ "collar": "leather collar" }` ([§16](#lists-in-text)). `${toys}` is an error
  that names the fix: select one value with `toys[key]`, or show every value with `toys.values.join()`. A dict is not a
  text field or an `askChoice` option; it may be a set member ([§16](#16-lists)).
- **Copies and storage:** dicts are copied like lists ([ADR 0014](../decisions/0014-core-runtime-value-semantics.md)),
  and `keys` and `values` are new lists. Storage ([§25](#25-persistent-storage-and-keys)) and checkpoints keep a dict
  with its entry order.
- **Type tests:** `is dict` and `is T dict` test the value; `is T dict` checks every value.

Deferred: keys other than text, merging dicts, and sorted dicts.

## 41. Headers and tags
**Status:** Accepted ([ADR 0023](../decisions/0023-tags-for-scripts-and-images.md))

### File header

A file may start with a header between two `---` lines:

```text
---
title: "Strict punishment"
author: "Mistress X"
description: "Corner time with lines, for after a failed task."
tags: "chastity", punishment: 4
keywords: "chastity", "femdom", "long session"
---
say "Your punishment begins."
exit
```

- Only blank lines and comments may precede the opening `---`, and each `---` stands alone on its line. A `---` line
  inside a block string is text. A header later in the file is an error.
- Each field is one `name: value` line. As after any `:` or comma, a value may continue on the next line
  ([§1](#1-statement-termination)). Every field is optional; an unknown or repeated field is an error.
- `title`, `author`, and `description` are text in quotes, single-line or block strings, without interpolation. They
  are shown on the website and in an editor overview of many files.
- `tags` lists the file's tags for selection, separated by commas: a plain tag in quotes, `"chastity"`, or a tag with a
  number without quotes, `punishment: 4` (not `"punishment: 4"`).
- `keywords` lists text in quotes for the future website catalog search. Only the keywords of `main.tease` are used,
  and they never affect selection.
- The header is metadata, not YAML: indentation has no meaning, and it runs no code and reads no variables.

### Tags

- A tag name has lowercase ASCII letters `a`–`z`, digits, and hyphens, such as `corner-time`. Surrounding spaces are
  removed and uppercase letters lowered, so `"Punishment"` is `punishment`.
- A tag may carry a number: `punishment: 4`. The number is finite, may be negative or a decimal, and uses the forms of
  [§3](#numeric-literal-forms) with an optional sign. A tag with a number also counts as present.
- A tag listed more than once counts once, with a warning; a number wins over its absence. Two different numbers for
  one tag are an error.

### Tagged selection

```text
showImage tagged "bedroom", "punishment"                     // comma = and
showImage tagged "punishment" > 3 and not "public"
showImage tagged ("bedroom" or "bathroom") and not "outdoor"
showImage tagged "bedroom", none: ["outdoor"]
let photos = findImages(where: "bedroom" and "punishment" >= minimum)
if photos.length > 0 { showImage photos.random }

goto tagged "punishment", none: ["intense"]                 // a file by the tags of its header
goto tagged "punishment" > 3 and not "public"
call tagged "chastity", from: "modules/*.tease"
let pool = findScripts(from: "modules/*.tease", where: "punishment" > 3)
if pool.length > 0 { goto (pool.random) } else { goto "fallback.tease" }
```

- After `tagged` and in the `where:` argument, a quoted tag name tests whether a candidate has the tag. A quoted name
  followed by `==`, `!=`, `<`, `<=`, `>`, or `>=` compares the tag's number with an ordinary expression, so
  `"punishment" > minimum` reads the variable `minimum`. A tag without a number makes every comparison false, also
  `!=`. `and`, `or`, `not`, and parentheses work as in conditions ([§5](#5-logical-and-comparison-operators)).
- A tag name in a query is written out in full, without `${...}` or a number: query `"punishment" == 4`, not
  `"punishment: 4"`.
- In `tagged`, commas join complete predicates with `and`. The options `all:`, `none:`, and `any:` follow them, each at
  most once, with a list of tag names that a candidate must have all of, none of, or at least one of; an empty list
  passes every candidate. They join with `and` too, and take computed names: `findImages(all: wanted)`.
- `findImages` takes the same parts as named arguments `where:`, `all:`, `none:`, and `any:`, and returns all matching
  images as a `string[]`, which may be empty: each package image by its path and each photo by its reference, in the
  order that tag queries search them ([Image tags](#image-tags)). Without arguments it returns every image.
- `goto tagged` and `call tagged` pick a file of the project by the tags of its header ([File header](#file-header))
  and enter it at its top, as `goto (reference)` does ([§29](#29-script-files-and-paths)). Every file that runs
  something is a candidate, `main.tease` and the current file too, but a `call tagged` that can pick the running file
  is a compile error where the compiler can prove it, and is otherwise checked when it runs, as for any `call`
  ([§29](#29-script-files-and-paths)). A file of declarations only runs nothing on its own and is skipped, as for a
  glob. The option `from:` limits the candidates to a path or glob written out in quotes, as for `goto`; one that names
  no file that runs something is a compile error. `findScripts` takes `where:`, `all:`, `none:`, `any:`, and `from:` as
  named arguments and returns `script` references to all matching candidates in path order, as a `script[]`. A pick,
  too, chooses among the candidates in path order.
- Comparison bounds and tag lists are evaluated once, in written order, before any candidate is matched. Matching draws
  no random number. A pick (`showImage tagged`, `goto tagged`, `call tagged`) draws once from the session random
  generator, and restoring a checkpoint never draws again.
- A `goto tagged` or `call tagged` that the compiler can see matches no candidate within its `from:` is a compile
  error, as when its tag tests and literal tag lists match none: every file's header is known when the project
  compiles.
- When the compilation is given the package images and no file takes photos with tags, a `showImage tagged` that the
  compiler can see matches none of them is a compile error, as when its tag tests and literal tag lists match none. Any
  other pick that finds no image is a runtime error.

### Image tags

- An image's tags are its XMP keywords ([ADR 0023](../decisions/0023-tags-for-scripts-and-images.md)), from its sidecar
  named after the whole file, such as `room.jpg.xmp`, when it has one, and otherwise embedded in the image. A keyword is
  a tag name, or a name and a number such as `punishment: 4`, with the rules of [Tags](#tags). Another keyword is
  ignored with a warning. A repeated tag counts once without a warning, because photo tools often keep `punishment`
  beside `punishment: 4`; two different numbers for one tag are an error.
- The catalog that tag queries search is generated from the package images when the project compiles. It is part of
  the plan, so a checkpoint keeps it and a restored session searches the same images.
- A photo taken with `takePhoto(tags: [...])` joins the catalog with these tags, under the reference `takePhoto`
  returns ([§33](#33-browser-api-file-folder-camera-and-url-references)):

  ```text
  let photo = takePhoto(tags: ["bedroom", "punishment: ${level}"])
  showImage tagged "bedroom", "punishment" >= 3       // may pick the photo
  ```

  The tags are texts such as `"bedroom"` or `"punishment: 4"`, read with the rules of [Tags](#tags) before the photo is
  taken; a text that is not a tag, or two numbers for one tag, is an error then, and no photo is taken. A repeated tag
  counts once. A photo taken without `tags:`, or no photo because the camera is unavailable, joins nothing. Tag
  queries search the package images in path order, then the photos in the order they were taken. The session keeps
  these entries, so a checkpoint restores them; a photo stays as available as its reference
  ([§33](#33-browser-api-file-folder-camera-and-url-references)).

## Remaining open decisions
The accepted core syntax is consolidated in this document. Remaining work is primarily detailed API payloads and engine/account behavior.

Resolved in this revision:

- unit literals accept documented abbreviations and full names with a required separating space;
- visible measurements use account-preferred unit systems, automatic readable scaling, an account decimal preference defaulting to two places, and per-call `format(unit: ..., decimals: ...)` overrides;
- `relativeTo: "background" | "viewport"`, background `fit: "contain" | "cover" | "stretch"`, and `"contain"` as the default are accepted;
- layered-scene positions and sizes may use `unit: "px"`, pixels of the background's intrinsic media canvas, and
  `imageSize(image)` returns an image's width and height in pixels (accepted future direction; not implemented; see
  [§22](#pixels-and-image-size));
- overlays use `hideOverlay`, asynchronous `moveOverlay` and `animateOverlay`, optional blocking behavior, and keyframe hold durations;
- `showImage <file>` and `hideImage` control the persistent Stage image; `showCamera [stage]` and `hideCamera` show and hide the camera's view; `playAudio` and `playVideo` are blocking by default, `async` returns a handle, `stopAudio` stops every sound, and cues use `at`, `beforeEnd`, and `finish` ([§22](#22-stage-image-audio-and-video));
- blur uses `showBlur` and `hideBlur` as a separate non-destructive visual layer;
- drawing uses dedicated shape/text functions and removable references;
- initial layered-scene transitions are `"none"`, `"fade"`, and `"crossfade"` (accepted future direction; not implemented; see [§22](#22-stage-image-audio-and-video));
- `playerProfile` is the typed player profile reference, which a script changes only through `askProfileChange(...)`;
- profile-change operations include `save`, `add`, `remove`, `removeAll`, `increase`, and `decrease`, while saving `[]` empties a list;
- toys have server-generated IDs, may share visible names, can be disabled without script-driven deletion, and have common photos plus initial detailed schemas for butt plugs, dildos, chastity devices, and ball gags;
- script-global data uses `publishGlobal` and `getGlobal`;
- cross-script same-player saved data uses read-only `loadFromScript` plus `getScriptMetadata`;
- account history uses `getPlayerHistory`; orgasm outcomes are `"orgasm"`, `"ruined"`, or `"denied"`;
- session checkpoints include sequence-controlled changed state, execution position, deterministic RNG state, and active recoverable runtime state;
- user identifiers are ASCII, case-sensitive, and follow `[A-Za-z_][A-Za-z0-9_]*`;
- numeric literals accept leading zeros, leading or trailing decimal dots, and the fixed scientific-notation forms documented in chapter 3;
- complete expression precedence and associativity are defined, with comparisons binding more strongly than `not`;
- single-line and block string escape sequences are defined, including `\${` for literal interpolation text;
- exact unit abbreviations, full names, singular forms, plural forms, capitalization, and multi-word matching are defined.

Open language and runtime decisions:

Parser-POC grammar blockers:

- none currently identified; statement separation, multiline continuation, identifiers, numeric literals, precedence, string escapes, and unit tokens are now defined.

Other open API and runtime decisions:

- define the player profile field names for unit system and decimal precision;
- decide whether an explicit unit-conversion method such as `measurement.to("km")` is needed in addition to presentation-only `format(...)`;
- define background alignment/position values when `contain` or `cover` leaves or crops edges;
- reconcile the Stage image with the layered scene: how `showImage` and the background and overlay layers coexist;
- decide whether `unit: "px"` is allowed only relative to background media, making `relativeTo: "viewport"` with
  `unit: "px"` an error because the viewport has no stable pixel size;
- define the return representation of `imageSize(image)`;
- decide how `imageSize` sizes an image other than a package image or a photo from `takePhoto()`, such as a file from
  `chooseFile()`;
- decide which layered-scene features the first implementation includes (backgrounds, overlays, `hideOverlay`,
  positioning) and which follow (movement, animation, blur, drawings, transitions);
- choose exact anchor values and decide whether hidden overlay references have a dedicated redisplay command;
- finalize drawing style parameter names, including fill, stroke, stroke width, opacity, font, text size, color, and alignment;
- define the edited-image export API and how an edited local reference links back to its original;
- finalize the `askProfileChange(...)` result object, especially how server-generated IDs of newly added toys are returned;
- define exact nested payload addressing for changing or disabling one toy by `toyId`;
- finalize the cheat-mode, permissive-mode, and hardcore property names and user-facing labels;
- define the per-setting lock enum, account-level counter-performance flows, owner-release rules, and exact maximum-duration fields;
- decide how scheduled chastity off-windows affect sentence duration in each account mode;
- define exact current-state fields, detailed edge-event fields, duration-session fields, and reconnect/abandoned-session finalization rules;
- define the standard and script-owned hygiene-pause APIs;
- define future speaker-specific LLM context fields.
