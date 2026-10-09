# ADR 0021 — Static types: enforcement, unions, type tests, and narrowing

**Status:** Accepted
**Decision source:** Owner decisions in issues #504 and #536 (dicts) (2026-10-04); §6: Owner decision, 2026-10-07

## Context

V30 accepts inferred and explicit types (§12, §13) and `T?` for values that may be `null` (§18), with the rule "a
variable keeps its declared or inferred type". Nothing enforced that rule, and a value could hold two kinds only
through `T?`. Legacy SexScript packages showed how dynamically typed scripts hide errors on paths their authors never
ran.

The Owner's direction is strict but invisible typing. Beginners never write or check types; the compiler finds every
programming error it can see and explains it in plain language with the concrete fix. Runtime checks cover only values
the compiler cannot know. Experienced authors may opt into union types, type tests, and narrowing.

## Decision

### 1. Every value has one type, and the compiler keeps it

1. A variable, list or set element, dict value, object property, function parameter, and function result each keep one
   type: the declared one, or the type of the first value, which rule 2 widens from `integer` to `number` where no type
   is declared. Storing a value of another type is a compile error that names both types and the fix.
2. `let x = null` without a type takes the type `T?` of the first non-null value later assigned. A different non-null
   type later is an error that names both places. This is the ordinary rule applied to the first real value, not a
   general union inference. A variable without a type annotation (declared by `let`, as a parameter with a default, or
   as a loop variable) whose type is `integer` is likewise inferred from all its assignments: it is a `number` when any
   of them can store a non-whole number, also one checked after its uses. With `let speed = 1` and
   `speed = speed * 1.5`, `speed` is a `number`; with `let count = 0` and `count += 1`, `count` stays an `integer`. The
   elements and properties inside such a variable widen by the same rule: with `let prices = [1, 2]` and
   `prices.add(2.5)`, `prices` is a `number[]`, and `hero.score = 2.5` after `let hero = { score: 0 }` is valid. A
   declared type stays strict, such as `integer`, `integer[]`, or `integer set`, and an integer-only use of a widened
   value, such as a list index, `removeAt`, or a repeat count, is a compile error.
3. An empty list or set takes its element type from the first element added or assigned. A list or set literal has one
   element type: integers and numbers together are numbers, and `null` elements make it optional. Elements of
   different types are an error that points to a declared union such as `(string | number)[]`. The values of a dict
   follow the same rules; the `default:` of `get(key, default: value)` must fit them like a stored value, and the
   result has the value type.
4. An object property keeps the type of its first value. Assignment may still add a property, which then keeps its type.
5. A function's result type comes from its `return` values; returns of different types are an error that names both.
   A function that can end without returning a value has an optional result. Annotated parameters and result types are
   checked. An unannotated parameter with a default takes the default's type by exactly the `let` rule, so
   `times = 1` is an `integer`, unless an assignment in the body widens it by rule 2. Parameters without an annotation or a default stay unknown; a parameter's type is never
   inferred from its call sites, so what a default leaves open stays unknown: `null` gives an unknown type, and `[]` a
   list of elements of unknown type. A returned value of unknown type makes the result unknown; the known returned
   values must still agree.
6. "First" follows the order in which the compiler checks the script: top-level statements in source order, a
   function body when a call first needs its result (otherwise after the top level), then timer and media blocks. A
   body that names a top-level variable declared after that call is checked after the top level, once it has its type;
   until then the call's result is the declared result type, or unknown. The start values of globals and speakers
   (ADR 0022 §6) come before all of this, in the order a session sets them up. A project checks its files one after
   another in project order, `main.tease` first and then the others by path, each in the order above; a global
   function's body is checked when a call in any file first needs its result, otherwise after its own file's top level.
7. A value whose type the compiler cannot know, such as storage under a key without a type (rule 6.2), host data, or an
   unknown parameter, is not rejected at compile time. When it is stored in a place of known type, it is checked at
   runtime with a source-located error.
