# Resource-limit registry

This is the canonical inventory and repair router required by
[ADR 0019](decisions/0019-resource-limit-governance.md). Code is canonical for current enforcement; accepted ADRs and
current topic specifications are canonical for policy. Recording a current value here does **not** justify retaining it.
Every numeric row marked `suspicious` below is **retention unsupported**: remove or re-derive it unless ADR 0019 evidence
later justifies both the need for the bound and its selected boundary.

## Conventions

The tables combine ADR 0019 fields where the answer is shared. **Source / boundary** is the canonical implementation
source and rejecting operation. **Current** is the enforced unit, predicate, domain, or formula. **Category** is exactly one ADR 0019 primary taxonomy
category and **Status** is exactly one ADR 0019 evidence status. **Authority / change** gives the governing source and special route: `Owner
default` means changing or removing a product default needs explicit Owner approval; `Version review` means serialized
or compatibility consequences must be checked; `ADR` is needed only when accepted architecture/coupling changes.
**Evidence / repair** gives the concrete risk, evidence source, important coupling, and focused repair/test route.

For `suspicious` numeric rows, no documented safety margin selects the current value. There is no official capacity claim,
so cheapest-baseline, worst/Pareto-form, and `max - 1` / `max` / `max + 1` cases are **not applicable as capacity proof of
the current value**; existing cases and #131 first-failure measurements are diagnostic evidence only. A retained or
replacement exact bound must add its own derivation, safety rationale, applicable worst-form evidence, and boundary tests.
Checkpoint/JSON/restore/resume coverage applies when affected state is resumable; otherwise it is not applicable.
For qualitative representation invariants, numeric safety margins and ordered max-edge tests are not applicable; tests
verify the predicate/domain itself.

## Diagnostic parser-stack evidence

On 2026-08-09 UTC, revision `830a49346052b353a849b2e716ecaddd2ff0d4f8` was measured on Linux `7.0.14-4-pve`
x86_64, AMD Ryzen 7 5825U, 8 GiB RAM, with no relevant Node flags. Fresh Node 24.18.0 / V8 13.6.233.17-node.50
child processes parsed valid source; each form passed at depth 96 before exponential search, binary narrowing, and
boundary rechecks found:

| Form | Passing / first failing depth | Failure |
|---|---:|---|
| parentheses | 537 / 538 | `SE` |
| `not` chain | 4,280 / 4,281 | `RE` (`#parseUnaryArithmetic`) |
| unary `-` chain | 4,276 / 4,277 | `SE` |
| lists / sets | 501 / 502 | `SE` |
| objects | 525 / 526 | `SE` |
| template interpolation | 520 / 521 | `SE` |
| nested `if` blocks | 1,644 / 1,645 | `RE` (`#parseStatement`) |

`SE` is `SyntaxError: Invalid regular expression: /[.eE]/u: Stack overflow`, with `RegExp.test` then `#parsePrimary`;
`RE` is `RangeError: Maximum call stack size exceeded`. Node 26.5.0 / V8 14.6.202.34-node.24 reproduced both signatures
on the same host; thresholds matched except unary `-` passed/failed at 4,277 / 4,278, and the `not` failure frame was
`#parsePostfix`. Revision `e8e5f0554a08866d2f521f273d6899192a9e49ff` later removed nine no-op wrapper layers left by
the old nesting guard, so these exact depths are historical observations rather than measurements of the final parser.
They are retained only as evidence that host-stack failure varies materially by syntax and implementation shape; they are
not TeaseScript limits, supported capacity, CI thresholds, safety margins, or production-classifier inputs.

## Proven representation and state invariants

