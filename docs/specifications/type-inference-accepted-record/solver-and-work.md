# The accepted record: solver and work

Part of [the type inference's accepted record](README.md): the solver's mechanics and charged work: demand, allowances,
work units, growth products, indexes, determinism and order.

## Revisions

### r4-26

**Registration reachability and returnability share one least fixpoint.**

**Rule.** Registration reachability and returnability are one least fixpoint: a registration after a non-returning call
contributes nothing. The core takes the name pass's picks as input and makes no claim about that pass's caching.

**Reason.** A registration beyond a call that never returns is unreachable.

**Source.** The lead's S1 ruling after Astra's review round 2, 2026-10-24.

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

### r4-45

**The two known products of W34's realization stay gated known limits (the owner's decision).**

**Rule.** Two products of the port's tested-and-copied-source lookup stay gated known limits:
- (a) more than four tested sources, each in more than four anchors of one tree, read many times at one path;
- (b) sources copied from more than four shared roots, stored at one path every copy reads.

The gate is a regression check on the 64 → 128 growth step only (3.37 for (a) and 2.53 for (b)), not a bound at larger
sizes. A change to that lookup re-measures and proposes the gate with its counts, and never retunes a threshold to
protect the margin.
- **Trigger to reconsider:** a realistic script shows both dimensions: many tested or copied sources meeting at one
  path, each with many anchors, read there many times.

