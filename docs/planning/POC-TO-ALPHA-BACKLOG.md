# POC-to-alpha backlog

**Status:** Canonical selected backlog

**Scope:** Work explicitly selected as required before a stated POC, pre-alpha, or alpha gate

**Scheduling:** This file does not schedule implementation

## Purpose

This backlog answers a narrower question than `WISHES.xml` or other proposal documents:

> Which open outcomes has the owner selected as required before a stated development gate?

Inclusion here means the outcome must be addressed before its target gate. It does not mean the item belongs to the current phase, and it does not accept a proposed syntax, API, architecture, or implementation.

The planning flow is:

```text
WISHES.xml or proposal material
    -> explicit owner selection
POC-TO-ALPHA-BACKLOG.md
    -> explicit coordinator scheduling
phase plan / issue
    -> implementation and verification
PHASE-STATUS.md
```

## Governance

- Agents may propose entries, but only the owner or designated coordinator may select an item as required, change its target gate, or schedule it for implementation.
- A backlog item is not implementation scope unless a current phase plan, coordinator assignment, or issue explicitly selects its ID.
- Ideas that still need product triage remain in `WISHES.xml` or another proposal document.
- Accepted architecture and language semantics belong in ADRs and specifications, not in this backlog.
- When an item is implemented and verified, record the result in `PHASE-STATUS.md` and remove it from this open backlog. Git history preserves the completed entry.

## Fields

### Tracks

- **Engine core:** parser, compiler, deterministic runtime, state, checkpoints, language semantics, and core libraries.
- **Player runtime:** Standard UI, package UI, media, choices, input, timers, and other behavior that runs inside the player environment before or after final iframe embedding.
- **Host shell:** the website-side owner of the cross-origin player iframe, sandbox, lifecycle, navigation, and host messaging.
- **Platform backend:** Laravel/PostgreSQL accounts, packages, publishing, persistence, scheduling, moderation, and services.
- **Authoring tools:** editor, simulator, debugger, validation, previews, and package tooling.
- **Cross-boundary:** contracts that necessarily span two or more tracks.

### Planning state

- **Design required:** the required outcome is selected, but its contract is not yet ready for implementation planning.
- **Ready for phase:** the contract is sufficiently decided to schedule in a future phase.

### Scheduling

- **Unscheduled:** required before the target gate but not assigned to a current phase.
- **Scheduled: `<phase/workstream>`:** explicitly selected by the owner or coordinator for that named phase/workstream.

## Open selected items

### POC-PLAYER-001 — Define the custom-view contract

- **Track:** Player runtime
- **Target gate:** Before alpha
- **Planning state:** Design required
- **Scheduling:** Unscheduled

#### Required outcome

Define the smallest coherent custom-view contract for package-provided UI inside the player runtime, including:

- registration and ownership of package TypeScript views;
- blocking views that return a serializable result;
- background views that return a runtime handle;
- typed input, events, results, update, close, cancel, failure, and cleanup behavior;
- deterministic lifecycle and reconstruction after save/resume;
- which view state is canonical runtime state versus reconstructible UI state;
- the boundary between Standard UI and package UI;
- DOM and CSS isolation policy, including when optional Shadow DOM is used and how it interacts with package styling, Standard UI, focus, accessibility, previewing, and debugging;
- focus, keyboard, overlay, navigation, and back behavior inside the player runtime;
- editor, simulator, debugger, and preview requirements;
- comparison of a TypeScript-only API, a small TeaseScript invocation API, and a fuller declarative TeaseScript syntax.

#### Boundaries

- This item concerns logical views inside the player runtime. It does not imply browser pop-ups or a nested iframe per view.
- The cross-origin host-shell protocol is a separate concern. Any custom-view capability that truly requires host support must be proposed and selected as a separate Host shell or Cross-boundary backlog item.
- Do not accept final TeaseScript syntax or an implementation API through this backlog entry. The result requires owner approval and the appropriate ADR/specification updates.

#### Dependencies and references

