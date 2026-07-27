# Repository source-layout proposal

**Status:** Proposal for owner review; non-authoritative  
**Issue:** #118  
**Scope:** Repository organization only; no behavior, API, or serialized-format change

## Purpose

The current repository structure was deliberately simple for the first vertical parser/runtime POC. That simplicity was useful: one TypeScript package, one build, one test command, a visible runtime directory, and a separate technical playground.

The next ADR 0018 stages will add compact interaction syntax, pacing actions, Player controls, editor/simulator support, and wider integration coverage. The existing layout now concentrates too many responsibilities in a few files and uses directory names that no longer express the accepted architecture precisely.

This document proposes a staged source-layout direction. It does not accept a physical migration, schedule refactoring, change public APIs, or authorize a monorepo. Any file moves require separately approved implementation issues.

## Authority boundary

This proposal maps existing accepted architecture to filesystem ownership. It does not redefine that architecture.

The following remain authoritative:

- ADR 0007 for executable `.tease` modules versus reusable `.ts` libraries;
- ADR 0015 for versioned instruction plans, explicit JSON-safe runtime state, and no suspended JavaScript call stack;
- ADR 0016 for one shared pending-action model, foreground/background actions, deterministic time, settlements, and checkpoint behavior;
- ADR 0017 for the dependency direction among TeaseScript, the Platform Standard Library, package libraries, engine primitives, and privileged adapters;
- ADR 0018 for the first Standard Library POC and its fully lowered interaction and pacing behavior;
- `docs/CODE-EDITOR.md` for the distinction between the current technical playground and the future production editor/Player surfaces;
- the Player runtime, Host shell, Platform backend, and Authoring tools tracks in `docs/planning/POC-TO-ALPHA-BACKLOG.md`.

When this proposal conflicts with an accepted ADR or current topic document, the accepted document wins.

## Documentation survey

No current accepted document defines a complete repository filesystem layout. Existing material defines logical responsibilities and deployment boundaries, which should guide the layout without being mistaken for an already accepted directory tree.

| Source | Status for this proposal | Retained or rejected direction |
| --- | --- | --- |
| ADR 0007 | Retained | `.tease` files are executable content modules; `.ts` files are reusable libraries. This is a language/package distinction, not a reason to place repository source in content folders. |
| ADRs 0015 and 0016 | Retained | Compiler plans, runtime state, pending actions, events, checkpoints, and validation remain one deterministic model. Physical modules may be split, but not into independent runtimes. |
| ADR 0017 | Primary structural input | The Platform Standard Library, package-library tooling, engine primitives, and privileged adapters are different responsibility and trust boundaries. The source tree should make those distinctions visible. |
| ADR 0018 | Retained with an important placement rule | The first helpers are fully lowered. Parser syntax, compiler lowering, runtime actions, Standard Library policy/metadata, and Player rendering therefore belong in different modules even when authors see one friendly API. |
| `docs/LIBRARIES.md` | Retained | The current catalog/metadata POC is tooling-only and not exported from the runtime root. This supports separating `library-tooling` from the actual Platform Standard Library. |
| `docs/CODE-EDITOR.md` | Retained | The technical workspace is not the production editor or immersive Player. The playground should develop internal workspace/player seams before both surfaces grow further. |
| `docs/planning/POC-TO-ALPHA-BACKLOG.md` | Partially reusable | Its tracks provide useful responsibility names, but they are planning tracks rather than required top-level folders or npm packages. |
| `docs/planning/LANGUAGE-LIBRARY-AND-SESSION-DIRECTIONS.md` | Retained | It reinforces the automatic Platform Standard Library prelude and future three-scope library model, but does not define filesystem packaging. |
| Legacy `POST-POC-DEVELOPMENT-BACKLOG.md` and historical V30/V31 reviews | Superseded for structure decisions | They contain historical assumptions and cannot establish current source layout. |
| Research archive and legacy architecture/library documents | Reference only | They contain no accepted repository layout. Older procedure/library examples and historical runtime divisions do not override V30 or ADRs 0015–0018. |
| Folder- and tag-based tease-module ideas in `WISHES.xml` | Unrelated to repository source layout | Those folders concern package content organization. Current direction explicitly avoids hiding session semantics in fixed folder rules. |

### Result of the survey

The useful older material is already expressed as logical boundaries in current ADRs and topic documents. There is no accepted old filesystem proposal that should be copied wholesale.

The proposal should therefore:

