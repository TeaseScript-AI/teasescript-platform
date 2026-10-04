# Proposed TeaseScript language changes

Working list of language changes discussed with the owner because of importer findings. Accepted behavior lives in
`docs/specifications/accepted-syntaxes-v30.md`, the ADRs, and the owner decisions on the linked issues; corpus evidence
is in [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md). Once the owner accepts a change, the importer emits it in its
default output (with stand-ins in the compiler gate until it is implemented) and the entry here records where it went.

## Workflow

1. A proposal is recorded here with the owner decisions so far and its open questions.
2. The importer emits the proposed form and the corpus is converted again, to check that the proposal resolves the
   problems it targets: resolved diagnostics, newly converted scripts, and readable output. For this test the importer
   uses a well-reasoned working syntax of its own; the owner discusses the exact syntax only for capabilities that
   prove valuable (owner, 2026-10-03).
3. If the proposal proves valuable, the owner decides whether it becomes an issue. Issues are added to the
   syntax-change tracker only with the owner's permission.
4. The compiler implements the change from that issue, so each change is implemented once.

Every open question below carries a recommendation with its rationale, the pros and cons of the options, consistency
with the direction TeaseScript already took, and common practice in other languages.

## Status

| ID | Proposal | Status |
| --- | --- | --- |
| L1 | Random list selection only inside `${...}`; `say list` shows the whole value | Accepted (#511); merged as #515 |
| C1 | A list as a `choose` option gives one button per element | Accepted (#511); merged as #515 |
| C2 | Options with and without a written value may be mixed; without one, the button text is the value | Accepted (#511); merged as #515 |
| C3 | Values from a list: choice objects `{ value?, text, background? }` | Accepted (#511); merged as #515 |
| C4 | Effective values are unique | Withdrawn: buttons may repeat a value |
| C5 | Warning when a choice result is compared with a value no option has | Merged as part of #504 (#535) |
| T1 | Type enforcement, union types, type tests, narrowing | #504: merged (#519 enforcement, #526 type rules, #520 runtime checks, #530 unions, `is`, and narrowing) |
| D1 | Dictionaries: lookup by runtime key (`toys[name]`) | Owner-decided as a separate `dict` type (#536); merged as #555 |
| M1 | Media selected by tags (include/exclude tags, count matches) | Evaluated (counting); later |

The importer emits L1 and C1–C3 in its default output as merged in #515, and the text operations, `join`, and
conversions of #508 as merged in #518; the compiler gate and smoke runs check both with `main`'s implementation. It
also emits the `dict` type of #536 for D1 as merged in #555, and declares unions (#530) for variables that Groovy gave
several types. Only M1 remains a proposal (`--proposed`).

## Corpus evaluation

Measured on 2026-10-04 at importer commit `5e9e33e8` with `node src/cli.ts report --run [--proposed=<id>] <package
scripts>`, after merging `main` at `242ada7a`; the merge of `dict` (#555) and date and time (#532) changed no cell. The importer emits a working syntax of its own choosing for the
remaining proposal; the report compiles and smoke-runs it through stand-ins in current TeaseScript, so "converted"
means converted, compiled, and run, not just emitted. Each cell: root errors / lowered scripts / compiler-clean except
pending / scripts reached by smoke runs.

| Conversion | Distribution | Domme3 | DisciplineClinic | Toy |
| --- | --- | --- | --- | --- |
| default before (`6e0d4d03`) | 15 / 10 / 10 / 10 | 35 / 13 / 10 / 10 | 17 / 3 / 3 / 3 | 267 / 0 / 0 / 0 |
| default before `dict` (`b4d4362b`) | 13 / 10 / 10 / 10 | 31 / 15 / 12 / 12 | 22 / 3 / 3 / 3 | 254 / 0 / 0 / 0 |
| default after `dict` (`b4f097a9`) | 13 / 10 / 10 / 10 | 24 / 15 / 12 / 12 | 22 / 3 / 3 / 3 | 183 / 0 / 0 / 0 |
| default before `main` at `337388d2` (`61ee928e`) | 8 / 12 / 12 / 12 | 24 / 15 / 12 / 12 | 8 / 3 / 3 / 3 | 108 / 0 / 0 / 0 |
| default now | 8 / 12 / 12 / 12 | 24 / 15 / 12 / 12 | 5 / 3 / 3 / 3 | 107 / 0 / 0 / 0 |
| media-tags (M1) | unchanged | 21 / 17 / 14 / 14 | unchanged | unchanged |

The third round converts conditional expressions, inputs, collection loops, and menus inside larger expressions
through temporaries, starts empty-text placeholders with their later type's empty value, notes what functions nothing
references cannot convert, and adds marked workarounds for two regular expressions and the system language (see the
workaround classes in [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)). The distribution's English and German
introductions now run to their end. The merge of `main` at `337388d2` replaces most stand-ins with real
implementations and adds the type pass and unions: DisciplineClinic's `dialog` and `response` and a Toy list become
unions (3 and 1 fewer root errors), and lists that start as null start empty where no code compares them with null
(see [`CORPUS-INVENTORY.md`](CORPUS-INVENTORY.md)).

The default now includes what the earlier measurement (2026-10-03, importer `d713b469`) counted as the proposals
choose-lists, string-operations, and input-defaults, everything `main` merged since (#513, #514, #517, #519, #523,
#524), and the owner decisions on switch, showButton, date and time, integer widening, and `dict` (#528, #531, #532,
#504 option B, #536). The default before, measured at the `main` merge `6e0d4d03`, matches that earlier baseline. Per
package:

- Distribution: the font menu converts, and `getImage` in `test.groovy` becomes `takePhoto()`.
- Domme3: 6 of its 9 Java date formats and its `Calendar.DAY_OF_YEAR` read convert (#532), so `task` and `sleep`
  become lowered and run; the 3 formats of a date built from Unix time remain, and 3 reads of never-assigned variables
  (legacy bugs) are now reported, which keeps `assignments` unlowered. Its 8 `size()` calls on values of unknown type
  convert to `.length`, which text, lists, and dicts share (#536), and one inner cause surfaces.
- DisciplineClinic: 7 of its 9 runtime menus and both `getImage` calls convert, while 8 variables that change type
  (#519) and 7 reads of never-assigned variables are new errors (see [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)).
  Its three unconverted scripts keep other causes, so the lowered count does not move.
- Toy: 7 runtime menus and 7 string methods convert, and its lookup-table maps become dicts (254 to 183 roots, see
  below).

Toy remains one script with many independent causes (Java objects, captured closures, evaluation order, persona
files), so no proposal makes it runnable; its root count shows how much each removes.

**C1–C3 choose over runtime lists: valuable, now default.** 23 menus in the corpus build their options at runtime, 11
with a truly variable number of options. 15 of them convert (DisciplineClinic 7 of 9, Toy 7 of 13, the distribution's
font menu). Legacy `getSelectedValue` returns the position, which the scripts use to index parallel data, so faithful
output needs C3's choice objects with numeric values, and the "Back" button needs C2's mixing:

```tease
pickOffense = choose 0: "Back", sexscriptLegacyMenuOptions(offenseTextArray, 1)
```

The generated helper builds `{ value: position, text: text }` objects. A form that returns the position directly
would make this shorter, but the objects work. Unconverted: two DisciplineClinic menus whose option variable also
holds text or a number elsewhere (a type change, which TeaseScript now rejects, #519), and Toy menus built inside
larger expressions.

**D1 dictionaries: owner-decided as `dict` (#536), now default.** The working syntax tested objects as dictionaries and
hit member-name collisions (`map["length"]`) and untypable runtime-key reads; the owner chose a separate `dict` type. A
Groovy map becomes a dict when a script or its modules look it up by a runtime or non-name key, call lookup methods or
`each` on it, or build it with computed or number keys; other maps stay objects. Toy's root count drops by 71 (254 to
183). In Toy the conversion covers 25 dict literals (8 empty), 34 lookups, 25 writes, 14 `containsKey` tests and 10 null
or truth tests of a lookup (all as `contains`), 5 guarded `remove` calls, 3 `clear` calls, 2 `keys`, 1 `length`, and 1
key loop from `each { key, value -> }`; 6 object literals declare fields that Groovy added later, such as
`sessionParams`, a record with mixed field types. The 28 Toy statements that still involve these maps are reported for
other causes: closures over map entries and method chains on looked-up values (`toys.any { s, t -> ... }`, `findAll`,
`activityList[name].func()`, 14), Java objects as values (`new Event(...)`, 2), a dict of closures (`funcMap`, 2), and
boolean `&`, conditionals, and regular expressions around them (10). No runtime map key stays reported. #536 has since
added a default lookup, `m.get(k, default: d)`, which fallbacks for a missing key now use (`m[k] ?: d`,
`m.containsKey(k) ? m[k] : d`, read-then-default); a lookup whose key the importer cannot prove present gets a note
instead (13 Toy sites). Domme3 drops from 31 to 24 because `.length` now covers `size()` on values of unknown type. No
other package uses maps as lookup tables, apart from a reply of the legacy online service in the distribution's
`test.groovy`, which stays unconverted.
The friction this showed is in [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md).

**Text operations (#508): valuable, cheap, now default.** They remove 7 of Toy's 14 string-method errors; the rest
need regular expressions, `tokenize`, or a receiver that may be a map. The accepted operations follow Unicode code
points and full case mapping, which differ from Java in rare cases the output does not mark: `trim()` also removes
non-breaking spaces, `uppercaseFirst()` turns a leading `ß` into `SS` where Groovy's `capitalize()` kept it, lengths
and positions count code points where Java counted UTF-16 units, and case-insensitive comparison does not fold the
Turkish dotted `İ`. `equalsIgnoreCase` becomes `lowercase()` on both sides (the owner confirmed no dedicated
operation; the corpus has no site), and converts only when the argument is known text, since Groovy returned `false`
for `null`.

**Prefill (#510, merged as #514): restores every default, now default.** All 62 legacy defaults convert (distribution
18, Domme3 15, DisciplineClinic 24, Toy 5); prefill removes no root error. 27 of them come from settings loaded from
storage, which may be null, and keep a note: TeaseScript rejects a null or blank default when the input opens, while
legacy showed "null" or an empty field (see [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)).

**M1 media tags: valuable for startup flows.** Counting images by folder tags converts Domme3's three pack-detection
routines; `intro` and `introfirst` become lowered (`settings` keeps a legacy bug, a never-assigned `DAY`), and the
entry flow now runs past pack detection:

```tease
return countImages(tags: ["Domme3", "Domme${pack}"])
```

The legacy count listed the folder's direct entries and filtered them by file name (`Domme(\d+).jpg`); the tag count
counts the images tagged with the folder names, including subfolders, and cannot filter by name, so the output carries
a note. With both proposals the entry flow runs `Domme3` → `introfirst` → `implements` and stops at `ask`, whose
remaining causes are legacy bugs (helper methods called without the script host, which failed in SexScript too), a
value-position assignment, and a date built from Unix time, which TeaseScript cannot construct (#532). Toy's imagery
(outfit folders with tag files, random selection by persona, outfit, and tags) fits the owner's tag idea but needs tag
ingestion from those files; not converted yet.

**Little corpus evidence:** removing positions from lists (#509) has zero sites and removing a value one, inside a
Toy closure chain that stays unconverted for other reasons; no output depends on `say` of a whole list (L1). Both
were language-consistency decisions.

## L1. Random list selection only inside `${...}`

Owner intent (2026-10-03): the random pick was only ever meant for interpolation. `${...}` turns a value into text, and
for a list that conversion picks one element. Everywhere else a list stays a list. V30 previously attached the pick to
every visible-text context (`say player.petNames`, plus fields that "opted into" it), which is why
`choose player.petNames` showed one random button.

```tease
say "Good ${player.petNames}"       // random element, chosen again at each evaluation
let name = player.petNames.random   // explicit random element, anywhere
let names = player.petNames         // a list copy, as before
```

**`say player.petNames` without `${...}`: option C, it shows the whole value** (owner, 2026-10-03, also for
debugging). PR #515 specifies a code-like notation, like Python's `print`: `say ["pet", "puppy"]` shows
`["pet", "puppy"]`, objects show their properties, and a text field such as a button label rejects a list. The options
considered:

- Option A, error with hint: one visible place for the magic, as the owner intends. It costs one extra line change for
  authors used to V30 examples (none exist outside the spec).
- Option B, `say` also picks: keeps V30's shorthand, but brings back "everywhere text is expected", which is exactly
  what made `choose` pick randomly.
- Option C, `say` prints all elements: predictable, but has no use in a tease and invites accidental output.
- Consistency: V30 already called the pick "deliberately not a general list-to-string conversion", and assignment
  already kept the list.
- Common practice: general-purpose languages print every element when a list becomes text (Python `['a', 'b']`,
  JavaScript `a,b`). Narrative scripting languages make random alternatives explicit inside the text, as in Ink's
  `{~a|b|c}` and Tracery's `#symbol#` expansions. None picks at random from a bare list outside such a marker.

Importer consequence: Groovy showed a list in text as `[a, b]`, which neither the notation nor `${list}` reproduces.
The conversion writes `"[${list.join(", ")}]"` when the elements are known to be text, numbers, or booleans, and
reports the rest.

## C1. A list as a `choose` option gives one button per element

A list that forms a whole option expands to one button per element, in order; a set gives one button per member; a
list inside text follows L1.

```tease
let offenses = ["Spanking", "Lines"]
offenses.add("Corner")
let answer = choose "Back", offenses               // Back | Spanking | Lines | Corner
let reply = choose "Yes, ${player.petNames}", "No" // 2 buttons, the first with a random name
let pick = choose player.petNames                  // one button per pet name
```

- An option list that is empty at runtime contributes no buttons; a `choose` with no buttons at all is an error, at
  compile time when the compiler can see it.
- Elements are values that `${...}` can show, or choice objects (C3).
- Corpus: 23 menus built from runtime data (`getSelectedValue(dialog, ["Back"] + offenseTextArray)` in
  DisciplineClinic, registered options in Toy).

## C2. Options with and without a written value may be mixed

Owner proposal (2026-10-03), accepted in #511 and specified in PR #515: the value written before `:` is what `choose`
returns ("label" was renamed to "value"); an option written without one returns itself, with its own type.

```tease
let answer = choose back: "Back", "Spanking", "Lines"
// buttons: Back | Spanking | Lines
// result:  "back" | "Spanking" | "Lines"
let rounds = choose 5, 10                               // 5 or 10, an integer
```

Common practice: this is how HTML's `<option>` works; without a `value` attribute the option's value is its text.

**Numeric values.** A numeric literal before `:` returns its number, an `integer` or a `number` as written, and when
all values share one type the result has that type. Until union types (#504) exist, one `choose` may not mix
identifier and numeric values before `:`; with them, mixing number and text results is planned to be allowed only into
an explicitly union-typed variable. The owner takes that, and C5, up with #504. The considerations:

- Pro: follows the single-type principle the owner adopted for #504: a variable keeps one inferred type, so
  `let answer = choose ...` must have one. It prevents code that works for the button the author tested and breaks for
  another.
- Con: one remaining rule to learn.
- Consistency: identifier values return `string` and numeric values a number (ADR 0018).

Importer consequence: the legacy menus convert with numeric values, whose type is `integer` (#515), so a legacy
variable that starts at `0` and later receives a menu result needs no annotation (14 in the corpus).

## C3. Values from a list: choice objects

Owner decision (2026-10-03, option A): values come from a list of choice objects `{ value?, text, background? }`; the
button shows `text` and returns `value`, or the `text` value when `value` is omitted. A choice object may also be a
whole option, and a value written before a list option is the value of every button from it.

```tease
let offenses = [
    { value: "spank", text: "Spanking" },
    { value: "lines", text: "Writing lines" },
    { text: "Corner" }  // no value: the value is the text (C2)
]
let answer = choose back: "Back", offenses
```

The owner's first idea, two parallel lists paired by position with a length warning, was set aside for objects. The
comparison that led there:

- Option A, objects: lists of object literals were already accepted (V30 §15 and §16); only `choose` reading `text`
  and `value` from an element is new. Value and text stay together, so they cannot shift apart. Con: authors must know
  the property names, and object literals are a step beyond plain lists. The plain list from C1 stays the simple path.
- Option B, two parallel lists: matches the owner's mental model of two columns, but needs a new notation (for example
  `choose(texts, values: ids)`) and carries the shift risk that a warning can only detect. `choose ids: texts` cannot
  be used: an identifier before `:` is a literal value.
- Option C, return the position: an unvalued list plus a way to get the chosen index, as legacy `getSelectedValue`
  did. Also needs new notation; no corpus case needs it beyond option A.
- Common practice: option lists are value/label records in HTML (`<option value>`) and common UI libraries: Django
  `choices` pairs, Rails `options_for_select`, Qt `addItem(text, data)`, Flutter `DropdownMenuItem(value:, child:)`,
  Windows Forms `DisplayMember`/`ValueMember`, Ren'Py `renpy.display_menu([(caption, value), ...])`. Parallel arrays
  are a known anti-pattern because they drift apart.

The DisciplineClinic offense menu and Toy's registered options convert with option A.

## C4. Effective values are unique (withdrawn)

The proposal made two options with the same effective value an error, as in `choose back: "Return", "back"`. The owner
withdrew it: buttons may repeat a value or a text, and a selected button is identified by its position, so each
returns its own value (`choose win: "Open a door", lose: ["Open a door", "Open a door"]` shows three buttons). The
corpus has no case that depends on it.

## C5. Warning when a choice result is compared with a value no option has

Owner agreed (2026-10-03). When a `choose` has its values in the source, the compiler can warn at
`if answer == "Open"` when `"Open"` is none of them. That catches the button text being compared instead of the
value, and typos such as `"bratyy"`. TypeScript reports the same mistake for literal union types ("This comparison
appears to be unintentional because the types have no overlap"). It depends on the type information from #504, and
the owner takes it up there.

## T1. Types: enforcement, union types, type tests, narrowing

Tracked in issue #504 and merged: `main` enforces that a variable keeps its declared or inferred type (#519), checks
types in a separate pass (ADR 0021, #526), checks values the compiler cannot know at runtime (#520), and has union types
with type tests and narrowing (#530, #535). The importer follows the owner decisions that a variable that starts as
`null` keeps the type of its first value (1a) and that an unannotated variable that starts as a whole number widens to
`number` when it later receives a fraction (option B), which resolved its largest friction (18 legacy variables, plus 14
that receive a numeric `choose`). It declares a union where Groovy gave a variable values of several types: on the
corpus, 4 variables with about 270 references need one type test between them. Variables that start as null needed 38
null tests because calls cancel their narrowing; lists now start empty where no code compares them with null, which
leaves 5 on number variables (see [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)).

**Type-test form (#504 question 4): `value is number`,** as recommended here and merged in #530 (`is` and
`is not`).

```tease
if reward is integer {
    say "You earned ${reward} points"
}
```

- Pro: the same type names as annotations (`let reward: integer`), so it also covers `string?`, `integer[]`, and unions
  without one function per type. It reads as English like `choose`, `say`, and `as mistress`, and narrowing attaches
  naturally to an operator the compiler knows.
- Con: `is` becomes a keyword. Beginners may read it as equality (`if mood is "happy"`), so a non-type operand gets
  "'is' checks a type; use '==' to compare values".
- Function form `isNumber(value)`: mirrors the conversions (`toNumber(value)`), but needs a function per type and
  cannot express `string?` or `integer[]`.
- Common practice: languages with narrowing mostly use an operator: Kotlin, C#, Swift, and Dart (`x is Int`), Java
  pattern matching (`x instanceof Integer i`), TypeScript (`typeof x === "number"`). Function forms are library style
  (lodash `_.isNumber`, `Array.isArray`).

The corpus evidence for #504 (how often legacy variables change type, and the integer/number friction) is in
[`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md).

## Decided for `main` (tracker #512)

Owner decisions that do not depend on the importer test go straight to `main` through tracker #512. Merged: the
`round()` tie rule (ties away from zero), the `showButton` elapsed `duration`, and `set` as a protected name (#507, as
#513); removing objects and positions from lists, with structural `==` on lists, sets, and objects (#509, as #517); a
prefilled `default:` for single-field inputs (#510, as #514); positional arguments followed by named ones (#522, as
#524); the runtime fix for a `choose` reached again with other option texts (#521, as #523); and L1 with C1–C3 (#511, as
#515); built-in text operations (#508, as #518); switch with several values per case and type cases (#528, as #529 and
#557); the compact `showButton "Done", timeout: 30` form (#531, as #534); `askInteger` (#539, as #548); and
`load "key", default: value` (#541, as #545); and date, time, and datetime values (#532, as #551, #554, #556, #561, and
#563). The importer follows all of them in its default output. `save null` already removes the key on `main` (#484). Text utilities beyond #508, such as regular expressions, are future
work as a `.ts` system library, and localized script variants too; one language is enough for now.

## Later

- **M1 media by tags.** The owner plans to tag every image and select a random image matching included and excluded
  tags, with a count of matches. No tagged media exists yet. Evaluated above for counting; random selection by tags
  and Toy's tag files come later.

## Next steps

- **Re-measure the corpus** as script transfers, `showPopup`, `askBooleans`, `openUrl`, and the camera land (their
  stand-ins then go away).
- **M1** stays for later, after tagged media exists.
