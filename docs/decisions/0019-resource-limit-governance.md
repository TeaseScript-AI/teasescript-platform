# ADR 0019 — Resource-limit governance

**Status:** Proposed
**Issue:** #130
**Parent:** #129

## Context

The repository uses bounded deterministic behavior across parsing, compilation,
plan validation, runtime execution, snapshots, checkpoints, host data,
transport, storage, and development tooling. Accepted ADR 0015 requires
validated versioned JSON-safe plans and explicit runtime state. ADR 0016 adds
bounded checkpoint-safe pending actions. ADR 0017 keeps validation,
checkpointing, security, and typed host boundaries engine-owned. ADR 0018
requires bounded interaction data, deterministic rejection without truncation
or partial mutation, and testing across every relevant boundary.

Those accepted decisions do not define one repository-wide method for
classifying, justifying, testing, documenting, and changing technical limits.
A defensive capture allowance, a compiler guard, an execution quantum, a UI
warning, and an officially supported engine capacity can therefore be confused
with each other. A round implementation value may become a documented promise
without evidence that one or more worst-case or Pareto-relevant valid forms for
every applicable resource dimension survive the complete engine and platform
path.

This ADR defines governance terminology and evidence requirements. It does not
select or change a numeric limit, reclassify any current value, alter a public
boundary, or declare any existing value correct or incorrect. The complete
repository inventory, measurements, and production repairs remain separate
follow-up work under issue #129.

This ADR remains `Proposed` until the Owner explicitly approves its exact text
in issue #130 or its pull request. Approval of the
workstream or technical review alone does not change its status.

## Decision summary

1. Every explicit or implicit repository limit must have one primary category,
   an affected boundary, a canonical source, its governing authority or an
   explicitly unresolved decision, the applicable change process and any
   required Owner approval, a measurement definition, a concrete risk, and an
   evidence status. The measurement definition is a quantitative unit or a
   qualitative domain or predicate, with a reason when no quantitative unit
   applies.
2. Limits with different threat models or semantic purposes must not share one
   value merely for convenience. Coupled limits must record the coupling and
   downstream expansion explicitly.
3. An officially supported maximum is an end-to-end contract across every
   applicable public layer, not merely agreement between a production constant
   and a boundary test.
4. Deterministic structural measurements and public-boundary tests are the
   primary correctness evidence. Wall-clock measurements are supplemental.
5. A future authoritative limit registry records every production limit or
   implicit hard bound. This ADR defines that registry contract but does not
   populate it.
6. Changes to product policy, architecture, accepted serialized domains, or
   compatibility require the corresponding Owner approval, ADR, format-version,
   migration, and compatibility decisions described below when applicable.
7. A provisional POC guard remains provisional until the required evidence and
   decisions promote it. It is not a permanent public compatibility promise.

## Terminology

A **limit** is any explicit constant, configurable option, formula, validation
budget, bounded loop, maximum collection size, maximum depth, maximum work
allowance, transport ceiling, storage ceiling, or implicit mechanism that
rejects, stops, yields, truncates, declines to process, or otherwise bounds
input or execution.

A **boundary** is the public or internal operation at which a limit is applied,
such as source capture, parsing, semantic validation, lowering, plan capture,
plan validation, snapshot creation, checkpoint creation, restore, Player
presentation, host-message validation, transport, rendering, storage, or a
tooling command.

A **governing authority** is an accepted ADR, accepted specification, or
controlling current topic contract that defines or constrains a limit or its
boundary. If accepted authority does not decide a required change, the registry
records that choice as unresolved and records the applicable change process and
any required Owner approval. Owner approval becomes durable implementation
authority only after the applicable accepted source is updated. An executing,
reviewing, or coordinating agent is temporary and does not acquire durable
ownership by working on the entry.

A **measurement definition** states how the governed property is evaluated. It
uses a quantitative unit when the property is measurable, such as bytes, nodes,
instructions, frames, or validation work. A qualitative representation
invariant instead records its accepted domain, predicate, or structural
criterion. When no quantitative unit applies, the registry records that fact
and its rationale rather than inventing an artificial unit.

A **resource dimension** is one independently relevant axis of resource use,
such as source bytes, AST nodes, graph-capture work, instruction count,
temporaries, frames, validation work, message bytes, rendered controls, or
checkpoint bytes.

A **worst-form evidence set** contains one or more valid representations that
are worst-case or Pareto-relevant for every applicable resource dimension and
coupled downstream budget. No single representation is assumed to maximize all
dimensions.