- preserve the accepted logical boundaries;
- reject historical syntax and runtime assumptions;
- avoid confusing package content folders with repository implementation folders;
- avoid treating planning tracks as mandatory packages;
- introduce only the module seams justified by current repository growth.

## Current structure

The current high-level layout is:

```text
src/          language, compiler, plan model, runtime entry points, library tooling
playground/   development server, technical workspace, browser UI
tests/        all test categories
docs/         current documentation, ADRs, planning, references
tools/        development workflow tooling
examples/     TeaseScript examples
```

This remains a good top-level POC shape. The problem is mainly inside `src/`, `playground/`, and `tests/`.

### Current growth hotspots

The issue #110 draft artifact was reviewed only for structural evidence. It contains approximately:

```text
src/instructions.ts             2,962 lines
src/runtime/engine.ts           2,568 lines
src/runtime/state.ts            2,472 lines
src/parser.ts                   1,837 lines
src/semantic.ts                   853 lines
src/runtime/serializable-values.ts
                                  757 lines
src/lexer.ts                      711 lines
```

File length alone is not a defect. The structural concern is that each large file combines several change reasons:

- `instructions.ts`: public plan types, compiler lowering, capture, validation, control-flow validation, and interaction plan data;
- `runtime/state.ts`: snapshot model, creation, cloning, capture, full validation, liveness analysis, pending-action invariants, and settlement invariants;
- `runtime/engine.ts`: run/step operations, time observation, action completion, instruction execution, evaluation, mutation helpers, and prepared references;
- `parser.ts`: all grammar and recovery behavior in one module;
- `playground/browser.ts`: a likely future overlap point between authoring workspace and Player presentation;
- flat `tests/`: language, compiler, runtime, hardening, library tooling, server, and browser tests share one directory.

ADR 0018 issues #111–#115 will repeatedly touch those same ownership areas unless explicit seams are introduced.

## Naming decision proposed for review

Use the accepted product term **Platform Standard Library** in documentation and `standard-library` in source paths.

Do not use `system-libraries`. That term suggests operating-system or low-level runtime libraries and does not match ADR 0017 terminology.

The source tree should distinguish:

```text
standard-library/   platform-owned author-facing policy, defaults, declarations,
                    metadata, and reusable capability-safe composition

library-tooling/    package/community-library catalog, metadata extraction,
                    validation, publication support, and editor tooling inputs

platform-internal/  privileged adapters and capability brokers that public
                    Standard Library or package-library imports cannot reach
```

The current `src/libraries/` contains catalog and metadata tooling, not the Platform Standard Library. Keeping that name while real Standard Library code is added would make the directory ambiguous.

## Placement rule for author-facing APIs

An author-facing API does not belong entirely in `standard-library/` merely because it is described as a Standard Library function.

For an interaction such as `askText`:

```text
compact source grammar
    -> language/parser

source-to-plan lowering and prepared values
    -> compiler

canonical pending action, completion, result, transcript, settlement
    -> runtime

author-facing defaults, declarations, documentation metadata,
and reusable synchronous composition
    -> standard-library

input rendering and localized feedback
    -> Player/Standard UI
```

This preserves one deterministic engine. The Standard Library must not become a second runtime or hide checkpoint-relevant state.

## Near-term target map

The following is a responsibility map, not a requirement to create every directory immediately:

```text
src/
  language/
    ast.ts
    ast-validation.ts
    diagnostics.ts
    lexer.ts
    parser.ts
    protected-names.ts
    semantic.ts
    source.ts
    token.ts

  compiler/
    index.ts
    lowering/
      expressions.ts
      statements.ts
      interactions.ts
      pacing.ts
    plan/
      model.ts
      capture.ts
      validation.ts

  runtime/
    actions/
      model.ts
      delay.ts
      interaction.ts
      pacing.ts
      settlement.ts
    engine/
      execute.ts
      run.ts
      complete-action.ts
      observe-time.ts
    state/
      model.ts
      create.ts
      clone.ts
      validation.ts
      invariants.ts
    values/
      serializable-values.ts
      compatibility-values.ts
    checkpoint.ts
    events.ts
    errors.ts
    random.ts
    warnings.ts

  standard-library/
    prelude/
    contracts/
    metadata.ts
    public.ts

  library-tooling/
    catalog.ts
    metadata.ts
    public.ts

  platform-internal/
    adapters/

  shared/
    external-data-limits.ts
    interaction-limits.ts

  index.ts
```

