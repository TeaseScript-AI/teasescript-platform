# Codex task routing and model selection

Use this guide to choose the executor and, when Codex is selected, the model and reasoning level. Prompt construction,
work-package boundaries, milestone handling, and per-prompt quality checks are owned by
[`CODEX-PROMPTING.md`](CODEX-PROMPTING.md).

Do not mechanically re-read either guide before every consecutive action. Re-read the relevant guide when its rules are
no longer fresh in active context, especially after substantial code or review inspection, large tool output,
a task switch, or other context-heavy work. Consecutive related selection and prompting steps may reuse guidance that
remains fresh. When uncertain whether it is still fresh, re-read it.

Choose the lowest-cost executor likely to produce an accepted result. When Codex is selected, choose its lowest-cost
model and reasoning level. Optimize for expected total cost, including handoff/context transfer, retries, debugging,
review corrections, CI failures, unnecessary repository exploration, publication friction, context or usage limits, and
human intervention. Do not automatically select Codex, the strongest model, or the highest reasoning level.

### Step 0: Select the executor

A **Sol agent** is a ChatGPT project agent with the shared local environment and GitHub connector; **Codex Sol** is the
strongest Codex model tier below. Prefer a Sol agent when reading, review, architecture, diagnosis, or difficult
semantic reasoning dominates; when the current session already holds the useful context; or when a separate Codex
handoff would cost more than direct execution. Prefer Codex when direct `git` and `gh` materially reduce publication
friction, many related edits must remain consistent, or a well-specified Luna or Terra task can be strongly verified.

Diff size is one factor, not the rule: a Sol agent may publish a large diff through the connector route, while a small
Codex-suitable change should stay with the current Sol agent when handoff costs more than direct execution. When Codex
is selected, let it obtain current repository and GitHub state through normal `git` and `gh`; do not supply Source
artifacts, copied canonical documents, or broad context packages without a concrete identity, availability, trust, or
task-specific reason.

### Model and reasoning are separate choices

Use model strength for semantic capability:

- **Luna:** mechanical, localized, repetitive, and strongly verifiable work.
- **Terra:** repository-aware implementation, accepted-architecture integration, compatibility work, and moderately
  complex debugging.
- **Sol:** selecting or reconciling architecture, altering behavior-critical canonical state, or resolving ambiguity
  across difficult-to-verify invariants.

Use reasoning effort for the amount of exploration, strategy comparison, diagnosis, and verification still required.
More reasoning does not make a smaller model equivalent to a stronger model.

### Step 1: Classify the task

Classify using six dimensions:

- **Mechanical scope:** how deterministic and repetitive is the work?
- **Semantic complexity:** must boundaries be followed or discovered?
- **Verification strength:** how reliably will incorrect work be detected?
- **Failure impact:** how costly or hidden would a subtle error be?
- **Ambiguity:** are behavior, ownership, and implementation strategy resolved?
- **Execution volume:** can Codex reliably complete the required reading, implementation, verification, diff review,
  and publication in one execution?

Task size, file count, architectural vocabulary, and large diffs do not by themselves increase conceptual complexity,
but execution volume still determines whether the work fits one run. A task may be Terra-level yet require several
bounded work packages. Do not use a stronger model or higher reasoning to compensate for excessive execution volume.
Strong verification permits a cheaper configuration only when it covers the relevant failure modes. Green tests are
insufficient when ownership, compatibility, API leakage, ordering, or other important properties are not tested.

### Step 2: Select the model

#### Select Luna when

Use Luna when most of the following are true:

- the change is mechanical or repetitive;
- paths, ownership, and edit patterns are explicit;
- little architectural interpretation is required;
- failures are detected reliably by tooling;
- the work can be divided into deterministic operations.

Typical examples include file moves, import migrations, compatibility facades, documentation updates, straightforward
fixtures, and running established verification.

#### Select Terra when

Use Terra when one or more of the following are true:

- several related modules must be understood;
- accepted architecture or ownership boundaries must be implemented, connected, tested, or audited rather than
  invented;
- existing code must be extracted, integrated, or repaired without redesigning canonical behavior;
- a prescribed canonical-state, transactional, atomicity, or serialization repair preserves the accepted state model,
  serialized representation, and public contracts;
- dependency direction, compatibility, public surfaces, or private helpers require care;
- tooling, UI adapters, test harnesses, or acceptance layers consume an already defined engine or compiler contract;
- several precise corrections must remain mutually consistent;
- failures are detectable through focused tests, conformance checks, diff review, or independent review.

Typical examples include specified ownership extraction, accepted-architecture integration, presentation or tooling
connected to authoritative APIs, compatibility and facade audits, grammar-aware tooling, deterministic test harnesses,
vertical acceptance work with narrow repairs, and behavior-neutral repository refactors.

#### Select Sol when

Select Sol when at least one capability-specific Sol trigger applies:

- the agent must choose, redesign, or reconcile an architectural boundary;
- a canonical state model, transition semantics, event-ordering contract, continuation model, transaction contract, or
  atomicity contract must be designed, extended, or reconciled;
- serialization requires choosing a new behavioral representation or provenance model rather than applying a
  prescribed repair or schema update;
- materially different strategies have different correctness or compatibility consequences;
- subtle nonlocal failures require independent diagnosis because the important invariants or failure mechanism have
  not already been identified and made testable;
- final review must detect plausible cross-boundary semantic inconsistencies that cheaper models may miss.

High impact, broad scope, many invariants, checkpoints, several layers, or expensive rework are not sufficient alone.
When the authoritative design is fixed and the task mainly implements, connects, tests, or documents it, Terra is
usually sufficient.

