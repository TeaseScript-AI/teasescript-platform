# Codex task routing and model selection

Use this guide to choose the executor and, when Codex is selected, the model and reasoning level. Prompt construction,
work-package boundaries, milestone handling, and per-prompt quality checks are owned by
[`CODEX-PROMPTING.md`](CODEX-PROMPTING.md).

Do not mechanically re-read either guide before every consecutive action. Re-read the relevant guide when its rules are
no longer fresh in active context, especially after substantial code or review inspection, large tool output,
a task switch, or other context-heavy work. Consecutive related selection and prompting steps may reuse guidance that
remains fresh. When uncertain whether it is still fresh, re-read it.

Treat this guide as the maintained cost-performance policy for model routing. Do not perform live pricing or benchmark
research during routine task selection. Optimize for expected total work, including orchestration, execution, retries,
repair, review, handoff, and hidden defects, rather than per-token price or model size alone.

### Step 0: Select direct execution or delegation

The **orchestrating agent** is responsible for decomposition, routing, integration, and review. It may be a ChatGPT
project agent or an agent running in the shared LXC under Codex or another harness; do not assume orchestration and
execution use different environments or model families.

Choose between direct execution and delegation by expected total work across the orchestrator and executor.

- **Astra orchestrator:** delegate bounded implementation to Sol early when a short handoff can preserve meaningful
  implementation freedom; keep expensive Astra execution and repeated Astra review loops shallow.
- **Sol orchestrator:** avoid delegating merely to use Luna when Sol must first perform most of the investigation and
  prompt construction, Luna must then reacquire the same context, and Sol must repeat substantial review.
- **Any orchestrator:** delegate when it reduces expected total cost, materially improves capability, or enables useful
  parallelism.

Parallel work packages must not overlap in implementation responsibility. For sequential delegation, do not perform the
delegated implementation yourself while waiting; wait for the result or work only on clearly non-overlapping work.

Diff size is one factor, not the rule. When Codex is selected for execution, let it obtain current repository and GitHub
state through normal `git` and `gh`; do not supply Source artifacts, copied canonical documents, or broad context
packages without a concrete identity, availability, trust, or task-specific reason.

### Model and reasoning are separate choices

Use model strength for semantic capability:

- **Luna:** prescribed implementation where the material semantics, architecture, boundaries, and intended behavior are
  already resolved. The work may span multiple files or modules and may require ordinary local coding judgment; it does
  not need to be mechanical, repetitive, or localized.
- **Sol:** work where the executor must discover, choose, reconcile, or diagnose material semantics, boundaries,
  implementation strategy, interacting invariants, or nonlocal behavior; also demanding integration and independent
  review.
- **Astra:** difficult cross-boundary reasoning, orchestration, complex diagnosis, integration judgment, or independent
  semantic review beyond a normal Sol Medium assignment.

Reasoning effort and model strength are separate choices, but their cost-performance tradeoff is model-specific. Do not assume that a smaller model at higher reasoning is cheaper per completed task, or that a stronger model is necessarily more expensive once token use, retries, and repair are included. Higher reasoning cannot compensate for semantic decisions beyond the selected model's reliable capability.

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
but execution volume still determines whether the work fits one run. A task may require several bounded work packages
without requiring a stronger model. Do not use a stronger model or higher reasoning to compensate for excessive
execution volume.
Strong verification permits a cheaper configuration only when it covers the relevant failure modes and independently
verifies the property being relied on. Passing tests, lint, or type checks are insufficient when they cannot detect
incorrect ownership, compatibility, API leakage, ordering, unsupported exceptions, false evidence claims, or other
important semantic failures.

### Step 2: Select the model

#### Select Luna when

Use Luna when the material semantic route is already resolved:

- intended behavior, architecture, ownership, and important boundaries are explicit in the prompt or controlling
  repository authority;
- the executor may make ordinary local coding choices but does not need to choose material behavior, architecture, or
  ownership;
- affected regions or patterns, critical invariants, and verification are sufficiently explicit to keep the assignment
  prescribed;
- larger work can be divided into bounded planned stages without making Luna rediscover the implementation strategy.

The work may span several files or modules. Typical Luna work includes file moves, import migrations, compatibility
facades, documentation updates, straightforward fixtures, accepted-architecture integration, prescribed canonical-state
or transactional repairs, tooling or UI adapters against defined contracts, behavior-neutral refactors with named
regions or patterns, and established verification.

Keep Luna work packages more tightly bounded and context-focused than Sol work. For larger Luna work, define the
intended milestone sequence before the first delegation and send bounded stages from that plan rather than the entire
assignment at once. Review each completed stage before selecting the next planned stage.

Use Luna Medium for straightforward prescribed implementation. Use Luna Max for more demanding prescribed work when
the semantic route remains fixed but careful execution, coordination, or verification benefits materially from
additional reasoning. Do not use Luna Max to compensate for unresolved semantic or architectural decisions.

#### Select Sol when

Select Sol when at least one capability-specific Sol trigger applies:

- the executor must discover, choose, redesign, or reconcile an important architectural, ownership, or behavioral
  boundary;
- several modules or interacting invariants must be understood in order to determine the correct implementation route,
  rather than merely execute an already resolved route;
- a canonical state model, transition semantics, event-ordering contract, continuation model, transaction contract, or
  atomicity contract must be designed, extended, or reconciled;
