# Resource-limit registry

This is the canonical repository registry for resource-limit classification and
evidence routing under [ADR 0019](decisions/0019-resource-limit-governance.md).
Source code remains canonical for the exact implemented constant or formula;
accepted ADRs and topic specifications remain authoritative for their decisions.
This document records what a current bound means, what evidence supports it, and
what follow-up is still required.

## Scope and use

The registry covers repository-owned production bounds that limit source
processing, caller-controlled data, engine/runtime work or state, checkpoint
handling, and the local playground transport/execution boundary. It includes
implicit hard bounds when they constrain one of those paths. Repository CI,
agent-bootstrap, patch-publication, and test-harness budgets are development
workflow controls rather than platform production limits and stay in their own
tooling contracts.

It is intentionally **not** a catalog of every semantic validator. Type domains
such as finite arithmetic results, choice-label rules, RNG algorithm state,
exact format versions, and capability/state-machine exclusions stay in their
owning specifications unless they are themselves the relevant resource,
identity, or overflow bound.
Test-only fuzz/property budgets and validation-statistics overrides are also out
of scope. No missing category implies that a new limit should be invented.

Evidence statuses (`proven`, `provisional`, `suspicious`, `obsolete`) and change
triggers have exactly the meanings defined by ADR 0019. In particular:

- a local implementation or tooling guard can be proven for that local risk
  without becoming a broader engine-capacity promise;
- `provisional` does not mean unsafe; it means the exact value, formula, policy,
  or broader evidence is incomplete;
- `suspicious` identifies a concrete coupling/category/evidence problem and does
  not authorize changing the value;
- an official source/platform maximum needs the applicable end-to-end proof;
- every new or materially changed production limit must be surfaced to the
  Owner, and ADR 0019 separately defines changes that need explicit Owner
  approval or an ADR.

Issue #131 is historical Phase 2A evidence. Its measurements proved important
failure modes and coupling on the then-current tree and PR #128, but its numeric
choice-lowering boundaries are **not** current-main capacity values after later
runtime/result-handoff changes. This registry consumes those observations only
where the underlying current mechanism still exists.

### Registry shorthand for inherited ADR 0019 fields

To keep one table maintainable instead of repeating boilerplate in every row,
the following fields are inherited unless a row explicitly says otherwise:

- the measurement definition is the quantitative unit/domain stated in the
  current-value cell;
- a limit is not caller-configurable unless the row states a configuration
  surface or range;
- every material change has the ADR 0019 Owner-information duty; the normal
  implementation/test/documentation route is available only while all ADR 0019
  implementation-only conditions remain true;
- a change that alters capture/validation/budget architecture or accepted ADR
  semantics requires the applicable ADR work; a change that alters an accepted
  serialized domain also triggers format-version/migration/compatibility review;
- changing a row classified as a product default, permanent public capacity,
  absolute policy ceiling, or user-visible rejection/compatibility policy has
  the explicit Owner-approval trigger defined by ADR 0019;
- ordered numeric guards require focused boundary coverage around the accepted
  edge when meaningful. Runtime-state limits additionally require checkpoint,
  JSON round-trip, restore/resume, and immutability coverage when those layers
  apply. An official capacity claim additionally requires the ADR 0019
  worst-form/end-to-end evidence set;
- for representation invariants that do not claim quantitative capacity, a
  cheapest-valid fixture, Pareto worst form, and safety margin are not applicable
  unless a row identifies an actual resource dimension; relational and
  exact-domain boundary tests are the relevant evidence instead;
- for `provisional` or `suspicious` rows, any missing safety margin,
  cheapest-valid fixture, worst-form derivation, or downstream capacity proof is
  intentionally recorded as missing evidence rather than invented;
- no row in this Phase 2 inventory is currently classified as `engine
  representational capacity`; no general source, plan, snapshot, checkpoint, or
  platform maximum is created by this registry;
- engine/checkpoint stages are not applicable to playground-only rows because
  those values do not enter the engine contract. Their required evidence ends
  at the actual playground tooling/transport boundary.

### Primary evidence anchors

The registry does not duplicate test cases. The main current boundary evidence
is maintained in:

- [`tests/parser-nesting-boundaries.test.ts`](../tests/parser-nesting-boundaries.test.ts)
  and [`tests/parser-nesting-limit.test.ts`](../tests/parser-nesting-limit.test.ts)
  for parser recursion;