Typical Sol work includes new canonical runtime state models, changed transition or ordering contracts, new continuation
or transaction semantics, lifecycle or state-machine redesign, unresolved module boundaries, subtle nonlocal behavioral
regressions, and high-risk semantic audits.

### Step 3: Select reasoning effort

#### Low reasoning

Use Low when the task is deterministic, the path is well bounded, relevant files and expected results are known, little
repository exploration is needed, and errors are immediately visible through tooling.

Use Terra Low when Terra's semantic capability is needed but the implementation direction, relevant boundaries, affected
files, expected behavior, and focused verification are already explicit.

Do not use Low merely because the code change is small.

#### Medium reasoning

Use Medium as the default, including for difficult cross-layer work when behavior and architecture are specified, the
model mainly implements an accepted design, tests are reasonably strong, and no major strategy remains unresolved.

This includes high-risk review repairs when the defect, required semantics, permitted implementation boundary, stop
conditions, and verification are already explicit.

Cross-layer scope, high impact, canonical-state mutation, transactionality, many acceptance criteria, or internal
planning do not by themselves justify High. Prefer a stronger model on Medium when the task needs better semantic
judgment rather than more searching.

#### High reasoning

Use High only when Medium is likely insufficient because a specific burden remains:

- important boundaries or dependencies are genuinely unclear;
- materially different strategies must be compared;
- verification is incomplete for the highest-risk invariants;
- failures require nonlocal or iterative diagnosis;
- architecture must be discovered rather than implemented;
- a well-specified Medium attempt exposed a genuine reasoning or debugging limit.

Do not select High merely because the task is large, high-risk, touches canonical state, requires atomicity, or must be
completed coherently. State the unresolved uncertainty, strategy comparison, or diagnostic burden that requires it.

### Default configurations

```text
Mechanical, explicit, strongly verified:
Luna Low or Luna Medium

Repository exploration within a deterministic pattern:
Luna Medium

Bounded repository-aware semantic work with explicit implementation
direction, known relevant files, and strong focused verification:
Terra Low

Repository-aware work following accepted boundaries that requires normal
exploration, coordination, or several mutually consistent changes:
Terra Medium

Prescribed canonical-state, transactional, atomicity, provenance,
or serialization repair with explicit semantics and strong verification:
Terra Low when localized and the implementation path is known; otherwise Terra Medium

Accepted-architecture work with unclear mutation surfaces, incomplete
verification, coupled nonlocal behavior, or substantial diagnosis:
Terra High

New or changed canonical state models, transition semantics, ordering
contracts, continuation models, behavioral serialization, transaction
contracts, or atomicity contracts:
Sol Medium

Unresolved architecture, competing strategies, or difficult-to-verify
behavioral design:
Sol High
```

Use the cheapest configuration likely to produce an accepted result without costly retries or hidden defects. Consider
verification strength and repair cost, not only per-run usage.

### Reassess review repairs

Model and reasoning selection apply to the current Codex task, not permanently to the issue, branch, or pull request.

After review identifies blockers, classify the repair prompt again from the remaining decision and investigation burden.
Do not inherit the original configuration merely because the initial implementation required it. Review findings often
remove ambiguity and may justify a cheaper model or lower reasoning level.

Classify the repair by what remains unresolved, not by the risk category of the affected subsystem. Touching canonical
state, serialization, ordering, or atomicity does not by itself require Sol when the review already specifies the
required semantics, permitted implementation boundary, stop conditions, and verification.

- **Luna:** explicit, localized, mechanical repairs with strong verification.
- **Terra:** repository-aware semantic repairs within an accepted contract, including prescribed canonical-state or
  transactional repairs that preserve the existing model and representation.
- **Sol:** repairs that still require architectural choice, a new or changed canonical behavior contract, unresolved
  representation design, or difficult nonlocal diagnosis of invariants not already identified and made testable.

Select reasoning independently. Use Low when the repair is bounded, the relevant files and implementation path are
known, and focused checks directly cover the change. Otherwise use Medium by default when the repair direction and
checks are explicit. Use High only when substantial repository investigation, strategy comparison, or iterative
diagnosis remains.

For multiple blockers in one repair prompt, select the configuration required by the most demanding blocker that must be
solved coherently. Split blockers only when they are independent and separately verifiable; do not split coupled state,
serialization, ordering, or restore repairs merely to force a cheaper configuration.

### Escalation policy

Escalate reasoning on the same model when inspection reveals unresolved dependencies or competing strategies, focused
failures require nonlocal diagnosis, or a well-specified attempt failed because it did not investigate or verify deeply
enough.

Escalate to a stronger model when the current model repeatedly makes incorrect ownership or semantic decisions, cannot
preserve interacting invariants, produces superficially green but incomplete work, or consumes the expected saving
through retries and repair.

A scope-stop condition is not a model-escalation trigger. It prevents automatic scope expansion. Do not repeat the same
failed prompt and configuration more than once without changing the instructions, reasoning effort, model, or task
specification.

### Handoff to prompt construction

Executor choice, classification, model selection, reasoning justification, cost analysis, and escalation logic are
internal routing work. Record one primary configuration and only the escalation trigger needed to revisit it. Translate
only task-relevant routing findings into concrete execution constraints or checks; do not copy classification labels,
pricing, rejected configurations, or model-selection rationale into the Codex prompt.

```text
Executor: Sol agent or Codex
Execution volume: one run or requires bounded work-package planning
Codex model/reasoning, when applicable:
Escalation trigger:
```

When uncertain between model tiers, choose the cheaper model only when failure is quickly and reliably detectable.
When uncertain between Medium and High, choose Medium unless a specific unresolved uncertainty, strategy choice, or
diagnostic burden requires High.

If Codex will receive a prompt, continue with [`CODEX-PROMPTING.md`](CODEX-PROMPTING.md) and complete its mandatory
author preflight.
