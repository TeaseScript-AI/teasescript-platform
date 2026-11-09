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
