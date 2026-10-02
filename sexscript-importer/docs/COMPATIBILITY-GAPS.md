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
   accepted-but-unimplemented TeaseScript (storage, `run`/`end`, `switch`, ...) is replaced by placeholder host calls;
   a file that is clean only in that copy is blocked by TeaseScript implementation work, not by importer output.
5. **Runnable/verified** — relevant execution paths have actually run without unresolved runtime behavior.

The POC embeds transitively required helper functions into each generated `.tease` file because package-library linkage
is not yet available. That is a current migration strategy, not a language requirement. Auxiliary Groovy classes with
fields are not duplicated automatically because fields may carry shared state; the importer reports
`SX_HELPER_SHARED_STATE` instead.

## Existing TeaseScript is sufficient

These corpus patterns looked like gaps but are importer work; the generated form is ordinary TeaseScript:

| Legacy pattern | TeaseScript form |
| --- | --- |
| `"Hi " + name` (string `+`) | `"Hi ${name}"`; TeaseScript `+` is numeric only |
| Groovy truthiness (`if (name)`, `!count`) | explicit comparisons chosen from inferred types (`name != ""`, `count == null or count == 0`) |
| ternary / Elvis | `if` statements with one assignment or statement per branch |
| implicit last-expression return | explicit `return`, also in the last statements of `if`/`else` branches |
| `list[getRandom(list.size())]`, `list[-1]` | `list.random`, `list.last` / `list[list.length - n]` |
| `collect`, `findAll`, `find`, `any`, `every`, `sum`, `times`, `eachWithIndex` with closures | ordinary `for` / `repeat` loops |
| closures stored in data or passed as callbacks | string action IDs (the forwarded function's name) plus one generated dispatcher function |
| `return new Object() { fields; methods }.main()` | globals, functions, and the entry method's statements as the script flow |
| runtime-loaded `metaClass` mixin modules (`Eval.me` over a script directory) | the injected methods as functions and direct calls to each module's load and setup function |
| a `break` in the middle of a `switch` case | break-free case paths |
| switch cases that are variables or lists | an `if`/`else if` chain with `==` or `contains()` |
| `getSelectedValue(text, [...])` | `say text` plus `choose 0: ..., 1: ...` (numeric labels return the index) |
| `getBoolean(text, yes, no)` | `say text` plus `(choose yes: ..., no: ...) == "yes"` |
| `getString` / `getFloat` | `say text` plus compact `askText` / `askNumber` |
| `Calendar.getInstance().get(Calendar.HOUR_OF_DAY)` and other fields | `getDateTime().hour`, with month and weekday-number conversions |
| `list + other`, `list << x`, `list.push(x)` | a generated concatenation helper and `add()` |
| `def x` / `int x` without initializer | `let x: string? = null` (or `string[]?`, ...), and `0` or `false` for primitives |
| `new Boolean[n]`, `x in list`, boolean `&`/`|` | a generated list helper, `list.contains(x)`, `and`/`or` with a side-effect-free right side |
| `System.exit(0)` | `exit` (the Player stays open) |
| `sleep(ms)`, `waitWithGauge(s)` | `wait ... ms`, `timer ...` |

## Semantic differences

The importer converts these with an inline `NOTE` or reports them when it cannot prove equivalence:

- `show()` replaced the single text area; `say` appends to a transcript. `show(null)` only cleared the text, so it is
  dropped. Input functions showed their text like `show()`; a `null` text kept the current text.
- `say` text is message markup: legacy `*emphasis*` renders as formatting and URLs become links. Line-start list,
  heading, or quote markers and backslash escapes get a `NOTE` (`escapeMarkup()` keeps text literal).
- Single-field input had a pre-filled value; TeaseScript input has none, so the player types it (`SX_INPUT_PREFILL`).
- Groovy turned lists into text as `[a, b]`; TeaseScript interpolation shows one random element (`SX_COLLECTION_TEXT`).
- Legacy `save(key, null)` deleted the key and every dotted sub-key (`key.*`), and generic `load()` decoded a stored
  string `"null"` as null. Generated reads therefore compare with `null` explicitly, which treats a stored null and a
  missing key alike; `load ... default` is not used because it would keep a stored null (see the specification
  questions below). TeaseScript keys are flat, so saving a scalar over a former list/map key leaves the old sub-keys.
- Groovy maps are shared references; TeaseScript records copy. A field write through a copy gets a `NOTE`
  (`SX_SHARED_MAP_WRITE`). Picking from an empty list returned null in Groovy and fails in TeaseScript.
- Groovy lists and maps alias by reference; TeaseScript composite values copy (ADR 0014). Groovy `def` may change type.
- Java `Math.round` rounds `.5` toward positive infinity; TeaseScript `round()` does not specify ties yet.
- Java date pattern formatting (`new Date().format("yyyy-MM-dd")`) has no equivalent; typed `date`/`datetime` values
  compare and store directly, and `formatDate()`/`formatTime()` cover display (`SX_DATE_FORMAT`).
- Rewrites that move evaluation (ternary branches, input prompts) are applied only when the expression is not behind
  `&&`/`||`/`?:` and nothing with side effects is evaluated earlier in the statement; otherwise the statement is
  reported (`SX_CONDITIONAL_POSITION`, `SX_PROMPT_POSITION`).

## Capability candidates

Evidence for owner evaluation, ordered by corpus weight:

1. **Choice from a runtime list.** DisciplineClinic builds menus from data (`getSelectedValue(dialog, ["Back"] +
   offenseTextArray)`), and Toy builds its menus from registered options; 23 corpus calls. Compact `choose` needs every
   option in the source, and `choose someList` presents one random option (visible-text list conversion). For a
   bounded package a helper that branches on the list length (`choose 0: rows[0].label, 1: rows[1].label, ...` per
   length) works, so this is an ergonomic gap rather than an inexpressible one; menus over data are ordinary script
   logic, which makes it the strongest candidate.
2. **Text utilities.** Toy measures typed lines (`line.size()` for typing speed) and transforms input text; 13 corpus
   string-method calls (`SX_STRING_METHOD`) have no accepted equivalent, not even string length. The corpus does not
   argue for new syntax: a small synchronous `.ts` library of length/case/trim/split functions, once package-library
   linkage exists, would cover these cases.
3. **Single-field input prefill.** About 30 corpus calls pass a meaningful default, typically to edit a current
   setting (`getInteger("...", cornerBase + playerLevel)`). Accepted multi-field `askIntegers`/`askNumbers` have
   `defaults`; single-field input has none. Lower priority: the player can still type the value.
4. **Localized script variants.** The distribution ships language variants per script (`intro`, `intro_de`,
   `intro_fr`, ...) selected by the legacy player. The repository has no localization decision; this is a package-level
   product question, not syntax.

Not candidates on current evidence: first-class closures, dictionaries, metaprogramming, and runtime evaluation. The
Toy package uses all of them, yet records, functions, and dispatch by action ID express its behavior; exceptions only
guard desktop APIs.

## Specification and implementation observations

Concrete points the migration surfaced in TeaseScript itself:

- **`save null as "key"` is unspecified.** If it deletes the key (as legacy SexScript and most key-value stores do),
  `load "key" default value` becomes exact for migrated read-then-default code and the importer can use it again.
- **`set` is a parser keyword** (ADR 0013 set literals) but missing from `TEASESCRIPT_PROTECTED_NAMES`; the importer
  reserves it itself. Declarations named `set` fail to parse instead of getting the protected-name diagnostic.
- **`round()` tie rule.** Java `Math.round` rounds `.5` toward positive infinity; the accepted `round()` does not say.
- **`showButton` elapsed result** type (number or duration) is still open in V30 section 21.
- **Storage semantics.** The owner-selected `load` semantics (no write on read) still differ from the canonical V30
  text (default-and-write).

## Legacy baggage

Reported for manual work and intentionally not reproduced: reflection and `GroovyClassLoader` outside resolved
package helpers, `java.io.File` access and directory listing other than a recognized module loader,
`System.getProperty`, OS processes (Toy's speech output), webcam/file pickers (`getImage`, `getFile`), `openCdTrays`,
`useEmailAddress`, `useFile`, the old online `send`/`receive` service, and `try`/`catch` around desktop APIs.
`Locale.getDefault()` serves the localization question above. Scripts also contain plain legacy bugs the importer
reports instead of repairing: calls to undefined functions, helper calls with missing arguments, and closures
referenced without `()` (which Groovy evaluated as a no-op or as `true`).

## Accepted but not implemented

The importer emits these accepted forms although the current compiler rejects them; the compiler gate counts them
separately: storage (`save`/`load`/`delete`), `run`/`end`, `switch`, `showPopup`, `showButton` with timeout or elapsed
result, `askInteger`, `askBooleans`, `getSeconds`/`getDateTime`, `openUrl`, `round`/`floor`/`ceil`, and conversions.
Storage and `run`/`end` dominate: they are the only blockers of most otherwise compiler-clean corpus scripts.

The owner-selected storage semantics (`load` returns `null` or the default without writing) still differ from the
canonical V30 text, which describes default-and-write behavior.
