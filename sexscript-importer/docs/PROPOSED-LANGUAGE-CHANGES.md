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
| L1 | Random list selection only inside `${...}`; `say list` shows the whole value | Accepted (#511); implemented in PR #515 |
| C1 | A list as a `choose` option gives one button per element | Accepted (#511); implemented in PR #515 |
| C2 | Options with and without a written value may be mixed; without one, the button text is the value | Accepted (#511); implemented in PR #515 |
| C3 | Values from a list: choice objects `{ value?, text, background? }` | Accepted (#511); implemented in PR #515 |
| C4 | Effective values are unique | Withdrawn: buttons may repeat a value |
| C5 | Warning when a choice result is compared with a value no option has | Taken up by the owner with #504 |
| T1 | Type enforcement, union types, type tests, narrowing | #504: enforcement merged (#519); rules, runtime checks, and unions in draft PRs #526, #520, #530 |
| D1 | Dictionaries: objects with runtime keys (`toys[name]`) | Evaluated on the corpus; taken up by the owner in the language tracker |
| M1 | Media selected by tags (include/exclude tags, count matches) | Evaluated (counting); later |

The importer emits L1 and C1–C3 in its default output following the head of PR #515 (`ec4aa657`), and the text
operations, `join`, and conversions of #508 following the head of PR #518 (`15ee912c`). Until those PRs merge, the
report's compiler gate and smoke runs replace them with stand-ins, counted as the pending capabilities `choose list
options` and `text operations`. Only D1 and M1 remain proposals (`--proposed`).

## Corpus evaluation

Measured on 2026-10-04 at importer commit `c72e3637` with `node src/cli.ts report --run [--proposed=<id>] <package
scripts>`, after merging `main` at `66f0a750`. The importer emits a working syntax of its own choosing for the two
remaining proposals; the report compiles and smoke-runs it through stand-ins in current TeaseScript, so "converted"
means converted, compiled, and run, not just emitted. Each cell: root errors / lowered scripts / compiler-clean except
pending / scripts reached by smoke runs.

| Conversion | Distribution | Domme3 | DisciplineClinic | Toy |
| --- | --- | --- | --- | --- |
| default before (`6e0d4d03`) | 15 / 10 / 10 / 10 | 35 / 13 / 10 / 10 | 17 / 3 / 3 / 3 | 267 / 0 / 0 / 0 |
| default now | 13 / 10 / 10 / 10 | 32 / 14 / 11 / 11 | 21 / 3 / 3 / 3 | 254 / 0 / 0 / 0 |
| dictionaries (D1) | unchanged | 25 / 14 / 11 / 11 | unchanged | 183 / 0 / 0 / 0 |
| media-tags (M1) | unchanged | 29 / 16 / 13 / 13 | unchanged | unchanged |
| both | 13 / 10 / 10 / 10 | 22 / 16 / 13 / 13 | 21 / 3 / 3 / 3 | 183 / 0 / 0 / 0 |

The default now includes what the earlier measurement (2026-10-03, importer `d713b469`) counted as the proposals
choose-lists, string-operations, and input-defaults, everything `main` merged since (#513, #514, #517, #519, #523,
#524), and the owner decisions on switch, showButton, and date and time (#528, #531, #532). The default before,
measured at the `main` merge `6e0d4d03`, matches that earlier baseline. Per package:

- Distribution: the font menu converts, and `getImage` in `test.groovy` becomes `takePhoto()`.
- Domme3: 6 of its 9 Java date formats convert (#532), and `task` becomes lowered and runs; the 3 formats of a date
  built from Unix time remain, and 3 reads of never-assigned variables (legacy bugs) are now reported, which keeps
  `assignments` unlowered. Its 8 string-method errors are `size()` calls on values that may be maps, which only
  dictionaries count.
- DisciplineClinic: 7 of its 9 runtime menus and both `getImage` calls convert, while 7 variables that change type
  (#519) and 7 reads of never-assigned variables are new errors (see [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)).
  Its three unconverted scripts keep other causes, so the lowered count does not move.
- Toy: 7 runtime menus and 7 string methods convert; one lookup with a text key is now reported as map access.

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

**D1 dictionaries: valuable, single-package evidence.** Toy's root count drops by 71 net (254 to 183): lookups and
writes with runtime keys, map method calls (`containsKey`, `keySet`, `values`, `remove`, `clear`), and map literals
with computed or numeric keys convert, and some inner causes surface. The default conversion reports these lookups.
No literal map key in the corpus has a dictionary member name; when one does, the output reads it as `map["length"]`
so the member keeps its meaning. The working syntax needed a literal with computed keys for 34 entries such as
`{ [COLLAR]: "leather collar" }`. It treats Groovy's numeric keys (12 sites) as text, with a note, and keeps Groovy's
copy-on-write difference for maps shared by two variables visible as a note. Making `.length` count dictionary keys,
as text and lists already have a length, removes Domme3's 8 `size()` errors on record fields of unknown type, and one
inner cause surfaces (32 to 25 roots). No other package uses maps as dictionaries.

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

Importer consequence: the legacy menus convert with numeric values, whose type is `integer` under PR #515 while `main`
still types a numeric `choose` as `number`. A legacy variable that starts at `0` and later receives a menu result is
therefore valid under PR #515 but rejected by `main`; the compiler gate hides that type behind a placeholder (pending
capability `choose integer values`, 4 corpus scripts).

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

Tracked in issue #504. `main` enforces that a variable keeps its declared or inferred type (#519): an `integer` may be
stored where a `number` is expected, and every other mismatch is compile error `TSV041`. The type rules (ADR 0021,
draft PR #526), runtime checks for values the compiler cannot know (draft PR #520), and union types with type tests and
narrowing (draft PR #530) are not merged; the importer emits no union types.

**Type-test form (#504 question 4): `value is number`,** as recommended here and implemented in draft PR #530 (`is` and
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
#524); and the runtime fix for a `choose` reached again with other option texts (#521, as #523). Open: built-in text
operations (#508, PR #518), L1 with C1–C3 (#511, PR #515), switch with several values per case (#528, PR #529), the
compact `showButton "Done", timeout: 30` form (#531), and date, time, and datetime values (#532). The importer
follows all of them in its default output. `save null` already removes the key on `main` (#484). Text utilities
beyond #508, such as regular expressions, are future work as a `.ts` system library, and localized script variants
too; one language is enough for now.

## Later

- **D1 dictionaries.** The owner always meant objects to work as dictionaries: lookup with a runtime key fails today
  (`toys[k]` raises TSR008 at runtime). Evaluated above with objects as dictionaries (`toys[name]`, `has`, `keys`,
  `values`, `length`, `remove`, `clear`, computed keys). The owner takes the syntax and typing against #504 up in the
  language tracker, where a separate `dict` type design awaits the owner's decision; until then the importer keeps
  its working syntax.
- **M1 media by tags.** The owner plans to tag every image and select a random image matching included and excluded
  tags, with a count of matches. No tagged media exists yet. Evaluated above for counting; random selection by tags
  and Toy's tag files come later.

## Next steps

- **D1 in the language tracker.** The owner's dictionary design replaces the working syntax; the importer then follows
  it and drops the proposal.
- **Union types (#504).** When draft PR #530 lands, the 7 DisciplineClinic variables that change type could convert
  to union-typed declarations, and the two menus whose option variable changes type could convert; the importer
  should then decide per variable between a union and separate variables.
- **Re-measure the corpus** as PRs #515, #518, and #529 and the #531 and #532 implementations merge (their stand-ins
  then go away), and when #526 or #520 change accepted type behavior. #526 types a function parameter from its default
  value, which a typed parameter would have to widen (101 generated functions have defaults), while `main` does not
  compile typed function signatures yet.
- **M1** stays for later, after tagged media exists.
