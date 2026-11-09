# The accepted record: stops and finishing

Part of [the type inference's accepted record](README.md): budget stops, what a stop forgets or keeps, settled and
unsettled stops, the finishing read, marks after a stop and lost checks.

## Revisions

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