8. Operations are checked by the same principle: an operator, condition, index, member, or command operand of a known
   type that does not support it is a compile error, because it would fail at runtime. Type checks apply to all code,
   reachable or not. Conditions and the operands of `and`, `or`, and `not` must be `true` or `false`; there is no
   truthiness. A list index is a whole number and a dict key is text; an object, whose properties have fixed names, is
   not indexed. Whether an object has a property is a fact about its value, not its type: a store may add one first, and
   a parameter or a value the compiler cannot know may bring others. Reading a property an object lacks, and a computed
   choice object's missing `text`, other property, or `value` or `background` that its button cannot use, therefore stay
   runtime errors; only a `text` whose known type can never be shown fails at compile time, because it fails whether the
   property is there or missing. A choice object written in the option is checked as written.
9. A possibly null value used where its non-null type is required, such as `n + 1` with `n: integer?`, is a compile
   error whose message names the check, `if n != null { ... }` (owner decision of 2026-10-04 on #504). The check
   narrows the value (rule 5.1). Places and operands that accept `null` themselves still take it.

### 2. Conversions

1. `integer` to `number` is the only implicit type conversion.
2. Literal spelling decides the numeric type: `2` is an `integer`; `2.0`, `.5`, and `1e3` are `number` values.
   Dividing numbers always gives a `number`; a duration divided by a number stays a duration (V30 §35). Storing a
   `number` where an `integer` is required, such as a declared `integer` or an element of a declared `integer[]`, is an
   error that suggests `floor(...)`, `round(...)`, `ceil(...)`, or a `number` declaration; nothing truncates silently. A
   variable without a type annotation, and its elements and properties, widen instead (rule 1.2).
3. A duration needs a unit. Bare numbers count as seconds only in commands that expect a time: `wait`, `timer`, the
   `showButton` timeout, and media positions.
4. Text and numbers, numbers and booleans, and numbers and durations never convert into each other implicitly. Values
   become visible text only in `${...}` and `say`.

### 3. Type syntax and union types

1. A type is a type name, `T[]`, `T set`, `T dict`, `T?`, a union `A | B`, or a parenthesized type. Postfix forms bind
   tighter than `|`: `integer | string[]` is an integer or a list of strings, and `(integer | string)[]` is a list whose
   elements are integers or strings.
2. `T?` is shorthand for `T | null`.
3. Type names: the scalar types `string`, `boolean`, `integer`, `number`, `date`, `time`, `datetime`,
   `absoluteDateTime` (named `timestamp` before ADR 0026), and `duration`;
   `null`; `list`, `set`, `dict`, and `object` for any list, set, dict, or object; and the program-control types
   `range`, `speaker`, `timer`, and `media`.
4. Unions are usable everywhere a type is allowed. The compiler never infers a union; mixing types without a declared
   union stays an error whose message points to the union form.
5. An operation on a union is allowed when every member supports it with a compatible result. Otherwise the error
   names the test the author needs, for example `'reward' may be text (string). Check it first: if reward is integer
   { ... }`.

### 4. Type tests

1. `value is T` tests a value against any type `T` that can follow `let x:`, and `value is not T` is its negation.
   `is` binds like the comparison operators, so `x is integer and x > 3` needs no parentheses. `is` is a protected
   grammar keyword.
2. `x is T` is true exactly when the value may be stored in a place of type `T`, the same check as rule 1.7.
   `is number` is also true for integers. `is integer` means a whole value, including `2.0`, because the runtime does
   not keep the literal spelling. A collection test with an element type checks every element, and `[] is integer[]`
   is true.
3. Tests work on every value, including values whose type the compiler cannot know. The operand is evaluated once and
   the test has no side effects.
4. A right operand that is not a type is an error that explains that `is` checks a type and `==` compares values.
5. The compiler warns about a test that is provably always true or always false, and only then. The same warning
   covers `==` and `!=` with a value that the other side can never hold, such as a `choose` result compared with a
   value no button returns (V30 §19).

### 5. Narrowing

1. After a test, the compiler knows the narrower type in `if`/`else` branches, in the right operand of `and`/`or`, in a
   `while` body, and after an early `return`, `exit`, `break`, or `continue`. `x != null` and `x == null` narrow like
   `x is not null` and `x is null`.
2. An assignment narrows the variable to the assigned value's type: directly after `let reward: integer | string = 10`,
   `reward` is known to be an `integer`.
3. Tests can overlap, because an integer is also a number. An `else` branch keeps only what the test provably excludes.
4. Only plain variables narrow; `door.locked` and `items[0]` do not.
5. A `wait`, an interaction, a function call, or another suspension cancels narrowed facts for every variable that a
   handler or function could change in the meantime, including a local that a block shares and assigns (ADR 0024). A loop condition is tested anew on each iteration, so an
   assignment inside the loop cancels narrowing at its start. A function or handler body does not inherit narrowed
   facts from the code around it.

### 6. Storage keys

1. Every `load` has a `default:`, the value to use while the key holds none. A `load` without one is an error that also
   names `default: null`, which says that the value may be missing.
2. A `load` of a key written as one string literal without `${...}`, also in parentheses, reads the stored value as the
   declared type of the variable it starts or is assigned to, as in `let level: integer | string = load("level",
   default: 1)`, or else as the type another load of the key declares, in any file, function, or handler, reachable or
   not, or else as its default's type. A key is declared once: two loads that declare different types are an error that
   names both. With `default: null`, the result is the key's declared type made optional; without a declared type for
   the key, `default: null` is an error that names the fix. A default of a type the compiler cannot know, without a
   declared type, gives a value of unknown type (rule 1.7), as does a key computed at runtime, such as `"toys.${id}"`,
   `"toys." + id`, or a variable.
3. Loads of a key without a declared type agree on its type: of two load types, one accepts every value of the other,
   as `number` does `integer`, or the later load in checking order is an error that names the earlier one, and its file
   when that is another one. Saves never decide the type.
4. A saved value of known type fits the type of every load of its key, or the save is an error that names the load it
   does not fit. A key that no load reads is not checked.
5. Each `load` checks the stored value against its type when the script runs: stored data can come from an older
   version of the script, a debugging edit, or an import. A value that does not fit is treated as absent for that
   `load`, with a developer warning, and stays stored (V30 §25). A saved value that the compiler cannot know is checked
   when the script runs against the type every load of its key accepts.

## Consequences

- Scripts that mixed types silently are rejected with messages that name the fix; existing examples are corrected. This
  includes values saved under a storage key that its loads do not accept.
- Beginners keep writing untyped scripts. Types and tests appear only when an author opts into unions or needs to check
  external data.
- The instruction plan carries type descriptions for the runtime checks and type tests.
- A `color` type is planned as a separate change.

## Alternatives considered

- Predicate functions such as `isNumber(x)`: one function per type, and no form for `string?`, `integer[]`, or unions.
- `integer or string` for unions: reads as English, but `|` is the form experienced authors expect, and it is a type
  operator rather than a logical one.
- Implicit number-to-text and number-to-duration conversions: fewer errors, but they hide real mixing.
- Requiring a type for `let x = null` and empty lists: explicit, but it makes beginners write types.
- Keeping an inferred `integer` variable an `integer` after its first value: the plain first-value rule, but
  `let speed = 1` followed by `speed = speed * 1.5` would be an error that beginners do not expect.
- Storage keys of unknown type: no new syntax, but every loaded value needs a test or a runtime check, and a key that
  holds an integer in one place and text in another stays hidden until a player reaches it.
- A key declaration, a typed `save`, or a generic `load`: explicit, but new syntax for what a declared variable already
  shows.
- Saves that decide a key's type, with an optional default: no declaration needed, but a save anywhere could change
  what an earlier load returned, which took several checks of the whole project and a guard against a key that holds
  its own loaded value, and a missing value silently became `null`.
- Deleting or converting a stored value that does not fit: keeps storage clean, but destroys data that an older version
  of the script saved and an author may still want to migrate.
- Typing families of computed keys by prefix, such as `"toys.${id}"`: prefixes overlap and computed keys can equal a
  literal key, so a family needs its own explicit form rather than a guessed naming convention.