An **officially supported maximum** is a value or formula deliberately offered
as supported capacity for a documented input class. It is stronger than an
implementation guard. Where runtime layers apply, it must satisfy the
end-to-end maximum invariant in this ADR.

A **structured diagnostic** is the repository's documented bounded error,
invalid result, or rejection outcome for the relevant boundary. Native stack
overflows, incidental allocation failures, hangs, and partially mutated state
are not structured diagnostics.

## Limit taxonomy

Each registry entry has one primary category. A limit may interact with other
categories, but those relationships are recorded separately rather than
collapsing their meanings.

### Representation invariant

A representation invariant defines what values or structures are valid at all,
independent of ordinary capacity policy. Examples include finite required
numbers, valid instruction positions, supported format versions, acyclic
canonical structures, identity uniqueness, and state relationships required
for deterministic restore.

An invariant is justified by representation correctness. It is not a product
default, usability recommendation, work quantum, or provisional capacity
number.

### Product default

A product default selects ordinary behavior when the author, player, account,
or caller supplies no override. A default is not automatically a maximum. Its
canonical policy source, change process, and override rules must be explicit.

Changing a user-visible default may require a product-policy decision and a
compatibility note even when every previously accepted value remains valid.

### UI warning or usability threshold

A UI warning or usability threshold identifies input that is technically valid
but likely awkward, slow to author, hard to read, difficult to render, or poor
for accessibility or interaction design.

It is non-blocking unless a separate accepted technical or product-policy limit
also applies. A UI warning does not automatically become an engine rejection.

### Hostile-input capture budget

A hostile-input capture budget bounds the work needed to detach, inspect, and
stabilize caller-controlled data before detailed validation. It protects
against cycles, accessors, proxies, unsupported prototypes, excessive depth,
excessive graph size, and similar hostile or malformed inputs.

This budget belongs to the capture threat model. It does not automatically
define the capacity of compiler-generated plans, runtime snapshots, or
checkpoints, even when those structures currently pass through the same helper.

### Engine representational capacity

Engine representational capacity is an officially supported maximum for a
specified valid source, plan, runtime-state, snapshot, checkpoint, action, or
other engine-owned representation.

A capacity claim requires a worst-form evidence set and proof across all
applicable downstream engine and platform layers. It must define the input
class, measurement definition, public boundary, resource dimensions, expansion
model, safety margin, and compatibility consequences.

### Parser, compiler, or runtime implementation guard

An implementation guard bounds recursion, allocation, work, or another
implementation-specific risk in the current parser, compiler, validator, or
runtime. It prevents an identified failure mode but is not automatically an
engine capacity promise or product policy.

A guard may later become a proven capacity, be replaced by a structural
formula, or become obsolete after the implementation changes. Until then its
status and limitations remain explicit.

### Execution quantum

An execution quantum bounds work performed by one invocation, scheduling turn,
step operation, or yield interval. Exhausting a quantum normally returns
control, yields, or produces the documented per-invocation outcome.

An execution quantum is not the same as an absolute runaway-session or product
policy ceiling unless an accepted decision deliberately combines those
semantics.

### Absolute runaway or policy ceiling

An absolute runaway or policy ceiling defines total work, duration, resource
consumption, or another condition after which the session, operation, package,
or account is permanently rejected, failed, stopped, or disallowed by policy.

Because it changes user-visible acceptance or failure semantics, this category
normally requires explicit Owner approval and clear compatibility handling.

### Transport, storage, or tooling guard

A transport, storage, or tooling guard protects a specific non-engine boundary,
such as an HTTP request body, editor buffer, package metadata field, artifact,
CLI campaign, development workspace, database field, or build tool.

It proves only the capacity of that boundary. It becomes an engine capacity
constraint only when the data is contractually required to cross into the
engine and the relationship is demonstrated.

### Provisional POC implementation guard

A provisional POC implementation guard is a temporary deterministic bound used
to keep the current proof of concept safe and reviewable before complete
capacity evidence or product policy exists.

It must be marked `provisional`, identify the risk it currently prevents, avoid
claims of permanent support, and record the evidence, governing decision, or
Owner approval still needed. Tests may pin its current behavior without
promoting it to proven capacity.

## Required distinctions

The following distinctions are mandatory:

- A hostile-input capture budget does not automatically determine the capacity
  of compiler-generated plans, runtime snapshots, or checkpoints.
- A UI warning or usability threshold does not automatically reject input in
  the engine.
- An execution quantum is distinct from an absolute runaway-session or policy
  ceiling unless an accepted decision deliberately combines them.
