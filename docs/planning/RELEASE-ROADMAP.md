# Release roadmap

This roadmap keeps future product work visible without turning every worthwhile idea into a GitHub issue. It records
owner-selected release-stage placement and compact progress history; it does not schedule implementation or replace the
accepted sources that define architecture, syntax, behavior, or current implementation state.

Release stages describe the maturity target for the product work selected for that stage. Individual subsystems may
mature earlier or later, and a stage does not require every planned product surface to exist.

## How to use this roadmap

- The Owner or designated coordinator selects roadmap placement. Agents may propose entries or moves.
- A section is the current target stage, not a permanent deadline. Move an item earlier or later when evidence,
  priorities, dependencies, or measured constraints justify it.
- Keep entries short. Put detailed design, acceptance criteria, and implementation plans in their canonical documents
  only when they are needed.
- A roadmap item does not need a GitHub issue. Create an issue when the work becomes concrete enough for near-term
  execution.
- Roadmap placement does not by itself accept architecture, syntax, compatibility, product behavior, or an
  implementation approach.
- A checked item may remain as compact roadmap progress history. Current implementation state stays in
  `PHASE-STATUS.md`, current topic documents, and code; accepted contracts stay in their ADRs or specifications.

### Item format

Use only the optional fields that add useful information. `Outcome` is the normal minimum.

```markdown
- [ ] **Short title**
  - **Outcome:** One or two sentences describing what should become true.
  - **Trigger:** Optional condition or evidence that should cause this item to be reconsidered, moved, or started.
  - **Reference:** Optional link to an existing planning document, decision, wish, or issue when that context is useful.
```

`[ ]` means the roadmap outcome is still open; `[x]` means that outcome is complete. Do not repeat the stage inside an
item because its section already supplies it.

## POC / Foundation

**Goal:** Prove the core technical foundations: TeaseScript, compilation, deterministic execution, save/resume,
Player/runtime boundaries, and the development tooling needed to exercise them.

**Expectation:** The system may still be developer-oriented and incomplete. Internal APIs, formats, tooling, and
architecture may change substantially while correctness and the basic model are being proven.

