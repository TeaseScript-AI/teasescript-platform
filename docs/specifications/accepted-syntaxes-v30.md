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
- [35. Date, time, durations, and timestamps](#35-date-time-durations-and-timestamps)
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

let answer = choose stay:
    "Stay", leave: "Leave"
```

The same calls and objects may remain on one line:

```text
let result = calculateDamage(player, weapon)
let music = playAudio(file: "music/track.mp3", async: true, volume: 0.5)
let toy = { type: "buttPlug", name: "Black plug", diameter: 4 cm }
```

An operator must remain at the end of the continued line. It may not begin a new statement line:

```text
let total = score
    + bonus // compile error
```

Correct:

```text
let total = score +
    bonus
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
let duration: number = 2.5
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
let average = total / count
let remainder = amount % 2
```

Dividing numbers always returns a `number`, also when the result is whole. Storing it where an `integer` is required needs
explicit rounding ([§13](#13-explicit-types)):

```text
5 / 2                                 // 2.5
let shares: integer = 10 / 5          // compile error: a quotient is a number
let shares: integer = floor(10 / 5)   // valid
```

Arithmetic applies to numbers, and to durations as described in [§35](#35-date-time-durations-and-timestamps). `+` also
joins two values of the same kind: two texts give one text, and two lists give a new list ([§16](#16-lists)); `+=` joins
the same way. Nothing converts: text and another value, or a list and a single value, is a compile error that points to
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

The range itself defines whether the upper bound is inclusive or exclusive. `randomInteger(...)` therefore needs no separate minimum/maximum boundary convention.

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
- `&&`, `||`, and `!` are not part of the language.
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
7. Comparisons `==`, `!=`, `<`, `<=`, `>`, `>=`, and type tests `is`, `is not` ([§13](#13-explicit-types))
8. `not`
9. `and`
10. `or`

Postfix operations such as property access, indexing, and function calls associate from left to right:

```text
player.toys[0].name
```

Arithmetic operators associate from left to right within the same precedence level:

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
**Status:** Accepted

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
| `text.indexOf(part)`, `text.lastIndexOf(part)` | the position of the first or last occurrence of `part`, or `-1` |
| `text.substring(start)`, `text.substring(start, end)` | the characters from `start` up to, but not including, `end`; without `end`, up to the end of the text |
| `text.split(separator)` | a `string[]` of the parts between separators, keeping empty parts; `split("")` returns the single characters |
| `text.replace(search, replacement)` | the text with every occurrence of `search` replaced |
| `text.trim()`, `text.trimStart()`, `text.trimEnd()` | the text without whitespace at both ends, at the start, or at the end |
| `text.uppercase()`, `text.lowercase()` | the text in upper or lower case |
| `text.uppercaseFirst()` | the text with its first character in upper case and the rest unchanged |
| `text.repeat(count)` | the text repeated `count` times |
| `text.padStart(length, fill)`, `text.padEnd(length, fill)` | the text with `fill` repeated before or after it up to `length` characters; a text that is already long enough is unchanged |

Rules:

- Positions and lengths count code points from `0`, like list indexes. A position is an integer from `0` through the
  length, and `end` may not be before `start`. A `count` or padding `length` is an integer of `0` or more.
- Searching and replacing compare text literally and case-sensitively. A `replace` search and a padding `fill` must be
  non-empty.
- Case conversion uses the locale-independent full Unicode mapping: `"Straße".uppercase()` is `"STRASSE"`. It is not
  case folding and is not reversible: `"ß".uppercase().lowercase()` is `"ss"`. Composed and decomposed forms of the same
  visible text are different text, and `split("")` returns code points, so a flag emoji gives two parts.
- Arguments are positional. Misuse the compiler can see is a compile error: an unknown member, a member of a value
  that has none (`count.uppercase()` on a number), a wrong number of arguments, an argument of the wrong known type, a
  visibly negative, out-of-range, or empty argument, or an assignment such as `text.length = 0`. A value the compiler
  cannot know is checked when the operation runs, and an invalid one raises a runtime error.

## 9. Commands
**Status:** Accepted

Engine-provided commands may omit parentheses and receive one expression:

```text
say "Fixed text"
say "Text with ${playerName}"
say message
say greetings
wait 2
playAudio "door.mp3"
```

`say` shows a list, set, dict, or object in code-like notation; only `${...}` interpolation selects one random element
from a list ([§16](#16-lists)).

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
    player: player,
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
- A grammar keyword may still be used as an API field label when it appears in the unambiguous `name:` position of a named argument, object property, or engine configuration block. This permits accepted labels such as `default:`, `repeat:`, and account-operation labels such as `save:` without permitting those words as variable or function identifiers.

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
- A parameter with a default but no annotation takes the default's type by the same rule as `let`
  ([§12](#12-variable-declarations)): with `times = 1`, `times` is an `integer`, and a call that passes `0.5` is a compile
  error that suggests `times: number = 1`. Only an assignment in the body can make it a `number`, by the §12 rule for
  non-whole numbers. What a default leaves open stays unknown: `null` gives an unknown type, and `[]` a list of
  elements of unknown type.
- A parameter without an annotation or a default has an unknown type. Its arguments are not checked, because a
  parameter's type is never inferred from its call sites.

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
- Interactions, timers, media, `goto`, `call`, `end`, `exit`, and recursion work in it as in any function. A bare label
  in it means a label of the file where it is written, like `goto "helpers.tease" start`: the goto enters that file
  afresh, so a variable of the file used after the label needs its `let` after the label too ([§26](#26-labels-and-goto)),
  where a call that can run reaches the function.
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

- A variable that starts as `null` takes the type of its first non-null value and may still hold `null`. The compiler
  infers no other combination of types.
- A variable without a type whose type is `integer` is a `number` when any of its assignments can store a non-whole
  number, wherever that assignment is. The elements and properties inside such a variable widen by the same rule. A
  declared type, such as `integer`, `integer[]`, or `integer set`, stays strict, and an integer-only use of a widened
  value, such as a list index, `removeAt`, or a repeat count, is a compile error:

  ```text
  let speed = 1
  speed = speed * 1.5   // speed is a number, also on the lines above
  let count = 0
  count += 1            // count stays an integer
  let i = 0
  i = i / 2             // i is a number, so items[i] is a compile error
  let prices = [1, 2]
  prices.add(2.5)       // prices is a number[]
  ```

- An empty list or set takes its element type from the first element added or assigned. In a list or set literal,
  integers and numbers together are numbers, and `null` elements make the element type optional.
- "First" follows checking order: top-level statements in source order, then function bodies that were not yet
  needed, then timer and media blocks. The start values of globals and speakers come before all of this, in the order a
  session sets them up. A package checks its files in turn, `main.tease` first and then the others by path; a global
  function's body is checked where a call first needs its result, otherwise after its own file. The message for a later
  contradiction names the line of the first value, and its file when that is another one.
- A value whose type the compiler cannot know, such as untyped storage, host data, or a parameter of unknown type,
  decides nothing and is not rejected at compile time.

### Global variables

`global` declares a variable that all files of a package share
([ADR 0022](../decisions/0022-multi-file-scripts.md)):

```text
global strictness = 2
global level = load "level", default: 1
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
timestamp
duration
```

The other type names are `null`; `list`, `set`, `dict`, and `object` for any list, set, dict, or object; and the
program-control types `range`, `speaker`, `timer` (a timer handle), `media` (a media handle), and `script` (a script
reference, [§29](#29-script-files-and-paths)). A type is a type name
or one of these forms ([ADR 0021](../decisions/0021-static-types.md)):

```text
integer[]            // a list of integers
integer set          // a set of integers
integer dict         // a dict of integers by text key (§40)
integer?             // an integer or null: integer | null
integer | string     // an integer or text
(integer | string)[] // a list whose elements are integers or text
integer | string[]   // an integer, or a list of text
integer?[]           // a list of integers or nulls
integer[]?           // a list of integers, or null
```

`[]`, `set`, `dict`, and `?` follow a type and bind tighter than `|`; parentheses group. A set may hold any value a list
may hold, so `integer[] set` is a set of lists of integers ([§16](#16-lists)).

### Union types

A union `A | B` holds a value of either type. Unions may be used wherever a type is allowed: variables, list and set
elements, dict values, parameters, and return types. The compiler never infers a union; mixing types without a declared
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
  [§35](#35-date-time-durations-and-timestamps).
- A test works on every value, including untyped storage, host data, and parameters of unknown type. The operand is
  evaluated once, and the test has no side effects.
- `x is "happy"` is a compile error: `is` checks a type, and `==` compares values.
- The compiler warns about a test that is provably always true or always false, such as `5 is number`.

After a test, the compiler knows the narrower type:

- in the branches of `if`/`else`, in the right operand of `and` and `or`, and in the body of `while`;
- in the case blocks and the `default` of a `switch` ([§32](#32-switch-statements));
- after an `if` whose branch ends with `return`, `exit`, `break`, or `continue`;
- `x != null` and `x == null` narrow like `x is not null` and `x is null`.

```text
let saved = load "level"
if saved is not integer {
    exit
}
let level: integer = saved   // valid: saved is an integer here
```

- An assignment narrows the variable to the assigned value's type: directly after `let reward: integer | string = 10`,
  `reward` is an `integer`.
- Tests can overlap: an `else` branch keeps only what the test provably excludes, so a `number` that fails
  `is integer` is still a `number`.
- Only plain variables narrow; `door.locked` and `items[0]` do not.
- A function call, `wait`, interaction, `say`, timer, media command, storage write, or timer or media property write
  may let a function or block run, so it cancels narrowing for every top-level variable that a function or block
  assigns. A loop's start forgets what the loop body may change, and a function or block body does not inherit
  narrowing from the code around it.

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
  `5 s`. A bare number counts as seconds only in commands that expect a time: `wait`, `timer`, the `showButton`
  timeout, and media positions.

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
toTimestamp(value)
```

The date and time conversions read strict ISO text; see [§35](#35-date-time-durations-and-timestamps).

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
| `toString(value)` | text, numbers, `true` and `false`, `null`, durations, date and time values, and script references | the same text as `"${value}"` |
| `toNumber(value)` | numbers, and number text | a `number` |
| `toInteger(value)` | numbers, and number text | an `integer` |
| `toBoolean(value)` | `true` and `false`, and the text `"true"` or `"false"` | a `boolean` |

- Number text is what `askNumber` accepts: an optional sign, digits with an optional decimal point, and an optional
  exponent, such as `2.5`, `-3`, `.5`, or `1e3`. Surrounding whitespace is ignored, also around `"true"` and `"false"`.
  Other text, such as `"2,5"`, `"ten"`, or a number too large to represent, cannot be converted.
- No other value can be converted: `toNumber(true)` and `toBoolean(1)` are errors, and a list is combined into text with
  [`join`](#16-lists).
- A `default:` value must have the conversion's result type; an `integer` may be the default of `toNumber`.

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

`min(...)` and `max(...)` return the smallest or largest of two or more values, which are all numbers, all durations
of one family, or all date and time values of one kind ([§35](#35-date-time-durations-and-timestamps)). The result is
an `integer` when every argument is an `integer`, a `number` otherwise, and for durations and date and time values the
chosen value itself. Mixing numbers, durations, duration families, or temporal kinds, other values, `null`, and named
arguments are compile errors when the types show them, and runtime errors otherwise:

```text
let minutes = min(20, 5 + punishments)
let pause = max(1 minute, remaining)
let boundedLevel = max(1, min(level, 10))
```

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

A property keeps the type of its first value, like a variable ([§12](#12-variable-declarations)); an `integer`
property becomes a `number` when one of its assignments can store a non-whole number. Assignment may add a property,
which then keeps its type:

```text
door.locked = "yes"    // compile error: locked holds true or false (boolean)
door.color = "red"     // adds color, which holds text (string) from now on
```

When an object is stored in a place that already holds an object, such as an element of a list of objects, the
properties they share must have the same types.

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
items.contains("map")
items.join(", ")
items.intersection(other)
items.union(other)
items.difference(other)
```

`removeAt`, `removeFirst`, and `removeLast` return the removed element; the result may be ignored:

```text
let next = tasks.removeAt(0)
let newest = tasks.removeLast()
```

`items.join(separator)` returns the elements as text, separated by the text `separator`, which defaults to `", "`:
`["pet", "puppy"].join()` is `"pet, puppy"`. Use `${items.join()}` to show every element where `${items}` selects one.
Elements may be text, numbers, `true` or `false`, `null`, durations, date and time values, and script references,
shown as `${...}` shows them; any other element raises an error.

List properties:

```text
items.length
items.first
items.last
items.random
```

`items.random` explicitly selects one element using the deterministic session RNG. It works for value lists and object lists:

```text
let chosenName = player.petNames.random
let stranger = speakers.random
```

### Lists in text

Interpolation is the only place where a list turns into one random element. Each `${...}` evaluation selects one
element with the deterministic session RNG:

```text
say "Good ${player.petNames}"
say "Come closer, ${player.petNames}"
```

The two evaluations may choose different elements. Replay and debugging reproduce the same session sequence.

An interpolated list may contain any value that `${...}` shows on its own: text, numbers, `true` and `false`, `null`,
durations, date and time values, and script references ([§29](#29-script-files-and-paths)). A list holds one element type ([§12](#12-variable-declarations)), and integers and
numbers together are numbers. The selected element is shown as that value would be:

```text
let waits = [30 seconds, 90 seconds]

say "Wait ${waits}"  // for example "Wait 1 min 30 s"
```

A list that holds values of different types needs a declared union element type ([§13](#13-explicit-types)):

```text
let values: (string | number | duration)[] = ["Level", 2, 3.5, 90 seconds]

say "Current: ${values}"  // for example "Current: 1 min 30 s"
```

The whole list is checked before the selection, so a list that also contains a list, a set, an object, or a media or
resource reference is rejected whichever element would have been selected. Object lists remain valid lists; select from
them explicitly:

```text
let stranger = speakers.random
```

`say` is also a debugging aid for whole values. Like Python's `print`, it shows text, numbers, `true` and `false`,
`null`, durations, and date and time values as it does on their own, and every other value in a code-like notation:

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
say [90 seconds]               // [1 min 30 s]
say 1..=5                      // 1..=5
say mistress                   // <speaker mistress>
say music                      // <media "music.mp3", playing at 12 s>
say beat                       // <timer "Beat", 7 s left>
```

In this notation, text is quoted with the string escapes of [§8](#8-strings-and-interpolation), durations use their
short form, a set shows like a list, an object shows its properties in order, a dict shows its quoted keys and values in
order, and a range shows as written. A speaker shows its identifier. A media handle shows its file and state:
`playing at` or `paused at` its position, `stopped`, or `finished`. A timer handle shows its label when it has one and
its state: the time left (after `paused,` when paused), `stopped`, or `finished`. A permanent button identifier shows
the button's text, `<permanent button "Stop">`, or `<permanent button, removed>`. Handles show the state at the moment
`say` runs. Message markup is not applied to the notation.

Other text fields, such as a button label, an input hint, the `text` of a choice object, a timer label, or a speaker's
name or title, do not select from a list. A list there is a compile error when the compiler can see it, such as a list
literal or a variable that holds a list, and a runtime error otherwise; the message points to `"${list}"` and
`list.random`. Another value a text field cannot show, such as an object or a range, is likewise a compile error when
the compiler can see it. A list as a whole `choose` option instead gives
one button per element ([§19](#19-choices)).

To choose a specific element, use its index:

```text
say player.petNames[0]
say "Today I will call you ${player.petNames[1]}"
```

To reuse one random choice, select it explicitly and store the resulting value:

```text
let chosenName = player.petNames.random

say "From now on, you are my ${chosenName}"
say "Come here, ${chosenName}"
```

Normal assignment does not perform random selection:

```text
let copiedNames = player.petNames
```

This assigns a list copy. List assignment uses copy semantics rather than a shared reference:

```text
let copiedNames = originalNames
copiedNames.add("new")
```

`originalNames` remains unchanged.

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

- An invalid index raises a runtime error rather than returning `null`. The compiler reports an index that it can see
  is negative or not a whole number, such as `items[-1]` or `items.removeAt(0.5)`.
- Interpolating an empty list raises a runtime error because no element can be selected.
- The empty-list error identifies the interpolated expression and explains that interpolation needs at least one
  element to select from.
- A value `${...}` cannot show, or a list literal inside it that is empty or holds such a value, is a compile error
  when the compiler can see it.
- Two lists are equal (`==`) when they have the same length and equal elements in the same order; two sets are equal
  when they have the same members in any order; two ranges are equal when they are written with the same bounds and
  the same inclusiveness, so `1..=2 != 1..3` although both produce `1` and `2`. Values of different kinds, such as a
  list and a set, are never equal. List `contains(value)` and `remove(value)` use this equality, so they also find
  objects and nested lists; `remove(value)` removes the first equal element.
- A set may hold any value a list may hold: text, numbers, `true` and `false`, `null`, durations, date and time values
  ([§35](#35-date-time-durations-and-timestamps)), lists, objects, dicts, sets, ranges, speakers, timer and media
  handles, and script references. Collections nest in every direction, such as sets of lists, sets in dicts, and lists in lists. A set keeps
  the first of members that are equal (`==`), in insertion order, so `set[[1, 2], [1, 2]]` has one member, and its
  `contains(value)` and `remove(value)` use the same equality. A member is copied when it is added, and `.first`,
  `.last`, `.random`, and a `for` loop give copies, so changing one does not change the set.
- The operands of `==` and `!=` are read when they are evaluated, left to right, so a change made while evaluating the
  right operand does not affect the left one: `items == [items.removeAt(0)]` is `true` for `items = [1]`.
- `remove(value)` leaves the list unchanged when the value is absent and emits a warning to the developer log.
- `removeAt(index)` removes the element at a zero-based index and moves later elements forward. An invalid index
  raises the same runtime error as indexing.
- `removeFirst()` and `removeLast()` on an empty list raise a runtime error, like `.first` and `.last`.
- `add(value)`, `addAll(other)`, `remove(value)`, `clear()`, `sort()`, and `shuffle()` return `null`. Set
  `remove(value)` of an absent value is a no-op: the set stays unchanged and execution continues without an error or
  warning.
- Mutating methods change the existing list.
- `sort()` orders a list in place, ascending and stable. Its elements must all be numbers (integers and numbers
  together), all text, all durations of one family, or all dates, all times, all datetimes, or all timestamps
  ([§35](#35-date-time-durations-and-timestamps)); text is ordered by Unicode code point, independently of locale, so
  `"B"` sorts before `"a"`. Other or mixed elements are a compile error when the element type shows them, and a runtime
  error otherwise.
- `shuffle()` puts a list in a uniformly random order in place with the deterministic session RNG. The number of random
  draws depends only on the length, so replay and checkpoint resume reproduce the order; a list of fewer than two
  elements draws nothing.
- Sets keep their insertion order and have no `sort()` or `shuffle()`; copy a set into a list with `toList()` first.
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
function calculateDamage(player, weapon) {
    return player.strength + weapon.power
}
```

Exit without a value:

```text
return
```

Optional return-type annotation follows the parameters:

```text
function calculateDamage(
    player,
    weapon
): number {
    return player.strength + weapon.power
}
```

`void` is not required for functions without a returned value.

A function's result type comes from its `return` values, so callers keep it like any other value
([§12](#12-variable-declarations)). Integers and numbers together give a `number`. Returns of different types are a
compile error that names both. A function that can end without returning a value, by reaching its end or through a
bare `return`, returns `null` there, so its result may be `null`. A returned value of unknown type, such as an
unannotated parameter, makes the result unknown; the other returned values must still agree.

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
error. The message names the check to write: `if n != null { ... }`, inside which `n` is an `integer`. A loaded value
can instead get a default, as in `load "level", default: 1`.

## 19. Choices
**Status:** Accepted

`choose` shows one button per option and returns the value of the selected button. A button shows its text; its value
is what `choose` returns. Options are comma-separated; the interaction itself (presentation, typed answers,
transcript) is defined in [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#choose).

```text
let action = choose open: "Open the door", leave: "Walk away"

if action == "open" {
    openDoor()
}
```

An option may have a value written before `:`. An identifier returns text and a numeric literal returns its number, an
`integer` or a `number` as written. An option without a written value returns itself, with its own type:

```text
let answer = choose back: "Back", "Spanking", "Lines"   // "back", "Spanking", or "Lines"
let rounds = choose 5, 10                               // 5 or 10, an integer
```

A list used as an option gives one button per element, in order; a set gives one button per member, in insertion order,
in the same way. An element is a value, or a choice object `{ value?, text, background? }`: the button shows `text`,
returns `value` (or the `text` value when `value` is omitted), and uses `background` as its colour
([§37](#authored-colours)). A choice object may also be a whole option. A value written before a list or set option is
the value of every button from it:

```text
let offenses = [{ value: "spank", text: "Spanking" }, { text: "Corner" }]
let answer = choose back: "Back", offenses   // "back", "spank", or "Corner"
let n = choose [5, 10, 15]                   // n is an integer
let door = choose win: "Open a door", lose: ["Open a door", "Open a door"]   // 3 buttons; the last two return "lose"
```

Rules:

- A button shows its option, or its choice object's `text`, as `${...}` shows it: text, a number, `true` or `false`,
  `null`, a duration, or a date or time value.
- Options with and without a written value may be mixed.
- When all values have the same type, the result has that type; integers and numbers together are numbers.
- Values of different types, such as text and numbers, give a union ([§13](#13-explicit-types)). Only a place declared
  with a union type keeps such a result; storing it where its type would be inferred, as in an unannotated `let`, is a
  compile error that names the union to declare:

  ```text
  let rounds: integer | string = choose "None", [5, 10]   // "None", 5, or 10
  let other = choose "None", [5, 10]                      // compile error: declare 'let other: string | integer'
  ```

- When the source shows every button's value, the result is known to be one of them until the variable is assigned
  again or a call or suspension may change it ([ADR 0021](../decisions/0021-static-types.md) rule 5.5), and comparing
  it with a value that no button returns, also as a literal `case` value ([§32](#32-switch-statements)), is a compiler
  warning:

  ```text
  let answer = choose "spank", "lines"
  if answer == "Open" { ... }   // warning: 'answer' is always "spank" or "lines" here
  ```

- The elements of a list option are values or choice objects, not lists or sets.
- A choice object has `text`, and optionally `value` and `background`. It has no `value` property when a value is
  written before its option's `:`, also as an element of a list or set option.
- An empty list or set contributes no buttons. A `choose` without any button is an error: a compile error when it is
  visible in the source, such as `choose []`, and a runtime error otherwise.
- Buttons may repeat a value or a text: `choose win: "Open a door", lose: "Open a door", lose: "Open a door"` shows
  three buttons. A selected button is identified by its position, so each returns its own value.
- `choose` does not return a result object.

## 20. Input functions
**Status:** Accepted (parenthesized basic asks implemented: Owner decision on #627, 2026-10-05)

`askText`, `askNumber`, `askInteger`, `askDate`, `askTime`, and `askDateTime` are implemented in this parenthesized
form with the arguments of their compact form
([ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#parenthesized-basic-asks)): an optional text and
an optional `default:`. Both forms mean the same: `askText()` is `askText`, and
`askText as mistress ("Name?", default: "Ada")` is `askText as mistress "Name?", default: "Ada"`. The speaker clause
comes before the parentheses, and the `)` ends the ask, so `askInteger("How many?") + 1` adds to the answer. Their
other options in this section, such as `message:` and `invalidMessage:`, are not implemented yet.

### Text input

```text
let name = askText("What is your name?")
```

`askText(...)` only completes when non-empty valid text has been entered and returns `string`.

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
- `default`: `string`; see [Default answers](#default-answers)

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
    defaults: [1.5, 10, 2.5]
)
```

`askNumbers(...)` expects:

- `message`: `string`
- `texts`: `string[]`
- `defaults`: `number[]`

It only completes when every field contains a valid number and returns `number[]`.

### Integer input

```text
let count = askInteger("Enter a whole number")
```

`askInteger(...)` only completes when a valid whole number has been entered and returns `integer`. The compact form
`askInteger [as speaker] [hint] [, default: integer]` is implemented as the whole-number counterpart of `askNumber`
([ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#askinteger)): an answer is an optional sign and
digits within the safe integer range.

### Multiple integer inputs

```text
let values = askIntegers(
    message: "Enter the values",
    texts: ["Minimum", "Maximum", "Repetitions"],
    defaults: [1, 10, 3]
)
```

`askIntegers(...)` expects:

- `message`: `string`
- `texts`: `string[]`
- `defaults`: `integer[]`

It only completes when every field contains a valid whole number and returns `integer[]`.

### Boolean input

```text
let answer = askBoolean("Continue?")
```

Custom boolean labels:

```text
let answer = askBoolean(
    message: "Continue?",
    yesText: "Continue",
    noText: "Stop"
)
```

`askBoolean(...)` returns `boolean`.

### Multiple boolean choices

```text
let selected = askBooleans(
    message: "Choose all that apply",
    texts: ["A", "B", "C"],
    defaults: [true, false, false]
)
```

`askBooleans(...)` expects:

- `message`: `string`
- `texts`: `string[]`
- `defaults`: `boolean[]`

It returns `boolean[]`.

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

The compact forms `askDate`, `askTime`, and `askDateTime [as speaker] [hint] [, default: value]` are implemented
([ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#askdate-asktime-and-askdatetime)). The control
submits strict ISO text ([§35](#35-date-time-durations-and-timestamps)); a local time that the player's zone skips is a
valid answer. The transcript shows the answer in the player's presentation. The Player's date and date-and-time
controls cover the years 0001 through 9999, as the browser's native controls do; a default in year 0000 is shown and
edited as ISO text instead. The value domain stays 0000 through 9999 for conversions, defaults, and text answers.

### Default answers

Every single-field input accepts an optional named `default:` answer that prefills its field:

```text
let name = askText("What is your name?", default: "Ada")
let minutes = askNumber("Corner time?", default: cornerBase + playerLevel)
let count = askInteger("How many?", default: 10)
let answer = askBoolean("Continue?", default: true)
let day = askDate("Which date?", default: getDate())
```

| Function | `default:` value |
|---|---|
| `askText(...)`, `askTyping(...)` | `string` with a non-whitespace character |
| `askNumber(...)` | `number` or `integer` |
| `askInteger(...)` | `integer` |
| `askBoolean(...)` | `boolean` |
| `askDate(...)`, `askTime(...)`, `askDateTime(...)` | `date`, `time`, and `datetime` respectively |

Rules:

- The input opens with the default as its editable answer, and the player still submits explicitly. A submitted
  default is an ordinary answer: its result, validation, and transcript text are those of the same answer entered by
  hand.
- Clearing the field never falls back to the default; a blank answer is rejected and asked again.
- The default must be an answer the input accepts. There is no implicit conversion except `integer` to `number`: write
  `default: "${count}"` to offer a number as text. A non-whole `askInteger` default is an error, never rounded.
- A default that is `null` or blank text (empty or only whitespace) when the input opens prefills nothing: the field
  starts empty, as without `default:`. A prefill can therefore come from a value that may not exist yet, such as
  `askText "Your name?", default: load "name"` on a first play. A default known at compile time to be `null` or blank,
  such as `default: ""` or `default: null`, is a compile error; remove `default:` to start with an empty field.
- The compiler rejects a default that it knows is invalid, and its error names the fix. Any other default is checked
  when the input opens; an invalid one is a runtime error, and the input does not open.
- `askTyping` applies its `allow...` restrictions to the prefilled text as to typed text.
- Restoring a checkpoint shows the original default again; edits the player had not submitted are dropped.
- `choose` has no preselected option: a choice is an explicit decision, and a choice button completes when activated.
  An author can style the preferred option instead, for example with `background:`. File, folder, image, video, and
  audio pickers have no prefill because a browser cannot preset a file input. Multi-field inputs keep their
  `defaults:` lists.

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

By default, camera and file upload are both available:

```text
let image = askImage("Add an image")
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

`askImage(...)` **status (Owner decisions, 2026-10-05):** images only, for now. The Player offers the file route:
while the request waits, a paperclip in its composer opens the browser's native file picker, and an image file dropped
onto the composer answers the request; outside such a request there is neither. A chosen image stays in the browser
and is session media with the lifecycle of a `takePhoto()` photo (§33): durable only while saved script storage
references it. When the request allows the camera and the browser can capture, the camera turns on by itself as the
request asks (owner round 5): the session camera when it is already open, otherwise one the request opens, which turns
off again after the answer, also when a file answers. The viewfinder opens on the Stage, or in the camera window a
script shows, with the request's message as its question and the shutter on the picture; the shutter counts down five
seconds, as a large animated number from 5 to 1 over the viewfinder, and the photo taken then shows with
"Use this" and "Retake", and only "Use this" gives the script the photo. These are Player controls, not transcript
messages. A camera that is denied or broken offers "Try again", and the paperclip keeps working. After a reload while
the request waits, the camera is asked for again, but a photo is never taken by itself. `invalidMessage` and `invalidLlmInstruction` are not implemented yet.

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

`askText(...)` and `askTyping(...)` do not need type-error messages because every entered value is text. Their own non-empty or task-specific validation may still use `invalidMessage` later if additional validation rules are added.

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

- `askText(...)`, `askTyping(...)`, `askNumber(...)`, `askNumbers(...)`, `askInteger(...)`, `askIntegers(...)`, `askDate(...)`, `askTime(...)`, `askDateTime(...)`, `askBoolean(...)`, `askBooleans(...)`, `askFile(...)`, `askFiles(...)`, `askFolder(...)`, `askImage(...)`, `askVideo(...)`, and `askAudio(...)` do not return `null`.
- Input functions complete only after valid input has been supplied.
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

## 21. Blocking button
**Status:** Accepted (compact form: Owner decision on #531, 2026-10-04)

`showButton` displays a button and blocks normal script execution until the user clicks it or an optional timeout is
reached. It uses the compact form of [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md#showbutton),
including `as speaker` and `background:`:

```text
showButton "Continue"
showButton "Continue", timeout: 5
let elapsed = showButton "Continue", timeout: 30 s
if elapsed < 2 s {
    say "That was quick."
}
```

Rules:

- `timeout` is optional. A bare number counts seconds, as for `wait` and `timer` ([§27](#27-timers)); an elapsed
  duration such as `500 ms` or `2 min` may also be used. `5` and `5 s` are the same timeout.
- Without a timeout, the command waits until the user clicks.
- With a timeout, execution continues after the click or when the timeout is reached. A reached timeout removes the
  button without a chat message.
- The command returns the elapsed waiting time as a `duration` ([§35](#35-date-time-durations-and-timestamps)),
  measured in scene time like timers ([§27](#time)). When the timeout is reached, the returned duration equals the
  timeout; a timeout of `5` returns `5 s`.
- If the caller does not need the elapsed time, the return value may be ignored.
- A zero, negative, or non-numeric timeout, or one with a calendar unit, is an error. The compiler rejects a timeout
  it can see is invalid; any other is checked when the button would appear, and an invalid one is a runtime error.
- The parenthesized forms `showButton("Continue", 5)` and `showButton(text: "Continue", timeout: 5)` are deferred
  until parenthesized interaction calls are needed.
- `showButton` belongs to the core language/runtime API, not specifically to the browser-picker API.

## 22. Stage image, audio, and video
**Status:** Accepted (Owner decisions on [#445](https://github.com/TeaseScript-AI/teasescript-platform/issues/445)). The
parser, compiler, deterministic runtime, and checkpoint foundation for image, audio, and video is implemented; Player
image and audio integration is tracked in #446, and browser video playback is planned.

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
  `showImage`, or `hideImage` stops an active video (`stopped`, without `finish`), and the Stage image is visible again
  when the video ends.

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
`endAt`, `at`, and `beforeEnd` accept non-negative exact durations or numbers of seconds. `startAt` and `endAt` default
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

On the ordinary story path, `showImage`, `hideImage`, `showCamera`, `hideCamera`, `playAudio`, `playVideo`, and
statement-level media handle operations such as `music.pause()` or `music.position = 2 min`, and camera placement
writes, wait until the previous message's pacing has completed or been skipped, like a following `say`. `wait` and
`timer` keep overlapping message pacing ([§27](#27-timers)). Timer and cue blocks keep the canonical interrupt pacing
and add no media wait.

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
  indefinitely. A block may declare `finish` at most once.
- Blocks are allowed for blocking and async media. They run one at a time through the timer interrupt queue with the
  same interruption and resumption rules as [timer expiry blocks](#expiry-blocks); cues due at the same point run in
  source order. Media keeps playing while a block runs unless the block controls it. `stop()` cancels queued blocks of
  that media that have not started.
- A block sees top-level names and its own locals, not the locals of the code that started the media. In
  `let NAME = playAudio async ... { ... }` every block also sees `NAME` as its own handle, including inside a function.
  This narrow self-handle binding is not general closure capture, which is tracked by #449.

### Failures, cleanup, and restore

- When the Player cannot load a source, or the source leaves an empty playback range, the runtime reports developer
  warning `TSW013`, the media becomes `stopped` without cues or `finish`, and the script continues. A `null` file plays
  nothing, continues at once, and reports `TSW011`.
- `exit` and the end of the session stop all media; the last Stage image stays. `goto`, `call`, and `end` do not stop
  media.
- Checkpoint and restore preserve the Stage image and media state; playback resumes from the persisted position, and
  time without a running Player does not advance media. Restore does not imply cross-device handoff.

### Superseded V30 media forms

| V30 form | Replacement |
| --- | --- |
| `playSound x` | `playAudio x` |
| `playBackgroundSound(x)` and `stopBackgroundSound(id)` | `let s = playAudio async x` and `s.stop()` |
| `stopVideo()` | `v.stop()` on an async video, or `showImage` / `hideImage` |
| `showBackgroundVideo(x, loop: true)` | `playVideo async repeat x` |
| positioned or timed top-level `showImage(...)` and `hideImage(ref)` | `showImage <file>` and `hideImage` for the Stage image |

### Future layered scene
**Status:** Accepted V30 direction, extended with [pixels and image size](#pixels-and-image-size) (Owner decision on
[#617](https://github.com/TeaseScript-AI/teasescript-platform/issues/617)); not implemented. Background and overlay
layers, their coordinate space, movement, blur, drawings, edited copies, and transitions remain separate from the Stage
image and media foundation above, which supersedes the old positioned and timed top-level image. Points affected by the
Stage image model must be reconciled before the layered scene is implemented.

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
**Status:** Accepted

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
a range, as they were when the loop started: changing the source inside the loop does not change what the loop visits.

```text
while player.health > 0 {
    wait 1
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
**Status:** Accepted (bounded `load(...)`: Owner decision on #627, 2026-10-05)

Save or overwrite a value:

```text
save playerName as "player.name"
```

`save value as key` evaluates the value first, then the key. It creates the key when absent and replaces its value
when present. Saving `null` removes the key, like `delete`; stored top-level values are never `null`.

`load` has a bounded form and a compact form; the fallback `default:` is optional:

```text
let playerName = load("player.name")              // null when the key is absent
let score: number = load("player.score", default: 0)
let visits = load "visits", default: 0             // compact form
```

`load` evaluates its key first. When the key exists, it returns the stored value with its stored TeaseScript type
without evaluating the default. When absent, it evaluates and returns the default, or returns `null` without one.
`load` never writes: the default is not stored. Only `save` creates or changes a stored value. An explicit target
type may determine the intended numeric type of a literal default, as in the `number` example above.

The bounded form takes the key and an optional named `default:` inside `()`, where line breaks follow the rules of
other arguments. Its `)` ends the `load`, also with a space before `(`, so the result combines directly with another
expression:

```text
load("k") == null
load("a", default: 0) + 1
```

The operands of `save` and of a compact `load` are full expressions. `as` ends the value of `save`. A `, default:`
belongs to the nearest construct before it that takes one, also inside a bounded `load`: a compact `load`, the default
answer of an ask, or a labelled option of a compact `choose`. Group the inner construct, or use a parenthesized ask,
to give the fallback to `load`, as in `load(askText("Key?"), default: "none")` or
`load((choose a: "x", b: "y"), default: "z")`; without the inner parentheses, the choice gets a third option labelled
`default`. Inside `()`, `[]`, and object literals, where a line
break does not end an expression, the comma may also start the next line. Group a compact `load`, as in
`(load "k") == null`, before combining its result with another expression. Without parentheses, `load "k" == null`
uses `"k" == null` as the key, which is not a string. Group a nested compact `load` used as a key too.
A compact interaction inside a `save` value ends at the `as`, which belongs to `save`:
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
- A loaded value must fit the type of the place that receives it ([§13](#13-explicit-types)), or runtime error
  `TSR058` is raised. This applies to the stored value, the default, and `null` for a missing key, so
  `let level: integer = load "level"` needs `integer?` or a default when the key may be missing.
- Persistent plain data is storable. Timer handles, media handles, and speaker references exist only in the current
  session and cannot be saved, including when nested inside lists or objects (`TSR055`). Nested `null` is allowed.
- Saving and loading copy data: later changes to the saved variable or a loaded value do not change storage.
- A string naming a camera, file, or media reference is stored only as a string; storage itself does not persist the
  media. A photo from `takePhoto()` or an image from `askImage(...)` is kept by the Player while saved storage
  references it (§33).
- Storage keys are plain strings.
- After unwrapping parentheses, a recognizably non-string outer key expression is a compile error (`TSV038`). Other
  keys are checked at runtime and raise `TSR054` if non-string. For `load`, the diagnostic explains:
  `Storage key must be a string. To compare the loaded value, write 'load("k") == null'.`
- Dots and slashes inside a key are naming conventions only.
- The complete string is treated as one key.

Storage currently supports strings, finite numbers, booleans, lists, objects, sets, dicts, ranges, durations, and date
and time values, including nested `null`. Wider persistent-data support is not yet implemented; this subset is not a
permanent language limit. The compiler rejects a default whose type is known and does not match. Replacement-value
recovery under [§34](#34-runtime-warnings-and-recoverable-values) is not yet implemented.

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
  anywhere.
- Labels are local to their file; `goto label` moves within the current file. [§29](#29-script-files-and-paths)
  defines `goto` to another file.
- Unknown labels and duplicate labels in one file are compile errors.
- A `goto` discards the current function, loop, and block continuations.
- A `goto` back to an earlier label runs the top-level `let`s after it again, which set their variables anew. A variable
  of the file may be used after a label only when every way to the label has run its `let`; otherwise it is a compile
  error.
- A `goto` triggered by an event aborts the current execution path and does not return.

## 27. Timers
**Status:** Accepted (Owner decisions on PR #443, 2026-09-30)

One `timer` concept covers blocking and asynchronous countdowns. `wait` is the shorthand for a hidden blocking
timer and shares its clock, checkpoint, and restore behavior.

### Short form

```text
wait 10                                   // hidden, blocking
timer 10                                  // visible, blocking
timer mystery 5..10 "Hold"                // mystery, blocking, labelled
timer async 30 s "Deadline" { ... }       // visible, asynchronous, with an expiry block
let t = timer async hidden 2 min { ... }  // keeps the handle
```

`timer [async] [visible|mystery|hidden] <duration> [unit] ["label"] [{ expiry block }]`: the execution modifier
comes first, then the presentation, the duration, an optional string-literal label, and the expiry block. Omitted
modifiers mean visible and blocking. `async`, `visible`, `mystery`, and `hidden` are recognized only directly after
`timer`; write `timer (hidden)` to use a variable of that name as the duration.

A duration is a bare number of seconds, a [§35](#35-date-time-durations-and-timestamps) elapsed duration such as
`500 ms` or `2 min`, or a number followed by a trailing unit as for `wait` (`timer n ms`). A range such as `5..10` or
`5..=10` counts whole seconds and is drawn once per round from the session RNG after the timer's operands are
evaluated. Ranges with other units, such as `5..10 min`, are not implemented yet. `timer 0` and `wait 0` continue
immediately.

### Named form

```text
let beat = timer(duration: 1..=3, async: true, display: "mystery", label: "Beat", repeat: true, persist: true) {
    say "Beat."
}
```

The named form carries the same fields plus `repeat` and `persist`. `async`, `repeat`, and `persist` are the
literals `true` or `false`; `duration`, `display`, and `label` are expressions evaluated in source order. `display`
defaults to `visible`, and an expression must evaluate to `"visible"`, `"mystery"`, or `"hidden"` for blocking and
asynchronous timers alike.

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
- `pause()` while paused, `resume()` while running, and `stop()` on a finished or stopped timer do nothing;
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
playing audio or video. It may use top-level names, its own locals, normal functions, and new timers, but not the
local variables of the code that started the timer.

A due block interrupts at the next deterministic runtime boundary, including while the main path waits on an
interaction, `wait`, or blocking timer; it waits while a paced message still blocks the chat. The interrupted action
is inert while the block runs, so there are never two active story paths:

- if the block completes normally, the interrupted action is presented again and the script continues where it
  left off;
- if the block uses `exit`, the session halts and the interrupted action and source instruction are discarded:
  an interrupted `let answer = askText ...` completes nothing and binds no value.

A `goto` from the block, also from a function that the block calls, discards the interrupted action and instruction
in the same way.

Blocks run one at a time in due order. A block may itself wait; later expiries queue behind it.

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
`let NAME = timer async ...` will likewise see `NAME` as its own handle; until then expiry blocks see no local of the
code that started the timer.

### Time

Timers and `wait` measure Player-executed scene time. Presentation and blocking do not change the clock. Time keeps
running while a live Player is minimized or in the background; when the Player is closed and later restored,
including on another device, the gap does not consume timer time and the timer continues with its saved remaining
time. A script plays the same however late or often the Player observes time: everything happens at its own moment
in scene time. See [`RUNTIME.md`](../RUNTIME.md#timers-and-scene-time) for the observation contract.

Scene time is measured in milliseconds, including fractional milliseconds, up to 2^53 − 1, about 285,000 years. A `wait`, timer, or `showButton` timeout
longer than that can never end; the compiler rejects one it can see, such as `wait 1e15`, and any other is a runtime
error.

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

Remove a button explicitly; removing a button that is already gone does nothing:

```text
removePermanentButton(buttonId)
```

The text follows the rules of other button labels ([§16](#lists-in-text)). Buttons appear in the order they were shown.

Click and handler behavior:

- A click runs the handler once, like a timer expiry block ([§27](#expiry-blocks)): it interrupts at the next
  deterministic runtime boundary, also while the main path waits on an interaction, `wait`, or media, and waits while a
  paced message still blocks the chat or another block runs. The interrupted action returns when the handler finishes.
- From the click until its handler finishes, the button stays in place but is inactive and cannot be clicked. It
  becomes active again unless it was removed.
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

Go to another file, from its top or at a label:

```text
goto "punishments/strict.tease"
goto "punishments/strict.tease" start
```

Call another file, from its top or at a label; execution continues after the `call` when that file reaches `end`:

```text
call "corner-time/short.tease"
call "corner-time/short.tease" start
call start                          // a label of this file, entered afresh
```

A glob pattern picks one matching file at random:

```text
goto "punishments/*.tease"
goto "punishments/*.tease" start    // only files that have label start
call "corner-time/*.tease"
```

A computed target needs the explicit conversion `script(path, label:)`:

```text
goto script("rooms/${room}.tease")
goto script("rooms/${room}.tease", label: "start")
let next = script("rooms/hall.tease")
goto (next)
```

Rules:

- `goto` to another file replaces the current file and does not return. Pending `call` returns remain; the current
  function, loop, and block continuations are discarded.
- `call` keeps the current position, including an enclosing function or loop, and resumes after the `call` when the
  called file reaches `end`.
- Each entry into a file, by `goto` or `call` naming it, by `call` of a label, or by the fallback, starts with fresh
  top-level variables of that file. A `goto` to a label of the file continues with the variables of the entry it runs
  in.
- A function sees the top-level variables of the entry that called it, and a timer or media block those of the entry
  that started it, also after the session has left that entry.
- `end`, also in a function or block, ends the running file and returns after its `call`. A file called from a block
  returns into that block.
- A `goto label` in a block of an entry other than the running one continues that entry at the label, with its own
  variables. If that entry called the running file, the calls above it are abandoned and its own callers stay; if the
  session had left that entry, it takes the place of the running one.
- A path that leaves the package, a missing file, and a missing label are compile errors.
- In a glob, `*` stands for any characters within one folder or file name. Globs are expanded at compile time. A glob
  only picks files that do something: the matched files that have the label, when one is given, and do not hold
  declarations only. A glob with no such file is a compile error. A glob may pick the file it stands in.
- Each time a glob target runs, one draw from the session random generator picks the file; a glob `fallback` draws
  each time the fallback is used. Restoring a checkpoint never draws again.
- `script(path)` returns a `script` reference to a file, and `script(path, label: name)` one to a label in it; the path
  and the name are text. Plain text is not a jump target. A reference is a value: it can be stored in variables, lists,
  dicts, sets, and globals, saved with `save`, and compared with `==` by path and label. It shows as the call that makes
  it, such as `script("rooms/hall.tease", label: "start")`, has no properties or methods, and is not a `choose` value.
  A computed target, a `script(...)` call or a grouped expression such as `goto (next)`, must be a reference.
- A `script(...)` whose path is literal, quoted text without `${...}`, is checked like a file target: a path that leaves
  the package, a missing file, a missing literal label, a glob, and a `goto` or `fallback` to a file of declarations
  only are compile errors. Any other reference is checked when a transfer uses it, a computed `fallback` when the
  statement runs: a missing file or label, or a `goto` or `fallback` to a file of declarations only, is a runtime error.
- For the check of variables after labels ([§26](#26-labels-and-goto)), the compiler reads from the source alone which
  labels references may enter afresh: a `script(...)` with a literal label enters that label of its file, or with a
  computed path that label of every file that has it, and one with a computed label every label of its file, or of
  every file. Reading or assigning a variable of the file whose `let` has not run in this entry into the file, as
  after a label that a reference from `load` entered, or in a function called before the `let`, is a runtime error.
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

Set the destination for an `end` without a caller, with the same targets as `goto` ([§29](#29-script-files-and-paths)):

```text
fallback "menu.tease"
fallback "menu.tease" start
if chapter > 3 { fallback script("chapters/${chapter}.tease", label: "recap") }
```

Behavior:

- `exit` is the only normal way to finish the session, and it is always required, in `main.tease` too. It works
  anywhere, including in a called file or a function, and never returns. A project with no reachable `exit` does not
  compile.
- `end` ends the current file, also from inside a function or block, and returns to the file that `call`ed it.
- Reaching `end` with no caller continues at the fallback destination when one is set, and is an error otherwise. The
  fallback is never implicit.
- `fallback` may run any number of times, anywhere, including inside `if`; the latest one executed wins. It is session
  state and is checkpointed. `fallback none` clears it again.
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

- statements are unreachable;
- an `exit` is declared but unreachable;
- a loop has no way out once it starts (`TSV058`, on its `while` or `goto`): `while true`, with or without parentheses,
  or an unconditional top-level `goto` back to an earlier label of its file, whose loop is the statements between them.
  A `break`, `return`, `end`, `exit`, any other `goto`, a file `call`, or a call of an author, host, or library function
  anywhere in the loop is a way out, also nested or in a branch that no value takes. So is one in any timer, media, or
  button block of the project, which then silences the warning in every file. Recursion and cycles through several
  labels or files are not checked.

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
- A case value is a literal (text without `${...}`, a number or duration with an optional sign, `true`, `false`, or
  `null`), a declared speaker, or a range with a number literal on each side. A literal or speaker matches when the
  switched value `==` it.
- A range matches a number within its bounds (§6): `1..5` matches `1 <= value < 5` and `1..=5` matches
  `1 <= value <= 5`, including numbers that are not whole, such as `4.5`. A value that is not a number, such as `null`,
  never matches a range.
- A type case, `case is T` or `case is not T`, tests the switched value like `value is T` ([§13](#13-explicit-types)).
  It tests one type; a union covers several, as in `case is integer | string`. A case has either values or a type test.
- When the switched value is a plain variable, it narrows as in an `if`/`else if` chain: the block of `case is T` knows
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
    `5..1` counts down (write `1..5` or `1..=5`);
  - a case value that repeats or overlaps an earlier case value (§6), such as `2` after `2.0` or after `1..5`;
  - a case value whose type can never match the switched value's known type, such as `case "x"` on an `integer`, or a
    range on text.
- Compile warnings: a case that can never match because of what the switched value can hold, such as a type case that
  no value left by the cases above passes, `case 5` after `case is integer`, or `case "maybe"` on a `choose` that only
  returns `"yes"` or `"no"`.

## 33. Browser API: file, folder, camera, and URL references
**Status:** Accepted

File, folder, and camera APIs return engine-managed string references or `null` when cancelled:

```text
let file: string? = chooseFile()
let folder: string? = chooseFolder()
let photo: string? = takePhoto()
let tagged: string? = takePhoto(tags: ["bedroom"])    // joins the image catalog, see §41
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

## 34. Runtime warnings and recoverable values
**Status:** Accepted

Using a possibly null value without an explicit check, where its non-null type is required, is a compile error
([§18](#18-null-and-optional-values)). Commands that accept `null` themselves, such as media commands, still take it;
see the fallback below.

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
let duration: number = load "settings.duration", default: 0
```

A valid number may replace an invalid stored value.

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

## 35. Date, time, durations, and timestamps
**Status:** Accepted (#532). Implemented: `date`, `time`, `datetime`, and `timestamp` values, their conversions,
fields, comparison, arithmetic, presentation, collections, and storage, the current-time getters, calendar durations,
and date and time input ([§20](#date-and-time-input)).

TeaseScript has two kinds of time:

| Type | Meaning |
| --- | --- |
| `date` | A local calendar date without a zone, such as `2026-10-04` |
| `time` | A local clock time without a zone, such as `14:30` |
| `datetime` | A local date and clock time without a zone. It follows the player: tomorrow 18:00 stays 18:00 wherever the player is, also after saving, loading, and travel |
| `timestamp` | A fixed moment in UTC, like Unix time |
| `duration` | Months, calendar days, and exact milliseconds |

Use local values for "what clock time" and "which day", and `timestamp` for "how long ago" and "how much time
passed". Unlike SQL, where `timestamp` names a local value, a TeaseScript `timestamp` is always an exact moment.

### Current values

```text
let today = getDate()
let now = getTime()
let dinner = toDateTime(getDate() + 1 day, toTime("18:00"))
let started = getTimestamp()
```

`getDate()`, `getTime()`, and `getDateTime()` return the player's current local values; `getTimestamp()` returns the
current moment. Within one start or continue, `getTimestamp()` never goes backwards. Local values can: after the
autumn daylight-saving change, or after travelling west. The engine reads no clock and no host time-zone or locale
data: the Player records the player's zone and presentation as session data (see
[`RUNTIME.md`](../RUNTIME.md#date-and-time-context)).

### Construction and conversion

Temporal values are written as strict ISO text with a four-digit year; there are no date literals and no locale
parsing:

```text
toDate("2026-10-04")
toTime("14:30")                         // also "14:30:15" and "14:30:15.250"
toDateTime("2026-10-04T18:00")
toTimestamp("2026-10-04T12:30:00Z")     // also an offset, such as "2026-10-04T14:30:00+02:00"
```

Local text has no offset; timestamp text requires `Z` or an offset. Fractions have one to three digits. Text that is
known at compile time and is not a valid value is a compile error, also when a `default:` is given; other text follows
the [§13](#13-explicit-types) conversion rules.

| Conversion | Converts |
| --- | --- |
| `toDate(value)` | date text, a `date`, or the date of a `datetime` |
| `toTime(value)` | time text, a `time`, or the clock time of a `datetime` |
| `toDateTime(value)` | datetime text or a `datetime` |
| `toDateTime(date, time)` | a `date` and a `time` combined |
| `toTimestamp(value)` | timestamp text or a `timestamp` |

Local values and timestamps convert through the player's current zone:

```text
let deadline = dinner.toTimestamp()
let local = started.toDateTime()
```

A local time that the spring daylight-saving change skips moves forward by the gap; a local time that the autumn
change repeats takes the earlier moment. A `date` or `time` alone cannot become a timestamp.

### Fields

```text
today.year
today.month
today.day
today.weekday           // "Saturday"
today.weekdayNumber     // Monday is 1, Sunday is 7

now.hour
now.minute
now.second
now.millisecond
```

A `datetime` has all of these fields. `weekday` is the English weekday name; comparing it with text that is not an
English weekday name gives a compile warning. Values hold whole milliseconds.

### Durations

| Kind | Units | Meaning |
| --- | --- | --- |
| Exact | `ms`/`millisecond`/`milliseconds`, `s`/`second`/`seconds`, `min`/`minute`/`minutes`, `h`/`hour`/`hours` | Elapsed time; `24 h` is always 24 elapsed hours |
| Calendar | `d`/`day`/`days`, `w`/`week`/`weeks`, `mo`/`month`/`months`, `y`/`year`/`years` | The same local clock time that many days, weeks, months, or years later, never a fixed number of hours |

Both long forms are accepted for any number: `1 seconds` and `2 day`. `m` is not a unit, because it would be ambiguous
between minutes and months. A week is 7 days and a year is 12 months. Adding months or years to a day that the target
month lacks gives that month's last day: January 31 plus one month is February 28, or 29 in a leap year, and
February 29 plus one year is February 28. Months and days are whole after normalizing: `0.5 years` is 6 months, while
`1.5 days`, `1.5 weeks`, and `1 month * 1.5` are errors, at compile time when the values are known. Exact time keeps
fractions.

A duration keeps months, days, and exact time apart, so `1 week == 7 days` but `1 day != 24 h`. Durations order and
divide within one family: exact with exact, days and weeks with days and weeks, months and years with months and years.
`1 week >= 7 days` is true and `18 months / 1 year` is `1.5`; `1 day >= 24 h` and `1 month >= 30 days` are errors. Zero
belongs to every family, and dividing by any zero duration is an error. `duration.days` is the whole number of days of a
duration made only of days and weeks, and `duration.months` the whole number of months of one made only of months and
years: `(getDate() - locked).days`.

`wait`, timers, the `showButton` timeout, media positions and repeat budgets, and assignments to timer and media
`remaining`, `position`, and `repeatDuration` accept exact durations only; a known calendar duration there is a compile
error, and any other one a runtime error.

### Arithmetic and comparison

| Operation | Result |
| --- | --- |
| `date ± calendar duration` | Calendar arithmetic; `date ± exact duration` is an error |
| `datetime ± calendar duration` | The same local clock time that many days, weeks, months, or years later |
| `datetime ± exact duration` | Elapsed time through the player's current zone |
| `timestamp ± exact duration` | Elapsed time; a calendar duration is an error |
| `date - date` | Whole calendar days, such as `5 days` |
| `datetime - datetime` | The elapsed exact duration through the player's current zone |
| `timestamp - timestamp` | The elapsed exact duration |

A composed duration applies its months, then its days, then its exact time; source grouping is preserved. Across the
spring daylight-saving night, `dinner + 24 h` is 19:00 the next day while `dinner + 1 day` is 18:00. Exact time added to
a temporal value is rounded to whole milliseconds, with ties away from zero; `wait` and timers keep fractional
milliseconds. Arithmetic on `time` is not available.

A `date` orders by calendar, a `time` by clock (without wrapping at midnight), a `datetime` by calendar and clock, and a
`timestamp` by moment. `sort()`, `min`, and `max` use the same order for values of one kind. Ordering or arithmetic
across temporal kinds is an error, and `==` between different kinds is `false`. Known invalid combinations are compile
errors; others are runtime errors.

Local comparisons can reverse after the autumn daylight-saving change or after travelling west, and a day counter counts
calendar-date boundaries. `datetime - datetime` measures through the current zone, so `(dinner + 24 h) - dinner` is
`23 h` when `dinner + 24 h` falls in the repeated autumn hour. Measure elapsed time with `timestamp`.

### Display and technical conversion

`say`, `${...}`, and `toString` show every temporal value, including a timestamp, in the player's numeric local form:
date field order, separators, and 12- or 24-hour clock follow the player's locale, such as `4-10-2026, 18:30` in Dutch
and `10/4/2026, 6:30 PM` in US English. The exact punctuation follows the engine's locale data. Seconds appear only when
they are not zero, milliseconds never (`toISO()` keeps them), and no month or weekday names appear. `formatDate()`,
`formatTime()`, and `formatDateTime()` return the same text for part or all of a value. Durations display as `1 h 2 min
3.5 s`.

Inside a list, set, or object, temporal values use a fixed notation: `<date 2026-10-04>`, `<time 14:30>`,
`<datetime 2026-10-04 14:30>`, and `<timestamp 2026-10-04T12:30:00Z>`.

```text
dinner.toISO()             // "2026-10-04T18:00", without an offset
started.toISO()            // "2026-10-04T12:30:00Z", in UTC
started.toSeconds()        // Unix seconds, rounded down
started.toMilliseconds()   // Unix milliseconds
```

There is no construction from a Unix number, because seconds and milliseconds would be ambiguous.

### Collections and storage

Temporal values and durations can be list and set elements; a set compares kind and value. Typed storage keeps each
kind distinct from the others and from text: local values without an offset, timestamps as moments in UTC.

## 36. Scheduling
**Status:** Wanted capability; final syntax, authority, and Player UI deferred

Scheduled events and deadlines target absolute wall-clock moments and may become due while no Player is running.
This differs from [timer and `wait` scene time](#27-timers), which excludes genuine Player unavailability.

Exact event syntax and handles, local/offline versus server-backed authority, recovery, and deadline presentation
require a separate design. The earlier `schedule datetime { ... }` and `cancelSchedule(...)` forms are not accepted
final author syntax. See [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

## 37. Dynamic speaker terms
**Status:** Accepted

Dynamic speaker terms are built-in and custom properties attached to a speaker-compatible character reference. A character may represent a person, a fictional character, a robot, or another entity that can participate in the tease.

The same property model is used for:

```text
player
speaker
mistressVera
cashier
```

- `player` is the fixed built-in reference for the person playing the tease. Use `player`, not `user`.
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
say "Kneel."
say "Good morning, ${player.alias}."
```

Use one explicit speaker for one message:

```text
say as mistressVera "Kneel."
say as mistressVera "You will obey your ${speaker.title}."
```

During the second message, `speaker` resolves to `mistressVera`. `say as` does not change the default speaker after that message.

A speaker can refer to another speaker explicitly:

```text
say as cashier "Please speak to ${mistressVera.shortTitle} ${mistressVera.lastName}."
```

Set the current default speaker with the same `speaker` keyword followed by an existing speaker reference:

```text
speaker mistressVera
```

This does not redeclare the speaker. The parser distinguishes `speaker identifier { ... }` from `speaker identifier` through the following token. The default speaker is session state: it survives `goto`, `end`, and `call`, remains active until changed again, and is cleared by `exit`.

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

The compact `say` form extends the ADR 0018 pacing syntax:

```text
say [as speaker] [bubble(options) | prose(options)] [skippable | unskippable] text [, pacing]
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
properties. The resulting presentation is captured with the message across pacing waits and checkpoint restore.

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

The engine supplies a default list for each player field. The player may customize these account-wide defaults. The
player's settings require at least one name in each list, and the Player and engine validate this where a profile
enters them; no profile input exists yet, so the validation arrives with it. There is no fallback text: a list that a
script empties follows the ordinary empty-list rules.

```text
player.petNames
player.degradingNames
player.lovingNames
```

Interpolation selects one random element according to the list rules:

```text
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

For `player`, account settings are loaded before the script starts. Explicit account terms override gender defaults. Script assignments then override the effective runtime values without silently changing the account. Changing `gender` only supplies values for terms that have not already been explicitly set at the applicable account or script layer.

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
say "${player.strokeRub} your ${player.cockClit}."
say "Keep ${player.strokingRubbing} your ${player.cockClit}."
say "${player.wankRub} your ${player.cockClit}."
say "You ${player.strokedRubbed} a lot today."
say "You ${player.wankedRubbed} earlier."
say "You are my ${player.strokerMasturbator}."
```

The generic words `masturbate`, `masturbating`, and `masturbated` need no dynamic replacement when the same wording is suitable for every player. `strokerMasturbator` follows the same gender-default and explicit-override rules as the other dynamic speaker terms.

### Extensible character state

Speaker-compatible objects are open to script-defined properties. A script may attach counters, scores, flags, collections, or other state to the player or any declared speaker:

```text
player.punishmentPoints = 0
player.monopolyScore = 1500

mistressVera.edgeInstructions = 0
mistressVera.edgeInstructions = mistressVera.edgeInstructions + 1
```

This allows state to remain attached to the character it describes instead of requiring unrelated global variables.

Built-in dynamic terms, name lists, presentation fields, and custom properties may all be changed by the running script.

Custom-property rules:

- The first unconditional assignment declares the property and infers its type.
- A custom property may also be declared directly in a `speaker` property block.
- Reading a property before it has definitely been declared is a compile error.
- A conditionally assigned property is not considered definitely available after the condition unless every path assigns it.
- The inferred or declared property type remains fixed.
- Speaker references compare by identity with `==` and `!=` and may be used as `switch` values.

### Read-only account access

`account` is the built-in read-only reference to the current player's server-backed account view:

```text
let maximum = account.settings.chastity.punishmentMaximum
let toys = account.toys
let hardcoreActive = account.hardcore.active
```

Rules:

- account fields are schema-defined, typed, and available to autocomplete;
- unknown account fields are compile errors;
- direct assignment is forbidden;
- cheat mode may substitute only unlocked values according to the account rules;
- locked values and hardcore state always expose the real server-confirmed state.

```text
account.gender = "female" // compile error
```

Large or filtered history collections use `getPlayerHistory(...)` rather than requiring the complete history to be loaded through one property.

### Account changes

A running script requests a blocking, server-confirmed account change with `askAccountChange(...)`. The player may accept, reject, or allow the request to expire. Supported operation groups are:

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
- `add` appends list values. Duplicate entries are allowed where the account schema permits weighting, such as name lists.
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

A script-specific assignment never silently changes the account. Every account-setting change or lock is an active player decision. The host website shows the consequences, the tease pauses, and the result becomes accepted only after the server has stored it. `askAccountChange(...)` and its accepted operation groups provide this blocking request; the exact result object and some nested account payload fields remain open.

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
    since: getDateTime() - 30 days,
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
and
or
not
set
true
false
null
choose
speaker
say
as
label
goto
call
end
exit
fallback
global
tagged
save
load
delete
is
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
timestamp
duration
list
dict
object
range
media
script
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
toString
toNumber
toInteger
toBoolean
toDate
toTime
toDateTime
toTimestamp
getDate
getTime
getDateTime
getTimestamp
schedule
cancelSchedule
askText
askNumber
askInteger
askBoolean
askDate
askTime
askDateTime
wait
timer
showPermanentButton
removePermanentButton
playAudio
playVideo
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
account
askAccountChange
publishGlobal
getGlobal
loadFromScript
getScriptMetadata
getPlayerHistory
```

This protected list may grow when new engine APIs are added. Editor autocomplete should distinguish grammar keywords, protected built-ins, and user-declared identifiers.

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
```

Accepted:

```text
and
or
not
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
**Status:** Accepted (#536)

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
  check, such as `Dictionary has no key "collar". Check toys.contains(name) first.` A missing key is visible to the
  compiler only for a literal dict, so `dict{ a: 1 }["b"]` is a compile error; for any other dict, check
  `contains(key)` first or read with `get`. `get(key, default: value)` gives `value` for a missing key; its `default:`
  is required and must fit the value type like a value stored in the dict, also when the script runs (`TSR058`), and
  its result has the value type. Like any argument, the default is evaluated before the lookup.
- **Iteration:** `for key in toys` goes through the keys as they were when the loop started
  ([§23](#23-loops)), so changing the dict inside the loop is safe. There is no two-variable `for`.
- **Equality:** two dicts are equal (`==`) when they have the same keys with equal values, in any order. A dict and an
  object are never equal.
- **Text:** `say` shows a dict as `dict{ "collar": "leather collar" }` ([§16](#lists-in-text)). `${toys}` is an error
  that names the fix: select one value with `toys[key]`, or show every value with `toys.values.join()`. A dict is not a
  text field or a `choose` option; it may be a set member ([§16](#16-lists)).
- **Copies and storage:** dicts are copied like lists ([ADR 0014](../decisions/0014-core-runtime-value-semantics.md)),
  and `keys` and `values` are new lists. Storage ([§25](#25-persistent-storage-and-keys)) and checkpoints keep a dict
  with its entry order.
- **Type tests:** `is dict` and `is T dict` test the value; `is T dict` checks every value.

Deferred: keys other than text, merging dicts, a two-variable `for`, and sorted dicts.

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
- `findImages` takes the same parts as named arguments `where:`, `all:`, `none:`, and `any:`, and returns the paths of
  all matching images in path order, as a `string[]`, which may be empty. Without arguments it returns every image.
- `goto tagged`, `call tagged`, and `fallback tagged` pick a file of the project by the tags of its header
  ([File header](#file-header)) and enter it at its top, as `goto (reference)` does
  ([§29](#29-script-files-and-paths)). Every file that runs something is a candidate, `main.tease` and the current
  file too; a file of declarations only runs nothing on its own and is skipped, as for a glob
  ([§29](#29-script-files-and-paths)). The option `from:` limits the candidates to a path or glob written out in quotes, as
  for `goto`; one that names no file that runs something is a compile error. `findScripts` takes `where:`, `all:`,
  `none:`, `any:`, and `from:` as named arguments and returns `script` references to all matching candidates in path
  order, as a `script[]`. A pick, too, chooses among the candidates in path order. A `fallback tagged` picks its file
  when the statement runs.
- Comparison bounds and tag lists are evaluated once, in written order, before any candidate is matched. Matching draws
  no random number. A pick (`showImage tagged`, `goto tagged`, `call tagged`, `fallback tagged`) draws once from the
  session random generator, and restoring a checkpoint never draws again.
- A `goto tagged`, `call tagged`, or `fallback tagged` whose tag tests and literal tag lists match no candidate, within
  its `from:`, is a compile error: every file's header is known when the project compiles. Comparisons and computed lists
  are not evaluated for this.
- When the compilation is given the package images and no file takes photos with tags, a `showImage tagged` whose tag
  tests and literal tag lists match none of them is a compile error; comparisons and computed lists are not evaluated
  for this. Any other pick that finds no image is a runtime error.

### Image tags

- An image's tags are its XMP keywords ([ADR 0023](../decisions/0023-tags-for-scripts-and-images.md)), from its sidecar
  named after the whole file, such as `room.jpg.xmp`, when it has one, and otherwise embedded in the image. A keyword is
  a tag name, or a name and a number such as `punishment: 4`, with the rules of [Tags](#tags). Another keyword is
  ignored with a warning. A repeated tag counts once without a warning, because photo tools often keep `punishment`
  beside `punishment: 4`; two different numbers for one tag are an error.
- The catalog that tag queries search is generated from the images when the project compiles. It is part of the plan,
  so a checkpoint keeps it and a restored session searches the same images.
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
- `showImage <file>` and `hideImage` control the persistent Stage image; `showCamera [stage]` and `hideCamera` show and hide the camera's view; `playAudio` and `playVideo` are blocking by default, `async` returns a handle, and cues use `at`, `beforeEnd`, and `finish` ([§22](#22-stage-image-audio-and-video));
- blur uses `showBlur` and `hideBlur` as a separate non-destructive visual layer;
- drawing uses dedicated shape/text functions and removable references;
- initial layered-scene transitions are `"none"`, `"fade"`, and `"crossfade"` (accepted future direction; not implemented; see [§22](#22-stage-image-audio-and-video));
- `account` is the read-only typed account reference;
- account-change operations include `save`, `add`, `remove`, `removeAll`, `increase`, and `decrease`, while saving `[]` empties a list;
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

- define the account field names for unit system and decimal precision;
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
- finalize the `askAccountChange(...)` result object, especially how server-generated IDs of newly added toys are returned;
- define exact nested payload addressing for changing or disabling one toy by `toyId`;
- finalize the cheat-mode, permissive-mode, and hardcore property names and user-facing labels;
- define the per-setting lock enum, account-level counter-performance flows, owner-release rules, and exact maximum-duration fields;
- decide how scheduled chastity off-windows affect sentence duration in each account mode;
- define exact current-state fields, detailed edge-event fields, duration-session fields, and reconnect/abandoned-session finalization rules;
- define the standard and script-owned hygiene-pause APIs;
- define future speaker-specific LLM context fields.