- A provisional POC guard is not a permanent public compatibility promise.
- A test that imports a production constant and checks `max` and `max + 1`
  proves implementation agreement at that boundary. It does not prove that the
  number is correct, justified, covered by the required worst-form evidence
  set, or supported end to end.
- Raising a general security or hostile-input budget is not the default repair
  for an inefficient compiler-generated, plan, snapshot, checkpoint, or other
  internal representation. The representation, expansion, and applicable
  governing budget must be analysed first.
- Sharing a number across boundaries does not establish that the boundaries
  have the same threat model, measurement definition, expansion factor,
  evidence, or compatibility contract.
- A product default, warning threshold, and technical rejection limit may have
  different values, canonical sources, and change processes.

## End-to-end maximum invariant

For every officially supported source or public-input maximum, each
representation in the applicable worst-form evidence set must survive every
applicable stage of at least this minimum engine sequence:

1. capture or parsing;
2. semantic validation;
3. lowering;
4. public plan validation;
5. fresh snapshot creation;
6. execution to every relevant wait or event boundary;
7. checkpoint creation;
8. JSON serialization and parsing;
9. public restore;
10. resumed completion;
11. deterministic uninterrupted-versus-resumed equivalence.

The numbered sequence is the minimum engine chain, not the entire public
platform path. Evidence must also traverse every applicable Player application,
parent/player or host-message, typed host integration, transport or API,
rendering or Standard/custom UI, persistence or storage, and other platform
boundary through which the accepted data must travel. An engine maximum is not
`proven` when a required Player, message, transport, rendering, or storage
boundary still rejects or cannot safely represent it.

Resource use is multidimensional. The proof identifies every applicable
resource dimension and coupled downstream budget, then uses one or more
worst-case or Pareto-relevant valid forms for each. No single globally
"heaviest" representation is presumed. When the accepted input class has
materially different forms, such as static and dynamically lowered forms,
root-owned and function-owned forms, or waiting and completed states, the
worst-form evidence set covers every form needed to bound those dimensions and
their downstream expansions.

A layer or boundary may be marked not applicable only with a concrete reason.
For example, a tooling-only metadata field that is never compiled, sent to the
Player, placed in a runtime snapshot, or stored in a checkpoint does not require
runtime, Player, or resume tests. It still requires focused tests for every
applicable tooling, capture, validation, serialization, transport, rendering,
or storage boundary and must not be reported as engine capacity.

### Downstream-derived upstream capacity

When a downstream boundary cannot support an upstream maximum, the supported
upstream maximum must be derived from the downstream contract and the
worst-case or Pareto-relevant expansions for every applicable resource
dimension and coupled budget. The earliest suitable upstream boundary then
rejects the unsupported input with a focused structured diagnostic.

The repository must not knowingly accept an upstream maximum that later fails
incidentally in lowering, plan validation, snapshot creation, checkpointing,
serialization, restore, resumed execution, Player presentation, host-message
validation, transport, rendering, or storage.

A downstream constraint may instead be repaired or structurally separated, but
that repair belongs to its own implementation decision and evidence. This ADR
does not design the actual plan, snapshot, checkpoint, or capture-budget split.

## Evidence statuses

Every registry entry uses one of these statuses.

### `proven`

`proven` means the current value, predicate, accepted domain, or formula is
justified for its declared category, measurement definition, boundary, and
input class.

Where relevant, evidence includes:

- the concrete risk or invariant being protected;
- a derivation, external constraint, accepted product policy, or deterministic
  structural measurement supporting the value or formula;
- tests through the documented public boundary;
- `max - 1`, `max`, and `max + 1` behavior where a quantitative ordered
  limit makes those cases meaningful;
- a cheapest valid baseline where useful;
- the worst-form evidence set for every applicable resource dimension and
  coupled downstream budget;
- all applicable minimum-engine and public-platform invariant stages;
- checkpoint creation, JSON round trip, public restore, resumed completion, and
  uninterrupted-versus-resumed equivalence where runtime state applies;
- deterministic bounded failure with no partial mutation at the rejecting
  boundary;
- documented safety margin, configuration, versioning, and compatibility
  consequences.

Not every entry needs every test shape. The registry records why a stage is not
applicable rather than silently omitting it.

### `provisional`

`provisional` means the limit is a deliberate deterministic current guard, but
its value, predicate, accepted domain, or formula lacks complete evidence, final
product policy, or both. The entry records the missing evidence, unresolved
governing decision, or required Owner approval.

### `suspicious`

`suspicious` means available evidence indicates a likely category error,
circular justification, boundary coupling, unsupported worst form, unexplained
expansion, inconsistent public behavior, or another reason the current value,
predicate, accepted domain, or formula should not be trusted as a justified
contract.

