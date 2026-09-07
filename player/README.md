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

`styles/layout.css` owns palette primitives and semantic roles; component CSS consumes those roles. Speaker,
package-accent, authored-control, and media colours retain their separate ownership.

## Phase 2A comparison presentation

Issue #336 evaluates an independent presentation from shared commit
`770b6f508a398d0f4dfd8ec892aae675404564b4`. This is a comparison candidate, not an accepted final Standard Player design.
The runtime-backed foundation and its capability exclusions below remain unchanged.

The candidate uses a narrow vertical instrument strip beside one uninterrupted scene/conversation flow. The strip
holds the TeaseScript wordmark, visible timers, Session, Tools, and fullscreen/exit. There is no horizontal title bar,
timer shelf, or right control rail. Scene/media stays above transcript, foreground decision, and persistent composer.
The ink/plum canvas gives media the luminance; ivory serif spoken prose distinguishes narrative voice from sans-serif
participant replies and instruments. Copper emphasizes the current response. Authored fonts and fills remain intact.

This direction was selected after comparing a screening-room header, a scene-over-workbench composition, a session
shelf, and a reading-first folio. The rendered shelf consumed scarce stage height and separated the scene from the
conversation. Moving secondary instruments onto a vertical axis removed that cost without overlaying the media.
The first spine render then exposed excessive empty media space on narrow screens; a width-based stage cap and a
quieter media-derived wash corrected it. These are comparison choices, not new accepted Standard Player policy.

Timers use values, labels, and linear elapsed progress in their own bounded vertical scroll region. Mystery timers
expose neither duration nor progress; hidden timers leave no timer UI. More timers never change primary row allocation.
Session opens an opaque Reka popover beside its trigger for background actions, switches, selects, and status. Busy,
disabled, authored-fill, script-update, ordering, and transcript-provenance behavior remain supported. Its controls
scroll independently when necessary; positioning, dismissal, and focus return stay inside the fullscreen Player.

Tools start closed. They open as a full-height workbench when one tool column, protected reading width, gutters,
instruments, and usable height fit; extra columns use the existing native horizontal strip when necessary. Otherwise
the same tools use a focus-contained Reka drawer with outside and Escape dismissal. Tool state survives disclosure.
Opening Session replaces the visible tools workspace, and opening Tools dismisses Session; their local content state
is retained. The wordmark abbreviates and instrument width contracts under width pressure. Fullscreen retains the same explicit
exit control. Dynamic safe areas and browser-reported keyboard geometry protect the input and controls.

The stage preference is capped by primary width and the budget for foreground controls, bounded input growth, and
conversation. Keyboard pressure lets it yield to the actual input and reading reserve. Long authored foreground labels
wrap and scroll within their allocation. TanStack remains the sole transcript windowing and anchoring owner.

Visual Lab retains stage proportion, tool width, reading width, composer tuning, and stress fixtures. These are local
adjustments, not the principal design alternatives. Layout Debug measures the instruments, tool reservation, session
popover, and actual scroll owners. Run `node tools/player-browser-smoke.mjs` after the build for runtime interactions,
disclosure/focus, responsive geometry, fullscreen, simulated keyboard/safe-area constraints, long authored labels,
and transcript virtualization/anchoring. Browser emulation does not establish physical software-keyboard or
cross-browser acceptance.

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
  toast-plus-highlight as transient feedback. The final transient treatment remains a playtest decision.
