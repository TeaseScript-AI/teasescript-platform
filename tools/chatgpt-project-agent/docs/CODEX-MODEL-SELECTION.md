## Codex Task Routing, Model Selection, and Prompting

Before assigning repository work, choose the lowest-cost executor likely to produce an accepted result. When Codex is selected, choose its lowest-cost model and reasoning level, then provide only task guidance that materially improves execution.

Optimize for expected total cost, including prompt transfer, retries, debugging, review corrections, CI failures, unnecessary repository exploration, publication friction, context or usage limits, and human intervention. Do not automatically select Codex, the strongest model, or the highest reasoning level.

### Step 0: Select the executor

A **Sol agent** is a ChatGPT project agent with the shared local environment and GitHub connector; **Codex Sol** is the strongest Codex model tier below. Prefer a Sol agent when reading, review, architecture, diagnosis, or difficult semantic reasoning dominates; when the current session already holds the useful context; or when a separate Codex handoff would cost more than direct execution. Prefer Codex when direct `git` and `gh` materially reduce publication friction, many related edits must remain consistent, or a well-specified Luna or Terra task can be strongly verified.

Diff size is one factor, not the rule: a Sol agent may publish a large diff through the connector route, while a small Codex-suitable change should stay with the current Sol agent when handoff costs more than direct execution. When Codex is selected, let it obtain current repository and GitHub state through normal `git` and `gh`; do not supply Source artifacts, copied canonical documents, or broad context packages without a concrete identity, availability, trust, or task-specific reason.

### Model and reasoning are separate choices

Use model strength for semantic capability:

- **Luna:** mechanical, localized, repetitive, and strongly verifiable work.
- **Terra:** repository-aware implementation, accepted-architecture integration, compatibility work, and moderately complex debugging.
- **Sol:** selecting or reconciling architecture, altering behavior-critical canonical state, or resolving ambiguity across difficult-to-verify invariants.

Use reasoning effort for the amount of exploration, strategy comparison, diagnosis, and verification still required. More reasoning does not make a smaller model equivalent to a stronger model.

### Step 1: Classify the task

Classify using six dimensions:

- **Mechanical scope:** how deterministic and repetitive is the work?
- **Semantic complexity:** must boundaries be followed or discovered?
- **Verification strength:** how reliably will incorrect work be detected?
- **Failure impact:** how costly or hidden would a subtle error be?
- **Ambiguity:** are behavior, ownership, and implementation strategy resolved?
- **Execution volume:** will the required reading, implementation, verification, diff review, and publication fit comfortably in one Codex execution?

Task size, file count, architectural vocabulary, and large diffs do not by themselves increase conceptual complexity, but execution volume still determines whether the work fits one run. A task may be Terra-level yet require several bounded execution phases. Strong verification permits a cheaper configuration only when it covers the relevant risks. Green tests are insufficient when ownership, compatibility, API leakage, ordering, or other important properties are not tested.

### Step 2: Select the model

#### Select Luna when

Use Luna when most of the following are true:

- the change is mechanical or repetitive;
- paths, ownership, and edit patterns are explicit;
- little architectural interpretation is required;
- failures are detected reliably by tooling;
- the work can be divided into deterministic operations.

Typical examples include file moves, import migrations, compatibility facades, documentation updates, straightforward fixtures, and running established verification.

#### Select Terra when

Use Terra when one or more of the following are true:

- several related modules must be understood;
- accepted architecture or ownership boundaries must be implemented, connected, tested, or audited rather than invented;
- existing code must be extracted, integrated, or repaired without redesigning canonical behavior;
- a prescribed canonical-state, transactional, atomicity, or serialization repair preserves the accepted state model, serialized representation, and public contracts;
- dependency direction, compatibility, public surfaces, or private helpers require care;
- tooling, UI adapters, test harnesses, or acceptance layers consume an already defined engine or compiler contract;
- several precise corrections must remain mutually consistent;
- failures are detectable through focused tests, conformance checks, diff review, or independent review.

Typical examples include specified ownership extraction, accepted-architecture integration, presentation or tooling connected to authoritative APIs, compatibility and facade audits, grammar-aware tooling, deterministic test harnesses, vertical acceptance work with narrow repairs, and behavior-neutral repository refactors.

#### Select Sol when

Select Sol when at least one capability-specific Sol trigger applies:

- the agent must choose, redesign, or reconcile an architectural boundary;
- a canonical state model, transition semantics, event-ordering contract, continuation model, transaction contract, or atomicity contract must be designed, extended, or reconciled;
- serialization requires choosing a new behavioral representation or provenance model rather than applying a prescribed repair or schema update;
- materially different strategies have different correctness or compatibility consequences;
- subtle nonlocal failures require independent diagnosis because the important invariants or failure mechanism have not already been identified and made testable;
- final review must detect plausible cross-boundary semantic inconsistencies that cheaper models may miss.

