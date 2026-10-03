# Proposed TeaseScript language changes

Working list of language changes discussed with the owner because of importer findings. Nothing here is accepted
syntax: accepted behavior lives in `docs/specifications/accepted-syntaxes-v30.md` and the ADRs. Corpus evidence is in
[`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md).

## Workflow

1. A proposal is recorded here with the owner decisions so far and its open questions.
2. The importer emits the proposed form and the corpus is converted again, to check that the proposal resolves the
   problems it targets: resolved diagnostics, newly converted scripts, and readable output.
3. If the proposal proves valuable, the owner decides whether it becomes an issue. Issues are added to the
   syntax-change tracker only with the owner's permission.
4. The compiler implements the change from that issue, so each change is implemented once.

Every open question below carries a recommendation with its rationale, the pros and cons of the options, consistency
with the direction TeaseScript already took, and common practice in other languages.

## Status

| ID | Proposal | Status |
| --- | --- | --- |
| L1 | Random list selection only inside `${...}` | Owner intent; the `say list` rule awaits confirmation |
| C1 | A list as a `choose` option gives one button per element | Owner agreed |
| C2 | Labels may be mixed; a missing label is the button text | Owner agreed; numeric-label rule awaits confirmation |
| C3 | Labels from a list | Length rule and warnings decided; notation open |
| C4 | Effective labels are unique | Owner agreed |
| C5 | Warning when a choice result is compared with an impossible label | Recommended, not yet discussed |
| T1 | Type enforcement, union types, type tests, narrowing | Issue #504 |

## L1. Random list selection only inside `${...}`

Owner intent (2026-10-03): the random pick was only ever meant for interpolation. `${...}` turns a value into text, and
for a list that conversion picks one element. Everywhere else a list stays a list. V30 instead attaches the pick to
every visible-text context (`say player.petNames`, plus fields that "opt into" it), and the runtime applies one shared
conversion (`visibleText` in `src/runtime/evaluator.ts`) to interpolation, `say`, and `choose` options. That is why
`choose player.petNames` currently shows one random button.

```tease
say "Good ${player.petNames}"       // random element, chosen again at each evaluation
let name = player.petNames.random   // explicit random element, anywhere
let names = player.petNames         // a list copy, as today
```

Spec impact: V30 §8 and §16 (the "approved visible-text contexts" and opt-in wording go away).

**Open: `say player.petNames` without `${...}`.** Recommendation: a compile error with a hint naming
`"${player.petNames}"` and `player.petNames.random`; at runtime, when the type is unknown, the same message as an error.

- Option A, error with hint: one visible place for the magic, as the owner intends. It costs one extra line change for
  authors used to V30 examples (none exist outside the spec).
- Option B, `say` also picks: keeps V30's shorthand, but brings back "everywhere text is expected", which is exactly
  what made `choose` pick randomly.
- Option C, `say` prints all elements: predictable, but has no use in a tease and invites accidental output.
- Consistency: V30 already calls the pick "deliberately not a general list-to-string conversion", and assignment
  already keeps the list.
- Common practice: general-purpose languages print every element when a list becomes text (Python `['a', 'b']`,
  JavaScript `a,b`). Narrative scripting languages make random alternatives explicit inside the text, as in Ink's
  `{~a|b|c}` and Tracery's `#symbol#` expansions. None picks at random from a bare list outside such a marker, which
  supports option A.

## C1. A list as a `choose` option gives one button per element

A list that forms a whole option expands to one option per element, in order; a list inside text follows L1.

```tease
let offenses = ["Spanking", "Lines"]
offenses.add("Corner")
let answer = choose "Back", offenses               // Back | Spanking | Lines | Corner
let reply = choose "Yes, ${player.petNames}", "No" // 2 buttons, the first with a random name
let pick = choose player.petNames                  // one button per pet name
```

- An option list that is empty at runtime contributes no buttons; a `choose` with no buttons at all is a runtime error.
- Elements follow the visible-text element rules (text and numbers; numbers shown as text).
- Corpus: 23 menus built from runtime data (`getSelectedValue(dialog, ["Back"] + offenseTextArray)` in
  DisciplineClinic, registered options in Toy). Today the importer reports them; with C1 the DisciplineClinic case
  becomes `choose "Back", offenses`.
- Spec impact: ADR 0018 `choose` rules; V30 §16 and §19.

## C2. Labels may be mixed; a missing label is the button text

Owner proposal (2026-10-03): every option has a label; an option written without one uses its button text as label.
The current "labelled and unlabelled options may not be mixed" rule goes away, and the unlabelled form becomes the case
where every label comes from the text.

```tease
let answer = choose back: "Back", "Spanking", "Lines"
// buttons: Back | Spanking | Lines
// result:  "back" | "Spanking" | "Lines"
```

Common practice: this is how HTML's `<option>` works; without a `value` attribute the option's value is its text.

**Open: numeric labels.** Recommendation: numeric labels stay all-or-nothing, so one `choose` always returns one type
(`string`, or `number` when every option has a numeric label). Identifier labels and text-derived labels mix freely
because both are text.

- Pro: follows the single-type principle the owner adopted for #504: a variable keeps one inferred type, so
  `let answer = choose ...` must have one. It prevents code that works for the button the author tested and breaks for
  another.
- Con: one remaining rule to learn. Once #504 adds union types, a mixed `choose` could be allowed when the author
  assigns it to an explicit `number | string` variable; that is a later extension, not part of this proposal.
- Consistency: identifier labels already return `string` and numeric labels `number` (ADR 0018).

## C3. Labels from a list

Owner decisions (2026-10-03): labels can come from a list paired by position with a list of button texts. When the
lengths differ, a missing label is the button text and extra labels are ignored. The author is warned, not stopped: a
compiler warning when both lists are known at compile time, otherwise a runtime developer warning. A length mismatch
often means a label was forgotten in the middle and every later label shifted, which is why the warning matters.

**Open: the notation.** `choose ids: texts` cannot be used: an identifier before `:` is a literal label, so that
already means one button labelled `"ids"`. Recommendation: a list of records, each with `label` and `text`.

```tease
let offenses = [
    { label: "spank", text: "Spanking" },
    { label: "lines", text: "Writing lines" },
    { text: "Corner" }  // no label: the label is the text (C2)
]
let answer = choose back: "Back", offenses
```

- Option A, records: no new syntax (C1 expands the list; the element supplies label and text) and no notation clash.
  Label and text stay together, so they cannot shift apart and the length rule never applies. `label` and `text` are
  the terms ADR 0018 and the runtime's choice options already use. Con: authors must know the two property names, and
  object literals are a step beyond plain lists. The plain-text list from C1 stays the simple path.
- Option B, two parallel lists: matches the owner's mental model of two columns. Con: it needs a new notation, for
  example a parenthesized named form such as `choose(texts, labels: ids)`. Such a form is anticipated in
  `docs/OPEN-DECISIONS.md` for advanced choice options but rejected by today's parser. It also carries the shift risk
  the warning can only detect.
- Option C, return the position: an unlabelled list plus a way to get the chosen index, as legacy `getSelectedValue`
  did. Also needs new notation. Deferred until a corpus case needs it beyond A or B.
- Consistency: TeaseScript already has object literals and object lists. Option B's named form would follow the split
  V30 uses for media commands: a compact form for the common case, a named form for less common options.
- Common practice: option lists are value/label records in HTML (`<option value>`) and in common UI libraries (items
  shaped like `{ value, label }`). Parallel arrays are a known anti-pattern because they drift apart.
- Whether label lists may hold numbers follows C2. The recommendation is text labels only, because a missing label
  falls back to text.

The importer evaluation should convert DisciplineClinic's offense menu and Toy's registered options with option A and,
if the owner wants the comparison, option B.

## C4. Effective labels are unique

Two options with the same effective label (explicit or derived) cannot be told apart, as in
`choose back: "Return", "back"`. Agreed rule: a compile error when the duplicate is visible in the source (as for
duplicate labels today); a runtime developer warning when it arises from lists, and both buttons then return that
label. Repeated button text with distinct labels stays allowed, as ADR 0018 already permits; typed input that matches
several options remains invalid there and the player selects a button.

## C5. Warning when a choice result is compared with an impossible label

Recommended, not yet discussed. When a `choose` has its labels in the source, the compiler can warn at
`if answer == "Open"` when `"Open"` is none of them. That catches the button text being compared instead of the
label, and typos such as `"bratyy"`. TypeScript reports the same mistake for literal union types ("This comparison
appears to be unintentional because the types have no overlap"). It depends on the type information from #504.

## T1. Types: enforcement, union types, type tests, narrowing

Tracked in issue #504, which records the owner direction and the design questions.

**Type-test form (#504 question 4).** Recommendation: an operator using the type names, `value is number`.

```tease
if reward is integer {
    say "You earned ${reward} points"
}
```

- Pro: the same type names as annotations (`let reward: integer`), so it also covers `string?`, `integer[]`, and unions
  without one function per type. It reads as English like `choose`, `say`, and `as mistress`, and narrowing attaches
  naturally to an operator the compiler knows.
- Con: `is` becomes a keyword. Beginners may read it as equality (`if mood is "happy"`). The compiler should reject a
  non-type operand with "`is` checks a type; use `==` to compare values".
- Function form `isNumber(value)`: mirrors the existing conversions (`toNumber(value)`), but needs a function per type
  (eight scalar types, `null`, lists, objects, and more) and cannot express `string?` or `integer[]`.
- Common practice: languages with narrowing mostly use an operator: Kotlin, C#, Swift, and Dart (`x is Int`), Java
  pattern matching (`x instanceof Integer i`), TypeScript (`typeof x === "number"`). Function forms are library style
  (lodash `_.isNumber`, `Array.isArray`).

Advice for the remaining #504 questions is still to be written.

## Not yet discussed

The other capability candidates and specification observations in [`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)
(text utilities, dictionaries, single-field input prefill, localized script variants, `save null`, `set` as a
protected name, the `round()` tie rule, the `showButton` elapsed type, storage semantics) have not been discussed with
the owner.
