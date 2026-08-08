# Resource-limit registry

This is the canonical repository inventory and repair router for current resource limits under
[ADR 0019](decisions/0019-resource-limit-governance.md). Source code owns implemented values; accepted ADRs and topic
specifications own policy. A number present in code is not a requirement merely because tests or documentation repeat it.

## Evidence rule

Retaining a production bound requires evidence for both the need for a bound at that boundary and the selected value,
formula, predicate, accepted domain, or mechanism. Exact-boundary tests prove current implementation behavior; they do
not justify the boundary they import. Historical, round, conservative, convenient, or cross-copied values are repair
inputs rather than capacity targets.

`provisional` is reserved for a deliberately selected boundary that already has a concrete evidence-based local
rationale while broader evidence or policy remains incomplete. No reviewed numeric POC guard in the tables below meets
that standard on the current evidence.

Rows marked **retention unsupported** record current code only so #129 can remove, replace, or re-derive them. Their
numbers must not become source-capacity goals, implementation targets, regression thresholds, or reasons to preserve
complexity. Issue #131 first-failure measurements likewise remain diagnostic evidence.

### Change routing

- Material production-limit changes carry ADR 0019's Owner-information duty.
- Product-default, official-capacity, absolute-ceiling, and public rejection-policy decisions use the explicit Owner route.
- Capture/validation-budget architecture and accepted cross-component coupling changes use the ADR route when the
  architecture or accepted contract changes.
- Serialized-domain changes include the applicable format-version, migration, and compatibility review.
- A repair that removes an unsupported implementation ceiling without creating a replacement capacity promise remains
  focused implementation work, with tests updated to the resulting justified behavior.

## Retained representation invariants

| ID | Boundary / invariant | Current mechanism | Evidence / authority |
|---|---|---|---|
| `capture.array-index-domain` | Captured arrays require precise own indexes consistent with validated JavaScript array length. | Safe integer indexes `< 0xffff_ffff` and below validated `length`; direct AST capture applies the equivalent dense-index relationship. | JavaScript array representation, ADR 0019, issue #87; hostile/proxy regressions. `proven` |
| `plan.instruction-address-domain` | Control-flow/function addresses must remain precise and inside validated plan regions. | Instruction boundaries are safe integers within `0..instructions.length`; indexed function IDs are positive safe integers. | ADRs 0015 and 0019; range-validation regressions. `proven` |
| `runtime.session-time-domain` | Persisted time/deadline arithmetic must remain finite and precise. | `currentSessionTimeMs` is a non-negative safe integer; timed work additionally requires an in-range deadline. | ADR 0016; overflow/atomicity regressions. `proven` |
| `runtime.identity-space` | Persisted IDs and event sequences must remain unique, monotonic, and precisely representable. | Positive/non-negative safe integers as applicable, with preflight before allocation/advancement would exceed the domain. | ADRs 0015 and 0016; overflow/atomicity regressions. `proven` |
| `runtime.last-settlement-retention` | Duplicate replay needs only the latest bounded settlement. | `lastSettlement` is `null` or one latest settlement record; a newer settlement replaces it. | ADR 0016 and [`RUNTIME.md`](RUNTIME.md); checkpoint/replay regressions. `proven` |

## Current numeric bounds with unsupported retention

The real failure mode in this table may justify some bounded mechanism. The reviewed history does not justify the
selected number itself. ADR 0019 status is therefore `suspicious`; **retention unsupported** is the #129 disposition,
not permission to preserve the current threshold.

| ID | Current code | Real concern / evidence | Why the selected value is unsupported | #129 disposition |
|---|---|---|---|---|
| `parser.nesting` | `MAX_PARSER_NESTING_DEPTH` | Recursive source parsing produced native stack overflow before issue #101/PR #107; structured `TSP027` is a real requirement. | Failing-before probes established vulnerable deep recursion, but no measured stack margin or structural invariant was found for the selected constant. Exact-edge tests mirror that constant. | Replace the hard-coded threshold with a justified measured/derived guard or remove the numeric ceiling by eliminating vulnerable recursion. |
| `capture.depth` | `MAX_EXTERNAL_RUNTIME_DATA_DEPTH` | Hostile deeply nested caller data produced native stack failure before issue #42/PR #52. | PR #52 describes the selected value as conservative/tunable and records no derivation from the observed failure or a platform constraint. | Re-derive the boundary from the actual capture implementation/risk or structurally remove the need for an arbitrary depth threshold. |
| `capture.work` | `MAX_EXTERNAL_RUNTIME_DATA_WORK` | Hostile wide graphs need bounded pre-validation work/allocation. | PR #52 describes the selected value as conservative/tunable; no measurement, safety margin, external constraint, or structural formula was found. The same constant is also reused across semantically different inputs. | Define the real structural/byte work dimensions and derive boundary-specific protection; remove the shared round constant where it has no justified role. |
| `snapshot.detailed-validation-work` | `MAX_DETAILED_VALIDATION_WORK` | Issue #89/PR #92 established multiplicative detailed-validation work and repaired several algorithms. | PR #92 retained the existing constant but did not derive it from the remaining algorithm, workload, memory bound, or safety margin. Exhaustion tests only prove enforcement. | Re-derive a bound from the remaining work model or remove it if the repaired algorithm can be bounded structurally without an arbitrary ceiling. |
| `interaction.string-bytes` | `MAX_INTERACTION_STRING_UTF8_BYTES` | Interaction data consumes validation, retained-state, checkpoint, and later platform resources. | PR #117 selected the value by matching an unrelated playground boundary rather than evidence for the runtime interaction boundary. | Remove the generic numeric ceiling unless a concrete runtime risk requires one; otherwise derive a boundary-specific value from that risk. |
| `interaction.aggregate-bytes` | `MAX_INTERACTION_AGGREGATE_UTF8_BYTES` | Aggregate retained interaction text has resource cost distinct from one string. | PR #117 copied another boundary's value despite the separate aggregate risk and supplied no independent derivation. | Remove or independently derive the aggregate mechanism from the resource it actually protects. |
| `interaction.option-entries` | `MAX_INTERACTION_OPTION_ENTRIES` | Large option collections consume validation, retained state, matching, and future presentation resources. | PR #117 chose a conservative round value relative to an unrelated graph-work guard. Existing exact tests use cheap static/empty-string shapes and do not justify the count. | Remove the generic option-count ceiling. Add a count bound only if a concrete boundary later demonstrates and justifies one. |
| `runtime.call-depth-default` | `DEFAULT_MAX_CALL_DEPTH` | Omitted `maxCallDepth` currently selects a value stored in snapshots. | PR #5 introduced the default without workload evidence or an accepted product-default decision. | Remove the unsupported default contract or obtain an explicit product decision backed by relevant workload evidence. |
| `runtime.call-depth-ceiling` | `MAX_SUPPORTED_CALL_DEPTH` | Call frames consume serializable runtime/checkpoint resources. | PR #5 introduced the ceiling without a reproduced failure, representation formula, downstream capacity derivation, or policy rationale. Runtime calls are explicit serializable frames rather than native JS recursion. | Remove the ceiling unless a real runtime/state boundary requires one; then derive it from that boundary. |
| `runtime.instruction-quantum-default` | default `instructionBudget` | A single `run(...)` / `stepToEvent(...)` invocation needs deliberate work/failure semantics. | The runtime was introduced with a hard-coded default; no workload, scheduler, latency, safety-margin, or product rationale for that value was found. | Resolve the intended per-invocation semantics, then derive or explicitly decide any default that remains. |

