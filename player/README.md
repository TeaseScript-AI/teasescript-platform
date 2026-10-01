# Player implementation

The Player implementation is under `vue/src/phase2c/`. The canonical observable UI contract is
[`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md). Do not infer new product requirements from HTML structure, CSS
selectors, TypeScript helpers, demo data, or other implementation details here.

General cross-surface UI engineering/design guidance lives in
[`docs/ui/UI-DESIGN-AND-ENGINEERING.md`](../docs/ui/UI-DESIGN-AND-ENGINEERING.md); narrow tasks use its focused reading
route. Accepted runtime, interaction, security, and custom-view semantics remain in their controlling specifications and
ADRs.

For local inspection, run `npm run dev:player:phase2c -- --host 0.0.0.0` and open `/phase2c/`. The development server
loads the development preview; the default build mounts the Player without preview fixtures unless `?dev` is selected.
This is a local inspection route, not the production cross-origin Player/host protocol.

The old Vue Player outside `vue/src/phase2c/`, served at `/player/`, is a legacy reference pending #448.

## Implementation seams

- `runtime-adapter.ts` contains framework-independent runtime-to-Player translation and shared action helpers used by
  the Player and playground workspace controller.
- `vue/src/phase2c/` contains the Player composition, components, shared layout/theme CSS, and development preview;
  its [component map](vue/src/phase2c/README.md) records responsibility boundaries.
- `model.ts` and `presentation.ts` contain shared presentation shapes and ordering, formatting, matching, and colour
  helpers.
- `theme/` owns theme generation and authored action-button material.

Browser-native CSS remains responsible for layout and responsive composition. Vue 3 owns rendering and local
presentation state in the Player; Tailwind CSS 4 is integrated through Vite as a foundation layer,
repository-owned shadcn-vue source/config provides local component seams, Reka is the selected accessible
primitive/positioning/focus layer when interactive components need it, and TanStack Vue Virtual is the single
transcript windowing/scroll-anchoring owner. The engine and shared presentation contracts remain framework-independent
as required by ADR 0020.

`vue/src/phase2c/style.css` owns shared Player geometry and semantic token mapping; `theme/` generates the currently
applied light/dark roles. Components consume semantic roles. Speaker, authored control, media, and technical mask
colours retain separate ownership. The maintained presentation contract and intended theme boundaries live in
[`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md); provisional generator values do not settle final palette policy.

## Experimental dynamic theme evaluation

The Player currently renders generated light/dark theme roles. In the development preview, Visual Lab → Theme Lab
edits the session-local theme intent. See the [component map](vue/src/phase2c/README.md).

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
missing-variant fallback are not yet implemented; see the
[theme boundary](../docs/ui/PLAYER-UI.md#theme-and-customization-boundary). It does not convert authored custom themes
or scene/speaker colours. Final generator adoption, preference persistence and palette/contrast policy remain Owner
decisions.

MCU (Apache-2.0) and Color.js (MIT) replace local colour-science implementations while leaving product role choices
explicit. Versions are pinned in the package manifest/lockfile. They add browser bundle size and dependency-update
review, without a network service or new data access. MCU 0.4.0's extensionless internal ESM imports require the Vite
bundler here: direct Node ESM execution of the adapter fails. No package patch or custom loader is installed.

## Component dependencies

The Player components follow the shadcn-vue structure and use four further pinned browser packages. `@lucide/vue`
supplies the shared SVG icons; the alternative is locally maintained SVGs. `@vueuse/core` supplies lifecycle-aware
events, observers, media queries, storage and textarea autosizing; the alternative is local browser-API composables.
`class-variance-authority` expresses the shared component variants that the design lint checks; the alternative is
computed class maps. `tw-animate-css` supplies the overlay enter/exit animation utilities used by the shadcn-vue
components; the alternative is maintained CSS keyframes. They add browser code/CSS and dependency-update review, without
a network service, data access or host boundary. On upgrades, verify icons, focus/autosizing, variants and overlay
animations.

## Tool panel ordering

The Phase 2C Tool Panel strip uses SortableJS for mouse/touch reordering and edge autoscroll. The binding restores
Sortable's DOM move before updating Vue's authoritative order; pinning and widths remain independent. Reka menu
actions provide the keyboard/non-drag alternative. A Vue wrapper adds little value for this single list, native drag
and drop has weaker touch support, and Pointer Events would require custom sorting/autoscroll.
SortableJS adds browser code and dependency maintenance, but no network service, runtime data access or host boundary.
Its type package is development-only; versions live in the manifest/lockfile. Verify sorting and scrolling on updates.

## Development-only behavior

`DevelopmentPreview.vue` opens one runtime choice scenario and supplies Visual Lab's Owner A/B presentation settings:
Theme Lab, the Stage media picker, and timer/background-button fixtures. Visual Lab and Layout Debug are development
surfaces, not Standard Player product tools or runtime/package/host APIs. Fixture timer/control values remain local;
the opening scenario still uses the shared canonical runtime adapter.

Run retained presentation checks through `npm run test:player:phase2c-browser -- <preview-url>`; see
[`docs/TESTING.md`](../docs/TESTING.md#player-browser-and-visual-verification) for prerequisites. Coverage that depended
on removed development fixtures is replaced by the `demo.tease` end-to-end path after runtime integration.