- [ADR 0012 — Custom-view capability](../decisions/0012-custom-view-capability.md)
- [ADR 0015 — Serializable runtime architecture](../decisions/0015-serializable-runtime-architecture.md)
- [`docs/RUNTIME.md`](../RUNTIME.md)
- [`docs/LIBRARIES.md`](../LIBRARIES.md)
- [`docs/SECURITY.md`](../SECURITY.md)
- [`docs/CODE-EDITOR.md`](../CODE-EDITOR.md)
- [`docs/OPEN-DECISIONS.md`](../OPEN-DECISIONS.md), section **Player and interactions**

#### Completion of the design item

This item may move to **Ready for phase** only after the owner approves a coherent lifecycle/state/security contract and the relevant ADRs and current topic documents are updated. Implementation is a later, explicitly scheduled phase.

### POC-HOST-001 — Define the cross-origin player host contract

- **Track:** Host shell
- **Target gate:** Before alpha
- **Planning state:** Design required
- **Scheduling:** Unscheduled

#### Required outcome

Define the smallest coherent contract between the website host shell and the cross-origin player iframe, including:

- iframe creation, startup, shutdown, and fatal lifecycle;
- sandbox flags and Content Security Policy;
- validated communication between parent and player, using typed or otherwise strictly validated messages;
- capability negotiation;
- transfer of only selected and validated package, session, and account data;
- checkpoint transport and acknowledgement or error responses for checkpoint storage;
- restore and reconnect behavior;
- resize and fullscreen behavior;
- browser navigation and back behavior;
- protocol errors and fatal player errors;
- clear responsibility boundaries between the Host shell, Player runtime, Standard UI, and package custom UI inside the player.

#### Boundaries

- The Host shell creates and owns the cross-origin player iframe and communicates with the player only through the validated boundary.
- The Player runtime contains Standard UI and package custom UI. A custom view does not normally communicate directly with the parent website; only functionality that genuinely requires a host capability may pass through the future player-host contract.
- Do not accept a final `postMessage` schema, protocol version, concrete TypeScript interfaces, capability names, host APIs, reconnect algorithms, sandbox details, or CSP details through this backlog entry.
- Do not introduce architecture outside the already accepted player/host boundary. The result requires owner approval and the appropriate ADR/current-document updates.

#### Dependencies and references

- [ADR 0012 — Custom-view capability](../decisions/0012-custom-view-capability.md)
- [ADR 0015 — Serializable runtime architecture](../decisions/0015-serializable-runtime-architecture.md)
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`docs/RUNTIME.md`](../RUNTIME.md)
- [`docs/SECURITY.md`](../SECURITY.md)
- [`docs/OPEN-DECISIONS.md`](../OPEN-DECISIONS.md), section **Player and interactions**

#### Completion of the design item

This item may move to **Ready for phase** only after the owner approves a coherent lifecycle, validation, capability, recovery, and responsibility contract and the relevant ADRs and current topic documents are updated. Implementation is a later, explicitly scheduled phase.

### POC-ENGINE-001 — Establish runtime performance criteria and a benchmark baseline

- **Track:** Engine core
- **Target gate:** Before alpha
- **Planning state:** Design required
- **Scheduling:** Unscheduled

#### Required outcome

Create a measured performance baseline and production optimization plan for the deterministic instruction runtime, including:

- representative small, normal, and stress workloads;
- execution throughput and latency between externally visible events;
- runtime-state and checkpoint-size measurements;
- long-running runtime-managed identity growth, including repeated scoped speaker creation and equivalent identity-producing workloads;
- clone, validation, and serialization costs as runtime-managed identities accumulate;
- a reachability and lifetime analysis before proposing reclamation or garbage-collection behavior;
- acceptable limits for loops, recursion, temporaries, scopes, identities, and large values;
- the cost of current snapshot cloning and defensive validation;
- run-until-event batching and clone-avoidance options;
- checkpoint cadence and incremental persistence boundaries;
- precomputed temporary-liveness metadata;
- possible copy-on-write optimization for ordinary values while preserving accepted copy semantics.

#### Boundaries