Suspicious does not by itself authorize changing the value or weakening the
boundary. It requires focused reproduction, measurement, or design work.

### `obsolete`

`obsolete` means the limit or mechanism no longer protects a reachable current
boundary, has been replaced, or remains only as dead compatibility residue.
Removal still requires normal code, test, documentation, and compatibility
review.

### Evidence rules

Deterministic structural evidence is preferred: node counts, edges, bytes,
UTF-16 units, UTF-8 bytes, instructions, frames, actions, graph values,
validation units, allocation sizes, or formulas tied to validated structure.
Public-boundary tests are preferred over private-helper tests.

Wall-clock time and peak-memory measurements may supplement evidence and help
select safety margins. They do not independently define correctness because
they vary by hardware, runtime version, load, and environment.

A status change records its evidence source. Promotion to `proven` is an
explicit review outcome, not an automatic consequence of adding an exact-boundary
test.

## Limit-registry contract

The later repository-wide inventory under issue #129 must record every
production constant, option, formula, validation budget, bounded mechanism, or
implicit hard bound. Each entry contains at least:

- stable entry identity;
- canonical source for the current limit or contract;
- governing authority, or an explicit unresolved-decision marker when no
  accepted source decides the change;
- affected public or internal boundary;
- applicable change process, including any required Owner approval;
- constant, option, formula, or implicit mechanism;
- primary taxonomy category;
- measurement definition: quantitative unit or qualitative domain, predicate,
  or structural criterion;
- an explicit not-applicable rationale when no quantitative unit exists;
- current value, predicate, accepted domain, or formula;
- concrete risk, invariant, or policy it prevents or enforces;
- evidence status and evidence source;
- cheapest valid baseline where relevant;
- one or more worst-case or Pareto-relevant valid representations for every
  applicable resource dimension and coupled downstream budget;
- downstream expansion and all coupled or interacting budgets;
- safety margin and its rationale;
- configuration surface and accepted range, when configurable;
- versioning, migration, and compatibility consequences;
- required `max - 1`, `max`, and `max + 1` tests where meaningful;
- required worst-form tests;
- required checkpoint and JSON-round-trip tests where runtime state applies;
- required restore, resume, and uninterrupted-versus-resumed equivalence tests
  where runtime continuation applies;
- explicit not-applicable reasons for omitted quantitative units, layers,
  boundaries, or tests;
- recommendation, repair direction, or unresolved governing or Owner decision.

The registry is authoritative for classification and evidence routing after it
is populated and accepted through the normal documentation workflow. It must
reference, not duplicate, accepted ADR semantics. This ADR does not populate
that inventory or assign evidence statuses to current repository values.

## Decision and versioning triggers

A proposed limit change first identifies the category, canonical source,
governing authority or unresolved decision, affected boundary, applicable
change process, measurement definition, evidence status, downstream effects,
and compatibility impact. The following triggers then apply cumulatively.

### Implementation, tests, and documentation only

A normal code, test, and documentation change is sufficient only when all of the
following hold:

- the applicable accepted architecture and product policy remain unchanged;
- no previously accepted public input becomes rejected;
- no user-visible default or absolute policy changes;
- no serialized shape, field meaning, identity rule, or format compatibility
  changes;
- the change does not silently couple or decouple independently governed
  boundaries;
- the registry evidence and focused tests are updated.

Examples include replacing an internal implementation guard with an equivalent
structural formula or increasing an internal validation-work allowance after
proof that the accepted input domain and compatibility contract are unchanged.
The example does not pre-approve any concrete change.

### Explicit Owner product-policy decision

An explicit Owner decision is required when changing:

- a product default;
- a UI warning intended as official product guidance;
- an absolute runaway or policy ceiling;
- a permanent public capacity promise;
- a user-visible rejection or failure policy;
- a compatibility tradeoff between accepting larger data and preserving older
  consumers, sessions, or storage.

Technical approval does not substitute for this Owner decision.

### New or amended ADR

A new or amended ADR is required when a change alters:

- the taxonomy or meaning of a category;
- boundary responsibility or the separation of threat models;
- the architecture for capture, validation, plan, snapshot, checkpoint,
  transport, storage, or execution budgets;
- the relationship between execution quanta and permanent failure policy;
- an accepted engine representational-capacity contract;
- cross-component coupling, or a formula change that alters architecture,
  cross-component coupling, an accepted capacity contract, or public
  compatibility semantics;
- an existing accepted ADR decision.

An accepted ADR is never silently overridden by a registry edit or production
constant change.

### Plan, snapshot, or checkpoint version decision

