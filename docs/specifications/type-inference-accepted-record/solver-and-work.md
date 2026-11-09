# The accepted record: solver and work

Part of [the type inference's accepted record](README.md): the solver's mechanics and charged work: demand, allowances,
work units, growth products, indexes, determinism and order.

## Revisions

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

### r4-349

**A structure built only for sharing is charged as shared work.**

**Rule.** A structure that only sharing builds, here the alias classes' eligibility index, is built inside
`WorkLedger.shared`. Its work counts to the analysis's total and never to the decision that first asks for it.

**Reason.** With sharing on, the first decision that needed the class index paid for building it (14,456 units against
3,840 at depth 32), stopped, and left every deeper path `budget`. The author saw one "would take too long" warning per
copy where the unshared route gave one per element. Charging a shared build to the total keeps sharing from stopping a
decision that the unshared run finishes.

**Source.** PR #1714, merged as `63254271e` (#1703), 2026-11-04.
