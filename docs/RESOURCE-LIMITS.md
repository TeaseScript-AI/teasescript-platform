# Resource-limit registry

This is the canonical inventory and repair router required by
[ADR 0019](decisions/0019-resource-limit-governance.md). Code is canonical for current enforcement; accepted ADRs and
current topic specifications are canonical for policy. Recording a current value here does **not** make it an officially
supported capacity. Issue #288 removed, structurally repaired, or deliberately routed every formerly `suspicious`
entry. The #304 implementation removes generic capture depth/work, sparse-array preflight, and detailed-validation work
rejection; current POC policy does not treat those dimensions as rejection requirements without a concrete current
protected boundary. Remaining numeric policies below are separate decisions and are not justified by that removed
external-input capture model.

## Conventions

The tables combine ADR 0019 fields where the answer is shared. **Source / boundary** is the canonical implementation
source and rejecting operation. **Current** is the enforced unit, predicate, domain, or formula. **Category** is exactly one ADR 0019 primary taxonomy
category and **Status** is exactly one ADR 0019 evidence status. **Authority / change** gives the governing source and special route: `Owner
default` means changing or removing a product default needs explicit Owner approval; `Version review` means serialized
or compatibility consequences must be checked; `ADR` is needed only when accepted architecture/coupling changes.
**Evidence / repair** gives the concrete risk, evidence source, important coupling, and focused repair/test route.

No retained provisional POC value below is an official capacity claim. Its selected boundary is justified only for the
stated temporary policy and must not be generalized into a supported TeaseScript maximum. Cheapest-baseline,
worst/Pareto-form, and `max - 1` / `max` / `max + 1` cases verify implementation agreement where useful; they do not turn
that temporary policy into capacity evidence. Checkpoint/JSON/restore/resume coverage applies when affected state is
resumable; otherwise it is not applicable. For qualitative representation invariants, numeric safety margins and ordered
max-edge tests are not applicable; tests verify the predicate/domain itself.

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

## Non-rejecting scale diagnostics

Traversal work, observed depth, node or instruction counts, temporary counts, validation work, and serialized byte
sizes may be collected when they cheaply expose scaling or representation amplification. These measurements are
engineering diagnostics only: they do not make otherwise valid source or structurally valid plan/snapshot/checkpoint
data invalid. An observed JavaScript stack, allocation, array/index, or other host failure is an implementation or
representation constraint to diagnose and repair where practical, not a replacement TeaseScript maximum.

## Proven domains and state invariants

