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

## Delimiter roles
**Status:** Accepted

The existing accepted forms use these delimiter pairs consistently. This section records that convention; it does not
add a new grammar form.

- `()` — expression grouping and call/parameter lists: grouped expressions, function-call arguments, and function
  parameter lists.
- `[]` — list syntax and positional access: list literals, list type suffixes such as `string[]`, and indexing.
- `{}` — structured bodies and records: executable or declaration blocks, speaker property blocks, and object
  literals.
- `${...}` — the reserved template-interpolation form. It is distinct from an ordinary `{}` structured body; normal
  TeaseScript expression parsing applies inside.

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
let score = baseScore + bonus * 2
let remaining = total - penalty
let ratio = current / maximum
let remainder = index % 4
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

When a list of eligible values is used in an approved visible-text context, the engine selects one element automatically using the deterministic session RNG.

Accepted in direct `say`:

```text
let greetings = ["Hello", "Hi", "Welcome"]
say greetings
```

Accepted in template interpolation:

```text
let greetings = ["Hello", "Hi", "Welcome"]
say `The greeting is ${greetings}`
```

Accepted as a direct named argument of a Standard Library function when that argument is explicitly declared as a visible-text field:

```text
showButton(
    text: greetings,
    color: "red"
)
```

These cases perform one random selection for that visible-text evaluation. The selected value participates in the normal deterministic RNG sequence and is preserved by checkpoint restore.

A normal function call does not automatically select from a list unless that parameter is defined by the engine or Standard Library as a visible-text field.

```text
calculateDamage(greetings) // passes the list itself, subject to normal type checking
```

The `.random` property performs explicit selection in any context:

```text
let greeting = greetings.random
```

Selection from an empty list is a runtime error when the list can be empty only at runtime. If the compiler can prove that a list literal is empty in a visible-text selection, it reports a compile error instead.

## 17. Return statements
**Status:** Accepted

Functions return a value with `return`:

```text
function calculateDamage(base: number, bonus: number = 0) {
    return base + bonus
}
```

A function may also return without a value:

```text
function logDoorState {
    say "Door checked"
    return
}
```

Rules:

- `return` exits the current function immediately.
- `return` without a value returns no value.
- Functions that return a value must return a compatible type on every reachable path.
- `return` is not valid at the top level.

## 18. Null and optional values
**Status:** Accepted

Use `null` for an absent value.

Optional values use `?` after the type:

```text
let selectedImage: string? = null
```

Rules:

- `null` is not an empty string, zero, or false.
- A non-optional value may not receive `null`.
- An optional value may be checked with normal comparisons.

```text
if selectedImage != null {
    showImage(selectedImage)
}
```

## 19. Choices
**Status:** Accepted

`choose` presents a blocking choice and returns the selected option value.

```text
let choice = choose(
    "Continue",
    "Stop"
)
```

Named choice values are allowed:

```text
let choice = choose(
    continue: "Continue",
    stop: "Stop"
)
```

Rules:

- `choose` is an expression and may be assigned, returned, or passed as an argument.
- It blocks normal execution until a choice is made.
- Named choice values use `name: value`.
- All choices in one call must use the same value type.
- The result is the selected value, not the visible label.

## 20. Input functions
**Status:** Accepted

### Text input

```text
let name = askText("What is your name?")
```

`askText(...)` blocks until a valid string is entered.

### Controlled typing

`askTyping(...)` shows a prompt and a text field while optionally restricting editing behavior.

```text
let answer = askTyping(
    prompt: "Type the sentence exactly.",
    expected: "Yes, Mistress.",
    strict: true,
    scope: "field"
)
```

Parameters:

- `prompt`: visible prompt text.
- `expected`: optional exact expected value.
- `strict`: when `true`, the input completes only when it matches `expected` exactly.
- `scope`: `"field"` or `"teasePlayer"`; the default is `"field"`.
- `allowSelection`: default `true`.
- `allowCopy`: default `true`.
- `allowCut`: default `true`.
- `allowPaste`: default `true`.
- `allowUndo`: default `true`.
- `allowRedo`: default `true`.
- `allowAutocomplete`: default `true`.
- `allowAutocorrect`: default `true`.
- `allowSpellcheck`: default `true`.

When `scope: "field"`, the restrictions apply only to that text field.

With `scope: "teasePlayer"`, applicable restrictions such as selection, copy, cut, paste, undo, redo, autocomplete, autocorrect, and spellcheck apply to the entire script iframe.