### KISS constraints

This map is intentionally not a file-generation checklist.

- Do not create empty directories merely to match the diagram.
- Do not create one file per command.
- Extract a module only when it owns a cohesive responsibility or removes a demonstrated conflict hotspot.
- Keep `src/index.ts` as the compatibility facade until explicit public entry points are justified.
- Keep one TypeScript package and one build for the near term.
- Do not add dependency-injection frameworks, package workspaces, or architectural lint dependencies without a demonstrated need.

## Dependency direction

The intended source dependency direction is:

```text
language
    -> compiler plan and lowering
        -> runtime public contracts

standard-library policy/declarations
    -> compiler lowering and public typed capabilities
        -> runtime actions

Player/workspace adapters
    -> public compiler/runtime APIs

library-tooling
    -> language/compiler metadata inputs
    -/-> runtime root
    -/-> privileged adapters

platform-internal adapters
    -> internal engine/player capability boundary
    -/-> public Standard Library exports
    -/-> package libraries
```

A directory move must not create dependency cycles or expose privileged adapters through a convenient barrel export.

## Proposed migration stages

### Stage 0 — no broad moves in issue #110

Issue #110 is a semantic runtime change and is already under separate review. A repository-wide move in that branch would obscure the interaction implementation diff and increase review risk.

The proposal may be reviewed and merged while #110 is open, but physical migration should use the final merged #110 state.

### Stage 1 — clarify library and trust-boundary naming

A first behavior-neutral implementation issue should:

1. rename `src/libraries/` to `src/library-tooling/`;
2. move the privileged-adapter placeholder to `src/platform-internal/`;
3. update direct imports and tooling tests;
4. preserve the fact that library tooling is not exported from the runtime root;
5. add no real Standard Library implementation merely to populate a directory;
6. prove build output and behavior remain unchanged.

This stage removes the most misleading current name with limited semantic risk.

### Stage 2 — extract plan and runtime-action seams

A separate behavior-neutral issue should work from the merged #110 model and:

1. keep a compatibility facade at the existing instruction-plan import path;
2. separate plan model, capture, and validation responsibilities;
3. introduce a shared `runtime/actions` model for delay, interaction, settlement, and later pacing behavior;
4. separate action completion and time observation from general instruction execution where practical;
5. preserve all public exports, diagnostic codes, event ordering, and serialized JSON shapes;
6. prove no plan, snapshot, or checkpoint version changes are required merely for file movement.

This stage may need two pull requests if plan extraction and runtime extraction create an unreviewable combined diff.

### Stage 3 — place new ADR 0018 code into established seams

After the preceding seams are accepted:

- issue #111 interaction grammar remains in language modules and interaction lowering in compiler modules;
- issue #112 pacing action behavior belongs with runtime actions, while source pacing syntax/lowering remains in language/compiler modules;
- Standard Library declarations, defaults, and tooling metadata are added to `standard-library/` only when there is actual code to own;
- issue #113 uses a Player-facing browser/controller area;
- issue #114 uses a workspace/editor/simulator area;
- neither browser surface imports arbitrary runtime internals.

If #111 or #112 is already active before a structural implementation lands, do not force a large mid-branch rebase. Finish the active feature coherently, then extract from the merged state.

### Stage 4 — separate playground responsibilities

Before both Player and editor surfaces become large, evolve the temporary application toward:

```text
playground/
  server/
  workspace/
    controller.ts
    browser.ts
  player/
    controller.ts
    interactions.ts
    pacing-input.ts
  shared/
  index.html
  playground.css
```

This remains one temporary development application. It does not decide the final cross-origin host protocol or create a second public Node server.

The physical split should follow actual #113/#114 ownership rather than pre-creating empty modules.

### Stage 5 — group tests during ordinary work

Use gradual grouping rather than a cosmetic all-at-once move:

```text
tests/
  language/
  compiler/
  runtime/
    actions/
    checkpoint/
    hardening/
  standard-library/
  library-tooling/
  playground/
    workspace/
    player/
    server/
  integration/
    source-to-runtime/
    resume-equivalence/
  helpers/
```

Move a coherent test group when its owning feature or structural issue already changes it. Keep behavior-oriented names and avoid mirroring every production subdirectory mechanically.

### Stage 6 — explicit public entry points after the vertical slice

The current broad `src/index.ts` remains useful during the POC. After ADR 0018 stabilizes, review whether the repository needs documented compiler, runtime, and tooling entry points.

