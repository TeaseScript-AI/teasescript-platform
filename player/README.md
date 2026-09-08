# Player POC implementation

This directory contains the current browser presentation implementation for the Standard Player POC. The canonical
observable UI contract is [`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md). Do not infer new product requirements
from HTML structure, CSS selectors, TypeScript helpers, demo data, or other implementation details here.

General cross-surface UI engineering/design guidance lives in
[`docs/ui/UI-DESIGN-AND-ENGINEERING.md`](../docs/ui/UI-DESIGN-AND-ENGINEERING.md); narrow tasks use its focused reading
route. Accepted runtime, interaction, security, and custom-view semantics remain in their controlling specifications and
ADRs.

For local inspection, `npm run playground` serves the maintained Vue Player at `/player/` through the existing development
server. This development route is not a public Player/host protocol and owns the development-only Visual Lab, Layout
Debug, and Runtime Session tools.

## Implementation seams

- `runtime-adapter.ts` contains the framework-independent runtime-to-Player translation and shared action helpers used
  by the Vue Player and playground workspace controller.
- `vue/` contains the maintained Vue Player and its Vite build.
- `model.ts` contains presentation-only POC data shapes.
- `presentation.ts` contains framework-independent presentation ordering, formatting, matching, and colour helpers.
- `panel-state.ts` and `tool-columns.ts` keep the current local UI state transitions separate from rendering.
- `stage-geometry.ts` resolves the stage height from the available width, the session media aspect, and the height that
  actually remains after the composer, response lane and control tray.
- Vue development diagnostics live under `vue/src/devtools/`.
- `styles/` separates reset, theme, layout, components, effects, and responsive composition through cascade layers.
- `demo-session.ts` and `demo-media/` are presentation fixtures, not runtime/package APIs.

Browser-native CSS remains responsible for layout and responsive composition. Vue 3 owns rendering and local
presentation state in the common reference; Tailwind CSS 4 is integrated through Vite as a foundation layer,
repository-owned shadcn-vue source/config provides local component seams, Reka is the selected accessible
primitive/positioning/focus layer when interactive components need it, and TanStack Vue Virtual is the single
transcript windowing/scroll-anchoring owner. The engine and shared presentation contracts remain framework-independent
as required by ADR 0020.

`styles/theme.css` owns the concrete palette primitives, semantic token mapping, type scale, and shape language;
`styles/layout.css` owns geometry. Component CSS consumes semantic roles rather than raw application-palette
primitives. Speaker, package-accent, media, and technical mask colours remain separate presentation data.

## Phase 2B presentation candidate

This branch carries the Phase 2B redesign from issue #337. It is a comparison candidate, so `docs/ui/PLAYER-UI.md`
still records the pre-Phase-2 presentation and is only synchronized once the Owner accepts a candidate. The
deliberate departures from that document, each pending an Owner decision, are:

- global controls float over the stage instead of reserving a full-width title band, which removes the separate
  overlay-chrome mode;
- the stage height is constraint-derived rather than a fixed `dvh` value, using a session-stable media aspect between
  a floor and a cap;
- visible timers are dial capsules docked to the stage's lower edge rather than rings stacked in the right region,
  which also removes the two-pane right-rail height allocation;
- long-lived background controls are bottom-anchored, and when a side track no longer fits they reflow to a
  horizontal tray above the response lane, then to an anchored sheet, rather than overlaying the stage;
- responsive composition is driven by measured constraints published as `data-*` composition states, not by viewport
  media queries;
- the default presentation is a low-light `stage` theme, with the warm `daylight` theme selectable in Visual Lab.

Reka provides the tooltip, popover and focus-scope behavior for anchored and overlay chrome; the tooltip surface is
repository-owned shadcn-vue source under `vue/src/components/ui/`.

## Demo-only behavior

The local playground server may select a supported image from `player/demo-media/` when the Player opens. Visual Lab,
Layout Debug, Runtime Session, their fixture content, local tuning/inspection controls, and the demo-media endpoint are
development-only presentation tools, not Standard Library, runtime, package, or host APIs.

Runtime Session restores canonical runtime/checkpoint state plus same-session runtime-event history; Visual Lab settings,
tool columns, and fixture-only right-rail/composer history remain local.

`/player/?fixture=transcript-stress` is a development-only browser-verification route. It retains 2,000 transcript
entries in presentation data while TanStack-owned windowing bounds rendered DOM, and exercises variable-height
measurement, keyed prepend/append anchoring, resize behavior, scroll-away preservation, and return-to-latest follow.
It is not a runtime, package, or host API.

Browser automation can open `/player/?layout-debug=1` to start the Vue Layout Debug overlay enabled; the ordinary
`/player/` route starts with diagnostics disabled.

The default Vue development route compiles real `player-controls.tease` source and drives `say`, canonical
`playerTranscript` output, foreground interactions, chat pacing, time observation, checkpoint, and restore through
`runtime-adapter.ts`. Engine operations remain authoritative for action identity, validation, normalization, choice
matching, transcript derivation, settlement, and continuation. The checkpoint's companion transcript-event history is
presentation-owned and retained only for same-session development restore; it does not alter the canonical runtime
checkpoint or define the deferred production persistence/host payload.

Demo media, timers, rendered right-rail controls, tool content, and the transcript stress route remain explicitly
fixture-backed. Accepted Standard interaction behavior remains controlled by ADR 0018 and the runtime contracts; the
maintained placement/presentation boundary is described in `docs/ui/PLAYER-UI.md`.

Current Visual Lab fixtures deliberately exercise several presentation questions without promoting their fixture state
to runtime or product semantics:

- the timer starts with the authored-label example; generic labels, mystery presentation, hidden presentation, and
  multiple-timer pressure remain selectable;
- the pacing-gate fixture reveals a short message sequence over time, with Player-background/empty-composer Space
  skipping available only in the skippable variant;
- script-initiated control changes add a neutral event to transcript history and compare toast, local highlight, and
  toast-plus-highlight as transient feedback. The final transient treatment remains a playtest decision;
- `Theme` compares the low-light `stage` presentation with the warm `daylight` presentation on the same structure;
- `Scrolled transcript edge` compares the three candidate treatments for the line sitting on the scrolled top
  boundary — a late-closing mask, a soft fade, and a hard cut — which the Owner left undecided;
- `Stage floor`, `Stage cap`, `Immersive stage cap` and `Control rail width` tune the constraints that decide the
  stage/conversation balance and when a side track stops fitting.
