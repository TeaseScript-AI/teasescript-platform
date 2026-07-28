# Concrete repository source-layout proposal

**Status:** Implemented behavior-neutral Option A baseline; retained as the source-layout record
**Issue:** #118  
**Recommended option:** A — focused seam extraction now  
**Scope:** Folder and module ownership only; no behavior, public API meaning, or serialized-format change

## Decision requested

Approve one near-term source-layout direction before ADR 0018 issues add substantially more code to the current hotspots.

This document recommends **Option A**: perform one focused behavior-neutral refactor after #110 is merged and before further ADR 0018 implementation is merged. It also records two practical alternatives so a review agent can compare cost and risk.

The proposal originally did not move production files. Its selected Option A
has now been applied by issue #124 from the then-current `main`; the concrete
implementation and compatibility inventory in `docs/ARCHITECTURE.md` are the
current ownership record. Deferred feature folders remain absent unless real
owning code exists.

## Problem being solved

The current layout was effective for the first vertical POC, but several files now own too many unrelated responsibilities:

- `src/instructions.ts` combines plan contracts, compiler lowering, capture, and validation;
- `src/runtime/engine.ts` combines execution, completion, time observation, evaluation, and mutation helpers;
- `src/runtime/state.ts` combines snapshot types, construction, cloning, capture, validation, and pending-action invariants;
- `src/libraries/` contains catalog/metadata tooling and a privileged-adapter placeholder rather than the Platform Standard Library;
- the actual Platform Standard Library has no unambiguous source location;
- Player and technical workspace/editor code are likely to grow into the same playground modules;
- #111–#115 will repeatedly touch these same areas.

The goal is not to maximize folder depth. The goal is to create a few stable responsibility seams before more independent work converges on the same files.

## Documentation review

No accepted document already defines a complete filesystem layout. The useful existing direction is logical:

| Source | Use in this proposal |
| --- | --- |
| ADR 0007 | Retain the `.tease` executable-content versus `.ts` reusable-library distinction. |
| ADRs 0015 and 0016 | Retain one compiler/runtime/checkpoint model; folders must not create separate runtimes. |
| ADR 0017 | Primary input for separating Platform Standard Library, library tooling, engine primitives, and privileged adapters. |
| ADR 0018 | Retain fully lowered interaction and pacing behavior; author-facing syntax does not place all implementation in the Standard Library folder. |
| `docs/LIBRARIES.md` | Confirms that the current catalog/metadata POC is tooling-only and should not be confused with the Platform Standard Library. |
| `docs/CODE-EDITOR.md` | Supports separating the technical workspace/editor surface from the immersive Player surface. |
| POC-to-alpha tracks | Useful responsibility names, but not mandatory npm packages or top-level folders. |
| Historical V30/V31 reviews and legacy backlog | Superseded or non-authoritative for repository structure. |
| Tease package folder/tag ideas | Concern package content, not repository source organization. |

Therefore this proposal maps current accepted boundaries to source ownership without importing an obsolete architecture.

# Option A — focused seam extraction now

**Recommendation: approve this option.**

It fixes the ambiguous library naming and the two most immediate conflict hotspots while keeping the repository as one TypeScript package. It deliberately does not reorganize every language file, test, or deployment component.

## Resulting near-term structure

```text
src/
  plan/
    model.ts
    capture.ts
    validation.ts

  compiler/
    compile-program.ts
    lowering/
      compiler.ts
      interactions.ts      # only when real #111 code uses a small context
      pacing.ts            # only when real #112 code uses a small context

  runtime/
    actions/
      model.ts
      delay.ts
      interaction.ts
      settlement.ts
      pacing.ts            # created by/for #112 when real code exists
    operations/
      complete-action.ts
      observe-time.ts
    state.ts               # retains whole-snapshot and cross-state invariants
    engine.ts              # remains the execution facade

  standard-library/
    public.ts              # created only when there is a real public surface
    prelude/
      interactions.ts      # defaults/declarations/metadata, not canonical state
      say.ts               # policy/default metadata, not a second scheduler

  library-tooling/
    catalog.ts
    metadata.ts
    public.ts

  platform-internal/
    privileged-platform-adapters.ts

  instructions.ts         # temporary compatibility facade
  index.ts                 # existing public compatibility facade

playground/
  player/                  # new #113 Player-facing code
  workspace/               # new #114 technical editor/simulator code
  shared/                  # only genuinely shared browser helpers
  ...existing compatibility entry/controller files
```

