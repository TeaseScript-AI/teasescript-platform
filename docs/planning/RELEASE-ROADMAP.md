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

- [ ] **ADR 0018 Standard Library interactions and pacing**
  - **Outcome:** Implement the accepted ADR 0018 slice end to end: `showButton`, `askText`, `askNumber`, `choose`, and
    `say` pacing/skip behavior, together with the matching Standard Player controls and editor/simulator support. Keep the
    detailed runtime state-machine and checkpoint rules in their accepted runtime sources rather than repeating them here.
  - **Reference:** [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md), [`RUNTIME.md`](../RUNTIME.md),
    [`LIBRARIES.md`](../LIBRARIES.md), [`CODE-EDITOR.md`](../CODE-EDITOR.md), and [`DEBUGGER.md`](../DEBUGGER.md).

- [ ] **Foreground and background timers**
  - **Outcome:** Let scripts use foreground timers that block script progress and background timers that continue while
    other script work proceeds, with explicit lifecycle control and deterministic save/resume behavior. Keep exact handle,
    syntax, repetition, and presentation decisions in the timer planning and accepted runtime/library sources.
  - **Reference:** [`TIMER-AND-RECOVERY-FOLLOW-UPS.md`](TIMER-AND-RECOVERY-FOLLOW-UPS.md),
    [ADR 0016](../decisions/0016-resumable-pending-action-runtime-contract.md), [`RUNTIME.md`](../RUNTIME.md), and
    [`LIBRARIES.md`](../LIBRARIES.md).

- [ ] **Player UI**
  - **Outcome:** Replace the technical playground presentation with a practical Player interface for transcript output,
    Standard interactions, timers, status/errors, and the media capabilities selected for the POC. Keep development and
    debug controls secondary to the actual Player experience.
  - **Reference:** [`PRODUCT.md`](../PRODUCT.md), [`DEBUGGER.md`](../DEBUGGER.md),
    [`PLAYER-UI.md`](../ui/PLAYER-UI.md), and [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).

- [ ] **Iframe development host and virtual viewport**
  - **Outcome:** Run the Player through a small local host shell using the product's iframe boundary without requiring a
    Laravel site. Let the host set custom viewport dimensions plus useful phone, tablet, desktop, and 4K presets, scaling
    the preview to fit the available monitor while the Player lays itself out against the requested viewport; keep device
    simulation logic out of the Player itself.
  - **Reference:** [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`SECURITY.md`](../SECURITY.md), and
    [`WISHES.xml` W-041](../../WISHES.xml).

- [ ] **Browser editor and Player preview**
  - **Outcome:** Provide the browser authoring environment with editing, diagnostics, simulation/debugging, and a Player
    preview that can use the same iframe host and virtual viewport. Keep the editor and Player as separate components even
    when they are shown side by side.
  - **Reference:** [`CODE-EDITOR.md`](../CODE-EDITOR.md), [`DEBUGGER.md`](../DEBUGGER.md), and
    [`WISHES.xml` W-031](../../WISHES.xml).

- [ ] **Audio and video playback**
  - **Outcome:** Support real Player audio and video playback for the POC, including blocking/foreground and background
    use, simultaneous identified resources, and targeted lifecycle control. Keep exact media APIs and persistence details
    in the runtime/library design rather than defining them in the roadmap.
  - **Reference:** [`RUNTIME.md`](../RUNTIME.md), [`LIBRARIES.md`](../LIBRARIES.md), and
    [`WISHES.xml` W-044](../../WISHES.xml).

## Alpha

**Goal:** Turn the proven foundation into a coherent usable product slice that can be exercised meaningfully, especially
the scripting, editor/tooling, and Player experience selected for alpha.

**Expectation:** Selected core flows should work together well enough for sustained testing. A production
website, community platform, or every planned product feature is not required. Rough UX, missing secondary capabilities,
and breaking changes remain acceptable.