- [ ] **Complete pending-action state-machine coverage**
  - **Outcome:** As each remaining pending-action kind and host-delivery path becomes supported, complete deterministic
    transition coverage for cancellation, timeout, late and wrong-type responses, checkpoint/restore across foreground
    and background actions and around timeout processing, duplicate delivery, active/settled/stale/unknown identities,
    non-reuse of event/action IDs after restore, and fake-time operation without real waiting. Preserve ADR 0016 as the
    shared runtime contract and add action-specific tests with the feature that makes each path real rather than creating
    speculative APIs, a duplicate state model, or another test framework. Action-specific contracts and the host-delivery
    schema still follow their normal accepted-decision routes; existing blocking-`wait` and generic foreground-interaction
    evidence remains current rather than being reopened.
  - **Reference:** [ADR 0016](../decisions/0016-resumable-pending-action-runtime-contract.md),
    [`RUNTIME.md`](../RUNTIME.md), [`TESTING.md`](../TESTING.md), and
    [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

## Alpha

**Goal:** Turn the proven foundation into a coherent usable product slice that can be exercised meaningfully, especially
the scripting, editor/tooling, and Player experience selected for alpha.

**Expectation:** Selected core flows should work together well enough for sustained testing. A complete production
website, community platform, or every planned product feature is not required. Rough UX, missing secondary capabilities,
and breaking changes remain acceptable.

- [ ] **Define the cross-origin player host contract**
  - **Outcome:** Define the smallest coherent contract between the website host shell and its cross-origin Player iframe:
    iframe creation and lifecycle, sandbox/CSP, strictly validated parent/player messages, capability negotiation,
    transfer of only selected validated package/session/account data, checkpoint storage acknowledgement and failure,
    restore/reconnect, resize/fullscreen, navigation/back behavior, protocol/fatal errors, and responsibility boundaries.
    The host continues to own the iframe while Standard UI and package UI stay inside the Player; package custom views do
    not normally talk directly to the parent. The roadmap does not select a final message schema/version, TypeScript API,
    capability names, reconnect algorithm, sandbox flags, or CSP details. The design is complete only after the Owner
    approves the lifecycle, validation, capability, recovery, and responsibility contract and the relevant ADRs/current
    documents are updated.
  - **Reference:** [ADR 0012](../decisions/0012-custom-view-capability.md),
    [ADR 0015](../decisions/0015-serializable-runtime-architecture.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md),
    [`RUNTIME.md`](../RUNTIME.md), [`SECURITY.md`](../SECURITY.md), and
    [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

- [ ] **Add cross-origin player browser E2E coverage**
  - **Outcome:** Once the concrete host shell and cross-origin Player exist, add real-browser coverage for sandbox/CSP,
    validated messaging, startup/reload/reconnect/shutdown/fatal failure, checkpoint save/restore, Standard UI,
    focus/keyboard/fullscreen/navigation behavior, and hostile or malformed messages. Select a browser-test framework
    only when the real browser surface and maintenance cost can be evaluated; testing must verify rather than define the
    host protocol, sandbox, CSP, or UI lifecycle.
  - **Reference:** **Define the cross-origin player host contract**, [`ARCHITECTURE.md`](../ARCHITECTURE.md),
    [`SECURITY.md`](../SECURITY.md), and [`TESTING.md`](../TESTING.md).

## Beta

**Goal:** Exercise the selected product scope under realistic usage and integrate the additional product surfaces needed
for broader testing and eventual release.

**Expectation:** Shift emphasis from proving concepts to reliability, usability, performance, security, browser
behavior, persistence, operational behavior, and integration. Major redesign becomes less desirable, but different
subsystems may still have different maturity levels.

- [ ] **Define the custom-view contract**
  - **Outcome:** Define the smallest coherent package custom-view contract inside the Player runtime: registration and
    ownership of package TypeScript views; blocking views with serializable results; background views with runtime
    handles; typed input/events/results plus update, close, cancellation, failure, cleanup, and deterministic save/resume
    reconstruction; the split between canonical runtime state and reconstructible UI state; and the Standard UI/package
    UI boundary. Resolve DOM/CSS isolation and optional Shadow DOM, including interaction with package styling and
    Standard UI; focus/keyboard/overlay/navigation/back behavior; accessibility; preview/editor/simulator/debugger needs;
    and compare the viable TypeScript-only, small TeaseScript invocation, and fuller declarative TeaseScript API shapes.
    These are logical views inside the Player, not browser pop-ups or an iframe per view; any genuine host capability is a
    separate host-boundary decision. When custom views become supported, extend the cross-origin browser E2E matrix to
    package custom UI. The design is complete only after the Owner approves a coherent lifecycle/state/security contract
    and the relevant ADRs/current documents are updated; roadmap placement does not accept final syntax or implementation
    APIs.
  - **Reference:** [ADR 0012](../decisions/0012-custom-view-capability.md),
    [ADR 0015](../decisions/0015-serializable-runtime-architecture.md), [`RUNTIME.md`](../RUNTIME.md),
    [`LIBRARIES.md`](../LIBRARIES.md), [`SECURITY.md`](../SECURITY.md), [`CODE-EDITOR.md`](../CODE-EDITOR.md), and
    [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

- [ ] **Establish a runtime performance baseline and optimization plan**
  - **Outcome:** Measure representative small, normal, stress, and long-running deterministic-runtime workloads before
    selecting production optimizations. Cover throughput and latency between externally visible events, runtime/checkpoint
    size, runtime-managed identity growth (including repeated scoped speakers), clone/validation/serialization cost,
    reachability and lifetime before reclamation or garbage collection, and any justified limits for loops, recursion,
    temporaries, scopes, identities, and large values under ADR 0019. Also evaluate snapshot-clone/defensive-validation
    cost, run-until-event batching and clone avoidance, checkpoint cadence and incremental persistence, precomputed
    temporary-liveness metadata, and copy-on-write options that preserve accepted copy semantics. Before treating this
    outcome as complete, obtain Owner approval for representative workloads, reproducible measurement commands,
    acceptance thresholds, and a prioritized optimization plan; schedule individual optimizations separately. JSON-safe
    state at instruction boundaries does not require persistence after every instruction, and no optimization may weaken
    deterministic source order, checkpoint validation, value-copy behavior, restore equivalence, or runtime identity
    correctness; do not assume scoped identities can be reclaimed at scope exit.
  - **Reference:** [ADR 0014](../decisions/0014-core-runtime-value-semantics.md),
    [ADR 0015](../decisions/0015-serializable-runtime-architecture.md),
    [ADR 0019](../decisions/0019-resource-limit-governance.md), [`CURRENT-DESIGN.md`](../../CURRENT-DESIGN.md),
    [`RUNTIME.md`](../RUNTIME.md), [`TESTING.md`](../TESTING.md), and [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

## Release Candidate

**Goal:** Validate a specific candidate containing the scope selected for the first stable release.

**Expectation:** The intended 1.0 scope is effectively frozen. Work is dominated by blockers, regressions,
compatibility or migration problems, documentation gaps, and release verification rather than new features.

## 1.0 / Stable Release

**Goal:** Release the selected first stable product scope for normal supported use.

**Expectation:** The included functionality has deliberate compatibility, persistence, security, upgrade,
documentation, and operational expectations. `1.0` does not mean every desirable TeaseScript Platform feature has been
implemented.

## Future / Post-1.0

**Goal:** Preserve valuable capabilities, optimizations, and product directions that do not need to block `1.0`.

**Expectation:** No implementation commitment. Move work earlier when evidence or product priorities justify it.

- [ ] **Evaluate worker and parallel execution opportunities**
  - **Outcome:** Measure whether worker-based runtime isolation, parallel file/module parsing or AST work where dependency
    boundaries permit, or worker-based compilation for responsive editor feedback provides a useful benefit over the
    simpler single-threaded design. Account for worker startup, messaging/serialization overhead, browser concurrency,
    dependency ordering, determinism, cancellation, debugging, responsiveness, and maintenance cost before selecting any
    topology; do not preselect one-worker-per-file, logical-core counts, or a worker pool.
  - **Trigger:** Move this earlier if realistic Beta workloads show a material UI-responsiveness, compilation-latency, or
    runtime-throughput problem that workers could plausibly address.