This is the selected near-term map, not a requirement to create empty files. A directory is created when the refactor moves real code into it or the owning ADR issue adds real code.

## Ownership rules

### Shared plan contract

`src/plan/` is a shared contract area, not a compiler subdirectory.

The compiler produces instruction plans. The runtime validates and consumes them. Neither side should conceptually import the other merely to access the persisted contract.

```text
src/plan/model.ts
    plan versions, instruction and expression-plan types,
    shared plan constants, and discriminated unions

src/plan/capture.ts
    capture of untrusted plan-shaped data into safe internal data

src/plan/validation.ts
    complete plan validation and structural invariants
```

The dependency direction is:

```text
language -> compiler -> plan contract <- runtime
```

`plan` must not import compiler lowering or runtime mutation code.

### Compiler ownership

The behavior-neutral migration gives the existing compiler implementation one exact first destination:

```text
src/compiler/compile-program.ts
    public compilation orchestration and compileProgram(...)

src/compiler/lowering/compiler.ts
    the existing cohesive stateful InstructionCompiler lowering pass
```

The migration must move the existing lowering implementation without broadly redesigning the compiler class.

`interactions.ts` and `pacing.ts` are added only when real #111/#112 code can use a small explicit lowering context without duplicating or fragmenting the existing compiler state. They are not empty shells and are not required to exist in the first behavior-neutral move.

### Pure action modules and canonical mutation

`src/runtime/actions/*` owns:

- serializable action and settlement models;
- action-specific construction and field validation;
- pure normalization, matching, and resolution helpers;
- typed action-specific completion or time-resolution results.

Action modules do **not**:

- mutate `RuntimeSnapshot`;
- allocate action or event sequence numbers;
- emit runtime events;
- move actions between foreground/background locations;
- write `lastSettlement`;
- advance instruction continuations;
- execute prepared output.

Canonical atomic mutations belong in:

```text
src/runtime/operations/complete-action.ts
src/runtime/operations/observe-time.ts
```

Those operations coordinate active lookup, snapshot mutation, event allocation/emission, settlement replay, status transitions, and continuation eligibility.

Whole-snapshot validation and cross-state invariants remain in `src/runtime/state.ts` during this first refactor. This prevents action modules from becoming distributed state machines or circular owners of canonical state.

## Exact changes in the behavior-neutral implementation PR

### 1. Clarify library and trust-boundary naming

Move the existing catalog/metadata implementation:

```text
src/libraries/catalog.ts
    -> src/library-tooling/catalog.ts

src/libraries/metadata.ts
    -> src/library-tooling/metadata.ts

src/libraries/public.ts
    -> src/library-tooling/public.ts
```

Move every other current file whose only responsibility is catalog, metadata extraction, validation, or tooling support into `src/library-tooling/` while preserving cohesive relative grouping.

Move the privileged adapter placeholder:

```text
src/libraries/internal/privileged-platform-adapters.ts
    -> src/platform-internal/privileged-platform-adapters.ts
```

Rules:

- `library-tooling` remains absent from the runtime root export;
- `platform-internal` is never re-exported through public Standard Library or package-library surfaces;
- no actual Standard Library implementation is invented merely to populate `standard-library/`;
- repository-owned production imports and tests move to the canonical paths.

### 2. Extract the shared plan and compiler seams