### Local playground values

These are development-tool implementation values, not engine/product capacity. They remain listed because they currently
reject input and can otherwise be mistaken for TeaseScript requirements.

| ID | Current code | Evidence result | #129 disposition |
|---|---|---|---|
| `playground.source-bytes` | `MAX_WORKSPACE_SOURCE_BYTES` | PR #86 states the bound but supplies no measurement or external constraint selecting its value. **Retention unsupported.** | Remove or derive from the actual local-tool buffering/compiler requirement. |
| `playground.request-bytes` | `MAX_WORKSPACE_REQUEST_BYTES` | Request buffering is a real boundary, but its fixed headroom has no documented protocol derivation. **Retention unsupported.** | Derive the request bound from the request shapes the local API actually accepts. |
| `playground.instruction-quantum` | `MAX_WORKSPACE_INSTRUCTION_BUDGET` | PR #86 reused the runtime value; no independent responsiveness/workload evidence selects it. **Retention unsupported.** | Remove the coupling or derive a local-tool value from measured/accepted workspace behavior. |

## Structural and domain defects with concrete evidence

| ID | Evidence | Repair direction |
|---|---|---|
| `ast.source-position-domain` | Direct-AST capture requires non-negative safe integers while exported `createSourcePosition(...)` accepts the wider non-negative integer domain. | Align or explicitly define the shared representation invariant. `suspicious` |
| `plan.temporary-id-domain` | Plan temporary counts/references accept a wider integer domain than persisted runtime temporary IDs. | Align the plan/runtime representation invariant. `suspicious` |
| `plan.loop-id-domain` | Plan loop IDs accept a wider integer domain than persisted loop frames. | Align the plan/runtime representation invariant. `suspicious` |
| `checkpoint.combined-capture` | Checkpoint creation captures plan/snapshot separately while serialization/restore recaptures the combined envelope through the shared unsupported capture budgets. Separately valid components can therefore fail only after composition. | Repair composition together with the capture-budget redesign; do not derive checkpoint capacity from the historical capture constants. `suspicious` |
| `runtime.instruction-quantum` | Caller-supplied positive integer `instructionBudget` accepts values beyond `Number.MAX_SAFE_INTEGER`, while the executed-instruction counter is a JavaScript `number`; exhaustion currently produces terminal `TSR037`. | Make the accepted domain/counter precise and resolve the intended yield/failure semantics without preserving the historical default as a target. `suspicious` |

## #111 and ADR 0018

The current option-count constant is not a source capacity, implementation target, end-to-end maximum, or ADR 0018
acceptance threshold. #111 follows its accepted interaction contract and actual downstream constraints. If realistic
supported interaction work exposes an unsupported historical guard, #129 repairs that guard or representation rather
than optimizing source lowering to reach the historical number.

## Current repair clusters

1. **Unsupported guard values with real failure modes:** parser recursion, hostile-data capture, and detailed snapshot
   validation. Preserve the demonstrated safety property while replacing arbitrary values with structural or evidenced
   mechanisms.
2. **Unsupported capacity/default constants:** interaction counts/bytes, call-depth default/ceiling, runtime instruction
   default, and playground constants. Remove them unless concrete evidence or explicit product/tooling policy justifies a
   replacement.
3. **Representation/domain consistency:** source positions, temporary IDs, loop IDs, and instruction-budget counter
   representation.
4. **Capture/checkpoint composition:** repair the shared accounting model together with the capture-bound redesign.

Owner decisions are needed only where a repair deliberately creates or retains product policy: a product default,
official supported capacity, absolute ceiling, public rejection/compatibility policy, or equivalent accepted tradeoff.

## Updating this registry

Keep implemented values in source near their owning boundary. Update this registry when evidence changes the disposition
or a focused repair lands. A new or retained numeric production bound must record the derivation, measurement plus safety
rationale, external constraint, representation invariant, or accepted policy that selects it; tests then verify that
justified boundary rather than supplying the justification themselves.
