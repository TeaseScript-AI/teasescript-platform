# Player POC implementation

This directory contains the current browser presentation implementation for the Standard Player POC. The canonical
observable UI contract is [`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md). Do not infer new product requirements
from HTML structure, CSS selectors, TypeScript helpers, demo data, or other implementation details here.

General cross-surface UI engineering/design guidance lives in
[`docs/ui/UI-DESIGN-AND-ENGINEERING.md`](../docs/ui/UI-DESIGN-AND-ENGINEERING.md); narrow tasks use its focused reading
route. Accepted runtime, interaction, security, and custom-view semantics remain in their controlling specifications and
ADRs.

For local inspection, `npm run playground` serves the production-direction Vue reference at `/player-vue/` and the
manual/vanilla legacy implementation at `/player/` through the existing development server. These development routes
are not a public Player/host protocol. `/player/` is pending removal and is not a maintained comparison architecture or
a second production frontend; `/player-vue/` owns the development-only Visual Lab, Layout Debug, and Runtime Session tools.

## Implementation seams

- `index.html` and `browser.ts` are the legacy manual development entry point and wiring pending removal.
- `runtime-adapter.ts` contains the framework-independent runtime-to-Player translation and shared action helpers used
  by the Vue reference and playground workspace controller.
- `vue/` contains the usable production-direction/common Vue reference and its Vite build.
- `model.ts` contains presentation-only POC data shapes.
- `presentation.ts` contains framework-independent presentation ordering, formatting, matching, and colour helpers.
- `render.ts` renders presentation data and demo tool-column content.
- `panel-state.ts` and `tool-columns.ts` keep the current local UI state transitions separate from rendering.
- `browser.ts` wires local browser interactions, demo presentation state, responsive state synchronization, and demo
  media loading.
- `layout-debug.ts` is the legacy manual-route geometry observer; Vue development diagnostics live under
  `vue/src/devtools/`.
- `styles/` separates reset, layout/theme ownership, components, effects, and responsive composition through cascade
  layers.
- `demo-session.ts` and `demo-media/` are presentation fixtures, not runtime/package APIs.

Browser-native CSS remains responsible for layout and responsive composition. Vue 3 owns rendering and local
presentation state in the common reference; Tailwind CSS 4 is integrated through Vite as a foundation layer,
repository-owned shadcn-vue source/config provides local component seams, Reka is the selected accessible
primitive/positioning/focus layer when interactive components need it, and TanStack Vue Virtual is the single
transcript windowing/scroll-anchoring owner. The engine and shared presentation contracts remain framework-independent
as required by ADR 0020.

`styles/layout.css` currently owns the concrete light-theme palette values and semantic token mapping used by the
source. Those values are also maintained as observable Player contract in `docs/ui/PLAYER-UI.md`; component CSS should
consume semantic roles rather than raw application-palette primitives. Speaker, package-accent, media, and technical
mask colours remain separate presentation data.

## Demo-only behavior

The local playground server may select a supported image from `player/demo-media/` when the Player opens. Visual Lab,
Layout Debug, Runtime Session, their fixture content, local tuning/inspection controls, and the demo-media endpoint are
development-only presentation tools, not Standard Library, runtime, package, or host APIs.

Runtime Session restores canonical runtime/checkpoint state plus same-session runtime-event history; Visual Lab settings,
tool columns, and fixture-only right-rail/composer history remain local.

`/player-vue/?fixture=transcript-stress` is a development-only browser-verification route. It retains 2,000 transcript
entries in presentation data while TanStack-owned windowing bounds rendered DOM, and exercises variable-height
measurement, keyed prepend/append anchoring, resize behavior, scroll-away preservation, and return-to-latest follow.
It is not a runtime, package, or host API.

Browser automation can open `/player-vue/?layout-debug=1` to start the Vue Layout Debug overlay enabled; the ordinary
`/player-vue/` route starts with diagnostics disabled.

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
  toast-plus-highlight as transient feedback. The final transient treatment remains a playtest decision.
