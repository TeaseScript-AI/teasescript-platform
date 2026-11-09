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
types conflict, and the error at the store that brings the other kind into a place receiving whole copies. An acyclic
projection (`x.inner`) counts as a whole copy held by reference; only a conflict reached through a step-adding cycle
(`a.inner = a`, `a = a.inner`) keeps the first-read answer.

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

### r4-83

**Known cost limits need evidence; sharing defects still need repair.**

**Rule.**

- A cost is a technical limit only with evidence that no reasonable fix exists. Superlinear work a reasonable fix
  removes is a bug.
- W34's two products keep the limits and gates in the owner's decision on W34's two known products (2026-10-24). The
  cross-source index stays a separate deferred change; these products are not value-side per-copy discovery.
- Read chains through nested literals are gated known limits under that decision's regression-gate and remeasurement
  rules. Their growing keys, charged contract text and admission prefixes belong to the nested-operation class accepted
  by the owner for PR #1050 (2026-10-27). The trie follow-up covers both; a realistic read chain approaching the
  allowance reopens the limit.
- Admission's repeated decider walks over `get` and alias siblings are assessed against F1's mechanism, with a separate
  bounded admission follow-up where F1 does not cover them.
- Sharing that changes published diagnostics or checks needs repair. Publication order follows the later rule named
  below; changed multisets remain a defect, judged by the member-answer oracle.
- Strictly alternating adds of several sources stay a gated known limit: one step per add per path is within §8 but
  outside §3.3's gate. A realistic alternating run approaching the allowance, or a sound summary found on paper, reopens
  it.
- Another sibling in value-side source sharing calls for reassessing the class keying before another repair.

**Reason.** Real read chains are about ten deep, and straight-line alternating adds number tens. Interned keys require a
cross-cutting change; an order-aware mixed-run summary requires a redesign of the exact add chain. The cheaper window
summary dropped a warning and its check, and a prefix memo shares nothing across distinct class sequences. That cost
outweighed the gain at realistic sizes; the sharing defects had no such justification.

**Source.** The lead's S6c rulings before Sol r4 and the owner's limit rule, PR #1055 at `c63e67974`, 2026-10-27.