When `scope: "teasePlayer"`, the same restrictions apply to the complete script-controlled player surface: standard UI, package HTML, DOM content, canvas interactions, and later script UI inside the sandboxed player iframe. The parent community site, forum, and account pages remain unaffected.

### Number input

```text
let amount = askNumber("Enter an amount")
```

### Multiple number inputs

```text
let values = askNumbers(
    prompts: ["First number", "Second number"],
    min: 0,
    max: 100
)
```

### Integer input

```text
let count = askInteger("Enter a whole number")
```

### Multiple integer inputs

```text
let values = askIntegers(
    prompts: ["First count", "Second count"],
    min: 0,
    max: 10
)
```

### Boolean input

```text
let confirmed = askBoolean("Continue?")
```

### Multiple boolean choices

```text
let answers = askBooleans(
    prompts: ["Question one", "Question two"]
)
```

### Date and time input

```text
let date = askDate("Choose a date")
let time = askTime("Choose a time")
let moment = askDateTime("Choose date and time")
```

These inputs use structured date and time controls and do not return unparsed free text. Like the other blocking `ask...` functions, they only complete with a valid value.

### File input

```text
let file = askFile(
    prompt: "Choose a file",
    accept: ["image/*", ".pdf"]
)
```

### Multiple file input

```text
let files = askFiles(
    prompt: "Choose files",
    accept: ["image/*"],
    maxFiles: 5
)
```

### Folder input

```text
let folder = askFolder("Choose a folder")
```

### Image input

```text
let image = askImage(
    prompt: "Take or choose a picture",
    allowCamera: true,
    allowFile: true
)
```

### Video input

```text
let video = askVideo(
    prompt: "Record or choose a video",
    allowCamera: true,
    allowFile: true
)
```

### Audio input

```text
let audio = askAudio(
    prompt: "Record or choose audio",
    allowMicrophone: true,
    allowFile: true
)
```

### Invalid input handling

Input functions do not return invalid values. Validation failure keeps the input request active and displays an error.

### General input rules

- `askText(...)`, `askTyping(...)`, `askNumber(...)`, `askNumbers(...)`, `askInteger(...)`, `askIntegers(...)`, `askBoolean(...)`, `askBooleans(...)`, `askFile(...)`, `askFiles(...)`, `askFolder(...)`, `askImage(...)`, `askVideo(...)`, and `askAudio(...)` do not return `null`.
- Cancel behavior is not silently converted into a valid result.
- File and media results are engine-managed string references.
- Validation happens before the blocking request completes.
- `chooseFile()` and `askFile(...)` are different functions: `chooseFile()` is a general browser picker, while `askFile(...)` is a blocking user-input request.
- `askImage(...)` defaults to `allowCamera: true` and `allowFile: true`.
- `askVideo(...)` defaults to `allowCamera: true` and `allowFile: true`.
- `askAudio(...)` defaults to `allowMicrophone: true` and `allowFile: true`.

## 21. Blocking button
**Status:** Accepted

`showButton` displays a button and blocks normal script execution until the user clicks it or an optional timeout is reached.

The return value may be ignored:

```text
showButton "Continue"
```

Or stored:

```text
let result = showButton(
    text: "Continue",
    timeout: 30 seconds
)
```

With a timeout, the result may represent either the click or timeout outcome according to the Standard Library contract.

## 22. Foreground and background media
**Status:** Accepted

Foreground media blocks normal script execution:

```text
playVideo("intro.mp4")
```

Background media does not block:

```text
playBackgroundSound("rain.mp3")
showBackgroundImage("room.jpg")
```

### Image layers

Backdrop:

```text
showBackgroundImage(
    image: "room.jpg",
    fit: "cover"
)
```

Overlay:

```text
let overlay = showOverlayImage(
    image: "person.png",
    x: 50,
    y: 50,
    width: 40,
    anchor: "center"
)
```

Top-level displayed image:

```text
showImage(
    image: "card.jpg",
    x: 50,
    y: 50,
    width: 80,
    duration: 10 seconds
)
```

#### Scene coordinate space

Image and drawing coordinates use percentages of the selected reference space.

- `relativeTo: "background"` uses the backdrop's logical coordinate system.
- `relativeTo: "viewport"` uses the visible player viewport.
- Coordinates are not restricted to `0..100`; values such as `-10` or `110` may intentionally move part of an image outside the visible scene.
- Width and height are percentages of the selected reference dimension unless an API documents another unit.
- Background fit accepts `"contain"`, `"cover"`, or `"stretch"`. The default is `"contain"`; cropping occurs only when `"cover"` is selected.
- `showImage` is opaque by default, remains above every overlay, and accepts the same `relativeTo`, coordinate, size, anchor, and fit concepts with suitable top-image defaults.

