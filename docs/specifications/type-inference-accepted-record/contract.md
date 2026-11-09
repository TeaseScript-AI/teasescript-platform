# The accepted record: contract

Part of [the type inference's accepted record](README.md): what a key's contract holds and how a read answers: value
kinds, operations, projections, presence of properties, narrowing and guards.

## Rules of the design's tables

### section-2-f12

**A read below an element step follows the literal's own structure only.**

**Rule.** An element read (`xs.first`, `xs.last`, `xs.random`, `xs[i]`, `d[key]`, and a path through them) projects
through the element step over the literal's own structure only:
- an element that is a literal contributes its own kind (`[1.5, 2.5].first` is a definite number;
  `[{v: 1}, {v: 2}].first.v` a definite integer);
- an element that is a read (a copy, an alias) is not followed below its own kinds: a path below it takes the
  contract's answer.

Admission still reads the literal's own elements as deciders, so `let xs = [1, 2]; xs.add("bad")` errs.

**Reason.** Projecting k copies at k demanded paths was a k × k product on a linear source. Sharing the copies'
snapshots needs a proof the handler model cannot give cheaply. The loss is a warning where k snapshots inside a literal
would have proved a kind.

**Source.** Checkpoint 9's design, §2's operation table (F12), as amended by revision 4.7, 2026-10-23.

### section-3-2-guarded

**A guarded read's items are marked, so no consumer errs on them.**

**Rule.** A read is guarded when it lies inside a branch whose condition tests the read's path (`!= null`, `== null`,
`is T`, `is not T`, a comparison), or after a branch that tests it and always leaves (`if n is not integer { exit }`).
Its items carry the mark `guarded`, every kind possible, so no consumer errs on them. The mark travels with the value
through copies, literals, projections, arithmetic, argument bindings and function results, and through a written
parameter or result too: a written type fixes the kinds a value may have, but never removes its mark or raises its
certainty.

**Reason.** Without the mark, guard dependence was lost through function results and after early exits, and valid
guarded code got false errors. With `function relay(x: number) { return x }` and a guarded argument,
`let whole: integer = relay(n)` under `if n is integer` warns, never errs.

**Source.** Checkpoint 9's design, §3.2, from the blind model check of revision 4.6 (Astra, Sol), 2026-10-23.

## Revisions

### r4-162

**A site fact not proved gives words, never a code form.**

**Rule.** The facts a fix's validity predicate reads are three-valued: proved, disproved, or not proved. A code form is
offered only where every site fact is proved at the site. A fact that is not proved is never read as holding; the fix is
given in words.

**Reason.** Ten review rounds each found a new path by which a value reaches a site (an inline literal's element, an
interpolation's result), and each lost fact let an invalid form be offered. With three values, a path the traversal does
not follow can only under-offer, never offer an invalid form.

**Source.** The lead's ruling on Codex round 10 of PR #1296 (#1241), 2026-10-28.

### r4-171

**A type suggestion is a type at the type position.**

**Rule.** A suggested type is proved as a form at the type position, so `(integer | string)[]` must parse there. The
message names the type ("declare it with the type '(integer | string)[]'"), never a whole declaration carrying the
author's start value.

**Reason.** V30 §13's example suggests `(integer | string)[]` for `let h: integer | string[] = 1`, but a declaration
with that start value does not compile. The start value is the author's own and keeps its own behaviour.

**Source.** The lead's ruling on Codex round 5 of PR #1273 (#1268), 2026-10-28.

### r4-215

**An unrestricted written domain's `unknown` carries the opaque reason.**

**Rule.** A value read from an unrestricted written domain (a `list` element, say) is `unknown` with the opaque reason,
set at the one producer, `keyContract`. Every consumer then owes its receiving check by its existing rules.

**Reason.** The domain's `unknown` had no reason, so every consumer that owes a check only for opaque or external items
owed nothing. `let xs: list = [hostValue, 4]`, `let carrier = [xs]` and `let result: integer = carrier[0][0]` printed
`"bad"` with no diagnostic and no check (#1501). The opaque reason is true for an internal value ("known only when the
script runs"); external would invent provenance. One bit at one producer was chosen over teaching every consumer to
recognise a reasonless unknown, which would need a marker carried through merges, copies and finishing.

**Source.** The lead's decision on #1501, after Sol's design round 1, 2026-10-30.

### r4-277

**A value's kinds keep their written spelling where one spelling covers them.**

**Rule.** An item made from a written type carries its spelling (`Item.spelling`, the written kinds in written order).
Only the producers where a written type becomes items set it. Marks form a lattice, joined by `mergePair`: unmarked,
then one spelling, then mixed. One rule, `inItsOrder`, orders every list of kinds:
- the written spelling, where exactly one spelling covers every concrete kind in the list;
- the table order otherwise.

One list is outside the rule: a warning's `fits` stays in fixed table order.

The spelling survives every transport where items are compared, replayed or restored.

**Reason.** Four review rounds each found a sibling of one family: a list of kinds put in table order where a written
spelling had to be kept, or the reverse. Ordering at publication could not tell the two classes apart, because the
publication sites read both. A mark carried from the producer can.

**Source.** The lead's ruling on PR #1558's design for #1398, after Codex round 5, 2026-11-02.
