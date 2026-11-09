# The type inference's accepted record

The accepted rules of the V2 type inference (`src/type-inference/core`) whose reasons the code's comments rely on. Each
entry states the rule, why it was chosen over the alternative a reader would expect, where it was decided, and what
later changed it. A comment that needs that reason links the entry by its anchor; a comment that only restates a rule
cites nothing.

- **Anchors:** each entry's heading is its anchor, `r4-N` for a revision (the number it had in the accepted record it
  came from) and `section-…` for a rule of the design's tables. A heading never changes and a number is never reused.
- **Authority:** an entry is canonical for its rule, overridden only within the exact scope of a later accepted ADR,
  V30 (`accepted-syntaxes-v30.md`), or a later entry here that names it.
- **Adding an entry:** the pull request that relies on a new rule adds it, in number order, with the same four parts.
  Entries are added without changing the existing ones; a change to a rule is a new entry that names the one it
  changes.

Each entry gives the rule; the reason; the source (the review round or ruling, the issue or pull request, the date);
and, where it applies, what superseded or bounded it.

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

### section-5-a2

**A field that exists only through whole copies.**

**Rule.** As first accepted, a field that exists only through whole copies of its record (`let c = a; c = b`, with
`c.n` never read or stored directly and no literal source of `c`) was admitted at its first direct read or store, not
at the copy. The error came at that first read or store and named the copy that brought the other kind.

**Reason.** Admitting every copied record's every field is a copies × fields product, and a field nobody reads cannot
fail when the script runs.

**Source.** Checkpoint 9's design, §5's admission table (A2), with ADR 0021 §1.1 as synchronized by #1031.

**Changed by the owner** (2026-10-28) and built as [r4.154](#r4-154) and r4.167: a field that exists only through whole
copies is checked where the copy meets the place. TSV044 comes at a list, set or dict literal of copies whose property
types conflict, and the error at the store that brings the other kind into a place receiving whole copies. A conflict
reached only through a projection or a step-adding cycle keeps the first-read answer.

## Revisions

### r4-15

**One identity function for every entry path into the contract index.**

**Rule.** Every path into the contract's source index decides a source's identity through one identity function. Guard
scope stays outside identity, provenance is a charged set, and each entry path has its own work family and ledger
identity check. An ingress `default: null` is an admitted `null` contribution.

**Reason.** Several entry paths each deciding identity on its own had made the index products of three design rounds
one class of defect. One function makes them agree by construction.

**Source.** Checkpoint 9's design review, round 4 (Astra), 2026-10-23.

### r4-17

**Marks never change a literal's structural identity.**

**Rule.** A guard mark never changes a literal's structural identity; only an ingress inside the literal does. The
combined identity check covers it.

**Reason.** The literal rule had leaked guard annotations into the identity of enclosing literals, so k guarded wrapper
stores counted as k sources.

**Source.** Checkpoint 9's design review, round 5 (Sol), 2026-10-23.

### r4-23

**One mark holder per source and projection; the demand as the budget's unit.**

**Rule.**
- One mark holder per (source, projection). References compose through aliases and enclosing literals, and are never
  copied or flattened. A read's mark work is bounded by its distinct references × prefix depth × log.
- Returnability is a worklist fixpoint, with no invalidation and no waiters.
- The budget's unit is a demand and its dependents, not a key, so proofs independent of an exhausted demand survive.
- Among the reasons a value is unknown, `budget` ranks last.

**Reason.** Copying or flattening marks multiplied their work. A per-key budget unit let one exhausted demand discard
proofs that did not depend on it.

**Source.** Checkpoint 9's design review, round 6, and the stage S2 builder's question, 2026-10-23.

### r4-44

**A decision inside a component is made once, on its completed solve.**

**Rule.** Every decision the solver makes inside a component is made once, on the component's completed open solve,
and held for the second solve. This covers a `load` or `fromJson` default's kinds (F18, F19), a computed key's and an
expected type's default, and a receiver's reference test (F19a). The answer then does not depend on where the component
was entered. Where a receiver's kinds come only around its own cycle (`g` returns `{custom: narrator}`, and `f` reads
`g(…).custom` through the cycle), the access is opaque by F19a. That is a warning with its runtime obligations, never a
budget error and never silent.

**Reason.** Deciding per entry made the answer depend on the order the solver met the component. Treating a
self-dependent receiver as a budget failure gave a false error on a 30-node program.

**Source.** The stage S4 builder's question after review round 1, ruled by the lead, 2026-10-24.

### r4-72

**A copied binding's written domain is part of its value class.**

**Rule.** When value classes share an answer, the copied binding's projected written domain is part of the class's
equivalence, so a class never merges values whose written domains differ.