#### Multiple overlays and movement

Overlays may coexist. `showOverlayImage(...)` returns a reference that can be moved, animated, or hidden.

```text
let left = showOverlayImage(
    image: "left.png",
    x: 25,
    y: 50,
    anchor: "center"
)

let right = showOverlayImage(
    image: "right.png",
    x: 75,
    y: 50,
    anchor: "center"
)
```

Move one overlay:

```text
moveOverlay(
    overlay: left,
    x: 50,
    y: 50,
    duration: 2 seconds
)
```

Set `blocking: true` when the script must wait for the movement to finish. Longer paths use timed keyframes. `hold` keeps the overlay at a keyframe before the next movement begins:

```text
animateOverlay(
    overlay: left,
    keyframes: [
        { x: 20, y: 50, duration: 1 second },
        { x: 50, y: 35, duration: 2 seconds, hold: 500 milliseconds },
        { x: 80, y: 50, duration: 1 second }
    ]
)
```

`animateOverlay(...)` is asynchronous by default and also accepts `blocking: true`.

Hide overlays without destroying their references:

```text
hideOverlay(left)
```

#### Top-level displayed images

`showImage(...)` maintains one active top-level displayed image in v1.

```text
showImage(image: "instruction.jpg", width: 75)
```

Calling `showImage(...)` again replaces the current top-level image. Use `hideImage()` to remove it.

#### Blur, drawings, edited copies, and transitions

Blur is a separate visual layer:

```text
showBlur(8)
hideBlur()
```

Drawing functions create removable drawing references:

```text
let box = drawRectangle(
    x: 10,
    y: 10,
    width: 20,
    height: 20,
    color: "red"
)

removeDrawing(box)
```

Edited copies preserve a link to their original source reference; the exact export API remains open.

Initial media transitions are:

```text
"none"
"fade"
"crossfade"
```

## 23. Loops
**Status:** Accepted

Repeat a fixed number of times:

```text
repeat 5 {
    say "Again"
}
```

Iterate a list:

```text
for item in items {
    say item
}
```

Conditional loop:

```text
while energy > 0 {
    say energy
    energy = energy - 1
}
```

Rules:

- `break` exits the nearest loop.
- `continue` skips to the next iteration.
- Loop variables use lexical block scope.

## 24. Comments
**Status:** Accepted

Single-line comments use `//`:

```text
// this is a comment
say "Hello" // inline comment
```

Block comments are not part of the initial syntax.

## 25. Persistent storage and keys
**Status:** Accepted

Persistent storage uses engine functions rather than special assignment syntax.

```text
save("score", score)
let score = load("score", default: 0)
delete("score")
```

Keys are strings. Storage is scoped according to the API contract.

## 26. Labels and goto
**Status:** Accepted

```text
label retry
say "Try again"
goto retry
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
wait 5 seconds
```

Visible blocking timer:

```text
timer 30 seconds {
    say "Time is up"
}
```

Visible blocking timer with a hidden duration:

```text
mysteryTimer 10..20 seconds {
    say "Done"
}
```

### Background timers

A background timer continues while the main script proceeds. Its block is inherently the finish action, so no `onFinish` wrapper is used:

```text
let timerId = startTimer(10 seconds) {
    say "Background timer finished"
}
```

Stop it before completion:

```text
stopTimer(timerId)
```

### Repeating timers

```text
let timerId = startTimer(
    delay: 5 seconds,
    repeat: 3
) {
    say "Tick"
}
```

### Persistent timers

Persistent timers survive script boundaries according to the runtime contract.

Finish-action behavior:

- The timer block runs without pausing currently playing audio or video.
- After a normal finish action completes, the interrupted script continues where it left off.
- The block may call normal functions and start new timers.
- A `goto` in the timer block abandons the interrupted execution path.

Cleanup:

- Timer identifiers are engine-managed.
- Completed timers are removed automatically.
- Stopped timers do not run their finish block.

## 28. Permanent buttons
**Status:** Accepted

A permanent button remains available while the script continues and returns an identifier. Its block is inherently the click action, so no `onClick` wrapper is used:

```text
let buttonId = showPermanentButton("Punish me") {
    say "You asked for it"
}
```

Remove it later:

```text
removePermanentButton(buttonId)
```

## 29. Script files and paths
**Status:** Accepted

The package entry point is:

