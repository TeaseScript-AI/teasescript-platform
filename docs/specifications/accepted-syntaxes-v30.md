# Script Language Syntax Decisions

## Table of contents
This table is generated from the current section order.

- [Status legend](#status-legend)
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
- [22. Foreground and background media](#22-foreground-and-background-media)
- [23. Loops](#23-loops)
- [24. Comments](#24-comments)
- [25. Persistent storage and keys](#25-persistent-storage-and-keys)
- [26. Labels and goto](#26-labels-and-goto)
- [27. Blocking and background timers](#27-blocking-and-background-timers)
- [28. Permanent buttons](#28-permanent-buttons)
- [29. Script files and paths](#29-script-files-and-paths)
- [30. Script endings](#30-script-endings)
- [31. Popups and system notifications](#31-popups-and-system-notifications)
- [32. Switch statements](#32-switch-statements)
- [33. Browser API: file, folder, camera, and URL references](#33-browser-api-file-folder-camera-and-url-references)
- [34. Runtime warnings and recoverable values](#34-runtime-warnings-and-recoverable-values)
- [35. Date, time, durations, and Unix time](#35-date-time-durations-and-unix-time)
- [36. Scheduling](#36-scheduling)
- [37. Dynamic speaker terms](#37-dynamic-speaker-terms)
- [38. Keywords and protected built-ins](#38-keywords-and-protected-built-ins)
- [39. Rejected and reserved syntax](#39-rejected-and-reserved-syntax)
- [Remaining open decisions](#remaining-open-decisions)

## Status legend
- **Accepted**: approved
- **Provisional**: direction chosen, details still open
- **Rejected**: not part of the language

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
- before the closing delimiter of a multiline call, list, or object.

Examples:

```text
let result = calculateDamage(
    player,
    weapon
)

showImage(
    image: photo,
    x: 50,
    y: 50,
    width: 80,
    duration: 10 seconds
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
```

The same calls and objects may remain on one line:

```text
let result = calculateDamage(player, weapon)
showImage(image: photo, x: 50, y: 50, width: 80, duration: 10 seconds)
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

Physical newlines inside an open string token do not terminate the surrounding statement. Their text behavior is defined under [Strings and interpolation](#8-strings-and-interpolation).

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

Division returns a `number` when necessary:

```text
5 / 2 // 2.5
```

### Randomness

All random operations use one deterministic session RNG. This includes list `.random`, automatic visible-text list selection, random ranges, script globs, and the built-in random functions.

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
7. Comparisons `==`, `!=`, `<`, `<=`, `>`, `>=`
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

## 8. Strings and interpolation
**Status:** Accepted

Plain strings use double quotes:

```text
say "The door opens"
```

Template strings use backticks and `${...}`:

```text
say `The ${doorName} opens`
```

`${...}` is not available inside double-quoted strings.

When an eligible list is interpolated into a template string, the engine selects one random element for that evaluation:

```text
let greetings = ["Hello", "Hi", "Welcome"]
say `${greetings}, ${playerName}`
```

This automatic selection is limited to approved visible-text contexts. It is not a general list-to-string conversion. The complete rules are defined under [Lists](#16-lists).

### String escape sequences

Double-quoted strings support these escapes:

```text
\\   // one literal backslash
\"   // one literal double quote
\n    // newline
\r    // carriage return
\t    // tab
```

Example:

```text
let message = "Quote: \"hello\"\nNext line"
```

Template strings support:

```text
\\   // one literal backslash
\`    // one literal backtick
\n    // newline
\r    // carriage return
\t    // tab
\${   // the literal characters ${ without starting interpolation
```

For example:

```text
say `The source text is \${player.name}`
```

This displays the literal text:

```text
The source text is ${player.name}
```

The backslash is an escape marker and is not included in the displayed result. To display an actual backslash, use `\\`.

Unknown escape sequences are compile errors. Inside `${...}`, normal TeaseScript expression parsing applies.

### Physical newlines inside strings

A double-quoted or template string may continue over physical source lines. A physical newline and the indentation surrounding it are folded into one ordinary space in the resulting string:

```text
let message = "This is one long sentence
    written across two source lines."
```

The resulting value is:

```text
This is one long sentence written across two source lines.
```

The same rule applies to template strings:

```text
say `Hello ${player.firstName},
    this sentence continues on the same displayed line.`
```

Use the explicit `\n` escape when the displayed result must contain an actual line break:

```text
let message = "First displayed line\nSecond displayed line"
```

This distinction lets authors wrap long source text for readability without unintentionally changing the visible layout. A physical newline inside an open string does not end the surrounding statement.

## 9. Commands
**Status:** Accepted

Engine-provided commands may omit parentheses and receive one expression:

```text
say "Fixed text"
say `Text with ${playerName}`
say message
say greetings
wait 2
playSound "door.mp3"
```

For `say`, an eligible list expression selects one random text value. Other commands do not gain this behavior unless their API explicitly defines the argument as a visible-text field.

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

Rules:

- Positional arguments fill parameters from left to right.
- Required positional parameters may not be skipped.
- Trailing parameters with defaults may be omitted.
- To skip an earlier parameter while setting a later one, use named arguments.
- Named arguments use `name: value`.
- Positional and named arguments may not be mixed in one call.
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
    say `The ${doorName} opens`
}
```

With explicit parameter types and defaults:

```text
function playClip(file: string, volume: number = 1) {
    playSound file
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
```

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
duration
```

Lists and optional values continue to use `type[]` and `type?`.

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
```

A conversion that cannot succeed raises a runtime error. A caller may provide an explicit fallback:

```text
let amount = toNumber(text, default: 0)
```

When the compiler can prove that a conversion is invalid, it reports a compile error instead:

```text
toNumber("hello") // compile error
```

Values obtained from input, storage, files, network data, or another runtime expression are not known during compilation and are validated at runtime.

`toInteger` discards the fractional part toward zero:

```text
toInteger(2.7)   // 2
toInteger(-2.7)  // -2
```

Use `round`, `floor`, or `ceil` when that rounding intent is required explicitly.

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
items.remove("key")
items.removeFirst()
items.removeLast()
items.clear()
items.sort()
items.contains("map")
```

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

### Automatic random selection in visible text

When a list is used in an approved visible-text context, the engine automatically selects one random element for that evaluation.

Accepted contexts include:

```text
say player.petNames
say `${player.petNames}`
```

Other visible-text fields may opt into the same behavior when their API documentation explicitly says so.

Automatic text selection accepts list elements of these types:

```text
string
integer
number
```

Those types may be mixed in one text-selection list:

```text
let values = [
    "Level",
    2,
    3.5
]

say values
```

A selected `integer` or `number` is converted to text for that visible-text use.

Each evaluation selects again:

```text
say `Good ${player.petNames}`
say `Come closer, ${player.petNames}`
```

The two evaluations may choose different elements. Selection uses the deterministic session RNG, so replay and debugging can reproduce the same session sequence.

To choose a specific element, use its index:

```text
say player.petNames[0]
say `Today I will call you ${player.petNames[1]}`
```

To reuse one random choice, select it explicitly and store the resulting value:

```text
let chosenName = player.petNames.random

say `From now on, you are my ${chosenName}`
say `Come here, ${chosenName}`
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

Automatic random selection is deliberately not a general list-to-string conversion. It does not apply implicitly to paths, storage keys, URLs, media references, resource references, ordinary type inference, or other program-control values:

```text
run scriptPaths
load storageKeys
openUrl(urls)
playVideo videos
```

Those examples require an explicit element or `.random` where the receiving API permits the selected element type.

Automatic visible-text selection also does not accept lists containing:

```text
boolean
null
objects
nested lists
media references
resource references
```

Object lists remain valid, but selection from them must be explicit:

```text
let stranger = speakers.random
```

Runtime behavior:

- An invalid index raises a runtime error rather than returning `null`.
- Automatic visible-text selection from an empty list raises a runtime error because no element can be selected.
- The empty-list error identifies the list expression and explains that the visible-text context requires at least one eligible element.
- `remove(value)` leaves the list unchanged when the value is absent and emits a warning to the developer log.
- Mutating methods change the existing list.
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

The `:` introduces the explicit type; `?` means the value may also be `null`.

Advanced authors may check explicitly:

```text
if file != null {
    playVideo file
}
```

Potentially nullable use without an explicit check follows the compiler-warning and runtime-recovery rules in the next section.

## 19. Choices
**Status:** Accepted

`choose` returns the selected label directly.

Named choices:

```text
let action = choose "What do you do?" {
    open: "Open the door"
    leave: "Walk away"
}
```

The result is the selected label:

```text
if action == "open" {
    openDoor()
}
```

Numeric labels are allowed:

```text
let action = choose "What do you do?" {
    1: "Open the door"
    2: "Walk away"
}
```

When no explicit label is supplied, the visible text itself is returned:

```text
let action = choose "What do you do?" [
    "Open the door",
    "Walk away"
]
```

Rules:

- A choice may use labeled entries or unlabeled entries.
- Labeled and unlabeled entries may not be mixed in one `choose`.
- A labeled choice returns the selected label.
- An unlabeled choice returns the selected visible text.
- `choose` does not return a result object.

## 20. Input functions
**Status:** Accepted

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

`askInteger(...)` only completes when a valid whole number has been entered and returns `integer`.

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

- `askText(...)`, `askTyping(...)`, `askNumber(...)`, `askNumbers(...)`, `askInteger(...)`, `askIntegers(...)`, `askBoolean(...)`, `askBooleans(...)`, `askFile(...)`, `askFiles(...)`, `askFolder(...)`, `askImage(...)`, `askVideo(...)`, and `askAudio(...)` do not return `null`.
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
**Status:** Accepted

`showButton` displays a button and blocks normal script execution until the user clicks it or an optional timeout is reached.

The return value may be ignored:

```text
showButton("Continue")
```

The elapsed waiting time may also be stored:

```text
let elapsed = showButton("Continue")
```

With an optional timeout, positional or named syntax may be used:

```text
showButton("Continue", 5)
```

```text
let elapsed = showButton(
    text: "Continue",
    timeout: 5
)
```

Rules:

- `timeout` is optional.
- Without a timeout, the command waits until the user clicks.
- With a timeout, execution continues after the click or when the timeout is reached.
- The function returns the actual elapsed waiting time.
- If the caller does not need the elapsed time, the return value may be ignored.
- When the timeout is reached, the returned value equals the timeout.
- `showButton` belongs to the core language/runtime API, not specifically to the browser-picker API.

## 22. Foreground and background media
**Status:** Accepted

Foreground media:

```text
playSound "sounds/bell.mp3"
playVideo "videos/scene.mp4"
```

Rules:

- `playSound` waits until the sound finishes.
- `playVideo` waits until the video finishes.
- Only one video may be active at a time.
- Starting a new video automatically stops the currently active video.
- A video identifier is therefore not needed.

Video control:

```text
stopVideo()
```

Background audio continues while the script proceeds and returns an identifier because multiple sounds may play at once:

```text
let soundId = playBackgroundSound("sounds/ambient.mp3")
```

Stop one specific background sound:

```text
stopBackgroundSound(soundId)
```

### Image layers

The visual player has three distinct image roles. The names describe visual purpose rather than file format:

```text
showBackgroundImage backgroundFile
showOverlayImage characterFile
showImage displayFile
```

- `showBackgroundImage` controls the environment or fixed backdrop.
- `showOverlayImage` places one or more characters or scene elements over the backdrop. Transparent source images are expected to be common here.
- `showImage` displays a top-level instructional, object, result, edited, or webcam image above the composed scene.

The background may also be a solid color:

```text
showBackgroundColor "#000000"
```

Background and overlay video use the same role distinction and may be looped:

```text
showBackgroundVideo(backgroundVideo, loop: true)
showOverlayVideo(characterVideo, loop: true)
```

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
- `showImage` is opaque by default, remains above every overlay, and accepts the same `relativeTo`, coordinate, size, anchor, and fit concepts with suitable top-image defaults.

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

#### Top-level displayed images

A top-level `showImage` may have an optional visible duration. It disappears when that duration ends. A non-persistent top-level image also disappears when the current script flow reaches `end` or `exit`.

```text
let displayedPhoto = showImage(
    image: webcamPhoto,
    relativeTo: "viewport",
    x: 50,
    y: 50,
    width: 80,
    height: 80,
    anchor: "center",
    fit: "contain",
    duration: 10 seconds
)
```

`showImage` supports `relativeTo: "background"` when a photo must be positioned inside the scene, such as a webcam image placed into a picture frame. `x`, `y`, `width`, `height`, `anchor`, and `fit` are optional and have centered, aspect-ratio-preserving defaults.

For v1, only one top-level displayed image is active at once. A new `showImage` replaces the previous one. Hide it manually with either form:

```text
hideImage()
hideImage(displayedPhoto)
```

#### Blur, drawings, edited copies, and transitions

Blur is a temporary, non-destructive visual layer. A blur may target:

- the background;
- a specific overlay reference;
- a top-level displayed image;
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

Replacing background, overlay, or displayed media may use:

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
**Status:** Accepted

Save or overwrite a value:

```text
save playerName as "player.name"
```

`save` uses upsert behavior: it creates the key when absent and replaces its value when present.

Every `load` supplies a default:

```text
let playerName = load "player.name" default ""
let score: number = load "player.score" default 0
```

When the key exists, the engine restores the stored TeaseScript type. When the key is absent, the engine stores and returns the default value. An explicit target type may determine the intended numeric type of a literal default, as in the `number` example above.

Delete a value:

```text
delete "player.name"
```

Rules:

- The engine preserves the stored value type; scripts do not serialize every value to plain text manually.
- The physical database representation is an implementation detail and may use typed columns, tagged JSON, or another typed serialization.
- A stored value whose type is incompatible with the receiving explicit type raises a runtime error.
- Storage keys are plain strings.
- Dots and slashes inside a key are naming conventions only.
- The complete string is treated as one key.

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

- Labels are local to the current script.
- `goto` may not jump into a deeper block or function scope.
- Unknown labels are compile errors.
- A `goto` triggered by an event aborts the current execution path and does not return.

## 27. Blocking and background timers
**Status:** Accepted

### Blocking timers

Hidden blocking wait:

```text
wait 10
```

Visible blocking timer:

```text
timer 10
```

Visible blocking timer with a hidden duration:

```text
mysteryTimer 10
```

Ranges may be used for randomized durations:

```text
timer 5..10
mysteryTimer 5..10
```

Range bounds follow the general range rules in this document.

### Background timers

A background timer continues while the main script proceeds. Its block is inherently the finish action, so no `onFinish` wrapper is used:

```text
let timerId = startTimer 30 {
    timeExpired()
}
```

A timer may jump to a label:

```text
let timerId = startTimer 30 {
    goto tooLate
}
```

Stop a timer:

```text
stopTimer(timerId)
```

### Repeating timers

```text
let timerId = startTimer 10 {
    repeat: true
    playBackgroundSound("sounds/bell.mp3")
}
```

A repeating random-range timer chooses a new random duration before each repetition:

```text
let timerId = startTimer 5..10 {
    repeat: true
    playBackgroundSound("sounds/laughter.mp3")
}
```

### Persistent timers

```text
let timerId = startTimer 30 {
    persist: true
    playBackgroundSound("sounds/laughter.mp3")
}
```

Finish-action behavior:

- The timer block runs without pausing currently playing audio or video.
- After a normal finish action completes, the interrupted script continues where it left off.
- The block may call normal functions and start new timers.
- Timer finish actions are processed one at a time.
- A `goto` in the timer block abandons the interrupted execution path.

Cleanup:

- A non-persistent timer is removed on `goto`, `end`, `run`, `call`, or `exit`.
- A persistent timer survives `goto`, `end`, `run`, and `call`.
- Every timer stops on `exit`.

## 28. Permanent buttons
**Status:** Accepted

A permanent button remains available while the script continues and returns an identifier. Its block is inherently the click action, so no `onClick` wrapper is used:

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

Persistent button:

```text
let buttonId = showPermanentButton "Fail" {
    persist: true
    goto retry
}
```

Remove a button explicitly:

```text
removePermanentButton(buttonId)
```

Click and handler behavior:

- The button disappears immediately after it is clicked.
- Its handler runs once.
- Extra clicks are impossible while the handler runs because the button is not visible.
- After a normal function handler finishes, the button returns unless it was explicitly removed.
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

- A non-persistent button is removed on `goto`, `end`, `run`, `call`, or `exit`.
- A persistent button survives `goto`, `end`, `run`, and `call`.
- Every permanent button disappears on `exit`.

## 29. Script files and paths
**Status:** Accepted

Script files use the `.tease` extension. The fixed project entry file is:

```text
main.tease
```

Specific script:

```text
run "punishments/strict.tease"
call "corner-time/short.tease"
```

Random matching script selected through a glob pattern:

```text
run "punishments/*.tease"
call "corner-time/*.tease"
```

Rules:

- `run` abandons the current execution path, starts the selected script, and does not return.
- `call` saves the current location, starts the selected script, and returns to the next statement after the called script reaches `end`.
- A glob that matches no files is a compile or load error.
- The explicit `random` keyword is not used; a glob pattern performs random matching-file selection.
- `goto` only moves within the current file and is not a script-file change.

## 30. Script endings
**Status:** Accepted

Normal end of the current script file:

```text
end
```

Complete end of the active tease/session:

```text
exit
```

Behavior:

- In a script entered through `call`, `end` returns to the caller.
- In a script entered through `run`, `end` returns control to the engine's active script-selection flow, which may select another matching script.
- `exit` terminates the entire active tease/session, including from a called script or function, and never returns.
- A script file may contain multiple reachable `end` or `exit` statements.
- `finish` is not used as an alternative to `end`.

Static analysis should warn, but not necessarily fail compilation, when:

- no reachable `end`, `run`, `goto`, or `exit` exists on a path;
- statements are unreachable;
- an `exit` is declared but unreachable.

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
    case "open" {
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
- Every `case` uses a required block.
- `break` is not used.
- Cases do not fall through.
- `default` is optional.
- Cases may use literal values or ranges.

## 33. Browser API: file, folder, camera, and URL references
**Status:** Accepted

File, folder, and camera APIs return engine-managed string references or `null` when cancelled:

```text
let file: string? = chooseFile()
let folder: string? = chooseFolder()
let photo: string? = takePhoto()
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

## 34. Runtime warnings and recoverable values
**Status:** Accepted

Potentially nullable results produce compiler warnings when used without an explicit check, but they are not automatically hard compile errors.

Example:

```text
let photo = takePhoto()
showImage photo
```

Possible warning:

```text
Warning: `photo` may be null.
Expected: string
Possible value: null
```

Compatible built-ins may apply a safe fallback. For example, `showImage null` may display no image, report that no image is available, record the source location, and continue.

When one replacement value can safely continue execution, the runtime may allow a replacement value to be supplied.

Suitable examples:

### Missing media reference

```text
showImage photo
```

A valid string reference may replace the missing value.

### Invalid number from stored or external data

```text
let duration: number = load "settings.duration" default 0
```

A valid number may replace an invalid stored value.

### Invalid list index

```text
let item = items[99]
```

A replacement value may be supplied for `item`.

### Empty list in visible-text selection

```text
say `${names}`
```

When `names` is empty, execution reports that no eligible text value can be selected. A replacement text value may be supplied when runtime recovery is enabled.

Recovered errors should record:

- script file and source line;
- technical error code;
- expected and received type;
- original value;
- replacement value, when supplied;
- enough execution information to produce an exportable log for the script developer or server.

Recovery is not offered for structural errors such as malformed syntax, unknown functions, invalid labels, or internal engine exceptions. The exact recovery interface and whether recovery is enabled are runtime implementation details, not syntax.

## 35. Date, time, durations, and Unix time
**Status:** Accepted

TeaseScript has separate `date`, `time`, `datetime`, and `duration` types.

Current values:

```text
let today: date = getDate()
let currentTime: time = getTime()
let now: datetime = getDateTime()
```

`getDateTime()` uses the effective player timezone from the account, with the device timezone as a fallback when no account timezone is available.

Available fields include:

```text
today.year
today.month
today.day
today.weekday
today.weekdayNumber

currentTime.hour
currentTime.minute
currentTime.second
currentTime.millisecond

now.year
now.month
now.day
now.hour
now.minute
now.second
now.millisecond
now.weekday
now.weekdayNumber
```

`weekday` returns the English weekday name. `weekdayNumber` uses ISO numbering where Monday is `1` and Sunday is `7`.

### Duration literals

Long and short duration forms are accepted:

```text
500 milliseconds
30 seconds
10 minutes
2 hours
1 day
3 weeks
1 month

500 ms
30 s
10 min
2 h
1 d
3 w
1 mo
```

`m` is not used because it would be ambiguous between minutes and months. Duration units may be combined:

```text
let punishmentDuration = 1 day + 6 hours + 30 minutes
```

Elapsed-time units are exact:

```text
milliseconds
seconds
minutes
hours
```

Calendar units preserve local clock time where possible:

```text
days
weeks
months
```

Consequently, `24 hours` is always exactly 24 elapsed hours, while `1 day` means the same local clock time on the next calendar day and may span 23, 24, or 25 elapsed hours around daylight-saving transitions.

### Arithmetic and comparison

Supported operations:

```text
datetime + duration -> datetime
datetime - duration -> datetime
datetime - datetime -> duration
duration + duration -> duration
duration - duration -> duration
duration * number -> duration
duration / number -> duration
duration / duration -> number
```

Date/time values support `==`, `!=`, `<`, `<=`, `>`, and `>=`. `datetime` comparisons use the represented exact moment.

### Display and technical conversion

In visible text, date/time and duration values are formatted using the player's locale and effective timezone:

```text
say `Your punishment ends ${chastityEnd}.`
say `You still have ${remaining} remaining.`
```

Explicit presentation methods return strings:

```text
chastityEnd.formatDate()
chastityEnd.formatTime()
chastityEnd.formatDateTime()
remaining.format()
```

Technical conversions:

```text
let localIso = chastityEnd.toISO()
let utcIso = chastityEnd.toUTC()
let timestamp = chastityEnd.toSeconds()
let timestampMs = chastityEnd.toMilliseconds()
```

Current Unix time:

```text
let timestamp = getSeconds()
let timestampMs = getMilliseconds()
```

Unix values are integers counted from `1970-01-01T00:00:00Z`.

### Storage

`date`, `time`, `datetime`, and `duration` values use ordinary typed storage. The engine preserves their type, exact moment or duration semantics, and relevant timezone information. The physical UTC, Unix-millisecond, tagged-JSON, or database representation is an implementation detail.


## 36. Scheduling
**Status:** Accepted

`schedule` accepts a `datetime` value. The block itself is inherently the trigger action, so no `onTrigger` wrapper is used:

```text
let releaseTime = getDateTime() + 1 day

let eventId = schedule releaseTime {
    say "Your punishment is over."
}
```

A technical ISO 8601 string is converted to `datetime` before it is scheduled:

```text
let releaseTime = toDateTime("2026-08-01T21:00:00+02:00")

let eventId = schedule releaseTime {
    goto eveningScene
}
```

Rules:

- The value passed to `schedule` must have type `datetime`. Passing a plain string directly is a compile-time type error.
- `toDateTime(...)` may be used for a valid ISO 8601 string with `Z` or an explicit UTC offset when a technical timestamp is required.
- Normal calculated scheduling should use `getDateTime()` plus or minus a `duration`.
- `schedule` returns an event identifier.
- The schedule block runs once when the scheduled moment is reached.
- Scheduled events can be cancelled with `cancelSchedule(eventId)`.
- The runtime stores a stable exact representation before persisting or transmitting a scheduled moment.

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
say `Good morning, ${player.alias}.`
```

Use one explicit speaker for one message:

```text
say as mistressVera "Kneel."
say as mistressVera `You will obey your ${speaker.title}.`
```

During the second message, `speaker` resolves to `mistressVera`. `say as` does not change the default speaker after that message.

A speaker can refer to another speaker explicitly:

```text
say as cashier `Please speak to ${mistressVera.shortTitle} ${mistressVera.lastName}.`
```

Set the current default speaker with the same `speaker` keyword followed by an existing speaker reference:

```text
speaker mistressVera
```

This does not redeclare the speaker. The parser distinguishes `speaker identifier { ... }` from `speaker identifier` through the following token. The default speaker is session state: it survives `goto`, `end`, `run`, and `call`, remains active until changed again, and is cleared by `exit`.

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
- `color` and `font` control that character's text presentation.
- `avatar` is an optional image reference shown beside that character's chat messages.

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

The engine supplies a default list for each player field. The player may customize these account-wide defaults. If a built-in list has nevertheless been emptied, its visible-text fallback is the literal category label: `"pet name"`, `"degrading name"`, or `"loving name"`. This special fallback does not change the general empty-list runtime-error rule for ordinary lists.

```text
player.petNames
player.degradingNames
player.lovingNames
```

In an approved visible-text context, a list automatically returns one random eligible element according to the list rules:

```text
say `Come here, ${player.petNames}.`
say `Good ${player.lovingNames}.`
say `You are such a ${player.degradingNames}.`
```

Every evaluation may select a different element. Use an index for a specific value:

```text
say `Today I will call you ${player.petNames[0]}.`
```

Use `.random` and store the result when the same selection must be reused:

```text
let chosenName = player.petNames.random

say `From now on, you are ${chosenName}.`
say `Come here, ${chosenName}.`
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
say `You are a good ${player.boyGirl}.`
say `${mistressVera.heShe} is waiting for you.`
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
say `Touch your ${player.cockPussy}.`
say `${player.strokeRub} your ${player.cockClit}.`
say `Focus on your ${player.glansClitoris}.`
say `Gently tap your ${player.ballsLabia}.`
say `Pull back your ${player.foreskinClitoralHood}.`
say `Touch your ${player.nippleBreast}.`
say `Keep going until you are ${player.hardWet}.`
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
say `${player.strokeRub} your ${player.cockClit}.`
say `Keep ${player.strokingRubbing} your ${player.cockClit}.`
say `${player.wankRub} your ${player.cockClit}.`
say `You ${player.strokedRubbed} a lot today.`
say `You ${player.wankedRubbed} earlier.`
say `You are my ${player.strokerMasturbator}.`
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
true
false
null
choose
speaker
say
as
label
goto
run
call
end
exit
save
load
delete
```

The same keyword may have more than one grammar form when the next token makes the form unambiguous. For example, `speaker identifier { ... }` declares a speaker, while `speaker identifier` sets the default speaker. A parser distinguishes these forms through normal lookahead; this is not an implementation problem.

### Protected type names

```text
string
boolean
integer
number
date
time
datetime
duration
```

### Protected engine names

Every built-in command, function, and contextual engine reference documented by this specification is protected and may not be redeclared by a script. Examples include:

```text
player
random
randomInteger
chance
toString
toNumber
toInteger
toBoolean
toDate
toTime
toDateTime
getDate
getTime
getDateTime
getSeconds
getMilliseconds
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
mysteryTimer
startTimer
stopTimer
showPermanentButton
removePermanentButton
playSound
playVideo
playBackgroundSound
stopBackgroundSound
showBackgroundColor
showBackgroundImage
showBackgroundVideo
showOverlayImage
showOverlayVideo
showImage
moveOverlay
animateOverlay
hideOverlay
hideImage
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

They are not currently executable syntax. Existing specific controls such as `stopVideo()`, `stopTimer(...)`, and `stopBackgroundSound(...)` remain valid.

### Reserved for later design

`available when` is reserved for future requirements or suitability metadata and is not executable syntax.

## Remaining open decisions
The accepted core syntax is consolidated in this document. Remaining work is primarily detailed API payloads and engine/account behavior.

Resolved in this revision:

- unit literals accept documented abbreviations and full names with a required separating space;
- visible measurements use account-preferred unit systems, automatic readable scaling, an account decimal preference defaulting to two places, and per-call `format(unit: ..., decimals: ...)` overrides;
- `relativeTo: "background" | "viewport"`, background `fit: "contain" | "cover" | "stretch"`, and `"contain"` as the default are accepted;
- overlays use `hideOverlay`, asynchronous `moveOverlay` and `animateOverlay`, optional blocking behavior, and keyframe hold durations;
- `showImage` supports coordinates, dimensions, reference space, fit, duration, and `hideImage`; one top-level displayed image is active at a time in v1;
- blur uses `showBlur` and `hideBlur` as a separate non-destructive visual layer;
- drawing uses dedicated shape/text functions and removable references;
- initial media transitions are `"none"`, `"fade"`, and `"crossfade"`;
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
- double-quoted and template-string escape sequences are defined, including `\${` for literal template interpolation text;
- exact unit abbreviations, full names, singular forms, plural forms, capitalization, and multi-word matching are defined.

Open language and runtime decisions:

Parser-POC grammar blockers:

- none currently identified; statement separation, multiline continuation, identifiers, numeric literals, precedence, string escapes, and unit tokens are now defined.

Other open API and runtime decisions:

- define the account field names for unit system and decimal precision;
- decide whether an explicit unit-conversion method such as `measurement.to("km")` is needed in addition to presentation-only `format(...)`;
- define background alignment/position values when `contain` or `cover` leaves or crops edges;
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
- decide the technical fallback when a speaker has no `displayName` and all of `title`, `firstName`, and `lastName` are empty;
- define the initial string-method library and future speaker-specific LLM context fields.
