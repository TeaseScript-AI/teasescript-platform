# Player POC implementation

This directory contains the current browser presentation implementation for the Standard Player POC. The canonical
observable UI contract is [`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md). Do not infer new product requirements
from HTML structure, CSS selectors, TypeScript helpers, demo data, or other implementation details here.

General cross-surface UI engineering/design guidance lives in
[`docs/ui/UI-DESIGN-AND-ENGINEERING.md`](../docs/ui/UI-DESIGN-AND-ENGINEERING.md); narrow tasks use its focused reading
route. Accepted runtime, interaction, security, and custom-view semantics remain in their controlling specifications and
ADRs.

For local inspection, `npm run playground` serves this implementation at `/player/` through the existing development
server. That development route is not a public Player/host protocol.

## Implementation seams

- `index.html` is the local Player entry point and static shell.
- `model.ts` contains presentation-only POC data shapes.
- `render.ts` renders presentation data and demo tool-column content.
- `panel-state.ts` and `tool-columns.ts` keep the current local UI state transitions separate from rendering.
- `browser.ts` wires local browser interactions, demo presentation state, responsive state synchronization, and demo
  media loading.
- `styles/` separates reset, layout/theme ownership, components, effects, and responsive composition through cascade
  layers.
- `demo-session.ts` and `demo-media/` are presentation fixtures, not runtime/package APIs.

The implementation intentionally uses browser-native layout/features and has no UI-framework runtime dependency.

`styles/layout.css` currently owns the concrete light-theme palette values and semantic token mapping used by the
source. Those values are also maintained as observable Player contract in `docs/ui/PLAYER-UI.md`; component CSS should
consume semantic roles rather than raw application-palette primitives. Speaker, package-accent, media, and technical
mask colours remain separate presentation data.

## Demo-only behavior

The local playground server may select a supported image from `player/demo-media/` when the Player opens. The `Visual
Lab` and `Scene` tools, their fixture content, local accent/effect/geometry tuning controls, filename-derived scene
information, and the demo-media endpoint exist to exercise the presentation and are not Standard Library, runtime,
package, or host APIs.

The current composer and rendered right-rail Action buttons are presentation-only and are not wired to the deterministic
runtime. Accepted Standard interaction behavior remains controlled by ADR 0018 and the runtime contracts; the maintained
placement/presentation boundary is described in `docs/ui/PLAYER-UI.md`.