High impact, broad scope, many invariants, checkpoints, several layers, or expensive rework are not sufficient alone. When the authoritative design is fixed and the task mainly implements, connects, tests, or documents it, Terra is usually sufficient.

Typical Sol work includes new canonical runtime state models, changed transition or ordering contracts, new continuation or transaction semantics, lifecycle or state-machine redesign, unresolved module boundaries, subtle nonlocal behavioral regressions, and high-risk semantic audits.

### Step 3: Select reasoning effort

#### Low reasoning

Use Low when the task is deterministic, the path is well bounded, relevant files and expected results are known, little repository exploration is needed, and errors are immediately visible through tooling.

Use Terra Low when Terra's semantic capability is needed but the implementation direction, relevant boundaries, affected files, expected behavior, and focused verification are already explicit.

Do not use Low merely because the code change is small.

#### Medium reasoning

Use Medium as the default, including for difficult cross-layer work when behavior and architecture are specified, the model mainly implements an accepted design, tests are reasonably strong, and no major strategy remains unresolved.

This includes high-risk review repairs when the defect, required semantics, permitted implementation boundary, stop conditions, and verification are already explicit.

Cross-layer scope, high impact, canonical-state mutation, transactionality, many acceptance criteria, or internal planning do not by themselves justify High. Prefer a stronger model on Medium when the task needs better semantic judgment rather than more searching.

#### High reasoning

Use High only when Medium is likely insufficient because a specific burden remains:

- important boundaries or dependencies are genuinely unclear;
- materially different strategies must be compared;
- verification is incomplete for the highest-risk invariants;
- failures require nonlocal or iterative diagnosis;
- architecture must be discovered rather than implemented;
- a well-specified Medium attempt exposed a genuine reasoning or debugging limit.

Do not select High merely because the task is large, high-risk, touches canonical state, requires atomicity, or must be completed coherently. State the unresolved uncertainty, strategy comparison, or diagnostic burden that requires it.

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

Use the cheapest configuration likely to produce an accepted result without costly retries or hidden defects. Consider verification strength and repair cost, not only per-run usage.

### Reassess review repairs

Model and reasoning selection apply to the current Codex task, not permanently to the issue, branch, or pull request.

After review identifies blockers, classify the repair prompt again from the remaining decision and investigation burden. Do not inherit the original configuration merely because the initial implementation required it. Review findings often remove ambiguity and may justify a cheaper model or lower reasoning level.

Classify the repair by what remains unresolved, not by the risk category of the affected subsystem. Touching canonical state, serialization, ordering, or atomicity does not by itself require Sol when the review already specifies the required semantics, permitted implementation boundary, stop conditions, and verification.

- **Luna:** explicit, localized, mechanical repairs with strong verification.
- **Terra:** repository-aware semantic repairs within an accepted contract, including prescribed canonical-state or transactional repairs that preserve the existing model and representation.
- **Sol:** repairs that still require architectural choice, a new or changed canonical behavior contract, unresolved representation design, or difficult nonlocal diagnosis of invariants not already identified and made testable.

Select reasoning independently. Use Low when the repair is bounded, the relevant files and implementation path are known, and focused checks directly cover the change. Otherwise use Medium by default when the repair direction and checks are explicit. Use High only when substantial repository investigation, strategy comparison, or iterative diagnosis remains.

For multiple blockers in one repair prompt, select the configuration required by the most demanding blocker that must be solved coherently. Split blockers only when they are independent and separately verifiable; do not split coupled state, serialization, ordering, or restore repairs merely to force a cheaper configuration.

### Escalation policy

Escalate reasoning on the same model when inspection reveals unresolved dependencies or competing strategies, focused failures require nonlocal diagnosis, or a well-specified attempt failed because it did not investigate or verify deeply enough.

Escalate to a stronger model when the current model repeatedly makes incorrect ownership or semantic decisions, cannot preserve interacting invariants, produces superficially green but incomplete work, or consumes the expected saving through retries and repair.

A scope-stop condition is not a model-escalation trigger. It prevents automatic scope expansion. Do not repeat the same failed prompt and configuration more than once without changing the instructions, reasoning effort, model, or task specification.

### Separate routing analysis from the Codex prompt

Executor choice, classification, model selection, reasoning justification, cost analysis, and escalation logic are internal routing work. Do not copy them into the Codex prompt.

Translate relevant findings into concrete constraints, checks, decision boundaries, verification requirements, and stop conditions. Codex does not need classification labels, pricing rationale, rejected configurations, or an explanation of why its model was selected.

### Prompt construction

Build the Codex-facing task prompt around **Goal, Context, Constraints, and Done when**. `Done when` must describe the final external state, including required checks, complete diff review, assigned commit/push/PR work, exact resulting identity, deviations, and remaining risks.