Move plan contracts, capture, and validation from `src/instructions.ts` into `src/plan/`.

Move `compileProgram(...)` orchestration into `src/compiler/compile-program.ts` and the current cohesive `InstructionCompiler` lowering implementation into `src/compiler/lowering/compiler.ts`.

Do not split every lowering case into a separate module. Add interaction- or pacing-specific lowering modules only when real feature code can use a clear explicit context.

`src/instructions.ts` becomes a compatibility facade that re-exports the same supported names from the canonical plan/compiler modules. It contains no duplicate implementation.

### 3. Extract the pending-action seam

Move pending-action types and pure action-specific behavior into:

```text
src/runtime/actions/model.ts
    shared action union, identity/ownership fields, and location types

src/runtime/actions/delay.ts
    delay model, validation, and pure resolution helpers

src/runtime/actions/interaction.ts
    interaction model, validation, normalization, matching, and pure resolution

src/runtime/actions/settlement.ts
    settlement models, replay classifications, and validation
```

Move canonical mutation entry points into:

```text
src/runtime/operations/complete-action.ts
src/runtime/operations/observe-time.ts
```

`src/runtime/engine.ts` remains the central execution facade and may delegate to or re-export these operations. Instruction execution, expression evaluation, and unrelated mutation helpers are not broadly reorganized in this refactor.

`src/runtime/state.ts` remains responsible for snapshot construction, cloning, whole-state validation, and cross-state invariants.

### 4. Introduce explicit compatibility facades

The implementation must retain temporary compatibility facades for at least:

| Old path | Canonical replacement | Purpose |
| --- | --- | --- |
| `src/instructions.ts` | `src/plan/*` and `src/compiler/*` | Preserve supported plan/compiler direct imports during migration. |
| `src/libraries/public.ts` | `src/library-tooling/public.ts` | Preserve the existing tooling public entry while consumers migrate. |
| Existing playground entry/controller paths | `playground/player/*` or `playground/workspace/*` | Preserve current routes/imports while browser responsibilities are separated. |

A facade re-exports canonical implementation. It must not retain or fork a second implementation.

The implementation PR must add a small compatibility inventory containing:

- old path;
- canonical replacement path;
- known repository consumers;
- owning area/issue;
- evidence-based removal condition;
- whether the path is intentionally supported externally.

### 5. Prevent new legacy imports

After canonical modules exist:

1. update all repository-owned production code and ordinary tests to use canonical paths;
2. add an automated import-boundary check that rejects new imports from legacy facade paths;
3. allow legacy imports only inside the facade itself and dedicated compatibility tests;
4. keep focused tests proving each old path still exposes the same supported symbols during transition.

Use the simplest repository-native check. Do not add an architectural lint dependency solely for this rule.

### 6. Retire facades in a separate cleanup

Facades are temporary, but not tied to an arbitrary date or release number.

After #111–#115 and active branches have migrated, open a separate behavior-neutral cleanup issue/PR. Remove a facade only when:

- repository search and the import-boundary check show no ordinary internal consumers;
- all dependent branches are merged, rebased, or otherwise accounted for;
- dedicated compatibility tests can be removed or updated intentionally;
- `src/index.ts` public exports remain stable;
- any intentionally supported external path has been documented and given an explicit compatibility decision;
- the full configured suite passes.

Internal code having stopped using a path is not by itself sufficient evidence that the path may be deleted.

## Compatibility contract

The implementation must preserve:

- all existing exports from `src/index.ts`;
- supported direct imports through the listed compatibility facades;
- diagnostic codes and spans;
- runtime event kinds and ordering;
- instruction-plan, runtime-snapshot, and checkpoint JSON shapes;
- plan/snapshot/checkpoint format versions;
- deterministic evaluation and RNG behavior;
- runtime-root isolation from library tooling and privileged adapters;
- test behavior and generated build output semantics.

A file move alone is not a reason for a format-version bump.