**Reason.** The owner chose option A over option B, a cross-source index per path, because B costs a lot, would create a
bigger problem elsewhere (it moves the cost to the other axis, a source's anchors × its tested or stored paths), can be
made linear later, and is written down so it can be reconsidered. The products reach the allowance floor only between
k = 512 and 1,024 for (a), and beyond k ≈ 4,000 for (b). These are different shapes from the close shapes the port fixed
first, which are linear at k = 1,024 in both orders.

**Source.** The owner's decision on S4's two known products, through the orchestrator, after Astra's round-2 judgment
and the S4 builder's estimate, 2026-10-24.

**Bounded by:** option B is deferred; if it comes, it is a separate PR after S4.

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

**Bounded.** [r4.85](sharing.md#r4-85) requires one discovery key and source-order-only mixed-add CI gates (PR #1055, 2026-10-27);
[r4.86](#r4-86) replaces discovery order with source-site publication order (PR #1059, 2026-10-27); [r4.87](sharing.md#r4-87)
requires an enumeration of operation families (PR #1055, 2026-10-27).

### r4-86

**Diagnostics and owed checks are published in source order of their sites.**

**Rule.** Diagnostics and owed checks are published in source order of their sites: file order, then the site's offset
and end, with the items at one site in the consumers' rule order. They are sorted once, when the result is assembled.

**Reason.** The order in which an eager landing queue first reached each path was an artefact of a mechanism the design
removed, and it differed between demand orders and between sharing on and off. A rule gives one order in every mode, so
the standing differential's text comparison ([r4.72](sharing.md#r4-72)) rests on a rule, not on discovery order.

**Source.** The lead's ruling on review round 3 of the F1 repair, PR #1059, 2026-10-27.

### r4-187

**Proof payloads follow the solver lifecycle beside their items.**

**Rule.** A `ProofDemand` proves a payload beside its items, read only through `Solver.proven`: provisional while
unfinished, reset from bottom at each start, compared by semantic signature, precharged before retention and forgotten
at a stop. A `ProofDecision` holds a restart when only the proof differs, and each new pass has a new solver. A
literal's index is a trie sharing a nested literal alone at a step by reference, with step-only path ids and bottom-up
signatures and structure identities using the same partition, preserving property discovery order. A property or index
occurrence's contract is a demand one step from its owner's; a stop forgets occurrence answers made since the previous
stop so subsequent reads reach `contractOf`'s stopped-key check, while a pass starting with stopped keys keeps its
cache.

**Reason.** An occurrence cache could return a definite completed answer before testing a newly stopped key.

**Source.** Merged PR #1375, including the repair after Astra round 1, 2026-10-29.

### r4-191

**A short semantic answer does not bound its internal support construction.**

**Rule.** The contract-role semantic migration remains held without a proved joint path/support bound and exact-equality
cost, with no growth waiver. Transfers keep their original normalization boundaries, accumulating raw items before
`alternatives`; a fixed original-source tie order needs proved role alignment, identical null masks, equivalent
transfers and complete fan/leaf preservation. The lifecycle proof covers retained reverse dependencies, completion-aware
use, transitive forgetting, held/component resets and atomic invalidation, with production stopped-path observer
coverage.

**Reason.** Linear source/path vertices can still require a product of membership edges, so a small published answer
does not make that internal work output-bound.

**Source.** The lead's ruling after Sol's contract-role design round 2, #1421, 2026-10-29.

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

### r4-201

**A literal contract at a path is one demand per literal and path.**

**Rule.** `valueAt` reads a literal contract through the `cl` demand once per literal and path, regardless of the
caller. Every crossing between nested literal indexes passes through that demand, including through indexes, `.first`,
`.last`, methods and `otherwise`; nested literals sharing one index do not cross. Each gather reads the inner level's
merged answer and adds only its own items, a bounded delta per level.

**Reason.** Inline recursion without an intervening demand merged every inner level's items again for each outer query.

**Source.** Merged PR #1443 for #1426, 2026-10-29.

### r4-204

**Pass-local key cursors cross one charged conversion boundary.**

**Rule.** A key cursor is `place#pathId` in the pass's path arena shared with literal indexes, built one step from its
parent; equality needs no text, and parent, step, depth and first-step reads are constant time. Raw ids never cross a
pass or checkpoint: `exportKeyIds` and `importKeyIds` use a validated parent-first packet. `keyIdOf`, `keyIdOfText`,
`keyOfId`, `stepsOfId`, `memberStepIn` and `compareKeyIds` charge every inspected node and code unit through `convert`
and kept helpers, memoised per id rather than per prefix. `compareKeyIds` preserves key-text UTF-16 order by comparing
steps in place with a virtual dot sentinel. The frozen family lane of [r4.196](#r4-196) keeps occurrence and stop
conditions live; a question during shape construction, settlement or mark collection fixes that family to text for the
pass.

**Reason.** Raw ids can name a different key in another pass, and temporary comparison text hid growing allocation
behind a much smaller charge.

**Source.** Merged PR #1454, with Codex and Astra conversion repairs, 2026-10-30.

**Bounded by:** [r4.227](#r4-227) applies the same replayable logical-identity rule to layer demands.

### r4-218

**Cursor paths carry one canonical representation and one charged fact record.**

**Rule.** Where `keyLane` chooses cursors, projection keys extend the preceding cursor and the decided-path flow carries
it end to end; text crosses only [r4.204](#r4-204) and labels use recipes, with the text lane unchanged. Canonicalize
every entry: only canonical functions produce `CanonicalKey`, cursor-owned maps use that brand, and `definitions.ts`
enforces `TextKey`. A record owns opaque `PathSteps`, read by position and spelled by the record, with `toArray()` as
the one charged escape. Every per-path memo and converter belongs to one lazily accessed `Contract.pathFacts` record,
including `keyAtWith`, `keyBelowWith`, `text` and the amortized `prefixId` climb. For the year and mixed chains in all
four modes, the cursor/text work ratio at 16 levels must be at most the ratio at 8 levels times 1.005.

**Reason.** Conversions, climbs, member scans, suffix arrays and array-born cursors were siblings of the same path-cost
family, so per-path ownership and type fences close their entry paths together.

**Source.** Merged PR #1497 and the lead's canonical-key and path-fence rulings, 2026-10-31.

### r4-219

**Property-name traversal detects path-pumping feedback independently of key answers.**

**Rule.** If a property-name task repeats an earlier task's place with steps inserted above an untouched tail, take its
own names and follow no source, charging the check per task independently of the key's answer. Do not prune a
stop-undecided key, and charge every retained path. Read each below-key step through `keptStepBelow`, with the
dictionary text branch using `keptPath`.

**Reason.** Using the whole growing path as the visited identity never closed copy feedback that adds a step each turn,
growing tasks, arrays and key text without charge.

**Source.** Merged PR #1499 for #1493, including the lead's post-rebase text-read ruling, 2026-10-30.

### r4-220

**Admission growth repairs separate structure, support, deciders and sparse properties.**

**Rule.** Structure listing is independent of asking order: retain one relative listing per composed node, finalized in
postorder on first need. Layer folding retains local contributions and parent/join references with O(k) or O(k log k)
recipe vertices and edges, charged at creation; short answers do not make quadratic internal support output-bound.
Written-decider transfer work reports the accepted A6 pass multiplier explicitly, rather than claiming overall
linearity; sparse properties have their own present/missing/provenance proof. These repairs leave syntax, allowances,
ledger rules, rejection scheduling, packets, wording and key comparison order unchanged.

**Reason.** Asking order multiplied structure listing, layer support grew faster than public records, and role minima
were not the cause.

**Source.** The lead's reading of Sol's admission-growth design round 1, #1444, #1466 and #1456, 2026-10-31.

**Bounded by:** PR #1546 (2026-11-01) builds per-consumer layer summaries over shared support; PR #1549 (2026-11-02)
builds sparse closed-object properties, while the lead keeps #1444(b,c) held (2026-10-31) because the fresh solver-owned
bridge still exceeds the largest-size cost gate.

### r4-221

**Operation/path proofs belong to the solver, with replayable pass-local descriptors.**

**Rule.** For #1479's original universal operation/path demand construction, use one constructor for root and non-root
reads, identified by the operation's `PlaceId` and logical path, with `contractOfOp` only inside its `make`. Answers
stay solver-owned, with component, dependency, disposal, stop and forget lifecycles; a pass-local map interns immutable
descriptors by operation and arena path id, charging retained entries and long names once and reusing names on hits.
Preserve `landsIn` cleanup and the `PathSteps` fence, with path-aware `cop` replay through `compareDemandNames` and the
existing packet; rejection passes get fresh descriptors and stops invalidate through recorded reads and `Solver.forget`.
C10 consumers are callers, with no consumer-side cache.

**Reason.** Inline default questions repeated operation/path work quadratically, while root-only replay could not
reconstruct a non-root `cop` demand; geometric path facts cannot hold a value-specific proof.

**Source.** The lead's #1479 ruling after Sol's design round 1, 2026-10-31.

**Superseded by:** [r4.283](#r4-283) replaces the universal operation/path demand scope with inline operation reads and
demands for the specified branches.

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

### r4-238

**Preparation values are invalidated with the proofs of their inputs.**

**Rule.** Consume a completed or cached proof under its parent frame, or under the root for an external consumer, so it
does not read itself. Cached link answers and derived region eligibility are solver-owned values carrying producer
dependencies: forgetting a dependency forgets them, and no summary is published until they are recomputed under the
current frame.

**Reason.** Retaining preparation after its proofs were forgotten republished a stale summary after a same-admission
stop; ownership alone did not establish freshness.

**Source.** The lead's ruling on Sol's #1444(b,c) prototype round 8, 2026-10-31.

**Bounded by:** [r4.240](#r4-240) puts computation, including guards before yielded reads, inside the proof generator;
#1444(b,c) remains held by the lead (2026-10-31) on the bridge cost.

### r4-240

**Preparation recipes live for a pass; derived values live only in solver proofs.**

**Rule.** Intern one reconstructible demand recipe per logical producer in the pass, but retain reusable derived values
only in the solver proof payload; `group.region` authorizes no reuse. Preparation is a graph of `Work` producers for
link tests, narrowed kinds, regions, written reachability and value/first-value reads: parents yield child demands, each
`make` builds anew, and stop-sensitive guards run in the generator before its first yield. `Inheriting` keeps its
existing driver outside `make`, with folds published from completed dependency certificates; provisional component
payloads are never cached or published externally, cycle unions invalidate every consumer and abandonment closes
generators. A group has an independently demandable first-value recipe even when a written candidate wins,
distinguishing unevaluated from evaluated absence. Replay routes `ds` through `demandWork`, preparing its entry before
`pass.solver.run` and reconstructing the complete inherited-cycle partition by logical content over the existing path
packet.

**Reason.** Computing before creating the proof demand lost a `Values.#keyRead` guard made outside `solver.reading`, so
replaying yielded dependencies alone missed the stopped place.

**Source.** The lead's construction-A ruling after Astra's #1444(b,c) bridge design review, 2026-10-31.

**Bounded by:** [r4.241](#r4-241) requires completed inherited certificates; the lead holds #1444(b,c) (2026-10-31)
with replay, per-group first-value demand and campaign refresh still open.

### r4-241

**Retained inherited folds require completed current dependency certificates.**

**Rule.** The existing `Inheriting` driver delivers completed inherited dependency and context information to the outer
preparation adapter, so a retained fold uses completed current inputs or pass-static annotations rather than a frozen
inherited answer.

**Reason.** Treating an unannotated inherited source as provisional prevented fold retention and recomputed the
written-property fold per demand, making fold states quadratic over a linear proof graph.

**Source.** The lead's ruling on Sol's #1444(b,c) prototype round 10, 2026-10-31.

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

### r4-257

**An object `+` run builds its property index lazily on the third distinct name.**

**Rule.** Borrow the pass's first property as a seed: an operation's first non-seed name records one entry and its
second distinct non-seed name activates the index, so a one-name run never builds it and a three-name run does. Share
literal descriptors and binding closed-shape proofs per pass, validate dominance per read, index the maximal binary `+`
tree from its root and charge retention before publishing spans. A binding's sole whole initializer must also be the
sole identical entry of X2's filtered definition table; cache failures and charge cold construction per term, posting
and read. Group a binding's reads and make its property-name set once per binding per pass, never postings per read;
answer each property from its holders and gaps on the value, contract and admission paths. Precharge each query step by
its holder bound: one per holding literal or binding plus one, per answer item, and in each binding order to the first
lacking it, except the first holder search bounded by the run's binding count; warm no-holder queries are constant, with
no query-path range tree, sort or occurrence scan.

**Reason.** Repeatedly walking the whole run for each property multiplied the work; grouping by binding avoids the
width-by-reuse postings product.

**Source.** The lead's #1384 design-round-2 ruling and merged PR #1562, 2026-11-01.

**Bounded by:** the lead's PR #1562 ruling (2026-11-01) allows at most one indexed construction per run per pass above
the baseline at exactly the activation count when a plain walk is cheaper, only if the excess is linear, all
construction-attributed and grows no faster than the baseline.

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

### r4-283

**Inline work uses its frame's explicit stack without creating a demand.**

**Rule.** `yield* inline(work)` runs a child on its frame's explicit stack with that frame's identity: never memoised,
never a component member and never a demand, with its read chain starting at zero. Push and pop add no charge or
allowance check, preserving generator steps, charges and stops; throw exceptions into parents, and between steps report
combined root and suspended-child read depth, maintained as a prefix per child. `valueAt` replaces [r4.221](#r4-221)'s
universal demand scope: at non-empty paths, the choice branch and fallback or `get` results use memoised `cop` demands;
every other operation reads inline, with root reads unchanged.

**Reason.** Native delegation overflowed on long operation chains; making every operation/path pair a demand changed
joined self-store components and introduced quadratic reruns.

**Source.** Merged PR #1584 for #1572, with Codex and Astra depth repairs, 2026-11-02. Merged PR #1824 (2026-11-06) adds
the non-empty-path demands for fallback and `get` results.

### r4-288

**Question memory releases node-keyed memos while retaining whole-program memos.**

**Rule.** Release memos keyed by the node of a question, retaining whole-program memos made once, with identical answers
and work within 0–3%. Work reached after the question oracle stops and question-order-dependent lazy copy decisions
remain explicit proof obligations rather than assumed safe behavior.

**Reason.** Releasing every memo reduced the answers completed before the oracle's stop; separate analysis memory was
dominated by uncharged forget records before any question ran.

**Source.** The lead's #1506 verify-first rulings and redirect to #1599, 2026-11-02.

### r4-298

**Long-key reuse shares an immutable spine with separately owned facts.**

**Rule.** Use a key's immutable spine as the common foundation with separately owned facts, carrying canonical
prefix/suffix facts through repeated callers and explicitly gating text adapters and touch/provenance work. Share the
residual proof over that foundation while retaining its outer occurrence; any touch repair beyond reuse of the same path
mechanism is separate. Before a residual-proof build, a bounded proof/stop prototype closes conversion, property-control
and depth-128 failures; complete linearity is unproved.

**Reason.** The forwarding prototype regressed property-chain work and threw at depth 128, so forwarding alone did not
establish a usable shared proof.

**Source.** The lead's reading of Sol's #1607/#1615 design round over PR #1609, 2026-11-02.

### r4-349

**A structure built for every later reader is charged as shared work; no demand runs inside it.**

**Rule.** A structure that only sharing builds, here the alias classes' eligibility index, is built inside
`WorkLedger.shared`. A literal's view, body and body's index (#2289), which every later reader of the literal's cells
reads, are built inside `WorkLedger.sharedStructure`. Their own steps count to the analysis's total and never to the
decision that first asks for them. No demand runs inside a structure's build: at each read it yields, the shared window
closes, the read runs and is charged to the decision that asks, and the window reopens when the build resumes; the reads
it makes without yielding run outside the window (`WorkLedger.outside`, `outsideSteps`), charged to the asker in the
same way. A build abandoned at a yield leaves nothing open. The total's allowance bounds them all.

**Reason.** With sharing on, the first decision that needed the class index paid for building it (14,456 units against
3,840 at depth 32), stopped, and left every deeper path `budget`. The author saw one "would take too long" warning per
copy where the unshared route gave one per element. Charging a shared build to the total keeps sharing from stopping a
decision that the unshared run finishes. A literal's body charged to the first decision that compares its elements
passed that decision's demand allowance where main's finished, and made the count depend on which decision asked first;
a read run inside the window would be charged to no decision at all.

**Source.** PR #1714, merged as `63254271e` (#1703), 2026-11-04; #2289 (2026-11-11), in its pull request.

### r4-358

**Contribution provenance is opt-in and filtered by the consumers' own predicates.**

**Rule.** Only a solver constructed inside `withContributions` records, per pass, which slots a contract slot's final
run includes after filters and choices; production passes have no sink and no recording charge. When enabled, charge
inclusions as shared builds to the total, never a demand; publish flows with answers, replace them on rerun, clear at
`#begin`, delete on `forget`, and build every component flow before publishing any. `Contract.contributions(key)` is a
fresh settled walk under the caller's lease until the next settlement or forget, stopping at contract slots; an
unrecorded route returns `unavailable`, never an empty edge set. Report an edge only if some settled item survives every
path filter through `otherwiseKeeps`, `withoutEmpty`, `heldAsIs` and `plusDropsEmpty`; remove a wholly filtered slot and
subtree, retain a partly filtered one, and return shared interned qualifier links linear in the edges. Classify reads
with the TypeScript checker by bound symbol: any call whose `Work` result contains `Item` through nested
unions/intersections or a demand yield is a read, only solver `inline` transfers, the sink is a `FlowSink` parameter and
inclusion is `FlowSink.include` on that same key symbol, including optional callbacks.

**Reason.** The filter-aware snapshot is the single invariant, avoiding redundant raw-inclusion guards, and shared
qualifiers avoid expanding every path per edge quadratically.

**Source.** Merged PR #1723 for #1668, with the lead's filter-aware invariant and static-gate ruling, 2026-11-05.

**Bounded by:** exact-value routes, named sibling leaves and choice option/button values are unavailable by design;
aliased `proven`, `Item` subtypes and tuples remain classification limits under #1729, and #1646's production activation
needs a separate gate for changed total stops and check contents plus the caller's lease.

### r4-370

**Published records serialize only on a complete site-and-rule sort tie.**

**Rule.** `answers.ts` sorts records by file, start, end and rule, making JSON only for a complete tie, memoised once
per item and compared lexically in the existing order. Compiler-growth coverage is added for each construction's own
family; an existing exponent gate does not cover families it never runs.

**Reason.** Eager JSON sort keys flattened otherwise shared operand text after a stop, making retained heap quadratic
even while charged capture work was linear.

**Source.** The lead's #1734 ruling after Sol's #1078 growth map and merged PR #1754, 2026-11-05.