```text
main.tease
```

Other `.tease` files may be called or run by path.

```text
call "chapters/intro.tease"
run "scenes/*.tease"
```

Paths are package-relative and use `/` as separator.

Glob patterns are supported where documented by the runtime. Selection from multiple matches uses the deterministic session RNG.

## 30. Script endings
**Status:** Accepted

`end` ends the current script file and returns according to how that file was entered.

`exit` ends the complete current tease session.

Rules:

- In a script entered through `call`, `end` returns to the next statement after the `call`.
- In a script entered through `run`, `end` returns control to the engine's active script-selection flow, which may select another matching script.
- In `main.tease`, `end` has the same effect as reaching the natural end of the entry script.
- `exit` ends the entire session regardless of the current script nesting.

## 31. Popups and system notifications
**Status:** Accepted

### Popup

A popup blocks until the user closes it.

Default button text:

```text
popup("Message")
```

Custom button text:

```text
popup(
    message: "Message",
    button: "Continue"
)
```

### System notification

```text
notify("Your timer is done")
```

Notifications do not block the script.

## 32. Switch statements
**Status:** Accepted

```text
switch score {
    case 0 {
        say "Zero"
    }
    case 1..5 {
        say "Small"
    }
    default {
        say "Other"
    }
}
```

Rules:

- Parentheses around the switched expression are optional.
- Every `case` uses a required block.
- `break` is not used.
- Cases do not fall through.

## 33. Browser API: file, folder, camera, and URL references
**Status:** Accepted

Browser-facing APIs return engine-managed string references rather than live DOM or browser objects.

Examples:

```text
let file = chooseFile()
let folder = chooseFolder()
let photo = takePhoto()
let image = loadImageFromUrl("https://example.com/image.jpg")
```

These references may be passed to engine media functions.

## 34. Runtime warnings and recoverable values
**Status:** Accepted

Some runtime situations produce warnings or recoverable results rather than terminating the complete tease.

### Missing media reference

A missing media reference produces a warning and returns a recoverable failure result where the API defines one.

### Invalid number from stored or external data

Conversion functions validate at runtime and may raise a runtime error or use an explicit fallback.

### Invalid list index

Indexing outside the valid range is a runtime error.

### Empty list in visible-text selection

Selecting visible text from an empty list is a runtime error unless the compiler can prove the empty list earlier.

## 35. Date, time, durations, and Unix time
**Status:** Accepted

`date`, `time`, `datetime`, and `duration` are built-in types.

### Duration literals

```text
5 seconds
2 minutes
1 hour
```

### Arithmetic and comparison

Dates and times support the documented arithmetic with durations.

### Display and technical conversion

Formatting is presentation-only. Technical conversion uses explicit functions.

### Storage

Persistent values use stable exact representations defined by the runtime/data contract.

## 36. Scheduling
**Status:** Accepted

`schedule` accepts a `datetime` value. The block itself is inherently the trigger action, so no `onTrigger` wrapper is used:

```text
let eventId = schedule(getDateTime() + 1 hour) {
    say "Scheduled action"
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

### Speaker declaration and `say as`

Declare a speaker with an identifier and a property block:

```text
speaker mistressVera {
    firstName: "Vera"
    lastName: "Black"
    title: "Mistress"
}
```

Use that speaker for one line:

```text
say as mistressVera "Kneel."
```

Set the current default speaker:

```text
speaker mistressVera
```

The parser distinguishes declaration from setter by the following `{`.

### Names, titles, and presentation

Speaker properties control display and language terms.

### Name lists

List-valued speaker properties use normal list syntax.

### Gender defaults and overrides

Gender selects default terms but may be overridden.

### Anatomical and arousal terms

The speaker/player model exposes configurable language terms.

### Dynamic action terms

Action terminology may be configured through speaker/player state.

### Extensible character state

Speaker-compatible objects may hold script-defined properties.

### Read-only account access

`account` exposes typed read-only account data.

### Account changes

`askAccountChange(...)` requests host-confirmed account mutations.

### Script-global and cross-script data

Global and cross-script APIs use engine-managed persistence.

### Runtime, script, and account persistence

Runtime state, script storage, and account state remain distinct layers.

### Preference ratings

Preference values use account-defined scales and APIs.

### Cheat mode, permissive mode, and hardcore mode

Account modes affect what values may be exposed or changed.

### Account locks and configured ranges

Locks are server-confirmed account constraints.

### Account-backed toys, state, history, and statistics

Toys, active states, history, and aggregate statistics are account-backed domains.

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