A format-version change is required when a limit change alters a serialized
shape, field meaning, representation invariant, identity rule, or the accepted
serialized domain in a way that same-version producers, validators, checkpoints,
or restorers may interpret incompatibly.

A numeric implementation-work guard that is not serialized and does not change
the accepted serialized domain does not automatically require a format-version
change. The pull request must still record why versioning is not required.

### Migration decision

A migration decision is required when existing persisted plans, snapshots, or
checkpoints need transformation, continued support, staged rejection, or
operator action. The repository must not add an implicit latest-version restore
or silent migration.

### Compatibility note

A compatibility note is required whenever previously accepted source, public
input, plan, snapshot, checkpoint, host data, package data, or tooling data will
now be rejected, or when a user-visible default or failure policy changes.

If persisted formats are affected, the compatibility note accompanies the
format-version and migration decision rather than replacing them.

## Testing governance

Tests for limits must distinguish agreement from justification.

A focused boundary test may import the production constant to verify that the
implementation accepts the documented boundary and rejects one unit over it.
That is useful regression coverage, but the evidence record must separately
show why the constant or formula is appropriate.

Where applicable, limit tests cover:

- `max - 1`, `max`, and `max + 1` for quantitative ordered limits;
- a cheapest valid baseline where useful;
- one or more worst-case or Pareto-relevant forms for every applicable resource
  dimension and coupled downstream budget;
- static and dynamically expanded forms;
- root-owned and function-owned forms;
- fresh, waiting, completed, checkpointed, restored, and resumed states;
- the minimum engine sequence and every applicable Player, host-message,
  transport, rendering, and storage boundary;
- deterministic structured rejection and input-state immutability;
- uninterrupted-versus-resumed equivalence.

Measurements and generated cases must themselves be bounded and reproducible.
A benchmark result may reveal insufficient margin or inefficient expansion, but
correctness does not depend on meeting one environment-specific wall-clock
number unless an accepted performance policy separately defines it.

## Relationship to accepted ADRs

- ADR 0015 remains authoritative for versioned JSON-safe plans, explicit runtime
  state, checkpoints, deterministic stepping, and configurable instruction-budget
  failure.
- ADR 0016 remains authoritative for atomic bounded pending-action state,
  deterministic time observation, action identity, settlement, checkpoint, and
  restore behavior.
- ADR 0017 remains authoritative for engine ownership of validation,
  checkpointing, typed bounded data, security, and resumable continuations.
- ADR 0018 remains authoritative for bounded interaction data, no truncation or
  partial mutation, the distinction between technical limits and UI guidance,
  and required testing across relevant boundaries.

This governance contract supplements those decisions. It does not change their
semantics, select their implementation values, or retroactively assign evidence
statuses.

## Consequences

### Benefits

- Technical limits gain explicit governing authorities, canonical sources,
  change processes, meanings, measurement definitions, risks, and evidence.
- Defensive hostile-input budgets no longer silently define internal engine
  capacity.
- UI guidance, execution scheduling, permanent policy, and representational
  capacity remain distinguishable.
- Capacity claims become testable through the minimum deterministic engine
  chain and every applicable public platform boundary.
- Future limit changes expose their product, architecture, format, migration,
  and compatibility consequences before implementation.

### Costs

- The repository needs a maintained limit inventory and evidence review.
- Worst-form structural fixtures and end-to-end tests may be more expensive than
  exact-boundary unit tests.
- Some current values may remain provisional or suspicious until separate
  measurement and repair work is completed.
- Independently motivated boundaries may require separate constants or formulas
  instead of one convenient shared allowance.

## Explicit exclusions

This ADR does not:

- choose or change any numeric value or formula;
- declare a current value proven, provisional, suspicious, or obsolete;
- populate the repository-wide inventory;
- run benchmarks or capacity measurements;
- change parser depth, call depth, instruction budgets, interaction limits,
  library-tooling limits, or transport limits;
- split or redesign plan, snapshot, checkpoint, external-data, or validation
  budgets;
- change production TypeScript, schemas, format versions, validation behavior,
  lowering, or runtime execution semantics;
- repair any defect identified by issue #129;
- add dependencies or infrastructure.

## Follow-up

Issue #131 completed the raw repository inventory, coupling, and cross-boundary
reproduction evidence and is closed. After this ADR is explicitly accepted,
the authoritative Phase 2 synthesis under #129 must consume and validate that
evidence, reproduce only missing or unresolved cases through public APIs,
populate the registry, measure the required worst-form evidence sets, propose
focused repairs, and request any required Owner or ADR decisions. That work
must not be folded into this governance PR.