- JSON-safe state at every instruction boundary does not mean serializing or persisting after every instruction.
- Do not optimize by weakening deterministic source order, checkpoint validation, value-copy behavior, restore equivalence, or runtime identity correctness.
- Do not assume that a scoped speaker can be deleted at scope exit; references may remain reachable from runtime values or state.
- Do not select reclamation, garbage collection, or another optimization merely because it appears plausible. Measure the current runtime first and document the lifetime, maintenance, and correctness trade-offs.

#### Dependencies and references

- [ADR 0014 — Core runtime value semantics](../decisions/0014-core-runtime-value-semantics.md)
- [ADR 0015 — Serializable runtime architecture](../decisions/0015-serializable-runtime-architecture.md)
- [`CURRENT-DESIGN.md`](../../CURRENT-DESIGN.md), section **Runtime execution and performance boundary**
- [`docs/RUNTIME.md`](../RUNTIME.md)
- [`docs/TESTING.md`](../TESTING.md), section **Coverage and performance boundaries**
- [`docs/OPEN-DECISIONS.md`](../OPEN-DECISIONS.md), section **Runtime hardening and evolution**

#### Completion of the design item

This item may move to **Ready for phase** after benchmark workloads, measurement commands, acceptance thresholds, and a prioritized optimization plan are owner-approved. Individual optimizations must then be scheduled explicitly.

### POC-PLAYER-002 — Complete pending-action state-machine coverage

- **Track:** Player runtime
- **Target gate:** Before alpha
- **Planning state:** Design required
- **Scheduling:** Unscheduled

#### Required outcome

Complete deterministic state-transition coverage for the remaining pre-alpha pending-action surface as its action kinds
and host delivery paths are implemented. Existing blocking-`wait` and generic foreground-interaction coverage remains
current evidence in `docs/TESTING.md` and is not reopened by this item.

The remaining coverage must include, where applicable:

- action-specific cancellation, timeout, late-response, and wrong-type behavior;
- checkpoint and restore across foreground and background actions;
- restore around timeout processing;
- duplicate host delivery and active, settled, stale, and unknown action identities;
- event and action IDs not being reused after restore;
- deterministic fake-time operation with no real waiting.

#### Boundaries

- ADR 0016 owns the shared pending-action runtime contract; this item does not redefine it.
- `docs/TESTING.md` owns the shared state-machine matrix and current wait/interaction evidence.
- Remaining action-specific contracts and the host-delivery schema require their normal accepted-decision routes.
- Add tests with the feature that makes each path supported; do not create speculative APIs, a duplicate model, or a
  second test framework through this backlog item.

#### Dependencies and references

- [ADR 0016 — Resumable pending-action runtime contract](../decisions/0016-resumable-pending-action-runtime-contract.md)
- [`docs/RUNTIME.md`](../RUNTIME.md), section **Remaining runtime work**
- [`docs/OPEN-DECISIONS.md`](../OPEN-DECISIONS.md), section **Player and interactions**
- [`docs/TESTING.md`](../TESTING.md), section **Interactive runtime state-machine testing**

### POC-HOST-002 — Add cross-origin player browser E2E coverage

- **Track:** Cross-boundary
- **Target gate:** Before alpha
- **Planning state:** Design required
- **Scheduling:** Unscheduled

#### Required outcome

Add real-browser coverage for the implemented cross-origin host/player boundary, including:

- iframe sandboxing and Content Security Policy;
- typed or otherwise strictly validated messaging;
- startup, reload, reconnect, shutdown, and fatal failure;
- checkpoint save and restore;
- Standard UI and package custom UI;
- focus, keyboard, fullscreen, and navigation behavior;
- hostile and malformed host/player messages.

#### Boundaries

- Do not select a browser framework until a concrete host shell and cross-origin player exist.
- Do not define the host/player protocol, sandbox flags, CSP, or UI lifecycle through this testing item.

#### Dependencies and references

- `POC-HOST-001`;
- an implemented host shell and cross-origin player;
- an explicitly selected browser-test framework;
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`docs/SECURITY.md`](../SECURITY.md)
- [`docs/TESTING.md`](../TESTING.md), section **Browser E2E gate**
