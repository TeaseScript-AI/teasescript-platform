# ADR 0021 — Static types: enforcement, unions, type tests, and narrowing

**Status:** Accepted
**Decision source:** Owner decisions in issues #504 and #536 (dicts) (2026-10-04); §6: Owner decision, 2026-10-07; the
rules for the new type checker (O4): Owner decisions of 2026-10-19, 2026-10-20, and 2026-10-21

The current compiler and runtime still apply the rules this file held before the O4 decisions until the compiler
switches to the new type checker, as V30's transition note says.

## Context

V30 accepts inferred and explicit types (§12, §13) and `T?` for values that may be `null` (§18), with the rule "a
variable keeps its declared or inferred type". Nothing enforced that rule, and a value could hold two kinds only
through `T?`. Legacy SexScript packages showed how dynamically typed scripts hide errors on paths their authors never
ran.

The Owner's direction is strict but invisible typing. Beginners never write or check types; the compiler finds every
programming error it can see and explains it in plain language with the concrete fix. Runtime checks cover only values
the compiler cannot know. Experienced authors may opt into union types, type tests, and narrowing.

In October 2026 the Owner simplified the rules for a new type checker: object properties come from their literal, no
union holds a whole collection, a fallback has the type it stands in for, each place keeps the type its earliest value
in source order settles, whatever order the checker meets the code in, and the compiler gives an error only where it
can simply prove one, and otherwise a warning with a check when the script runs.

## Decision

### 1. Every value has one type, and the compiler keeps it

1. A variable, list or set element, dict value, object property, function parameter, and function result each keep one
   type: the written one, or else the type its declaration's start value settles, or else that of the earliest value
   stored into it in source order (rule 1.6). `null`, a value the compiler cannot know, and the elements of an empty
   collection settle nothing. Rule 2 widens an `integer` to a `number` where no type is written. Storing a value of
   another type is a compile error at that store that names the line that decided the type and suggests a written
   union. The compiler ignores the rejected value, so later uses are checked against the decided type and one mistake
   gives one error. The decided type holds wherever the place is used, also before the value that decided it, and a
   read inside an expression sees the value at that point of evaluation, as the runtime does.
2. `let x = null` without a type takes the type `T?` of the earliest non-null value stored into it. A different non-null
   type is an error that names both places. This is the ordinary rule applied to the first real value, not a general
   union inference. Storing `null` later also makes a place optional: after `let count = 1`, `count = null` makes
   `count` an `integer?`. A variable without a type annotation (declared by `let` or as a loop variable) whose type is
   `integer` is likewise inferred from all its assignments: it is a `number` when any of them can store a non-whole
   number, wherever that assignment is. With `let speed = 1` and `speed = speed * 1.5`, `speed` is a `number`; with
   `let count = 0` and `count += 1`, `count` stays an `integer`. The elements and properties inside such a variable
   widen by the same rule: with `let prices = [1, 2]` and `prices.add(2.5)`, `prices` is a `number[]`, and
   `hero.score = 2.5` after `let hero = { score: 0 }` is valid. A declared type stays strict, such as `integer`,
   `integer[]`, or `integer set`. A read sees what the variable holds at that point: after `let i = 0`, `items[i]`
   before `i = i / 2` is valid, because `i` can have received only whole numbers there. A value that may not be whole
   and reaches an integer-only use, such as a list index, a `removeAt` position, or a repeat count, on every run is a
   compile error; where only a particular run brings it there, such as one arm of an `askBoolean` or a later round of
   a loop, the use is warned and the value checked when the script runs (rule 1.10).
3. An empty list or set takes its element type from the earliest element added or assigned. A list or set literal has
   one element type: integers and numbers together are numbers, and `null` elements make it optional. Elements of
   different types are an error that points to a declared union such as `(string | number)[]`, and the earliest
   element's type counts for later uses. The values of a dict follow the same rules. A copy is a new value:
   `let b = a` starts with what `a` holds at that moment, so a copy of a list with elements carries their type, and
   then takes its type from its own stores; a copy of a variable with a written type keeps that type (V30 §12).
4. An object property behaves like a variable: the object literal declares it once with a start value, and it keeps a
   type by rule 1.1. Storing a property that the literal lacks is a compile error that points to the literal, or to a
   dict for names known only when the script runs; `null` in the literal means "not known yet". Objects with different
   property names may share a place, such as the elements of one list; the properties they share have one type, and a
   store never adds a property. The compiler keeps, per property, whether it is certainly or only maybe present.
   Speakers keep their own rule (V30 §37). Fixed names give every property a type from its literal, as a declaration
   gives a variable one, and turn a misspelt property into an error at the store.
