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

`npm run dev:player:timer-lab` serves an isolated timer design lab at `/timer-lab/`. It renders every timer direction
under discussion side by side against the current Player ring, in four environments including a photographic backdrop,
and exists only so a direction can be chosen before anything is integrated. It reuses `presentation.ts` for time
formatting and otherwise shares no component with the maintained Player; its `--tl-*` variables are lab-local and are
not Player theme roles. `vue/src/timer-lab/catalogue.ts` is the single list every candidate is registered in. Query
parameters address a specific state for review or screenshots, for example `?bg=media&veil=light&only=bezel&progress=85`.

## Implementation seams

- `runtime-adapter.ts` contains the framework-independent runtime-to-Player translation and shared action helpers used
  by the Vue Player and playground workspace controller.
- `vue/` contains the maintained Vue Player and its Vite build.
- `model.ts` contains presentation-only POC data shapes.
- `presentation.ts` contains framework-independent presentation ordering, formatting, matching, and colour helpers.
- `panel-state.ts` and `tool-columns.ts` keep the current local UI state transitions separate from rendering.
- Vue development diagnostics live under `vue/src/devtools/`.
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

The isolated Phase 2C Tool Panel strip uses SortableJS directly for handle-based mouse/touch reordering and edge
autoscroll. A local lifecycle binding restores Sortable's DOM move before updating Vue's authoritative visual-order
list; pin membership and per-tool widths remain separate. A Vue wrapper would add another maintenance/version layer
for little reduction in this single-list binding. Native HTML drag-and-drop has weaker touch support; a Pointer Events
implementation would require custom sorting and autoscroll. Reka menu actions provide the keyboard/non-drag alternative.
SortableJS adds shipped browser code and a normal dependency update/audit obligation; its development-only type package
adds no runtime code. Both are locked in the package manifest/lockfile. The integration introduces no network service,
runtime data access, or new host boundary. Keep sorting and scroll behavior covered when updating the dependency.

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
  toast-plus-highlight as transient feedback. The final transient treatment remains a playtest decision.
