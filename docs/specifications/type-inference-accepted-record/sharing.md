# The accepted record: sharing

Part of [the type inference's accepted record](README.md): work shared between copies and sources: alias classes,
copies, joins and discovery keys.

## Revisions

### r4-8

**A guarded copy keeps its source identity and carries its mark on the alias entry.**

**Rule.** A copy declared under a guard shares its source's contract entry by identity; its mark rides on the alias
entry. P3 refuses a key with a guarded source entry.

**Reason.** Separating guarded copies from their source made k copies read at k fields cost k × k again.

**Source.** M3 design review, Sol round 2 D1; the ruling records no date.

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

### r4-18

**A shared entry has one tested-path mark index, shared by reference.**

**Rule.** Each shared entry has one mark index keyed by tested path, queried by the demanded path and shared by
reference along aliases, with ledger controls.

**Reason.** Groups keyed by binding were walked per field, and copying lists along alias chains created another product.

**Source.** M3 design review, Astra round 5 D1–D3, 2026-10-23.

### r4-20

**Fill a mark index once per entry and contribution; memoise file returnability.**

**Rule.** Fill the mark index once per entry and contribution, never per alias, read or chain step, using a reference or
a flat per-entry array that does not fragment the index. Memoise returnability along a `goto` chain per file over the
transfer graph in one pass.

**Reason.** A file transfer exposed a lost registration behind a file `goto` and the per-file search; quadratic
returnability was not accepted.

**Source.** The lead's answers to the builder's round-10 questions, 2026-10-23.

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

### r4-38

**Whole-copy mark realisation covers fan-out and interleaved stores.**

**Rule.** Query the source's shared per-path mark index by the copy's own path and guard scope, never scan tested paths
per copy or chain step. Memoise the shared set per source and scope, not per first asker, so asking order cannot
rematerialise it. A descendant store excludes only the stored path from sharing, never the whole copy. These rules cover
sibling guarded copies and copies interleaved with stores to different fields.

**Reason.** A source's tested paths scanned per copy recreated a k × k product.

**Source.** The lead's ruling from Astra and Sol round 10, 2026-10-24.

**Bounded by:** The owner required these shapes to be fixed first in the port, with the reference-model repair following
without gating it (2026-10-24). The different products retained as gated known limits are scoped by
[r4.45](solver-and-work.md#r4-45).

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

### r4-163

**Choice cells share a class only through what they store.**

**Rule.** `#storedClass` gives two options' selected cells the same class when they store the same value. A read stores
its source identity through unchanged whole copies, with its own steps and holding guards; an inline wrapper stores its
structure, with each object separate. Nothing else stores a class: a store into a copy ends aliasing, a guard holding a
read belongs to its class, and an ingress gives no class. Compute the class once per cell and give it a short name.

**Reason.** One stored-value definition replaces `#heldClass` and its patched exceptions, allowing choice options to be
counted once per stored class.

**Source.** Merged PR #1300 for #1233, 2026-10-28.

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

### r4-176

**Dormant meetings are owed only where a containing node differs.**

**Rule.** A node containing another owes its recorded meetings only where the contained node is absent or the container
has its own payload. Merging found tries skips their shared parts; a node merged with itself owes nothing in either
sharing mode. `Touches.#rings` defines the ring mark once: it marks a node with a ring's trie at its own level or a
projection whose walk steps through one, never a ring-free sibling under a parent holding a ring. Containers holding a
ring keep their previous owing.

**Reason.** A ring-free sibling inheriting its parent's ring mark restored near-quadratic dormant work.

**Source.** Merged PR #1311 for #1270, including the repair after Astra round 2 B2, 2026-10-28.

### r4-190

**Role summaries need a state bound, exact transfers and solver-owned invalidation.**

**Rule.** Do not migrate semantic role summaries before bounding path/support states and dependency edges across paths,
prefixes and cold subsets, defining operation-specific transfers and bounded certificate equality, and proving G3
transitive invalidation and provisional-proof handling in a bounded prototype. Answer-equivalent summaries are an
implementation interpretation under exact per-mode baseline equality with existing scoped exceptions only, never a
blanket ordering waiver; the growth gate remains, and invalidation uses G3's `ProofDemand` lifecycle.

**Reason.** Repeated tie-rule repairs walked writers, peers, intermediates or cached decisions; the proposed recipe
graph still lacked a bound on semantic path states. `alternatives` is not associative, and ingress node ids do not
identify semantic leaf sets, so operation-specific transfers and certificate equality need their own proof.

**Source.** The lead's ruling after Sol role-data design round 1 and Astra's review for #1357 and PR #1359, 2026-10-29.

**Bounded by:** [r4.191](solver-and-work.md#r4-191) keeps semantic migration on hold after the second design round: the
joint path/support construction and exact-equality cost remain unproved, with no growth waiver. Merged PR #1417
(2026-10-29) applies only the interim cut: interned class ids, a class's own writer and role parts, and `roleMinima`
reading a class's writers only when a second member arrives; residual growth remains recorded as bugs. In that cut,
`KeptClass.roleParts` forwards a writer-less unary part to its sole child, while `classWriters` reads writers once per
value and side in a pre-order walk bounded by returned roles.

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

### r4-316

**A listing schedules only its effective sources in property search.**

**Rule.** A listing schedules only sources adding a name, task or listing that earlier sources did not add. Build
listings once per pass from definitions and the prefix index, deriving a layer's from its parent's, and forget them at a
stop. Keep the flat listing wherever an effective source could pump or is on the chain; the pump condition is the pump
check's own entry test for the source's place. Charge a classified source's step once, taking it at the first visit that
takes it up. The listing's names are independent of the question that made it; work may differ by order.

**Reason.** Visiting every source at every pump made diamonds of listings search quadratically.

**Source.** Merged PR #1617 for #1610, with the classification-charge repair after Codex round 1, 2026-11-02.

### r4-317

**Share leaf walks and ordered unions while replaying each demand's debit.**

**Rule.** With sharing, `leafRoles` walks once per starting value; further readers keep one entry and replay the rest of
the walk's charge through `WorkLedger.repeat`. `WorkLedger.repeat` counts units to the demand allowance and spender,
never the analysis total or a counter, does nothing after the stop or apart, and counts only to the spender inside a
shared build. Each member's leaves are one `rolesNode`; `setNode` folds the other members' nodes in list order through
ingress pair interning, charging m lookup steps as shared total work, without sorting, hashing or collision handling.
`heldLeaves` checks once per node and roles, with further checks counting the original charge; each demand keeps exactly
its former debit so no decision stop moves. For a list whose other members are fresh values, the lookup's `invSteps` may
add the named constant-per-list excess.

**Reason.** Per-list leaf walks, repeated unions in each list's order and repeated held-leaf checks created superlinear
work; sorting and collision scans exposed sibling costs.

**Source.** The lead's rulings after Codex rounds 1 and 2, applied by merged PR #1628 for #1573, 2026-11-03.

### r4-371

**A group's fold is declined through a member's non-own read.**

**Rule.**
- **Declined folds.** Where a folded group's read path passes through a member's read that is not its own object (an
  inline `.get`, a call, differing steps), the fold is declined, and those members answer per entry, as with sharing
  off.
- **Provenance reads.** A provenance read must not move the asking decision's stop: the member reads are charged as
  shared provenance work, to the total and not to the asker ([r4.349](solver-and-work.md#r4-349)).

**Reason.** Folding through such reads cost 4k² − 3k extra member reads through an inline `.get`, 2k² − k through a
call and k² on alternating projections, while the output stayed linear. Declining the fold is correct by construction,
because the location then agrees with the unshared route, and it adds no superlinear term over it.

**Source.** The lead's rulings on #1736, after Codex round 5, 2026-11-05.

### r4-385

**Projection cycles close through producer equations, never through equal answers.**

**Rule.** Use one ordered producer/content graph per structural position and epoch, reusing whole-copy component content
by reference, deriving projections one step at a time and linking a field returning into the ring to existing content.
Keep receiver-prefix proofs and the solver's existing proof protocol. Before construction, prove qualified finite
producer equations and their state bound, including overlays and terminal missing answers: equal items, level proofs or
copied-position sets do not establish a cycle; finite literal positions stay distinct and seedless cycles stay bottom.

**Reason.** Growing projection keys enlarged a raw solver component that restarted from bottom, exhausting the analysis
before admission even though retained memory was small.

**Source.** The lead's rulings on Sol's design for #1655, 2026-11-05.

**Bounded by:** [r4.396](contract.md#r4-396) applies the graph as a pushed read with explicit eligibility and native
fallback.

### r4-432

**A pushed read carries compiled mark states rather than mark histories.**

**Rule.** For [r4.396](contract.md#r4-396)'s pushed reads, a pending mark is a state of one compiled automaton of the
holders' marks, never a history: intern pending sets, compute each set's advance per step and each pair's union once,
and hold a reached base node once per goal with the union of all sets that reached it. Remove `canMarkBelow` pruning,
and compile one guard answer per holder/base group so tested-prefix visits equal distinct prefixes. For every admitted
finite holder H, history p and suffix t, some pending state after p accepts t exactly when `marksAt(H, p·t)`; keep one
pending set per base node per goal and holds/marks nesting at depth one. Exactness at a marking entry is tested over
every item pair of the condition. Respect the native `receiverWalk` floor: no shorter prefix's stores are read below a
receiver whose kinds have no structure. Pair pending mark states with receiver shapes and stop at that floor, carrying
its unknowns and accepted marks.

**Reason.** Declining marking routes fell back to a native read that grew a longer key at every read; histories and
repeated holder compilation introduced further growth.

**Source.** Merged PR #1859 for #1784, following Sol design D, Astra rounds 1–2 and Codex repairs, 2026-11-07. Merged PR
#2022 for #2005 adds the receiver floor, 2026-11-08.