Possible later entries are:

```text
compiler API
runtime API
library-tooling API
editor-support API
```

Do not split the public API merely to make the directory diagram symmetrical. First identify real consumers and compatibility expectations.

## Long-term application/package split

A later repository shape may become appropriate when the repository contains both a real Laravel application and an independently built Player:

```text
apps/
  platform-web/          Laravel application and only public backend
  player/                cross-origin iframe/PWA application

packages/
  teasescript-engine/
  standard-library/
  editor-support/
  library-tooling/

docs/
examples/
tools/
```

This proposal does **not** accept that monorepo now.

A package split should require concrete evidence such as:

- independent build or deployment lifecycles;
- different runtime dependency sets;
- a real Laravel/Composer application boundary;
- a separately deployed Player bundle;
- multiple actual consumers of the TypeScript engine;
- release/versioning requirements that cannot be handled cleanly in one package.

Until then, npm workspaces, multiple TypeScript builds, Composer path packages, and cross-package version management would add more complexity than they remove.

## Public compatibility during moves

Behavior-neutral structure changes must preserve:

- `src/index.ts` public exports unless an explicit API issue changes them;
- tooling-only exports that intentionally remain outside the runtime root;
- importable source paths used by repository tests, or provide temporary re-export facades;
- diagnostic codes and source spans;
- instruction-plan JSON shape and version;
- runtime snapshot/checkpoint JSON shape and version;
- event names and ordering;
- deterministic execution, RNG, and resume equivalence;
- package scripts and one clean build/test flow.

A file move alone is not a reason to bump a serialized format version.

## Coordination with ADR 0018 issues

```text
#110 runtime foundation
    -> should finish without repository-wide moves

structure implementation selected from this proposal
    -> should use merged #110 as its base

#111 syntax and lowering
#112 pacing
    -> should use the resulting seams only when the structure work is merged first

#113 Player and #114 editor
    -> should coordinate playground file ownership

#115 vertical acceptance
    -> verifies behavior, not whether every optional target directory exists
```

This proposal does not automatically insert a new blocking dependency into tracker #109. The owner should decide whether a behavior-neutral structure implementation lands before #111, between later issues, or after the ADR 0018 vertical slice.

## Risks

### Excessive movement

Large renames can make semantic history and pull-request review harder. Mitigation: separate naming, plan extraction, runtime extraction, playground separation, and test grouping into small behavior-neutral changes.

### Artificial fragmentation

Many tiny modules can make navigation worse. Mitigation: extract by cohesive responsibility, not line count or one-command-per-file rules.

### Accidental API expansion

New barrel files may expose internals. Mitigation: preserve existing public entry points and review every re-export explicitly.

### Accidental serialized change

Refactoring validation or clone code can alter accepted JSON shapes or error behavior. Mitigation: no version bump or shape change in a structure-only PR; compare full plans, snapshots, checkpoints, and events in tests.

### Active-branch conflicts

Moving files while feature branches are open creates unnecessary rebases. Mitigation: schedule physical moves only against a known merged base and avoid rewriting another agent's branch.

## Open owner decisions

This proposal requests review of these choices:

1. Accept `standard-library`, `library-tooling`, and `platform-internal` as the preferred directory names.
2. Decide whether library/trust-boundary naming should be the first physical structure change.
3. Decide whether plan extraction and runtime-action extraction should be one issue or two.
4. Decide when the structure implementation should occur relative to issues #111–#115.
5. Retain one TypeScript package until real deployment/package evidence justifies `apps/` and `packages/`.

## Explicit non-goals

This proposal does not decide or implement:

- Standard Library import syntax, manifests, lockfiles, or version selection;
- community-library dependency resolution;
- exact Standard Library package identity;
- a new runtime, scheduler, or checkpoint model;
- final Player/host messaging, CSP, sandbox flags, or deployment;
- Laravel project scaffolding;
- npm workspaces or a monorepo;
- final editor framework or metadata transport;
- a source-file size rule;
- mandatory one-to-one correspondence between folders and architecture diagrams.

## Proposed acceptance outcome

Approval of this document should mean only:

- the terminology and staged direction are suitable for implementation planning;
- future source additions should avoid worsening the identified mixed-responsibility directories;
- physical moves may be proposed in focused behavior-neutral issues.

Approval should not be interpreted as completing any migration or accepting the long-term monorepo example.