## Implementation commits and review boundary

Use one implementation issue and one behavior-neutral PR with logical commits:

1. rename library tooling, move privileged adapters, and add the tooling facade;
2. extract `src/plan/`, `compile-program.ts`, and the cohesive lowering compiler;
3. extract pure runtime action modules and canonical runtime operations;
4. add compatibility inventory, boundary check, and focused facade tests;
5. update documentation and run full verification.

No ADR 0018 feature behavior should be added in that branch.

## Placement rules for ADR 0018 work

### Issue #111 — compact interactions and protected prelude

- parser and semantic changes remain in the current language modules unless a later dedicated language move is approved;
- `compileProgram(...)` remains in `src/compiler/compile-program.ts`;
- the existing lowering pass remains in `src/compiler/lowering/compiler.ts`;
- interaction lowering gets `src/compiler/lowering/interactions.ts` only when it can use a small explicit context;
- plan representation uses the shared `src/plan/` contract;
- canonical pending interaction models and pure resolution belong in `src/runtime/actions/interaction.ts`;
- canonical snapshot/event/continuation mutation belongs in runtime operations;
- author-facing defaults/declarations/metadata may use `src/standard-library/prelude/interactions.ts` only when there is real code to own;
- compact syntax must not be implemented as an invisibly suspended TypeScript call.

### Issue #112 — smart autoplay and pacing

- source syntax remains in parser/compiler ownership;
- pacing lowering gets `src/compiler/lowering/pacing.ts` only when a small explicit context is practical;
- `chatPacingGate` models and pure action-specific resolution belong in `src/runtime/actions/pacing.ts`;
- completion and time settlement mutations reuse `runtime/operations/`;
- whole-state pacing invariants remain in `runtime/state.ts`;
- Standard Library `say` policy/default declarations may use `src/standard-library/prelude/say.ts`;
- no browser timer or hidden library scheduler is introduced.

### Issue #113 — Standard Player controls

New immersive Player-facing browser/controller code belongs in:

```text
playground/player/
```

It consumes public compiler/runtime/workspace APIs and must not become a second canonical state machine. Existing playground entry/controller paths remain compatibility facades until the evidence-based cleanup.

### Issue #114 — editor, formatter, and simulator

Reusable DOM-free authoring support may use a later `src/editor-support/` module when real reusable code exists. Browser integration belongs in:

```text
playground/workspace/
```

It remains separate from immersive Player interaction rendering. Existing playground entry/controller paths remain compatibility facades during migration.

### Issue #115 — final integration

New vertical acceptance tests should be grouped only when the existing test runner supports the directory without broad unrelated movement. Existing tests are not reorganized wholesale by the structure refactor.

## Timing with active branches

Recommended order:

1. merge the reviewed #110 implementation;
2. approve this proposal;
3. merge the behavior-neutral structure implementation PR from the latest `main`;
4. rebase or update active #111–#115 branches once onto that new `main`;
5. continue semantic work in the selected locations.

Do not mix this migration into #110 or force-push another agent's branch. When an active dependent PR is already too advanced to rebase safely, finish that coherent feature first and apply the same extraction immediately after its merge. The coordinator should select one ordering and prevent both layouts from being merged concurrently.

## What Option A deliberately does not do

- no wholesale move of lexer, parser, AST, semantic, or diagnostics files into `src/language/`;
- no complete split of `runtime/state.ts` or every helper in `runtime/engine.ts`;
- no mass reorganization of existing tests;
- no npm workspaces, monorepo, or multiple engine packages;
- no Laravel or production Player scaffolding;
- no final Standard Library package identity, imports, manifests, versions, or replacement mechanism;
- no behavior change, schema migration, or format-version bump;
- no one-file-per-command policy and no empty architectural shells.

# Option B — naming and trust-boundary move only

Perform only:

