# The accepted record: admission

Part of [the type inference's accepted record](README.md): how a place's type is decided from its stores: admission's
tests, the decider, rejections, and ingress and boundary checks at stores.

## Rules of the design's tables

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

### r4-49

**`A6-chain`, admission's passes × stores, stays a gated known limit (the owner's decision).**

**Rule.** The product "admission's passes × stores (A6), charged" stays a gated known limit. Its shape is a chain of k
places, each copied from the previous one after that one received a wrong-kind store, then given such a store itself,
and ending in a written integer. Every link is a compile error, A6 decides in passes until stable, and the chain falls
one link per pass, so the cost is passes × program.

The gate is a regression check on the 64 → 128 growth step only, 3.92, not a bound at larger sizes. The allowance is
reached at k = 514, where the script gets one `budget-error` instead of its k errors. A change to admission's passes
re-measures and proposes the gate with its counts, and never retunes.
- **Trigger to reconsider:** a realistic script reaches the allowance through cascading rejections.

**Reason.** The owner chose option A. Option B is a worklist in rounds that re-examines only the stores whose evaluation
read a store whose rejection flipped, reproducing the passes' exact sequence of rejected sets. It is 800 to 1,500 lines
across eight core files, with a high risk of a stale answer, and needs a differential against the pass-based version.
The reference model has the same product (k + 3 passes). Of W8's 1,888 records, all but one take at most two passes.

**Source.** The owner's decision on `A6-chain`, through the orchestrator, after the S6 builder's section and the model
builder's probe, 2026-10-25.

**Bounded by:** option B is deferred to a separate PR.

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

### r4-177

**Admission reuses proven conflict classes, written-type cursors and indexed paths.**

**Rule.** A8 conflict discovery asks one representative per proven kind class through `Contract.classOf`,
`#conflictClass` and `#conflictGroups`. The groups union identity and class edges that preserve kinds at every path, use
their least tag as name and keep class, identity and F18 namespaces separate; finishing named literals bypass grouping
after a stop. `levelsOf` caches a written type's element-depth walk by `TypeTerm` identity and advances one element at a
time. `Contract.relevantSubs` indexes full paths so a preset read does not visit unrelated siblings.

**Reason.** These mechanisms remove repeated conflict-class discovery, repeated written-type walks and nonrecursive
preset sibling scans without claiming the remaining per-copy and per-path costs are solved.

**Source.** Merged PR #1319 for the bounded #1078 shapes and repeated written-type walks in #1194, 2026-10-28.

### r4-178

**Positioned-prefix proofs use the solver lifecycle and preserve the sharing seam.**

**Rule.** A positioned-prefix entry's proof payload is demand-owned, with semantic payload change detection; an ordinary
pass-local cache is insufficient. If the payload needs a second lifecycle rather than being a solver-owned result,
return that API seam to design. Both modes reuse the same original occurrence's prefix and compose original syntax-child
transfers; `withoutSharing` disables equivalent-value, alias-chain, level, stop and class answer reuse, and all four
modes remain equal in answers. Claim closure only for proved families; report a nonseparable contextual-frontier residue
with its state count and cause, without relabelling it as a technical limit, and keep allowances unchanged.

**Reason.** Solver ownership avoids a second proof lifecycle, and sharing-off retains only the original-occurrence and
original-child reuse that the ruling permits.

**Source.** The lead's G3 build rulings after Sol round 2 and Astra design review round 2, 2026-10-29.

### r4-181

**A whole-copy ring uses one finite cut with distinct member ports.**

**Rule.** Represent each whole-copy ring once as a component with distinct member ports and one closed prefix result,
using a finite simultaneous cut. Use one shared inherited contract and decision recipe with sparse member-local ordered
overlays; each member keeps its own decision, type and site. Position each contribution's flow on G3 continuations and
solver-owned payloads, with one contribution comparison and a sparse obligation frontier. The bound is O(N + E + Q + F +
U + J + P), strictly linear for the proved transparent sparse ring families and output-sensitive for the conflicting
four-axis case, with contextual F/U growth exposed. Sharing-off reuses the original ring equation and original child
proof once while keeping each member and copy occurrence distinct and every disabled equivalent-answer reuse disabled.
Keep the solver's single lifecycle and existing allowances; return a failed cut-equivalence, sharing-seam or
named-family bound to design before dependent work.

**Reason.** The finite simultaneous cut replaces entry-dependent discovery while retaining each member's own answer and
site.

**Source.** The lead's four rulings on Sol's G5 design and Astra's design review, 2026-10-29.

