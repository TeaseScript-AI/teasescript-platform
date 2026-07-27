# Concrete repository source-layout proposal

**Status:** Proposal for review; non-authoritative until approved  
**Issue:** #118  
**Recommended option:** A — focused seam extraction now  
**Scope:** Folder and module ownership only; no behavior, public API meaning, or serialized-format change

## Decision requested

Approve one near-term source-layout direction before ADR 0018 issues add substantially more code to the current hotspots.

This document recommends **Option A**: perform one focused behavior-neutral refactor after #110 is merged and before further ADR 0018 implementation is merged. It also records two practical alternatives so a review agent can compare cost and risk.

The proposal does not itself move production files. After approval, one separate implementation issue and pull request should apply the selected option from the then-current `main`.

## Problem being solved

The current layout was effective for the first vertical POC, but several files now own too many unrelated responsibilities:

- `src/instructions.ts` combines plan types, lowering, capture, and validation;
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
  compiler/
    plan/
      model.ts
      capture.ts
      validation.ts
    lowering/
      interactions.ts      # created by/for #111 when real code exists
      pacing.ts            # created by/for #112 when real code exists

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

  standard-library/
    public.ts              # created only when there is a real public surface
    prelude/
      interactions.ts      # defaults/declarations/metadata, not canonical runtime state
      say.ts               # pacing policy/default metadata, not a second scheduler

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
  ...existing entry files
```

This is the selected near-term map, not a requirement to create empty files. A directory is created when the refactor moves real code into it or the owning ADR issue adds real code.

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
- direct internal imports and tests are updated mechanically.

### 2. Extract the instruction-plan seam

Split the current `src/instructions.ts` responsibilities into:

```text
src/compiler/plan/model.ts
    plan versions, instruction and expression-plan types,
    shared plan constants, and discriminated unions

src/compiler/plan/capture.ts
    capture of untrusted plan-shaped data into safe internal data

src/compiler/plan/validation.ts
    complete plan validation and structural invariants
```

Compiler lowering that currently lives in `instructions.ts` moves to cohesive compiler modules. Existing generic lowering may remain in one compiler module; interaction- and pacing-specific modules are added only when #111/#112 provide real code.

`src/instructions.ts` remains temporarily and re-exports the same public names from the new modules. Existing consumers must not be forced to change in the same migration.

### 3. Extract the pending-action seam

Move pending-action types and cohesive behavior into:

```text
src/runtime/actions/model.ts
    shared action union, common identity/ownership fields, and location types

src/runtime/actions/delay.ts
    delay-specific construction/validation/settlement helpers

src/runtime/actions/interaction.ts
    ADR 0018 interaction-specific construction/validation/completion helpers

src/runtime/actions/settlement.ts
    settlement types, replay classification, and shared validation
```

Separate the two public mutation operations from general instruction execution:

```text
src/runtime/operations/complete-action.ts
src/runtime/operations/observe-time.ts
```

`src/runtime/engine.ts` remains the central execution facade and may delegate to/re-export these operations. Instruction execution, expression evaluation, and unrelated mutation helpers are not broadly reorganized in this refactor.

`src/runtime/state.ts` remains in place for this first migration. Action model extraction may reduce its size, but snapshot construction, cloning, and whole-state validation are not split merely to make the tree look symmetrical.

### 4. Preserve compatibility

The implementation must preserve:

- all existing exports from `src/index.ts`;
- existing supported direct imports through compatibility re-exports where repository consumers rely on them;
- diagnostic codes and spans;
- runtime event kinds and ordering;
- instruction-plan, runtime-snapshot, and checkpoint JSON shapes;
- plan/snapshot/checkpoint format versions;
- deterministic evaluation and RNG behavior;
- test behavior and generated build output semantics.

A file move alone is not a reason for a format-version bump.

### 5. Keep the migration reviewable

Use one implementation issue and one behavior-neutral PR with logical commits:

1. rename library tooling and move privileged adapters;
2. extract plan model/capture/validation and add the compatibility facade;
3. extract runtime actions and completion/time operations;
4. update documentation and run full verification.

No ADR 0018 feature behavior should be added in that branch.

## Placement rules for ADR 0018 work

### Issue #111 — compact interactions and protected prelude

- parser and semantic changes remain in the current language modules unless a later dedicated language move is approved;
- interaction lowering belongs in `src/compiler/lowering/interactions.ts`;
- plan representation uses `src/compiler/plan/`;
- canonical pending interaction behavior belongs in `src/runtime/actions/interaction.ts`;
- author-facing defaults/declarations/metadata may use `src/standard-library/prelude/interactions.ts` only when there is real code to own;
- compact syntax must not be implemented as an invisibly suspended TypeScript call.

### Issue #112 — smart autoplay and pacing

- source syntax remains in parser/compiler ownership;
- pacing lowering belongs in `src/compiler/lowering/pacing.ts`;
- `chatPacingGate` action behavior belongs in `src/runtime/actions/pacing.ts`;
- completion and time settlement reuse `runtime/operations/`;
- Standard Library `say` policy/default declarations may use `src/standard-library/prelude/say.ts`;
- no browser timer or hidden library scheduler is introduced.

### Issue #113 — Standard Player controls

New immersive Player-facing browser/controller code belongs in:

```text
playground/player/
```

It consumes public compiler/runtime/workspace APIs and must not become a second canonical state machine.

### Issue #114 — editor, formatter, and simulator

Reusable DOM-free authoring support may use a later `src/editor-support/` module when real reusable code exists. Browser integration belongs in:

```text
playground/workspace/
```

It remains separate from immersive Player interaction rendering.

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

Option B fixes only the naming problem. Option C fixes substantially more than current evidence requires. Option A provides useful seams for #111–#114 without turning the POC into a premature monorepo or a lengthy architecture project.

# Implementation acceptance criteria

The later behavior-neutral implementation is complete when:

- selected files live under the approved directories;
- old supported import paths continue through compatibility re-exports;
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

The review should specifically check that the selected option preserves ADRs 0015–0018, does not expose privileged adapters, does not create a second runtime, and does not silently alter serialized formats.