```text
src/libraries/ -> src/library-tooling/
src/libraries/internal/privileged-platform-adapters.ts
    -> src/platform-internal/privileged-platform-adapters.ts
```

Reserve `src/standard-library/` for future real code, but leave `instructions.ts`, `runtime/engine.ts`, and `runtime/state.ts` unchanged.

## Advantages

- smallest diff and lowest immediate rebase cost;
- resolves the most misleading folder name;
- can be completed quickly while feature branches remain active.

## Disadvantages

- does not reduce the main conflict hotspots for #111 and #112;
- action completion, time observation, and plan validation continue growing in central files;
- a second structural refactor remains necessary almost immediately.

## When to choose it

Choose Option B only when active feature branches are already too advanced for the focused extraction to land safely before them.

# Option C — broad domain reorganization now

Move the full language layer, compiler, runtime state, tests, playground, and public APIs into a comprehensive domain tree in one coordinated refactor.

Possible end state:

```text
src/language/
src/plan/
src/compiler/
src/runtime/actions/
src/runtime/engine/
src/runtime/state/
src/standard-library/
src/library-tooling/
src/platform-internal/
src/editor-support/
playground/player/
playground/workspace/
tests/language/
tests/compiler/
tests/runtime/
tests/player/
```

## Advantages

- strongest long-term ownership map;
- reduces the need for later mechanical moves;
- makes most accepted architecture boundaries visible immediately.

## Disadvantages

- very large rename/import diff;
- high conflict and review cost while ADR 0018 work is active;
- makes it harder to prove that no behavior changed;
- encourages empty abstractions and premature package-like boundaries;
- delays actual feature implementation.

## Recommendation

Do not choose Option C now. Revisit broader grouping after ADR 0018 vertical acceptance or when concrete deployment/package boundaries exist.

# Why Option A is recommended

Option A is the smallest option that addresses both classes of current problem:

1. ambiguous library/trust-boundary naming;
2. central plan and pending-action conflict hotspots.

Option B fixes only the naming problem. Option C fixes substantially more than current evidence requires. Option A provides durable seams for shared plan contracts, compiler lowering, runtime actions, Player code, workspace/editor support, the Standard Library, library tooling, and privileged adapters without creating separate packages or runtimes.

This layout is intentionally not a final filesystem for all future media, timers, host protocol, Laravel integration, package versioning, or continuous personalities. Those features can extend these ownership seams or justify later focused ADRs without invalidating the near-term structure.

# Implementation acceptance criteria

The later behavior-neutral implementation is complete when:

- selected files live under the approved directories;
- `src/plan/` is a shared compiler/runtime contract rather than compiler-owned state;
- the existing compiler has the exact destinations stated above without a broad class rewrite;
- action modules are pure and canonical mutation remains in operations/state ownership;
- every compatibility facade is recorded in the inventory;
- repository-owned code imports canonical paths;
- the boundary check prevents new legacy imports;
- focused compatibility tests prove old paths during transition;
- runtime-root exports do not expose library tooling or privileged adapters;
- no observable runtime, compiler, diagnostic, event, or serialized-data behavior changes;
- no plan/snapshot/checkpoint version changes occur merely due to file movement;
- #111–#114 have clear target locations;
- the full configured test/build/check suite passes;
- `git diff --check` passes and the worktree is clean;
- the PR contains no unrelated ADR 0018 feature implementation.

# Review checklist

The review agent should return one of these outcomes:

- **Approve Option A** — proceed with the focused behavior-neutral implementation;
- **Select Option B** — use the naming-only fallback because active branch conflict is too high;
- **Select Option C** — only with a concrete justification for accepting the broader cost now;
- **Request changes** — identify the exact directory, ownership, dependency, compatibility, or timing concern.

The review should specifically check that the selected option preserves ADRs 0015–0018, treats `src/plan/` as a shared contract, keeps action modules pure, does not expose privileged adapters, does not create a second runtime, and does not silently alter serialized formats.
