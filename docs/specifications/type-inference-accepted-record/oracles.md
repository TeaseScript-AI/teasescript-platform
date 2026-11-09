# The accepted record: oracles

Part of [the type inference's accepted record](README.md): the test oracles and evidence about the core: the stop
oracle, the member-answer oracle and what a difference may be.

## Revisions

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

### r4-322

**A combined stop may label a key step more precisely than the demand-only reference (the owner's decision).**

**Rule.** At demands 1 to 3, the demand-only reference spells a dictionary value's or derived list's key step `element`,
because its own contract read ran out of demand. The combined stop's finishing read spells it `entry`. That finishing
read takes `keyDomain`, the settled contract, then the written type, then the retained type at a settled stop.

The stop oracle is not relaxed in general. This one difference is allowed only where all three hold:
1. the more precise label demonstrably follows from a proven type (the settled contract or the written type);
2. the actual check, its location and the expected types are identical;
3. no other diagnostic difference is ignored.

**Reason.** The owner chose option A: forbidding the better sentence because an analysis with less information produces
a vaguer one is illogical. The third condition keeps a real compiler defect from hiding behind a better sentence.

**Source.** The owner's decision on #1595 (construction A), 2026-11-03.

**Bounded by:** the ruling's condition that demand-only runs show 0 differences stands, so the fallback is not added to
demand-only runs.
