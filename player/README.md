# Player POC implementation

This directory contains the current browser presentation implementation for the Standard Player POC. The canonical
observable UI contract is [`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md). Do not infer new product requirements
from HTML structure, CSS selectors, TypeScript helpers, demo data, or other implementation details here.

General cross-surface UI engineering/design guidance lives in
[`docs/ui/UI-DESIGN-AND-ENGINEERING.md`](../docs/ui/UI-DESIGN-AND-ENGINEERING.md); narrow tasks use its focused reading
route. Accepted runtime, interaction, security, and custom-view semantics remain in their controlling specifications and
ADRs.

For local inspection, `npm run playground` serves the maintained Vue Player at `/player/` through the existing development
server. It compiles and starts [`demo.tease`](demo.tease) automatically. The separate `/phase2c/` Vite preview retains
Visual Lab, Layout Debug, stress fixtures, and presentation experiments. Neither route defines a public Player/host protocol.

## Implementation seams

- `runtime-adapter.ts` contains the framework-independent runtime-to-Player translation and shared action helpers used
  by the Vue Player and playground workspace controller.
- `vue/` contains the maintained Vue Player and its Vite build.
- `model.ts` contains presentation-only POC data shapes.
- `presentation.ts` contains framework-independent presentation ordering, formatting, matching, and colour helpers.
- `vue/src/phase2c/` contains the shared composition components. `PlayerApp.vue` is the `/player/` entry and
  `App.vue` is the `/phase2c/` preview entry. Preview tools and stress fixtures are absent from the production bundle.
- `demo.tease` is the repository demo script. `demo-assets/` supplies its bundled avatar and temporary stage artwork.

Browser-native CSS remains responsible for layout and responsive composition. Vue 3 owns rendering and local
presentation state in the common reference; Tailwind CSS 4 is integrated through Vite as a foundation layer,
repository-owned shadcn-vue source/config provides local component seams, Reka is the selected accessible
primitive/positioning/focus layer when interactive components need it, and TanStack Vue Virtual is the single
transcript windowing/scroll-anchoring owner. The engine and shared presentation contracts remain framework-independent
as required by ADR 0020.

`vue/src/phase2c/style.css` owns the concrete light-theme palette values and semantic token mapping used by the
source. Those values are also maintained as observable Player contract in `docs/ui/PLAYER-UI.md`; component CSS should
consume semantic roles rather than raw application-palette primitives. Speaker, package-accent, media, and technical
mask colours remain separate presentation data.

## Experimental dynamic theme evaluation

Run `npm run dev:player:phase2c -- --host 0.0.0.0` and open `/phase2c/`, then Visual Lab → Theme Lab.
See the [preview component map](vue/src/phase2c/README.md) for composition and interaction responsibilities.

`theme/palette.ts` resolves Material-based light/dark roles; `theme/material.ts` isolates MCU's tonal palettes;
`theme/color.ts` isolates Color.js conversion, gamut mapping and contrast. `usePlayerTheme.ts` applies the generated
roles to the document root, including body-portaled controls, and restores previous inline values on unmount.
Theme Lab edits session-local intent: accent, surface hue/tint, maximum chroma, monochrome and contrast. Zero tint
is achromatic; accent remains independent. High contrast increases tone separation rather than saturation.
Colour-pair presets change surface/accent inputs without changing mode or contrast; they do not register themes.

Surface roles drive canvas ambience, containers and neutral interaction states; accent drives primary actions,
focus and progress. Nested surfaces use less tint. Translucent media controls and Timer materials account for
background media independently of light/dark mode; theme generation does not control their geometry or recolour
content. Exact provisional tones and effects live in the implementation. Diagnostics measure opaque colour pairs;
they do not certify translucent overlays or perceptual state distinction.

The generator consumes resolved platform intent. User/package precedence, authored-theme registration and
missing-variant fallback remain outside this preview; see the
[theme boundary](../docs/ui/PLAYER-UI.md#theme-and-customization-boundary). It does not convert authored custom themes
or scene/speaker colours. Production adoption, persistence and final palette/contrast policy remain Owner decisions.

MCU (Apache-2.0) and Color.js (MIT) replace local colour-science implementations while leaving product role choices
explicit. Versions are pinned in the package manifest/lockfile. They add browser bundle size and dependency-update
review, without a network service or new data access. MCU 0.4.0's extensionless internal ESM imports require the Vite
bundler here: direct Node ESM execution of the adapter fails. No package patch or custom loader is installed.

## Demo-only behavior

The Phase 2C Tool Panel strip uses SortableJS for mouse/touch reordering and edge autoscroll. The binding restores
Sortable's DOM move before updating Vue's authoritative order; pinning and widths remain independent. Reka menu
actions provide the keyboard/non-drag alternative. A Vue wrapper adds little value for this single list, native drag
and drop has weaker touch support, and Pointer Events would require custom sorting/autoscroll.
SortableJS adds browser code and dependency maintenance, but no network service, runtime data access or host boundary.
Its type package is development-only; versions live in the manifest/lockfile. Verify sorting and scrolling on updates.

The `/player/` entry point compiles real `demo.tease` source and drives `say`, canonical
`playerTranscript` output, foreground interactions, chat pacing, time observation, checkpoint, and restore through
`runtime-adapter.ts`. Engine operations remain authoritative for action identity, validation, normalization, choice
matching, transcript derivation, settlement, and continuation. The checkpoint's companion transcript-event history is
presentation-owned and retained only for same-session development restore; it does not alter the canonical runtime
checkpoint or define the deferred production persistence/host payload.

The demo avatar is an authored speaker reference resolved to a bundled asset. General package-asset resolution,
script-driven stage media, timers, and right-rail controls still need their upstream runtime/host integrations. The
current stage image is bundled demo artwork. Timer and right-rail fixtures exist only in the `/phase2c/` preview.
Accepted Standard interaction behavior remains controlled by ADR 0018 and the runtime contracts; the maintained
placement/presentation boundary is described in `docs/ui/PLAYER-UI.md`.

Current Visual Lab fixtures deliberately exercise several presentation questions without promoting their fixture state
to runtime or product semantics:

- the timer starts with the authored-label example; generic labels, mystery presentation, hidden presentation, and
  multiple-timer pressure remain selectable;
- the pacing-gate fixture reveals a short message sequence over time, with Player-background/empty-composer Space
  skipping available only in the skippable variant;
- script-initiated control changes add a neutral event to transcript history and compare toast, local highlight, and
  toast-plus-highlight as transient feedback. The final transient treatment remains a playtest decision.