- serialization requires choosing a new behavioral representation or provenance model rather than applying a prescribed
  repair or schema update;
- materially different strategies have different correctness or compatibility consequences;
- subtle nonlocal failures require independent diagnosis because the important invariants or failure mechanism have not
  already been identified and made testable;
- repeated exceptions or evidence claims must be judged against nonlocal invariants, while automated checks can still
  pass when those claims, suppressions, assertions, or type weakenings are semantically unjustified;
- integration or final review must detect plausible cross-boundary semantic inconsistencies that Luna may miss.

High impact, broad scope, many invariants, checkpoints, several layers, or expensive rework are not sufficient alone.
When semantics, architecture, boundaries, and intended behavior are resolved and the remaining task is prescribed
implementation, Luna may still be sufficient even when the work spans several modules.

Typical Sol work includes new canonical runtime state models, changed transition or ordering contracts, new continuation
or transaction semantics, lifecycle or state-machine redesign, unresolved module boundaries, subtle nonlocal behavioral
regressions, difficult integration, and high-risk semantic audits.

#### Select Astra when

Astra is a constrained-capacity tier. An agent may recommend Astra but must not select or spawn an Astra sub-agent
without explicit owner authorization.

Recommend Astra when semantic completeness is difficult to verify mechanically and subtle omissions or cross-boundary
inconsistencies could plausibly survive competent Sol work; when difficult nonlocal diagnosis or integration judgment
exceeds a normal Sol Medium assignment; or when Sol work warrants a stronger independent semantic review.

When Astra is authorized, default to Astra Low. An agent may recommend higher Astra reasoning, but must not select
it without explicit owner authorization.

When Astra is the orchestrating agent, delegate implementation to Sol by default. Sol may further delegate sufficiently
specified work to Luna and perform the first review and repair pass before returning the integrated result to Astra.
This keeps expensive Astra review loops shallow.

### Step 3: Select reasoning effort

#### Low reasoning

Use Low when the task is deterministic, the path is well bounded, relevant files and expected results are known, little
repository exploration is needed, and errors are immediately visible through tooling.

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

#### Max reasoning

Use Luna Max for demanding prescribed work when semantics, architecture, and important boundaries are already resolved
and additional deliberate execution or verification materially improves reliability. Do not use Max to substitute for
semantic or architectural judgment that belongs with Sol.

### Default configurations

```text
Straightforward prescribed implementation with resolved semantics and boundaries:
Luna Medium

More demanding prescribed implementation with a fixed semantic route:
Luna Max

Work requiring material semantic or boundary decisions, broader repository
reasoning, nonlocal diagnosis, integration judgment, or difficult review:
Sol Medium

Work materially beyond a normal Sol Medium assignment or requiring stronger
semantic review:
Recommend Astra Low

Astra-authorized work:
Astra Low
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

- **Luna:** repairs where review has resolved the defect, required semantics, implementation boundary, and verification
  sufficiently to make the remaining work prescribed.
- **Sol:** repairs where material semantic judgment, boundary discovery, reconciliation, representation design, or
  difficult nonlocal diagnosis remains.
- **Astra:** recommend owner-authorized Astra Low when subtle omissions or cross-boundary inconsistencies could plausibly
  survive competent Sol work or stronger independent semantic review is warranted.

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

Treat unsupported evidence claims, broadened exceptions, or weakened meaningful assertions used to satisfy checks as
semantic failure, not successful verification. When review establishes that the verification oracle can be satisfied
without preserving the intended property, do not repeat an equivalent attempt under the same configuration.

Escalate to a stronger model when the current model repeatedly makes incorrect ownership or semantic decisions, cannot
preserve interacting invariants, produces superficially green but incomplete work, or consumes the expected saving
through retries and repair. Before escalating a well-understood repair, distinguish a model reasoning limit from a
prompt-packaging failure: if accepted semantics are clear but the assignment unnecessarily makes one executor choose a
moving foundation, downstream repair order, and publication boundary at once, first tighten the work package and
implementation direction. A successful bounded retry is evidence that the earlier package was the problem. If the
better-specified retry still fails, treat that as escalation evidence only when the failure exposes a remaining
reasoning, semantic or invariant-preservation, or diagnostic capability burden; execution volume, tooling, environment,
test-harness, publication, or other non-capability failures are not evidence for a stronger model or reasoning level.

A scope-stop condition is not a model-escalation trigger. It prevents automatic scope expansion. Do not repeat the same
failed prompt and configuration more than once without changing the instructions, reasoning effort, model, or task
specification.

### Handoff to prompt construction

Executor choice, classification, model selection, reasoning justification, cost analysis, and escalation logic are
internal routing work. Record one primary configuration and only the escalation trigger needed to revisit it. Translate
only task-relevant routing findings into concrete execution constraints or checks; do not copy classification labels,
pricing, rejected configurations, or model-selection rationale into the Codex prompt.

```text
Execution: direct or delegated
Execution volume: one run or requires bounded work-package planning
Executor model/reasoning, when delegated:
Escalation trigger:
```

When uncertain between model tiers, choose the cheaper model only when failure is quickly and reliably detectable.
When uncertain between Medium and High, choose Medium unless a specific unresolved uncertainty, strategy choice, or
diagnostic burden requires High.

If Codex will receive a prompt, continue with [`CODEX-PROMPTING.md`](CODEX-PROMPTING.md) and complete its mandatory
author preflight.
