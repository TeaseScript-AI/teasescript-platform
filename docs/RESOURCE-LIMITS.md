# Resource-limit registry

This is the canonical repository registry for current resource-limit classification and evidence routing under
[ADR 0019](decisions/0019-resource-limit-governance.md). Source code owns implemented values and formulas; accepted ADRs
and topic specifications own policy. Each entry records the current boundary, reason, category, evidence, coupling, and
decision route.

## Scope

The registry covers current hard bounds for source processing, caller-controlled data, engine/runtime work and state,
checkpoint handling, interaction payloads, and the local playground boundary. Test and CI tooling keep their own limits
in their owning tooling contracts.

A provisional guard may remain provisional while it protects a concrete current risk. Evidence requirements scale with
the claim: a local guard needs evidence for its local behavior, while a deliberate official capacity claim requires the
broader ADR 0019 evidence for every applicable supported layer and resource dimension.

Issue #131 supplies raw coupling evidence. Current Phase 2 probes refresh the findings that still apply to current
`main`; measured first-failure points remain diagnostic evidence.

### Change routing

- Material production-limit changes carry ADR 0019's Owner-information duty.
- Product-default, official-capacity, absolute-ceiling, and public rejection-policy changes use the explicit Owner route.
- Capture/validation-budget architecture and accepted cross-component coupling changes use the ADR route.
- Serialized-domain changes include the applicable format-version, migration, and compatibility review.
- Exact-edge and worst-form evidence is added when the entry's deliberate claim requires it.

### Primary evidence anchors

- [`tests/parser-nesting-boundaries.test.ts`](../tests/parser-nesting-boundaries.test.ts) and
  [`tests/parser-nesting-limit.test.ts`](../tests/parser-nesting-limit.test.ts): parser recursion.
- [`tests/external-runtime-data-limits.test.ts`](../tests/external-runtime-data-limits.test.ts) and
  [`tests/stable-external-data.test.ts`](../tests/stable-external-data.test.ts): graph capture and checkpoint mappings.
- [`tests/instruction-plan-range-validation.test.ts`](../tests/instruction-plan-range-validation.test.ts) and
  [`tests/runtime-snapshot-invariants.test.ts`](../tests/runtime-snapshot-invariants.test.ts): plan/runtime numeric domains.
- [`tests/functions-checkpoint.test.ts`](../tests/functions-checkpoint.test.ts): call-frame and detailed snapshot work.
- [`tests/foreground-interactions-runtime.test.ts`](../tests/foreground-interactions-runtime.test.ts),
  [`tests/foreground-interactions-handoff-runtime.test.ts`](../tests/foreground-interactions-handoff-runtime.test.ts), and
  [`tests/pending-action-hardening.test.ts`](../tests/pending-action-hardening.test.ts): interaction/time/counter boundaries.
- [`tests/playground-workspace.test.ts`](../tests/playground-workspace.test.ts),
  [`tests/playground-server.test.ts`](../tests/playground-server.test.ts), and
  [`tests/playground-browser-workspace.test.ts`](../tests/playground-browser-workspace.test.ts): local workspace boundary.

## Engine and runtime