| ID | Source / boundary | Current | Category | Status | Authority / change | Evidence / repair |
|---|---|---|---|---|---|---|
| `capture.array-index-domain` | `src/external-data-limits.ts`, `src/ast-validation.ts`; stable array capture | Safe-integer length/indexes; indexes `< 0xffff_ffff` and `< length`; direct-AST arrays are dense own-index arrays. | representation invariant | `proven` | JS array representation + ADR 0019; version/ADR review only if representation changes | issue #87 plus hostile/proxy regressions establish the index/density relation. Separate from the work-coupled preflights below. |
| `plan.instruction-address-domain` | `src/plan/validation.ts`; plan validation | Safe-integer instruction boundaries within the plan; function targets must resolve to validated definitions. | representation invariant | `proven` | ADRs 0015/0019; Version review if serialized domain changes | Range-validation regressions; no independent instruction-count capacity claim. |
| `ast.source-position-domain` | `src/source.ts`, direct-AST and plan validation; source positions | Offset, line, and column are non-negative safe integers. | representation invariant | `proven` | ADR 0019 + [`RUNTIME.md`](RUNTIME.md); Version review if the serialized domain changes | Source-helper, direct-AST, plan, and runtime-snapshot regressions enforce one exact-integer domain; no source-capacity claim. |
| `plan.temporary-id-domain` | plan validation and persisted runtime temporaries | `temporaryCount` is a non-negative safe integer; temporary IDs are positive safe integers within that count. | representation invariant | `proven` | ADRs 0015/0019 + [`RUNTIME.md`](RUNTIME.md); Version review if the serialized domain changes | Plan-range and runtime-snapshot regressions align the plan and persisted temporary domains. |
| `plan.loop-id-domain` | plan validation and persisted loop frames | Loop IDs are positive safe integers. | representation invariant | `proven` | ADRs 0015/0019 + [`RUNTIME.md`](RUNTIME.md); Version review if the serialized domain changes | Plan-range, fresh-runtime, and checkpoint-restore regressions align the plan and persisted loop domains. |
| `runtime.session-time-domain` | `src/runtime/state.ts`, `src/runtime/actions/delay.ts`; persisted time/deadlines | Finite values in `0..Number.MAX_SAFE_INTEGER`; integer-valued persisted time uses that precise domain. | representation invariant | `proven` | ADR 0016; Version review if serialized domain changes | Overflow/atomicity/checkpoint regressions protect precise time arithmetic. |
| `runtime.rng-seed-state-domain` | `src/runtime/random.ts`, `src/runtime/state.ts`; fresh `seed` option and persisted RNG state | Non-zero unsigned 32-bit integer `1..0xffffffff`. | representation invariant | `proven` | ADR 0015 + [`RUNTIME.md`](RUNTIME.md); Version/compatibility review if algorithm or serialized domain changes | `FreshRuntimeOptions.seed` is caller-configurable; omitted seed uses `DEFAULT_PLAYGROUND_SEED = 0x6d2b79f5`. Creation and snapshot validation enforce the same non-zero uint32 domain, preserving deterministic `xorshift32-v1` state. |
| `runtime.identity-space` | runtime state/engine/support; persisted IDs and event sequences | Positive/non-negative safe integers as defined per field, with preflight before exhaustion. | representation invariant | `proven` | ADRs 0015/0016/0019; Version review if serialized domain changes | Overflow/atomicity regressions prevent ID/sequence reuse. |
| `runtime.last-settlement-retention` | `src/runtime/state.ts`; replay state | `lastSettlement` is `null` or one latest settlement; newer settlement replaces it. | representation invariant | `proven` | ADR 0016; Version review for persistence-shape changes | Checkpoint/restore and duplicate-replay regressions. |

## Current bounds with unsupported retention

These mechanisms remain enforced until focused #129 repairs land. Their values are inventory facts, not targets or
supported maxima.