**Bounded by:** Merged PR #1394 (2026-10-29) applies the finite cut with entry-by-entry equality in every query order,
subject only to [r4.185](oracles.md#r4-185)'s case-5 order exception.

### r4-197

**Stored-value readers use ordered transfers from one recipe per task.**

**Rule.** `admission/walk.ts` keeps one `expand` recipe per task, memoised per pass, and `stopsOf` uses the same DFS
over those recipes. `heldMeetings` reads A2's `heldInput` view per task and lane, with owing unchanged.
`transferredDecider` supplies `earliestDecider`'s value phase from decider groups: merge choice rows in key order, test
eligibility per entry before choosing the earliest, and do not read below an operation at the path's end. With sharing,
read once per class and path and keep answers per group, rest of path and mask; a written copy on the path asking a type
falls back to the stop scan in its own order. `valueStructure` and `collect` keep structure per value and strip, holding
parts by reference.

**Reason.** Reading carrier transfers replaces the per-element `ownOf` to `stopsOf` walk and removes the
nested-selection and nested-choice decision products.

**Source.** Merged PR #1423, G3 part 2, 2026-10-29.

**Bounded by:** [r4.336](#r4-336) replaces the written-copy fallback outside decisions with group summaries, keeping
decision scans unchanged.

### r4-202

**A decider region holds paths as parent-linked step nodes.**

**Rule.** A `regionOf` path in `admission/transfers/regions.ts` is a `RegionPath` node one step below its parent, never an array
or text. `forEachPath` follows the decided path's rest node by node, each node remembers its path's distinct values, and
`holdsWritten` reads the two facts recorded when the region is made. Path equality remains exactly the former text
equality, because a step contains no dot; preserve the former region's charges to the unit.

**Reason.** Text-keyed regions duplicated every level's arrays and text inside the decision demand, turning a deep
literal's linear decision quadratic and exhausting its allowance. A changed per-path charge moved decisions across fixed
allowances, so it was restored.

**Source.** Merged PR #1441 for #1438, 2026-10-29.

### r4-234

**A preparation generator owns its dependency frame while it advances.**

**Rule.** In a written-decider proof bridge, each preparation generator owns an explicit frame active only while it
advances, with suspension, resumption and abandonment on a cycle restart. Attribute reads to the active frame and cached
link answers to the frame that first produced them or reread them; retain the stack-mismatch assertion as an invariant
that never fires. For typed parameter defaults mixing host, null and literal elements, with loop items copied to typed
bindings, retain the reference scan's decider and inherited provenance.

**Reason.** The waiting driver can suspend or abandon a preparation generator out of stack order when a cycle grows, so
an admission-wide lifetime stack attributes dependencies to the wrong owner. An unchanged admitted type alone is
insufficient: the typed-set case kept its kinds but changed its decider and inherited flag.

**Source.** The lead's decision after Sol prototype round 6 for #1444(b,c), directing round 7, 2026-10-31.

**Bounded by:** The lead held #1444(b,c)'s proof bridge for its cost (2026-10-31); [r4.336](#r4-336) replaces its frame
machinery with a decomposition needing no proof bridge. The decider and inherited-provenance requirement remains.

### r4-336

**Summarise written deciders only outside decisions, with forget epochs.**

**Rule.** Answer `earliestDecider` questions outside decisions from a rank-ordered fold of group regions, one summary
per group, rest and masks, using written-copy representatives and a lazy first value. An open list join takes its
operand first; otherwise take the earlier of the earliest written copy and earliest deciding value. This replaces
[r4.197](#r4-197)'s written-copy fallback outside decisions and [r4.234](#r4-234)'s proof bridge. Keep a decision's own
scan unchanged, so its debits remain identical by construction and no proof bridge is needed. Use `Solver.forget`'s
count as the summary epoch, replace summary maps whole when it changes and never write the ordinary caches after a
forget. A routed question reaches no decision: `into === null`, with a depth flag enforcing that boundary.

**Reason.** The quadratic cost was entirely in questions outside decisions; leaving decision scans intact removes the
need to bridge summary proofs into their debit lifecycle.

**Source.** Merged PR #1685 for #1444(b,c), 2026-11-04.

### r4-360

**An admitted-structure certificate waits for its depth and noninterference proofs.**

**Rule.** Do not construct the admitted-structure certificate while its soundness argument is incomplete; resume only
after closing the check-depth bound and C5, the decider-site noninterference proof for callers continuing after
`SliceDepth`. Narrowing it to a direct-spine shadow-only construction with the oracle as its only test requires a
separate owner-visible decision.

**Reason.** Equal `LevelProof`s at several depths did not prevent a later finite check, and recording shared work moved
a stop at the total allowance. The direct-spine recurrence left the general depth bound, local-flow case, passivity and
C5 unresolved.

**Source.** The lead's ruling after Astra's two design reviews and Sol's revised proposal review for #1646, 2026-11-05.

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

### r4-377

**Copy deciders use a grounded carried-domain proof on the shared selection service.**

**Rule.** Extend [r4.375](#r4-375)'s solver-facing selection service with a grounded carried-domain proof consumed by
admission, transfers, literal checking and numeric obligations. A copy retains its attached type rather than deciding
from current items; rejected or external values decide nothing. Keep the written-receiver projection separate: an
inferred number is not F18's written context, and current-value certainty, guards, presence and ingress provenance
remain separate facts. Distinguish independently modified copies sharing one origin, and schedule a constrained
descendant of an open incoming object as a copy-boundary decision discharged by the ordinary receiving route.

**Reason.** The copy-decider family needs to distinguish carried domains from current values, independently modified
copies from a common origin, and constrained descendants of open incoming objects.

**Source.** The lead's rulings on Sol's copy-decider family design for #1745, #1751, #1752, #1746 and #1749, 2026-11-05.