**Reason.** Keying a class by the resolved value alone lost a written type's check: after `let b: integer[] = raw`,
`let out = a` and `out = b`, invalid data reached the next effect unchecked. The standing differential test (class
sharing and chain resolution on and off, every family and witness, byte-identical diagnostics, owed checks and plan)
keeps grouping output-neutral; a further axis it exposes is repaired inside the class rule only by adding an existing
answer component to the key.

**Source.** The orchestrator's ruling on stage S6's review round 5, 2026-10-26.

### r4-86

**Diagnostics and owed checks are published in source order of their sites.**

**Rule.** Diagnostics and owed checks are published in source order of their sites: file order, then the site's offset
and end, with the items at one site in the consumers' rule order. They are sorted once, when the result is assembled.

**Reason.** The order in which an eager landing queue first reached each path was an artefact of a mechanism the design
removed, and it differed between demand orders and between sharing on and off. A rule gives one order in every mode, so
the standing differential's text comparison ([r4.72](#r4-72)) rests on a rule, not on discovery order.

**Source.** The lead's ruling on review round 3 of the F1 repair, PR #1059, 2026-10-27.

### r4-87

**Every operation family the value side composes has a class rule.**

**Rule.**
- A projection's value class is its step plus its owner's class with the owner's roles.
- `+` over a run of terms takes a run rule at the operator site, as the add run does.
- Every operation family the value side composes has its class rule, or the reason it composes nothing. The families
  are reads, projections, `get` and `otherwise`, literals, ingresses, the add run, `+`, `addAll`, conversions and
  selections. Each family that composes has a work family that measures it.

**Reason.** An inventory of class sites built from the shapes found had missed a literal-rooted projection and a k-term
`+` read at k fields, each superlinear. An enumeration of the families leaves no site unlisted.

**Source.** The lead's ruling on stage S6c's review round 5, PR #1055, 2026-10-27.

### r4-135

**No syntax decision at a stop before admission settled.**

**Rule.** At a stop before admission settled, no place is decided from its syntax. The finishing pass marks every
inferred store, so each owes its runtime check. At a stop after admission settled, the syntax decision stays, reading
the decision admission retained.