| ID | Boundary / reason | Category | Current value / mechanism | Canonical source | Authority / status | Coupling, evidence, and next action |
|---|---|---|---|---|---|---|
| `parser.nesting` | Recursive source parsing; bounds native-stack exposure and preserves structured parser failure. | Parser/compiler/runtime implementation guard | `MAX_PARSER_NESTING_DEPTH = 64` recursive syntax entries. | [`src/parser.ts`](../src/parser.ts) | ADR 0019; issue #101. `provisional` | Exact-edge and deep-form tests establish current guard behavior. Refresh the rationale when parser recursion structure or this guard changes. |
| `capture.depth` | Stable capture of caller-controlled graphs; bounds recursive hostile-data traversal before detailed validation and cloning. | Hostile-input capture budget | `MAX_EXTERNAL_RUNTIME_DATA_DEPTH = 128`, root depth `0`. | [`src/external-data-limits.ts`](../src/external-data-limits.ts), [`src/ast-validation.ts`](../src/ast-validation.ts) | ADR 0019; [`SECURITY.md`](SECURITY.md). `suspicious` | The same value governs generic external data and separate direct-AST capture, then influences plan, snapshot, checkpoint, globals, completion, and serializable-value paths. Later work should justify or separate semantically distinct uses when evidence supports a concrete benefit. |
| `capture.work` | Stable capture of caller-controlled graphs; bounds graph traversal, hostile arrays/keys, and pre-validation allocation/work. | Hostile-input capture budget | `MAX_EXTERNAL_RUNTIME_DATA_WORK = 100_000` visited values; sparse declared array length and key enumeration consume the same allowance. | [`src/external-data-limits.ts`](../src/external-data-limits.ts), [`src/ast-validation.ts`](../src/ast-validation.ts), [`src/plan/capture-support.ts`](../src/plan/capture-support.ts) | ADR 0019; [`SECURITY.md`](SECURITY.md). `suspicious` | Current source compilation and checkpoint probes confirm category spillover across structurally different boundaries. Graph work counts structure; scalar-string and property-key byte accounting is a separate resource dimension. Repair analysis should measure the real structural and byte risks per boundary. |
| `capture.array-index-domain` | Captured JavaScript arrays; preserves precise indexes and agreement with validated array length under hostile/proxy input. | Representation invariant | Captured indexes are safe integers `< 0xffff_ffff` and below validated `length`; direct AST capture applies the equivalent dense-index relationship. | [`src/external-data-limits.ts`](../src/external-data-limits.ts), [`src/ast-validation.ts`](../src/ast-validation.ts) | JavaScript array representation; ADR 0019; issue #87. `proven` | Focused hardening tests cover proxy-index conflicts and sparse/inflated lengths. |
| `ast.source-position-domain` | Public source positions and direct-AST spans; keeps diagnostic coordinates precise and serializable. | Representation invariant | Direct-AST capture requires non-negative JavaScript safe integers; exported `createSourcePosition(...)` accepts non-negative integers. | [`src/ast-validation.ts`](../src/ast-validation.ts), [`src/source.ts`](../src/source.ts) | ADR 0019; intended common numeric domain unresolved. `suspicious` | The public constructor and direct-AST boundary accept different numeric domains. Align or explicitly define the shared representation invariant. |
| `plan.instruction-address-domain` | Public plan control-flow/function addresses; keeps targets precise and inside validated plan regions. | Representation invariant | Instruction boundaries are JavaScript safe integers within `0..instructions.length`; function IDs are positive safe integers where indexed. | [`src/plan/validation.ts`](../src/plan/validation.ts), [`src/plan/model.ts`](../src/plan/model.ts) | ADR 0015; ADR 0019. `proven` | Range-validation tests cover malformed boundaries and function regions. |
| `plan.temporary-id-domain` | Public plan temporaries and persisted runtime temporaries; keeps plan/runtime identity representation consistent. | Representation invariant | Plan `temporaryCount` accepts non-negative integers and references `1..temporaryCount`; runtime snapshot temporary IDs require positive JavaScript safe integers. | [`src/plan/validation.ts`](../src/plan/validation.ts), [`src/runtime/state.ts`](../src/runtime/state.ts) | ADR 0015; common domain unresolved under ADR 0019. `suspicious` | Current public-API evidence confirms the plan/runtime domains differ above the safe-integer boundary. Align the shared representation invariant. |
| `plan.loop-id-domain` | Public plan loop identities and persisted runtime loop frames; keeps validated plan identities representable in runtime state. | Representation invariant | Plan `loopStart`/`loopControl` require positive integer `loopId`; persisted loop frames require positive JavaScript safe integers. | [`src/plan/validation.ts`](../src/plan/validation.ts), [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADR 0015; common domain unresolved under ADR 0019. `suspicious` | Current public-API evidence confirms plan validation can accept a loop ID that later falls outside the snapshot domain. Align the plan/runtime loop-ID invariant. |
| `checkpoint.combined-capture` | Checkpoint serialization/restore; bounds hostile whole-envelope graph work while composing plan and snapshot data. | Hostile-input capture budget | `createCheckpoint(...)` captures plan and snapshot separately; serialization/restore captures the complete `{ plan, snapshot }` envelope under the shared `128` / `100_000` allowance. | [`src/runtime/checkpoint.ts`](../src/runtime/checkpoint.ts) | ADRs 0015 and 0019; composition policy unresolved under #129. `suspicious` | Current public-API evidence confirms separately valid components can exceed the shared allowance only after envelope composition. Repair analysis should address boundary composition or derive a justified relation from the real resource dimensions. |
| `snapshot.detailed-validation-work` | Detailed snapshot consistency/liveness validation; bounds post-capture validation work before execution or restore. | Parser/compiler/runtime implementation guard | `MAX_DETAILED_VALIDATION_WORK = 1_000_000` operation-local work units. | [`src/runtime/state.ts`](../src/runtime/state.ts) | ADRs 0015, 0016, 0019; [`SECURITY.md`](SECURITY.md). `provisional` | Deterministic exhaustion is covered across snapshot, runtime, and checkpoint boundaries. Additional structural evidence becomes useful when the guard, algorithm, or a supported workload conflict changes. |
| `interaction.string-bytes` | Interaction definitions/completions; bounds per-string validation and retained runtime state. | Provisional POC guard | `MAX_INTERACTION_STRING_UTF8_BYTES = 65_536` UTF-8 bytes per retained/submitted string. | [`src/interaction-limits.ts`](../src/interaction-limits.ts) | ADRs 0018 and 0019; runtime/security docs. `provisional` | Current direct runtime boundary tests cover the guard. Its scope is the generic runtime interaction payload boundary; later Player/host/transport/storage work supplies evidence for those boundaries when implemented. |
| `interaction.aggregate-bytes` | One interaction definition; bounds aggregate retained text work and checkpoint payload growth. | Provisional POC guard | `MAX_INTERACTION_AGGREGATE_UTF8_BYTES = 65_536` UTF-8 bytes across retained strings in one definition. | [`src/interaction-limits.ts`](../src/interaction-limits.ts) | ADRs 0018 and 0019; runtime/security docs. `provisional` | Shares the numeric value with the per-string guard while protecting a separate aggregate risk; wrapper/option structure also consumes graph-capture work. |
| `interaction.option-entries` | Generic choice interaction payload; bounds collection validation, retained state, matching work, and future rendering/transport exposure. | Provisional POC guard | `MAX_INTERACTION_OPTION_ENTRIES = 4_096` entries. | [`src/interaction-limits.ts`](../src/interaction-limits.ts) | ADRs 0018 and 0019. `provisional` | Scope: generic runtime-payload boundary. Current direct runtime tests cover that guard. Author-facing source lowering follows the actual downstream constraints of the implementation it selects. |
| `runtime.call-depth-default` | Omitted `maxCallDepth`; selects the normal POC recursion setting. | Product default | `DEFAULT_MAX_CALL_DEPTH = 256` call frames. | [`src/runtime/state.ts`](../src/runtime/state.ts) | Current runtime contract; ADR 0019. `provisional` | Callers may configure the supported POC range below. A product-default change follows the explicit Owner route. |
| `runtime.call-depth-ceiling` | Fresh/restored `maxCallDepth`; bounds configured call-frame growth. | Provisional POC guard | `MAX_SUPPORTED_CALL_DEPTH = 4_096`; accepted configuration `1..4_096`. | [`src/runtime/state.ts`](../src/runtime/state.ts) | ADRs 0015 and 0019. `provisional` | Shared graph capture and detailed snapshot validation also constrain concrete frame shapes. The guard remains local to this configuration boundary. |
| `runtime.instruction-quantum` | `run(...)` / `stepToEvent(...)` invocation work; bounds one execution call. | Execution quantum | Caller-supplied positive integer `instructionBudget`; exhaustion produces deterministic `TSR037`. | [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADR 0015; ADR 0019. `suspicious` | The accepted option domain extends beyond `Number.MAX_SAFE_INTEGER`, while the executed-instruction counter is an incremented JavaScript `number`. Repair options are a representable option domain or a different counter representation; a narrowed public domain follows the compatibility/Owner route. |
| `runtime.instruction-quantum-default` | Omitted instruction budget; selects ordinary per-call work before `TSR037`. | Product default | `10_000` instructions per `run(...)` / `stepToEvent(...)` invocation. | [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADR 0015; ADR 0019. `provisional` | A product-default change follows the explicit Owner route and should use workload evidence relevant to the intended runtime. |
| `runtime.session-time-domain` | Persisted session time and timed-action deadlines; preserves finite precise time/deadline arithmetic. | Representation invariant | `0 <= currentSessionTimeMs <= Number.MAX_SAFE_INTEGER`; timed work additionally requires finite non-negative duration and an in-range deadline. | [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/engine.ts`](../src/runtime/engine.ts), [`src/runtime/operations/observe-time.ts`](../src/runtime/operations/observe-time.ts) | ADR 0016; current snapshot representation. `proven` | Boundary tests cover time/deadline overflow and atomic rejection. |
| `runtime.identity-space` | Persisted runtime IDs and event sequences; preserves precise identity, monotonicity, and atomic transitions. | Representation invariant | Positive/non-negative JavaScript safe integers as appropriate; allocation/event advancement preflights remaining representable space. | [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/operations/support.ts`](../src/runtime/operations/support.ts), [`src/runtime/engine.ts`](../src/runtime/engine.ts) | ADRs 0015 and 0016. `proven` | Focused tests cover overflow rejection and atomic state/event behavior. |
| `runtime.last-settlement-retention` | Completion replay state; bounds retained settlement history while preserving deterministic immediate retry. | Representation invariant | `lastSettlement` is `null` or one latest bounded settlement record; a newer settlement replaces it. | [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/operations/support.ts`](../src/runtime/operations/support.ts) | ADR 0016; [`RUNTIME.md`](RUNTIME.md). `proven` | Checkpoint/restore and duplicate/stale-action tests cover the single-record invariant. Interaction byte and snapshot validation guards apply to retained content. |

## Playground development boundary

These entries describe the local development workspace boundary.

| ID | Boundary / reason | Category | Current value / mechanism | Canonical source | Authority / status | Coupling, evidence, and next action |
|---|---|---|---|---|---|---|
| `playground.source-bytes` | Browser/file/workspace source ingestion; bounds local parser/compiler work and upload buffering. | Transport/storage/tooling guard | `MAX_WORKSPACE_SOURCE_BYTES = 64 * 1024 = 65_536` UTF-8 bytes. | [`playground/workspace/controller.ts`](../playground/workspace/controller.ts) | [`SECURITY.md`](SECURITY.md); ADR 0019. `provisional` | Exact byte-boundary tests cover the local tool. Scope remains the playground workspace boundary. |
| `playground.request-bytes` | Loopback workspace HTTP request buffering; bounds request memory/work before source handling. | Transport/storage/tooling guard | `MAX_WORKSPACE_REQUEST_BYTES = MAX_WORKSPACE_SOURCE_BYTES + 1_024 = 66_560` bytes. | [`playground/server.ts`](../playground/server.ts) | [`SECURITY.md`](SECURITY.md); ADR 0019. `provisional` | The formula intentionally couples request capacity to workspace source bytes plus fixed protocol headroom. |
| `playground.instruction-quantum` | Browser workspace run/step; bounds one local execution request. | Execution quantum | `MAX_WORKSPACE_INSTRUCTION_BUDGET = 10_000` instructions passed explicitly to runtime run/step. | [`playground/workspace/controller.ts`](../playground/workspace/controller.ts) | Playground development contract; ADR 0015. `provisional` | This is an explicit local-tool choice with the same current number as the runtime default. |

## Current routing

### Suspicious clusters

1. **Capture and checkpoint accounting.** The shared `128` / `100_000` hostile-data values span direct AST, plan,
   snapshot, checkpoint, globals/completion, and serializable-value paths. Checkpoint creation and combined-envelope
   capture also compose those allowances differently. Current evidence supports focused analysis of the real structural
   and byte dimensions per boundary.
2. **Representation-domain consistency.** Public source positions, plan temporary IDs, and plan loop IDs each have a
   wider accepted numeric domain than the corresponding capture/runtime representation. These are narrow consistency
   defects suitable for one focused repair cluster.
3. **Instruction-quantum option domain.** The public `instructionBudget` domain extends beyond the precise counting range
   of the current JavaScript counter. A focused repair should make the accepted option domain and counter representation
   agree.

### Owner decision points

Owner approval becomes relevant when later work changes the `256` call-depth default, the `10_000` instruction-budget
default, narrows a previously accepted public input, establishes an official capacity policy, or changes a public
failure/compatibility policy. Other material technical guard changes retain ADR 0019's Owner-information duty.

### Recommended follow-up clusters

1. **Capture/checkpoint accounting:** measure structural and byte dimensions, then select the smallest boundary-specific
   repair justified by those measurements.
2. **Representation-domain consistency:** align source-position, temporary-ID, and loop-ID domains with their persisted
   representations.
3. **Instruction-quantum domain:** align the accepted per-invocation budget domain with a representable counter and use
   the compatibility/Owner route for any public-domain narrowing.

Provisional parser, detailed-validation, interaction, call-depth, runtime-default, and playground guards remain useful
current entries with their existing local rationale. Additional evidence is gathered when a guard changes, a supported
path exposes a concrete conflict, or a broader policy claim is proposed.

## Updating this registry

Update the smallest relevant entry when a production limit is added, removed, materially changed, or gains better
evidence. Keep each implemented constant/formula near its owning boundary and use focused repair work for concrete
conflicts, operational risk, or worthwhile simplification.