**Bounded.** [r4.85](#r4-85) requires one discovery key and source-order-only mixed-add CI gates (PR #1055, 2026-10-27);
[r4.86](#r4-86) replaces discovery order with source-site publication order (PR #1059, 2026-10-27); [r4.87](#r4-87)
requires an enumeration of operation families (PR #1055, 2026-10-27).

### r4-85

**Every value-side discovery uses one class key.**

**Rule.** One class-key function serves a literal's computed values, a choice option's selected value, add runs, `get`
and `otherwise` defaults, and preset entries. The class is `contractClass` plus the role minima. The operation-family
enumeration required by the later ruling below records what each family composes, its class rule or why it composes
nothing, and a gate family for every composing family. Preserve published answers except for the later scoped
corrections named below.

Review constructs a shape per enumerated family, including families said to compose nothing, and states convergence
against that enumeration. A missing family stops the work for the lead. Mixed-add CI gates run in source order only; the
laptop series keeps the reversed order, whose measured difference was at most 0.0001.

**Reason.** Computed literal values used `contractClass` and role minima, while selected choice values used `readClass`,
which a computed `get` lacked. Each differently keyed site reproduced the same family. Another ordering rule would leave
that cause intact.

**Source.** The lead's ruling on Sol r4 B1 and source-sharing non-convergence, PR #1055 at `ced6f5be4`, 2026-10-27.

**Bounded.** [r4.87](#r4-87) requires an operation-family enumeration, a projection's owner class and roles in its
class, and a `+` run rule (PR #1055, 2026-10-27); PR #1208 (2026-10-27) summarises computed-key loads below one literal
path while preserving separate leaves and checks; PR #1212 (2026-10-27) unions projected host-read origins while keeping
each read's value-side entry and landing stop; the lead's revision-3 decision on #1188 (2026-10-28) replaces exact
baseline rejection records with the rule that a rejected store adds no contents but keeps its landing, a
still-disagreeing list gets its own error, later uses follow the first error's decided type and nothing warns or checks
against a rejected type, with kept sets compared against that invariant.

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

**Shared admission summaries wait for their query bound and their lifecycle contract.**

**Rule.** Admission's shared path cursors may be built on their own. Its shared structure summaries (suffix folds,
prefix continuations) are built only with both of these:
- a query bound proved by a count of the states over intermediate wrapper projections;
- their lifecycle contract: who owns a demand, how it is charged, provisional publication, the component restart and
  invalidation at a stop. Recursive G4 is a separately reviewed bounded prototype.
Any change to the sharing-off mode's answers is a ruling with evidence, and the four modes stay equal in answers.

**Reason.** The design review found that a summary shared across demands needs that contract to stay sound under the
solver's restarts and stops. It also found that a bound which shares storage can still answer a triangular set of
residual queries.

**Source.** The lead's answers to the admission design G3/G4 (Sol round 1, Astra's review), 2026-10-28.

### r4-165

**The question-source guard checks named syntax, with review beyond it.**

**Rule.** `check-question-sources` is syntactic and scoped within the core:

- every identifier reference to `finishedItems` or `#lazilyDecided`, including property accesses, aliases and
  destructurings by name, lies inside `CoreAnswers.#items`;
- every reference to `Consumers.#finishingRead` lies inside `Consumers.finishedItems` or a reader listed with its reason
  in `FINISHING_READERS`: the constructor's admission host read, `#valueItems`, its own recursion, or `#typedRead`.

A listed reader is trusted by its reason. Other named references fail the check. References the syntax does not name,
such as inherited members through inferred wrappers, generic receivers or computed names, are outside the guard and
reviewed against the S8 part-2 ruling after Astra r7 on PR #1063 (2026-10-28): one ordered-source endpoint answers every
direct or composed question. The guard states that scope. The question oracle and composed-shape matrix verify the
product rule.

**Reason.** Three review rounds found further ways to evade a type-aware guard through members, value flow, wrappers and
generic calls. A named syntactic boundary is checkable; extending a partial type or flow model did not close the family.

**Source.** S8 part 2, the question-source scope ruling after Codex r26–r28 on PR #1063, 2026-10-28, following the same
day's S8 ruling that listed host reads are trusted by their stated reasons.

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

### r4-182

**The obligation guard accepts listed forms and reports every other named reference.**

**Rule.** `check-obligation-inventory` is syntactic and name-scoped throughout the core. Its closed list recognises:

- direct `this.<member>(…)`, `this.readChecks.push(…)`, `boundaryCheck(…)` and an `error` parameter's call inside a
  listed derivation;
- a dot read of a listed read;
- a derivation moved to a function identified by its declaration, not its name.

Every other identifier reference by name to `readChecks`, `boundaryCheck`, an `error` parameter, `diagnostics` or any
`Admission` member is reported as unproved, including aliases and destructurings, wherever it stands and whatever flows
from it. There is no binding resolver, propagation graph or flow model. References the syntax does not name, including
inherited or generic access, computed names and values carried through aggregates or copies, are outside scope and a
review matter; the guard states that boundary.

The evidence covers the recognised forms passing and the reviewers' 24 forms and r1–r5 escapes being reported in both
layouts. New named forms are reported by construction; unnamed forms do not start further guard rounds. The product
evidence remains `OBLIGATION_SITES` and S8's stop evidence.

**Reason.** Five rounds found another TypeScript escape each time the guard tried to infer derivations across file
splits. A closed syntax list avoids turning the inventory check into an incomplete flow analyser.

**Source.** The obligation-inventory scope ruling after Codex r1–r5 on PRs #1360 and #1369, 2026-10-29, following the S8
ruling that listed host reads are trusted by their stated reasons (PR #1063, 2026-10-28) and [r4.165](#r4-165).

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

### r4-185

**Only the ring cut's case 5 admits an order-only difference.**

**Rule.** The whole-copy ring cut finds each cycle once per pass over the copies the prefix walk follows, recording its
ports and stops. A member with one live store at its root is a link; every other member is a stop. Each member's list is
equal to the baseline entry by entry in every order of asking, with one scoped exception: case 5, where a stop's entries
merge into one, from two copies reaching one stop or a copy of a place with no store.

For case 5 only, the equality projection admits a difference in item order or kind order in a decided type, taking the
baseline's open-stop choice. Diagnostics, checks, records, plans and deciders remain equal, and the comparison fails on
any other difference. Canonical publication order is a separate sharing-neutrality question.

**Reason.** The finite cut removes quadratic prefix entries. The baseline's case-5 choice depended on which place
entered the cycle first; reproducing it would retain entry dependence and require a second memo without changing the
checked meaning.

**Source.** G5 commit 5a, the lead's ruling on Codex r1's order criterion for PR #1394, 2026-10-29.

### r4-196

**A key family's lane is chosen once, from a frozen wrapper shape.**

**Rule.** A binding's keys for one first step (a `(binding, first step)` family) take one representation for the whole
pass: cursors or text. The choice comes from a frozen structural wrapper shape, made before the family's first key.
- An unknown shape stays text for the pass and is never promoted later; a fresh pass chooses afresh.
- Semantic reads apply the live stop checks, whatever the representation.
- Conversions go through one charged helper, memoised by fresh id.
- Labels are a deferred recipe.

The early selector's equality criterion is the build's acceptance:
- publications, admitted types, deciders, plans, routes and provenance are exactly unchanged where the work suffices;
  a publication may change only through a budget stop, with its marks and runtime checks, never as a changed unstopped
  answer, a lost unmarked check, a spurious error or a stale proof;
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

### r4-227

**A layer demand has a replayable logical name.**

**Rule.** Per-consumer layer summaries name a demand from the indexed program and path steps:

- `protoLayer|alias|<original place>||<requested path>`;
- `protoLayer|projected|<original place>|<source projection path>|<requested path>`.

The name is independent of prefix-query order, allocation numbers, trie versions and solver order. A layer allocation
number or support-trie node id is never its logical identity. Demand-name comparison, logical expansion and exported
names remain byte-unchanged; the packet already carries the paths. Import keeps the receiving arena's native tokens for
this family, and demand solving is unchanged.

Replay uses the pass's own `Contract`: an alias origin is re-derived from its prefix stores and alias layer, a projected
origin from its projected layer. A cut receiving prefix, unknown origin kind or missing layer is rejected; an arena
number is never guessed. The descriptor is cached by physical layer and canonical native path id, created and charged
once; the `recipeDemand` text is made once per pair and retained. The build keeps Sol's invariants and nine mutants,
Astra's consumer table, the identity and replay controls, and the level-3 evidence with inherited #1424 exceptions named
separately.

**Reason.** Allocation identity does not survive replay into an arena with a different history. The prototype reproduced
logical names and packets across histories, while the arena-id mutant failed in every mode, retaining the earlier bound
and answers.

**Source.** The lead's build-ready ruling for #1466 after Sol's replay-identity prototype r3 passed the replayability
and allocation-history gate required by Astra's design review, with the #1501 handoff, 2026-10-31.

**Bounded.** PR #1546 (2026-11-01) confines layer-demand identities to internal replay, outside plans and checkpoints.

### r4-245

**An output-bound family may pay an attributed constant per real pair.**

**Rule.** An output-bound family may exceed the baseline under both the per-doubling and largest-size clauses only when:

- `P` independently counts distinct real holder-layer/path answers from the generator's holders, never from demands
  made;
- the entire positive difference is attributed to the retained layer index and its solver demand runs;
- every new site's work is bounded by a fixed number per real pair, plus existing shared or input-sized work and
  identifier width;
- excess per real pair does not rise at later doublings;
- every mode reports total/baseline, excess/`P` and the site ledger, and `checks` stays at or below the baseline at
  every size.

Enumeration or support copying must not replace the ruled sharing on diamonds or listing chains; other families keep
their gate. The F1 family uses shared, reversed-join, mixed and pairs controls at one cheap doubling to assert `P` and
unique-pair demand creation; the 16–128 series and ledgers remain external evidence.

**Reason.** In the sibling with k reads over k layers, both trees owe `P = k² + 2k` answers. The excess per pair fell as
size grew and came from retained index and solver work. Singleton forwarding still exceeded the baseline and regressed
rings and diamonds; name interning cannot merge distinct pairs, a reference cache misses every pair, and one summary per
read re-enumerates support. Keeping PR #1546's head avoided those costs.

**Source.** The lead's ruling after Sol's summary-cost design round r1 on Codex r5 F1, PR #1546 at `14b4eadea` for
#1466, 2026-11-01.

**Bounded.** The lead's phase-B ruling on PR #1606 for #1526 (2026-11-02) compares newly charged capture work with the
baseline's charged total plus its uncounted work for the same obligations, judging an output-bound term per output node.

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

### r4-262

**A forwarded read makes a path id only when a summary needs it.**

**Rule.** A read that forwards through a singleton source makes its path id only where a summary demand needs it. The
alternating-feedback family belongs in the family kit and deep-read CI row; changing the source requires the full replay
again on the new candidate. The excess needs a cost repair, without a scoped growth waiver.

Separately, #1462's program-stop stall in mutual copies is fixed by #1551. Its regression coverage adds plain
variable-copy cycles stopped later in the walk in a reversed mode, because the existing coverage exercised call cycles
only.

**Reason.** Read selection made the path id before forwarding, although the forwarded read created no demand. The
alternating-feedback read therefore paid exactly `2D + 9` extra units in every mode. Both trees were superlinear, so the
gate's affine-excess clause did not admit it. For #1462, the verify-first comparison isolated the fix to the admission
boundary change: the parent stalled in reversed modes while the fixed candidate finished.

**Source.** The lead's cost-repair ruling on Astra r1 F1 for PR #1546 at `0ad45cdcc`, with Codex r11 assigned closure;
the #1462 verify-first ruling on `95e3c1020`, fixed by #1551, 2026-11-01.

**Bounded.** PR #1546 (2026-11-01) forbids making any path or span id during read selection, including alternate
interning routes.

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

### r4-299

**The combined-stop oracle proves open reads coarsely per unit and key.**

**Rule.** The combined-stop oracle uses coarse reading (a): per unit and by key, every open read of the reference run's
unit is answered by the combined run or quiet-skipped. It does not use dynamic per-invocation occurrence ids. The
written-set positive, Codex r4's B2 witness and the six `writtenObjectBelow` stops form one counted class, `coarse (a)
rejection`, with a named reason per member and no per-member exception. The ev9 mutant evidence reruns over every
family; a surviving mutant is a finding. A production hook for the oracle remains an owner decision, not an authorised
repair.

**Reason.** ESM consumers are called through local bindings, with no entry to wrap beyond the prototype and per-walk
fields, and V8's strict-mode call sites expose no call identity. Repeated calls at one loop position collide. An
inspector harness or rewritten module copy would be excluded test infrastructure, so the earlier ruling's named coarse
fallback is the available proof.

**Source.** The lead's rulings on Codex r4 B2 for PR #1597, replacing the finer reading in the 12:05 ruling, and on
Sol's reconciliation sweep at `366a42d42`, 2026-11-02.

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