**Reason.** Admission's decision reads a place's contract first, and after a stop the solver finishes nothing more
(the owner's decision D4: past the allowance the analysis stops proving and nothing is solved further). So a syntax decision before admission settled would have needed a second
derivation of the contract from the literal stores. Refused instead: solving the contracts of literal-only places after
a stop, which reopens the stop's bound, and answering the contract from the literal stores directly. An author at an
early stop sees a runtime check where a compile error stood, never a vanished error.

**Source.** Stage S8 part 3, the ruling after the build attempt, #1165, 2026-10-28.

### r4-154

**Rule A2 checks where a whole copy meets the place.**

**Rule.** Rule A2 is checked where a copy meets the place, through whole copies in live groups:
- a literal of whole copies with conflicting property types is TSV044 at that literal;
- a place receiving whole copies errs at the store.

A conflict reached only through a projection or a stepped copy keeps the listed answer and is reported where the value
is read, never silently lost.

**Reason.** A general design over held nodes made every witness answer as required, but its bound was not proved: its
alignment needed closure rounds that grew with the program, a new superlinear term. The owner's conditional yes was
measured on whole copies, so A2 is built there.

**Source.** The lead's ruling on Sol's design round 8 for #1188, 2026-10-28.

**Superseded in part by r4.167** (PR #1293, 2026-10-28): an acyclic projection such as `x.inner` counts as a whole copy
held by reference, so `let ys = [x.inner, y.inner]` is TSV044 at `y.inner`. Only the cycles that add steps
(`a.inner = a`, `a = a.inner`) keep the read-site answer.

### r4-162

**A site fact not proved gives words, never a code form.**

**Rule.** The facts a fix's validity predicate reads are three-valued: proved, disproved, or not proved. A code form is
offered only where every site fact is proved at the site. A fact that is not proved is never read as holding; the fix is
given in words.

**Reason.** Ten review rounds each found a new path by which a value reaches a site (an inline literal's element, an
interpolation's result), and each lost fact let an invalid form be offered. With three values, a path the traversal does
not follow can only under-offer, never offer an invalid form.

**Source.** The lead's ruling on Codex round 10 of PR #1296 (#1241), 2026-10-28.

### r4-164

**Shared admission summaries wait for their lifecycle contract.**

**Rule.** Admission's shared path cursors may be built on their own. Its shared structure summaries (suffix folds,
prefix continuations) are built only with their lifecycle contract: who owns a demand, how it is charged, provisional
publication, the component restart and invalidation at a stop. Recursive G4 is a separately reviewed bounded prototype.
Any change to the sharing-off mode's answers is a ruling with evidence, and the four modes stay equal in answers.

**Reason.** The design review found that a summary shared across demands needs that contract to stay sound under the
solver's restarts and stops. It also found that a bound which shares storage can still answer a triangular set of
residual queries.

**Source.** The lead's answers to the admission design G3/G4 (Sol round 1, Astra's review), 2026-10-28.

### r4-171

**A type suggestion is a type at the type position.**

**Rule.** A suggested type is proved as a form at the type position, so `(integer | string)[]` must parse there. The
message names the type ("declare it with the type '(integer | string)[]'"), never a whole declaration carrying the
author's start value.

**Reason.** V30 §13's example suggests `(integer | string)[]` for `let h: integer | string[] = 1`, but a declaration
with that start value does not compile. The start value is the author's own and keeps its own behaviour.

**Source.** The lead's ruling on Codex round 5 of PR #1273 (#1268), 2026-10-28.

### r4-180

**A newly stopped decision restarts the pass.**

**Rule.** A pass in which a decision newly stops is not settled. The next pass runs with every stopped key stopped from
its start, so no result in any order can have read the key before its stop. Independent reads redo their work under the
same allowances and keep their answers. A program stop inside the pass where a decision first stopped counts as not
settled, so the finishing pass marks the stores ([r4.135](#r4-135)). Finished work stands, and no cache is cleared at a
stop.

**Reason.** The solver keeps no dependency path over finished results, so a result that read the key before its stop
could not otherwise be found. Reusing the existing pass restart needs no new solver structure kept in every analysis,
unlike the rejected alternative of recording every cross-result read during setup and decisions.

**Source.** Stage S8 part 3, PR #1165, 2026-10-29.

**Bounded by [r4.183](#r4-183):** at most one restart per pass.

### r4-183

**At most one restart per pass; a stopped key narrows under a type test.**

**Rule.**
- **One restart.** At most one restart per pass. A decision that newly stops in the restarted pass stops the analysis,
  as a program stop does, and the finishing pass marks the stores.
- **Narrowing.** A stopped key reads as unknown data and narrows under a type test as host data does (V30 §13). Inside
  `if k is integer` the read is `integer`, proved by the test, with the test's reason, not `budget`. The negative branch
  and every unguarded read stay `unknown` for `budget`.

**Reason.** The restart of [r4.180](#r4-180) cascaded. A decision over a deep written type costs depth × copies against
an allowance linear in the program, so after its stop the next decision lacked its finished work and stopped too: 64
restarts and 13.3M units where one stop had cost 268,254. The bound never leaves a stale answer and at most doubles a
pass's work. Runtime checks where analysis is too costly are accepted design.

**Source.** Stage S8 part 3, PR #1165, 2026-10-29.

### r4-196

**A key family's lane is chosen once, from a frozen wrapper shape.**

**Rule.** A binding's keys for one first step (a `(binding, first step)` family) take one representation for the whole
pass: cursors or text. The choice comes from a frozen structural wrapper shape, made before the family's first key.
- An unknown shape stays text for the pass and is never promoted later; a fresh pass chooses afresh.
- Semantic reads apply the live stop checks, whatever the representation.
- Conversions go through one charged helper, memoised by fresh id.
- Labels are a deferred recipe.

The early selector's equality criterion is the build's acceptance:
- publications, admitted types, deciders, plans, routes and provenance are exactly unchanged;
- each family's choice is recorded once per pass, with its cost by producer and counter;
- moved work is accounted beside added work;
- every stop that moves at the default allowances is reported, with its cause.

**Reason.** An earlier cursor change stopped charging text and path walks that it still did, so its measured growth hid
a quadratic. Choosing a family's lane once, and never moving a family between lanes during a pass, keeps the work bound
provable and every unit charged.

**Source.** The lead's ruling accepting admission G3 stage 1 for building (Sol's design round 1, Astra's review),
2026-10-29; the earlier cursor PR #1422 closed.

### r4-208

**The finishing read's host frontier is bounded by construction.**

**Rule.** After a settled stop, the finishing read that finds the host data a key's stores hold through copy graphs is
bounded by construction:
- it follows the direct stores of the key and its ancestors, and copies to depth 2;
- it makes at most 8 frontier visits per read, indexed and memoised per place and path, with single-copy collapse.

Beyond that cut, the read answers the domain's kinds plus one external item carrying the place-level copy component's
ingress union. So its consumer owes its check through a mark, and the boundaries form as published checks: a superset,
never a dropped check.

**Reason.** The frontier went through four cost forms in four review rounds, each local repair exposing the next, and a
design round found no input-linear bound for the general design. A fixed cut with a conservative answer is bounded and
never drops a check. Measured before building: 33 of 11,688 finishing reads in the family were cut, none in the owner's
corpus or the fixtures, with no extra mark, warning, check or boundary.

**Source.** The lead's decision for PR #1445 (#1432, #1415), after Sol's design round, 2026-10-30.

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

### r4-251

**A deep read forwards through a singleton layer.**

**Rule.** Once `layersAt` has selected the holders, one eligibility rule serves the four summary consumers
(`summaryItems`, `summaryCount`, `summaryPresence`, `offendingStores`). It forwards to the one source's `subAt` demand,
with the caller's original rest of the path, when all of these hold:
- exactly one layer is selected;
- that layer has exactly one own source under the first step;
- there is no listing layer below that step, and no holder mark at the path.

Every other shape keeps its summary. There is no semantic cache.

**Reason.** Rebuilding the rest of the path for each layer was most of a deep read's cost. Forwarding the singleton case
closed #1466's deep read: at or under `main` at every sampled depth, with every stop regression removed. Compound and
multiple-top reads keep their summary runs.

**Source.** Sol's deep-read design round for #1466, and the lead's ruling, 2026-11-01.

### r4-277

**A value's kinds keep their written spelling where one spelling covers them.**

**Rule.** An item made from a written type carries its spelling (`Item.spelling`, the written kinds in written order).
Only the producers where a written type becomes items set it. Marks form a lattice, joined by `mergePair`: unmarked,
then one spelling, then mixed. One rule, `inItsOrder`, orders every list of kinds:
- the written spelling, where exactly one spelling covers every concrete kind in the list;
- the table order otherwise.

The spelling survives every transport where items are compared, replayed or restored.

**Reason.** Four review rounds each found a sibling of one family: a list of kinds put in table order where a written
spelling had to be kept, or the reverse. Ordering at publication could not tell the two classes apart, because the
publication sites read both. A mark carried from the producer can.

**Source.** The lead's ruling on PR #1558's design for #1398, after Codex round 5, 2026-11-02.

### r4-349

**A structure built only for sharing is charged as shared work.**

**Rule.** A structure that only sharing builds, here the alias classes' eligibility index, is built inside
`WorkLedger.shared`. Its work counts to the analysis's total and never to the decision that first asks for it.

**Reason.** With sharing on, the first decision that needed the class index paid for building it (14,456 units against
3,840 at depth 32), stopped, and left every deeper path `budget`. The author saw one "would take too long" warning per
copy where the unshared route gave one per element. Charging a shared build to the total keeps sharing from stopping a
decision that the unshared run finishes.

**Source.** PR #1714, merged as `63254271e` (#1703), 2026-11-04.

### r4-371

**A group's fold is declined through a member's non-own read.**

**Rule.**
- **Declined folds.** Where a folded group's read path passes through a member's read that is not its own object (an
  inline `.get`, a call, differing steps), the fold is declined, and those members answer per entry, as with sharing
  off.
- **Provenance reads.** A provenance read must not move the asking decision's stop: the member reads are charged as
  shared provenance work, to the total and not to the asker ([r4.349](#r4-349)).

**Reason.** Folding through such reads cost 4k² − 3k extra member reads through an inline `.get`, 2k² − k through a
call and k² on alternating projections, while the output stayed linear. Declining the fold is correct by construction,
because the location then agrees with the unshared route, and it adds no superlinear term over it.

**Source.** The lead's rulings on #1736, after Codex round 5, 2026-11-05.

### r4-375

**One solver-facing A4 service, shared by the solver and admission.**

**Rule.** The inherited written domain (A4) is one solver-facing service, read by the solver and by admission alike. It
exposes its reads to the solver's existing proof, component and held-choice lifecycle: no recursive admission run, no
private fixpoint, no new global restart. Admission reads the same completed proof. A completed A4 level never turns a
lost external-store descriptor into a complete proof. The call-site snapshot's scope stays F18's typed calls; other lazy
defaults keep their contract read.

**Reason.** The solver and admission disagreed on nine written-number copy records: the typed call answered `integer`
from its default, while admission decided the destination `number`. Reading admission's inherited marking from the
solver cannot work, because the inherited scan reads the solver's value items, so the typed call's answer would ask
itself. Two copies of A4, or an assertion in place of a construction, were rejected, as was a single restart, which has
no stability argument for general receiving dependencies.

**Source.** Sol's design round on #1072 (F18), and the lead's rulings, 2026-11-05.
