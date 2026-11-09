# The accepted record: sharing

Part of [the type inference's accepted record](README.md): work shared between copies and sources: alias classes,
copies, joins and discovery keys.

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