| ID | Source / boundary | Current | Category | Status | Authority / change | Evidence / repair |
|---|---|---|---|---|---|---|
| `capture.array-index-domain` | stable external/direct-AST array capture and validation | Safe-integer length/indexes; indexes `< 0xffff_ffff` and `< length`; direct-AST arrays are dense own-index arrays. | representation invariant | `proven` | JS array representation + ADR 0019; version/ADR review only if representation changes | issue #87 plus stable-capture and array-representation regressions establish the index/density relation. This is a representation predicate, not a capture-work policy. |
| `plan.instruction-address-domain` | `src/plan/validation.ts`; plan validation | Safe-integer instruction boundaries within the plan; function targets must resolve to validated definitions. | representation invariant | `proven` | ADRs 0015/0019; Version review if serialized domain changes | Range-validation regressions; no independent instruction-count capacity claim. |
| `ast.source-position-domain` | `src/source.ts`, direct-AST and plan validation; source positions | Offset, line, and column are non-negative safe integers. | representation invariant | `proven` | ADR 0019 + [`RUNTIME.md`](RUNTIME.md); Version review if the serialized domain changes | Source-helper, direct-AST, plan, and runtime-snapshot regressions enforce one exact-integer domain; no source-capacity claim. |
| `plan.temporary-id-domain` | plan validation and persisted runtime temporaries | `temporaryCount` is a non-negative safe integer; temporary IDs are positive safe integers within that count. | representation invariant | `proven` | ADRs 0015/0019 + [`RUNTIME.md`](RUNTIME.md); Version review if the serialized domain changes | Plan-range and runtime-snapshot regressions align the plan and persisted temporary domains. |
| `plan.loop-id-domain` | plan validation and persisted loop frames | Loop IDs are positive safe integers. | representation invariant | `proven` | ADRs 0015/0019 + [`RUNTIME.md`](RUNTIME.md); Version review if serialized domain changes | Plan-range, fresh-runtime, and checkpoint-restore regressions align the plan and persisted loop domains. |
| `runtime.session-time-domain` | `src/runtime/state.ts`, `src/runtime/actions/delay.ts`; persisted time/deadlines | Finite values in `0..Number.MAX_SAFE_INTEGER`; integer-valued persisted time uses that precise domain. | representation invariant | `proven` | ADR 0016; Version review if serialized domain changes | Overflow/atomicity/checkpoint regressions protect precise time arithmetic. |
| `runtime.rng-seed-state-domain` | `src/runtime/random.ts`, `src/runtime/state.ts`; fresh `seed` option and persisted RNG state | Non-zero unsigned 32-bit integer `1..0xffffffff`. | representation invariant | `proven` | ADR 0015 + [`RUNTIME.md`](RUNTIME.md); Version/compatibility review if algorithm or serialized domain changes | `FreshRuntimeOptions.seed` is caller-configurable; omitted seed uses `DEFAULT_PLAYGROUND_SEED = 0x6d2b79f5`. Creation and snapshot validation enforce the same non-zero uint32 domain, preserving deterministic `xorshift32-v1` state. |
| `runtime.identity-space` | runtime state/engine/support; persisted IDs and event sequences | Positive/non-negative safe integers as defined per field, with preflight before exhaustion. | representation invariant | `proven` | ADRs 0015/0016/0019; Version review if serialized domain changes | Overflow/atomicity regressions prevent ID/sequence reuse. |
| `runtime.last-settlement-retention` | `src/runtime/state.ts`; replay state | `lastSettlement` is `null` or one latest settlement; newer settlement replaces it. | representation invariant | `proven` | ADR 0016; Version review for persistence-shape changes | Checkpoint/restore and duplicate-replay regressions. |
| `runtime.instruction-quantum` | `src/runtime/engine.ts`; configured `run(...)` / `stepToEvent(...)` work quantum | Explicit budgets are positive safe integers `1..Number.MAX_SAFE_INTEGER`; omission uses the separate product default; exhaustion terminates with structured `TSR037`. | execution quantum | `proven` | ADRs 0015/0019; Owner approved the rejection-policy compatibility repair on 2026-08-09 | #288 proved that larger accepted JS integers can stop advancing the numeric execution counter. The positive-safe-integer domain is therefore a representation/correctness predicate rather than a capacity target. It is not serialized, so the repair requires no format-version change. |

## Retained POC policies and defaults

The remaining rows are separate POC policies/defaults with their own accepted or Owner-selected rationale. The Owner
chose on 2026-08-09 to retain their current numeric values through the POC while the product and representative
workloads are still changing. That compatibility-preservation rationale does **not** establish that a historical number
was technically derived, measured as safe capacity, or suitable as a permanent compatibility promise. The #304
reassessment does not make these remaining policies security requirements and does not re-decide them merely because
the generic external-input capture policy changed.

Every row in this table therefore remains `provisional` and must follow its own ADR 0019 change route. It must be
reassessed before its numeric value is carried forward as supported non-POC compatibility behavior, no later than the
Beta runtime-performance baseline, and earlier if representative valid workloads or new evidence show that the value
is inappropriate. Interaction-specific bounds, call-depth policy, and runtime instruction-budget policy are distinct
from the removed capture/traversal and detailed-validation acceptance counters.

