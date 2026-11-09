# The accepted record: stops and finishing

Part of [the type inference's accepted record](README.md): budget stops, what a stop forgets or keeps, settled and
unsettled stops, the finishing read, marks after a stop and lost checks.

## Revisions

### r4-106

**A finished contract is a domain, not the read's own kinds.**

**Rule.** The finishing read's leaf source is a literal's own kind or a host read's structural ingress, direct or
projected; this and the read's own finished answer describe the value, while the key's finished contract, written type,
retained admitted type and syntax decision are domains over all its stores. At every domain source, a kinds-dependent
requirement uses the domain only if every value in it gives the same requirement; otherwise it stays undecided with its
deferred mark, while fixed-need consumers read the domain as the value. An unsettled element contract does not prove a
copied written list non-empty.

**Reason.** Treating a nullable contract as the unfinished read's kinds imposed a fallback requirement on a valid run
and caused TSR058.

**Source.** The lead's reassessment after Codex round 10 on PR #1063, 2026-10-27.

**Bounded by:** the lead's #1073 ruling (2026-10-28) refines unstopped C10: join the non-null members' families, with
`null` contributing none; one non-null family supplies that requirement, two supply none and leave the receiving-union
rule to decide, a proved-only-null value supplies none, and unknown kinds without a written type keep the runtime check.

### r4-113

**A host read keeps its structural ingress even when the script writes into that global.**

**Rule.** A host read's ingress, direct or projected through `ingressOf`, is structural whatever the script stores into
the global, so finishing forms its C9 boundary at every stop. Source 1 decides its kinds only if no script store is at
or above the read's path; a store below or beside does not replace the value read. Otherwise the later sources decide,
and at an unsettled stop the consumer's obligation is marked at the read's own site.

**Reason.** Declining ingress with kinds lost the read's C9 check, which the store's mark at its value did not cover.

**Source.** The lead's ruling on Codex round 12 B1, PR #1063, 2026-10-28.

### r4-117

**Rollback drops ingress memo; NarrowingIndex is lazy.**

**Rule.** When `takeBackReadChecks` rolls back a check and its key, it also clears cached ingress resolution. Build
`NarrowingIndex` lazily at the first read of `GuardIndex.narrowing` and charge the work when it runs. Written-store
parts at a stop use admission's own C1 under [r4.125](#r4-125).

**Reason.** Keeping the ingress cache after rollback lost an own-read boundary, while eager narrowing setup built an
unused index in the fresh finishing pass.

**Source.** The lead's rulings after Codex's final check and the S10 rebase of PR #1063, 2026-10-28.

**Superseded by:** [r4.125](#r4-125) and [r4.126](#r4-126) replace the separate descent of written-store parts with C1.

### r4-125

**The fresh pass checks written stores through admission's own C1.**

**Rule.** For each store into a written place, the fresh pass runs admission's own written-store C1 and has no separate
descent through the literal's parts.

**Reason.** The separate descent repeatedly disagreed with C1 on labels, keys, sites and grouping; a mixed wrong-kind
literal produced two TSV041 records where admission produced TSV041 and TSV044.

**Source.** The lead's ruling on Codex round 15, PR #1063, 2026-10-28.

**Bounded by:** [r4.135](#r4-135) forbids an inferred syntax decision before admission settles.

### r4-126

**A boundary's expected domain uses the ordered finishing read.**

**Rule.** A boundary's `against` is a read: take the finishing read's sources in order, using a finished operation
contract as a domain for a fixed need, without new solving. Keep the store mark only where every source leaves the read
undecided. The fresh pass checks written stores with admission's own C1, replacing the separate descent of
[r4.117](#r4-117) as required by [r4.125](#r4-125).

**Reason.** Re-deriving `against` from the destination lost a retained operation contract without a mark, and separate
literal descent both split grouped errors and turned a definite object error into an unknown mark.

**Source.** The lead's rulings on Astra round 4, PR #1063, 2026-10-28.

**Bounded by:** the obligation inventory and retained-boundary discharge rule of PR #1063 (2026-10-28) cover every
obligation-creating admission site and carry retained kinds through discharge rather than deriving them again from the
destination.

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

### r4-152

**One ordered source endpoint answers every direct or composed question.**

**Rule.** Every question's items, direct or composed, come through `CoreAnswers.#items`: the solver's answer, syntax
shape, finishing domains, then the place's lazily decided type. Compose a child's items through that endpoint, retaining
the enclosing literal's own names; only that endpoint calls `Consumers.finishedItems` and `#lazilyDecided`. If no source
retains information and no consumer owes a check, answer `unknown` for `budget`; a lazily decided element after a
settled stop supplies its answer instead of a mark. A written store whose literal holds an undecided named element is
marked at the literal, covering records within the store's value span without moving the mark. The derivation guard
trusts a listed host read by its stated reason; effects hidden inside a listed `read` or `run` are reviewed against that
reason.

**Reason.** Separate endpoints let a composed literal child lose the lazily decided answer that the direct question
retained.

**Source.** The lead's three rulings and extension after Astra round 7, PR #1063, 2026-10-28.

**Bounded by:** [r4.165](oracles.md#r4-165) and [r4.182](oracles.md#r4-182) define the syntactic scope of the source
and obligation guards.

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

### r4-213

**A finishing domain owns its boundary requests through its deferred warning.**

**Rule.** After a settled stop, boundary requests introduced by a finishing domain depend on the deferred warning owning
the read; structural ingress remains unconditional under [r4.113](#r4-113). Use one ownership-aware `boundariesAt`
entry, carrying warning acceptance through `nullWarning`, `memberChecks` and consumer callers, allowing multiple live
owners without changing admission's pending set or cache. With no omission, requests, diagnostics, obligations and plans
stay identical; omission removes only domain-caused effects, and the oracle excuses only the exact omitted obligation
with every other identity kept.

**Reason.** A domain may include a non-reaching store and introduce a redundant boundary; a general site-insensitive
surplus exception could conceal a lost reaching check, while a new reaching analysis after the stop would add a second
engine.

**Source.** The lead's decision for #1448 after Sol's design round 1, 2026-10-30.

### r4-226

**An owned finishing-domain boundary is omitted with its warning.**

**Rule.** A consumer's warning acceptance travels with domain boundary requests through `markDomain` and `heldIngress`;
`boundariesAt` and `boundariesBefore` use one `leftOutBy` helper with one owner per item per request, retaining
additional owners. Fallback requests follow their warnings: a domain boundary is the owning warning's content, never an
independent C9 boundary, and omission keeps structural ingress and any other live owner. Without omission, request
multisets, diagnostics, obligations and plans stay unchanged; this work is charged only in finishing.

**Reason.** Ownership removes unowned extra boundaries without a new exception for redundant checks.

**Source.** Merged PR #1511 for #1448 under [r4.213](#r4-213), 2026-10-31.

**Bounded by:** PR #1536 (2026-10-31) masks the unrestricted-domain opaque reason in `laterSources` so the owned
host-data boundary survives a settled stop.

### r4-271

**A value with no holding place has one memoised node in the finishing walk.**

**Rule.** After a settled stop, a read with neither binding nor call at its root has an `ownFrontier` for the host data
its value brings, and a cut walk takes that value's iterative `ownIngress`, visiting each value once. Resolve copies
above a frontier once and share them with reads below it; memoise each placeless value's frontier, ingress and root, and
keep the climbed root for every value on its chain. Inside an own frontier and its descendant steps, link a placeless
operand as a copy at its strip on every entry path instead of re-entering it; stored places keep exact inline entry, and
only placeless values beyond the copy bound take the sound superset of [r4.208](#r4-208).

**Reason.** Returning no frontier lost the host-data boundary of literal-derived and default reads; repeated entry into
nested placeless values and copied roots introduced quadratic work.

**Source.** Merged PR #1559 for #1491 and #1502, with the lead's structure-first ruling after Astra round 1, 2026-11-01.

### r4-278

**One immutable contract proof serves each canonical key and admission epoch.**

**Rule.** Keep scoped completion in the existing solver and admission, retaining an immutable `ContractRef` per
canonical key and admission epoch with path-sensitive dependency closure for each destination key, receiving site and
required extent. Shape and complete-contract extents are distinct: an ancestor shape query proves no wildcard subtree.
Publication uses the existing requirement map, `TypeCheckPlan` and `assertValueType`; share completed admitted-domain
proofs and qualified copy origins rather than computing a second type. The descriptor service prefers written and
independently retained copy terms, otherwise the existing admission/solver proof per needed level, interning immutable
contract references with labels and receiving sites outside identity and iterative depth construction shared with facts.
Closure and assembly must establish the proposed O(K + E + T + H) per-epoch bound over solver work; it is a construction
to prove and gate, not a measured property of the prototype.

**Reason.** Lost destinations came from bookkeeping, and a depth cut was an implementation limit rather than a language
rule; one shared proof/descriptor builder avoids a second computation and duplicate extraction.

**Source.** The lead's reading of Sol's #1526 production-structure design and merged phase-A PR #1593, 2026-11-02.

**Bounded by:** [r4.312](#r4-312) replaces stopped-key retries through forget/restart with a fresh completion pass
without frozen keys. PR #1652 (2026-11-04) turns `SliceDepth` into the existing slice exit and removes the unsound cycle
certificate, leaving admitted-level inclusion to be proved. Publication after a stop follows the [resource-limit
contract](../../RESOURCE-LIMITS.md#coarse-type-core-bounds).

### r4-303

**Forget records live only while admission can still stop their owner.**

**Rule.** `Contract` retains ask records per place while an admission-group decision can still stop it, opening before
`admittedStores`, updating after each `decide` and dropping records at the last decision through `closeDecisions`, also
called from `finish`. Keep every place open while pass targets decide receivers; `Solver` records readers only into
demands a stop may forget, at every handoff to a parent frame including abandonment. Store one key or reader directly,
up to eight readers as a list and more as a set; forgetting after closure throws. Forgettable status is sticky, abort
cleanup retains reader handoffs, and a budget stop closes forgetting.

**Reason.** Retaining uncharged ask and reader records after their last possible stop consumed analysis memory without
supporting further invalidation.

**Source.** Merged PR #1601 for #1599, under the lead's prototype-C ruling, 2026-11-02.

### r4-312

**Completion has one fresh admission pass over settled inputs, charged to the total.**

**Rule.** Replace [r4.278](#r4-278)'s forget/restart retries: after capture, construct one fresh `Admission` from the
settled pass's rejections and store targets without its frozen keys; decide a proof-read key where a level first reads
it from the remaining total, recording `budget.closure.decisions`. Leave the settled pass unchanged and publish
completion results only as the `Answers.receiving` inventory, charging closure work to the total and its own pass
records, never a settled-pass demand allowance or apart work. Share descriptor listings and assembly cells; the retained
cell graph, counted transaction guard, progress-stamped frontier and `close()` remain. A completion decision that would
reject or retarget a selecting store makes its obligation `Lost` with that cause, never a refusal, widening or altered
settled answer.

**Reason.** A separate mask-free pass avoids caches of frozen answers and the extra invalidation protocol; sharing
listing work removes the destination-by-listing product that remained despite a linear frontier.

**Source.** The lead's phase-C construction readings on PR #1637 for #1526, 2026-11-02.

**Bounded by:** the deep-wrapper family owes quadratic real holder-paths with path-sized reads; copied-key listing reuse
remains a separate #1615-class repair. Publication after a stop follows the [resource-limit
contract](../../RESOURCE-LIMITS.md#coarse-type-core-bounds).

### r4-332

**Combined stops retain demand-only obligations with identical domains.**

**Rule.** At a binding root, add `null` to a retained answer only if a finished contract or a store provides it, reading
the contract as it finished without new solving; below the root, keep `null` admitted by the decision. Store syntax
follows inferred-place copies by frontier links at the copied path, one per source per level using the earliest store,
summed once per frontier with written kinds once per walk and property sets as tokens. Copy cycles remain untold in
every read order; follow chains only to `FRONTIER_COPIES`, retaining the least cut depth for a level and charging each
look. At every place and dimension, a stop owes the demand-only checks, or one-for-one replacements with the same
domain, except checks removed by the proved root-null rule.

**Reason.** A root-null over-approximation and incomplete copied syntax produced unnecessary stop marks; matching the
demand-only obligations removes over-checks while preserving domains.

**Source.** Merged PR #1653 for #1604, 2026-11-04.

**Bounded by:** [r4.363](oracles.md#r4-363), the owner's #1708 decision A′ on type-reading sentence parts after a stop.

### r4-339

**Completion publishes the natural C1 obligations only as store-part checks.**

**Rule.** Receiving completion retains its existing C1 warning obligations only where nothing was lost, clears them at
its allowance, and supplies none after `LeftSlice` or when completion is omitted. `runtimeChecks` merges these
obligations into store-part checks only, never the whole check, preserving the existing step-5 behavior and one
published order by site, consumer rank and text. Each stopped store's parts are a subsequence of the natural parts with
equal paths and types, except a part covered at that path by the natural whole check with the same projected type; loss,
capping or unread state may remove parts, never leave them uncovered or stricter.

**Reason.** Completion already ran the natural C1 rule on settled inputs but retained only warning sites, so publication
reuses the existing derivation rather than checking again.

**Source.** Merged PR #1690 for #1682 and the lead's projection-clause invariant, 2026-11-04.

### r4-387

**Stop-loss repairs share one per-pass obligation registry on solver provenance.**

**Rule.** Use one per-pass obligation registry on existing solver provenance, preserving the completion cap and restart
bound: a stop may defer a check to runtime, never drop it. After A2, build retained C10 proofs, then operand-domain
proofs, then grounded C1 obligations on the registry sharing A4's register; fresh unsettled solving stays at #1252's
boundary, and #1642's remaining cases are verified before repair. Check equivalences need explicit proofs rather than
relabels; publication after a stop follows the [resource-limit
contract](../../RESOURCE-LIMITS.md#coarse-type-core-bounds).

**Reason.** Standing-copy coverage did not prove the remaining receiver, C10/store and advice equivalences, which need
explicit proofs.

**Source.** The lead's acceptance of Sol's #1580 stop-loss design round, 2026-11-05.

**Bounded by:** [r4.389](#r4-389) specifies qualified capture reuse and dependency-complete proof retention through the
same registry.

### r4-389

**Publication consumes qualified captures; marks invalidate only dependent proofs.**

**Rule.** Publication matches a retained slot by destination, exact path, admission epoch, receiving site and role,
required extent and written/landing policy, accepting `Complete` or proved-`Open` with written/retained-term precedence
and the existing fallback for missing, mismatched or `Lost` captures. Apply receiving-site property order without asking
admission again; one immutable `Complete`/`Open`/`Lost` proof feeds checking and lowering, a shape never substitutes for
a whole contract, `Lost` never becomes `Open`, and complete obligations are discharged from the registry. Bind each
immutable proof to every actual solver/value read and stable rejection/target input, including cache hits, copies,
projections and wrappers; follow a mark's reverse reach once, keeping only proofs proved outside it and conservatively
losing unknown support. Settled capture admissions and targets stay unchanged, with [r4.183](#r4-183)'s one restart per
A6 pass and completion cap `min(2W, A−W)`; provenance uses shared accounting. Publication after a stop follows the
[resource-limit contract](../../RESOURCE-LIMITS.md#coarse-type-core-bounds). Before building, establish binding and
property-order representation, discharge, Lost/Open and stale-epoch controls, and the dependency contract on retargeted,
wrapped, independent and copied-independent cases.

**Reason.** A complete receiving contract can otherwise leave only unrestricted-list part checks and let a forbidden
value reach the next effect where the natural compile fails TSR058.

**Source.** The lead's #1645/#1648 rulings after Sol's decision preparation, 2026-11-05.
