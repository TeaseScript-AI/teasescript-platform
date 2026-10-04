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
4. **Compiler-clean** — the generated script passes the real compiler. The report also compiles a copy in which
   accepted-but-unimplemented TeaseScript (`run`/`end`, `switch`, ...) is replaced by placeholder host calls;
   a file that is clean only in that copy is blocked by TeaseScript implementation work, not by importer output.
5. **Runnable/verified** — relevant execution paths have actually run without unresolved runtime behavior. The
   report's smoke run (`report --run`) executes one deterministic path per package entry in the real runtime,
   following script transfers with shared storage, and runs scripts no entry reached in isolation. It catches runtime
   type errors the compiler cannot, but one path is evidence, not proof of equivalence.

The POC embeds transitively required helper functions into each generated `.tease` file because package-library linkage
is not yet available. That is a current migration strategy, not a language requirement. Auxiliary Groovy classes with
fields are not duplicated automatically because fields may carry shared state; the importer reports
`SX_HELPER_SHARED_STATE` instead.

## Existing TeaseScript is sufficient

These corpus patterns looked like gaps but are importer work; the generated form is ordinary TeaseScript, or accepted
TeaseScript that the compiler gate replaces with stand-ins until it is implemented:

| Legacy pattern | TeaseScript form |
| --- | --- |
| `"Hi " + name` (string `+`) | `"Hi ${name}"`; TeaseScript `+` is numeric only |
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
| `getString` / `getFloat` / `getInteger` with a default | `say text` plus `askText default: value` / `askNumber default: value`; `askInteger(text, default: value)` |
| `Calendar.getInstance().get(Calendar.HOUR_OF_DAY)` and other fields | `getDateTime().hour`, with month and weekday-number conversions |
| `getTime()` (Unix seconds) | `getTimestamp().toSeconds()`, a fixed moment (#532) |
| `Calendar.getInstance().get(Calendar.DAY_OF_YEAR)` | `(getDate() - toDate("${getDate().year}-01-01")).days + 1` (#532) |
| `new Date().format("yyyy-MM-dd")`, `new Date().format("HH:mm")` | `getDate().toISO()`; `getTime().formatTime()`, with a note (#532) |
| `list + other`, `list << x`, `list.push(x)`, `list += other` | a generated concatenation helper and `add()` |
| a map used as a lookup table: `[(KEY): v]`, `map[key]`, `containsKey`, `keySet`, `values`, `size`, `put`, `remove`, `clear`, `each { k, v -> }` | a `dict` (#536): `dict{ [KEY]: v }`, `map[key]`, `contains`, `keys`, `values`, `length`, `map[key] = v`, a guarded `remove`, `clear`, `for k in map` |
| a map with fixed names that gains fields later, and its `clear()` | an object literal that declares every used field (null when added later); `clear()` reassigns it with null fields |
| `list.remove(index)`, `list.remove(value)` | `list.removeAt(index)`, also as a value; `list.remove(value)` with structural equality (#517) |
| Groovy string methods (`size()`, `trim()`, `toUpperCase()`, `replace()`, `split()`, ...) | text operations (`text.length`, `trim()`, `uppercase()`, ...; PR #518) |
| `list.join(separator)`, `"${list}"` | `list.join(separator)`; `"[${list.join(", ")}]"` (PR #518) |
| `def x` / `int x` without initializer | `let x: string? = null` (or `string[]?`, ...), and `0` or `false` for primitives |
| `def x = 0` that later holds a fraction | `let x = 0`, which widens to `number` by itself (#504 option B; the compiler gate writes `: number` until #526 lands) |
| `def x = "a"` that is later set to `null`; `def x = null` | `let x: string? = "a"`; `let x = null`, which keeps the type of its first value (#504 decision 1a) |
| `int x = 7 / 2`, `int x = f()`, and later values stored in `x` | `let x = toInteger(7 / 2)`, `let x = toInteger(f())` (Groovy stores 3); `int x = loadInteger(k)` becomes `let x: integer = load k` |
| `new Boolean[n]`, `x in list`, boolean `&`/`|` | a generated list helper, `list.contains(x)`, `and`/`or` with a side-effect-free right side |
| `System.exit(0)` | `exit` (the Player stays open) |
| `int t = showPopup(m)` (seconds until closed) | `getTimestamp().toSeconds()` before and after `showPopup m`, in whole seconds |
| `showButton(text, s)` used as a value (seconds until the click) | `(showButton text, timeout: s) / 1 s` (#531) |
| `showButton(text, 0)` (the button stayed for its 10 ms safety margin; the result was 0) | `showButton text, timeout: 10 ms`, with a note; a used result is `0` |
| `getImage(message)` (webcam picture path or null) | `takePhoto()`, with a note (V30 §33) |
| `playBackgroundSound(null)`, `stopSoundThreads()` | handles of the async sounds kept in a list and stopped by a generated helper |
| `f(x++)`, `continue` in a C-style `for`, `return` inside `each()` | `f(x)` then `x += 1`; the update step before each `continue`; `continue` |
| `while (playBackgroundSound(s) \|\| true)` | `while true` with the call as its first statement |
| `sleep(ms)`, `waitWithGauge(s)` | `wait ... ms`, `timer ...` |

## Semantic differences

The importer converts these with an inline `NOTE` or reports them when it cannot prove equivalence:

- `show()` replaced the single text area; `say` appends to a transcript. `show(null)` only cleared the text, so it is
  dropped. Input functions showed their text like `show()`; a `null` text kept the current text.
- `say` text is message markup: legacy `*emphasis*` renders as formatting and URLs become links. Line-start list,
  heading, or quote markers and backslash escapes get a `NOTE` (`escapeMarkup()` keeps text literal).
- Single-field input prefilled its field with the default, also when the default was null (the field showed "null")
  or empty. TeaseScript prefills with `default:` but rejects a null or blank default when the input opens, so a
  default that may be either gets a note (`SX_INPUT_PREFILL`); a literal empty or null default is dropped. A text
  default that is not text becomes text (`"${level}"`), and a list becomes `"[${list.join(", ")}]"`, as Groovy printed
  it; a map default is reported (`SX_INPUT_PREFILL_VALUE`). A default
  computed with side effects stays manual work for text and number input (`SX_INPUT_PREFILL_EFFECT`): legacy computed
  it before showing the question, and the converted question is a `say` before the input.
- Groovy turned a list into text as `[a, b]`; TeaseScript `${list}` selects one element and `say list` shows a quoted
  notation (PR #515). A list of text, numbers, and booleans becomes `"[${list.join(", ")}]"`; other lists are reported
  (`SX_COLLECTION_TEXT`). Groovy printed a whole `double` as `2.0`, where `${...}` shows `2`. Groovy `join()` had no
  separator, so it becomes `join("")`, as TeaseScript's default separator is `", "`.
- Text operations follow Unicode code points and full case mapping (PR #518): lengths and positions count code points
  where Java counted UTF-16 units, `trim()` also removes non-breaking spaces, and `uppercaseFirst()` turns a leading
  `ß` into `SS`. A literal with a character outside the Basic Multilingual Plane, such as an emoji, gets a `NOTE` on a
  length, `substring`, `indexOf`, or `lastIndexOf` (`SX_TEXT_CODE_POINTS`); text known only at runtime does not. Java
  `split()` drops trailing empty parts and TeaseScript `split()` keeps them (`NOTE`). Groovy `join()` printed nested
  lists and maps, which the accepted `join()` rejects, so a list known to hold them is reported (`SX_LIST_JOIN`).
- Legacy `save(key, null)` deleted the key and every dotted sub-key (`key.*`), and generic `load()` decoded a stored
  string `"null"` as null. Generated reads therefore compare with `null` explicitly, which treats a stored null and a
  missing key alike; `load ... default` is not used because it would keep a stored null (see the specification
  questions below). TeaseScript keys are flat, so saving a scalar over a former list/map key leaves the old sub-keys.
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
- A Groovy map read a missing key as null; a dict reports it (#536). `map[key] == null` and a lookup used as a
  condition therefore test `contains(key)` first, and `remove(key)` of a key that may be missing becomes
  `if map.contains(key) { map.remove(key) }`; any other lookup of a missing key fails where Groovy continued with null.
  Groovy kept a key's type, so `1` and `"1"` were different keys, while dict keys are text: number keys become text
  with a note (`SX_DICT_KEY_TEXT`), also a key of unknown type in a dict built with number keys. A repeated literal key
  kept its first position and its last value, which the dict literal merges with a note (`SX_DICT_DUPLICATE_KEY`). A
  map whose values have different types, or a runtime key on a map not held in a variable, is reported
  (`SX_DICT_VALUE_TYPE`, `SX_DYNAMIC_MAP_ACCESS`).
- Closures kept as values become action IDs called through one dispatcher. Unlike Groovy, the dispatcher ignores extra
  arguments and returns null for an unknown action; Groovy failed in both cases.
- A `switch` case Groovy tested with `isCase` keeps its meaning only where the case value shows it: equality for
  scalars, membership for lists, bounds for ranges (tested in both directions when a bound is known only at runtime).
  Other case values (classes, patterns, closures, values of unknown type) are reported.
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
  Groovy did: `t = toInteger((showButton "Done") / 1 s)`, 25 sites in Domme3. A literal zero timeout kept the legacy
  button for its 10 ms safety margin and returned 0, which the conversion keeps (`SX_BUTTON_TIMEOUT`); a timeout that
  is zero only at runtime fails in TeaseScript (#531), and a negative literal, which failed in legacy too, is reported.
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

## Type enforcement findings (#519)

`main` rejects a value of another type than a variable's declared or inferred one (`TSV041`), and only `integer`
widens to `number`. The importer follows the compiler's static types over the generated program, under the accepted
rules: the result types of PRs #515 and #518, and the #504 decisions that a variable starting as `null` keeps the type
of its first value (1a) and that an unannotated integer widens to `number` by itself (option B, built in #526). Where
`main` needs another annotation, only the compiler gate writes it. Measured on the four corpus packages:

- **Variables that change type: 8, all in DisciplineClinic.** Four start as an empty-text placeholder and later hold
  a list (`def lineArray = ""`, then `lineArray = ["I need discipline, ...", ...]`, also `mantraArray`,
  `lessonArray`, `adviceArray`); three reuse an answer variable for text and then booleans or menu positions
  (`def response = ""`, later `response = getBoolean(...)` and `response = getSelectedValue(...)`); and `dialog` holds
  the menu text and then the option list (`dialog = ["Back"] + mistressArray`), now seen because helper and function
  results have types. Without union types they are reported at the declaration (`SX_TYPE_CHANGE`) and need separate
  variables. That menu and one in OffenseSelect (whose option variable also holds a number) stay unconverted
  (`SX_DYNAMIC_CHOICE_OPTIONS`). The other three packages reuse variables only with compatible types.
- **Integer/number friction, resolved by #504 option B:** 18 declarations (Domme3 3, DisciplineClinic 9, Toy 6) start
  with a whole number and later hold a fraction (`def spankTempo = 1`, later `spankTempo = 0.75`), and 14 more receive
  a numeric `choose` result, which `main` still types as `number`. Under #519 alone each needed `: number`, which takes
  a whole-program view of every later assignment. The output now writes none; until #526 and PR #515 land, the
  compiler gate writes `: number` on 42 declarations (counted as the pending capability "number annotations").
- **Optional types:** one variable starts with text and is later set to null (`let block: string? = "begin"`).
  Variables that start as `null` are no longer annotated from Groovy's number evidence, which cannot tell an integer
  from a fraction; they keep the type of their first value.
- **Groovy integer declarations coerce:** an `int` stores whole numbers, so every value not known to be an integer
  truncates with `toInteger`, 55 sites (25 of them `showButton` seconds stored in Domme3's `int t`), and the 52 `int`
  declarations initialized from storage become `let x: integer = load k`, which checks the stored value.
- **Index rule:** a variable that may hold a fraction cannot index a list (#504 option B); such an index truncates
  with `toInteger`, as Groovy's `getAt(Number)` did. No corpus site remains once null-started variables are inferred.
- **Importer defects the checks exposed:** 13 Toy `lines += [...]` appends were emitted as numeric `+=` because the
  per-file Groovy type inference could not prove the list; the type pass now appends with the concatenation helper,
  and reports an append whose value may be a list or one element (`SX_LIST_CONCATENATION`). A text key on a receiver
  of unknown type was emitted as list indexing, which `main` now rejects; it is reported as map access.
- **Coming with #526:** an unannotated parameter takes its default's type, so a legacy default such as `amount = 1`
  that callers pass fractions would need `amount: number = 1`; 101 generated functions have defaults, and `main` does
  not compile typed function signatures yet.

## Dict findings (#536)

The owner's `dict` type replaced the importer's objects-as-dictionaries working syntax. Converting Toy's lookup tables
showed:

- **One value type fits the corpus:** no lookup-table map mixes value types (`SX_DICT_VALUE_TYPE` 0). The one mixed
  map, Toy's `sessionParams` (booleans, text, numbers), uses fixed names and is a record, as #536 anticipated.
- **Missing keys need guards:** Groovy read a missing key as null. 10 Toy lookups only test presence or truth and
  become `contains` tests, and 5 `remove` calls on keys that may be missing need `if map.contains(key) { ... }`. The
  deferred default lookup form would shorten these and `toynames[t] ?: t.replaceAll("_", " ")` (1 site, which also
  needs a regular expression).
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

Evidence for owner evaluation, ordered by corpus weight. Choices from runtime lists (C1–C3, PR #515), text
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
  null (`askInteger(dialog, default: playerLevel)`). TeaseScript rejects a null default when the input opens, so a
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

## Legacy baggage

Reported for manual work and intentionally not reproduced: reflection and `GroovyClassLoader` outside resolved
package helpers, `java.io.File` access and directory listing other than a recognized module loader,
`System.getProperty`, OS processes (Toy's speech output), the file picker `getFile` (no corpus site; accepted
`chooseFile()` would be its counterpart), `openCdTrays`, `useEmailAddress`, `useFile`, the old online
`send`/`receive` service, and `try`/`catch` around desktop APIs. The webcam `getImage` converts to `takePhoto()` (see
above; the Player side is in draft PRs #475 and #516). `Locale.getDefault()` serves the localization question above.
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

The importer emits these accepted forms although the current compiler rejects them; the compiler gate counts them
separately: `run`/`end`, `switch` (#528, PR #529), `showPopup`, the `showButton` timeout and elapsed result (#531),
`askInteger`, `askBooleans`, date and time (`getDateTime()`, `getDate()`, `getTime()`, `getTimestamp()`,
`toSeconds()`, `toISO()`, `formatTime()`, `toDate()`, `.days`; #532), `openUrl`, `round`/`floor`/`ceil` and the
conversions (#518), text operations and `join` (#518), `choose` with list options (#515), `takePhoto()` (camera,
#475), integer widening (#504 option B, #526), for which the gate writes `: number`, and `dict` (#536). `run`/`end`
dominates: it blocks 21 otherwise compiler-clean corpus scripts.

## Open importer work

Found while evaluating the proposals; none needs a language decision:

- **Toy menus built inside larger expressions,** whose `collect` cannot move before the statement.
- **Toy imagery** (outfit folders with tag files) could map to proposed media tags once tags are ingested from those
  files.
- **Regular expressions** in `replaceAll` and `split` remain manual work (Toy).
- **`load "key" default value`** is now exact for legacy read-then-default code, because `save null` removes the key on
  `main` (#484); the importer does not use it for that pattern yet.
- **Groovy type inference is per file and flow-insensitive:** a name used in two functions shares one type set, which
  hides lists (the Toy appends above) and makes `size()` on values of unknown type look like possible maps. The
  never-assigned-variable check is name-based in the same way.
