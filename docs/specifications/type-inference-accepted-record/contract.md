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

### r4-129

**A stored stable-path read takes its narrowing where it holds.**

**Rule.** A read of a stable path inside a stored value takes its narrowing where it holds: a nearer definition after G
supersedes it, and one before G is filtered. N5's preserving stores solve as one solver component starting from every
store preserving, and publish only when stable; the events module has no separate evaluator. A loop-local test takes its
input from the key's contract. A lost fact reruns only the nodes above its store, the union per location and loop, and
the readers of each changed node.

**Reason.** The preserving-store answer is published only after the joint solver component stabilises, replacing the
events module's separate evaluator.

**Source.** S10 part 2b, merged PR #1228, 2026-10-28.

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

### r4-249

**A filtered property fold stays outside the ordinary complete memo.**

**Rule.** Classify sparse-property eligibility in `prefixLevels`' existing charged entry loop before any sparse list
exists: a whole, unguarded, ingress-free closed object literal whose holder marks nothing. Typed and open values inside
keep their ordinary path, and unproved prefixes and deeper paths fall back. A filtered fold neither reads nor writes
`Contract.levelGroups`; retain the complete memo for recursive fallback, let the existing contract demand own the
filtered answer and use existing prefix, path and property identities.

**Reason.** Isolating filtered and ordinary folds preserves the complete memo for recursive fallback and avoids the
parent/deeper cache defect exposed by the first prototype.

**Source.** The lead's build decision after Sol prototype round 2 for #1456, 2026-11-01.

**Bounded by:** Merged PR #1549 (2026-11-02) applies one predicate to every prefix entry, requiring at least two whole
closed objects and excluding projections, copied keys, elements, cells, guards and ingress, with nonmarking holders and
level membership when sharing. It answers one-step properties through a per-pass property index, choosing the earliest
literal writer for F11 `missing` and the first-stored alike group when sharing; it originally built only after property
reads spent more than the prefix's size. [r4.450](#r4-450) extends deeper reads and changes that pay rule.

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

### r4-300

**Canonical kind order exempts null, unknown and empty from spelling coverage.**

