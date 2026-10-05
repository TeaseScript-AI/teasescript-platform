# Compatibility gaps and TeaseScript feedback

This document separates importer limitations from actual TeaseScript design questions. SexScript compatibility is not
a reason by itself to copy Groovy or the old runtime. Corpus counts come from the dated snapshot in
[`CORPUS-INVENTORY.md`](CORPUS-INVENTORY.md); the target policy is in [`POC-SCOPE.md`](POC-SCOPE.md).

## Classification

Every unsupported corpus construct should end in one of four buckets:

1. **Importer gap** — TeaseScript already expresses the behavior; the converter needs a rewrite or better analysis.
2. **Semantic difference** — both languages can express the intent, but automatic conversion needs an explicit rewrite
   or warning because observable behavior differs.
3. **Capability candidate** — the legacy script uses a generally useful behavior for which accepted TeaseScript has no
   proven equivalent. This is evidence for owner evaluation, not an automatic language change.
4. **Legacy baggage** — JVM, reflection, process, filesystem, dynamic class loading, or similarly host-specific behavior
   that should not be reproduced in TeaseScript merely for compatibility.

## Conversion gates

Importer progress is measured at package level rather than by requiring every generated `.tease` file to be standalone:

1. **Recognized** — the legacy source parses and the importer understands its structural form.
2. **Lowered** — the script body has TeaseScript IR/output without direct migration errors.
3. **Dependency-closed** — every generated function call resolves to generated package code or a known accepted
   TeaseScript/Standard-Library capability. This includes transitive helper dependencies.
4. **Compiler-clean** — the package compiles as one project (`compileProject`, ADR 0022), and the project reports no
   error for the script. By default the importer emits workarounds for accepted TeaseScript that `main` does not
   implement yet (see Accepted but not implemented); with `--accepted`, the report compiles a copy in which those forms
   become placeholder host calls that keep their accepted result types, and a file that is clean only in that copy is
   blocked by TeaseScript implementation work, not by importer output.
5. **Runnable/verified** — relevant execution paths have actually run without unresolved runtime behavior. The
   report's smoke run (`report --run`) runs the package project in the real runtime from `main.tease`; the runtime
   follows the transfers between files itself, and a file that is not compiler-clean is a stub that ends the run as
   `blocked`. Scripts no run reached run in isolation, through a `main.tease` that transfers to them. It catches
   runtime type errors the compiler cannot, but one path is evidence, not proof of equivalence.

The POC embeds transitively required helper functions into each generated `.tease` file because package-library linkage
is not yet available. That is a current migration strategy, not a language requirement. Auxiliary Groovy classes with
fields are not duplicated automatically because fields may carry shared state; the importer reports
`SX_HELPER_SHARED_STATE` instead.

## Existing TeaseScript is sufficient

These corpus patterns looked like gaps but are importer work; the generated form is ordinary TeaseScript, or accepted
TeaseScript that the compiler gate replaces with stand-ins until `main` implements it (see Accepted but not
implemented):