5. A function's result type comes from its `return` values by rule 1.1, also through a recursive call; a return of
   another type is an error that names both. A function that can end without returning a value has an optional
   result. Annotated parameters and result types, written `function f(x: T): R`, are checked. A parameter without an
   annotation needs no type, also when it has a default: the compiler works out once, from the body, what the function
   requires of it, returns, and changes, and checks every call against that. Each call types the parameter from its
   argument, a `null` argument included, so `shake(0.5)` is valid for `function shake(times = 1)`; calls are never
   combined into one parameter type. A default is only the value used for an omitted argument, and it is checked once,
   at the function. Where the compiler cannot show that a call fits, the value is checked when the script runs. A
   returned value of unknown type makes the result unknown; the known returned values must still agree.
6. "Earliest" is source order: the files in project order, `main.tease` first and then the others by path, each from
   top to bottom, wherever the store is, also in a function body or a timer, media, or button block. A declaration's
   start value comes before every other store into its place. Source order, never the order in which the compiler
   meets the stores, decides, so the result is the same for every checking order.
7. A value whose type the compiler cannot know, such as storage under a key without a type (rule 6.2) or host data,
   decides nothing and is not rejected at compile time. When it is stored in a place of known type, it is checked at
   runtime with a source-located error. A place with a written type, or a type decided earlier in the source, still
   rejects at compile time a value none of whose possible types fits, as in `let y: string = x / 4`; where only a later
   value decides the type, the compiler warns and the value is checked when it runs. The same holds for a store whose
   value comes from a function that reads a part of the same place that no earlier value decided, and the warning
   advises a written type on the place, one type or a union. Read directly in the stored value, the part is read as
   it is before the store (rule 1.1).
8. Operations are checked by the same principle: an operator, condition, index, member, or command operand of a known
   type that does not support it is a compile error, because it would fail at runtime. Type checks apply to all code,
   reachable or not. Conditions and the operands of `and`, `or`, and `not` must be `true` or `false`; there is no
   truthiness. A list index is a whole number and a dict key is text; an object, whose properties have fixed names, is
   not indexed. Reading or storing a property that no object in its place has is a compile error that names the
   properties it can have (rule 1.4). A read or store that may reach an object without that property, or an object the
   compiler cannot know, such as stored data or an `object`, is checked when the script runs, and so are a computed
   choice object's missing `text`, other property, or
   `value` or `background` that its button cannot use; only a `text` whose known type can never be shown fails at
   compile time, because it fails whether the property is there or missing. A choice object written in
   the option is checked as written.