| ID | Source / boundary | Current | Category | Status | Authority / change | Evidence / repair |
|---|---|---|---|---|---|---|
| `capture.depth` | external/direct-AST capture | `MAX_EXTERNAL_RUNTIME_DATA_DEPTH = 128`, root depth `0`. | hostile-input capture budget | `suspicious` | ADR 0019; ADR only if capture architecture changes; Owner notice for material change | PR #52 proved deep hostile-data risk but called the value conservative/tunable. A 2026-08-09 #288 removal probe passed representative depths through 2,048, but downstream serializable validation/cloning, snapshot/checkpoint cloning/freezing, and direct-AST semantic/lowering/freezing still recurse with accepted nesting while `capture.work` bounds visits rather than call-stack depth. A depth-protection mechanism therefore remains structurally necessary until those traversals become stack-independent; `128` itself remains retention unsupported and is not a measured capacity. |
| `capture.work` | external/direct-AST graph capture and dependent plan/snapshot/checkpoint/globals/completion capture | `MAX_EXTERNAL_RUNTIME_DATA_WORK = 100,000` visited values per capture. | hostile-input capture budget | `suspicious` | ADR 0019; ADR if threat-model/coupling architecture changes; Owner notice for material change | PR #52 proved bounded hostile work is needed, not `100,000`. A 2026-08-09 #288 Node 24 removal probe accepted broad shallow samples from about 100k through 1m values while capture, runtime, and direct-AST compile time/RSS scaled materially with caller-controlled graph size and no surviving cross-container aggregate cap. This confirms the aggregate mechanism is needed but does not justify `100,000`; selecting or deriving the value/policy remains an ADR 0019 Owner/evidence decision. |
| `capture.array-length-preflight` | external/direct-AST array capture | Array `length <= 100,000`; direct-AST arrays also require exactly `length + 1` own keys including `length`. | hostile-input capture budget | `suspicious` | ADR 0019; coupled to `capture.work` | Imports the graph-work number as allocation/shape preflight without independent derivation. Re-derive or structurally replace with capture redesign. |
| `capture.own-key-preflight` | own-key enumeration in external/direct-AST capture | External capture rejects more than `100,001` own keys; direct-AST plain objects reject more than `100,000`; direct-AST arrays use the density rule above. | hostile-input capture budget | `suspicious` | ADR 0019; coupled to `capture.work` | Inherited from shared work allowance, not derived as a key/allocation limit. Re-derive or structurally replace. |
| `snapshot.detailed-validation-work` | `src/runtime/state.ts`; detailed snapshot validation | `MAX_DETAILED_VALIDATION_WORK = 1,000,000` validation-work units. | parser, compiler, or runtime implementation guard | `suspicious` | ADR 0019; Owner notice for material change | issue #89/PR #92 repaired multiplicative algorithms but did not derive `1,000,000`. Re-derive from remaining work or replace structurally. |
| `interaction.string-bytes` | `src/interaction-limits.ts`, plan/runtime validation/completion | `MAX_INTERACTION_STRING_UTF8_BYTES = 65,536` UTF-8 bytes. | parser, compiler, or runtime implementation guard | `suspicious` | ADRs 0018/0019; Owner decision for deliberate public rejection-policy change, otherwise Owner notice | PR #117 copied an unrelated playground value. Remove unless a real boundary needs it; otherwise derive that boundary-specific value. |
| `interaction.aggregate-bytes` | same; one retained interaction definition | `MAX_INTERACTION_AGGREGATE_UTF8_BYTES = 65,536` UTF-8 bytes. | parser, compiler, or runtime implementation guard | `suspicious` | ADRs 0018/0019; same route as string guard | Separate aggregate risk, but no independent derivation. Remove or derive from the protected resource. |
| `interaction.option-entries` | same; choice collection | `MAX_INTERACTION_OPTION_ENTRIES = 4,096`. | parser, compiler, or runtime implementation guard | `suspicious` | ADRs 0018/0019; Owner decision only for intentional public capacity/rejection policy, otherwise Owner notice | PR #117 selected a round value relative to unrelated graph work. `4,096` is **not** source capacity, a #111 target, an end-to-end maximum, or ADR 0018 acceptance threshold. Remove unless a concrete boundary justifies a count bound. |
| `runtime.call-depth-default` | `src/runtime/state.ts`; omitted fresh-snapshot option | `DEFAULT_MAX_CALL_DEPTH = 256`, persisted as `snapshot.maxCallDepth`. | product default | `suspicious` | ADR 0019; **Owner default** + Version review | PR #5 supplied no workload evidence or accepted default decision. Owner decides changing/removing it; any retained/replacement default needs evidence. |
| `runtime.call-depth-ceiling` | runtime state/engine; configured/persisted call depth and function entry | `MAX_SUPPORTED_CALL_DEPTH = 4,096`; configured domain `1..4,096`; entry fails at `callFrames.length >= maxCallDepth`. | parser, compiler, or runtime implementation guard | `suspicious` | ADR 0019; Version review for accepted persisted-range change; Owner decision if made public capacity/rejection policy | PR #5 supplied no failure, state-size formula, downstream derivation, or policy rationale. Remove if no real state boundary needs it; otherwise derive it. |
| `runtime.instruction-budget-default` | `src/runtime/engine.ts`; omitted `run(...)` / `stepToEvent(...)` option | Default `10,000` runtime instructions per invocation. | product default | `suspicious` | ADR 0019 **Owner default** for changing/removing `10,000`; ADR 0015 still fixes exhaustion as `TSR037` | No workload/scheduler evidence selects `10,000`. Owner decides changing/removing the default; any retained/replacement default needs evidence. |
| `runtime.instruction-quantum` | `src/runtime/engine.ts`; configured `run(...)` / `stepToEvent(...)` work quantum | Caller accepts any positive JS integer; exhaustion terminates with structured `TSR037`. | execution quantum | `suspicious` | ADR 0015 fixes failure-on-exhaustion; ADR 0019; Owner review if accepted caller domain/rejection policy changes | The accepted domain extends beyond `Number.MAX_SAFE_INTEGER` while the executed-instruction counter is a JS number. Preserve `TSR037`; align domain/counter without treating the default as evidence. |
| `checkpoint.combined-capture` | `src/runtime/checkpoint.ts`; serialize/restore envelope | Create captures plan/snapshot separately; serialize/restore recaptures combined checkpoint under current `128` depth / `100,000` work guards. | hostile-input capture budget | `suspicious` | ADR 0019; repair with capture work; ADR if accepted checkpoint/capture architecture changes | #131 proves separately valid components can fail after composition. Repair the coupling; do not derive checkpoint capacity from historical capture values. |