- [`tests/external-runtime-data-limits.test.ts`](../tests/external-runtime-data-limits.test.ts)
  and [`tests/stable-external-data.test.ts`](../tests/stable-external-data.test.ts)
  for graph capture and checkpoint mappings;
- [`tests/instruction-plan-range-validation.test.ts`](../tests/instruction-plan-range-validation.test.ts)
  and [`tests/runtime-snapshot-invariants.test.ts`](../tests/runtime-snapshot-invariants.test.ts)
  for safe-integer plan/runtime representation domains;
- [`tests/functions-checkpoint.test.ts`](../tests/functions-checkpoint.test.ts)
  for call-frame and detailed snapshot-validation work;
- [`tests/foreground-interactions-runtime.test.ts`](../tests/foreground-interactions-runtime.test.ts),
  [`tests/foreground-interactions-handoff-runtime.test.ts`](../tests/foreground-interactions-handoff-runtime.test.ts),
  and [`tests/pending-action-hardening.test.ts`](../tests/pending-action-hardening.test.ts)
  for interaction/time/counter boundaries and checkpoint-safe completion;
- [`tests/playground-workspace.test.ts`](../tests/playground-workspace.test.ts),
  [`tests/playground-server.test.ts`](../tests/playground-server.test.ts), and
  [`tests/playground-browser-workspace.test.ts`](../tests/playground-browser-workspace.test.ts)
  for the local workspace boundary.

#131 remains the evidence source for historical cross-boundary coupling and the
old PR #128 reproductions; those measurements are not silently restated as
current-main maxima.

## Engine and runtime

