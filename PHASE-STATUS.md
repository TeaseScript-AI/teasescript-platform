# Current phase status

## Current phase and gate

The current implementation phase combines the deterministic TypeScript language/runtime POC with the
production-direction Vue Player foundation and local browser development surfaces. This file records verified
capability state at a high level; it is not the canonical source for source identity, live CI state, detailed
contracts, or historical execution evidence.

Owner-selected release-stage outcomes, including work that remains open for POC / Foundation or Alpha, are tracked
in [`docs/planning/RELEASE-ROADMAP.md`](docs/planning/RELEASE-ROADMAP.md). Roadmap placement does not schedule work or
accept syntax, architecture, or implementation details.

## Implemented capability groups

- **Source pipeline:** lexer, parser, immutable AST, source spans, diagnostics, semantic validation, type checking,
  and compilation for the implemented TeaseScript subset.
- **Language foundation:** values including elapsed durations and date, time, datetime, and timestamp values,
  variables, assignments including `+=`/`-=`, speakers, output, collections, expressions, interpolated
  single-line and block strings, constrained authored `say` message markup, protected `escapeMarkup` literal insertion,
  control flow, deterministic random, rounding, and `min`/`max` built-ins, text operations and list `join`, the
  `toString`/`toNumber`/`toInteger`/`toBoolean` conversions, list `sort`/`shuffle` and set operations, top-level
  user-defined functions, labels and `goto`, and explicit endings with a required `exit` (ADR 0022). Projects of several
  `.tease` files compile into one plan, with globals, global functions, and speakers shared by all files, `goto`,
  `call`, and `end` between files with a `fallback`, glob targets, and computed targets from `script(...)` references.
- **Deterministic runtime:** versioned JSON-safe instruction plans, runtime snapshots, checkpoints, explicit loop and
  call state, deterministic RNG state, typed sequenced events, instruction budgets, and defensive restore validation.
- **Script storage:** `save`/`load`/`delete`, optional lazy defaults, a validated checkpointed session view, and
  host-acknowledged atomic writes under [Runtime](docs/RUNTIME.md#script-storage). The Player keeps it in browser local storage
  with a Clear saved script data control.
- **Pending actions, timers, and chat pacing:** blocking `wait`/`timer` and asynchronous timers with presentation metadata,
  labels, opaque handles, lifecycle control, repetition, queued expiry interrupts, and scene-time checkpoint/restore;
  protected compact interactions on one typed foreground family; and ADR 0018 resumable `say` pacing, prepared
  output, typed skip settlement, and interaction/timer composition.
- **Stage image and media:** `showImage`/`hideImage` Stage state, tag queries over the compiled package image catalog
  and photos taken with tags (`showImage tagged`, `findImages`, `takePhoto(tags:)`), and blocking or asynchronous `playAudio`/`playVideo`
  with playback ranges, repetition, volume, handles, seeks, timeline cues, Player load/progress observations, and
  checkpoint restore at the language, compiler, and runtime level. The Player shows the Stage image and plays
  audio after explicit Start; browser video playback remains deferred.
- **Camera capture:** `takePhoto()` as a typed capture action with trusted reference admission and non-fatal
  unavailability under [Runtime](docs/RUNTIME.md#camera-capture). With a trusted host capability the Player opens the
  session camera after Start and captures silently; a photo saved through script storage is stored in the browser and
  shown again in a later run. `askImage`, recording APIs, and the advanced package media API remain deferred.
- **Player:** the POC Player is the Vue implementation under `player/vue/src/` (#418), served on `/player/`. It uses
  Vue/Vite, Tailwind CSS 4, repository-owned shadcn-vue/Reka primitives, and TanStack Vue Virtual as the transcript
  owner. A framework-independent adapter connects it to the implemented transcript, foreground-interaction, pacing,
  time-observation, runtime timer, checkpoint, and restore slice, including typed message markup with controlled links;
  authored runtime timers render in its timer rail on a session-owned scene clock (#444).
  It also has the tools framework and browser-local Player Settings. It shows the runtime Stage image and plays authored
  audio through `player/media-device.ts` after the explicit Start activation (#446). The default build plays the
  repository demo `examples/demo/demo.tease` (#448); the development server or `?dev` loads the development preview
  with Visual Lab and Layout Debug instead.
- **Development and verification:** a standalone browser playground with Standard interaction and pacing controls;
  source-to-runtime conformance coverage; focused runtime/checkpoint/state-validation tests; reproducible desktop and
  narrow-screen browser smoke coverage that plays the repository demo, development-preview browser checks, and a bounded
  deterministic property campaign.

These summaries are orientation only. The current topic documents below are canonical for the detailed implementation
contracts and boundaries.

## Current major exclusions and blockers

- complete V30 coverage, complete static typing, measurement units, generalized duration ranges, and locale-aware
  duration presentation;
- production cross-origin Player/host integration, richer editor support, and final browser acceptance coverage;
- pending-action capabilities beyond the implemented timer, interaction, pacing, and media families; browser video
  playback, the layered scene, camera capture beyond `takePhoto()`, and custom views;
- the cross-origin player-host protocol and production browser security integration;
- TypeScript library linkage, final Standard Library/package identity and compatibility, richer module selection, and
  community dependency resolution;
- Laravel/PostgreSQL persistence, accounts, catalog, publishing, moderation, scheduling, continuous personalities,
  and LLM/vision integration.

Current unresolved choices are recorded in [`docs/OPEN-DECISIONS.md`](docs/OPEN-DECISIONS.md). Concrete
implementation work is tracked in GitHub issues rather than in this status file.

## Verification entrypoint

Use the runtime version declared by [`.nvmrc`](.nvmrc) and the dependency graph declared by
[`package.json`](package.json) and [`package-lock.json`](package-lock.json):

```shell
npm ci
npm run check
git diff --check
```

Inspect the complete diff and any affected security or playground route matrix. Resolve live pull-request and CI
state from GitHub.

## Current topic sources

- Product scope and current implementation focus: [`docs/PRODUCT.md`](docs/PRODUCT.md)
- Architecture and component boundaries: [`CURRENT-DESIGN.md`](CURRENT-DESIGN.md) and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Accepted syntax baseline and implemented language subset:
  [`docs/specifications/accepted-syntaxes-v30.md`](docs/specifications/accepted-syntaxes-v30.md) and
  [`docs/TEASESCRIPT.md`](docs/TEASESCRIPT.md)
- Runtime, actions, checkpoints, and current internal formats: [`docs/RUNTIME.md`](docs/RUNTIME.md)
- Engine primitives and libraries: [`docs/LIBRARIES.md`](docs/LIBRARIES.md)
- Browser editor and current playground authoring surface: [`docs/CODE-EDITOR.md`](docs/CODE-EDITOR.md)
- Debugger, simulator, and diagnostic execution: [`docs/DEBUGGER.md`](docs/DEBUGGER.md)
- Testing strategy and configured verification: [`docs/TESTING.md`](docs/TESTING.md)
- Security and trust boundaries: [`docs/SECURITY.md`](docs/SECURITY.md)