Include task-relevant authority, likely files or code areas, canonical modules or patterns, critical invariants, exclusions, acceptance criteria, established verification commands, and explicit allowed and prohibited GitHub writes when they reduce search or ambiguity. Treat likely areas as starting points, not exhaustive boundaries.

Require only sources that materially affect implementation or verification. Give each non-obvious Required source a task-specific reason that identifies the decision, invariant, boundary, or verification requirement it controls; stable repository-mandated reads may share one concise justification. Point to relevant sections when practical, prefer current canonical repository sources over copied documents or historical reports, and do not repeat stable rules already available in applicable `AGENTS.md`, CI, tests, or canonical workflow documentation.

For implementation work, require Codex to briefly identify expected files, critical invariants, material risks, and genuine stop conditions, then continue through the assigned implementation, verification, complete diff review, publication, and pull-request work without waiting for plan approval. A plan, progress update, focused test run, local commit, or push is intermediate rather than completion while assigned work remains.

Define stop conditions narrowly: an unresolved owner or architecture decision, an invalidated branch or head, unavailable permission or evidence with no permitted alternative, a security or trust-boundary concern, or a repair that would materially broaden scope or change accepted behavior. A recoverable tool, command, or GitHub failure is normally a retry or route-selection problem rather than task completion or a stop condition. Resolve minor ambiguity from current repository evidence and report the assumption instead of stopping.

A prompt-supplied expected or reference SHA is not itself a stop condition when the task is to start from current `main`. In that case, have Codex synchronize the authoritative remote `main`, leave any unrelated or stale local branch, and start the task branch from the synchronized head. Stop for a SHA/head mismatch only when the assignment requires an exact immutable source identity or synchronization shows that the assigned branch/head was genuinely invalidated in a way that affects the task. A stale local branch or remote-tracking ref is normally synchronization work, not task completion.

Limit repository reading as well as prompt length:

- **Required:** sources that materially define implementation or verification.
- **Conditional:** open only when current code, dependencies, or a concrete ambiguity make them relevant.
- **Unrelated by default:** do not read speculatively; reconsider only when repository evidence reveals a direct dependency, conflict, or verification need.

Do not let documentation restrictions override applicable repository instructions.

Adjust implementation freedom by model:

- **Luna:** clearer sequencing, narrower decisions, concrete checks.
- **Terra:** implementation direction, ownership, risks, and local freedom.
- **Sol:** precise contracts, relevant evidence, high-risk invariants, and broad implementation freedom.

Adjust investigation depth independently by reasoning level:

- **Low:** resolve ambiguity upfront and keep the path well bounded.
- **Medium:** provide direction and allow normal repository investigation.
- **High:** identify unresolved questions, trade-offs, or diagnostic risks instead of adding procedural steps.

Use one coherent Codex execution phase by default only when the complete required reading, implementation, verification, diff review, publication, and assigned pull-request maintenance are expected to fit comfortably. Otherwise split the work before execution into the smallest coherent, independently verifiable phases. Before splitting, trace immediate execution dependencies. Each phase must be dependency-closed for the behavior it introduces: do not defer a required transition, state, serialization, validation, or other path that ordinary successful execution can immediately reach. Order phases by dependency, from prerequisites through reachable behavior, before hardening or finalization. Each implementation phase should normally end in a durable repository state, and a dependent next phase should start from the verified resulting head or another explicitly recorded handoff state. Split also when different capability is genuinely required, an owner decision must occur between phases, or independently reviewable work benefits from separation. Do not use a stronger model or higher reasoning merely to compensate for excessive execution volume. Internal milestones remain useful when they validate a risky intermediate choice, but they are not separate approval gates or automatically separate prompts, branches, pull requests, contexts, or model selections.

Remove repetition and narrative filler, not meaning. Self-review prompts and phase plans for recurring token/context cost; remove detail that does not guide current execution, especially duplicated facts or unrelated future-phase material. Preserve necessary conditions, ordering, exceptions, and execution clarity. Do not write the patch in prose or leave the objective underspecified.

### Internal routing recommendation

Before drafting each Codex task, including every review-repair prompt, record:

```text
Executor:
- Sol agent or Codex:
- Rationale for this current task:
- Execution volume: one run or bounded phases:
- Phase boundary and durable end state, when split:

Recommended Codex configuration, when applicable:
- Model:
- Reasoning:
- Escalation trigger:

Codex prompt notes:
- Relevant files, patterns, and Required-source reasons:
- Critical constraints, invariants, and genuine stop conditions:
- Allowed and prohibited GitHub writes:
- Verification and final completion state:
- Internal milestones, only when useful:
```

This recommendation is not the Codex prompt. Name one primary configuration. When uncertain between model tiers, choose the cheaper model only when failure is quickly and reliably detectable. When uncertain between Medium and High, choose Medium unless a specific unresolved uncertainty, strategy choice, or diagnostic burden requires High.