9. A possibly null value used where its non-null type is required, such as `n + 1` with `n: integer?`, is a compile
   error whose message names the check, `if n != null { ... }` (owner decision of 2026-10-04 on #504). The check
   narrows the value (rule 5.1). Places and operands that accept `null` themselves still take it.
10. Valid code always compiles: a compile error names a violation of a syntax, type, or required-check rule. Where the
    compiler cannot prove at reasonable cost that a written check still holds, or a check is impractical at compile
    time, the check moves to the runtime, and the compiler warns at that place, saying how to let the compiler check it
    now. The compiler gives an exact answer, an error or acceptance without a warning, only where it has a simple
    proof, and warns everywhere else, so it never gives a false error and never accepts silently: an error means that
    the code is certainly wrong, and a warning that it may go wrong. A run that makes a value unfit for a later use is
    an error only where the run can really happen and the compiler proves it simply, as when every run that reaches the
    use makes the value unfit; a failure that needs a particular answer, a button pressed during a `wait`, or a later
    round of a loop, or that depends on conditions that exclude each other, is warned. The required-check rules stay:
    a use that needs a check and has none on some route is an error (rules 1.9 and 5.6).
    The temporary work budget follows this rule: a place over it, and the checks that need what it would have found, are
    checked when the script runs, with a warning there; every other use, also of the same variable or function, stays
    checked at compile time, and a known violation stays an error. A limit of the compiler is thus never reported as
    the author's mistake. The compiler never hangs: only a shape that is very unrealistic for a real script, now or in
    the future, stops with a compile error at the compiler's limit, which leaves generous room above realistic
    scripts.

### 2. Conversions

1. `integer` to `number` is the only implicit type conversion.
2. Literal spelling decides the numeric type: `2` is an `integer`; `2.0`, `.5`, and `1e3` are `number` values.
   Dividing numbers always gives a `number`; a duration divided by a number stays a duration (V30 §35). Storing a
   `number` where an `integer` is required, such as a declared `integer` or an element of a declared `integer[]`, is an
   error that suggests `floor(...)`, `round(...)`, `ceil(...)`, or a `number` declaration; nothing truncates silently. A
   variable without a type annotation, and its elements and properties, widen instead (rule 1.2).
3. A duration needs a unit, also where a command expects a time: `wait 5`, `timer 10`, `timeout: 30`, `say "x", 3`, and
   a number as a media position are compile errors that name the fix
   ([ADR 0026](0026-unified-time-semantics.md#8-explicit-units-for-time-quantities)).
4. Text and numbers, numbers and booleans, and numbers and durations never convert into each other implicitly. Values
   become visible text only in `${...}` and `say`.
5. A conversion takes its fallback as `default:` (rule 7), never as a positional argument.
6. `fromJson`'s result has an expected type: the written type of the place it lands in directly (rule 7), otherwise its
   default's type, where `[]` leaves the element type open and `null` leaves the value unknown, to be tested with `is`.
   An object default, or an expected object type, reads the JSON as that object: a missing key, or one whose value has
   the wrong type, takes that property's value from the default (in debug or test mode a developer warning names the
   key), extra keys are ignored, nested objects follow the same rules, and malformed text or JSON of another kind gives
   the whole default. A property that is `null` in the default and gets no type elsewhere in the script stays unknown,
   tested with `is`. A dict default gives a dict. The default declares the shape the script expects, so its uses are
   checked at compile time and one bad field does not discard the others.

### 3. Type syntax and union types

1. A type is a type name, `T[]`, `T set`, `T dict`, `T?`, a union `A | B`, or a parenthesized type. Postfix forms bind
   tighter than `|`: `(integer | string)[]` is a list whose elements are integers or strings, and `integer | string[]`
   would be an integer or a list of strings, which rule 3.4 forbids.
2. `T?` is shorthand for `T | null`.
3. The type names are those of V30 §13.
4. Unions are usable everywhere a type is allowed, except that a union never holds a whole list, set, or dict beside
   another type, in any type position, also inside another type: `integer[] | string[]`, `string[] | string`, and
   `integer | string[]` are compile errors, the last suggesting `(integer | string)[]`. An optional collection such as
   `integer[]?` stays. The compiler never infers a union; mixing types without a declared union stays an error whose
   message points to the union form.
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
   covers `==` and `!=` with a value that the other side can never hold. Comparing the answer of a compact `askChoice`
   whose button values are all written with a value no button returns is warned by a simple check outside the types,
   for `switch askChoice` and for a variable that only ever holds such answers, with the buttons of all of them,
   wherever the comparison stands (V30 §19).

### 5. Narrowing

1. After a test, the compiler knows the narrower type in `if`/`else` branches, in the right operand of `and`/`or`, in a
   `while` body, and after an early `return`, `exit`, `break`, or `continue`. `x != null` and `x == null` narrow like
   `x is not null` and `x is null`.
2. An assignment narrows the variable to the assigned value's type: directly after `let reward: integer | string = 10`,
   `reward` is known to be an `integer`.
3. Tests can overlap, because an integer is also a number. An `else` branch keeps only what the test provably excludes.
4. A check on a stable path narrows like a check on a variable: a variable followed by properties, fixed indexes or
   keys, or indexes and keys held in plain variables, as in `rooms[i].door.locked`, where each read selects the same
   stored value (V30 §13). A check holds only where every route into the place establishes it. A saved value keeps
   its facts: after `let item = items[i + 1]`, a check of `item` holds even when `items` changes later.
5. A check is dropped by a change to the value, to any part of its path or to an index or key variable in it, by a
   change of a list or dict in the path, by a write through any reference to the same speaker, and by code that may run
   and change the path: a call, `say`, `wait`, an interaction, a storage write, a timer or media command or property
   write, also through a local that a block shares and assigns (ADR 0024). Inside a `noInterrupts` block (V30 §27),
   timer, media, and button blocks wait until it ends and drop no check. Where the compiler cannot tell what code
   changes, it assumes it may. A loop's start joins the facts on entry with those at the end of the body until they no
   longer change, and a write in the body drops a fact only when the written value can break it. A function or handler
   body does not inherit the checks of the code around it.
6. A use that needs a check is a compile error when some route to it has none, or when the compiler proves it invalid.
   A check on every route that the compiler cannot keep, because of a computed index, a possible write by a timer,
   media, or button block or a function in between, or an analysis limit, gives a compiler warning at that use and a
   check there when the script runs (rule 1.10); this holds for plain variables too. Once `noInterrupts` blocks are
   implemented, a warning about a timer, media, or button block also suggests one.

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
3. Loads of a key without a declared type agree on its type: of two load types, one accepts every value of the other, as
   `number` does `integer`, or the later load in source order (rule 1.6) is an error that names the earlier one, and its
   file when that is another one. Saves never decide the type.
4. A saved value of known type fits the type of every load of its key, or the save is an error that names the load it
   does not fit. A key that no load reads is not checked.
5. Each `load` checks the stored value against its type when the script runs: stored data can come from an older
   version of the script, a debugging edit, or an import. A value that does not fit is treated as absent for that
   `load`, with a developer warning, and stays stored (V30 §25). With an object default, `load` works per field, as
   `fromJson` does (rule 2.6): a missing or wrong-typed field takes that field's value from the default, and `TSW016`
   names the field. A saved value that the compiler cannot know is checked when the script runs against the type every
   load of its key accepts.

### 7. Fallbacks and defaults

1. `a otherwise b` evaluates `a` once and gives it unless it is `null`; then it evaluates and gives `b`, and it does not
   assign to `a`. `b` has the type of `a` without `null`, or is `null`; a non-null `b` removes `null` from the result.
2. Every `default:` follows the same rule: the default of a list or dict `get`, of the conversions, `toRegex`,
   `fromJson`, `fromBase64`, `fileFromBase64`, `decryptText`, `decryptFile`, and `load`. A default types only its
   result, never the list or dict it reads from.
3. A fallback or default of another type is a compile error, also inside `${...}`. A mix is allowed only where the value
   lands directly in a place whose written union holds both: a typed `let`, an assignment to a variable with a written
   type, an argument for a parameter with a written type, or a `return` in a function with a written result type.
   There the written type also reaches the elements of nested list, set, and dict literals, but not through a function
   without types, an operator such as `+`, or `${...}`.

A fallback follows the type rule of an assignment without assigning to its source. A mixed result without a written
union would be an inferred union (rule 3.4).

## Consequences

- Scripts that mixed types silently are rejected with messages that name the fix; existing examples are corrected. This
  includes values saved under a storage key that its loads do not accept.
- Beginners keep writing untyped scripts. Types and tests appear only when an author opts into unions or needs to check
  external data.
- The instruction plan carries type descriptions for the runtime checks and type tests.
- A `color` type is planned as a separate change.
- The O4 rules change what compiles when the compiler switches to the new type checker; scripts that rely on a
  property added by assignment, a union of whole collections, a mixed fallback, or two kinds in one place need a
  literal with every property, a union inside the collection, or a written union.

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
- Saves that decide a key's type: a later save must not change what an earlier load returns.
- Deleting or converting a stored value that does not fit: keeps storage clean, but destroys data that an older version
  of the script saved and an author may still want to migrate.
- Assignment that adds a property, as in JavaScript (the earlier rule 1.4): a misspelt property silently became a new
  one, and an object's type depended on every store anywhere in the project.
- A union inferred for a mixed fallback or default, such as `get` joining its default with the element type (the
  earlier rule 1.3): it hides the mixing that rule 3.4 reports elsewhere.
- Deciding a place by the first store the compiler meets (the earlier rule 1.6): the result depended on the checking
  order, which authors cannot see.
- Required parameter types: they make beginners write types; types at selected boundaries remain the fallback, by a new
  owner decision, if per-function summaries prove too costly.
- An error or a warning for a JSON object default's `null` property: its only fix, such as `nick: ""`, turns "not set"
  into empty text, because a property's type cannot be written; if that pinches, the remedy is syntax for a type at a
  `null`.
- A compile error for a place over the work budget in a realistic script, or for a written check the compiler cannot
  keep: it rejects valid code for a limit of the compiler.
- A compile error for code that may go wrong, as mypy gives: clear at first sight, but a false error confuses beginners
  most, and an error should always mean that the code is certainly wrong.
- Exact answers everywhere through an ever more precise analysis: its plan reviews kept finding new blockers of the
  same kinds, so precision comes one rule at a time instead.
- A compile error for a store that reads its own place through a function: it needs another representation, with
  symbolic obligations, and a further design round.
- Accepting, at an integer-only use, a value that may not be whole on every run, with a check when the script runs as
  in Lua, or with a warning: `items[score / 2]` would fail only when `score` is odd.
- A parameter typed from its default, as a `let` is from its start value (the earlier rule 1.5): `shake(0.5)` was an
  error for `function shake(times = 1)`, although an integer becomes a number where that is needed.
- The button values of an `askChoice` in its answer's type, known until the variable changes (the earlier V30 §19
  rule): it carried literal value sets through the type system for one warning.
- Typing computed keys by prefix, such as `"toys.${id}"`: prefixes overlap, so a family needs its own explicit form.
- Typing a computed-key load by its default: it gives data the compiler cannot know a fixed type.
- Widening an inferred `integer` place to `number` for a non-whole value from data the compiler cannot know: every
  whole-number use of that place would become an error; such a store is checked when the script runs (rule 1.7).
- A compile error for a value the compiler cannot know against a type that only a later value decides (rule 1.7): exact
  admission against later deciders failed four review rounds of the new type checker, so the forward check was dropped.