**Rule.** This extends [r4.277](#r4-277): use the written spelling where exactly one spelling covers every kind except
`null`, `unknown` and `empty`; otherwise use the value-kinds table order, then `unknown`, then `empty`. Written-type
items, their copies, a type test's written type and the stores' syntax by one carry `spelling`; `joinSpelling` is
commutative and associative, with `MIXED` absorbing. Apply the idempotent `inItsOrder` when making lists in merges,
stopped answers, finishing reads and compositions, and again at publication; fixed tables such as a warning's `fits` and
lists carrying no spelling keep table order. Include spelling in `itemsSignature` and `Values.narrowingMark`, read once
per form; append it in `classed` only where `readClass` supplied none, so no class charges it twice. `annotationTags`
walks each written type once per form and pass; sorting at most one item per kind is bounded by the entries already
charged and has no separate charge.

**Reason.** First-discovery order made answers, suggestions, checks and decided types depend on consumer order, solver
order and sharing.

**Source.** Merged PR #1558 for #1398 and #1299, including the repair after Codex round 10, 2026-11-02.

### r4-386

**Non-own object reads need a solver-managed objects query before fold integration.**

**Rule.** `objectsAt(value, q)` returns the objects held by a member's completed read at prefix q, with tokens, names
and a step's absence support, through solver-managed proofs obeying provisional, reset and forget rules. This read-layer
service neighbours [r4.375](admission.md#r4-375)'s A4 service and remains separate from it. Keep
[r4.371](sharing.md#r4-371)'s declined fold until the query is proved; integrate with one shared absence scan per
members, q and lacking class, retaining `absenceClass` for the own-object class. The missing writer equals the unshared
join's, provenance work is shared and no decision stop moves. The fold integration must be linear in each of #1736's
four families.

**Reason.** The objects query supplies the missing and absence facts required to integrate folds through non-own reads
without changing the unshared missing writer or the asking decision's stop.

**Source.** The lead's rulings on Sol's design for #1747, 2026-11-05.

### r4-396

**A pushed projection read solves a finite producer graph from empty sets.**

**Rule.** Below a key entry's writing edge in a copy cycle through a projection, or a store's writing edge whose value
is such a binding's property-read chain, join the leaves reached over `contract/frontier.ts`'s finite producer graph.
Nodes are binding positions, with one root per whole-copy cycle, literal-index nodes and leaves; `Sum(node, step)` is
the least solution from empty sets and cycles close only through producer edges. A pushed read is an ordinary `pr|` or
`pv|` demand forgotten at any stop, and the graph is shared work under [r4.349](solver-and-work.md#r4-349). Otherwise
use the native reader: exclude written bindings, guarded or marked copies or host reads, ingress, cursors, wrappers,
alias layers, selection, index or member steps, collection elements, host data at an element step, values stepped below
a push and stops on held places. Every settled slot and publication equals the native reader on finite controls in all
four modes.

**Reason.** The finite producer graph lets a whole-copy ring read through a projection reach consumers instead of
exhausting setup.

**Source.** Merged PR #1768 for #1655 under the lead's accepted [r4.385](sharing.md#r4-385) design, 2026-11-05.

**Bounded by:** [r4.432](sharing.md#r4-432) extends pushed reads through marking routes using compiled mark states.

### r4-403

**Read the nearest narrowing at the read node and retain ingress provenance.**

**Rule.** This changes [section-3-2-guarded](#section-3-2-guarded): each read takes its nearest narrowing G at its own
node through `Values.#narrowingOf`, and a definition after G's entry that reaches the read answers it. A consumer's
descendant demand takes the G of its whole path through one charged `NarrowingIndex.nearestAt` walk, for consumers only,
leaving alias-class answers unchanged. `fromExternal` travels through value-keeping `marksOf` transfers, is dropped by
`computedMarks` results and is attached by `entered` at ingress as to an external unknown. Both C9 predicates use
`isExternal || fromExternal`, and a stopped ingress read keeps its provenance.

**Reason.** A type test proves a kind, never an ingress; a reaching assignment after the test must not be hidden by the
earlier narrowing.

**Source.** The lead's ruling (a), applied by merged PR #1770 for #1073 PR 2 phase 1, 2026-11-05.

### r4-444

**Route certificates prove producers conservatively and refuse unavailable arm evidence.**

**Rule.** AD-1's `#valueProduces` certifies a read by what the producer's value holds: a literal, any default, lookup,
parse, void exit or written type; a never-selected fallback certifies nothing. Null that another callable or handler may
store and a use tested against the same producer stay warning cases. Answer whole-copy descendants by value rather than
one route per field; a called function's written union proves itself at its use, with C1's copy rule applied at a store.
`RouteTests.checked` alone decides the closed tested-producer set: N1 tests under and/or/not, uses in guarded
arms, later conjuncts and uses after passed statements with no intervening label. A guard held inside a loop or switch
does not propagate past it; a `while` whose false condition proves the test and that no `break` leaves can pass. An
unproved exit kind or arm shape counts as not tested, including the under-offers of a loop holding a guard and a guard
followed by a label. Promote through the certificate only where no live arm of an admitted callable is infeasible by
entry narrowing; a stopped decision, nonexternal `unknown` or empty answer is unavailable and blocks promotion, while
external `unknown` is an answer. U5's word comes from the failing event, naming a collection's invalidation `member`.

**Reason.** Per-arm and per-callable guards failed under whole copies, nesting and transitively reached callables; the
program default prevents those false required-check errors. An unavailable stopped input cannot justify promotion to an
error.

**Source.** Merged PR #1937 for #1073 PR 4, including the lead's F2 rulings and the final three-outcome `#infeasible`
repair, 2026-11-07.

### r4-450

**Read closed-object property descendants from holders and pay for indexing by saved folds.**

**Rule.** `propertyItems` accepts a rest starting with a property unless any step is `SELECTED_VALUE` or
`SELECTED_TEXT`; selection paths read every entry separately. Otherwise fold only that property's holders at any depth;
keep the fold once per path below a deeper read inside the property index, never in `Contract.levelGroups`. Below a
property every source holds, and wherever holders cover every source the levels path answers; the equivalence lasts for
the pass's property index. For `landed`, index each copy path's copies by the first step past their strips taken by
their sources' seeds; prove a source only when `landedOwn` answers from its seeds alone, and take every other copy for
every step. Change #1456's pay rule as applied in [r4.249](#r4-249): build the index once the folds its reads would save
reach its construction cost, counting names once and holders once per name with integers. Per counter, permit only the
declared terms: once-per-prefix, source-linear pay bookkeeping, exactly the sources' name count added to unshared
`structureSteps` and under 1.5 times the baseline on that counter for `shared-past`'s quadratic case; plus pre-pay folds
on `none-below` and `none-at`.

**Reason.** A nonholder's read below is F11 `missing`, and fold keys hold the root's property names; seed-only proof
makes excluding a landed copy fail closed.

**Source.** The lead's design rulings 1–6, applied by merged PR #2064 for #1948 and #1585, 2026-11-08.

### r4-451

**A `null` that reaches a use through an entry is the use's required check.**

**Rule.** This bounds [r4-444](#r4-444): beside its forward route, AD-1 promotes a `null` item reaching a use through an
entry. An entry reads a route as the forward rule does, a route of the program's
flow (ADR 0021 rules 5.5 and 5.6): a value the compiler knows, such as a loop's count or list held in a variable,
removes no route. Entries: a loop's head (from its live predecessors in its body, none for a `for` over a one-element
literal), a label (its live `goto`s and its fall-through), a file's start (from a literal
`goto "f"` or `goto script("f")`; a glob, a computed target or a jump from block code is none), and a block body's
start, which carries a `null` item with no writer and names the registering statement. A segment is unchecked only when no
statement on it holds the key's root name in a test position (`==`, `!=`, `is`, `is not`, `and`, `or`, `not` operands;
an `if` or `while` condition; a `switch` subject or case value), stores or binds it, or hands it to a call (its
arguments or receiver; for a key owned outside the segment's activation, any call of an author function or a file's
`call`). Passed compound statements count in every part, entered ones by their header. Per key, the jumps in its
certified `null` stores' stretches (to the first later statement holding the name in that block or one around it; no
other jump can be seeded) are tried as seeds in source order and propagated once per entry; the use takes its innermost
nearest carrying entry, then its body's start. Many keys over many jumps cost their product (the gated known product
in `docs/RESOURCE-LIMITS.md`); loops nested k deep cost jumps × depth, which the nesting limit bounds.
Inside a block body the forward route admits the body's own definitions. In a program the route rule's default holds
(R2.2), only a loop's or a label's entry T is taken, and only where a run is proved to reach T and then the store, the
jump and the use: a label in the top level of the file the session starts in, or a loop that stands where a route may
promote, with nothing before it that a route may not pass; each of the three standing after T (its boundary none or
T's label, no arm on its chain that no run is proved to enter, no loop's body but T's own), with no such statement
before it in its blocks, counted after T in T's block. A statement inside an arm proved never entered marks no
statement above that arm there. A seed alone carries; nothing is carried on through a further jump. Kept as warnings:
written-union members, X7, block-reachable foreground uses, under the program default every other entry route, and
copies whose source's `null` arrives through an entry.

**Reason.** The text's error (V30 §13) for a value an earlier round, a label, a file transfer or a block body brings;
closing a segment on any held name keeps every give-up a warning, never a false error.

**Source.** The lead's HEAD 0 rulings R27 to R35 for #2497 pull request 1, 2026-11-12; R52 to R56 for pull request 2
(R2.2), 2026-11-12.

### r4-452

**Read a call of an identity function as its argument in parentheses.**

**Rule.** An identity function has exactly one parameter, with no type and no default, no result type, and a body that
is exactly `return` of that parameter. The analysis reads a call as `(argument)`, keeping the call's span, where its
callee is a plain name that the project declares as exactly one function, that function is an identity function visible
from the call's file (global, or the file's own), no parameter or variable of the enclosing function has the name, and
the call has one positional argument. A call that stands in a place slot (a store's receiver chain, the receiver of a
method that changes it, read through any parentheses on the way) stays a call: its result is a copy. A test of the
call's result narrows its argument, as a test of `(argument)` does. The analysis reads a view of the syntax built before
the collector; the front end and the plan read the source, and each syntax node that crosses between them is translated.
A call read as its argument is no function result: a guarded argument's mark
([section-3-2-guarded](#section-3-2-guarded)) travels as through parentheses. A narrowing holds across such a call as
across `(argument)`. Rule 1.2's widening of the parameter by the function's other calls is not modelled: the call gives
what `(argument)` gives, the class #1173 holds for copies.

**Reason.** One result shared by every call merged unrelated arguments: on the converted packages it gave false
warnings and errors and ran past the work allowance. ADR 0021 rule 5.5 drops a check across a call because a call may
run code that changes the path; an identity call runs its argument and nothing else.

**Source.** The lead's rulings R22 to R26 on #2493's plan (AST view; the predicate; the widening a named gap; narrowing
kept), R34 (a guarded argument's mark through such a call), R41, R42, R45 and R49 (a call in a place slot stays a call,
parentheses read through; a test is no place slot), applied by #2493's pull request, 2026-11-12.

### r4-455

**Cut a cycle that nests a list, set or dict deeper on each turn one level below what enters it.**

**Rule.** ADR 0021 rule 1.1's nesting cycle. An element level is a list's or a set's element or a dict's value. The
routes of a pass's places, each weighted by the element levels a value gains along it: a list literal's element and an
`add` +1; a copy, an argument, a return, a read and a call's result 0; a store through a path its element steps; a
projection or an operation the element steps it stands below in its operand (`carriers.ts`'s carrier kinds, each given a
route or none in one table; a choice's answer none). The routes are the stores the contract reads: a store in code no
run reaches is one, and a place with a written type takes its routes, its written levels its own depth, so no cut lands
inside them. A strongly connected component holding a cycle of positive weight is cut at `M + 1`, `M` the deepest
element level entering it from outside: the level a value brings by itself (a written or literal type's, a kind's
declared elements', a dict's `keys`', at least 0 for an expression's value), an earlier component's known level, a
growing one's at its cut. Property routes are followed by name: a component that grows with names ignored is solved
again with one position per place and property, and only a cycle that grows there is cut; a route through two property
steps or more has no position and is never cut. A key below its place's cut depth answers an opaque unknown (rule 1.7)
before any demand is made. The index is built on the first key with two element steps, once per pass, as a shared build.

**Reason.** Under F20 and F21 a function that wraps its argument in a list and is called on its own result has types
without end: the candidate route asked ever deeper paths (1.35 million units at two calls) and ended with TSV076 or a
slice refusal. The cut depends on the graph alone, never on the order anything is asked in.

**Source.** The owner's decisions of 2026-11-14 on rule 1.1, and the lead's rulings on #2764's plan (rule B, the cut at
`M + 1`, property routes by name, the carrier table's routes) and of 2026-11-14 (the index routes the stores the contract
reads), applied by #2764's pull request.