| Legacy pattern | TeaseScript form |
| --- | --- |
| `"Hi " + name` (string `+`) | `"Hi ${name}"`; TeaseScript `+` adds two numbers or joins two texts or two lists (V30 §4), and Groovy joined text with any value |
| Groovy truthiness (`if (name)`, `!count`, `if (map)`) | explicit comparisons chosen from inferred types (`name != ""`, `count == null or count == 0`, `map != {}`, `dict.length > 0`) |
| ternary / Elvis | `if` statements with one assignment or statement per branch |
| implicit last-expression return | explicit `return`, also in the last statements of `if`/`else` branches |
| `list[getRandom(list.size())]`, `list[-1]` | `list.random`, `list.last` / `list[list.length - n]` |
| `collect`, `findAll`, `find`, `any`, `every`, `sum`, `times`, `eachWithIndex` with closures | ordinary `for` / `repeat` loops |
| closures stored in data or passed as callbacks | string action IDs (the forwarded function's name) plus one generated dispatcher function |
| `return new Object() { fields; methods }.main()` | globals, functions, and the entry method's statements as the script flow |
| runtime-loaded `metaClass` mixin modules (`Eval.me` over a script directory) | the injected methods as functions and direct calls to each module's load and setup function |
| a `break` in the middle of a `switch` case | break-free case paths |
| switch cases that are literal lists | a case with several values, `case 0, 1 { ... }` (#528) |
| switch cases that are variables, or that overlap | an `if`/`else if` chain with `==` or `contains()` |
| `getSelectedValue(text, [...])` | `say text` plus `choose 0: ..., 1: ...` (numeric values return the index) |
| `getSelectedValue(text, ["Back"] + list)` | `say text` plus `choose 0: "Back", sexscriptLegacyMenuOptions(list, 1)`, whose `{ value, text }` choice objects return the index (PR #515) |
| `getBoolean(text, yes, no)` | `say text` plus `(choose yes: ..., no: ...) == "yes"` |
| `getString` / `getFloat` / `getInteger` with a default | `say text` plus `askText default: value` / `askNumber default: value` / `askInteger default: value` (#548) |
| `Calendar.getInstance().get(Calendar.HOUR_OF_DAY)` and other fields | `getDateTime().hour`, with month and weekday-number conversions |
| `getTime()` (Unix seconds) | `getTimestamp().toSeconds()`, a fixed moment (#532) |
| `Calendar.getInstance().get(Calendar.DAY_OF_YEAR)` | `(getDate() - toDate("${getDate().year}-01-01")).days + 1` (#532) |
| `new Date().format("yyyy-MM-dd")`, `new Date().format("HH:mm")` | `getDate().toISO()`; `getTime().formatTime()`, with a note (#532) |
| `list + other`, `list << x`, `list.push(x)`, `list += other` | a generated concatenation helper and `add()` |
| `list - other`, `list -= other` | a generated helper that keeps every element `other` does not hold, repeated ones too, as Groovy did (`difference()` keeps each once); a right side not proven a list or one value is decided at runtime |
| `x instanceof Number` (`String`, `Boolean`, `List`, `Map`) | `x is number` (`string`, `boolean`, `list`, `dict` or `object`) (#530) |
| a map used as a lookup table: `[(KEY): v]`, `map[key]`, `containsKey`, `keySet`, `values`, `size`, `put`, `remove`, `clear`, `each { k, v -> }` | a `dict` (#536): `dict{ [KEY]: v }`, `map[key]`, `contains`, `keys`, `values`, `length`, `map[key] = v`, a guarded `remove`, `clear`, `for k in map` |
| a map with fixed names that gains fields later, and its `clear()` | an object literal that declares every used field (null when added later); `clear()` reassigns it with null fields, so a map that `clear()` empties starts every field as null and sets its values right after, since a property keeps the type of its first value (ADR 0021 rule 1.4) |
| `list.remove(index)`, `list.remove(value)` | `list.removeAt(index)`, also as a value; `list.remove(value)` with structural equality (#517) |
| Groovy string methods (`size()`, `trim()`, `toUpperCase()`, `replace()`, `split()`, ...) | text operations (`text.length`, `trim()`, `uppercase()`, ...; #518) |
| `list.join(separator)`, `"${list}"` | `list.join(separator)`; `"[${list.join(", ")}]"` (#518) |
| `def x` / `int x` without initializer | `let x: string? = null`, and `0` or `false` for primitives; a list, also one declared `= null`, starts empty (`let lines: string[] = []`), and a number `0`, unless code in its script or modules compares it with null or reads it with `?.`, where null and an empty list or 0 differ (owner decisions); Groovy truth treats them alike. A note marks a number a text can show before its first value, which Groovy showed as `null` (`SX_NULL_START_NUMBER`) |
| `def x = 0` that later holds a fraction | `let x = 0`, which widens to `number` by itself (#504 option B, #526) |
| `def x = "a"` that is later set to `null`; `def x = null` | `let x: string? = "a"`; `let x = null`, which keeps the type of its first value (#504 decision 1a) |
| a variable that receives a function result that may be absent, or a storage read that the script then tests for null; `def b = a` where `a` may be null | `let x: integer? = 7`, since a possibly null value fits only an optional place (ADR 0021 rule 1.9); `let b: string? = a`, since the compiler narrows `a` at the declaration. Other storage reads are checked at runtime when stored |
| `text += value` | `text = "${text}${value}"` |
| a list literal mixing types, such as Groovy pairs `[["late", 2], ["rude", 4]]` | `let pairs: (string \| integer)[][] = [["late", 2], ["rude", 4]]` (ADR 0021 rule 1.3), with a note when later elements add a type |
| `int x = 7 / 2`, `int x = f()`, and later values stored in `x` | `let x = toInteger(7 / 2)`, `let x = toInteger(f())` (Groovy stores 3); `int x = loadInteger(k)` becomes `let x: integer = load k`, and another storage read `toInteger(load k)` |
| `new Boolean[n]`, `x in list`, boolean `&`/`|` | a generated list helper, `list.contains(x)`, `and`/`or` with a side-effect-free right side |
| `System.exit(0)` | `exit` (the Player stays open) |
| `setInfos(version, title, summary, author, status, color, language, tags)` | the `---` file header (V30 §41, #575): `title`, `author`, `description`, and the legacy tags, which named a script in the legacy catalog, as `keywords` rather than the selection `tags`; the version, status, color, and language have no header field and stay a comment after it, as does a value the script computed (`SX_METADATA_DYNAMIC`, 0 corpus sites); text joined from literals with `+` counts as written. All 23 corpus calls convert |
| a script-level `return "name"`, the next script of the legacy chain | `goto "path.tease"`, with the path from the package root (ADR 0022); a name the package has no script for ended the legacy chain quietly, so it becomes `exit` with a note (`SX_MISSING_SCRIPT`, 8 sites) |
| `return name` with a computed name | `goto script(name)` (#570), after `exit` when the name is null or empty (`SX_DYNAMIC_SCRIPT`, DisciplineClinic's `returnPoint`) |
| `return null`, `return`, or the end of a script | `exit`: every file ends with a transfer or `exit` (ADR 0022 §4); parameters and return points passed through storage stay `save` and `load` |
| the scripts the legacy player listed | a generated `main.tease` that asks the legacy profile and goes to the entry: the script of `scripts/` that calls `setInfos`, is no internal script, and that no other script chains to, or without one there such a script one folder down (teachertrouble's `Banjo/teachertrouble`); a menu labelled by setInfos title and language where there are several (`SX_ENTRY_MENU`); a legacy `main.groovy` is `main.tease` itself. Every other file keeps its legacy folder and name (owner decisions 2026-10-05) |
| mixin modules a script loads at runtime (`Eval.me` of each file of a folder, Toy's `toy/*.groovy`) | each module its own file, its injected methods and loader `global function`s, with what they use of the loading script global too (its fields as `global`s, assigned where the script declared them); a module folder that several scripts load is composed into each |
| a function several scripts define, as authors copied it between scripts | a function in each file, as in the legacy package (owner decision 2026-10-05) |
| the methods of a package-local helper class, such as `Domme3Class` | `global function`s in the class's own file (`Domme3/Domme3Class.tease`), with its static fields of literal values as `global`s, where other files call them; a method that reads other state or dispatches closure values is copied into each script that calls it |
| the importer's own generated helpers (`sexscriptLegacy*`) and the system speaker | one `global function` each in `main.tease`, with the state they share across files, such as the switch button's ID, as a `global`; the background-sound helpers stay in each file, since the legacy player stopped a script's sounds when it ended |
| `int t = showPopup(m)` (seconds until closed) | `getTimestamp().toSeconds()` before and after `showPopup m`, in whole seconds |
| `showButton(text, s)` used as a value (seconds until the click) | `(showButton text, timeout: s) / 1 s` (#531) |
| `showButton(text, 0)` (the button stayed for its 10 ms safety margin; the result was 0) | `showButton text, timeout: 10 ms`, with a note, also for a timeout known before the run (`def t = 0`, `1 - 1`); a used result is `0` |
| `x = loadInteger(k)` followed by `if (x == null) x = d` | `x = load k, default: d` (#541; also `loadString`, `loadBoolean`, `loadFloat`) |
| `m[k] ?: d`, `m.containsKey(k) ? m[k] : d`, `x = m[k]` followed by `if (x == null) x = d` on a dict | `m.get(k, default: d)` (#536) |
| `getImage(message)` (webcam picture path or null) | `takePhoto()`, with a note (V30 §33) |
| `playBackgroundSound(null)`, `stopSoundThreads()` | handles of the async sounds kept in a list and stopped by a generated helper |
| `f(x++)`, `continue` in a C-style `for`, `return` inside `each()` or `times()` | `f(x)` then `x += 1`; the update step before each `continue`; `continue` |
| `c ? a : b`, `v ?: d`, `a && getBoolean(q)` inside a larger expression or an `if` condition | `let conditional = ...` with one assignment per branch before the statement, which then reads `conditional`; parts Groovy evaluated earlier move into `let earlier = ...` first where their effects or values could change |
| `a & f()`, `a \| f()` on booleans | `let earlier = a`, `let conditional = f()`, then `earlier and conditional` |
| `list.findAll { }`, `any`, `every`, `collect`, `find`, `sum` inside a larger expression | the loop into `findAllResult` (and so on) before the statement |
| `getSelectedValue(q, opts.collect { it.lbl })` inside a larger expression | the menu into `selected` before the statement |
| `x.isEmpty()`, `x.size()`, `n.times { }` on a value of unknown type | `x.length == 0`, `x.length` (text, lists, and dicts), with a note where the value may be an object, whose length fails (`SX_LENGTH_RECEIVER`, 20 sites); the loop (Groovy has `times()` only on numbers) |
| `list = list.sort()` | `list.sort()` |
| A script variable that holds values of several types where every write and read is straight-line code of the block that declares it, which no function writes (`x = "a"; say x; x = 1; ...`) | one variable per type (`x`, `xNumber`); otherwise a declared union (`let dialog: string \| list = ""`, `SX_UNION_TYPE` note, #530), and a type change (`SX_TYPE_CHANGE`) only for types a union annotation does not name, such as a range |
| `while (playBackgroundSound(s) \|\| true)` | `while true` with the call as its first statement |
| `sleep(ms)`, `waitWithGauge(s)` | `wait ... ms`, `timer ...` |

## Semantic differences

The importer converts these with an inline `NOTE` or reports them when it cannot prove equivalence:

- `show()` replaced the single text area; `say` appends to a transcript. `show(null)` only cleared the text, so it is
  dropped. Input functions showed their text like `show()`; a `null` text kept the current text.
- `say` text is message markup: legacy `*emphasis*` renders as formatting and URLs become links. Line-start list,
  heading, or quote markers and backslash escapes get a `NOTE` (`escapeMarkup()` keeps text literal).
- Single-field input prefilled its field with the default, also when the default was null (the field showed "null")
  or empty. TeaseScript prefills with `default:`, and a null or blank default at runtime opens the input without a
  prefill (#618), so such a default converts as written; a literal empty or null default, which TeaseScript rejects
  as written (`TSV039`), is dropped. A number input's default that may be no number, or a fraction for `askInteger`,
  goes through a helper with a note (`SX_INPUT_PREFILL`). A text default that may be no text becomes text
  (`"${level}"`, null staying null), and a list becomes `"[${list.join(", ")}]"`, as Groovy printed
  it; a map default is reported (`SX_INPUT_PREFILL_VALUE`). A default
  computed with side effects stays manual work for text and number input (`SX_INPUT_PREFILL_EFFECT`): legacy computed
  it before showing the question, and the converted question is a `say` before the input.
- Groovy turned a list into text as `[a, b]`; TeaseScript `${list}` selects one element and `say list` shows a quoted
  notation (PR #515). A list of text, numbers, and booleans becomes `"[${list.join(", ")}]"`; other lists are reported
  (`SX_COLLECTION_TEXT`). Groovy printed a whole `double` as `2.0`, where `${...}` shows `2`. Groovy `join()` had no
  separator, so it becomes `join("")`, as TeaseScript's default separator is `", "`.
- Text operations follow Unicode code points and full case mapping (#518): lengths and positions count code points
  where Java counted UTF-16 units, `trim()` also removes non-breaking spaces, and `uppercaseFirst()` turns a leading
  `ß` into `SS`. A literal with a character outside the Basic Multilingual Plane, such as an emoji, gets a `NOTE` on a
  length, `substring`, `indexOf`, or `lastIndexOf` (`SX_TEXT_CODE_POINTS`); text known only at runtime does not. Java
  `split()` drops trailing empty parts and TeaseScript `split()` keeps them (`NOTE`). Groovy `join()` printed nested
  lists and maps, which the accepted `join()` rejects, so a list known to hold them is reported (`SX_LIST_JOIN`), also
  when they reach it through an alias (`ys = xs`) or a later `add`, `<<`, or `+=`; a list whose element types are not
  proven gets a note (0 corpus sites).
- Legacy `save(key, null)` deleted the key and every dotted sub-key (`key.*`), and generic `load()` decoded a stored
  string `"null"` as null. Since `save null` removes the key on `main` too (#484), a typed read followed by a null
  default (`x = loadInteger(k)`, then `if (x == null) x = d`) becomes `load k, default: d` (#541), 101 corpus sites
  (100 in DisciplineClinic); other reads compare with `null` explicitly, and generic `load()` keeps that test because
  of the `"null"` text. TeaseScript keys are flat, so saving a scalar over a former list/map key leaves the old
  sub-keys.
- `getRandom(max)` returned 0 for `max` 0 (rounding toward zero for a negative bound, and 0..99 for null), while
  `randomInteger()` rejects the empty range `0..0`. Bounds other than a positive integer literal therefore use a
  generated helper with the legacy results; the smoke run found this on Domme3's default single image pack.
- Groovy ordered comparisons accept null (`null` sorts first, so `null >= 5` is false); TeaseScript comparisons fail
  at runtime. Conversions keep plain comparisons: guarding every comparison of a stored number would bury the intent,
  and the corpus scripts that compare a missing key (isolated smoke runs of Domme3 `discipline` and `maintenance`)
  depend on settings saved by the package's introduction anyway.
- A Groovy map in a condition tests emptiness, which `map != {}` expresses now that objects compare structurally
  (#517), or `dict.length > 0` for a dict; a map that may also be null is tested with `map != null and map != {}`, and
  reported when the expression cannot be evaluated twice (`SX_MAP_TRUTHINESS`).
- A Groovy map read a missing key as null; a dict reports it (#536). `map[key] == null` and a lookup used as a condition
  therefore test `contains(key)` first (with `or map[key] == null` when a value may be null), and `remove(key)` of a key
  that may be missing becomes `if map.contains(key) { map.remove(key) }`. A fallback for a missing key (`m[k] ?: d`,
  `m.containsKey(k) ? m[k] : d`, read-then-default) becomes `m.get(k, default: d)`, with a note where Groovy's fallback
  also replaced a stored null, or with `?:` a stored false, 0, or empty value (`SX_DICT_DEFAULT`). Any other lookup
  fails where Groovy continued with null, so it gets a note (`SX_DICT_MISSING_KEY`, 13 Toy sites) unless its key is
  proven present: a literal key that every map assigned to the variable has and nothing removes, a key a surrounding
  test found, a key written earlier in the same block, or the key of a loop over `keySet()`. Groovy kept a key's type,
  so `1` and `"1"` were different keys, while dict keys are text: number keys become text with a note
  (`SX_DICT_KEY_TEXT`), at every number key of a dict that text keys reach too, and a key of unknown type becomes text
  in a dict that number keys reach. A repeated literal key kept its first position and its last value, which the dict
  literal merges with a note (`SX_DICT_DUPLICATE_KEY`). A map whose values have different types (also through property
  writes or lists with different element types), a runtime key on a map not held in a variable, and a dict compared with
  a map that may be an object are reported (`SX_DICT_VALUE_TYPE`, `SX_DYNAMIC_MAP_ACCESS`, `SX_DICT_EQUALITY`); a map
  literal or variable compared with a dict becomes a dict, since a dict never equals an object. Dict analysis follows
  bindings, so a closure's own `def m` is apart from a script `m`.
- An empty-text placeholder that later holds one other type (`def lineArray = ""`, later a list) starts with that
  type's empty value (`let lineArray: string[] = []`), which differs only where the empty text was read
  (`SX_PLACEHOLDER_TYPE`, 5 DisciplineClinic sites). A write by position into a list that starts empty grew the Groovy
  list, padding with null; the conversion appends when the position is the length and notes the difference beyond it
  (`SX_LIST_GROWTH`, DisciplineClinic's `assignmentArrayList`).
- What a function cannot convert does not block the script when nothing references the function: no call, action ID, or
  use as a value in the generated program, which counts module loaders, setups, and the action dispatcher, and no
  reference in the legacy code either, so a caller the conversion left unconverted still counts. Groovy never ran such a
  function, so its diagnostics become notes (DisciplineClinic's `testAllImages` and its class-loading `test`, 9 notes;
  Toy 1). A package with a call whose method name is computed keeps them blocking, since such a call could reach any
  function.
- Closures kept as values become action IDs called through one dispatcher. Unlike Groovy, the dispatcher ignores extra
  arguments and returns null for an unknown action; Groovy failed in both cases.
- A `switch` case Groovy tested with `isCase` keeps its meaning only where the case value shows it: equality for
  scalars, membership for lists, bounds for number ranges (tested in both directions when a bound is known only at
  runtime). A text range holds only the texts its iteration reaches (`"a".."c"` holds `"b"` but not `"ba"`), so a
  range case with text bounds, or with bounds of unknown type against a subject that may be text, is reported, like
  other case values (classes, patterns, closures, values of unknown type).
- Java integer and character arrays convert every written value; they are reported instead of becoming lists.
  Writes to a list that a direct `b = a` assignment shared get a `NOTE` (`SX_SHARED_LIST_WRITE`).
- `break`/`continue` with a label leave an outer loop; TeaseScript jumps affect only the innermost loop, so they are
  reported. A statement that only computes a value (often `==` written for `=`) had no effect and is dropped with a
  `NOTE`.
- Known residual differences, found by adversarial review and left as is because they need unusual input or fail
  loudly: Groovy integer ranges contain only whole numbers, while a converted range case also matches a fractional
  value; a `times` count or list index that is fractional or negative only at runtime fails in TeaseScript; two
  scripts that load the same module directory share one set of function and field facts; a variable that shadows
  `Calendar` is still read as the Calendar class; functions authored with the importer's `sexscriptLegacy` prefix
  collide with generated helpers; a closure parameter declared `int` does not truncate later stores, as a typed local
  does (the corpus's one typed parameter is never reassigned); `remove(x)` with a fractional number removed by value
  in Groovy, while the conversion removes by position (no corpus site); and a text default whose value is a list only
  at runtime shows one element (`"${value}"`).
- Groovy maps are shared references; TeaseScript records copy. A field write through a copy gets a `NOTE`
  (`SX_SHARED_MAP_WRITE`). Picking from an empty list returned null in Groovy and fails in TeaseScript.
- Groovy lists and maps alias by reference; TeaseScript composite values copy (ADR 0014). Groovy `def` variables may
  change type; TeaseScript variables keep one (#519, see the findings below).
- `list.removeAt(index)` with an invalid index fails like Groovy's `remove(int)`. The importer emits no `removeFirst()`
  or `removeLast()` (an error on an empty list). The corpus removes no list element by position: of its 6 `remove`
  calls, 5 act on Toy's maps and one removes a text value inside a Toy closure chain.
- Java `Math.round` rounds `.5` toward positive infinity; TeaseScript `round()` rounds ties away from zero (V30 §13),
  so `round(-2.5)` is `-3` where Java gave `-2` (`SX_ROUNDING_TIES`, 7 corpus sites).
- Legacy `showButton()` returned the seconds until the click as a number; the TeaseScript result is a duration
  (#513, #531), so a used result is divided by `1 s`, 49 corpus sites. A Groovy `int` that stores it truncates, as
  Groovy did: `t = toInteger((showButton "Done") / 1 s)`, 25 sites in Domme3. A zero timeout kept the legacy
  button for its 10 ms safety margin and returned 0, which the conversion keeps (`SX_BUTTON_TIMEOUT`) when the zero is
  known before the run (a literal, arithmetic on literals, or a variable assigned one such value once); a computed
  timeout gets a note, since it fails in TeaseScript (#531) if it is zero or negative (6 corpus sites), and a negative
  one, which failed in legacy too, is reported.
- Java date pattern formatting (#532): `yyyy-MM-dd` is a machine format and becomes `toISO()`, exactly; a display
  pattern of a whole date or time becomes `formatDate()`, `formatTime()`, or `formatDateTime()`, which show the
  player's local form instead of the legacy pattern, a deliberate difference with a `NOTE`. Of the corpus's 9
  formatting sites, 3 use `toISO()` and 3 `formatTime()`; the 3 that format a date built from stored Unix seconds stay
  reported (`SX_DATE_FORMAT`), see the observations below.
- Legacy `getImage()` took a webcam picture without asking and returned its path, or null; only without a webcam did
  it open a file chooser titled with the message. `takePhoto()` returns a photo reference or null; the file-chooser
  fallback and the message are dropped with a `NOTE`, and the Player decides how the photo is taken (3 corpus sites).
- Rewrites that move evaluation (ternary branches, input prompts) are applied only when the expression is not behind
  `&&`/`||`/`?:` and nothing with side effects is evaluated earlier in the statement; otherwise the statement is
  reported (`SX_CONDITIONAL_POSITION`, `SX_PROMPT_POSITION`).

## Type enforcement findings (#519, #526, #530)

`main` rejects a value of another type than a variable's declared or inferred one (`TSV041`), and only `integer`
widens to `number`. Since `337388d2` it checks types in a separate pass (#526, ADR 0021), checks values the compiler
cannot know at runtime (#520), and accepts unions, `is`, and narrowing (#530). The importer follows these rules over the
generated program: a variable that starts as `null` keeps the type of its first value (#504 decision 1a), and an
unannotated integer widens to `number` by itself (option B). Measured on the four corpus packages:

- **The type pass reaches only scripts that pass name and structure checks.** Toy, DisciplineClinic's `Punish` and
  `OffenseSelect`, and Domme3's `exercise` and `status` stop at unknown names first (variables whose declaration stays
  unconverted, assignments to undeclared names, which Groovy turned into script properties), and Domme3's `settings`
  at a `break` outside a loop, so their type errors stay hidden behind those.
- **Variables that change type: 8 in DisciplineClinic, 1 in Toy.** Five start as an empty-text placeholder and later
  hold a list or yes/no answers (`def lineArray = ""`); they start with the later type's empty value, with a note
  (`SX_PLACEHOLDER_TYPE`). The other four now get a declared union with a note that names the test a use of one type
  needs (`SX_UNION_TYPE`); see the union findings below.
- **Integer/number friction, resolved by #504 option B:** 18 declarations start with a whole number and later hold a
  fraction (`def spankTempo = 1`, later `spankTempo = 0.75`); `main` widens them by itself, so the output writes no
  `: number`.
- **Optional types:** a variable that is later set to null gets `T?` (`let block: string? = "begin"`). Two more cases
  surfaced with #526: `let newBlock = block` with `block: string?` takes `block`'s type narrowed at that point, so it
  gets `string?` written (Domme3 `sleep`); and a variable that receives a storage read and is then tested for null
  (`w = loadInteger(k)`, then `if (w == null) ...`) gets `integer?`, since `main` checks the stored null at runtime
  otherwise. A storage read the script does not test for null stays unannotated: the runtime check is what Groovy's
  guards (`if (loadInteger(k) != null) p = loadInteger(k)`) rely on.
- **Groovy integer declarations coerce:** an `int` stores whole numbers, so every value not known to be an integer
  truncates with `toInteger`, 55 sites (25 of them `showButton` seconds stored in Domme3's `int t`). The 53 `int`
  declarations initialized with `loadInteger()` become `let x: integer = load k`, which `main` now checks when the
  value is stored (#520); in isolated smoke runs with empty storage four Domme3 scripts fail there (`TSR058`), where
  Groovy's `int` rejected null too. Groovy stored a one-character text in an `int` as its character code (`"3"` became
  51), so a value proven to be text is reported and a truncated value that may be text gets a note
  (`SX_INTEGER_FROM_TEXT`; 0 corpus sites).
- **Text `+=`:** Groovy appended any value to text with `+=`; TeaseScript `+=` joins text only with text (V30 §4), so
  `text += value` on a variable that holds text becomes `text = "${text}${value}"` (Domme3's
  `showDynamically`, which also iterates over the characters of a text, which TeaseScript `for` rejects at runtime).
- **Index rule:** a variable that may hold a fraction cannot index a list (#504 option B); such an index truncates with
  `toInteger`, as Groovy's `getAt(Number)` did. No corpus site remains.
- **Mixed list literals:** a list of mixed types needs a declared union element type (ADR 0021 rule 1.3).
  DisciplineClinic's offense tables are Groovy pairs (`[["offenseDrivingAccident", 4], ...]`, 6 tables with 61 pairs
  in `OffenseSelect`) and now declare `(string | integer)[][]`.
- **Objects that `clear()` empties:** an object property keeps the type of its first value (rule 1.4), so the field
  values of such a map are set after a declaration with null fields (0 corpus sites with values; Toy's
  `sessionParams` already starts empty).
- **Parameters with defaults (#526):** an unannotated parameter takes its default's type; no script that reaches the
  type pass passes a value of another type to one of the 101 generated functions with defaults.

### Union types on real code (#530)

The variables that held values of several types are declared with unions, and the compiler then shows how many uses
need a type test. Uses in `say`, `${...}`, `save`, `==`, `choose` option lists right after a list assignment, and
assignments need none, and an assignment narrows the variable until the next call that may change it.

| Variable | Declaration | References | Uses that need a test |
| --- | --- | ---: | --- |
| DisciplineClinic `dialog` (main script) | `let dialog: string \| list = ""` | 217 (93 assignments) | 0 |
| DisciplineClinic `response` (`OffenseSelect`) | `let response: boolean \| integer = false` | 22 | 0 |
| DisciplineClinic `response` (`Punish`) | `let response: boolean \| integer = false` | 31 | 1: `if response { ... }` after an `if` that assigns a yes/no answer in one branch only; Groovy tested truth, the branch-merged type is still `boolean \| integer` |
| Toy `txt` (`tease`) | `let txt: (string \| string[])[] = ["Rub", "Caress"]` | 4 in its function | not measurable: Toy stops at unknown names before the type pass; the uses pass `txt` to a function |

The counts for `Punish` and `OffenseSelect` come from copies in which their unrelated unknown names are removed, so the
type pass runs. Unions fit this corpus well: the friction is one test in about 270 references, and it sits on a
condition the importer already marks (`SX_CONDITION_TYPE`). The one menu over `dialog` stays unconverted for another
reason: the importer proves a menu's option list at conversion time from Groovy types, which cannot see that `dialog`
holds a list at that point (`SX_DYNAMIC_CHOICE_OPTIONS`); `main` would accept `choose` over it there.

The larger friction was narrowing of variables that start as null. Such a variable is optional, and the narrowing an
assignment gives does not survive a loop start whose body changes the variable or, for a top-level variable that a
function assigns, a call, `wait`, interaction, or `say` (V30 "Type tests and narrowing"). Legacy code assigns lists in a
function and reads them after a helper call (`dialogArray = [...]`, `dIdx = getRandom(dialogArray.size())`,
`show(dialogArray[dIdx])`), so each read needed a null test: 38 sites (the lists `dialogArray` 15 and `offenseArray`
18, and three number variables 5), which blocked `WaitRoom` and would have blocked `Punish` and `OffenseSelect` once
their other causes are fixed. By owner decision, a list that starts as null now starts empty unless the code compares
it with null; that changes only reads before the first assignment, where Groovy failed with a null pointer, so the
output carries no note. 9 declarations qualify (DisciplineClinic 7, Toy 2) and none is blocked by a null comparison.
`WaitRoom` compiles again, `OffenseSelect` without its unrelated unknown names has no type error left, and 5 null tests
remain, all on number variables in `Punish` (`pickMistress` 3, `pointsBonus`, `numSlaps`).

## Dict findings (#536)

The owner's `dict` type replaced the importer's objects-as-dictionaries working syntax. Converting Toy's lookup tables
showed:

- **One value type fits the corpus:** no lookup-table map mixes value types (`SX_DICT_VALUE_TYPE` 0). The one mixed
  map, Toy's `sessionParams` (booleans, text, numbers), uses fixed names and is a record, as #536 anticipated.
- **Missing keys need guards:** Groovy read a missing key as null. 10 Toy lookups only test presence or truth and
  become `contains` tests, and 5 `remove` calls on keys that may be missing need `if map.contains(key) { ... }`. The
  default lookup that #536 added, `m.get(k, default: d)`, covers fallbacks for a missing key; Toy has one,
  `toynames[t] ?: t.replaceAll("_", " ")`, which becomes `toynames.get(t, default: t.replace("_", " "))` with a note,
  since Groovy's `?:` also replaced a stored empty name. 13 Toy lookups have a key
  the importer cannot prove present (a parameter, a list element, a computed level) and get a note, since they stop
  the script where Groovy read null.
- **Number keys:** Toy keeps two tables keyed by level (`[1: 1.25, 2: 1.1, ...][getLevel(DENIAL)]`), so their keys and
  lookups become text (`dict{ "1": 1.25, ... }["${getLevel(DENIAL)}"]`, 4 `SX_DICT_KEY_TEXT` notes). The deferred
  non-text keys would keep such tables as written.
- **Closures over entries stay manual:** `toys.any { s, t -> ... }` and `findAll` chains over maps (with method
  chains on looked-up values, 14 Toy statements) need loops; only `each { key, value -> }` converts, to
  `for key in map` with a lookup, since #536 has no two-variable `for` (1 site). `funcMap`, a dict of closures, stays
  manual like other closures kept as values (2).
- **Open maps versus fixed properties:** Groovy maps used as records gained fields later (`sessionParams.aborted = r`);
  with fixed properties the importer declares every field the package uses, null until set (6 literals), and turns
  `clear()` into a reassignment with null fields. Deciding dict or object needs the uses of a variable in the script
  and every module that loads it.

## Capability candidates

Evidence for owner evaluation, ordered by corpus weight. Choices from runtime lists (C1–C3, merged as #515), text
operations (#508, PR #518), single-field prefill (#510, merged as #514), and dictionaries (D1, decided as `dict` in
#536) were candidates here and are now accepted; the importer emits them by default.

1. **Regular expressions.** Toy's `replaceAll(/<[^>]*>/, "")` and a pattern `split` remain manual work, as does a
   locale argument (`toLowerCase(Locale.ENGLISH)`); a synchronous `.ts` text library, once package-library linkage
   exists, would cover the patterns.
2. **Localized script variants.** The distribution ships language variants per script (`intro`, `intro_de`,
   `intro_fr`, ...) selected by the legacy player. The repository has no localization decision; this is a package-level
   product question, not syntax.

Not candidates on current evidence: first-class closures, metaprogramming, and runtime evaluation. Toy uses all
three, and the converted Toy output expresses them with functions, action IDs plus one dispatcher, and direct module
calls; exceptions only guard desktop APIs.

## Specification and implementation observations

Concrete points the migration surfaced in TeaseScript itself:

- **Storage** matches the owner decision on `main` (#484): `load` never writes, and `save null` removes the key.
- **Prefill if available.** 27 of the corpus's 62 input defaults come from settings loaded from storage, which may be
  null (`askInteger default: playerLevel`). TeaseScript rejects a null default when the input opens, so a
  faithful conversion would need an `if` around two inputs; the output keeps one input with a note. A form that
  prefills only when the value is present would fit these settings dialogs.
- **Two kinds of time (#532).** Local `date`, `time`, and `datetime` values have no zone and follow the player; a
  `timestamp` from `getTimestamp()` is the fixed moment for "how long ago". Legacy code measured elapsed time in Unix
  seconds (`getTime()`, 18 scripts), so it uses `getTimestamp().toSeconds()`, while fields and formats keep the local
  getters. `day` and `week` are calendar units like `month` and `year` (`1 day` is tomorrow's same local clock time),
  so legacy arithmetic in seconds stays exact: the importer keeps such values as numbers and emits no `day` or `week`.
- **No timestamp from a number (#532).** Domme3 stores the chastity start as Unix seconds
  (`save("domme3.chastitystart", getTime())`) and later formats it (`new Date((long)chastitystart * 1000)`, 3 sites).
  #532 converts a timestamp to seconds but builds none from a number, because seconds and milliseconds would be
  ambiguous, so these stay manual work; storing the timestamp itself is the TeaseScript way, which needs a package-wide
  rewrite of the saved value.
- **Calendar day counts** convert with #532's `(date - date).days`: Domme3's `Calendar.DAY_OF_YEAR` seed (1 site)
  becomes `(getDate() - toDate("${getDate().year}-01-01")).days + 1`, which lowers `sleep`.
- **Compact interactions as values.** A used `showButton` result needs parentheses and a duration division,
  `(showButton "Done", timeout: 30) / 1 s`, 49 corpus sites; most compare the seconds with a number.
- **Defects found in `main` at `337388d2` are fixed in `242ada7a`** (#567): `case null, 0` removes null from the later
  cases (#557); `==` and `!=` with a value the other side can never hold warn (ADR 0021 rule 4.5; #535); a range case a
  `choose` result never matches, and `case 5` after `case is integer`, warn (V30 §32; #557); a `load` default of the
  wrong type is a compile error also in an assignment (V30 §25; #526); `askInteger` rejects an answer with line breaks
  (ADR 0018; #548); the `union()` and nested `toString()` errors name a working fix (#546, #518); and V30 §18 shows
  `load "level", default: 1`. In the corpus the warning for impossible null tests found the importer's own null test
  of input questions, which it now leaves out where the question can never be null (41 sites), and 11 legacy null
  tests that can never be true or false (8 distribution: `askBooleans` values tested for null, which TeaseScript never
  returns, and a commented dead test; 2 Domme3; 1 DisciplineClinic); they stay as written, with the compiler's
  warning.

## Multi-file scripts (#570)

Converting the corpus's script chains to ADR 0022 surfaced:

- **Shared helpers multiplied.** Functions are local to their file (ADR 0022 §3), so every script that used a helper
  needed its own copy: Domme3's 19 shared helpers were copied 165 times, 146 of them redundant (`sexscriptLegacyRandom`
  23 times, `percentChance` and `getImagePath` 22, `image` 18, `punish` 17). Several of them present things (`image`
  shows a picture, `punish` and `popup` talk and wait), so a synchronous `.ts` library cannot hold them. The owner's
  `global function` (#570) resolves this; the results are in the next section.
- **Global functions in the corpus.** Domme3 promotes 16 functions, which replace 145 identical copies, and one global,
  `imagePath`, which each script assigns where it computed its own (`imagePath = getImagePath()`). 4 names stay in more
  than one script, all with bodies that differ: `image` keeps 8 copies of 4 other picture sets as `imageLocal` (one of
  those sets is shared by 3 scripts and two by 2, but only one body can take the global name), and `kink`, `mast`, and
  `getInstalledDommePack` differ per script; `punish`, `reward`, `popup`, and `tomSound` each keep one variant as
  `nameLocal`. DisciplineClinic promotes 25 functions (78 copies) with 8 constant tables (phrase lists, picture counts,
  `scriptText`) and 6 assigned globals (`mistress`, `scenario`, two picture counts, `receptionSpankingPicsArray`,
  `assignmentArrayList`); 10 names stay per script, 8 functions whose bodies differ (`saveTempData`, `loadTempData`,
  `test`, ...) and the importer's two background-sound helpers, whose list of sound handles stays with its file because
  the legacy player stopped each script's sounds when it ended. The distribution shares no functions, and Toy is one
  script.
- **Package structure (owner decision 2026-10-05).** The measurements above used a generated `helpers.tease` that
  merged identical copies; the converted package now keeps the legacy files instead: copies stay in each file, a helper
  class's methods are global functions in its own file, and the importer's generated helpers are global functions in
  `main.tease`.
- **Friction.** Unique global names reach every file: any other name of a global gets another name in its file. A
  global's initializer may not call a function (ADR 0022 §6.4). A file that only declares global functions and globals
  needs no `exit` (ADR 0022 §4.3), so a helper class's file ends with its declarations. The warning for
  impossible null tests also reaches the importer's null test of an input question right after the question was set
  to text, which main's narrowing proves non-null; the importer leaves that test out too (59 of 64 such sites in
  DisciplineClinic's `Punish`, which does not reach the type pass yet; the other 5 follow the assignment in an outer
  block).
- **Localized variants are chosen by language.** The legacy player looked for `name_<language>_<country>` and
  `name_<language>` before `name`. ADR 0022 selects no file by language, so the converted chains follow the English
  scripts, the distribution's 4 localized targets (`mensclothes_de`, `toys_de`, `toys_fr`, `womensclothes_de`) are not
  reached, and its menu offers the localized introductions as scripts of their own.
- **References outside the package.** 8 script names point outside their package or nowhere: Domme3 chains to the
  distribution's `fontconfiguration` and to `system/config` and `system/restart` of the legacy player, DisciplineClinic
  to its `DCAfterDark` add-on, and four names are typos or missing files (`Domme`, `null`, `Domme3/masturbate`,
  `Domme3/training`). The legacy player ended the chain quietly when it found no file; a path cannot leave the package
  (ADR 0022 §1), so these become `exit` with a note.
- **Explicit endings** need an `exit` at the end of every converted script, since the legacy chain ended there.
- **Native projects (#570 parts 3 to 7a).** With globals, global functions, `goto` to files, and `script(...)`
  references in `main` (up to `19a93bee`), the gate compiles each package once with `compileProject`, and the smoke
  run starts the one plan at `main.tease` and lets the runtime follow the transfers. A package with unconverted files
  still runs: those files become stubs in the run's project, and the run ends as `blocked` when it reaches one. Native
  transfers behaved like the earlier stand-ins on both corpora. A computed legacy script name such as
  `"rooms/hall.groovy"` becomes `script(name.replace(".groovy", ".tease"))`, since `script()` needs the converted path.
  A package with a single script now gets it as `main.tease` too, so the Player can open it.

## Legacy baggage

Reported for manual work and intentionally not reproduced: reflection and `GroovyClassLoader` outside resolved
package helpers, `java.io.File` access and directory listing other than a recognized module loader,
`System.getProperty`, OS processes (Toy's speech output), `openCdTrays`, `useEmailAddress`, `useFile`, the old online
`send`/`receive` service, and `try`/`catch` around desktop APIs. The webcam `getImage` converts to `takePhoto()`,
native since #475, and the file picker `getFile` to `askImage()` (#608), since scripts used it for a photo. `Locale.getDefault()` serves the localization question above.
Scripts also contain plain legacy bugs the importer reports instead of repairing: calls to undefined functions, reads
of variables that nothing assigns (10 sites, such as `save("domme3.spank", fun)`; SexScript failed with a missing
property when they ran), helper calls with missing arguments, and closures referenced without `()` (which Groovy
evaluated as a no-op or as `true`).

Toy-specific owner decisions (2026-10-03): speech output is ignored for now; the Cornertime workflow (custom
punishment and report files exchanged with the external Cornertime webcam tool) stays manual work, and showing the
tool's link in the chat is acceptable if it is converted later. Toy's personas are data files evaluated at runtime:
`images/toy/domme.groovy` holds the shared title and session plans (with requirement conditions written as Groovy
expression strings), and each persona folder holds `person.groovy` plus image sets. The supplied packs contain the
Emily persona; the code's default owner `ancilla` is not included.

## Accepted but not implemented

File transfers (`goto "file.tease"`, `goto script(...)`), `global function` and `global` (ADR 0022, #570), and `takePhoto()` (#475, camera in the runtime and the Player) are native on `main` now, as are `dict` (#555),
date and time (#532), `switch` (#529, #557), the `showButton` timeout and elapsed result (#534), `askInteger` (#548),
rounding and the conversions, text operations and `join` (#518), list `sort()` (#546), integer widening (#526),
`load "key", default:` (#545), permanent buttons (#612), and image tags with `findImages` (#572): a legacy count of
an images folder becomes a query for one generated tag of the folder's full path, which an XMP sidecar gives each image
(`SX_IMAGE_TAGS`, owner decision 2026-10-05); only a count filtered by file name stays counted at conversion time
(`SX_IMAGE_COUNT_WORKAROUND`).

What remains accepted but unimplemented becomes a workaround in implemented TeaseScript, with a `// NOTE` naming it at
every site (owner decision 2026-10-05), so converted packages play natively; `--accepted=<forms>` emits the accepted
form instead once `main` implements it:

| Accepted form | Workaround | What it loses |
| --- | --- | --- |
| `askBooleans(message:, texts:, defaults:)` | the message, one yes/no `choose` per item with the preset marked in its button, then "Confirm" or "Change answers", which starts over (`SX_ASK_BOOLEANS_WORKAROUND`) | one form with every option; changing a single answer |
| `showPopup` | the message in the chat and an OK button (`SX_POPUP_WORKAROUND`) | the popup presentation |
| `openUrl(url)` | "Open this link: …" in the chat, where message markup makes an `http(s)` address a link, and a Continue button (`SX_OPEN_URL_WORKAROUND`) | opening the page itself |
| layered scene (`showBackgroundImage`, `showOverlayImage`) for an image composed in memory and shown with `setImage(bytes, n)` | the base image the function read (`SX_IMAGE_COMPOSITION`); `--accepted=layeredScene` places the base as background and each drawn image as an overlay at percentages of the canvas (`SX_LAYERED_SCENE`, or `SX_LAYERED_SCENE_PARTIAL` for source rectangles, text, shapes, pixel edits, and transformations) | the composition |

In the 211 merged corpus2 units (2026-10-05), 41 functions that only compose an image fall back to their base image,
and 46 `setImage(bytes)` sites stay TODOs because their function also shows text, waits, saves, or changes outer
variables. None of them maps cleanly to the layered scene: all 211 composing closures in the sources size their canvas
from a loaded image's `getWidth()` and `getHeight()`, so overlay percentages are unknown at conversion time; 27 draw in
loops, and only 6 read a literal base path. A clean mapping needs overlay positions relative to the background's own
pixel size, or an image-size query.

`askBoolean` with custom labels already converts to a two-option `choose` compared with its first label. Legacy
`getFile(title)` was used for a photo of the player, so it becomes `askImage(title)` (#608), which the player answers
with an image file or the camera (`SX_FILE_PHOTO`, owner decision 2026-10-05; a cancelled chooser gave null, which
askImage does not); `chooseFile()` (#604) stays behind `--accepted=chooseFile`.

### Universal conversions decided by the owner (2026-10-05)

- The legacy online service: `send(key, value)` and `receive*(key)` keep values in the package's storage, and
  `isConnected()` is true (`SX_ONLINE_STORAGE`); `sendImage(reference)` saves the photo reference under a generated code
  that it returns, and `receiveImage(code)` loads it.
- Files: `new File(path).exists()` reads the package's files at conversion time, a literal path as `true` or `false` and
  a computed one as a lookup in the package files below its fixed beginning; a program (`.exe`) never exists, and
  `getDataFolder()` is the package root (`SX_FILE_EXISTS`, `SX_DATA_FOLDER`). Deleting the file of a photo the script
  took clears the reference (`SX_PHOTO_DELETE`). `useFile(path)` plays an audio file (`SX_USE_FILE_AUDIO`) or a video
  (`SX_USE_FILE_VIDEO`, a WMV, AVI, MPEG, FLV, or MOV file as an MP4 that the corpus driver converts); any other
  file, such as a device control program, stays reported as a program a package cannot start (`SX_EXTERNAL_PROGRAM`).
  A device switch program (`"SwitchBox.exe 7 ein".execute()`, a command ending with `on`, `ein`, `an`, `off`, or
  `aus`) becomes a persistent permanent button, "Power: ON" or "Power: OFF", which replaces the previous one; the
  button ID is a `global` in `main.tease` (`SX_SWITCH_BUTTON`).
- Media paths: a literal image or sound path names the file the package holds when the legacy player found it ignoring
  letter case, around spaces, or below a repeated folder name (`SX_MEDIA_PATH`); several files that match apart from
  case get a note (`SX_MEDIA_PATH_CASE`). A MIDI file becomes an MP3 rendered at conversion (fluidsynth with a General
  MIDI soundfont, then ffmpeg).
- Pacing: legacy `show()` displayed its text at once and a `wait()` right after it set the timing, so text shown
  directly before a wait becomes `say …, instant`; other text keeps TeaseScript's reading time (converter owner,
  2026-10-05).
- Repeated text: every legacy `show()` and question replaced the one text display, so authors repeated a message to
  extend it, while the Player keeps earlier messages. A `say` that repeats the text just before it on the same straight
  path, with only waits, images, and sounds in between, says only what it adds, and one that only repeats it is
  dropped, joining the waits around it (growing dots become one text and one wait). Texts compare with whitespace and line breaks collapsed and without the earlier text's final punctuation,
  the repeat ends at a word boundary, and only literal text and interpolations of identical expressions compare. Any
  other statement, a nested block, or a call in an image or sound starts over. The report counts the dropped,
  shortened, and kept texts (`repeatedText`; `SX_REPEATED_TEXT_DROPPED`, `SX_REPEATED_TEXT_SHORTENED`,
  `SX_REPEATED_TEXT_KEPT` where the interpolated values differ).
- Launch markers: the legacy player saved `<script>.launch.firsttime`, `.lasttime`, and `.nb` at every script start
  (`FullScript.groovytemplate`); a script whose markers the package reads saves them first (`SX_LAUNCH_MARKERS`).
- Java text: `String.format` with `%s`, `%d`, `%f`, a `0` flag, a width, and a precision becomes interpolation,
  `padStart`, and a fixed-decimals helper (`SX_FORMAT`); `tokenize()` becomes a helper that splits at any delimiter
  character without empty parts.
- Control flow: `for (;;)` becomes `while true`; `++x` and `--x` inside an expression change the variable before the
  statement; a declaration whose value cannot convert keeps its variable with a neutral value of its type.
- Branches: a switch case for a value that no code of the package stores under the switched key never runs; its chain to
  a missing script becomes `exit` (`SX_UNREACHABLE_BRANCH`). A chain to a script of the legacy desktop player
  (`system/...`, `welcome`, `exit`) ends the session (`SX_DESKTOP_SCRIPT`).
- The legacy player profile: the distribution's intro saved the player's name and gender, and its options the toys and
  clothes the player owns; a package that reads such keys and never saves them asks the missing ones once at the start
  of `main.tease`, with the distribution's questions, and saves them under the legacy keys (`SX_LEGACY_PROFILE`).
- `show("")` only cleared the legacy text area and is dropped; an empty or blank image path clears the image.
- Lists join with TeaseScript `+`, `+=`, and `addAll` (#609); the concatenation helper remains only for ranges. A right
  side not proven to be a list or one element (`[] + impl` with a parameter) goes through a generated helper that
  returns a list as it is and wraps any other value, also null, as Groovy appended it (63 corpus sites, 26 in Toy).

- Actions a browser cannot do (owner decision 2026-10-05): questions and notices that the importer adds come from a
  global speaker `system` (title "System"), declared once in `main.tease` or in a lone script. Device commands kept
  in variables such as `estim_start` or `lock_finish`, and `switchbox_on`, become persistent permanent buttons with the
  device's state (`Estim: RUNNING`, `Lock: LOCKED`, `Power: ON`); `openCdTrays()` shows `CD tray: OPEN` until clicked
  (`SX_DEVICE_STATE`, `SX_SWITCH_BUTTON`). `System.getProperty("user.name")`, `"user.home"`, and the player's folder are
  asked once and saved; a network hardware address becomes a random ID made once; `useEmailAddress()` asks the email
  address once and says that no email is sent (`SX_OS_INFO`, `SX_EMAIL`). Text files that the package writes only
  through a `File` of one path keep their text in storage under `file:` and the path (`SX_STORED_FILE`); `useFile()` of
  a text file shows it as prose (`SX_FILE_VIEW`); a walk through a home, Downloads, or Documents folder asks for a photo
  (`SX_HOME_PICTURES`); walking the installed scripts folder gives a notice and ends the session (`SX_SCRIPT_MANAGER`);
  `delete()` clears the reference stored under the path and `mkdir()` is dropped (`SX_FILE_DELETE`,
  `SX_FOLDER_CREATE`). A packaged program gives a notice, and a puzzle program a solved/not solved choice
  (`SX_EXTERNAL_PROGRAM_NOTICE`). An online read or a function that talks to an online service gives a notice with the
  request, secret query values hidden, and reads empty or returns as failed (`SX_ONLINE_REQUEST`). Java network
  settings are dropped (`SX_JVM_SETTING`), and a function that reads photo pixels to answer yes or no answers false
  (`SX_PHOTO_PIXELS`). A try block without fallible calls runs without its catch (`SX_TRY_WITHOUT_CATCH`).

## Remaining gaps by workaround class

What still blocks conversion, ranked by whether current TeaseScript can express it. Counts are root errors or blocked scripts in default mode after
the merge of `main` at `242ada7a`; the column "Before" gives the count at the `dict` round.

**Expressible in current TeaseScript (importer work).** The language already has a clean form.

| Gap | Before | Now | Clean form |
| --- | --- | --- | --- |
| Conditional expressions (`?:`, Elvis) inside larger expressions and conditions | Toy about 40 | 0 | a temporary computed before the statement, with earlier parts first (done) |
| Inputs on the right of `&&`/`\|\|`, `&`/`\|` with effects on the right | Toy about 10, distribution 2 | Toy 1 (`goodToy & ...`, left side not proven boolean) | temporaries and an `if` (done) |
| Collection methods with closures inside larger expressions; `times`, `isEmpty`, `sort` | Toy 36 of 59 dynamic calls | Toy 27 of 53, all on receivers the importer cannot prove to be lists | loops (done where the receiver is a list or range) |
| Collection methods on unproven receivers: closure parameters (`texts.collect`), persona data (`DOMME.sessions.forEach`), map entries (`toys.any { s, t -> }`), plus `each`, `sum`, list appends | (in the row above) | Toy 27 dynamic calls, 7 `each`, 4 `sum`, 3 appends, 2 other | a loop once inference proves the list, or a key loop with a lookup for a dict |
| Menus built inside larger expressions | Toy 6 | Toy 2 (option lists not proven) | the menu into a temporary first (done) |
| Variables that hold values of two types (valid dynamic Groovy) | DisciplineClinic 8 | 0 | an empty-text placeholder starts with the later type's empty value (done, 5); one variable per type in straight-line code (done, none in the corpus); otherwise a declared union (done, DisciplineClinic 3, Toy 1; #530) |
| Closures that capture local state | Toy 10 | Toy 10 | explicit state parameters: feasible for 2 local helpers that call sibling local closures (`suck`, `suckBeat`); the other 8 are stored in registries, returned, or evaluate persona expressions |
| Method pointers; calls of closures kept in data (`it.cond()`, `e.event.func(...)`) | Toy 3 and 4 | Toy 3 and 5 | action IDs with a dispatcher |
| Persona data files with Groovy expression strings | Toy | Toy | data converted at import time |
| Behaviour kept as data with code strings evaluated at runtime (`Eval.me`, expression strings in plan or config records, Toy's 9 session plans with 26 expression strings in `images/toy/domme.groovy`, run by `sessionPlay`) | Toy | Toy | owner decision 2026-10-05: native TeaseScript, in per-unit patches and in converter rules where the pattern is general: each behaviour an ordinary function, its conditions plain `if`s, and the choice among them a small selection list or `switch` (Toy: a function per session, and session choice as a list of conditions with weights). Eval is not emulated with a lookup table of expression texts |
| `instanceof`; `asBoolean()`; `Math.floorDiv` | Toy 1 each | Toy 1 each | `is` (#530); Groovy truth; `floor(a / b)` |

**Workaround possible, but a hack.** Works with current TeaseScript but differs from the intended behavior; the
accepted implementation is still wanted. Each workaround the importer emits carries a note that names it
(`SX_REGEX_WORKAROUND`, `SX_LOCALE_WORKAROUND`).

| Gap | Corpus | Workaround | What the workaround loses |
| --- | --- | --- | --- |
| `askBooleans` | blocked 8 scripts | emitted since 2026-10-05 (see Accepted but not implemented): one yes/no `choose` per item, then a confirmation | one form with every option; changing an earlier answer |
| `showPopup` | blocked 4 scripts | emitted since 2026-10-05: `say` plus `showButton "OK"` | the popup presentation |
| Media selected by tags (M1), including Toy's imagery folders with tag files | Domme3 3, Toy imagery | emitted since 2026-10-05 for counts of a listed images folder: the counts at conversion time | packs added after conversion |
| Regular expressions | Toy 2 converted, `tokenize` and Java patterns left | emitted: a loop over the parts between spaces for `split(/\s+/)`, and one removing each `<...>` for `replaceAll(/<[^>]*>/, "")` | readability, and exactness for other whitespace and a leading space |
| The player's language (`Locale.getDefault().getLanguage()`) | distribution 2 converted | emitted: English, `"en"` | the font configuration offer for other languages |

**No reasonable workaround.**

| Gap | Corpus | Why |
| --- | --- | --- |
| Desktop and Java APIs: `java.time` formatting and zones (5), files (4), `java.util.Random` (4), JSON and Base64 (2), `Eval.me`, `java.util.function.Function`, `System.getProperty`, OS processes (1 each), Java objects, the Cornertime exchange | Toy 19 of its 53 dynamic calls and 8 constructors, distribution | Outside the product boundary by design (see Legacy baggage). `Random.nextInt(n)` alone could become `randomInteger()`, without the seed. |
| Legacy bugs (variables nothing assigns, helpers without the script host) | Domme3 3 and 7, DisciplineClinic 1 | Need an author's repair; reporting them is correct. Six more sit in functions nothing calls and are notes now. |

### Left after the step-4 rounds (corpus2-merged, 2026-10-05)

At converter `884339a3`/`a2fadae4`, 2,249 root errors remained in 103 of the 209 merged units; 105 units played to
the end. The classes below are what the last round deliberately left; counts are TODO sites and units.

| Class | Sites, units | Why it stays |
| --- | --- | --- |
| In-memory image composition (`ImageIO`, `BufferedImage`, `Graphics.drawImage`, `setImage(bytes, 0)`) | 546, about 21 | A language gap; waits for an owner decision on layered scenes or composition. Unlocks about 7 units alone. |
| Closures that capture local state | 84, 9 | TeaseScript has no closures; a rewrite with explicit state is per unit. |
| `try`/`catch` around fallible calls (number parsing, files, network, programs) | part of 56, 27 | No exceptions; only try blocks without fallible calls run without their catch. |
| Questions in other positions (arguments with effects, `?:`) | about 25, 6 | Only `while` conditions are rewritten; an `if` already computes its guarded question first. |
| Nullable values that flow through unproven values (`+` of possible text, ternaries of nullable loads, loads tested for null elsewhere) | compile errors in about 10 units (Escape, OwlSays, gunfighter, questionnaire, scatslut, ashleyYHBS, spinthebottle, MatchDares, Stay, fapioh) | Each case needs its own type flow; returned parameters and function locals are typed now. |
| The action dispatcher returning values of several types | RileyReid | Needs a declared union result type, which the IR does not write. |
| A closure declared inside a top-level block (`if (estim) { def shock = { ... } }`) | NoPeeking 9 | The prepass finds closures at the top level only. |
| Per-unit object models and data | Toy 456 compile errors, DungeonTrials 84, Farkel 28 | Patches, not rules. |
| Units with many small idioms on unproven receivers | ScarlettsBlackmail 60, SpankingParty 32, OwlGames 24, Bondage_Fun beyond its switch | Each site needs its own proof of type. |
| Dynamic code (`Eval.me`, `inspect`, per-script property objects) | 81, 9 | Patches. |
| File metadata and other system calls without a decided substitute (`lastModified`, `traverse`, threads, zip, sockets) | about 20, 15 | Outside a browser package; reported as TODO. |
| Legacy bugs (names nothing defines, `assert`, `throw`) | 31, 9 | Correctly reported. |

### Third-round findings

Smoke runs that go further surface problems the static gates do not:

- **Groovy lists grow on a write past their end.** DisciplineClinic fills `assignmentArrayList = []` by position
  (`assignmentArrayList[i] = [...]`), which Groovy grows, padding with null; a TeaseScript position must exist
  (`TSR025`). The importer appends at the end with a note (`SX_LIST_GROWTH`, 2 sites); a position beyond the end
  stays different.
- **Accepted list `sort()` was missing on `main`.** V30 §16 lists `items.sort()`; `main` compiled it but its runtime
  rejected the method (`TSR016`) until #546, so the gate stood in for it (1 Toy site).
- **`main` compiled method calls its runtime did not implement.** Text operations such as `trim()` passed the compiler
  and failed only at runtime (`TSR016`) until #518 merged, so only the smoke runs caught them.
- **Unreachable legacy code blocked whole scripts.** Test functions nothing references held class loading and reads of
  never-assigned variables (DisciplineClinic's `testAllImages` and `test`); they are notes now. Which functions are
  unreferenced has to come from the generated program together with the legacy code: module loads and setups run
  module code that no legacy name refers to, and an unconverted caller still calls.
- **Variables reused for several types cross function boundaries.** DisciplineClinic's `dialog` and `response` are
  written by many functions, each assigning before it reads, so a split by type would need flow analysis across calls,
  `break`, and loops; with #530 they get declared unions (see the union findings above). Five empty-text placeholders
  later hold lists or yes/no answers and convert with a note.
- **Isolated runs still fail on settings the introductions save** (Domme3 7 scripts, DisciplineClinic `WaitRoom`):
  Groovy compared a missing setting as null, which TeaseScript comparisons reject, and `main` now also rejects a missing
  setting stored in a Groovy `int` when it is read.

### Large-corpus ranking (corpus2)

The 289-package corpus ([`CORPUS-INVENTORY.md`](CORPUS-INVENTORY.md#large-corpus-corpus2), 2026-10-04) changes the
ranking above. Of its 8,512 root errors, about 4,770 (142 packages) are legacy baggage: the old online service
(`send`/`receive*`, 2,000 sites in 33 packages), in-memory image composition shown with `setImage(bytes, 0)` (Java
`BufferedImage`, `ImageIO`, `drawImage`; 30–40 packages), files (`new File` in 70 packages), HTTP, OS processes, and
`try`/`catch` around them. About 2,740 (131 packages) are importer work, led by list and text methods on receivers not
proven to be lists or text (about 1,500, such as `contains`, `add`, `count`, `join`), `<<` on such receivers (226 in 24
packages), list methods without a direct form (`add(index, value)`, `collect()`, `pop`), menus from computed option
lists (117), typed and empty `for` loops (93), and `list - value` with an unproven value (75). About 490 (64 packages)
need workarounds, mostly regular expressions in `replaceAll` (239) and `String.format` (104); about 370 (36 packages)
are legacy bugs, such as 144 calls of functions no file defines. File transfers remain the largest pending blocker (190
otherwise clean scripts), then `global function` (118), `askBooleans()` (33), `openUrl()` (15), and `showPopup` (14).

Patterns the four-package corpus did not show: null-start numbers read in functions block about 20 otherwise clean
scripts (`TSV043`, `TSV039`; the empty-list decision covers only lists); function parameters have no type, so
`list -= value` on a parameter stays numeric and a variable widened by `parameter / 30` stays an integer for the
compiler (smoke failures `TSR027`, `TSR058`); `for (c in text)` iterated characters (`split("")`); an empty computed
`getString` default failed `askText` (`TSR052`, no longer since #618); `isInteger()`, `isNumber()`, and `isFloat()` text checks (8, 6, and 3
packages) have no direct form.

## Open importer work

Found while evaluating the proposals, besides the importer work listed above; none needs a language decision:

- **Menus over a union variable:** the option list of a menu is proven from Groovy types at conversion time, which
  cannot see that `dialog` holds a list right after `dialog = ["Back"] + mistressArray`; `main` would narrow it there.
- **Safe navigation:** `x?.size()` converts like `x.size()`, which fails where Groovy gave null (0 corpus sites).
- **Concatenation that starts with possibly null text:** `dialog + count + ...` with `dialog: string?` keeps a numeric
  `+` for its first pair, which the type pass rejects (1 `Punish` site).
- **Groovy type inference is per file and flow-insensitive:** a name used in two functions shares one type set, which
  hides lists (the Toy appends above) and makes `size()` on values of unknown type look like possible maps. The
  never-assigned-variable check is name-based in the same way. Local closure results now have types, also across the
  script and its modules, but closure parameters stay unknown, which keeps most remaining Toy collection methods
  unconverted.