## Local playground tooling bounds

These are development-tool behavior, not TeaseScript or engine capacity. `suspicious` values remain **retention unsupported**; a justified tooling-domain guard may use another ADR 0019 status without becoming broader capacity.

| ID | Source / boundary | Current | Category | Status | Authority / change | Evidence / repair |
|---|---|---|---|---|---|---|
| `playground.source-bytes` | workspace controller/browser/server; local source import | `MAX_WORKSPACE_SOURCE_BYTES = 64 * 1024 = 65,536` UTF-8 bytes. | transport, storage, or tooling guard | `suspicious` | ADR 0019; tooling implementation unless promoted to product policy | PR #86 gives no measurement/external constraint. Remove or derive from actual buffering/compiler needs. |
| `playground.request-bytes` | `playground/server.ts`; local request buffering | `MAX_WORKSPACE_REQUEST_BYTES = MAX_WORKSPACE_SOURCE_BYTES + 1,024 = 66,560` bytes. | transport, storage, or tooling guard | `suspicious` | ADR 0019; tooling implementation unless promoted to product policy | Buffering is real; `+1,024` has no protocol derivation. Derive from accepted request shapes or another concrete constraint. |
| `playground.port-domain` | `playground/server.ts`; configured local listener port | Integer `1..65,535` through option or `PORT`. | transport, storage, or tooling guard | `provisional` | Network port representation + ADR 0019; tooling compatibility review for configuration changes | The configured listener requires an explicit non-zero TCP port number; `65,535` is the protocol port maximum, while `0` requests OS ephemeral allocation rather than naming a port. The local rationale is concrete; focused boundary-test evidence remains incomplete. |
| `playground.instruction-quantum` | workspace controller; local run automation | `MAX_WORKSPACE_INSTRUCTION_BUDGET = 10,000` runtime instructions. | execution quantum | `suspicious` | ADR 0019; tooling implementation; ADR 0015 still governs runtime exhaustion | PR #86 reused the runtime number without local responsiveness/workload evidence. Decouple/remove or derive from accepted tooling behavior. |

## Updating this registry

Update this file when implementation or evidence changes an entry. Do not preserve an unsupported value to keep the table
stable. A retained or replacement production bound must satisfy ADR 0019 before tests can verify it; tests, historical
roundness, another boundary's number, and empirical first-failure points cannot provide that justification.