| ID | Boundary and concrete risk | Primary category | Current value / formula / mechanism | Canonical source | Governing authority / unresolved decision | Evidence status | Couplings, evidence, and next action |
|---|---|---|---|---|---|---|---|
| `parser.nesting` | Recursive source parsing; prevents native stack exhaustion and unstructured parser failure. | Parser/compiler/runtime implementation guard | `MAX_PARSER_NESTING_DEPTH = 64` recursive syntax entries. | [`src/parser.ts`](../src/parser.ts) | ADR 0019 governs classification; issue #101 established the required bounded parser failure. No accepted source makes `64` a permanent language-capacity promise. | `provisional` | Boundary tests cover the implemented exact edge and deep failing forms. The need for a guard is established; the retained evidence does not derive `64` as an official source maximum. Re-measure only if parser structure or the guard changes. |
| `capture.depth` | Stable capture of caller-controlled graphs; prevents unbounded nesting before detailed validation/cloning. | Hostile-input capture budget | `MAX_EXTERNAL_RUNTIME_DATA_DEPTH = 128`, root depth `0`. | [`src/external-data-limits.ts`](../src/external-data-limits.ts), [`src/ast-validation.ts`](../src/ast-validation.ts) | ADR 0019; current security contract in [`SECURITY.md`](SECURITY.md). No authority makes `128` general plan/snapshot/checkpoint capacity. | `suspicious` | The same number governs generic external data and a separate direct-AST capture implementation, and indirectly constrains plans, snapshots, checkpoints, globals, completions, and serializable values. Keep hostile rejection bounded, but separate/justify independently governed uses before treating the number as broader capacity. |
| `capture.work` | Stable capture of caller-controlled graphs; bounds graph traversal, hostile arrays/keys, and pre-validation allocation/work. | Hostile-input capture budget | `MAX_EXTERNAL_RUNTIME_DATA_WORK = 100_000` visited values; sparse declared array length and key enumeration are also bounded from this allowance. Scalar string bytes and property-key bytes are not charged separately. | [`src/external-data-limits.ts`](../src/external-data-limits.ts), [`src/ast-validation.ts`](../src/ast-validation.ts), [`src/plan/capture-support.ts`](../src/plan/capture-support.ts) | ADR 0019; current security contract in [`SECURITY.md`](SECURITY.md). | `suspicious` | #131 and current Phase 2 evidence show category spillover: the same value is reused by direct AST, plan, snapshot, checkpoint, globals, completion, and serializable-value paths. `compileSource(...)` itself can reject a large otherwise ordinary parsed AST through this shared work guard (`TSC005`), so the resulting source boundary is representation-dependent and is not an engine/source-capacity claim. The graph counter also does not independently bound the byte size of scalar strings/property names; current public APIs accept at least a 1 MiB global string through snapshot/checkpoint serialization. Treat that as a missing resource dimension for later hostile-capture analysis, not as authority to invent a generic string maximum here. |
| `capture.array-index-domain` | Captured JavaScript arrays, including hostile/proxy inputs; prevents invalid array-index keys, precision loss, and index/validated-length disagreement. | Representation invariant | A captured array index must be a safe integer `< 0xffff_ffff` and must fall below the already validated array `length`; direct AST capture applies the equivalent safe-integer/dense-index relationship. | [`src/external-data-limits.ts`](../src/external-data-limits.ts), [`src/ast-validation.ts`](../src/ast-validation.ts) | JavaScript array-index representation plus ADR 0019; issue #87 established the hostile proxy/index-order failure mode. | `proven` | Focused hardening tests cover conflicting proxy indexes and sparse/inflated lengths. The separate `100_000` capture-work guard normally constrains accepted arrays far below this representational domain; do not treat `0xffff_ffff` as supported collection capacity. |
| `ast.source-position-domain` | Public source-position construction and direct-AST source spans; prevents imprecise/non-addressable coordinates from entering compiler diagnostics and serialized data. | Representation invariant | Direct-AST capture requires `offset`, `line`, and `column` to be non-negative JavaScript safe integers, while exported `createSourcePosition(...)` currently accepts any non-negative integer. | [`src/ast-validation.ts`](../src/ast-validation.ts), [`src/source.ts`](../src/source.ts) | ADR 0019 and the public source/direct-AST contracts; the intended uniform numeric domain is unresolved. | `suspicious` | The two public entry points accept different numeric domains. Parser-generated positions remain practically far below either edge, so this does not block ordinary source compilation. Align or explicitly document the constructor/capture domain; do not turn the safe-integer edge into a source-size capacity claim. |
| `plan.instruction-address-domain` | Public instruction-plan control-flow/function addresses; prevents imprecise targets and references outside validated plan regions. | Representation invariant | Instruction boundaries are JavaScript safe integers within `0..instructions.length`; function IDs are positive safe integers where definitions are indexed. | [`src/plan/validation.ts`](../src/plan/validation.ts), [`src/plan/model.ts`](../src/plan/model.ts) | ADR 0015 owns validated versioned instruction plans; ADR 0019 governs classification. | `proven` | Range-validation tests cover malformed boundaries and function regions. This relational domain does not create a separate instruction-count capacity. |
| `plan.temporary-id-domain` | Public plan `temporaryCount`/temporary references and persisted runtime temporaries; prevents numeric precision mismatch between validated plans and checkpointed runtime state. | Representation invariant | Plan validation currently accepts any non-negative integer `temporaryCount` and integer temporary IDs `1..temporaryCount`; runtime snapshot temporaries require positive JavaScript safe-integer IDs. | [`src/plan/validation.ts`](../src/plan/validation.ts), [`src/runtime/state.ts`](../src/runtime/state.ts) | ADR 0015 requires one validated plan/runtime contract; the intended common temporary-ID numeric domain is unresolved under ADR 0019. | `suspicious` | Current Phase 2 evidence confirms a plan can validate with `temporaryCount > Number.MAX_SAFE_INTEGER`, while a runtime temporary with such an ID cannot validate. Ordinary compiler-generated IDs are far below the edge. Align the representation invariant or explicitly constrain the applicable plan field; do not invent a temporary-count capacity maximum. |
| `checkpoint.combined-capture` | Checkpoint serialization/restore; prevents hostile whole-envelope graph work but can make separately valid plan/snapshot data compete for one allowance. | Hostile-input capture budget | `createCheckpoint(...)` captures plan and snapshot separately; `serializeCheckpoint(...)` calls `restoreCheckpoint(...)`, and restore captures the complete `{ plan, snapshot }` envelope once under the shared `128` / `100_000` graph allowance. | [`src/runtime/checkpoint.ts`](../src/runtime/checkpoint.ts) | ADRs 0015 and 0019. Exact checkpoint-envelope capacity and any budget separation remain unresolved under #129. | `suspicious` | #131 proved the failure class on an older interaction baseline, and current Phase 2 reproduced it again through current public APIs: separately valid plan/snapshot data can pass creation but fail serialization under the combined capture. The measured fixture edge is evidence only, not a reusable capacity value. A repair must address the boundary composition or derive a justified relation rather than copy that fixture count. |
| `snapshot.detailed-validation-work` | Detailed snapshot consistency/liveness validation; bounds work after graph capture before runtime execution or restore. | Parser/compiler/runtime implementation guard | `MAX_DETAILED_VALIDATION_WORK = 1_000_000` operation-local detailed work units. | [`src/runtime/state.ts`](../src/runtime/state.ts) | ADRs 0015, 0016, 0019; current security contract in [`SECURITY.md`](SECURITY.md). Exact allowance/formula is not otherwise selected. | `provisional` | Exhaustion is deterministic through snapshot, runtime, and checkpoint boundaries. #131 demonstrated that detailed work can become the first downstream constraint on an older function-owned interaction shape; those old counts are not current capacities. Fresh structural evidence is needed before changing or claiming capacity. |
| `interaction.string-bytes` | Interaction definitions and completions; bounds validation, retained state, future transport/storage, and rendering exposure per string. | Provisional POC implementation guard | `MAX_INTERACTION_STRING_UTF8_BYTES = 65_536` UTF-8 bytes for each retained/submitted string. | [`src/interaction-limits.ts`](../src/interaction-limits.ts) | ADRs 0018 and 0019; [`RUNTIME.md`](RUNTIME.md) and [`SECURITY.md`](SECURITY.md) define current technical semantics. | `provisional` | Exact direct runtime boundaries are tested, but production Player/host transport/rendering/storage are not yet complete. This is not a TeaseScript source-string or UI recommendation. Keep the claim local until the applicable platform path exists. |
| `interaction.aggregate-bytes` | One interaction definition; bounds total retained UI/transcript-related text work and checkpoint payload growth. | Provisional POC implementation guard | `MAX_INTERACTION_AGGREGATE_UTF8_BYTES = 65_536` UTF-8 bytes across retained strings in one interaction definition. | [`src/interaction-limits.ts`](../src/interaction-limits.ts) | ADRs 0018 and 0019; current runtime/security docs. | `provisional` | Shares the same numeric value as the per-string guard for separate reasons. It also consumes shared graph-capture capacity through wrapper/option nodes. Prove required Player/transport/storage boundaries before any broader capacity claim. |
| `interaction.option-entries` | Choice interaction payload; bounds collection validation, rendering/transport exposure, snapshot/checkpoint size, and matching work. | Provisional POC implementation guard | `MAX_INTERACTION_OPTION_ENTRIES = 4_096` entries. | [`src/interaction-limits.ts`](../src/interaction-limits.ts) | ADRs 0018 and 0019. Source-level `choose` capacity is not selected by this runtime constant. | `provisional` | Current runtime tests cover the direct action boundary. #131 proved that historical dynamic lowering could expand enough to fail earlier downstream, so `4,096` must not be promoted to source capacity by circular constant tests. The author-facing compact-choice implementation owns worst-form verification for the lowering it actually adds. |
| `runtime.call-depth-default` | Fresh runtime configuration when the caller omits `maxCallDepth`; trades ordinary recursion capacity against snapshot/call-frame resource use. | Product default | `DEFAULT_MAX_CALL_DEPTH = 256` call frames. | [`src/runtime/state.ts`](../src/runtime/state.ts) | Current runtime contract documents the default; no accepted Owner policy selects `256` as a durable product default. ADR 0019 requires explicit Owner approval to change a product default. | `provisional` | Caller can override within the supported POC guard below. No workload/product rationale for exactly `256` is retained. Do not infer engine capacity from the default. |
| `runtime.call-depth-ceiling` | Fresh snapshot and restored snapshot `maxCallDepth`; bounds accepted call-frame configuration and recursive state growth. | Provisional POC implementation guard | `MAX_SUPPORTED_CALL_DEPTH = 4_096`; configured `maxCallDepth` must be integer `1..4_096`. | [`src/runtime/state.ts`](../src/runtime/state.ts) | ADRs 0015 and 0019; no accepted source claims that every worst-form 4,096-frame state fits capture/detailed/checkpoint budgets. | `provisional` | Coupled to shared graph capture and detailed snapshot validation. Measure representative worst-form frames before treating `4,096` as engine capacity or narrowing the accepted configuration. |
| `runtime.instruction-quantum` | `run(...)` / `stepToEvent(...)` invocation work; prevents one call from executing indefinitely. | Execution quantum | Caller-supplied positive integer `instructionBudget`; no explicit upper bound. Exhaustion produces deterministic `TSR037` on that runtime operation/snapshot. | [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADR 0015 requires a configurable instruction-budget failure; ADR 0019 keeps this separate from a lifetime runaway policy. | `suspicious` | Small-budget failure semantics are tested, but the public option accepts integers above `Number.MAX_SAFE_INTEGER` while the executed-instruction counter is an incremented JavaScript `number`. Beyond the safe-integer range that counter cannot reliably advance by one, so the boundedness claim does not hold for the complete accepted option domain. Later repair should bound the option to a representable counter domain or change the counter representation; narrowing accepted input needs the ADR 0019 compatibility/Owner path. |
| `runtime.instruction-quantum-default` | Omitted runtime instruction budget; selects ordinary per-call work before `TSR037`. | Product default | `10_000` instructions per `run(...)` / `stepToEvent(...)` invocation when omitted. | [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADR 0015 requires a configurable budget but does not select `10_000`; ADR 0019 governs default changes. | `provisional` | Exact default lacks workload/product evidence. Changing the default is an Owner product-default decision; changing the quantum mechanism or its relation to permanent failure may require an ADR. |
| `runtime.session-time-domain` | Persisted session time and timed-action deadlines; prevents non-finite/unsupported magnitude and deadline overflow. | Representation invariant | `0 <= currentSessionTimeMs <= Number.MAX_SAFE_INTEGER`; timed work additionally requires a finite non-negative duration and a deadline within that range. | [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/engine.ts`](../src/runtime/engine.ts), [`src/runtime/operations/observe-time.ts`](../src/runtime/operations/observe-time.ts) | ADR 0016 requires validated persisted session time and rejection of non-finite/overflowing deadlines; current snapshot format owns the exact representation. | `proven` | This is a numeric representation/overflow invariant, not a maximum tease duration policy. Required tests cover boundary time/deadline behavior and immutable rejection. |
| `runtime.identity-space` | Persisted runtime IDs and event sequences; prevents precision loss, identity reuse, and partially emitted atomic action transitions. | Representation invariant | Positive/non-negative JavaScript safe integers as appropriate; advancing a counter that cannot remain `<= Number.MAX_SAFE_INTEGER` is rejected before allocation/event mutation. | [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/operations/support.ts`](../src/runtime/operations/support.ts), [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADR 0016 explicitly requires monotonic persisted safe-integer action IDs; ADR 0015 requires sequenced persisted runtime state. | `proven` | This is representation correctness, not a practical session-work target. Atomic operations reserve enough event-sequence capacity before mutation. |
| `runtime.last-settlement-retention` | Duplicate/stale completion replay state; prevents unbounded settlement history while retaining deterministic immediate retry. | Representation invariant | `lastSettlement` is `null` or exactly one latest bounded settlement record; a newer settlement replaces the older record. | [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/operations/support.ts`](../src/runtime/operations/support.ts) | ADR 0016 explicitly selects one bounded canonical settlement record; current [`RUNTIME.md`](RUNTIME.md) defines the implemented replay semantics. | `proven` | Checkpoint/restore and duplicate/stale-action tests cover the single-record invariant. Retained interaction strings remain subject to interaction byte guards and snapshot graph/detailed-validation budgets. |

## Playground development boundary

The playground is a local development tool, not the public production backend.
Its limits therefore prove only that tooling boundary and do not define
TeaseScript engine capacity.

| ID | Boundary and concrete risk | Primary category | Current value / formula / mechanism | Canonical source | Governing authority / unresolved decision | Evidence status | Couplings, evidence, and next action |
|---|---|---|---|---|---|---|---|
| `playground.source-bytes` | Browser/file/workspace source ingestion; bounds parser/compiler work and accidental local-tool uploads. | Transport, storage, or tooling guard | `MAX_WORKSPACE_SOURCE_BYTES = 64 * 1024 = 65_536` UTF-8 bytes. | [`playground/workspace/controller.ts`](../playground/workspace/controller.ts) | Current [`SECURITY.md`](SECURITY.md); no engine/source-capacity authority. | `provisional` | Exact byte boundary and rejection are tested and practical for the dev tool, but `65_536` is not derived as a language maximum. Keep separate from interaction string limits despite numeric equality. |
| `playground.request-bytes` | Loopback workspace HTTP request buffering; bounds request memory/work before source handling. | Transport, storage, or tooling guard | `MAX_WORKSPACE_REQUEST_BYTES = MAX_WORKSPACE_SOURCE_BYTES + 1_024 = 66_560` bytes. | [`playground/server.ts`](../playground/server.ts) | Current [`SECURITY.md`](SECURITY.md). | `provisional` | Formula is coupled intentionally to source size plus fixed request headroom. It is development transport only; revise with the workspace protocol if the payload shape changes. |
| `playground.instruction-quantum` | Browser workspace run/step; keeps a local execution request bounded. | Execution quantum | `MAX_WORKSPACE_INSTRUCTION_BUDGET = 10_000` instructions passed explicitly to runtime run/step. | [`playground/workspace/controller.ts`](../playground/workspace/controller.ts) | Playground development contract plus ADR 0015 runtime semantics. | `provisional` | Numerically equals the runtime default but is a separate explicit tooling choice. It is not a lifetime ceiling and does not justify coupling future product execution policy to the playground. |

## Obsolete Phase 2A findings

The following #131 findings are no longer present as current production
mechanisms. They are retained here only to close the historical inventory loop
and prevent old numbers from being reused as current authority.

| ID | Historical mechanism | Last observed value | Classification | Current evidence / disposition |
|---|---|---:|---|---|
| `obsolete.compat-execute-budget` | Legacy compatibility `execute(...)` wrapper instruction budget | `100_000` instructions | `obsolete` | No compatibility interpreter/`execute` route remains in current `src/`; do not compare this number with the current runtime quantum. |
| `obsolete.library-metadata-limits` | Removed TypeScript export-metadata POC source, per-field, aggregate, and identity guards | `100_000` characters source; `16_384` per field; `100_000` aggregate; `256` identity characters | `obsolete` | The old metadata parser/catalog/facade are absent from current production source; [`LIBRARIES.md`](LIBRARIES.md) records that the temporary tooling POC was removed. Future linkage/editor metadata must select its own real boundaries. |
| `obsolete.pr128-interaction-cfg-budget` | PR #128 interaction-control-flow analysis coupled to `MAX_EXTERNAL_RUNTIME_DATA_WORK * 10` | `1_000_000` analysis steps | `obsolete` | The PR #128 implementation is not the current source-lowering contract and this budget is absent from current production code. Do not resurrect it to preserve historical dynamic-choice numbers. |

## Intentionally absent separate maxima

Phase 2 also confirmed several places where a new round limit would be the wrong
output:

- Core `compileSource(...)` has no general source-byte maximum. The current
  parser recursion guard and downstream structural/work guards remain separate;
  the playground's `65_536`-byte tooling ceiling is not promoted into the
  language.
- Instruction-plan instruction count and `temporaryCount` have no dedicated
  capacity constant. Their current practical acceptance is constrained by graph
  capture plus structural validation. The inconsistent plan/runtime temporary-ID
  representation domain is classified separately above; it is not a reason to
  invent an instruction/temporary maximum.
- Generic external-data capture has no separate scalar-string or property-key
  byte ceiling. Depth/work counters bound graph structure but not total text
  bytes; interaction payloads add their own string-byte guards. Current public
  runtime/checkpoint paths accept a 1 MiB serializable global string. This is a
  concrete missing resource dimension for later hostile-input analysis, not a
  reason to invent a repository-wide string maximum in this inventory.
- `deserializeCheckpoint(...)` has no raw JSON byte ceiling before `JSON.parse`.
  The parsed graph is subsequently bounded structurally, but not by a generic
  scalar-string/key byte budget. No public backend checkpoint upload or storage
  transport is implemented yet, so a raw checkpoint byte quota should be
  selected only with that real boundary and threat model.
- There is no universal session/lifetime instruction ceiling. The runtime has
  per-invocation instruction quanta; ADR 0019 requires a separate reason and
  Owner policy decision before a permanent runaway ceiling is introduced.
- There is no current production UI-warning threshold and no current TypeScript
  library-metadata capacity. Those categories remain unpopulated rather than
  receiving placeholder numbers.

## Current conclusions and routing

### `suspicious` entries

The main suspicious cluster is the reuse of the `128` / `100_000` hostile
capture values across direct AST, compiler-generated plan, runtime snapshot,
checkpoint, globals/completion, and serializable-value boundaries, plus the
split-create/combined-checkpoint capture asymmetry. Existing hardening shows the
shared capture guard is useful; the problem is treating one threat-model budget
as unrelated representation capacity.

Two representation-domain entries are separately `suspicious`: public source
positions are not constrained to the safe-integer domain required by direct-AST
capture, and plan `temporaryCount` may exceed the safe-integer ID domain required
by persisted runtime temporaries. Both are narrow consistency defects, not
capacity-limit proposals.

The runtime instruction quantum is also `suspicious` because its public
configuration accepts integers above the safe range of the JavaScript counter
used to prove that execution is bounded. This is a narrow option-domain defect,
not a reason to add a lifetime instruction ceiling.

No current interaction ceiling is classified `suspicious` merely because the
complete Player/source path is unfinished. The current `65_536` / `4_096`
ceilings are intentionally classified as provisional runtime POC guards. A
future source or platform capacity claim must earn stronger evidence rather than
changing that classification by assertion.

### Owner or governing decisions still needed

No replacement number or new Owner policy is required to merge this inventory.
Later work needs an explicit Owner decision when it would:

- change the `256` call-depth or `10_000` instruction-budget product default;
- narrow the currently accepted `instructionBudget` input domain as a repair,
  because that changes a public rejection/compatibility boundary;
- establish or change a permanent public source/platform capacity promise;
- introduce a permanent lifetime/session runaway ceiling;
- change a user-visible rejection/failure policy or make a compatibility
  tradeoff that ADR 0019 assigns to the Owner.

A new/material technical guard that does not trigger those approval cases still
has the ADR 0019 Owner-information duty. Changing capture/validation budget
architecture or accepted ADR semantics requires the applicable ADR work even
when no product number is being selected.

### Recommended repair/evidence clusters

1. **Capture and checkpoint boundary separation.** Current Phase 2 evidence
   confirms the split-create/combined-serialize failure class and that visited-
   value accounting does not bound scalar-string/property-key bytes. Measure the
   relevant structural and byte dimensions, then decide whether hostile external
   capture, direct AST, plan, snapshot, and whole-checkpoint envelopes need
   separate formulas/budgets. Prefer structural formulas or simpler
   representations over globally raising `100_000` or guessing one universal
   string ceiling.
2. **Detailed snapshot-validation evidence.** Measure current call/function/loop
   worst forms against the `1_000_000` detailed-work guard. Optimize or derive a
   structural allowance only when current evidence shows a meaningful conflict.
3. **Representation-domain consistency.** Align the exported source-position
   constructor with direct-AST capture, and separately decide whether plan
   temporary counts/IDs need one uniform safe-integer invariant. These are
   representation-hardening questions, not reasons to invent capacity maxima.
4. **Runtime configuration defaults/ceilings.** Treat call-depth and instruction
   defaults separately from hard safety/representation invariants. Gather real
   workload evidence before proposing policy changes.
5. **Instruction-quantum option-domain hardening.** Resolve the accepted range
   versus JavaScript counter mismatch without introducing a lifetime ceiling.
   Prefer the smallest repair that makes the per-invocation bound actually
   representable; follow the compatibility/Owner route if accepted inputs are
   narrowed.
6. **Interaction end-to-end evidence just in time.** The author-facing compact-
   choice implementation should verify the lowering it actually adds across
   static/dynamic and root/function forms before landing. Later Player/host work
   should add those real boundaries to the same evidence path. Do not create a
   parallel resource-audit implementation of the source lowering.

## Updating this registry

When a production limit is added, removed, materially changed, or gains better
evidence, update the smallest relevant row in this file in the same PR. Keep the
actual constant/formula near its owning implementation boundary. Do not create a
runtime registry, generated schema, global `limits.ts`, or one issue per
constant. Create a focused repair issue only when a concrete conflict, category
error, operational risk, or worthwhile simplification justifies independent
work.