- [ ] **Cross-origin Player host contract**
  - **Outcome:** Define the smallest coherent production contract between the application host shell and its cross-origin
    Player iframe: iframe creation/lifecycle, sandbox/CSP, validated parent/Player messages, capability negotiation,
    selected package/session data and any later host-owned account data, checkpoint storage acknowledgement/failure,
    restore/reconnect, resize/fullscreen/navigation, protocol errors, and responsibility boundaries. When that concrete
    boundary exists, verify the contract in real browsers for the relevant startup, restore, input, navigation, and
    malformed-message paths;
    browser tests verify the contract rather than define it.
  - **Reference:** [ADR 0012](../decisions/0012-custom-view-capability.md),
    [ADR 0015](../decisions/0015-serializable-runtime-architecture.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md),
    [`RUNTIME.md`](../RUNTIME.md), [`SECURITY.md`](../SECURITY.md), [`TESTING.md`](../TESTING.md),
    [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md), and [`WISHES.xml` W-041](../../WISHES.xml).

## Beta

**Goal:** Exercise the selected product scope under realistic usage and integrate the additional product surfaces needed
for broader testing and eventual release.

**Expectation:** Shift emphasis from proving concepts to reliability, usability, performance, security, browser
behavior, persistence, operational behavior, and integration. Major redesign becomes less desirable, but different
subsystems may still have different maturity levels.

- [ ] **Complete the custom-view contract**
  - **Outcome:** ADR 0012 fixes blocking/background ownership, supported Player presentation forms, sandbox confinement,
    and recovery-frontier behavior. Complete registration, typed input/events/results, update/close/cancellation/failure,
    reconstructible-state declaration, surface isolation/optional Shadow DOM, focus/keyboard/navigation/back behavior,
    accessibility, preview/debug tooling, and the author-facing TypeScript/TeaseScript API. These are logical views inside
    the Player, not browser pop-ups or
    per-view iframes; genuine host capabilities remain a separate boundary. Add real-browser Player/host coverage when
    package custom UI is implemented.
  - **Reference:** [ADR 0012](../decisions/0012-custom-view-capability.md),
    [ADR 0015](../decisions/0015-serializable-runtime-architecture.md), [`RUNTIME.md`](../RUNTIME.md),
    [`LIBRARIES.md`](../LIBRARIES.md), [`SECURITY.md`](../SECURITY.md), [`CODE-EDITOR.md`](../CODE-EDITOR.md),
    [`DEBUGGER.md`](../DEBUGGER.md), [`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md), and
    [`WISHES.xml` W-042/W-055](../../WISHES.xml).

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

- [ ] **Evaluate editor usability warnings for interaction content**
  - **Outcome:** Use representative authoring, Player, accessibility, and usability evidence to decide whether non-blocking
    editor warnings are useful for unusually long interaction labels or unusually large choice sets. If warnings are
    adopted, define them as a separate usability policy rather than copying engine hard limits or treating provisional
    resource guards as recommendations. Do not invent placeholder thresholds merely to make the warning category finite.
  - **Trigger:** Reconsider after representative Alpha/Beta authoring and Player usage provides concrete evidence that
    technically valid interaction content creates a recurring usability or accessibility problem.
  - **Reference:** [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md),
    [ADR 0019](../decisions/0019-resource-limit-governance.md), [`CODE-EDITOR.md`](../CODE-EDITOR.md), and
    [`RESOURCE-LIMITS.md`](../RESOURCE-LIMITS.md).

- [ ] **Reassess retained #288 numeric resource policies and defaults**
  - **Outcome:** Before any remaining numeric policy or default deliberately retained by Issue #288 becomes supported
    non-POC compatibility behavior, reassess it using then-current workload, safety, performance, compatibility, and
    maintenance evidence. This applies to the separately retained interaction, call-depth, and instruction-budget
    policies, defaults, and ceilings. Generic capture/traversal and validation-work counters are not retained rejection
    policies; stack-independent traversal remains an engineering resilience/performance option when evidence warrants it,
    not a reason to recreate a generic `capture.depth` rejection policy. Do not preselect replacement values or treat
    retained POC values as permanent capacity promises.
  - **Trigger:** Reassess no later than the Beta runtime-performance baseline, and earlier if representative valid
    workloads hit a retained boundary or new performance/security evidence shows that a current policy is materially wrong.
  - **Reference:** Issues #288 and #304, PR #293, [ADR 0019](../decisions/0019-resource-limit-governance.md),
    `docs/RESOURCE-LIMITS.md`, and **Establish a runtime performance baseline and optimization plan**.

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