| ID | Source / boundary | Current | Category | Status | Authority / change | Evidence / policy |
|---|---|---|---|---|---|---|
| `interaction.string-bytes` | `src/interaction-limits.ts`; completion/result/transcript retention | `MAX_INTERACTION_STRING_UTF8_BYTES = 65,536` UTF-8 bytes for completion/result/transcript strings. Authored/materialized UI fields have no independent per-field policy and instead preflight against remaining definition aggregate bytes. | parser, compiler, or runtime implementation guard | `provisional` | ADRs 0018/0019; Owner POC policy; Owner decision for later public rejection-policy change | #288 separated completion-retained bytes from definition bytes. PR #293 removes the independent authored-field policy while preserving this completion/result/transcript boundary. The Owner retained `65,536` only for POC rejection compatibility; equality with the definition aggregate is not a structural coupling. |
| `interaction.aggregate-bytes` | interaction plan/runtime definition validation; one retained interaction definition | `MAX_INTERACTION_AGGREGATE_UTF8_BYTES = 65,536` UTF-8 bytes across all retained definition strings; each field preflights against the remaining aggregate budget. | parser, compiler, or runtime implementation guard | `provisional` | ADRs 0018/0019; Owner POC policy; Owner decision for later public rejection-policy change | #288 proved aggregate definition bytes are independent of both single completion strings and option count. PR #293 makes this the sole byte-policy axis for authored/materialized UI definition strings. The Owner retained `65,536` only for POC rejection compatibility. |
| `interaction.option-entries` | interaction definition/materialization and completion matching | `MAX_INTERACTION_OPTION_ENTRIES = 4,096`. | parser, compiler, or runtime implementation guard | `provisional` | ADRs 0018/0019; Owner POC policy; Owner decision for later public rejection-policy change | #288 confirmed that many empty/short or numeric-label options keep byte totals small while validation, materialization, snapshot handling, and matching still grow with entry count. The mechanism remains necessary under the current materialized representation. The Owner retained `4,096` only for POC rejection compatibility. |
| `runtime.call-depth-default` | `src/runtime/state.ts`; omitted fresh-snapshot option | `DEFAULT_MAX_CALL_DEPTH = 256`, persisted as `snapshot.maxCallDepth`. | product default | `provisional` | ADR 0019; **Owner default**; Version review if persisted-domain handling changes | A finite omitted-option default is the simplest compatible KISS behavior for ordinary fresh runtimes; requiring every caller to configure it is possible but changes API ergonomics. The Owner retained `256` as the current POC product default because no evidence supports changing existing behavior. It remains reassessable and is not a capacity claim. |
| `runtime.call-depth-ceiling` | runtime state/engine; configured/persisted call depth and function entry | `MAX_SUPPORTED_CALL_DEPTH = 4,096`; configured domain `1..4,096`; entry fails at `callFrames.length >= maxCallDepth`. | parser, compiler, or runtime implementation guard | `provisional` | ADR 0019; Owner POC policy; Version/compatibility review for persisted accepted-range changes | #288 confirmed that TeaseScript calls use explicit retained frames, so an externally configured unlimited depth could grow retained frame/scope state before later validation. The per-instruction O(depth²) snapshot-copy artifact was removed, but that does not remove the need for an absolute configured domain. The Owner retained `4,096` to preserve current POC persisted/rejection compatibility; it must be reassessed before becoming a non-POC promise. |
| `runtime.instruction-budget-default` | `src/runtime/engine.ts`; omitted `run(...)` / `stepToEvent(...)` option | Default `10,000` runtime instructions per invocation. | product default | `provisional` | ADR 0019 **Owner default**; ADR 0015 fixes exhaustion as `TSR037` | A finite omitted-option budget is the simplest compatible KISS protection against unbounded loops/recursion. `TSR037` is terminal today, so changing this default changes which omitted-option runs fail rather than merely yielding more often. With no evidence for a better value, the Owner retained `10,000` as the current POC product default. It remains reassessable and is not a capacity claim. |

Generic external-data capture still measures visited values, processed descriptors, and maximum observed depth through
test-only instrumentation. Detailed snapshot validation similarly records its liveness work. These measurements support
scaling regressions and disposable profiling; they are not public telemetry, serialized state, or rejection policy.

## Local playground tooling bounds

These are development-tool behavior, not TeaseScript or engine capacity. PR #289 removed the unsupported local source,
request-body, and copied instruction-budget limits; playground execution now uses the runtime's omitted-option budget
behavior. The configured listener port remains the only current playground tooling bound in this registry.

| ID | Source / boundary | Current | Category | Status | Authority / change | Evidence / repair |
|---|---|---|---|---|---|---|
| `playground.port-domain` | `playground/server.ts`; configured local listener port | Integer `1..65,535` through option or `PORT`. | transport, storage, or tooling guard | `provisional` | Network port representation + ADR 0019; tooling compatibility review for configuration changes | The configured listener requires an explicit non-zero TCP port number; `65,535` is the protocol port maximum, while `0` requests OS ephemeral allocation rather than naming a port. The local rationale is concrete; focused boundary-test evidence remains incomplete. |

## Updating this registry

Update this file when implementation, evidence, or an Owner policy decision changes an entry. Historical roundness,
another boundary's number, and empirical first-failure points do not justify retention. When temporary compatibility is
the selected POC reason, record that policy and its mandatory reassessment trigger explicitly rather than presenting the
value as technically derived or permanent capacity. A resource rejection justified as security must also name a
concrete current protected boundary; self-only local misuse or shared-helper convenience is not sufficient.
